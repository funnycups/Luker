import { expect, test } from '@jest/globals';
import {
    GENERATION_CONFIG_KEYS,
    pickGenerationConfig,
    normalizeGenerationPresets,
    getGenerationPreset,
    createGenerationPreset,
    renameGenerationPreset,
    deleteGenerationPreset,
    selectGenerationPreset,
    applyGenerationConfig,
    syncGenerationPresetFromSettings,
    patchGenerationPresetConfig,
} from '../public/scripts/extensions/stable-diffusion/generation-presets.js';

const SD = {
    source: 'comfy',
    model: 'm1',
    sampler: 'euler',
    scheduler: 'normal',
    vae: 'v1',
    steps: 20,
    scale: 7,
    width: 832,
    height: 1216,
    prompt_prefix: 'prefix',
    negative_prompt: 'negative',
    style: 'Default',
    comfy_type: 'standard',
    comfy_url: 'http://127.0.0.1:8188',
    comfy_workflow: 'Test.json',
    comfy_placeholders: [{ find: 'a', replace: 'b' }],
    seed: 42,
    refine_mode: true,
    wand_visible: true,
    prompts: {},
    styles: [],
    character_prompts: {},
    character_negative_prompts: {},
    comfy_prompt: 'last',
};

test('pickGenerationConfig keeps only generation keys', () => {
    const config = pickGenerationConfig(SD);
    expect(config).toMatchObject({ source: 'comfy', model: 'm1', steps: 20, comfy_workflow: 'Test.json' });
    expect(config).not.toHaveProperty('seed');
    expect(config).not.toHaveProperty('refine_mode');
    expect(config).not.toHaveProperty('wand_visible');
    expect(config).not.toHaveProperty('prompts');
    expect(config).not.toHaveProperty('styles');
    expect(config).not.toHaveProperty('character_prompts');
    expect(config).not.toHaveProperty('comfy_prompt');
});

test('first normalization creates a default preset', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default', now: 10 });
    expect(bucket.presets).toHaveLength(1);
    expect(bucket.presets[0].name).toBe('Default');
    expect(bucket.presets[0].config.model).toBe('m1');
    expect(bucket.currentId).toBe(bucket.presets[0].id);
});

test('existing empty bucket stays empty', () => {
    const bucket = normalizeGenerationPresets({ currentId: '', presets: [] }, { currentConfig: pickGenerationConfig(SD) });
    expect(bucket.presets).toEqual([]);
    expect(bucket.currentId).toBe('');
});

test('create rejects duplicate names and snapshots the config', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    expect(() => createGenerationPreset(bucket, { name: 'Default', config: {} })).toThrow('already exists');
    const added = createGenerationPreset(bucket, { name: 'Second', config: { steps: 30 } });
    expect(added.config.steps).toBe(30);
});

test('rename rejects duplicate names', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    createGenerationPreset(bucket, { name: 'Second', config: {} });
    expect(() => renameGenerationPreset(bucket, bucket.currentId, 'Second')).toThrow('already exists');
});

test('delete selects the first remaining preset', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    const second = createGenerationPreset(bucket, { name: 'Second', config: {} });
    selectGenerationPreset(bucket, second.id);
    expect(deleteGenerationPreset(bucket, second.id)).toBe(bucket.presets[0].id);
});

test('apply writes only present keys and deep-clones placeholders', () => {
    const config = { steps: 30, comfy_placeholders: [{ find: 'a', replace: 'b' }] };
    const sd = { ...SD, steps: 1, comfy_placeholders: [{ find: 'x', replace: 'y' }] };
    const applied = applyGenerationConfig(sd, config);
    expect(applied).toEqual(['steps', 'comfy_placeholders']);
    expect(sd.steps).toBe(30);
    expect(sd.comfy_placeholders).toEqual([{ find: 'a', replace: 'b' }]);
    expect(sd.comfy_placeholders).not.toBe(config.comfy_placeholders);
});

test('sync writes user edits into the current preset', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    const edited = { ...SD, model: 'm2', steps: 40 };
    syncGenerationPresetFromSettings(bucket, edited, { now: 99 });
    const preset = getGenerationPreset(bucket, bucket.currentId);
    expect(preset.config.model).toBe('m2');
    expect(preset.config.steps).toBe(40);
    expect(preset.updatedAt).toBe(99);
});

test('sync is a no-op without a current preset', () => {
    const bucket = { currentId: '', presets: [] };
    expect(syncGenerationPresetFromSettings(bucket, { ...SD, steps: 40 })).toBeNull();
    expect(bucket.presets).toEqual([]);
});

test('sync omits derived option keys from untargeted edits', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    const edited = { ...SD, model: null, sampler: null, scheduler: null, vae: null, steps: 40 };
    syncGenerationPresetFromSettings(bucket, edited, { now: 42, omitKeys: ['model', 'sampler', 'scheduler', 'vae'] });
    const preset = getGenerationPreset(bucket, bucket.currentId);
    expect(preset.config.model).toBe('m1');
    expect(preset.config.sampler).toBe('euler');
    expect(preset.config.scheduler).toBe('normal');
    expect(preset.config.vae).toBe('v1');
    expect(preset.config.steps).toBe(40);
    expect(preset.updatedAt).toBe(42);
});

test('patch writes only allowed keys', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(SD), defaultName: 'Default' });
    patchGenerationPresetConfig(bucket, bucket.currentId, { source: 'novel', unknown: 1 });
    const preset = getGenerationPreset(bucket, bucket.currentId);
    expect(preset.config.source).toBe('novel');
    expect(preset.config.model).toBe('m1');
    expect(preset.config).not.toHaveProperty('unknown');
});

test('patch is a no-op without a current preset', () => {
    const bucket = { currentId: '', presets: [] };
    expect(patchGenerationPresetConfig(bucket, '', { source: 'novel' })).toBeNull();
    expect(bucket.presets).toEqual([]);
});

test('the field whitelist excludes volatile generation values', () => {
    expect(GENERATION_CONFIG_KEYS).toContain('comfy_placeholders');
    expect(GENERATION_CONFIG_KEYS).not.toContain('seed');
    expect(GENERATION_CONFIG_KEYS).not.toContain('original_seed');
    expect(GENERATION_CONFIG_KEYS).not.toContain('comfy_prompt');
});

test('preset ids stay unique within the same millisecond', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: {}, defaultName: 'Default', now: 5 });
    const second = createGenerationPreset(bucket, { name: 'Second', config: {}, now: 5 });
    const third = createGenerationPreset(bucket, { name: 'Third', config: {}, now: 5 });
    expect(bucket.presets[0].id).toBe('genpreset_5');
    expect(second.id).toBe('genpreset_5_1');
    expect(third.id).toBe('genpreset_5_2');
});

test('normalization drops invalid presets and repairs currentId', () => {
    const bucket = normalizeGenerationPresets({
        currentId: 'missing',
        presets: [
            null,
            { name: 'No id', config: {} },
            { id: 'genpreset_1', name: 'Kept', config: { steps: 12 } },
        ],
    }, { now: 20 });
    expect(bucket.presets).toHaveLength(1);
    expect(bucket.presets[0].id).toBe('genpreset_1');
    expect(bucket.presets[0].config).toEqual({ steps: 12 });
    expect(bucket.currentId).toBe('genpreset_1');
});

test('create snapshots only whitelisted config keys', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: {}, defaultName: 'Default' });
    const preset = createGenerationPreset(bucket, { name: 'Second', config: { steps: 30, seed: 7, unknown: true } });
    expect(preset.config).toEqual({ steps: 30 });
});

test('apply ignores keys outside the whitelist', () => {
    const sd = { steps: 1, seed: 42 };
    expect(applyGenerationConfig(sd, { seed: 7, unknown: 1 })).toEqual([]);
    expect(sd.seed).toBe(42);
});

test('patch returns null when the preset does not exist', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: {}, defaultName: 'Default' });
    expect(patchGenerationPresetConfig(bucket, 'genpreset_404', { steps: 2 })).toBeNull();
});

test('sync merges config so keys absent from settings survive', () => {
    const bucket = normalizeGenerationPresets(undefined, { currentConfig: { model: 'm1', steps: 20 }, defaultName: 'Default' });
    syncGenerationPresetFromSettings(bucket, { model: 'm2' }, { now: 7 });
    const preset = getGenerationPreset(bucket, bucket.currentId);
    expect(preset.config).toEqual({ model: 'm2', steps: 20 });
    expect(preset.updatedAt).toBe(7);
});
