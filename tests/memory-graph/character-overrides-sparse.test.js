/**
 * Covers the sparse per-character advanced-settings override layer.
 *
 * Reading a character card yields the raw sparse object stored under
 * `data.extensions.memory_graph.advancedOverride`; the effective settings are
 * the normalized globals with that sparse object merged on top. The patch
 * helper writes only the keys it was given and preserves sibling override keys
 * such as `schemaOverride`.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// character-overrides.js captures `constants.unset` at module load.
const UNSET_VALUE = Symbol.for('test.unset');
globalThis.Luker = {
    getContext: () => ({ constants: { unset: UNSET_VALUE } }),
};

const { ADVANCED_SETTING_DEFAULTS, normalizeAdvancedSettings } =
    await import('../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js');
const { CONFIG_FIELDS } =
    await import('../../public/scripts/extensions/memory-graph/config-iteration/fields.js');
const {
    configure,
    getCharacterAdvancedOverrideByAvatar,
    getEffectiveAdvancedSettings,
    getAdvancedScopeInfo,
    persistCharacterAdvancedOverride,
    persistCharacterAdvancedOverridePatch,
} = await import('../../public/scripts/extensions/memory-graph/character-overrides.js');

let globalSettings;

beforeEach(() => {
    globalSettings = {
        ...ADVANCED_SETTING_DEFAULTS,
        recallMaxIterations: 3,
        extractBatchTurns: 7,
    };
    configure({
        MODULE_NAME: 'memory_graph',
        defaultSettings: ADVANCED_SETTING_DEFAULTS,
        normalizeAdvancedSettings,
        getSettings: () => globalSettings,
    });
});

function makeContext(advancedOverride, { schemaOverride = [{ id: 'event' }] } = {}) {
    const blob = {};
    if (schemaOverride !== undefined) {
        blob.schemaOverride = schemaOverride;
    }
    if (advancedOverride !== undefined) {
        blob.advancedOverride = advancedOverride;
    }
    const character = {
        avatar: 'a.png',
        name: 'A',
        data: { extensions: { memory_graph: blob } },
    };
    return {
        characters: [character],
        characterId: 0,
        writeExtensionField: jest.fn(async () => {}),
    };
}

describe('getCharacterAdvancedOverrideByAvatar', () => {
    test('returns the raw sparse object instead of a normalized snapshot', () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        const override = getCharacterAdvancedOverrideByAvatar(ctx, 'a.png');

        expect(override).toEqual({ recallMaxIterations: 5 });
        expect(Object.keys(override)).toHaveLength(1);
        expect(override).not.toBe(ctx.characters[0].data.extensions.memory_graph.advancedOverride);
    });

    test('returns null when the blob slot is missing or empty', () => {
        expect(getCharacterAdvancedOverrideByAvatar(makeContext(), 'a.png')).toBeNull();
        expect(getCharacterAdvancedOverrideByAvatar(makeContext({}), 'a.png')).toBeNull();
        expect(getCharacterAdvancedOverrideByAvatar(makeContext(undefined, { schemaOverride: undefined }), 'a.png')).toBeNull();
    });

    test('returns null for an unknown avatar', () => {
        expect(getCharacterAdvancedOverrideByAvatar(makeContext({ recallMaxIterations: 5 }), 'missing.png')).toBeNull();
    });
});

describe('getEffectiveAdvancedSettings', () => {
    test('merges the sparse override on top of normalized globals and drops legacy recentRawTurns', () => {
        const ctx = makeContext({ recallMaxIterations: 5, updateEvery: 3, recentRawTurns: 9 });
        const effective = getEffectiveAdvancedSettings(ctx, { recallMaxIterations: 3, extractBatchTurns: 7 });

        expect(effective.recallMaxIterations).toBe(5);
        expect(effective.updateEvery).toBe(3);
        expect(effective.extractBatchTurns).toBe(7);
        expect(effective.extractContextTurns).toBe(2);
        expect('recentRawTurns' in effective).toBe(false);
    });

    test('returns normalized globals when the card has no override', () => {
        const ctx = makeContext();
        const effective = getEffectiveAdvancedSettings(ctx, { recallMaxIterations: 4 });

        expect(effective.recallMaxIterations).toBe(4);
        expect(effective.extractContextTurns).toBe(2);
    });
});

describe('getAdvancedScopeInfo', () => {
    test('reports character scope and the merged settings', () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        const info = getAdvancedScopeInfo(ctx, { recallMaxIterations: 3 });

        expect(info.hasOverride).toBe(true);
        expect(info.scope).toBe('character');
        expect(info.settings.recallMaxIterations).toBe(5);
        expect(info.hasAvatar).toBe(true);
        expect(info.characterName).toBe('A');
    });

    test('reports global scope when the card has no override', () => {
        const ctx = makeContext();
        const info = getAdvancedScopeInfo(ctx, { recallMaxIterations: 3 });

        expect(info.hasOverride).toBe(false);
        expect(info.scope).toBe('global');
        expect(info.settings.recallMaxIterations).toBe(3);
    });
});

describe('persistCharacterAdvancedOverridePatch', () => {
    test('writes only the patched key and preserves sibling overrides', async () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        const result = await persistCharacterAdvancedOverridePatch(ctx, 'a.png', {
            set: { recallMaxIterations: 6 },
            unset: [],
        });

        expect(result).toBe(true);
        expect(ctx.writeExtensionField).toHaveBeenCalledTimes(1);
        expect(ctx.writeExtensionField).toHaveBeenCalledWith(
            0,
            'memory_graph',
            expect.objectContaining({
                schemaOverride: [{ id: 'event' }],
                advancedOverride: { recallMaxIterations: 6 },
            }),
        );
        const written = ctx.writeExtensionField.mock.calls[0][2];
        expect(written.advancedOverride).toEqual({ recallMaxIterations: 6 });
        expect(Object.keys(written.advancedOverride)).toHaveLength(1);
    });

    test('keeps untouched sparse keys and removes unset keys', async () => {
        const ctx = makeContext({ recallMaxIterations: 5, extractBatchTurns: 9 });
        await persistCharacterAdvancedOverridePatch(ctx, 'a.png', {
            set: { recallMaxIterations: 6 },
            unset: ['extractBatchTurns'],
        });

        const written = ctx.writeExtensionField.mock.calls[0][2];
        expect(written.advancedOverride).toEqual({ recallMaxIterations: 6 });
    });

    test('creates a sparse override when the card has none', async () => {
        const ctx = makeContext();
        await persistCharacterAdvancedOverridePatch(ctx, 'a.png', {
            set: { updateEvery: 4 },
            unset: [],
        });

        const written = ctx.writeExtensionField.mock.calls[0][2];
        expect(written.advancedOverride).toEqual({ updateEvery: 4 });
        expect(written.schemaOverride).toEqual([{ id: 'event' }]);
    });

    test('writes the unset sentinel when no keys remain', async () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        await persistCharacterAdvancedOverridePatch(ctx, 'a.png', {
            set: {},
            unset: ['recallMaxIterations'],
        });

        const written = ctx.writeExtensionField.mock.calls.at(-1)[2];
        expect(written.advancedOverride).toBe(UNSET_VALUE);
    });

    test('returns false without writing for unusable targets', async () => {
        const noAvatar = makeContext({ recallMaxIterations: 5 });
        await expect(persistCharacterAdvancedOverridePatch(noAvatar, '', { set: { recallMaxIterations: 6 } }))
            .resolves.toBe(false);
        expect(noAvatar.writeExtensionField).not.toHaveBeenCalled();

        const unknownAvatar = makeContext({ recallMaxIterations: 5 });
        await expect(persistCharacterAdvancedOverridePatch(unknownAvatar, 'missing.png', { set: { recallMaxIterations: 6 } }))
            .resolves.toBe(false);
        expect(unknownAvatar.writeExtensionField).not.toHaveBeenCalled();

        const noWriter = makeContext({ recallMaxIterations: 5 });
        delete noWriter.writeExtensionField;
        await expect(persistCharacterAdvancedOverridePatch(noWriter, 'a.png', { set: { recallMaxIterations: 6 } }))
            .resolves.toBe(false);
    });

    test('propagates write failures instead of swallowing them', async () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        ctx.writeExtensionField.mockRejectedValueOnce(new Error('write failed'));

        await expect(persistCharacterAdvancedOverridePatch(ctx, 'a.png', {
            set: { recallMaxIterations: 6 },
        })).rejects.toThrow('write failed');
    });
});

describe('persistCharacterAdvancedOverride', () => {
    test('keeps the full normalized snapshot write path', async () => {
        const ctx = makeContext({ recallMaxIterations: 5 });
        await persistCharacterAdvancedOverride(ctx, 'a.png', { recallMaxIterations: 6 });

        const written = ctx.writeExtensionField.mock.calls[0][2];
        expect(Object.keys(written.advancedOverride)).toHaveLength(
            Object.keys(CONFIG_FIELDS).length,
        );
        expect(written.advancedOverride.recallMaxIterations).toBe(6);
        expect(written.schemaOverride).toEqual([{ id: 'event' }]);
    });

    test('normalizeAdvancedSettings clears unseeded prompt fields when equal to code defaults', () => {
        const defaults = {
            extractTemplate: CONFIG_FIELDS['settings.extractTemplate'].defaultValue,
            extractEdgeRules: CONFIG_FIELDS['settings.extractEdgeRules'].defaultValue,
            graphIterSystemPrompt: CONFIG_FIELDS['settings.graphIterSystemPrompt'].defaultValue,
            configIterSystemPrompt: CONFIG_FIELDS['settings.configIterSystemPrompt'].defaultValue,
        };
        const normalized = normalizeAdvancedSettings(defaults, {});
        expect(normalized.extractTemplate).toBe('');
        expect(normalized.extractEdgeRules).toBe('');
        expect(normalized.graphIterSystemPrompt).toBe('');
        expect(normalized.configIterSystemPrompt).toBe('');
    });
});
