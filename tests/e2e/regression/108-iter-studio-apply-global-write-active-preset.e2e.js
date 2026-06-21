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

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock;

const MARKER = '*REGRESSION-LOCK-108* Hold the Ash voice — close every turn with the brine on the lantern bezel.';

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '108-writeactive-preset', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

// Local inline helpers — `tests/e2e/_lib/ui-iter-studio.js`'s
// openIterStudio + sendIterPrompt + applyIterBatch are stale: they assume
// the legacy apply-batch / discard-batch action attrs (iter-library was
// refactored to a proposal-bus model with `data-proposal-action="approve"
// | "reject"`). The brief forbids editing _lib/, so we inline the
// up-to-date flow here.

async function setOrchModeToDirector(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'director') {
        await modeSelect.selectOption('director');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
        await page.waitForFunction(() => {
            const board = document.querySelector('#luker_orch_director_board');
            return board && board.offsetParent !== null;
        }, { timeout: 5000 });
    }
    // Flip the Enabled checkbox via the real settings panel — no
    // internal-state mutation. The drawer is already open (we just
    // toggled execution mode above), so the checkbox is visible.
    // bootstrapCustomBackend already cleared requestApi/LlmPresetName.
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

async function openOrchIterStudio(page) {
    const openBtn = page.locator('#luker_orch_director_board [data-luker-action="ai-iterate-open"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await openBtn.click();
    const sendBtn = page.locator('[data-orch-it-action="send"]').last();
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
}

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    const popup = page.locator('.popup:visible').last();
    const composer = popup.locator('textarea[data-orch-it-input]').first();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill(text);
    const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
    await sendBtn.click();
    const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 60_000 });
}

async function approveTopProposal(page) {
    const popup = page.locator('.popup:visible').last();
    const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await approveBtn.click();
    await approveBtn.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
}

async function closeIterStudioPopup(page) {
    const popup = page.locator('.popup:visible:has(.orch_it_popup)').last();
    const close = popup.locator('.popup-button-close').first();
    if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
        await close.click();
    } else {
        await page.keyboard.press('Escape');
    }
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

async function openOrchEditor(page) {
    const openBtn = page.locator('#luker_orch_director_board [data-luker-action="open-orch-editor"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await openBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    await popup.waitFor({ state: 'visible', timeout: 15_000 });
    return popup;
}

async function closeOrchEditor(page) {
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    const closeBtn = popup.locator('.popup-button-ok').first();
    await closeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeBtn.click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
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

        // Pre-reload sanity: open the editor and confirm the textarea
        // already shows the marker.
        let editor = await openOrchEditor(page);
        const sysPromptBefore = editor.locator('[data-orch-director-field="mainAgent.systemPrompt"]').first();
        await sysPromptBefore.waitFor({ state: 'visible', timeout: 10_000 });
        const valueBefore = await sysPromptBefore.inputValue();
        expect(valueBefore,
            'Approve must update the in-memory active preset; if the editor textarea is empty here, the apply pipeline never reached the preset library',
        ).toContain(MARKER);

        await closeOrchEditor(page);

        // RELOAD — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await setOrchModeToDirector(page);

        editor = await openOrchEditor(page);
        const sysPromptAfter = editor.locator('[data-orch-director-field="mainAgent.systemPrompt"]').first();
        await sysPromptAfter.waitFor({ state: 'visible', timeout: 10_000 });
        const valueAfter = await sysPromptAfter.inputValue();

        expect(valueAfter,
            'after reload, the director main agent systemPrompt textarea must STILL show the marker; ' +
            'a regression in writeActivePreset routing surfaces here as an empty/default textarea ' +
            '(migration strips the legacy field on next boot)',
        ).toContain(MARKER);
    });
});
