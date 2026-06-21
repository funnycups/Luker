// #113 — director-mode character override survives reload with the flat shape
// (memory: known_bug_director_override_load_shape, resolved 2026-05-28)
//
// Bug shape: pre-fix, character-card director overrides were saved as the
// BARE inner sub-object (`override.director = { mainAgent, ... }`), while
// the loader fed it through `sanitizeDirectorProfile`, which expected the
// legacy `{ director: { mainAgent, ... } }` wrapper. The bare shape made
// `profile.director` undefined and the sanitizer returned defaults —
// user-visible: AI Iteration Studio in director mode appeared to "save
// nothing" because the loader rebuilt the override from defaults on every
// open.
//
// Fix: director profile is flat — `{ mode, mainAgent, subAgents, ... }`.
// `sanitizeDirectorProfile` auto-detects all three input shapes (legacy
// wrapped, new flat, bare card-override sub-object) and produces flat
// output unconditionally; writes always produce flat.
//
// REAL USER FLOW:
//   1. Select a character.
//   2. Switch execution mode to "director" via the real dropdown.
//   3. Open the Orchestration Editor.
//   4. Write a marker into the director main-agent systemPrompt textarea.
//   5. Click "Save To Character Override" — creates the override.
//   6. Reload the page; re-select the character; re-enable director mode.
//   7. Re-open the editor — the textarea must STILL contain the marker.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server;

const OVERRIDE_MARKER = 'REGRESSION-113 marker: Ash stands on the Bryn cliff at slow tide and watches the salt-mark drifters.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '113-director-override', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

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
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
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

test.describe('#113 — director-mode character override survives reload', () => {
    test.setTimeout(120_000);

    test('save-to-character then reload reloads the override with its flat shape and the marker intact', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setOrchModeToDirector(page);

        // Open editor (global scope — no override yet).
        let popup = await openOrchEditor(page);

        // Write the marker into the director main-agent systemPrompt.
        const sysPromptArea = popup.locator('[data-orch-director-field="mainAgent.systemPrompt"]').first();
        await sysPromptArea.waitFor({ state: 'visible', timeout: 10_000 });
        await sysPromptArea.fill(OVERRIDE_MARKER);
        await page.waitForTimeout(500);

        // Click "Save To Character Override" — creates and enables override.
        const saveBtn = popup.locator('[data-luker-action="save-character"]:visible').first();
        await saveBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await saveBtn.click();
        await page.waitForTimeout(800);
        await closeOrchEditor(page);

        // Verify the override toggle appears on the director board.
        const overrideToggleAfterSave = page.locator('#luker_orch_director_override_toggle');
        await overrideToggleAfterSave.waitFor({ state: 'visible', timeout: 10_000 });
        expect(await page.locator('#luker_orch_director_override_enabled').isChecked(),
            'override should be enabled after save',
        ).toBe(true);

        // RELOAD — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setOrchModeToDirector(page);

        const overrideToggleAfterReload = page.locator('#luker_orch_director_override_toggle');
        await overrideToggleAfterReload.waitFor({ state: 'visible', timeout: 15_000 });
        expect(await page.locator('#luker_orch_director_override_enabled').isChecked(),
            'character override toggle must still be on after reload',
        ).toBe(true);

        popup = await openOrchEditor(page);
        const sysPromptAfter = popup.locator('[data-orch-director-field="mainAgent.systemPrompt"]').first();
        await sysPromptAfter.waitFor({ state: 'visible', timeout: 10_000 });
        const value = await sysPromptAfter.inputValue();

        expect(value,
            'director main agent systemPrompt must round-trip through the override sanitizer; ' +
            'if the loader regresses to the bare-shape misread, defaults overwrite the marker',
        ).toContain(OVERRIDE_MARKER);
    });
});
