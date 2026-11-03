// #118 — Multi-select bulk delete on the connection-profile picker.
//
// Real user gestures only: the rendered Select2 dropdown is opened by
// clicking its selection box, rows are selected by clicking the row label,
// and bulk delete is driven by ticking row checkboxes and pressing the
// toolbar button.
//
// The one exception is reading state: everything else is asserted through
// the native <select> and through `extension_settings.connectionManager`.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

const PROFILE_NAMES = ['reef-watch', 'tide-relay', 'salt-mark'];
const PROFILE_MODELS = { 'reef-watch': 'mock-reef', 'tide-relay': 'mock-tide', 'salt-mark': 'mock-salt' };
const RESULTS_ID = '#select2-connection_profiles-results';
const UNDO_BUTTON = '.prompt-manager-toggle-undo-button';

let server;
let mock;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash nods, the lantern steady between you.* The relay holds.'] });
    server = await startServer({ batchKey: 'bulkdelete', scenarioId: 'profiles' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    for (const name of PROFILE_NAMES) {
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name, model: PROFILE_MODELS[name] });
    }
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/** The dropdown belonging to #connection_profiles (seven other select2 widgets exist). */
function profileDropdown(page) {
    return page.locator('.select2-dropdown').filter({ has: page.locator(RESULTS_ID) });
}

function profileRow(page, label) {
    return page.locator(`${RESULTS_ID} .select2-results__option`).filter({ hasText: label }).first();
}

/** The profile picker lives in the API Connections drawer (`#rm_api_block`). */
async function openApiConnectionsDrawer(page) {
    const block = page.locator('#rm_api_block');
    const isOpen = await block.evaluate((el) => !el.classList.contains('closedDrawer')).catch(() => false);
    if (!isOpen) {
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
    }
    await block.waitFor({ state: 'visible', timeout: 10_000 });
}

async function openProfileDropdown(page) {
    await openApiConnectionsDrawer(page);
    await page.waitForFunction(() => {
        const select = document.querySelector('#connection_profiles');
        return !!select && Array.from(select.options).some((option) => option.value !== '');
    }, undefined, { timeout: 15_000 });
    await page.locator('#connection_profiles + .select2-container .select2-selection').click();
    await page.locator(`${RESULTS_ID} .select2-results__option`).first().waitFor({ state: 'visible', timeout: 5_000 });
}

async function toggleRow(page, label) {
    await profileRow(page, label).locator('.luker-action-select2-option__checkbox').click();
}

/** Selecting a row is not the feature under test; drive it through the real row label. */
async function selectProfileRow(page, label) {
    await profileRow(page, label).locator('.luker-action-select2-option__label').click();
    await page.waitForFunction((name) => {
        const manager = window.Luker.getContext().extensionSettings.connectionManager;
        const selected = manager.profiles.find((profile) => profile.id === manager.selectedProfile);
        return selected?.name === name;
    }, label, { timeout: 15_000 });
}

async function expectProfileLabels(page, { contains = [], excludes = [] }) {
    await page.waitForFunction(({ contains, excludes }) => {
        const labels = Array.from(document.querySelector('#connection_profiles').options)
            .map((option) => (option.textContent || '').trim());
        return contains.every((name) => labels.includes(name)) && excludes.every((name) => !labels.includes(name));
    }, { contains, excludes }, { timeout: 15_000 });
}

async function recordLoadedEvents(page) {
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        window.__bulkLoadedEvents = [];
        ctx.eventSource.on(ctx.eventTypes.CONNECTION_PROFILE_LOADED, (name) => {
            window.__bulkLoadedEvents.push(String(name));
        });
    });
}

async function confirmBulkDelete(page, expectedNames) {
    const toolbar = page.locator('.luker-bulk-delete-toolbar');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });
    await toolbar.locator('.luker-bulk-delete-toolbar__delete').click();

    const popup = page.locator('.popup:visible').last();
    for (const name of expectedNames) {
        await expect(popup).toContainText(name);
    }
    await popup.locator('.popup-button-ok').click();
}

test('bulk delete removes the ticked profiles and undo brings them back', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openProfileDropdown(page);

    await toggleRow(page, 'reef-watch');
    await toggleRow(page, 'tide-relay');

    const toolbar = page.locator('.luker-bulk-delete-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');
    await expect(profileDropdown(page).locator('.luker-action-select2-option__delete').first()).toBeHidden();

    await confirmBulkDelete(page, ['reef-watch', 'tide-relay']);
    await expectProfileLabels(page, { contains: ['salt-mark'], excludes: ['reef-watch', 'tide-relay'] });

    await page.locator(UNDO_BUTTON).click();
    await expectProfileLabels(page, { contains: ['reef-watch', 'tide-relay'] });
});

test('select-all covers exactly the rows that offer a per-row delete', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openProfileDropdown(page);

    // The <None> option has value '' and select2's hidePlaceholder decorator drops
    // every result whose id matches the placeholder id (the wrapper passes ''), so
    // no non-deletable row reaches the results list. The invariant that survives
    // is: a row is bulk-selectable exactly when it has its own delete button.
    const deleteButtons = await page.locator(`${RESULTS_ID} .luker-action-select2-option__delete`).count();
    const checkboxes = await page.locator(`${RESULTS_ID} .luker-action-select2-option__checkbox`).count();
    expect(deleteButtons).toBeGreaterThan(0);
    expect(checkboxes).toBe(deleteButtons);

    await toggleRow(page, 'salt-mark');

    const toolbar = page.locator('.luker-bulk-delete-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.locator('.luker-bulk-delete-toolbar__select-all').click();
    await expect(toolbar.locator('.luker-bulk-delete-toolbar__count')).toContainText(`: ${checkboxes}`);
});

test('clicking between two checkboxes ticks the row instead of switching profiles', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openProfileDropdown(page);

    const selectedBefore = await page.evaluate(() => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile);

    await toggleRow(page, 'reef-watch');

    // The click lands on the row's padding, a few pixels left of the
    // checkbox's center: the near miss that used to select the profile,
    // close the dropdown and drop the batch selection.
    const target = profileRow(page, 'tide-relay');
    await target.click({ position: { x: 3, y: 3 } });

    await expect(target.locator('.luker-action-select2-option__checkbox')).toBeChecked();
    await expect(page.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');
    await expect(target).toBeVisible();
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile)).toBe(selectedBefore);
});

test('deleting the active profile falls back to <None> and undo applies it again', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await recordLoadedEvents(page);

    await openProfileDropdown(page);
    await selectProfileRow(page, 'tide-relay');

    const { activeId, activeModel } = await page.evaluate(() => {
        const manager = window.Luker.getContext().extensionSettings.connectionManager;
        const profile = manager.profiles.find((item) => item.id === manager.selectedProfile);
        return { activeId: manager.selectedProfile, activeModel: profile?.model || '' };
    });
    expect(activeId).toBeTruthy();
    expect(activeModel).toBeTruthy();

    await openProfileDropdown(page);
    await toggleRow(page, 'tide-relay');
    await confirmBulkDelete(page, ['tide-relay', 'tide']);

    await page.waitForFunction(() => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile === null, undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => document.querySelector('#connection_profiles').value)).toBe('');

    await page.evaluate(() => { window.__bulkLoadedEvents = []; });
    await page.locator(UNDO_BUTTON).click();

    await page.waitForFunction((id) => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile === id, activeId, { timeout: 10_000 });
    await expectProfileLabels(page, { contains: ['tide-relay'] });
    expect(await page.evaluate(() => window.__bulkLoadedEvents)).toContain('tide-relay');

    // Restoring the picker is not enough: the profile's own settings have to be
    // applied again, otherwise the picker names one profile while the live
    // connection is whatever the user picked in the meantime.
    await page.waitForFunction(
        (model) => window.Luker.getContext().chatCompletionSettings.openai_model === model,
        activeModel,
        { timeout: 15_000 },
    );
});

test('committing the delete tells consumers the active profile is gone', async ({ page }) => {
    test.setTimeout(60_000);

    await awaitMainUI(page, server.baseURL);
    await recordLoadedEvents(page);

    await openProfileDropdown(page);
    await selectProfileRow(page, 'salt-mark');

    await openProfileDropdown(page);
    await toggleRow(page, 'salt-mark');
    await confirmBulkDelete(page, ['salt-mark']);

    // Deferred: the <None> hand-off must not happen while the undo is pending.
    expect(await page.evaluate(() => window.__bulkLoadedEvents)).not.toContain('<None>');

    await page.waitForFunction(() => window.__bulkLoadedEvents.includes('<None>'), undefined, { timeout: 20_000 });
});

test('undo applies the restored profile instead of leaving the newly picked one applied', async ({ page }) => {
    test.setTimeout(90_000);

    await awaitMainUI(page, server.baseURL);
    await recordLoadedEvents(page);

    await openProfileDropdown(page);
    await selectProfileRow(page, 'reef-watch');
    const { activeId, activeModel } = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const manager = ctx.extensionSettings.connectionManager;
        const profile = manager.profiles.find((item) => item.id === manager.selectedProfile);
        return { activeId: manager.selectedProfile, activeModel: profile?.model || '' };
    });
    expect(activeModel).toBe('mock-reef');
    await page.waitForFunction((model) => window.Luker.getContext().chatCompletionSettings.openai_model === model, activeModel, { timeout: 20_000 });

    await openProfileDropdown(page);
    await toggleRow(page, 'reef-watch');
    await confirmBulkDelete(page, ['reef-watch']);
    await page.waitForFunction(() => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile === null, undefined, { timeout: 15_000 });

    // Pick a different profile during the undo window, which applies its own
    // settings. Undo has to put the deleted profile's settings back, not just
    // move the picker's selection.
    await openProfileDropdown(page);
    await selectProfileRow(page, 'tide-relay');
    await page.waitForFunction(() => window.Luker.getContext().chatCompletionSettings.openai_model === 'mock-tide', undefined, { timeout: 20_000 });

    await page.evaluate(() => { window.__bulkLoadedEvents = []; });
    await page.locator(UNDO_BUTTON).click();

    await page.waitForFunction((id) => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile === id, activeId, { timeout: 15_000 });
    await page.waitForFunction((model) => window.Luker.getContext().chatCompletionSettings.openai_model === model, activeModel, { timeout: 20_000 });
});

test('committing after another profile was picked does not announce <None>', async ({ page }) => {
    test.setTimeout(90_000);

    await awaitMainUI(page, server.baseURL);
    await recordLoadedEvents(page);

    await openProfileDropdown(page);
    await selectProfileRow(page, 'reef-watch');

    await openProfileDropdown(page);
    await toggleRow(page, 'reef-watch');
    await confirmBulkDelete(page, ['reef-watch']);
    await page.waitForFunction(() => window.Luker.getContext().extensionSettings.connectionManager.selectedProfile === null, undefined, { timeout: 15_000 });

    // Pick a different profile during the undo window. The delete still
    // commits, but announcing `<None>` would tell every consumer the
    // connection was cleared while `tide-relay` is applied and active.
    await openProfileDropdown(page);
    await selectProfileRow(page, 'tide-relay');

    await page.evaluate(() => { window.__bulkLoadedEvents = []; });
    await page.waitForTimeout(6000);

    expect(await page.evaluate(() => window.__bulkLoadedEvents)).not.toContain('<None>');
});
