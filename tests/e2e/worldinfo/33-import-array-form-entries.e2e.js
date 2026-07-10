// #33 — WI import must accept array-form `entries`
//
// Some legacy authors / merge tools serialize a world book with
// `entries` as an *array* of entry objects (uid stored inline on each
// entry) rather than the documented `{ "<uid>": {...} }` object shape.
// Upstream SillyTavern's /api/worldinfo/import only checks `'entries'
// in worldContent`, so array-form imports round-trip and the frontend
// renders them fine. Luker's import endpoint added a stricter check
// (`!Array.isArray(worldContent.entries)`) that rejects these files
// with HTTP 400 — user surface: "Failed to import world info: Bad
// Request" toast, book never appears in the dropdown.
//
// b48ae81c1 already ships `normalizeWorldInfoFile` on the /get and
// /get-batch paths (books that reached disk via other channels get
// repaired on read). The /import route needs the same coercion so the
// UI import path is at least as permissive as the on-disk path and as
// upstream ST.
//
// This test drops an array-form JSON via the real
// #world_import_button → #world_import_file gesture and asserts the
// book shows up in #world_editor_select with its entries rendered.

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const BOOK_NAME = 'array-entries-fixture';
const FIXTURE_PATH = resolve('/tmp', `${BOOK_NAME}.json`);

/**
 * Synthesize a world book whose `entries` is an ARRAY of entry
 * objects (each carrying its own `uid` inline), matching the shape
 * we see from field-collected books such as the user's
 * "幻想-重西方..." pack. Kept small and deterministic so the test
 * doesn't depend on a 500KB fixture on disk.
 */
function buildArrayFormBook() {
    const mkEntry = (uid, comment, content, extras = {}) => ({
        uid,
        key: [`kw-${uid}`],
        keysecondary: [],
        comment,
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100 + uid,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: null,
        sticky: null,
        cooldown: null,
        delay: null,
        displayIndex: uid,
        ...extras,
    });
    return {
        entries: [
            mkEntry(0, 'first-entry', 'Content of the first entry — array-form serialization.'),
            mkEntry(1, 'second-entry', 'Content of the second entry.'),
            mkEntry(2, 'third-entry', 'Content of the third entry with different order.', { order: 500 }),
        ],
        extensions: {
            merge_manifest: 'array-form fixture for #33',
        },
    };
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startWorldInfoServer({
        specBaseName: '33-import-array-form-entries',
        scenarioId: 'array-form',
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Write the array-form fixture to /tmp so setInputFiles can upload
    // it. The filename (sans extension) is what /api/worldinfo/import
    // uses as the book name.
    writeFileSync(FIXTURE_PATH, JSON.stringify(buildArrayFormBook()), 'utf8');
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

test.describe('#33 — WI import tolerates array-form entries', () => {
    test('array-form JSON imports via the real toolbar and entries render', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Diagnostic: capture the /api/worldinfo/import response so
        // parallel-run flakes surface the actual server outcome instead
        // of the empty-toast red herring.
        const importResponses = [];
        page.on('response', async (res) => {
            if (res.url().includes('/api/worldinfo/import')) {
                importResponses.push({
                    status: res.status(),
                    body: await res.text().catch(() => '<unreadable>'),
                });
            }
        });

        // Real import via the toolbar. `_lib/ui-worldinfo.js`'s helper
        // clicks #world_import_button and setInputFiles in the same
        // microtask, which race-loses on cold-start parallel runs (the
        // click's `$('#world_import_file').trigger('click')` handler
        // hasn't attached yet, so the change event never fires and the
        // server sees zero /api/worldinfo/import hits). Open the drawer
        // and wait for the file input to be attached to the DOM AND
        // for its jQuery `change` handler to be bound (world-info.js's
        // init runs the `$('#world_import_file').on('change', …)` call
        // async, and setInputFiles fires natively before the binding
        // lands on cold-start parallel runs) before driving
        // setInputFiles directly — setInputFiles fires the native
        // change event without needing the button click.
        await openWorldInfoDrawer(page);
        const importInput = page.locator('#world_import_file');
        await importInput.waitFor({ state: 'attached', timeout: 10_000 });
        await page.waitForFunction(() => {
            const jq = window.jQuery || window.$;
            if (!jq) return false;
            const el = jq('#world_import_file')[0];
            if (!el) return false;
            const events = jq._data ? jq._data(el, 'events') : null;
            return !!events && Array.isArray(events.change) && events.change.length > 0;
        }, null, { timeout: 15_000 });

        const importResponsePromise = page.waitForResponse(
            (res) => res.url().includes('/api/worldinfo/import'),
            { timeout: 20_000 },
        );
        await importInput.setInputFiles(FIXTURE_PATH);

        try {
            const res = await importResponsePromise;
            expect(res.status(), `import POST returned ${res.status()}`).toBe(200);
        } catch (err) {
            throw new Error(`import POST never observed — importResponses=${JSON.stringify(importResponses)} — ${err.message}`);
        }

        try {
            await page.waitForFunction((wanted) => {
                const sel = document.querySelector('#world_editor_select');
                if (!sel) return false;
                return Array.from(sel.options).some(o => String(o.textContent || '').trim() === wanted);
            }, BOOK_NAME, { timeout: 20_000 });
        } catch (err) {
            const diag = await page.evaluate(() => ({
                dropdownOptions: Array.from(document.querySelectorAll('#world_editor_select option'))
                    .map(o => String(o.textContent || '').trim()),
                toastErrors: Array.from(document.querySelectorAll('.toast-error, .toast-warning'))
                    .map(t => t.textContent?.trim()),
            }));
            throw new Error(`book "${BOOK_NAME}" never appeared in dropdown — importResponses=${JSON.stringify(importResponses)} — dom=${JSON.stringify(diag)} — ${err.message}`);
        }

        // Select the imported book and confirm the entries actually
        // rendered (not just that the name appeared in the dropdown).
        await page.evaluate((wanted) => {
            const jq = window.jQuery || window.$;
            const select = document.querySelector('#world_editor_select');
            const option = Array.from(select.options).find(
                o => String(o.textContent || '').trim() === wanted,
            );
            if (!option) throw new Error(`option "${wanted}" missing after import`);
            jq('#world_editor_select').val(option.value).trigger('change');
        }, BOOK_NAME);

        await page.locator('#world_popup_entries_list .world_entry').first()
            .waitFor({ state: 'visible', timeout: 10_000 });

        const renderedComments = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'))
                .map(r => r.querySelector('input[name="comment"], textarea[name="comment"]')?.value || '')
                .sort(),
        );
        expect(renderedComments).toEqual(['first-entry', 'second-entry', 'third-entry']);
    });
});
