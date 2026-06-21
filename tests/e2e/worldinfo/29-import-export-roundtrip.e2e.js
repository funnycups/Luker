// #29 — WI import / export round-trip via the real editor controls
//
// Drive the real toolbar buttons end-to-end:
//   1. Seed an initial book on disk with 5 distinct entries.
//   2. Open the WI drawer, select the book, click #world_popup_export
//      and capture the download — that's the exact bytes the user gets.
//   3. Click #world_popup_delete and confirm the popup. List the
//      dropdown to confirm the book is gone.
//   4. Drop the downloaded JSON onto the page via the import button +
//      hidden file input (#world_import_button → #world_import_file
//      setInputFiles). The newly-imported book reappears in the
//      dropdown.
//   5. Open it; the rendered entries match the original comments.
//   6. Restart the server. Re-open the editor; entries still match.
//
// All four primitives (import / export / delete / select-by-label)
// route through tests/e2e/_lib/ui-worldinfo.js, which clicks the
// real toolbar icons (no raw fetch, no internal helper imports).

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openWorldInfoDrawer,
    exportSelectedWorldBook,
    deleteSelectedWorldBook,
    importWorldBook,
} from '../_lib/ui-worldinfo.js';
import { startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const FIVE_ENTRIES = [
    {
        key: ['cliff-path', 'cliff'],
        comment: 'cliff-path-entry',
        content: 'The cliff path from Bryn town to the lighthouse follows the old goat trail; sheer drop on the seaward side, loose shale underfoot.',
        order: 100,
    },
    {
        key: ['gull rocks'],
        comment: 'gull-rocks-entry',
        content: 'The gull rocks emerge two hours either side of low tide. Locals time their crab harvest by them.',
        order: 110,
    },
    {
        key: ['lantern oil', 'oil'],
        keysecondary: ['lighthouse'],
        comment: 'lantern-oil-entry',
        content: 'Lantern oil for the Bryn lighthouse comes in 5-gallon casks from the inland refinery; supply lasts roughly six weeks.',
        selectiveLogic: 3, // AND_ALL
        order: 120,
    },
    {
        key: [],
        comment: 'always-on-keeper',
        content: 'The keeper of the Bryn lighthouse has held the post for eleven years; her predecessors all died at sea or on the cliff path.',
        constant: true,
        order: 130,
    },
    {
        key: ['storm-watch'],
        comment: 'storm-watch-entry',
        content: 'During storm watches, the harbor bell rings three times at the start of each hour. Failure to ring means the bellringer has been swept off the platform.',
        order: 140,
        depth: 8,
        preventRecursion: true,
    },
];

const BOOK_NAME = 'bryn-export-source';

/**
 * Drive #world_editor_select to the supplied book name. select2 wraps
 * the native select; we trigger via the canonical jQuery val+change
 * channel (same path the user's pointer click ultimately fires).
 */
async function openBookInEditor(page, bookName) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_editor_select').waitFor({ state: 'visible', timeout: 5000 });
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
    if (!rendered) throw new Error(`book "${bookName}" entries did not render after 3 retries`);
}

async function readEditorComments(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
        return rows.map(r => r.querySelector('input[name="comment"], textarea[name="comment"]')?.value || '');
    });
}

async function listDropdownLabels(page) {
    return page.evaluate(() => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return [];
        return Array.from(select.options).map(o => String(o.textContent || '').trim()).filter(Boolean);
    });
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startWorldInfoServer({ specBaseName: '29-import-export-roundtrip', scenarioId: 'export-roundtrip' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeWorldBook({ dataRoot: server.dataRoot, name: BOOK_NAME, entries: FIVE_ENTRIES });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

test.describe('#29 — WI import/export round-trip via real toolbar', () => {
    test('export → delete → re-import via real UI gestures yields the same entries', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Open the book in the editor and verify the seed shape.
        await openBookInEditor(page, BOOK_NAME);
        const originalComments = (await readEditorComments(page)).sort();
        expect(originalComments).toEqual([
            'always-on-keeper',
            'cliff-path-entry',
            'gull-rocks-entry',
            'lantern-oil-entry',
            'storm-watch-entry',
        ]);

        // 2. Real export: click #world_popup_export, wait for the download
        //    event, save the bytes to /tmp for re-upload. The download's
        //    suggested filename is `<bookName>.json` — preserve that so
        //    re-import lands the entries under the same book name (the
        //    server's `worldName = path.parse(file.name).name`).
        const download = await exportSelectedWorldBook(page);
        const exportedPath = resolve('/tmp', `${BOOK_NAME}.json`);
        await download.saveAs(exportedPath);
        expect(existsSync(exportedPath), 'expected the export download to land on disk').toBe(true);
        const exportedJson = JSON.parse(readFileSync(exportedPath, 'utf8'));
        const exportedComments = Object.values(exportedJson.entries || {}).map(e => e.comment).sort();
        expect(exportedComments).toEqual(originalComments);

        // 3. Real delete: click #world_popup_delete + popup OK. Wait
        //    for the dropdown to drop the book before re-importing so
        //    the overwrite-confirm popup doesn't fire on import.
        await deleteSelectedWorldBook(page);
        await page.waitForFunction((wanted) => {
            const select = document.querySelector('#world_editor_select');
            if (!select) return false;
            return !Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
        }, BOOK_NAME, { timeout: 15_000 });
        const afterDeleteLabels = await listDropdownLabels(page);
        expect(afterDeleteLabels).not.toContain(BOOK_NAME);

        // 4. Real re-import: set the file input to the exported bytes
        //    via the hidden #world_import_file. Wait for the dropdown
        //    to repopulate with the imported name.
        try {
            await importWorldBook(page, { filePath: exportedPath, expectedName: BOOK_NAME, timeoutMs: 45_000 });
        } catch (err) {
            await page.screenshot({ path: `/tmp/wi-29-import-${Date.now()}.png`, fullPage: true });
            const diag = await page.evaluate(() => ({
                fileInput: !!document.querySelector('#world_import_file'),
                fileInputClass: document.querySelector('#world_import_file')?.className || '',
                dropdownOptions: Array.from(document.querySelectorAll('#world_editor_select option')).map(o => String(o.textContent || '').trim()),
                toastErrors: Array.from(document.querySelectorAll('.toast-error, .toast-warning')).map(t => t.textContent?.trim()),
                visiblePopups: Array.from(document.querySelectorAll('.popup:visible, .popup.shown')).map(p => p.textContent?.slice(0, 100)),
            }));
            throw new Error(`import failed: ${JSON.stringify(diag)} — ${err.message}`);
        }
        const afterImportLabels = await listDropdownLabels(page);
        expect(afterImportLabels).toContain(BOOK_NAME);

        // 5. Open the re-imported book and verify entry comments match.
        await openBookInEditor(page, BOOK_NAME);
        const reimportedComments = (await readEditorComments(page)).sort();
        expect(reimportedComments).toEqual(originalComments);
    });

    test('re-imported book survives a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        await openBookInEditor(page, BOOK_NAME);
        const comments = (await readEditorComments(page)).sort();
        expect(comments).toEqual([
            'always-on-keeper',
            'cliff-path-entry',
            'gull-rocks-entry',
            'lantern-oil-entry',
            'storm-watch-entry',
        ]);
    });
});
