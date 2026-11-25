import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';
import { openMemoryWorkspace, openOrchWorkspace, openWorkbenchIterate, saveOrchDraftIfVisible, selectOrchPreset, setOrchMode } from '../_lib/ui-workbench.js';
import { accountWindow, openAccountTab, windowConfirm } from '../_lib/account-window.js';
import { read as readCharacterCard } from '../../../src/character-card-parser.js';

let server;

function isSettingsSave(response) {
    return ['/api/settings/save', '/api/settings/patch'].includes(new URL(response.url()).pathname)
        && response.request().method() === 'POST'
        && response.ok();
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'extensions',
        scenarioId: 'prompt-settings-defaults',
        extraConfig: { enableUserAccounts: false },
    });
});

async function revealPrompt(page, selector) {
    await openExtensionsDrawer(page);
    const field = page.locator(selector);
    await expect(field).toBeAttached();
    const drawers = field.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")]');
    for (const drawer of await drawers.all()) {
        const content = drawer.locator('> .inline-drawer-content');
        if (!(await content.isVisible())) {
            await drawer.locator('> .inline-drawer-toggle').click();
        }
    }
    for (const details of await field.locator('xpath=ancestor::details').all()) {
        if ((await details.getAttribute('open')) === null) {
            await details.locator('> summary').click();
        }
    }
    await expect(field).toBeVisible();
    return field;
}

const uiText = (page, text) => page.evaluate(key => globalThis.Luker.getContext().translate(key), text);

async function locatePrompt(page, entry) {
    if (entry.workspace === 'orch') {
        if (entry.mode) await setOrchMode(page, entry.mode);
        const lens = await openOrchWorkspace(page, 'settings');
        return lens.getByLabel(await uiText(page, entry.label), { exact: true });
    }
    if (entry.workspace === 'memory') {
        const lens = await openMemoryWorkspace(page, 'settings');
        const details = lens.locator('[data-settings-section="technical"]');
        if ((await details.getAttribute('open')) === null) await details.locator('> summary').click();
        return lens.locator(`[data-field-key="${entry.key}"] textarea`);
    }
    return revealPrompt(page, entry.selector);
}

async function saveAdvancedIfNeeded(page, entry) {
    if (entry.workspace === 'memory') {
        await page.locator('.mlens').getByRole('button', { name: await uiText(page, 'Save Advanced to Global'), exact: true }).click();
    }
}

async function editAndSave(page, field, value, entry) {
    await Promise.all([
        page.waitForResponse(isSettingsSave),
        (async () => {
            await field.fill(value);
            await field.press('Tab');
            await saveAdvancedIfNeeded(page, entry);
        })(),
    ]);
}

function readSettings() {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'));
}

for (const entry of [
    {
        name: 'character editor',
        selector: '#cea_editor_system_prompt',
        reset: '#cea_reset_editor_system_prompt',
        plugin: 'character_editor_assistant',
        key: 'editorIterationSystemPrompt',
        defaultSource: { path: '/scripts/workbench/targets/card-prompts.js', keys: ['DEFAULT_CARD_SYSTEM_PROMPT'] },
    },
    {
        name: 'CardApp Studio',
        selector: '#cea_cardapp_studio_system_prompt',
        reset: '#cea_reset_cardapp_studio_system_prompt',
        plugin: 'character_editor_assistant',
        key: 'cardAppStudioSystemPrompt',
        defaultSource: { path: '/scripts/extensions/character-editor-assistant/studio/ai-chat.js', keys: ['DEFAULT_SYSTEM_PROMPT'] },
    },
    {
        name: 'search agent',
        selector: '#search_tools_agent_system_prompt',
        reset: '#search_tools_reset_agent_prompt',
        confirmReset: true,
        plugin: 'search_tools',
        key: 'agentSystemPrompt',
        defaultSource: { path: '/scripts/extensions/search-tools/main.js', keys: ['DEFAULT_SETTINGS', 'agentSystemPrompt'] },
    },
    {
        name: 'preset iteration',
        selector: '#cpa_iter_base_system_prompt',
        reset: '#cpa_reset_iter_base_system_prompt',
        plugin: 'completion_preset_assistant',
        key: 'iterBaseSystemPrompt',
        defaultSource: { path: '/scripts/workbench/targets/preset-prompts.js', keys: ['buildBaseSystemPrompt'], call: true },
    },
    {
        name: 'preset orchestrator mode',
        selector: '#cpa_iter_mode_orchestrator_prompt',
        reset: '#cpa_reset_iter_mode_orchestrator_prompt',
        plugin: 'completion_preset_assistant',
        key: 'iterModePromptOrchestratorOptimize',
        defaultSource: { path: '/scripts/workbench/targets/preset-prompts.js', keys: ['buildOrchestratorOptimizeModeBlock'], call: true },
    },
    {
        name: 'preset jailbreak mode',
        selector: '#cpa_iter_mode_jailbreak_prompt',
        reset: '#cpa_reset_iter_mode_jailbreak_prompt',
        plugin: 'completion_preset_assistant',
        key: 'iterModePromptJailbreakOnly',
        defaultSource: { path: '/scripts/workbench/targets/preset-prompts.js', keys: ['buildJailbreakOnlyModeBlock'], call: true },
    },
    {
        name: 'image caption',
        selector: '#caption_prompt',
        reset: '#caption_prompt_restore',
        plugin: 'caption',
        key: 'prompt',
        prepare: async page => (await revealPrompt(page, '#caption_source')).selectOption('multimodal'),
    },
    {
        name: 'vector summary',
        selector: '#vectors_summary_prompt',
        reset: '#vectors_summary_prompt_restore',
        plugin: 'vectors',
        key: 'summary_prompt',
    },
    {
        name: 'expression classification',
        selector: '#expression_llm_prompt',
        reset: '#expression_llm_prompt_restore',
        plugin: 'expressions',
        key: 'llmPrompt',
        prepare: async page => (await revealPrompt(page, '#expression_api')).selectOption('2'),
    },
    {
        name: 'orchestration iteration base',
        workspace: 'orch',
        label: 'Iteration AI base system prompt',
        plugin: 'orchestrator',
        key: 'requestSystemPrompt',
    },
    {
        name: 'orchestration capsule instruction',
        workspace: 'orch',
        mode: 'single',
        label: 'Custom instruction',
        plugin: 'orchestrator',
        key: 'capsuleCustomInstruction',
    },
    {
        name: 'memory configuration',
        workspace: 'memory',
        plugin: 'memory_graph',
        key: 'configIterSystemPrompt',
    },
]) {
    test(`${entry.name} preserves custom and cleared prompts until reset`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        if (entry.prepare) await entry.prepare(page);
        if (entry.plugin === 'vectors') {
            const enabled = await revealPrompt(page, '#vectors_enabled_chats');
            await enabled.check();
        }
        let field = await locatePrompt(page, entry);
        await expect(field).toBeVisible();
        expect((await field.inputValue()).trim()).not.toBe('');
        const defaultText = entry.defaultSource ? await page.evaluate(async source => {
            let value = await import(source.path);
            for (const key of source.keys) value = value[key];
            return source.call ? value() : value;
        }, entry.defaultSource) : null;
        const custom = 'Describe visible details.\n  Keep the requested format.  \n';
        await editAndSave(page, field, custom, entry);
        await expect.poll(() => readSettings().extension_settings[entry.plugin][entry.key]).toBe(custom);

        await awaitMainUI(page, server.baseURL);
        field = await locatePrompt(page, entry);
        await expect(field).toHaveValue(custom);
        await editAndSave(page, field, '', entry);
        await awaitMainUI(page, server.baseURL);
        field = await locatePrompt(page, entry);
        await expect(field).toHaveValue('');
        await expect.poll(() => readSettings().extension_settings[entry.plugin][entry.key]).toBe('');

        if (entry.confirmReset) page.once('dialog', dialog => dialog.accept());
        const reset = entry.workspace === 'orch'
            ? field.locator('..').locator('xpath=following-sibling::button[1]')
            : entry.workspace === 'memory'
                ? page.locator(`.mlens [data-field-key="${entry.key}"]`).getByRole('button', { name: await uiText(page, 'Reset to default'), exact: true })
                : page.locator(entry.reset);
        await expect(reset).toBeVisible();
        await Promise.all([
            page.waitForResponse(isSettingsSave),
            (async () => {
                await reset.click();
                await saveAdvancedIfNeeded(page, entry);
            })(),
        ]);
        if (defaultText !== null) await expect(field).toHaveValue(defaultText);
        const resetText = await field.inputValue();
        expect(resetText.trim()).not.toBe('');
        await expect(field).not.toHaveValue(custom);
        await expect.poll(() => readSettings().extension_settings[entry.plugin][entry.key]).toBe(resetText);
    });
}

test('a cleared iteration prompt reports a validation error before generation', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const entry = { workspace: 'memory', plugin: 'memory_graph', key: 'configIterSystemPrompt' };
    const field = await locatePrompt(page, entry);
    await editAndSave(page, field, '', entry);
    await expect.poll(() => readSettings().extension_settings.memory_graph.configIterSystemPrompt).toBe('');
    const win = await openWorkbenchIterate(page, 'memory', { scope: 'global', newSession: true });
    const generationRequests = [];
    page.on('request', request => {
        if (request.method() === 'POST' && /\/generate(?:-text)?$/.test(new URL(request.url()).pathname)) generationRequests.push(request.url());
    });
    await win.locator('.wb-chat .wb-input').fill('Review the configuration using the supplied context.');
    await win.locator('.wb-chat .wb-send').click();
    try {
        await expect(win.locator('.wb-msg-error').last()).toContainText(await uiText(page, 'Fill in the prompt or reset it to the default.'));
        expect(generationRequests).toHaveLength(0);
    } finally {
        const stop = win.getByRole('button', { name: await uiText(page, 'Stop answering'), exact: true });
        if (await stop.isVisible()) await stop.click();
    }
});

test('restoring legacy blank prompts initializes stored defaults and preserves custom text', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => readSettings().extension_settings.character_editor_assistant.promptDefaultsInitialized).toBe(true);
    const backupDir = join(server.dataRoot, 'default-user/backups');
    const previousBackups = new Set(readdirSync(backupDir));
    await openAccountTab(page, 'snapshots');
    await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/make-snapshot' && response.ok()),
        accountWindow(page).locator('[data-act="snap-make"]').click(),
    ]);
    const restore = accountWindow(page).locator('[data-act="snap-restore"]').first();
    await expect.poll(async () => {
        const name = await restore.getAttribute('data-name');
        return Boolean(name) && !previousBackups.has(name);
    }).toBe(true);
    const snapshotName = await restore.getAttribute('data-name');
    const snapshotPath = join(backupDir, snapshotName);
    const legacyBackup = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const custom = '  Retain this user-authored instruction.\n\n';
    const cea = legacyBackup.extension_settings.character_editor_assistant;
    delete cea.promptDefaultsInitialized;
    cea.editorIterationSystemPrompt = '';
    cea.cardAppStudioSystemPrompt = custom;
    // Prepare an old-version backup fixture, then restore it through the real
    // Account UI. The test never writes the running user's settings file.
    writeFileSync(snapshotPath, JSON.stringify(legacyBackup));
    await restore.click();
    await Promise.all([
        page.waitForEvent('domcontentloaded'),
        windowConfirm(page).locator('[data-r="1"]').click(),
    ]);
    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext
        && performance.getEntriesByName('[init] complete').length > 0, null, { timeout: 60_000 });
    const expected = await page.evaluate(async () => (await import('/scripts/workbench/targets/card-prompts.js')).DEFAULT_CARD_SYSTEM_PROMPT);
    await expect(await revealPrompt(page, '#cea_editor_system_prompt')).toHaveValue(expected);
    await expect(await revealPrompt(page, '#cea_cardapp_studio_system_prompt')).toHaveValue(custom);
    await expect.poll(() => {
        const settings = readSettings().extension_settings.character_editor_assistant;
        return {
            initialized: settings.promptDefaultsInitialized,
            editor: settings.editorIterationSystemPrompt,
            cardApp: settings.cardAppStudioSystemPrompt,
        };
    }).toEqual({ initialized: true, editor: expected, cardApp: custom });
});

const agentPromptCases = [
    { name: 'agenda planner', mode: 'agenda', agentId: 'agenda_planner', path: ['presetLibraries', 'agenda', 'default', 'planner', 'systemPrompt'], exportName: 'defaultAgendaPlanner', field: 'systemPrompt' },
    { name: 'agenda task template', mode: 'agenda', agentId: 'agenda_planner', path: ['presetLibraries', 'agenda', 'default', 'planner', 'userPromptTemplate'], exportName: 'defaultAgendaPlanner', field: 'userPromptTemplate', title: 'Task template' },
    { name: 'single agent role', mode: 'single', agentId: 'single_agent', path: ['singleAgentSystemPrompt'], exportName: 'DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT' },
    { name: 'single agent task', mode: 'single', agentId: 'single_agent', path: ['singleAgentUserPromptTemplate'], exportName: 'DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE', title: 'Task template' },
    { name: 'loop agent', mode: 'loop', agentId: 'loop_agent', path: ['presetLibraries', 'loop', 'default', 'system_prompt'], module: 'loop-default-prompt.js', exportName: 'DEFAULT_LOOP_SYSTEM_PROMPT' },
];

for (const entry of agentPromptCases) {
    test(`${entry.name} stores edited and cleared prompts without replacing them`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, entry.mode);
        if (entry.mode !== 'single') await selectOrchPreset(page, 'default', { scope: 'global' });
        const roleTitle = await uiText(page, entry.title || 'Role prompt (system prompt)');
        const edit = async (value) => {
            const lens = await openOrchWorkspace(page, 'flow');
            const card = lens.locator(`.ol-card[data-agent="${entry.agentId}"]`);
            if ((await card.getAttribute('aria-pressed')) !== 'true') await card.click();
            const field = lens.locator('.ol-field').filter({ has: page.getByText(roleTitle, { exact: true }) });
            await field.getByRole('button', { name: await uiText(page, 'Edit field'), exact: true }).click();
            const area = field.getByRole('textbox', { name: roleTitle, exact: true });
            if (value === undefined) return { lens, field, area };
            await area.fill(value);
            await field.getByRole('button', { name: await uiText(page, 'Done'), exact: true }).click();
            await expect(lens.locator('.ol-savebar')).toBeVisible();
            await saveOrchDraftIfVisible(page);
            return { lens, field, area };
        };
        const savedPrompt = () => entry.path.reduce((value, key) => value?.[key], readSettings().extension_settings.orchestrator);
        const custom = '  Plan from the supplied context.\n';
        await edit(custom);
        await expect.poll(savedPrompt).toBe(custom);
        await awaitMainUI(page, server.baseURL);
        await edit('');
        await expect.poll(savedPrompt).toBe('');
        await awaitMainUI(page, server.baseURL);
        const { field, area } = await edit();
        await expect(area).toHaveValue('');
        await field.getByRole('button', { name: await uiText(page, 'Cancel'), exact: true }).click();
        const reset = field.getByRole('button', { name: await uiText(page, 'Reset to default'), exact: true });
        await expect(reset).toBeVisible();
        await reset.click();
        await saveOrchDraftIfVisible(page);
        const defaultPrompt = await page.evaluate(async ({ module, exportName, field }) => {
            const value = (await import(`/scripts/extensions/orchestrator/${module || 'defaults.js'}`))[exportName];
            return field ? value[field] : value;
        }, entry);
        await expect.poll(savedPrompt).toBe(defaultPrompt);
    });
}

async function selectPromptCharacter(page, avatar = null) {
    const icon = page.locator('#rightNavDrawerIcon');
    if ((await icon.getAttribute('class')).includes('closedIcon')) await icon.click();
    const list = page.locator('#rm_print_characters_block');
    if (!(await list.isVisible())) await page.locator('#rm_button_characters').click();
    const characterId = avatar ? await page.evaluate(wanted => window.Luker.getContext().characters.findIndex(character => character.avatar === wanted), avatar) : null;
    const card = characterId === null ? list.locator('.character_select').first() : list.locator(`.character_select[data-chid="${characterId}"]`);
    await expect(card).toBeVisible();
    await card.click();
    await page.waitForFunction(wanted => {
        const ctx = window.Luker.getContext();
        const selected = ctx.characters[ctx.characterId]?.avatar;
        return Boolean(selected) && (!wanted || selected === wanted);
    }, avatar);
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters[ctx.characterId].avatar;
    });
}

test('character-scoped memory prompts preserve edits and clears across reloads', async ({ page }) => {
    let avatar;
    const selectCard = async () => { avatar = await selectPromptCharacter(page, avatar); };
    const storedPrompt = () => JSON.parse(readCharacterCard(readFileSync(join(server.dataRoot, 'default-user', 'characters', avatar))))
        .data.extensions.memory_graph?.advancedOverride?.configIterSystemPrompt;
    const entry = { workspace: 'memory', key: 'configIterSystemPrompt' };
    const saveToCard = async () => {
        await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/merge-attributes'
                && response.request().method() === 'POST' && response.ok()),
            page.getByRole('button', { name: await uiText(page, 'Save Advanced to Character'), exact: true }).click(),
        ]);
    };
    const edit = async (value) => {
        const field = await locatePrompt(page, entry);
        await field.fill(value);
        await field.press('Tab');
        await saveToCard();
        return field;
    };
    await awaitMainUI(page, server.baseURL);
    await selectCard();
    const globalPrompt = readSettings().extension_settings.memory_graph.configIterSystemPrompt;
    const custom = '  Respect the supplied setting.\n';
    await edit(custom);
    await expect.poll(storedPrompt).toBe(custom);
    await awaitMainUI(page, server.baseURL);
    await selectCard();
    await expect(await locatePrompt(page, entry)).toHaveValue(custom);
    await edit('');
    await expect.poll(storedPrompt).toBe('');
    await awaitMainUI(page, server.baseURL);
    await selectCard();
    const field = await locatePrompt(page, entry);
    await expect(field).toHaveValue('');
    await field.locator('xpath=ancestor::*[@data-field-key]').getByRole('button', { name: await uiText(page, 'Reset to default'), exact: true }).click();
    await saveToCard();
    const defaultPrompt = await page.evaluate(async () => (await import('/scripts/extensions/memory-graph/config-iteration/fields.js')).CONFIG_FIELDS['settings.configIterSystemPrompt'].defaultValue);
    await expect.poll(storedPrompt).toBe(defaultPrompt);
    expect(readSettings().extension_settings.memory_graph.configIterSystemPrompt).toBe(globalPrompt);
});

test('failed character prompt saves retain the stored value and unsaved edit', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const avatar = await selectPromptCharacter(page);
    const directory = join(server.dataRoot, 'default-user', 'characters');
    const storedPrompt = () => JSON.parse(readCharacterCard(readFileSync(join(directory, avatar))))
        .data.extensions.memory_graph?.advancedOverride?.configIterSystemPrompt;
    const field = await locatePrompt(page, { workspace: 'memory', key: 'configIterSystemPrompt' });
    const button = page.getByRole('button', { name: await uiText(page, 'Save Advanced to Character'), exact: true });
    const matchesSave = response => new URL(response.url()).pathname === '/api/characters/merge-attributes'
        && response.request().method() === 'POST';
    const saved = 'Keep this saved configuration.\n';
    await field.fill(saved);
    await field.press('Tab');
    await Promise.all([page.waitForResponse(response => matchesSave(response) && response.ok()), button.click()]);
    await expect.poll(storedPrompt).toBe(saved);

    const unsaved = '  Keep this uncommitted edit.\n';
    await field.fill(unsaved);
    await field.press('Tab');
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, 0o555);
    try {
        const [response] = await Promise.all([page.waitForResponse(matchesSave), button.click()]);
        expect(response.status()).toBe(500);
        await expect(page.locator('.ml-settings-error')).toBeVisible();
        await expect(field).toHaveValue(unsaved);
        expect(storedPrompt()).toBe(saved);
        const cached = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].data.extensions.memory_graph.advancedOverride.configIterSystemPrompt;
        });
        expect(cached).toBe(saved);
    } finally {
        chmodSync(directory, mode);
    }
    await Promise.all([page.waitForResponse(response => matchesSave(response) && response.ok()), button.click()]);
    await expect.poll(storedPrompt).toBe(unsaved);
    await expect(page.locator('.ml-settings-error')).toBeHidden();
});
