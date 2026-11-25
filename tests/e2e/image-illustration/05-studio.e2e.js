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
    mock = await startMockLLM();
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
    const menuItem = page.locator('#sd_illustration_open_studio');
    const expectedLabel = await page.evaluate(() => window.Luker.getContext().translate('Image Studio'));
    await expect(menuItem).toContainText(expectedLabel);
    await menuItem.click();
    await expect(page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]')).toBeVisible({ timeout: 10_000 });
}

test.describe('Workbench embedded image studio', () => {
    test('supports free drawing, source image editing, attribution:none, and GlobalState persistence without character-design controls', async ({ page }) => {
        let round = 0;
        mock.scriptCompletion(() => {
            round += 1;
            if (round === 1) {
                return { tool: 'generate_image', arguments: { prompt: '1girl, lighthouse, dusk' } };
            }
            if (round === 2) {
                return { tool: 'generate_image', arguments: { prompt: '1girl, lighthouse, starry night' } };
            }
            return { text: '已按你的反馈调整。' };
        });

        await awaitMainUI(page, server.baseURL);
        await configureSd(page);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        await openStudio(page);
        const studioRoot = page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]');

        // Character-design controls are retired from Studio.
        await expect(studioRoot.locator('[data-sd-studio-mode]')).toHaveCount(0);
        await expect(studioRoot.locator('[data-sd-role="studio-target-profile"]')).toHaveCount(0);
        await expect(studioRoot.locator('[data-sd-role="studio-source-select"]')).toHaveCount(0);

        // Session creation lives in the session list header, prompt preset lives in the toolbar, and empty states guide new users.
        await expect(studioRoot.locator('.sdlens-studio-sessions-head [data-sd-role="studio-new-session"]')).toBeVisible();
        await expect(studioRoot.locator('.sdlens-studio-sessions [data-sd-role="studio-preset"]')).toHaveCount(0);
        await expect(studioRoot.locator('.sdlens-studio-toolbar [data-sd-role="studio-preset"]')).toBeVisible();
        await expect(studioRoot.locator('[data-sd-role="studio-sessions-empty"]')).toBeVisible();
        await expect(studioRoot.locator('.sdlens-studio-messages > .lw-empty')).toBeVisible();
        await expect(studioRoot.locator('.sdlens-studio-gallery .lw-empty')).toBeVisible();

        // First round: the model calls generate_image; output saved under _studio with attribution:none.
        await studioRoot.locator('[data-sd-role="studio-input"]').fill('画一座海边的灯塔');
        await studioRoot.locator('[data-sd-role="studio-send"]').click();

        const imageCard = studioRoot.locator('[data-studio-image-id]').first();
        await expect(imageCard).toBeVisible({ timeout: 60_000 });
        const imgSrc = await imageCard.locator('img').getAttribute('src');
        expect(imgSrc).toContain('/user/images/_studio/');
        await expect(studioRoot.locator('[data-studio-action="promote-reference"]')).toHaveCount(0);

        const txt2img = sdMock.requests.find(request => request.url === '/sdapi/v1/txt2img');
        expect(txt2img, 'SD mock should receive one txt2img request').toBeTruthy();
        expect(String(txt2img.body.prompt)).toContain('lighthouse');

        // Edit source is hidden while #sd_img2img_enabled is off; enabling it via UI unlocks source editing in Studio.
        await expect(studioRoot.locator('[data-studio-action="edit-source"]')).toHaveCount(0);
        await page.locator('.wbench .wb-titlebar .lw-ibtn.is-close').click();
        await expect(page.locator('.wbench .wb-win')).toBeHidden({ timeout: 10_000 });

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await page.locator('#sd_img2img_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        await openStudio(page);
        const studioForImg2Img = page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]');
        await expect(studioForImg2Img.locator('[data-studio-action="edit-source"]')).toBeVisible({ timeout: 10_000 });

        // Second round: attach first image as source via Edit source and generate edited image via img2img.
        await studioForImg2Img.locator('[data-studio-action="edit-source"]').click();
        await expect(studioForImg2Img.locator('.sdlens-studio-source-banner')).toBeVisible();
        await studioForImg2Img.locator('[data-sd-role="studio-input"]').fill('把天空改成星空夜晚');
        await studioForImg2Img.locator('[data-sd-role="studio-send"]').click();
        await expect(studioForImg2Img.locator('[data-studio-image-id]')).toHaveCount(2, { timeout: 60_000 });

        const img2img = sdMock.requests.find(request => request.url === '/sdapi/v1/img2img');
        expect(img2img, 'SD mock should receive an img2img request when editing source image').toBeTruthy();
        expect(String(img2img.body.prompt)).toContain('starry night');

        // Third round: plain text reply, carrying previous assistant tool_calls and tool result.
        await studioForImg2Img.locator('[data-sd-role="studio-input"]').fill('构图很不错');
        await studioForImg2Img.locator('[data-sd-role="studio-send"]').click();
        await expect(studioForImg2Img.locator('.sdlens-studio-messages')).toContainText('已按你的反馈调整。', { timeout: 60_000 });

        const chatRequests = mock.requests.filter(request => String(request.url).includes('/chat/completions'));
        expect(chatRequests.length).toBeGreaterThanOrEqual(3);
        expect(chatRequests[0].body.tools.map(t => t.function.name)).toEqual(['generate_image']);
        const thirdHistory = chatRequests.at(-1).body.messages;
        const toolMessage = thirdHistory.find(message => message.role === 'tool');
        expect(toolMessage, 'later round must replay the tool result').toBeTruthy();
        expect(toolMessage.content).toContain('/user/images/_studio/');
        expect(thirdHistory.some(message => message.role === 'assistant'
            && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)).toBe(true);

        // Session is stored in states/sd_studio_sessions.json without retired character-design keys, NOT settings.json.
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

        const storedSession = Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).sessions)[0];
        for (const retiredKey of ['mode', 'targetProfileId', 'sourceKind', 'sourceCardAvatar', 'stagedProfileDraft']) {
            expect(Object.hasOwn(storedSession, retiredKey)).toBe(false);
        }

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
        await expect(reopenedStudio.locator('[data-studio-image-id]')).toHaveCount(2);
        await expect(reopenedStudio.locator('.sdlens-studio-messages')).toContainText('画一座海边的灯塔');
        await expect(reopenedStudio.locator('.sdlens-studio-messages')).toContainText('把天空改成星空夜晚');
        await expect(reopenedStudio.locator('.sdlens-studio-messages')).toContainText('构图很不错');
    });
});
