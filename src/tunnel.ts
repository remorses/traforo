import dedent from 'string-dedent'
import {
  evaluateCloudflareCacheability,
  getRequestCacheBypassReason,
} from './cache-policy.js'
import {
  getActiveUpstream,
  isStaleUpstream,
  sendUpstreamMessage,
} from './upstream-state.js'
import type {
  UpstreamMessage,
  DownstreamMessage,
  HttpRequestMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpErrorMessage,
  WsOpenMessage,
  WsFrameMessage,
  WsCloseMessage,
  WsOpenedMessage,
  WsFrameResponseMessage,
  WsClosedMessage,
  WsErrorMessage,
} from './types.js'

// Cloudflare-specific types
export type Env = {
  TUNNEL_DO: DurableObjectNamespace
  TUNNEL_RATE_LIMITER: RateLimit
}

type Attachment = {
  role: 'upstream' | 'downstream'
  tunnelId: string
  /** Newer upstream sockets win if an older one lingers during disconnect races. */
  connectedAt?: number
  /** Password stored on upstream attachment, survives DO hibernation */
  password?: string
  /** Edge cache partition key, survives DO hibernation */
  cacheKey?: string
}

type CacheContext = {
  tunnelId: string
  cacheKey: string
}

type PendingHttpRequest = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  /** Original request URL for cache storage (only set when caching is enabled) */
  cacheRequest?: Request
  /** Immutable cache context captured at request time (avoids race if key changes mid-flight) */
  cacheContext?: CacheContext
  /** Request-side directive that forced cache lookup bypass */
  cacheLookupBypassReason?: string
}

type StreamingHttpRequest = {
  writer: WritableStreamDefaultWriter<Uint8Array>
  timeout: ReturnType<typeof setTimeout>
  status: number
  headers: Headers
}

type PendingWsConnection = {
  userWs: WebSocket
  timeout: ReturnType<typeof setTimeout>
}

const HTTP_TIMEOUT_MS = 30_000
const WS_OPEN_TIMEOUT_MS = 10_000
const RATE_LIMIT_PERIOD_SECONDS = 60

export function appendQueryParamPreservingFormatting(
  url: string,
  key: string,
  value: string,
): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

export function removeQueryParamPreservingFormatting(
  url: string,
  key: string,
): string {
  const queryIndex = url.indexOf('?')
  if (queryIndex === -1) {
    return url
  }

  const hashIndex = url.indexOf('#', queryIndex)
  const base = url.slice(0, queryIndex)
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
  const query = url.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex)
  const filteredParams = query.split('&').filter((param) => {
    const paramName = param.split('=', 1)[0] || ''
    return paramName !== key && decodeURIComponent(paramName) !== key
  })

  if (filteredParams.length === 0) {
    return `${base}${hash}`
  }

  return `${base}?${filteredParams.join('&')}${hash}`
}

// Worker entrypoint
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url)
      const host = url.hostname
      const isUpgrade = req.headers.get('Upgrade') === 'websocket'

      const rateLimitKey = getRateLimitKey(req)
      const rateLimitOutcome = await env.TUNNEL_RATE_LIMITER.limit({
        key: rateLimitKey,
      })
      if (!rateLimitOutcome.success) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: {
            'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
          },
        })
      }

      console.log(
        `[Worker] ${req.method} ${url.pathname} host=${host} upgrade=${isUpgrade}`,
      )

      // Extract tunnel ID from subdomain: {tunnelId}-tunnel.kimaki.xyz
      const tunnelId = extractTunnelId(host)
      if (!tunnelId) {
        console.log(`[Worker] Invalid tunnel URL: ${host}`)
        return new Response('Invalid tunnel URL', { status: 400 })
      }

      console.log(`[Worker] tunnelId=${tunnelId}`)

      // Get the Durable Object for this tunnel
      const doId = env.TUNNEL_DO.idFromName(tunnelId)
      const stub = env.TUNNEL_DO.get(doId)

      // Forward request to DO
      const doUrl = appendQueryParamPreservingFormatting(
        req.url,
        '_tunnelId',
        tunnelId,
      )
      const res = await stub.fetch(new Request(doUrl, req))

      console.log(`[Worker] DO response status=${res.status}`)
      return res
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[Worker] Unhandled error: ${error.message}`)
      console.error(`[Worker] Stack: ${error.stack}`)
      return new Response(`Worker error: ${error.message}\n${error.stack}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
  },
}

function extractTunnelId(host: string): string | null {
  // Match: {tunnelId}-tunnel.kimaki.xyz, {tunnelId}-tunnel-preview.kimaki.xyz, or {tunnelId}-tunnel.localhost
  const match = host.match(/^([a-z0-9-]+)-tunnel(?:-preview)?\./)
  if (!match) {
    return null
  }
  return match[1]
}

// Durable Object
export class Tunnel {
  private ctx: DurableObjectState
  private env: Env
  private pendingHttpRequests: Map<string, PendingHttpRequest> = new Map()
  private streamingHttpRequests: Map<string, StreamingHttpRequest> = new Map()
  private pendingWsConnections: Map<string, PendingWsConnection> = new Map()
  /** Cache key for edge caching, null when caching is disabled */
  private cacheKey: string | null = null
  /** Password for tunnel protection, null when no password is set */
  private password: string | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env

    // Auto-respond to JSON ping messages without waking the DO.
    // Only one auto-response pair can be active (second call overrides first).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    )
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this._fetch(req)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[DO] Unhandled error in fetch: ${error.message}`)
      console.error(`[DO] Stack: ${error.stack}`)
      return new Response(`DO error: ${error.message}\n${error.stack}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
  }

  private async _fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const tunnelId = url.searchParams.get('_tunnelId') || 'default'
    const isUpgrade = req.headers.get('Upgrade') === 'websocket'

    console.log(
      `[DO] fetch path=${url.pathname} tunnelId=${tunnelId} upgrade=${isUpgrade}`,
    )

    // WebSocket upgrade requests
    if (isUpgrade) {
      if (url.pathname === '/traforo-upstream') {
        // Parse cache key from upstream connection params
        const cacheKey = url.searchParams.get('_cacheKey')
        if (cacheKey) {
          this.cacheKey = cacheKey
          console.log(`[DO] Edge caching enabled (key: ${cacheKey})`)
        } else {
          this.cacheKey = null
        }
        // Parse password from upstream connection params
        const password = url.searchParams.get('_password')
        if (password) {
          this.password = password
          console.log(`[DO] Password protection enabled`)
        } else {
          this.password = null
        }
        console.log(`[DO] Handling upstream connection for ${tunnelId}`)
        return this.handleUpstreamConnection(tunnelId)
      }
      // User WebSocket connection to be proxied
      // Password check for WebSocket upgrades
      const wsPassword = this.getPassword(tunnelId)
      if (wsPassword) {
        const cookie = parseCookie(req.headers.get('cookie') || '')
        if (cookie['traforo-password'] !== wsPassword) {
          // Can't show HTML for WS upgrades, reject with close code
          const pair = new WebSocketPair()
          const [client, server] = Object.values(pair)
          server.accept()
          server.close(4013, 'Unauthorized: invalid or missing password')
          return new Response(null, { status: 101, webSocket: client })
        }
      }
      // Preserve raw query formatting for bare flags like ?import&url&inline.
      const wsUrl = new URL(
        removeQueryParamPreservingFormatting(req.url, '_tunnelId'),
      )
      const wsPath = wsUrl.pathname + wsUrl.search
      console.log(
        `[DO] Handling user WS connection for ${tunnelId} path=${wsPath}`,
      )
      return this.handleUserWsConnection(tunnelId, wsPath, req.headers)
    }

    // Status endpoint
    if (url.pathname === '/traforo-status') {
      const upstream = this.getUpstream(tunnelId)
      console.log(`[DO] Status check: online=${!!upstream}`)
      return Response.json({
        online: !!upstream,
        tunnelId,
      })
    }

    // Password login endpoint
    if (url.pathname === '/traforo-login' && req.method === 'POST') {
      return this.handleLogin(tunnelId, req)
    }

    // Password protection check for HTTP requests
    const passwordResponse = this.checkPassword(tunnelId, req)
    if (passwordResponse) {
      return passwordResponse
    }

    // HTTP request to be proxied
    console.log(`[DO] HTTP proxy request ${req.method} ${url.pathname}`)
    return this.handleHttpProxy(tunnelId, req)
  }

  // ============================================
  // Password Protection
  // ============================================

  /**
   * Check if the request has a valid password cookie.
   * Returns null if no password is set or cookie is valid.
   * Returns a 401 Response if unauthorized.
   */
  private checkPassword(tunnelId: string, req: Request): Response | null {
    const password = this.getPassword(tunnelId)
    if (!password) {
      return null
    }

    const cookie = parseCookie(req.headers.get('cookie') || '')
    if (cookie['traforo-password'] === password) {
      return null
    }

    // Determine if this is a browser request
    const accept = req.headers.get('accept') || ''
    const isBrowser = accept.includes('text/html')

    if (isBrowser) {
      return new Response(passwordHtml(), {
        status: 401,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    return new Response(
      'Unauthorized: this tunnel is password protected.\n' +
        'Pass the password as a cookie:\n\n' +
        "  curl -b 'traforo-password=YOUR_PASSWORD' URL\n",
      {
        status: 401,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  /**
   * Handle POST /traforo-login — validate password and set cookie.
   */
  private async handleLogin(tunnelId: string, req: Request): Promise<Response> {
    const password = this.getPassword(tunnelId)
    if (!password) {
      return new Response('No password configured', { status: 400 })
    }

    let submitted: string | File | null = null
    try {
      const formData = await req.formData()
      submitted = formData.get('password')
    } catch {
      return new Response(passwordHtml('Invalid form submission'), {
        status: 400,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    if (typeof submitted !== 'string' || submitted !== password) {
      return new Response(passwordHtml('Incorrect password'), {
        status: 401,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    // Password correct — set cookie and redirect to /
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/',
        'Set-Cookie': `traforo-password=${encodeURIComponent(password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
      },
    })
  }

  // ============================================
  // Upstream (local client) connection
  // ============================================

  private handleUpstreamConnection(tunnelId: string): Response {
    // Close any existing upstream connection
    const existing = this.getUpstream(tunnelId)
    if (existing) {
      try {
        existing.close(4009, 'Replaced by new connection')
      } catch {}
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const connectedAt = Date.now()

    this.ctx.acceptWebSocket(server, [`upstream:${tunnelId}`])
    server.serializeAttachment({
      role: 'upstream',
      tunnelId,
      connectedAt,
      ...(this.password && { password: this.password }),
      ...(this.cacheKey && { cacheKey: this.cacheKey }),
    } satisfies Attachment)

    // Notify any waiting downstream connections
    const downstreams = this.ctx.getWebSockets(`downstream:${tunnelId}`)
    for (const ws of downstreams) {
      try {
        ws.send(JSON.stringify({ event: 'upstream_connected' }))
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  private getUpstream(tunnelId: string): WebSocket | null {
    return getActiveUpstream(this.ctx.getWebSockets(`upstream:${tunnelId}`), tunnelId)
  }

  private isStaleUpstreamSocket(tunnelId: string, ws: WebSocket): boolean {
    return isStaleUpstream(this.ctx.getWebSockets(`upstream:${tunnelId}`), tunnelId, ws)
  }

  private handleUpstreamDisconnected(tunnelId: string) {
    console.log(
      `[DO] Upstream disconnected, pending HTTP requests: ${this.pendingHttpRequests.size}, streaming: ${this.streamingHttpRequests.size}`,
    )

    const downstreams = this.ctx.getWebSockets(`downstream:${tunnelId}`)
    for (const down of downstreams) {
      try {
        down.send(JSON.stringify({ event: 'upstream_disconnected' }))
        down.close(1012, 'Upstream disconnected')
      } catch {}
    }

    for (const [, pending] of this.pendingHttpRequests) {
      clearTimeout(pending.timeout)
      pending.resolve(new Response('Tunnel disconnected', { status: 502 }))
    }
    this.pendingHttpRequests.clear()

    for (const [, streaming] of this.streamingHttpRequests) {
      clearTimeout(streaming.timeout)
      try {
        streaming.writer.close()
      } catch {}
    }
    this.streamingHttpRequests.clear()

    for (const [connId, pending] of this.pendingWsConnections) {
      clearTimeout(pending.timeout)
      try {
        pending.userWs.close(4011, 'Tunnel disconnected')
      } catch {}
    }
    this.pendingWsConnections.clear()
  }

  private sendToUpstream(
    tunnelId: string,
    upstream: WebSocket,
    message: UpstreamMessage,
    context: string,
  ): boolean {
    return sendUpstreamMessage({
      tunnelId,
      sockets: this.ctx.getWebSockets(`upstream:${tunnelId}`),
      upstream,
      message,
      context,
      logError: console.error,
      logInfo: console.log,
      onDisconnect: () => {
        this.handleUpstreamDisconnected(tunnelId)
      },
    })
  }

  /**
   * Get the password, recovering from the upstream WS attachment if the DO
   * was hibernated and this.password was lost from memory.
   */
  private getPassword(tunnelId: string): string | null {
    if (this.password) {
      return this.password
    }
    // Recover from upstream WebSocket attachment (survives hibernation)
    const upstream = this.getUpstream(tunnelId)
    if (upstream) {
      const attachment = upstream.deserializeAttachment() as Attachment | undefined
      if (attachment?.password) {
        this.password = attachment.password
        return this.password
      }
    }
    return null
  }

  /**
   * Get the cache key, recovering from the upstream WS attachment if the DO
   * was hibernated and this.cacheKey was lost from memory.
   */
  private getCacheKey(tunnelId: string): string | null {
    if (this.cacheKey) {
      return this.cacheKey
    }
    const upstream = this.getUpstream(tunnelId)
    if (upstream) {
      const attachment = upstream.deserializeAttachment() as Attachment | undefined
      if (attachment?.cacheKey) {
        this.cacheKey = attachment.cacheKey
        return this.cacheKey
      }
    }
    return null
  }

  // ============================================
  // HTTP Proxy
  // ============================================

  private async handleHttpProxy(
    tunnelId: string,
    req: Request,
  ): Promise<Response> {
    const url = new URL(removeQueryParamPreservingFormatting(req.url, '_tunnelId'))

    // Capture immutable cache context at request time to avoid race conditions
    // if the upstream reconnects with a different --cache key mid-flight.
    // getCacheKey() recovers the key from WS attachment after hibernation.
    const cacheKey = this.getCacheKey(tunnelId)
    const cacheContext: CacheContext | undefined = cacheKey
      ? { tunnelId, cacheKey }
      : undefined

    // Build a clean cache request (without internal params)
    const cacheRequest =
      cacheContext && req.method === 'GET'
        ? new Request(url.toString(), {
            method: 'GET',
            headers: req.headers,
          })
        : undefined

    const cacheLookupBypassReason = cacheRequest
      ? getRequestCacheBypassReason(cacheRequest)
      : null

    // Check edge cache before proxying
    if (cacheRequest && cacheContext && !cacheLookupBypassReason) {
      try {
        const cache = await caches.open(
          `traforo:${cacheContext.tunnelId}:${cacheContext.cacheKey}`,
        )
        const cached = await cache.match(cacheRequest)
        if (cached) {
          console.log(`[DO] Cache HIT ${req.method} ${url.pathname}`)
          const res = new Response(cached.body, cached)
          res.headers.set('X-Traforo-Cache', 'HIT')
          return res
        }
      } catch (err) {
        console.error(`[DO] Cache check error:`, err)
      }
    } else if (cacheLookupBypassReason) {
      console.log(`[DO] Cache LOOKUP BYPASS reason=${cacheLookupBypassReason}`)
    }

    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      return new Response(offlineHtml(tunnelId), {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const reqId = crypto.randomUUID()

    // Read request body
    let body: string | null = null
    if (req.body) {
      const buffer = await req.arrayBuffer()
      if (buffer.byteLength > 0) {
        body = arrayBufferToBase64(buffer)
      }
    }

    // Build headers object
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (!isHopByHopHeader(key)) {
        headers[key] = value
      }
    })

    // Send request to local client
    const message: HttpRequestMessage = {
      type: 'http_request',
      id: reqId,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body,
    }

    if (!this.sendToUpstream(tunnelId, upstream, message, `${tunnelId} reqId=${reqId}`)) {
      return new Response('Failed to send to tunnel', { status: 502 })
    }

    // Wait for response (either full or streaming start)
    return new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHttpRequests.delete(reqId)
        this.streamingHttpRequests.delete(reqId)
        resolve(new Response('Tunnel timeout', { status: 504 }))
      }, HTTP_TIMEOUT_MS)

      this.pendingHttpRequests.set(reqId, {
        resolve,
        reject,
        timeout,
        cacheRequest,
        cacheContext,
        cacheLookupBypassReason: cacheLookupBypassReason || undefined,
      })
    })
  }

  // ============================================
  // User WebSocket Proxy
  // ============================================

  private handleUserWsConnection(
    tunnelId: string,
    path: string,
    reqHeaders: Headers,
  ): Response {
    // Echo back Sec-WebSocket-Protocol so clients like ws that require
    // subprotocol negotiation (e.g. "vite-hmr") don't reject the connection
    const protocol = reqHeaders.get('sec-websocket-protocol')
    const responseHeaders: Record<string, string> = {}
    if (protocol) {
      responseHeaders['Sec-WebSocket-Protocol'] = protocol
    }

    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      server.accept()
      server.close(4008, 'Tunnel offline')
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders,
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    const connId = crypto.randomUUID()

    this.ctx.acceptWebSocket(server, [`downstream:${tunnelId}`, `ws:${connId}`])
    server.serializeAttachment({
      role: 'downstream',
      tunnelId,
    } satisfies Attachment)

    // Build headers object
    const headers: Record<string, string> = {}
    reqHeaders.forEach((value, key) => {
      if (!isHopByHopHeader(key) && key.toLowerCase() !== 'upgrade') {
        headers[key] = value
      }
    })

    // Request local client to open WebSocket
    const message: WsOpenMessage = {
      type: 'ws_open',
      connId,
      path,
      headers,
    }

    if (!this.sendToUpstream(tunnelId, upstream, message, `WS ${connId}`)) {
      server.close(4009, 'Failed to contact tunnel')
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders,
      })
    }

    // Set timeout for WS open
    const timeout = setTimeout(() => {
      this.pendingWsConnections.delete(connId)
      try {
        server.close(4010, 'Local connection timeout')
      } catch {}
    }, WS_OPEN_TIMEOUT_MS)

    this.pendingWsConnections.set(connId, { userWs: server, timeout })

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders,
    })
  }

  // ============================================
  // WebSocket Hibernation Handlers
  // ============================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment | undefined
    if (!attachment) {
      return
    }

    if (attachment.role === 'upstream') {
      // Upstream messages are always JSON protocol messages (strings)
      if (typeof message !== 'string') {
        return
      }
      this.handleUpstreamMessage(attachment.tunnelId, message)
    } else if (attachment.role === 'downstream') {
      // Downstream messages can be text or binary from user WebSockets
      if (typeof message === 'string') {
        this.handleDownstreamMessage(attachment.tunnelId, ws, message, false)
      } else {
        // Binary message - base64 encode and forward
        const base64 = arrayBufferToBase64(message)
        this.handleDownstreamMessage(attachment.tunnelId, ws, base64, true)
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    const attachment = ws.deserializeAttachment() as Attachment | undefined
    console.log(
      `[DO] webSocketClose code=${code} reason=${reason} role=${attachment?.role} tunnelId=${attachment?.tunnelId}`,
    )
    if (!attachment) {
      return
    }

    if (attachment.role === 'upstream') {
      if (this.isStaleUpstreamSocket(attachment.tunnelId, ws)) {
        console.log(`[DO] Ignoring stale upstream close for ${attachment.tunnelId}`)
        return
      }

      this.handleUpstreamDisconnected(attachment.tunnelId)
    } else if (attachment.role === 'downstream') {
      // Downstream (user) WS closed — forward close to upstream so the
      // local client can clean up its corresponding localWsConnections entry
      const tags = this.ctx.getTags(ws)
      const wsTag = tags.find((t) => t.startsWith('ws:'))
      if (wsTag) {
        const connId = wsTag.replace('ws:', '')
        const upstream = this.getUpstream(attachment.tunnelId)
        if (upstream) {
          const closeMsg: WsCloseMessage = {
            type: 'ws_close',
            connId,
            code,
            reason,
          }
          this.sendToUpstream(
            attachment.tunnelId,
            upstream,
            closeMsg,
            `WS close ${connId}`,
          )
        }
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error(`[DO] webSocketError: ${error instanceof Error ? error.message : String(error)}`)
    // Treat errors same as close
    await this.webSocketClose(ws, 1011, 'WebSocket error', false)
  }

  // ============================================
  // Message Handlers
  // ============================================

  private handleUpstreamMessage(tunnelId: string, rawMessage: string) {
    let msg: DownstreamMessage
    try {
      msg = JSON.parse(rawMessage) as DownstreamMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'http_response':
        this.handleHttpResponse(msg)
        break
      case 'http_response_start':
        this.handleHttpResponseStart(msg)
        break
      case 'http_response_chunk':
        this.handleHttpResponseChunk(msg)
        break
      case 'http_response_end':
        this.handleHttpResponseEnd(msg)
        break
      case 'http_error':
        this.handleHttpError(msg)
        break
      case 'ws_opened':
        this.handleWsOpened(msg)
        break
      case 'ws_frame':
        this.handleWsFrame(tunnelId, msg)
        break
      case 'ws_closed':
        this.handleWsClosed(msg)
        break
      case 'ws_error':
        this.handleWsError(msg)
        break
    }
  }

  private handleDownstreamMessage(
    tunnelId: string,
    ws: WebSocket,
    rawMessage: string,
    binary: boolean,
  ) {
    // Forward message from user WebSocket to upstream
    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      return
    }

    // Find the connId for this downstream WebSocket from its tags
    const tags = this.ctx.getTags(ws)
    const wsTag = tags.find((t) => t.startsWith('ws:'))
    if (!wsTag) {
      return
    }
    const connId = wsTag.replace('ws:', '')

    // Forward as WsFrameMessage (rawMessage can be text or base64-encoded binary)
    const message: WsFrameMessage = {
      type: 'ws_frame',
      connId,
      data: rawMessage,
      binary,
    }

    this.sendToUpstream(tunnelId, upstream, message, `WS frame ${connId}`)
  }

  private handleHttpResponse(msg: HttpResponseMessage) {
    const pending = this.pendingHttpRequests.get(msg.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingHttpRequests.delete(msg.id)

    // Decode body
    let body: BodyInit | null = null
    if (msg.body) {
      body = base64ToArrayBuffer(msg.body)
    }

    const headers = buildHeaders(msg.headers)
    const response = new Response(body, { status: msg.status, headers })

    if (pending.cacheLookupBypassReason) {
      response.headers.set('X-Traforo-Cache', 'BYPASS')
      response.headers.set(
        'X-Traforo-Cache-Reason',
        pending.cacheLookupBypassReason,
      )
      pending.resolve(response)
      return
    }

    // Store in edge cache if cacheable (use immutable context from request time)
    if (pending.cacheRequest && pending.cacheContext) {
      const cacheResult = this.cacheStore(
        pending.cacheRequest,
        response,
        msg.headers,
        pending.cacheContext,
      )
      response.headers.set('X-Traforo-Cache', cacheResult.stored ? 'MISS' : 'BYPASS')
      response.headers.set('X-Traforo-Cache-Reason', cacheResult.reason)
    }

    pending.resolve(response)
  }

  private handleHttpResponseStart(msg: HttpResponseStartMessage) {
    const pending = this.pendingHttpRequests.get(msg.id)
    if (!pending) {
      return
    }

    // Remove from pending (we're about to resolve)
    this.pendingHttpRequests.delete(msg.id)

    const headers = buildHeaders(msg.headers)

    if (pending.cacheContext) {
      headers.set('X-Traforo-Cache', 'BYPASS')
    }

    // Create TransformStream for streaming response
    const { readable, writable } = new TransformStream<Uint8Array>()
    const writer = writable.getWriter()

    // Store streaming info for chunk handling
    this.streamingHttpRequests.set(msg.id, {
      writer,
      timeout: pending.timeout,
      status: msg.status,
      headers,
    })

    // Resolve with streaming response
    pending.resolve(new Response(readable, { status: msg.status, headers }))
  }

  private handleHttpResponseChunk(msg: HttpResponseChunkMessage) {
    const streaming = this.streamingHttpRequests.get(msg.id)
    if (!streaming) {
      return
    }

    try {
      const chunk = base64ToArrayBuffer(msg.chunk)
      streaming.writer.write(new Uint8Array(chunk))
    } catch (err) {
      console.error(`[DO] Failed to write chunk: ${err}`)
    }
  }

  private handleHttpResponseEnd(msg: HttpResponseEndMessage) {
    const streaming = this.streamingHttpRequests.get(msg.id)
    if (!streaming) {
      return
    }

    clearTimeout(streaming.timeout)
    this.streamingHttpRequests.delete(msg.id)

    try {
      streaming.writer.close()
    } catch {}
  }

  private handleHttpError(msg: HttpErrorMessage) {
    const pending = this.pendingHttpRequests.get(msg.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingHttpRequests.delete(msg.id)

    pending.resolve(new Response(msg.error, { status: 502 }))
  }

  private handleWsOpened(msg: WsOpenedMessage) {
    const pending = this.pendingWsConnections.get(msg.connId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingWsConnections.delete(msg.connId)
    // WebSocket is now fully connected, messages will flow via webSocketMessage
  }

  private handleWsFrame(tunnelId: string, msg: WsFrameResponseMessage) {
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        if (msg.binary) {
          ws.send(base64ToArrayBuffer(msg.data))
        } else {
          ws.send(msg.data)
        }
      } catch {}
    }
  }

  private handleWsClosed(msg: WsClosedMessage) {
    // Clear pending if still waiting
    const pending = this.pendingWsConnections.get(msg.connId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingWsConnections.delete(msg.connId)
    }

    // Close user WebSocket
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        ws.close(msg.code, msg.reason)
      } catch {}
    }
  }

  // ============================================
  // Edge Cache Helpers
  // ============================================

  /**
   * Store a response in the edge cache if it's cacheable.
   * Respects origin Cache-Control headers; adds default caching for static assets.
   * Uses immutable cache context captured at request time to avoid races.
   * Returns true if the response was stored, false if it was not cacheable.
   */
  private cacheStore(
    cacheRequest: Request,
    response: Response,
    rawHeaders: Record<string, string | string[]>,
    ctx: CacheContext,
  ): { stored: boolean; reason: string } {
    const decision = evaluateCloudflareCacheability({
      request: cacheRequest,
      responseStatus: response.status,
      responseHeaders: response.headers,
    })

    if (!decision.cacheable) {
      console.log(`[DO] Cache BYPASS reason=${decision.reason}`)
      return { stored: false, reason: decision.reason }
    }

    const pathname = new URL(cacheRequest.url).pathname

    // Build response to cache
    const responseToCache = new Response(response.clone().body, {
      status: response.status,
      headers: buildHeaders(rawHeaders),
    })

    // Apply deterministic default TTL fallback when policy requested it.
    if (decision.cacheControlOverride) {
      responseToCache.headers.set('Cache-Control', decision.cacheControlOverride)
    }

    responseToCache.headers.set('X-Traforo-Cache', 'STORED')

    console.log(`[DO] Cache STORE ${pathname}`)

    this.ctx.waitUntil(
      caches
        .open(`traforo:${ctx.tunnelId}:${ctx.cacheKey}`)
        .then((cache) => cache.put(cacheRequest, responseToCache))
        .catch((err) => console.error(`[DO] Cache store error:`, err)),
    )

    return { stored: true, reason: decision.reason }
  }

  private handleWsError(msg: WsErrorMessage) {
    // Clear pending if still waiting
    const pending = this.pendingWsConnections.get(msg.connId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingWsConnections.delete(msg.connId)
    }

    // Close user WebSocket with error
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        ws.close(4012, msg.error)
      } catch {}
    }
  }
}

// ============================================
// Utilities
// ============================================

// Rebuild Headers from ResponseHeaders, using append() for multi-value headers (Set-Cookie)
function buildHeaders(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (isHopByHopHeader(key)) {
      continue
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v)
      }
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

function isHopByHopHeader(header: string): boolean {
  return HOP_BY_HOP_HEADERS.has(header.toLowerCase())
}

function getRateLimitKey(req: Request): string {
  const cfConnectingIp = req.headers.get('CF-Connecting-IP')?.trim()
  if (cfConnectingIp) {
    return cfConnectingIp
  }

  return 'unknown-client'
}

function parseCookie(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.split('=')
    const key = name?.trim()
    if (!key) continue
    const raw = rest.join('=').trim()
    try {
      cookies[key] = decodeURIComponent(raw)
    } catch {
      // Malformed cookie value — use raw string instead of throwing
      cookies[key] = raw
    }
  }
  return cookies
}

const html = dedent
function passwordHtml(error?: string): string {
  const errorBlock = error
    ? `<p class="error">${error}</p>`
    : ''
  const htmlStr = html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Password Required</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family:
              -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
              'Helvetica Neue', Arial, sans-serif;
            background: #fff;
            color: #111;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            line-height: 1.6;
          }
          .container {
            max-width: 380px;
            width: 100%;
          }
          h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
          }
          p {
            color: #444;
            margin-bottom: 1.5rem;
          }
          .error {
            color: #dc2626;
            font-size: 0.875rem;
            margin-bottom: 1rem;
          }
          form {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          input[type='password'] {
            font-family: inherit;
            font-size: 0.9375rem;
            padding: 0.5rem 0.75rem;
            border: 1px solid #ddd;
            border-radius: 6px;
            outline: none;
            transition: border-color 0.15s;
          }
          input[type='password']:focus {
            border-color: #111;
          }
          button {
            font-family: inherit;
            font-size: 0.9375rem;
            font-weight: 500;
            padding: 0.5rem 0.75rem;
            background: #111;
            color: #fff;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s;
          }
          button:hover {
            background: #333;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background: #111;
              color: #eee;
            }
            p {
              color: #aaa;
            }
            .error {
              color: #f87171;
            }
            input[type='password'] {
              background: #1a1a1a;
              border-color: #333;
              color: #eee;
            }
            input[type='password']:focus {
              border-color: #eee;
            }
            button {
              background: #eee;
              color: #111;
            }
            button:hover {
              background: #ccc;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Password Required</h1>
          <p>This tunnel is protected. Enter the password to continue.</p>
          ${errorBlock}
          <form method="POST" action="/traforo-login">
            <input
              type="password"
              name="password"
              placeholder="Password"
              autofocus
              required
            />
            <button type="submit">Continue</button>
          </form>
        </div>
      </body>
    </html>
  `
  return htmlStr
}

function offlineHtml(tunnelId: string): string {
  const htmlStr = html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Tunnel Offline</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family:
              -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
              'Helvetica Neue', Arial, sans-serif;
            background: #fff;
            color: #111;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            line-height: 1.6;
          }
          .container {
            max-width: 540px;
            width: 100%;
          }
          h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 1rem;
            letter-spacing: -0.02em;
          }
          p {
            color: #444;
            margin-bottom: 1.5rem;
          }
          .tunnel-id {
            font-family:
              'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.875rem;
            background: #f5f5f5;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
          }
          .section {
            margin-top: 2rem;
            padding-top: 2rem;
            border-top: 1px solid #eee;
          }
          .section-title {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #888;
            margin-bottom: 1rem;
          }
          pre {
            font-family:
              'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.8125rem;
            background: #fafafa;
            margin-left: -1rem;
            margin-right: -1rem;
            padding: 0.75rem 1rem;
            overflow-x: auto;
            line-height: 1.7;
          }
          code {
            font-family: inherit;
          }
          .comment {
            color: #888;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background: #111;
              color: #eee;
            }
            p {
              color: #aaa;
            }
            .tunnel-id {
              background: #222;
            }
            .section {
              border-top-color: #333;
            }
            .section-title {
              color: #666;
            }
            pre {
              background: #1a1a1a;
            }
            .comment {
              color: #666;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Tunnel Offline</h1>
          <p>
            The tunnel <span class="tunnel-id">${tunnelId}</span> is no longer
            connected. The local dev server has stopped running.
          </p>
          <p>
            This usually happens when the terminal session ends or the process
            is interrupted.
          </p>
          <div class="section">
            <div class="section-title">Keep it running with tmux</div>
            <pre><code><span class="comment"># Create a background session</span>
    tmux new-session -d -s dev

    <span class="comment"># Start your dev server with tunnel</span>
    tmux send-keys -t dev "npx kimaki tunnel --kill -p 3000 -- pnpm dev" Enter

    <span class="comment"># View the tunnel URL</span>
    tmux capture-pane -t dev -p | grep tunnel</code></pre>
          </div>
        </div>
      </body>
    </html>
  `
  return htmlStr
}
