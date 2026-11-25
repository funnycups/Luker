// #137 — On a fresh install the first director-mode turn generates without
// the unsaved-preset dialog.
//
// The shipped user settings and the shipped "Default" chat-completion
// preset must agree on every generation field. When they disagree, the
// untouched "Default" preset already reads as having unsaved changes at
// first boot, and the director's preset swap stops the turn on the
// "Save and continue / Discard and continue" dialog.
//
// REAL USER-GESTURE flow:
//   1. Fixtures (before the page loads): onboarding is marked done and the
//      main chat connection points at the mock. No preset edits.
//   2. In the orchestrator drawer: enable, switch to director mode.
//   3. Send one chat turn from the composer. The director main agent writes
//      the reply and finalizes.
//   4. The reply bubble holds the director's text and the unsaved-preset
//      dialog never opened.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { enableOrchestratorMode } from '../_lib/ui-orchestrator.js';

const REPLY = '*Seraphina sets the lantern on the sill.* "The tide turned an hour ago. We leave at first light."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '137-director-first-turn-clean-preset' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#137 — first director turn on a fresh install', () => {
    test.setTimeout(180_000);

    test('generates without the unsaved-preset dialog', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableOrchestratorMode(page, 'director');

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role !== 'director-main') return null;
                if (turn === 0) return { tool: 'write_message', arguments: { text: REPLY, mode: 'replace' } };
                if (turn === 1) return { tool: 'finalize', arguments: {} };
                return null;
            },
        });

        // The dialog suspends Generate until answered, so an open dialog
        // shows up as a reply timeout. Name the dialog in the failure.
        const unsavedDialog = page.locator('.popup:visible', { hasText: 'has unsaved changes' });
        let reply;
        try {
            reply = await sendMessageAndAwaitReply(page, '*I lean over the chart table.* "How long until the reef lets us through?"', { timeoutMs: 60_000 });
        } catch (error) {
            const dialogs = await unsavedDialog.count();
            throw new Error(`director turn did not finish (unsaved-preset dialogs open: ${dialogs}): ${error.message}`);
        }
        expect(reply.text).toContain('We leave at first light.');
        await expect(unsavedDialog).toHaveCount(0);
        expect(mock.requests.some((r) => (r.body?.tools || []).some((t) => t?.function?.name === 'write_message')),
            'the director main agent request must reach the mock').toBe(true);
    });
});
