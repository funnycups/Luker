import { jest } from '@jest/globals';

const extensionSettings = { orchestrator: {} };

// defaults.js (transitively imported by preset-library.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time — added in 571c529c2 after the verbatim mock header in this
// plan was authored. Provide a minimal shim so module evaluation succeeds.
//
// editor-state.js (the module under test) also captures
// `Luker.getContext().extensionSettings` at module-load time into a
// local `extension_settings` const. Expose the shared `extensionSettings`
// here so beforeEach() mutations propagate into getSettings().
globalThis.Luker = {
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
        extensionSettings,
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

let editorState;
beforeAll(async () => {
    editorState = await import('../../public/scripts/extensions/orchestrator/editor-state.js');
});

beforeEach(() => {
    extensionSettings.orchestrator = {
        presetLibraries: {
            loop: { p1: { name: 'P1', system_prompt: 'PROMPT-FROM-P1', tools: {}, max_rounds: 10, wall_clock_budget_ms: 60000 } },
            director: {}, agenda: {}, spec: {},
        },
        activePresetIds: { spec: '', agenda: '', loop: 'p1', director: '' },
    };
});

describe('editor-state — load functions read active preset', () => {
    test('loadGlobalLoopEditorState returns the active loop preset payload', () => {
        const draft = editorState.loadGlobalLoopEditorState();
        expect(draft.system_prompt).toBe('PROMPT-FROM-P1');
    });

    test('switching activePresetIds.loop changes what loadGlobalLoopEditorState returns', () => {
        extensionSettings.orchestrator.presetLibraries.loop.p2 = {
            name: 'P2', system_prompt: 'PROMPT-FROM-P2', tools: {}, max_rounds: 5, wall_clock_budget_ms: 60000,
        };
        extensionSettings.orchestrator.activePresetIds.loop = 'p2';
        const draft = editorState.loadGlobalLoopEditorState();
        expect(draft.system_prompt).toBe('PROMPT-FROM-P2');
    });
});
