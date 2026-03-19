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

The `cacheKey` field has the same hibernation concern — it's currently only set during upstream connection. If bugs arise around caching after idle periods, apply the same attachment-recovery pattern.
