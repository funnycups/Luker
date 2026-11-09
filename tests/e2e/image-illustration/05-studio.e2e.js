import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({ scriptedReplies: ['已按你的反馈调整。'] });
    mock.scriptToolCall({ name: 'generate_image', arguments: { prompt: '1girl, lighthouse, dusk' } });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '05-studio' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
});

async function configureSd(page) {
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
        sd.width = 64;
        sd.height = 64;
        sd.prompt_prefix = '';
        sd.negative_prompt = '';
        ctx.saveSettingsDebounced();
    }, sdMock.baseURL);
}

async function openStudio(page) {
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#sd_illustration_open_studio').click();
    await expect(page.locator('#sd_studio')).toBeVisible({ timeout: 10_000 });
}

test.describe('image iteration studio', () => {
    test('keeps tool history and persists sessions across restarts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureSd(page);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        await openStudio(page);

        // First round: the model calls generate_image.
        await page.locator('#sd_studio_input').fill('画一座海边的灯塔');
        await page.locator('#sd_studio_send').click();

        const imageCard = page.locator('#sd_studio [data-studio-image-id]').first();
        await expect(imageCard).toBeVisible({ timeout: 60_000 });
        const txt2img = sdMock.requests.find(request => request.url === '/sdapi/v1/txt2img');
        expect(txt2img, 'SD mock should receive one image generation request').toBeTruthy();
        expect(String(txt2img.body.prompt)).toContain('lighthouse');

        // Second round: plain text reply, but its history must carry the
        // previous assistant tool call and the tool result.
        await page.locator('#sd_studio_input').fill('改成夜晚');
        await page.locator('#sd_studio_send').click();
        await expect(page.locator('#sd_studio_messages')).toContainText('已按你的反馈调整。', { timeout: 60_000 });

        const chatRequests = mock.requests.filter(request => String(request.url).includes('/chat/completions'));
        expect(chatRequests.length).toBeGreaterThanOrEqual(2);
        const secondHistory = chatRequests.at(-1).body.messages;
        const toolMessage = secondHistory.find(message => message.role === 'tool');
        expect(toolMessage, 'second round must replay the tool result').toBeTruthy();
        expect(toolMessage.content).toContain('/user/images/');
        expect(secondHistory.some(message => message.role === 'assistant'
            && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)).toBe(true);

        // Session is on disk before the restart.
        const settingsFile = resolve(server.dataRoot, 'default-user', 'settings.json');
        await expect.poll(() => {
            try {
                const stored = JSON.parse(readFileSync(settingsFile, 'utf8'));
                return Object.keys(stored.extension_settings?.sd?.illustration?.studioSessions || {}).length;
            } catch {
                return 0;
            }
        }, { timeout: 15_000 }).toBeGreaterThan(0);

        await page.locator('dialog.popup[open] .popup-button-close').last().click();
        await expect(page.locator('#sd_studio')).toHaveCount(0, { timeout: 10_000 });

        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await openStudio(page);

        await expect(page.locator('#sd_studio .sd_studio_session')).toHaveCount(1);
        await page.locator('#sd_studio .sd_studio_session').first().click();
        await expect(page.locator('#sd_studio [data-studio-image-id]')).toHaveCount(1);
        await expect(page.locator('#sd_studio_messages')).toContainText('画一座海边的灯塔');
        await expect(page.locator('#sd_studio_messages')).toContainText('改成夜晚');
    });
});
