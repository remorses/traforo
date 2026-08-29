---
'traforo': patch
---

Complete WebSocket close handshakes so a normal disconnect is not reported as **1006**.

The worker `compatibility_date` is now **2026-07-30**. On that date Cloudflare auto-replies to peer close frames. Clients only see **1006** when the isolate actually dies (no close frame), not when the other side closes cleanly.
