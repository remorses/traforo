/**
 * Pure helpers for choosing and sending to the active upstream tunnel socket.
 */

import { CLOSE_INTERNAL_ERROR, type UpstreamMessage } from './types.js'

export type UpstreamAttachment = {
  role: 'upstream' | 'downstream'
  tunnelId: string
  connectedAt?: number
}

export type UpstreamSocketLike = {
  deserializeAttachment(): UpstreamAttachment | undefined
  send(data: string): void
  close(code: number, reason: string): void
}

type SendUpstreamMessageOptions<TSocket extends UpstreamSocketLike> = {
  tunnelId: string
  sockets: readonly TSocket[]
  upstream: TSocket
  message: UpstreamMessage
  context: string
  logError: (message: string, error: unknown) => void
  logInfo: (message: string) => void
  onDisconnect: () => void
}

export function getActiveUpstream<TSocket extends UpstreamSocketLike>(
  sockets: readonly TSocket[],
  tunnelId: string,
): TSocket | null {
  let latest: { socket: TSocket; connectedAt: number } | null = null

  for (const socket of sockets) {
    const attachment = socket.deserializeAttachment()
    if (attachment?.role === 'upstream' && attachment.tunnelId === tunnelId) {
      const connectedAt = attachment.connectedAt ?? 0
      if (!latest || connectedAt >= latest.connectedAt) {
        latest = { socket, connectedAt }
      }
    }
  }

  return latest?.socket || null
}

export function takeWaitersForTunnel<T extends { tunnelId: string }>(
  waiters: Map<string, T>,
  tunnelId: string,
): T[] {
  const taken: T[] = []
  for (const [id, waiter] of waiters) {
    if (waiter.tunnelId === tunnelId) {
      waiters.delete(id)
      taken.push(waiter)
    }
  }
  return taken
}

export function isStaleUpstream<TSocket extends UpstreamSocketLike>(
  sockets: readonly TSocket[],
  tunnelId: string,
  upstream: TSocket,
): boolean {
  const active = getActiveUpstream(sockets, tunnelId)
  return active !== null && active !== upstream
}

export function sendUpstreamMessage<TSocket extends UpstreamSocketLike>(
  options: SendUpstreamMessageOptions<TSocket>,
): boolean {
  try {
    options.upstream.send(JSON.stringify(options.message) satisfies string)
    return true
  } catch (error) {
    options.logError(
      `[DO] upstream.send() failed for ${options.context}:`,
      error,
    )

    if (isStaleUpstream(options.sockets, options.tunnelId, options.upstream)) {
      options.logInfo(
        `[DO] Ignoring send failure from stale upstream for ${options.tunnelId}`,
      )
      return false
    }

    try {
      options.upstream.close(CLOSE_INTERNAL_ERROR, 'Network connection lost')
    } catch {}

    options.onDisconnect()
    return false
  }
}
