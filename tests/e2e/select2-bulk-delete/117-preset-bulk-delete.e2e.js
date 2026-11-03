// #117 — Multi-select bulk delete on the OpenAI preset picker.
//
// Drives the real rendered Select2 dropdown (the checkbox rows and the batch
// toolbar), not the hidden native <select>.

import { test, expect } from '@playwright/test';
import AdmZip from 'adm-zip';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writePreset } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { normalizeIterStudioSettings, ensureOaiDrawerOpen } from '../preset/_helpers.js';

const PRESETS = ['reef-notes', 'reef-draft', 'tide-tables'];
const RESULTS_ID = '#select2-settings_preset_openai-results';

let server, mock;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Seraphina folds the chart away.* The lantern still holds.'] });
    server = await startServer({
        batchKey: 'bulkdelete',
        scenarioId: 'preset',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    for (const name of PRESETS) {
        writePreset({ dataRoot: server.dataRoot, name });
    }
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

function presetDropdown(page) {
    return page.locator('.select2-dropdown').filter({ has: page.locator(RESULTS_ID) });
}

function presetRow(page, label) {
    return presetDropdown(page).locator('.select2-results__option', { hasText: label }).first();
}

async function openPresetDropdown(page) {
    await ensureOaiDrawerOpen(page);
    await page.waitForFunction((names) => {
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return false;
        const texts = Array.from(select.options).map((option) => option.textContent.trim());
        return names.every((name) => texts.includes(name));
    }, PRESETS, { timeout: 20_000 });
    await page.locator('#settings_preset_openai + .select2-container .select2-selection').click();
    await presetDropdown(page).locator('.select2-results__option').first().waitFor({ state: 'visible', timeout: 5_000 });
}

async function toggleRow(page, label) {
    await presetRow(page, label).locator('.luker-action-select2-option__checkbox').click();
}

async function presetOptionLabels(page) {
    return page.evaluate(() => Array.from(document.querySelector('#settings_preset_openai').options)
        .map((option) => option.textContent.trim()));
}

test('bulk delete removes the ticked presets and undo brings them back', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openPresetDropdown(page);

    await toggleRow(page, 'reef-notes');
    await toggleRow(page, 'reef-draft');

    const toolbar = page.locator('.luker-bulk-delete-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');

    await toolbar.locator('.luker-bulk-delete-toolbar__delete').click();

    const popup = page.locator('.popup:visible').last();
    await expect(popup).toContainText('reef-notes');
    await expect(popup).toContainText('reef-draft');
    await popup.locator('.popup-button-ok').click();

    await page.waitForFunction(() => {
        const select = document.querySelector('#settings_preset_openai');
        return !!select && !Array.from(select.options).some((option) => option.textContent.trim() === 'reef-notes');
    }, undefined, { timeout: 10_000 });
    expect(await presetOptionLabels(page)).not.toContain('reef-draft');

    await page.locator('.prompt-manager-toggle-undo-button').click();
    await page.waitForFunction((names) => {
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return false;
        const texts = Array.from(select.options).map((option) => option.textContent.trim());
        return names.every((name) => texts.includes(name));
    }, ['reef-notes', 'reef-draft'], { timeout: 10_000 });
});

test('undoing a batch delete keeps the preset that is active now active', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    const activeBefore = await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.preset_settings_openai);
    expect(activeBefore).toBeTruthy();

    await openPresetDropdown(page);
    await toggleRow(page, 'reef-notes');
    await toggleRow(page, 'reef-draft');
    await page.locator('.luker-bulk-delete-toolbar__delete').click();
    await page.locator('.popup .popup-button-ok').last().click();

    await page.waitForFunction(() => !Array.from(document.querySelector('#settings_preset_openai').options)
        .some((option) => option.textContent.trim() === 'reef-notes'), undefined, { timeout: 15_000 });

    await page.locator('.prompt-manager-toggle-undo-button').click();
    await page.waitForFunction(() => Array.from(document.querySelector('#settings_preset_openai').options)
        .some((option) => option.textContent.trim() === 'reef-notes'), undefined, { timeout: 15_000 });

    // Restoring each preset must not make it the active one. Selecting every
    // restored preset would leave the last one restored active, silently
    // overwriting the settings the user is working with.
    expect(await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.preset_settings_openai)).toBe(activeBefore);
});

test('clicking between two checkboxes ticks the row instead of switching presets', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openPresetDropdown(page);

    const activeBefore = await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.preset_settings_openai);

    await toggleRow(page, 'reef-notes');

    // The click lands on the row's padding, a few pixels left of the
    // checkbox's center: the near miss that used to select the option,
    // switch presets and close the dropdown, dropping the batch selection.
    const row = presetRow(page, 'reef-draft');
    await row.click({ position: { x: 3, y: 3 } });

    await expect(row.locator('.luker-action-select2-option__checkbox')).toBeChecked();
    await expect(page.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');
    await expect(presetDropdown(page)).toBeVisible();
    expect(await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.preset_settings_openai)).toBe(activeBefore);
});

test('every row that offers a per-row delete also offers a bulk checkbox', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openPresetDropdown(page);

    const dropdown = presetDropdown(page);
    const deleteButtons = await dropdown.locator('.luker-action-select2-option__delete').count();
    const checkboxes = await dropdown.locator('.luker-action-select2-option__checkbox').count();

    expect(deleteButtons).toBeGreaterThan(0);
    expect(checkboxes).toBe(deleteButtons);
});

test('select-all includes members of a collapsed group', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openPresetDropdown(page);

    // Group reef-notes and reef-draft through the dropdown's own controls.
    await presetRow(page, 'reef-notes').locator('.luker-action-select2-option__group').click();
    const createMenu = page.locator('.luker-preset-ctx-menu').last();
    await createMenu.waitFor({ state: 'visible', timeout: 5_000 });
    page.once('dialog', (dialog) => dialog.accept('reef charts'));
    await createMenu.locator('.luker-preset-ctx-menu__item--new').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#settings_preset_openai option'))
        .some((option) => option.dataset.presetGroupMember === 'true'), undefined, { timeout: 10_000 });

    await presetRow(page, 'reef-draft').locator('.luker-action-select2-option__group').click();
    const moveMenu = page.locator('.luker-preset-ctx-menu').last();
    await moveMenu.waitFor({ state: 'visible', timeout: 5_000 });
    await moveMenu.locator('.luker-preset-ctx-menu__item', { hasText: 'Move to group: reef charts' }).first().click();
    await page.waitForTimeout(500);

    // Reopen so the group renders in its collapsed default state.
    await page.keyboard.press('Escape');
    await openPresetDropdown(page);

    await expect(presetRow(page, 'reef-notes')).toBeHidden();
    await expect(presetRow(page, 'reef-draft')).toBeHidden();

    await toggleRow(page, 'tide-tables');
    const rendered = await presetDropdown(page).locator('.luker-action-select2-option__checkbox').count();
    expect(rendered).toBeGreaterThan(2);

    await page.locator('.luker-bulk-delete-toolbar__select-all').click();
    await expect(page.locator('.luker-bulk-delete-toolbar__count')).toContainText(`: ${rendered}`);
});

test('bulk export downloads a zip with one JSON file per ticked preset', async ({ page }, testInfo) => {
    await awaitMainUI(page, server.baseURL);
    await openPresetDropdown(page);

    await toggleRow(page, 'reef-notes');
    await toggleRow(page, 'reef-draft');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('.luker-bulk-delete-toolbar__export').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('presets.zip');

    const downloadPath = testInfo.outputPath('presets.zip');
    await download.saveAs(downloadPath);

    const zip = new AdmZip(downloadPath);
    const entries = zip.getEntries().map((entry) => entry.entryName).sort();
    expect(entries).toEqual(['reef-draft.json', 'reef-notes.json']);

    const exported = JSON.parse(zip.readAsText('reef-notes.json'));
    expect(exported).toBeTruthy();
    expect(exported.temperature).toBeDefined();
});

test('deleting the active preset leaves the picker and the runtime agreeing', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    await page.evaluate(() => {
        const select = document.querySelector('#settings_preset_openai');
        const option = Array.from(select.options).find((item) => item.textContent.trim() === 'tide-tables');
        if (!option) throw new Error('tide-tables option missing');
        window.jQuery(select).val(String(option.value)).trigger('change');
    });
    await page.waitForFunction(() => window.Luker.getContext().chatCompletionSettings.preset_settings_openai === 'tide-tables', undefined, { timeout: 15_000 });

    await openPresetDropdown(page);
    await toggleRow(page, 'tide-tables');
    await page.locator('.luker-bulk-delete-toolbar__delete').click();
    await page.locator('.popup .popup-button-ok').last().click();

    // The picker and the applied settings must name the same preset. Falling
    // back in the dropdown while the runtime still names the deleted preset
    // leaves every subsequent save writing into a preset that is gone.
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        const select = document.querySelector('#settings_preset_openai');
        const active = ctx.chatCompletionSettings.preset_settings_openai;
        const selectedText = select.selectedOptions[0]?.textContent.trim();
        return Boolean(active) && active !== 'tide-tables' && selectedText === active;
    }, undefined, { timeout: 20_000 });
});
