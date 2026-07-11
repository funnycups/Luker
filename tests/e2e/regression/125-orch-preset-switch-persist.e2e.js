// #125 — orchestrator preset switch persists across page reload
//
// Bug shape (user report): "I have two presets, I select the second one,
// then reload the page — it reverts to the first". The change handler
// (main.js `[data-luker-preset-select]` change delegate) calls
// `setActivePresetId` (which mutates `settings.activePresetIds[mode]` in
// place) followed by `await saveSettings()` for global scope. On reload,
// the drawer's `buildOrchestratorSettingsHtml` runs BEFORE
// `initializeUiState`, so `presetBarPropsFor` reads a stale
// `uiState.globalActivePresetIds.spec === ''` and emits `<select>` with
// no `selected` `<option>` — the browser defaults to the first option,
// giving the false impression that the switch never persisted.
//
// Fix: `renderDynamicPanels` now calls `refreshPresetSelectorBars` at
// its tail, which re-runs `initializeUiState` + rebuilds each
// `<select>` from `settings.activePresetIds`, restoring the correct
// selection after first paint.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer.
//   2. Confirm at least two presets exist for the current mode
//      (`spec` has `default` + one extra seeded here).
//   3. Switch the preset selector to the second preset via a real
//      `<select>.selectOption` + change dispatch.
//   4. Verify in-memory `settings.activePresetIds.spec` updated.
//   5. Reload page + reopen drawer.
//   6. Verify the `<select value>` reflects the SECOND preset — not
//      the first (the bug's symptom).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server;

const EXTRA_PRESET_ID = 'secondary-spec-preset';
const EXTRA_PRESET_NAME = 'Secondary spec preset';

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function seedTwoSpecPresets(dataRoot) {
    // Ensure the settings.json exposes two spec-mode preset library
    // entries so we have something meaningful to switch between. The
    // factory default seeder creates only one entry ("default"), so we
    // stamp a second one directly on disk before the server first reads
    // the file. Keeping the shape minimal (matching sanitizeSpec's
    // idempotent output) means preset-library's read-side sanitizer
    // accepts the seed without normalization drift.
    const sp = settingsJsonPath(dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    const ext = s.extension_settings.orchestrator;
    ext.enabled = true;
    ext.executionMode = 'spec';
    ext.presetLibrariesMigrationDone = 1;
    ext.presetLibraries = ext.presetLibraries || { spec: {}, agenda: {}, loop: {}, director: {} };
    ext.presetLibraries.spec = ext.presetLibraries.spec || {};
    // Factory default (mirrors what the factory seeder would build so
    // the "first" preset resolves consistently across runs).
    if (!ext.presetLibraries.spec.default) {
        ext.presetLibraries.spec.default = {
            name: 'Default',
            stages: [{ mode: 'parallel', nodes: [] }],
            skills: { visible: ['*'], deny: [] },
        };
    }
    ext.presetLibraries.spec[EXTRA_PRESET_ID] = {
        name: EXTRA_PRESET_NAME,
        stages: [{ mode: 'parallel', nodes: [] }],
        skills: { visible: ['*'], deny: [] },
    };
    ext.activePresetIds = ext.activePresetIds || { spec: '', agenda: '', loop: '', director: '' };
    // Start with the FIRST preset active — this is the state the user
    // sees when they open the drawer before switching.
    ext.activePresetIds.spec = 'default';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveSpecId(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    return s?.extension_settings?.orchestrator?.activePresetIds?.spec || '';
}

async function openOrchDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'spec') {
        await modeSelect.selectOption('spec');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    // The drawer opens on the Agents tab by default; switch to General
    // so the preset selector bar is interactable. The user's real
    // workflow starts with them clicking the preset dropdown from the
    // General tab, so this mirrors the reported path.
    const generalTabButton = page.locator('button[data-luker-tabs-target="luker_orch_tabs"][data-luker-tab-key="general"]');
    if (await generalTabButton.count()) await generalTabButton.first().click();
}

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'regression',
        scenarioId: '125-orch-preset-switch-persist',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    seedTwoSpecPresets(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#125 — orchestrator preset switch persists across page reload', () => {
    test.setTimeout(90_000);

    test('switching spec preset via <select> change survives F5 (drawer and settings.json)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawer(page);

        // Locate this orchestrator-mode preset selector inside the drawer.
        // Its General-tab bar wrapper is `[data-luker-preset-bar-host="spec"]`
        // (Bug A fix's stable anchor). Inside it lives the actual
        // `[data-luker-preset-select][data-mode="spec"]` element.
        //
        // Use `attached` (not `visible`) — the drawer opens on the
        // Agents tab by default so General-tab elements have a `hidden`
        // ancestor. `.value` / `.selectOption` / `.evaluate` all work
        // through `hidden`, and forcing visibility would require an
        // extra tab-switch click that isn't part of the user story
        // being tested (user reload → drawer opens → preset selector
        // shows previously-chosen value).
        const specSelector = page.locator(
            '[data-luker-preset-bar-host="spec"] [data-luker-preset-select][data-mode="spec"]',
        );
        await specSelector.waitFor({ state: 'attached', timeout: 10_000 });

        // Sanity: two <option>s exist and the initial selected is `default`.
        await expect.poll(async () => await specSelector.evaluate(el => el.value)).toBe('default');
        const optionsBefore = await specSelector.evaluate(el => Array.from(el.options).map(o => o.value));
        expect(optionsBefore).toContain(EXTRA_PRESET_ID);
        expect(optionsBefore).toContain('default');

        // Real UI action: pick the second preset and fire change.
        await specSelector.selectOption(EXTRA_PRESET_ID);
        await specSelector.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });

        // In-memory: settings.activePresetIds.spec must reflect the switch.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return ctx.extensionSettings.orchestrator?.activePresetIds?.spec || '';
            });
        }, { timeout: 10_000 }).toBe(EXTRA_PRESET_ID);

        // On-disk: settings.json must reflect it too (saveSettings landed).
        await expect.poll(() => readActiveSpecId(server.dataRoot), { timeout: 10_000 }).toBe(EXTRA_PRESET_ID);

        // The load-bearing leg: F5 the whole page.
        await reloadAndAwait(page, server.baseURL);
        await openOrchDrawer(page);

        // After reload, the drawer's preset selector must still show
        // the SECOND preset — this is the exact user-reported symptom
        // ("刷新页面又变回第一个了"). Reading `.value` from the
        // `<select>` (not just settings.json) proves the UI itself
        // renders the correct selected `<option>`, catching the
        // build-html-before-initializeUiState race that the fix
        // resolves.
        const specSelectorAfter = page.locator(
            '[data-luker-preset-bar-host="spec"] [data-luker-preset-select][data-mode="spec"]',
        );
        await specSelectorAfter.waitFor({ state: 'attached', timeout: 10_000 });

        expect(await specSelectorAfter.evaluate(el => el.value),
            'preset selector must render with the previously-chosen preset selected after reload; ' +
            'if it shows "default" the drawer built its <select> from a stale uiState snapshot ' +
            'before initializeUiState synced from persisted settings',
        ).toBe(EXTRA_PRESET_ID);

        // Disk-side re-verify: settings.json must still carry the switch.
        expect(readActiveSpecId(server.dataRoot)).toBe(EXTRA_PRESET_ID);
    });
});
