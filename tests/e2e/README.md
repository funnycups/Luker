# tests/e2e — Expanded Playwright e2e suite

This directory holds the post-2.7.0 expanded e2e suite. It complements
the legacy suites under `tests/frontend/` (Macro / iteration smoke) and
`tests/skills-ui/playwright/` (Skills UI smoke).

## Layout

```
tests/e2e/
├── _lib/           Shared fixtures and helpers (server, mock LLM, page, fixtures, ports)
├── _smoke/         Sanity test for the harness itself
├── _fixtures/      (reserved)
├── chat/           #1–#14   Chat main flow (send, swipe, edit, delete, continue, branch, export…)
├── character/      #15–#24  Character / Card App (import, edit, avatar, duplicate, delete cascade, dynamic WI)
├── worldinfo/      #25–#32  World Info (5 activation strategies, cache trim, bindings, recursion, vectors)
├── preset/         #33–#38  Preset / CPA (save/switch, export/import, character binding, Apply→Global, patch threshold)
├── server/         #39–#51  Connection profiles, multi-backend, uploads self-heal, multi-user, basicAuth, attachments
├── memorygraph/    #52–#60  Memory Graph (extract, persistence, branch isolation, schema, vector index, read-api)
├── varops/         #61–#66  var_ops / floor-state (multi-mutation, rollback, persist, malformed handling, op log)
├── orchestrator/   #67–#78  Director / Run Panel / spec→agenda→loop / critic / per-run tools / capsule / abort
├── iterstudio/     #79–#83  Iter-studio Apply→Global closed loops (CPA, MG Schema, Orchestrator, CEA Character)
├── groups/         #84–#88  Group chat rotation, MG+Skills coexist, director main speaker, persistence+branch+export
├── extensions/     #89–#98  Regex, vectors, authors note, quick reply, translate, TTS, SD, caption, slash, function-call
├── personas/       #99–#106 Persona CRUD/binding/avatar, settings persistence, i18n, multi-user, announcements
└── regression/     #107–#115 Locks for recent + still-open known bugs
```

## Running

Default (single worker is the most reliable; the harness spawns one
real Luker server per spec scenario and shares APFS-cloned dataRoots):

```sh
cd tests
PW_WORKERS=1 npx playwright test e2e/ --reporter=line
```

Per-batch:

```sh
PW_WORKERS=1 npx playwright test e2e/chat/ --reporter=line
PW_WORKERS=1 npx playwright test e2e/regression/ --reporter=line
```

A single spec:

```sh
PW_WORKERS=1 npx playwright test e2e/chat/12-branch-regression.e2e.js --reporter=line
```

`PW_WORKERS=2` works for most batches but a few are flaky under
parallelism — drop to 1 if you see EADDRINUSE or "redirect count
exceeded" noise.

## Live-LLM specs

A handful of specs gate on `LIVE=1` plus provider API keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) and skip
otherwise. They round-trip a real model against the configured backend
for parity coverage.

```sh
LIVE=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... PW_WORKERS=1 \
    npx playwright test e2e/server/44-live-three-backends.e2e.js
```

## Authoring conventions

See `tests/e2e/AGENT_BRIEF.md` for the full briefing used when
generating these specs. Quick rules:

1. Every spec spawns its own Luker server via `startServer({ batchKey,
   scenarioId })` — port + dataRoot are scenario-scoped.
2. Mock LLM is `_lib/mockLLM.js`; `scriptReply(s)` / `scriptToolCall(t)`
   queue responses, `mock.requests` records every request.
3. Persistence assertions cross a `server.restart()` boundary, not just
   in-memory reads.
4. RP-immersive fixture content only — no "say hi" placeholders.
5. `test.fail('<reason>')` for tests that lock a real product bug.
6. `test.fixme('<blocker>')` for tests blocked on missing infrastructure
   (mock embedder, worktree-symlink → squoosh-WASM, etc).

## Bugs locked

None at present. When a regression lands that you cannot fix in the
same change, wrap the failing assertion in `test.fail('<reason>')` and
add a row here naming the spec and the broken behaviour. Removing the
`test.fail` (and this row) is part of the fix.
