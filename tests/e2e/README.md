# tests/e2e — Expanded Playwright e2e suite

This directory holds the post-2.7.0 expanded e2e suite. It complements
the browser-hosted suite under `tests/frontend/` (Macro / iteration smoke),
which runs as the `frontend` Playwright project against one shared server.
`npm run test:e2e` runs both projects.

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
├── server/         #39–#54  Connection profiles, multi-backend, uploads self-heal, multi-user, basicAuth, attachments
├── memorygraph/    #52–#60  Memory Graph (extract, persistence, branch isolation, schema, vector index, read-api)
├── varops/         #61–#66  var_ops / floor-state (multi-mutation, rollback, persist, malformed handling, op log)
├── orchestrator/   #67–#78  Director / Run Panel / spec→agenda→loop / critic / per-run tools / capsule / abort
├── iterstudio/     #79–#83  Iter-studio Apply→Global closed loops (CPA, MG Schema, Orchestrator, CEA Character)
├── groups/         #84–#88  Group chat rotation, MG+Skills coexist, director main speaker, persistence+branch+export
├── extensions/     #89–#98  Regex, vectors, authors note, quick reply, translate, TTS, SD, caption, slash, function-call
├── personas/       #99–#106 Persona CRUD/binding/avatar, settings persistence, i18n, multi-user, announcements
├── regression/     #107–#115 Locks for recent + still-open known bugs
└── select2-bulk-delete/ #116–#119 Multi-select bulk delete on the lorebook, preset, and connection-profile dropdowns
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
5. Repair real product regressions and keep their tests passing.
6. Report missing infrastructure explicitly. Expected failures, skips and
   fixme annotations require explicit user authorization.

## Bugs locked

None at present. Report an unresolved regression with its failing command
and observed behavior. Do not hide it behind an expected-failure annotation.
