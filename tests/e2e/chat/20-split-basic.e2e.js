// #20 — Split one chat into three sibling chats via the per-message split icon.
//
// Real-user gesture:
//   1. Send 3 user turns into the auto-opened first chat. Each turn fires
//      a scripted assistant reply, so the on-disk body is
//      [greeting, u0, r0, u1, r1, u2, r2] = 7 entries.
//   2. Open the split dialog from the message at mesid=2 (the first
//      assistant reply) by clicking its .mes_split_chat icon.
//   3. Set two split points at indexes 2 and 4 so the three resulting
//      segments are body[0..2), body[2..4), body[4..7) — i.e. 2 / 2 / 3
//      entries respectively. The greeting always lives in segment 0
//      because it's body[0]; the brief's "2/2/2" framing assumed no
//      greeting, but Seraphina (and every character card) always renders
//      one.
//   4. Set per-segment names part1 / part2 / part3 and click OK.
//
// Locks:
//   - source chat (the chat we were viewing when the split fired) is
//     unchanged on disk and the UI is still pointed at it after submit
//     (split doesn't auto-switch like merge does).
//   - all three new chats are present on disk under the same character
//     folder with the requested names.
//   - each new chat's body matches the corresponding slice of the source
//     body — header lines aren't compared (the new headers carry a fresh
//     create_date) but the body JSON is byte-equal per entry.

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
    takeStepScreenshot,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina charts the swell on the parchment.* "r0: the tide is full."',
        '*Seraphina rolls a brass weight along the chart.* "r1: the wind backs to the east."',
        '*Seraphina notches a tally into the rail.* "r2: that\'s three watches gone."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'split-basic' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#20 — split one chat into three via the per-message split icon', () => {
    test('split at [2, 4] writes three sibling chats with the expected slices', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Build a 7-entry chat: greeting + 3 user/reply pairs.
        const sourceChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(sourceChatId).toBeTruthy();
        for (let j = 0; j < 3; j++) await sendMessageAndAwaitReply(page, `u${j}: stand by for the next mark.`);

        // Sanity: body should be exactly 7 entries before we split.
        const preLen = await page.evaluate(() => window.Luker.getContext().chat.length);
        expect(preLen, `expected 7-entry body before split; got ${preLen}`).toBe(7);

        // Capture the source body BEFORE splitting so the post-split "source
        // unchanged" assertion compares against the real on-disk slice (not
        // anything the test made up). Header create_date isn't part of the
        // body and is excluded from the comparison.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const sourcePath = resolve(chatsDir, `${sourceChatId}.jsonl`);
        const sourceLinesBefore = readFileSync(sourcePath, 'utf-8').trim().split('\n');
        expect(sourceLinesBefore.length, `expected 1 header + 7 messages; got ${sourceLinesBefore.length}`).toBe(8);
        const sourceBodyBefore = sourceLinesBefore.slice(1).map(l => JSON.parse(l));

        // Open the split dialog from mesid=2 (the first scripted reply).
        // The dialog's initial split point defaults to that mesid, but we
        // override it via setSplitPoints below, so the click site only
        // affects WHICH per-message icon fires the open — not the cut.
        const dialog = await openSplitDialogViaUI(page, 2);
        await setSplitPoints(dialog, [2, 4]);
        await setSplitSegmentName(dialog, 0, 'part1');
        await setSplitSegmentName(dialog, 1, 'part2');
        await setSplitSegmentName(dialog, 2, 'part3');
        await takeStepScreenshot(page, '07-split-dialog-three-segments');

        await submitSplitDialog(page, dialog);

        // Source chat stays open after submit — split, unlike merge,
        // doesn't switch the UI to one of the new chats.
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            sourceChatId,
            { timeout: 10_000 },
        );

        // Source on disk is byte-equal (modulo timestamps that live only
        // in the header) to what we read before the split. We compare the
        // body JSON only — the header's create_date is unrelated to split.
        const sourceLinesAfter = readFileSync(sourcePath, 'utf-8').trim().split('\n');
        expect(sourceLinesAfter.length).toBe(8);
        const sourceBodyAfter = sourceLinesAfter.slice(1).map(l => JSON.parse(l));
        for (let i = 0; i < sourceBodyBefore.length; i++) {
            expect(sourceBodyAfter[i]).toEqual(sourceBodyBefore[i]);
        }

        // All three new chats exist with the expected slices.
        //   part1 = body[0..2)  = [greeting, u0]            → 2 entries
        //   part2 = body[2..4)  = [r0, u1]                  → 2 entries
        //   part3 = body[4..7)  = [r1, u2, r2]              → 3 entries
        const expected = [
            { name: 'part1', range: [0, 2] },
            { name: 'part2', range: [2, 4] },
            { name: 'part3', range: [4, 7] },
        ];
        for (const { name, range } of expected) {
            const partPath = resolve(chatsDir, `${name}.jsonl`);
            const lines = readFileSync(partPath, 'utf-8').trim().split('\n');
            const expectedCount = range[1] - range[0];
            expect(lines.length, `${name}: expected 1 header + ${expectedCount} messages; got ${lines.length}`)
                .toBe(1 + expectedCount);
            const partBody = lines.slice(1).map(l => JSON.parse(l));
            const sourceSlice = sourceBodyBefore.slice(range[0], range[1]);
            expect(partBody.length).toBe(sourceSlice.length);
            for (let i = 0; i < sourceSlice.length; i++) {
                expect(partBody[i]).toEqual(sourceSlice[i]);
            }
        }
    });
});
