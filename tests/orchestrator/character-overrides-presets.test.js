import { jest } from '@jest/globals';

// defaults.js (transitively imported by preset-library.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time — added in 571c529c2 after the verbatim mock header in this
// plan was authored. Provide a minimal shim so module evaluation succeeds.
globalThis.Luker = {
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
// agenda-profile → editable-spec → agent-resolution → connection-manager →
// openai → group-chats → bookmarks → request-compression → '/lib.js' (note
// leading slash — not the same specifier as the mocked '../../public/lib.js').
// Sever the chain at agent-resolution, mirroring custom-tool-sanitize.test.js.
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

function makeCtx(avatar, ext) {
    return { characters: [{ avatar, data: { extensions: { orchestrator: ext || {} } } }] };
}

describe('character-overrides — preset library reads', () => {
    test('presetLibraries.loop is exposed as-is', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { foo: { name: 'Foo', system_prompt: 'NEW' } } },
            activePresetIds: { loop: 'foo' },
        });
        const lib = overrides.getCharacterPresetLibrary(ctx, 'alice.png', 'loop');
        expect(Object.keys(lib)).toEqual(['foo']);
        expect(overrides.getCharacterActivePresetId(ctx, 'alice.png', 'loop')).toBe('foo');
    });

    test('empty library returns {} (no synthetic fallback)', () => {
        const ctx = makeCtx('alice.png', {});
        expect(overrides.getCharacterPresetLibrary(ctx, 'alice.png', 'loop')).toEqual({});
        expect(overrides.getCharacterActivePresetId(ctx, 'alice.png', 'loop')).toBe('');
    });

    test('isCharacterPresetActiveOverrideEnabled requires both library entry and overrideEnabled flag', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
            overrideEnabled: { loop: true },
        });
        expect(overrides.isCharacterPresetActiveOverrideEnabled(ctx, 'alice.png', 'loop')).toBe(true);
    });

    test('overrideEnabled.loop=false disables override even when library is populated', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
            overrideEnabled: { loop: false },
        });
        expect(overrides.isCharacterPresetActiveOverrideEnabled(ctx, 'alice.png', 'loop')).toBe(false);
    });

    test('missing overrideEnabled container reads as disabled', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
        });
        expect(overrides.isCharacterPresetActiveOverrideEnabled(ctx, 'alice.png', 'loop')).toBe(false);
    });
});
