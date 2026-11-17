// #121 — orchestrator customTools[] auto-save via narrow persisted patch
//
// Bug shape: the 5 custom-tool handlers (add / import-defaults / edit /
// duplicate / remove) previously mutated editor.customTools[] in memory but
// did not persist until Save.
//
// Fix: `presets.saveCustomTools(...)` -> `persistCustomToolsPatch(...)` narrow-patches
// customTools right after each action, keeping other draft state untouched.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Load app, open Workbench -> Orchestration, switch mode to loop, enable.
//   2. Open Setup view.
//   3. In the Custom tools section, click Add, fill name + description, click OK.
//   4. Verify the new custom tool row appears and persists in settings.json on disk.
//   5. WITHOUT clicking any `.ol-savebar` Save button, reload the page.
//   6. Re-open Workbench -> Orchestration -> Setup view -> verify the custom tool row
//      is still present.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
} from '../_lib/ui-workbench.js';

let server;

const NEW_TOOL_NAME = 'regression_121_marker_tool';
const NEW_TOOL_DESC = 'REGRESSION-121 marker: this tool must survive reload without an explicit Save click.';

function readPersistedLoopCustomToolNames(dataRoot) {
    const raw = readFileSync(resolve(dataRoot, 'default-user', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    const ext = settings?.extension_settings?.orchestrator;
    const activeId = ext?.activePresetIds?.loop || 'default';
    const tools = ext?.presetLibraries?.loop?.[activeId]?.customTools;
    return Array.isArray(tools) ? tools.map(t => t?.name || '') : [];
}

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '121-orch-ct-auto-save', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openLoopSetup(page) {
    await setOrchMode(page, 'loop');
    await setOrchEnabled(page, true);
    return openOrchWorkspace(page, 'setup');
}

async function addCustomToolViaSetup(page, lens, { name, description }) {
    const section = lens.locator('section.ol-setup-section').filter({
        has: page.locator('.lw-sec-title > span', { hasText: /^Custom tools$/i }),
    }).first();
    await expect(section).toBeVisible({ timeout: 10_000 });

    const addBtn = section.locator('.lw-sec-title button').filter({ hasText: /^Add$/i }).first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    const editor = page.locator('dialog.popup[open]:has(.luker_orch_ct_editor), .popup:visible:has(.luker_orch_ct_editor)').last();
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.locator('[data-orch-ct-name]').fill(name);
    await editor.locator('[data-orch-ct-description]').fill(description);
    await editor.locator('.popup-button-ok').first().click();
    await editor.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    await expect(section.locator('.ol-setup-row .ol-setup-name', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test.describe('#121 — orchestrator customTools[] auto-save', () => {
    test.setTimeout(120_000);

    test('adding a custom tool persists across reload without clicking Save', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const lens = await openLoopSetup(page);

        await addCustomToolViaSetup(page, lens, { name: NEW_TOOL_NAME, description: NEW_TOOL_DESC });

        await expect.poll(
            () => readPersistedLoopCustomToolNames(server.dataRoot),
            { message: 'persistCustomToolsPatch must flush custom tool to settings.json', timeout: 10_000 },
        ).toContain(NEW_TOOL_NAME);

        // Reload — load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        const lensAfter = await openLoopSetup(page);

        const sectionAfter = lensAfter.locator('section.ol-setup-section').filter({
            has: page.locator('.lw-sec-title > span', { hasText: /^Custom tools$/i }),
        }).first();
        const rowAfter = sectionAfter.locator('.ol-setup-row').filter({
            has: page.locator('.ol-setup-name', { hasText: NEW_TOOL_NAME }),
        });
        await expect(rowAfter.first()).toBeVisible({ timeout: 10_000 });
    });
});
