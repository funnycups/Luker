/**
 * Real-server migration check for the iter-studio settings.json → sidecar
 * drain. Each iter-studio popup mounts a one-shot migrator that walks the
 * legacy V2 bucket on `extension_settings.<plugin>` and rewrites every
 * session into either:
 *   - the per-character sidecar (orchestrator + CEA, scope=character)
 *   - or the new global bucket (orchestrator scope=global; MG, which never
 *     carried a per-character dimension in V2).
 *
 * Why direct-invoke the migrator instead of opening the popups:
 *   - Each plugin's popup-open function takes 5-20 deps wired through main.js
 *     (orchestrator needs ORCH_EXECUTION_MODES + a dozen helpers; MG needs
 *     normalizeNodeTypeSchema + getEffectiveSettings + getSchemaScopeInfo +
 *     persistCharacterSchemaOverride + saveSettings + …). Reconstructing
 *     that surface from a Playwright test is brittle and tests the wrong
 *     thing — the call site of the migrator is 4 lines of try/catch already
 *     covered by the jest-side popup-mount specs.
 *   - The interesting failure mode is the migrator-against-live-storage:
 *     does `ctx.setCharacterState` accept the payload, does the V2 bucket
 *     actually get deleted post-drain in the real browser env, does the
 *     migration flag set on the settings root and persist. That is exactly
 *     what this spec exercises by dynamic-importing the migrator module
 *     and calling it with the live `ctx` and the live settings root.
 *
 * Coverage:
 *   - orchestrator V2 (`extension_settings.orchestrator.iterStudioV2`)
 *     drains into the per-character sidecar
 *     `orchestrator_iter_studio_history`.
 *   - CEA V2 (`extension_settings.character_editor_assistant.unified_cea_editor_sessions`)
 *     drains into the per-character sidecar
 *     `character_editor_assistant_iter_sessions`.
 *   - MG V2 (`extension_settings.memory_graph.iterStudioV2Schema`) drains
 *     into the global bucket `schema_iter_global_sessions`.
 *
 * Each test seeds a single V2 entry, resets the migration flag (so the
 * idempotent-skip path can't short-circuit it), runs the migrator, and
 * asserts the expected post-state.
 */

import { test, expect } from '@playwright/test';
import { awaitMainUI, ensureCharacterLoaded } from './helpers.js';

// Run serially: the three tests share `ctx.extensionSettings` and the
// orchestrator's sidecar namespace under the active character. Parallel
// execution would race the V2-seed step.
test.describe.configure({ mode: 'serial' });

test.describe('iter-studio settings.json → sidecar migration', () => {
    test.setTimeout(60_000);

    test('orchestrator V2 bucket drains into per-character sidecar', async ({ page }) => {
        await awaitMainUI(page);

        // Need a real character on disk so the orch migrator's
        // `isKnownAvatar` check passes. Without one the entry is "skipped"
        // (kept in the V2 bucket) and the test would assert against the
        // wrong post-state.
        const avatar = await ensureCharacterLoaded(page);
        expect(avatar, 'character must be loaded to exercise per-character sidecar path').toBeTruthy();

        const seed = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const root = ctx.extensionSettings.orchestrator = ctx.extensionSettings.orchestrator || {};

            // Reset the idempotent flag so the migrator runs even if a
            // prior test invocation (or the popup-mount on previous load)
            // already drained whatever was there.
            delete root.__iterStudioV2ToSidecarMigratedAt;

            // Wipe any stale sidecar from a previous run so the assertion
            // proves THIS migration wrote it.
            try { await ctx.setCharacterState(avatar, 'orchestrator_iter_studio_history', { version: 1, sessions: {} }); } catch { /* best-effort */ }

            // Seed a V2 entry pointing at the loaded character. Shape
            // mirrors the legacy storage path:
            //   iterStudioV2[<mode>][character_<avatar>][<sid>] = session
            root.iterStudioV2 = {
                director: {
                    [`character_${avatar}`]: {
                        's-pwtest-orch-1': {
                            id: 's-pwtest-orch-1',
                            title: 'PW migration test (orch director)',
                            updatedAt: Date.now(),
                            mode: 'director',
                            messages: [],
                        },
                    },
                },
            };
            return { avatar, seededId: 's-pwtest-orch-1' };
        }, avatar);

        // Invoke the migrator directly. Equivalent to what
        // openOrchestratorIterationStudio does at line ~1053 — minus the
        // ~30 deps the popup itself needs.
        const result = await page.evaluate(async ({ avatar }) => {
            const ctx = window.SillyTavern.getContext();
            const settingsRoot = ctx.extensionSettings.orchestrator;
            const mod = await import('/scripts/extensions/orchestrator/iter-studio/session-migration-v2-to-sidecar.js');
            await mod.migrateOrchSessionsV2ToSidecar({
                settingsRoot,
                ctx,
                persistSettings: () => {
                    try {
                        if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
                    } catch { /* ignore */ }
                },
            });
            const sidecar = await ctx.getCharacterState(avatar, 'orchestrator_iter_studio_history');
            return {
                v2BucketGone: !settingsRoot.iterStudioV2,
                migrationFlag: settingsRoot.__iterStudioV2ToSidecarMigratedAt === true,
                sidecarHasSession: Boolean(sidecar && sidecar.sessions && sidecar.sessions['s-pwtest-orch-1']),
                sidecarSessionTitle: sidecar?.sessions?.['s-pwtest-orch-1']?.title || null,
            };
        }, seed);

        expect(result.v2BucketGone, 'V2 iterStudioV2 bucket removed after drain').toBe(true);
        expect(result.migrationFlag, 'idempotent flag set on settings root').toBe(true);
        expect(result.sidecarHasSession, 'seeded session present in per-character sidecar').toBe(true);
        expect(result.sidecarSessionTitle, 'seeded session metadata preserved').toBe('PW migration test (orch director)');
    });

    test('CEA V2 bucket drains into per-character sidecar', async ({ page }) => {
        await awaitMainUI(page);
        const avatar = await ensureCharacterLoaded(page);
        expect(avatar, 'character must be loaded to exercise per-character sidecar path').toBeTruthy();

        const seed = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const root = ctx.extensionSettings.character_editor_assistant = ctx.extensionSettings.character_editor_assistant || {};
            delete root.__unifiedCeaEditorV2ToSidecarMigratedAt;
            try { await ctx.setCharacterState(avatar, 'character_editor_assistant_iter_sessions', { version: 1, sessions: {} }); } catch { /* best-effort */ }

            // CEA V2 scope keys are `char_<avatar>` (not `character_<avatar>`
            // like orchestrator). The migrator slices the `char_` prefix.
            root.unified_cea_editor_sessions = {
                [`char_${avatar}`]: {
                    's-pwtest-cea-1': {
                        id: 's-pwtest-cea-1',
                        title: 'PW migration test (CEA unified)',
                        updatedAt: Date.now(),
                        messages: [],
                    },
                },
            };
            return { avatar, seededId: 's-pwtest-cea-1' };
        }, avatar);

        const result = await page.evaluate(async ({ avatar }) => {
            const ctx = window.SillyTavern.getContext();
            const settingsRoot = ctx.extensionSettings.character_editor_assistant;
            const mod = await import('/scripts/extensions/character-editor-assistant/editor-iteration/session-migration-v2-to-sidecar.js');
            await mod.migrateCeaSessionsV2ToSidecar({
                settingsRoot,
                ctx,
                persistSettings: () => {
                    try {
                        if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
                    } catch { /* ignore */ }
                },
            });
            const sidecar = await ctx.getCharacterState(avatar, 'character_editor_assistant_iter_sessions');
            return {
                v2BucketGone: !settingsRoot.unified_cea_editor_sessions,
                migrationFlag: settingsRoot.__unifiedCeaEditorV2ToSidecarMigratedAt === true,
                sidecarHasSession: Boolean(sidecar && sidecar.sessions && sidecar.sessions['s-pwtest-cea-1']),
                sidecarSessionTitle: sidecar?.sessions?.['s-pwtest-cea-1']?.title || null,
            };
        }, seed);

        expect(result.v2BucketGone, 'V2 unified_cea_editor_sessions bucket removed after drain').toBe(true);
        expect(result.migrationFlag, 'idempotent flag set on settings root').toBe(true);
        expect(result.sidecarHasSession, 'seeded session present in per-character sidecar').toBe(true);
        expect(result.sidecarSessionTitle, 'seeded session metadata preserved').toBe('PW migration test (CEA unified)');
    });

    test('MG V2 bucket drains into global schema-iter sessions bucket', async ({ page }) => {
        await awaitMainUI(page);
        // MG V2 was flat (no per-character dimension), so the migrator
        // routes everything to the global bucket. We don't need a loaded
        // character — but mounting the main UI is still required so
        // extension_settings.memory_graph is initialized.

        const seed = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const root = ctx.extensionSettings.memory_graph = ctx.extensionSettings.memory_graph || {};
            delete root.__schemaIterV2ToSidecarMigratedAt;
            // Wipe any prior global-bucket entry from earlier runs.
            if (root.schema_iter_global_sessions && typeof root.schema_iter_global_sessions === 'object') {
                delete root.schema_iter_global_sessions['s-pwtest-mg-1'];
            }
            // MG V2 shape: flat map of sid → session.
            root.iterStudioV2Schema = {
                's-pwtest-mg-1': {
                    id: 's-pwtest-mg-1',
                    title: 'PW migration test (MG schema)',
                    updatedAt: Date.now(),
                    messages: [],
                },
            };
            return { seededId: 's-pwtest-mg-1' };
        });

        const result = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settingsRoot = ctx.extensionSettings.memory_graph;
            const mod = await import('/scripts/extensions/memory-graph/schema-iteration/session-migration-v2-to-sidecar.js');
            await mod.migrateMgSchemaSessionsV2ToSidecar({
                settingsRoot,
                ctx,
                persistSettings: () => {
                    try {
                        if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
                    } catch { /* ignore */ }
                },
            });
            const globalBucket = settingsRoot.schema_iter_global_sessions || {};
            return {
                v2BucketGone: !settingsRoot.iterStudioV2Schema,
                migrationFlag: settingsRoot.__schemaIterV2ToSidecarMigratedAt === true,
                globalHasSession: Boolean(globalBucket['s-pwtest-mg-1']),
                globalSessionTitle: globalBucket['s-pwtest-mg-1']?.title || null,
            };
        });

        expect(result.v2BucketGone, 'V2 iterStudioV2Schema bucket removed after drain').toBe(true);
        expect(result.migrationFlag, 'idempotent flag set on settings root').toBe(true);
        expect(result.globalHasSession, 'seeded session present in global schema-iter bucket').toBe(true);
        expect(result.globalSessionTitle, 'seeded session metadata preserved').toBe('PW migration test (MG schema)');
    });
});
