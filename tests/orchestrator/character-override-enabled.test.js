// Tests for the per-character "override enabled" toggle helpers.
//
// The runtime in main.js:getEffectiveProfile already gates each mode on
// `<override>?.enabled`, falling back to the global profile when the
// flag is false. The UI side, however, had no affordance to flip that
// flag without re-saving the entire override; the only nearby option
// was "Clear Character Override", which destroys the data.
//
// These tests pin the four lightweight helpers added in editor-persist.js
// to fill that gap. Each helper writes the same `override` object back
// with a single `enabled` field flipped — payloads, names, and
// timestamps for *other* sub-modes must stay byte-identical, and the
// helper must refuse to write when there is no matching sub-override
// to toggle (so a stray click on a hidden control cannot synthesize a
// half-empty payload).

import { jest } from '@jest/globals';

// defaults.js (transitively imported by editor-persist.js) reads
// `SillyTavern.getContext().constants.{promptRoles,wiPosition}` at module
// load time after upstream commit 571c529c2. editor-persist.js also
// captures `SillyTavern.getContext().saveSettings` and `.constants.unset`
// at module-load. Expose stubs + the shared `extensionSettings` so
// beforeEach() mutations propagate.
const extensionSettings = { orchestrator: {} };
globalThis.SillyTavern = {
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
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
}));

let setCharacterSpecOverrideEnabled;
let setCharacterAgendaOverrideEnabled;
let setCharacterLoopOverrideEnabled;
let setCharacterDirectorOverrideEnabled;

beforeAll(async () => {
    ({
        setCharacterSpecOverrideEnabled,
        setCharacterAgendaOverrideEnabled,
        setCharacterLoopOverrideEnabled,
        setCharacterDirectorOverrideEnabled,
    } = await import(
        '../../public/scripts/extensions/orchestrator/editor-persist.js'
    ));
});

beforeEach(() => {
    extensionSettings.orchestrator = {};
});

const AVATAR = 'default_Seraphina.png';

function makeContext(override) {
    const writes = [];
    const character = {
        avatar: AVATAR,
        name: 'Seraphina',
        data: {
            extensions: {
                orchestrator: override ? { override } : {},
            },
        },
    };
    return {
        ctx: {
            characterId: 0,
            characters: [character],
            writeExtensionField: async (id, key, value) => {
                writes.push({ id, key, value });
                if (value && typeof value === 'object') {
                    character.data.extensions[key] = value;
                } else {
                    delete character.data.extensions[key];
                }
            },
        },
        writes,
        readOverride() {
            return character.data?.extensions?.orchestrator?.override ?? null;
        },
    };
}

describe('setCharacterSpecOverrideEnabled', () => {
    test('flips override.enabled and preserves the spec payload', async () => {
        const original = {
            mode: 'spec',
            enabled: true,
            spec: { stages: [{ id: 's1', mode: 'serial', nodes: [{ id: 'n1', preset: 'p1' }] }] },
            presets: { p1: { systemPrompt: 'KEEP_ME' } },
            presetPatch: { p1: { userPromptTemplate: 'KEEP_ME_TOO' } },
            updatedAt: 1000,
            name: 'Seraphina',
        };
        const { ctx, writes, readOverride } = makeContext(structuredClone(original));

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        const next = readOverride();
        expect(next.enabled).toBe(false);
        expect(next.spec).toEqual(original.spec);
        expect(next.presets).toEqual(original.presets);
        expect(next.presetPatch).toEqual(original.presetPatch);
        expect(next.name).toBe(original.name);
        expect(typeof next.updatedAt).toBe('number');
        expect(next.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    });

    test('refuses to toggle when no spec override exists', async () => {
        const { ctx, writes } = makeContext({
            mode: 'loop',
            loop: { enabled: true, updatedAt: 2000 },
        });

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('idempotent when target value equals current value', async () => {
        const { ctx, readOverride } = makeContext({
            mode: 'spec',
            enabled: true,
            spec: { stages: [] },
            presets: {},
            updatedAt: 3000,
        });

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, true);

        expect(ok).toBe(true);
        expect(readOverride().enabled).toBe(true);
        expect(readOverride().spec).toEqual({ stages: [] });
    });
});

describe('setCharacterAgendaOverrideEnabled', () => {
    test('flips override.agenda.enabled and preserves the agenda payload', async () => {
        const original = {
            mode: 'agenda',
            agenda: {
                enabled: true,
                planner: { systemPrompt: 'AGENDA_KEEP' },
                agents: { a1: { systemPrompt: 'A1' } },
                finalAgentId: 'a1',
                limits: { plannerMaxRounds: 5, maxConcurrentAgents: 2, maxTotalRuns: 10 },
                updatedAt: 1000,
                name: 'Seraphina',
            },
        };
        const { ctx, readOverride } = makeContext(structuredClone(original));

        const ok = await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readOverride();
        expect(next.agenda.enabled).toBe(false);
        expect(next.agenda.planner).toEqual(original.agenda.planner);
        expect(next.agenda.agents).toEqual(original.agenda.agents);
        expect(next.agenda.finalAgentId).toBe(original.agenda.finalAgentId);
        expect(next.agenda.limits).toEqual(original.agenda.limits);
        expect(next.agenda.name).toBe(original.agenda.name);
        expect(next.agenda.updatedAt).toBeGreaterThanOrEqual(original.agenda.updatedAt);
    });

    test('refuses to toggle when no agenda sub-override exists', async () => {
        const { ctx, writes } = makeContext({
            mode: 'spec',
            enabled: true,
            spec: { stages: [] },
            updatedAt: 1000,
        });

        const ok = await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('leaves sibling sub-overrides untouched', async () => {
        const { ctx, readOverride } = makeContext({
            mode: 'agenda',
            enabled: true,
            spec: { stages: [{ id: 's1', mode: 'serial', nodes: [] }] },
            presets: { keep: { systemPrompt: 'X' } },
            agenda: { enabled: true, planner: { systemPrompt: 'P' }, updatedAt: 1000 },
            loop: { enabled: true, updatedAt: 2000 },
        });

        await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        const next = readOverride();
        expect(next.enabled).toBe(true); // spec-level enabled untouched
        expect(next.spec).toEqual({ stages: [{ id: 's1', mode: 'serial', nodes: [] }] });
        expect(next.presets).toEqual({ keep: { systemPrompt: 'X' } });
        expect(next.loop).toEqual({ enabled: true, updatedAt: 2000 });
        expect(next.agenda.enabled).toBe(false);
    });
});

describe('setCharacterLoopOverrideEnabled', () => {
    test('flips override.loop.enabled and preserves the loop payload', async () => {
        const original = {
            mode: 'loop',
            loop: {
                enabled: true,
                tools: { search: { enabled: true } },
                systemPrompt: 'LOOP_KEEP',
                updatedAt: 1000,
                name: 'Seraphina',
            },
        };
        const { ctx, readOverride } = makeContext(structuredClone(original));

        const ok = await setCharacterLoopOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readOverride();
        expect(next.loop.enabled).toBe(false);
        expect(next.loop.tools).toEqual(original.loop.tools);
        expect(next.loop.systemPrompt).toBe(original.loop.systemPrompt);
        expect(next.loop.name).toBe(original.loop.name);
        expect(next.loop.updatedAt).toBeGreaterThanOrEqual(original.loop.updatedAt);
    });

    test('refuses to toggle when no loop sub-override exists', async () => {
        const { ctx, writes } = makeContext({ mode: 'spec', enabled: true, spec: { stages: [] } });

        const ok = await setCharacterLoopOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });
});

describe('setCharacterDirectorOverrideEnabled', () => {
    test('flips override.director.enabled and preserves the director payload', async () => {
        const original = {
            mode: 'director',
            director: {
                enabled: true,
                mainAgent: { systemPrompt: 'DIRECTOR_KEEP' },
                subAgents: [{ id: 'critic', systemPrompt: 'c' }],
                maxRounds: 7,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 11,
                tools: {},
                discardOnAbort: true,
                updatedAt: 1000,
                name: 'Seraphina',
            },
        };
        const { ctx, readOverride } = makeContext(structuredClone(original));

        const ok = await setCharacterDirectorOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readOverride();
        expect(next.director.enabled).toBe(false);
        expect(next.director.mainAgent).toEqual(original.director.mainAgent);
        expect(next.director.subAgents).toEqual(original.director.subAgents);
        expect(next.director.maxRounds).toBe(original.director.maxRounds);
        expect(next.director.maxConcurrentSubagents).toBe(original.director.maxConcurrentSubagents);
        expect(next.director.maxTotalSubagentRuns).toBe(original.director.maxTotalSubagentRuns);
        expect(next.director.tools).toEqual(original.director.tools);
        expect(next.director.discardOnAbort).toBe(true);
        expect(next.director.name).toBe(original.director.name);
        expect(next.director.updatedAt).toBeGreaterThanOrEqual(original.director.updatedAt);
    });

    test('refuses to toggle when no director sub-override exists', async () => {
        const { ctx, writes } = makeContext({ mode: 'spec', enabled: true, spec: { stages: [] } });

        const ok = await setCharacterDirectorOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('returns false when the character is not on the context', async () => {
        const ctx = { characters: [] };
        const ok = await setCharacterDirectorOverrideEnabled(ctx, 'ghost.png', false);
        expect(ok).toBe(false);
    });
});
