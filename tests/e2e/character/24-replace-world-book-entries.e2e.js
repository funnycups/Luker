// #24 — Luker-only CardApp.replaceWorldBookEntries dynamic world book.
//
// Per memory `dynamic_worldbook_decision`, the team chose
// `ctx.replaceWorldBookEntries` as the supported path for CardApps that
// need to wipe + repopulate a world book in one shot. The function
// lives on the CardApp ctx (public/scripts/extensions/card-app/context.js:916),
// which is BUILT by `buildContext(container, charId, config)` and
// exposed only to CardApps at runtime.
//
// There is no user-facing UI for "regenerate this book from a
// variable"; the API is for the CardApp to call. This test invokes
// `replaceWorldBookEntries` via the CardApp ctx builder + then VERIFIES
// the result by opening the WI editor UI and confirming the rendered
// entries match. That keeps the production code path identical to the
// real CardApp call site while still exercising the WI editor UI as
// the load-bearing DOM-side assertion.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, closeRightNavDrawer } from '../_lib/page.js';
import { openWorldInfoDrawer, selectWorldBook, getRenderedWorldEntries } from '../_lib/ui-worldinfo.js';

let server, mock, avatar, bookName;

const ASH_NAME = 'Ash the Cartographer';
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
    disableTagImportPopup({ dataRoot: server.dataRoot });
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
    test('replace wipes baseline + writes new entries; new entries surface in the WI editor; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Select Ash so the CardApp ctx has a valid charId.
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);

        // Baseline on disk: BRYN_ENTRIES (2 entries).
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${bookName}.json`);
        const baseline = JSON.parse(readFileSync(bookPath, 'utf8'));
        expect(Object.keys(baseline.entries).length).toBe(2);
        const baselineComments = Object.values(baseline.entries).map(e => e.comment).sort();
        expect(baselineComments).toEqual(expect.arrayContaining(['reef-conditions', 'drifters']));

        // ── Drive ctx.replaceWorldBookEntries via the CardApp ctx
        //    builder. This is the production code path that real
        //    CardApps go through — `import buildContext from
        //    /scripts/extensions/card-app/context.js`, build a ctx,
        //    call ctx.replaceWorldBookEntries. The function reassigns
        //    uids on every call (so caller-supplied uids must be
        //    ignored — that's the documented contract).
        const replaceResult = await page.evaluate(async ({ bookName, entries }) => {
            const mod = await import('/scripts/extensions/card-app/context.js');
            const ctx0 = window.Luker.getContext();
            const charId = String(ctx0.characterId);
            const container = document.createElement('div');
            const cardAppCtx = mod.buildContext(container, charId, {});
            if (typeof cardAppCtx.replaceWorldBookEntries !== 'function') {
                return { ok: false, reason: 'replaceWorldBookEntries not on CardApp ctx' };
            }
            // Pass caller-supplied uids that should be ignored (9999+).
            const partial = entries.map((e, i) => ({ ...e, uid: 9999 + i }));
            const created = await cardAppCtx.replaceWorldBookEntries(bookName, partial);
            return {
                ok: true,
                createdCount: Array.isArray(created) ? created.length : 0,
                createdUids: Array.isArray(created) ? created.map(e => e.uid) : [],
            };
        }, { bookName, entries: REPLACEMENT_ENTRIES });

        expect(replaceResult.ok, `replace failed: ${replaceResult.reason}`).toBe(true);
        expect(replaceResult.createdCount).toBe(REPLACEMENT_ENTRIES.length);
        // Caller's uids (9999+) MUST have been ignored — assigned uids
        // start from a fresh counter (≤ 3 typically).
        for (const uid of replaceResult.createdUids) {
            expect(uid, 'caller-supplied uids are NOT honored').toBeLessThan(9999);
        }

        // ── On-disk: original entries gone, replacement entries present.
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

        // ── DOM-side assertion: open the WI editor, select the book,
        //    verify the rendered entries reflect the replacement. The
        //    saveWorldInfo call inside replaceWorldBookEntries uses
        //    `{refreshEditor: true}`, so a freshly-opened editor sees
        //    the new entries even if it was open at the time of
        //    replacement.
        await closeRightNavDrawer(page);
        await dismissAnyPopup(page);
        await openWorldInfoDrawer(page);
        await selectWorldBook(page, bookName);
        const rendered = await getRenderedWorldEntries(page);
        const renderedComments = rendered.map(r => r.comment).sort();
        expect(renderedComments).toEqual(expect.arrayContaining([
            'replaced/eastern-light',
            'replaced/skiff-alpha',
            'replaced/skiff-beta',
        ]));
        expect(renderedComments).not.toContain('reef-conditions');
        expect(renderedComments).not.toContain('drifters');

        // ── Persistence ─────────────────────────────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = JSON.parse(readFileSync(bookPath, 'utf8'));
        const afterRestartComments = Object.values(afterRestart.entries).map(e => e.comment).sort();
        expect(afterRestartComments).toEqual(expect.arrayContaining([
            'replaced/eastern-light', 'replaced/skiff-alpha', 'replaced/skiff-beta',
        ]));
    });
});
