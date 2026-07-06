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
                    system_prompt: 'LOOP-SYS-DRAFT-UNCHANGED',
                    tools: { custom: {} },
                    customTools: [],
                    max_rounds: 10,
                    wall_clock_budget_ms: 60000,
                },
            },
            director: {
                d1: {
                    name: 'D1',
                    mainAgent: { systemPrompt: 'DIRECTOR-MAIN-DRAFT-UNCHANGED' },
                    subAgents: [{ id: 'sub-a', systemPrompt: 'SUB-A-DRAFT-UNCHANGED' }],
                    tools: { custom: {} },
                    customTools: [],
                    maxRounds: 20,
                    maxConcurrentSubagents: 4,
                    maxTotalSubagentRuns: 16,
                    discardOnAbort: false,
                },
            },
            agenda: {
                a1: {
                    name: 'A1',
                    planner: { systemPrompt: 'AGENDA-PLANNER-DRAFT-UNCHANGED' },
                    agents: [{ id: 'ag-1', systemPrompt: 'AG-1-DRAFT-UNCHANGED' }],
                    finalAgentId: 'ag-1',
                    limits: { plannerMaxRounds: 6, maxConcurrentAgents: 3, maxTotalRuns: 24 },
                    customTools: [{ name: 'kept_agenda_tool', description: 'was-here' }],
                    defaultTools: { custom: { some_flag: true } },
                },
            },
            spec: {},
        },
        activePresetIds: { spec: '', agenda: 'a1', loop: 'p1', director: 'd1' },
    };
    writes.length = 0;
    saveSettingsCalls.length = 0;
});

describe('persistRuntimeLimitsPatch — global scope', () => {
    test('loop patch merges only top-level limits fields; system_prompt and tools untouched', async () => {
        await persist.persistRuntimeLimitsPatch(null, extensionSettings.orchestrator, 'loop', 'global', {
            max_rounds: 99,
            wall_clock_budget_ms: 120000,
        });
        const p = extensionSettings.orchestrator.presetLibraries.loop.p1;
        expect(p.max_rounds).toBe(99);
        expect(p.wall_clock_budget_ms).toBe(120000);
        expect(p.system_prompt).toBe('LOOP-SYS-DRAFT-UNCHANGED');
        expect(p.name).toBe('P1');
        expect(saveSettingsCalls.length).toBe(1);
    });

    test('director patch merges only top-level limits fields; mainAgent and subAgents untouched', async () => {
        await persist.persistRuntimeLimitsPatch(null, extensionSettings.orchestrator, 'director', 'global', {
            maxRounds: 99,
            maxConcurrentSubagents: 7,
        });
        const p = extensionSettings.orchestrator.presetLibraries.director.d1;
        expect(p.maxRounds).toBe(99);
        expect(p.maxConcurrentSubagents).toBe(7);
        expect(p.maxTotalSubagentRuns).toBe(16); // untouched
        expect(p.mainAgent.systemPrompt).toBe('DIRECTOR-MAIN-DRAFT-UNCHANGED');
        expect(p.subAgents[0].systemPrompt).toBe('SUB-A-DRAFT-UNCHANGED');
    });

    test('agenda patch merges under .limits sub-object; agents / planner untouched', async () => {
        await persist.persistRuntimeLimitsPatch(null, extensionSettings.orchestrator, 'agenda', 'global', {
            plannerMaxRounds: 12,
        });
        const p = extensionSettings.orchestrator.presetLibraries.agenda.a1;
        expect(p.limits.plannerMaxRounds).toBe(12);
        expect(p.limits.maxConcurrentAgents).toBe(3); // untouched
        expect(p.limits.maxTotalRuns).toBe(24); // untouched
        expect(p.agents[0].systemPrompt).toBe('AG-1-DRAFT-UNCHANGED');
        expect(p.planner.systemPrompt).toBe('AGENDA-PLANNER-DRAFT-UNCHANGED');
        // Sibling non-limits agenda fields (customTools / defaultTools) must
        // survive the narrow limits patch — writeActivePreset funnels the
        // payload through sanitizePresetEntry which historically dropped
        // them by explicit-field projection on the agenda branch.
        expect(p.customTools[0].name).toBe('kept_agenda_tool');
        expect(p.defaultTools.custom.some_flag).toBe(true);
    });
});

describe('persistRuntimeLimitsPatch — character scope', () => {
    test('writes to character.data.extensions.orchestrator and calls writeExtensionField', async () => {
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
                                    tools: {},
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
        await persist.persistRuntimeLimitsPatch(ctx, extensionSettings.orchestrator, 'director', 'character', {
            maxRounds: 55,
        }, { avatar: 'alice.png' });
        expect(writes.length).toBe(1);
        const payload = writes[0].value;
        expect(payload.presetLibraries.director.d1.maxRounds).toBe(55);
        expect(payload.presetLibraries.director.d1.mainAgent.systemPrompt).toBe('CARD-MAIN-UNCHANGED');
        expect(payload.overrideEnabled.director).toBe(true); // untouched
    });
});
