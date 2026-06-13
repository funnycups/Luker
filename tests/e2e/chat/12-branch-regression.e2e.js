// #12 — /branch-create regression test.
//
// Locks regression for the `chatMetadata.main_chat` legacy-fallback bug
// (memory: known_bug_branch_legacy_fallback). Branch a chat at turn 2,
// confirm:
//   a) A new chat is created with the first 2 turns copied,
//   b) The ORIGINAL chat still has all 4 turns (no truncation),
//   c) After server restart, both chats persist on disk.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';
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

test.describe('#12 — /branch-create regression', () => {
    test('branch at turn 2 copies prefix, leaves original chat intact', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn 1: chart fresh?');
        await sendMessageAndAwaitReply(page, 'Turn 2: east?');
        await sendMessageAndAwaitReply(page, 'Turn 3: south?');
        await sendMessageAndAwaitReply(page, 'Turn 4: any worry?');

        const beforeBranch = await getChatSnapshot(page);
        const originalChatId = beforeBranch.chatId;
        const originalLen = beforeBranch.length;
        expect(originalLen).toBeGreaterThanOrEqual(8); // greeting + 4 user + 4 assistant
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const filesBefore = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesBefore.length).toBe(1);

        // Find the second assistant turn (turn 2 of conversation = reply 2).
        const asstIdxs = beforeBranch.messages.map((m, i) => ({ i, m })).filter(({ m }) => !m.is_user).map(({ i }) => i);
        // asstIdxs[0] = greeting; [1]..[4] = replies 1..4. Branch at reply 2.
        const branchAt = asstIdxs[2];
        expect(typeof branchAt === 'number').toBe(true);

        // /branch-create <mesId>
        const branchEventP = page.evaluate(() => new Promise((resolve) => {
            const ctx = window.SillyTavern.getContext();
            const t = setTimeout(() => resolve('timeout'), 30_000);
            const handler = (data) => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_BRANCH_CREATED, handler); } catch {}
                resolve(data ?? 'event');
            };
            ctx.eventSource.on(ctx.eventTypes.CHAT_BRANCH_CREATED, handler);
        }));
        await page.evaluate(async (id) => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions(`/branch-create ${id}`);
        }, branchAt);
        await branchEventP;

        // After branch-create, Luker opens the new branch chat. Wait for
        // chat-changed.
        await page.waitForFunction((origId) => {
            const ctx = window.SillyTavern.getContext();
            const cur = ctx.getCurrentChatId?.();
            return cur && cur !== origId;
        }, originalChatId, { timeout: 15_000 });
        await page.waitForTimeout(500);

        const inBranch = await getChatSnapshot(page);
        const branchChatId = inBranch.chatId;
        expect(branchChatId).not.toBe(originalChatId);
        // Branch should contain greeting + first 2 turns = 5 messages
        // (greeting + user1 + asst1 + user2 + asst2).
        expect(inBranch.length, `branch chat should have prefix up to and including msg ${branchAt}; got ${JSON.stringify(inBranch.messages.map(m => m.mes?.slice(0, 40)))}`)
            .toBe(branchAt + 1);
        // Confirm branch metadata main_chat points back at original.
        expect(inBranch.metadata?.main_chat).toBe(originalChatId);

        // Two chat files on disk now.
        const filesAfter = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesAfter.length, `expected 2 chat files (original + branch); got ${JSON.stringify(filesAfter)}`).toBe(2);

        // Original chat file untouched: same number of lines as before branch.
        const origPath = resolve(chatsDir, `${originalChatId}.jsonl`);
        const origLines = readFileSync(origPath, 'utf8').trim().split('\n');
        // header + originalLen messages
        expect(origLines.length, 'original chat file lines should NOT be truncated by branch').toBeGreaterThanOrEqual(originalLen);

        // Restart and re-load original chat; turn 3+4 should still be there.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 15_000 });

        // After reload, character will load most-recent chat (likely the
        // branch). Switch back to the original via openCharacterChat.
        const switched = await page.evaluate(async (origId) => {
            const ctx = window.SillyTavern.getContext();
            const fn = ctx.openCharacterChat || (await import('/script.js')).openCharacterChat;
            await fn(origId);
            return ctx.getCurrentChatId?.();
        }, originalChatId);
        expect(switched).toBe(originalChatId);
        await page.waitForFunction(({ id, len }) => {
            const ctx = window.SillyTavern.getContext();
            return ctx.getCurrentChatId?.() === id && ctx.chat.length >= len;
        }, { id: originalChatId, len: originalLen }, { timeout: 10_000 });

        const after = await getChatSnapshot(page);
        expect(after.length, `original chat must retain all 4 turns post-restart; got ${JSON.stringify(after.messages.map(m => m.mes?.slice(0, 40)))}`)
            .toBe(originalLen);
        // Turn 3 and 4 still present.
        expect(after.messages.some(m => /Reply 3/.test(m.mes || ''))).toBe(true);
        expect(after.messages.some(m => /Reply 4/.test(m.mes || ''))).toBe(true);
    });
});
