import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
    selectCharacterByName, sendMessageAndAwaitReply, swipeRightOnLatest, deleteMessageViaUI,
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
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '06-lifecycle' });
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

async function boot(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.evaluate(() => document.querySelector('#api_button_openai').click());
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await configureSd(page);
}

async function openIllustrationDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_illustration_container');
}

async function setToggles(page, { enabled, auto }) {
    await openIllustrationDrawer(page);
    const enabledBox = page.locator('#sd_illustration_enabled');
    const autoBox = page.locator('#sd_illustration_auto_generate');
    if (enabled !== undefined) {
        await enabledBox.setChecked(enabled);
    }
    if (auto !== undefined) {
        await autoBox.setChecked(auto);
    }
    await page.waitForTimeout(800);
    await closeAnyOpenTopSettingsDrawer(page);
}

async function waitForIllustration(page, messageIndex = -1) {
    await page.waitForFunction((index) => {
        const chat = window.Luker.getContext().chat;
        const message = index < 0 ? chat.at(index) : chat[index];
        return Array.isArray(message?.extra?.illustrations) && message.extra.illustrations.length > 0;
    }, messageIndex, { timeout: 60_000 });
}

function isIllustrationTaskRequest(request) {
    const tools = Array.isArray(request?.body?.tools) ? request.body.tools : [];
    return tools.some(tool => String(tool?.function?.name || '') === 'add_image_prompt');
}

test.describe.serial('illustration lifecycle', () => {
    test('feature switch hides entries while existing illustrations stay interactive', async ({ page }) => {
        await boot(page);
        await openIllustrationDrawer(page);
        await closeAnyOpenTopSettingsDrawer(page);
        await setToggles(page, { enabled: true, auto: true });

        await sendMessageAndAwaitReply(page, 'Show me the chart.');
        await waitForIllustration(page);

        await setToggles(page, { enabled: false });

        await page.locator('#extensionsMenuButton').click();
        await expect(page.locator('#sd_illustration_generate_last')).toBeHidden();
        const messageButton = page.locator('.mes:not([is_user="true"]):not([is_system="true"]) .sd_illustration_gen').first();
        expect(await messageButton.evaluate(el => getComputedStyle(el).display)).toBe('none');

        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('dialog.popup[open] .popup-button-close').last().click();
        await expect(page.locator('#sd_illustration_actions')).toHaveCount(0, { timeout: 10_000 });
    });

    test('automatic generation follows its switch', async ({ page }) => {
        await boot(page);
        await setToggles(page, { enabled: true, auto: false });

        const txt2imgBefore = sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length;
        await sendMessageAndAwaitReply(page, 'First without automatic illustration.');
        await page.waitForTimeout(1500);
        expect(sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length).toBe(txt2imgBefore);
        const state = await page.evaluate(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return { records: message?.extra?.illustrations || [], mes: String(message?.mes || '') };
        });
        expect(state.records).toHaveLength(0);
        expect(state.mes).not.toContain('data-illustration-id');

        await setToggles(page, { auto: true });
        await sendMessageAndAwaitReply(page, 'Now illustrate this one.');
        await waitForIllustration(page);
    });

    test('swiping away cancels the in-flight task', async ({ page }) => {
        await boot(page);
        await setToggles(page, { enabled: true, auto: true });
        mock.setLatencyMs(2500);
        try {
            await sendMessageAndAwaitReply(page, 'Swipe this away.');
            // Freeze automatic illustration for the new swipe so the only
            // image that could land here is the old task's insertion.
            await page.evaluate(() => {
                window.Luker.getContext().extensionSettings.sd.illustration.autoGenerate = false;
            });
            await swipeRightOnLatest(page);
        } finally {
            mock.setLatencyMs(0);
        }
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(1500);

        const state = await page.evaluate(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return {
                swipeId: message?.swipe_id,
                records: message?.extra?.illustrations || [],
                mes: String(message?.mes || ''),
            };
        });
        expect(state.swipeId).toBe(1);
        expect(state.records).toHaveLength(0);
        expect(state.mes).not.toContain('data-illustration-id');
    });

    test('deleting the message cancels the in-flight task without unhandled errors', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await boot(page);
        await setToggles(page, { enabled: true, auto: true });
        mock.setLatencyMs(2500);
        try {
            await sendMessageAndAwaitReply(page, 'Delete this one.');
            const replyId = await page.evaluate(() => window.Luker.getContext().chat.length - 1);
            await deleteMessageViaUI(page, replyId);
        } finally {
            mock.setLatencyMs(0);
        }
        await page.waitForTimeout(2000);
        expect(pageErrors).toEqual([]);
        const lastMessage = await page.evaluate(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return { mes: String(message?.mes || ''), records: message?.extra?.illustrations || [] };
        });
        expect(lastMessage.mes).toContain('Delete this one');
        expect(lastMessage.records).toHaveLength(0);
    });

    test('illustration markup never reaches chat prompts', async ({ page }) => {
        await boot(page);
        await setToggles(page, { enabled: true, auto: true });

        await sendMessageAndAwaitReply(page, 'Create context for prompt cleanup.');
        await waitForIllustration(page);
        await sendMessageAndAwaitReply(page, 'Another turn with an illustrated history.');
        await waitForIllustration(page);
        await page.waitForTimeout(1000);

        const chatRequests = mock.requests.filter(request => String(request.url).includes('/chat/completions'));
        const mainRequests = chatRequests.filter(request => !isIllustrationTaskRequest(request));
        expect(mainRequests.length).toBeGreaterThan(0);
        for (const request of mainRequests) {
            expect(JSON.stringify(request.body.messages)).not.toContain('data-illustration-id');
        }

        const taskRequests = chatRequests.filter(isIllustrationTaskRequest);
        expect(taskRequests.length).toBeGreaterThan(0);
        for (const request of taskRequests) {
            expect(JSON.stringify(request.body.messages)).not.toContain('data-illustration-id');
        }

        const cleanedPrompt = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const eventData = {
                prompt: 'before <img src="/user/images/a.png" data-illustration-id="ill_1"> after',
                dryRun: false,
            };
            await ctx.eventSource.emit(ctx.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
            return eventData.prompt;
        });
        expect(cleanedPrompt).toBe('before  after');
    });

    test('an old chat with illustrations renders and stays clickable after a restart', async ({ page }) => {
        await server.restart();
        await boot(page);
        await page.waitForFunction(() => {
            const chat = window.Luker.getContext().chat;
            return chat.some(message => String(message?.mes || '').includes('data-illustration-id'));
        }, null, { timeout: 30_000 });

        const image = page.locator('.mes_text img[data-illustration-id]').last();
        await expect(image).toBeVisible();
        await image.click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
    });
});
