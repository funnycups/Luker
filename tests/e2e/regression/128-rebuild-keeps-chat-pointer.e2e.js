// #128 — Live chat pointers must survive full character-list rebuilds.
//
// A `getCharacters()` call replaces the entire `characters` array from the
// server (drag-drop import, "Characters" library open, duplicate, group
// create/delete, …). The rebuild used to reset every character's `.chat`
// back to the PNG-persisted value, so a chat the user opened moments ago
// (whose pointer only lived in memory — see #127 for why that is common)
// silently reverted: the DOM kept showing the open chat while
// `ctx.getCurrentChatId()` and the next save targeted the old file.
//
// Real-user flow locked here:
//   1. Open original chat O, branch to A from an early message (card now
//      points at A), reload, click O on the welcome screen → client shows O
//      with the healed-pointer write in flight (#127).
//   2. Open the character library via the real "Characters" button →
//      `getCharacters()` rebuild fires.
//   3. The rebuild must carry the live pointer O across — after it, the
//      active character's `.chat` still names O, and the DOM still shows
//      O's content.

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
    getRenderedChatTexts,
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
        scenarioId: 'rebuild-keeps-chat-pointer',
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

test.describe('#128 - character-list rebuild keeps the live chat pointer', () => {
    test('opening the character library mid-session does not revert the opened chat', async ({ page }) => {
        test.setTimeout(120_000);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'Check the western marker against the chart.');

        const before = await getChatSnapshot(page);
        const originalChatId = before.chatId;
        const rendered = await getRenderedChatTexts(page);
        const branchAt = rendered.findIndex(text => text.includes('western marker is still'));
        expect(branchAt).toBeGreaterThanOrEqual(0);

        // Branch so the card pointer diverges from the chat we keep open.
        const branchPersisted = page.waitForResponse((response) => {
            if (!response.url().endsWith('/api/characters/merge-attributes') || response.request().method() !== 'POST') {
                return false;
            }
            const body = response.request().postDataJSON();
            return body.chat && body.chat !== originalChatId;
        });
        await branchFromMessageViaUI(page, branchAt);
        const branchChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const persistResponse = await branchPersisted;
        expect(persistResponse.ok()).toBe(true);
        expect(persistResponse.request().postDataJSON().chat).toBe(branchChatId);

        // Reload → welcome screen; click the original recent chat so the
        // client opens O while the card still points at the branch.
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
        const welcomePanel = page.locator('.welcomePanel');
        await welcomePanel.waitFor({ state: 'visible', timeout: 15_000 });
        const originalEntry = welcomePanel.locator(`.recentChat[data-file=${JSON.stringify(originalChatId)}]`);
        await expect(originalEntry).toHaveCount(1);
        await originalEntry.click();
        await page.waitForFunction((chatId) => window.Luker.getContext().getCurrentChatId() === chatId, originalChatId, { timeout: 15_000 });

        // Real gesture: open the "Characters" library — its click handler
        // fires the full getCharacters() rebuild.
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_characters').click();
        // The rebuild re-renders the character cards; wait for a card
        // bearing the chid of our character to reappear before reading.
        const ashChid = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters.findIndex(c => c.avatar === 'ash-the-cartographer.png');
        });
        await page.waitForFunction((chid) => {
            return document.querySelectorAll('#chat .mes').length >= 1
                && window.Luker?.getContext?.()?.characters?.[chid] !== undefined;
        }, ashChid, { timeout: 10_000 });

        // The live pointer must have survived the rebuild.
        const pointerAfter = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(pointerAfter, 'character-list rebuild must not revert the opened chat pointer').toBe(originalChatId);
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.some(text => text.includes('Check the western marker against the chart.'))).toBe(true);
    });
});
