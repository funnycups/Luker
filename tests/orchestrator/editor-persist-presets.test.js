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
globalThis.Luker = {
    getContext: () => ({
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
// Sever the chain at agent-resolution, mirroring custom-tool-sanitize.test.js.
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
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

describe('editor-persist — character writes record overrideEnabled + pin saved mode', () => {
    test('persistCharacterLoopEditor seeds presetLibraries.loop and sets overrideEnabled.loop', async () => {
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
            writeExtensionField: async (id, key, value) => { writes.push({ id, key, value }); },
        };
        await persist.persistCharacterLoopEditor(ctx, extensionSettings.orchestrator, 'alice.png', {
            editor: { mode: 'loop', system_prompt: 'NEW-CARD-LOOP', tools: {}, max_rounds: 8, wall_clock_budget_ms: 60000, enabled: true },
        });
        expect(writes.length).toBe(1);
        const payload = writes[0].value;
        expect(payload.presetLibraries.loop).toBeTruthy();
        const ids = Object.keys(payload.presetLibraries.loop);
        expect(ids.length).toBe(1);
        expect(payload.presetLibraries.loop[ids[0]].system_prompt).toBe('NEW-CARD-LOOP');
        expect(payload.overrideEnabled.loop).toBe(true);
        expect(payload.override.mode).toBe('loop');
    });

    test('persistCharacterLoopEditor honors forceEnabled=false even when editor says enabled', async () => {
        const character = {
            avatar: 'bob.png',
            name: 'Bob',
            data: { extensions: { orchestrator: {} } },
        };
        const ctx = {
            characters: [character],
            writeExtensionField: async (id, key, value) => { writes.push({ id, key, value }); },
        };
        await persist.persistCharacterLoopEditor(ctx, extensionSettings.orchestrator, 'bob.png', {
            editor: { mode: 'loop', system_prompt: 'X', tools: {}, max_rounds: 8, wall_clock_budget_ms: 60000, enabled: true },
            forceEnabled: false,
        });
        expect(writes[0].value.overrideEnabled.loop).toBe(false);
    });
});
