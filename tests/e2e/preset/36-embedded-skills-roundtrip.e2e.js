// #36 — Preset with embedded skills (+ WI) round-trip across export → import.
//
// Builds on `tests/skills-ui/playwright/preset-export-with-skills.spec.js`.
// The legacy spec validated pack→extract on the skills API alone; this
// e2e variant adds:
//   - dedicated server + dataRoot (no shared state with parallel batches)
//   - a real OpenAI preset (preset-A) created via the preset manager
//   - export builds via `packAndAttachSkillsForExport` — same path the
//     OAI_PRESET_EXPORT_READY hook drives in production
//   - import surfaces verbatim into a different preset name
//   - restart re-asserts disk persistence
//
// The WI side of the brief asks "if preset-scope WI is supported, also
// round-trip it". Per `grep -rn 'embedded_world_info_source' public/scripts/`
// (empty result), preset-scope WI does NOT have an analogous embed
// payload path — characters do (`extensions.luker.embedded_world_info`),
// presets do not. The WI block of this case is therefore `test.fixme`'d
// with that note so a future contributor can wire it once the symmetry
// lands.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const SOURCE_PRESET_NAME = 'p36-source-with-skills';
const TARGET_PRESET_NAME = 'p36-imported-with-skills';
const SOURCE_SCOPE = { kind: 'preset', name: SOURCE_PRESET_NAME };
const TARGET_SCOPE = { kind: 'preset', name: TARGET_PRESET_NAME };
const FIXTURE_SKILL_NAME = 'p36-export-roundtrip-skill';
const FIXTURE_BODY_ANCHOR = '*Ash unfolds a worn chart and marks three points; the e2e fixture skill body anchor reads: roundtrip-v1.*';

// Skill payload shape used by `executeExtractEmbed`. Mirrors the
// `buildSyntheticEmbed` helper in tests/skills-ui/playwright/helpers.js
// (the `bundleFormat: 'inline-files-v1'` discriminant is required —
// without it the materialize step throws "unsupported bundleFormat:
// undefined" from skills/embed.js).
function buildSyntheticEmbed({ name, description, bodyTail }) {
    const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const skillMd = [
        '---',
        `name: ${name}`,
        `description: ${yamlString(description)}`,
        '---',
        '',
        '# Body',
        '',
        bodyTail,
        '',
    ].join('\n');
    return {
        version: 1,
        items: [{
            bundleFormat: 'inline-files-v1',
            name,
            description,
            files: [
                { path: 'SKILL.md', encoding: 'utf8', content: skillMd },
            ],
        }],
    };
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'preset', scenarioId: 'preset-embed-skills' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#36 — preset with embedded skills round-trips', () => {
    test('preset-scope skill packs into export payload, extracts into a new preset, survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Ensure ctx.skills is wired. If not, fail loud — the rest of the
        // case is meaningless.
        const hasSkills = await page.evaluate(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return Boolean(ctx?.skills && typeof ctx.skills.list === 'function');
        });
        expect(hasSkills, 'context.skills should be exposed').toBe(true);

        // ── Step 1: Create the source preset. The preset only needs to
        // exist as a scope owner for the skill — minimal body is fine.
        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const mgr = ctx.getPresetManager('openai');
            const base = mgr.getCompletionPresetByName('Default') || {};
            const clone = JSON.parse(JSON.stringify(base));
            await mgr.savePreset(name, clone);
        }, SOURCE_PRESET_NAME);

        await page.waitForFunction((name) => {
            return Array.from(document.querySelectorAll('#settings_preset_openai option'))
                .some(o => o.textContent === name);
        }, SOURCE_PRESET_NAME, { timeout: 5000 });

        // ── Step 2: Install the fixture skill into the source preset scope.
        const installed = await page.evaluate(async ({ scope, payload }) => {
            const ctx = window.SillyTavern.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
            const list = await ctx.skills.list({ scope });
            return (list || []).map(s => s.name);
        }, {
            scope: SOURCE_SCOPE,
            payload: buildSyntheticEmbed({
                name: FIXTURE_SKILL_NAME,
                description: 'Round-trip fixture skill: verifies preset export packs preset-scope skills.',
                bodyTail: FIXTURE_BODY_ANCHOR,
            }),
        });
        expect(installed).toContain(FIXTURE_SKILL_NAME);

        // ── Step 3: Pack the skills via the export helper.
        //   This is the exact path the OAI_PRESET_EXPORT_READY hook
        //   drives in production via `packAndAttachSkillsForExport`.
        const exportPayload = await page.evaluate(async (scope) => {
            const ctx = window.SillyTavern.getContext();
            const mod = await import('/scripts/skills/embed-export-helper.js');
            return await mod.packSkillsForExport({ context: ctx, targetScope: scope });
        }, SOURCE_SCOPE);
        expect(exportPayload, 'export helper returns a payload').toBeTruthy();
        expect(exportPayload.version).toBe(1);
        const fixtureEntry = (exportPayload.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixtureEntry, 'packed payload contains the fixture skill').toBeTruthy();

        // ── Step 4: Attach to a freshly-built preset export object,
        // mirroring what the OAI preset Export-to-file hook does.
        const attachedShape = await page.evaluate(async ({ scope, sourceName }) => {
            const ctx = window.SillyTavern.getContext();
            const mod = await import('/scripts/skills/embed-export-helper.js');
            const mgr = ctx.getPresetManager('openai');
            const baseBody = mgr.getCompletionPresetByName(sourceName);
            const exportObj = JSON.parse(JSON.stringify(baseBody || {}));
            const payload = await mod.packAndAttachSkillsForExport({
                context: ctx, targetScope: scope, attachTo: exportObj,
            });
            return {
                hasPayload: !!payload,
                attachedAt: exportObj.extensions?.luker?.embedded_skills_source || null,
                exportObj,
            };
        }, { scope: SOURCE_SCOPE, sourceName: SOURCE_PRESET_NAME });
        expect(attachedShape.hasPayload).toBe(true);
        expect(attachedShape.attachedAt, 'payload attached at extensions.luker.embedded_skills_source').toBeTruthy();

        // ── Step 5: "Import" — preview against the target preset scope,
        // then extract. Mirror an end-user's reimport flow with a fresh name.
        // First, ensure the target preset scope exists by saving an empty
        // preset under that name (so the skill scope has somewhere to land).
        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const mgr = ctx.getPresetManager('openai');
            const base = mgr.getCompletionPresetByName('Default') || {};
            const clone = JSON.parse(JSON.stringify(base));
            await mgr.savePreset(name, clone);
        }, TARGET_PRESET_NAME);
        await page.waitForFunction((name) => {
            return Array.from(document.querySelectorAll('#settings_preset_openai option'))
                .some(o => o.textContent === name);
        }, TARGET_PRESET_NAME, { timeout: 5000 });

        const preview = await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.SillyTavern.getContext();
            return await ctx.skills.previewExtractEmbed({ payload, targetScope: scope });
        }, { payload: exportPayload, scope: TARGET_SCOPE });
        const previewItem = (preview?.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(previewItem, 'fixture appears in preview').toBeTruthy();
        expect(previewItem.conflict, 'preview classifies fixture as new in target scope').toBe('new');

        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.SillyTavern.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload: exportPayload, scope: TARGET_SCOPE });

        // ── Step 6: Body must match through the round-trip.
        const roundTripped = await page.evaluate(async ({ scope, name }) => {
            const ctx = window.SillyTavern.getContext();
            const all = await ctx.skills.list({ scope });
            const entry = (all || []).find(s => s.name === name);
            if (!entry) return null;
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return { entry, fileContent: file?.content || '' };
        }, { scope: TARGET_SCOPE, name: FIXTURE_SKILL_NAME });
        expect(roundTripped, 'fixture lives in target preset scope after extract').toBeTruthy();
        expect(roundTripped.entry.scope.kind).toBe('preset');
        expect(roundTripped.entry.scope.name).toBe(TARGET_PRESET_NAME);
        expect(roundTripped.fileContent).toContain(FIXTURE_BODY_ANCHOR);

        // ── Step 7: Scope isolation — fixture must NOT leak to global.
        const fixtureInstances = await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const all = await ctx.skills.list({ scope: 'all' });
            return (all || []).filter(s => s.name === name).map(s => s.scope);
        }, FIXTURE_SKILL_NAME);
        expect(fixtureInstances).toHaveLength(2);
        for (const s of fixtureInstances) {
            expect(s.kind, 'each instance is preset-scoped').toBe('preset');
        }

        // ── Step 8: Restart + reload. Skill files live on disk under
        // default-user/skills/<preset-or-global>/<name>/SKILL.md so they
        // must survive a server kill.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = await page.evaluate(async ({ scope, name }) => {
            const ctx = window.SillyTavern.getContext();
            const list = await ctx.skills.list({ scope });
            const entry = (list || []).find(s => s.name === name);
            if (!entry) return null;
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return { entry, fileContent: file?.content || '' };
        }, { scope: TARGET_SCOPE, name: FIXTURE_SKILL_NAME });
        expect(afterRestart, 'fixture survived restart in target preset scope').toBeTruthy();
        expect(afterRestart.fileContent).toContain(FIXTURE_BODY_ANCHOR);
    });

    // Preset-scope WI does not currently have an analogous embed payload
    // path. The character path uses `extensions.luker.embedded_world_info`,
    // packed/extracted by separate hooks; presets do not have the symmetric
    // hook today. Marked fixme so this gets revisited when symmetry lands.
    test.fixme('preset-scope world info round-trips alongside skills', async () => {
        // Intentionally blank — no `embedded_world_info_source` analog for
        // presets exists in the codebase (verified via grep against public/
        // scripts/). Re-enable when the export pipeline grows that hook.
    });
});
