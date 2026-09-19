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
// Sever the chain at the connection-manager gate so the real agent-resolution
// runs (it only pulls textgen-models.js transitively through this entry).
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
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
let presetLibrary;
beforeAll(async () => {
    overrides = await import('../../public/scripts/extensions/orchestrator/character-overrides.js');
    presetLibrary = await import('../../public/scripts/extensions/orchestrator/preset-library.js');
});

function makeCtx(avatar, ext) {
    return { characters: [{ avatar, data: { extensions: { orchestrator: ext || {} } } }] };
}

describe('character-overrides — single-scope runtime derivation', () => {
    test('card with populated active slot reads as character runtime scope', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
        });
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('character');
        expect(overrides.getCharacterActivePresetId(ctx, 'alice.png', 'loop')).toBe('id1');
    });

    test('card with empty active slot reads as global even when library is populated', () => {
        // Single-scope model: the user picked a global preset for this
        // card. The library stays on the card, but the empty slot means
        // the global active preset runs.
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: '' },
        });
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('global');
        expect(overrides.getCharacterActivePresetId(ctx, 'alice.png', 'loop')).toBe('');
    });

    test('missing activePresetIds container reads as global', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
        });
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('global');
    });

    test('no avatar always reads as global', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
        });
        expect(overrides.getRuntimePresetScope(ctx, '', 'loop')).toBe('global');
    });
});

describe('character-overrides — overrideEnabled flag migration', () => {
    test('enabled true keeps/fills card active id, false clears, flag removed', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: {
                spec: { p1: { name: 'P1', spec: { stages: [] } } },
                loop: { l1: { name: 'L1' } },
            },
            activePresetIds: { spec: 'p1', loop: '' },
            overrideEnabled: { spec: true, loop: false },
        });
        expect(overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png')).toBe(true);
        const ext = ctx.characters[0].data.extensions.orchestrator;
        expect(ext.activePresetIds.spec).toBe('p1');
        expect(ext.activePresetIds.loop).toBe('');
        expect(ext.overrideEnabled).toBeUndefined();
    });

    test('enabled true with empty slot fills the first library key', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { agenda: { a1: { name: 'A1' } } },
            activePresetIds: { agenda: '' },
            overrideEnabled: { agenda: true },
        });
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(ctx.characters[0].data.extensions.orchestrator.activePresetIds.agenda).toBe('a1');
    });

    test('no-op when no flag field present', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { spec: { p1: { name: 'P1', spec: { stages: [] } } } },
            activePresetIds: { spec: 'p1' },
        });
        expect(overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png')).toBe(false);
        expect(ctx.characters[0].data.extensions.orchestrator.activePresetIds.spec).toBe('p1');
    });
});

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

    test('overrideEnabled.loop=true migrates to a filled slot (card runs)', () => {
        // Superseded by the single-scope model: the runtime decision is
        // now `getRuntimePresetScope` (active slot non-empty). The legacy
        // flag is consumed once by `migrateCardOverrideEnabledFlags`.
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
            overrideEnabled: { loop: true },
        });
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('character');
    });

    test('overrideEnabled.loop=false migrates to an empty slot (global runs)', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
            overrideEnabled: { loop: false },
        });
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('global');
    });

    test('missing overrideEnabled container reads as disabled', () => {
        const ctx = makeCtx('alice.png', {
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
        });
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('character');
    });

    test('freshly imported legacy card with only override.<mode>.enabled migrates to a filled slot', () => {
        // Regression: imports through /api/characters/import write the
        // card's `data.extensions.orchestrator` blob verbatim, no
        // migration. A legacy card whose loop override was authored under
        // the pre-preset-library shape has the on/off flag at
        // `override.loop.enabled`. The legacy payload migration seeds the
        // library + active id; after the flag migration the slot is
        // filled, so the runtime scope is character.
        const ctx = makeCtx('alice.png', {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'LEGACY' } },
        });
        // Legacy payload migration (existing) seeds library + active id.
        presetLibrary.migrateAndPersistLegacyCardOverrideForMode(ctx, 'alice.png', 'loop');
        // Flag migration consumes overrideEnabled (seeded by the legacy
        // migration) and settles the slot.
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('character');
        expect(overrides.getCharacterActivePresetId(ctx, 'alice.png', 'loop')).not.toBe('');
    });

    test('legacy spec card with top-level override.enabled=true migrates to a filled slot', () => {
        const ctx = makeCtx('alice.png', {
            override: {
                mode: 'spec',
                enabled: true,
                spec: { stages: [{ id: 's1', mode: 'serial', nodes: [{ id: 'n1', preset: 'p1' }] }] },
                presets: { p1: { systemPrompt: 'KEEP' } },
            },
        });
        presetLibrary.migrateAndPersistLegacyCardOverrideForMode(ctx, 'alice.png', 'spec');
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'spec')).toBe('character');
    });

    test('legacy override.<mode>.enabled=false on import migrates to an empty slot', () => {
        // The legacy flag must be read literally — a card whose creator
        // turned the override off must NOT flip on after migration.
        const ctx = makeCtx('alice.png', {
            override: { mode: 'loop', loop: { enabled: false, system_prompt: 'LEGACY' } },
        });
        presetLibrary.migrateAndPersistLegacyCardOverrideForMode(ctx, 'alice.png', 'loop');
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('global');
    });

    test('new-shape overrideEnabled.<mode> wins over the legacy flag during migration', () => {
        // If both the new flag and a stale legacy flag are present
        // (mid-migration card), the explicit new value wins. Otherwise
        // the user's flick-the-toggle-off action from after the migration
        // would be silently overridden by the pre-migration default.
        const ctx = makeCtx('alice.png', {
            override: { mode: 'loop', loop: { enabled: true } },
            overrideEnabled: { loop: false },
            presetLibraries: { loop: { id1: { name: 'A' } } },
            activePresetIds: { loop: 'id1' },
        });
        overrides.migrateCardOverrideEnabledFlags(ctx, 'alice.png');
        expect(overrides.getRuntimePresetScope(ctx, 'alice.png', 'loop')).toBe('global');
    });
});
