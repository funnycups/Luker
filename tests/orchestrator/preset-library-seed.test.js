import { jest } from '@jest/globals';

// defaults.js (transitively imported by preset-library.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time. Provide a minimal shim so module evaluation succeeds.
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
// Sever import chain at agent-resolution, mirroring preset-library.test.js.
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
let ORCH_EXECUTION_MODE_DIRECTOR;
let ORCH_EXECUTION_MODE_LOOP;
beforeAll(async () => {
    lib = await import('../../public/scripts/extensions/orchestrator/preset-library.js');
    ({ ORCH_EXECUTION_MODE_DIRECTOR } = await import('../../public/scripts/extensions/orchestrator/director-defaults.js'));
    ({ ORCH_EXECUTION_MODE_LOOP } = await import('../../public/scripts/extensions/orchestrator/defaults.js'));
});

function freshSettings() {
    return {
        presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} },
        activePresetIds: { spec: '', agenda: '', loop: '', director: '' },
    };
}

describe('preset-library: director factory seeds two entries on fresh install', () => {
    test('first read on empty director library seeds both entries', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
        const ids = Object.keys(settings.presetLibraries.director).sort();
        expect(ids).toEqual(['default', 'default-full']);
    });

    test('default-full is the active entry after seed', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
        expect(settings.activePresetIds.director).toBe('default-full');
    });

    test('default-full entry has memory_curator (Full preset content carried through)', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
        const full = settings.presetLibraries.director['default-full'];
        const ids = full.subAgents.map(a => a.id);
        expect(ids).toContain('memory_curator');
        expect(full.name).toBe('Default (记忆图 + 搜索)');
    });

    test('default entry does NOT have memory_curator (Minimal preset content carried through)', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
        const minimal = settings.presetLibraries.director['default'];
        const ids = minimal.subAgents.map(a => a.id);
        expect(ids).not.toContain('memory_curator');
        expect(minimal.name).toBe('Default (无记忆图，无搜索)');
    });
});

describe('preset-library: director re-seed on full deletion', () => {
    test('deleting both entries triggers re-seed of both', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
        lib.deletePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, 'global', 'default');
        lib.deletePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, 'global', 'default-full');
        const ids = Object.keys(settings.presetLibraries.director).sort();
        expect(ids).toEqual(['default', 'default-full']);
    });
});

describe('preset-library: other modes still seed exactly one entry', () => {
    test('loop mode seeds a single "default" entry', () => {
        const settings = freshSettings();
        lib.getActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, { scope: 'global' });
        const ids = Object.keys(settings.presetLibraries.loop);
        expect(ids).toEqual(['default']);
    });
});

describe('preset-library: legacy migration', () => {
    test('director with NO legacy data seeds both entries', () => {
        const settings = freshSettings();
        lib.migrateGlobalLegacyToLibraries(settings);
        const ids = Object.keys(settings.presetLibraries.director).sort();
        expect(ids).toEqual(['default', 'default-full']);
        expect(settings.activePresetIds.director).toBe('default-full');
    });

    test('director with legacy directorProfile keeps single default entry only', () => {
        const settings = freshSettings();
        settings.directorProfile = {
            mode: 'director',
            mainAgent: { systemPrompt: 'legacy prompt', tools: null },
            subAgents: [],
            maxRounds: 10,
            maxConcurrentSubagents: 2,
            maxTotalSubagentRuns: 8,
            tools: {},
        };
        lib.migrateGlobalLegacyToLibraries(settings);
        const ids = Object.keys(settings.presetLibraries.director);
        expect(ids).toEqual(['default']);
        expect(settings.activePresetIds.director).toBe('default');
    });

    test('director migration with no legacy AND content shape preserved (anti-degradation regression test)', () => {
        // This test exists specifically to catch the silent-degradation bug
        // B3 introduced: factory returns array, but consumer code assumed
        // single object → spread an Array into sanitizePresetEntry produced
        // a near-empty preset. Without this test, no other test would have
        // caught the degradation because they only assert on key presence.
        const settings = freshSettings();
        lib.migrateGlobalLegacyToLibraries(settings);
        const fullPreset = settings.presetLibraries.director['default-full'];
        // Sub-agent list must carry through (verifies the spread happened correctly)
        expect(Array.isArray(fullPreset.subAgents)).toBe(true);
        expect(fullPreset.subAgents.length).toBeGreaterThan(0);
        // memory_curator presence specifically — load-bearing for "Full vs Minimal"
        const ids = fullPreset.subAgents.map(a => a.id);
        expect(ids).toContain('memory_curator');
    });
});
