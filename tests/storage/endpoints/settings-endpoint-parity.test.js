// Smoke test for the endpoint-harness itself plus a first proof-of-bug.
//
// This file establishes the test pattern used throughout the db-parity work:
//   - describe.each(ENDPOINT_HARNESSES) parameterizes by storage engine.
//   - beforeEach builds a fresh app + storage stack per test (slow but
//     isolated).
//   - Tests exercise the real Express router via supertest.
//
// The bug demo at the bottom exercises the symptom the user reported:
// save a preset through the Repo, then ask /api/settings/get for it. Today
// it returns only the seed "Default" in db mode. After Phase 4 it must
// return the saved preset in every mode.

import request from 'supertest';

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
        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
        const parsed = typeof res.body.settings === 'string' ? JSON.parse(res.body.settings) : res.body.settings;
        expect(parsed.user_name).toBe('tester');
    });

    // --- Preset families ---
    //
    // For each of the four preset categories rendered in the settings payload,
    // simulate the user's repro: save through PresetRepo (what /api/presets/save
    // does internally), then ask the settings endpoint for the payload.
    // Before Phase 4 every db-mode case returned the seed-only directory listing.

    const PRESET_CASES = [
        { apiId: 'openai',              namesField: 'openai_setting_names',                  bodiesField: 'openai_settings' },
        { apiId: 'novel',               namesField: 'novelai_setting_names',                 bodiesField: 'novelai_settings' },
        { apiId: 'textgenerationwebui', namesField: 'textgenerationwebui_preset_names',      bodiesField: 'textgenerationwebui_presets' },
        { apiId: 'kobold',              namesField: 'koboldai_setting_names',                bodiesField: 'koboldai_settings' },
    ];

    for (const c of PRESET_CASES) {
        test(`REGRESSION: ${c.apiId} preset saved via PresetRepo surfaces in /get (${c.namesField})`, async () => {
            await getPresetRepo().save(harness.handle, c.apiId, 'MyCustomPreset', SAMPLE_PRESET);

            const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
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

            const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
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

        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
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

        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
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

        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.quickReplyPresets)).toBe(true);
        const found = res.body.quickReplyPresets.find((p) => p && p.name === 'CustomQR');
        expect(found).toBeDefined();
        expect(Array.isArray(found.quickReplies)).toBe(true);
    });

    // --- WorldInfo ---

    test('REGRESSION: world saved via WorldInfoRepo surfaces in /get (world_names)', async () => {
        await getWorldInfoRepo().save(harness.handle, 'MyLore', { entries: {} });

        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
        expect(Array.isArray(res.body.world_names)).toBe(true);
        expect(res.body.world_names).toContain('MyLore');
    });

    // --- bootstrap variant must share the same data ---

    test('REGRESSION: /bootstrap surfaces the same preset/world/themes data as /get', async () => {
        await getPresetRepo().save(harness.handle, 'openai', 'BootPreset', { marker: 'boot' });
        await getNamedDocRepo().save(harness.handle, 'themes', 'BootTheme', { name: 'BootTheme', x: 1 });
        await getWorldInfoRepo().save(harness.handle, 'BootLore', { entries: {} });

        const res = await request(harness.app).post('/api/settings/bootstrap').send({}).expect(200);
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

        const res = await request(harness.app).post('/api/settings/get').send({}).expect(200);
        expect(res.body.openai_setting_names).toContain('SurvivorPreset');
        expect(res.body.world_names).toContain('SurvivorLore');
        expect(res.body.themes.find((t) => t?.name === 'SurvivorTheme')).toBeDefined();
    });
});

