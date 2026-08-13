---
'traforo': patch
---

Show both the local and tunnel URLs after connecting.

Never use the tunnel URL for local testing. Use the localhost URL instead; it is much faster. Always print both URLs so people on the same machine can use localhost.

```
Connected with Traforo!

Local:  http://localhost:3000
Tunnel: https://example-tunnel.traforo.dev

NEVER use the tunnel URL for local testing. Use the local URL instead; it is much faster.
Always show both URLs to the user. The local URL works when they are on the same machine.
```
