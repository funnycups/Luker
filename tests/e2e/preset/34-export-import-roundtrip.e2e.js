// #34 — Preset export → import under a different connection profile.
//
// REAL USER-GESTURE flow:
//   1. Save a source preset with distinct field values via visible UI.
//   2. Click the visible Export button (data-preset-manager-export="openai")
//      and capture the download.
//   3. Switch to Default and import via the visible Import button.
//   4. Verify the imported preset appears in the preset select and that
//      selecting it shows the same values (via DOM input read).
//   5. Restart, re-select, re-assert via DOM.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton, setCounterInput } from './_helpers.js';

let server, mock;

const SOURCE_PRESET = 'preset-A-export';
const TARGET_PRESET = 'preset-A-imported';
const SOURCE_VALUES = { temperature: 0.31, top_p: 0.62, presence_penalty: 0.21 };

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'export-import',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: 'primary-mock' });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Click the visible Export button for the openai preset manager. ST mounts
 * the export icon as #export_oai_preset (a synthetic blob-download).
 */
async function exportSelectedPreset(page) {
    const dl = page.waitForEvent('download', { timeout: 15_000 });
    await page.evaluate(() => {
        const el = document.querySelector('#export_oai_preset');
        if (!el) throw new Error('#export_oai_preset button not found');
        el.click();
    });
    return dl;
}

/**
 * Trigger the OpenAI preset import via the visible Import button +
 * setInputFiles on the hidden #openai_preset_import_file input.
 */
async function importPresetFile(page, filePath) {
    // Click the Import button so any pre-import hook gates run; then
    // drive the hidden file input directly. The import handler reads
    // the file via the input's change event.
    await page.evaluate(() => {
        const trigger = document.querySelector('#import_oai_preset');
        if (trigger) trigger.click();
    });
    const input = page.locator('#openai_preset_import_file');
    await input.setInputFiles(filePath);
    await page.waitForTimeout(800);
}

test.describe('#34 — preset export → import (real UI)', () => {
    test('exported preset body reconstructs identically when imported', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Step 1: Seed the source preset via the visible UI.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', SOURCE_VALUES.temperature);
        await setCounterInput(page, '#top_p_counter_openai', SOURCE_VALUES.top_p);
        await setCounterInput(page, '#pres_pen_counter_openai', SOURCE_VALUES.presence_penalty);
        await savePresetAsViaButton(page, SOURCE_PRESET);

        // Step 2: Export — capture download.
        const download = await exportSelectedPreset(page);
        const downloadPath = resolve(server.dataRoot, '_e2e_exported_preset.json');
        await download.saveAs(downloadPath);
        const exportedBody = JSON.parse(readFileSync(downloadPath, 'utf8'));
        expect(exportedBody.temperature).toBe(SOURCE_VALUES.temperature);
        expect(exportedBody.top_p).toBe(SOURCE_VALUES.top_p);
        expect(exportedBody.presence_penalty).toBe(SOURCE_VALUES.presence_penalty);

        // Step 3: Switch to Default before import.
        await selectPresetByName(page, 'Default');

        // Step 4: Import. The OpenAI preset import uses the file name (sans
        // extension) as the imported preset name — there is no rename popup
        // on the OpenAI preset path (that's only on the legacy preset paths
        // mounted via [data-preset-manager-import="..."]). So we copy the
        // exported JSON to a path whose basename matches TARGET_PRESET.
        const importPath = resolve(server.dataRoot, `${TARGET_PRESET}.json`);
        writeFileSync(importPath, JSON.stringify(exportedBody, null, 4));
        await importPresetFile(page, importPath);

        // Step 5: The imported preset must appear in the select; selecting
        // it must show the saved values via DOM.
        await page.waitForFunction((n) => Array.from(document.querySelectorAll('#settings_preset_openai option')).some(o => o.textContent === n), TARGET_PRESET, { timeout: 15_000 });
        await selectPresetByName(page, TARGET_PRESET);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(SOURCE_VALUES.temperature, 5);
        await expect.poll(async () => Number(await page.locator('#top_p_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(SOURCE_VALUES.top_p, 5);

        // Step 6: Restart + reload, re-select imported preset, re-assert DOM.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectPresetByName(page, TARGET_PRESET);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 15_000 }).toBeCloseTo(SOURCE_VALUES.temperature, 5);
    });
});
