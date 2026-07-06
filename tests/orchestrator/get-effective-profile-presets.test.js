import { jest } from '@jest/globals';

// Shared, mutable extension settings — main.js binds `extension_settings`
// from `Luker.getContext().extensionSettings` at module-load time
// (line 9 in main.js). Exposing the same reference here lets each test
// mutate `extensionSettings.orchestrator` before invoking
// getEffectiveProfile.
const extensionSettings = { orchestrator: {} };

// The snapshot-cache mock below reads from this closure so tests can
// simulate a loaded character via `currentAvatar = 'alice.png'`. The real
// `getCurrentAvatar(context)` reads `context.characters[context.characterId]
// .avatar`, but routing through `context` would require tests to fake the
// indexing layer too; this closure shortcut keeps the test focused on the
// preset-resolution branch.
let currentAvatar = '';

// main.js bottom-of-file IIFE registers UI handlers via `jQuery(() => …)`;
// `toastr.error/info/success` may be reached from defensive branches. Provide
// no-op globals so module-load doesn't throw.
globalThis.jQuery = Object.assign(() => ({ on: () => {}, off: () => {}, find: () => ({ on: () => {}, off: () => {}, length: 0 }) }), {
    fn: {},
});
globalThis.$ = globalThis.jQuery;
globalThis.toastr = { error: () => {}, info: () => {}, success: () => {}, warning: () => {} };

// Minimal SillyTavern shim. main.js reads `getContext()` at module top to
// hydrate constants, settings handles, and the extension-API registrar.
globalThis.Luker = {
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            promptTypes: { NONE: 0, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
        extensionSettings,
        saveSettings: async () => {},
        saveSettingsDebounced: () => {},
        registerExtensionApi: () => {},
        chatCompletionSettings: {},
        createMessageEditorHandle: () => null,
        skills: { listSkills: () => [], getSkill: () => null },
        getExtensionApi: () => null,
        eventSource: { on: () => {}, off: () => {}, emit: () => {} },
        event_types: {},
        callGenericPopup: async () => null,
        POPUP_TYPE: { TEXT: 0, INPUT: 1, CONFIRM: 2 },
    }),
};

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    buildAgentApiRoutingPromptData: () => ({}),
    buildAgentPromptPresetRoutingPromptData: () => ({}),
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    refreshOpenAIPresetSelectors: () => {},
    renderConnectionProfileOptions: () => '',
    renderOpenAIPresetOptions: () => '',
    resolveAgentToolFlags: (override) => override || null,
    resolveOrchestrationRuntimeWorldInfo: () => null,
    sanitizeConnectionProfileName: (v) => String(v || ''),
    sanitizePromptPresetName: (v) => String(v || ''),
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    getContext: () => globalThis.Luker.getContext(),
    writeExtensionField: async () => {},
    UNSET_VALUE: Symbol('unset'),
    renderExtensionTemplateAsync: async () => '',
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
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    debounce: (fn) => fn,
    uuidv4: () => 'uuid',
    download: () => {},
    getStringHash: () => '',
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: async () => null,
    POPUP_TYPE: { TEXT: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({
    SlashCommandParser: { addCommandObject: () => {} },
    SlashCommand: { fromProps: () => ({}) },
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
    ARGUMENT_TYPE: { STRING: 'string' },
}));

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/ui-templates.js', () => ({
    buildOrchestrationEditorPopupPanelHtml: () => '',
    buildOrchestratorSettingsHtml: () => '',
    injectWorkspaceIntoTabHost: () => {},
    renderInheritOrOverridePanel: () => '',
    renderSkillChipsPlaceholder: () => '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/styles.js', () => ({
    ensureStyles: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/abort-utils.js', () => ({
    isAbortError: () => false,
    isAbortSignalLike: () => false,
    linkAbortSignals: () => null,
    throwIfAborted: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    makeRuntimeToolCallId: () => 'id',
    serializeToolResultContent: (v) => String(v ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/template-vars.js', () => ({
    normalizeTemplateForAiPrompt: (v) => v,
    normalizeTemplateForRuntime: (v) => v,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/output-formatting.js', () => ({
    toReadableYamlText: (v) => String(v ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/pure-preset-body.js', () => ({
    // Only the large BODY blob is stubbed (this suite doesn't exercise its
    // contents). Keep every other export mirrored here — main.js and its
    // link graph reference DIRECTOR_PURE_PRESET_NAME by identifier and ESM
    // link errors out with "does not provide an export named ..." if a
    // future constant is added to pure-preset-body.js and forgotten here.
    // Mock can't `await import(...)` the same specifier — that would loop
    // through the same mock and OOM.
    DIRECTOR_PURE_PRESET_BODY: {},
    DIRECTOR_PURE_PRESET_NAME: 'orchestrator:director-pure',
}));
// snapshot-cache: getCurrentAvatar is the load-bearing one for this test.
// Routing it through the closure `currentAvatar` lets each test simulate a
// loaded character without faking context.characterId.
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/snapshot-cache.js', () => ({
    canReuseLatestOrchestrationSnapshot: () => false,
    clearCacheForChatChange: () => {},
    getActiveSnapshot: () => null,
    getChatKey: () => '',
    getCurrentAvatar: () => currentAvatar,
    getLatestOrchestrationEntry: () => null,
    getLoadedOrchestrationHistoryAnchors: () => [],
    loadOrchestratorChatState: async () => {},
    persistEditedSnapshotToFloorState: async () => {},
    refreshActiveSnapshotFromCache: () => {},
    refreshOrchestratorStateAfterStructuralEvent: () => {},
    setActiveSnapshot: () => {},
    storeCompletedOrchestrationSnapshot: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agenda-profile.js', () => ({
    buildAgendaProfileForRuntime: (v) => v,
    cloneAgendaWorkingProfileFromEditor: (v) => v,
    ensureAgendaEditorIntegrity: (v) => v,
    sanitizeAgendaWorkingProfile: (v) => v,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agenda-runtime.js', () => ({
    runAgendaOrchestration: async () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/spec-runtime.js', () => ({
    runSpecOrchestration: async () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/loop-runtime.js', () => ({
    runLoopOrchestration: async () => ({}),
    attachNotesFloorState: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/director-runtime.js', () => ({
    handleDirectorDispatch: async () => null,
    runMainAgentLoop: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/director-default-prompt.js', () => ({
    buildDirectorDefaultSystemPrompt: () => '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/director-content-payload.js', () => ({
    createContentPayloadCache: () => ({
        capture: () => {},
        get: () => null,
        clear: () => {},
    }),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/loop-tools.js', () => ({
    executeLoopTool: async () => null,
    beginSimulation: () => {},
    endSimulation: () => {},
    getBuiltinToolRegistry: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/register-custom-tool.js', () => ({
    registerOrchestrationTool: () => {},
    unregisterOrchestrationTool: () => {},
    listExtensionTools: () => [],
    bridgeSillyTavernTool: () => {},
    unbridgeSillyTavernTool: () => {},
    listAvailableSillyTavernTools: () => [],
    rehydrateBridgedSillyTavernTools: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/skill-orchestration-tools.js', () => ({
    registerSkillOrchestrationTools: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/tools/skill-iter-studio.js', () => ({
    SKILL_ITER_STUDIO_TOOL_DEFS: [],
    isSkillIterStudioTool: () => false,
    runSkillIterStudioTool: async () => null,
    commitApprovedSkillProposal: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/custom-tool-editor.js', () => ({
    openCustomToolEditor: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/bridge-st-tool-picker.js', () => ({
    openBridgeStToolPicker: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/studio-prompt-augment.js', () => ({
    augmentStudioPromptWithCustomTools: (v) => v,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/character-import-tools-review.js', () => ({
    reviewIncomingCustomTools: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/notes-panel.js', () => ({
    mountNotesPanel: () => {},
}));
jest.unstable_mockModule('../../public/scripts/skills/skill-manager-panel.js', () => ({
    openSkillManagerPanel: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/skills/skill-chips.js', () => ({
    mountSkillChips: () => {},
}));
jest.unstable_mockModule('../../public/scripts/skills/embed-lifecycle.js', () => ({
    registerSkillEmbedLifecycle: () => {},
}));
jest.unstable_mockModule('../../public/scripts/skills/embed-export-hook.js', () => ({
    maybeAttachSkillsToPresetExport: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/profile-projection.js', () => ({
    sanitizeProfileForAiPrompt: (v) => v,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/editor-state.js', () => ({
    createNewStage: () => ({}),
    ensureDirectorEditorIntegrity: (v) => v,
    ensureEditorIntegrity: (v) => v,
    ensureLoopEditorIntegrity: (v) => v,
    initializeUiState: () => {},
    loadCharacterAgendaEditorState: () => ({}),
    loadCharacterDirectorEditorState: () => ({}),
    loadCharacterEditorState: () => ({}),
    loadCharacterLoopEditorState: () => ({}),
    loadGlobalAgendaEditorState: () => ({}),
    loadGlobalDirectorEditorState: () => ({}),
    loadGlobalEditorState: () => ({}),
    loadGlobalLoopEditorState: () => ({}),
    pickDefaultPreset: () => '',
    setDisplayedScopeForMode: () => {},
    syncCharacterEditorWithActiveAvatar: () => {},
    uiState: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/editor-display.js', () => ({
    getAgendaEditorByScope: () => ({}),
    getAgendaScopeFromElement: () => 'global',
    getCopyScopeFromElement: () => 'global',
    getDisplayedScope: () => 'global',
    getDisplayedScopeForMode: () => 'global',
    getDisplayedScopeLabel: () => '',
    getEditorByScope: () => ({}),
    getExplicitScopeFromElement: () => 'global',
    getIterationDefaultScope: () => 'global',
    getLoopEditorByScope: () => ({}),
    getPopupEditingLabel: () => '',
    getProfileTitleForScope: () => '',
    getScopeFromElementOrMode: () => 'global',
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/editor-persist.js', () => ({
    createPortableAgendaProfileFromEditor: () => ({}),
    createPortableDirectorProfileFromEditor: () => ({}),
    createPortableLoopProfileFromEditor: () => ({}),
    createPortableProfileFromEditor: () => ({}),
    persistCharacterAgendaEditor: async () => {},
    persistCharacterDirectorEditor: async () => {},
    persistCharacterEditor: async () => {},
    persistCharacterLoopEditor: async () => {},
    persistCustomToolsPatch: async () => {},
    persistGlobalAgendaEditorFrom: async () => {},
    persistGlobalDirectorEditorFrom: async () => {},
    persistGlobalEditorFrom: async () => {},
    persistGlobalLoopEditorFrom: async () => {},
    persistOrchestratorCharacterExtension: async () => {},
    persistRuntimeLimitsPatch: async () => {},
    setCharacterAgendaOverrideEnabled: async () => {},
    setCharacterDirectorOverrideEnabled: async () => {},
    setCharacterLoopOverrideEnabled: async () => {},
    setCharacterSpecOverrideEnabled: async () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/iter-studio/studio.js', () => ({
    openOrchestratorIterationStudio: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/index.js', () => ({
    openSimulationReview: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/i18n/index.js', () => ({
    ensureSimulationReviewLocaleData: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/dry-run-capture.js', () => ({
    captureDryRunPayload: () => null,
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/simulation-payload-adapter.js', () => ({
    exportSpecPayload: () => null,
    exportAgendaPayload: () => null,
    exportLoopPayload: () => null,
    exportDirectorPayload: () => null,
}));

let main;
beforeAll(async () => {
    main = await import('../../public/scripts/extensions/orchestrator/main.js');
});

beforeEach(() => {
    delete extensionSettings.orchestrator;
    currentAvatar = '';
});

function ctxWithCard(avatar, ext) {
    return { characters: [{ avatar, data: { extensions: { orchestrator: ext || {} } } }] };
}

describe('getEffectiveProfile — picks active preset from current scope', () => {
    test('director mode global → returns global active director preset', () => {
        extensionSettings.orchestrator = {
            executionMode: 'director',
            presetLibrariesMigrationDone: 1,
            presetLibraries: {
                spec: {}, agenda: {}, loop: {},
                director: {
                    d1: {
                        name: 'D1',
                        mainAgent: { systemPrompt: 'DIRECTOR-D1' },
                        subAgents: [],
                        maxRounds: 10,
                        maxConcurrentSubagents: 2,
                        maxTotalSubagentRuns: 8,
                        tools: {},
                        discardOnAbort: false,
                    },
                },
            },
            activePresetIds: { spec: '', agenda: '', loop: '', director: 'd1' },
        };
        const ctx = { characters: [] };
        const profile = main.getEffectiveProfile(ctx);
        expect(profile.mainAgent.systemPrompt).toBe('DIRECTOR-D1');
        expect(profile.source).toBe('global');
    });

    test('director mode + character with overrideEnabled.director → returns character active preset', () => {
        extensionSettings.orchestrator = {
            executionMode: 'director',
            presetLibrariesMigrationDone: 1,
            presetLibraries: {
                spec: {}, agenda: {}, loop: {},
                director: {
                    gd: {
                        name: 'GD',
                        mainAgent: { systemPrompt: 'GLOBAL-D' },
                        subAgents: [],
                        maxRounds: 10,
                        maxConcurrentSubagents: 2,
                        maxTotalSubagentRuns: 8,
                        tools: {},
                        discardOnAbort: false,
                    },
                },
            },
            activePresetIds: { spec: '', agenda: '', loop: '', director: 'gd' },
        };
        const ctx = ctxWithCard('alice.png', {
            override: { mode: 'director' },
            overrideEnabled: { director: true },
            presetLibraries: {
                director: {
                    cd: {
                        name: 'CD',
                        mainAgent: { systemPrompt: 'CARD-D' },
                        subAgents: [],
                        maxRounds: 10,
                        maxConcurrentSubagents: 2,
                        maxTotalSubagentRuns: 8,
                        tools: {},
                        discardOnAbort: false,
                    },
                },
            },
            activePresetIds: { director: 'cd' },
        });
        currentAvatar = 'alice.png';
        const profile = main.getEffectiveProfile(ctx);
        expect(profile.mainAgent.systemPrompt).toBe('CARD-D');
        expect(profile.source).toBe('character');
    });
});
