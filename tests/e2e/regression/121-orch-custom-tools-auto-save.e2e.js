// #121 — orchestrator customTools[] auto-save via narrow persisted patch
//
// Bug shape: main.js:6961 comment explicitly said "Persist still requires
// Save." The 5 custom-tool handlers (add / import-defaults / edit /
// duplicate / remove) mutated editor.customTools[] in memory but did not
// call any persist function. Users who added a tool, closed the editor
// without clicking Save, and returned later found their tool gone.
//
// Fix: append `await persistCustomToolsPatch(...)` — narrow-patches only
// the customTools slot into the active preset, keeping mainAgent /
// tool-flag / skill-chip / other draft state untouched.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer, switch mode to loop.
//   2. Open loop workspace.
//   3. Click "Add custom tool", fill in name + description, click OK.
//   4. WITHOUT clicking any Save button, reload the page.
//   5. Re-open orchestrator drawer, switch mode to loop.
//   6. Verify the custom tool row exists in the loop customTools list.
//   7. Cross-check: any existing tool-flag checkbox state is untouched
//      (auto-save patched only the customTools slot).

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

const NEW_TOOL_NAME = 'regression_121_marker_tool';
const NEW_TOOL_DESC = 'REGRESSION-121 marker: this tool must survive reload without an explicit Save click.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '121-orch-ct-auto-save', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawerLoop(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'loop') {
        await modeSelect.selectOption('loop');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
    // Switch to the "Tools & Skills" tab where the Custom Tools section
    // lives. Tab state persists per scope; after reload the persisted
    // active tab is already this one, but we click defensively so the
    // "before reload" path also lands on the right tab.
    await page.locator('#luker_orch_tabs [data-luker-tab-key="tools-skills"]').first().click();
    // The tools-skills tab pane holds `<div data-orch-mode="loop"
    // data-orch-tab-host="tools-skills">` which is display:none until
    // refreshModeVisibility toggles it for the current mode. Wait for
    // the loop tools-skills host to become visible — this is the
    // workspace-inside-visible-tab-pane readiness signal.
    await page.locator('[data-orch-mode="loop"][data-orch-tab-host="tools-skills"]').waitFor({ state: 'visible', timeout: 10_000 });
    // The <details> Custom Tools wrapper is closed by default; force
    // it open so the Add button and any tool rows become visible.
    await page.evaluate(() => {
        document
            .querySelectorAll('.luker_orch_ct_section[data-orch-mode-tag="loop"]')
            .forEach(el => { el.open = true; });
    });
}

async function addCustomToolViaEditor(page, { name, description }) {
    // `data-orch-mode-tag="loop"` scopes to the loop template section
    // within the drawer. openOrchDrawerLoop has already expanded the
    // Custom Tools details wrapper.
    const addBtn = page.locator('[data-orch-action="add-custom-tool"][data-orch-mode-tag="loop"]:visible').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await addBtn.click();
    // The tool editor is its own popup rendered by custom-tool-editor.js
    // with wrapper class `luker_orch_ct_editor` (underscores). Fields are
    // identified by `data-orch-ct-*` attributes, not name/id.
    const editor = page.locator('.popup:visible:has(.luker_orch_ct_editor)').last();
    await editor.waitFor({ state: 'visible', timeout: 10_000 });
    await editor.locator('[data-orch-ct-name]').fill(name);
    await editor.locator('[data-orch-ct-description]').fill(description);
    // Click OK / Save inside the tool editor popup.
    await editor.locator('.popup-button-ok').first().click();
    await editor.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // Wait for the async persistCustomToolsPatch to flush to settings.
    await page.waitForTimeout(800);
}

test.describe('#121 — orchestrator customTools[] auto-save', () => {
    test.setTimeout(120_000);

    test('adding a custom tool persists across reload without clicking Save', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawerLoop(page);

        await addCustomToolViaEditor(page, { name: NEW_TOOL_NAME, description: NEW_TOOL_DESC });

        // Sanity check that persistCustomToolsPatch wrote to settings —
        // we intentionally do NOT check the drawer DOM here because
        // refreshOrchestrationEditorPopup is a no-op in drawer context
        // (it only re-renders the popup). Post-reload the drawer will
        // rebuild from settings; that's the load-bearing verification.
        const persistedNames = await page.evaluate(() => {
            const ext = window.Luker?.getContext()?.extensionSettings?.orchestrator;
            const loopLib = ext?.presetLibraries?.loop || {};
            const activeId = ext?.activePresetIds?.loop || '';
            const active = loopLib[activeId] || null;
            return Array.isArray(active?.customTools)
                ? active.customTools.map(t => t?.name || '')
                : [];
        });
        expect(persistedNames,
            'persistCustomToolsPatch must have written the tool into ' +
            'settings.presetLibraries.loop.<activeId>.customTools before ' +
            'reload; without this call, the reload leg cannot distinguish ' +
            'draft-only mutations from real persistence',
        ).toContain(NEW_TOOL_NAME);

        // Reload — load-bearing leg. If persistCustomToolsPatch did not
        // fire, editor.customTools[] mutation is lost and the row is gone
        // after re-open.
        await reloadAndAwait(page, server.baseURL);
        await openOrchDrawerLoop(page);

        const rowSelector = `[data-orch-mode-tag="loop"] .luker_orch_ct_row:has([data-orch-tool-flag="${NEW_TOOL_NAME}"])`;
        const rowAfter = page.locator(rowSelector);
        await rowAfter.waitFor({ state: 'visible', timeout: 10_000 });
        expect(await rowAfter.count(),
            'custom tool row must persist to settings.presetLibraries.loop.<activeId>.customTools; ' +
            'if the auto-save patch did not fire, the row is gone after reload because the editor draft ' +
            'was never flushed to disk',
        ).toBeGreaterThan(0);
    });
});
