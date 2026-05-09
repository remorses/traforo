---
'traforo': minor
---

Inject `X-Forwarded-Host` and `X-Forwarded-Proto` headers when proxying requests to localhost.

Frameworks like **BetterAuth**, **Next.js**, and **Express** (with trust-proxy) use these standard
reverse-proxy headers to construct correct redirect URLs. Without them, OAuth callbacks and other
redirects point to `localhost` instead of the public tunnel URL.

Headers are only injected if not already present in the incoming request.

Also sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` in the child process environment when running
commands via `traforo -- ...`. This lets `wrangler dev` pass parent env vars (including
`TRAFORO_URL`) as worker bindings, so `process.env.TRAFORO_URL` works inside workerd without
manual `.dev.vars` configuration.
