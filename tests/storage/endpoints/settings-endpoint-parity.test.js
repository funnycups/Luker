// Smoke test for the endpoint-harness itself plus a first proof-of-bug.
//
// This file establishes the test pattern used throughout the db-parity work:
//   - describe.each(ENDPOINT_HARNESSES) parameterizes by storage engine.
//   - beforeEach builds a fresh app + storage stack per test (slow but
//     isolated).
//   - Tests exercise the real Express router via supertest.
//
// The bug demo at the bottom exercises the symptom the user reported:
// save a preset through the Repo, then ask /api/settings/get for it. Previously
// it returned only the seed "Default" in db mode; it must
// return the saved preset in every mode.

import request from 'supertest';
import { router as presetsRouter } from '../../../src/endpoints/presets.js';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as settingsRouter } from '../../../src/endpoints/settings.js';
import {
    getPresetRepo,
    getSettingsRepo,
    getNamedDocRepo,
    getWorldInfoRepo,
} from '../../../src/storage/index.js';

const SAMPLE_PRESET = {
    temperature: 0.91,
    top_p: 0.92,
    custom_marker: 'user_saved_in_db_mode',
};

describe.each(ENDPOINT_HARNESSES)('settings.js endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/settings', settingsRouter);
                app.use('/api/presets', presetsRouter);
            },
        });
        // Seed a minimal settings doc; /get throws if the settings handle is
        // missing.
        await getSettingsRepo().save(harness.handle, { user_name: 'tester' });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('GET /api/settings/get returns 200 with the settings JSON', async () => {
        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        const parsed = typeof res.body.settings === 'string' ? JSON.parse(res.body.settings) : res.body.settings;
        expect(parsed.user_name).toBe('tester');
    });

    test('accepted preset and orphan state endpoint writes remain distinct in settings and bootstrap', async () => {
        const preset = { prompts: [{ name: 'endpoint', content: 'FULL_ENDPOINT_PRESET' }], temperature: 0.31 };
        await request(harness.server).post('/api/presets/save').send({ apiId: 'openai', name: 'A.luker-state.n', preset }).expect(200);
        await request(harness.server).post('/api/presets/state/patch').send({ apiId: 'openai', name: 'A', namespace: 'n', operations: [{ op: 'add', path: '/notes', value: ['FULL_ENDPOINT_STATE'] }] }).expect(200);
        await getSettingsRepo().save(harness.handle, { user_name: 'tester', oai_settings: { preset_settings_openai: 'A.luker-state.n' } });
        for (const route of ['get', 'bootstrap']) {
            const response = await request(harness.server).post(`/api/settings/${route}`).send({}).expect(200);
            expect(response.body.openai_setting_names).toEqual(['A.luker-state.n']);
            expect(JSON.parse(response.body.openai_settings[0])).toEqual(preset);
        }
        const state = await request(harness.server).post('/api/presets/state/get').send({ apiId: 'openai', name: 'A', namespace: 'n' }).expect(200);
        expect(state.body).toEqual({ ok: true, data: { notes: ['FULL_ENDPOINT_STATE'] } });
        expect(await getPresetRepo().get(harness.handle, 'openai', 'A')).toBeNull();
    });

    test('preset deletion removes its own state while the absent-document guard preserves independent orphan state', async () => {
        const legacy = { notes: ['COMPLETE_LEGACY_STATE'], nested: { retained: true } };
        const own = { notes: ['COMPLETE_OWN_STATE'] };
        const repo = getPresetRepo();
        await repo.setState(harness.handle, 'openai', 'A', 'n', legacy);
        await repo.setState(harness.handle, 'openai', 'A.luker-state.n', 'm', own);
        await request(harness.server).post('/api/presets/delete').send({ apiId: 'openai', name: 'A.luker-state.n' }).expect(404);
        expect(await repo.getState(harness.handle, 'openai', 'A', 'n')).toEqual(legacy);
        expect(await repo.getState(harness.handle, 'openai', 'A.luker-state.n', 'm')).toEqual(own);
        await request(harness.server).post('/api/presets/save').send({ apiId: 'openai', name: 'A.luker-state.n', preset: SAMPLE_PRESET }).expect(200);
        await request(harness.server).post('/api/presets/delete').send({ apiId: 'openai', name: 'A.luker-state.n' }).expect(200);
        expect(await repo.exists(harness.handle, 'openai', 'A.luker-state.n')).toBe(false);
        expect(await repo.getState(harness.handle, 'openai', 'A.luker-state.n', 'm')).toBeNull();
        expect(await repo.getState(harness.handle, 'openai', 'A', 'n')).toEqual(legacy);
    });

    // --- Preset families ---
    //
    // For each of the four preset categories rendered in the settings payload,
    // simulate the user's repro: save through PresetRepo (what /api/presets/save
    // does internally), then ask the settings endpoint for the payload.
    // Previously every db-mode case returned the seed-only directory listing.

    const PRESET_CASES = [
        { apiId: 'openai',              namesField: 'openai_setting_names',                  bodiesField: 'openai_settings' },
        { apiId: 'novel',               namesField: 'novelai_setting_names',                 bodiesField: 'novelai_settings' },
        { apiId: 'textgenerationwebui', namesField: 'textgenerationwebui_preset_names',      bodiesField: 'textgenerationwebui_presets' },
        { apiId: 'kobold',              namesField: 'koboldai_setting_names',                bodiesField: 'koboldai_settings' },
    ];

    for (const c of PRESET_CASES) {
        test(`REGRESSION: ${c.apiId} preset saved via PresetRepo surfaces in /get (${c.namesField})`, async () => {
            await getPresetRepo().save(harness.handle, c.apiId, 'MyCustomPreset', SAMPLE_PRESET);

            const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
            const names = res.body[c.namesField];
            const bodies = res.body[c.bodiesField];
            expect(names).toContain('MyCustomPreset');
            const idx = names.indexOf('MyCustomPreset');
            expect(idx).toBeGreaterThanOrEqual(0);
            const parsed = typeof bodies[idx] === 'string' ? JSON.parse(bodies[idx]) : bodies[idx];
            expect(parsed.custom_marker).toBe('user_saved_in_db_mode');
            expect(parsed.temperature).toBe(0.91);
        });
    }

    // --- Preset-shaped categories (instruct / context / sysprompt / reasoning) ---

    const DOC_PRESET_CASES = [
        { apiId: 'instruct',  field: 'instruct' },
        { apiId: 'context',   field: 'context' },
        { apiId: 'sysprompt', field: 'sysprompt' },
        { apiId: 'reasoning', field: 'reasoning' },
    ];

    for (const c of DOC_PRESET_CASES) {
        test(`REGRESSION: ${c.apiId} doc saved via PresetRepo surfaces in /get (${c.field})`, async () => {
            await getPresetRepo().save(harness.handle, c.apiId, 'CustomDoc', {
                name: 'CustomDoc',
                marker: 'user_saved_in_db_mode',
            });

            const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
            const arr = res.body[c.field];
            expect(Array.isArray(arr)).toBe(true);
            const found = arr.find((e) => e && e.name === 'CustomDoc');
            expect(found).toBeDefined();
            expect(found.marker).toBe('user_saved_in_db_mode');
        });
    }

    // --- NamedDocRepo buckets (themes, movingUI, quickReplies) ---

    test('REGRESSION: theme saved via NamedDocRepo surfaces in /get (themes)', async () => {
        await getNamedDocRepo().save(harness.handle, 'themes', 'CustomTheme', {
            name: 'CustomTheme',
            bg_color: '#cafe00',
        });

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.themes)).toBe(true);
        const found = res.body.themes.find((t) => t && t.name === 'CustomTheme');
        expect(found).toBeDefined();
        expect(found.bg_color).toBe('#cafe00');
    });

    test('REGRESSION: movingUI preset saved via NamedDocRepo surfaces in /get (movingUIPresets)', async () => {
        await getNamedDocRepo().save(harness.handle, 'movingUI', 'CustomUI', {
            name: 'CustomUI',
            offsetX: 42,
        });

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.movingUIPresets)).toBe(true);
        const found = res.body.movingUIPresets.find((p) => p && p.name === 'CustomUI');
        expect(found).toBeDefined();
        expect(found.offsetX).toBe(42);
    });

    test('REGRESSION: quickReply set saved via NamedDocRepo surfaces in /get (quickReplyPresets)', async () => {
        await getNamedDocRepo().save(harness.handle, 'quickReplies', 'CustomQR', {
            name: 'CustomQR',
            quickReplies: [{ label: 'hi', message: 'hello' }],
        });

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.quickReplyPresets)).toBe(true);
        const found = res.body.quickReplyPresets.find((p) => p && p.name === 'CustomQR');
        expect(found).toBeDefined();
        expect(Array.isArray(found.quickReplies)).toBe(true);
    });

    // --- WorldInfo ---

    test('REGRESSION: world saved via WorldInfoRepo surfaces in /get (world_names)', async () => {
        await getWorldInfoRepo().save(harness.handle, 'MyLore', { entries: {} });

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.world_names)).toBe(true);
        expect(res.body.world_names).toContain('MyLore');
    });

    // --- bootstrap variant must share the same data ---

    test('REGRESSION: /bootstrap surfaces the same preset/world/themes data as /get', async () => {
        await getPresetRepo().save(harness.handle, 'openai', 'BootPreset', { marker: 'boot' });
        await getNamedDocRepo().save(harness.handle, 'themes', 'BootTheme', { name: 'BootTheme', x: 1 });
        await getWorldInfoRepo().save(harness.handle, 'BootLore', { entries: {} });

        const res = await request(harness.server).post('/api/settings/bootstrap').send({}).expect(200);
        expect(res.body.openai_setting_names).toContain('BootPreset');
        expect(res.body.world_names).toContain('BootLore');
        expect(res.body.themes.find((t) => t?.name === 'BootTheme')).toBeDefined();
        // bootstrap explicitly skips quickReplies for payload size.
        expect(res.body.quickReplyPresets).toEqual([]);
    });

    // --- Read-after-restart: simulates the actual user repro path ---

    test('REGRESSION: data persists across engine restart (user repro path)', async () => {
        await getPresetRepo().save(harness.handle, 'openai', 'SurvivorPreset', { marker: 'durable' });
        await getNamedDocRepo().save(harness.handle, 'themes', 'SurvivorTheme', { name: 'SurvivorTheme', x: 1 });
        await getWorldInfoRepo().save(harness.handle, 'SurvivorLore', { entries: {} });

        await harness.reopenEngine();

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        expect(res.body.openai_setting_names).toContain('SurvivorPreset');
        expect(res.body.world_names).toContain('SurvivorLore');
        expect(res.body.themes.find((t) => t?.name === 'SurvivorTheme')).toBeDefined();
    });
});

// Fresh-storage seeding: a user who flips storage.mode from fs to a db mode
// without first running the migration script must still be able to hit
// /api/settings/get without a 500. The endpoint imports the legacy
// settings.json off disk if SettingsRepo is empty.

describe.each(ENDPOINT_HARNESSES)('settings.js fresh-storage handling on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/settings', settingsRouter); },
        });
        // DO NOT seed SettingsRepo — that's the whole point of this test.
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: missing settings doc + missing settings.json → 200 with empty defaults', async () => {
        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        const parsed = typeof res.body.settings === 'string' ? JSON.parse(res.body.settings) : res.body.settings;
        expect(parsed).toEqual({});
    });

    test('REGRESSION: missing settings doc + existing settings.json → settings imported into Repo', async () => {
        // Plant a legacy on-disk settings.json (the FS engine's storage shape)
        // for a user who had data but never ran storage:migrate after switching
        // to a db mode. The endpoint must one-shot import it into SettingsRepo.
        const fs = await import('node:fs');
        const path = await import('node:path');
        fs.mkdirSync(harness.dirs.root, { recursive: true });
        fs.writeFileSync(
            path.join(harness.dirs.root, 'settings.json'),
            JSON.stringify({ user_name: 'legacy-fs-user', custom: 'imported' }),
            'utf8',
        );

        const res = await request(harness.server).post('/api/settings/get').send({}).expect(200);
        const parsed = typeof res.body.settings === 'string' ? JSON.parse(res.body.settings) : res.body.settings;
        expect(parsed.user_name).toBe('legacy-fs-user');
        expect(parsed.custom).toBe('imported');

        if (mode !== 'fs') {
            // For db modes specifically: future /get calls must come from
            // SettingsRepo, not from a re-read of the legacy fs file. Wipe
            // the on-disk file and confirm the in-engine copy still answers.
            // (In fs mode this is a no-op assertion because settings.json IS
            // the engine storage.)
            fs.unlinkSync(path.join(harness.dirs.root, 'settings.json'));
            const res2 = await request(harness.server).post('/api/settings/get').send({}).expect(200);
            const parsed2 = typeof res2.body.settings === 'string' ? JSON.parse(res2.body.settings) : res2.body.settings;
            expect(parsed2.user_name).toBe('legacy-fs-user');
        }
    });
});
