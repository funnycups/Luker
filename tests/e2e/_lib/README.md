# tests/e2e/_lib

Shared helpers for the expanded e2e suite under `tests/e2e/<area>/`.

These helpers exist so each batch of e2e specs:
- spawns its own Luker server on an isolated port + data directory
- shares the same login/idle/send/restart primitives
- uses the same RP-immersive fixtures (no "say hi" placeholder content)

The legacy suites under `tests/frontend/` and `tests/skills-ui/playwright/`
keep their inline `awaitMainUI` helpers. New e2e under `tests/e2e/` should
import from here.

## Modules

- `server.js`   — spawn / probe-ready / restart / kill a Luker server on a
  configurable port + dataRoot. Each spec calls `startServer({batchKey})`
  which picks a port from the batch's reserved range and APFS-clones a
  fresh data directory from the shared seed.
- `page.js`     — `awaitMainUI(page)`, `loginIfNeeded(page)`, drawer toggles,
  chat send helpers, swipe helpers, restart-then-reopen helper.
- `fixtures.js` — programmatic builders for character cards, presets,
  world books, connection profiles, MG schemas — built directly into the
  spec's data directory so each spec controls its own corpus.
- `ports.js`    — single source of truth for per-batch port ranges so two
  batches running in parallel never collide.
