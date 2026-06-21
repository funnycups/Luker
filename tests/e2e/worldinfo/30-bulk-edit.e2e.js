// #30 — WI bulk edit via the real toolbar
//
// Drive the entire bulk-edit flow through actual DOM gestures — the
// jest unit tests cover the pure helpers (inferCommonValue,
// buildBulkFieldPatchSnapshot, applyPatchToEntries,
// restoreEntriesFromSnapshot). This e2e exercises the user-visible
// chain:
//   1. Open the WI editor on a book with 5 mixed-depth entries.
//   2. Click .world_entry_select on each entry (real checkbox click);
//      the toolbar's #world_entries_select_page button is the canonical
//      "select all on page" gesture so we use it for parity.
//   3. Click #world_entries_bulk_set_field → the menu builds in the
//      DOM as #world_bulk_set_field_menu with one .world_bulk_field_menu_item
//      per BULK_EDITABLE_FIELDS entry. Click the "Injection Depth" leaf.
//   4. The Popup opens with a number input; fill 9 + click "Apply".
//   5. Read entries from disk after the popup closes — all 5 depths
//      should now be 9, and the change must survive a server restart.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const BULK_ENTRIES = [
    { key: ['mountain'], comment: 'mountain-pass', content: 'The northern pass is closed from first snow until thaw.', depth: 4, order: 100 },
    { key: ['coastal'], comment: 'coastal-route', content: 'The coastal route runs fast in summer but freezes the carts in winter.', depth: 4, order: 110 },
    { key: ['fenland'], comment: 'fenland-ford', content: 'Fenland ford is impassable after three days of rain.', depth: 0, order: 120 },
    { key: ['ridgeline'], comment: 'ridgeline-trail', content: 'Ridgeline trail offers the longest view but exposes travelers to the wind.', depth: 4, order: 130 },
    { key: ['estuary'], comment: 'estuary-crossing', content: 'The estuary can only be forded two hours either side of low tide.', depth: 0, order: 140 },
];

const BOOK_NAME = 'bulk-edit-routes';

async function openBookInEditor(page, bookName) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_editor_select').waitFor({ state: 'visible', timeout: 5000 });
    // Wait for world_names to be populated — without this, the change
    // handler may run before the editor wiring is fully bound, leaving
    // the entries list empty on the first try.
    await page.waitForFunction((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return false;
        return Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
    }, bookName, { timeout: 15_000 });
    const optionValue = await page.evaluate((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return null;
        for (const option of Array.from(select.options)) {
            if (String(option.textContent || '').trim() === wanted) return option.value;
        }
        return null;
    }, bookName);
    if (!optionValue) throw new Error(`no editor-dropdown option matches "${bookName}"`);
    // Try the change up to 3 times — the editor's render is async and
    // can race against the page's initial bootstrap when the test
    // worker is under load.
    let rendered = false;
    for (let attempt = 0; attempt < 3 && !rendered; attempt++) {
        await page.evaluate((value) => {
            const jq = window.jQuery || window.$;
            if (!jq) throw new Error('jQuery missing');
            jq('#world_editor_select').val(value).trigger('change');
        }, optionValue);
        try {
            await page.locator('#world_popup_entries_list .world_entry').first().waitFor({ state: 'visible', timeout: 6_000 });
            rendered = true;
        } catch { /* retry */ }
    }
    if (!rendered) {
        throw new Error(`book "${bookName}" entries did not render after 3 retries`);
    }
}

/**
 * Read the on-disk shape of a book directly from the test data root.
 * The bulk edit goes through saveWorldInfo → repo.save → fs write, so
 * inspecting the file gives us the load-bearing "did the change land"
 * assertion (the editor's in-memory state isn't sufficient — the user
 * cares about persistence).
 */
function readBookFromDisk(dataRoot, bookName, handle = 'default-user') {
    const path = resolve(dataRoot, handle, 'worlds', `${bookName}.json`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startWorldInfoServer({ specBaseName: '30-bulk-edit', scenarioId: 'bulk-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeWorldBook({ dataRoot: server.dataRoot, name: BOOK_NAME, entries: BULK_ENTRIES });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

test.describe('#30 — WI bulk edit via the real toolbar', () => {
    test('bulk-select + Injection Depth = 9 lands on disk for every entry', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openBookInEditor(page, BOOK_NAME);

        // Pre-condition: the book has 5 entries with mixed depths.
        const original = readBookFromDisk(server.dataRoot, BOOK_NAME);
        expect(Object.keys(original.entries).length).toBe(5);
        const originalDepths = Object.values(original.entries).map(e => e.depth).sort((a, b) => a - b);
        expect(originalDepths).toEqual([0, 0, 4, 4, 4]);

        // 1. Select all entries on the current page via the real
        //    "Select Page" toolbar button. This drives the same path the
        //    user clicks — toggles every visible .world_entry_select
        //    checkbox at once.
        const selectPageBtn = page.locator('#world_entries_select_page');
        await selectPageBtn.waitFor({ state: 'visible', timeout: 5000 });
        await selectPageBtn.click();
        // Wait for the bulk status text to show "5 entries selected".
        await page.waitForFunction(() => {
            const status = document.querySelector('#world_entry_bulk_status');
            return status && /5/.test(String(status.textContent || ''));
        }, { timeout: 5000 });

        // 2. Click the bulk-edit button. The dynamic menu mounts on
        //    document.body as #world_bulk_set_field_menu.
        const bulkBtn = page.locator('#world_entries_bulk_set_field');
        await bulkBtn.waitFor({ state: 'visible', timeout: 5000 });
        await bulkBtn.click();
        const menu = page.locator('#world_bulk_set_field_menu');
        await menu.waitFor({ state: 'visible', timeout: 5000 });

        // 3. Click the "Injection Depth" leaf in the menu (depth is in
        //    the top group, so it appears as a direct child item).
        const depthLeaf = menu.locator('.world_bulk_field_menu_item', { hasText: 'Injection Depth' }).first();
        await depthLeaf.waitFor({ state: 'visible', timeout: 5000 });
        await depthLeaf.click();

        // 4. The Popup opens with a number input. Fill 9 and click Apply.
        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        const numberInput = popup.locator('input[type="number"]').first();
        await numberInput.waitFor({ state: 'visible', timeout: 5000 });
        await numberInput.fill('9');
        // The Apply button is rendered as a custom button — match by visible text.
        const applyBtn = popup.locator('.popup-button-custom', { hasText: /Apply/i }).first();
        await applyBtn.waitFor({ state: 'visible', timeout: 5000 });
        await applyBtn.click();
        // Wait for the popup to close (save → toast → close).
        await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});

        // 5. Read the book from disk; every entry should have depth=9.
        // Give the autosave a moment to flush before reading.
        await page.waitForFunction(() => {
            const status = document.querySelector('#world_entry_bulk_status');
            // Status changes once the save completes. Even if we miss
            // the specific text, the data on disk is the load-bearing
            // assertion below.
            return status !== null;
        }, { timeout: 5000 });
        // Brief settle for the disk write.
        await page.waitForTimeout(500);

        const afterSave = readBookFromDisk(server.dataRoot, BOOK_NAME);
        const newDepths = Object.values(afterSave.entries).map(e => e.depth).sort((a, b) => a - b);
        expect(newDepths, 'bulk edit should set depth=9 on every entry').toEqual([9, 9, 9, 9, 9]);

        // The other fields shouldn't drift — verify a few load-bearing
        // ones round-trip.
        const comments = Object.values(afterSave.entries).map(e => e.comment).sort();
        expect(comments).toEqual([
            'coastal-route',
            'estuary-crossing',
            'fenland-ford',
            'mountain-pass',
            'ridgeline-trail',
        ]);
    });

    test('bulk edit survives a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        const reloaded = readBookFromDisk(server.dataRoot, BOOK_NAME);
        expect(Object.keys(reloaded.entries).length).toBe(5);
        for (const entry of Object.values(reloaded.entries)) {
            expect(entry.depth).toBe(9);
        }
    });
});
