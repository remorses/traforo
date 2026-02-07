# Changelog

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
