// #120 — orchestrator Runtime-limits auto-save via narrow persisted patch
//
// Bug shape: after commit f8b5b7bd8 hoisted director / agenda / loop
// Runtime-limits into the General tab, their change handlers only mutated
// the editor draft (editor.maxRounds = X). Runtime reads from
// settings.presetLibraries.director.<activeId>.maxRounds, so the next
// chat run used the OLD limits. UI showed the new value (editor draft
// re-hydrates the field), giving the user a "changed but doesn't work"
// experience.
//
// Fix: append `await persistRuntimeLimitsPatch(...)` to the handlers —
// narrow-patches only the limits fields into the active preset, keeping
// mainAgent / subAgents / tools / customTools untouched.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer.
//   2. Switch mode to director.
//   3. Change director.maxRounds via the General-tab input.
//   4. Reload page.
//   5. Re-open orchestrator drawer, switch mode to director.
//   6. Verify the director.maxRounds input shows the new value.
//   7. Also verify director mainAgent systemPrompt (or another mainAgent
//      field) was NOT clobbered — draft-only mutations should NOT be
//      persisted by the auto-save.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server;

const NEW_MAX_ROUNDS = 77;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '120-orch-rt-limits', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawerDirector(page) {
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
    }
    // Runtime-limits inputs live inside `<div data-orch-mode="director">`
    // which starts hidden and is toggled on by refreshModeVisibility.
    // Wait for the director max_rounds input to be revealed.
    await page.locator('#luker_orch_director_max_rounds').waitFor({ state: 'visible', timeout: 10_000 });
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

test.describe('#120 — orchestrator Runtime-limits auto-save', () => {
    test.setTimeout(90_000);

    test('director maxRounds change persists across reload without touching mainAgent draft', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawerDirector(page);

        // Switch to the Agents tab so the mainAgent systemPrompt textarea
        // becomes visible for `.fill()`. The drawer starts on the General
        // tab (where #luker_orch_director_max_rounds lives), and the
        // Agents-tab pane is `hidden` until clicked. Reading `.inputValue()`
        // would work through the `hidden` attribute, but `.fill()` requires
        // the element to be interactable.
        const agentsTabButton = page.locator('button[data-luker-tabs-target="luker_orch_tabs"][data-luker-tab-key="agents"]');
        await agentsTabButton.click();
        const mainAgentTextarea = page.locator('[data-orch-director-field="mainAgent.systemPrompt"]').first();
        await mainAgentTextarea.waitFor({ state: 'visible', timeout: 5000 });

        // Capture the current mainAgent systemPrompt from the drawer's
        // director workspace before we inject a draft-only marker edit.
        const mainAgentPromptBefore = await mainAgentTextarea.inputValue();

        // Draft-only mainAgent edit: type a marker into the mainAgent
        // systemPrompt textarea, but DO NOT trigger any Save. This
        // discriminates narrow-patch from full-draft flush: narrow-patch
        // must leave this unsaved draft edit in memory only, so after
        // reload the persisted preset (pre-marker value) hydrates back
        // in and the marker is gone.
        const MAIN_AGENT_DRAFT_MARKER = 'REGRESSION-120-MAIN-AGENT-DRAFT-MARKER';
        await mainAgentTextarea.fill(MAIN_AGENT_DRAFT_MARKER);
        await mainAgentTextarea.evaluate(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('input');
        });

        // Switch back to the General tab so the max_rounds input becomes
        // interactable again.
        const generalTabButton = page.locator('button[data-luker-tabs-target="luker_orch_tabs"][data-luker-tab-key="general"]');
        await generalTabButton.click();

        // Change director max_rounds in the General tab.
        const maxRoundsInput = page.locator('#luker_orch_director_max_rounds');
        await maxRoundsInput.waitFor({ state: 'visible', timeout: 10_000 });
        await maxRoundsInput.fill(String(NEW_MAX_ROUNDS));
        await maxRoundsInput.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
        // Wait for the async persistRuntimeLimitsPatch to flush.
        await page.waitForTimeout(800);

        // Reload — load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await openOrchDrawerDirector(page);

        const maxRoundsAfter = await page.locator('#luker_orch_director_max_rounds').inputValue();
        expect(Number(maxRoundsAfter),
            'director.maxRounds must persist to settings.presetLibraries.director.<activeId>.maxRounds; ' +
            'if the auto-save patch did not fire, the value reverts to the prior default on reload',
        ).toBe(NEW_MAX_ROUNDS);

        // Discriminator assertions: the marker we typed into mainAgent must
        // NOT have survived the reload (narrow-patch did not flush draft),
        // AND the value must have reverted to the persisted pre-draft state.
        // If the auto-save had flushed the whole editor draft, the marker
        // would be back after the persisted-then-hydrated round trip.
        // Read via .inputValue() — works through the `hidden` attribute so
        // we don't need to switch tabs again post-reload.
        const mainAgentPromptAfterReload = await page
            .locator('[data-orch-director-field="mainAgent.systemPrompt"]')
            .first()
            .inputValue();
        expect(mainAgentPromptAfterReload,
            'draft-only mainAgent edits must NOT be flushed by the runtime-limits auto-save; ' +
            'if the marker reappears the auto-save is flushing the whole editor draft, not a narrow patch',
        ).not.toBe(MAIN_AGENT_DRAFT_MARKER);
        expect(mainAgentPromptAfterReload,
            'mainAgent.systemPrompt must revert to the pre-draft persisted value on reload; ' +
            'a mismatch means either the draft leaked (see previous assertion) or the persisted value drifted',
        ).toBe(mainAgentPromptBefore);
    });
});
