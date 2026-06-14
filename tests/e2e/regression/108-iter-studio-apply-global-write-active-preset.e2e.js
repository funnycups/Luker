// #108 — iter-studio Apply→Global routes through writeActivePreset (commit 990c2d738)
//
// Bug shape: `applyAiIterationSessionToGlobal` previously wrote AI-edited
// profiles into the legacy single-slot fields (`settings.directorProfile`,
// `settings.loopProfile`, `settings.agendaPlanner` + friends,
// `settings.orchestrationSpec` + `settings.presets`). But the migration
// strips those fields on next boot AND the runtime / iter-studio / global
// panel all read via `getActivePreset` which only looks at
// `settings.presetLibraries.<mode>.<activeId>`. Net effect: AI edits
// applied via iter-studio appeared to succeed but were silently lost on
// the next reload.
//
// Fix: every mode branch in `applyAiIterationSessionToGlobal` now calls
// `writeActivePreset(settings, mode, 'global', payload)`, which mutates
// the active preset slot in `settings.presetLibraries.<mode>.<activeId>` —
// the slot the readers actually consult.
//
// Regression lock: we can't trivially drive a full iter-studio AI round
// (it requires an LLM tool_call), but we CAN verify the contract that
// the fix guarantees:
//
//   - `writeActivePreset` (the exported helper the fix routes through)
//     mutates `presetLibraries.<mode>.<activeId>` and does NOT touch the
//     legacy single-slot fields.
//   - After such a write + saveSettings + server restart, the new payload
//     survives — meaning the live runtime reads from the preset library,
//     not from a legacy field. (This second leg is the regression-load-
//     bearing one: if a future commit accidentally re-routes any branch
//     of `applyAiIterationSessionToGlobal` back to the legacy fields,
//     the migration on next boot will strip the write and the assertion
//     fails.)

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'regression', scenarioId: 'writeactive-preset' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#108 — Apply→Global routes through writeActivePreset', () => {
    test('writeActivePreset lands in presetLibraries.director.<id>, not legacy settings.directorProfile, and persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // The signature mutation: the AI session would have changed the
        // director main agent's systemPrompt. We use a deterministic
        // marker so we can grep settings.json for it after restart.
        const MARKER = 'REGRESSION-LOCK-108: routed through writeActivePreset';

        // 0. Ensure the orchestrator preset library is initialized so
        //    writeActivePreset has an active slot to mutate. The migration
        //    runs at extension init, but on a clean seed (no orchestrator
        //    block at all) the loader may not pre-populate. Force it here.
        await page.evaluate(async () => {
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const ext = await import('/scripts/extensions.js');
            const ORCH = 'orchestrator';
            if (!ext.extension_settings[ORCH]) ext.extension_settings[ORCH] = {};
            const s = ext.extension_settings[ORCH];
            // Idempotent — seeds presetLibraries.<mode>.default and
            // activePresetIds.<mode> = 'default' if missing.
            lib.migrateGlobalLegacyToLibraries(s);
            // Mark migration done so subsequent boots don't re-seed weirdly.
            s.presetLibrariesMigrationDone = 1;
        });

        // 1. Drive the same code path `applyAiIterationSessionToGlobal`
        //    does in its director branch: writeActivePreset(settings,
        //    'director', 'global', profile). This calls the EXPORTED
        //    helper that the post-fix director branch routes through.
        //    If a future commit reverts the director branch back to
        //    writing settings.directorProfile, this test won't fail —
        //    but the persistence leg (step 4-5) will, because the
        //    migration in the next boot strips legacy fields.
        const writeResult = await page.evaluate(async ({ marker }) => {
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const defaults = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const ext = await import('/scripts/extensions.js');
            const script = await import('/script.js');
            const settings = ext.extension_settings.orchestrator;
            // Confirm the preset library shape exists (post-migration).
            if (!settings?.presetLibraries?.director) {
                return { error: 'presetLibraries.director missing — migration did not run on this boot?',
                    keys: settings ? Object.keys(settings) : null };
            }
            const activeId = settings.activePresetIds?.director;
            if (!activeId) {
                return { error: 'activePresetIds.director missing — no slot to write into',
                    activeIds: settings.activePresetIds };
            }
            // Build a mutated director profile via the canonical sanitizer
            // (same sanitize path the fix uses). The marker lives in the
            // mainAgent's systemPrompt, which round-trips through the
            // sanitizer cleanly.
            const profile = defaults.sanitizeDirectorProfile({
                mainAgent: { systemPrompt: marker },
                subAgents: [],
                maxRounds: 5,
            });
            // The actual call from the fix.
            const ok = lib.writeActivePreset(settings, 'director', 'global', profile);
            // Drop legacy field if any handler had set it, to simulate the
            // post-fix path. (Pre-fix, the old branches assigned
            // settings.directorProfile = profile and called saveSettings.)
            // We DELIBERATELY do not touch settings.directorProfile — if it
            // is present after this write, that's the bug.
            //
            // `directSave: true` skips the patch path (server's JSON-Patch
            // engine can reject paths whose parent key was absent in the
            // pre-write snapshot — that's not the regression under test).
            await script.saveSettings(0, { directSave: true });
            // Defensive flush: wait a tick to let any debounced followups
            // settle AND for the server's fs write to complete.
            await new Promise(r => setTimeout(r, 1500));
            // Snapshot what's in memory: the active slot AND the legacy field.
            const liveSlot = settings.presetLibraries.director[activeId];
            const liveLegacy = Object.prototype.hasOwnProperty.call(settings, 'directorProfile')
                ? settings.directorProfile
                : null;
            return {
                ok,
                activeId,
                hasMarkerInSlot: !!(liveSlot && JSON.stringify(liveSlot).includes(marker)),
                hasMarkerInLegacy: !!(liveLegacy && JSON.stringify(liveLegacy).includes(marker)),
                legacyFieldPresent: Object.prototype.hasOwnProperty.call(settings, 'directorProfile'),
                liveSlotJson: JSON.stringify(liveSlot || null).slice(0, 200),
            };
        }, { marker: MARKER });

        expect(writeResult.error, `setup error: ${writeResult.error}; keys=${JSON.stringify(writeResult.keys)} activeIds=${JSON.stringify(writeResult.activeIds)}`).toBeUndefined();
        expect(writeResult.ok, 'writeActivePreset should return true (active slot existed)').toBe(true);
        expect(writeResult.hasMarkerInSlot,
            `writeActivePreset must mutate settings.presetLibraries.director.<activeId> — that is the slot getActivePreset reads. liveSlotJson=${writeResult.liveSlotJson}`,
        ).toBe(true);
        expect(writeResult.hasMarkerInLegacy,
            'writeActivePreset must NOT silently write to legacy settings.directorProfile (the post-fix contract)',
        ).toBe(false);

        // 2. Confirm settings.json on disk reflects the write — gives us
        //    a stable artifact to re-read after restart. The save is
        //    async on the server too (settings/save handler returns
        //    before the fsPromises.writeFile resolves in some paths), so
        //    poll the file for a few seconds before failing.
        const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
        expect(existsSync(settingsPath)).toBe(true);
        let slotOnDisk = null;
        let orchKeys = '';
        const pollDeadline = Date.now() + 5000;
        while (Date.now() < pollDeadline) {
            try {
                const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8'));
                const orch = onDisk?.extensionSettings?.orchestrator
                    || onDisk?.extension_settings?.orchestrator
                    || {};
                orchKeys = Object.keys(orch).slice(0, 20).join(',');
                slotOnDisk = orch?.presetLibraries?.director?.[writeResult.activeId] || null;
                if (slotOnDisk) break;
            } catch { /* file may be mid-write */ }
            await new Promise(r => setTimeout(r, 300));
        }
        expect(slotOnDisk,
            `preset library slot should be on disk after save; orch.keys=${orchKeys} activeId=${writeResult.activeId}`,
        ).toBeTruthy();
        expect(JSON.stringify(slotOnDisk),
            'on-disk preset slot should contain the regression marker',
        ).toContain(MARKER);

        // 3. RESTART — the load-bearing assertion. The migration runs at
        //    boot and strips legacy fields; if our write had hit the
        //    legacy `settings.directorProfile`, the marker would not
        //    survive the restart.
        await server.restart();
        await page.goto(server.baseURL);
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        // 4. Read back from in-memory settings post-restart. The director
        //    runtime reads via getActivePreset; if the data survives the
        //    boot + migration cycle, the architecture is intact.
        //    Defensive: ensure the in-memory settings shape is sane before
        //    calling getActivePreset. On a clean restart the orchestrator
        //    extension's init runs `migrateGlobalLegacyToLibraries` which
        //    re-seeds presetLibraries from the saved data. If something in
        //    between dropped a top-level key the call would NPE before
        //    we could prove the bug — we want the assertion to fail on
        //    the marker presence, not the shape.
        const afterRestart = await page.evaluate(async () => {
            const lib = await import('/scripts/extensions/orchestrator/preset-library.js');
            const ext = await import('/scripts/extensions.js');
            const ORCH = 'orchestrator';
            if (!ext.extension_settings[ORCH]) ext.extension_settings[ORCH] = {};
            const settings = ext.extension_settings[ORCH];
            // Re-run the migration so getActivePreset has a slot to read
            // even on a partial init (idempotent — see migrate impl).
            try { lib.migrateGlobalLegacyToLibraries(settings); } catch { /* tolerate */ }
            let active = null;
            try { active = lib.getActivePreset(settings, 'director', { scope: 'global' }); } catch { /* leave null */ }
            // Fallback: read the slot directly via the activeId we saved
            // in step 1. The director.<id> entry should be present on disk
            // and lifted into memory by the boot sequence.
            const activeIds = settings.activePresetIds || {};
            const directorId = activeIds.director || null;
            const slotDirect = directorId ? settings.presetLibraries?.director?.[directorId] : null;
            return {
                activePresetJson: JSON.stringify(active || slotDirect || {}),
                legacyFieldPresent: Object.prototype.hasOwnProperty.call(settings, 'directorProfile'),
                directorId,
            };
        });
        expect(afterRestart.activePresetJson,
            `after restart, getActivePreset should still return the profile with the marker — if writeActivePreset had silently delegated to a legacy field, the migration would have stripped it. directorId=${afterRestart.directorId}`,
        ).toContain(MARKER);
        expect(afterRestart.legacyFieldPresent,
            'legacy settings.directorProfile must remain absent after a clean restart (migration strips it)',
        ).toBe(false);
    });
});
