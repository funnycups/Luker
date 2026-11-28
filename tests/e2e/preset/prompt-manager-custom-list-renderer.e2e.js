import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../harness/playwright.js';

import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { ensureOaiDrawerOpen, savePresetAsViaButton, selectPresetByName } from './_helpers.js';

test.use({ viewport: { width: 1280, height: 1400 } });

const TEST_EXTENSION_DIR_NAME = 'custom-prompt-list-host';

const TEST_EXTENSION_MANIFEST = {
    display_name: 'Custom Prompt List Host',
    loading_order: -1000,
    requires: [],
    optional: [],
    js: 'index.js',
    author: 'Luker E2E',
    version: '1.0.0',
    auto_update: false,
};

// Minimal third-party extension implementing the upstream PromptManager extension
// contract: monkey-patches `promptManager.renderPromptManagerListItems` and
// wraps `#completion_prompt_manager_list` inside a custom host element.
const TEST_EXTENSION_JS = `
import { promptManager } from '../../../openai.js';

const state = (globalThis.__customPromptListHostState = {
    renderCalls: 0,
    mountCount: 0,
    host: null,
    root: null,
    originalRenderListItems: null,
});

function renderCustomRows(list) {
    const order = promptManager.getPromptOrderForCharacter?.(promptManager.activeCharacter) ?? [];
    const prompts = Array.isArray(promptManager.serviceSettings?.prompts) ? promptManager.serviceSettings.prompts : [];
    const byId = new Map(prompts.filter(Boolean).map(p => [p.identifier, p]));
    list.replaceChildren();
    for (const entry of order) {
        const prompt = byId.get(entry?.identifier);
        if (!prompt?.identifier) continue;
        const li = document.createElement('li');
        li.className = 'completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable custom-prompt-row';
        li.dataset.pmIdentifier = prompt.identifier;
        li.dataset.customRendered = '1';
        const name = document.createElement('span');
        name.className = 'completion_prompt_manager_prompt_name';
        name.textContent = prompt.name || prompt.identifier;
        li.append(name);
        list.append(li);
    }
}

function mountOrSyncCustomList() {
    if (!promptManager?.serviceSettings) return;
    if (state.host?.isConnected && state.root?.isConnected) {
        promptManager.listElement = state.root;
        renderCustomRows(state.root);
        return;
    }
    const existingList = document.getElementById('completion_prompt_manager_list');
    if (!(existingList instanceof HTMLElement)) return;
    const host = document.createElement('div');
    host.className = 'custom-prompt-list-host';
    const root = document.createElement('ul');
    root.id = 'completion_prompt_manager_list';
    root.className = 'text_pole custom-prompt-list';
    host.append(root);
    existingList.replaceWith(host);
    state.host = host;
    state.root = root;
    state.mountCount += 1;
    promptManager.listElement = root;
    renderCustomRows(root);
}

function installPatch() {
    if (!promptManager || typeof promptManager.renderPromptManagerListItems !== 'function') {
        setTimeout(installPatch, 50);
        return;
    }
    if (!state.originalRenderListItems) {
        state.originalRenderListItems = promptManager.renderPromptManagerListItems;
        promptManager.renderPromptManagerListItems = async function () {
            state.renderCalls += 1;
            mountOrSyncCustomList();
        };
    }
    mountOrSyncCustomList();
}

installPatch();
`;

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'preset',
        scenarioId: 'pm-custom-list-renderer',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:1/v1' });

    const extDir = path.join(server.dataRoot, 'default-user', 'extensions', TEST_EXTENSION_DIR_NAME);
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(TEST_EXTENSION_MANIFEST, null, 4));
    fs.writeFileSync(path.join(extDir, 'index.js'), TEST_EXTENSION_JS);
});

async function assertCustomHostMounted(page) {
    await expect.poll(() => page.evaluate(() => {
        const container = document.getElementById('completion_prompt_manager');
        const host = container?.querySelector('.custom-prompt-list-host');
        const list = host?.querySelector('#completion_prompt_manager_list.custom-prompt-list');
        const rows = list?.querySelectorAll('li.custom-prompt-row[data-custom-rendered="1"]').length ?? 0;
        return {
            hasHost: Boolean(host?.isConnected),
            hasCustomList: Boolean(list?.isConnected),
            hasCustomRows: rows > 0,
        };
    }), { timeout: 10_000 }).toEqual({
        hasHost: true,
        hasCustomList: true,
        hasCustomRows: true,
    });
}

test('keeps overridden renderPromptManagerListItems active across chat load, preset switch, reload with auto-load, and prompt save', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await ensureOaiDrawerOpen(page);
    await assertCustomHostMounted(page);

    // Selecting a character emits CHAT_LOADED -> promptManager.renderDebounced().
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_print_characters_block .character_select').first().click();
    await page.waitForFunction(() => Boolean(window.Luker?.getContext?.()?.characterId !== undefined), null, { timeout: 10_000 });

    // Wait for the debounced render triggered by CHAT_LOADED to run and verify
    // the custom renderer was invoked rather than bypassed by the shell rebuild.
    await expect.poll(() => page.evaluate(() => globalThis.__customPromptListHostState?.renderCalls ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
    await assertCustomHostMounted(page);

    // Preset switch calls syncOpenAIPresetUiAfterApply() -> promptManager.render(false).
    const callsBeforeSwitch = await page.evaluate(() => globalThis.__customPromptListHostState.renderCalls);
    await ensureOaiDrawerOpen(page);
    await savePresetAsViaButton(page, 'CustomListRoundtrip');
    await selectPresetByName(page, 'Default');
    await selectPresetByName(page, 'CustomListRoundtrip');
    await expect.poll(() => page.evaluate(() => globalThis.__customPromptListHostState.renderCalls), { timeout: 10_000 }).toBeGreaterThan(callsBeforeSwitch);
    await assertCustomHostMounted(page);

    // Saving an existing prompt through the popup must not replace custom rows
    // in place with native markup; it must route through the overridden renderer.
    const callsBeforeEditSave = await page.evaluate(() => globalThis.__customPromptListHostState.renderCalls);
    await page.evaluate(async () => {
        const { promptManager } = await import('/scripts/openai.js');
        const mainPrompt = promptManager.getPromptById('main');
        promptManager.loadPromptIntoEditForm(mainPrompt);
        promptManager.showPopup();
    });
    const promptTextarea = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill('Updated prompt body under custom list host.');
    await page.locator('#completion_prompt_manager_popup_entry_form_save').click();
    await expect.poll(() => page.evaluate(() => globalThis.__customPromptListHostState.renderCalls), { timeout: 10_000 }).toBeGreaterThan(callsBeforeEditSave);
    await assertCustomHostMounted(page);

    // Enable auto_load_chat via UI settings and reload: startup autoload emits
    // CHAT_LOADED right after extensions activate.
    await page.locator('#user-settings-button .drawer-icon').click();
    const autoLoadCheckbox = page.locator('#auto-load-chat-checkbox');
    await expect(autoLoadCheckbox).toBeVisible();
    await autoLoadCheckbox.check();
    await page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx) return reject(new Error('missing context'));
        const timer = setTimeout(() => reject(new Error('SETTINGS_UPDATED timeout')), 10_000);
        ctx.eventSource.once(ctx.eventTypes.SETTINGS_UPDATED, () => { clearTimeout(timer); resolve(); });
        ctx.saveSettings();
    }));

    await reloadAndAwait(page, server.baseURL);
    await ensureOaiDrawerOpen(page);
    await expect.poll(() => page.evaluate(() => globalThis.__customPromptListHostState?.renderCalls ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
    await assertCustomHostMounted(page);
});
