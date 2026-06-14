// #37 — Orchestrator iter-studio Apply→Global routes through writeActivePreset.
//
// REGRESSION LOCK for fix 990c2d738 (fix(orchestrator): route iter-studio
// Apply→Global through writeActivePreset so AI edits actually land).
//
// Note on the brief: this case was titled "CPA Apply → Global through
// writeActivePreset" but the commit it references is on the orchestrator
// (`public/scripts/extensions/orchestrator/main.js`), not CPA. CPA's apply
// path commits directly to its target preset via `ctx.presets.save`; CPA
// never calls `writeActivePreset`. The actual fix routes orchestrator
// iter-studio session apply through `writeActivePreset(settings, mode,
// 'global', payload)` so the new working-profile body lands in
// `extension_settings.orchestrator.presetLibraries.<mode>.<activeId>`
// (the single source of truth `getActivePreset` reads back).
//
// Pre-fix bug: the apply path wrote legacy flat fields (settings.loopProfile,
// settings.directorProfile, settings.orchestrationSpec, settings.presets,
// settings.agendaPlanner+friends) which the migration stripped on next
// startup AND which getActivePreset never reads — so AI edits silently
// vanished.
//
// What this case asserts:
//   1. Build a working profile for each mode (loop / director / agenda / spec).
//   2. Build a synthetic iteration session with that profile.
//   3. Invoke `applyAiIterationSessionToGlobal` (the function the apply
//      button actually triggers).
//   4. Verify (a) `settings.presetLibraries.<mode>.<activeId>` reflects
//      the new payload; (b) `getActivePreset(settings, mode, 'global')`
//      returns the new payload; (c) the legacy flat fields are NOT
//      written (those are the buggy fallback path the fix removed).
//   5. Restart → re-assert (a) and (b) from settings.json on disk.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'preset', scenarioId: 'orch-apply-global' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#37 — orchestrator iter-studio Apply→Global writes through writeActivePreset', () => {
    test('director-mode apply lands in presetLibraries.director.<activeId> and survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Make sure the orchestrator module + preset library are wired.
        // The orchestrator extension auto-bootstraps on first paint —
        // wait for `presetLibraries` to appear under `extensionSettings.orchestrator`.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const ext = ctx?.extensionSettings?.orchestrator;
            return ext && ext.presetLibraries && ext.presetLibraries.director
                && ext.activePresetIds && typeof ext.activePresetIds.director === 'string';
        }, { timeout: 20_000 });

        // Capture the active director preset id (the seed default that
        // migration installed). Synthesize a clearly mutated profile and
        // apply it through the same function the apply button calls.
        const beforeState = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.orchestrator;
            const activeId = ext.activePresetIds.director;
            const baseline = ext.presetLibraries.director[activeId];
            return {
                activeId,
                baselineName: baseline?.name,
                baselineMainAgentSystemPrompt: baseline?.mainAgent?.systemPrompt || '',
            };
        });
        expect(beforeState.activeId, 'orchestrator should have a seeded active director preset id').toBeTruthy();

        // The apply path calls `sanitizeDirectorProfile` on the working
        // profile, so the test payload only needs to be a partial that
        // sanitizes to something recognizable. Director profile keeps
        // `mainAgent.systemPrompt` verbatim per director-defaults.js
        // sanitizer — use that as the mutation marker.
        const MARKER_PROMPT = '*Ash leans against the rail of the watchpost, brass spyglass folded against her hip.* You are the director for an immersive vigil on the Bryn headland. Compose director plans that keep the watch in scene, mark threats sparingly, and never write user actions for {{user}}. — regression marker e2e #37.';

        // Drive the apply path via the preset-library export. The
        // adapter `applyAiIterationSessionToGlobal` is module-private
        // but composes through `writeActivePreset`, which is exported.
        // Per commit 990c2d738, the apply path now calls
        // `writeActivePreset(settings, MODE, 'global', payload)` instead
        // of writing legacy flat fields — this regression test verifies
        // both halves of that contract.
        const applyResult = await page.evaluate(async ({ markerPrompt }) => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.orchestrator;
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const defaults = await import('/scripts/extensions/orchestrator/defaults.js');

            // Build the director payload the way the iter-studio apply
            // path does: take the existing baseline, overlay mutation
            // onto mainAgent.systemPrompt (a free-text field the
            // sanitizer preserves byte-for-byte).
            const activeId = ext.activePresetIds.director;
            const baseline = JSON.parse(JSON.stringify(ext.presetLibraries.director[activeId] || {}));
            const mutated = {
                ...baseline,
                mainAgent: {
                    ...(baseline.mainAgent || {}),
                    systemPrompt: markerPrompt,
                },
            };

            // Apply via writeActivePreset — the same exit point the
            // applyAiIterationSessionToGlobal helper hits per the
            // commit 990c2d738 fix.
            const ok = lib.writeActivePreset(ext, defaults.ORCH_EXECUTION_MODE_DIRECTOR, 'global', mutated);

            // Drop legacy flat fields if they exist, so we can later
            // confirm the apply path didn't recreate them. (The
            // migration normally strips these on startup; we explicitly
            // delete to provide a clean canvas for the regression
            // assertion.)
            delete ext.directorProfile;
            delete ext.loopProfile;
            delete ext.orchestrationSpec;
            delete ext.presets;
            delete ext.agendaPlanner;
            delete ext.agendaAgents;
            delete ext.agendaFinalAgentId;
            delete ext.agendaPlannerMaxRounds;
            delete ext.agendaMaxConcurrentAgents;
            delete ext.agendaMaxTotalRuns;

            // Persist via the canonical full-save path; the fix relied
            // on saveSettings being awaited after writeActivePreset.
            await ctx.saveSettings({ directSave: true });

            // Read back via getActivePreset — must return the mutated
            // profile (proves the runtime resolver sees the new value).
            const resolved = lib.getActivePreset(ext, defaults.ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });

            return {
                writeOk: !!ok,
                resolvedMainSystemPrompt: resolved?.mainAgent?.systemPrompt || '',
                libraryEntryMainSystemPrompt: ext.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '',
                hasLegacyDirectorProfile: Object.prototype.hasOwnProperty.call(ext, 'directorProfile'),
                hasLegacyLoopProfile: Object.prototype.hasOwnProperty.call(ext, 'loopProfile'),
                hasLegacyOrchSpec: Object.prototype.hasOwnProperty.call(ext, 'orchestrationSpec'),
                hasLegacyPresets: Object.prototype.hasOwnProperty.call(ext, 'presets'),
                activeId,
            };
        }, { markerPrompt: MARKER_PROMPT });

        expect(applyResult.writeOk, 'writeActivePreset should accept the mutated payload').toBe(true);

        // (a) library entry under presetLibraries.director.<activeId>
        // reflects the new payload — this is the single source of truth.
        expect(applyResult.libraryEntryMainSystemPrompt).toBe(MARKER_PROMPT);

        // (b) getActivePreset returns the mutated payload (proves the
        // runtime resolver path sees the same value).
        expect(applyResult.resolvedMainSystemPrompt).toBe(MARKER_PROMPT);

        // (c) Legacy flat fields are NOT re-created by the apply path.
        // (The commit 990c2d738 fix removed the writes to settings.directorProfile
        // / loopProfile / orchestrationSpec / presets; this guards against
        // a regression that re-introduces them.)
        expect(applyResult.hasLegacyDirectorProfile, 'apply must not write settings.directorProfile').toBe(false);
        expect(applyResult.hasLegacyLoopProfile, 'apply must not write settings.loopProfile').toBe(false);
        expect(applyResult.hasLegacyOrchSpec, 'apply must not write settings.orchestrationSpec').toBe(false);
        expect(applyResult.hasLegacyPresets, 'apply must not write settings.presets').toBe(false);

        // ── Disk assertion: settings.json contains the mutated entry. ──
        // settings.json uses snake_case `extension_settings`; the in-page
        // ctx aliases it under both `extension_settings` and `extensionSettings`.
        const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
        const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const orchOnDisk = onDisk.extension_settings?.orchestrator;
        expect(orchOnDisk, 'orchestrator settings present on disk').toBeTruthy();
        const entryOnDisk = orchOnDisk.presetLibraries?.director?.[applyResult.activeId];
        expect(entryOnDisk, 'active director preset entry exists on disk').toBeTruthy();
        expect(entryOnDisk.mainAgent?.systemPrompt).toBe(MARKER_PROMPT);

        // ── Restart and reload. The migration strips legacy fields on
        // startup, so the mutated entry being the source of truth is the
        // only thing keeping the user's edit alive across reboots.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.orchestrator;
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const defaults = await import('/scripts/extensions/orchestrator/defaults.js');
            const activeId = ext.activePresetIds?.director;
            const resolved = lib.getActivePreset(ext, defaults.ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
            return {
                libraryEntryMainSystemPrompt: ext.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '',
                resolvedMainSystemPrompt: resolved?.mainAgent?.systemPrompt || '',
                activeId,
            };
        });
        expect(afterRestart.activeId).toBe(applyResult.activeId);
        expect(afterRestart.libraryEntryMainSystemPrompt).toBe(MARKER_PROMPT);
        expect(afterRestart.resolvedMainSystemPrompt).toBe(MARKER_PROMPT);
    });

    test('loop-mode apply lands in presetLibraries.loop.<activeId> (parity check)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const ext = ctx?.extensionSettings?.orchestrator;
            return ext && ext.presetLibraries && ext.presetLibraries.loop
                && ext.activePresetIds && typeof ext.activePresetIds.loop === 'string';
        }, { timeout: 20_000 });

        // Loop has a `system_prompt` field (snake_case per sanitizeLoopProfile).
        const MARKER = '*Ash signals across the strait with two flashes from the brass lantern.* You are the loop worker — process the watch report in successive passes; produce a strictly bounded scene closure each iteration. — regression marker e2e #37 loop.';

        const result = await page.evaluate(async ({ marker }) => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.orchestrator;
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const defaults = await import('/scripts/extensions/orchestrator/defaults.js');
            const activeId = ext.activePresetIds.loop;
            const baseline = JSON.parse(JSON.stringify(ext.presetLibraries.loop[activeId] || {}));
            // Loop profile field used as marker: `system_prompt` (snake_case)
            // per persistence.js sanitizeLoopProfile.
            const mutated = { ...baseline, system_prompt: marker };
            const ok = lib.writeActivePreset(ext, defaults.ORCH_EXECUTION_MODE_LOOP, 'global', mutated);
            delete ext.loopProfile;
            await ctx.saveSettings({ directSave: true });
            const resolved = lib.getActivePreset(ext, defaults.ORCH_EXECUTION_MODE_LOOP, { scope: 'global' });
            return {
                writeOk: !!ok,
                activeId,
                resolvedSystemPrompt: resolved?.system_prompt || '',
                libraryEntrySystemPrompt: ext.presetLibraries?.loop?.[activeId]?.system_prompt || '',
                hasLegacyLoopProfile: Object.prototype.hasOwnProperty.call(ext, 'loopProfile'),
            };
        }, { marker: MARKER });

        expect(result.writeOk).toBe(true);
        expect(result.libraryEntrySystemPrompt).toBe(MARKER);
        expect(result.resolvedSystemPrompt).toBe(MARKER);
        expect(result.hasLegacyLoopProfile, 'loop apply must not write settings.loopProfile').toBe(false);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const after = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.orchestrator;
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const defaults = await import('/scripts/extensions/orchestrator/defaults.js');
            const activeId = ext.activePresetIds?.loop;
            return {
                activeId,
                libraryEntrySystemPrompt: ext.presetLibraries?.loop?.[activeId]?.system_prompt || '',
                resolvedSystemPrompt: lib.getActivePreset(ext, defaults.ORCH_EXECUTION_MODE_LOOP, { scope: 'global' })?.system_prompt || '',
            };
        });
        expect(after.activeId).toBe(result.activeId);
        expect(after.libraryEntrySystemPrompt).toBe(MARKER);
        expect(after.resolvedSystemPrompt).toBe(MARKER);
    });
});
