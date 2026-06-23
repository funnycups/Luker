// Tests for the per-character "override enabled" toggle helpers.
//
// The runtime in main.js:getEffectiveProfile already gates each mode on
// `overrideEnabled[mode]`, falling back to the global profile when the
// flag is false. The UI side, however, had no affordance to flip that
// flag without re-saving the entire override; the only nearby option
// was "Clear Character Override", which destroys the data.
//
// These tests pin the four lightweight helpers exported from
// editor-persist.js. Each helper writes the card-scoped
// `overrideEnabled[mode]` flag back with a single bit flipped — the
// per-mode preset library, active id, sibling enabled flags, and the
// saved-mode pin must stay byte-identical. The helper refuses to write
// when there is no preset library for that mode (so a stray click on a
// hidden control cannot synthesize a phantom override).

import { jest } from '@jest/globals';

// defaults.js (transitively imported by editor-persist.js) reads
// `Luker.getContext().constants.{promptRoles,wiPosition}` at module
// load time after upstream commit 571c529c2. editor-persist.js also
// captures `Luker.getContext().saveSettings` and `.constants.unset`
// at module-load. Expose stubs + the shared `extensionSettings` so
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

function makeContext(orchestratorExt) {
    const writes = [];
    const character = {
        avatar: AVATAR,
        name: 'Seraphina',
        data: {
            extensions: {
                orchestrator: orchestratorExt || {},
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
        readExt() {
            return character.data?.extensions?.orchestrator ?? null;
        },
    };
}

describe('setCharacterSpecOverrideEnabled', () => {
    test('flips overrideEnabled.spec and preserves preset libraries + sibling flags', async () => {
        const original = {
            override: { mode: 'spec' },
            presetLibraries: {
                spec: { default: { name: 'Default', spec: { stages: [] }, presets: { p1: { systemPrompt: 'KEEP' } } } },
                loop: { default: { name: 'Default', system_prompt: 'LOOP_KEEP' } },
            },
            activePresetIds: { spec: 'default', loop: 'default' },
            overrideEnabled: { spec: true, loop: true },
        };
        const { ctx, writes, readExt } = makeContext(structuredClone(original));

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        const next = readExt();
        expect(next.overrideEnabled.spec).toBe(false);
        expect(next.overrideEnabled.loop).toBe(true);
        expect(next.presetLibraries).toEqual(original.presetLibraries);
        expect(next.activePresetIds).toEqual(original.activePresetIds);
        expect(next.override).toEqual(original.override);
    });

    test('refuses to toggle when no preset library for spec exists', async () => {
        const { ctx, writes } = makeContext({
            override: { mode: 'loop' },
            presetLibraries: { loop: { default: { name: 'Default' } } },
            activePresetIds: { loop: 'default' },
            overrideEnabled: { loop: true },
        });

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('synthesizes overrideEnabled container when previously absent', async () => {
        const { ctx, readExt } = makeContext({
            presetLibraries: { spec: { default: { name: 'Default', spec: {}, presets: {} } } },
            activePresetIds: { spec: 'default' },
        });

        const ok = await setCharacterSpecOverrideEnabled(ctx, AVATAR, true);

        expect(ok).toBe(true);
        expect(readExt().overrideEnabled).toEqual({ spec: true });
    });
});

describe('setCharacterAgendaOverrideEnabled', () => {
    test('flips overrideEnabled.agenda and preserves the agenda preset payload', async () => {
        const original = {
            presetLibraries: {
                agenda: { default: { name: 'Default', planner: { systemPrompt: 'P' }, agents: {}, finalAgentId: 'finalizer', limits: {} } },
            },
            activePresetIds: { agenda: 'default' },
            overrideEnabled: { agenda: true },
        };
        const { ctx, readExt } = makeContext(structuredClone(original));

        const ok = await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readExt();
        expect(next.overrideEnabled.agenda).toBe(false);
        expect(next.presetLibraries).toEqual(original.presetLibraries);
    });

    test('refuses to toggle when no agenda preset library exists', async () => {
        const { ctx, writes } = makeContext({
            presetLibraries: { spec: { default: { name: 'Default' } } },
            activePresetIds: { spec: 'default' },
        });

        const ok = await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('leaves sibling enabled flags untouched', async () => {
        const { ctx, readExt } = makeContext({
            presetLibraries: {
                spec: { default: { name: 'Default' } },
                agenda: { default: { name: 'Default' } },
                loop: { default: { name: 'Default' } },
            },
            activePresetIds: { spec: 'default', agenda: 'default', loop: 'default' },
            overrideEnabled: { spec: true, agenda: true, loop: true },
        });

        await setCharacterAgendaOverrideEnabled(ctx, AVATAR, false);

        const next = readExt();
        expect(next.overrideEnabled).toEqual({ spec: true, agenda: false, loop: true });
    });
});

describe('setCharacterLoopOverrideEnabled', () => {
    test('flips overrideEnabled.loop and preserves the loop preset payload', async () => {
        const original = {
            presetLibraries: {
                loop: { default: { name: 'Default', system_prompt: 'LOOP_KEEP', tools: {} } },
            },
            activePresetIds: { loop: 'default' },
            overrideEnabled: { loop: true },
        };
        const { ctx, readExt } = makeContext(structuredClone(original));

        const ok = await setCharacterLoopOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readExt();
        expect(next.overrideEnabled.loop).toBe(false);
        expect(next.presetLibraries.loop).toEqual(original.presetLibraries.loop);
    });

    test('refuses to toggle when no loop preset library exists', async () => {
        const { ctx, writes } = makeContext({
            presetLibraries: { spec: { default: { name: 'Default' } } },
            activePresetIds: { spec: 'default' },
        });

        const ok = await setCharacterLoopOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(false);
        expect(writes).toHaveLength(0);
    });
});

describe('setCharacterDirectorOverrideEnabled', () => {
    test('flips overrideEnabled.director and preserves the director preset payload', async () => {
        const original = {
            presetLibraries: {
                director: {
                    default: {
                        name: 'Default',
                        mainAgent: { systemPrompt: 'DIRECTOR_KEEP' },
                        subAgents: [{ id: 'critic', systemPrompt: 'c' }],
                        maxRounds: 7,
                        maxConcurrentSubagents: 2,
                        maxTotalSubagentRuns: 11,
                        tools: {},
                        discardOnAbort: true,
                    },
                },
            },
            activePresetIds: { director: 'default' },
            overrideEnabled: { director: true },
        };
        const { ctx, readExt } = makeContext(structuredClone(original));

        const ok = await setCharacterDirectorOverrideEnabled(ctx, AVATAR, false);

        expect(ok).toBe(true);
        const next = readExt();
        expect(next.overrideEnabled.director).toBe(false);
        expect(next.presetLibraries.director).toEqual(original.presetLibraries.director);
    });

    test('refuses to toggle when no director preset library exists', async () => {
        const { ctx, writes } = makeContext({
            presetLibraries: { spec: { default: { name: 'Default' } } },
            activePresetIds: { spec: 'default' },
        });

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
