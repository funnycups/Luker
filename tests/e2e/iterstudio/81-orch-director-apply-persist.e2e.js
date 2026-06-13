// #81 — Orchestrator iter-studio: Apply director profile → persists across restart.
//
// Story:
//   1. Open Orchestrator iter-studio (Extensions drawer → Orchestrator
//      drawer → "Open AI Iteration Studio" for the active mode).
//   2. The director's profile lives under
//      `extension_settings.orchestrator.presetLibraries.director.<activeId>`,
//      written via `writeActivePreset(settings, 'director', 'global', payload)`
//      then `saveSettings()`. iter-studio's Apply-to-Global path
//      (`applyAiIterationSessionToGlobal`) does exactly this — see
//      `orchestrator/main.js#applyAiIterationSessionToGlobal` and
//      `orchestrator/editor-persist.js`.
//   3. Drive the canonical apply path with a mutated director main agent
//      systemPrompt. Verify:
//        - In-memory active director preset has the new systemPrompt.
//        - settings.json reflects the new payload at the active preset id.
//        - After restart + reload, the change still loads.
//
// We mutate via the canonical writeActivePreset + saveSettings — the same
// path the iter-studio Apply button uses. Bypassing the LLM round means
// we don't have to script a coherent tool-call protocol for the mock
// (covered in IterWorkspaceSplit smoke), but we do exercise the studio
// shell mount + the canonical disk write path that's the regression
// target of commit 990c2d738 (memory `feedback_api_design_parity`).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

const NEW_DIRECTOR_PROMPT = '*You are Ash, the cartographer-narrator of the Bryn headland.* '
    + 'Hold the in-scene voice. Frame each scene through the reef chart you carry — '
    + 'no third-wall asides, no meta. End every turn with a tactile beat: the brine on the rail, '
    + 'the verdigris of the spyglass, the cold of the lantern\'s bezel.';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash adjusts the chart and considers your direction.*'] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '81-orch-director-apply' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

function settingsPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function readActiveDirectorPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.director || '';
    const lib = ext.presetLibraries?.director || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.describe('#81 — Orchestrator iter-studio Apply → director profile persists across restart', () => {
    test('Apply writes director.mainAgent.systemPrompt to active preset; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Enable orchestrator + director mode so the studio button surfaces
        // for the right mode.
        await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const s = ctx.extensionSettings?.orchestrator;
            if (!s) throw new Error('orchestrator settings missing');
            s.enabled = true;
            s.executionMode = 'director';
            if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
            else if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        });

        // Open the orchestrator inline drawer + the iter-studio popup.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'orchestrator_settings');

        // Pick the visible "Open AI Iteration Studio" button — there are
        // four per-mode boards but only the active one is visible.
        const openBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
        await expect(openBtn).toBeVisible({ timeout: 10_000 });
        await openBtn.click();
        const popup = page.locator('.orch_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15_000 });

        // Apply via the canonical write path. We import the preset-library
        // module directly (it's plain ESM, no plugin scaffolding) so we
        // can call writeActivePreset() exactly as applyAiIterationSessionToGlobal
        // does in production.
        const applyResult = await page.evaluate(async (newPrompt) => {
            const ctx = window.SillyTavern.getContext();
            const presetLib = await import(
                '/scripts/extensions/orchestrator/preset-library.js'
            );
            const s = ctx.extensionSettings.orchestrator;
            if (!s) return { ok: false, reason: 'orch settings missing' };
            // Read current active director preset, mutate systemPrompt, write back.
            const current = presetLib.getActivePreset(s, 'director', { scope: 'global' });
            if (!current) return { ok: false, reason: 'no active director preset' };
            // Build a payload mirroring what sanitizeDirectorProfile +
            // applyAiIterationSessionToGlobal produces: spread the current,
            // overlay the new mainAgent.systemPrompt.
            const payload = {
                ...current,
                mainAgent: {
                    ...(current.mainAgent || {}),
                    systemPrompt: newPrompt,
                },
            };
            const ok = presetLib.writeActivePreset(s, 'director', 'global', payload);
            if (!ok) return { ok: false, reason: 'writeActivePreset returned false' };
            // saveSettings flushes settings.json (the orchestrator extension
            // settings live under settings.extension_settings.orchestrator).
            if (typeof ctx.saveSettings === 'function') {
                await ctx.saveSettings();
            } else if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
            // Read back so the caller can confirm the in-memory shape.
            const after = presetLib.getActivePreset(s, 'director', { scope: 'global' });
            return {
                ok: true,
                wroteSystemPrompt: String(after?.mainAgent?.systemPrompt || ''),
                activeId: s.activePresetIds?.director || '',
            };
        }, NEW_DIRECTOR_PROMPT);

        expect(applyResult.ok, applyResult.reason).toBe(true);
        expect(applyResult.wroteSystemPrompt).toBe(NEW_DIRECTOR_PROMPT);

        // Disk: poll for the settings.json flush.
        await expect.poll(() => {
            const entry = readActiveDirectorPreset(server.dataRoot);
            return entry?.mainAgent?.systemPrompt || '';
        }, { timeout: 10_000 }).toBe(NEW_DIRECTOR_PROMPT);

        await page.keyboard.press('Escape');

        // Restart, reload, re-assert.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestartDisk = readActiveDirectorPreset(server.dataRoot);
        expect(afterRestartDisk, 'no active director preset after restart').toBeTruthy();
        expect(afterRestartDisk.mainAgent?.systemPrompt).toBe(NEW_DIRECTOR_PROMPT);

        // In-memory: orchestrator preset library still has the new prompt.
        const inMem = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const presetLib = await import(
                '/scripts/extensions/orchestrator/preset-library.js'
            );
            const s = ctx.extensionSettings.orchestrator;
            const active = presetLib.getActivePreset(s, 'director', { scope: 'global' });
            return String(active?.mainAgent?.systemPrompt || '');
        });
        expect(inMem).toBe(NEW_DIRECTOR_PROMPT);
    });
});
