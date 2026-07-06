import { jest } from '@jest/globals';

const extensionSettings = { orchestrator: {} };
const writes = [];
const saveSettingsCalls = [];

// Match the shim shape used by editor-persist-presets.test.js so the
// same module chain evaluates cleanly under jsdom-free node env.
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
        saveSettings: async () => { saveSettingsCalls.push(Date.now()); },
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
            loop: {
                p1: {
                    name: 'P1',
                    system_prompt: 'LOOP-SYS-UNCHANGED',
                    tools: { custom: { existing_tool: true } },
                    customTools: [{ name: 'existing_tool', description: 'was-here' }],
                    max_rounds: 10,
                    wall_clock_budget_ms: 60000,
                },
            },
            director: {},
            agenda: {},
            spec: {
                s1: {
                    name: 'S1',
                    spec: {
                        stages: [],
                        defaultTools: { custom: {} },
                        customTools: [{ name: 'old_spec_tool', description: 'was-here' }],
                    },
                    presets: {},
                },
            },
        },
        activePresetIds: { spec: 's1', agenda: '', loop: 'p1', director: '' },
    };
    writes.length = 0;
    saveSettingsCalls.length = 0;
});

describe('persistCustomToolsPatch — shape guarantees', () => {
    test('loop mode replaces top-level customTools without touching tools.custom flag bucket', async () => {
        const newTools = [
            { name: 'new_alpha', description: 'A' },
            { name: 'new_beta', description: 'B' },
        ];
        await persist.persistCustomToolsPatch(null, extensionSettings.orchestrator, 'loop', 'global', newTools);
        const p = extensionSettings.orchestrator.presetLibraries.loop.p1;
        expect(p.customTools.map(t => t.name)).toEqual(['new_alpha', 'new_beta']);
        // tools.custom flag bucket is unrelated to customTools[] and must NOT be cleared.
        expect(p.tools.custom.existing_tool).toBe(true);
        // System prompt unaffected.
        expect(p.system_prompt).toBe('LOOP-SYS-UNCHANGED');
        expect(saveSettingsCalls.length).toBe(1);
    });

    test('spec mode writes customTools under .spec, not top-level', async () => {
        const newTools = [{ name: 'new_spec_tool', description: 'Z' }];
        await persist.persistCustomToolsPatch(null, extensionSettings.orchestrator, 'spec', 'global', newTools);
        const p = extensionSettings.orchestrator.presetLibraries.spec.s1;
        expect(p.spec.customTools.map(t => t.name)).toEqual(['new_spec_tool']);
        // Top-level customTools stays absent (spec never had one).
        expect(p.customTools).toBeUndefined();
    });

    test('character scope writes customTools patch to character extension', async () => {
        const character = {
            avatar: 'alice.png',
            name: 'Alice',
            data: {
                extensions: {
                    orchestrator: {
                        presetLibraries: {
                            director: {
                                d1: {
                                    name: 'D1',
                                    mainAgent: { systemPrompt: 'CARD-MAIN-UNCHANGED' },
                                    subAgents: [],
                                    tools: { custom: {} },
                                    customTools: [],
                                    maxRounds: 30,
                                    maxConcurrentSubagents: 2,
                                    maxTotalSubagentRuns: 10,
                                },
                            },
                        },
                        activePresetIds: { spec: '', agenda: '', loop: '', director: 'd1' },
                        overrideEnabled: { director: true },
                    },
                },
            },
        };
        const ctx = {
            characters: [character],
            writeExtensionField: async (id, key, value) => { writes.push({ id, key, value }); },
        };
        await persist.persistCustomToolsPatch(ctx, extensionSettings.orchestrator, 'director', 'character', [
            { name: 'card_only_tool', description: 'X' },
        ], { avatar: 'alice.png' });
        expect(writes.length).toBe(1);
        const payload = writes[0].value;
        expect(payload.presetLibraries.director.d1.customTools.map(t => t.name)).toEqual(['card_only_tool']);
        expect(payload.presetLibraries.director.d1.mainAgent.systemPrompt).toBe('CARD-MAIN-UNCHANGED');
        expect(payload.overrideEnabled.director).toBe(true);
    });
});
