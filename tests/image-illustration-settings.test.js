import { describe, expect, test } from '@jest/globals';
import {
    normalizeIllustrationSettings,
    getPresetById,
    addPresetFromCurrent,
    updatePreset,
    deletePreset,
    selectPreset,
} from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';

describe('illustration settings', () => {
    test('first normalization creates two presets', () => {
        const settings = normalizeIllustrationSettings(undefined, { llm: {} });
        expect(settings.initialized).toBe(true);
        expect(settings.presets).toHaveLength(2);
        expect(settings.presets[0]).not.toHaveProperty('image');
        expect(settings.currentPresetId).toBe(settings.presets[0].id);
    });

    test('existing preset image snapshots are dropped', () => {
        const settings = normalizeIllustrationSettings({
            initialized: true,
            currentPresetId: 'p',
            presets: [{
                id: 'p',
                name: 'P',
                illustrationPrompt: 'x',
                studioPrompt: 'y',
                llm: { apiPresetName: '', llmPresetName: '' },
                image: { width: 768 },
            }],
        }, { llm: {} });
        expect(getPresetById(settings, 'p')).not.toHaveProperty('image');
    });

    test('initialized empty preset list stays empty', () => {
        const settings = normalizeIllustrationSettings(
            { initialized: true, presets: [], currentPresetId: '' },
            { llm: {} },
        );
        expect(settings.presets).toEqual([]);
        expect(settings.currentPresetId).toBe('');
    });

    test('add, update, select and delete presets', () => {
        const settings = normalizeIllustrationSettings(undefined, { llm: {} });
        const added = addPresetFromCurrent(settings, {
            name: 'Copy', llm: {}, now: 10,
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

    test('does not recreate studioSessions on fresh or migrated settings while preserving characterDesignPrompt across normalize, copy, and update', () => {
        const fresh = normalizeIllustrationSettings(undefined, { llm: {} });
        expect(Object.hasOwn(fresh, 'studioSessions')).toBe(false);

        const withLegacy = normalizeIllustrationSettings({
            initialized: true,
            currentPresetId: 'p1',
            studioSessions: { s1: { id: 's1', title: 'Old' } },
            presets: [{
                id: 'p1',
                name: 'P1',
                illustrationPrompt: 'ill',
                studioPrompt: 'stu',
                characterDesignPrompt: 'Custom OC sheet prompt',
                llm: { apiPresetName: '', llmPresetName: '' },
            }],
        }, { llm: {} });
        expect(Object.hasOwn(withLegacy, 'studioSessions')).toBe(true);
        expect(getPresetById(withLegacy, 'p1').characterDesignPrompt).toBe('Custom OC sheet prompt');

        const copied = addPresetFromCurrent(withLegacy, { name: 'P2', llm: {}, now: 100 });
        expect(copied.characterDesignPrompt).toBe('Custom OC sheet prompt');

        updatePreset(withLegacy, copied.id, { characterDesignPrompt: 'Updated OC prompt' }, 200);
        expect(getPresetById(withLegacy, copied.id).characterDesignPrompt).toBe('Updated OC prompt');
    });
});
