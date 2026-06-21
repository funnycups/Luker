// #112 — WI editor opens populated for a trailing-space book name
// (memory: known_bug_worldinfo_cache_key_trim, fixed 2026-06-07)
//
// Bug shape: importing a v2/v3 character card whose
// `data.character_book.name` or `data.extensions.world` ended in
// whitespace put the editor in a broken state — the import wrote real
// entries under the RAW name ("X "), the get-batch preload cached an
// empty dummy under the TRIMMED name ("X"), and the editor read via
// `world_names[idx]` (trimmed) → cache hit on the stale empty dummy →
// editor opened empty until manual refresh.
//
// Fix: `cacheWorldInfoData`, `saveWorldInfo` eager-set, and the `wiUids`
// slash-command lookup all now `String(name || '').trim()` their cache
// keys.
//
// REAL USER FLOW: plant a world book on disk whose name ends in a
// trailing space. Open the WI drawer, select the book from the editor
// dropdown, expand the entries, assert the entry CONTENT (not just the
// row count) is non-empty. Pre-fix the editor would show empty entry
// rows on first open (cache poisoning); only a manual reselect fixed it.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer, selectWorldBook, getRenderedWorldEntries } from '../_lib/ui-worldinfo.js';

let server;

const BOOK_NAME_WITH_TRAILING_SPACE = 'regression-112-trailing-space ';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '112-wi-cache-key-trim', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });

    writeWorldBook({
        dataRoot: server.dataRoot,
        name: BOOK_NAME_WITH_TRAILING_SPACE,
        entries: BRYN_ENTRIES,
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#112 — WI editor opens populated for a trailing-space book name', () => {
    test('selecting the book from the dropdown surfaces entries on first open (no stale-dummy cache hit)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await openWorldInfoDrawer(page);
        const sel = page.locator('#world_editor_select');
        await sel.waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForFunction((wanted) => {
            const s = document.querySelector('#world_editor_select');
            if (!s) return false;
            return Array.from(s.options).some(o => o.textContent === wanted);
        }, BOOK_NAME_WITH_TRAILING_SPACE, { timeout: 15_000 }).catch(() => {});

        // Dropdown text may be trimmed by server-side persister or kept raw;
        // tolerate both. We click whichever option matches when stripped.
        const labels = await page.locator('#world_editor_select option')
            .evaluateAll(opts => opts.map(o => o.textContent || ''));
        const target = labels.find(l => l.trim() === BOOK_NAME_WITH_TRAILING_SPACE.trim());
        expect(target,
            `dropdown must list the trailing-space book (or trimmed-on-server variant); options=${JSON.stringify(labels)}`,
        ).toBeTruthy();

        await selectWorldBook(page, target);

        // Entries should render on first open.
        await expect.poll(async () => {
            const rows = await getRenderedWorldEntries(page);
            return rows.length;
        }, {
            message: 'WI editor must render entries on first open for a trailing-space book name; ' +
                'if the worldInfoCache key trim regresses, the editor shows zero rows until manual reselect',
            timeout: 10_000,
        }).toBeGreaterThanOrEqual(BRYN_ENTRIES.length);

        // Expand all entry inline-drawers so the content textareas
        // populate (entries are collapsed by default; the body
        // textarea is mounted lazily on toggle).
        await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.world_entry'));
            for (const row of rows) {
                const header = row.querySelector('.inline-drawer-header, .inline-drawer-toggle');
                const icon = row.querySelector('.inline-drawer-icon');
                if (icon && icon.classList.contains('down') && header) {
                    header.click();
                }
            }
        });
        await page.waitForTimeout(800);

        // Build a robust blob from every text/textarea descendant of
        // `.world_entry` — pre-fix, rows existed but were stub-empty
        // (cache-poisoning bug).
        const fullEntryText = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.world_entry'));
            return rows.map(r => {
                const tas = Array.from(r.querySelectorAll('textarea, input[type="text"]'))
                    .map(el => (el.value || '').trim())
                    .filter(Boolean);
                return tas.join('\n');
            }).join('\n');
        });
        expect(fullEntryText,
            'rendered entries should contain BRYN_ENTRIES content — e.g. the reef-conditions blurb. ' +
            'Pre-fix the entries would exist as collapsed rows but their content would be empty (cache poisoning by the trimmed-key dummy)',
        ).toContain('reef');
    });
});
