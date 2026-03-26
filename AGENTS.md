# Traforo Agent Instructions

## Cloudflare Durable Object Hibernation

**Class fields do not survive hibernation.** When a DO hibernates between requests, the runtime reconstructs the class from scratch — all in-memory properties reset to their constructor defaults. Only these survive:

- **Durable Storage** (`this.ctx.storage`)
- **WebSocket attachments** (`ws.serializeAttachment()` / `ws.deserializeAttachment()`)
- **WebSocket tags** (`this.ctx.getWebSockets(tag)`)

Any state that must persist across hibernation must be stored in one of these. For lightweight metadata (like the tunnel password or cache key), WebSocket attachments are the simplest option — they're serialized by the runtime and restored automatically.

**Pattern:** use a getter method that checks the in-memory field first, then falls back to reading from a WebSocket attachment:

```ts
private getPassword(tunnelId: string): string | null {
  if (this.password) return this.password
  const upstream = this.getUpstream(tunnelId)
  const attachment = upstream?.deserializeAttachment() as Attachment | undefined
  if (attachment?.password) {
    this.password = attachment.password // re-cache in memory
    return this.password
  }
  return null
}
```

## Deploying

After modifying `src/tunnel.ts`, you must redeploy the worker AND reconnect the tunnel client for changes to take effect:

```bash
npx wrangler deploy        # deploy worker
# then restart the CLI client so the DO gets fresh upstream connection params
```

All fields that must survive hibernation (`password`, `cacheKey`, `lastActivity`) use this pattern and are stored on the upstream WebSocket attachment.

## Cloudflare WebSocket Features We Rely On

Docs:
- Hibernation API: https://developers.cloudflare.com/durable-objects/best-practices/use-websockets/
- DO lifecycle: https://developers.cloudflare.com/durable-objects/runtime/lifecycle/
- Hibernation example: https://developers.cloudflare.com/durable-objects/examples/build-websocket-server-with-hibernation/

### Auto-response (setWebSocketAutoResponse)

The DO constructor registers an auto-response pair:
```ts
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
)
```

When the client sends `{"type":"ping"}`, the **Cloudflare edge** responds with `{"type":"pong"}` without waking the DO from hibernation. Zero billing during idle periods. Only one auto-response pair can be active at a time (second call overrides first).

### CDN inactivity timeout (~100 seconds)

Cloudflare's CDN has a **non-configurable ~100 second inactivity timeout** on WebSocket connections. If no frames pass through in ~100s, the CDN terminates the connection. The client sends `{"type":"ping"}` every 30s to keep the wire alive. This is handled entirely at the edge via auto-response — the DO stays hibernated.

Docs:
- https://developers.cloudflare.com/fundamentals/network/network-settings/web-sockets/
- https://developers.cloudflare.com/web-sockets/

### ctx.acceptWebSocket (hibernation-aware accept)

Use `this.ctx.acceptWebSocket(server, tags)` instead of `server.accept()`. This is what enables hibernation — the DO can go to sleep while clients stay connected to the Cloudflare edge. Tags allow querying sockets later via `this.ctx.getWebSockets(tag)`.

### Outgoing WebSockets do NOT support hibernation

Hibernation only works for **incoming** WebSocket connections accepted via `ctx.acceptWebSocket()`. If a DO opens an outgoing WebSocket via `new WebSocket()`, the DO is pinned in memory indefinitely. We don't use outgoing WebSockets — the local client connects TO the DO (incoming).

### Hibernation timeline

- DO goes idle → hibernated after ~10 seconds of inactivity
- Non-hibernatable idle DO → evicted after 70-140 seconds
- WebSocket auto-response does NOT interrupt hibernation
- `webSocketMessage` handler wakes the DO on any non-auto-response message

### DO alarm for periodic work

Use `this.ctx.storage.setAlarm(date)` if you ever need periodic DO-side work (cleanup, expiration). Alarms wake the DO from hibernation. We don't currently use alarms but they're the correct tool if needed.
