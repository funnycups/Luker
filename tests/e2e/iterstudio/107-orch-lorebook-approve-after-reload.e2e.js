// #107 — Orchestrator iter-studio: a pending world book proposal restored
// after a restart and reload can still be approved.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio (global scope); the mock LLM
//      answers round 1 with `lorebook_update_entry` on the bundled Eldoria
//      book, every later round with text.
//   2. With the popup still open, wait for the pending proposal in
//      settings.json, then restart the server and reload the page.
//   3. Reopen the studio, load the past session from the history list,
//      click Approve: the entry changes in worlds/Eldoria.json.
//   4. Click Rollback: the entry returns to its original fields on disk.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, readGlobalWorkbenchBodies } from './_helpers.js';

let server, mock;

const BOOK = 'Eldoria';
const UID = 1;
const NEW_COMMENT = 'shadowfang — tide-bell ledger';
const NEW_KEYSECONDARY = ['tide bell', 'harbor ledger'];
const FOLLOW_UP = 'The chart-keeper marks the shadowfang entry with the tide-bell ledger.';

function readEntry(dataRoot, uid) {
    const raw = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK}.json`), 'utf8'));
    return raw?.entries?.[String(uid)] || null;
}

function storedDecisionStates() {
    return readGlobalWorkbenchBodies(server.dataRoot, session => session.ws === 'orch')
        .flatMap(session => (session.turns || []).filter(turn => turn.changes?.length).map(turn => turn.state));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '107-orch-lorebook-approve-after-reload',
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

test.describe('#107 — Orchestrator iter-studio: approve a restored world book proposal', () => {
    test('a pending proposal approved after a restart writes the entry and rolls back', async ({ page }) => {
        const before = readEntry(server.dataRoot, UID);
        expect(before).toBeTruthy();
        expect(before.comment).not.toBe(NEW_COMMENT);

        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [{
                        name: 'lorebook_update_entry',
                        arguments: { book_name: BOOK, uid: UID, patch: { comment: NEW_COMMENT, keysecondary: NEW_KEYSECONDARY } },
                    }],
                };
            }
            return { text: FOLLOW_UP };
        });

        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        await sendIterPrompt(page, 'orch', 'Tie the Eldoria shadowfang entry to the tide-bell ledger the harbor keeps.');

        // Popup still open: the pending proposal must already be on disk.
        await expect.poll(storedDecisionStates, { timeout: 30_000 }).toEqual(['pending']);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await openIterStudio(page, 'orch');

        const reopened = page.locator('.wbench .wb-win');
        const pastSession = reopened.locator('.wb-sess-item', { hasText: 'Tie the Eldoria' });
        await pastSession.waitFor({ state: 'visible', timeout: 10_000 });
        await pastSession.click();
        await expect(reopened.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });

        await applyIterBatch(page, 'orch');
        await expect(reopened.locator('.wb-chg.is-applied .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect(reopened.locator('.wb-chg.is-partial')).toHaveCount(0);
        await expect.poll(storedDecisionStates, { timeout: 15_000 }).toEqual(['applied']);
        await expect.poll(() => readEntry(server.dataRoot, UID)?.comment, { timeout: 15_000 }).toBe(NEW_COMMENT);
        expect(readEntry(server.dataRoot, UID).keysecondary).toEqual(NEW_KEYSECONDARY);
        expect(readEntry(server.dataRoot, UID).content).toBe(before.content);

        await rollbackIterBatch(page, 'orch');
        await expect(reopened.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(storedDecisionStates, { timeout: 15_000 }).toEqual(['discarded']);
        await expect.poll(() => readEntry(server.dataRoot, UID)?.comment, { timeout: 15_000 }).toBe(before.comment);
        expect(readEntry(server.dataRoot, UID).keysecondary).toEqual(before.keysecondary);

        await closeIterStudio(page);
    });
});
