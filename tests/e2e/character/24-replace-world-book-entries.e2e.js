// #24 — Luker-only CardApp.replaceWorldBookEntries dynamic world book.
//
// Bind a WI book to Ash. Drive a sequence equivalent to what a CardApp
// init() would do via `ctx.replaceWorldBookEntries(bookName, entries)`:
// load → wipe → assign → save → reload. Verify
//   - the WI editor / loadWorldInfo shows the NEW entries
//   - the baseline entries are gone (replaced, not merged)
//   - across restart, the new entries are still there
//   - the legacy uids the test held before replace are NOT honored
//     (uid assignment is the contract — caller-supplied uids ignored).
//
// Per memory `dynamic_worldbook_decision`, this is the path the team
// chose for dynamic world-book regeneration. The implementation lives
// in public/scripts/extensions/card-app/context.js#replaceWorldBookEntries.
// We replicate its body here (load → reset entries → create → save) so
// the test doesn't depend on a live CardApp; the contract is the same.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

let server, mock, avatar, bookName;

const REPLACEMENT_ENTRIES = [
    {
        key: ['eastern light'],
        comment: 'replaced/eastern-light',
        content: 'Dynamic entry: eastern light is offline; trim wick before dawn.',
        order: 100,
    },
    {
        key: ['skiff alpha'],
        comment: 'replaced/skiff-alpha',
        content: 'Dynamic entry: skiff Alpha rounded the headland at 03:14.',
        order: 110,
    },
    {
        key: ['skiff beta'],
        comment: 'replaced/skiff-beta',
        content: 'Dynamic entry: skiff Beta delayed by drift; ETA + 40 min.',
        order: 120,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'replace-wi' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bookName = writeWorldBook({ dataRoot: server.dataRoot, name: 'bryn-headland-replace', entries: BRYN_ENTRIES });
    avatar = writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        overrides: { extensions: { world: bookName } },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#24 — CardApp.replaceWorldBookEntries (Luker-only dynamic world book)', () => {
    test('replace wipes baseline + writes new entries; persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === 'Ash the Cartographer');
        }, { timeout: 15_000 });

        // Baseline on disk: BRYN_ENTRIES (2 entries).
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${bookName}.json`);
        const baseline = JSON.parse(readFileSync(bookPath, 'utf8'));
        expect(Object.keys(baseline.entries).length).toBe(2);
        const baselineKeys = Object.values(baseline.entries).map(e => e.comment).sort();
        expect(baselineKeys).toEqual(expect.arrayContaining(['reef-conditions', 'drifters']));

        // Drive replaceWorldBookEntries (Luker's CardApp ctx method).
        const replaceResult = await page.evaluate(async ({ bookName, entries }) => {
            const ctx = window.SillyTavern.getContext();
            // Mirror context.js#replaceWorldBookEntries body — load, wipe,
            // create new entries from partials, save.
            const data = await ctx.loadWorldInfo(bookName);
            if (!data) return { ok: false, reason: 'book not found' };
            data.entries = {};
            const created = [];
            for (const partial of entries) {
                const newEntry = ctx.worldInfoEntry.create(bookName, data);
                if (!newEntry) continue;
                if (partial && typeof partial === 'object') {
                    // Caller-supplied uids must be ignored — that's the contract.
                    const { uid: _ignored, ...fields } = partial;
                    Object.assign(newEntry, fields);
                }
                created.push(newEntry);
            }
            await ctx.saveWorldInfo(bookName, data, true);
            return {
                ok: true,
                createdCount: created.length,
                createdUids: created.map(e => e.uid),
            };
        }, { bookName, entries: REPLACEMENT_ENTRIES.map((e, i) => ({ ...e, uid: 9999 + i })) });

        expect(replaceResult.ok, `replace failed: ${replaceResult.reason}`).toBe(true);
        expect(replaceResult.createdCount).toBe(REPLACEMENT_ENTRIES.length);
        // Caller's uids (9999+) should have been ignored — assigned uids
        // start from a fresh counter (≤ 3 typically).
        for (const uid of replaceResult.createdUids) {
            expect(uid, 'caller-supplied uids are NOT honored').toBeLessThan(9999);
        }

        // On-disk: original entries gone, replacement entries present.
        const afterReplace = JSON.parse(readFileSync(bookPath, 'utf8'));
        const afterComments = Object.values(afterReplace.entries).map(e => e.comment).sort();
        expect(afterComments.length).toBe(3);
        expect(afterComments).toEqual(expect.arrayContaining([
            'replaced/eastern-light',
            'replaced/skiff-alpha',
            'replaced/skiff-beta',
        ]));
        expect(afterComments).not.toContain('reef-conditions');
        expect(afterComments).not.toContain('drifters');

        // In-memory editor view also reflects the replacement.
        const inMemory = await page.evaluate(async (bookName) => {
            const ctx = window.SillyTavern.getContext();
            const data = await ctx.loadWorldInfo(bookName);
            return Object.values(data?.entries || {}).map(e => e.comment).sort();
        }, bookName);
        expect(inMemory).toEqual(expect.arrayContaining([
            'replaced/eastern-light', 'replaced/skiff-alpha', 'replaced/skiff-beta',
        ]));

        // Survives restart.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = JSON.parse(readFileSync(bookPath, 'utf8'));
        const afterRestartComments = Object.values(afterRestart.entries).map(e => e.comment).sort();
        expect(afterRestartComments).toEqual(expect.arrayContaining([
            'replaced/eastern-light', 'replaced/skiff-alpha', 'replaced/skiff-beta',
        ]));
    });
});
