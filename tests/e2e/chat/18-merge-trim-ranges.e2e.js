// #18 — Per-segment trim ranges restrict each source's slice in the merge.
//
// Real-user gesture:
//   1. Build three sibling chats A, B, C with 4 / 3 / 5 user turns each
//      (every turn is a scripted assistant reply, so each chat's on-disk
//      body is 1 greeting + 2*count messages: 9 / 7 / 11 entries).
//   2. Open the merge dialog and add A, B, C in order.
//   3. Leave A on the default full range; type a [0,2] head trim into
//      B's row (keeps greeting + first user msg); type a [7,11] tail
//      trim into C's row (keeps the last user/reply pair × 2).
//   4. Submit. Merged body = A's 9 + B's 2 + C's 4 = 15 entries.
//
// Locks the per-segment range slice contract on the .cms-range-from /
// .cms-range-to inputs: changing them must feed buildMergedBodyAndHeader's
// body.slice(from, to) cut, NOT silently fall back to the full body.

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
    setSegmentRangeInDialog,
    submitMergeDialog,
    takeStepScreenshot,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    // 4 + 3 + 5 = 12 scripted replies, one per user turn across A, B, C.
    const replies = Array.from({ length: 12 }, (_, i) => `r${i}`);
    mock = await startMockLLM({ scriptedReplies: replies });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-trim-ranges' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#18 — merge dialog per-segment trim slices each source', () => {
    test('range inputs feed body.slice(from, to) into the merged body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const ids = [];
        const labels = ['A', 'B', 'C'];
        const counts = [4, 3, 5];
        for (let i = 0; i < labels.length; i++) {
            if (i > 0) await createNewChatViaUI(page);
            const id = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
            expect(id).toBeTruthy();
            ids.push(id);
            for (let j = 0; j < counts[i]; j++) {
                await sendMessageAndAwaitReply(page, `${labels[i]} msg ${j}`);
            }
        }
        expect(new Set(ids).size, `ids must be distinct; got ${JSON.stringify(ids)}`).toBe(3);

        const dialog = await openMergeDialogViaUI(page);
        for (const id of ids) await addSourceToMerge(page, dialog, id);

        // A: full range (default). Each body = greeting + 2*count, so the
        // dialog's totalMessages should read 9 / 7 / 11 for A / B / C.
        const totals = await dialog.locator('.cms-segment-count').evaluateAll(
            cells => cells.map(c => Number(c.textContent.split('/')[1])),
        );
        expect(totals, `dialog totals should be [9, 7, 11]; got ${JSON.stringify(totals)}`)
            .toEqual([9, 7, 11]);

        // B: keep first 2 (greeting + first user msg).
        await setSegmentRangeInDialog(dialog, 1, 0, 2);
        // C: keep last 4 (the last user/reply pair twice over: u3, r3, u4, r4).
        await setSegmentRangeInDialog(dialog, 2, 7, 11);
        await takeStepScreenshot(page, '06-merge-dialog-trimmed');

        // Sanity-check the row-level reads the input handler stamped into
        // data-from / data-to. If the input event handler hadn't fired,
        // these would still be 0 / total, and the slice would silently
        // ship the full body instead of the trimmed range.
        const trimmed = await dialog.locator('.cms-segment-row').evaluateAll(
            rows => rows.map(r => [Number(r.dataset.from), Number(r.dataset.to)]),
        );
        expect(trimmed).toEqual([[0, 9], [0, 2], [7, 11]]);

        const mergedName = 'merged-trimmed';
        await submitMergeDialog(page, dialog, mergedName);
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );

        // Disk side: 1 header line + 15 body lines = 16 total.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const mergedPath = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder, `${mergedName}.jsonl`);
        const lines = readFileSync(mergedPath, 'utf-8').trim().split('\n');
        expect(lines.length, `expected 1 header + 15 messages; got ${lines.length}`).toBe(16);
        const bodyMesgs = lines.slice(1).map(l => JSON.parse(l).mes);

        // A's full body lives at indices 0..8: greeting then 4 user/reply
        // pairs. The greeting text is whatever the Seraphina card ships
        // with; we don't assert it byte-for-byte (that's the card's
        // contract, not this test's) but the user/reply pattern is ours.
        expect(bodyMesgs.length).toBe(15);
        expect(bodyMesgs[1]).toBe('A msg 0');
        expect(bodyMesgs[2]).toBe('r0');
        expect(bodyMesgs[3]).toBe('A msg 1');
        expect(bodyMesgs[7]).toBe('A msg 3');
        expect(bodyMesgs[8]).toBe('r3');

        // B contributes 2 entries: its greeting then "B msg 0". The B
        // greeting is the same character card text as A's greeting, so
        // we just check that the user msg we sent landed in the right
        // slot.
        expect(bodyMesgs[10]).toBe('B msg 0');

        // C contributes 4 entries from body[7..10]: u3, r10, u4, r11.
        // (The mock replies feed from a global queue; A took r0..r3, B
        // took r4..r6, so C's first reply is r7 and r10 is C's u3 reply.)
        expect(bodyMesgs[11]).toBe('C msg 3');
        expect(bodyMesgs[12]).toBe('r10');
        expect(bodyMesgs[13]).toBe('C msg 4');
        expect(bodyMesgs[14]).toBe('r11');
    });
});
