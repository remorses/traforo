# Changelog

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
