import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// A spec profile whose custom tool list was emptied keeps it empty when
// the editor draft is built and serialized back: the draft carries the
// `seededDefaultCustomTools` flag, so `sanitizeSpec` does not seed the
// default custom tools again.

globalThis.Luker = {
    getContext: () => ({
        translate: (s) => String(s ?? ''),
        saveSettings: async () => {},
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
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

let sanitizeSpec;
let serializeEditorSpec;
let toEditableSpec;

beforeAll(async () => {
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ serializeEditorSpec, toEditableSpec } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js'));
});

const STAGES = [{ id: 'watch', mode: 'serial', nodes: [{ id: 'lookout', preset: 'lookout' }] }];

describe('spec editor draft and seeded default custom tools', () => {
    test('an emptied custom tool list stays empty through the editor draft', () => {
        const stored = sanitizeSpec({ stages: STAGES, customTools: [], seededDefaultCustomTools: true });
        expect(stored.customTools).toEqual([]);
        const roundTripped = serializeEditorSpec(toEditableSpec(stored, { lookout: {} }));
        expect(roundTripped.customTools).toEqual([]);
        expect(roundTripped).toEqual(stored);
    });

    test('a fresh profile still receives the default custom tools', () => {
        const fresh = serializeEditorSpec(toEditableSpec({ stages: STAGES }, { lookout: {} }));
        expect(fresh.customTools.length).toBeGreaterThan(0);
        expect(fresh.seededDefaultCustomTools).toBe(true);
    });
});
