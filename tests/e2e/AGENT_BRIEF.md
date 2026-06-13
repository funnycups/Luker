# E2E Expansion — Agent Brief

You are one of ~13 parallel agents writing Playwright e2e tests for the
Luker (SillyTavern fork) repo. Each agent owns one **batch** of tests
covering one functional area. Other agents are writing other batches at
the same time.

## Hard rules — read this first

1. **Worktree-scoped, don't touch main**: cwd is
   `/Users/funnycups/worktree/luker-e2e-expand`. All new files go under
   `tests/e2e/<your-batch>/`. **Never edit anything outside `tests/e2e/`**
   except adding to `tests/e2e/<your-batch>/`.
2. **Spec naming**: `tests/e2e/<your-batch>/<NN>-<short-name>.e2e.js`
   where NN is the case number from the master list (#1–#115).
3. **Use the shared `_lib`** — don't reinvent. Import from
   `../_lib/server.js`, `../_lib/page.js`, `../_lib/mockLLM.js`,
   `../_lib/fixtures.js`. Read those files to learn the API.
4. **Port range**: your batch already has a reserved port range in
   `_lib/ports.js`. Just pass your `batchKey` to `startServer()`.
5. **No mocks where real is feasible** — real Luker server, real Playwright,
   real browser, real chat history on disk. Mock the LLM only (already
   provided). Per repo convention `e2e_real_user_flow`.
6. **RP-immersive fixtures** — never use "say hi" placeholder content.
   The bundled fixture helpers already use Ash-the-Cartographer-style
   prose; if you need new ones, match that tone.
7. **Persistence assertions** — for anything that touches disk, prove it
   with `server.restart()` + re-open + re-assert. In-memory only is
   not enough.
8. **Full raw content** — chat bubbles must equal model output 1:1 (per
   `feedback_no_silent_truncation`).
9. **Each spec must clean up after itself** — `afterAll` calls
   `tearDownServer(server)` and `mock.stop()`. The scratch dataRoot is
   wiped automatically.
10. **Don't run the full suite — only your own batch.** When you're
    happy, run `cd tests && npx playwright test e2e/<your-batch>/ --reporter=list`.
    You don't need every test to pass on first try — failures that
    look like real product bugs should be left as failing tests with a
    `test.fail(...)` or a `test.fixme(...)` annotation describing what
    they expose. Better an "expected failure" recording a real bug
    than a glossed-over test.

## Shared `_lib` quick reference

### `server.js`
```js
import { startServer, tearDownServer } from '../_lib/server.js';
const server = await startServer({ batchKey: 'chat', scenarioId: 'unique' });
// server.port, server.dataRoot, server.baseURL
await server.restart();           // kills + respawns same dataRoot
await tearDownServer(server);     // afterAll
```

### `mockLLM.js`
```js
import { startMockLLM } from '../_lib/mockLLM.js';
const mock = await startMockLLM({
    scriptedReplies: ['*Ash answers...*', '*A second reply.*'],
    scriptedToolCalls: [{ name: 'skill_read', arguments: { name: 'x' } }],
});
// mock.baseURL — pass to bootstrapCustomBackend()
// mock.requests — array of {url, method, body, headers}
// mock.scriptReply(s) / scriptToolCall(t) — push more replies mid-test
await mock.stop();
```

### `fixtures.js`
```js
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded,
         writeCharacter, writePreset, writeWorldBook, BRYN_ENTRIES, listCharacters }
    from '../_lib/fixtures.js';

markOnboarded({ dataRoot });            // ALWAYS call before opening UI
bootstrapCustomBackend({ dataRoot, baseURL: mock.baseURL });
appendConnectionProfile({ dataRoot, baseURL: mock.baseURL, name: 'e2e-mock' });

const avatarFile = writeCharacter({ dataRoot, overrides: { name: 'Iyana' } });
const presetName = writePreset({ dataRoot, name: 'sober' });
const bookName   = writeWorldBook({ dataRoot, name: 'bryn', entries: BRYN_ENTRIES });
```

### `page.js`
```js
import {
    awaitMainUI, reloadAndAwait,
    openExtensionsDrawer, openInlineDrawer,
    selectCharacterByName,
    sendMessageAndAwaitReply,            // slash-driven (fast, default)
    sendMessageViaButtonAndAwaitReply,   // DOM click path (slower)
    swipeRightOnLatest,
    deleteLastMessage, editMessageById,
    getChatSnapshot,
    abortGeneration,
} from '../_lib/page.js';

await awaitMainUI(page, server.baseURL);
await selectCharacterByName(page, 'Seraphina');
const { text } = await sendMessageAndAwaitReply(page, 'I walked the cliff path.');
const snap = await getChatSnapshot(page);  // {chatId, length, messages, metadata}
```

## Skeleton spec

```js
// tests/e2e/<your-batch>/01-thing.e2e.js
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [ /* RP-immersive replies */ ] });
    server = await startServer({ batchKey: 'YOUR_BATCH_KEY', scenarioId: 'thing' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#NN — short title', () => {
    test('first scenario', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        // ... act ...
        // ... assert ...
    });
});
```

## Self-verification

Each agent is responsible for running playwright against its own folder
before reporting done. Commands:

```bash
cd /Users/funnycups/worktree/luker-e2e-expand/tests
PW_WORKERS=2 npx playwright test e2e/<your-batch>/ --reporter=list
```

Expected outcome per case: a row with ✓ (pass) or ✘ (real product bug —
keep it but mark `test.fail()`). If a spec is fundamentally blocked by
missing UI / unknown API, leave a `test.fixme()` with a one-line note
on why, so a human (or follow-up agent) can pick it up.

## Reporting format

When done, return a brief summary:
```
Files written:
- tests/e2e/<batch>/01-x.e2e.js       (3 cases, 3 pass)
- tests/e2e/<batch>/02-y.e2e.js       (2 cases, 1 pass, 1 fixme: <reason>)

Total: <N> cases / <P> pass / <F> fail (real bugs?) / <X> fixme
```
