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
    });
});
