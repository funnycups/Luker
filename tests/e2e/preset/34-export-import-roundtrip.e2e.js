// #34 — Preset export → import under a different connection profile.
//
// Save preset-A under one connection profile, export its body via the
// preset manager, switch the connection profile to a different custom
// URL, import the exported body back as a new preset, and verify every
// field round-tripped 1:1.
//
// Persistence: restart and re-verify the imported preset is still on
// disk with the same body.
//
// What's exercised:
//   - `getPresetManager('openai').savePreset(name, body)`
//   - `getPresetManager('openai').getCompletionPresetByName(name)` (export)
//   - connection-manager profile switch (live UI)
//   - `getPresetManager('openai').savePreset(newName, exportedBody)` (import)
//   - on-disk preset file under `default-user/OpenAI Settings/<name>.json`

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mockPrimary, mockSecondary;

const SOURCE_PRESET = 'preset-A-export';
const TARGET_PRESET = 'preset-A-imported';

// Use distinct, non-default values so a stale Default body would be
// instantly visible. Hold to fields we know the OpenAI preset manager
// preserves cleanly (temperature/top_p/frequency_penalty/main prompt).
const SOURCE_VALUES = {
    temperature: 0.31,
    top_p: 0.62,
    frequency_penalty: 0.17,
    presence_penalty: 0.21,
    mainPromptContent: '*Ash unrolls the chart and runs a thumb across the reef line.* You and {{char}} are watching the night reef from the headland. Stay in scene. Reply with two or three immersive paragraphs unless asked OOC.',
};

test.beforeAll(async () => {
    mockPrimary = await startMockLLM({ scriptedReplies: [
        '*Seraphina shakes salt-spray from her sleeve.* The chart still holds.',
    ] });
    mockSecondary = await startMockLLM({ scriptedReplies: [
        '*Seraphina lifts the lantern higher.* That second profile reads clean.',
    ] });
    server = await startServer({ batchKey: 'preset', scenarioId: 'export-import' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mockPrimary.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mockPrimary.baseURL, name: 'primary-mock' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mockPrimary?.stop();
    await mockSecondary?.stop();
});

test.describe('#34 — preset export → import (under different connection profile)', () => {
    test('exported preset body reconstructs identically when imported under a new profile', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // ── Step 1: Seed the source preset under the primary profile ────
        await page.evaluate(async (vals) => {
            const ctx = window.Luker.getContext();
            const oai = ctx.chatCompletionSettings;
            oai.temperature = vals.temperature;
            oai.top_p = vals.top_p;
            oai.frequency_penalty = vals.frequency_penalty;
            oai.presence_penalty = vals.presence_penalty;
            if (Array.isArray(oai.prompts)) {
                const main = oai.prompts.find(p => p?.identifier === 'main');
                if (main) main.content = vals.mainPromptContent;
            }
        }, SOURCE_VALUES);

        const saveResult = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            await mgr.savePreset(name, ctx.chatCompletionSettings);
            return true;
        }, SOURCE_PRESET);
        expect(saveResult).toBe(true);

        // Wait for source preset option to register.
        await page.waitForFunction((name) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            return opts.some(o => o.textContent === name);
        }, SOURCE_PRESET, { timeout: 5000 });

        // ── Step 2: "Export" — read the stored body the same way the
        // export-to-file path does. The preset manager keeps the
        // canonical in-memory copy under `openai_settings[i]`, which
        // `getCompletionPresetByName` exposes verbatim.
        const exportedBody = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return body ? JSON.parse(JSON.stringify(body)) : null;
        }, SOURCE_PRESET);
        expect(exportedBody, 'exported body should exist').toBeTruthy();
        expect(exportedBody.temperature).toBe(SOURCE_VALUES.temperature);
        expect(exportedBody.top_p).toBe(SOURCE_VALUES.top_p);
        expect(exportedBody.frequency_penalty).toBe(SOURCE_VALUES.frequency_penalty);
        expect(exportedBody.presence_penalty).toBe(SOURCE_VALUES.presence_penalty);
        const mainPromptInExport = (exportedBody.prompts || []).find(p => p?.identifier === 'main');
        expect(mainPromptInExport?.content).toBe(SOURCE_VALUES.mainPromptContent);

        // ── Step 3: Switch the custom URL to point at the secondary mock.
        // This is the "different connection profile" gate — the import
        // happens with a different backend in scope, but the saved
        // preset body must NOT have stale `custom_url` baked in (the
        // preset manager strips connection-coupled fields on save).
        await page.evaluate(async (url) => {
            const ctx = window.Luker.getContext();
            ctx.chatCompletionSettings.custom_url = url;
            // Persist the runtime change so it survives in case the
            // savePreset path reads from disk for diff purposes.
            await ctx.saveSettings({ directSave: true });
        }, mockSecondary.baseURL);

        // ── Step 4: Import — save the exported body under a fresh name.
        const importOk = await page.evaluate(async ({ name, body }) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            try {
                await mgr.savePreset(name, body);
                return { ok: true };
            } catch (err) {
                return { ok: false, reason: String(err?.message || err) };
            }
        }, { name: TARGET_PRESET, body: exportedBody });
        expect(importOk.ok, `import failed: ${importOk.reason || ''}`).toBe(true);

        await page.waitForFunction((name) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            return opts.some(o => o.textContent === name);
        }, TARGET_PRESET, { timeout: 5000 });

        // Read back the imported preset body and assert field equality.
        const importedBody = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            return mgr.getCompletionPresetByName(name);
        }, TARGET_PRESET);
        expect(importedBody).toBeTruthy();
        expect(importedBody.temperature).toBe(SOURCE_VALUES.temperature);
        expect(importedBody.top_p).toBe(SOURCE_VALUES.top_p);
        expect(importedBody.frequency_penalty).toBe(SOURCE_VALUES.frequency_penalty);
        expect(importedBody.presence_penalty).toBe(SOURCE_VALUES.presence_penalty);
        const mainPromptImported = (importedBody.prompts || []).find(p => p?.identifier === 'main');
        expect(mainPromptImported?.content).toBe(SOURCE_VALUES.mainPromptContent);

        // ── Step 5: On-disk persistence — the imported preset must
        // appear as its own JSON file under default-user/OpenAI Settings.
        const presetDir = resolve(server.dataRoot, 'default-user', 'OpenAI Settings');
        const importedPath = resolve(presetDir, `${TARGET_PRESET}.json`);
        expect(existsSync(importedPath), `expected ${importedPath} to exist on disk`).toBe(true);
        const diskBody = JSON.parse(readFileSync(importedPath, 'utf8'));
        expect(diskBody.temperature).toBe(SOURCE_VALUES.temperature);
        expect(diskBody.top_p).toBe(SOURCE_VALUES.top_p);
        expect(diskBody.frequency_penalty).toBe(SOURCE_VALUES.frequency_penalty);
        const mainDisk = (diskBody.prompts || []).find(p => p?.identifier === 'main');
        expect(mainDisk?.content).toBe(SOURCE_VALUES.mainPromptContent);

        // ── Step 6: Restart and re-verify the imported preset still loads.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const reloaded = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            return mgr.getCompletionPresetByName(name);
        }, TARGET_PRESET);
        expect(reloaded, 'imported preset survived restart').toBeTruthy();
        expect(reloaded.temperature).toBe(SOURCE_VALUES.temperature);
        expect(reloaded.top_p).toBe(SOURCE_VALUES.top_p);
        expect(reloaded.frequency_penalty).toBe(SOURCE_VALUES.frequency_penalty);
        const mainReloaded = (reloaded.prompts || []).find(p => p?.identifier === 'main');
        expect(mainReloaded?.content).toBe(SOURCE_VALUES.mainPromptContent);
    });
});
