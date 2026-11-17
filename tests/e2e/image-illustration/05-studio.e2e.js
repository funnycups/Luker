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
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
    await page.locator('#sd_source').selectOption('auto');
    await page.locator('#sd_auto_url').fill(sdMock.baseURL);
    await page.locator('#sd_auto_validate').click();
    await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });
    await closeAnyOpenTopSettingsDrawer(page);
}

async function openStudio(page) {
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#sd_illustration_open_studio').click();
    await expect(page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]')).toBeVisible({ timeout: 10_000 });
}

test.describe('Workbench embedded image studio', () => {
    test('keeps tool history with attribution:none and persists sessions in GlobalState across restarts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureSd(page);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        await openStudio(page);
        const studioRoot = page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]');

        // First round: the model calls generate_image; output saved under _studio with attribution:none.
        await studioRoot.locator('[data-sd-role="studio-input"]').fill('画一座海边的灯塔');
        await studioRoot.locator('[data-sd-role="studio-send"]').click();

        const imageCard = studioRoot.locator('[data-studio-image-id]').first();
        await expect(imageCard).toBeVisible({ timeout: 60_000 });
        const imgSrc = await imageCard.locator('img').getAttribute('src');
        expect(imgSrc).toContain('/user/images/_studio/');

        const txt2img = sdMock.requests.find(request => request.url === '/sdapi/v1/txt2img');
        expect(txt2img, 'SD mock should receive one image generation request').toBeTruthy();
        expect(String(txt2img.body.prompt)).toContain('lighthouse');

        // Second round: plain text reply, carrying previous assistant tool_calls and tool result.
        await studioRoot.locator('[data-sd-role="studio-input"]').fill('改成夜晚');
        await studioRoot.locator('[data-sd-role="studio-send"]').click();
        await expect(studioRoot.locator('.sdlens-studio-messages')).toContainText('已按你的反馈调整。', { timeout: 60_000 });

        const chatRequests = mock.requests.filter(request => String(request.url).includes('/chat/completions'));
        expect(chatRequests.length).toBeGreaterThanOrEqual(2);
        const secondHistory = chatRequests.at(-1).body.messages;
        const toolMessage = secondHistory.find(message => message.role === 'tool');
        expect(toolMessage, 'second round must replay the tool result').toBeTruthy();
        expect(toolMessage.content).toContain('/user/images/_studio/');
        expect(secondHistory.some(message => message.role === 'assistant'
            && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)).toBe(true);

        // Session is stored in states/sd_studio_sessions.json, NOT settings.json.
        const stateFile = resolve(server.dataRoot, 'default-user', 'states', 'sd_studio_sessions.json');
        const settingsFile = resolve(server.dataRoot, 'default-user', 'settings.json');
        await expect.poll(() => {
            try {
                const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
                return Object.keys(stored.sessions || {}).length;
            } catch {
                return 0;
            }
        }, { timeout: 15_000 }).toBe(1);

        const settingsJson = JSON.parse(readFileSync(settingsFile, 'utf8'));
        expect(settingsJson.extension_settings?.sd?.illustration?.studioSessions).toBeUndefined();

        await page.locator('.wbench .wb-titlebar .lw-ibtn.is-close').click();
        await expect(page.locator('.wbench .wb-win')).toBeHidden({ timeout: 10_000 });

        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await openStudio(page);

        const reopenedStudio = page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]');
        await expect(reopenedStudio.locator('[data-studio-session-id]')).toHaveCount(1);
        await reopenedStudio.locator('[data-studio-session-id]').first().click();
        await expect(reopenedStudio.locator('[data-studio-image-id]')).toHaveCount(1);
        await expect(reopenedStudio.locator('.sdlens-studio-messages')).toContainText('画一座海边的灯塔');
        await expect(reopenedStudio.locator('.sdlens-studio-messages')).toContainText('改成夜晚');
    });
});
