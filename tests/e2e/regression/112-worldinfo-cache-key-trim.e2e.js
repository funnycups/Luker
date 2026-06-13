// #112 — worldInfoCache key trim (memory: known_bug_worldinfo_cache_key_trim)
//
// Bug shape (fixed 2026-06-07 in `public/scripts/world-info.js`):
// importing a v2/v3 character card whose `data.character_book.name`
// or `data.extensions.world` ended in whitespace put the editor in a
// broken state — the import wrote real entries under the RAW name
// ("X "), the get-batch preload cached an empty dummy under the
// TRIMMED name ("X"), and the editor read via `world_names[idx]`
// (trimmed) → cache hit on the stale empty dummy → editor opened
// empty. Refresh + reselect from the dropdown fixed it.
//
// Fix: `cacheWorldInfoData`, `saveWorldInfo` eager-set, and the
// `wiUids` slash-command lookup all now `String(name || '').trim()`
// their cache keys.
//
// Regression lock: write a world book whose name has a trailing space
// onto disk before boot. Load the page, immediately open the editor
// against that book, and assert: entries are visible right away (no
// refresh needed). If the cache key trim regresses, the editor reads
// the stale dummy and lists zero entries.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

const BOOK_NAME_WITH_TRAILING_SPACE = 'regression-112-trailing-space ';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'wi-cache-key-trim' });
    markOnboarded({ dataRoot: server.dataRoot });

    // Plant a world book whose filename has trailing whitespace. The
    // server's writeWorldInfo persistence keeps the trailing space in the
    // file name + the in-file `name` field; the bug-trigger condition is
    // EXACTLY this whitespace mismatch between raw saves and trimmed reads.
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: BOOK_NAME_WITH_TRAILING_SPACE,
        entries: BRYN_ENTRIES,
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#112 — worldInfoCache key trim survives trailing-space book names', () => {
    test('opening editor immediately after import lists entries (no stale-dummy hit)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Confirm the book is on the server side via the world-info list.
        //    We list via the canonical /api/worldinfo/list and resolve the
        //    name the server actually persists (could be the raw "X " or
        //    a trimmed canonical "X" depending on the server-side persister).
        //    Retry on transient fetch failures (parallel-worker port reuse
        //    can briefly disconnect us from the server during a teardown).
        const onServer = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            async function tryFetch(url, body, attempts = 3) {
                for (let i = 0; i < attempts; i++) {
                    try {
                        const res = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', ...ctx.getRequestHeaders() },
                            body: JSON.stringify(body),
                        });
                        if (res.ok) return await res.json().catch(() => null);
                    } catch { /* transient */ }
                    await new Promise(r => setTimeout(r, 500 * (i + 1)));
                }
                return null;
            }
            const list = await tryFetch('/api/worldinfo/list', {});
            return { list };
        });

        // Find the book — server may persist with trailing space verbatim,
        // or trim. We tolerate both — the bug shape is on the CLIENT side
        // (cache key mismatch). What matters is the editor reads entries
        // when opened by the trimmed name.
        const list = Array.isArray(onServer.list) ? onServer.list : [];
        const listNames = list.map(e => typeof e === 'string' ? e : (e?.name ?? e?.file_id ?? ''));
        const matchingName = listNames.find(n => String(n).trim() === BOOK_NAME_WITH_TRAILING_SPACE.trim());
        expect(matchingName, `book "${BOOK_NAME_WITH_TRAILING_SPACE}" (or trimmed) should be on disk; saw list=${JSON.stringify(listNames)}`).toBeTruthy();

        // 2. Load the book via the loadWorldInfo path that the editor uses,
        //    then read it again — both should yield the same non-empty
        //    entries set. Pre-fix, the first load might cache a dummy under
        //    a different key than the second read uses, so the editor
        //    surfaces empty entries.
        const editorEntries = await page.evaluate(async ({ raw, trimmed }) => {
            // Retry the world-info module import too — it can transiently
            // fail when a parallel-worker test is tearing down a server
            // that briefly shared our port.
            async function importWi(attempts = 3) {
                for (let i = 0; i < attempts; i++) {
                    try {
                        return await import('/scripts/world-info.js');
                    } catch { /* try again */ }
                    await new Promise(r => setTimeout(r, 500 * (i + 1)));
                }
                throw new Error('failed to import /scripts/world-info.js');
            }
            const wiMod = await importWi();
            // Simulate the editor path: load by the trimmed name (what
            // world_names[idx] resolves to in the dropdown) and inspect
            // entries. Pre-fix, this returns an empty {entries:{}} because
            // the get-batch preload poisoned the cache.
            const trimmedLoad = await wiMod.loadWorldInfo(trimmed);
            const rawLoad = await wiMod.loadWorldInfo(raw);
            return {
                trimmedCount: trimmedLoad?.entries ? Object.keys(trimmedLoad.entries).length : 0,
                rawCount: rawLoad?.entries ? Object.keys(rawLoad.entries).length : 0,
            };
        }, { raw: BOOK_NAME_WITH_TRAILING_SPACE, trimmed: BOOK_NAME_WITH_TRAILING_SPACE.trim() });

        // The book has 2 entries (BRYN_ENTRIES). Both raw and trimmed
        // lookups must yield the same non-empty count. Pre-fix, one of
        // them would return zero (cache poisoning by the stale dummy).
        expect(editorEntries.trimmedCount, 'editor (trimmed name) must surface entries').toBeGreaterThan(0);
        expect(editorEntries.rawCount, 'raw-name lookup must also surface entries').toBeGreaterThan(0);
        expect(editorEntries.trimmedCount).toBe(editorEntries.rawCount);
    });
});
