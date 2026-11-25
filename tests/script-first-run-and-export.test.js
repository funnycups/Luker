// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, afterAll, beforeEach, afterEach, jest } from '@jest/globals';

const noop = () => {};
const asyncNoop = async () => {};
class StubClass {}

function stubExports(names, overrides = {}) {
    const out = { ...overrides };
    for (const name of names) {
        if (!(name in out)) out[name] = noop;
    }
    return out;
}

let callGenericPopupImpl = async () => 'Tester';
let confirmCharacterSkillsExportImpl = async () => false;
let validateDisabledSamplersImpl = asyncNoop;
let koboldStreamingImpl = async () => async function* () {};
const metaListeners = new WeakMap();
const mockOnLukerResponseMeta = jest.fn((response, listener) => {
    if (!metaListeners.has(response)) metaListeners.set(response, new Set());
    const set = metaListeners.get(response);
    set.add(listener);
    return () => { set.delete(listener); };
});

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => stubExports([
    'humanizedDateTime', 'favsToHotswap', 'getMessageTimeStamp', 'dragElement',
    'isMobile', 'initNavPanelPins', 'initRossMods', 'initSendTextareaState',
]));
jest.unstable_mockModule('../public/scripts/stats.js', () => stubExports(['userStatsHandler', 'statMesProcess', 'initStats']));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => stubExports([
    'hydrateKoboldPresetData', 'loadKoboldSettings',
    'getKoboldGenerationData', 'initKoboldSettings',
], {
    generateKoboldWithStreaming: (...args) => koboldStreamingImpl(...args),
    kai_settings: {},
    kai_flags: {},
    koboldai_settings: {},
    koboldai_setting_names: {},
}));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => stubExports([
    'hydrateTextGenPresetData', 'loadTextGenSettings', 'generateTextGenWithStreaming',
    'getTextGenGenerationData', 'parseTextgenLogprobs', 'parseTabbyLogprobs', 'initTextGenSettings',
], { textgenerationwebui_settings: {}, textgenerationwebui_presets: [], textgenerationwebui_preset_names: [], textgen_types: {} }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => stubExports([
    'getWorldInfoPrompt', 'setWorldInfoSettings', 'importEmbeddedWorldInfo',
    'checkEmbeddedWorld', 'setWorldInfoButtonClass', 'initWorldInfo',
    'charUpdatePrimaryWorld', 'charSetAuxWorlds', 'deleteWorldInfoWithUndo',
], {
    world_info: {},
    world_names: [],
    wi_anchor_position: {},
    world_info_include_names: {},
    getWorldInfoSettings: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => stubExports([
    'saveGroupChat', 'getGroups', 'primeGroupsSnapshot', 'generateGroupWrapper',
    'resetSelectedGroup', 'select_group_chats', 'regenerateGroup', 'getGroupChat',
    'loadGroupChat', 'renameGroupMember', 'createNewGroupChat', 'editGroup',
    'getGroupAvatar', 'deleteGroupChat', 'renameGroupChat', 'importGroupChat',
    'getGroupBlock', 'getGroupCharacterCardsLazy', 'getGroupDepthPrompts',
], { groups: [], selected_group: null, is_group_generating: false, group_generation_id: null }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => stubExports([
    'collapseNewlines', 'loadPowerUserSettings', 'playMessageSound', 'fixMarkdown',
    'loadMovingUIState', 'getCustomStoppingStrings', 'renderStoryString',
    'sortEntitiesList', 'registerDebugFunction', 'flushEphemeralStoppingStrings',
    'resetMovableStyles', 'forceCharacterEditorTokenize', 'applyPowerUserSettings',
    'generatedTextFiltered', 'applyStylePins', 'notifyMessageComplete',
    'notifyMessageFailure', 'notifyMessageProgressStart', 'clearMessageProgressNotification',
], {
    power_user: { personas: {}, persona_descriptions: {} },
    persona_description_positions: { IN_PROMPT: 0 },
    MAX_CONTEXT_DEFAULT: 4096,
    MAX_RESPONSE_DEFAULT: 300,
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => stubExports([
    'setOpenAIMessageExamples', 'setOpenAIMessages', 'setupChatCompletionPromptManager',
    'prepareOpenAIMessages', 'sendOpenAIRequest', 'isLastOpenAIReplyPersistedByServer',
    'getLastOpenAIGenerationId', 'hydrateOpenAIPresetData', 'loadOpenAISettings',
    'getChatCompletionModel', 'loadProxyPresets', 'bindCurrentChatCompletionPresetToCharacter',
    'clearCharacterBoundChatCompletionPreset', 'maybeApplyCharacterBoundPreset', 'initOpenAI',
    'captureCharacterBoundSettingsSave',
], {
    oai_settings: {},
    openai_settings: [],
    openai_setting_names: {},
    openai_messages_count: 0,
    chat_completion_sources: {},
    proxies: [],
    selected_proxy: '',
}));
jest.unstable_mockModule('../public/scripts/character/manage-bound-presets-dialog.js', () => ({ openManageBoundPresetsDialog: noop }));
jest.unstable_mockModule('../public/scripts/character/card-binding-preservation.js', () => ({ handlePostReplaceBindings: noop }));
jest.unstable_mockModule('../public/scripts/character/post-replace-actions.js', () => ({ handlePostReplaceWorldBook: noop }));
jest.unstable_mockModule('../public/scripts/character/resource-read.js', () => ({
    invalidateCharacterResource: noop,
    loadCharacterResource: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/nai-settings.js', () => stubExports([
    'generateNovelWithStreaming', 'getNovelGenerationData', 'getKayraMaxContextTokens',
    'hydrateNovelPresetData', 'loadNovelSettings', 'adjustNovelInstructionPrompt',
    'parseNovelAILogprobs', 'initNovelAISettings',
], { nai_settings: {}, novelai_settings: {}, novelai_setting_names: {} }));
jest.unstable_mockModule('../public/scripts/bookmarks.js', () => stubExports(['initBookmarks', 'showBookmarksButtons', 'updateBookmarkDisplay']));
jest.unstable_mockModule('../public/scripts/horde.js', () => stubExports([
    'loadHordeSettings', 'generateHorde', 'getStatusHorde', 'getHordeModels',
    'adjustHordeGenerationParams', 'isHordeGenerationNotAllowed', 'initHorde',
], { horde_settings: {}, MIN_LENGTH: 1 }));
jest.unstable_mockModule('../public/scripts/utils.js', () => stubExports([
    'cancelDebounce', 'delay', 'trimToEndSentence', 'countOccurrences',
    'isOdd', 'sortMoments', 'timestampToMoment', 'isDataURL', 'getCharaFilename',
    'waitUntilCondition', 'escapeRegex', 'resetScrollHeight', 'onlyUnique',
    'getBase64Async', 'humanFileSize', 'isValidUrl', 'ensureImageFormatSupported',
    'flashHighlight', 'toggleDrawer', 'isElementInViewport', 'copyText', 'escapeHtml',
    'saveBase64AsFile', 'equalsIgnoreCaseAndAccents', 'findCanonicalNameInList',
    'localizePagination', 'renderPaginationDropdown', 'paginationDropdownChangeHandler',
    'importFromExternalUrl', 'shiftUpByOne', 'shiftDownByOne', 'canUseNegativeLookbehind',
    'trimSpaces', 'clamp', 'shakeElement', 'createTimeout',
], {
    debounce: () => {
        const fn = () => {};
        fn.cancel = noop;
        return fn;
    },
    PAGINATION_TEMPLATE: '',
    Stopwatch: StubClass,
    uuidv4: (() => { let n = 0; return () => `gen-${++n}`; })(),
}));
jest.unstable_mockModule('../public/scripts/luker-download.js', () => ({ downloadFromServer: asyncNoop }));
jest.unstable_mockModule('../public/scripts/extensions.js', () => stubExports([
    'bootstrapExtensions', 'cancelDebouncedMetadataSave', 'doDailyExtensionUpdatesCheck',
    'initExtensions', 'primeExtensionSettings', 'runGenerationInterceptors', 'saveMetadataDebounced',
], { extension_settings: {} }));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => stubExports([
    'consumeEphemeralScriptInjectsForMainGeneration', 'executeSlashCommandsOnChatInput',
    'initDefaultSlashCommands', 'initSlashCommandAutoComplete', 'isExecutingCommandsFromChatInput',
    'pauseScriptExecution', 'processChatSlashCommands', 'stopScriptExecution',
], { COMMENT_NAME_DEFAULT: '', CONNECT_API_MAP: {}, UNIQUE_APIS: {} }));
jest.unstable_mockModule('../public/scripts/tags.js', () => stubExports([
    'filterByTagState', 'isBogusFolder', 'isBogusFolderOpen', 'chooseBogusFolder',
    'getTagBlock', 'loadTagsSettings', 'printTagFilters', 'getTagKeyForEntity',
    'printTagList', 'createTagMapFromList', 'renameTagKey', 'importTags',
    'compareTagsForSort', 'initTags', 'applyTagsOnCharacterSelect',
    'applyTagsOnGroupSelect', 'applyCharacterTagsToMessageDivs',
], { tag_map: {}, tags: [], tag_filter_type: {}, tag_import_setting: {} }));
jest.unstable_mockModule('../public/scripts/secrets.js', () => stubExports([
    'checkOpenRouterAuth', 'initSecrets', 'primeSecretStateSnapshot', 'readSecretState',
]));
jest.unstable_mockModule('../public/scripts/showdown-exclusion.js', () => ({ markdownExclusionExt: {} }));
jest.unstable_mockModule('../public/scripts/showdown-underscore.js', () => ({ markdownUnderscoreExt: {} }));
jest.unstable_mockModule('../public/scripts/authors-note.js', () => stubExports([
    'initAuthorsNote', 'setFloatingPrompt', 'shouldWIAddPrompt',
], { NOTE_MODULE_NAME: '', metadata_keys: {} }));
jest.unstable_mockModule('../public/scripts/PromptManager.js', () => ({ registerPromptManagerMigration: noop }));
jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s) => s,
    regex_placement: {},
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/auto-continue-truncated.js', () => ({
    getAutoContinueOnTruncated: () => false,
    isTruncatedFinishReason: () => false,
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-retry.js', () => ({
    withProfileRetry: async (fn) => fn(),
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/request-timeout.js', () => ({ getRequestTimeoutMs: () => 0 }));
jest.unstable_mockModule('../public/scripts/logprobs.js', () => ({ initLogprobs: noop, saveLogprobsForActiveMessage: noop }));
jest.unstable_mockModule('../public/scripts/filters.js', () => ({ FILTER_STATES: {}, FILTER_TYPES: {}, FilterHelper: StubClass, isFilterState: () => false }));
jest.unstable_mockModule('../public/scripts/cfg-scale.js', () => ({ getCfgPrompt: () => '', getGuidanceScale: () => 1, initCfg: noop }));
jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => stubExports([
    'formatInstructModeChat', 'formatInstructModePrompt', 'formatInstructModeExamples',
    'formatInstructModeStoryString', 'getInstructStoppingSequences',
], { force_output_sequence: {} }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    initLocales: asyncNoop,
    addLocaleData: noop,
    getCurrentLocale: () => 'en',
    translate: (s) => String(s ?? ''),
    createScopedI18n: () => ({ i18n: (s) => String(s ?? ''), i18nFormat: (s) => String(s ?? '') }),
    t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => stubExports([
    'getFriendlyTokenizerName', 'getTokenCount', 'getTokenCountAsync',
    'initTokenizers', 'saveTokenCacheDebounced', 'flushTokenCacheSave',
]));
jest.unstable_mockModule('../public/scripts/last-usage.js', () => ({ consumeLastUsage: noop }));
jest.unstable_mockModule('../public/scripts/personas.js', () => stubExports([
    'getUserAvatars', 'getUserAvatar', 'setUserAvatar', 'primeUserAvatarsSnapshot',
    'initPersonas', 'setPersonaDescription', 'initUserAvatar', 'updatePersonaConnectionsAvatarList',
    'isPersonaPanelOpen',
], { user_avatar: 'default.png' }));
jest.unstable_mockModule('../public/scripts/backgrounds.js', () => ({ initBackgrounds: noop, loadBackgroundSettings: noop, background_settings: {} }));
jest.unstable_mockModule('../public/scripts/loader.js', () => ({ hideLoader: asyncNoop, isLoaderVisible: () => false, showLoader: noop }));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({ loader: {} }));
jest.unstable_mockModule('../public/scripts/BulkEditOverlay.js', () => ({ BulkEditOverlay: StubClass }));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({ initTextGenModels: noop, initTextGenModelSelects: noop }));
jest.unstable_mockModule('../public/scripts/chats.js', () => stubExports([
    'appendFileContent', 'hasPendingFileAttachment', 'populateFileAttachment', 'decodeStyleTags',
    'encodeStyleTags', 'hideChatMessageRange', 'isExternalMediaAllowed', 'preserveNeutralChat',
    'restoreNeutralChat', 'formatCreatorNotes', 'initChatUtilities', 'addDOMPurifyHooks',
]));
jest.unstable_mockModule('../public/scripts/chat-merge-split.js', () => ({ wireEntryPoints: noop }));
jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: () => null, initPresetManager: asyncNoop }));
jest.unstable_mockModule('../public/scripts/macros.js', () => ({ evaluateMacros: (s) => s, getLastMessageId: () => -1, initMacros: noop }));
jest.unstable_mockModule('../public/scripts/variable-op-log/index.js', () => ({ initVariableOpLog: noop, extractMessageById: noop, pushFloorVarOp: noop }));
jest.unstable_mockModule('../public/scripts/variable-op-log/extractor.js', () => ({ extractFromText: noop }));
jest.unstable_mockModule('../public/scripts/variable-op-log/panel.js', () => ({ initVarOpsPanelHandler: noop }));
jest.unstable_mockModule('../public/scripts/media-deletion-dialog.js', () => stubExports([
    'fetchMediaDeletionCandidates', 'deleteMediaFiles', 'promptMediaDeletion', 'notifyMediaDeleteResult',
]));
jest.unstable_mockModule('../public/scripts/frontend-log-manager.js', () => ({
    installFrontendLogCapture: noop,
    setFrontendConsoleDebugLoggingEnabled: noop,
}));
jest.unstable_mockModule('../public/scripts/debug-export.js', () => ({ initDebugExportButton: noop }));
jest.unstable_mockModule('../public/scripts/debug-menu-capture.js', () => ({ initDebugMenuCapture: noop }));
jest.unstable_mockModule('../public/scripts/luker-android-debug-trail.js', () => ({ initAndroidDebugTrail: noop }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({
    currentUser: null,
    getConfigValidationMessage: () => '',
    isAdmin: () => false,
    setUserControls: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/sync-status.js', () => ({}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: { INPUT: 3 },
    Popup: StubClass,
    callGenericPopup: (...args) => callGenericPopupImpl(...args),
    fixToastrForDialogs: noop,
}));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplate: () => '', renderTemplateAsync: asyncNoop }));
jest.unstable_mockModule('../public/scripts/scrapers.js', () => ({ initScrapers: noop }));
jest.unstable_mockModule('../public/scripts/samplerSelect.js', () => ({
    initCustomSelectedSamplers: noop,
    validateDisabledSamplers: (...args) => validateDisabledSamplersImpl(...args),
}));
jest.unstable_mockModule('../public/scripts/dragdrop.js', () => ({ DragAndDropHandler: StubClass }));
jest.unstable_mockModule('../public/scripts/keyboard.js', () => ({ INTERACTABLE_CONTROL_CLASS: '', initKeyboard: noop }));
jest.unstable_mockModule('../public/scripts/dynamic-styles.js', () => ({ initDynamicStyles: noop }));
jest.unstable_mockModule('../public/scripts/input-md-formatting.js', () => ({ initInputMarkdown: noop }));
jest.unstable_mockModule('../public/scripts/sysprompt.js', () => ({ initSystemPrompts: noop }));
jest.unstable_mockModule('../public/scripts/extensions-slashcommands.js', () => ({ registerExtensionSlashCommands: noop }));
jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({ ToolManager: {} }));
jest.unstable_mockModule('../public/scripts/tool-invocation-hide.js', () => ({ classifyInvocationSummary: noop, getOpenToolTaskTailStart: () => 0 }));
jest.unstable_mockModule('../public/scripts/skills/embed-lifecycle.js', () => ({ registerSkillEmbedLifecycle: noop }));
jest.unstable_mockModule('../public/scripts/skills/embed-export-hook.js', () => ({
    confirmCharacterSkillsExport: (...args) => confirmCharacterSkillsExportImpl(...args),
}));
jest.unstable_mockModule('../public/scripts/util/showdown-patch.js', () => ({ addShowdownPatch: noop }));
jest.unstable_mockModule('../public/scripts/browser-fixes.js', () => ({ applyBrowserFixes: noop }));
jest.unstable_mockModule('../public/scripts/server-history.js', () => ({ initServerHistory: noop }));
jest.unstable_mockModule('../public/scripts/setting-search.js', () => ({ initSettingsSearch: noop }));
jest.unstable_mockModule('../public/scripts/bulk-edit.js', () => ({ initBulkEdit: noop }));
jest.unstable_mockModule('../public/scripts/st-context.js', () => ({ getContext: () => ({}) }));
jest.unstable_mockModule('../public/scripts/lukerContext.js', () => ({}));
jest.unstable_mockModule('../public/scripts/reasoning.js', () => stubExports([
    'extractReasoningBlocksFromData', 'extractReasoningDetailsFromData', 'extractReasoningFromData',
    'extractReasoningSignatureFromData', 'initReasoning', 'parseReasoningInSwipes', 'PromptReasoning',
    'registerReasoningSlashCommands', 'removeReasoningFromString', 'updateReasoningUI',
], {
    extractNativeTurnFromData: () => ({ nativeParts: null, nativeContentBlocks: null, responsesOutputItems: null }),
    ReasoningHandler: StubClass,
    ReasoningType: {},
}));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getState: () => ({}), init: noop },
}));
jest.unstable_mockModule('../public/scripts/welcome-screen.js', () => stubExports([
    'fetchRecentChatsSnapshot', 'initWelcomeScreen', 'openPermanentAssistantChat',
    'openPermanentAssistantCard', 'getPermanentAssistantAvatar', 'openWelcomeScreen',
    'primeRecentChatsSnapshotPromise',
]));
jest.unstable_mockModule('../public/scripts/data-maid.js', () => ({ initDataMaid: noop }));
jest.unstable_mockModule('../public/scripts/itemized-prompts.js', () => stubExports([
    'clearItemizedPrompts', 'deleteItemizedPromptForMessage', 'deleteItemizedPrompts',
    'findItemizedPromptSet', 'flushItemizedPromptsSave', 'initItemizedPrompts', 'loadItemizedPrompts',
    'promptItemize', 'replaceItemizedPromptText', 'saveItemizedPrompts',
    'saveItemizedPromptsDebounced', 'swapItemizedPrompts',
], { itemizedParams: {}, itemizedPrompts: [] }));
jest.unstable_mockModule('../public/scripts/system-messages.js', () => stubExports([
    'getSystemMessageByType', 'initSystemMessages', 'sendSystemMessage',
], { SAFETY_CHAT: '', system_message_types: {}, system_messages: {} }));
jest.unstable_mockModule('../public/scripts/announcements.js', () => ({ initAnnouncements: noop, whenCriticalAnnouncementsDone: asyncNoop }));
jest.unstable_mockModule('../public/scripts/floor-state.js', () => stubExports([
    'settleChatChanged', 'settleMessageDeleted', 'settleMessageSwipeDeleted', 'settleMessageSwiped',
]));
jest.unstable_mockModule('../public/scripts/a11y.js', () => ({ initAccessibility: noop }));
jest.unstable_mockModule('../public/scripts/util/stream-fadein.js', () => ({ applyStreamFadeIn: noop }));
jest.unstable_mockModule('../public/scripts/dom-handlers.js', () => ({ initDomHandlers: noop }));
jest.unstable_mockModule('../public/scripts/audio-player.js', () => ({ AudioPlayer: StubClass }));
jest.unstable_mockModule('../public/scripts/macros/engine/MacroEnvBuilder.js', () => ({ MacroEnvBuilder: StubClass }));
jest.unstable_mockModule('../public/scripts/message-formatter.js', () => ({ MessageFormatter: StubClass }));
jest.unstable_mockModule('../public/scripts/macros/engine/MacroEngine.js', () => ({ MacroEngine: StubClass }));
jest.unstable_mockModule('../public/scripts/chat-backups.js', () => ({ addChatBackupsBrowser: noop }));
jest.unstable_mockModule('../public/scripts/macros/engine/MacroDiagnostics.js', () => ({ onboardingExperimentalMacroEngine: noop }));
jest.unstable_mockModule('../public/scripts/undo-toast.js', () => ({ showUndoToast: noop }));
jest.unstable_mockModule('../public/scripts/request-compression.js', () => ({ setRequestCompressionConfig: noop }));
jest.unstable_mockModule('../public/scripts/swipe-picker.js', () => ({
    canJumpToSwipeForMessage: () => false,
    canOpenSwipePickerForMessage: () => false,
    initSwipePicker: noop,
}));
jest.unstable_mockModule('../public/scripts/self-profiler.js', () => ({ bootSelfProfilerFromStorage: noop }));
jest.unstable_mockModule('../public/scripts/ws-delivery.js', () => ({
    createLukerDelivery: noop,
    getLukerResponseMeta: () => null,
    installFetchProxy: noop,
    installFetchProxyForAllIframes: noop,
    installLifecycleHooks: noop,
    onLukerResponseMeta: mockOnLukerResponseMeta,
}));
jest.unstable_mockModule('../public/scripts/settings-resource-read.js', () => ({ loadSettingsEnvelope: asyncNoop }));
jest.unstable_mockModule('../public/scripts/named-resource-read.js', () => ({
    listPresetDocuments: async () => [],
    loadPresetResources: async () => ({}),
    readPresetDocument: async () => null,
}));
jest.unstable_mockModule('../public/scripts/workbench/index.js', () => ({ initWorkbench: noop }));

globalThis.document = {
    readyState: 'complete',
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: { style: { setProperty: noop } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.window = Object.assign(globalThis, {
    addEventListener: noop,
    removeEventListener: noop,
});
globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn(), subscribe: noop, options: {} };
const jqValues = new Map();
const jqueryEnv = (() => {
    const readyCallbacks = [];
    function jQuery(target) {
        if (typeof target === 'function') {
            readyCallbacks.push(target);
            return undefined;
        }
        const key = typeof target === 'string' ? target : null;
        const selection = {
            length: 0,
            off() { return selection; },
            on() { return selection; },
            css() { return selection; },
            clone() { return selection; },
            find() { return selection; },
            prop() { return selection; },
            val(v) {
                if (arguments.length === 0) return key ? (jqValues.get(key) ?? '') : '';
                if (key) jqValues.set(key, v);
                return selection;
            },
            text() { return selection; },
            attr() { return selection; },
            addClass() { return selection; },
            removeClass() { return selection; },
            toggleClass() { return selection; },
            show() { return selection; },
            hide() { return selection; },
            toggle() { return selection; },
            empty() { return selection; },
            append() { return selection; },
            html() { return selection; },
            trigger() { return selection; },
            closest() { return selection; },
            parent() { return selection; },
            children() { return selection; },
            each() { return selection; },
            is() { return false; },
            data() { return undefined; },
        };
        return selection;
    }
    jQuery.escapeSelector = (value) => String(value ?? '');
    jQuery.ajaxPrefilter = noop;
    const prevJQuery = globalThis.jQuery;
    const prevDollar = globalThis.$;
    globalThis.jQuery = jQuery;
    globalThis.$ = jQuery;
    return {
        readyCallbacks,
        restore() {
            globalThis.jQuery = prevJQuery;
            globalThis.$ = prevDollar;
        },
    };
})();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: noop, removeItem: noop },
});

const scriptMod = await import('../public/script.js');
const { getSettings, saveSettings, eventSource, event_types } = scriptMod;
const toastrStub = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn(), subscribe: noop, options: {} };
globalThis.toastr = toastrStub;

afterAll(() => {
    jqueryEnv.restore();
});

describe('script.js firstRun onboarding persistence rollback guards', () => {
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        validateDisabledSamplersImpl = asyncNoop;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.toastr.error.mockClear();
        globalThis.toastr.warning.mockClear();
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        validateDisabledSamplersImpl = asyncNoop;
        jest.restoreAllMocks();
    });

    test('does NOT reset firstRun=true when saveSettings returns status: deferred (not_ready)', async () => {
        // Hold getSettings before `settingsReady = true` so onboarding's saveSettings
        // deterministically returns `{ ok: false, status: 'deferred', reason: 'not_ready' }`
        callGenericPopupImpl = async () => 'Alice';
        let releaseBoot;
        const bootGate = new Promise((res) => { releaseBoot = res; });
        validateDisabledSamplersImpl = async () => { await bootGate; };

        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));

        const bootPromise = getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: true, main_api: 'openai' }),
            },
        });
        // Give doOnboarding().then(saveSettings) time to run while settingsReady is still false
        await new Promise(r => setTimeout(r, 15));
        releaseBoot();
        await bootPromise;
        await new Promise(r => setTimeout(r, 10));

        // Now saveSettings runs after settingsReady=true -> must persist firstRun: false (NOT rolled back to true!)
        const outcome = await saveSettings(0, { directSave: true });
        expect(outcome.ok).toBe(true);
        expect(outcome.payload.firstRun).toBe(false);
    });

    test('does NOT reset firstRun=true when a post-save SETTINGS_UPDATED listener throws', async () => {
        let releaseOnboarding;
        callGenericPopupImpl = () => new Promise((res) => { releaseOnboarding = res; });

        const throwingListener = jest.fn(() => {
            throw new Error('listener exploded after save');
        });

        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));

        await getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: true, main_api: 'openai' }),
            },
        });

        eventSource.on(event_types.SETTINGS_UPDATED, throwingListener);
        try {
            releaseOnboarding('Alice');
            await new Promise(r => setTimeout(r, 20));
        } finally {
            eventSource.removeListener(event_types.SETTINGS_UPDATED, throwingListener);
        }

        expect(throwingListener).toHaveBeenCalled();
        const followUp = await saveSettings(0, { directSave: true });
        expect(followUp.ok).toBe(true);
        expect(followUp.payload.firstRun).toBe(false);
    });

    test('DOES reset firstRun=true when /api/settings/save actually fails', async () => {
        let releaseOnboarding;
        callGenericPopupImpl = () => new Promise((res) => { releaseOnboarding = res; });

        const failedSaveBodies = [];
        globalThis.fetch = jest.fn(async (url, init) => {
            if (url === '/api/settings/save') failedSaveBodies.push(JSON.parse(init.body));
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => ({}),
            };
        });

        await getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: true, main_api: 'openai' }),
            },
        });

        releaseOnboarding('Alice');
        await new Promise(r => setTimeout(r, 20));
        expect(failedSaveBodies).toHaveLength(1);
        expect(failedSaveBodies[0].firstRun).toBe(false);

        // Switch fetch back to ok and verify firstRun was rolled back to true
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));
        const followUp = await saveSettings(0, { directSave: true });
        expect(followUp.ok).toBe(true);
        expect(followUp.payload.firstRun).toBe(true);
    });
});

describe('script.js sendGenerationRequest onLukerResponseMeta guards & disposal', () => {
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        mockOnLukerResponseMeta.mockClear();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    test('disposes listener after response finishes and ignores stale generationId or mismatched live main_api', async () => {
        const { sendGenerationRequest, getLastLukerGenerationIdForApi } = scriptMod;
        await getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: false, main_api: 'kobold' }),
            },
        });

        let releaseJson1;
        const jsonGate1 = new Promise((res) => { releaseJson1 = res; });
        const resp1 = {
            ok: true,
            status: 200,
            headers: { get: (k) => (String(k).toLowerCase() === 'x-luker-generation-id' ? 'gen-1' : null) },
            json: async () => {
                await jsonGate1;
                return { results: [{ text: 'first' }] };
            },
        };
        globalThis.fetch = jest.fn(async () => resp1);

        const req1 = sendGenerationRequest('normal', { prompt: 'hello' }, {}, new AbortController().signal);
        await new Promise(r => setTimeout(r, 0));

        expect(metaListeners.get(resp1)?.size).toBe(1);
        expect(getLastLukerGenerationIdForApi('kobold')).toBe('gen-1');

        // Stale mismatched generation_id on resp1 must be ignored
        for (const fn of [...metaListeners.get(resp1)]) {
            fn({ generation_id: 'gen-stale', persisted: true });
        }
        expect(getLastLukerGenerationIdForApi('kobold')).toBe('gen-1');

        // Switching live main_api to openai makes resp1's listener ignore subsequent meta
        await getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: false, main_api: 'openai' }),
            },
        });
        for (const fn of [...metaListeners.get(resp1)]) {
            fn({ generation_id: 'gen-after-switch', persisted: true });
        }
        expect(getLastLukerGenerationIdForApi('kobold')).toBe('gen-1');

        // Finishing response.json() disposes the onLukerResponseMeta listener in finally
        releaseJson1();
        await req1;
        expect(metaListeners.get(resp1)?.size).toBe(0);
    });

    test('starting a second generation disposes the first listener and invalidates its epoch', async () => {
        const { sendGenerationRequest, getLastLukerGenerationIdForApi } = scriptMod;
        await getSettings({
            payload: {
                settings: JSON.stringify({ firstRun: false, main_api: 'kobold' }),
            },
        });

        let releaseJson1;
        const jsonGate1 = new Promise((res) => { releaseJson1 = res; });
        const resp1 = {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => {
                await jsonGate1;
                return { results: [{ text: 'first' }] };
            },
        };
        const resp2 = {
            ok: true,
            status: 200,
            headers: { get: (k) => (String(k).toLowerCase() === 'x-luker-generation-id' ? 'gen-2' : null) },
            json: async () => ({ results: [{ text: 'second' }] }),
        };

        let call = 0;
        globalThis.fetch = jest.fn(async () => (++call === 1 ? resp1 : resp2));

        const req1 = sendGenerationRequest('normal', { prompt: 'first' }, {}, new AbortController().signal);
        await new Promise(r => setTimeout(r, 0));
        expect(metaListeners.get(resp1)?.size).toBe(1);
        const listener1 = [...metaListeners.get(resp1)][0];

        // Second generation starts and completes -> disposes listener1 and advances epoch
        await sendGenerationRequest('normal', { prompt: 'second' }, {}, new AbortController().signal);
        expect(metaListeners.get(resp1)?.size).toBe(0);
        expect(metaListeners.get(resp2)?.size).toBe(0);
        expect(getLastLukerGenerationIdForApi('kobold')).toBe('gen-2');

        // Even if listener1 is invoked late directly, stale epoch guard drops it
        listener1({ generation_id: 'gen-1-late', persisted: false });
        expect(getLastLukerGenerationIdForApi('kobold')).toBe('gen-2');

        releaseJson1();
        await req1;
    });
});
