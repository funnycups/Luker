// #16 — Reorder three sources before merge using the drag handle.
//
// Real-user gesture:
//   1. Create three sibling chats A, B, C; each gets one user/assistant turn.
//   2. Open the merge dialog and add A, B, C in that order via "+ Add chat".
//   3. Grab row C's .cms-drag-handle and drop it onto the row at index 0.
//   4. Submit. The merged file should contain C's block first, then A, then B.
//
// Locks the jQuery UI sortable wiring on .cms-segments-list: if dragTo
// fails to reorder, this test will fail loud rather than silently merging
// in the wrong order. Each source contributes 3 messages
// (greeting + user + reply) for 9 total.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
    dragSegmentToIndex,
    submitMergeDialog,
    takeStepScreenshot,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina nods once.* "rA: the rope is fast."',
        '*Seraphina turns the lantern.* "rB: the cable is humming."',
        '*Seraphina lowers the spyglass.* "rC: the cliff face is loose."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-three-reorder' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#16 — merge dialog drag-handle reorders sources', () => {
    test('drag handle moves source C to the front so merged file leads with C', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Three sibling chats. Chat A is the one we're already in; B, C
        // created via createNewChatViaUI. Each gets exactly one user turn
        // (+ scripted assistant reply).
        const ids = [];
        for (const label of ['A', 'B', 'C']) {
            if (label !== 'A') await createNewChatViaUI(page);
            const id = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
            expect(id).toBeTruthy();
            ids.push(id);
            await sendMessageAndAwaitReply(page, `msg ${label}`);
        }
        expect(new Set(ids).size, `ids should be distinct; got ${JSON.stringify(ids)}`).toBe(3);

        // Open the merge dialog and add sources in original order A, B, C.
        const dialog = await openMergeDialogViaUI(page);
        for (const id of ids) await addSourceToMerge(page, dialog, id);
        await takeStepScreenshot(page, '04-merge-dialog-three-sources');

        // Confirm the dialog's row order matches our add order before reorder.
        const beforeOrder = await dialog.locator('.cms-segment-row').evaluateAll(
            rows => rows.map(r => r.dataset.source),
        );
        expect(beforeOrder).toEqual(ids);

        // Drag row C (index 2) onto row at index 0. jQuery UI sortable
        // listens for mouse events on the .cms-drag-handle and reorders
        // the .cms-segment-row siblings on drop.
        await dragSegmentToIndex(dialog, 2, 0);
        await takeStepScreenshot(page, '05-merge-dialog-after-drag');

        // Confirm DOM-level reorder before submit. If the drag silently
        // failed (jQuery UI sortable + headless drag has flake history)
        // we want this to surface here, not as a misleading merge-order
        // assertion later.
        const afterOrder = await dialog.locator('.cms-segment-row').evaluateAll(
            rows => rows.map(r => r.dataset.source),
        );
        expect(afterOrder, `drag should put C first; got ${JSON.stringify(afterOrder)}`)
            .toEqual([ids[2], ids[0], ids[1]]);

        const mergedName = 'merged-reordered';
        await submitMergeDialog(page, dialog, mergedName);
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );

        // Disk side: each source is greeting + 1 user + 1 reply = 3 msgs,
        // so the merged body has 9 messages in C-then-A-then-B order.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const mergedPath = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder, `${mergedName}.jsonl`);
        const lines = readFileSync(mergedPath, 'utf-8').trim().split('\n');
        expect(lines.length, `expected 1 header + 9 messages; got ${lines.length}`).toBe(10);
        const bodyMessages = lines.slice(1).map(l => JSON.parse(l).mes);
        expect(bodyMessages[1]).toContain('msg C');
        expect(bodyMessages[2]).toContain('rC');
        expect(bodyMessages[4]).toContain('msg A');
        expect(bodyMessages[5]).toContain('rA');
        expect(bodyMessages[7]).toContain('msg B');
        expect(bodyMessages[8]).toContain('rB');
    });
});
