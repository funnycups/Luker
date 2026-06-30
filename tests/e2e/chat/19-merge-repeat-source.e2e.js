// #19 — Adding the same source chat twice keeps both slices in the merge.
//
// Real-user gesture:
//   1. Send 3 user turns into the auto-opened first chat. With the
//      greeting, on-disk body = [greeting, m0, r0, m1, r1, m2, r2] (7).
//   2. Open the merge dialog and click "+ Add chat" twice, picking the
//      same chat both times. The dialog must not collapse duplicates.
//   3. Trim the first instance to [1, 3] (m0, r0) and the second
//      instance to [5, 7] (m2, r2).
//   4. Submit. The merged body should contain 4 messages stitched
//      together: m0, r0, m2, r2.
//
// Locks the multi-instance segment contract: buildMergedBodyAndHeader
// must treat each segments[] entry as its own slice plan, even when two
// entries name the same source. If the dialog or server silently
// de-duplicated by source name, we'd see 2 messages (one trim) instead
// of 4 (both trims).

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
    openMergeDialogViaUI,
    addSourceToMerge,
    setSegmentRangeInDialog,
    submitMergeDialog,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['r0', 'r1', 'r2'] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-repeat-source' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#19 — same source added twice keeps both slices', () => {
    test('two segment rows on one source survive into the merged body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const id = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(id).toBeTruthy();
        for (let j = 0; j < 3; j++) await sendMessageAndAwaitReply(page, `m${j}`);
        // body = [greeting, m0, r0, m1, r1, m2, r2] = 7 entries

        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, id);
        await addSourceToMerge(page, dialog, id);

        // Sanity: the dialog must show TWO rows pointing at the same source
        // (if it silently de-duplicated, we'd see one row here and the
        // trim test below would be meaningless).
        const rowSources = await dialog.locator('.cms-segment-row').evaluateAll(
            rows => rows.map(r => r.dataset.source),
        );
        expect(rowSources, `expected two rows for the same source; got ${JSON.stringify(rowSources)}`)
            .toEqual([id, id]);

        // First instance: keep [1, 3] = m0, r0 (skipping the greeting).
        await setSegmentRangeInDialog(dialog, 0, 1, 3);
        // Second instance: keep [5, 7] = m2, r2 (final user/reply pair).
        await setSegmentRangeInDialog(dialog, 1, 5, 7);

        const trimmed = await dialog.locator('.cms-segment-row').evaluateAll(
            rows => rows.map(r => [Number(r.dataset.from), Number(r.dataset.to)]),
        );
        expect(trimmed).toEqual([[1, 3], [5, 7]]);

        const mergedName = 'merged-dup';
        await submitMergeDialog(page, dialog, mergedName);
        await page.waitForFunction(
            (n) => window.Luker.getContext().getCurrentChatId() === n,
            mergedName,
            { timeout: 15_000 },
        );

        // Disk side: header + 4 body lines = 5 total.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const mergedPath = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder, `${mergedName}.jsonl`);
        const lines = readFileSync(mergedPath, 'utf-8').trim().split('\n');
        expect(lines.length, `expected 1 header + 4 messages; got ${lines.length}`).toBe(5);
        const bodyMesgs = lines.slice(1).map(l => JSON.parse(l).mes);
        expect(bodyMesgs.length).toBe(4);
        expect(bodyMesgs[0]).toBe('m0');
        expect(bodyMesgs[1]).toBe('r0');
        expect(bodyMesgs[2]).toBe('m2');
        expect(bodyMesgs[3]).toBe('r2');
    });
});
