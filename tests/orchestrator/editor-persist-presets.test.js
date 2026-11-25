import { jest } from '@jest/globals';

const extensionSettings = { orchestrator: {} };
const writes = [];

// defaults.js (transitively imported by preset-library.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time. Provide a minimal shim so module evaluation succeeds.
//
// editor-persist.js (the module under test) also captures
// `Luker.getContext().saveSettings` and `.constants.unset` at
// module-load time. Expose stubs and the shared `extensionSettings` so
// beforeEach() mutations propagate.
const __defaultStateErrors = globalThis.Luker?.getContext?.()?.stateErrors;

globalThis.Luker = {
    getContext: () => ({
        stateErrors: __defaultStateErrors,
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
        extensionSettings,
        saveSettings: async () => {},
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
    extension_settings: extensionSettings,
    getContext: () => ({}),
    writeExtensionField: async (id, key, value) => { writes.push({ id, key, value }); },
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

let persist;
beforeAll(async () => {
    persist = await import('../../public/scripts/extensions/orchestrator/editor-persist.js');
});

beforeEach(() => {
    extensionSettings.orchestrator = {
        presetLibraries: {
            loop: { p1: { name: 'P1', system_prompt: 'OLD', tools: {}, max_rounds: 10, wall_clock_budget_ms: 60000 } },
            director: {}, agenda: {}, spec: {},
        },
        activePresetIds: { spec: '', agenda: '', loop: 'p1', director: '' },
    };
    writes.length = 0;
});

describe('editor-persist — global writes land in active preset', () => {
    test('persistGlobalLoopEditorFrom writes to the active preset slot', async () => {
        await persist.persistGlobalLoopEditorFrom(extensionSettings.orchestrator, {
            mode: 'loop', system_prompt: 'NEW-PROMPT', tools: {}, max_rounds: 12, wall_clock_budget_ms: 60000,
        });
        expect(extensionSettings.orchestrator.presetLibraries.loop.p1.system_prompt).toBe('NEW-PROMPT');
        // Name is preserved across the rewrite
        expect(extensionSettings.orchestrator.presetLibraries.loop.p1.name).toBe('P1');
        // No legacy slot is written
        expect(extensionSettings.orchestrator.loopProfile).toBeUndefined();
    });
});

describe('editor-persist — character writes land in the card active slot', () => {
    test('persistCharacterLoopEditor seeds presetLibraries.loop and pins saved mode', async () => {
        const character = {
            avatar: 'alice.png',
            name: 'Alice',
            data: { extensions: { orchestrator: {} } },
        };
        const ctx = {
            characters: [character],
            // persistOrchestratorCharacterExtension calls ctx.writeExtensionField
            // (passed through context). The extensions.js mock above is here
            // for any transitive imports; the real write happens via ctx.
            writeExtensionField: async (id, key, value) => {
                const resolved = typeof value === 'function' ? value(character.data.extensions[key]) : value;
                character.data.extensions[key] = resolved;
                writes.push({ id, key, value: resolved });
            },
        };
        await persist.persistCharacterLoopEditor(ctx, extensionSettings.orchestrator, 'alice.png', {
            editor: { mode: 'loop', system_prompt: 'NEW-CARD-LOOP', tools: {}, max_rounds: 8, wall_clock_budget_ms: 60000 },
        });
        expect(writes.length).toBe(1);
        const payload = writes[0].value;
        expect(payload.presetLibraries.loop).toBeTruthy();
        const ids = Object.keys(payload.presetLibraries.loop);
        expect(ids.length).toBe(1);
        expect(payload.presetLibraries.loop[ids[0]].system_prompt).toBe('NEW-CARD-LOOP');
        // Single-scope model: persisting an editor draft activates the
        // card's slot; no overrideEnabled flag is written.
        expect(payload.activePresetIds.loop).toBe(ids[0]);
        expect(payload.overrideEnabled).toBeUndefined();
        expect(payload.override.mode).toBe('loop');
    });

    test('persistCharacterLoopEditor ignores a stale forceEnabled option', async () => {
        const character = {
            avatar: 'bob.png',
            name: 'Bob',
            data: { extensions: { orchestrator: {} } },
        };
        const ctx = {
            characters: [character],
            writeExtensionField: async (id, key, value) => {
                const resolved = typeof value === 'function' ? value(character.data.extensions[key]) : value;
                character.data.extensions[key] = resolved;
                writes.push({ id, key, value: resolved });
            },
        };
        await persist.persistCharacterLoopEditor(ctx, extensionSettings.orchestrator, 'bob.png', {
            editor: { mode: 'loop', system_prompt: 'X', tools: {}, max_rounds: 8, wall_clock_budget_ms: 60000, enabled: true },
            forceEnabled: false,
        });
        // The enabled flag no longer exists — the payload must not carry it.
        expect(writes[0].value.overrideEnabled).toBeUndefined();
        expect(writes[0].value.activePresetIds.loop).toBeTruthy();
    });

    test('persistCharacterLoopEditor passes an updater so concurrent sibling mode edits survive', async () => {
        const character = {
            avatar: 'carol.png',
            name: 'Carol',
            data: { extensions: { orchestrator: {} } },
        };
        let passedFunction = false;
        const ctx = {
            characters: [character],
            writeExtensionField: async (id, key, value) => {
                passedFunction = typeof value === 'function';
                const concurrentState = {
                    presetLibraries: { director: { d1: { name: 'Director 1' } } },
                    activePresetIds: { director: 'd1' },
                };
                const resolved = typeof value === 'function' ? value(concurrentState) : value;
                character.data.extensions[key] = resolved;
                writes.push({ id, key, value: resolved });
            },
        };
        await persist.persistCharacterLoopEditor(ctx, extensionSettings.orchestrator, 'carol.png', {
            editor: { mode: 'loop', system_prompt: 'CONCURRENT-LOOP', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
        });
        expect(passedFunction).toBe(true);
        expect(writes[0].value.presetLibraries.director.d1).toEqual({ name: 'Director 1' });
        expect(writes[0].value.activePresetIds.director).toBe('d1');
        expect(writes[0].value.presetLibraries.loop.default.system_prompt).toBe('CONCURRENT-LOOP');
    });

    test('persistOrchestratorCharacterExtension maps null updater return to UNSET_VALUE instead of literal null', async () => {
        const unsetSentinel = Symbol('test-unset');
        const character = {
            avatar: 'dana.png',
            name: 'Dana',
            data: { extensions: { orchestrator: { override: { mode: 'loop' } } } },
        };
        const recorded = [];
        const ctx = {
            constants: { unset: unsetSentinel },
            characters: [character],
            writeExtensionField: async (id, key, value) => {
                const resolved = typeof value === 'function'
                    ? await value(structuredClone(character.data.extensions[key]))
                    : value;
                recorded.push({ id, key, value: resolved });
                if (resolved === unsetSentinel) {
                    delete character.data.extensions[key];
                } else {
                    character.data.extensions[key] = resolved;
                }
                return true;
            },
        };

        const syncOk = await persist.persistOrchestratorCharacterExtension(ctx, 0, () => null);
        expect(syncOk).toBe(true);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].value).toBe(unsetSentinel);
        expect(Object.prototype.hasOwnProperty.call(character.data.extensions, 'orchestrator')).toBe(false);

        character.data.extensions.orchestrator = { override: { mode: 'spec' } };
        const asyncOk = await persist.persistOrchestratorCharacterExtension(ctx, 0, async () => null);
        expect(asyncOk).toBe(true);
        expect(recorded).toHaveLength(2);
        expect(recorded[1].value).toBe(unsetSentinel);
        expect(Object.prototype.hasOwnProperty.call(character.data.extensions, 'orchestrator')).toBe(false);
    });
});
