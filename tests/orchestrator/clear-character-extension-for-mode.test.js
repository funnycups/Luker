import { jest } from '@jest/globals';

globalThis.SillyTavern = {
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
    }),
};

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: {},
    getContext: () => ({}),
    writeExtensionField: async () => {},
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => {},
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: (s) => s,
    chat_metadata: {},
    this_chid: 0,
    characters: [],
    getRequestHeaders: () => ({}),
    saveCharacterDebounced: () => {},
    menu_type: '',
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    event_types: {},
    getExtensionPromptByName: () => '',
    saveMetadata: async () => {},
    getCurrentChatId: () => '',
    create_save: {},
    name1: '',
    buildObjectPatchOperations: () => [],
    buildObjectPatchOperationsAsync: async () => [],
    requestAsyncDiffForNextSettingsSave: () => {},
    getOneCharacter: () => null,
    select_selected_character: () => {},
    user_avatar: '',
    processDroppedFiles: () => {},
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
    wi_anchor_position: {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
}));

let overrides;
beforeAll(async () => {
    overrides = await import('../../public/scripts/extensions/orchestrator/character-overrides.js');
});

describe('clearCharacterExtensionForMode — drops per-mode preset library so probes read false', () => {
    test('loop: drops presetLibraries.loop + activePresetIds.loop + overrideEnabled.loop, leaves other modes intact', () => {
        const before = {
            presetLibraries: {
                spec: { default: { name: 'Default', spec: {}, presets: {} } },
                loop: { id1: { name: 'A', system_prompt: 'X' } },
            },
            activePresetIds: { spec: 'default', loop: 'id1' },
            overrideEnabled: { spec: true, loop: true },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'loop');
        expect(after.presetLibraries?.loop).toBeUndefined();
        expect(after.activePresetIds?.loop).toBeUndefined();
        expect(after.overrideEnabled?.loop).toBeUndefined();
        expect(after.presetLibraries?.spec).toEqual({ default: { name: 'Default', spec: {}, presets: {} } });
        expect(after.activePresetIds?.spec).toBe('default');
        expect(after.overrideEnabled?.spec).toBe(true);
    });

    test('after clear, hasCharacterLoopOverride reads false', () => {
        const before = {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
            overrideEnabled: { loop: true },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'loop');
        const ctx = { characters: [{ avatar: 'a.png', data: { extensions: { orchestrator: after } } }] };
        expect(overrides.hasCharacterLoopOverride(ctx, 'a.png')).toBe(false);
    });

    test('director: drops presetLibraries.director + activePresetIds.director', () => {
        const before = {
            presetLibraries: { director: { id1: { name: 'A' } }, spec: { default: { name: 'Default' } } },
            activePresetIds: { director: 'id1', spec: 'default' },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'director');
        expect(after.presetLibraries?.director).toBeUndefined();
        expect(after.activePresetIds?.director).toBeUndefined();
        const ctx = { characters: [{ avatar: 'a.png', data: { extensions: { orchestrator: after } } }] };
        expect(overrides.hasCharacterDirectorOverride(ctx, 'a.png')).toBe(false);
    });

    test('agenda: drops presetLibraries.agenda + activePresetIds.agenda', () => {
        const before = {
            presetLibraries: { agenda: { id1: { name: 'A' } } },
            activePresetIds: { agenda: 'id1' },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'agenda');
        const ctx = { characters: [{ avatar: 'a.png', data: { extensions: { orchestrator: after } } }] };
        expect(overrides.hasCharacterAgendaOverride(ctx, 'a.png')).toBe(false);
    });

    test('spec: drops presetLibraries.spec + activePresetIds.spec + overrideEnabled.spec', () => {
        const before = {
            presetLibraries: { spec: { default: { name: 'Default', spec: {}, presets: {} } } },
            activePresetIds: { spec: 'default' },
            overrideEnabled: { spec: true },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'spec');
        const ctx = { characters: [{ avatar: 'a.png', data: { extensions: { orchestrator: after } } }] };
        expect(overrides.hasCharacterSpecOverride(ctx, 'a.png')).toBe(false);
        expect(after.overrideEnabled).toBeUndefined();
    });

    test('clearing one mode preserves other modes (libraries + flags)', () => {
        const before = {
            presetLibraries: {
                loop: { l1: { name: 'L' } },
                spec: { s1: { name: 'S' } },
            },
            activePresetIds: { loop: 'l1', spec: 's1' },
            overrideEnabled: { loop: true, spec: true },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'loop');
        expect(after.presetLibraries?.spec).toEqual({ s1: { name: 'S' } });
        expect(after.activePresetIds?.spec).toBe('s1');
        expect(after.overrideEnabled?.spec).toBe(true);
        expect(after.presetLibraries?.loop).toBeUndefined();
        expect(after.activePresetIds?.loop).toBeUndefined();
        expect(after.overrideEnabled?.loop).toBeUndefined();
    });

    test('re-pins override.mode to the surviving mode when the pinned mode was cleared', () => {
        const before = {
            override: { mode: 'loop' },
            presetLibraries: {
                loop: { l1: { name: 'L' } },
                spec: { s1: { name: 'S' } },
            },
            activePresetIds: { loop: 'l1', spec: 's1' },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'loop');
        expect(after.override?.mode).toBe('spec');
    });

    test('drops override envelope entirely when no surviving libraries remain', () => {
        const before = {
            override: { mode: 'loop' },
            presetLibraries: { loop: { l1: { name: 'L' } } },
            activePresetIds: { loop: 'l1' },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'loop');
        expect(after.override).toBeUndefined();
    });

    test('handles empty/null previous ext (defensive)', () => {
        expect(() => overrides.clearCharacterExtensionForMode(null, 'loop')).not.toThrow();
        expect(() => overrides.clearCharacterExtensionForMode({}, 'loop')).not.toThrow();
        expect(overrides.clearCharacterExtensionForMode({}, 'loop')).toEqual({});
    });

    test('unknown/invalid mode normalizes to spec', () => {
        const before = {
            presetLibraries: { spec: { s1: { name: 'S' } }, loop: { l1: { name: 'L' } } },
            activePresetIds: { spec: 's1', loop: 'l1' },
        };
        const after = overrides.clearCharacterExtensionForMode(before, 'garbage');
        expect(after.presetLibraries?.spec).toBeUndefined();
        expect(after.presetLibraries?.loop).toEqual({ l1: { name: 'L' } });
    });
});
