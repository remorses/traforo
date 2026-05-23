---
'traforo': patch
---

Fix port auto-detection matching Vite's "Port X is in use" fallback lines.

When Vite's default port is occupied, it prints lines like `Port 5173 is in use, trying another one...` before binding to a different port. The broad `\bport\s+(\d+)\b` regex matched these noise lines, causing traforo to detect the *occupied* port instead of the one Vite actually binds to. Then `waitForPort` would either connect to the wrong process or time out.

The fix adds `/\bport\s+\d+\s+is\s+in\s+use\b/i` to `IGNORED_LINE_PATTERNS` so these lines are skipped, and the actual `http://localhost:5176/` line is detected correctly.
