/**
 * Focused tests for the tunnel client's proxy-aware WebSocket agent helper.
 */

import { afterEach, describe, expect, test } from 'vitest'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import {
  createWebSocketAgentFromEnv,
  formatConnectionMessage,
} from './client.js'

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
