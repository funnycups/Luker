import { describe, expect, test } from '@jest/globals';
import * as illustrationSettings from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';
import * as promptDefaults from '../public/scripts/extensions/stable-diffusion/illustration/presets.js';
import { DEFAULT_EXPLORATION_PROMPT } from '../public/scripts/extensions/stable-diffusion/exploration/prompts.js';
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

    test('does not recreate studioSessions on fresh or migrated settings and removes retired characterDesignPrompt from presets', () => {
        const fresh = normalizeIllustrationSettings(undefined, { llm: {} });
        expect(Object.hasOwn(fresh, 'studioSessions')).toBe(false);
        for (const preset of fresh.presets) {
            expect(Object.hasOwn(preset, 'characterDesignPrompt')).toBe(false);
        }

        const withLegacy = normalizeIllustrationSettings({
            initialized: true,
            currentPresetId: 'p1',
            studioSessions: { s1: { id: 's1', title: 'Old' } },
            presets: [{
                id: 'p1',
                name: 'P1',
                promptStyle: 'tag',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'ill',
                studioPrompt: 'stu',
                explorationPrompt: 'exp',
                characterDesignPrompt: 'Custom OC sheet prompt',
                llm: { apiPresetName: '', llmPresetName: '' },
            }],
        }, { llm: {} });
        expect(Object.hasOwn(withLegacy, 'studioSessions')).toBe(true);
        expect(Object.hasOwn(getPresetById(withLegacy, 'p1'), 'characterDesignPrompt')).toBe(false);

        const copied = addPresetFromCurrent(withLegacy, { name: 'P2', promptStyle: 'tag', llm: {}, now: 100 });
        expect(Object.hasOwn(copied, 'characterDesignPrompt')).toBe(false);

        updatePreset(withLegacy, copied.id, { characterDesignPrompt: 'Updated OC prompt' }, 200);
        expect(Object.hasOwn(getPresetById(withLegacy, copied.id), 'characterDesignPrompt')).toBe(false);
    });
});

function migratePrompts(raw, options) {
    expect(illustrationSettings.migrateIllustrationPromptSettings).toEqual(expect.any(Function));
    return illustrationSettings.migrateIllustrationPromptSettings(raw, options);
}

describe('stored illustration prompt defaults', () => {
    test('new presets store an explicit style and full prompt defaults', () => {
        const settings = normalizeIllustrationSettings(undefined, { now: 10 });
        const expected = [
            ['tag', promptDefaults.DEFAULT_ILLUSTRATION_PROMPT, promptDefaults.DEFAULT_STUDIO_PROMPT],
            ['natural', promptDefaults.DEFAULT_NATURAL_ILLUSTRATION_PROMPT, promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT],
        ];
        for (const [index, [style, illustrationPrompt, studioPrompt]] of expected.entries()) {
            const preset = settings.presets[index];
            expect(preset.promptStyle).toBe(style);
            expect(preset.promptDefaultsInitialized).toBe(true);
            expect(preset.illustrationPrompt).toBe(illustrationPrompt);
            expect(preset.studioPrompt).toBe(studioPrompt);
            expect(preset.explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
        }
    });

    test('default prompt values follow only the requested style', () => {
        expect(promptDefaults.getDefaultPromptValues).toEqual(expect.any(Function));
        expect(promptDefaults.getDefaultPromptValues('tag')).toEqual({
            illustrationPrompt: promptDefaults.DEFAULT_ILLUSTRATION_PROMPT,
            studioPrompt: promptDefaults.DEFAULT_STUDIO_PROMPT,
            explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
        });
        expect(promptDefaults.getDefaultPromptValues('natural')).toEqual({
            illustrationPrompt: promptDefaults.DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
            studioPrompt: promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT,
            explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
        });
        expect(() => promptDefaults.getDefaultPromptValues('')).toThrow();
        expect(() => promptDefaults.getDefaultPromptValues('automatic')).toThrow();
    });

    test('migratesLegacyBlankPromptsOnce', () => {
        const raw = {
            initialized: true,
            currentPresetId: 'legacy',
            presets: [{
                id: 'legacy',
                name: 'Saved preset',
                illustrationPrompt: promptDefaults.LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
                studioPrompt: ' \n ',
                explorationPrompt: '',
            }],
        };
        const { settings } = migratePrompts(raw, { now: 20 });
        const preset = settings.presets[0];
        expect(preset.promptStyle).toBe('tag');
        expect(preset.illustrationPrompt).toBe(promptDefaults.DEFAULT_ILLUSTRATION_PROMPT);
        expect(preset.studioPrompt).toBe(promptDefaults.DEFAULT_STUDIO_PROMPT);
        expect(preset.explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
        expect(preset.promptDefaultsInitialized).toBe(true);
        expect(raw.presets[0]).not.toHaveProperty('promptDefaultsInitialized');
        expect(raw.presets[0].studioPrompt).toBe(' \n ');

        updatePreset(settings, preset.id, { illustrationPrompt: '', studioPrompt: '', explorationPrompt: '' });
        const again = migratePrompts(settings).settings.presets[0];
        expect(again.illustrationPrompt).toBe('');
        expect(again.studioPrompt).toBe('');
        expect(again.explorationPrompt).toBe('');
    });

    test('preservesClearedCurrentPrompts', () => {
        const raw = {
            initialized: true,
            presets: [{
                id: 'current',
                name: 'Saved preset',
                promptStyle: 'natural',
                promptDefaultsInitialized: true,
                illustrationPrompt: '',
                studioPrompt: '',
                explorationPrompt: '',
            }],
        };
        const normalized = normalizeIllustrationSettings(raw);
        const migrated = migratePrompts(raw).settings;
        for (const settings of [normalized, migrated]) {
            expect(settings.presets[0].illustrationPrompt).toBe('');
            expect(settings.presets[0].studioPrompt).toBe('');
            expect(settings.presets[0].explorationPrompt).toBe('');
            expect(settings.presets[0].promptStyle).toBe('natural');
        }
    });

    test('requiresStyleChoiceForCustomPresets', () => {
        const customText = '  Use the supplied visual details.\n\n';
        const { settings } = migratePrompts({
            initialized: true,
            presets: [{
                id: 'custom',
                name: 'Tag style',
                illustrationPrompt: customText,
                studioPrompt: '',
                explorationPrompt: '',
            }, {
                id: 'fragment',
                name: 'Natural language style',
                illustrationPrompt: `${promptDefaults.DEFAULT_ILLUSTRATION_PROMPT}\nKeep the requested details.`,
                studioPrompt: '',
            }],
        });
        for (const preset of settings.presets) {
            expect(preset).not.toHaveProperty('promptStyle');
            expect(preset.studioPrompt).toBe('');
            expect(preset.explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
            expect(preset.pendingStyleDefaults).toEqual(['studioPrompt']);
        }
        updatePreset(settings, 'custom', { promptStyle: 'natural' });
        expect(settings.presets[0].promptStyle).toBe('natural');
        expect(settings.presets[0].illustrationPrompt).toBe(customText);
        expect(settings.presets[0].studioPrompt).toBe(promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT);
        expect(settings.presets[0]).not.toHaveProperty('pendingStyleDefaults');
    });

    test('an explicit edit cancels pending initialization before style selection', () => {
        const { settings } = migratePrompts({
            initialized: true,
            presets: [{ id: 'custom', name: 'Saved preset', illustrationPrompt: 'Keep the supplied details.' }],
        });
        updatePreset(settings, 'custom', { studioPrompt: '' });
        updatePreset(settings, 'custom', { promptStyle: 'tag' });
        expect(settings.presets[0].studioPrompt).toBe('');
        expect(settings.presets[0].illustrationPrompt).toBe('Keep the supplied details.');
        expect(settings.presets[0]).not.toHaveProperty('pendingStyleDefaults');
    });

    test('requiresVisiblePromptMigration', () => {
        const customText = '  Develop the requested appearance.\nKeep every stitch.\n\n';
        const { settings, pendingCharacterDesignPrompts } = migratePrompts({
            initialized: true,
            presets: [{
                id: 'legacy-design',
                name: 'Saved preset',
                promptStyle: 'tag',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'ill',
                studioPrompt: 'stu',
                explorationPrompt: 'exp',
                characterDesignPrompt: customText,
            }, {
                id: 'blank-design',
                name: 'Blank legacy',
                promptStyle: 'tag',
                promptDefaultsInitialized: true,
                illustrationPrompt: 'ill',
                studioPrompt: 'stu',
                explorationPrompt: 'exp',
                characterDesignPrompt: '   \n ',
            }],
        });

        expect(Object.hasOwn(settings.presets[0], 'characterDesignPrompt')).toBe(false);
        expect(Object.hasOwn(settings.presets[1], 'characterDesignPrompt')).toBe(false);
        expect(pendingCharacterDesignPrompts).toEqual([{
            presetId: 'legacy-design',
            presetName: 'Saved preset',
            text: customText,
        }]);
        expect(settings.pendingCharacterDesignPrompts).toEqual(pendingCharacterDesignPrompts);

        // Repeated normalization and migration preserve the unresolved migration record without re-adding the retired key.
        const normalizedAgain = normalizeIllustrationSettings(settings);
        expect(Object.hasOwn(normalizedAgain.presets[0], 'characterDesignPrompt')).toBe(false);
        expect(normalizedAgain.pendingCharacterDesignPrompts).toEqual(pendingCharacterDesignPrompts);
        expect(migratePrompts(normalizedAgain).pendingCharacterDesignPrompts).toEqual(pendingCharacterDesignPrompts);

        // Export content contains exact verbatim text; clearing deletes the pending list completely.
        expect(illustrationSettings.exportPendingCharacterDesignPromptsContent).toEqual(expect.any(Function));
        const exported = illustrationSettings.exportPendingCharacterDesignPromptsContent(pendingCharacterDesignPrompts);
        expect(exported).toContain(customText);
        expect(illustrationSettings.clearPendingCharacterDesignPrompts).toEqual(expect.any(Function));
        illustrationSettings.clearPendingCharacterDesignPrompts(settings);
        expect(Object.hasOwn(settings, 'pendingCharacterDesignPrompts')).toBe(false);
        expect(migratePrompts(settings).pendingCharacterDesignPrompts).toEqual([]);
    });

    test('a new preset without a template uses its explicitly selected defaults', () => {
        const settings = normalizeIllustrationSettings({ initialized: true, presets: [] });
        const preset = addPresetFromCurrent(settings, { name: 'Saved preset', promptStyle: 'natural', now: 30 });
        expect(preset.promptStyle).toBe('natural');
        expect(preset.promptDefaultsInitialized).toBe(true);
        expect(preset.illustrationPrompt).toBe(promptDefaults.DEFAULT_NATURAL_ILLUSTRATION_PROMPT);
        expect(preset.studioPrompt).toBe(promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT);
        expect(preset.explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
    });

    test('a copied preset initializes blank fields without changing the source preset', () => {
        const settings = normalizeIllustrationSettings(undefined);
        const source = settings.presets[0];
        updatePreset(settings, source.id, { illustrationPrompt: '', studioPrompt: '', explorationPrompt: '' });
        const copy = addPresetFromCurrent(settings, { name: 'Saved copy', promptStyle: 'natural' });
        expect(copy.illustrationPrompt).toBe(promptDefaults.DEFAULT_NATURAL_ILLUSTRATION_PROMPT);
        expect(copy.studioPrompt).toBe(promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT);
        expect(copy.explorationPrompt).toBe(DEFAULT_EXPLORATION_PROMPT);
        expect(source.illustrationPrompt).toBe('');
        expect(source.studioPrompt).toBe('');
        expect(source.explorationPrompt).toBe('');
    });

    test('invalid style updates do not partially change the preset', () => {
        const settings = normalizeIllustrationSettings(undefined);
        const preset = settings.presets[0];
        const previousName = preset.name;
        expect(() => updatePreset(settings, preset.id, {
            name: 'Do not apply this change',
            promptStyle: 'automatic',
        })).toThrow();
        expect(preset.name).toBe(previousName);
    });

    test('migration reports changed false on steady state and normalizes invalid legacy promptStyle safely', () => {
        const initial = migratePrompts(undefined, { now: 50 });
        expect(initial.changed).toBe(true);
        const steady = migratePrompts(initial.settings, { now: 60 });
        expect(steady.changed).toBe(false);

        const legacyInvalid = migratePrompts({
            initialized: true,
            currentPresetId: 'bad-style',
            presets: [{
                id: 'bad-style',
                name: 'Legacy Preset',
                promptStyle: '',
                illustrationPrompt: 'Custom prompt',
                studioPrompt: '',
                explorationPrompt: '',
            }],
        }, { now: 70 });
        expect(legacyInvalid.changed).toBe(true);
        expect(legacyInvalid.settings.presets[0]).not.toHaveProperty('promptStyle');
        expect(legacyInvalid.settings.presets[0].pendingStyleDefaults).toEqual(['studioPrompt']);
    });

    test('upgrades exact V1 default illustration prompts even on already-initialized presets while preserving custom and cleared prompts', () => {
        const raw = {
            initialized: true,
            currentPresetId: 'v1_tag',
            presets: [
                {
                    id: 'v1_tag',
                    name: 'Tag style',
                    promptStyle: 'tag',
                    promptDefaultsInitialized: true,
                    illustrationPrompt: promptDefaults.V1_DEFAULT_ILLUSTRATION_PROMPT,
                    studioPrompt: promptDefaults.DEFAULT_STUDIO_PROMPT,
                    explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
                },
                {
                    id: 'v1_natural',
                    name: 'Natural',
                    promptStyle: 'natural',
                    promptDefaultsInitialized: true,
                    illustrationPrompt: promptDefaults.V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
                    studioPrompt: promptDefaults.DEFAULT_NATURAL_STUDIO_PROMPT,
                    explorationPrompt: DEFAULT_EXPLORATION_PROMPT,
                },
                {
                    id: 'cleared',
                    name: 'Cleared',
                    promptStyle: 'tag',
                    promptDefaultsInitialized: true,
                    illustrationPrompt: '',
                    studioPrompt: '',
                    explorationPrompt: '',
                },
            ],
        };
        const first = migratePrompts(raw, { now: 80 });
        expect(first.changed).toBe(true);
        expect(first.settings.presets[0].illustrationPrompt).toBe(promptDefaults.DEFAULT_ILLUSTRATION_PROMPT);
        expect(first.settings.presets[1].illustrationPrompt).toBe(promptDefaults.DEFAULT_NATURAL_ILLUSTRATION_PROMPT);
        expect(first.settings.presets[2].illustrationPrompt).toBe('');

        const second = migratePrompts(first.settings, { now: 90 });
        expect(second.changed).toBe(false);
    });
});
