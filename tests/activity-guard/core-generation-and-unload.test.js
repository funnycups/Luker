import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import {
    acquireActivityLease,
    cancelChatSwitchActivities,
    getActiveActivities,
    hasActiveSource,
    hasChatSwitchGuard,
    hasUnloadGuard,
} from '../../public/scripts/activity-guard.js';

const noop = () => {};
const asyncNoop = async () => {};

function stubExports(names, overrides = {}) {
    const out = { ...overrides };
    for (const name of names) {
        if (!(name in out)) out[name] = noop;
    }
    return out;
}

class StubClass {}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let scriptMod;
let Generate;
let shouldWarnBeforeUnload;
let handleBeforeUnload;
let confirmChatSwitchGuard;
let getChatTransitionEpoch;
let bumpChatTransitionEpoch;
let selectCharacterById;
let openCharacterChat;
let doNewChat;
let closeCurrentChat;
let newAssistantChat;
let setCharacterId;
let characters;
let eventSource;
let event_types;
let setEditedMessageId;
let setSendButtonState;
let setOnlineStatus;
let saveChatDebounced;
let saveChatConditional;

let executeSlashCommandsMock;
let flushTokenCacheSaveMock;
let flushItemizedPromptsSaveMock;
let popupConfirmMock;
let sendOpenAIRequestMock;
let prepareOpenAIMessagesMock;
let notifyMessageFailureMock;
let getTokenCountAsyncMock;
let mockAutoContinueTruncated = false;
let mockCanPerformToolCalls = false;
let mockPowerUser;
let mockOaiSettings;
let fetchMock;
let sendTextareaVal = '';
const mockGroupState = { is_group_generating: false };

beforeAll(async () => {
    executeSlashCommandsMock = jest.fn(async () => {});
    flushTokenCacheSaveMock = jest.fn();
    flushItemizedPromptsSaveMock = jest.fn();
    popupConfirmMock = jest.fn(async () => 1);
    sendOpenAIRequestMock = jest.fn(async () => ({ choices: [{ message: { content: 'ok' } }] }));
    prepareOpenAIMessagesMock = jest.fn(async () => [[], []]);
    notifyMessageFailureMock = jest.fn();
    getTokenCountAsyncMock = jest.fn(async () => 0);
    mockPowerUser = {
        instruct: { enabled: false },
        context: { names_as_stop_strings: false },
        sysprompt: { enabled: false },
        reasoning: { prefix: '', suffix: '' },
        auto_continue: { enabled: false },
        message_token_count_enabled: false,
    };
    mockOaiSettings = { stream_openai: false, send_if_empty: '' };
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

    jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => stubExports([
        'humanizedDateTime', 'favsToHotswap', 'getMessageTimeStamp', 'dragElement',
        'isMobile', 'initNavPanelPins', 'initRossMods', 'initSendTextareaState',
    ]));
    jest.unstable_mockModule('../../public/scripts/stats.js', () => stubExports(['userStatsHandler', 'statMesProcess', 'initStats']));
    jest.unstable_mockModule('../../public/scripts/kai-settings.js', () => stubExports([
        'generateKoboldWithStreaming', 'hydrateKoboldPresetData', 'loadKoboldSettings',
        'getKoboldGenerationData', 'initKoboldSettings',
    ], { kai_settings: {}, kai_flags: {}, koboldai_settings: {}, koboldai_setting_names: {} }));
    jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => stubExports([
        'hydrateTextGenPresetData', 'loadTextGenSettings', 'generateTextGenWithStreaming',
        'getTextGenGenerationData', 'parseTextgenLogprobs', 'parseTabbyLogprobs', 'initTextGenSettings',
    ], { textgenerationwebui_settings: {}, textgenerationwebui_presets: [], textgenerationwebui_preset_names: [], textgen_types: {} }));
    jest.unstable_mockModule('../../public/scripts/world-info.js', () => stubExports([
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
    jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
        ...stubExports([
            'saveGroupChat', 'getGroups', 'primeGroupsSnapshot', 'generateGroupWrapper',
            'resetSelectedGroup', 'select_group_chats', 'regenerateGroup', 'getGroupChat',
            'loadGroupChat', 'renameGroupMember', 'createNewGroupChat', 'editGroup',
            'getGroupAvatar', 'deleteGroupChat', 'renameGroupChat', 'importGroupChat',
            'getGroupBlock', 'getGroupCharacterCardsLazy', 'getGroupDepthPrompts',
        ], { groups: [], selected_group: null, group_generation_id: null }),
        get is_group_generating() {
            return mockGroupState.is_group_generating;
        },
    }));
    jest.unstable_mockModule('../../public/scripts/power-user.js', () => stubExports([
        'collapseNewlines', 'loadPowerUserSettings', 'playMessageSound', 'fixMarkdown',
        'loadMovingUIState', 'renderStoryString',
        'sortEntitiesList', 'registerDebugFunction', 'flushEphemeralStoppingStrings',
        'resetMovableStyles', 'forceCharacterEditorTokenize', 'applyPowerUserSettings',
        'generatedTextFiltered', 'applyStylePins', 'notifyMessageComplete',
        'notifyMessageFailure', 'notifyMessageProgressStart', 'clearMessageProgressNotification',
    ], {
        notifyMessageFailure: (...args) => notifyMessageFailureMock(...args),
        getCustomStoppingStrings: () => [],
        power_user: mockPowerUser,
        persona_description_positions: {},
        MAX_CONTEXT_DEFAULT: 4096,
        MAX_RESPONSE_DEFAULT: 300,
    }));
    jest.unstable_mockModule('../../public/scripts/openai.js', () => stubExports([
        'setupChatCompletionPromptManager',
        'isLastOpenAIReplyPersistedByServer',
        'getLastOpenAIGenerationId', 'hydrateOpenAIPresetData', 'loadOpenAISettings',
        'getChatCompletionModel', 'loadProxyPresets', 'bindCurrentChatCompletionPresetToCharacter',
        'clearCharacterBoundChatCompletionPreset', 'maybeApplyCharacterBoundPreset', 'captureCharacterBoundSettingsSave', 'initOpenAI',
    ], {
        setOpenAIMessageExamples: () => [],
        setOpenAIMessages: () => [],
        prepareOpenAIMessages: (...args) => prepareOpenAIMessagesMock(...args),
        sendOpenAIRequest: (...args) => sendOpenAIRequestMock(...args),
        oai_settings: mockOaiSettings,
        openai_settings: [],
        openai_setting_names: {},
        openai_messages_count: 0,
        chat_completion_sources: {},
        proxies: [],
        selected_proxy: '',
    }));
    jest.unstable_mockModule('../../public/scripts/character/manage-bound-presets-dialog.js', () => ({ openManageBoundPresetsDialog: noop }));
    jest.unstable_mockModule('../../public/scripts/character/card-binding-preservation.js', () => ({ handlePostReplaceBindings: noop }));
    jest.unstable_mockModule('../../public/scripts/character/post-replace-actions.js', () => ({ handlePostReplaceWorldBook: noop }));
    jest.unstable_mockModule('../../public/scripts/character/resource-read.js', () => ({
        invalidateCharacterResource: noop,
        loadCharacterResource: asyncNoop,
    }));
    jest.unstable_mockModule('../../public/scripts/nai-settings.js', () => stubExports([
        'generateNovelWithStreaming', 'getNovelGenerationData', 'getKayraMaxContextTokens',
        'hydrateNovelPresetData', 'loadNovelSettings', 'adjustNovelInstructionPrompt',
        'parseNovelAILogprobs', 'initNovelAISettings',
    ], { nai_settings: {}, novelai_settings: {}, novelai_setting_names: {} }));
    jest.unstable_mockModule('../../public/scripts/bookmarks.js', () => stubExports(['initBookmarks', 'showBookmarksButtons', 'updateBookmarkDisplay']));
    jest.unstable_mockModule('../../public/scripts/horde.js', () => stubExports([
        'loadHordeSettings', 'generateHorde', 'getStatusHorde', 'getHordeModels',
        'adjustHordeGenerationParams', 'isHordeGenerationNotAllowed', 'initHorde',
    ], { horde_settings: {}, MIN_LENGTH: 1 }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => stubExports([
        'debounce', 'cancelDebounce', 'delay', 'trimToEndSentence', 'countOccurrences',
        'isOdd', 'sortMoments', 'timestampToMoment', 'isDataURL', 'getCharaFilename',
        'waitUntilCondition', 'escapeRegex', 'resetScrollHeight', 'onlyUnique',
        'getBase64Async', 'humanFileSize', 'isValidUrl', 'ensureImageFormatSupported',
        'flashHighlight', 'toggleDrawer', 'isElementInViewport', 'copyText', 'escapeHtml',
        'saveBase64AsFile', 'uuidv4', 'equalsIgnoreCaseAndAccents', 'findCanonicalNameInList',
        'localizePagination', 'renderPaginationDropdown', 'paginationDropdownChangeHandler',
        'importFromExternalUrl', 'shiftUpByOne', 'shiftDownByOne', 'canUseNegativeLookbehind',
        'trimSpaces', 'clamp', 'shakeElement', 'createTimeout',
    ], {
        PAGINATION_TEMPLATE: '',
        Stopwatch: class { async tick(fn) { return await fn(); } },
        debounce: () => () => {},
        timestampToMoment: () => ({
            isValid: () => false,
            format: () => '',
            toISOString: () => new Date(0).toISOString(),
        }),
        escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])),
    }));
    jest.unstable_mockModule('../../public/scripts/luker-download.js', () => ({ downloadFromServer: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/extensions.js', () => stubExports([
        'bootstrapExtensions', 'cancelDebouncedMetadataSave', 'doDailyExtensionUpdatesCheck',
        'initExtensions', 'primeExtensionSettings', 'runGenerationInterceptors', 'saveMetadataDebounced',
    ], { extension_settings: { note: { allowWIScan: false } } }));
    jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => stubExports([
        'consumeEphemeralScriptInjectsForMainGeneration', 'initDefaultSlashCommands',
        'initSlashCommandAutoComplete', 'isExecutingCommandsFromChatInput', 'pauseScriptExecution',
        'processChatSlashCommands', 'stopScriptExecution',
    ], {
        executeSlashCommandsOnChatInput: executeSlashCommandsMock,
        COMMENT_NAME_DEFAULT: '',
        CONNECT_API_MAP: {},
        UNIQUE_APIS: {},
    }));
    jest.unstable_mockModule('../../public/scripts/tags.js', () => stubExports([
        'isBogusFolder', 'isBogusFolderOpen', 'chooseBogusFolder',
        'getTagBlock', 'loadTagsSettings', 'printTagFilters', 'getTagKeyForEntity',
        'printTagList', 'createTagMapFromList', 'renameTagKey', 'importTags',
        'compareTagsForSort', 'initTags', 'applyTagsOnCharacterSelect',
        'applyTagsOnGroupSelect', 'applyCharacterTagsToMessageDivs',
    ], {
        filterByTagState: (entities) => entities || [],
        tag_map: {},
        tags: [],
        tag_filter_type: {},
        tag_import_setting: {},
    }));
    jest.unstable_mockModule('../../public/scripts/secrets.js', () => stubExports([
        'checkOpenRouterAuth', 'initSecrets', 'primeSecretStateSnapshot', 'readSecretState',
    ]));
    jest.unstable_mockModule('../../public/scripts/showdown-exclusion.js', () => ({ markdownExclusionExt: () => [] }));
    jest.unstable_mockModule('../../public/scripts/showdown-underscore.js', () => ({ markdownUnderscoreExt: () => [] }));
    jest.unstable_mockModule('../../public/scripts/authors-note.js', () => stubExports([
        'initAuthorsNote', 'setFloatingPrompt', 'shouldWIAddPrompt',
    ], { NOTE_MODULE_NAME: '', metadata_keys: {} }));
    jest.unstable_mockModule('../../public/scripts/PromptManager.js', () => ({ registerPromptManagerMigration: noop }));
    jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
        getRegexedString: (s) => s,
        regex_placement: {},
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/auto-continue-truncated.js', () => ({
        getAutoContinueOnTruncated: () => ({ enabled: mockAutoContinueTruncated, maxAttempts: 3 }),
        isTruncatedFinishReason: () => mockAutoContinueTruncated,
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-retry.js', () => ({ withProfileRetry: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/request-timeout.js', () => ({ getRequestTimeoutMs: () => 0 }));
    jest.unstable_mockModule('../../public/scripts/logprobs.js', () => ({ initLogprobs: noop, saveLogprobsForActiveMessage: noop }));
    jest.unstable_mockModule('../../public/scripts/filters.js', () => ({
        FILTER_STATES: {},
        FILTER_TYPES: {},
        FilterHelper: class {
            getFilterData() { return ''; }
            applyFilters(list) { return list; }
            setFilterData() {}
            clearFuzzySearchCaches() {}
        },
        isFilterState: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/cfg-scale.js', () => ({ getCfgPrompt: () => '', getGuidanceScale: () => 1, initCfg: noop }));
    jest.unstable_mockModule('../../public/scripts/instruct-mode.js', () => stubExports([
        'formatInstructModeChat', 'formatInstructModePrompt', 'formatInstructModeExamples',
        'formatInstructModeStoryString',
    ], { getInstructStoppingSequences: () => [], force_output_sequence: {} }));
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        getCurrentLocale: () => 'en',
        initLocales: asyncNoop,
        t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
        translate: (s) => String(s ?? ''),
    }));
    jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => stubExports([
        'getTokenCount',
        'initTokenizers', 'saveTokenCacheDebounced',
    ], {
        getTokenCountAsync: (...args) => getTokenCountAsyncMock(...args),
        getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }),
        flushTokenCacheSave: flushTokenCacheSaveMock,
    }));
    jest.unstable_mockModule('../../public/scripts/last-usage.js', () => ({ consumeLastUsage: noop }));
    jest.unstable_mockModule('../../public/scripts/personas.js', () => stubExports([
        'getUserAvatars', 'getUserAvatar', 'setUserAvatar', 'primeUserAvatarsSnapshot',
        'initPersonas', 'setPersonaDescription', 'initUserAvatar', 'updatePersonaConnectionsAvatarList',
        'isPersonaPanelOpen',
    ], { user_avatar: 'default.png' }));
    jest.unstable_mockModule('../../public/scripts/backgrounds.js', () => ({ initBackgrounds: noop, loadBackgroundSettings: noop, background_settings: {} }));
    jest.unstable_mockModule('../../public/scripts/loader.js', () => ({ hideLoader: asyncNoop, isLoaderVisible: () => false, showLoader: noop }));
    jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({ loader: {} }));
    jest.unstable_mockModule('../../public/scripts/BulkEditOverlay.js', () => ({ BulkEditOverlay: StubClass }));
    jest.unstable_mockModule('../../public/scripts/textgen-models.js', () => ({ initTextGenModels: noop, initTextGenModelSelects: noop }));
    jest.unstable_mockModule('../../public/scripts/chats.js', () => stubExports([
        'hasPendingFileAttachment', 'populateFileAttachment', 'decodeStyleTags',
        'encodeStyleTags', 'hideChatMessageRange', 'isExternalMediaAllowed', 'preserveNeutralChat',
        'restoreNeutralChat', 'formatCreatorNotes', 'initChatUtilities', 'addDOMPurifyHooks',
    ], {
        appendFileContent: async (_item, text) => text,
    }));
    jest.unstable_mockModule('../../public/scripts/chat-merge-split.js', () => ({ wireEntryPoints: noop }));
    jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({ getPresetManager: () => null, initPresetManager: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/macros.js', () => ({ evaluateMacros: (s) => s, getLastMessageId: () => -1, initMacros: noop }));
    jest.unstable_mockModule('../../public/scripts/variable-op-log/index.js', () => ({ initVariableOpLog: noop, extractMessageById: noop, pushFloorVarOp: noop }));
    jest.unstable_mockModule('../../public/scripts/variable-op-log/extractor.js', () => ({ extractFromText: noop }));
    jest.unstable_mockModule('../../public/scripts/variable-op-log/panel.js', () => ({ initVarOpsPanelHandler: noop }));
    jest.unstable_mockModule('../../public/scripts/media-deletion-dialog.js', () => stubExports([
        'fetchMediaDeletionCandidates', 'deleteMediaFiles', 'promptMediaDeletion', 'notifyMediaDeleteResult',
    ]));
    jest.unstable_mockModule('../../public/scripts/frontend-log-manager.js', () => ({
        installFrontendLogCapture: noop,
        setFrontendConsoleDebugLoggingEnabled: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/debug-export.js', () => ({ initDebugExportButton: noop }));
    jest.unstable_mockModule('../../public/scripts/debug-menu-capture.js', () => ({ initDebugMenuCapture: noop }));
    jest.unstable_mockModule('../../public/scripts/luker-android-debug-trail.js', () => ({ initAndroidDebugTrail: noop }));
    jest.unstable_mockModule('../../public/scripts/user.js', () => ({
        currentUser: null,
        getConfigValidationMessage: () => '',
        isAdmin: () => false,
        setUserControls: asyncNoop,
    }));
    jest.unstable_mockModule('../../public/scripts/sync-status.js', () => ({}));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => {
        class PopupStub extends StubClass {}
        PopupStub.show = { confirm: (...args) => popupConfirmMock(...args) };
        return {
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            POPUP_TYPE: {},
            Popup: PopupStub,
            callGenericPopup: asyncNoop,
            fixToastrForDialogs: noop,
        };
    });
    jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplate: () => '<div></div>', renderTemplateAsync: async () => '<div></div>' }));
    jest.unstable_mockModule('../../public/scripts/scrapers.js', () => ({ initScrapers: noop }));
    jest.unstable_mockModule('../../public/scripts/samplerSelect.js', () => ({ initCustomSelectedSamplers: noop, validateDisabledSamplers: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/dragdrop.js', () => ({ DragAndDropHandler: StubClass }));
    jest.unstable_mockModule('../../public/scripts/keyboard.js', () => ({ INTERACTABLE_CONTROL_CLASS: '', initKeyboard: noop }));
    jest.unstable_mockModule('../../public/scripts/dynamic-styles.js', () => ({ initDynamicStyles: noop }));
    jest.unstable_mockModule('../../public/scripts/input-md-formatting.js', () => ({ initInputMarkdown: noop }));
    jest.unstable_mockModule('../../public/scripts/sysprompt.js', () => ({ initSystemPrompts: noop }));
    jest.unstable_mockModule('../../public/scripts/extensions-slashcommands.js', () => ({ registerExtensionSlashCommands: noop }));
    jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({
        ToolManager: {
            isToolCallingSupported: () => mockCanPerformToolCalls,
            canPerformToolCalls: () => mockCanPerformToolCalls,
            hasToolCalls: (toolCallsOrData) => Array.isArray(toolCallsOrData) ? toolCallsOrData.length > 0 : false,
            invokeFunctionTools: async () => ({ invocations: [], stealthCalls: [], errors: [] }),
            saveFunctionToolInvocations: async () => {},
            showToolCallError: noop,
            RECURSE_LIMIT: 5,
        },
    }));
    jest.unstable_mockModule('../../public/scripts/tool-invocation-hide.js', () => ({ classifyInvocationSummary: noop, getOpenToolTaskTailStart: () => 0 }));
    jest.unstable_mockModule('../../public/scripts/skills/embed-lifecycle.js', () => ({ registerSkillEmbedLifecycle: noop }));
    jest.unstable_mockModule('../../public/scripts/util/showdown-patch.js', () => ({ addShowdownPatch: noop }));
    jest.unstable_mockModule('../../public/scripts/browser-fixes.js', () => ({ applyBrowserFixes: noop }));
    jest.unstable_mockModule('../../public/scripts/server-history.js', () => ({ initServerHistory: noop }));
    jest.unstable_mockModule('../../public/scripts/setting-search.js', () => ({ initSettingsSearch: noop }));
    jest.unstable_mockModule('../../public/scripts/bulk-edit.js', () => ({ initBulkEdit: noop }));
    jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({ getContext: () => ({}) }));
    jest.unstable_mockModule('../../public/scripts/lukerContext.js', () => ({}));
    jest.unstable_mockModule('../../public/scripts/reasoning.js', () => stubExports([
        'extractReasoningBlocksFromData', 'extractReasoningDetailsFromData', 'extractReasoningFromData',
        'extractReasoningSignatureFromData', 'initReasoning', 'parseReasoningInSwipes',
        'registerReasoningSlashCommands', 'removeReasoningFromString', 'updateReasoningUI',
    ], {
        extractNativeTurnFromData: () => ({ nativeParts: null, nativeContentBlocks: null, responsesOutputItems: null }),
        PromptReasoning: class {
            addToMessage(m) { return m; }
            isLimitReached() { return false; }
            removePrefix(m) { return m; }
        },
        ReasoningHandler: class {
            constructor() { this.reasoning = ''; }
            initContinue() {}
            updateReasoning() {}
            async process() {}
            updateDom() {}
            async finish() {}
            getDuration() { return 0; }
        },
        ReasoningType: {},
    }));
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
        accountStorage: { getState: () => ({}), init: noop, getItem: () => null, setItem: noop, removeItem: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/welcome-screen.js', () => stubExports([
        'fetchRecentChatsSnapshot', 'initWelcomeScreen', 'openPermanentAssistantChat',
        'openPermanentAssistantCard', 'getPermanentAssistantAvatar', 'openWelcomeScreen',
        'primeRecentChatsSnapshotPromise',
    ]));
    jest.unstable_mockModule('../../public/scripts/data-maid.js', () => ({ initDataMaid: noop }));
    jest.unstable_mockModule('../../public/scripts/itemized-prompts.js', () => stubExports([
        'clearItemizedPrompts', 'deleteItemizedPromptForMessage', 'deleteItemizedPrompts',
        'findItemizedPromptSet', 'initItemizedPrompts', 'loadItemizedPrompts',
        'promptItemize', 'replaceItemizedPromptText', 'saveItemizedPrompts',
        'saveItemizedPromptsDebounced', 'swapItemizedPrompts',
    ], {
        flushItemizedPromptsSave: flushItemizedPromptsSaveMock,
        itemizedParams: {},
        itemizedPrompts: [],
    }));
    jest.unstable_mockModule('../../public/scripts/system-messages.js', () => stubExports([
        'getSystemMessageByType', 'initSystemMessages', 'sendSystemMessage',
    ], { SAFETY_CHAT: '', system_message_types: {}, system_messages: {} }));
    jest.unstable_mockModule('../../public/scripts/announcements.js', () => ({ initAnnouncements: noop, whenCriticalAnnouncementsDone: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/whats-new.js', () => ({ initWhatsNew: noop }));
    jest.unstable_mockModule('../../public/scripts/floor-state.js', () => stubExports([
        'settleChatChanged', 'settleMessageDeleted', 'settleMessageSwipeDeleted', 'settleMessageSwiped',
    ]));
    jest.unstable_mockModule('../../public/scripts/a11y.js', () => ({ initAccessibility: noop }));
    jest.unstable_mockModule('../../public/scripts/util/stream-fadein.js', () => ({ applyStreamFadeIn: noop }));
    jest.unstable_mockModule('../../public/scripts/dom-handlers.js', () => ({ initDomHandlers: noop }));
    jest.unstable_mockModule('../../public/scripts/audio-player.js', () => ({ AudioPlayer: StubClass }));
    jest.unstable_mockModule('../../public/scripts/macros/engine/MacroEnvBuilder.js', () => ({ MacroEnvBuilder: StubClass }));
    jest.unstable_mockModule('../../public/scripts/message-formatter.js', () => ({
        MessageFormatter: class extends StubClass {
            static stage = {
                BEFORE_REGEX: 'beforeRegex',
                AFTER_REGEX: 'afterRegex',
                AFTER_MARKDOWN: 'afterMarkdown',
            };
            static runStage(_stage, mes) { return mes; }
        },
    }));
    jest.unstable_mockModule('../../public/scripts/macros/engine/MacroEngine.js', () => ({ MacroEngine: StubClass }));
    jest.unstable_mockModule('../../public/scripts/chat-backups.js', () => ({ addChatBackupsBrowser: noop }));
    jest.unstable_mockModule('../../public/scripts/macros/engine/MacroDiagnostics.js', () => ({ onboardingExperimentalMacroEngine: noop }));
    jest.unstable_mockModule('../../public/scripts/undo-toast.js', () => ({ showUndoToast: noop }));
    jest.unstable_mockModule('../../public/scripts/luker-toast.js', () => ({ setToastTranslator: noop }));
    jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({ setRequestCompressionConfig: noop }));
    jest.unstable_mockModule('../../public/scripts/swipe-picker.js', () => ({
        canJumpToSwipeForMessage: () => false,
        canOpenSwipePickerForMessage: () => false,
        initSwipePicker: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/self-profiler.js', () => ({ bootSelfProfilerFromStorage: noop }));
    jest.unstable_mockModule('../../public/scripts/ws-delivery.js', () => ({
        createLukerDelivery: noop,
        getLukerResponseMeta: () => null,
        installFetchProxy: noop,
        installFetchProxyForAllIframes: noop,
        installLifecycleHooks: noop,
        onLukerResponseMeta: () => noop,
    }));
    jest.unstable_mockModule('../../public/scripts/settings-resource-read.js', () => ({ loadSettingsEnvelope: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/named-resource-read.js', () => ({
        listPresetDocuments: async () => [],
        loadPresetResources: async () => ({}),
        readPresetDocument: async () => null,
    }));
    jest.unstable_mockModule('../../public/scripts/workbench/index.js', () => ({ initWorkbench: noop }));

    globalThis.document = {
        readyState: 'complete',
        addEventListener: noop,
        removeEventListener: noop,
        body: { dataset: {} },
        documentElement: { style: { setProperty: noop } },
        getElementById: (id) => (id === 'right-nav-panel' ? { dataset: {} } : null),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    globalThis.window = Object.assign(globalThis, {
        addEventListener: noop,
        removeEventListener: noop,
        Element: class {},
        HTMLElement: class {},
        DocumentFragment: class {},
        HTMLImageElement: class {},
        HTMLVideoElement: class {},
    });
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn(), subscribe: noop, options: {} };
    globalThis.fetch = fetchMock;

    const baseJQuery = globalThis.jQuery || { escapeSelector: (s) => String(s ?? '') };
    const makeSafeChain = () => {
        const chain = {
            __isSafeChain: true,
            length: 0,
            0: { dispatchEvent: noop },
            [Symbol.toPrimitive]: () => '',
            val: (v) => (v !== undefined ? chain : ''),
            attr: (...args) => (args.length >= 2 || (typeof args[0] === 'object' && args[0] !== null) ? chain : undefined),
            css: (...args) => (args.length >= 2 || (typeof args[0] === 'object' && args[0] !== null) ? chain : 'none'),
            text: (...args) => (args.length >= 1 ? chain : ''),
            html: (...args) => (args.length >= 1 ? chain : ''),
            prop: (...args) => (args.length >= 2 || (typeof args[0] === 'object' && args[0] !== null) ? chain : false),
            is: () => false,
            hasClass: () => false,
            toArray: () => [],
            get: () => [],
            index: () => -1,
            height: () => 0,
            width: () => 0,
            outerHeight: () => 0,
            outerWidth: () => 0,
            scrollTop: (...args) => (args.length >= 1 ? chain : 0),
        };
        for (const method of [
            'on', 'off', 'one', 'trigger', 'triggerHandler', 'addClass', 'removeClass', 'toggleClass',
            'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'detach', 'find',
            'closest', 'children', 'parent', 'parents', 'siblings', 'next', 'prev', 'filter', 'not',
            'first', 'last', 'eq', 'each', 'map', 'data', 'removeAttr', 'removeData', 'focus', 'blur',
            'click', 'stop', 'fadeIn', 'fadeOut', 'animate', 'slideUp', 'slideDown', 'clone',
            'replaceWith', 'after', 'before', 'insertAfter', 'insertBefore', 'wrap', 'unwrap',
            'submit', 'change', 'input', 'keydown', 'keyup', 'keypress', 'mousedown', 'mouseup',
            'mouseenter', 'mouseleave', 'scroll', 'resize', 'ready', 'bind', 'unbind',
            'pagination', 'sortable', 'select2', 'draggable', 'resizable', 'autocomplete', 'tooltip',
        ]) {
            chain[method] = () => chain;
        }
        return chain;
    };
    const safeChain = makeSafeChain();
    const customJQuery = Object.assign(
        function (selectorOrFn) {
            if (typeof selectorOrFn === 'function') {
                return selectorOrFn.__isSafeChain ? selectorOrFn : undefined;
            }
            if (typeof selectorOrFn === 'string' && selectorOrFn === '#send_textarea') {
                const chain = Object.assign(Object.create(safeChain), {
                    val: (v) => {
                        if (v !== undefined) {
                            sendTextareaVal = v;
                            return chain;
                        }
                        return sendTextareaVal;
                    },
                    0: { dispatchEvent: noop },
                });
                return chain;
            }
            return safeChain;
        },
        baseJQuery,
    );
    globalThis.jQuery = customJQuery;
    globalThis.$ = customJQuery;
    globalThis.$.ajaxPrefilter = noop;

    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: noop, removeItem: noop },
    });

    scriptMod = await import('../../public/script.js');
    scriptMod.reloadMarkdownProcessor();
    ({
        Generate,
        shouldWarnBeforeUnload,
        handleBeforeUnload,
        confirmChatSwitchGuard,
        getChatTransitionEpoch,
        bumpChatTransitionEpoch,
        selectCharacterById,
        openCharacterChat,
        doNewChat,
        closeCurrentChat,
        newAssistantChat,
        setCharacterId,
        characters,
        eventSource,
        event_types,
        setEditedMessageId,
        setSendButtonState,
        setOnlineStatus,
        saveChatDebounced,
        saveChatConditional,
    } = scriptMod);
});

describe('public/script.js core generation leases and unified beforeunload guard', () => {
    beforeEach(async () => {
        executeSlashCommandsMock.mockClear();
        flushTokenCacheSaveMock.mockClear();
        flushItemizedPromptsSaveMock.mockClear();
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
        sendTextareaVal = '';
        mockGroupState.is_group_generating = false;
        setEditedMessageId(undefined);
        setSendButtonState(false);
        setOnlineStatus('no_connection');
        await saveChatConditional();
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(async () => {
        mockGroupState.is_group_generating = false;
        setEditedMessageId(undefined);
        setSendButtonState(false);
        setOnlineStatus('no_connection');
        sendTextareaVal = '';
        await saveChatConditional();
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('legacy generation in-flight exports are physically removed from public/script.js', () => {
        expect('isGenerationInFlight' in scriptMod).toBe(false);
        expect('setGenerationInFlightListener' in scriptMod).toBe(false);
    });

    test('Generate acquires no lease for dryRun or when interrupted by slash commands', async () => {
        let sawDryRunActive = false;
        const onAfterCmd = () => {
            sawDryRunActive = getActiveActivities().length > 0;
        };
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onAfterCmd);
        try {
            await Generate('normal', {}, true);
            expect(sawDryRunActive).toBe(false);
            expect(getActiveActivities()).toEqual([]);
        } finally {
            eventSource.removeListener(event_types.GENERATION_AFTER_COMMANDS, onAfterCmd);
        }

        sendTextareaVal = '/newchat';
        let commandTimeActivities = null;
        executeSlashCommandsMock.mockImplementationOnce(async () => {
            commandTimeActivities = getActiveActivities();
            expect(hasChatSwitchGuard()).toBe(false);
        });

        await Generate('normal', {}, false);
        expect(executeSlashCommandsMock).toHaveBeenCalledTimes(1);
        expect(commandTimeActivities).toEqual([]);
        expect(getActiveActivities()).toEqual([]);
    });

    test('Generate holds core:generation after processCommands, hooks stopGeneration via onCancel, and releases in finally', async () => {
        sendTextareaVal = 'Hello world';
        const pingGate = deferred();
        let startedActivities = null;
        let afterCmdActivities = null;

        const onStarted = () => {
            startedActivities = getActiveActivities();
        };
        const onAfterCommands = () => {
            afterCmdActivities = getActiveActivities();
        };
        const stoppedSpy = jest.fn();
        eventSource.on(event_types.GENERATION_STARTED, onStarted);
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onAfterCommands);
        eventSource.on(event_types.GENERATION_STOPPED, stoppedSpy);

        fetchMock.mockImplementationOnce(async () => await pingGate.promise);

        try {
            const genPromise = Generate('normal', {}, false);

            await new Promise((r) => setTimeout(r, 10));

            expect(startedActivities).toEqual([]);
            expect(afterCmdActivities).toHaveLength(1);
            expect(afterCmdActivities[0]).toMatchObject({
                source: 'core:generation',
                label: 'Message generation',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            });
            expect(hasActiveSource('core:generation')).toBe(true);
            expect(shouldWarnBeforeUnload()).toBe(true);

            cancelChatSwitchActivities();
            expect(stoppedSpy).toHaveBeenCalledTimes(1);

            pingGate.resolve({ ok: false });
            await expect(genPromise).rejects.toThrow('Server unreachable');
            expect(getActiveActivities()).toEqual([]);
            expect(hasUnloadGuard()).toBe(false);
        } finally {
            pingGate.resolve({ ok: false });
            eventSource.removeListener(event_types.GENERATION_STARTED, onStarted);
            eventSource.removeListener(event_types.GENERATION_AFTER_COMMANDS, onAfterCommands);
            eventSource.removeListener(event_types.GENERATION_STOPPED, stoppedSpy);
        }
    });

    test('Generate with type quiet acquires core:generation-quiet and releases on exit', async () => {
        let observed = null;
        const onAfterCommands = () => {
            observed = getActiveActivities();
        };
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onAfterCommands);

        try {
            await Generate('quiet', { quiet_prompt: 'Summarize' }, false);
            expect(observed).toHaveLength(1);
            expect(observed[0]).toMatchObject({
                source: 'core:generation-quiet',
                label: 'Background generation',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            });
            expect(getActiveActivities()).toEqual([]);
        } finally {
            eventSource.removeListener(event_types.GENERATION_AFTER_COMMANDS, onAfterCommands);
        }
    });

    test('shouldWarnBeforeUnload unifies activity guard, active generation, edits, draft input, and pending saves', () => {
        expect(shouldWarnBeforeUnload()).toBe(false);

        const releaseNoUnload = acquireActivityLease({ source: 'test:no-unload', guardUnload: false });
        expect(shouldWarnBeforeUnload()).toBe(false);
        releaseNoUnload();

        const releaseUnload = acquireActivityLease({ source: 'test:unload', guardUnload: true });
        expect(shouldWarnBeforeUnload()).toBe(true);
        releaseUnload();
        expect(shouldWarnBeforeUnload()).toBe(false);

        setSendButtonState(true);
        expect(shouldWarnBeforeUnload()).toBe(true);
        setSendButtonState(false);

        setEditedMessageId(2);
        expect(shouldWarnBeforeUnload()).toBe(true);
        setEditedMessageId(undefined);

        sendTextareaVal = '   \n  ';
        expect(shouldWarnBeforeUnload()).toBe(false);
        sendTextareaVal = 'unsent reply';
        expect(shouldWarnBeforeUnload()).toBe(true);
        sendTextareaVal = '';

        expect(shouldWarnBeforeUnload(true)).toBe(true);
        expect(shouldWarnBeforeUnload(false)).toBe(false);
    });

    test('handleBeforeUnload flushes caches, captures debouncePending before saveChatConditional, and never runs onCancel', () => {
        const onCancelSpy = jest.fn();
        const release = acquireActivityLease({
            source: 'test:unload-task',
            scope: 'chat',
            guardUnload: true,
            onCancel: onCancelSpy,
        });

        try {
            expect(shouldWarnBeforeUnload()).toBe(true);

            const leaseEvent = {
                preventDefault: jest.fn(),
                returnValue: undefined,
            };
            handleBeforeUnload(leaseEvent);

            expect(flushTokenCacheSaveMock).toHaveBeenCalledTimes(1);
            expect(flushItemizedPromptsSaveMock).toHaveBeenCalledTimes(1);
            expect(leaseEvent.preventDefault).toHaveBeenCalledTimes(1);
            expect(leaseEvent.returnValue).toBe('');
            expect(onCancelSpy).not.toHaveBeenCalled();
        } finally {
            release();
        }

        // Isolated debouncePending check: no active lease, edit, generation, or draft input.
        expect(shouldWarnBeforeUnload()).toBe(false);
        saveChatDebounced();
        expect(shouldWarnBeforeUnload()).toBe(true);

        const debounceEvent = {
            preventDefault: jest.fn(),
            returnValue: undefined,
        };
        handleBeforeUnload(debounceEvent);
        expect(debounceEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(debounceEvent.returnValue).toBe('');
        expect(shouldWarnBeforeUnload()).toBe(false);

        const idleEvent = {
            preventDefault: jest.fn(),
            returnValue: undefined,
        };
        handleBeforeUnload(idleEvent);
        expect(idleEvent.preventDefault).not.toHaveBeenCalled();
        expect(idleEvent.returnValue).toBeUndefined();
    });
});

describe('public/script.js confirmChatSwitchGuard, epoch helpers, and switch entrypoints', () => {
    beforeEach(async () => {
        popupConfirmMock.mockReset();
        popupConfirmMock.mockResolvedValue(1);
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
        prepareOpenAIMessagesMock.mockReset().mockResolvedValue([[], []]);
        notifyMessageFailureMock.mockReset();
        getTokenCountAsyncMock.mockReset().mockResolvedValue(0);
        mockAutoContinueTruncated = false;
        mockCanPerformToolCalls = false;
        globalThis.toastr.info.mockClear();
        mockGroupState.is_group_generating = false;
        setEditedMessageId(undefined);
        setSendButtonState(false);
        setCharacterId(undefined);
        characters.splice(0, characters.length);
        await saveChatConditional();
    });

    afterEach(() => {
        mockAutoContinueTruncated = false;
        mockCanPerformToolCalls = false;
        mockGroupState.is_group_generating = false;
        setEditedMessageId(undefined);
        setSendButtonState(false);
        setCharacterId(undefined);
        characters.splice(0, characters.length);
    });

    test('confirmChatSwitchGuard collects escaping labels, generation fallback, unsaved edit, and handles cancel/confirm/re-entrancy/skipConfirmation', async () => {
        await expect(confirmChatSwitchGuard()).resolves.toBe(true);
        expect(popupConfirmMock).not.toHaveBeenCalled();

        const onCancelSpy = jest.fn();
        const release = acquireActivityLease({
            source: 'test:xss-label',
            label: '<script>alert(1)</script>',
            scope: 'chat',
            onCancel: onCancelSpy,
        });

        try {
            setSendButtonState(true);
            setEditedMessageId(0);

            const epochBeforeCancel = getChatTransitionEpoch();
            const pendingPopup = deferred();
            popupConfirmMock.mockImplementationOnce(() => pendingPopup.promise);

            const firstCall = confirmChatSwitchGuard();
            const reentrantCall = confirmChatSwitchGuard();

            await expect(reentrantCall).resolves.toBe(false);
            expect(popupConfirmMock).toHaveBeenCalledTimes(1);

            const [title, html, opts] = popupConfirmMock.mock.calls[0];
            expect(title).toBe('Tasks still in progress');
            expect(html).toContain('<li>&lt;script&gt;alert(1)&lt;/script&gt;</li>');
            expect(html).toContain('<li>Message generation</li>');
            expect(html).toContain('<li>Unsaved message edit</li>');
            expect(opts).toMatchObject({
                okButton: 'Switch anyway',
                cancelButton: 'Cancel',
                defaultResult: 0,
            });

            pendingPopup.resolve(0);
            await expect(firstCall).resolves.toBe(false);
            expect(getChatTransitionEpoch()).toBe(epochBeforeCancel);
            expect(onCancelSpy).not.toHaveBeenCalled();

            // Confirming advances epoch, stops generation, and invokes onCancel.
            const stoppedSpy = jest.fn();
            eventSource.on(event_types.GENERATION_STOPPED, stoppedSpy);
            popupConfirmMock.mockResolvedValueOnce(1);
            try {
                await expect(confirmChatSwitchGuard()).resolves.toBe(true);
                expect(getChatTransitionEpoch()).toBe(epochBeforeCancel + 1);
                expect(stoppedSpy).toHaveBeenCalledTimes(1);
                expect(onCancelSpy).toHaveBeenCalledTimes(1);
            } finally {
                eventSource.removeListener(event_types.GENERATION_STOPPED, stoppedSpy);
            }

            // skipConfirmation skips dialog while still bumping epoch & cancelling.
            popupConfirmMock.mockClear();
            onCancelSpy.mockClear();
            const epochBeforeSkip = getChatTransitionEpoch();
            await expect(confirmChatSwitchGuard({ skipConfirmation: true })).resolves.toBe(true);
            expect(popupConfirmMock).not.toHaveBeenCalled();
            expect(getChatTransitionEpoch()).toBe(epochBeforeSkip + 1);
            expect(onCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
    });

    test('confirmChatSwitchGuard prompts with Background task and runs onCancel for unnamed guardChatSwitch lease', async () => {
        const onCancelSpy = jest.fn();
        const release = acquireActivityLease({
            source: 'plugin:unnamed',
            scope: 'chat',
            label: '',
            onCancel: onCancelSpy,
        });

        try {
            popupConfirmMock.mockResolvedValueOnce(0);
            await expect(confirmChatSwitchGuard()).resolves.toBe(false);
            expect(popupConfirmMock).toHaveBeenCalledTimes(1);
            expect(popupConfirmMock.mock.calls[0][1]).toContain('<li>Background task</li>');
            expect(onCancelSpy).not.toHaveBeenCalled();

            popupConfirmMock.mockResolvedValueOnce(1);
            await expect(confirmChatSwitchGuard()).resolves.toBe(true);
            expect(onCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
    });

    test('closeCurrentChat, openCharacterChat, selectCharacterById, doNewChat, and newAssistantChat return boolean and honor cancel/confirm', async () => {
        characters.push(
            { avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-1', shallow: false },
        );
        setCharacterId('0');

        const release = acquireActivityLease({
            source: 'test:switch-block',
            label: 'Memory graph update',
            scope: 'chat',
        });

        try {
            // Cancel returns false across entrypoints without mutating state or showing legacy toast.
            popupConfirmMock.mockResolvedValue(0);
            await expect(closeCurrentChat()).resolves.toBe(false);
            await expect(openCharacterChat('alice-2')).resolves.toBe(false);
            await expect(selectCharacterById(1)).resolves.toBe(false);
            await expect(doNewChat()).resolves.toBe(false);
            await expect(newAssistantChat({ temporary: true })).resolves.toBe(false);
            expect(globalThis.toastr.info).not.toHaveBeenCalled();

            // Clicking already-selected character skips switch guard and returns true.
            popupConfirmMock.mockClear();
            await expect(selectCharacterById(0)).resolves.toBe(true);
            expect(popupConfirmMock).not.toHaveBeenCalled();

            // Confirming newAssistantChat({ temporary: true }) switches cleanly and bumps epoch.
            popupConfirmMock.mockResolvedValueOnce(1);
            const beforeEpoch = getChatTransitionEpoch();
            await expect(newAssistantChat({ temporary: true })).resolves.toBe(true);
            expect(getChatTransitionEpoch()).toBeGreaterThan(beforeEpoch);

            // Confirming closeCurrentChat returns true and clears character selection.
            setCharacterId('0');
            popupConfirmMock.mockResolvedValueOnce(1);
            await expect(closeCurrentChat()).resolves.toBe(true);
            expect(scriptMod.this_chid).toBeUndefined();
        } finally {
            release();
        }
    });

    test('bumpChatTransitionEpoch advances monotonically', () => {
        const start = getChatTransitionEpoch();
        expect(bumpChatTransitionEpoch()).toBe(start + 1);
        expect(getChatTransitionEpoch()).toBe(start + 1);
    });

    test('non-streaming Generate onSuccess drops stale reply when chatTransitionEpoch advances mid-request', async () => {
        scriptMod.changeMainAPI('openai');
        setOnlineStatus('connected');
        mockOaiSettings.stream_openai = false;
        characters.push({ avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false });
        setCharacterId('0');
        scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Hi Alice' });

        const gate = deferred();
        sendOpenAIRequestMock.mockReset();
        sendOpenAIRequestMock.mockImplementationOnce(async () => await gate.promise);

        const messageReceivedSpy = jest.fn();
        eventSource.on(event_types.MESSAGE_RECEIVED, messageReceivedSpy);

        try {
            const genPromise = Generate('normal', {}, false);
            await new Promise((r) => setTimeout(r, 25));
            expect(sendOpenAIRequestMock).toHaveBeenCalledTimes(1);

            // User switches to a new chat while non-streaming request is in flight.
            bumpChatTransitionEpoch();
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'Bob', is_user: false, mes: 'New chat greeting' });
            // Simulate a new chat starting its own generation lock.
            setSendButtonState(true);

            gate.resolve({ choices: [{ message: { content: 'Leaked stale Alice reply' } }] });
            await genPromise;

            expect(scriptMod.chat).toEqual([{ name: 'Bob', is_user: false, mes: 'New chat greeting' }]);
            expect(messageReceivedSpy).not.toHaveBeenCalled();
            expect(scriptMod.is_send_press).toBe(true);
        } finally {
            setSendButtonState(false);
            scriptMod.chat.splice(0, scriptMod.chat.length);
            eventSource.removeListener(event_types.MESSAGE_RECEIVED, messageReceivedSpy);
        }
    });

    test('streaming Generate and StreamingProcessor fence chunks, saves, emits, and streamingProcessor cleanup across epoch transition', async () => {
        scriptMod.changeMainAPI('openai');
        setOnlineStatus('connected');
        mockOaiSettings.stream_openai = true;
        characters.push({ avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false });
        setCharacterId('0');
        scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Hi Alice' });

        const chunkGate = deferred();
        const bobGate = deferred();
        sendOpenAIRequestMock.mockReset();
        sendOpenAIRequestMock
            .mockImplementationOnce(async () => {
                return async function* staleStream() {
                    yield { text: 'First chunk ', swipes: [], logprobs: null, toolCalls: [], state: {} };
                    await chunkGate.promise;
                    yield { text: 'Second stale chunk', swipes: [], logprobs: null, toolCalls: [], state: {} };
                };
            })
            .mockImplementationOnce(async () => {
                return async function* freshStream() {
                    yield { text: 'Bob reply', swipes: [], logprobs: null, toolCalls: [], state: {} };
                    await bobGate.promise;
                };
            });

        const messageReceivedSpy = jest.fn();
        eventSource.on(event_types.MESSAGE_RECEIVED, messageReceivedSpy);

        try {
            const staleGenPromise = Generate('normal', {}, false);
            await new Promise((r) => setTimeout(r, 25));
            expect(sendOpenAIRequestMock).toHaveBeenCalledTimes(1);

            // Confirm switch while stream is mid-flight (before chunk 2).
            popupConfirmMock.mockResolvedValueOnce(1);
            await expect(confirmChatSwitchGuard()).resolves.toBe(true);

            // Switch clears chat and loads new chat; immediately start Bob's fresh stream.
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'Bob', is_user: false, mes: 'Bob greeting' });
            const bobGenPromise = Generate('normal', {}, false);
            await new Promise((r) => setTimeout(r, 25));
            expect(sendOpenAIRequestMock).toHaveBeenCalledTimes(2);

            const bobProcessor = scriptMod.streamingProcessor;
            expect(bobProcessor).toBeTruthy();

            // Release old stream while Bob's stream is still active: must NOT clear Bob's streamingProcessor or mutate chat[].
            chunkGate.resolve();
            await staleGenPromise;
            expect(scriptMod.streamingProcessor).toBe(bobProcessor);
            expect(messageReceivedSpy).not.toHaveBeenCalled();

            // Finish Bob's stream cleanly.
            bobGate.resolve();
            await bobGenPromise;
            expect(scriptMod.streamingProcessor).toBeNull();
            expect(scriptMod.chat.map((m) => m.mes)).toEqual(['Bob greeting', 'Bob reply']);
            expect(messageReceivedSpy).toHaveBeenCalledTimes(1);
        } finally {
            mockOaiSettings.stream_openai = false;
            scriptMod.chat.splice(0, scriptMod.chat.length);
            eventSource.removeListener(event_types.MESSAGE_RECEIVED, messageReceivedSpy);
        }
    });

    test('sendStreamingRequest throws AbortError when streamingProcessor is cleared or replaced across GENERATION_BEFORE_API_REQUEST', async () => {
        scriptMod.changeMainAPI('openai');
        setOnlineStatus('connected');
        mockOaiSettings.stream_openai = true;
        characters.push({ avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false });
        setCharacterId('0');
        scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Hi Alice' });

        // 1. Direct call with null streamingProcessor rejects with AbortError instead of TypeError.
        await expect(scriptMod.sendStreamingRequest('normal', { prompt: [] })).rejects.toMatchObject({ name: 'AbortError' });

        // 2. Chat switch + new Generate during GENERATION_BEFORE_API_REQUEST must not TypeError or hijack the new chat signal.
        const bobGate = deferred();
        sendOpenAIRequestMock.mockReset();
        sendOpenAIRequestMock.mockImplementationOnce(async (_type, _prompt, signal) => {
            expect(signal.aborted).toBe(false);
            return async function* bobStream() {
                yield { text: 'Bob reply', swipes: [], logprobs: null, toolCalls: [], state: {} };
                await bobGate.promise;
            };
        });

        let bobPromise = null;
        let switched = false;
        const onBeforeApiRequest = async () => {
            if (switched) return;
            switched = true;
            popupConfirmMock.mockResolvedValueOnce(1);
            await confirmChatSwitchGuard();
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'Bob', is_user: false, mes: 'Bob greeting' });
            bobPromise = Generate('normal', {}, false);
        };
        eventSource.on(event_types.GENERATION_BEFORE_API_REQUEST, onBeforeApiRequest);

        try {
            const stalePromise = Generate('normal', {}, false);
            await expect(stalePromise).rejects.toMatchObject({ name: 'AbortError' });

            await new Promise((r) => setTimeout(r, 25));
            expect(sendOpenAIRequestMock).toHaveBeenCalledTimes(1);
            expect(scriptMod.streamingProcessor).toBeTruthy();

            bobGate.resolve();
            await bobPromise;
            expect(scriptMod.chat.map((m) => m.mes)).toEqual(['Bob greeting', 'Bob reply']);
        } finally {
            mockOaiSettings.stream_openai = false;
            scriptMod.chat.splice(0, scriptMod.chat.length);
            eventSource.removeListener(event_types.GENERATION_BEFORE_API_REQUEST, onBeforeApiRequest);
        }
    });

    test('prepareOpenAIMessages catch skips notifyMessageFailure and unblockGeneration when chatTransitionEpoch is stale', async () => {
        scriptMod.changeMainAPI('openai');
        setOnlineStatus('connected');
        mockOaiSettings.stream_openai = false;
        characters.push({ avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false });
        setCharacterId('0');

        const prepGate = deferred();
        prepareOpenAIMessagesMock.mockImplementationOnce(() => prepGate.promise);

        try {
            const genPromise = Generate('normal', {}, false);
            await new Promise((r) => setTimeout(r, 20));

            bumpChatTransitionEpoch();
            setSendButtonState(true);
            prepGate.reject(new Error('stale prompt prep error'));

            await expect(genPromise).rejects.toThrow('stale prompt prep error');
            expect(notifyMessageFailureMock).not.toHaveBeenCalled();
            expect(scriptMod.is_send_press).toBe(true);
        } finally {
            setSendButtonState(false);
        }
    });

    test('MESSAGE_RECEIVED epoch bump prevents CHARACTER_MESSAGE_RENDERED in streaming, tool-call finalize, and auto-continue abort paths', async () => {
        scriptMod.changeMainAPI('openai');
        setOnlineStatus('connected');
        characters.push({ avatar: 'alice.png', name: 'Alice', chat: 'alice-1', shallow: false });
        setCharacterId('0');

        // 1. Streaming onFinishStreaming path
        mockOaiSettings.stream_openai = true;
        scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Hi' });
        sendOpenAIRequestMock.mockReset().mockImplementationOnce(async () => async function* () {
            yield { text: 'Hello', swipes: [], logprobs: null, toolCalls: [], state: {} };
        });

        let receivedCount = 0;
        let renderedCount = 0;
        const onMessageReceivedBump = () => {
            receivedCount += 1;
            bumpChatTransitionEpoch();
        };
        const onRendered = () => {
            renderedCount += 1;
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceivedBump);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);

        try {
            await Generate('normal', {}, false);
            expect(receivedCount).toBe(1);
            expect(renderedCount).toBe(0);

            // 2. Streaming tool-call finalizeIntermediaryMessage path (deferEmit = false)
            receivedCount = 0;
            renderedCount = 0;
            mockCanPerformToolCalls = true;
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Tool?' });
            sendOpenAIRequestMock.mockReset().mockImplementationOnce(async () => async function* () {
                yield {
                    text: 'Using tool',
                    swipes: [],
                    logprobs: null,
                    toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
                    state: {},
                };
            });
            await Generate('normal', {}, false);
            expect(receivedCount).toBe(1);
            expect(renderedCount).toBe(0);
            mockCanPerformToolCalls = false;

            // 3. Streaming auto-continue-on-truncated aborted between suppress finalize and recursive Generate
            receivedCount = 0;
            renderedCount = 0;
            mockAutoContinueTruncated = true;
            mockPowerUser.message_token_count_enabled = true;
            getTokenCountAsyncMock.mockImplementation(async (text) => {
                if (typeof text === 'string' && (text === 'Part 1' || text.includes('Truncated'))) {
                    scriptMod.stopGeneration();
                }
                return 42;
            });
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Long?' });
            sendOpenAIRequestMock.mockReset().mockImplementationOnce(async () => async function* () {
                yield { text: 'Part 1', swipes: [], logprobs: null, toolCalls: [], state: { finishReason: 'length' } };
            });
            await Generate('normal', {}, false);
            expect(receivedCount).toBe(1);
            expect(renderedCount).toBe(0);

            // 4. Non-streaming auto-continue-on-truncated aborted during saveReply before recursive Generate
            receivedCount = 0;
            renderedCount = 0;
            mockOaiSettings.stream_openai = false;
            scriptMod.chat.splice(0, scriptMod.chat.length,
                { name: 'You', is_user: true, mes: 'NonStream?' },
                { name: 'Alice', is_user: false, mes: 'Prefix ', swipes: ['Prefix '], swipe_id: 0, swipe_info: [{}] },
            );
            sendOpenAIRequestMock.mockReset().mockResolvedValueOnce({
                choices: [{ message: { content: 'Truncated' }, finish_reason: 'length' }],
            });
            await Generate('continue', {}, false);
            expect(receivedCount).toBe(1);
            expect(renderedCount).toBe(0);

            // 5. Normal non-streaming saveReply MESSAGE_RECEIVED epoch bump prevents CHARACTER_MESSAGE_RENDERED
            receivedCount = 0;
            renderedCount = 0;
            mockAutoContinueTruncated = false;
            mockPowerUser.message_token_count_enabled = false;
            scriptMod.chat.splice(0, scriptMod.chat.length, { name: 'You', is_user: true, mes: 'Normal non-stream' });
            sendOpenAIRequestMock.mockReset().mockResolvedValueOnce({
                choices: [{ message: { content: 'Normal reply' }, finish_reason: 'stop' }],
            });
            await Generate('normal', {}, false);
            expect(receivedCount).toBe(1);
            expect(renderedCount).toBe(0);
        } finally {
            mockAutoContinueTruncated = false;
            mockCanPerformToolCalls = false;
            mockOaiSettings.stream_openai = false;
            scriptMod.chat.splice(0, scriptMod.chat.length);
            eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceivedBump);
            eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onRendered);
        }
    });
});
