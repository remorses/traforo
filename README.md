HTTP tunnel via **Cloudflare Durable Objects** and **WebSockets**.
Expose local servers to the internet with a simple CLI.
Infinitely scalable with support for Cloudflare CDN caching and password protection.

## Installation

```bash
npm install -g traforo
```

## Usage

Expose a **local server** by pointing traforo at a port:

```bash
traforo -p 3000
```

<Aside>
<Tip>
When you pass a command after `--`, traforo **auto-detects** the port from
the process output so you don't need `-p` at all.
</Tip>
</Aside>

Or let traforo auto-detect the port from a dev server command:

```bash
traforo -- pnpm dev
traforo -- next start
```

With a **custom tunnel ID** (only for services safe to expose publicly):

```bash
traforo -p 3000 -t my-app
```

Run a command and tunnel it:

```bash
traforo -- next start
traforo -- pnpm dev
traforo -p 5173 -- vite
traforo -p 3000 -- next start    # explicit port overrides auto-detection
```

The tunnel URL will be:

```
https://{tunnel-id}-tunnel.traforo.dev
```

## Options

```
-p, --port <port>          Local port to expose (optional with -- command)
-t, --tunnel-id [id]       Custom tunnel ID (prefer random default)
-c, --cache [key]          Enable edge caching (optional partition key)
--password <password>      Protect the tunnel with a password
-h, --host [host]          Local host (default: localhost)
-s, --server [url]         Custom tunnel server URL
--help                     Show help
--version                  Show version
```

## Auto Port Detection

When you pass a command after `--`, traforo can **detect the local port** from the
process output. It watches stdout and stderr for addresses like these:

```
http://localhost:3000
localhost:5173
127.0.0.1:8080
0.0.0.0:4321
```

<Aside>
<Note>
If you also pass **`-p`**, traforo uses that explicit port instead of
auto-detecting from process output.
</Note>
</Aside>

This works well with common dev servers that print their local URL when they start.

## Edge Caching

Cache responses at **Cloudflare's edge** so repeat requests never hit your
local machine:

```bash
traforo -p 3000 --cache
```

<Aside>
<Info>
The **`X-Traforo-Cache`** response header shows `HIT`, `MISS`, or `BYPASS`
for debugging. When `BYPASS`/`MISS` comes from the local origin path,
`X-Traforo-Cache-Reason` explains why.
</Info>
</Aside>

**What gets cached:**

- **GET requests** where the origin sends cacheable `Cache-Control` headers
  (`public`, `max-age`, `s-maxage`)
- **Static asset extensions** use Cloudflare-like default fallback TTLs when
  cache headers are missing: `200`/`301`=120m, `302`/`303`=20m, `404`/`410`=3m

**What never gets cached:**

- Non-GET requests
- `206 Partial Content` responses (Cache API `put()` limitation)
- Responses with `Set-Cookie`, `Cache-Control: no-store/no-cache/private`
- **Streaming responses** (SSE, ndjson)
- **WebSocket connections**

Requests with `Authorization`, `Cache-Control: no-cache/no-store/max-age=0`,
or `Pragma: no-cache` bypass edge cache lookup.

### Cache Partitioning

**Cache partitioning** lets you bust all cached content by changing the key:

```bash
traforo -p 3000 --cache v1     # first deployment
traforo -p 3000 --cache v2     # new deploy, fresh cache
```

Each key creates a **separate cache namespace**. Old entries expire via TTL.

## Password Protection

Restrict tunnel access with a **password**:

```bash
traforo -p 3000 --password mysecret
```

Visitors in a browser see a **login page**. After entering the correct password
a `traforo-password` cookie is set and they can browse normally.

<Aside>
<Warning>
**WebSocket upgrade** requests without the correct cookie are rejected with
close code `4013`.
</Warning>
</Aside>

Non-browser clients (curl, APIs) get a `401 Unauthorized` response with
instructions to pass the password as a cookie:

```bash
curl -b 'traforo-password=mysecret' https://{tunnel-id}-tunnel.traforo.dev
```

## TRAFORO_URL Environment Variable

When you run a command after `--`, traforo injects **`TRAFORO_URL`** into the
child process environment with the full public tunnel URL:

```
TRAFORO_URL=https://{tunnel-id}-tunnel.traforo.dev
```

Your app can read it directly:

```ts
const baseUrl = process.env.TRAFORO_URL
```

<Aside>
<Tip>
To remap it to a **custom env var** your app already uses, prefix the command
with `sh -c` and reference `$TRAFORO_URL`.
</Tip>
</Aside>

To remap it to a custom env var your app already uses, prefix the command:

```bash
traforo -p 3000 -- sh -c 'APP_URL=$TRAFORO_URL exec node server.js'
traforo -p 3000 -- sh -c 'NEXT_PUBLIC_URL=$TRAFORO_URL exec next dev'
traforo -p 3000 -- sh -c 'VITE_BASE_URL=$TRAFORO_URL exec vite'
```

Or set it in your `.env` / startup script and let traforo override only
`TRAFORO_URL`, reading it where needed:

```js
// next.config.js
const baseUrl = process.env.APP_URL || process.env.TRAFORO_URL || 'http://localhost:3000'
```

## Path Inheritance

Package managers like **pnpm** and **bun** prepend `node_modules/.bin` to `PATH`.
Traforo passes the **full parent environment** to child commands, so
project-local binaries work without `pnpm exec` or `npx`:

```bash
pnpm traforo -- vite dev
pnpm traforo -- next start
bun traforo -- wrangler dev
```

## Reverse Proxy Headers

Traforo injects standard **reverse-proxy headers** when forwarding requests to
your local server:

```
X-Forwarded-Host:  {tunnel-id}-tunnel.traforo.dev
X-Forwarded-Proto: https
```

<Aside>
<Note>
These headers are only added if **not already present** in the incoming
request. No configuration needed.
</Note>
</Aside>

Frameworks like **BetterAuth**, **Next.js**, **Express** (with `trust-proxy`),
and **Hono** use these to construct correct redirect URLs and absolute links
instead of pointing back to `localhost`.

If your framework reads `X-Forwarded-Host` or `X-Forwarded-Proto`, redirects
and **OAuth callbacks** will use the public tunnel URL automatically.

## Cloudflare Workers (Wrangler Dev)

When running a Cloudflare Workers project via `traforo -- wrangler dev`,
traforo sets **`CLOUDFLARE_INCLUDE_PROCESS_ENV=true`** in the child process
environment. This tells wrangler to pass parent env vars (including
`TRAFORO_URL`) as local development bindings, so `process.env.TRAFORO_URL`
works inside workerd.

```bash
traforo -- wrangler dev
```

```ts
// Inside your worker:
const baseUrl = process.env.TRAFORO_URL
```

<Aside>
<Warning>
This only works when **no `.dev.vars` file** exists in the project. If you use
`.dev.vars`, add `TRAFORO_URL` there manually or use a startup script that
reads the env var.
</Warning>
</Aside>

## How It Works

```diagram
  CLI Client                Cloudflare Edge               Local Server
      │                          │                             │
      │  WebSocket connect       │                             │
      │ ────────────────────►    │                             │
      │                          │                             │
      │                    ┌─────┴─────┐                       │
      │                    │  Durable  │    HTTP request        │
      │                    │  Object   │ ◄─── browser/curl      │
      │                    └─────┬─────┘                       │
      │                          │                             │
      │  forward request via WS  │                             │
      │ ◄────────────────────    │                             │
      │                          │                             │
      │         http://localhost:PORT                           │
      │ ──────────────────────────────────────────────────►    │
      │                          │                             │
      │ ◄──────────────────────────────────────────────────    │
      │  response                │                             │
      │ ────────────────────►    │                             │
      │                    ┌─────┴─────┐                       │
      │                    │  respond  │ ───► browser/curl      │
      │                    └───────────┘                       │
```

1. Local client connects to **Cloudflare Durable Object** via WebSocket
2. HTTP requests to tunnel URL are forwarded to the DO
3. DO sends requests over **WebSocket** to local client
4. Local client makes request to **localhost** and returns response
5. **WebSocket connections** from users are also proxied through

## API Endpoints

```
/traforo-status         Check if tunnel is online
/traforo-upstream       WebSocket endpoint for local client
/traforo-login          POST endpoint for password login
/*                      All other paths proxied to local server
```

## Library Usage

```ts
import { TunnelClient } from 'traforo/client'
import { runTunnel } from 'traforo/run-tunnel'

const client = new TunnelClient({
  localPort: 3000,
  tunnelId: 'my-app',
  cacheKey: 'v1',       // optional: enable edge caching
  password: 'mysecret', // optional: password protection
})

await client.connect()
```

## License

MIT
