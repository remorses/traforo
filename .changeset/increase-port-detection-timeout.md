---
'traforo': patch
---

Increase port auto-detection timeout from 60s to 120s.

When running `traforo -- pnpm dev` with slow startup (e.g. secret injection via sigillo, database migrations, wrangler setup), the child process can take well over 60 seconds before printing the localhost URL. The previous 60s default caused premature "Timeout waiting for command output to reveal a local port" errors.

Both `detectPortFromProcessOutput` and `waitForPort` now default to 120 seconds.
