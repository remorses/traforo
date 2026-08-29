---
'traforo': patch
---

Reconnect after the tunnel isolate dies, and wait before closing public WebSockets as offline.

When Cloudflare kills a Durable Object, both sockets drop with **1006** and no close reason. **1009** (message too big) and **1011** also reconnect. The CLI **backs off** (3s, 6s, 12s, capped at 30s) and still treats **4409** (tunnel id in use) as fatal. Send failures no longer crash the client.

Public WebSocket dials no longer fail immediately if the upstream is still reconnecting. The Durable Object **waits 5 seconds** for the local client. If it connects in time, the dial succeeds. If not, the socket still closes with **4008 Tunnel offline**.
