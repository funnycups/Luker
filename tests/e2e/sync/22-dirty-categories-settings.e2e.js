// A UI edit in each settings, preset, media and extension category marks
// the device dirty, so the idle sync carries it to the other device with
// no clicks.
//
// One pair of real servers: A syncs 2 s after each edit, B never syncs on
// its own. Every step is a real UI edit on A followed by a poll on B's
// data root. The dirty mark is per user, so each step also checks from A's
// server trace that its own write emitted a real dirty notification.
// Named items are created in preparation and updated by the measured edit.
// Settings saves may accompany category writes; the trace proves each target
// handler notified the scheduler independently of those accompanying writes.
// The only mock is the upstream LLM API the connection checks reach.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer, openTopDrawer, closeTopDrawer } from '../_lib/page.js';
import { openPersonaPanel } from '../_lib/ui-persona-preset.js';
import { writeCharacterPng } from '../groups/_helpers.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, setSyncSchedule, closeAllPopups,
    readUserFile, userRootOf, waitForBackgroundSync, recordDirtyWrites, categoryStep,
} from '../_lib/sync.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SAMPLE_PNG = path.join(REPO_ROOT, 'default/content/default_Seraphina.png');
const CATEGORIES = ['settings', 'secrets', 'themes', 'movingUI', 'openai-presets', 'textgen-presets', 'koboldai-presets', 'novelai-presets', 'instruct', 'context',
    'sysprompt', 'reasoning', 'quickreplies', 'comfy-workflows', 'assets', 'extensions', 'avatars', 'user-images', 'user-files'];
// A's idle delay; client saves debounce for at most `debounce_timeout.relaxed` (1 s).
const IDLE_SECONDS = 2;
const listed = (server, rel) => {
    const dir = path.join(userRootOf(server), ...rel.split('/'));
    return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [];
};
const exists = (server, rel) => fs.existsSync(path.join(userRootOf(server), ...rel.split('/')));
const bytesOf = (server, rel) => (exists(server, rel) ? fs.readFileSync(path.join(userRootOf(server), ...rel.split('/'))) : Buffer.alloc(0));
const readJson = (server, rel) => JSON.parse(readUserFile(server, rel) ?? 'null');
// A click or fill that cannot land fails on its own instead of using up the long test budget.
test.use({ actionTimeout: 15_000 });
let A;
let B;
let mock;
let tmp;
let contexts = [];
let traceFile;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    tmp = fs.mkdtempSync(path.join(REPO_ROOT, 'tests/.e2e-scratch/dirty2-trace-'));
    traceFile = path.join(tmp, 'dirty-A.jsonl');
    A = await startServer({ batchKey: 'sync', scenarioId: 'dirty2-A', extraEnv: { LUKER_TEST_DIRTY_TRACE: traceFile } });
    B = await startServer({ batchKey: 'sync', scenarioId: 'dirty2-B' });
    for (const server of [A, B]) {
        const root = userRootOf(server);
        writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'Seraphina.png', card: { name: 'Seraphina', first_mes: 'Welcome back to the glade.' } });
        fs.mkdirSync(path.join(root, 'assets', 'ambient'), { recursive: true });
        fs.copyFileSync(SAMPLE_PNG, path.join(root, 'assets', 'ambient', 'glade-rain.mp3'));
        fs.mkdirSync(path.join(root, 'user', 'files'), { recursive: true });
        fs.writeFileSync(path.join(root, 'user', 'files', 'glade-assets.json'), JSON.stringify([
            { id: 'glade-rain.mp3', type: 'ambient', name: 'Glade rain', description: 'Rain over the glade.', url: `${A.baseURL}/user/files/glade-rain.mp3` },
        ]));
        fs.writeFileSync(path.join(root, 'user', 'files', 'glade-ledger.txt'), 'The spring rises beneath the white stones.');
        fs.mkdirSync(path.join(root, 'extensions', 'glade-notes'), { recursive: true });
        fs.writeFileSync(path.join(root, 'extensions', 'glade-notes', 'manifest.json'), JSON.stringify({ display_name: 'Glade Notes', js: 'index.js', author: 'luker-e2e', version: '1.0.0' }));
        fs.writeFileSync(path.join(root, 'extensions', 'glade-notes', 'index.js'), '');
    }
});

test.afterAll(async () => {
    for (const ctx of contexts) await ctx.close();
    await tearDownServer(A);
    await tearDownServer(B);
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** The newest open popup, pinned by its id so it stays the same dialog once newer ones close. */
async function newestPopup(page) {
    const id = await page.locator('dialog.popup[open]').last().getAttribute('data-id');
    return page.locator(`dialog.popup[data-id="${id}"]`);
}

/** Click `trigger`, type `value` into the input popup it opens and accept it. */
async function answerInput(page, trigger, value) {
    await page.locator(trigger).first().click();
    await page.locator('dialog.popup[open] .popup-input:visible').last().waitFor();
    const popup = await newestPopup(page);
    await popup.locator('.popup-input').fill(value);
    await popup.locator('.popup-button-ok').click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 });
}

async function acceptConfirm(page) {
    await page.locator('dialog.popup[open] .popup-button-ok:visible').last().waitFor();
    const popup = await newestPopup(page);
    await popup.locator('.popup-button-ok').click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 });
}

async function chooseFile(page, trigger, file) {
    const chooser = page.waitForEvent('filechooser');
    await trigger.click();
    await (await chooser).setFiles(file);
}

/** Open a `<details>` block whose summary reads `summary` if it is closed. */
async function openDetails(page, summary) {
    const details = page.locator('details', { has: page.locator('summary', { hasText: summary }) }).first();
    if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

async function selectMainApi(page, api) {
    await openTopDrawer(page, 'sys-settings-button');
    await page.locator('#main_api').selectOption(api);
}

/** Open the inline drawer whose header reads `title` if it is closed. */
async function openTitledInlineDrawer(page, title) {
    const drawer = page.locator('.inline-drawer', { has: page.locator('> .inline-drawer-toggle', { hasText: title }) }).first();
    const content = drawer.locator('> .inline-drawer-content');
    if (!(await content.isVisible())) await drawer.locator('> .inline-drawer-toggle').click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

async function loadUI(page, baseURL) {
    await awaitMainUI(page, baseURL);
}

async function selectCharacter(page, name) {
    await openTopDrawer(page, 'rightNavHolder');
    await page.locator('#rm_button_characters').click();
    await page.locator('#rm_print_characters_block .character_select', { has: page.locator(`.avatar[title$="File: ${name}.png"]`) }).click();
    await closeTopDrawer(page, 'rightNavHolder');
}

test('a UI edit in each settings, preset, media and extension category reaches the other device after the idle delay', async ({ browser }) => {
    // Playwright budget for sequential sync round trips across every category.
    test.setTimeout(15 * 60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await loadUI(pageA, A.baseURL);
    await loadUI(pageB, B.baseURL);
    for (const page of [pageA, pageB]) {
        await openTopDrawer(page, 'sys-settings-button');
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(mock.baseURL);
        await page.locator('#custom_api_url_text').blur();
        await page.locator('#custom_model_id').fill('mock-gpt-4o');
        await page.locator('#custom_model_id').blur();
        await closeTopDrawer(page, 'sys-settings-button');
    }
    await expect.poll(() => [A, B].every(server => readJson(server, 'settings.json').oai_settings?.custom_url === mock.baseURL)).toBe(true);
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories: CATEGORIES });
    await openLanSyncPanel(pageB);
    expect(await acceptPairingLink(pageB, link, { categories: CATEGORIES, localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: IDLE_SECONDS, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });
    await ctxB.close();
    contexts = [ctxA];

    const writes = recordDirtyWrites(pageA);
    const step = categoryStep(pageA, writes, {
        idleMs: IDLE_SECONDS * 1000,
        dirtyTrace: () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    });

    const fastUiBefore = readJson(A, 'settings.json').power_user.fast_ui_mode;
    await step('settings', {
        ownRoute: /^\/api\/settings\/(save|patch)\/?$/,
        prepare: async () => {
            await openTopDrawer(pageA, 'user-settings-button');
            await answerInput(pageA, '#ui-preset-save-button', 'Glade Dusk');
        },
        edit: () => pageA.locator('#fast_ui_mode').click(),
        arrived: () => readJson(B, 'settings.json').power_user.fast_ui_mode === !fastUiBefore,
    });

    await step('themes', {
        ownRoute: /^\/api\/themes\/save\/?$/,
        edit: () => pageA.locator('#ui-preset-update-button').click(),
        arrived: () => readJson(B, 'themes/Glade Dusk.json')?.fast_ui_mode === !fastUiBefore,
    });

    await step('movingUI', {
        ownRoute: /^\/api\/moving-ui\/save\/?$/,
        prepare: async () => {
            await pageA.locator('#movingUImode').check();
            await answerInput(pageA, '#movingui-preset-save-button', 'Glade Layout');
            await closeTopDrawer(pageA, 'user-settings-button');
            const grip = await pageA.locator('#sheldheader').boundingBox();
            await pageA.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await pageA.mouse.down();
            await pageA.mouse.move(grip.x + grip.width / 2 - 60, grip.y + grip.height / 2 + 40, { steps: 8 });
            await pageA.mouse.up();
            await openTopDrawer(pageA, 'user-settings-button');
        },
        edit: () => answerInput(pageA, '#movingui-preset-save-button', 'Glade Layout'),
        arrived: () => readJson(B, 'movingUI/Glade Layout.json')?.movingUIState?.sheld !== undefined,
    });

    const keyManager = pageA.locator('dialog.popup[open]', { has: pageA.locator('.secretKeyManager') });
    await step('secrets', {
        ownRoute: /^\/api\/secrets\/rename\/?$/,
        prepare: async () => {
            await openTopDrawer(pageA, 'sys-settings-button');
            await pageA.locator('.manage-api-keys[data-key="api_key_custom"]').click();
            await keyManager.locator('button[data-action="add-secret"]').click();
            await pageA.locator('dialog.popup[open] #newSecretLabel').waitFor();
            const addPopup = await newestPopup(pageA);
            await addPopup.locator('.popup-input').fill('sk-glade-e2e');
            await addPopup.locator('#newSecretLabel').fill('Glade draft');
            await addPopup.locator('.popup-button-ok').click();
            await keyManager.locator('.secretKeyManagerItem', { hasText: 'Glade draft' }).waitFor({ state: 'visible' });
        },
        edit: () => answerInput(pageA, '.secretKeyManagerItem:has-text("Glade draft") button[data-action="rename-secret"]', 'Glade key'),
        arrived: () => (readUserFile(B, 'secrets.json') ?? '').includes('Glade key'),
    });
    await closeAllPopups(pageA);

    await step('openai-presets', {
        ownRoute: /^\/api\/presets\/save\/?$/,
        prepare: async () => {
            await openTopDrawer(pageA, 'ai-config-button');
            await answerInput(pageA, '#new_oai_preset', 'Glade OAI');
            const selectedAt = Date.now();
            await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.at(-1)?.at ?? 0, writes.lastSentAt, selectedAt) >= IDLE_SECONDS * 1000,
                { timeout: 30_000, message: 'OpenAI preset application finishes before editing' }).toBe(true);
            await openTitledInlineDrawer(pageA, 'Generation Parameters');
            await pageA.locator('#temp_openai').press('Home');
            await pageA.locator('#temp_openai').press('ArrowRight');
        },
        edit: () => answerInput(pageA, '#new_oai_preset', 'Glade OAI'),
        arrived: () => readJson(B, 'OpenAI Settings/Glade OAI.json')?.temperature === 0.01,
    });

    for (const { api, label, dir, name, counter, field, temperature, settingsKey } of [
        { api: 'textgenerationwebui', label: 'textgen-presets', dir: 'TextGen Settings', name: 'Glade TG', counter: '#temp_counter_textgenerationwebui', field: 'temp', temperature: 0.01, settingsKey: 'textgenerationwebui_settings' },
        { api: 'kobold', label: 'koboldai-presets', dir: 'KoboldAI Settings', name: 'Glade Kobold', counter: '#temp_counter', field: 'temp', temperature: 0.01, settingsKey: 'kai_settings' },
        { api: 'novel', label: 'novelai-presets', dir: 'NovelAI Settings', name: 'Glade Novel', counter: '#temp_counter_novel', field: 'temperature', temperature: 0.11, settingsKey: 'nai_settings' },
    ]) {
        await step(label, {
            ownRoute: /^\/api\/presets\/save\/?$/,
            prepare: async () => {
                await selectMainApi(pageA, api);
                await openTopDrawer(pageA, 'ai-config-button');
                await answerInput(pageA, `[data-preset-manager-new="${api}"]`, name);
                const selectedAt = Date.now();
                await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.at(-1)?.at ?? 0, writes.lastSentAt, selectedAt) >= IDLE_SECONDS * 1000,
                    { timeout: 30_000, message: `${label}: preset application finishes before editing` }).toBe(true);
                const sliderId = await pageA.locator(counter).getAttribute('data-for');
                await pageA.locator(`#${sliderId}`).press('Home');
                await pageA.locator(`#${sliderId}`).press('ArrowRight');
                await expect(pageA.locator(counter)).toHaveValue(String(temperature));
                await expect.poll(() => readJson(A, 'settings.json')[settingsKey]?.[field],
                    { timeout: 10_000, message: `${label}: edited runtime settings persist` }).toBe(temperature);
            },
            edit: async () => {
                await pageA.locator(`[data-preset-manager-update="${api}"]`).click();
                await expect.poll(() => readJson(A, `${dir}/${name}.json`)?.[field], { message: `${label}: local preset value` }).toBe(temperature);
            },
            arrived: () => readJson(B, `${dir}/${name}.json`)?.[field] === temperature,
        });
    }

    for (const { kind, name, textarea, details } of [
        { kind: 'instruct', name: 'Glade Instruct', textarea: '#instruct_input_sequence' },
        { kind: 'context', name: 'Glade Context', textarea: '#context_example_separator' },
        { kind: 'sysprompt', name: 'Glade Prompt', textarea: '#sysprompt_content' },
        { kind: 'reasoning', name: 'Glade Reasoning', textarea: '#reasoning_prefix', details: 'Reasoning Formatting' },
    ]) {
        const marker = `${name} marker`;
        await step(kind, {
            ownRoute: /^\/api\/presets\/save\/?$/,
            prepare: async () => {
                await selectMainApi(pageA, 'textgenerationwebui');
                await openTopDrawer(pageA, 'advanced-formatting-button');
                if (details) await openDetails(pageA, details);
                await answerInput(pageA, `[data-preset-manager-new="${kind}"]`, name);
                const selectedAt = Date.now();
                await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.at(-1)?.at ?? 0, writes.lastSentAt, selectedAt) >= IDLE_SECONDS * 1000,
                    { timeout: 30_000, message: `${kind}: template application finishes before editing` }).toBe(true);
                await pageA.locator(textarea).fill(marker);
            },
            edit: () => pageA.locator(`[data-preset-manager-update="${kind}"]`).click(),
            arrived: () => (readUserFile(B, `${kind}/${name}.json`) ?? '').includes(marker),
        });
    }

    await step('quickreplies', {
        ownRoute: /^\/api\/quick-replies\/save\/?$/,
        prepare: async () => {
            await openExtensionsDrawer(pageA);
            await openInlineDrawer(pageA, 'qr_container');
            await answerInput(pageA, '#qr--set-new', 'Glade Replies');
        },
        edit: () => pageA.locator('#qr--disableSend').click(),
        arrived: () => readJson(B, 'QuickReplies/Glade Replies.json')?.disableSend === true,
    });

    const workflowEditor = pageA.locator('dialog.popup[open]', { has: pageA.locator('#sd_comfy_workflow_editor_workflow') });
    await step('comfy-workflows', {
        ownRoute: /^\/api\/sd\/comfy\/save-workflow\/?$/,
        prepare: async () => {
            await openInlineDrawer(pageA, 'sd_container');
            await pageA.locator('#sd_source').selectOption('comfy');
            await answerInput(pageA, '#sd_comfy_new_workflow', 'glade-workflow');
            await workflowEditor.locator('.popup-button-cancel').click();
            await workflowEditor.waitFor({ state: 'detached' });
        },
        edit: async () => {
            await pageA.locator('#sd_comfy_open_workflow_editor').click();
            await workflowEditor.locator('#sd_comfy_workflow_editor_workflow').fill('{"glade": "%prompt%"}');
            await workflowEditor.locator('.popup-button-ok').click();
        },
        arrived: () => (readUserFile(B, 'user/workflows/glade-workflow.json') ?? '').includes('glade'),
    });

    const assetButton = pageA.locator('#assets_install_ambient_0');
    await step('assets', {
        ownRoute: /^\/api\/assets\/delete\/?$/,
        prepare: async () => {
            await openInlineDrawer(pageA, 'assets_container');
            await pageA.locator('#assets-json-url-field').fill(`${A.baseURL}/user/files/glade-assets.json`);
            await pageA.locator('#assets-connect-button').click();
            await acceptConfirm(pageA);
            await expect(assetButton.locator('i')).toHaveClass(/fa-check/);
        },
        edit: () => assetButton.click(),
        arrived: () => !exists(B, 'assets/ambient/glade-rain.mp3'),
    });

    const imagesBefore = listed(B, 'user/images');
    const gallery = pageA.locator('#gallery');
    await step('user-images', {
        ownRoute: /^\/api\/images\/upload\/?$/,
        prepare: async () => {
            await closeTopDrawer(pageA, 'extensions-settings-button');
            await selectCharacter(pageA, 'Seraphina');
            const selectedAt = Date.now();
            await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.at(-1)?.at ?? 0, writes.lastSentAt, selectedAt) >= IDLE_SECONDS * 1000,
                { timeout: 30_000, message: 'character selection finishes before opening the gallery' }).toBe(true);
            await pageA.locator('#extensionsMenuButton').click();
            await pageA.locator('#show_gallery_wand_button').click();
            await gallery.getByText('Add Image').waitFor({ state: 'visible' });
        },
        edit: () => chooseFile(pageA, gallery.getByText('Add Image'), SAMPLE_PNG),
        arrived: () => listed(B, 'user/images').some(entry => !imagesBefore.includes(entry) && entry.endsWith('.png')),
    });

    const ledger = pageA.locator('.characterAttachmentsList .attachmentListItem', { hasText: 'Glade ledger.txt' });
    let ledgerRelative;
    await step('user-files', {
        ownRoute: /^\/api\/files\/delete\/?$/,
        prepare: async () => {
            await gallery.locator('.dragClose').click();
            await pageA.locator('#extensionsMenuButton').click();
            await pageA.locator('#manageAttachments').click();
            await pageA.locator('.characterAttachmentsTitle .openActionModalButton').click();
            const chooser = pageA.waitForEvent('filechooser');
            await pageA.locator('.actionButtonsModal .actionButton', { hasText: 'File' }).click();
            await (await chooser).setFiles({ name: 'Glade ledger.txt', mimeType: 'text/plain', buffer: Buffer.from('The spring rises beneath the white stones.') });
            await ledger.waitFor({ state: 'visible' });
            ledgerRelative = (await ledger.getAttribute('data-attachment-url')).replace(/^\//, '');
            await expect.poll(() => readUserFile(B, ledgerRelative), { timeout: 60_000, message: 'the imported attachment reaches the receiver before the measured deletion' }).toBe('The spring rises beneath the white stones.');
        },
        edit: async () => {
            await ledger.locator('.deleteAttachmentButton').click();
            await acceptConfirm(pageA);
        },
        arrived: () => !exists(B, ledgerRelative),
    });
    await closeAllPopups(pageA);

    const persona = path.join(tmp, 'persona.png');
    fs.copyFileSync(SAMPLE_PNG, persona);
    const avatarBefore = bytesOf(B, 'User Avatars/user-default.png');
    await step('avatars', {
        ownRoute: /^\/api\/avatars\/upload\/?$/,
        prepare: () => openPersonaPanel(pageA),
        edit: async () => {
            await chooseFile(pageA, pageA.locator('#persona_set_image_button'), persona);
            await acceptConfirm(pageA);
        },
        arrived: () => {
            const avatar = bytesOf(B, 'User Avatars/user-default.png');
            return !avatar.equals(avatarBefore) && avatar.equals(bytesOf(A, 'User Avatars/user-default.png'));
        },
    });

    await step('extensions', {
        ownRoute: /^\/api\/extensions\/delete\/?$/,
        prepare: async () => {
            await openExtensionsDrawer(pageA);
            await pageA.locator('#extensions_details').click();
            await pageA.locator('.extensions_info .extension_block', { hasText: 'Glade Notes' }).waitFor({ state: 'visible' });
        },
        edit: async () => {
            await pageA.locator('.extensions_info .extension_block', { hasText: 'Glade Notes' }).locator('.btn_delete').click();
            await acceptConfirm(pageA);
        },
        arrived: () => !exists(B, 'extensions/glade-notes'),
    });
});
