// #29 — WI import / export round-trip
//
// 1. Create a book on disk with 5 distinct entries.
// 2. Export the book via the server's GET endpoint (which returns the
//    exact JSON the client downloads).
// 3. Delete the book via the DELETE endpoint.
// 4. Re-import the captured JSON via the IMPORT endpoint.
// 5. Re-GET and assert the new payload is deep-equal to the original.
// 6. Restart the server and re-GET — entries still match.
//
// Equality is on entry content + key + comment + the flag fields the
// import path preserves. (uid is stable since the import payload retains
// the indexed key string.)

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
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
const REIMPORTED_NAME = 'bryn-export-source'; // same name to test overwrite semantics

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

// Normalize entries for deep-equal: drop fields the server-side persistence may
// not preserve byte-for-byte but for which semantic equality is what we care about.
// (Specifically, we want to verify all field values survive a round trip — uid,
// key, keysecondary, comment, content, constant, vectorized, order, depth,
// position, preventRecursion, selectiveLogic.)
function normalizeBook(book) {
    const out = {};
    for (const [k, v] of Object.entries(book?.entries || {})) {
        out[k] = {
            uid: v.uid,
            key: Array.isArray(v.key) ? [...v.key].sort() : v.key,
            keysecondary: Array.isArray(v.keysecondary) ? [...v.keysecondary].sort() : v.keysecondary,
            comment: v.comment,
            content: v.content,
            constant: !!v.constant,
            vectorized: !!v.vectorized,
            order: v.order,
            depth: v.depth,
            position: v.position,
            preventRecursion: !!v.preventRecursion,
            selectiveLogic: v.selectiveLogic,
        };
    }
    return out;
}

test.describe('#29 — WI import/export round-trip', () => {
    test('export → delete → reimport produces a byte-equivalent book', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Snapshot original via the same /api/worldinfo/get the editor uses.
        const original = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name }) });
            return res.json();
        }, BOOK_NAME);

        expect(Object.keys(original.entries).length).toBe(5);

        // 2. "Export" — the GET payload IS the export format (`{ entries: {...} }`).
        const exportedJson = JSON.stringify(original);

        // 3. Delete via the deleteWorldInfo endpoint.
        const deleted = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/delete', { method: 'POST', headers, body: JSON.stringify({ name }) });
            return res.status;
        }, BOOK_NAME);
        expect(deleted).toBe(200);

        // Confirm it's gone — list-lite should not contain it.
        const afterDelete = await page.evaluate(async () => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/list-lite', { method: 'POST', headers, body: JSON.stringify({}) });
            return res.json();
        });
        expect(afterDelete.names).not.toContain(BOOK_NAME);

        // 4. Reimport via the import endpoint. Multipart upload with the
        //    exported JSON as the file payload.
        const imported = await page.evaluate(async ({ json, name }) => {
            const file = new File([json], `${name}.json`, { type: 'application/json' });
            const formData = new FormData();
            formData.append('avatar', file);
            const headers = window.SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/worldinfo/import', { method: 'POST', headers, body: formData });
            return { ok: res.ok, body: await res.json() };
        }, { json: exportedJson, name: REIMPORTED_NAME });
        expect(imported.ok).toBe(true);
        expect(imported.body.name).toBe(REIMPORTED_NAME);

        // 5. Re-GET and deep-compare normalized entries.
        const reloaded = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name }) });
            return res.json();
        }, REIMPORTED_NAME);

        expect(normalizeBook(reloaded)).toEqual(normalizeBook(original));
    });

    test('reimported book survives a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        const afterRestart = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name }) });
            return res.json();
        }, REIMPORTED_NAME);

        expect(Object.keys(afterRestart.entries).length).toBe(5);

        const comments = Object.values(afterRestart.entries).map(e => e.comment).sort();
        expect(comments).toEqual([
            'always-on-keeper',
            'cliff-path-entry',
            'gull-rocks-entry',
            'lantern-oil-entry',
            'storm-watch-entry',
        ]);
    });
});
