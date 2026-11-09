import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({ scriptedReplies: ['ok'] });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '01-settings' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
});

async function openIllustrationDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_illustration_container');
}

test.describe('illustration settings', () => {
    test('edits, creates, applies and persists a preset', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.evaluate((baseURL) => {
            const ctx = window.Luker.getContext();
            const sd = ctx.extensionSettings.sd;
            sd.source = 'auto';
            sd.auto_url = baseURL;
            sd.auto_auth = '';
            sd.model = 'mock-model';
            sd.sampler = 'DDIM';
            sd.scheduler = 'normal';
            sd.steps = 20;
            sd.scale = 7;
            sd.vae = '';
            sd.width = 512;
            sd.height = 512;
            sd.prompt_prefix = '';
            sd.negative_prompt = '';
            ctx.saveSettingsDebounced();
        }, sdMock.baseURL);
        await page.waitForTimeout(1000);

        await openIllustrationDrawer(page);

        const presetSelect = page.locator('#sd_illustration_preset');
        await expect(presetSelect).toBeVisible();
        expect(await presetSelect.locator('option').count()).toBeGreaterThanOrEqual(2);

        const prompt = page.locator('#sd_illustration_prompt');
        await expect(prompt).toBeVisible();
        await prompt.fill('Custom task prompt');
        await page.waitForTimeout(1500);

        const before = await presetSelect.locator('option').count();
        await page.locator('#sd_illustration_preset_new').click();
        expect(await presetSelect.locator('option').count()).toBe(before + 1);

        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            ctx.extensionSettings.sd.width = 768;
            ctx.extensionSettings.sd.source = 'auto';
            ctx.saveSettingsDebounced();
        });
        await page.locator('#sd_illustration_update_image_config').click();
        await page.evaluate(() => {
            window.Luker.getContext().extensionSettings.sd.width = 1024;
        });
        await page.locator('#sd_illustration_apply_image_config').click();
        await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.sd.width)).toBe(768);

        const presetCount = await presetSelect.locator('option').count();
        await page.waitForTimeout(1500);
        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await openIllustrationDrawer(page);
        await expect(prompt).toHaveValue('Custom task prompt');
        expect(await page.locator('#sd_illustration_preset option').count()).toBe(presetCount);
    });
});
