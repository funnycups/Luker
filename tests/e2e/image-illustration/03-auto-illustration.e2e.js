import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
    selectCharacterByName, sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

const MAIN_REPLY = '*Ash sets the brass spyglass on the chart and studies the reef.*';
const IMAGE_PROMPT = '1girl, brass spyglass, dusk';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM();
    mock.scriptCompletion(({ toolNames }) => {
        if (toolNames.includes('add_image_prompt')) {
            return {
                tool: 'add_image_prompt',
                arguments: {
                    prompt: IMAGE_PROMPT,
                    insert_after: 'brass spyglass',
                    insert_before: 'on the chart',
                },
            };
        }
        return { text: MAIN_REPLY };
    });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '03-auto' });
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

test.describe('automatic illustration', () => {
    test('inserts one inline image at the tool anchors and persists it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await configureSd(page);

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await page.waitForTimeout(1500);
        await closeAnyOpenTopSettingsDrawer(page);

        const before = sdMock.requests.length;
        await sendMessageAndAwaitReply(page, 'Show me the chart.');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            const message = ctx.chat.at(-1);
            return Array.isArray(message?.extra?.illustrations) && message.extra.illustrations.length > 0;
        }, null, { timeout: 60_000 });

        const snapshot = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const message = ctx.chat.at(-1);
            return {
                mes: message.mes,
                illustrations: message.extra.illustrations,
                swipes: message.swipes,
                swipeInfo: message.swipe_info,
                swipeId: message.swipe_id,
            };
        });

        expect(snapshot.illustrations).toHaveLength(1);
        expect(snapshot.mes).toContain('data-illustration-id');
        expect(snapshot.mes).toContain('/user/images/');
        expect(snapshot.mes).toMatch(/brass spyglass\s*<img[^>]+data-illustration-id[^>]*>\s*on the chart/);
        expect(snapshot.swipes[snapshot.swipeId]).toBe(snapshot.mes);
        expect(snapshot.swipeInfo[snapshot.swipeId].extra.illustrations).toHaveLength(1);

        const txt2img = sdMock.requests.slice(before).find(request => request.url === '/sdapi/v1/txt2img');
        expect(txt2img, 'mock should receive one image generation request').toBeTruthy();
        expect(String(txt2img.body.prompt)).toContain('brass spyglass');

        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.some(message => String(message?.mes || '').includes('data-illustration-id'));
        }, null, { timeout: 30_000 });
        const persisted = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chat.find(message => String(message?.mes || '').includes('data-illustration-id'))?.mes || '';
        });
        expect(persisted).toContain('/user/images/');
    });
});
