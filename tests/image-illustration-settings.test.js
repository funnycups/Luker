import { describe, expect, test } from '@jest/globals';
import {
    IMAGE_CONFIG_KEYS,
    normalizeIllustrationSettings,
    readImageConfig,
    applyImageConfig,
    imageConfigFingerprint,
    getPresetById,
    addPresetFromCurrent,
    updatePreset,
    deletePreset,
    selectPreset,
} from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';

const sd = {
    source: 'auto', model: 'm', steps: 20, width: 512, height: 512,
    api_key: 'must-not-copy', seed: 123, prompts: { 0: 'x' },
};

describe('illustration settings', () => {
    test('readImageConfig only returns whitelisted keys', () => {
        const config = readImageConfig(sd);
        expect(Object.keys(config).sort()).toEqual([...IMAGE_CONFIG_KEYS].sort());
        expect(config).not.toHaveProperty('api_key');
        expect(config).not.toHaveProperty('seed');
        expect(config).not.toHaveProperty('prompts');
    });

    test('applyImageConfig only writes whitelisted keys', () => {
        const target = {};
        const applied = applyImageConfig(target, { source: 'auto', api_key: 'x', seed: 1 });
        expect(applied).toEqual(['source']);
        expect(target).toEqual({ source: 'auto' });
    });

    test('imageConfigFingerprint is stable across key order', () => {
        expect(imageConfigFingerprint({ width: 512, source: 'auto' }))
            .toBe(imageConfigFingerprint({ source: 'auto', width: 512 }));
        expect(imageConfigFingerprint({ width: 512 }))
            .not.toBe(imageConfigFingerprint({ width: 768 }));
    });

    test('first normalization creates two presets and snapshots image config', () => {
        const settings = normalizeIllustrationSettings(undefined, { imageConfig: sd, llm: {} });
        expect(settings.initialized).toBe(true);
        expect(settings.presets).toHaveLength(2);
        expect(settings.presets[0].image.source).toBe('auto');
        expect(settings.currentPresetId).toBe(settings.presets[0].id);
    });

    test('initialized empty preset list stays empty', () => {
        const settings = normalizeIllustrationSettings(
            { initialized: true, presets: [], currentPresetId: '' },
            { imageConfig: sd, llm: {} },
        );
        expect(settings.presets).toEqual([]);
        expect(settings.currentPresetId).toBe('');
    });

    test('add, update, select and delete presets', () => {
        const settings = normalizeIllustrationSettings(undefined, { imageConfig: sd, llm: {} });
        const added = addPresetFromCurrent(settings, {
            name: 'Copy', imageConfig: { ...sd, width: 768 }, llm: {}, now: 10,
        });
        expect(getPresetById(settings, added.id).name).toBe('Copy');
        updatePreset(settings, added.id, { name: 'Renamed' }, 20);
        expect(getPresetById(settings, added.id).name).toBe('Renamed');
        selectPreset(settings, added.id);
        expect(settings.currentPresetId).toBe(added.id);
        deletePreset(settings, added.id);
        expect(getPresetById(settings, added.id)).toBeNull();
        expect(settings.currentPresetId).toBe(settings.presets[0].id);
    });
});
