// #108 — iter-studio Apply→Global persists across reload via the active preset
// (commit 990c2d738)
//
// Bug shape: `applyAiIterationSessionToGlobal` previously wrote AI-edited
// profiles into the legacy single-slot fields (`settings.directorProfile`,
// `settings.loopProfile`, ...). The migration strips those fields on next
// boot AND the runtime / iter-studio / global panel all read via
// `getActivePreset`, which only looks at
// `settings.presetLibraries.<mode>.<activeId>`. Net effect: AI edits
// applied via iter-studio appeared to succeed but were silently lost on
// the next reload.
//
// Fix: every mode branch in `applyAiIterationSessionToGlobal` now calls
// `writeActivePreset(settings, mode, 'global', payload)`, which mutates
// the active preset slot — the slot the readers actually consult.
//
// REAL USER FLOW:
//   1. Switch execution mode to "director" via the real dropdown.
//   2. Open the orchestrator iter-studio popup.
//   3. Script the mock LLM to emit a profile-edit tool call that mutates
//      the director main agent's systemPrompt to contain a marker.
//   4. Send → click Approve on the rendered proposal card.
//   5. Reload the page; re-enable director mode.
//   6. Open the Orchestration Editor and assert the director main agent's
//      systemPrompt textarea still contains the marker.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { setOrchMode, setOrchEnabled, openOrchWorkspace, closeWorkbench } from '../_lib/ui-workbench.js';

let server, mock;

const MARKER = '*REGRESSION-LOCK-108* Hold the Ash voice — close every turn with the brine on the lantern bezel.';

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM();
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '108-writeactive-preset', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await mock?.stop();
});

async function setOrchModeToDirector(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

async function openOrchIterStudio(page) {
    await openIterStudio(page, 'orch', { scope: 'global' });
}

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    await sendIterPrompt(page, 'orch', text);
}

async function approveTopProposal(page) {
    await applyIterBatch(page, 'orch');
}

async function closeIterStudioPopup(page) {
    await closeIterStudio(page);
}

async function readMainAgentPromptInOrchLens(page) {
    const lens = await openOrchWorkspace(page, 'flow');
    const mainCard = lens.locator('button.ol-card').first();
    await expect(mainCard).toBeVisible({ timeout: 15_000 });
    await mainCard.click();
    const insp = lens.locator('.ol-inspector').first();
    await expect(insp).toBeVisible({ timeout: 10_000 });
    return insp.innerText();
}

async function closeOrchEditor(page) {
    await closeWorkbench(page);
}

test.describe('#108 — iter-studio Apply→Global persists across reload', () => {
    test.setTimeout(180_000);

    test('AI-edited director main agent systemPrompt survives reload via the active preset', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: MARKER },
        });

        await openOrchIterStudio(page);
        await sendOrchIterPromptAndAwaitProposal(page,
            'Update the director main agent systemPrompt to take the Ash cartographer voice.');
        await approveTopProposal(page);

        await closeIterStudioPopup(page);

        // Pre-reload sanity: inspect mainAgent prompt in Orchestra Lens Flow view.
        const valueBefore = await readMainAgentPromptInOrchLens(page);
        expect(valueBefore,
            'Apply must update the in-memory active preset; if Orchestra Lens inspector lacks the marker, the apply pipeline never reached the preset library',
        ).toContain(MARKER);

        await closeOrchEditor(page);

        // RELOAD — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await setOrchModeToDirector(page);

        const valueAfter = await readMainAgentPromptInOrchLens(page);

        expect(valueAfter,
            'after reload, the director main agent systemPrompt in Orchestra Lens must STILL show the marker',
        ).toContain(MARKER);
    });
});
