---
'traforo': minor
---

Keep the same random tunnel URL when a tuistory session restarts.

traforo now uses tuistory's restart-scoped `TUISTORY_SESSION_ID` when no explicit `--tunnel-id` is provided:

```bash
tuistory -s app -- traforo -- pnpm dev
tuistory -s app restart
```

The URL remains non-guessable. Closing the session and launching a new one creates a new random URL.
