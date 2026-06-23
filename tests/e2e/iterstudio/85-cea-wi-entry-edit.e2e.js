// #85 — CEA Character iter-studio: edit a world-book entry → persists across restart.
//
// This is the WI counterpart to #82 (which exercised character-card editing).
// Production bug this guards: users reported "CEA 编 WI 永远冲突" — the first
// LLM proposal to update a lorebook entry surfaced as a conflict with no
// Approve button. Root cause was the legacy whole-snapshot fingerprint over
// the entire live state; the patch-storage refactor swapped that for
// path-overlap drift detection. This e2e drives the FULL real path
// (mock LLM → studio → bus → orch-lorebook target → CEA helper-api commit →
// disk worlds/<book>.json) so any regression to whole-snapshot drift
// detection — or to the underlying sandbox-diff helper-api wiring — surfaces
// as Apply failing to mutate the on-disk world book.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const BOOK_NAME = 'Eldoria';
const NEW_CONTENT = '*The Eldoria wood is older than the kingdoms it shadows.* '
    + 'Reef-rusted lantern brackets line every path where the canopy thins enough for a survey crew to camp. '
    + 'When the wind moves through the high beeches, the chart-bearers say it sounds like a tide.';
const TARGET_UID = 0;

function worldsJsonPath(dataRoot, bookName) {
    return resolve(dataRoot, 'default-user', 'worlds', `${bookName}.json`);
}

function readEldoriaEntry(dataRoot, uid) {
    const raw = JSON.parse(readFileSync(worldsJsonPath(dataRoot, BOOK_NAME), 'utf8'));
    return raw?.entries?.[String(uid)] || null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '85-cea-wi-entry-edit',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#85 — CEA character iter-studio WI entry edit → persists across restart (real UI)', () => {
    test('Apply rewrites Eldoria entry uid=0 content via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Baseline: the seeded entry's content does NOT yet contain the
        // reef-survey wording — confirms the assertion below is not a tautology.
        const beforeContent = readEldoriaEntry(server.dataRoot, TARGET_UID)?.content || '';
        expect(beforeContent).not.toContain('reef-rusted lantern brackets');

        // Open CEA editor iter-studio popup.
        await openIterStudio(page, 'cea');

        // Script the lorebook entry update tool_call. Patch only `content`
        // so any other field on uid=0 stays untouched.
        mock.scriptToolCall({
            name: 'cea_update_lorebook_entry',
            arguments: {
                book_name: BOOK_NAME,
                uid: TARGET_UID,
                patch: { content: NEW_CONTENT },
            },
        });

        await sendIterPrompt(page, 'cea', `Rewrite the "${BOOK_NAME}" lorebook entry uid 0 to add the reef-rusted lantern bracket detail.`);
        await applyIterBatch(page, 'cea');
        await closeIterStudio(page);

        // Disk-side: world book file rewritten with new content.
        await expect.poll(() => {
            const e = readEldoriaEntry(server.dataRoot, TARGET_UID);
            return e?.content || '';
        }, { timeout: 10_000 }).toBe(NEW_CONTENT);

        // Restart + reload + re-assert.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = readEldoriaEntry(server.dataRoot, TARGET_UID);
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.content).toBe(NEW_CONTENT);
    });
});
