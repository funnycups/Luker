// @jest-environment node
import { jest } from '@jest/globals';

// Task 8 adds imports of character-overrides / editor-display /
// snapshot-cache / preset-library to preset-lifecycle-hooks.js. These
// pull in the same transitive chain that character-overrides-presets.test.js
// mocks — provide the same shim + module mocks so module evaluation
// succeeds under jest.
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

let hooks;

beforeAll(async () => {
    hooks = await import('../../public/scripts/extensions/orchestrator/preset-lifecycle-hooks.js');
});

function makeContext({ skills = {}, eventTypes = {}, emitError = null } = {}) {
    const emit = jest.fn(async (name, payload) => {
        if (emitError) throw emitError;
    });
    return {
        context: {
            skills,
            eventTypes,
            eventSource: { emit },
        },
        emit,
    };
}

describe('copyOrchPresetSkills', () => {
    test('calls skills.copyScope with correct fromScope/toScope shapes', async () => {
        const copyScope = jest.fn(async () => null);
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        });
        expect(copyScope).toHaveBeenCalledTimes(1);
        expect(copyScope).toHaveBeenCalledWith(
            { kind: 'orch-preset', mode: 'director', name: 'RP4' },
            { kind: 'orch-preset', mode: 'director', name: 'RP5' },
        );
    });

    test('is a no-op when oldName === newName', async () => {
        const copyScope = jest.fn();
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'same', newName: 'same',
        });
        expect(copyScope).not.toHaveBeenCalled();
    });

    test('swallows 404 (source has no skills) silently — no console.warn', async () => {
        const err = new Error('skill scope not found: orch-preset/director/RP4');
        err.status = 404;
        const copyScope = jest.fn(async () => { throw err; });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { context } = makeContext({ skills: { copyScope } });
        await hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('logs on non-404 error but does not throw', async () => {
        const err = new Error('destination already exists');
        err.status = 409;
        const copyScope = jest.fn(async () => { throw err; });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { context } = makeContext({ skills: { copyScope } });
        await expect(hooks.copyOrchPresetSkills(context, {
            mode: 'director', oldName: 'RP4', newName: 'RP5',
        })).resolves.not.toThrow();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('duplicate preset skills copy failed');
        warnSpy.mockRestore();
    });
});

describe('renameOrchPresetSkills', () => {
    test('calls skills.renameScope with {mode, name} newName shape (orch-preset requires object)', async () => {
        const renameScope = jest.fn(async () => null);
        const { context } = makeContext({ skills: { renameScope } });
        await hooks.renameOrchPresetSkills(context, {
            mode: 'agenda', oldName: 'planA', newName: 'planB',
        });
        expect(renameScope).toHaveBeenCalledWith(
            { kind: 'orch-preset', mode: 'agenda', name: 'planA' },
            { mode: 'agenda', name: 'planB' },
        );
    });
});

describe('emitOrchPresetDeleted', () => {
    test('emits ORCH_PRESET_DELETED with {mode, name} payload', async () => {
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_DELETED: 'orch_preset_deleted' },
        });
        await hooks.emitOrchPresetDeleted(context, { mode: 'director', name: 'RP4' });
        expect(emit).toHaveBeenCalledWith('orch_preset_deleted', { mode: 'director', name: 'RP4' });
    });

    test('is a no-op when eventTypes.ORCH_PRESET_DELETED is undefined', async () => {
        const { context, emit } = makeContext({ eventTypes: {} });
        await hooks.emitOrchPresetDeleted(context, { mode: 'director', name: 'RP4' });
        expect(emit).not.toHaveBeenCalled();
    });
});

describe('emitOrchPresetExportReady', () => {
    test('emits with payload as sole positional argument (matches OAI convention)', async () => {
        const payload = { format: 'PORTABLE_PROFILE_V2', mode: 'director', profile: { name: 'RP4' } };
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_EXPORT_READY: 'orch_preset_export_ready' },
        });
        await hooks.emitOrchPresetExportReady(context, payload);
        expect(emit).toHaveBeenCalledWith('orch_preset_export_ready', payload);
    });
});

describe('emitOrchPresetImportReady', () => {
    test('emits with {data, mode, name} payload (mirrors OAI {data, presetName} with mode extension)', async () => {
        const data = { name: 'RP5', mainAgent: { systemPrompt: 'x' } };
        const { context, emit } = makeContext({
            eventTypes: { ORCH_PRESET_IMPORT_READY: 'orch_preset_import_ready' },
        });
        await hooks.emitOrchPresetImportReady(context, { data, mode: 'director', name: 'RP5' });
        expect(emit).toHaveBeenCalledWith('orch_preset_import_ready', {
            data, mode: 'director', name: 'RP5',
        });
    });
});

describe('computeActiveOrchPresetScope', () => {
    test('returns orch-preset scope for the active preset in the current mode (global scope)', async () => {
        const settings = {
            executionMode: 'director',
            activePresetIds: { director: 'd1' },
            presetLibraries: {
                director: {
                    d1: { name: 'RP4', mainAgent: { systemPrompt: 'x' } },
                },
            },
        };
        const context = {
            extensionSettings: { orchestrator: settings },
            characterId: 0,
            characters: [{ avatar: 'alice.png' }],
        };
        const result = hooks.computeActiveOrchPresetScope(context, settings);
        expect(result).toEqual({ kind: 'orch-preset', mode: 'director', name: 'RP4' });
    });

    test('returns orch-preset scope for character-override preset when displayed scope is character', async () => {
        const character = {
            avatar: 'alice.png',
            name: 'Alice',
            data: {
                extensions: {
                    orchestrator: {
                        overrideEnabled: { director: true },
                        activePresetIds: { director: 'd1' },
                        presetLibraries: {
                            director: {
                                d1: { name: 'AliceRP', mainAgent: { systemPrompt: 'x' } },
                            },
                        },
                    },
                },
            },
        };
        const settings = {
            executionMode: 'director',
            activePresetIds: { director: 'd-global' },
            presetLibraries: {
                director: {
                    'd-global': { name: 'GlobalRP', mainAgent: { systemPrompt: 'y' } },
                },
            },
        };
        const context = {
            extensionSettings: { orchestrator: settings },
            characterId: 0,
            characters: [character],
        };
        const result = hooks.computeActiveOrchPresetScope(context, settings);
        // Character override active + displayed scope = character → returns character-side preset name.
        expect(result).toEqual({ kind: 'orch-preset', mode: 'director', name: 'AliceRP' });
    });

    test('returns null when the active preset has no name', async () => {
        const settings = {
            executionMode: 'director',
            activePresetIds: { director: 'd1' },
            presetLibraries: { director: { d1: { name: '' } } },
        };
        const context = {
            extensionSettings: { orchestrator: settings },
            characterId: 0,
            characters: [{ avatar: 'alice.png' }],
        };
        const result = hooks.computeActiveOrchPresetScope(context, settings);
        expect(result).toBeNull();
    });

    test('returns null when settings has no active preset for the current mode', async () => {
        const settings = {
            executionMode: 'director',
            activePresetIds: { director: '' },
            presetLibraries: { director: {} },
        };
        const context = {
            extensionSettings: { orchestrator: settings },
            characterId: null,
            characters: [],
        };
        const result = hooks.computeActiveOrchPresetScope(context, settings);
        expect(result).toBeNull();
    });
});

describe('purgePromptPresetNameInLibrary', () => {
    test('clears loop preset field when name matches', () => {
        const libs = {
            loop: {
                l1: { name: 'A', promptPresetName: 'MyBase' },
                l2: { name: 'B', promptPresetName: 'Other' },
            },
        };
        const mutated = hooks.purgePromptPresetNameInLibrary(libs, 'MyBase');
        expect(mutated).toBe(true);
        expect(libs.loop.l1.promptPresetName).toBe('');
        expect(libs.loop.l2.promptPresetName).toBe('Other');
    });

    test('clears agenda planner and every matching agent', () => {
        const libs = {
            agenda: {
                a1: {
                    planner: { promptPresetName: 'MyBase' },
                    agents: {
                        one: { promptPresetName: 'MyBase' },
                        two: { promptPresetName: 'Other' },
                        three: { promptPresetName: 'MyBase' },
                    },
                },
            },
        };
        const mutated = hooks.purgePromptPresetNameInLibrary(libs, 'MyBase');
        expect(mutated).toBe(true);
        expect(libs.agenda.a1.planner.promptPresetName).toBe('');
        expect(libs.agenda.a1.agents.one.promptPresetName).toBe('');
        expect(libs.agenda.a1.agents.two.promptPresetName).toBe('Other');
        expect(libs.agenda.a1.agents.three.promptPresetName).toBe('');
    });

    test('clears director mainAgent and matching subAgents (array)', () => {
        const libs = {
            director: {
                d1: {
                    mainAgent: { promptPresetName: 'MyBase' },
                    subAgents: [
                        { id: 's1', promptPresetName: 'MyBase' },
                        { id: 's2', promptPresetName: 'Other' },
                    ],
                },
            },
        };
        const mutated = hooks.purgePromptPresetNameInLibrary(libs, 'MyBase');
        expect(mutated).toBe(true);
        expect(libs.director.d1.mainAgent.promptPresetName).toBe('');
        expect(libs.director.d1.subAgents[0].promptPresetName).toBe('');
        expect(libs.director.d1.subAgents[1].promptPresetName).toBe('Other');
    });

    test('clears spec preset entries under presets map', () => {
        const libs = {
            spec: {
                sp1: {
                    presets: {
                        pA: { promptPresetName: 'MyBase' },
                        pB: { promptPresetName: 'Other' },
                    },
                },
            },
        };
        const mutated = hooks.purgePromptPresetNameInLibrary(libs, 'MyBase');
        expect(mutated).toBe(true);
        expect(libs.spec.sp1.presets.pA.promptPresetName).toBe('');
        expect(libs.spec.sp1.presets.pB.promptPresetName).toBe('Other');
    });

    test('returns false and mutates nothing when no field matches', () => {
        const libs = {
            loop: { l1: { promptPresetName: 'X' } },
            director: {
                d1: {
                    mainAgent: { promptPresetName: 'Y' },
                    subAgents: [{ promptPresetName: 'Z' }],
                },
            },
        };
        const before = JSON.parse(JSON.stringify(libs));
        const mutated = hooks.purgePromptPresetNameInLibrary(libs, 'MyBase');
        expect(mutated).toBe(false);
        expect(libs).toEqual(before);
    });

    test('is a safe no-op when presetLibraries is missing or empty deletedName', () => {
        expect(hooks.purgePromptPresetNameInLibrary(undefined, 'X')).toBe(false);
        expect(hooks.purgePromptPresetNameInLibrary({}, 'X')).toBe(false);
        expect(hooks.purgePromptPresetNameInLibrary({ loop: { l1: { promptPresetName: 'X' } } }, '')).toBe(false);
    });
});
