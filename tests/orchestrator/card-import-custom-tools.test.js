import { jest } from '@jest/globals';

// Tests for collectCustomToolsFromCardExtension + stripCustomToolsFromCardExtension.
//
// /api/characters/import writes the orchestrator blob verbatim, no
// migration. A third-party card whose orchestrator profile carries
// `customTools[]` would land on disk and register at runtime without
// any user review — that's executable JavaScript with full session
// permissions. The orchestrator already has a review popup for the
// "apply iter-studio session → character" path; here we add the
// data-layer helpers it uses to detect tools on an imported card and
// strip them if the user declines.
//
// Pure data layer; no DOM, no eventSource, no settings. The popup +
// CHARACTER_IMPORTED wiring lives in main.js and is exercised
// separately.

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
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
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

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/orchestrator/card-import-custom-tools.js');
});

function makeTool(name) {
    return {
        name,
        displayName: name,
        description: 'A test tool',
        parameters: { type: 'object' },
        mode: 'write',
        body: 'return { ok: true };',
    };
}

describe('collectCustomToolsFromCardExtension', () => {
    test('returns empty when extension has no orchestrator data', () => {
        const result = mod.collectCustomToolsFromCardExtension(null);
        expect(result.tools).toEqual([]);
        expect(result.locations).toEqual([]);
    });

    test('returns empty when no customTools live anywhere in the blob', () => {
        const ext = {
            presetLibraries: {
                loop: { default: { name: 'Default', system_prompt: 'P' } },
            },
            activePresetIds: { loop: 'default' },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools).toEqual([]);
        expect(result.locations).toEqual([]);
    });

    test('aggregates tools from a new-shape loop preset library', () => {
        const ext = {
            presetLibraries: {
                loop: {
                    p1: { name: 'P1', customTools: [makeTool('tool_a')] },
                    p2: { name: 'P2', customTools: [makeTool('tool_b'), makeTool('tool_c')] },
                },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools.map(t => t.name).sort()).toEqual(['tool_a', 'tool_b', 'tool_c']);
        // Locations are described well enough to strip — at minimum
        // every preset entry that carried tools must be reachable.
        expect(result.locations).toHaveLength(2);
    });

    test('finds tools on a new-shape spec preset (tools live under .spec)', () => {
        const ext = {
            presetLibraries: {
                spec: {
                    default: {
                        name: 'Default',
                        spec: { stages: [], customTools: [makeTool('spec_tool')] },
                        presets: {},
                    },
                },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools.map(t => t.name)).toEqual(['spec_tool']);
    });

    test('finds tools on a legacy override.<mode> payload', () => {
        const ext = {
            override: {
                mode: 'loop',
                loop: { enabled: true, system_prompt: 'P', customTools: [makeTool('legacy_loop_tool')] },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools.map(t => t.name)).toEqual(['legacy_loop_tool']);
    });

    test('finds tools on a legacy override.spec.customTools payload', () => {
        const ext = {
            override: {
                mode: 'spec',
                enabled: true,
                spec: { stages: [], customTools: [makeTool('legacy_spec_tool')] },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools.map(t => t.name)).toEqual(['legacy_spec_tool']);
    });

    test('aggregates tools across BOTH legacy and new shapes when both exist', () => {
        // A partially-migrated card may have both. Both must surface
        // through the review popup or the user will only see a subset
        // of what is about to run.
        const ext = {
            presetLibraries: {
                loop: { p1: { name: 'P1', customTools: [makeTool('new_tool')] } },
            },
            override: {
                loop: { customTools: [makeTool('legacy_tool')] },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        expect(result.tools.map(t => t.name).sort()).toEqual(['legacy_tool', 'new_tool']);
    });

    test('skips entries that are not arrays of objects', () => {
        const ext = {
            presetLibraries: {
                loop: {
                    p1: { name: 'P1', customTools: 'not an array' },
                    p2: { name: 'P2', customTools: [null, 'bad', { name: 'good_tool', body: '' }] },
                },
            },
        };
        const result = mod.collectCustomToolsFromCardExtension(ext);
        // Bad entries silently dropped; good one survives.
        expect(result.tools.map(t => t.name)).toEqual(['good_tool']);
    });
});

describe('stripCustomToolsFromCardExtension', () => {
    test('clears customTools at every location the collect call returned', () => {
        const ext = {
            presetLibraries: {
                loop: { p1: { name: 'P1', customTools: [makeTool('t1')] } },
                spec: { default: { name: 'Default', spec: { customTools: [makeTool('t2')] }, presets: {} } },
            },
            override: {
                loop: { customTools: [makeTool('t3')] },
            },
        };
        const { locations } = mod.collectCustomToolsFromCardExtension(ext);

        mod.stripCustomToolsFromCardExtension(ext, locations);

        expect(ext.presetLibraries.loop.p1.customTools).toEqual([]);
        expect(ext.presetLibraries.spec.default.spec.customTools).toEqual([]);
        expect(ext.override.loop.customTools).toEqual([]);
    });

    test('is a no-op when locations is empty', () => {
        const ext = {
            presetLibraries: { loop: { p1: { name: 'P1', system_prompt: 'P' } } },
        };
        const before = JSON.stringify(ext);
        mod.stripCustomToolsFromCardExtension(ext, []);
        expect(JSON.stringify(ext)).toBe(before);
    });

    test('a follow-up collect after strip returns no tools', () => {
        const ext = {
            presetLibraries: {
                loop: { p1: { name: 'P1', customTools: [makeTool('t1'), makeTool('t2')] } },
            },
        };
        const { locations } = mod.collectCustomToolsFromCardExtension(ext);
        mod.stripCustomToolsFromCardExtension(ext, locations);
        const after = mod.collectCustomToolsFromCardExtension(ext);
        expect(after.tools).toEqual([]);
    });
});

describe('planImportedCardCustomToolsReview', () => {
    test('"with" → keep (no persistence)', () => {
        const ext = {
            presetLibraries: { loop: { p1: { name: 'P1', customTools: [makeTool('t1')] } } },
        };
        const plan = mod.planImportedCardCustomToolsReview(ext, 'with');
        expect(plan).toEqual({ action: 'keep', nextExt: null });
    });

    test('"cancel" → drop (caller should write null)', () => {
        const ext = {
            presetLibraries: { loop: { p1: { name: 'P1', customTools: [makeTool('t1')] } } },
        };
        const plan = mod.planImportedCardCustomToolsReview(ext, 'cancel');
        expect(plan).toEqual({ action: 'drop', nextExt: null });
    });

    test('"without" → strip; nextExt is a clone with customTools cleared', () => {
        const ext = {
            presetLibraries: {
                loop: { p1: { name: 'P1', customTools: [makeTool('t1')] } },
                spec: { default: { name: 'Default', spec: { customTools: [makeTool('t2')] }, presets: {} } },
            },
            override: { loop: { customTools: [makeTool('t3')] } },
        };
        const plan = mod.planImportedCardCustomToolsReview(ext, 'without');

        expect(plan.action).toBe('strip');
        // The original blob is untouched — caller will pass `nextExt`
        // to the persistor, not the in-memory blob it scanned.
        expect(ext.presetLibraries.loop.p1.customTools).toHaveLength(1);
        expect(ext.override.loop.customTools).toHaveLength(1);
        // The plan's clone has every customTools location flushed.
        expect(plan.nextExt.presetLibraries.loop.p1.customTools).toEqual([]);
        expect(plan.nextExt.presetLibraries.spec.default.spec.customTools).toEqual([]);
        expect(plan.nextExt.override.loop.customTools).toEqual([]);
        // Surrounding fields survive the strip.
        expect(plan.nextExt.presetLibraries.loop.p1.name).toBe('P1');
    });

    test('unknown decision string falls back to keep (defensive)', () => {
        const ext = { presetLibraries: { loop: { p1: { name: 'P1' } } } };
        const plan = mod.planImportedCardCustomToolsReview(ext, 'maybe');
        expect(plan).toEqual({ action: 'keep', nextExt: null });
    });

    test('"without" on a card with no orchestrator data is a no-op', () => {
        const plan = mod.planImportedCardCustomToolsReview(null, 'without');
        expect(plan).toEqual({ action: 'keep', nextExt: null });
    });
});
