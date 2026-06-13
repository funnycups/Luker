// #30 — WI bulk edit — jest → e2e
//
// The jest unit test `tests/world-info-bulk-edit.test.js` covers the pure
// helpers (inferCommonValue, buildBulkFieldPatchSnapshot,
// applyPatchToEntries, restoreEntriesFromSnapshot). This e2e exercises
// the most load-bearing bulk-edit scenario END-TO-END:
//
//   1. Create a book with multiple entries that differ on a target field
//      (depth: some 4, some 0).
//   2. Apply applyPatchToEntries via the real client module — same function
//      the bulk-edit popup invokes — patching all selected entries to
//      depth: 9 atomically.
//   3. Save via the live saveWorldInfo path (/api/worldinfo/edit).
//   4. Restart the server.
//   5. Reload the book, confirm all entries persist with depth=9.
//
// This matches the unit test's "writes patch fields to all changedUids"
// scenario but routes through the real disk-write code path, locking
// the integration that the jest test can't reach.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
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

async function loadBook(page, name) {
    return page.evaluate(async (n) => {
        const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
        const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: n }) });
        return res.json();
    }, name);
}

async function saveBook(page, name, data) {
    return page.evaluate(async ({ n, d }) => {
        const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
        const res = await fetch('/api/worldinfo/edit', { method: 'POST', headers, body: JSON.stringify({ name: n, data: d }) });
        return res.json();
    }, { n: name, d: data });
}

test.describe('#30 — WI bulk edit lands depth change for all selected entries', () => {
    test('bulk depth patch applied via applyPatchToEntries persists to disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const original = await loadBook(page, BOOK_NAME);
        expect(Object.keys(original.entries).length).toBe(5);

        // Sanity: mixed depths in the original (2 with depth=0, 3 with depth=4)
        const originalDepths = Object.values(original.entries).map(e => e.depth).sort((a, b) => a - b);
        expect(originalDepths).toEqual([0, 0, 4, 4, 4]);

        // Drive the SAME pure helper the bulk-edit popup calls. We import it
        // dynamically from the client module so we exercise the real
        // implementation, not a re-implementation.
        const result = await page.evaluate(async ({ name, entries }) => {
            const mod = await import('/scripts/world-info-bulk-edit.js');
            const allUids = Object.keys(entries);
            const patch = { depth: 9 };
            const { changedUids, snapshot } = mod.buildBulkFieldPatchSnapshot(entries, allUids, patch);
            mod.applyPatchToEntries(entries, changedUids, patch);
            return {
                changedUids,
                snapshot,
                entries,
            };
        }, { name: BOOK_NAME, entries: original.entries });

        // The snapshot is what the toast undo path would use to revert;
        // ensure it captured the original values for entries that did change.
        expect(result.changedUids.length).toBe(5); // all 5 differ from depth=9
        const snapshotByUid = Object.fromEntries(result.snapshot.map(s => [s.uid, s.oldValues]));
        // The two depth-0 and three depth-4 entries all changed.
        const oldDepths = Object.values(snapshotByUid).map(v => v.depth).sort((a, b) => a - b);
        expect(oldDepths).toEqual([0, 0, 4, 4, 4]);

        // Save through the real edit endpoint (saveWorldInfo wraps this).
        const saved = await saveBook(page, BOOK_NAME, { entries: result.entries });
        expect(saved).toEqual({ ok: true });

        // Re-load and confirm the on-disk state has depth=9 across the board.
        const afterSave = await loadBook(page, BOOK_NAME);
        for (const entry of Object.values(afterSave.entries)) {
            expect(entry.depth, `entry uid=${entry.uid} (${entry.comment}) should have depth=9`).toBe(9);
        }
    });

    test('bulk edit survives a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        const reloaded = await loadBook(page, BOOK_NAME);
        expect(Object.keys(reloaded.entries).length).toBe(5);
        for (const entry of Object.values(reloaded.entries)) {
            expect(entry.depth).toBe(9);
        }
        // Make sure no other fields drifted in the round trip
        const comments = Object.values(reloaded.entries).map(e => e.comment).sort();
        expect(comments).toEqual([
            'coastal-route',
            'estuary-crossing',
            'fenland-ford',
            'mountain-pass',
            'ridgeline-trail',
        ]);
    });
});
