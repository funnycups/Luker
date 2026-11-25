import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    closeRightNavDrawer,
    closeTopDrawer,
    openTopDrawer,
    openUserSettingsDrawer,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { closeWorkbench, workbenchWindow } from '../_lib/ui-workbench.js';
import { openMemoryWorkspace, setMgSettings } from '../_lib/ui-mg-varops.js';

const EXTRACT_DONE = 'luker_rpg_extract_done';
const EVENT_CREATE = 'luker_rpg_extract_event_create';
const EXTRACT_STALL_MS = 20_000;

const STREAM_CHUNKS = Array.from({ length: 15 }, (_, i) => `stalechunk${String(i + 1).padStart(2, '0')}`);
const STREAM_REPLY = STREAM_CHUNKS.join(' ');
const STREAM_CHUNK_DELAY_MS = 300;

function sleepMs(ms) {
    return new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

function toolNamesOf(request) {
    const tools = Array.isArray(request?.body?.tools) ? request.body.tools : [];
    return tools.map((tool) => String(tool?.function?.name || ''));
}

function extractionRequests(mock) {
    return mock.requests.filter((request) => toolNamesOf(request).includes(EXTRACT_DONE));
}

async function clickCharacterInList(page, name) {
    const drawerIcon = page.locator('#rightNavDrawerIcon');
    const drawerClosed = await drawerIcon.evaluate((el) => el.classList.contains('closedIcon')).catch(() => true);
    if (drawerClosed) {
        await drawerIcon.click();
    }

    const listVisible = await page.locator('#rm_print_characters_block:visible').count().catch(() => 0);
    if (!listVisible) {
        const minimizeBtn = page.locator('#toast-container .luker-toast[data-toast-state="docked"] .luker-toast-minimize-button').first();
        if (await minimizeBtn.isVisible().catch(() => false)) {
            await minimizeBtn.click();
        }
        await page.locator('#rm_button_characters').click();
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 });
    }

    const card = page.locator('#rm_print_characters_block .character_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();
}

async function dispatchCancelableBeforeUnload(page) {
    return page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    });
}

async function readGuardState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const ch = ctx.characters?.[ctx.characterId];
        return {
            characterId: ctx.characterId,
            characterName: ch?.name || '',
            avatar: ch?.avatar || '',
            chatId: ctx.getCurrentChatId?.() || '',
            isGeneratingDom: Boolean(document.body.dataset.generating),
            hasStreamingProcessor: Boolean(ctx.streamingProcessor),
            activeSources: ctx.activityGuard?.list?.().map((entry) => entry.source) || [],
            textareaValue: document.querySelector('#send_textarea')?.value || '',
        };
    });
}

async function readErrorToasts(page) {
    return page.evaluate(() => {
        const container = document.querySelector('#toast-container');
        if (!container) return [];
        return Array.from(container.querySelectorAll('.toast-error')).map((el) => el.innerText.slice(0, 200));
    });
}

function readCharacterChatFiles(dataRoot, avatarFile) {
    const folder = String(avatarFile || '').replace(/\.png$/, '');
    const dir = resolve(dataRoot, 'default-user', 'chats', folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => ({
            file,
            content: readFileSync(resolve(dir, file), 'utf8'),
        }));
}

async function seedStandardDataRoot(dataRoot, baseURL) {
    markOnboarded({ dataRoot });
    bootstrapCustomBackend({ dataRoot, baseURL });
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        if (settings.extension_settings && typeof settings.extension_settings === 'object') {
            delete settings.extension_settings.memory_graph;
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    }
    appendConnectionProfile({ dataRoot, baseURL });
    disableTagImportPopup({ dataRoot });
    return writeEmbeddedCharacter({ dataRoot });
}

async function connectCustomApiViaUI(page) {
    await openTopDrawer(page, 'sys-settings-button');
    await page.locator('#api_button_openai').click();
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await closeTopDrawer(page, 'sys-settings-button');
}

async function configureEveryTurnExtractionViaUI(page) {
    await setMgSettings(page, {
        enabled: true,
        autoExtractionEnabled: true,
        autoCompressionEnabled: false,
        recallEnabled: false,
    });
    const lens = await openMemoryWorkspace(page, { subview: 'settings' });
    const panel = lens.locator('.ml-settings').first();
    const everyOnePreset = panel.locator('[data-cadence-preset="every_1"]').first();
    await everyOnePreset.waitFor({ state: 'visible', timeout: 10_000 });
    await everyOnePreset.click();
    const saveBtn = panel.locator('.ml-settings-sticky button').filter({
        hasText: /^(Save Advanced to Global|将高级设置保存到全局|將進階設定儲存到全域|保存高级到全局|儲存進階到全域)$/,
    }).first();
    await saveBtn.click();
    await workbenchWindow(page).locator('.ml-settings-sticky:not(.is-dirty)').waitFor({ state: 'attached', timeout: 10_000 });
    await closeWorkbench(page);
}

test.describe('activity-guard: settings cleanup', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({ scriptedReplies: ['*Seraphina marks the harbor chart.*'] });
        server = await startServer({ batchKey: 'generation', scenarioId: 'activity-guard-settings' });
        await seedStandardDataRoot(server.dataRoot, mock.baseURL);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test('User Settings drawer omits #before_unload_guard_mode', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openUserSettingsDrawer(page);

        await expect(page.locator('#user-settings-block')).toBeVisible();
        await expect(page.locator('#confirm_message_delete')).toBeAttached();
        await expect(page.locator('#before_unload_guard_mode')).toHaveCount(0);

        await closeTopDrawer(page, 'user-settings-button');
    });
});

test.describe('activity-guard: Memory Graph extraction unload and chat-switch confirmation', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM();
        mock.scriptCompletion((req) => {
            const names = req.toolNames || [];
            if (names.includes(EXTRACT_DONE)) {
                return {
                    toolCalls: [
                        {
                            name: EVENT_CREATE,
                            arguments: {
                                summary: '时间：第一夜；Seraphina 记录了灯塔周围潮汐的变化。',
                                links: [],
                                no_link_reason: 'mock',
                            },
                        },
                        { name: EXTRACT_DONE, arguments: {} },
                    ],
                };
            }
            return { text: '*Seraphina adjusts the lantern wick and checks the tide table.* "The outer bar stays clear until midnight."' };
        });
        mock.setLatencyMs((_req, parsed) => {
            const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
            const isExtract = tools.some((tool) => String(tool?.function?.name || '') === EXTRACT_DONE);
            return isExtract ? EXTRACT_STALL_MS : 0;
        });

        server = await startServer({ batchKey: 'generation', scenarioId: 'activity-guard-mg' });
        await seedStandardDataRoot(server.dataRoot, mock.baseURL);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('active extraction guards beforeunload and chat switching across Cancel and Switch anyway', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await connectCustomApiViaUI(page);
        await selectCharacterByName(page, 'Seraphina');
        await page.locator('#chat .mes').first().waitFor({ state: 'visible', timeout: 30_000 });

        await configureEveryTurnExtractionViaUI(page);

        await sendMessageAndAwaitReply(page, 'How does the outer tide look from the headland tonight?');

        await expect.poll(() => extractionRequests(mock).length, {
            timeout: 30_000,
            intervals: [100, 200, 300],
        }).toBeGreaterThanOrEqual(1);

        await expect.poll(async () => readGuardState(page), {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).toMatchObject({
            characterName: 'Seraphina',
            isGeneratingDom: false,
            hasStreamingProcessor: false,
            textareaValue: '',
        });

        await expect.poll(async () => (await readGuardState(page)).activeSources, {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).toContain('memory-graph:update');

        await expect(page.locator('#send_but')).not.toHaveClass(/displayNone/);
        await expect(page.locator('#mes_stop')).toBeHidden();

        const stateBeforeSwitch = await readGuardState(page);
        expect(stateBeforeSwitch.activeSources).not.toContain('core:generation');

        const preventedDuringExtract = await dispatchCancelableBeforeUnload(page);
        expect(preventedDuringExtract).toBe(true);

        // First switch attempt -> Cancel must keep character, chat, and active extraction intact.
        await clickCharacterInList(page, 'Ash the Cartographer');
        const cancelPopup = page.locator('dialog.popup[open]').last();
        await cancelPopup.waitFor({ state: 'visible', timeout: 10_000 });
        await expect(cancelPopup).toContainText(/Tasks still in progress|仍有任务进行中|仍有任務進行中/);
        await expect(cancelPopup).toContainText(/Memory graph update|记忆图更新|記憶圖更新/);

        await cancelPopup.locator('.popup-button-cancel').click();
        await cancelPopup.waitFor({ state: 'detached', timeout: 10_000 });

        const stateAfterCancel = await readGuardState(page);
        expect(stateAfterCancel.characterName).toBe('Seraphina');
        expect(stateAfterCancel.chatId).toBe(stateBeforeSwitch.chatId);
        expect(stateAfterCancel.activeSources).toContain('memory-graph:update');

        // Second switch attempt -> Switch anyway aborts extraction cleanly and switches promptly.
        await clickCharacterInList(page, 'Ash the Cartographer');
        const switchPopup = page.locator('dialog.popup[open]').last();
        await switchPopup.waitFor({ state: 'visible', timeout: 10_000 });
        await expect(switchPopup).toContainText(/Memory graph update|记忆图更新|記憶圖更新/);

        const switchStartMs = Date.now();
        await expect(switchPopup.locator('.popup-button-ok')).toHaveText(/Switch anyway|仍然切换|仍然切換/);
        await switchPopup.locator('.popup-button-ok').click();
        await switchPopup.waitFor({ state: 'detached', timeout: 10_000 });

        await expect.poll(async () => readGuardState(page), {
            timeout: 10_000,
            intervals: [100, 200, 300],
        }).toMatchObject({
            characterName: 'Ash the Cartographer',
            activeSources: [],
            isGeneratingDom: false,
            hasStreamingProcessor: false,
            textareaValue: '',
        });
        expect(Date.now() - switchStartMs).toBeLessThan(EXTRACT_STALL_MS - 5000);

        await closeRightNavDrawer(page);
        await expect(page.locator('#chat .mes').first()).toContainText('Ash looks up from a half-folded chart');
        expect(await readErrorToasts(page)).toEqual([]);

        const preventedWhenIdle = await dispatchCancelableBeforeUnload(page);
        expect(preventedWhenIdle).toBe(false);
    });
});

test.describe('activity-guard: mid-generation chat switch discards stale reply', () => {
    let server, mock, ashAvatar;

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: [STREAM_REPLY],
            streamChunkDelayMs: STREAM_CHUNK_DELAY_MS,
        });
        server = await startServer({ batchKey: 'generation', scenarioId: 'activity-guard-stream-switch' });
        ashAvatar = await seedStandardDataRoot(server.dataRoot, mock.baseURL);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('confirming Switch anyway mid-stream prevents stale chunks from leaking into Character B DOM or .jsonl', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await connectCustomApiViaUI(page);
        await selectCharacterByName(page, 'Seraphina');
        await page.locator('#chat .mes').first().waitFor({ state: 'visible', timeout: 30_000 });

        await page.locator('#send_textarea').fill('Trace the currents beyond the breakwater.');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });

        const streamStartMs = Date.now();
        await page.locator('#send_but').click();

        await page.waitForFunction(() => {
            const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
            for (const bubble of bubbles) {
                if ((bubble.querySelector('.mes_text')?.innerText || '').includes('stalechunk01')) {
                    return true;
                }
            }
            return false;
        }, null, { timeout: 30_000 });

        await clickCharacterInList(page, 'Ash the Cartographer');
        const popup = page.locator('dialog.popup[open]').last();
        await popup.waitFor({ state: 'visible', timeout: 10_000 });
        await expect(popup).toContainText(/Tasks still in progress|仍有任务进行中|仍有任務進行中/);
        await expect(popup).toContainText(/Message generation|回复生成|回覆生成/);

        await expect(popup.locator('.popup-button-ok')).toHaveText(/Switch anyway|仍然切换|仍然切換/);
        await popup.locator('.popup-button-ok').click();
        await popup.waitFor({ state: 'detached', timeout: 10_000 });

        await expect.poll(async () => (await readGuardState(page)).characterName, {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).toBe('Ash the Cartographer');

        await closeRightNavDrawer(page);
        await expect(page.locator('#chat .mes').first()).toContainText('Ash looks up from a half-folded chart');

        const remainingStreamWaitMs = Math.max(0, STREAM_CHUNKS.length * STREAM_CHUNK_DELAY_MS + 1500 - (Date.now() - streamStartMs));
        await sleepMs(remainingStreamWaitMs);

        const finalState = await readGuardState(page);
        expect(finalState.characterName).toBe('Ash the Cartographer');
        expect(finalState.activeSources).toEqual([]);
        expect(finalState.isGeneratingDom).toBe(false);

        const chatDomText = await page.locator('#chat').innerText();
        for (const chunk of STREAM_CHUNKS) {
            expect(chatDomText).not.toContain(chunk);
        }
        expect(chatDomText).toContain('Ash looks up from a half-folded chart');

        await expect.poll(() => readCharacterChatFiles(server.dataRoot, ashAvatar).length, {
            timeout: 10_000,
            intervals: [100, 200, 500],
        }).toBeGreaterThanOrEqual(1);

        const ashChatFiles = readCharacterChatFiles(server.dataRoot, ashAvatar);
        const combinedDiskText = ashChatFiles.map((entry) => entry.content).join('\n');
        expect(combinedDiskText).toContain('Ash looks up from a half-folded chart');
        for (const chunk of STREAM_CHUNKS) {
            expect(combinedDiskText).not.toContain(chunk);
        }

        expect(await readErrorToasts(page)).toEqual([]);
    });
});

test.describe('activity-guard: idle /newchat command', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: ['*Seraphina closes the logbook.* "Everything up to this hour is recorded."'],
        });
        server = await startServer({ batchKey: 'generation', scenarioId: 'activity-guard-newchat' });
        await seedStandardDataRoot(server.dataRoot, mock.baseURL);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(120_000);

    test('typing /newchat in #send_textarea and pressing Enter while idle opens a new chat without self-blocking', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await connectCustomApiViaUI(page);
        await selectCharacterByName(page, 'Seraphina');
        await page.locator('#chat .mes').first().waitFor({ state: 'visible', timeout: 30_000 });

        await sendMessageAndAwaitReply(page, 'Log the midnight watch before we open a fresh sheet.');

        await expect.poll(async () => readGuardState(page), {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).toMatchObject({
            characterName: 'Seraphina',
            isGeneratingDom: false,
            hasStreamingProcessor: false,
            activeSources: [],
        });

        const beforeState = await readGuardState(page);
        await expect(page.locator('#chat .mes')).toHaveCount(3);

        await page.evaluate(() => {
            window.__observedDialogPopups = [];
            const recordOpenPopups = () => {
                for (const dialog of document.querySelectorAll('dialog.popup[open]')) {
                    const text = (dialog.innerText || '').trim();
                    if (text && !window.__observedDialogPopups.includes(text)) {
                        window.__observedDialogPopups.push(text);
                    }
                }
            };
            recordOpenPopups();
            const observer = new MutationObserver(recordOpenPopups);
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
        });

        const textarea = page.locator('#send_textarea');
        await textarea.click();
        await textarea.fill('/newchat');
        await textarea.press('Enter');

        await expect.poll(async () => (await readGuardState(page)).chatId, {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).not.toBe(beforeState.chatId);

        await expect.poll(() => page.locator('#chat .mes').count(), {
            timeout: 15_000,
            intervals: [100, 200, 300],
        }).toBe(1);

        const afterState = await readGuardState(page);
        expect(afterState.characterName).toBe('Seraphina');
        expect(afterState.textareaValue).toBe('');

        const observedPopups = await page.evaluate(() => window.__observedDialogPopups.slice());
        expect(observedPopups).toEqual([]);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        expect(await readErrorToasts(page)).toEqual([]);
    });
});
