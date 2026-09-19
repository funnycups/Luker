// Tests for the character editor draft's `enabled` field under the
// single-scope model.
//
// The toggle helpers (`setCharacter*OverrideEnabled`) are gone: the
// runtime decision is now the card's active slot (non-empty = card
// library runs, empty = global active runs). The editor draft still
// carries an `enabled` bit — loadCharacter*EditorState derives it
// directly from the slot state, so the UI can label the draft without a
// separate flag roundtrip.

import { jest } from '@jest/globals';

// defaults.js (transitively imported by editor-state.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time. Expose stubs + the shared `extensionSettings` so
// beforeEach() mutations propagate.
const extensionSettings = { orchestrator: {} };
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

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    getContext: () => ({}),
    writeExtensionField: () => {},
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
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let loadCharacterEditorState;

beforeAll(async () => {
    ({ loadCharacterEditorState } = await import(
        '../../public/scripts/extensions/orchestrator/editor-state.js'
    ));
});

beforeEach(() => {
    extensionSettings.orchestrator = {
        executionMode: 'spec',
        presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} },
        activePresetIds: { spec: '', agenda: '', loop: '', director: '' },
    };
});

const AVATAR = 'default_Seraphina.png';

function makeContext(orchestratorExt) {
    const character = {
        avatar: AVATAR,
        name: 'Seraphina',
        data: { extensions: { orchestrator: orchestratorExt || {} } },
    };
    return { ctx: { characterId: 0, characters: [character] } };
}

describe('loadCharacterEditorState — enabled reflects the card active slot', () => {
    test('filled active slot → enabled true', () => {
        extensionSettings.orchestrator.presetLibraries.spec = {
            g: { name: 'G', spec: { stages: [] }, presets: {} },
        };
        extensionSettings.orchestrator.activePresetIds.spec = 'g';
        const { ctx } = makeContext({
            presetLibraries: { spec: { c: { name: 'C', spec: { stages: [] }, presets: {} } } },
            activePresetIds: { spec: 'c' },
        });
        const state = loadCharacterEditorState(ctx, AVATAR);
        expect(state.enabled).toBe(true);
    });

    test('empty active slot → enabled false even with a populated library', () => {
        extensionSettings.orchestrator.presetLibraries.spec = {
            g: { name: 'G', spec: { stages: [] }, presets: {} },
        };
        extensionSettings.orchestrator.activePresetIds.spec = 'g';
        const { ctx } = makeContext({
            presetLibraries: { spec: { c: { name: 'C', spec: { stages: [] }, presets: {} } } },
            activePresetIds: { spec: '' },
        });
        const state = loadCharacterEditorState(ctx, AVATAR);
        expect(state.enabled).toBe(false);
    });
});
