---
'traforo': minor
---

Prevent subdomain hijacking on stable tunnel IDs.

Previously, if Alice was running `traforo -t my-app`, anyone else could run the same command and
silently replace her as the upstream, receiving all traffic meant for her server. This was a
man-in-the-middle attack vector.

Now the Durable Object **rejects** new upstream connections when one is already active, closing
the attacker's socket with code 4409 and the message "already in use". The original upstream
stays untouched. Once the original client disconnects, the tunnel ID becomes available again.

The client also handles 4409 as a fatal error: it prints a clear message and exits instead of
silently retrying in a loop.

```
Error: Tunnel ID "my-app" is already in use by another client
```

**Other improvements in this change:**

- The DO now sends an `upstream_accepted` ACK after accepting the upstream WebSocket. The client
  resolves `connect()` only after receiving this message, not on WebSocket `open`. This makes it
  possible to reliably distinguish accepted vs rejected connections.
- Password and cache key state is only applied after the upstream is accepted. A rejected
  connection can no longer mutate the live tunnel's password or caching configuration.
- Added 10-second ACK timeout so `connect()` doesn't hang forever against an older deployed worker.
