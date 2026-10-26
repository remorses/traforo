---
'traforo': minor
---

Add **license keys** for hosted tunnels. Save your key once with `traforo login <key>`; future CLI runs load it automatically. For CI, use `TRAFORO_LICENSE_KEY`. Libraries can pass the `licenseKey` option to `TunnelClient` and `runTunnel`.

```bash
traforo login <key>
traforo -p 3000
```

Saved keys have owner-only file permissions and are scoped to the tunnel server. For a custom server, pass the same `--server` option to `login` and the tunnel command. The environment variable overrides the saved key. Keys are never printed.

When the server requires a key and it is missing or invalid, it closes the tunnel with code **4402**. The CLI and library print a readable error with the buy link (https://traforo.dev/license) and do not reconnect. `connect()` rejects with a `TunnelRejectedError`.

Self-hosted workers are not affected: the check only runs when the worker sets `LICENSE_REQUIRED` to `"true"`. Only keys from the Traforo license benefit are accepted. Valid keys are cached for an hour and the check fails open when Polar is unreachable.

A reconnect that the server refuses (tunnel ID taken, license revoked) now calls `onFatalError` instead of leaving the client silently closed.
