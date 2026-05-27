/**
 * Cloudflare-like cache eligibility policy used by the Durable Object cache layer.
 *
 * Source references for Cloudflare behavior:
 * - https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
 * - https://developers.cloudflare.com/cache/concepts/cache-control/
 * - https://developers.cloudflare.com/cache/how-to/configure-cache-status-code/
 * - https://developers.cloudflare.com/workers/runtime-apis/cache/
 */

import CachePolicy from 'http-cache-semantics'

type CacheDecision = {
  cacheable: boolean
  reason: string
  /** Optional Cache-Control value applied only to the cached copy */
  cacheControlOverride?: string
}

type EvaluateCacheabilityInput = {
  request: Request
  responseStatus: number
  responseHeaders: Headers
}

const DEFAULT_EXTENSION_TTLS_SECONDS = new Map<number, number>([
  [200, 120 * 60],
  [301, 120 * 60],
  [302, 20 * 60],
  [303, 20 * 60],
  [404, 3 * 60],
  [410, 3 * 60],
])

const DEFAULT_CACHEABLE_EXTENSIONS = new Set([
  '7z',
  'avi',
  'avif',
  'apk',
  'bin',
  'bmp',
  'bz2',
  'class',
  'css',
  'csv',
  'doc',
  'docx',
  'dmg',
  'ejs',
  'eot',
  'eps',
  'exe',
  'flac',
  'gif',
  'gz',
  'ico',
  'iso',
  'jar',
  'jpeg',
  'jpg',
  'js',
  'm4a',
  'mid',
  'midi',
  'mkv',
  'mp3',
  'mp4',
  'ogg',
  'otf',
  'pdf',
  'pict',
  'pls',
  'png',
  'ppt',
  'pptx',
  'ps',
  'rar',
  'svg',
  'svgz',
  'swf',
  'tar',
  'tif',
  'tiff',
  'ttf',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'zip',
  'zst',
])

const STREAMING_CONTENT_TYPES = ['text/event-stream', 'application/x-ndjson']

export function evaluateCloudflareCacheability(
  input: EvaluateCacheabilityInput,
): CacheDecision {
  const { request, responseStatus, responseHeaders } = input

  if (request.method !== 'GET') {
    return { cacheable: false, reason: 'method-not-get' }
  }

  // Cache API put() rejects 206 responses.
  if (responseStatus === 206) {
    return { cacheable: false, reason: 'status-206-not-supported-by-cache-api' }
  }

  if (responseHeaders.has('set-cookie')) {
    return { cacheable: false, reason: 'response-has-set-cookie' }
  }

  const varyHeader = responseHeaders.get('vary') || ''
  if (varyHeader.includes('*')) {
    return { cacheable: false, reason: 'response-vary-star-not-cacheable' }
  }

  const contentType = (responseHeaders.get('content-type') || '').toLowerCase()
  if (STREAMING_CONTENT_TYPES.some((value) => contentType.includes(value))) {
    return { cacheable: false, reason: 'streaming-response' }
  }

  const responseHeadersRecord = headersToRecord(responseHeaders)
  const requestHeadersRecord = headersToRecord(request.headers)

  try {
    const policy = new CachePolicy(
      {
        method: request.method,
        url: request.url,
        headers: requestHeadersRecord,
      },
      {
        status: responseStatus,
        headers: responseHeadersRecord,
      },
      {
        shared: true,
        cacheHeuristic: 0,
      },
    )

    const storable = policy.storable()
    if (storable) {
      const ttlMs = policy.timeToLive()
      if (ttlMs > 0) {
        return { cacheable: true, reason: 'http-cache-semantics-storable' }
      }
    } else {
      return { cacheable: false, reason: 'http-cache-semantics-not-storable' }
    }
  } catch {
    // Fall through to Cloudflare-like default fallback checks.
  }

  // Cloudflare-like default fallback: cache static extensions by default status TTL
  // only when origin did not provide explicit cache freshness headers.
  const cacheControl = responseHeaders.get('cache-control')
  const expires = responseHeaders.get('expires')
  const pragma = (responseHeaders.get('pragma') || '').toLowerCase()
  if (pragma.includes('no-cache')) {
    return {
      cacheable: false,
      reason: 'response-pragma-no-cache',
    }
  }

  if (cacheControl || expires) {
    return {
      cacheable: false,
      reason: 'explicit-cache-headers-not-storable',
    }
  }

  const pathname = new URL(request.url).pathname
  const extension = getExtension(pathname)
  if (!extension || !DEFAULT_CACHEABLE_EXTENSIONS.has(extension)) {
    return {
      cacheable: false,
      reason: 'path-extension-not-default-cacheable',
    }
  }

  const fallbackTtl = DEFAULT_EXTENSION_TTLS_SECONDS.get(responseStatus)
  if (!fallbackTtl) {
    return {
      cacheable: false,
      reason: 'status-not-default-cacheable',
    }
  }

  return {
    cacheable: true,
    reason: 'cloudflare-default-fallback',
    cacheControlOverride: `public, s-maxage=${fallbackTtl}`,
  }
}

export function getRequestCacheBypassReason(request: Request): string | null {
  if (request.headers.has('authorization')) {
    return 'request-has-authorization'
  }

  const pragma = (request.headers.get('pragma') || '').toLowerCase()
  if (pragma.includes('no-cache')) {
    return 'request-pragma-no-cache'
  }

  const cacheControl = (request.headers.get('cache-control') || '').toLowerCase()
  if (cacheControl.includes('no-store')) {
    return 'request-cache-control-no-store'
  }

  if (cacheControl.includes('no-cache')) {
    return 'request-cache-control-no-cache'
  }

  if (cacheControl.includes('max-age=0')) {
    return 'request-cache-control-max-age-0'
  }

  return null
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase()
    const existing = record[normalizedKey]
    record[normalizedKey] = existing ? `${existing}, ${value}` : value
  })
  return record
}

function getExtension(pathname: string): string | null {
  const lastSegment = pathname.split('/').pop() || ''
  const dotIndex = lastSegment.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return null
  }

  return lastSegment.slice(dotIndex + 1).toLowerCase()
}
