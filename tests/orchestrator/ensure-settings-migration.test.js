import { jest } from '@jest/globals';

// Shared, mutable extension settings — main.js binds `extension_settings`
// from `Luker.getContext().extensionSettings` at module-load time
// (line 9 in main.js). Exposing the same reference here lets each test
// mutate `extensionSettings.orchestrator` before invoking ensureSettings.
const extensionSettings = { orchestrator: {} };
// Captures every registerExtensionApi call made at main.js module load.
const registeredExtensionApis = {};
const mockSetCharacterActivePreset = async () => ({ ok: false, mode: '', reason: 'no_saved_mode' });

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
// Provide just enough surface for module evaluation + ensureSettings to
// run without hitting `undefined` accessors.
const __defaultStateErrors = globalThis.Luker?.getContext?.()?.stateErrors;

globalThis.Luker = {
    getContext: () => ({
        stateErrors: __defaultStateErrors,
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
        registerExtensionApi: (name, api) => { registeredExtensionApis[name] = api; },
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

// `public/lib.js` is the bundled-vendor shim ST uses for lodash + yaml.
// Several orchestrator modules pull from it; route to real lodash so
// transitively imported real modules (preset-library, defaults, etc.)
// keep working.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});

// agenda-profile → editable-spec → agent-resolution → connection-manager →
// openai → group-chats → bookmarks → request-compression → '/lib.js'.
// Sever the chain at agent-resolution to avoid pulling the entire ST
// chat-completion stack into the test (mirrors editor-state-presets.test.js).
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

// ST core modules main.js transitively pulls in.
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

// Orchestrator sibling modules main.js imports. Each mock exposes JUST
// the named export(s) main.js destructures — providing more would invite
// silent breakage if main.js starts using something the mock lies about.
// Functions ensureSettings() actually calls (sanitizePresetMap,
// createAgendaPlannerDraft, normalizeIdToken, sanitizeSpec,
// migrateLegacyCapsuleInjectPosition, normalizeCapsuleInjectPosition,
// sanitizeLoopProfile, cloneDefault, normalizeExecutionMode) come from
// the REAL modules — those imports are not mocked here.
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/ui-templates.js', () => ({
    buildOrchestrationEditorPopupPanelHtml: () => '',
    buildOrchestratorSettingsHtml: () => '',
    injectWorkspaceIntoTabHost: () => {},
    refreshPresetSelectorBars: () => {},
    renderInheritOrOverridePanel: () => '',
    renderSkillChipsPlaceholder: () => '',
}));
// anchors.js delegates to the shared playable-anchor helpers; load it
// so persistence.js (also real, transitively imported via the persistence
// → anchors chain) finds its named exports.
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
// world-info.js (orchestrator-local, not the ST one) is leaf-pure and
// re-exported elsewhere; load the real module.
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
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/snapshot-cache.js', () => ({
    canReuseLatestOrchestrationSnapshot: () => false,
    clearCacheForChatChange: () => {},
    getActiveSnapshot: () => null,
    getChatKey: () => '',
    getCurrentAvatar: () => '',
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
    setAgendaEditorFinalAgent: () => {},
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
    isBuiltinToolName: () => false,
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
}));
jest.unstable_mockModule('../../public/scripts/skills/embed-export-hook.js', () => ({
    maybeAttachSkillsToOrchPresetExport: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/editor-state.js', () => ({
    copyAgendaAgentsIntoSpecEditor: () => {},
    createNewStage: () => ({}),
    ensureDirectorEditorIntegrity: (v) => v,
    ensureEditorIntegrity: (v) => v,
    ensureLoopEditorIntegrity: (v) => v,
    ensureLorebookFilterOnEditor: (v) => v,
    initializeUiState: () => {},
    loadCharacterAgendaEditorState: () => ({}),
    loadCharacterDirectorEditorState: () => ({}),
    loadCharacterEditorState: () => ({}),
    loadCharacterLoopEditorState: () => ({}),
    pickDefaultPreset: () => '',
    refreshUiStateFromHost: () => {},
    reloadPresetDraft: () => {},
    setDisplayedScopeForMode: () => {},
    setEditorNodePreset: () => {},
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
    persistCustomToolsKeepingDrafts: async () => {},
    persistGlobalAgendaEditorFrom: async () => {},
    persistGlobalDirectorEditorFrom: async () => {},
    persistGlobalEditorFrom: async () => {},
    persistGlobalLoopEditorFrom: async () => {},
    persistGlobalPresetWrite: async () => {},
    persistOrchestratorCharacterExtension: async () => {},
    persistRuntimeLimitsKeepingDrafts: async () => {},
    setCharacterActivePresetForSavedMode: mockSetCharacterActivePreset,
    setCharacterAgendaOverrideEnabled: async () => {},
    setCharacterDirectorOverrideEnabled: async () => {},
    setCharacterLoopOverrideEnabled: async () => {},
    setCharacterSpecOverrideEnabled: async () => {},
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
let routingTool;
beforeAll(async () => {
    main = await import('../../public/scripts/extensions/orchestrator/main.js');
    routingTool = await import('../../public/scripts/extensions/orchestrator/preset-routing-tool.js');
});

beforeEach(() => {
    // Clear so each test starts with a fresh `orchestrator` slot.
    delete extensionSettings.orchestrator;
});

describe('ensureSettings — runs migration once', () => {
    test('first call migrates legacy fields and sets the flag', () => {
        extensionSettings.orchestrator = {
            loopProfile: { system_prompt: 'LEGACY' },
            // no presetLibrariesMigrationDone
        };
        main.ensureSettings();
        expect(extensionSettings.orchestrator.loopProfile).toBeUndefined();
        expect(extensionSettings.orchestrator.presetLibraries.loop.default.system_prompt).toBe('LEGACY');
        expect(extensionSettings.orchestrator.presetLibrariesMigrationDone).toBe(1);
    });

    test('second call is a no-op', () => {
        extensionSettings.orchestrator = {
            presetLibrariesMigrationDone: 1,
            presetLibraries: { loop: { foo: { name: 'Foo', system_prompt: 'KEEP', tools: {}, max_rounds: 5, wall_clock_budget_ms: 60000 } }, spec: {}, agenda: {}, director: {} },
            activePresetIds: { spec: '', agenda: '', loop: 'foo', director: '' },
        };
        main.ensureSettings();
        expect(extensionSettings.orchestrator.presetLibraries.loop.foo.system_prompt).toBe('KEEP');
    });
});

describe('orchestrator extension api — card preset surface', () => {
    test('exposes the saved-mode reader and the preset switch, not the raw library writers', () => {
        const api = registeredExtensionApis.orchestrator;
        expect(typeof api.getCharacterSavedExecutionModeByAvatar).toBe('function');
        expect(typeof api.setCharacterActivePresetForSavedMode).toBe('function');
        expect(api).not.toHaveProperty('getCharacterPresetLibrary');
        expect(api).not.toHaveProperty('setActivePresetId');
    });
});

describe('iteration studio — preset routing read tool', () => {
    test.each(['spec', 'agenda', 'loop', 'director'])('the %s catalog offers the routing tool once', (mode) => {
        extensionSettings.orchestrator = {};
        main.ensureSettings();
        const names = main.buildAiIterationToolSet({ mode }).map((def) => def?.function?.name);
        expect(names.filter((name) => name === routingTool.PRESET_ROUTING_TOOL_NAME)).toHaveLength(1);
    });

    test('the tool takes no arguments', () => {
        expect(routingTool.PRESET_ROUTING_TOOL_DEF.function.name).toBe(routingTool.PRESET_ROUTING_TOOL_NAME);
        expect(routingTool.PRESET_ROUTING_TOOL_DEF.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
        expect(routingTool.isPresetRoutingTool(routingTool.PRESET_ROUTING_TOOL_NAME)).toBe(true);
        expect(routingTool.isPresetRoutingTool('luker_orch_read_spec_fields')).toBe(false);
    });
});

describe('ensureSettings — persisted preset routing prompt lines', () => {
    const FIELDS = ['requestSystemPrompt', 'iterModePromptLoop', 'iterModePromptDirector', 'iterModePromptAgenda', 'iterModePromptSpec'];

    function seededDefaults() {
        extensionSettings.orchestrator = {};
        main.ensureSettings();
        return Object.fromEntries(FIELDS.map((key) => [key, extensionSettings.orchestrator[key]]));
    }

    test('stored prompts that still carry the replaced lines load as the current defaults', () => {
        const defaults = seededDefaults();
        const toLegacy = new Map(routingTool.PRESET_ROUTING_PROMPT_LINE_MIGRATIONS.map(([legacy, current]) => [current, legacy]));
        const stored = Object.fromEntries(FIELDS.map((key) => [
            key,
            defaults[key].split('\n').map((line) => toLegacy.get(line) ?? line).join('\n'),
        ]));
        for (const key of FIELDS) expect(stored[key]).not.toBe(defaults[key]);

        extensionSettings.orchestrator = { ...stored };
        main.ensureSettings();
        for (const key of FIELDS) expect(extensionSettings.orchestrator[key]).toBe(defaults[key]);
    });

    test('a routing line the user edited stays as written', () => {
        const [legacy] = routingTool.PRESET_ROUTING_PROMPT_LINE_MIGRATIONS[0];
        const custom = `The keeper routes every agent through the lighthouse relay.\n${legacy} Ask before touching it.`;
        extensionSettings.orchestrator = { requestSystemPrompt: custom };
        main.ensureSettings();
        expect(extensionSettings.orchestrator.requestSystemPrompt).toBe(custom);
    });
});
