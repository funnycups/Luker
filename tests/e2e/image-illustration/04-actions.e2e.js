import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
    selectCharacterByName, sendMessageAndAwaitReply, swipeRightOnLatest,
} from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

const MAIN_REPLY = '*Ash sets the brass spyglass on the chart and studies the reef.*';
const IMAGE_PROMPT = '1girl, brass spyglass, dusk';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM();
    mock.scriptCompletion(({ toolNames, userMessages }) => {
        if (toolNames.includes('add_image_prompt')) {
            if (userMessages.some(text => text.includes('Two prompts'))) {
                return {
                    toolCalls: [
                        {
                            name: 'add_image_prompt',
                            arguments: { prompt: '1girl, two prompts, dusk', insert_after: 'Two prompts', insert_before: 'please.' },
                        },
                        {
                            name: 'add_image_prompt',
                            arguments: { prompt: '1girl, two prompts, dawn', insert_after: 'Two prompts', insert_before: 'please.' },
                        },
                    ],
                };
            }
            return {
                tool: 'add_image_prompt',
                arguments: {
                    prompt: IMAGE_PROMPT,
                    insert_after: 'brass spyglass',
                    insert_before: 'on the chart',
                },
            };
        }
        if (userMessages.some(text => text.includes('Two prompts'))) {
            return { text: 'Two prompts please. *Ash lifts the lantern.*' };
        }
        return { text: MAIN_REPLY };
    });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '04-actions' });
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

async function latestMessageState(page) {
    return page.evaluate(() => {
        const message = window.Luker.getContext().chat.at(-1);
        return {
            mes: String(message?.mes || ''),
            records: Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations : [],
            swipeId: message?.swipe_id ?? 0,
            swipes: message?.swipes || [],
            swipeInfo: message?.swipe_info || [],
        };
    });
}

test.describe('illustration actions', () => {
    test('regenerates, edits, deletes and lists prompt history', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await configureSd(page);

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_update_image_config').click();
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await page.waitForTimeout(1500);
        await closeAnyOpenTopSettingsDrawer(page);

        await sendMessageAndAwaitReply(page, 'Show me the chart.');
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return Array.isArray(message?.extra?.illustrations) && message.extra.illustrations.length > 0;
        }, null, { timeout: 60_000 });

        const first = await latestMessageState(page);
        expect(first.records).toHaveLength(1);
        const originalRecord = first.records[0];

        // 1. Clicking the inline image opens the action dialog.
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();

        // 2. Regenerate creates a new child record and swaps the marker.
        await page.locator('#sd_illustration_action_regenerate').click();
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 2;
        }, null, { timeout: 60_000 });

        const regenerated = await latestMessageState(page);
        const childRecord = regenerated.records[1];
        expect(childRecord.parentId).toBe(originalRecord.id);
        expect(childRecord.imageUrl).not.toBe(originalRecord.imageUrl);
        expect(regenerated.mes).toContain(`data-illustration-id="${childRecord.id}"`);
        expect(regenerated.mes).not.toContain(`data-illustration-id="${originalRecord.id}"`);
        expect(regenerated.swipes[regenerated.swipeId]).toBe(regenerated.mes);
        expect(regenerated.swipeInfo[regenerated.swipeId].extra.illustrations).toHaveLength(2);

        // 3. Editing the prompt keeps the previous record and stores the new prompt.
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_edit_prompt').click();
        const inputPopup = page.locator('dialog.popup[open]').last();
        const promptInput = inputPopup.locator('.popup-input').last();
        await promptInput.waitFor({ state: 'visible', timeout: 5000 });
        await promptInput.fill('1girl, edited prompt, dawn');
        await inputPopup.locator('.popup-button-ok').click();
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 3;
        }, null, { timeout: 60_000 });

        const edited = await latestMessageState(page);
        const editedRecord = edited.records[2];
        expect(editedRecord.prompt).toBe('1girl, edited prompt, dawn');
        expect(editedRecord.parentId).toBe(childRecord.id);
        expect(edited.records[1]).toEqual(childRecord);
        expect(edited.mes).toContain(`data-illustration-id="${editedRecord.id}"`);

        // 4. History lists earlier prompts for the current chain.
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_history').click();
        const historyList = page.locator('#sd_illustration_history_list');
        await expect(historyList).toBeVisible();
        await expect(historyList).toContainText(IMAGE_PROMPT);
        await expect(historyList).toContainText('1girl, edited prompt, dawn');
        await page.locator('#sd_illustration_history_close').click();

        // 5. Delete removes the newest record and its marker, keeping ancestors.
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_delete').click();
        const deletePopup = page.locator('dialog.popup[open]').last();
        await expect(deletePopup.locator('#sd_illustration_delete_files')).toBeVisible();
        await expect(deletePopup.locator('#sd_illustration_delete_files')).not.toBeChecked();
        await deletePopup.locator('#sd_illustration_delete_confirm').click();
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 2;
        }, null, { timeout: 30_000 });

        const deleted = await latestMessageState(page);
        expect(deleted.records.map(record => record.id)).toEqual([originalRecord.id, childRecord.id]);
        expect(deleted.mes).not.toContain(`data-illustration-id="${editedRecord.id}"`);
        expect(deleted.mes).toContain(`data-illustration-id="${childRecord.id}"`);
        expect(deleted.swipes[deleted.swipeId]).toBe(deleted.mes);
        expect(deleted.swipeInfo[deleted.swipeId].extra.illustrations).toHaveLength(2);

        // 6. Picking a history entry regenerates from its prompt.
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await page.locator('#sd_illustration_action_history').click();
        await page.locator('#sd_illustration_history_list [data-illustration-history-id]').first().click();
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 3;
        }, null, { timeout: 60_000 });
        const fromHistory = await latestMessageState(page);
        const historyRecord = fromHistory.records[2];
        expect(historyRecord.prompt).toBe(IMAGE_PROMPT);
        expect(historyRecord.parentId).toBe(originalRecord.id);
        expect(fromHistory.mes).toContain(`data-illustration-id="${historyRecord.id}"`);
    });

    test('a swipe during regeneration discards the stale image', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await configureSd(page);

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_update_image_config').click();
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await page.waitForTimeout(1000);
        await closeAnyOpenTopSettingsDrawer(page);

        await sendMessageAndAwaitReply(page, 'Show me the chart again.');
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length > 0;
        }, null, { timeout: 60_000 });

        const txt2imgBefore = sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length;
        sdMock.setTxt2imgDelayMs(2500);
        try {
            await page.locator('.mes_text img[data-illustration-id]').last().click();
            await page.locator('#sd_illustration_action_regenerate').click();
            await expect.poll(
                () => sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length,
                { timeout: 10_000 },
            ).toBeGreaterThan(txt2imgBefore);

            // The new swipe must not pick up the old swipe's auto illustration.
            await page.evaluate(() => {
                window.Luker.getContext().extensionSettings.sd.illustration.autoGenerate = false;
            });
            await swipeRightOnLatest(page);
        } finally {
            sdMock.setTxt2imgDelayMs(0);
        }
        await page.waitForTimeout(3000);

        const state = await latestMessageState(page);
        expect(state.swipeId).toBe(1);
        expect(state.records).toHaveLength(0);
        expect(state.mes).not.toContain('data-illustration-id');
        expect(state.swipes).toHaveLength(2);
        expect(state.swipeInfo).toHaveLength(2);

        // The pending swipe slot must remain usable for further swipes.
        await swipeRightOnLatest(page);
        await page.waitForTimeout(1500);
        const secondSwipe = await latestMessageState(page);
        expect(secondSwipe.swipeId).toBe(2);
        expect(secondSwipe.swipes).toHaveLength(3);
        expect(secondSwipe.swipeInfo).toHaveLength(3);
        expect(secondSwipe.mes).not.toBe('');
    });

    test('manual generation asks before replacing existing illustrations', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await configureSd(page);

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.waitForTimeout(800);
        await closeAnyOpenTopSettingsDrawer(page);

        const clickGenerate = () => page.evaluate(() => {
            const messages = [...document.querySelectorAll('.mes:not([is_user="true"]):not([is_system="true"])')];
            messages.at(-1)?.querySelector('.sd_illustration_gen')?.click();
        });

        // First manual run replaces nothing, so no dialog appears.
        await clickGenerate();
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 1;
        }, null, { timeout: 60_000 });
        const first = await latestMessageState(page);
        const firstRecord = first.records[0];
        expect(first.mes).toContain(`data-illustration-id="${firstRecord.id}"`);

        // Second manual run must confirm, then drop the old marker and record.
        await clickGenerate();
        const confirmPopup = page.locator('dialog.popup[open]').last();
        await expect(confirmPopup).toContainText('This message already has illustrations. Replace them?');
        await confirmPopup.locator('.popup-button-ok').click();
        await page.waitForFunction((oldId) => {
            const message = window.Luker.getContext().chat.at(-1);
            const records = message?.extra?.illustrations || [];
            return records.length === 1 && records[0].id !== oldId;
        }, firstRecord.id, { timeout: 60_000 });

        const replaced = await latestMessageState(page);
        expect(replaced.records).toHaveLength(1);
        expect(replaced.records[0].parentId).toBeNull();
        expect(replaced.mes).toContain(`data-illustration-id="${replaced.records[0].id}"`);
        expect(replaced.mes).not.toContain(`data-illustration-id="${firstRecord.id}"`);
        expect(replaced.swipes[replaced.swipeId]).toBe(replaced.mes);
        expect(replaced.swipeInfo[replaced.swipeId].extra.illustrations).toHaveLength(1);
    });

    test('changing image settings between queued prompts cancels the task', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await configureSd(page);

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await page.locator('#sd_illustration_max_concurrent').fill('1');
        await page.waitForTimeout(800);
        await closeAnyOpenTopSettingsDrawer(page);

        const txt2imgBefore = sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length;
        sdMock.setTxt2imgDelayMs(2500);
        try {
            await sendMessageAndAwaitReply(page, 'Two prompts please.');
            await expect.poll(
                () => sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length,
                { timeout: 15_000 },
            ).toBeGreaterThan(txt2imgBefore);

            await page.evaluate(() => {
                window.Luker.getContext().extensionSettings.sd.model = 'changed-model';
            });
            await page.waitForTimeout(3500);
        } finally {
            sdMock.setTxt2imgDelayMs(0);
        }

        const state = await latestMessageState(page);
        expect(state.records).toHaveLength(0);
        expect(state.mes).not.toContain('data-illustration-id');
        expect(sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length).toBe(txt2imgBefore + 1);
        await expect(page.locator('#toast-container')).toContainText('Image generation configuration changed. This round produced no image.');
    });
});
