// #95 — Orchestrator iter-studio lorebook proposals: Approve writes the
// world book on disk, Rollback restores it.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio popup via real clicks.
//   2. The mock LLM answers round 1 with `lorebook_update_entry` (uid 1)
//      and `lorebook_str_replace_in_entry` (uid 2) on the bundled Eldoria
//      book; every later round is plain text.
//   3. Click "Approve all pending" → both entries change in
//      worlds/Eldoria.json.
//   4. Click "Rollback this turn" → both entries return to their original
//      fields on disk.
//   5. Restart the server, reload, re-assert the restored file.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const BOOK = 'Eldoria';
const NEW_COMMENT = 'shadowfang — night-watch ledger';
const NEW_KEYSECONDARY = ['night watch', 'lantern ledger'];
const OLD_PHRASE = 'a haven of safety I\'ve warded with ancient magic';
const NEW_PHRASE = 'a haven the night-watch lanterns still ring with ward-light';
// Plain prose (no markdown markers) so the rendered bubble text equals it 1:1.
const FOLLOW_UP = 'The chart-keeper sets the quill down. Both Eldoria entries now carry the night-watch detail and the glade ward reads as lantern-light.';

function readEntry(dataRoot, uid) {
    const raw = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK}.json`), 'utf8'));
    return raw?.entries?.[String(uid)] || null;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '95-orch-lorebook-approve-rollback',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#95 — Orchestrator iter-studio lorebook Approve → disk → Rollback (real UI)', () => {
    test('Approve writes both entry edits and Rollback restores them across restart', async ({ page }) => {
        const before1 = readEntry(server.dataRoot, 1);
        const before2 = readEntry(server.dataRoot, 2);
        expect(before1).toBeTruthy();
        expect(before2.content).toContain(OLD_PHRASE);
        expect(before1.comment).not.toBe(NEW_COMMENT);

        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [
                        {
                            name: 'lorebook_update_entry',
                            arguments: { book_name: BOOK, uid: 1, patch: { comment: NEW_COMMENT, keysecondary: NEW_KEYSECONDARY } },
                        },
                        {
                            name: 'lorebook_str_replace_in_entry',
                            arguments: { book_name: BOOK, uid: 2, oldString: OLD_PHRASE, newString: NEW_PHRASE },
                        },
                    ],
                };
            }
            return { text: FOLLOW_UP };
        });

        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        await sendIterPrompt(page, 'orch', 'Tie the Eldoria shadowfang and glade entries to the night-watch lanterns the cartographers keep.');

        const popup = page.locator('.wbench .wb-win');
        await expect(popup.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(2);

        await applyIterBatch(page, 'orch');

        await expect.poll(() => readEntry(server.dataRoot, 1)?.comment, { timeout: 15_000 }).toBe(NEW_COMMENT);
        expect(readEntry(server.dataRoot, 1).keysecondary).toEqual(NEW_KEYSECONDARY);
        await expect.poll(() => readEntry(server.dataRoot, 2)?.content, { timeout: 15_000 })
            .toBe(before2.content.replace(OLD_PHRASE, NEW_PHRASE));
        await expect(popup.locator('.wb-chg.is-applied .wb-chg-line')).toHaveCount(2);
        await expect(popup.locator('.wb-chg.is-partial')).toHaveCount(0);
        await expect(popup).toContainText(FOLLOW_UP, { timeout: 15_000 });

        await rollbackIterBatch(page, 'orch', { turn: true });

        // The turn's entries roll back one after another, so each entry
        // is awaited on its own.
        await expect.poll(() => readEntry(server.dataRoot, 2)?.content, { timeout: 15_000 }).toBe(before2.content);
        await expect.poll(() => readEntry(server.dataRoot, 1)?.comment, { timeout: 15_000 }).toBe(before1.comment);
        expect(readEntry(server.dataRoot, 1).keysecondary).toEqual(before1.keysecondary);
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(2);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const after1 = readEntry(server.dataRoot, 1);
        const after2 = readEntry(server.dataRoot, 2);
        expect(after1.comment).toBe(before1.comment);
        expect(after1.keysecondary).toEqual(before1.keysecondary);
        expect(after2.content).toBe(before2.content);
    });
});
