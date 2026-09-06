// #129 — Renaming a recent chat from the welcome screen must not hijack
// the character's active-chat pointer.
//
// renameRecentCharacterChat renamed the file server-side and then called
// updateRemoteChatName(characterId, newName) UNCONDITIONALLY — even when
// the renamed file was just some old chat, not the chat the character is
// currently pointed at. The PNG `.chat` pointer then jumped to the renamed
// chat, so the next reload / /go / selection opened the renamed chat
// instead of the last-active one.
//
// The in-editor rename flow (renameGroupOrCharacterChat) already carries
// the correct guard: it only follows the rename with a pointer update when
// `characters[i].chat === oldFileName`. The welcome-screen caller must
// apply the same condition.
//
// Real-user flow locked here:
//   1. Chat O open (pointer at O), branch to A from an early message.
//   2. Reload → welcome screen lists both chats.
//   3. Rename the NON-active entry O (the original) via the welcome
//      pencil icon → real popup → new name.
//   4. The character's active pointer must stay at A (the last-opened
//      chat), NOT jump to the renamed O.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    branchFromMessageViaUI,
    getChatSnapshot,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash studies the inked coastline.* "The western marker is still where we left it."',
        ],
    });
    server = await startServer({
        batchKey: 'regression',
        scenarioId: 'welcome-rename-pointer',
        extraConfig: { 'performance.lazyLoadCharacters': true },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#129 - welcome-screen rename keeps the active-chat pointer', () => {
    test('renaming a non-active recent chat does not move the character pointer', async ({ page }) => {
        test.setTimeout(120_000);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'Check the western marker against the chart.');

        const before = await getChatSnapshot(page);
        const originalChatId = before.chatId;

        // Branch so two recent chats exist and the pointer moves to the
        // branch (the last-opened chat).
        const branchPersisted = page.waitForResponse((response) => {
            if (!response.url().endsWith('/api/characters/merge-attributes') || response.request().method() !== 'POST') {
                return false;
            }
            const body = response.request().postDataJSON();
            return body.chat && body.chat !== originalChatId;
        });
        await branchFromMessageViaUI(page, 1);
        const branchChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const persistResponse = await branchPersisted;
        expect(persistResponse.ok()).toBe(true);
        expect(persistResponse.request().postDataJSON().chat).toBe(branchChatId);
        expect(branchChatId).not.toBe(originalChatId);

        // Reload → welcome screen. Rename the NON-active chat (the original)
        // via the real pencil icon + popup.
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
        const welcomePanel = page.locator('.welcomePanel');
        await welcomePanel.waitFor({ state: 'visible', timeout: 15_000 });
        const originalEntry = welcomePanel.locator(`.recentChat[data-file=${JSON.stringify(originalChatId)}]`);
        await expect(originalEntry).toHaveCount(1);

        const renamePointerWrite = page.waitForResponse((response) => {
            if (!response.url().endsWith('/api/characters/merge-attributes') || response.request().method() !== 'POST') {
                return false;
            }
            return response.request().postDataJSON()?.chat != null;
        }, { timeout: 20_000 }).then(
            (response) => response.request().postDataJSON().chat,
            () => null,
        );

        await originalEntry.locator('.renameChat').click();
        const popup = page.locator('dialog.popup[open]').last();
        const popupInput = popup.locator('.popup-input').last();
        await popupInput.waitFor({ state: 'visible', timeout: 5_000 });
        await popupInput.fill(`${originalChatId} - Renamed`);
        await popup.locator('.popup-button-ok').click();

        // Wait for the rename round-trip to finish: the welcome screen
        // re-renders with the new name once the rename + refresh completed.
        await page.waitForFunction((name) => {
            return Array.from(document.querySelectorAll('.recentChat .recentChatName, .recentChat'))
                .some(el => (el.textContent || '').includes(name));
        }, `${originalChatId} - Renamed`, { timeout: 20_000 });
        // Any pointer write (merge-attributes) races with the welcome
        // re-render; settle it before reading the pointer.
        const pointerWrite = await renamePointerWrite;

        // The pointer must still be the last-opened chat (the branch), not
        // the renamed original. The character is not selected on the welcome
        // screen, so read the pointer off the character record directly.
        const pointerAfter = await page.evaluate((avatar) => {
            const ctx = window.Luker.getContext();
            return ctx.characters.find(c => c.avatar === avatar)?.chat;
        }, 'ash-the-cartographer.png');
        expect(pointerAfter).toBe(branchChatId);
        // And no merge-attributes write may have pointed the card at the
        // renamed chat.
        expect(pointerWrite, 'welcome rename must not rewrite the card pointer').not.toBe(`${originalChatId} - Renamed`);
    });
});
