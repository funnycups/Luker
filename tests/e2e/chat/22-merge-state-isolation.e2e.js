// #22 — Merging two chats does NOT carry over the source's memory-graph
// floor-log sidecar onto the merged chat.
//
// Real-user gesture:
//   1. Send a user turn into the auto-opened chat A so the chat is
//      saveable and the memory-graph extension's lifecycle hooks fire.
//   2. Use the public `ctx.createFloorState` API (the same API the
//      memory-graph extension uses internally) to deterministically
//      append one commit on the `memory_graph` namespace. This forces
//      the `<chatA>.luker-state.memory_graph__floor_log.json` sidecar
//      to land on disk regardless of whether MG's own extraction
//      pipeline managed to commit anything (the mock LLM does not
//      produce extraction-shaped responses, so MG's extraction would
//      typically be a no-op).
//   3. Start a fresh chat B and send a user turn there too.
//   4. Open the merge dialog, add A then B, target name "merged-iso".
//   5. After CHAT_CHANGED flips to merged-iso, assert:
//        - source A's sidecar still exists on disk (sanity baseline so
//          the no-sidecar assertion below has teeth),
//        - the merged chat's sidecar does NOT exist on disk.
//
// Locks the per-chat state-isolation contract from the merge endpoint:
// state lives in a separate sidecar keyed by the chat file name, and
// the merge writes only the .jsonl body+header — it must not copy the
// source's state sidecars onto the new chat.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    createNewChatViaUI,
} from '../_lib/page.js';
import {
    openMergeDialogViaUI,
    addSourceToMerge,
    submitMergeDialog,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina pencils a tally in the margin.* "rA: the breeze is freshening."',
        '*Seraphina trims the lantern wick a half-turn.* "rB: the watch is yours next."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-state-isolation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#22 — merge does not carry over the source memory-graph sidecar', () => {
    test('merged chat has no memory_graph__floor_log sidecar even when source has one', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const idA = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(idA).toBeTruthy();
        await sendMessageAndAwaitReply(page, 'hello A');

        // Force the `memory_graph__floor_log` sidecar to exist on disk
        // for chat A. We go through the real `createFloorState` public
        // API — the same path the memory-graph extension uses (see
        // public/scripts/extensions/memory-graph/persistence.js line
        // 98). Calling `.patch` with a single add-op writes a real
        // commit to the chat-state log namespace, which the server
        // persists as `<chatA>.luker-state.memory_graph__floor_log.json`.
        // We don't mock anything; this is a legitimate product write
        // path that any plugin (or test) is allowed to invoke.
        const sidecarWriteResult = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const fs = await ctx.createFloorState({ namespace: 'memory_graph' });
            const result = await fs.patch([{ op: 'add', path: '/e2e_test_marker', value: 'iso' }]);
            return result;
        });
        expect(sidecarWriteResult?.ok, `floor-state patch must succeed for the sidecar to land; got ${JSON.stringify(sidecarWriteResult)}`)
            .toBe(true);

        // Chat B via the real options dropdown.
        await createNewChatViaUI(page);
        const idB = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(idB).toBeTruthy();
        expect(idB).not.toBe(idA);
        await sendMessageAndAwaitReply(page, 'hello B');

        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const sourceSidecar = resolve(chatsDir, `${idA}.luker-state.memory_graph__floor_log.json`);

        // Sanity: the source sidecar we forced must actually be on
        // disk. If it isn't, the merged-side no-sidecar assertion below
        // becomes degenerate (passes for the wrong reason).
        expect(existsSync(sourceSidecar), `expected source sidecar to exist at ${sourceSidecar} after fs.patch`)
            .toBe(true);

        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, idA);
        await addSourceToMerge(page, dialog, idB);
        const mergedName = 'merged-iso';
        await submitMergeDialog(page, dialog, mergedName);
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );

        // Contract: the merge endpoint writes a fresh .jsonl for the
        // target chat and MUST NOT copy any of the source's sidecar
        // state files (memory-graph, orchestrator, search-tools, etc.).
        const mergedSidecar = resolve(chatsDir, `${mergedName}.luker-state.memory_graph__floor_log.json`);
        expect(existsSync(mergedSidecar), `merged chat must not inherit a memory-graph sidecar; found ${mergedSidecar}`)
            .toBe(false);
    });
});
