// Regression: AI Iteration Studio's director save was reported as "no real
// changes hit the override". The save IS correct, but the read-back path
// (`loadCharacterDirectorEditorState`) silently wipes the override.
//
// Root cause: `getCharacterDirectorOverrideByAvatar(ctx, avatar)` returns
// `override.director` directly — the bare director sub-object (mainAgent,
// subAgents, maxRounds, ...) with NO nested `director` key. Passing it
// straight into `sanitizeDirectorProfile(directorOverride)` triggers
// `const input = profile?.director ?? {}`, which finds `undefined` and
// falls back to defaults. The "sanitized override" then carries empty
// mainAgent + zero sub-agents + default limits, the global fallbacks in
// the merge kick in, and the user sees a perfect copy of the global
// profile masquerading as their override.
//
// Pinning the fix: pass `{ director: directorOverride }` (or otherwise
// adapt the shape) so the sanitizer reads the override's fields.

import { jest } from '@jest/globals';

// public/lib.js pulls a browser bundle — short-circuit per existing
// orchestrator test conventions.
jest.unstable_mockModule('../../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});

// SillyTavern surface seams editor-state transitively pulls in. Mocked
// to avoid loading the whole UI runtime + bookmarks/group-chats/request-
// compression chain (which references the absolute `/lib.js` URL that
// the Node module resolver cannot find).
const extensionSettings = { orchestrator: {} };
jest.unstable_mockModule('../../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    getContext: () => ({}),
    writeExtensionField: () => {},
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../../public/script.js', () => ({
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
// world-info.js + utils.js cascade pulls /lib.js via request-compression
// — short-circuit both with stubs that only export what defaults / our
// loaders actually touch.
jest.unstable_mockModule('../../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));
jest.unstable_mockModule('../../../public/scripts/utils.js', () => ({}));
// scripts/i18n.js loads scripts/power-user.js which transitively pulls the
// whole UI surface (including bookmarks → request-compression → '/lib.js').
// orchestrator/i18n.js is the only module that imports it for our chain.
jest.unstable_mockModule('../../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
}));
// editable-spec.js → agent-resolution.js → profile-resolver.js → openai.js
// → group-chats.js → request-compression.js → '/lib.js' (absolute URL,
// unresolvable under Jest). Cut the chain at the orchestrator-internal
// boundary by mocking agent-resolution so the heavy SillyTavern modules
// never load.
jest.unstable_mockModule('../../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override) => override || null,
}));

let loadCharacterDirectorEditorState;
let createDefaultDirectorProfile;

beforeAll(async () => {
    ({ loadCharacterDirectorEditorState } = await import(
        '../../../public/scripts/extensions/orchestrator/editor-state.js'
    ));
    ({ createDefaultDirectorProfile } = await import(
        '../../../public/scripts/extensions/orchestrator/director-defaults.js'
    ));
});

beforeEach(() => {
    // Reset module-private settings between tests.
    extensionSettings.orchestrator = {};
});

function makeContextWithOverride(overrideDirector) {
    return {
        characterId: 0,
        characters: [
            {
                avatar: 'default_Seraphina.png',
                name: 'Seraphina',
                data: {
                    extensions: {
                        orchestrator: {
                            override: {
                                mode: 'director',
                                director: overrideDirector,
                            },
                        },
                    },
                },
            },
        ],
    };
}

describe('loadCharacterDirectorEditorState — override merge', () => {
    test('character override fields survive the load (not silently dropped to defaults)', () => {
        // Global director uses defaults.
        extensionSettings.orchestrator.directorProfile = createDefaultDirectorProfile();

        // Saved override on the card — shape matches what
        // persistCharacterDirectorEditor writes: bare director sub-object,
        // NOT { director: {...} }.
        const overrideDirector = {
            mainAgent: {
                systemPrompt: 'OVERRIDE_MAIN_PROMPT_MARKER',
                apiPresetName: 'override-api',
                promptPresetName: 'override-prompt',
                tools: null,
            },
            subAgents: [
                {
                    id: 'override_critic',
                    description: 'override-only critic',
                    systemPrompt: 'critic body',
                    apiPresetName: '',
                    promptPresetName: '',
                    tools: null,
                },
            ],
            maxRounds: 7,
            maxConcurrentSubagents: 2,
            maxTotalSubagentRuns: 11,
            tools: {},
            discardOnAbort: true,
            enabled: true,
            updatedAt: 1234567890,
            name: 'Seraphina',
        };

        const ctx = makeContextWithOverride(overrideDirector);
        const loaded = loadCharacterDirectorEditorState(ctx, 'default_Seraphina.png');

        // After the director-shape unification: load returns FLAT, so the
        // override fields surface at the top of the editor object.
        expect(loaded.mainAgent.systemPrompt).toBe('OVERRIDE_MAIN_PROMPT_MARKER');
        expect(loaded.maxRounds).toBe(7);
        expect(loaded.maxConcurrentSubagents).toBe(2);
        expect(loaded.maxTotalSubagentRuns).toBe(11);
        expect(loaded.discardOnAbort).toBe(true);
        expect(loaded.subAgents).toHaveLength(1);
        expect(loaded.subAgents[0]).toMatchObject({
            id: 'override_critic',
            systemPrompt: 'critic body',
        });
        expect(loaded.enabled).toBe(true);
    });

    test('an empty override (no mainAgent prompt, no sub-agents) still inherits global', () => {
        // Defensive: the "fall back to global when override is empty"
        // ergonomic in loadCharacterDirectorEditorState should keep working
        // after the fix.
        const globalProfile = createDefaultDirectorProfile();
        globalProfile.mainAgent.systemPrompt = 'GLOBAL_PROMPT';
        globalProfile.subAgents = [
            { id: 'global_sub', description: 'd', systemPrompt: 'gp', apiPresetName: '', promptPresetName: '', tools: null },
        ];
        extensionSettings.orchestrator.directorProfile = globalProfile;

        const overrideDirector = {
            mainAgent: {
                systemPrompt: '',
                apiPresetName: '',
                promptPresetName: '',
                tools: null,
            },
            subAgents: [],
            maxRounds: 9,  // valid override field
            tools: {},
            enabled: true,
        };

        const ctx = makeContextWithOverride(overrideDirector);
        const loaded = loadCharacterDirectorEditorState(ctx, 'default_Seraphina.png');

        // mainAgent + subAgents fall back to global (existing ergonomic).
        expect(loaded.mainAgent.systemPrompt).toBe('GLOBAL_PROMPT');
        expect(loaded.subAgents).toHaveLength(1);
        expect(loaded.subAgents[0].id).toBe('global_sub');
        // But explicit numeric overrides like maxRounds DO win over global.
        expect(loaded.maxRounds).toBe(9);
    });
});
