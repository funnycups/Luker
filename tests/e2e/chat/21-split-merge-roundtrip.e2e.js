// #21 — Split a chat, then merge the parts back in order, and assert the
// merged file's body is byte-equal to the original source body.
//
// Real-user gesture:
//   1. Send 3 user turns into the auto-opened first chat. Each turn fires
//      a scripted assistant reply, so the on-disk body is
//      [greeting, u0, r0, u1, r1, u2, r2] = 7 entries.
//   2. Read the source jsonl body lines for the post-roundtrip equality
//      check.
//   3. Open the split dialog from mesid=2 and split at [2, 4] with names
//      rt-part1 / rt-part2 / rt-part3.
//   4. Open the merge dialog (still on the source chat), add the three
//      parts in order, request target name "rt-merged".
//   5. After CHAT_CHANGED flips to rt-merged, read its body lines.
//
// Locks the body-roundtrip property:
//   - the body lines (everything after the header) of the merged file are
//     deep-equal entry-by-entry to the original source body.
//   - the header is intentionally NOT compared: both split and merge stamp
//     a fresh create_date on their outputs, so byte-equality on the
//     header line would always fail. The contract being verified is
//     "split + merge preserves the message stream", not "header is
//     identical".

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
} from '../_lib/page.js';
import {
    openSplitDialogViaUI,
    setSplitPoints,
    setSplitSegmentName,
    submitSplitDialog,
    openMergeDialogViaUI,
    addSourceToMerge,
    submitMergeDialog,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart edge under a brass weight.* "r0: the swell is rising."',
        '*Seraphina taps the compass glass twice.* "r1: north-by-east, steady."',
        '*Seraphina lowers the spyglass onto the chart.* "r2: the reef is masked tonight."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'split-merge-roundtrip' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#21 — split then merge back yields byte-equal message body', () => {
    test('split at [2, 4] then re-merge the three parts reconstructs the source body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const sourceChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(sourceChatId).toBeTruthy();
        for (let j = 0; j < 3; j++) await sendMessageAndAwaitReply(page, `u${j}: hold the rail steady.`);

        // Capture the source body BEFORE splitting. The merged file's body
        // will be compared against this entry-by-entry.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const sourcePath = resolve(chatsDir, `${sourceChatId}.jsonl`);
        const sourceLines = readFileSync(sourcePath, 'utf-8').trim().split('\n');
        expect(sourceLines.length, `expected 1 header + 7 messages; got ${sourceLines.length}`).toBe(8);
        const sourceBody = sourceLines.slice(1).map(l => JSON.parse(l));

        // Split into three parts. The split dialog initial-point default
        // comes from mesid=2 but we override it with setSplitPoints; the
        // mesid argument here only chooses which per-message icon fires
        // the open.
        const splitDialog = await openSplitDialogViaUI(page, 2);
        await setSplitPoints(splitDialog, [2, 4]);
        await setSplitSegmentName(splitDialog, 0, 'rt-part1');
        await setSplitSegmentName(splitDialog, 1, 'rt-part2');
        await setSplitSegmentName(splitDialog, 2, 'rt-part3');
        await submitSplitDialog(page, splitDialog);

        const mergeDialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, mergeDialog, 'rt-part1');
        await addSourceToMerge(page, mergeDialog, 'rt-part2');
        await addSourceToMerge(page, mergeDialog, 'rt-part3');
        const mergedName = 'rt-merged';
        await submitMergeDialog(page, mergeDialog, mergedName);
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );

        // Body-equality contract: every message entry in the merged file
        // matches the corresponding entry in the original source. Header
        // create_date is excluded by construction (we only compare lines
        // after index 0).
        const mergedPath = resolve(chatsDir, `${mergedName}.jsonl`);
        const mergedLines = readFileSync(mergedPath, 'utf-8').trim().split('\n');
        expect(mergedLines.length, `expected 1 header + ${sourceBody.length} messages; got ${mergedLines.length}`)
            .toBe(1 + sourceBody.length);
        const mergedBody = mergedLines.slice(1).map(l => JSON.parse(l));
        expect(mergedBody.length).toBe(sourceBody.length);
        for (let i = 0; i < sourceBody.length; i++) {
            expect(mergedBody[i]).toEqual(sourceBody[i]);
        }
    });
});
