import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
    selectCharacterByName, sendMessageAndAwaitReply,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['A quiet reply.'] });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '02-menus' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openIllustrationDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_illustration_container');
}

test.describe('illustration menus', () => {
    test('menu entries and message buttons follow the enable switch', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });

        await expect(page.locator('body')).not.toHaveClass(/illustration-enabled/);
        await expect(page.locator('#sd_illustration_generate_last')).toBeHidden();

        await openIllustrationDrawer(page);
        await page.locator('#sd_illustration_enabled').check();
        await expect(page.locator('body')).toHaveClass(/illustration-enabled/);
        await closeAnyOpenTopSettingsDrawer(page);

        await page.locator('#extensionsMenuButton').click();
        await expect(page.locator('#sd_illustration_generate_last')).toBeVisible();
        await expect(page.locator('#sd_illustration_open_studio')).toBeVisible();

        const assistantButton = page.locator('.mes:not([is_user="true"]):not([is_system="true"]) .sd_illustration_gen').first();
        expect(await assistantButton.evaluate(el => getComputedStyle(el).display)).toBe('inline-block');

        await sendMessageAndAwaitReply(page, 'Hello there');
        const userButton = page.locator('.mes[is_user="true"] .sd_illustration_gen').last();
        expect(await userButton.evaluate(el => getComputedStyle(el).display)).toBe('none');

        await openIllustrationDrawer(page);
        await page.locator('#sd_illustration_enabled').uncheck();
        await expect(page.locator('body')).not.toHaveClass(/illustration-enabled/);
        await expect(page.locator('#sd_illustration_generate_last')).toBeHidden();
        expect(await assistantButton.evaluate(el => getComputedStyle(el).display)).toBe('none');
    });
});
