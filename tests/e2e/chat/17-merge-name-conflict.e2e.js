// #17 — Merging onto an already-taken target name produces a "(2)" suffix.
//
// Real-user gesture:
//   1. In the auto-opened first chat, send one user turn so the chat
//      becomes saveable (this is the "occupy" chat we'll rename later).
//   2. Create two more sibling chats A and B; each gets one user turn.
//   3. Open Manage Chat Files, click the rename pencil on the occupy
//      row, and rename it to 'merged-conflict'. The target slot is now
//      taken. We rename it without switching to it (the rename pencil
//      is per-row, not tied to the current chat).
//   4. Open the merge dialog, add A and B, request 'merged-conflict'.
//   5. ST's resolveAvailableTargetName() finds the slot occupied and
//      writes the merged chat as 'merged-conflict (2)' instead.
//
// Locks the conflict-resolution naming contract from
// src/endpoints/chats.js resolveAvailableTargetName().

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    createNewChatViaUI,
    openOptionsAndClick,
} from '../_lib/page.js';
import {
    openMergeDialogViaUI,
    addSourceToMerge,
    submitMergeDialog,
} from '../_lib/ui-chat-merge-split.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina sketches a quick note in the margin.* "rOcc: I will hold this corner of the chart."',
        '*Seraphina taps the rim of the lantern.* "rA: the southern reef is calm now."',
        '*Seraphina folds the spyglass shut.* "rB: but the north is shifting again."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'merge-name-conflict' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#17 — merge name conflict resolves to (2) suffix', () => {
    test('existing target slot makes the merged chat land at "merged-conflict (2)"', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Order matters: do the new-chat creations BEFORE the rename so
        // we don't have to fight the past-chats popup that ST's rename
        // handler reopens on a 250ms delay. We'll come back to rename the
        // very first chat once both A and B exist.
        await sendMessageAndAwaitReply(page, 'occupy: hold the corner.');
        const occupyChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(occupyChatId).toBeTruthy();

        await createNewChatViaUI(page);
        const idA = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        await sendMessageAndAwaitReply(page, 'A1: south clean?');
        await createNewChatViaUI(page);
        const idB = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        await sendMessageAndAwaitReply(page, 'B1: north shifting?');
        expect(idA).not.toBe(idB);
        expect(idA).not.toBe(occupyChatId);
        expect(idB).not.toBe(occupyChatId);

        // Now rename the occupy chat to 'merged-conflict' to set up the
        // target-name collision. We rename it directly from the past-chats
        // popup (clicking the pencil on the occupy row) WITHOUT switching
        // to it first — a real user can rename any chat in the list
        // without leaving their current chat (handler at script.js:19047
        // operates on whichever row's .renameChatButton was clicked).
        // This avoids the chat-switch path entirely, keeping the test
        // focused on the merge name-conflict contract.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);

        await openOptionsAndClick(page, 'option_select_chat');
        await page.locator('#select_chat_popup').waitFor({ state: 'visible', timeout: 10_000 });
        const occupyRow = page.locator('.select_chat_block_wrapper', {
            has: page.locator('.select_chat_block_filename', { hasText: occupyChatId }),
        }).first();
        await occupyRow.waitFor({ state: 'visible', timeout: 5000 });
        await occupyRow.locator('.renameChatButton').click();
        const renamePopup = page.locator('dialog.popup[open]').last();
        const renameInput = renamePopup.locator('.popup-input').last();
        await renameInput.waitFor({ state: 'visible', timeout: 5000 });
        await renameInput.fill('merged-conflict');
        // Attach the CHAT_RENAMED listener BEFORE clicking Save so we
        // don't miss the event. This is observation-only — the Save
        // click is the real product-logic trigger.
        const renameDonePromise = page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const timer = setTimeout(() => reject(new Error('CHAT_RENAMED timeout')), 15000);
            const off = ctx.eventSource.on(ctx.eventTypes.CHAT_RENAMED, (data) => {
                clearTimeout(timer);
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_RENAMED, off); } catch {}
                resolve(data);
            });
        }));
        await renamePopup.locator('.popup-button-ok').click();
        await renameDonePromise;

        const filesBefore = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesBefore, `expected occupied slot on disk; got ${JSON.stringify(filesBefore)}`)
            .toContain('merged-conflict.jsonl');

        const dialog = await openMergeDialogViaUI(page);
        await addSourceToMerge(page, dialog, idA);
        await addSourceToMerge(page, dialog, idB);

        // Request a name that's already taken. ST should resolve to
        // "merged-conflict (2)" and open it.
        await submitMergeDialog(page, dialog, 'merged-conflict');
        await page.waitForFunction(() => {
            const id = window.Luker.getContext().getCurrentChatId();
            return typeof id === 'string' && id.startsWith('merged-conflict');
        }, null, { timeout: 15_000 });

        const openedId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(openedId).toBe('merged-conflict (2)');

        // Both names co-exist on disk after the merge: the occupied chat
        // is untouched and the (2)-suffixed merged chat was written.
        const filesAfter = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesAfter).toContain('merged-conflict.jsonl');
        expect(filesAfter).toContain('merged-conflict (2).jsonl');
    });
});
