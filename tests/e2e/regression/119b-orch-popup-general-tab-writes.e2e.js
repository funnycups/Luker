// #119b — orchestrator popup General-tab writes propagate to settings
//
// Bug shape: after the tab-refactor commits, the popup renders General-tab
// fields with `orch-popup-` prefixed ids, but the `bindUi` change handlers
// used drawer-scoped `root.on(..., '#luker_orch_X', ...)` — matching zero
// popup elements. User edits in popup were silent no-ops: value entered,
// no persist, no toast, next chat run used stale settings.
//
// Fix: convert 15 change/input handlers and 5 click handlers to
// `jQuery(document).on(..., '#UI_BLOCK_ID #luker_orch_X, .luker_orch_editor_popup #orch-popup-luker_orch_X', ...)`
// — same pattern already used for max_recent_messages/tool_retries/rpm_limit.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer, ensure orchestrator enabled.
//   2. Open "Open in Popup".
//   3. Type marker A into POPUP's request-system-prompt textarea.
//   4. Type marker B into POPUP's iter_mode_prompt_spec textarea.
//   5. Wait for debounced save.
//   6. Close popup, reload page.
//   7. Re-open orchestrator drawer.
//   8. Verify DRAWER's request-system-prompt textarea has marker A.
//   9. Verify DRAWER's iter_mode_prompt_spec textarea has marker B.

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

const PROMPT_MARKER_A = 'REGRESSION-119b marker A: popup edits must persist to settings.requestSystemPrompt.';
const PROMPT_MARKER_B = 'REGRESSION-119b marker B: popup edits must persist to settings.iterModePromptSpec.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '119b-orch-popup-writes', extraConfig: { 'storage.mode': 'fs' } });
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

async function openOrchPopup(page) {
    const openBtn = page.locator('#orchestrator_settings [data-luker-action="open-orch-editor-popup"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    return popup;
}

async function closeOrchPopup(page) {
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    const closeBtn = popup.locator('.popup-button-ok').first();
    await closeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeBtn.click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.describe('#119b — orchestrator popup General-tab writes propagate to settings', () => {
    test.setTimeout(90_000);

    test('editing request-system-prompt and iter-mode-prompt-spec in popup persists across reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawer(page);

        const popup = await openOrchPopup(page);

        // Edit in POPUP.
        const popupPrompt = popup.locator('#orch-popup-luker_orch_request_system_prompt');
        await popupPrompt.waitFor({ state: 'visible', timeout: 5000 });
        await popupPrompt.fill(PROMPT_MARKER_A);

        const popupIterSpec = popup.locator('#orch-popup-luker_orch_iter_mode_prompt_spec');
        await popupIterSpec.waitFor({ state: 'visible', timeout: 5000 });
        await popupIterSpec.fill(PROMPT_MARKER_B);

        // Wait for debounced saveSettings to flush.
        await page.waitForTimeout(800);
        await closeOrchPopup(page);

        // Reload the page — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await openOrchDrawer(page);

        // Verify DRAWER textareas have the marker values.
        const drawerPrompt = page.locator('#luker_orch_request_system_prompt');
        await drawerPrompt.waitFor({ state: 'visible', timeout: 10_000 });
        expect(await drawerPrompt.inputValue(),
            'drawer request-system-prompt must reflect popup edit; ' +
            'if the popup-side write handler did not fire, settings.requestSystemPrompt keeps its prior value',
        ).toBe(PROMPT_MARKER_A);

        const drawerIterSpec = page.locator('#luker_orch_iter_mode_prompt_spec');
        expect(await drawerIterSpec.inputValue(),
            'drawer iter-mode-prompt-spec must reflect popup edit; ' +
            'if the popup-side write handler did not fire, settings.iterModePromptSpec keeps its prior value',
        ).toBe(PROMPT_MARKER_B);
    });
});
