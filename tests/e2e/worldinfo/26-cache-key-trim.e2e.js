// #26 — WorldInfo cache key trim regression (fixed 2026-06-07)
//
// Bug history (memory: known_bug_worldinfo_cache_key_trim):
//   Before the fix, client-side worldInfoCache writes used the raw book
//   name while reads trimmed. Importing a book whose filename ended in
//   trailing whitespace made the editor show an empty entry list until
//   the user manually refreshed (cache miss on the trimmed key but hit
//   on the raw key). The fix: trim names on both write and read paths
//   so the keys agree.
//
// Real-user regression lock:
//   1. Drop a book file with a literal trailing space in the filename
//      onto disk before the server starts (mirrors a previously-imported
//      book from before the fix).
//   2. Open the World Info drawer through real DOM gestures
//      (#WIDrawerIcon) and select the book from the editor dropdown
//      (#world_editor_select). Selecting it must populate the rendered
//      entry rows without a manual refresh — the symptom the
//      cache-key-trim fix locks down.
//   3. Restart the server. Repeat the open + select gesture. Entries
//      must render again on the first visit — both the cache key trim
//      AND the server-side filename resolver have to agree on the
//      trimmed name.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

/**
 * Read entry rows under #world_popup_entries_list — the live editor's
 * actual entry container. The shared `getRenderedWorldEntries` helper
 * queries `.world_entry` globally, which also matches the hidden
 * `entry_edit_template` row; this scoped read filters it out.
 *
 * The key/content inputs are lazily mounted inside each entry's
 * collapsed inline-drawer body, so they aren't present until the user
 * expands the entry. The comment textarea sits in the header and is
 * always populated — load-bearing enough for this regression.
 */
async function readEditorEntries(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
        return rows.map(r => {
            const commentEl = r.querySelector('input[name="comment"], textarea[name="comment"]');
            const uid = r.getAttribute('uid') || r.dataset?.uid || '';
            return {
                uid: String(uid),
                comment: commentEl?.value || '',
            };
        });
    });
}

test.describe.configure({ mode: 'serial' });

let server, mock;

const BOOK_FILE_NAME = 'trailing-test .json';
const BOOK_DISPLAY_NAME = 'trailing-test'; // trimmed form

const ENTRIES_PAYLOAD = {
    entries: {
        '0': {
            uid: 0,
            key: ['lighthouse'],
            keysecondary: [],
            comment: 'trailing-cache-regression-entry-1',
            content: 'The lighthouse keepers of Bryn rotate their watch on the half-hour.',
            constant: false,
            selective: true,
            order: 100,
            position: 0,
            disable: false,
            displayIndex: 0,
            addMemo: true,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            probability: 100,
            depth: 4,
            useProbability: true,
            role: null,
            vectorized: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
        },
        '1': {
            uid: 1,
            key: ['skiff'],
            keysecondary: [],
            comment: 'trailing-cache-regression-entry-2',
            content: 'Each drifter skiff is named after a daughter of the family it carries.',
            constant: false,
            selective: true,
            order: 110,
            position: 0,
            disable: false,
            displayIndex: 1,
            addMemo: true,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            probability: 100,
            depth: 4,
            useProbability: true,
            role: null,
            vectorized: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
        },
    },
};

function writeBookWithTrailingSpaceFilename(dataRoot) {
    const dir = resolve(dataRoot, 'default-user', 'worlds');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, BOOK_FILE_NAME), JSON.stringify(ENTRIES_PAYLOAD, null, 4));
}

/**
 * Drive the editor dropdown to the supplied book name. The dropdown is
 * wrapped by select2 (initActionableSingleSelect), so Playwright's
 * `selectOption` can be silently swallowed by the select2 shim — set
 * `val()` + `trigger('change')` via the same jQuery channel the bound
 * `$('#world_editor_select').on('change')` handler listens to, exactly
 * as a real-user click on a dropdown item ultimately does.
 *
 * Match against the trimmed text of each option so the test stays
 * robust whether the listing endpoint preserves or sanitizes the
 * trailing space in the displayed label.
 */
async function selectBookByTrimmedLabel(page, wantedTrimmed) {
    await openWorldInfoDrawer(page);
    const sel = page.locator('#world_editor_select');
    await sel.waitFor({ state: 'visible', timeout: 5000 });
    // Wait for the dropdown to actually have our book as an option —
    // world_names is populated async, and the editor's change handler
    // is bound during that same init sequence.
    await page.waitForFunction((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return false;
        return Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
    }, wantedTrimmed, { timeout: 15_000 });
    const optionValue = await page.evaluate((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return null;
        for (const option of Array.from(select.options)) {
            if (String(option.textContent || '').trim() === wanted) return option.value;
        }
        return null;
    }, wantedTrimmed);
    if (!optionValue) {
        throw new Error(`no editor-dropdown option trims to "${wantedTrimmed}"`);
    }
    // Try the change up to 3 times — the editor's render can race
    // against the page's initial bootstrap when the worker is loaded.
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
        throw new Error(`book "${wantedTrimmed}" entries did not render after 3 retries`);
    }
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startWorldInfoServer({ specBaseName: '26-cache-key-trim', scenarioId: 'cache-trim-regression' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeBookWithTrailingSpaceFilename(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

test.describe('#26 — WorldInfo cache key trim regression', () => {
    test('book with trailing-space filename renders entries on first open of the editor', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Real-user gesture: open the WI drawer, then pick the book
        // from the dropdown. The cache regression manifested HERE — the
        // change handler routes through worldInfoCache, and the bug
        // made the entry rows stay empty until the user hit refresh.
        await selectBookByTrimmedLabel(page, BOOK_DISPLAY_NAME);

        const entries = await readEditorEntries(page);
        const comments = entries.map(e => e.comment).sort();
        expect(comments, 'editor should render both entries immediately, not after refresh').toEqual([
            'trailing-cache-regression-entry-1',
            'trailing-cache-regression-entry-2',
        ]);
    });

    test('persists across restart with the trimmed cache key', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        // Same real-user gesture again — after restart the cache is
        // cold, so this exercises both the cache write path AND the
        // server-side filename resolver against the trailing-space file.
        await selectBookByTrimmedLabel(page, BOOK_DISPLAY_NAME);

        const entries = await readEditorEntries(page);
        expect(entries.length, 'entries survive restart with the trimmed cache key').toBe(2);
        const comments = entries.map(e => e.comment).sort();
        expect(comments).toEqual([
            'trailing-cache-regression-entry-1',
            'trailing-cache-regression-entry-2',
        ]);
    });
});
