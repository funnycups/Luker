import { test, expect } from '@playwright/test';
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { accountWindow, openAccountTab, windowConfirm } from '../_lib/account-window.js';
import { selectWorkbenchTab, workbenchWindow } from '../_lib/ui-workbench.js';
import { LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT } from '../../../public/scripts/extensions/stable-diffusion/illustration/presets.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: 'prompt-settings',
        extraConfig: { enableUserAccounts: false },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

function readSettings() {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8')).extension_settings.sd.illustration;
}

function readCurrentPreset() {
    const settings = readSettings();
    return settings.presets.find(preset => preset.id === settings.currentPresetId);
}

async function uiText(page, text) {
    return page.evaluate(value => window.Luker.getContext().translate(value), text);
}

async function openIllustrationDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_illustration_container');
}

async function openPromptField(page, selector) {
    await openIllustrationDrawer(page);
    const field = page.locator(selector);
    if (!(await field.isVisible())) {
        await field.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")][1]')
            .locator('> .inline-drawer-toggle').click();
    }
    await expect(field).toBeVisible();
    return field;
}

async function chooseStyle(page, style) {
    await openIllustrationDrawer(page);
    const select = page.locator('#sd_illustration_prompt_style');
    await expect(select).toBeAttached();
    await expect(select).toBeVisible();
    await select.selectOption(style);
    await expect.poll(() => readCurrentPreset().promptStyle).toBe(style);
}

async function getDefaults(page, style) {
    return page.evaluate(async value => {
        const presets = await import('/scripts/extensions/stable-diffusion/illustration/presets.js');
        return presets.getDefaultPromptValues(value);
    }, style);
}

const promptFields = [
    { key: 'illustrationPrompt', selector: '#sd_illustration_prompt', reset: '#sd_illustration_prompt_reset' },
    { key: 'studioPrompt', selector: '#sd_illustration_studio_prompt', reset: '#sd_illustration_studio_prompt_reset' },
    { key: 'explorationPrompt', selector: '#sd_illustration_exploration_prompt', reset: '#sd_illustration_exploration_prompt_reset' },
];

for (const entry of promptFields) {
    test(`${entry.key} preserves edits and clears until its explicit reset`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await chooseStyle(page, 'tag');
        let field = await openPromptField(page, entry.selector);
        const custom = 'Use the supplied visual details.\n  Keep the requested format.  \n';
        await field.fill(custom);
        await expect.poll(() => readCurrentPreset()[entry.key]).toBe(custom);
        await awaitMainUI(page, server.baseURL);
        field = await openPromptField(page, entry.selector);
        await expect(field).toHaveValue(custom);
        await field.fill('');
        await expect.poll(() => readCurrentPreset()[entry.key]).toBe('');
        await awaitMainUI(page, server.baseURL);
        field = await openPromptField(page, entry.selector);
        await expect(field).toHaveValue('');
        await chooseStyle(page, 'natural');
        await expect(field).toHaveValue('');
        const defaults = await getDefaults(page, 'natural');
        await page.locator(entry.reset).click();
        await expect(field).toHaveValue(defaults[entry.key]);
        await expect.poll(() => readCurrentPreset()[entry.key]).toBe(defaults[entry.key]);
    });
}

test('new presets persist their selected style and full prompt values', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await chooseStyle(page, 'natural');
    const previous = readCurrentPreset();
    const before = readSettings().presets.length;
    await page.locator('#sd_illustration_preset_new').click();
    await expect.poll(() => readSettings().presets.length).toBe(before + 1);
    const created = readCurrentPreset();
    expect(created.id).not.toBe(previous.id);
    expect(created.promptStyle).toBe('natural');
    expect(created.promptDefaultsInitialized).toBe(true);
    expect(created.llm).toEqual(previous.llm);
    for (const { key } of promptFields) expect(created[key].trim()).not.toBe('');
    await server.restart();
    await awaitMainUI(page, server.baseURL);
    await openIllustrationDrawer(page);
    await expect(page.locator('#sd_illustration_preset')).toHaveValue(created.id);
    await expect(page.locator('#sd_illustration_prompt_style')).toHaveValue('natural');
    expect(readCurrentPreset()).toEqual(created);
});

test('the settings shortcut opens image prompt iteration', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openIllustrationDrawer(page);
    await expect(page.locator('#sd_illustration_iterate_ai')).toBeVisible();
    await page.locator('#sd_illustration_iterate_ai').click();
    const win = workbenchWindow(page);
    await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]')).toHaveText(await uiText(page, 'Image Generation'));
    await expect(win.locator('.wb-chat .wb-input')).toBeVisible();
});

for (const entry of [
    { name: 'studio', key: 'studioPrompt', field: '#sd_illustration_studio_prompt', view: 'studio', input: 'studio-input', submit: 'studio-send', stop: 'studio-stop', text: 'Draw a traveler beside a quiet river.' },
    { name: 'exploration', key: 'explorationPrompt', field: '#sd_illustration_exploration_prompt', view: 'characters', openDialog: 'open-ai-builder', dialogRole: 'character-builder-dialog', input: 'builder-input', submit: 'builder-send', closeRole: 'builder-cancel', text: 'A wandering cartographer' },
]) {
    test(`a cleared ${entry.name} prompt reports an error before requesting generation`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const field = await openPromptField(page, entry.field);
        await field.fill('');
        await expect.poll(() => readCurrentPreset()[entry.key]).toBe('');
        await selectWorkbenchTab(page, 'sd');
        const studio = page.locator('.sdlens');
        await studio.locator(`[data-sd-nav="${entry.view}"]`).click();
        let scope = studio;
        if (entry.openDialog) {
            await studio.locator(`[data-sd-role="${entry.openDialog}"]`).first().click();
            scope = page.locator(`[data-sd-role="${entry.dialogRole}"]`).last();
            await expect(scope).toBeVisible();
        }
        const requests = [];
        page.on('request', request => {
            if (request.method() === 'POST' && /\/generate(?:-text)?$/.test(new URL(request.url()).pathname)) requests.push(request.url());
        });
        try {
            await scope.locator(`[data-sd-role="${entry.input}"]`).fill(entry.text);
            await scope.locator(`[data-sd-role="${entry.submit}"]`).click();
            await expect(page.getByText(await uiText(page, 'Fill in the prompt or reset it to the default.')).first()).toBeVisible();
            expect(requests).toEqual([]);
        } finally {
            if (entry.stop) {
                const stop = scope.locator(`[data-sd-role="${entry.stop}"]`);
                if (await stop.isVisible()) await stop.click();
            }
            if (entry.closeRole) {
                const cancel = scope.locator(`[data-sd-role="${entry.closeRole}"]`);
                if (await cancel.isVisible()) await cancel.click();
            }
        }
    });
}

test('legacy custom prompts wait for a style choice while exact defaults migrate', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
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
    const snapshotPath = join(backupDir, await restore.getAttribute('data-name'));
    const backup = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const custom = '  Respect the requested visual identity.\n\n';
    const design = '  Keep this earlier appearance instruction.\n';
    const template = backup.extension_settings.sd.illustration.presets[0];
    const presets = [{
        ...template, id: 'unresolved-style', name: 'Tag style',
        illustrationPrompt: custom, studioPrompt: '', explorationPrompt: '', characterDesignPrompt: design,
    }, {
        ...template, id: 'exact-natural', name: 'Tag style',
        illustrationPrompt: LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT, studioPrompt: '', explorationPrompt: '',
    }];
    for (const preset of presets) {
        delete preset.promptStyle;
        delete preset.promptDefaultsInitialized;
        delete preset.pendingStyleDefaults;
    }
    backup.extension_settings.sd.illustration = {
        ...backup.extension_settings.sd.illustration,
        initialized: true, currentPresetId: 'unresolved-style', presets,
    };
    // This is an old-version backup fixture, restored by the actual Account UI.
    writeFileSync(snapshotPath, JSON.stringify(backup));
    await restore.click();
    await Promise.all([
        page.waitForEvent('domcontentloaded'),
        windowConfirm(page).locator('[data-r="1"]').click(),
    ]);
    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext
        && performance.getEntriesByName('[init] complete').length > 0, null, { timeout: 60_000 });
    await openIllustrationDrawer(page);
    const style = page.locator('#sd_illustration_prompt_style');
    await expect(style).toBeAttached();
    await expect(style).toHaveValue('');
    await expect(page.locator('#sd_illustration_prompt')).toHaveValue(custom);
    await expect(page.locator('#sd_illustration_studio_prompt')).toHaveValue('');
    await expect(page.locator('#sd_illustration_studio_prompt_reset')).toBeDisabled();
    await expect(page.locator('#sd_illustration_character_design_prompt')).toHaveCount(0);
    await expect(page.locator('#sd_illustration_legacy_design_notice')).toBeVisible();
    expect(Object.hasOwn(readCurrentPreset(), 'characterDesignPrompt')).toBe(false);
    expect(readSettings().pendingCharacterDesignPrompts).toEqual([{
        presetId: 'unresolved-style',
        presetName: 'Tag style',
        text: design,
    }]);

    // Review dialog shows full verbatim text; Cancel retains pending migration record.
    await page.locator('#sd_illustration_review_legacy_design').click();
    const migrationDialog = page.locator('[data-sd-role="legacy-prompt-migration-dialog"]').last();
    await expect(migrationDialog).toBeVisible();
    await expect(migrationDialog.locator('[data-sd-role="legacy-prompt-text"]')).toHaveValue(design);
    await migrationDialog.locator('[data-sd-role="legacy-prompt-cancel"]').click();
    await expect(migrationDialog).toBeHidden();
    expect(readSettings().pendingCharacterDesignPrompts).toHaveLength(1);

    // Export delivers complete file and clears the pending record only after explicit confirmation.
    await page.locator('#sd_illustration_review_legacy_design').click();
    const exportDialog = page.locator('[data-sd-role="legacy-prompt-migration-dialog"]').last();
    await expect(exportDialog).toBeVisible();
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        exportDialog.locator('[data-sd-role="legacy-prompt-export"]').click(),
    ]);
    const exportedPath = await download.path();
    expect(readFileSync(exportedPath, 'utf8')).toContain(design);
    const confirmPopup = page.locator('dialog.popup[open]').last();
    await confirmPopup.locator('.popup-button-ok').click();
    await expect(exportDialog).toBeHidden();
    await expect(page.locator('#sd_illustration_legacy_design_notice')).toBeHidden();
    await expect.poll(() => readSettings().pendingCharacterDesignPrompts).toBeUndefined();

    await chooseStyle(page, 'natural');
    const defaults = await getDefaults(page, 'natural');
    await expect(page.locator('#sd_illustration_studio_prompt')).toHaveValue(defaults.studioPrompt);
    await expect(page.locator('#sd_illustration_prompt')).toHaveValue(custom);
    await expect.poll(() => readCurrentPreset().studioPrompt).toBe(defaults.studioPrompt);
    expect(Object.hasOwn(readCurrentPreset(), 'characterDesignPrompt')).toBe(false);
    await page.locator('#sd_illustration_preset').selectOption('exact-natural');
    await expect(style).toHaveValue('natural');
    await expect(page.locator('#sd_illustration_prompt')).toHaveValue(defaults.illustrationPrompt);
    await expect.poll(() => readCurrentPreset().id).toBe('exact-natural');
    expect(readCurrentPreset().promptDefaultsInitialized).toBe(true);
});

test('failed preset creation restores the previous selection and permits retry', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await chooseStyle(page, 'tag');
    const previous = readCurrentPreset();
    const before = readSettings().presets.length;
    const directory = join(server.dataRoot, 'default-user');
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, 0o555);
    try {
        const [response] = await Promise.all([
            page.waitForResponse(value => new URL(value.url()).pathname === '/api/settings/save' && value.request().method() === 'POST'),
            page.locator('#sd_illustration_preset_new').click(),
        ]);
        expect(response.status()).toBe(500);
        await expect(page.locator('.toast-error').first()).toBeVisible();
        await expect(page.locator('#sd_illustration_preset option')).toHaveCount(before);
        await expect(page.locator('#sd_illustration_preset')).toHaveValue(previous.id);
        const cached = await page.evaluate(() => {
            const settings = window.Luker.getContext().extensionSettings.sd.illustration;
            return { count: settings.presets.length, current: settings.currentPresetId };
        });
        expect(cached).toEqual({ count: before, current: previous.id });
        expect(readSettings().presets).toHaveLength(before);
    } finally {
        chmodSync(directory, mode);
    }
    await page.locator('#sd_illustration_preset_new').click();
    await expect.poll(() => readSettings().presets.length).toBe(before + 1);
    await expect(page.locator('#sd_illustration_preset')).toHaveValue(readCurrentPreset().id);
});

test('a failed prompt reset retains saved text and permits retry', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openIllustrationDrawer(page);
    await chooseStyle(page, 'tag');
    const field = await openPromptField(page, '#sd_illustration_prompt');
    const custom = '  Describe the requested scene.\n\n';
    await field.fill(custom);
    await expect.poll(() => readCurrentPreset().illustrationPrompt).toBe(custom);
    const before = readCurrentPreset();
    const defaults = await getDefaults(page, 'tag');
    const reset = page.locator('#sd_illustration_prompt_reset');
    const directory = join(server.dataRoot, 'default-user');
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, 0o555);
    try {
        const [response] = await Promise.all([
            page.waitForResponse(value => value.request().method() === 'POST'
                && new URL(value.url()).pathname === '/api/settings/save'),
            reset.click(),
        ]);
        expect(response.status()).toBe(500);
        await expect(reset).toBeEnabled();
        await expect(field).toHaveValue(custom);
        expect(readCurrentPreset()).toEqual(before);
        const cached = await page.evaluate(() => {
            const settings = window.Luker.getContext().extensionSettings.sd.illustration;
            return settings.presets.find(preset => preset.id === settings.currentPresetId);
        });
        expect(cached).toEqual(before);
    } finally {
        chmodSync(directory, mode);
    }
    await reset.click();
    await expect.poll(() => readCurrentPreset().illustrationPrompt).toBe(defaults.illustrationPrompt);
    await expect(field).toHaveValue(defaults.illustrationPrompt);
});
