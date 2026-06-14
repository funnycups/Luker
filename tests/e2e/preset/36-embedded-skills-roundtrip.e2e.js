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
// round-trip it". Preset-scope WI binding is implemented via
// `extensions.preset_lorebook` on the preset body (the entire WI payload
// embedded as `{ version, name, data }`). The programmatic surface lives
// in `public/scripts/preset-lorebook-embed.js` and is exposed via
// `ctx.presetLorebook` for tests + extensions (mirrors `ctx.skills`).

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
            const ctx = window.Luker?.getContext?.();
            return Boolean(ctx?.skills && typeof ctx.skills.list === 'function');
        });
        expect(hasSkills, 'context.skills should be exposed').toBe(true);

        // ── Step 1: Create the source preset. The preset only needs to
        // exist as a scope owner for the skill — minimal body is fine.
        await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
            return await ctx.skills.previewExtractEmbed({ payload, targetScope: scope });
        }, { payload: exportPayload, scope: TARGET_SCOPE });
        const previewItem = (preview?.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(previewItem, 'fixture appears in preview').toBeTruthy();
        expect(previewItem.conflict, 'preview classifies fixture as new in target scope').toBe('new');

        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload: exportPayload, scope: TARGET_SCOPE });

        // ── Step 6: Body must match through the round-trip.
        const roundTripped = await page.evaluate(async ({ scope, name }) => {
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
            const list = await ctx.skills.list({ scope });
            const entry = (list || []).find(s => s.name === name);
            if (!entry) return null;
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return { entry, fileContent: file?.content || '' };
        }, { scope: TARGET_SCOPE, name: FIXTURE_SKILL_NAME });
        expect(afterRestart, 'fixture survived restart in target preset scope').toBeTruthy();
        expect(afterRestart.fileContent).toContain(FIXTURE_BODY_ANCHOR);
    });

    // Preset ↔ lorebook embed symmetry with skills. The binding mechanism
    // is `extensions.preset_lorebook = { version, name, data }` on the
    // preset body — the entire world-info payload travels inside the
    // preset JSON. The programmatic API lives at `ctx.presetLorebook`
    // (mirrors `ctx.skills`); the underlying `extensions.preset_lorebook`
    // field is already round-tripped by the standard preset save/load
    // path (no per-export "include WI?" prompt — once bound, always
    // travels with the preset).
    test('preset-scope world info round-trips alongside skills', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // ── Step 1: Source preset must already exist from the previous
        // case (preset-scope skills test in the same describe). If the
        // earlier test failed and left no preset, fall back to creating
        // one so this case can still drive its own assertions.
        await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            if (!mgr.getCompletionPresetByName(name)) {
                const base = mgr.getCompletionPresetByName('Default') || {};
                await mgr.savePreset(name, JSON.parse(JSON.stringify(base)));
            }
        }, SOURCE_PRESET_NAME);

        // ── Step 2: Create a world book with three entries via the real
        // saveWorldInfo endpoint, then bind it to the source preset via
        // the new programmatic ctx.presetLorebook.bind() API.
        const WI_BOOK = 'p36-source-bound-wi';
        const WI_ENTRIES = [
            { uid: 0, key: ['reef'], comment: 'reef-conditions', content: 'The reef breakers run high after the spring rains.', order: 100 },
            { uid: 1, key: ['ash'], comment: 'ash-skipper', content: 'Ash skippers the lantern fleet from Bryn Headland.', order: 110 },
            { uid: 2, key: ['headland'], comment: 'bryn-headland', content: 'Bryn Headland marks the seaward edge of the territory.', order: 120 },
        ];

        const bindResult = await page.evaluate(async ({ wiName, wiEntries, presetName }) => {
            const ctx = window.Luker.getContext();
            // saveWorldInfo from ctx accepts the same { entries: { uid: {...} } }
            // shape /api/worldinfo/edit writes.
            const entries = {};
            for (const e of wiEntries) {
                entries[String(e.uid)] = {
                    uid: e.uid,
                    key: e.key || [],
                    keysecondary: [],
                    comment: e.comment,
                    content: e.content,
                    constant: false,
                    selective: true,
                    order: e.order ?? 100,
                    position: 0,
                    disable: false,
                    displayIndex: e.uid,
                    addMemo: true,
                    group: '',
                    groupOverride: false,
                    groupWeight: 100,
                    sticky: 0,
                    cooldown: 0,
                    delay: 0,
                    probability: 100,
                    depth: 4,
                    useProbability: true,
                    role: null,
                    vectorized: false,
                    excludeRecursion: false,
                    preventRecursion: false,
                    delayUntilRecursion: false,
                    scanDepth: null,
                    caseSensitive: null,
                    matchWholeWords: null,
                    useGroupScoring: null,
                    automationId: '',
                };
            }
            await ctx.saveWorldInfo(wiName, { entries }, true);
            await ctx.updateWorldInfoList();
            // Bind via the new ctx.presetLorebook API.
            const bound = await ctx.presetLorebook.bind({
                apiId: 'openai', presetName, worldName: wiName,
            });
            return { bound };
        }, { wiName: WI_BOOK, wiEntries: WI_ENTRIES, presetName: SOURCE_PRESET_NAME });
        expect(bindResult.bound, 'ctx.presetLorebook.bind() succeeds').toBe(true);

        // ── Step 3: Read back the source preset body and confirm the
        // binding landed at `extensions.preset_lorebook` with the WI
        // name + the three entries we wrote.
        const sourceShape = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return {
                hasExt: !!body?.extensions?.preset_lorebook,
                embed: body?.extensions?.preset_lorebook || null,
                entryCount: body?.extensions?.preset_lorebook?.data?.entries
                    ? Object.keys(body.extensions.preset_lorebook.data.entries).length
                    : 0,
            };
        }, SOURCE_PRESET_NAME);
        expect(sourceShape.hasExt, 'extensions.preset_lorebook is set on the source preset').toBe(true);
        expect(sourceShape.embed.version).toBe(1);
        expect(sourceShape.embed.name).toBe(WI_BOOK);
        expect(sourceShape.entryCount, 'embed carries all three WI entries').toBe(3);

        // ── Step 4: Simulate export — read the in-memory preset body
        // (the same path `onExportPresetClick` reads) and stringify it.
        // The exported JSON must include the embed block.
        const exportedJson = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            // Mirror onExportPresetClick: structuredClone + JSON.stringify.
            const cloned = JSON.parse(JSON.stringify(body));
            return JSON.stringify(cloned);
        }, SOURCE_PRESET_NAME);
        const parsedExport = JSON.parse(exportedJson);
        expect(parsedExport?.extensions?.preset_lorebook?.name).toBe(WI_BOOK);
        expect(Object.keys(parsedExport.extensions.preset_lorebook.data.entries))
            .toHaveLength(3);

        // ── Step 5: Simulate import under a different preset name. Save
        // the exported body verbatim — this is what saveOpenAIPresetBody
        // does after OAI_PRESET_IMPORT_READY fires.
        const IMPORTED_PRESET = 'p36-imported-with-wi';
        await page.evaluate(async ({ name, body }) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            await mgr.savePreset(name, JSON.parse(body));
        }, { name: IMPORTED_PRESET, body: exportedJson });
        await page.waitForFunction((name) => {
            return Array.from(document.querySelectorAll('#settings_preset_openai option'))
                .some(o => o.textContent === name);
        }, IMPORTED_PRESET, { timeout: 5000 });

        // ── Step 6: The imported preset must carry the same binding
        // (verbatim — same WI name, same entries).
        const importedShape = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return {
                hasExt: !!body?.extensions?.preset_lorebook,
                embedName: body?.extensions?.preset_lorebook?.name || '',
                entryCount: body?.extensions?.preset_lorebook?.data?.entries
                    ? Object.keys(body.extensions.preset_lorebook.data.entries).length
                    : 0,
                entryComments: body?.extensions?.preset_lorebook?.data?.entries
                    ? Object.values(body.extensions.preset_lorebook.data.entries).map(e => e.comment).sort()
                    : [],
            };
        }, IMPORTED_PRESET);
        expect(importedShape.hasExt, 'imported preset carries extensions.preset_lorebook').toBe(true);
        expect(importedShape.embedName).toBe(WI_BOOK);
        expect(importedShape.entryCount).toBe(3);
        expect(importedShape.entryComments).toEqual(['ash-skipper', 'bryn-headland', 'reef-conditions']);

        // ── Step 7: Materialize the embedded WI through the new ctx API.
        // First delete the source WI file from disk so we know the
        // import actually re-creates it from the embed (not a stale read).
        // Use the live deleteWorldInfo (not raw fetch) so both the file
        // and the client-side caches drop in lockstep — otherwise the
        // `saveWorldInfo` patch-mode optimization would short-circuit on
        // the stale snapshot and never actually re-write the file.
        await page.evaluate(async (wiName) => {
            const mod = await import('/scripts/world-info.js');
            await mod.deleteWorldInfo(wiName);
        }, WI_BOOK);

        const materializeResult = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return await ctx.presetLorebook.applyFromPresetBody({
                presetBody: body, onConflict: 'replace', activate: true,
            });
        }, IMPORTED_PRESET);
        expect(materializeResult).toBeTruthy();
        expect(materializeResult.worldName).toBe(WI_BOOK);
        expect(materializeResult.materialized, 'WI file written to disk from embed').toBe(true);

        // ── Step 8: Confirm the materialized WI file is on disk with the
        // same three entries. Read via /api/worldinfo/get (the same path
        // the editor uses).
        const materialized = await page.evaluate(async (wiName) => {
            const headers = { 'Content-Type': 'application/json', ...window.Luker.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: wiName }) });
            return res.json();
        }, WI_BOOK);
        expect(Object.keys(materialized.entries)).toHaveLength(3);
        const materializedComments = Object.values(materialized.entries).map(e => e.comment).sort();
        expect(materializedComments).toEqual(['ash-skipper', 'bryn-headland', 'reef-conditions']);

        // ── Step 9: Persistence — restart, reload, the imported preset
        // still has the binding, and the WI file survives too.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return {
                hasExt: !!body?.extensions?.preset_lorebook,
                embedName: body?.extensions?.preset_lorebook?.name || '',
                entryCount: body?.extensions?.preset_lorebook?.data?.entries
                    ? Object.keys(body.extensions.preset_lorebook.data.entries).length
                    : 0,
            };
        }, IMPORTED_PRESET);
        expect(afterRestart.hasExt, 'embed survived restart on the imported preset').toBe(true);
        expect(afterRestart.embedName).toBe(WI_BOOK);
        expect(afterRestart.entryCount).toBe(3);

        const wiAfterRestart = await page.evaluate(async (wiName) => {
            const headers = { 'Content-Type': 'application/json', ...window.Luker.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: wiName }) });
            return res.json();
        }, WI_BOOK);
        expect(Object.keys(wiAfterRestart.entries)).toHaveLength(3);

        // ── Step 10: Also verify on-disk shape of the imported preset
        // file matches what we expect (sanity check that server side
        // wrote the embed verbatim, not stripped extensions).
        const presetPath = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', `${IMPORTED_PRESET}.json`);
        expect(existsSync(presetPath), 'imported preset file exists').toBe(true);
        const onDisk = JSON.parse(readFileSync(presetPath, 'utf-8'));
        expect(onDisk?.extensions?.preset_lorebook?.name).toBe(WI_BOOK);
        expect(Object.keys(onDisk.extensions.preset_lorebook.data.entries)).toHaveLength(3);
    });
});
