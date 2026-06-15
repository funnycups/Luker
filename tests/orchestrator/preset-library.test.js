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

let lib;
beforeAll(async () => {
    lib = await import('../../public/scripts/extensions/orchestrator/preset-library.js');
});

const MODES = ['spec', 'agenda', 'loop', 'director'];

function freshSettings() {
    return {
        presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} },
        activePresetIds: { spec: '', agenda: '', loop: '', director: '' },
    };
}

describe('preset-library — CRUD on global scope', () => {
    test.each(MODES)('createPreset seeds an entry and returns its id (%s)', (mode) => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, mode, 'global', { name: 'My Style' });
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        expect(settings.presetLibraries[mode][id]).toMatchObject({ name: 'My Style' });
    });

    test.each(MODES)('listPresets returns insertion order (%s)', (mode) => {
        const settings = freshSettings();
        const a = lib.createPreset(settings, mode, 'global', { name: 'A' });
        const b = lib.createPreset(settings, mode, 'global', { name: 'B' });
        const c = lib.createPreset(settings, mode, 'global', { name: 'C' });
        expect(lib.listPresets(settings, mode, { scope: 'global' }).map(p => p.id)).toEqual([a, b, c]);
    });

    test.each(MODES)('getPreset returns sanitized profile data (%s)', (mode) => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, mode, 'global', { name: 'X' });
        const p = lib.getPreset(settings, mode, 'global', id);
        expect(p).toBeTruthy();
        expect(p.name).toBe('X');
    });
});

describe('preset-library — active preset resolution', () => {
    test.each(MODES)('setActivePresetId then getActivePresetId roundtrips (%s)', (mode) => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, mode, 'global', { name: 'A' });
        lib.setActivePresetId(settings, mode, 'global', id);
        expect(lib.getActivePresetId(settings, mode, { scope: 'global' })).toBe(id);
    });

    test.each(MODES)('getActivePreset returns sanitized active entry (%s)', (mode) => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, mode, 'global', { name: 'A' });
        lib.setActivePresetId(settings, mode, 'global', id);
        const p = lib.getActivePreset(settings, mode, { scope: 'global' });
        expect(p?.name).toBe('A');
    });

    test.each(MODES)('getActivePreset on empty library re-seeds Default and returns it (%s)', (mode) => {
        const settings = freshSettings();
        // library starts empty
        const p = lib.getActivePreset(settings, mode, { scope: 'global' });
        expect(p?.name).toBe('Default');
        // The seeded entry should also be in the library now under id 'default'
        expect(settings.presetLibraries[mode].default).toBeTruthy();
        expect(settings.activePresetIds[mode]).toBe('default');
    });
});

describe('preset-library — delete / rename / duplicate', () => {
    test('deletePreset removes entry; deleting active falls back to first remaining', () => {
        const settings = freshSettings();
        const a = lib.createPreset(settings, 'loop', 'global', { name: 'A' });
        const b = lib.createPreset(settings, 'loop', 'global', { name: 'B' });
        const c = lib.createPreset(settings, 'loop', 'global', { name: 'C' });
        lib.setActivePresetId(settings, 'loop', 'global', b);
        expect(lib.deletePreset(settings, 'loop', 'global', b)).toBe(true);
        expect(settings.presetLibraries.loop[b]).toBeUndefined();
        expect(settings.activePresetIds.loop).toBe(a);
        // Still includes c
        expect(lib.listPresets(settings, 'loop', { scope: 'global' }).map(p => p.id)).toEqual([a, c]);
    });

    test('deleting the last preset re-seeds Default and makes it active', () => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, 'director', 'global', { name: 'Only' });
        lib.setActivePresetId(settings, 'director', 'global', id);
        lib.deletePreset(settings, 'director', 'global', id);
        const list = lib.listPresets(settings, 'director', { scope: 'global' });
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('default');
        expect(settings.activePresetIds.director).toBe('default');
    });

    test('deleting the last character-scope preset leaves the library empty', () => {
        // Regression: previously, deleting the last character-scope preset
        // would re-seed a factory Default into the card, creating a
        // phantom override that `hasCharacter*Override` reads as true.
        // The user-visible bug: "Clear Character Override" appeared to do
        // nothing because the next render would immediately re-seed.
        // Now the library stays empty and activeId is '' so callers fall
        // back to the global active preset.
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const ctx = { characters: [{ avatar: 'alice.png', data: { extensions: { orchestrator: {} } } }] };
        const id = lib.createPreset(settings, 'director', 'character',
            { name: 'OnlyOne' }, { context: ctx, avatar: 'alice.png' });
        lib.setActivePresetId(settings, 'director', 'character', id,
            { context: ctx, avatar: 'alice.png' });
        lib.deletePreset(settings, 'director', 'character', id, { context: ctx, avatar: 'alice.png' });
        const cardExt = ctx.characters[0].data.extensions.orchestrator;
        expect(Object.keys(cardExt.presetLibraries.director)).toHaveLength(0);
        expect(cardExt.activePresetIds.director).toBe('');
    });

    test('renamePreset updates name without changing id', () => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, 'spec', 'global', { name: 'Old' });
        expect(lib.renamePreset(settings, 'spec', 'global', id, { name: 'New' })).toBe(true);
        expect(settings.presetLibraries.spec[id].name).toBe('New');
    });

    test('duplicatePreset deep-clones source under a fresh id', () => {
        const settings = freshSettings();
        const a = lib.createPreset(settings, 'agenda', 'global', { name: 'Source' });
        settings.presetLibraries.agenda[a].planner.systemPrompt = 'SOURCE-MARKER';
        const dup = lib.duplicatePreset(settings, 'agenda', 'global', a, { name: 'Copy' });
        expect(dup).not.toBe(a);
        expect(settings.presetLibraries.agenda[dup].name).toBe('Copy');
        expect(settings.presetLibraries.agenda[dup].planner.systemPrompt).toBe('SOURCE-MARKER');
        // Mutating duplicate must not bleed back to source
        settings.presetLibraries.agenda[dup].planner.systemPrompt = 'CHANGED';
        expect(settings.presetLibraries.agenda[a].planner.systemPrompt).toBe('SOURCE-MARKER');
    });
});

describe('preset-library — writeActivePreset + character scope', () => {
    function makeCardContext(avatar, extPayload) {
        return {
            characters: [{
                avatar,
                data: { extensions: { orchestrator: extPayload || {} } },
            }],
        };
    }

    test('writeActivePreset replaces active entry payload in-place', () => {
        const settings = freshSettings();
        const id = lib.createPreset(settings, 'loop', 'global', { name: 'X' });
        lib.setActivePresetId(settings, 'loop', 'global', id);
        lib.writeActivePreset(settings, 'loop', 'global', { system_prompt: 'NEW-PROMPT' });
        expect(settings.presetLibraries.loop[id].system_prompt).toBe('NEW-PROMPT');
        // Name is preserved across the rewrite
        expect(settings.presetLibraries.loop[id].name).toBe('X');
    });

    test('character-scope createPreset writes into the card data', () => {
        const settings = freshSettings();
        const ctx = makeCardContext('alice.png');
        const id = lib.createPreset(settings, 'director', 'character',
            { name: 'CardOnly' }, { context: ctx, avatar: 'alice.png' });
        const ext = ctx.characters[0].data.extensions.orchestrator;
        expect(ext.presetLibraries.director[id].name).toBe('CardOnly');
    });

    test('writeActivePreset on character scope rewrites the card entry', () => {
        const settings = freshSettings();
        const ctx = makeCardContext('alice.png');
        const id = lib.createPreset(settings, 'director', 'character',
            { name: 'CardOnly' }, { context: ctx, avatar: 'alice.png' });
        lib.setActivePresetId(settings, 'director', 'character', id,
            { context: ctx, avatar: 'alice.png' });
        lib.writeActivePreset(settings, 'director', 'character',
            { mainAgent: { systemPrompt: 'CARD-PROMPT' } },
            { context: ctx, avatar: 'alice.png' });
        const entry = ctx.characters[0].data.extensions.orchestrator.presetLibraries.director[id];
        expect(entry.mainAgent.systemPrompt).toBe('CARD-PROMPT');
    });
});

describe('preset-library — character-scope absence behavior', () => {
    test('card with no card-scope library returns null — does NOT auto-seed', () => {
        // Regression: previously, character-scope getActivePreset would
        // synthesize a factory Default into the card on first touch
        // whenever the card had no preset library. That silently made
        // `hasCharacter*Override` flip to true and made "Clear Character
        // Override" a no-op (the next render would re-seed immediately).
        // Now the call returns null and the card data is untouched;
        // callers fall back to the global active preset.
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const ctx = { characters: [{ avatar: 'bob.png', data: { extensions: { orchestrator: {} } } }] };
        const active = lib.getActivePreset(settings, 'director', { scope: 'character', context: ctx, avatar: 'bob.png' });
        expect(active).toBeNull();
        // Card data must not be mutated by a phantom seed.
        const cardLib = ctx.characters[0].data.extensions.orchestrator.presetLibraries?.director || {};
        expect(Object.keys(cardLib)).toHaveLength(0);
    });
});

describe('preset-library — legacy override migration', () => {
    test('legacy override.loop on a card is migrated to presetLibraries.loop.default on first read', () => {
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'MY-CUSTOM', updatedAt: 42 } },
        } } } };
        const ctx = { characters: [character] };

        const active = lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });
        expect(active?.system_prompt).toBe('MY-CUSTOM');

        const cardExt = character.data.extensions.orchestrator;
        expect(cardExt.presetLibraries.loop.default.system_prompt).toBe('MY-CUSTOM');
        expect(cardExt.activePresetIds.loop).toBe('default');
        // Legacy enabled flag is translated into the new flat container.
        expect(cardExt.overrideEnabled.loop).toBe(true);
        // Legacy payload is stripped so subsequent renders do not re-migrate.
        expect(cardExt.override.loop).toBeUndefined();
        // The override envelope is preserved as the mode pin.
        expect(cardExt.override.mode).toBe('loop');
    });

    test('legacy spec override migrates spec+presets and translates the top-level enabled flag', () => {
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: {
                mode: 'spec',
                enabled: false,
                spec: { stages: [{ id: 's1', mode: 'serial', nodes: [{ id: 'n1', preset: 'p1' }] }] },
                presets: { p1: { systemPrompt: 'KEEP' } },
                updatedAt: 99,
            },
        } } } };
        const ctx = { characters: [character] };

        lib.getActivePreset(settings, 'spec', { scope: 'character', context: ctx, avatar: 'alice.png' });

        const cardExt = character.data.extensions.orchestrator;
        expect(cardExt.presetLibraries.spec.default.spec.stages).toHaveLength(1);
        expect(cardExt.presetLibraries.spec.default.presets.p1.systemPrompt).toBe('KEEP');
        expect(cardExt.overrideEnabled.spec).toBe(false);
        expect(cardExt.override.spec).toBeUndefined();
        expect(cardExt.override.presets).toBeUndefined();
        expect(cardExt.override.enabled).toBeUndefined();
    });

    test('second read is a no-op when the library already exists', () => {
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            presetLibraries: { loop: { existing: { name: 'Existing', system_prompt: 'ALREADY' } } },
            activePresetIds: { loop: 'existing' },
            override: { mode: 'loop' },
        } } } };
        const ctx = { characters: [character] };

        const active = lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });
        expect(active?.system_prompt).toBe('ALREADY');
        // No `default` slot synthesized on top of the existing library.
        expect(character.data.extensions.orchestrator.presetLibraries.loop.default).toBeUndefined();
    });

    test('migration does not clobber a pre-existing overrideEnabled flag', () => {
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'MIGRATE' } },
            overrideEnabled: { loop: false },
        } } } };
        const ctx = { characters: [character] };

        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });

        // The user's explicit `false` from the new shape wins over the
        // legacy `true` — the migration must not flip it back on.
        expect(character.data.extensions.orchestrator.overrideEnabled.loop).toBe(false);
    });
});

describe('preset-library — migration persistence hook', () => {
    afterEach(() => {
        // Reset to default no-op so cross-test pollution doesn't survive.
        lib.setMigrationPersistHook(null);
    });

    test('hook fires once per migration with (context, avatar, mode)', () => {
        // Gap 2: migrateLegacyCardOverrideForMode mutates the in-memory
        // card blob into the new shape, but until something writes the
        // card back to disk the legacy fields keep getting re-migrated
        // on every reload. The hook is how main.js wires a debounced
        // persistOrchestratorCharacterExtension into the migration so
        // the new shape actually settles.
        const calls = [];
        lib.setMigrationPersistHook((context, avatar, mode) => {
            calls.push({ avatar, mode });
        });
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'NEEDS-PERSIST' } },
        } } } };
        const ctx = { characters: [character] };

        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });

        expect(calls).toEqual([{ avatar: 'alice.png', mode: 'loop' }]);
    });

    test('hook is NOT fired on a second read (migration was already done)', () => {
        const calls = [];
        lib.setMigrationPersistHook((context, avatar, mode) => {
            calls.push({ avatar, mode });
        });
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'P' } },
        } } } };
        const ctx = { characters: [character] };

        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });
        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });

        // First read migrates and fires the hook. Second read sees the
        // already-populated library and is a no-op.
        expect(calls).toHaveLength(1);
    });

    test('hook is NOT fired when there is no legacy payload to migrate', () => {
        const calls = [];
        lib.setMigrationPersistHook((context, avatar, mode) => {
            calls.push({ avatar, mode });
        });
        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            presetLibraries: { loop: { existing: { name: 'Existing', system_prompt: 'ALREADY' } } },
            activePresetIds: { loop: 'existing' },
        } } } };
        const ctx = { characters: [character] };

        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });

        expect(calls).toEqual([]);
    });

    test('hook is tolerant of being unregistered (null clears it)', () => {
        const calls = [];
        lib.setMigrationPersistHook((context, avatar, mode) => {
            calls.push({ avatar, mode });
        });
        lib.setMigrationPersistHook(null);

        const settings = { presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} }, activePresetIds: {} };
        const character = { avatar: 'alice.png', data: { extensions: { orchestrator: {
            override: { mode: 'loop', loop: { enabled: true, system_prompt: 'P' } },
        } } } };
        const ctx = { characters: [character] };

        // Must not throw; just no callback fired.
        lib.getActivePreset(settings, 'loop', { scope: 'character', context: ctx, avatar: 'alice.png' });
        expect(calls).toEqual([]);
    });
});
