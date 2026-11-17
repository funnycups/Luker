// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { compare as compareJsonPatch, applyPatch as applyJsonPatch } from '../../public/scripts/util/fast-json-patch.js';
import { cloneAsJsonWire } from '../../public/scripts/util/json-clone.js';
import { saveSettingsChecked } from '../../public/scripts/workbench/model/patch.js';

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

// Minimal module stubs for public/script.js's browser-UI dependencies so we
// can import and execute the REAL saveSettings / saveSettingsInternal /
// mergeSettingsSaveOptions / getSettings implementation under Jest.
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
jest.unstable_mockModule('../../public/scripts/group-chats.js', () => stubExports([
    'saveGroupChat', 'getGroups', 'primeGroupsSnapshot', 'generateGroupWrapper',
    'resetSelectedGroup', 'select_group_chats', 'regenerateGroup', 'getGroupChat',
    'loadGroupChat', 'renameGroupMember', 'createNewGroupChat', 'editGroup',
    'getGroupAvatar', 'deleteGroupChat', 'renameGroupChat', 'importGroupChat',
    'getGroupBlock', 'getGroupCharacterCardsLazy', 'getGroupDepthPrompts',
], { groups: [], selected_group: null, is_group_generating: false, group_generation_id: null }));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => stubExports([
    'collapseNewlines', 'loadPowerUserSettings', 'playMessageSound', 'fixMarkdown',
    'loadMovingUIState', 'getCustomStoppingStrings', 'renderStoryString',
    'sortEntitiesList', 'registerDebugFunction', 'flushEphemeralStoppingStrings',
    'resetMovableStyles', 'forceCharacterEditorTokenize', 'applyPowerUserSettings',
    'generatedTextFiltered', 'applyStylePins', 'notifyMessageComplete',
    'notifyMessageFailure', 'notifyMessageProgressStart', 'clearMessageProgressNotification',
], {
    power_user: {},
    persona_description_positions: {},
    MAX_CONTEXT_DEFAULT: 4096,
    MAX_RESPONSE_DEFAULT: 300,
}));
jest.unstable_mockModule('../../public/scripts/openai.js', () => stubExports([
    'setOpenAIMessageExamples', 'setOpenAIMessages', 'setupChatCompletionPromptManager',
    'prepareOpenAIMessages', 'sendOpenAIRequest', 'isLastOpenAIReplyPersistedByServer',
    'getLastOpenAIGenerationId', 'hydrateOpenAIPresetData', 'loadOpenAISettings',
    'getChatCompletionModel', 'loadProxyPresets', 'bindCurrentChatCompletionPresetToCharacter',
    'clearCharacterBoundChatCompletionPreset', 'maybeApplyCharacterBoundPreset', 'initOpenAI',
], {
    oai_settings: {},
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
], { PAGINATION_TEMPLATE: '', Stopwatch: StubClass }));
jest.unstable_mockModule('../../public/scripts/luker-download.js', () => ({ downloadFromServer: asyncNoop }));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => stubExports([
    'bootstrapExtensions', 'cancelDebouncedMetadataSave', 'doDailyExtensionUpdatesCheck',
    'initExtensions', 'primeExtensionSettings', 'runGenerationInterceptors', 'saveMetadataDebounced',
], { extension_settings: {} }));
jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => stubExports([
    'consumeEphemeralScriptInjectsForMainGeneration', 'executeSlashCommandsOnChatInput',
    'initDefaultSlashCommands', 'initSlashCommandAutoComplete', 'isExecutingCommandsFromChatInput',
    'pauseScriptExecution', 'processChatSlashCommands', 'stopScriptExecution',
], { COMMENT_NAME_DEFAULT: '', CONNECT_API_MAP: {}, UNIQUE_APIS: {} }));
jest.unstable_mockModule('../../public/scripts/tags.js', () => stubExports([
    'filterByTagState', 'isBogusFolder', 'isBogusFolderOpen', 'chooseBogusFolder',
    'getTagBlock', 'loadTagsSettings', 'printTagFilters', 'getTagKeyForEntity',
    'printTagList', 'createTagMapFromList', 'renameTagKey', 'importTags',
    'compareTagsForSort', 'initTags', 'applyTagsOnCharacterSelect',
    'applyTagsOnGroupSelect', 'applyCharacterTagsToMessageDivs',
], { tag_map: {}, tags: [], tag_filter_type: {}, tag_import_setting: {} }));
jest.unstable_mockModule('../../public/scripts/secrets.js', () => stubExports([
    'checkOpenRouterAuth', 'initSecrets', 'primeSecretStateSnapshot', 'readSecretState',
]));
jest.unstable_mockModule('../../public/scripts/showdown-exclusion.js', () => ({ markdownExclusionExt: {} }));
jest.unstable_mockModule('../../public/scripts/showdown-underscore.js', () => ({ markdownUnderscoreExt: {} }));
jest.unstable_mockModule('../../public/scripts/authors-note.js', () => stubExports([
    'initAuthorsNote', 'setFloatingPrompt', 'shouldWIAddPrompt',
], { NOTE_MODULE_NAME: '', metadata_keys: {} }));
jest.unstable_mockModule('../../public/scripts/PromptManager.js', () => ({ registerPromptManagerMigration: noop }));
jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s) => s,
    regex_placement: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/auto-continue-truncated.js', () => ({
    getAutoContinueOnTruncated: () => false,
    isTruncatedFinishReason: () => false,
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-retry.js', () => ({ withProfileRetry: asyncNoop }));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/request-timeout.js', () => ({ getRequestTimeoutMs: () => 0 }));
jest.unstable_mockModule('../../public/scripts/logprobs.js', () => ({ initLogprobs: noop, saveLogprobsForActiveMessage: noop }));
jest.unstable_mockModule('../../public/scripts/filters.js', () => ({ FILTER_STATES: {}, FILTER_TYPES: {}, FilterHelper: StubClass, isFilterState: () => false }));
jest.unstable_mockModule('../../public/scripts/cfg-scale.js', () => ({ getCfgPrompt: () => '', getGuidanceScale: () => 1, initCfg: noop }));
jest.unstable_mockModule('../../public/scripts/instruct-mode.js', () => stubExports([
    'formatInstructModeChat', 'formatInstructModePrompt', 'formatInstructModeExamples',
    'formatInstructModeStoryString', 'getInstructStoppingSequences',
], { force_output_sequence: {} }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ initLocales: asyncNoop, t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)) }));
jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => stubExports([
    'getFriendlyTokenizerName', 'getTokenCount', 'getTokenCountAsync',
    'initTokenizers', 'saveTokenCacheDebounced', 'flushTokenCacheSave',
]));
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
    'appendFileContent', 'hasPendingFileAttachment', 'populateFileAttachment', 'decodeStyleTags',
    'encodeStyleTags', 'hideChatMessageRange', 'isExternalMediaAllowed', 'preserveNeutralChat',
    'restoreNeutralChat', 'formatCreatorNotes', 'initChatUtilities', 'addDOMPurifyHooks',
]));
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
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: {},
    Popup: StubClass,
    callGenericPopup: asyncNoop,
    fixToastrForDialogs: noop,
}));
jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplate: () => '', renderTemplateAsync: asyncNoop }));
jest.unstable_mockModule('../../public/scripts/scrapers.js', () => ({ initScrapers: noop }));
jest.unstable_mockModule('../../public/scripts/samplerSelect.js', () => ({ initCustomSelectedSamplers: noop, validateDisabledSamplers: asyncNoop }));
jest.unstable_mockModule('../../public/scripts/dragdrop.js', () => ({ DragAndDropHandler: StubClass }));
jest.unstable_mockModule('../../public/scripts/keyboard.js', () => ({ INTERACTABLE_CONTROL_CLASS: '', initKeyboard: noop }));
jest.unstable_mockModule('../../public/scripts/dynamic-styles.js', () => ({ initDynamicStyles: noop }));
jest.unstable_mockModule('../../public/scripts/input-md-formatting.js', () => ({ initInputMarkdown: noop }));
jest.unstable_mockModule('../../public/scripts/sysprompt.js', () => ({ initSystemPrompts: noop }));
jest.unstable_mockModule('../../public/scripts/extensions-slashcommands.js', () => ({ registerExtensionSlashCommands: noop }));
jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({ ToolManager: {} }));
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
    'extractReasoningSignatureFromData', 'initReasoning', 'parseReasoningInSwipes', 'PromptReasoning',
    'registerReasoningSlashCommands', 'removeReasoningFromString', 'updateReasoningUI',
], { ReasoningHandler: StubClass, ReasoningType: {} }));
jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getState: () => ({}), init: noop },
}));
jest.unstable_mockModule('../../public/scripts/welcome-screen.js', () => stubExports([
    'fetchRecentChatsSnapshot', 'initWelcomeScreen', 'openPermanentAssistantChat',
    'openPermanentAssistantCard', 'getPermanentAssistantAvatar', 'openWelcomeScreen',
    'primeRecentChatsSnapshotPromise',
]));
jest.unstable_mockModule('../../public/scripts/data-maid.js', () => ({ initDataMaid: noop }));
jest.unstable_mockModule('../../public/scripts/itemized-prompts.js', () => stubExports([
    'clearItemizedPrompts', 'deleteItemizedPromptForMessage', 'deleteItemizedPrompts',
    'findItemizedPromptSet', 'flushItemizedPromptsSave', 'initItemizedPrompts', 'loadItemizedPrompts',
    'promptItemize', 'replaceItemizedPromptText', 'saveItemizedPrompts',
    'saveItemizedPromptsDebounced', 'swapItemizedPrompts',
], { itemizedParams: {}, itemizedPrompts: [] }));
jest.unstable_mockModule('../../public/scripts/system-messages.js', () => stubExports([
    'getSystemMessageByType', 'initSystemMessages', 'sendSystemMessage',
], { SAFETY_CHAT: '', system_message_types: {}, system_messages: {} }));
jest.unstable_mockModule('../../public/scripts/announcements.js', () => ({ initAnnouncements: noop }));
jest.unstable_mockModule('../../public/scripts/floor-state.js', () => stubExports([
    'settleChatChanged', 'settleMessageDeleted', 'settleMessageSwipeDeleted', 'settleMessageSwiped',
]));
jest.unstable_mockModule('../../public/scripts/a11y.js', () => ({ initAccessibility: noop }));
jest.unstable_mockModule('../../public/scripts/util/stream-fadein.js', () => ({ applyStreamFadeIn: noop }));
jest.unstable_mockModule('../../public/scripts/dom-handlers.js', () => ({ initDomHandlers: noop }));
jest.unstable_mockModule('../../public/scripts/audio-player.js', () => ({ AudioPlayer: StubClass }));
jest.unstable_mockModule('../../public/scripts/macros/engine/MacroEnvBuilder.js', () => ({ MacroEnvBuilder: StubClass }));
jest.unstable_mockModule('../../public/scripts/message-formatter.js', () => ({ MessageFormatter: StubClass }));
jest.unstable_mockModule('../../public/scripts/macros/engine/MacroEngine.js', () => ({ MacroEngine: StubClass }));
jest.unstable_mockModule('../../public/scripts/chat-backups.js', () => ({ addChatBackupsBrowser: noop }));
jest.unstable_mockModule('../../public/scripts/macros/engine/MacroDiagnostics.js', () => ({ onboardingExperimentalMacroEngine: noop }));
jest.unstable_mockModule('../../public/scripts/undo-toast.js', () => ({ showUndoToast: noop }));
jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({ setRequestCompressionConfig: noop }));
jest.unstable_mockModule('../../public/scripts/swipe-picker.js', () => ({
    canJumpToSwipeForMessage: () => false,
    canOpenSwipePickerForMessage: () => false,
    initSwipePicker: noop,
}));
jest.unstable_mockModule('../../public/scripts/self-profiler.js', () => ({ bootSelfProfilerFromStorage: noop }));
jest.unstable_mockModule('../../public/scripts/ws-delivery.js', () => ({
    createLukerDelivery: noop,
    installFetchProxy: noop,
    installFetchProxyForAllIframes: noop,
    installLifecycleHooks: noop,
}));
jest.unstable_mockModule('../../public/scripts/settings-resource-read.js', () => ({ loadSettingsEnvelope: asyncNoop }));
jest.unstable_mockModule('../../public/scripts/named-resource-read.js', () => ({
    listPresetDocuments: async () => [],
    loadPresetResources: async () => ({}),
    readPresetDocument: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/workbench/index.js', () => ({ initWorkbench: noop }));
jest.unstable_mockModule('../../public/scripts/util/fast-json-patch.js', () => ({
    applyPatch: applyJsonPatch,
    compare: compareJsonPatch,
}));
jest.unstable_mockModule('../../public/scripts/util/json-clone.js', () => ({ cloneAsJsonWire }));

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
globalThis.$.ajaxPrefilter = noop;
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: noop, removeItem: noop },
});

const scriptMod = await import('../../public/script.js');
const { saveSettings, getSettings } = scriptMod;
const { extension_settings } = await import('../../public/scripts/extensions.js');

describe('public/script.js saveSettings onSaved ack chain', () => {
    let origFetch;

    beforeAll(async () => {
        await getSettings({ payload: { result: 'file not find' } });
    });

    beforeEach(() => {
        origFetch = globalThis.fetch;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.toastr.error.mockClear();
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    test('invokes onSaved when /api/settings/save succeeds so saveSettingsChecked resolves', async () => {
        const calls = [];
        globalThis.fetch = jest.fn(async (url) => {
            calls.push(url);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        await expect(saveSettingsChecked({ saveSettings: (lc, opts) => saveSettings(lc, { ...opts, directSave: true }) }))
            .resolves.toBeUndefined();
        expect(calls).toEqual(['/api/settings/save']);
    });

    test('does not invoke onSaved when /api/settings/save returns 500 or throws, so saveSettingsChecked rejects', async () => {
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }));
        await expect(saveSettingsChecked({ saveSettings: (lc, opts) => saveSettings(lc, { ...opts, directSave: true }) }))
            .rejects.toMatchObject({ code: 'write-failed' });

        globalThis.fetch = jest.fn(async () => { throw new Error('network down'); });
        await expect(saveSettingsChecked({ saveSettings: (lc, opts) => saveSettings(lc, { ...opts, directSave: true }) }))
            .rejects.toMatchObject({ code: 'write-failed' });
    });

    test('chains multiple overlapping saveSettings onSaved callbacks through mergeSettingsSaveOptions', async () => {
        const deferred = [];
        const fetchUrls = [];
        globalThis.fetch = jest.fn((url) => {
            fetchUrls.push(url);
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            deferred.push({ resolve });
            return promise;
        });

        const order = [];
        const p1 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack1') });
        expect(fetchUrls).toHaveLength(1);

        // Overlapping saves while p1 is in flight queue into settingsSaveQueuedOptions
        extension_settings.wb_queued = { step: 2 };
        const p2 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack2') });
        extension_settings.wb_queued = { step: 3 };
        const p3 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack3') });

        // Second fetch has not fired while the first save is still in flight
        expect(fetchUrls).toHaveLength(1);

        // Complete first save -> ack1 fires, then queued drain triggers second fetch
        deferred[0].resolve({ ok: true, status: 200, statusText: 'OK' });
        await new Promise(r => setTimeout(r, 10));
        expect(order).toEqual(['ack1']);
        expect(fetchUrls).toHaveLength(2);

        // Complete queued save -> BOTH ack2 and ack3 fire via mergeSettingsSaveOptions
        deferred[1].resolve({ ok: true, status: 200, statusText: 'OK' });
        await Promise.all([p1, p2, p3]);
        expect(order).toEqual(['ack1', 'ack2', 'ack3']);
    });

    test('queued save failure does not invoke queued onSaved callbacks', async () => {
        const deferred = [];
        globalThis.fetch = jest.fn(() => {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            deferred.push({ resolve });
            return promise;
        });

        const order = [];
        const p1 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack1') });
        extension_settings.wb_queued_fail = { step: 2 };
        const p2 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack2') });
        const p3 = saveSettings(0, { directSave: true, onSaved: () => order.push('ack3') });

        deferred[0].resolve({ ok: true, status: 200, statusText: 'OK' });
        await new Promise(r => setTimeout(r, 10));
        expect(order).toEqual(['ack1']);

        deferred[1].resolve({ ok: false, status: 500, statusText: 'Server Error' });
        await Promise.all([p1, p2, p3]);
        expect(order).toEqual(['ack1']);
    });
});
