// #125 — orchestrator preset switch persists across page reload
//
// Bug shape (user report): "I have two presets, I select the second one,
// then reload the page — it reverts to the first". The UI rebuilt its
// `<select>` from a stale snapshot before syncing from persisted settings.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Seed two spec presets ("default" active + secondary preset) before start.
//   2. Load app, open Workbench -> Orchestration -> Setup view.
//   3. Confirm `.ol-setup-bar select.ol-select` has both options and defaults to `global:default`.
//   4. Select `global:secondary-spec-preset` via `selectOrchPreset`.
//   5. Verify settings.json on disk updates `activePresetIds.spec`.
//   6. Reload page + reopen Workbench -> Orchestration -> Setup view.
//   7. Verify `.ol-setup-bar select.ol-select` value is STILL `global:secondary-spec-preset`
//      and settings.json on disk still holds `secondary-spec-preset`.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import {
    openOrchWorkspace,
    selectOrchPreset,
    setOrchMode,
} from '../_lib/ui-workbench.js';

let server;

const EXTRA_PRESET_ID = 'secondary-spec-preset';
const EXTRA_PRESET_NAME = 'Secondary spec preset';

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function seedTwoSpecPresets(dataRoot) {
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
    ext.activePresetIds.spec = 'default';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveSpecId(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    return s?.extension_settings?.orchestrator?.activePresetIds?.spec || '';
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

    test('switching spec preset via Setup <select> survives reload (UI and settings.json)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, 'spec');
        const lens = await openOrchWorkspace(page, 'setup');

        const specSelector = lens.locator('.ol-setup-bar select.ol-select').first();
        await expect(specSelector).toBeVisible({ timeout: 10_000 });

        await expect.poll(async () => await specSelector.inputValue()).toBe('global:default');
        const optionsBefore = await specSelector.evaluate(el => Array.from(el.options).map(o => o.value));
        expect(optionsBefore).toContain(`global:${EXTRA_PRESET_ID}`);
        expect(optionsBefore).toContain('global:default');

        // Real UI action: pick the second preset via Setup <select>.
        await selectOrchPreset(page, EXTRA_PRESET_ID, { scope: 'global' });
        await expect(specSelector).toHaveValue(`global:${EXTRA_PRESET_ID}`, { timeout: 10_000 });

        // On-disk: settings.json must reflect the switch.
        await expect.poll(() => readActiveSpecId(server.dataRoot), { timeout: 10_000 }).toBe(EXTRA_PRESET_ID);

        // Reload the page.
        await reloadAndAwait(page, server.baseURL);
        const lensAfter = await openOrchWorkspace(page, 'setup');
        const specSelectorAfter = lensAfter.locator('.ol-setup-bar select.ol-select').first();
        await expect(specSelectorAfter).toBeVisible({ timeout: 10_000 });

        await expect(specSelectorAfter,
            'preset selector must render with the previously-chosen preset selected after reload',
        ).toHaveValue(`global:${EXTRA_PRESET_ID}`);

        expect(readActiveSpecId(server.dataRoot)).toBe(EXTRA_PRESET_ID);
    });
});
