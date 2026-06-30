// #15 — Merge two chats via the real Past Chats → Merge dialog flow.
//
// Real-user gesture:
//   1. Send messages in chat A.
//   2. option_start_new_chat → confirm to create chat B; send messages.
//   3. Open the past-chats popup (option_select_chat) and click the
//      #merge_chats_button to open the merge dialog.
//   4. Click "+ Add chat" twice, picking A then B in the picker popup.
//   5. Fill the target name and click OK.
//   6. ST emits CHAT_CHANGED on the openCharacterChat(merged_name) switch.
//
// Locks:
//   - Source chats remain on disk after merge (no delete-on-merge).
//   - Merged file's body lists A's messages first, then B's, in order.
//   - DOM-rendered chat carries 8 bubbles (4 user/assistant per source).

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
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
    takeStepScreenshot,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart in half.* "Reply A1: I hear the wind shifting south."',
        '*Seraphina trims the lantern wick.* "Reply A2: it will be a long watch tonight."',
        '*Seraphina sets a brass weight on the chart corner.* "Reply B1: the reef is restless again."',
        '*Seraphina taps the spyglass barrel.* "Reply B2: we should mark the second breaker."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-basic' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#15 — merge two chats via Past Chats Merge UI', () => {
    test('merge two chats preserves order and source chats', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Chat A: greeting + 2 user/assistant turns.
        const chatAId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatAId).toBeTruthy();
        await sendMessageAndAwaitReply(page, 'Turn A1: do you hear that wind?');
        await sendMessageAndAwaitReply(page, 'Turn A2: how long this watch?');

        // Chat B via the real options dropdown → option_start_new_chat.
        await createNewChatViaUI(page);
        const chatBId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatBId).toBeTruthy();
        expect(chatBId).not.toBe(chatAId);
        await sendMessageAndAwaitReply(page, 'Turn B1: any sign of the reef?');
        await sendMessageAndAwaitReply(page, 'Turn B2: mark the second breaker?');
        await takeStepScreenshot(page, '01-two-chats-ready');

        // Open merge dialog, pick A then B.
        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, chatAId);
        await addSourceToMerge(page, dialog, chatBId);
        await takeStepScreenshot(page, '02-merge-dialog-two-sources');

        const mergedName = 'merged-basic';
        await submitMergeDialog(page, dialog, mergedName);
        // submitMergeDialog resolves on CHAT_CHANGED. The subsequent
        // expect(messageBubbles).toHaveCount(10) auto-retries until the
        // post-flip render lands, so no extra sleep is needed.
        await page.waitForFunction(
            (id) => window.Luker.getContext().getCurrentChatId() === id,
            mergedName,
            { timeout: 15_000 },
        );
        await takeStepScreenshot(page, '03-merged-chat-opened');

        // DOM-side: 10 bubbles total. Each source chat contributes its
        // greeting + 2 user turns + 2 assistant turns = 5 messages. Chat
        // A's block is messages 0-4, Chat B's block is 5-9.
        const messageBubbles = page.locator('#chat .mes');
        await expect(messageBubbles).toHaveCount(10);
        const messages = await page.locator('#chat .mes .mes_text').allInnerTexts();
        expect(messages[1]).toContain('Turn A1');
        expect(messages[2]).toContain('Reply A1');
        expect(messages[3]).toContain('Turn A2');
        expect(messages[4]).toContain('Reply A2');
        expect(messages[6]).toContain('Turn B1');
        expect(messages[7]).toContain('Reply B1');
        expect(messages[8]).toContain('Turn B2');
        expect(messages[9]).toContain('Reply B2');

        // Disk side: source chats still present, merged file written.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const files = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(files, `expected source A still present; got ${JSON.stringify(files)}`)
            .toContain(`${chatAId}.jsonl`);
        expect(files, `expected source B still present; got ${JSON.stringify(files)}`)
            .toContain(`${chatBId}.jsonl`);
        expect(files, `expected merged file written; got ${JSON.stringify(files)}`)
            .toContain(`${mergedName}.jsonl`);

        // Merged file body has all 10 bubbles in order: A's 5 then B's 5.
        const mergedPath = resolve(chatsDir, `${mergedName}.jsonl`);
        const lines = readFileSync(mergedPath, 'utf-8').trim().split('\n');
        expect(lines.length, `expected 1 header + 10 messages; got ${lines.length} lines`).toBe(11);
        const bodyMessages = lines.slice(1).map(l => JSON.parse(l).mes);
        expect(bodyMessages[1]).toContain('Turn A1');
        expect(bodyMessages[2]).toContain('Reply A1');
        expect(bodyMessages[3]).toContain('Turn A2');
        expect(bodyMessages[4]).toContain('Reply A2');
        expect(bodyMessages[6]).toContain('Turn B1');
        expect(bodyMessages[7]).toContain('Reply B1');
        expect(bodyMessages[8]).toContain('Turn B2');
        expect(bodyMessages[9]).toContain('Reply B2');
    });
});
