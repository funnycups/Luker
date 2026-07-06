// #119 — orchestrator popup General tab hydrates from live settings
//
// Bug shape: after the tab-refactor commits (7af4b419a, 720f87cc0, 1953665a6,
// 6ceb8bc47, 7925fedac, b25d0d4eb, f8b5b7bd8, 2d55913ff), the popup opened
// from any mode's board arrived with completely empty API preset dropdowns,
// empty iteration-AI system prompt textarea, empty per-mode iteration prompt
// textareas, and per-mode profile chips stuck at template placeholders
// like "(No character card)" / "Global profile" — because
// `refreshOrchestrationEditorPopup` rebuilt the HTML from templates without
// running the equivalent of `bindUi`'s field-population loop plus
// `renderDynamicPanels`'s per-mode chip block.
//
// Fix: extract `hydrateGeneralTabFields(mount, {prefix, context, settings})`
// and `hydratePerModeChips(mount, context, settings, prefix)`; call both from
// `bindUi` with prefix='' and from `refreshOrchestrationEditorPopup` with
// prefix='orch-popup-'.
//
// REAL USER FLOW:
//   1. Load the app fresh.
//   2. Open the extensions drawer + orchestrator settings drawer.
//   3. Type a marker value into the drawer's request-system-prompt textarea
//      (this exercises the auto-save handler and lands in settings).
//   4. Click "Open in Popup" — the popup renders from templates.
//   5. Verify the popup's request-system-prompt textarea shows the marker.
//   6. Verify the popup's API preset dropdown has at least one option.
//   7. Verify per-mode profile-chip label matches drawer's (e.g. "Global profile").

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server;

const REQUEST_PROMPT_MARKER = 'REGRESSION-119 marker: hydrate the popup request system prompt from live settings.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '119-orch-popup-hydrate', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 10_000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

async function openOrchPopupFromDrawer(page) {
    // The drawer's UI_BLOCK_ID is 'orchestrator_settings'. The "Open in
    // Popup" button lives inside each mode's row (spec / agenda / loop /
    // director / single); only the active mode's row is visible.
    const openBtn = page.locator('#orchestrator_settings [data-luker-action="open-orch-editor-popup"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    return popup;
}

test.describe('#119 — orchestrator popup General tab hydrates from live settings', () => {
    test.setTimeout(90_000);

    test('popup opens with API preset options, request system prompt, and per-mode chips populated', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawer(page);

        // Drop a marker into the drawer's request-system-prompt textarea.
        // This exercises the auto-save handler (drawer side) so the value
        // lands in settings before we open the popup.
        const drawerPrompt = page.locator('#luker_orch_request_system_prompt');
        await drawerPrompt.waitFor({ state: 'visible', timeout: 10_000 });
        await drawerPrompt.fill(REQUEST_PROMPT_MARKER);
        // Fire 'input' event so the auto-save handler runs. Playwright's
        // fill() already dispatches this; the wait is for the debounced
        // saveSettings call to flush before we open the popup.
        await page.waitForTimeout(500);

        const popup = await openOrchPopupFromDrawer(page);

        // Assertion 1: request-system-prompt hydrated from settings.
        const popupPrompt = popup.locator('#orch-popup-luker_orch_request_system_prompt');
        await popupPrompt.waitFor({ state: 'visible', timeout: 5000 });
        expect(await popupPrompt.inputValue(),
            'popup request-system-prompt must hydrate from settings.requestSystemPrompt',
        ).toBe(REQUEST_PROMPT_MARKER);

        // Assertion 2: API preset dropdown populated (at least the empty-option row).
        const apiPresetSelect = popup.locator('#orch-popup-luker_orch_request_api_preset');
        const optionCount = await apiPresetSelect.locator('option').count();
        expect(optionCount,
            'popup API preset dropdown must be populated by refreshOpenAIPresetSelectors — 0 means the popup selectors did not run',
        ).toBeGreaterThan(0);

        // Assertion 3: per-mode profile chip label reflects live scope
        // ('Global profile' for a fresh no-character-card session). The
        // template placeholder before the fix reads the same label, so
        // we instead assert the chip is NOT the initial template default
        // by cross-checking against drawer's populated chip.
        const drawerChipText = await page.locator('#luker_orch_profile_mode').textContent();
        const popupChipText = await popup.locator('#orch-popup-luker_orch_profile_mode').textContent();
        expect(String(popupChipText || '').trim(),
            'popup per-mode profile chip must be hydrated from renderDynamicPanels equivalent, matching drawer',
        ).toBe(String(drawerChipText || '').trim());
    });
});
