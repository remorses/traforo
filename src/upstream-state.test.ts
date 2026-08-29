/**
 * Tests the stale-upstream selection and send behavior used by the tunnel DO.
 */

import { describe, expect, test, vi } from 'vitest'
import {
  getActiveUpstream,
  isStaleUpstream,
  sendUpstreamMessage,
  takeWaitersForTunnel,
  type UpstreamAttachment,
  type UpstreamSocketLike,
} from './upstream-state.js'

class FakeSocket implements UpstreamSocketLike {
  public sends: string[] = []
  public closes: Array<{ code: number; reason: string }> = []

  constructor(
    private readonly attachment: UpstreamAttachment,
    private readonly shouldThrow = false,
  ) {}

  deserializeAttachment(): UpstreamAttachment {
    return this.attachment
  }

  send(data: string): void {
    if (this.shouldThrow) {
      throw new Error('Network connection lost')
    }
    this.sends.push(data)
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
  }
}

describe('upstream-state', () => {
  test('prefers the newest upstream socket when old and new sockets coexist', () => {
    const stale = new FakeSocket({
      role: 'upstream',
      tunnelId: 'abc',
      connectedAt: 1,
    })
    const fresh = new FakeSocket({
      role: 'upstream',
      tunnelId: 'abc',
      connectedAt: 2,
    })

    expect(getActiveUpstream([stale, fresh], 'abc')).toBe(fresh)
    expect(isStaleUpstream([stale, fresh], 'abc', stale)).toBe(true)
    expect(isStaleUpstream([stale, fresh], 'abc', fresh)).toBe(false)
  })

  test('ignores send failures from stale upstream sockets', () => {
    const stale = new FakeSocket(
      { role: 'upstream', tunnelId: 'abc', connectedAt: 1 },
      true,
    )
    const fresh = new FakeSocket({
      role: 'upstream',
      tunnelId: 'abc',
      connectedAt: 2,
    })
    const onDisconnect = vi.fn()
    const logError = vi.fn()
    const logInfo = vi.fn()

    expect(
      sendUpstreamMessage({
        tunnelId: 'abc',
        sockets: [stale, fresh],
        upstream: stale,
        message: { type: 'ws_open', connId: '1', path: '/ws', headers: {} },
        context: 'WS 1',
        logError,
        logInfo,
        onDisconnect,
      }),
    ).toBe(false)

    expect(onDisconnect).not.toHaveBeenCalled()
    expect(stale.closes).toEqual([])
    expect(logInfo).toHaveBeenCalledWith(
      '[DO] Ignoring send failure from stale upstream for abc',
    )
  })

  test('takes only waiters for the tunnel that just came online', () => {
    const waiters = new Map([
      ['a', { tunnelId: 'abc', path: '/extension' }],
      ['b', { tunnelId: 'other', path: '/ws' }],
      ['c', { tunnelId: 'abc', path: '/hmr' }],
    ])

    expect(takeWaitersForTunnel(waiters, 'abc')).toEqual([
      { tunnelId: 'abc', path: '/extension' },
      { tunnelId: 'abc', path: '/hmr' },
    ])
    expect([...waiters.keys()]).toEqual(['b'])
  })
})
