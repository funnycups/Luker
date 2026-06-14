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

describe('migrateGlobalLegacyToLibraries', () => {
    test('migrates loopProfile + directorProfile + spec + agenda fields', () => {
        const settings = {
            loopProfile: { system_prompt: 'LOOP-LEGACY', max_rounds: 10 },
            directorProfile: { mainAgent: { systemPrompt: 'DIR-LEGACY' } },
            orchestrationSpec: { stages: [{ id: 'only', mode: 'serial', nodes: ['x'] }] },
            presets: { x: { systemPrompt: 'P', userPromptTemplate: 'U' } },
            agendaPlanner: { systemPrompt: 'AP', userPromptTemplate: 'AT' },
            agendaAgents: { z: { systemPrompt: 'AG', userPromptTemplate: 'UG' } },
            agendaFinalAgentId: 'z',
            agendaPlannerMaxRounds: 7,
            agendaMaxConcurrentAgents: 2,
            agendaMaxTotalRuns: 30,
        };
        lib.migrateGlobalLegacyToLibraries(settings);
        expect(settings.presetLibraries.loop.default).toBeTruthy();
        expect(settings.presetLibraries.loop.default.system_prompt).toBe('LOOP-LEGACY');
        expect(settings.presetLibraries.director.default.mainAgent.systemPrompt).toBe('DIR-LEGACY');
        expect(settings.presetLibraries.spec.default.spec.stages.length).toBeGreaterThan(0);
        expect(settings.presetLibraries.agenda.default.planner.systemPrompt).toBe('AP');
        expect(settings.activePresetIds).toEqual({ spec: 'default', agenda: 'default', loop: 'default', director: 'default' });
        expect(settings.loopProfile).toBeUndefined();
        expect(settings.directorProfile).toBeUndefined();
        expect(settings.orchestrationSpec).toBeUndefined();
        expect(settings.presets).toBeUndefined();
        expect(settings.agendaPlanner).toBeUndefined();
        expect(settings.agendaAgents).toBeUndefined();
    });

    test('is idempotent when called twice', () => {
        const settings = { loopProfile: { system_prompt: 'X' } };
        lib.migrateGlobalLegacyToLibraries(settings);
        const first = JSON.stringify(settings.presetLibraries);
        lib.migrateGlobalLegacyToLibraries(settings);
        expect(JSON.stringify(settings.presetLibraries)).toBe(first);
    });

    test('fresh install seeds factory defaults for all 4 modes', () => {
        const settings = {};
        lib.migrateGlobalLegacyToLibraries(settings);
        expect(Object.keys(settings.presetLibraries.spec)).toContain('default');
        expect(Object.keys(settings.presetLibraries.agenda)).toContain('default');
        expect(Object.keys(settings.presetLibraries.loop)).toContain('default');
        expect(Object.keys(settings.presetLibraries.director)).toContain('default');
    });
});
