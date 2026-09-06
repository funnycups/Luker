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
            '*Ash lowers the spyglass.* "The northern buoy still burns beyond the fog."',
        ],
    });
    server = await startServer({
        batchKey: 'regression',
        scenarioId: 'branch-reload-recent-chat',
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

test.describe('#127 - original chat selection after branching', () => {
    test('the first recent-chat click after reload opens the selected original chat', async ({ page }) => {
        test.setTimeout(120_000);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'Check the western marker against the chart.');
        await sendMessageAndAwaitReply(page, 'Can you still see the northern buoy?');

        const original = await getChatSnapshot(page);
        const originalChatId = original.chatId;
        const rendered = await getRenderedChatTexts(page);
        const branchAt = rendered.findIndex(text => text.includes('western marker is still'));
        expect(branchAt).toBeGreaterThanOrEqual(0);
        expect(rendered.some(text => text.includes('Can you still see the northern buoy?'))).toBe(true);

        const branchPersisted = page.waitForResponse((response) => {
            if (!response.url().endsWith('/api/characters/merge-attributes') || response.request().method() !== 'POST') {
                return false;
            }
            const body = response.request().postDataJSON();
            return body.chat && body.chat !== originalChatId;
        });
        await branchFromMessageViaUI(page, branchAt);
        const branchChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(branchChatId).not.toBe(originalChatId);
        expect((await getRenderedChatTexts(page)).some(text => text.includes('Can you still see the northern buoy?'))).toBe(false);
        const persistResponse = await branchPersisted;
        expect(persistResponse.ok()).toBe(true);
        expect(persistResponse.request().postDataJSON().chat).toBe(branchChatId);

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        const welcomePanel = page.locator('.welcomePanel');
        await welcomePanel.waitFor({ state: 'visible', timeout: 15_000 });
        const originalEntry = welcomePanel.locator(`.recentChat[data-file=${JSON.stringify(originalChatId)}]`);
        await expect(originalEntry).toHaveCount(1);
        await originalEntry.click();

        await page.waitForFunction((chatId) => {
            const ctx = window.Luker.getContext();
            return ctx.getCurrentChatId() === chatId && Array.from(document.querySelectorAll('#chat .mes_text'))
                .some(element => element.textContent.includes('Can you still see the northern buoy?'));
        }, originalChatId, { timeout: 15_000 });

        expect(await page.evaluate(() => window.Luker.getContext().getCurrentChatId())).toBe(originalChatId);

        // The pinned chat must also be persisted into the character card so
        // the next reload (auto-load chat, /go, fresh getCharacters) resumes
        // on the chat the user actually opened, not the branch created last.
        const pointerPersisted = page.waitForResponse((response) => {
            if (!response.url().endsWith('/api/characters/merge-attributes') || response.request().method() !== 'POST') {
                return false;
            }
            return response.request().postDataJSON()?.chat === originalChatId;
        }, { timeout: 15_000 });
        await pointerPersisted;
    });

    test('opening the original chat heals the card pointer, so a reload auto-resumes on it', async ({ page }) => {
        test.setTimeout(120_000);

        // Continuation of the flow above: this server's data keeps the card
        // pointer from the previous test (already healed to originalChatId).
        // Rebuild the branch scenario from scratch to prove the heal works
        // from a stale-pointer state: branch again from the original chat.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        // The character's persisted pointer targets whichever chat the last
        // session left open; branch from an early message so the branch chat
        // lacks the second exchange.
        await sendMessageAndAwaitReply(page, 'The western marker first, then the buoy.');
        const beforeBranch = await getChatSnapshot(page);
        const originalChatId = beforeBranch.chatId;
        const rendered = await getRenderedChatTexts(page);
        const branchAt = rendered.findIndex(text => text.includes('western marker is still'));
        expect(branchAt).toBeGreaterThanOrEqual(0);

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

        // Reload lands on the welcome panel (no auto-load), click original.
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
        const welcomePanel = page.locator('.welcomePanel');
        await welcomePanel.waitFor({ state: 'visible', timeout: 15_000 });
        const originalEntry = welcomePanel.locator(`.recentChat[data-file=${JSON.stringify(originalChatId)}]`);
        await expect(originalEntry).toHaveCount(1);
        await originalEntry.click();

        await page.waitForFunction((chatId) => window.Luker.getContext().getCurrentChatId() === chatId, originalChatId, { timeout: 15_000 });

        // After the welcome early-return path, reload once more. The freshly
        // reloaded card must point at the original chat (the healed pointer),
        // not at the branch that was created after it.
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction((chatId) => window.Luker.getContext().getCurrentChatId() === chatId, originalChatId, { timeout: 15_000 });
    });
});
