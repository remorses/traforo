# Changelog

## 0.7.2

1. **Better error messages with recovery hints** — all timeout and connection errors now include actionable suggestions instead of generic messages:
   - Port detection timeout shows elapsed seconds and suggests `traforo -p <port> -- <command>`
   - Tunnel acceptance timeout explains the worker may be unresponsive
   - Tunnel ID conflict suggests `--tunnel-id` or omitting `-t` for a random ID
   - Connection failure clarifies it's the tunnel server and suggests checking internet
2. **Reduced port detection timeout from 60s to 30s** — most dev servers print their URL in under 10 seconds; the shorter timeout gives faster feedback when something is wrong

## 0.7.1

1. **Fixed port detection failing when dev servers use ANSI colors** — Vite and other dev servers embed ANSI escape codes inside URLs when `FORCE_COLOR=1` is set (which traforo injects). For example, Vite outputs color codes between `localhost:` and the port number, splitting the string so the port regex never matches and detection times out. Port output is now stripped of all ANSI escape sequences before running the port regex.

## 0.7.0

1. **Self-hosting support via `TRAFORO_BASE_DOMAIN`** — deploy your own traforo instance on Cloudflare and point the CLI at it with a single env variable:

   ```bash
   export TRAFORO_BASE_DOMAIN=example.com
   traforo -p 3000
   # => https://{id}-tunnel.example.com
   ```

   Works with both the CLI and the Node.js `TunnelClient` API (pass `baseDomain` or set the env var). See the [Self-Hosting guide](./README.md#self-hosting) for full setup instructions including wrangler deployment and wildcard DNS configuration.

2. **Fixed port auto-detection false positives from Vite** — when Vite's default port is occupied, it prints lines like `Port 5173 is in use, trying another one...` before binding to a different port. The port detection regex matched these noise lines, causing traforo to detect the occupied port instead of the one Vite actually binds to. Port detection now only matches lines containing an actual URL (`localhost:PORT`, `127.0.0.1:PORT`, etc.), eliminating false positives from any "port X is in use" style messages.

## 0.6.1

1. **Fixed orphan child processes on exit** — previously, `traforo -- <command>` would call `child.kill()` followed by an immediate `process.exit()`, leaving the child running. Now traforo forwards the original signal (`SIGINT`, `SIGTERM`, `SIGHUP`) to the child, waits for it to exit, and falls back to `SIGKILL` after 5 seconds if it doesn't terminate.

2. **Fixed false port detection from Node.js inspector output** — lines like `"Default inspector port 9229 not available"` were being matched as the dev server port, causing traforo to connect to the wrong port. Port detection now skips inspector, debugger, and devtools output before applying URL/port patterns:

   ```
   # This no longer triggers a false match:
   Debugger listening on ws://127.0.0.1:9229/...
   Default inspector port 9229 not available

   # Only the real dev server line is detected:
   Local: http://localhost:4173/
   ```

## 0.6.0

1. **Prevent subdomain hijacking on stable tunnel IDs** — previously, if Alice was running `traforo -t my-app`, anyone else could run the same command and silently replace her as the upstream, receiving all traffic meant for her server. Now the Durable Object **rejects** new upstream connections when one is already active, closing the attacker's socket with code 4409:

   ```
   Error: Tunnel ID "my-app" is already in use by another client
   ```

   Once the original client disconnects, the tunnel ID becomes available again. The client handles 4409 as a fatal error and exits instead of silently retrying.

   The DO now sends an `upstream_accepted` ACK after accepting the upstream WebSocket. The client resolves `connect()` only after receiving this message, not on WebSocket `open`. This makes it possible to reliably distinguish accepted vs rejected connections. Password and cache key state is only applied after the upstream is accepted, so a rejected connection can no longer mutate the live tunnel's configuration. Also added a 10-second ACK timeout so `connect()` doesn't hang forever against an older deployed worker.

2. **Inject `X-Forwarded-Host` and `X-Forwarded-Proto` headers** — when proxying requests to localhost, traforo now injects standard reverse-proxy headers so frameworks like BetterAuth, Next.js, and Express (with trust-proxy) construct correct redirect URLs pointing to the public tunnel instead of `localhost`. Headers are only injected if not already present in the incoming request.

3. **`CLOUDFLARE_INCLUDE_PROCESS_ENV=true` for child processes** — when running commands via `traforo -- ...`, this env var is now set automatically. It lets `wrangler dev` pass parent env vars (including `TRAFORO_URL`) as worker bindings, so `process.env.TRAFORO_URL` works inside workerd without manual `.dev.vars` configuration.

## 0.5.0

1. **Proxy-aware WebSocket connections** — the tunnel client now automatically routes through HTTP, HTTPS, and SOCKS proxies based on standard environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`):

   ```bash
   # Route tunnel through a corporate proxy
   HTTP_PROXY=http://proxy.corp.com:8080 traforo -p 3000

   # SOCKS5 proxy
   ALL_PROXY=socks5://127.0.0.1:1080 traforo -p 3000

   # Exclude specific hosts
   NO_PROXY=localhost,127.0.0.1 traforo -p 3000
   ```

   No configuration needed — it picks up proxy settings from your environment automatically.

2. **Localhost URL hint for AI agents** — when traforo detects it's running inside an AI coding agent, it now shows both the tunnel URL and the local server URL so the agent can use localhost directly for faster responses:

   ```
   Connected with Traforo!
   https://abc123-3000-tunnel.traforo.dev

   Use http://localhost:3000 directly for lower latency.
   The tunnel URL is for remote access. Show both URLs to the user.
   ```

## 0.4.0

1. **`TRAFORO_URL` env var injected into child processes** — your app now receives its own public tunnel URL automatically when launched via `traforo -- <command>`:

   ```bash
   traforo -- node server.js
   # process.env.TRAFORO_URL → https://{id}-tunnel.traforo.dev
   ```

   Read it directly in your app:

   ```ts
   const baseUrl = process.env.TRAFORO_URL
   ```

   Remap to a custom env var your framework already uses with `sh -c`:

   ```bash
   traforo -p 3000 -- sh -c 'APP_URL=$TRAFORO_URL exec node server.js'
   traforo -p 3000 -- sh -c 'NEXT_PUBLIC_URL=$TRAFORO_URL exec next dev'
   traforo -p 3000 -- sh -c 'VITE_BASE_URL=$TRAFORO_URL exec vite'
   ```

   Or fall back to it in your config when no explicit URL is set:

   ```ts
   // next.config.js
   const baseUrl = process.env.APP_URL || process.env.TRAFORO_URL || 'http://localhost:3000'
   ```

## 0.3.0

1. **`--port` is now optional when running a command** — traforo detects the local port automatically from the dev server's output, so you no longer need to know the port upfront:

   ```bash
   traforo -- pnpm dev       # detects port from output
   traforo -- next start
   traforo -- vite
   ```

   It watches stdout and stderr for common address patterns (`localhost:PORT`, `127.0.0.1:PORT`, `0.0.0.0:PORT`) and connects the tunnel the moment the server announces it. Pass `-p` explicitly to override auto-detection.

   Child process output is now always forwarded through a pipe so traforo can observe it, which also means the output is always flushed line-by-line regardless of whether `-p` is provided.

2. **Fixed Vite asset imports failing through the tunnel** — `?import&url&inline` bare query flags were being rewritten to `?import=&url=&inline=` when traforo appended and removed its internal `_tunnelId` parameter via `URLSearchParams`. Vite serves the two forms differently (raw binary vs. JS module wrapper), causing dynamic imports and font loads to break. The query string is now preserved exactly as the client sent it.

## 0.2.5

1. **Fixed "Network connection lost" errors during client reconnects** — the Durable Object now always uses the newest upstream WebSocket when an old one is still closing during a reconnect. Previously it picked the first socket returned by `getWebSockets()`, which could be a stale dying connection, causing in-flight requests to fail with a spurious disconnect.

2. **Restart tunnel while preserving the URL** — the port-conflict error message now shows the exact command to restart while keeping the same tunnel ID, so existing consumers don't need to update their URLs:

   ```
   If you want to restart it without changing the tunnel URL for existing consumers, run:
     traforo -p 3000 -t abc123-3000 --kill -- pnpm dev
   ```

3. **Better production debugging** — unhandled errors in the Worker and Durable Object now return the error message and stack trace in the 500 response body and log close codes, roles, and pending request counts. Previously Cloudflare returned an opaque empty 500 with no stack in `wrangler tail`.

## 0.2.4

1. **Fixed stale tunnel detection for privileged processes** — `isLockfileStale` previously treated any signal error as "dead", including `EPERM` (process exists but you can't signal it). Only `ESRCH` (no such process) is now considered stale, so tunnels running as a different user or alongside system processes are no longer incorrectly reported as dead.

2. **Fixed: `--kill` no longer erases tunnel info when the kill fails** — the lockfile (which stores the tunnel URL and ID) is now only deleted after the port is confirmed free. Previously it was deleted before the check, losing the tunnel metadata if the kill attempt failed due to permissions or a slow process.

3. **`TRAFORO_HOME` env var overrides the lockfile directory** — by default lockfiles go to `~/.traforo/`. Set `TRAFORO_HOME` to redirect them elsewhere, useful for CI or sandboxed environments.

4. **Shell-safe suggested commands in error messages** — the `--kill` command hint printed in conflict errors now correctly quotes arguments containing spaces or special characters.

## 0.2.3

1. **Port conflict detection before starting the dev server** — when running `traforo -p PORT -- command`, if the port is already occupied the CLI now exits with a clear error instead of silently connecting the tunnel to the wrong process:

   ```
   Error: Port 3000 is already in use

     Tunnel:  https://abc123-3000-tunnel.traforo.dev
     ID:      abc123-3000
     Command: pnpm dev
     Dir:     /Users/me/my-app
     PID:     12345
     Started: 2026-04-06T09:00:00Z

   The same command in the same directory is already tunneled.
   Reuse the tunnel URL above instead of creating a new one.
   ```

   If the existing tunnel is running a **different** command, the error suggests `--kill` but also shows the existing tunnel URL so you can choose to reuse it instead.

2. **Tunnel lockfiles in `~/.traforo/`** — traforo now writes a `~/.traforo/{port}.json` file when a tunnel connects, storing the tunnel ID, URL, command, working directory, and PID. The file is removed on clean shutdown (`SIGINT`, `SIGTERM`, child exit). Stale lockfiles from crashed processes are detected via PID liveness check and ignored automatically.

3. **`--kill` now verifies the port freed up** — if `--kill` fails to terminate the process (permission issues, slow shutdown), the CLI exits with an error instead of proceeding and silently attaching to the wrong server.

## 0.2.2

1. **Shorter default tunnel IDs** — reduced from 128 bits to 80 bits (20 hex chars). Still non-guessable but shorter URLs:

   ```
   a1b2c3d4e5f6a7b8c9d0-3000.traforo.dev
   ```

## 0.2.1

1. **Default tunnel IDs are now non-guessable** — auto-generated tunnel IDs use 128 bits of cryptographic randomness followed by the local port, making them safe to use as public URLs without a custom ID:

   ```
   Before: a1b2c3d4e5f63000   (truncated UUID — only ~64 bits random)
   After:  a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-3000   (128 bits + port)
   ```

   Explicit `--tunnel-id` still works as before for intentional public exposure.

2. **Tunnel URL starts at the beginning of the line** — the connection message now prints the URL on its own line so it doesn't wrap on narrow terminals and stays easy to copy:

   ```
   Connected with Traforo!
   https://a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-3000.traforo.dev
   ```

## 0.2.0

1. **New `--kill` flag** — automatically kill whatever is already running on the target port before starting the tunnel:

   ```bash
   traforo -p 3000 --kill
   ```

   Useful when restarting dev servers that leave orphaned processes on the port.

2. **Port number in default tunnel ID** — auto-generated tunnel IDs now include the port, making it easier to tell tunnels apart at a glance:

   ```
   Before: a1b2c3d4e5f6g7h8
   After:  a1b2c3d4e5f6g7h83000
   ```

3. **Fixed WebSocket disconnects after ~100s of idle** — the Cloudflare CDN drops connections with no traffic after ~100 seconds. The client now sends a `ping` frame every 30s, handled entirely at the Cloudflare edge via auto-response (no DO wake-up, zero billing impact).

## 0.1.0

1. **Password protection for tunnels** — restrict access with `--password`:

   ```bash
   traforo -p 3000 --password mysecret
   ```

   Visitors in a browser see a styled login page. After entering the correct
   password a `traforo-password` cookie is set and they can browse normally.

   Non-browser clients (curl, APIs) get a 401 with instructions:

   ```bash
   curl -b 'traforo-password=mysecret' https://my-app-tunnel.traforo.dev
   ```

   WebSocket upgrades without a valid cookie are rejected with close code 4013.

2. **Library API: `password` option** — pass password when using `TunnelClient` or `runTunnel` directly:

   ```ts
   const client = new TunnelClient({
     localPort: 3000,
     tunnelId: 'my-app',
     password: 'mysecret',
   })
   ```

3. **Fixed crash on malformed cookies** — a `Cookie` header with percent-encoded garbage no longer throws a 500; invalid values fall back to raw strings.

## 0.0.9

### Highlights

- **Fix Vite HMR WebSocket payload type** - Text frames are now kept as text end-to-end, so browser clients receive JSON strings instead of `Blob` payloads. This fixes runtime errors like `"[object Blob] is not valid JSON"` in Vite HMR.
- **Harden public tunnel surface** - Tunnel ID validation and Cloudflare IP-based throttling were improved to better protect shared/public endpoints.
- **Stabilize throttling behavior** - `Retry-After` values are now consistent for rate-limited responses.

### Technical Notes

```ts
// before
if (isBinary || data instanceof Buffer) {
  // text frames from Node ws were misclassified as binary
}

// now
if (isBinary) {
  // binary => base64
} else {
  // text => utf8 string
}
```

```text
Local server WS text frame
        |
        v
Traforo client keeps text semantics
        |
        v
Browser receives string payload
        |
        v
Vite HMR JSON.parse(data) succeeds
```

### Tests

- Expanded Vite HMR coverage to assert that HMR `connected`/`update` messages are delivered as **non-binary** frames.

## 0.0.8

### Bug Fixes

- **WebSocket subprotocol forwarding** - DO now echoes `Sec-WebSocket-Protocol` header in 101 response and client forwards subprotocol to local server. Fixes connections from strict clients like ws library and Vite HMR that require protocol negotiation.
- **Query param proxying for WebSocket** - WebSocket proxy now forwards query params (e.g. `?token=xxx`) to local server. Previously dropped, breaking authenticated WS connections.
- **Internal query param leakage** - `_tunnelId` internal param is now stripped from HTTP and WebSocket requests before forwarding to local server.

### Tests

- **Vite HMR integration test** - Added comprehensive test that starts Vite dev server, tunnels it, and verifies HTML serving, module requests, HMR WebSocket connection with vite-hmr protocol, and live file updates.

## 0.0.7

### Bug Fixes

- **Fix multi-value Set-Cookie headers** - Multiple Set-Cookie headers from the local server were collapsed into one, losing all but the last cookie. Response headers now support string arrays so all Set-Cookie values are preserved through the tunnel.

### Improvements

- **Remove CORS header injection** - The tunnel no longer injects `Access-Control-Allow-Origin: *` and related CORS headers on every response. The tunnel is now a transparent proxy that forwards the local server's headers as-is. Previously, the injected CORS headers would overwrite the server's own CORS policy and break `credentials: 'include'` requests.
- **Forward OPTIONS requests to local server** - OPTIONS preflight requests are now proxied to the local server instead of being short-circuited with a 204 at the tunnel layer. This lets the local server handle its own CORS policy.

## 0.0.6

### Breaking Changes

- **Remove domain flag** - Removed `-d, --domain` CLI flag as the domain is now fixed/handled differently.

### Styling

- **Landing page** - Reduced max-width of the landing page for better readability.

## 0.0.5

### Features

- **Parametrizable base domain** - Added `baseDomain` option to client and `-d, --domain` CLI flag
- **Default domain changed** - Now defaults to `traforo.dev` instead of `kimaki.xyz`
- **Landing page** - Added simple monospace landing page at traforo.dev
- **Standalone repo** - Moved to standalone GitHub repo at github.com/remorses/traforo

## 0.0.4

### Patch Changes

- feat: **nicer offline page** - show a better looking HTML page when tunnel is offline
- fix: **client typings** - fix issue with client types export

## 0.0.3

### Bug Fixes

- **Binary WebSocket support** - Binary messages are now properly forwarded via base64 encoding. Previously binary messages were silently dropped.
- **Non-JSON WebSocket messages** - Plain text WebSocket messages are now forwarded correctly. Previously only JSON messages worked.
- **Preview URL pattern** - Fixed regex to handle both production (`*-tunnel.`) and preview (`*-tunnel-preview.`) URL patterns.
- **CLI executable permissions** - Build script now sets executable flag on `dist/cli.js`.

### Features

- **Preview deployment environment** - Added preview environment config in `wrangler.json` for testing before production.

### Improvements

- **Node.js 18+ required** - Added `engines` field requiring Node.js >= 18.0.0 (for native fetch).
- **Separate build/test tsconfig** - Test files are no longer compiled to dist.

### Tests

- Added 28 comprehensive integration tests covering:
  - HTTP methods (GET/POST/PUT/DELETE/PATCH)
  - Large request/response bodies (50KB/100KB)
  - Binary data transfers
  - Concurrent requests
  - SSE streaming
  - WebSocket connections (text, binary, broadcast, concurrent)
  - Offline tunnel behavior
  - Upstream reconnection

## 0.0.2

- Initial release with HTTP tunneling, WebSocket proxy, and SSE streaming support.
