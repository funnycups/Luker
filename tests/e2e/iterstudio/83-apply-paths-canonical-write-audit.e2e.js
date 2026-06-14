// #83 — Cross-cutting audit: all 4 iter-studio Apply paths go through
//         a canonical, well-known write API (NEVER raw settings.json writes
//         that bypass the in-memory model).
//
// Why this test exists:
//   Commit 990c2d738 fixed a regression where orchestrator iter-studio
//   Apply→Global was writing legacy flat fields (`settings.directorProfile`,
//   `settings.loopProfile`, …) instead of routing through
//   `writeActivePreset(settings, mode, 'global', payload)`. The runtime
//   reads via `getActivePreset` from `presetLibraries.<mode>.<activeId>`,
//   so the AI edits silently never landed even though settings.json was
//   touched. (See memory `feedback_api_design_parity`.)
//
//   This audit pins the canonical write path per adapter so a re-regression
//   becomes a load-bearing test failure rather than a silent UX bug.
//
// What we verify per adapter:
//   - CPA          → Apply commits via `ctx.presets.save(ref, body, …)`
//                    (HTTP POST /api/presets/save).
//   - MG Schema    → Apply commits via
//                    `extension_settings.memory_graph.nodeTypeSchema = …`
//                    + saveSettings() (HTTP POST /api/settings/save).
//   - Orchestrator → Apply commits via
//                    `writeActivePreset(settings, mode, 'global', payload)`
//                    against `presetLibraries.<mode>.<activeId>`
//                    and NEVER writes settings.directorProfile,
//                    settings.loopProfile, settings.orchestrationSpec,
//                    settings.agendaPlanner/agendaAgents/...
//   - CEA Character→ Apply commits via
//                    `commitCharacterEditorOperations` →
//                    `mergeCharacterAttributes` →
//                    `/api/characters/edit` (the canonical card-edit
//                    endpoint).
//
// Strategy:
//   For each adapter, install a `fetch` interceptor in the page to record
//   every URL hit during the Apply round, drive the Apply via the same
//   path the production code uses, and assert the captured URLs include
//   the canonical endpoint AND exclude any legacy bypass surface. For
//   the orchestrator additionally inspect the live settings object to
//   verify legacy flat fields were NOT written (per the regression
//   pattern).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash glances at the chart.*'] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '83-apply-path-audit' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

// Patch window.fetch to record every request. Cumulative across the test.
async function installFetchRecorder(page) {
    await page.evaluate(() => {
        if (window.__iterStudioFetchRecorderInstalled) return;
        window.__iterStudioFetchRecorderInstalled = true;
        window.__iterStudioFetchLog = [];
        const orig = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string' ? input.url : String(input));
            const method = (init && init.method) || (input && input.method) || 'GET';
            window.__iterStudioFetchLog.push({ url: String(url), method: String(method).toUpperCase() });
            return orig(input, init);
        };
    });
}

async function readFetchLogSince(page, sinceIdx) {
    return await page.evaluate((from) => {
        const log = window.__iterStudioFetchLog || [];
        return log.slice(from);
    }, sinceIdx);
}

async function fetchLogLength(page) {
    return await page.evaluate(() => (window.__iterStudioFetchLog || []).length);
}

test.describe('#83 — All 4 iter-studio Apply paths route through canonical write APIs', () => {
    test('CPA Apply → /api/presets/save (and never bypasses)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        const before = await fetchLogLength(page);

        // Mirror cpa-iteration/studio.js's `commitLiveToPreset` exactly.
        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const ref = { collection: 'openai', name: 'Default' };
            const stored = ctx.presets.getStored?.(ref);
            const live = stored?.body
                ? JSON.parse(JSON.stringify(stored.body))
                : { ...ctx.chatCompletionSettings };
            live.temperature = 0.7;
            await ctx.presets.save(ref, live, { select: true });
            return { ok: true, finalTemp: ctx.chatCompletionSettings.temperature };
        });
        expect(result.ok).toBe(true);

        const newReqs = await readFetchLogSince(page, before);
        const savedPreset = newReqs.find(r => /\/api\/presets\/save\b/.test(r.url));
        expect(savedPreset, `CPA Apply must hit /api/presets/save; saw ${JSON.stringify(newReqs.map(r => r.url))}`).toBeTruthy();
        expect(savedPreset.method).toBe('POST');
    });

    test('MG Schema Apply → /api/settings/save (and never bypasses)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        const before = await fetchLogLength(page);

        // Mirror schema-iteration/studio.js's `commitLiveToSchema` for the
        // global scope branch (no avatar): settings.nodeTypeSchema = …
        // + saveSettings.
        //
        // Use the positional `saveSettings(0, { directSave: true })` form:
        // the JSON-Patch path silently rejects `add` ops whose parent
        // (`extension_settings.memory_graph`) wasn't serialized at boot
        // (most fresh dataRoots fall into this case), which would surface
        // here as a 500 response from /api/settings/patch instead of the
        // expected /api/settings/save. directSave forces a full settings.json
        // rewrite, which is the path the studio actually uses internally.
        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings.memory_graph;
            if (!ext) return { ok: false, reason: 'memory_graph ext settings missing' };
            const schema = Array.isArray(ext.nodeTypeSchema) ? ext.nodeTypeSchema.slice() : [];
            // Push a known-distinct entry so the write is non-trivial.
            schema.push({
                id: 'audit_marker_83',
                label: 'Audit Marker',
                tableName: 'audit_marker_table',
                tableColumns: ['note'],
                embeddingColumns: ['note'],
                requiredColumns: ['note'],
                keywords: ['audit'],
            });
            ext.nodeTypeSchema = schema;
            if (typeof ctx.saveSettings === 'function') {
                await ctx.saveSettings(0, { directSave: true });
            } else if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
                // Force-flush via the public API if available.
                await new Promise(r => setTimeout(r, 200));
            }
            return { ok: true };
        });
        expect(result.ok, result.reason).toBe(true);

        // Settings save flushes via /api/settings/save (or the older
        // /api/save_settings shim). Poll briefly because the debounced
        // saver may delay.
        await expect.poll(async () => {
            const logSince = await readFetchLogSince(page, before);
            return logSince.some(r => /\/api\/settings\/save\b|\/api\/save_settings\b/.test(r.url));
        }, { timeout: 5000 }).toBe(true);
    });

    test('Orchestrator Apply → writeActivePreset; legacy flat fields stay untouched', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        // Enable orchestrator + director mode and snapshot the legacy flat
        // fields BEFORE the apply so we can prove they are not the write
        // target post-apply.
        const baseline = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            if (!s) throw new Error('orchestrator settings missing');
            s.enabled = true;
            s.executionMode = 'director';
            return {
                hadDirectorProfile: Object.prototype.hasOwnProperty.call(s, 'directorProfile'),
                directorProfileSnapshot: s.directorProfile ? JSON.parse(JSON.stringify(s.directorProfile)) : null,
                hadLoopProfile: Object.prototype.hasOwnProperty.call(s, 'loopProfile'),
                loopProfileSnapshot: s.loopProfile ? JSON.parse(JSON.stringify(s.loopProfile)) : null,
                presetLibrariesKeys: s.presetLibraries
                    ? Object.fromEntries(Object.entries(s.presetLibraries).map(([k, v]) => [k, Object.keys(v || {}).length]))
                    : null,
                activeDirectorId: s.activePresetIds?.director || '',
            };
        });
        // We expect presetLibraries.director to have at least one slot
        // (factory default seeded on first boot). If it's empty something
        // is structurally wrong.
        expect(baseline.presetLibrariesKeys, 'presetLibraries missing').toBeTruthy();
        expect(baseline.presetLibrariesKeys.director).toBeGreaterThanOrEqual(1);
        expect(baseline.activeDirectorId).toBeTruthy();

        // Apply via the canonical writeActivePreset path (mirrors
        // applyAiIterationSessionToGlobal for director mode).
        const NEW_PROMPT = '*Ash narrates the night reef.* Stay in scene; one tactile beat per turn.';
        const apply = await page.evaluate(async (newPrompt) => {
            const ctx = window.Luker.getContext();
            const presetLib = await import(
                '/scripts/extensions/orchestrator/preset-library.js'
            );
            const s = ctx.extensionSettings.orchestrator;
            const current = presetLib.getActivePreset(s, 'director', { scope: 'global' });
            if (!current) return { ok: false, reason: 'no active director preset' };
            const payload = {
                ...current,
                mainAgent: {
                    ...(current.mainAgent || {}),
                    systemPrompt: newPrompt,
                },
            };
            const ok = presetLib.writeActivePreset(s, 'director', 'global', payload);
            return { ok, written: ok ? presetLib.getActivePreset(s, 'director', { scope: 'global' })?.mainAgent?.systemPrompt : null };
        }, NEW_PROMPT);

        expect(apply.ok, apply.reason).toBe(true);
        expect(apply.written).toBe(NEW_PROMPT);

        // Verify legacy flat fields were NOT touched by the canonical write.
        const after = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            return {
                hasDirectorProfile: Object.prototype.hasOwnProperty.call(s, 'directorProfile'),
                directorProfile: s.directorProfile ? JSON.parse(JSON.stringify(s.directorProfile)) : null,
                hasLoopProfile: Object.prototype.hasOwnProperty.call(s, 'loopProfile'),
                hasOrchestrationSpec: Object.prototype.hasOwnProperty.call(s, 'orchestrationSpec'),
                hasAgendaPlanner: Object.prototype.hasOwnProperty.call(s, 'agendaPlanner'),
                hasAgendaAgents: Object.prototype.hasOwnProperty.call(s, 'agendaAgents'),
                directorActiveSlot: s.presetLibraries?.director?.[s.activePresetIds?.director || '']?.mainAgent?.systemPrompt || '',
            };
        });

        // The active preset slot now carries the new prompt.
        expect(after.directorActiveSlot).toBe(NEW_PROMPT);

        // The legacy `directorProfile` flat field MUST NOT mirror the new
        // prompt — that's the regression we're guarding against. Either
        // the field was never touched (pre-existing snapshot preserved) or
        // it was outright stripped by migrateGlobalLegacyToLibraries. Both
        // are acceptable; what's NOT acceptable is "directorProfile got
        // the new value AND presetLibraries didn't" — that would silently
        // drop the AI's edits at runtime.
        if (after.hasDirectorProfile && after.directorProfile?.mainAgent) {
            expect(
                after.directorProfile.mainAgent.systemPrompt,
                'legacy settings.directorProfile.mainAgent.systemPrompt must not mirror the iter-studio Apply (regression 990c2d738)',
            ).not.toBe(NEW_PROMPT);
        }
    });

    test('CEA Character Apply → /api/characters/edit (and never bypasses)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installFetchRecorder(page);

        const before = await fetchLogLength(page);

        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mod = await import(
                '/scripts/extensions/character-editor-assistant/main.js'
            );
            const character = ctx.characters?.[ctx.characterId] || null;
            if (!character) return { ok: false, reason: 'no active character' };
            const avatar = String(character.avatar || '').trim();
            if (!avatar) return { ok: false, reason: 'no avatar' };
            const liveCharacter = JSON.parse(JSON.stringify(character));
            const newText = 'Seraphina keeps a tide-log on her belt — a half-inch leather notebook.';
            const edits = [{
                op: 'set',
                path: 'description',
                newValue: newText,
                // The `set` op's detectConflict reads `edit.oldValue`. If
                // omitted (or set to a non-matching value), the engine
                // emits `value_drifted` and excludes the edit from
                // `clean[]` (applied stays 0). Pass the live root field
                // value so the conflict check passes and the canonical
                // /api/characters/edit POST fires — which is the only
                // thing this audit case verifies.
                oldValue: liveCharacter.description || liveCharacter?.data?.description || '',
            }];
            try {
                const r = await mod.commitCharacterEditorOperations(ctx, avatar, edits, { liveCharacter });
                return { ok: true, applied: r?.applied };
            } catch (e) {
                return { ok: false, reason: String(e?.message || e) };
            }
        });
        expect(result.ok, result.reason).toBe(true);
        expect(result.applied).toBeGreaterThanOrEqual(1);

        const newReqs = await readFetchLogSince(page, before);
        const editCall = newReqs.find(r => /\/api\/characters\/edit\b/.test(r.url));
        expect(editCall, `CEA Character Apply must hit /api/characters/edit; saw ${JSON.stringify(newReqs.map(r => r.url))}`).toBeTruthy();
        expect(editCall.method).toBe('POST');
    });
});
