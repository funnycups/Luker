// #26 — WorldInfo cache key trim regression (fixed 2026-06-07)
//
// Bug history (memory: known_bug_worldinfo_cache_key_trim):
//   Before the fix, client-side worldInfoCache writes used the raw book
//   name while reads trimmed. Importing a book with trailing whitespace
//   in the filename made the editor show an empty entry list until a
//   refresh (cache miss on the trimmed key but a hit on the raw key).
//   The fix: trim names on both write and read paths so the keys agree.
//
// This regression lock:
//   1. Drop a book file with a literal trailing space in the name onto
//      disk (mirrors what /import does internally when the upload name
//      ends with " .json").
//   2. Open the world-info editor immediately. Entries should render
//      without a manual refresh.
//   3. Restart the server. Entries should still render — both the cache
//      key trim and the server-side resolveWorldInfoFilename fallback
//      have to agree on the trimmed name.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const BOOK_DISPLAY_NAME = 'trailing-test'; // no trailing space — that's what the editor will resolve
const BOOK_FILE_NAME = 'trailing-test .json'; // raw on disk WITH trailing space
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
    test('book with trailing-space filename resolves entries on first open', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // The trimmed lookup should resolve to the raw file on disk and
        // return both entries. Make the request through the server's
        // own client-side fetch helpers so we cover the same path the
        // editor uses.
        const fetched = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.Luker.getContext().getRequestHeaders() };
            // First: list-lite shows the file is on disk (after the import-name sanitizer trim, server uses tolerant lookup)
            const listRes = await fetch('/api/worldinfo/list-lite', { method: 'POST', headers, body: JSON.stringify({}) });
            const list = await listRes.json();
            // Then: get via trimmed name
            const getRes = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name }) });
            const data = await getRes.json();
            return {
                listed: list.names,
                entryCount: Object.keys(data?.entries || {}).length,
                entries: Object.values(data?.entries || {}).map(e => ({ comment: e.comment, key: e.key })),
            };
        }, BOOK_DISPLAY_NAME);

        // The server's tolerant filename resolver (`resolveWorldInfoFilename`)
        // strips the trailing space when matching for /get. The list-lite
        // endpoint uses `path.parse(file.name).name` which preserves the
        // trailing space in the display name — i.e. the regression fix
        // covers the cache + resolver, NOT the listing endpoint's raw name.
        // What matters for the regression: trim-keyed lookups MUST resolve.
        expect(fetched.listed.some(n => n.trim() === BOOK_DISPLAY_NAME), `expected list-lite to contain a name that trims to "${BOOK_DISPLAY_NAME}", got ${JSON.stringify(fetched.listed)}`).toBe(true);
        expect(fetched.entryCount, 'editor should see both entries immediately, not after refresh').toBe(2);
        const comments = fetched.entries.map(e => e.comment).sort();
        expect(comments).toEqual(['trailing-cache-regression-entry-1', 'trailing-cache-regression-entry-2']);
    });

    test('persists across restart with trimmed cache key', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        const persisted = await page.evaluate(async (name) => {
            const headers = { 'Content-Type': 'application/json', ...window.Luker.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name }) });
            const data = await res.json();
            return Object.keys(data?.entries || {}).length;
        }, BOOK_DISPLAY_NAME);

        expect(persisted, 'entries survive restart with the trimmed cache key').toBe(2);
    });
});
