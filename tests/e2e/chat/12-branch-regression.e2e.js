// #12 — Branch from a message via the message-action button
// (.mes_create_branch in the .extraMesButtons row).
//
// Locks regression for the `chatMetadata.main_chat` legacy-fallback bug
// (memory: known_bug_branch_legacy_fallback). Branch at the 2nd
// assistant turn and confirm:
//   a) A new chat is created with the prefix copied (UI loads it),
//   b) The ORIGINAL chat still has all 4 turns (no truncation),
//   c) After server restart, both chats persist on disk.
//
// Real-user gesture: click .extraMesButtonsHint (ellipsis) to reveal
// the action row, then click .mes_create_branch. Luker's branch handler
// emits CHAT_CHANGED on the switch — we wait for that.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    branchFromMessageViaUI,
    getChatSnapshot,
    getRenderedChatTexts,
} from '../_lib/page.js';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPLIES = [
    '*Seraphina nods.* "Reply 1: the chart is fresh as of yesterday."',
    '*Seraphina taps the corner.* "Reply 2: the eastern reef looks calm."',
    '*Seraphina frowns.* "Reply 3: but the south is restless."',
    '*Seraphina sets the brass spyglass down.* "Reply 4: I do not like the look of the southern stretch."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'branch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#12 — branch-from-message regression', () => {
    test('clicking .mes_create_branch at turn 2 copies prefix, leaves original chat intact', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn 1: chart fresh?');
        await sendMessageAndAwaitReply(page, 'Turn 2: east?');
        await sendMessageAndAwaitReply(page, 'Turn 3: south?');
        await sendMessageAndAwaitReply(page, 'Turn 4: any worry?');

        // Capture original chat state via DOM + ctx.chat snapshot.
        const renderedBefore = await getRenderedChatTexts(page);
        const beforeBranch = await getChatSnapshot(page);
        const originalChatId = beforeBranch.chatId;
        const originalLen = beforeBranch.length;
        expect(originalLen).toBeGreaterThanOrEqual(8); // greeting + 4 user + 4 assistant
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const filesBefore = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesBefore.length).toBe(1);

        // Locate "Reply 2" via DOM and branch from its mesid.
        const branchAt = renderedBefore.findIndex(t => /Reply 2/.test(t || ''));
        expect(branchAt).toBeGreaterThanOrEqual(0);

        // Real user gesture: ellipsis → .mes_create_branch.
        await branchFromMessageViaUI(page, branchAt);
        await page.waitForFunction((origId) => {
            const ctx = window.Luker.getContext();
            const cur = ctx.getCurrentChatId?.();
            return cur && cur !== origId;
        }, originalChatId, { timeout: 15_000 });
        await page.waitForTimeout(500);

        // DOM-side: the branch chat is loaded and contains exactly the
        // prefix bubbles (greeting + first 2 turns).
        const renderedInBranch = await getRenderedChatTexts(page);
        expect(renderedInBranch.length, `branch chat should have prefix up to and including msg ${branchAt}`).toBe(branchAt + 1);
        expect(renderedInBranch.some(t => /Reply 1/.test(t))).toBe(true);
        expect(renderedInBranch.some(t => /Reply 2/.test(t))).toBe(true);
        expect(renderedInBranch.some(t => /Reply 3/.test(t))).toBe(false);
        expect(renderedInBranch.some(t => /Reply 4/.test(t))).toBe(false);

        const inBranch = await getChatSnapshot(page);
        const branchChatId = inBranch.chatId;
        expect(branchChatId).not.toBe(originalChatId);
        expect(inBranch.length).toBe(branchAt + 1);
        // Confirm branch metadata main_chat points back at original.
        expect(inBranch.metadata?.main_chat).toBe(originalChatId);

        // Two chat files on disk now.
        const filesAfter = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesAfter.length, `expected 2 chat files (original + branch); got ${JSON.stringify(filesAfter)}`).toBe(2);

        // Original chat file untouched: same number of lines as before branch.
        const origPath = resolve(chatsDir, `${originalChatId}.jsonl`);
        const origLines = readFileSync(origPath, 'utf8').trim().split('\n');
        expect(origLines.length, 'original chat file lines should NOT be truncated by branch').toBeGreaterThanOrEqual(originalLen);

        // Restart and re-load original chat; turn 3+4 should still be there.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 });

        // Switch back to the original chat. After reload the character
        // loads its MOST-RECENT chat (likely the branch), so we use
        // openCharacterChat to flip. This is still triggered by the UI's
        // "Manage Chat Files" flow — clicking a select_chat_block fires
        // openCharacterChat under the hood — but doing it programmatically
        // here keeps the test honest about WHICH chat we expect to
        // assert on.
        const switched = await page.evaluate(async (origId) => {
            const ctx = window.Luker.getContext();
            const fn = ctx.openCharacterChat || (await import('/script.js')).openCharacterChat;
            await fn(origId);
            return ctx.getCurrentChatId?.();
        }, originalChatId);
        expect(switched).toBe(originalChatId);
        await page.waitForFunction(({ id, len }) => {
            const ctx = window.Luker.getContext();
            return ctx.getCurrentChatId?.() === id && document.querySelectorAll('#chat .mes').length >= len;
        }, { id: originalChatId, len: originalLen }, { timeout: 10_000 });

        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.length, `original chat must retain all 4 turns post-restart`).toBe(originalLen);
        expect(renderedAfter.some(t => /Reply 3/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /Reply 4/.test(t))).toBe(true);

        const after = await getChatSnapshot(page);
        expect(after.length).toBe(originalLen);
        expect(after.messages.some(m => /Reply 3/.test(m.mes || ''))).toBe(true);
        expect(after.messages.some(m => /Reply 4/.test(m.mes || ''))).toBe(true);
    });
});
