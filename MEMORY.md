## license keys (hosted traforo.dev)

- Paid hosted plan: $20/month via Polar license keys. No webhooks: worker calls the public `customer-portal/license-keys/validate` endpoint on upstream connect, caches valid keys 1h, fails open when Polar errors.
- Off by default (`LICENSE_REQUIRED: "false"` in `worker/wrangler.json`) so self-hosters change nothing.
- Polar org `morse`: ID `0a5fd52e-d5a1-40f9-ab65-3a0b215b9658`, product `2768f9a9-6827-4a97-8dd0-01c3c1048c2d`, benefit `27c5d069-6c5c-406a-8186-7316108da158`, keys prefixed `traforo_`.
- Clients print `https://traforo.dev/license`; `website/src/server.tsx` redirects it to the Polar checkout link, so the target can change without a client release.
- Polar org is active and its checkout accepts paid subscriptions. No real purchase has been tested.
- CLI users run `traforo login <key>` once. Keys are stored with owner-only permissions and scoped by server; `TRAFORO_LICENSE_KEY` overrides saved keys. Library clients only read explicit keys or the environment.
- `LICENSE_REQUIRED` is `"true"` in production (enabled Oct 2026, user request) and `"false"` in preview so `src/tunnel.test.ts` keeps working. The production worker also serves `*-tunnel.kimaki.dev` and `*-tunnel.kimaki.xyz`, so those need a key too.
- Worker only accepts keys of benefit `27c5d069-…` in org `0a5fd52e-…` (hardcoded in `src/tunnel.ts`).
