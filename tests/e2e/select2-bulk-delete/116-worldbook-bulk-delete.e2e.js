// #116 — Multi-select bulk delete on the world/lorebook picker.
//
// Drives the REAL rendered Select2 dropdown: open the container, click the
// per-row checkbox, use the batch toolbar. The hidden native <select> is
// only used for the "which book is open in the editor" setup gesture and
// for reading the surviving option labels — never to invoke the feature.

import { test, expect } from '@playwright/test';
import AdmZip from 'adm-zip';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { awaitMainUI, acceptTopmostPopup, cancelTopmostPopup } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';

test.describe.configure({ mode: 'serial' });

const BOOKS = ['reef-conditions', 'reef-drifters', 'tide-tables'];
let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'bulkdelete', scenarioId: 'worldbook' });
    markOnboarded({ dataRoot: server.dataRoot });
    for (const name of BOOKS) {
        writeWorldBook({ dataRoot: server.dataRoot, name, entries: BRYN_ENTRIES });
    }
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.beforeEach(async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
});

/** Open the WI drawer and pop the rendered Select2 dropdown for the editor picker. */
async function openEditorDropdown(page) {
    await openWorldInfoDrawer(page);
    await page.waitForFunction(() => {
        const select = document.querySelector('#world_editor_select');
        return !!select && Array.from(select.options).some((option) => option.value !== '');
    }, undefined, { timeout: 15_000 });
    await page.locator('#world_editor_select + .select2-container .select2-selection').click();
    await page.locator('.select2-dropdown .select2-results__option').first()
        .waitFor({ state: 'visible', timeout: 5_000 });
}

function row(page, label) {
    return page.locator('.select2-results__option', { hasText: label }).first();
}

async function toggleRow(page, label) {
    await row(page, label).locator('.luker-action-select2-option__checkbox').click();
}

async function editorOptionLabels(page) {
    return page.evaluate(() => Array.from(document.querySelector('#world_editor_select').options)
        .filter((option) => option.value !== '')
        .map((option) => option.textContent.trim())
        .sort());
}

/**
 * Polls the editor dropdown until the wanted labels are present and the
 * unwanted ones are gone. The seeded data root already ships one world book,
 * so the list is never exactly our fixtures.
 */
async function expectEditorLabels(page, { contains = [], excludes = [] } = {}) {
    await expect.poll(async () => {
        const labels = await editorOptionLabels(page);
        return {
            missing: contains.filter((label) => !labels.includes(label)),
            stillPresent: excludes.filter((label) => labels.includes(label)),
        };
    }, { timeout: 10_000 }).toEqual({ missing: [], stillPresent: [] });
}

test('ticking two rows shows the toolbar and hides the per-row delete buttons', async ({ page }) => {
    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await toggleRow(page, 'reef-drifters');

    const toolbar = page.locator('.luker-bulk-delete-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');
    await expect(page.locator('.luker-action-select2-option__delete').first()).toBeHidden();
});

test('a ticked row renders as checked', async ({ page }) => {
    await openEditorDropdown(page);
    const checked = page.locator('.luker-action-select2-option__checkbox:checked');

    await expect(checked).toHaveCount(0);
    await toggleRow(page, 'reef-conditions');
    await expect(checked).toHaveCount(1);
    await toggleRow(page, 'reef-drifters');
    await expect(checked).toHaveCount(2);
    await toggleRow(page, 'reef-conditions');
    await expect(checked).toHaveCount(1);
});

test('clicking between two checkboxes ticks the row instead of switching books', async ({ page }) => {
    await openEditorDropdown(page);
    const selectedBefore = await page.evaluate(() => document.querySelector('#world_editor_select').value);

    await toggleRow(page, 'reef-conditions');

    // The click lands on the row's padding, a few pixels left of the
    // checkbox's center: the near miss that used to select the book, close
    // the dropdown and drop the batch selection.
    const target = row(page, 'reef-drifters');
    await target.click({ position: { x: 3, y: 3 } });

    await expect(target.locator('.luker-action-select2-option__checkbox')).toBeChecked();
    await expect(page.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');
    await expect(target).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('#world_editor_select').value)).toBe(selectedBefore);
});

test('unticking back to zero restores the normal rows', async ({ page }) => {
    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await toggleRow(page, 'reef-drifters');
    await expect(page.locator('.luker-bulk-delete-toolbar')).toBeVisible();

    await toggleRow(page, 'reef-conditions');
    await toggleRow(page, 'reef-drifters');

    await expect(page.locator('.luker-bulk-delete-toolbar')).toHaveCount(0);
    await expect(page.locator('.luker-action-select2-option__delete').first()).toBeVisible();
});

test('bulk delete removes every ticked book and undo brings them all back', async ({ page }) => {
    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await toggleRow(page, 'reef-drifters');

    await page.locator('.luker-bulk-delete-toolbar__delete').click();

    const popup = page.locator('.popup .popup-content').last();
    await expect(popup).toContainText('reef-conditions');
    await expect(popup).toContainText('reef-drifters');
    await acceptTopmostPopup(page);

    await expectEditorLabels(page, {
        contains: ['tide-tables'],
        excludes: ['reef-conditions', 'reef-drifters'],
    });

    await page.locator('.prompt-manager-toggle-undo-button').last().click();
    await expectEditorLabels(page, { contains: BOOKS });
});

test('bulk export downloads a zip with one JSON file per ticked book', async ({ page }, testInfo) => {
    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await toggleRow(page, 'reef-drifters');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('.luker-bulk-delete-toolbar__export').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('worldbooks.zip');

    const downloadPath = testInfo.outputPath('worldbooks.zip');
    await download.saveAs(downloadPath);

    const zip = new AdmZip(downloadPath);
    const entries = zip.getEntries().map((entry) => entry.entryName).sort();
    expect(entries).toEqual(['reef-conditions.json', 'reef-drifters.json']);

    const exported = JSON.parse(zip.readAsText('reef-conditions.json'));
    expect(exported.entries).toBeTruthy();
    expect(Object.keys(exported.entries).length).toBeGreaterThan(0);
});

test('select-all covers the search result set only', async ({ page }) => {
    await openEditorDropdown(page);
    await page.locator('.select2-search__field[aria-controls="select2-world_editor_select-results"]').fill('reef');
    await expect(row(page, 'reef-drifters')).toBeVisible();

    await toggleRow(page, 'reef-conditions');
    await page.locator('.luker-bulk-delete-toolbar__select-all').click();
    await expect(page.locator('.luker-bulk-delete-toolbar__count')).toContainText('2');

    await page.locator('.luker-bulk-delete-toolbar__delete').click();
    const popup = page.locator('.popup .popup-content').last();
    await expect(popup).toContainText('reef-conditions');
    await expect(popup).toContainText('reef-drifters');
    await expect(popup).not.toContainText('tide-tables');
    await cancelTopmostPopup(page);
});

test('every row that offers a per-row delete also offers a bulk checkbox', async ({ page }) => {
    // The world/lorebook picker has no non-deletable rows: select2's
    // hidePlaceholder decorator drops the `--- Pick to Edit ---` option from
    // the results, and every remaining row resolves to a real book. So the
    // invariant to hold here is checkbox ⇔ per-row delete.
    await openEditorDropdown(page);

    const rowsWithDelete = await page.locator('.select2-results__option')
        .filter({ has: page.locator('.luker-action-select2-option__delete') }).count();
    const rowsWithCheckbox = await page.locator('.select2-results__option')
        .filter({ has: page.locator('.luker-action-select2-option__checkbox') }).count();

    expect(rowsWithDelete).toBeGreaterThan(0);
    expect(rowsWithCheckbox).toBe(rowsWithDelete);
});

test('closing the dropdown clears the selection and deleting the open book clears the editor', async ({ page }) => {
    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await expect(page.locator('.luker-bulk-delete-toolbar')).toBeVisible();

    await page.keyboard.press('Escape');
    await openEditorDropdown(page);
    await expect(page.locator('.luker-bulk-delete-toolbar')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await page.locator('#world_editor_select').selectOption({ label: 'reef-conditions' });
    await page.locator('#world_popup_entries_list .world_entry').first()
        .waitFor({ state: 'visible', timeout: 10_000 });

    await openEditorDropdown(page);
    await toggleRow(page, 'reef-conditions');
    await page.locator('.luker-bulk-delete-toolbar__delete').click();
    await acceptTopmostPopup(page);

    await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(0, { timeout: 10_000 });
    await expectEditorLabels(page, {
        contains: ['tide-tables'],
        excludes: ['reef-conditions'],
    });

    await page.locator('.prompt-manager-toggle-undo-button').last().click();
    await expectEditorLabels(page, { contains: BOOKS });
});

test('a book whose contents cannot be read is not deleted', async ({ page }) => {
    const brokenName = 'broken-charts';
    writeWorldBook({ dataRoot: server.dataRoot, name: brokenName, entries: BRYN_ENTRIES });
    writeFileSync(
        resolve(server.dataRoot, 'default-user/worlds', `${brokenName}.json`),
        '{ this file is not valid json',
    );

    await awaitMainUI(page, server.baseURL);
    await openEditorDropdown(page);

    const labels = await editorOptionLabels(page);
    expect(labels).toContain(brokenName);

    await toggleRow(page, brokenName);
    await toggleRow(page, 'tide-tables');

    await page.locator('.luker-bulk-delete-toolbar__delete').click();
    await acceptTopmostPopup(page);

    // A book with no readable contents has nothing to restore from, so the
    // undo could never bring it back. It must be left on disk and reported,
    // not deleted behind an undo that silently cannot restore it.
    await expectEditorLabels(page, { excludes: ['tide-tables'], contains: [brokenName] });
});
