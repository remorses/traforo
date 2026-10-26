/**
 * Focused tests for the tunnel client's proxy-aware WebSocket agent helper.
 */

import { afterEach, describe, expect, test } from 'vitest'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import {
  createWebSocketAgentFromEnv,
  formatConnectionMessage,
  shouldReconnectUpstream,
  TunnelClient,
  TunnelRejectedError,
  upstreamReconnectDelayMs,
} from './client.js'
import {
  CLOSE_ABNORMAL,
  CLOSE_INTERNAL_ERROR,
  CLOSE_LICENSE_REQUIRED,
  CLOSE_MESSAGE_TOO_BIG,
  CLOSE_SERVICE_RESTART,
  CLOSE_TUNNEL_ID_IN_USE,
  CLOSE_TUNNEL_OFFLINE,
} from './types.js'

const PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'WSS_PROXY',
  'WS_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'wss_proxy',
  'ws_proxy',
] as const

const originalEnv = new Map<string, string | undefined>(
  PROXY_ENV_KEYS.map((key) => {
    return [key, process.env[key]]
  }),
)

function resetProxyEnv(): void {
  PROXY_ENV_KEYS.forEach((key) => {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
      return
    }
    process.env[key] = value
  })
}

afterEach(() => {
  resetProxyEnv()
})

describe('createWebSocketAgentFromEnv', () => {
  test('returns undefined when no proxy env var is set', () => {
    PROXY_ENV_KEYS.forEach((key) => {
      delete process.env[key]
    })

    expect(
      createWebSocketAgentFromEnv({ wsUrl: 'wss://traforo.dev/socket' }),
    ).toBeUndefined()
  })

  test('creates an HttpsProxyAgent when HTTP_PROXY is set', () => {
    PROXY_ENV_KEYS.forEach((key) => {
      delete process.env[key]
    })
    process.env.HTTP_PROXY = 'http://127.0.0.1:8080'

    const agent = createWebSocketAgentFromEnv({
      wsUrl: 'ws://traforo.dev/socket',
    })

    expect(agent).toBeInstanceOf(HttpsProxyAgent)
  })

  test('creates a SocksProxyAgent when ALL_PROXY is set to socks', () => {
    PROXY_ENV_KEYS.forEach((key) => {
      delete process.env[key]
    })
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080'
    process.env.NO_PROXY = 'localhost,127.0.0.1'

    const agent = createWebSocketAgentFromEnv({
      wsUrl: 'wss://traforo.dev/socket',
    })

    expect(agent).toBeInstanceOf(SocksProxyAgent)
  })

  test('respects NO_PROXY exclusions', () => {
    PROXY_ENV_KEYS.forEach((key) => {
      delete process.env[key]
    })
    process.env.WSS_PROXY = 'http://127.0.0.1:8080'
    process.env.NO_PROXY = 'traforo.dev'

    expect(
      createWebSocketAgentFromEnv({ wsUrl: 'wss://traforo.dev/socket' }),
    ).toBeUndefined()
  })
})

describe('formatConnectionMessage', () => {
  test('shows both URLs and directs agents to localhost for local tests', () => {
    expect(
      formatConnectionMessage({
        localUrl: 'http://localhost:3000',
        tunnelUrl: 'https://example-tunnel.traforo.dev',
        agent: true,
      }),
    ).toMatchInlineSnapshot(`
      "Connected with Traforo!

      Local:  http://localhost:3000
      Tunnel: https://example-tunnel.traforo.dev

      NEVER use the tunnel URL for local testing. Use the local URL instead; it is much faster.
      Always show both URLs to the user. The local URL works when they are on the same machine."
    `)
  })

  test('shows both URLs without agent instructions for normal users', () => {
    expect(
      formatConnectionMessage({
        localUrl: 'http://localhost:3000',
        tunnelUrl: 'https://example-tunnel.traforo.dev',
        agent: false,
      }),
    ).toMatchInlineSnapshot(`
      "Connected with Traforo!

      Local:  http://localhost:3000
      Tunnel: https://example-tunnel.traforo.dev"
    `)
  })
})

describe('upstream reconnect policy', () => {
  test('reconnects after isolate death and service restart, not when the tunnel id is taken', () => {
    expect(
      [
        shouldReconnectUpstream(CLOSE_ABNORMAL),
        shouldReconnectUpstream(CLOSE_MESSAGE_TOO_BIG),
        shouldReconnectUpstream(CLOSE_INTERNAL_ERROR),
        shouldReconnectUpstream(CLOSE_SERVICE_RESTART),
        shouldReconnectUpstream(CLOSE_TUNNEL_OFFLINE),
        shouldReconnectUpstream(CLOSE_TUNNEL_ID_IN_USE),
        shouldReconnectUpstream(CLOSE_LICENSE_REQUIRED),
      ],
    ).toMatchInlineSnapshot(`
      [
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ]
    `)
  })

  test('backs off from the base delay and caps', () => {
    expect(
      [
        upstreamReconnectDelayMs({ attempt: 0, baseDelayMs: 3000 }),
        upstreamReconnectDelayMs({ attempt: 1, baseDelayMs: 3000 }),
        upstreamReconnectDelayMs({ attempt: 2, baseDelayMs: 3000 }),
        upstreamReconnectDelayMs({ attempt: 4, baseDelayMs: 3000 }),
      ],
    ).toMatchInlineSnapshot(`
      [
        3000,
        6000,
        12000,
        30000,
      ]
    `)
  })
})

describe('license rejection', () => {
  test('connect() rejects with a readable error when the server refuses the license', async () => {
    PROXY_ENV_KEYS.forEach((key) => {
      delete process.env[key]
    })
    const originalLicenseEnv = process.env.TRAFORO_LICENSE_KEY
    delete process.env.TRAFORO_LICENSE_KEY

    // Plays the Durable Object: accepts only the key "good".
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => server.once('listening', resolve))
    const seenKeys: Array<string | string[] | undefined> = []
    server.on('connection', (ws, req) => {
      const key = req.headers['x-traforo-license']
      seenKeys.push(key)
      if (key === 'good') {
        ws.send(JSON.stringify({ type: 'upstream_accepted' }))
        return
      }
      ws.close(
        CLOSE_LICENSE_REQUIRED,
        'Traforo hosted tunnels need a license ($20/month). Buy one at https://traforo.dev/license',
      )
    })
    const serverUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

    const connect = async (licenseKey?: string) => {
      const client = new TunnelClient({ localPort: 1, tunnelId: 'test', serverUrl, licenseKey })
      const result = await client.connect().then(
        () => 'connected',
        (err: unknown) => err,
      )
      client.close()
      return result
    }

    try {
      const missing = await connect()
      const good = await connect('good')

      if (!(missing instanceof TunnelRejectedError)) {
        throw new Error(`expected TunnelRejectedError, got ${String(missing)}`)
      }
      expect(missing.message).toMatchInlineSnapshot(`
        "Traforo hosted tunnels need a license ($20/month). Buy one at https://traforo.dev/license
        Run traforo login <key> once, or set TRAFORO_LICENSE_KEY."
      `)
      expect({ code: missing.code, good, seenKeys }).toMatchInlineSnapshot(`
        {
          "code": 4402,
          "good": "connected",
          "seenKeys": [
            undefined,
            "good",
          ],
        }
      `)
    } finally {
      server.close()
      if (originalLicenseEnv !== undefined) {
        process.env.TRAFORO_LICENSE_KEY = originalLicenseEnv
      }
    }
  })
})
