import {
    showdown,
    moment,
    DOMPurify,
    hljs,
    Handlebars,
    SVGInject,
    Popper,
    initLibraryShims,
    default as libs,
    lodash,
} from './lib.js';

import { humanizedDateTime, favsToHotswap, getMessageTimeStamp, dragElement, isMobile, initNavPanelPins, initRossMods, initSendTextareaState } from './scripts/RossAscends-mods.js';
import { userStatsHandler, statMesProcess, initStats } from './scripts/stats.js';
import {
    generateKoboldWithStreaming,
    hydrateKoboldPresetData,
    kai_settings,
    loadKoboldSettings,
    getKoboldGenerationData,
    kai_flags,
    koboldai_settings,
    koboldai_setting_names,
    initKoboldSettings,
} from './scripts/kai-settings.js';

import {
    hydrateTextGenPresetData,
    textgenerationwebui_settings as textgen_settings,
    loadTextGenSettings,
    generateTextGenWithStreaming,
    getTextGenGenerationData,
    textgen_types,
    parseTextgenLogprobs,
    parseTabbyLogprobs,
    initTextGenSettings,
} from './scripts/textgen-settings.js';

import {
    world_info,
    getWorldInfoPrompt,
    getWorldInfoSettings,
    setWorldInfoSettings,
    world_names,
    importEmbeddedWorldInfo,
    checkEmbeddedWorld,
    setWorldInfoButtonClass,
    wi_anchor_position,
    world_info_include_names,
    initWorldInfo,
    charUpdatePrimaryWorld,
    charSetAuxWorlds,
    deleteWorldInfoWithUndo,
} from './scripts/world-info.js';

import {
    groups,
    selected_group,
    saveGroupChat,
    getGroups,
    primeGroupsSnapshot,
    generateGroupWrapper,
    is_group_generating,
    resetSelectedGroup,
    select_group_chats,
    regenerateGroup,
    group_generation_id,
    getGroupChat,
    renameGroupMember,
    createNewGroupChat,
    editGroup,
    getGroupAvatar,
    deleteGroupChat,
    renameGroupChat,
    importGroupChat,
    getGroupBlock,
    getGroupCharacterCardsLazy,
    getGroupDepthPrompts,
} from './scripts/group-chats.js';

import {
    collapseNewlines,
    loadPowerUserSettings,
    playMessageSound,
    fixMarkdown,
    power_user,
    persona_description_positions,
    loadMovingUIState,
    getCustomStoppingStrings,
    MAX_CONTEXT_DEFAULT,
    MAX_RESPONSE_DEFAULT,
    renderStoryString,
    sortEntitiesList,
    registerDebugFunction,
    flushEphemeralStoppingStrings,
    resetMovableStyles,
    forceCharacterEditorTokenize,
    applyPowerUserSettings,
    generatedTextFiltered,
    applyStylePins,
    notifyMessageComplete,
    notifyMessageFailure,
    notifyMessageProgressStart,
    clearMessageProgressNotification,
} from './scripts/power-user.js';

import {
    setOpenAIMessageExamples,
    setOpenAIMessages,
    setupChatCompletionPromptManager,
    prepareOpenAIMessages,
    sendOpenAIRequest,
    isLastOpenAIReplyPersistedByServer,
    getLastOpenAIGenerationId,
    hydrateOpenAIPresetData,
    loadOpenAISettings,
    oai_settings,
    openai_messages_count,
    chat_completion_sources,
    getChatCompletionModel,
    proxies,
    loadProxyPresets,
    selected_proxy,
    bindCurrentChatCompletionPresetToCharacter,
    clearCharacterBoundChatCompletionPreset,
    initOpenAI,
} from './scripts/openai.js';

import {
    generateNovelWithStreaming,
    getNovelGenerationData,
    getKayraMaxContextTokens,
    hydrateNovelPresetData,
    loadNovelSettings,
    nai_settings,
    adjustNovelInstructionPrompt,
    parseNovelAILogprobs,
    novelai_settings,
    novelai_setting_names,
    initNovelAISettings,
} from './scripts/nai-settings.js';

import {
    initBookmarks,
    showBookmarksButtons,
    updateBookmarkDisplay,
} from './scripts/bookmarks.js';

import {
    horde_settings,
    loadHordeSettings,
    generateHorde,
    getStatusHorde,
    getHordeModels,
    adjustHordeGenerationParams,
    isHordeGenerationNotAllowed,
    MIN_LENGTH,
    initHorde,
} from './scripts/horde.js';

import {
    debounce,
    cancelDebounce,
    delay,
    trimToEndSentence,
    countOccurrences,
    isOdd,
    sortMoments,
    timestampToMoment,
    download,
    isDataURL,
    getCharaFilename,
    PAGINATION_TEMPLATE,
    waitUntilCondition,
    escapeRegex,
    resetScrollHeight,
    onlyUnique,
    getBase64Async,
    humanFileSize,
    Stopwatch,
    isValidUrl,
    ensureImageFormatSupported,
    flashHighlight,
    toggleDrawer,
    isElementInViewport,
    copyText,
    escapeHtml,
    saveBase64AsFile,
    uuidv4,
    equalsIgnoreCaseAndAccents,
    findCanonicalNameInList,
    localizePagination,
    renderPaginationDropdown,
    paginationDropdownChangeHandler,
    importFromExternalUrl,
    shiftUpByOne,
    shiftDownByOne,
    canUseNegativeLookbehind,
    trimSpaces,
    clamp,
    shakeElement,
    createTimeout,
} from './scripts/utils.js';
import { debounce_timeout, GENERATION_TYPE_TRIGGERS, IGNORE_SYMBOL, inject_ids, MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, OVERSWIPE_BEHAVIOR, SCROLL_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from './scripts/constants.js';

import { bootstrapExtensions, cancelDebouncedMetadataSave, doDailyExtensionUpdatesCheck, extension_settings, initExtensions, loadExtensionSettings, primeExtensionSettings, runGenerationInterceptors } from './scripts/extensions.js';
import { COMMENT_NAME_DEFAULT, CONNECT_API_MAP, consumeEphemeralScriptInjectsForMainGeneration, executeSlashCommandsOnChatInput, initDefaultSlashCommands, initSlashCommandAutoComplete, isExecutingCommandsFromChatInput, pauseScriptExecution, processChatSlashCommands, stopScriptExecution, UNIQUE_APIS } from './scripts/slash-commands.js';
import { initMacroAutoComplete } from './scripts/autocomplete/MacroAutoComplete.js';
import {
    tag_map,
    tags,
    filterByTagState,
    isBogusFolder,
    isBogusFolderOpen,
    chooseBogusFolder,
    getTagBlock,
    loadTagsSettings,
    printTagFilters,
    getTagKeyForEntity,
    printTagList,
    createTagMapFromList,
    renameTagKey,
    importTags,
    tag_filter_type,
    compareTagsForSort,
    initTags,
    applyTagsOnCharacterSelect,
    applyTagsOnGroupSelect,
    tag_import_setting,
    applyCharacterTagsToMessageDivs,
} from './scripts/tags.js';
import { initSecrets, primeSecretStateSnapshot, readSecretState } from './scripts/secrets.js';
import { markdownExclusionExt } from './scripts/showdown-exclusion.js';
import { markdownUnderscoreExt } from './scripts/showdown-underscore.js';
import { NOTE_MODULE_NAME, initAuthorsNote, metadata_keys, setFloatingPrompt, shouldWIAddPrompt } from './scripts/authors-note.js';
import { registerPromptManagerMigration } from './scripts/PromptManager.js';
import { getRegexedString, regex_placement } from './scripts/extensions/regex/engine.js';
import { initLogprobs, saveLogprobsForActiveMessage } from './scripts/logprobs.js';
import { FILTER_STATES, FILTER_TYPES, FilterHelper, isFilterState } from './scripts/filters.js';
import { getCfgPrompt, getGuidanceScale, initCfg } from './scripts/cfg-scale.js';
import {
    force_output_sequence,
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeExamples,
    formatInstructModeStoryString,
    getInstructStoppingSequences,
} from './scripts/instruct-mode.js';
import { initLocales, t } from './scripts/i18n.js';
import { getFriendlyTokenizerName, getTokenCount, getTokenCountAsync, initTokenizers, saveTokenCache } from './scripts/tokenizers.js';
import {
    user_avatar,
    getUserAvatars,
    getUserAvatar,
    setUserAvatar,
    primeUserAvatarsSnapshot,
    initPersonas,
    setPersonaDescription,
    initUserAvatar,
    updatePersonaConnectionsAvatarList,
    isPersonaPanelOpen,
} from './scripts/personas.js';
import { getBackgrounds, initBackgrounds, loadBackgroundSettings, background_settings } from './scripts/backgrounds.js';
import { hideLoader, isLoaderVisible, showLoader } from './scripts/loader.js';
import { loader } from './scripts/action-loader.js';
import { BulkEditOverlay } from './scripts/BulkEditOverlay.js';
import { initTextGenModels, initTextGenModelSelects } from './scripts/textgen-models.js';
import { appendFileContent, hasPendingFileAttachment, populateFileAttachment, decodeStyleTags, encodeStyleTags, hideChatMessageRange, isExternalMediaAllowed, preserveNeutralChat, restoreNeutralChat, formatCreatorNotes, initChatUtilities, addDOMPurifyHooks } from './scripts/chats.js';
import { getPresetManager, initPresetManager } from './scripts/preset-manager.js';
import { evaluateMacros, getLastMessageId, initMacros } from './scripts/macros.js';
import { installFrontendLogCapture, setFrontendConsoleDebugLoggingEnabled } from './scripts/frontend-log-manager.js';
import { currentUser, isAdmin, setUserControls } from './scripts/user.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup, fixToastrForDialogs } from './scripts/popup.js';
import { renderTemplate, renderTemplateAsync } from './scripts/templates.js';
import { initScrapers } from './scripts/scrapers.js';
import { initCustomSelectedSamplers, validateDisabledSamplers } from './scripts/samplerSelect.js';
import { DragAndDropHandler } from './scripts/dragdrop.js';
import { INTERACTABLE_CONTROL_CLASS, initKeyboard } from './scripts/keyboard.js';
import { initDynamicStyles } from './scripts/dynamic-styles.js';
import { initInputMarkdown } from './scripts/input-md-formatting.js';

import { AbortReason } from './scripts/util/AbortReason.js';
import { initSystemPrompts } from './scripts/sysprompt.js';
import { registerExtensionSlashCommands as initExtensionSlashCommands } from './scripts/extensions-slashcommands.js';
import { ToolManager } from './scripts/tool-calling.js';
import { addShowdownPatch } from './scripts/util/showdown-patch.js';
import { applyBrowserFixes } from './scripts/browser-fixes.js';
import { initServerHistory } from './scripts/server-history.js';
import { initSettingsSearch } from './scripts/setting-search.js';
import { initBulkEdit } from './scripts/bulk-edit.js';
import { getContext } from './scripts/st-context.js';
import { extractReasoningFromData, extractReasoningSignatureFromData, initReasoning, parseReasoningInSwipes, PromptReasoning, ReasoningHandler, removeReasoningFromString, updateReasoningUI } from './scripts/reasoning.js';
import { accountStorage } from './scripts/util/AccountStorage.js';
import { fetchRecentChatsSnapshot, initWelcomeScreen, openPermanentAssistantChat, openPermanentAssistantCard, getPermanentAssistantAvatar, openWelcomeScreen, primeRecentChatsSnapshotPromise } from './scripts/welcome-screen.js';
import { initDataMaid } from './scripts/data-maid.js';
import { clearItemizedPrompts, deleteItemizedPromptForMessage, deleteItemizedPrompts, findItemizedPromptSet, initItemizedPrompts, itemizedParams, itemizedPrompts, loadItemizedPrompts, promptItemize, replaceItemizedPromptText, saveItemizedPrompts, swapItemizedPrompts } from './scripts/itemized-prompts.js';
import { getSystemMessageByType, initSystemMessages, SAFETY_CHAT, sendSystemMessage, system_message_types, system_messages } from './scripts/system-messages.js';
import { event_types, eventSource } from './scripts/events.js';
import { initAccessibility } from './scripts/a11y.js';
import { applyStreamFadeIn } from './scripts/util/stream-fadein.js';
import { initDomHandlers } from './scripts/dom-handlers.js';
import { SimpleMutex } from './scripts/util/SimpleMutex.js';
import { applyPatch as applyJsonPatch, compare as compareJsonPatch } from './scripts/util/fast-json-patch.js';
import { AudioPlayer } from './scripts/audio-player.js';
import { MacroEnvBuilder } from './scripts/macros/engine/MacroEnvBuilder.js';
import { MacroEngine } from './scripts/macros/engine/MacroEngine.js';
import { addChatBackupsBrowser } from './scripts/chat-backups.js';
import { onboardingExperimentalMacroEngine } from './scripts/macros/engine/MacroDiagnostics.js';
import { showUndoToast } from './scripts/undo-toast.js';
import { compressRequest, setRequestCompressionConfig } from './scripts/request-compression.js';
import { canJumpToSwipeForMessage, canOpenSwipePickerForMessage, initSwipePicker } from './scripts/swipe-picker.js';

installFrontendLogCapture();

// API OBJECT FOR EXTERNAL WIRING
const lukerApi = {
    libs,
    getContext,
};
globalThis.Luker = lukerApi;
globalThis.st = lukerApi;
globalThis.SillyTavern = lukerApi;


export {
    user_avatar,
    setUserAvatar,
    getUserAvatars,
    getUserAvatar,
    nai_settings,
    isOdd,
    countOccurrences,
    renderTemplate,
    promptItemize,
    itemizedPrompts,
    saveItemizedPrompts,
    loadItemizedPrompts,
    itemizedParams,
    clearItemizedPrompts,
    replaceItemizedPromptText,
    deleteItemizedPrompts,
    findItemizedPromptSet,
    koboldai_settings,
    koboldai_setting_names,
    novelai_settings,
    novelai_setting_names,
    UNIQUE_APIS,
    CONNECT_API_MAP,
    system_messages,
    system_message_types,
    sendSystemMessage,
    getSystemMessageByType,
    event_types,
    eventSource,
    /** @deprecated Use setCharacterSettingsOverrides instead. */
    setCharacterSettingsOverrides as setScenarioOverride,
    /** @deprecated Use appendMediaToMessage instead. */
    appendMediaToMessage as appendImageToMessage,
    /** @deprecated Use getMaxPromptTokens instead. */
    getMaxPromptTokens as getMaxContextSize,
};

/**
 * Wait for page to load before continuing the app initialization.
 */
await new Promise((resolve) => {
    if (document.readyState === 'complete') {
        resolve();
    } else {
        window.addEventListener('load', resolve);
    }
});

// Configure toast library:
toastr.options = {
    positionClass: 'toast-top-center',
    closeButton: false,
    progressBar: false,
    showDuration: 250,
    hideDuration: 250,
    timeOut: 4000,
    extendedTimeOut: 10000,
    showEasing: 'linear',
    hideEasing: 'linear',
    showMethod: 'fadeIn',
    hideMethod: 'fadeOut',
    escapeHtml: true,
    onHidden: function () {
        // If we have any dialog still open, the last "hidden" toastr will remove the toastr-container. We need to keep it alive inside the dialog though
        // so the toasts still show up inside there.
        fixToastrForDialogs();
    },
};

// Run once during startup
toastr.subscribe(function (args) {
    if (args.state !== 'visible') {
        return;
    }

    const $container = toastr.getContainer(args.options, false);
    if (!$container || !$container.length) {
        return;
    }

    // toastr has already inserted the element at this point
    const $toast = args.options.newestOnTop
        ? $container.children().first()
        : $container.children().last();

    // Meaning of "clickable":
    // Interactable unless tapToDismiss was explicitly false
    const isInteractable = args.options.tapToDismiss !== false;
    $toast.toggleClass('interactable', isInteractable);
    if (isInteractable) {
        $toast.attr('title', t`Tap to close`);
    } else {
        $toast.removeAttr('title');
        $toast.addClass('toast-non-interactable');
    }
});

export const characterGroupOverlay = new BulkEditOverlay();

// Markdown converter
export let mesForShowdownParse; //intended to be used as a context to compare showdown strings against
/** @type {import('showdown').Converter} */
export let converter;

// array for prompt token calculations

export const systemUserName = 'Luker System';
export const neutralCharacterName = 'Assistant';
let default_user_name = 'User';
export let name1 = default_user_name;
export let name2 = systemUserName;
/** @type {ChatMessage[]} */
export let chat = [];
const chatServerState = {
    nextOlderIndex: 0,
    totalMessages: 0,
    hasMore: false,
};
let lukerRecoveryPollTimer = null;
let lukerRecoveryPollBusy = false;
let lukerRecoveryJobId = '';
let lukerRecoveryChatId = '';
const LUKER_RECOVERY_PREVIEW_ID = 'luker_generation_recovery_preview';
const LUKER_SERVER_PERSISTENCE_APIS = new Set(['openai', 'textgenerationwebui', 'kobold', 'novel']);
let lastLukerGenerationId = '';
let lastLukerReplyPersistedByServer = false;

function supportsLukerServerPersistence(api = main_api) {
    return LUKER_SERVER_PERSISTENCE_APIS.has(api);
}

function resetLukerGenerationState(api = main_api) {
    if (api === 'openai') {
        return;
    }
    lastLukerGenerationId = '';
    lastLukerReplyPersistedByServer = false;
}

function summarizeLukerPersistTargetForDebug(persistTarget) {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return null;
    }

    if (persistTarget.kind === 'group') {
        return {
            kind: 'group',
            id: String(persistTarget.id || ''),
        };
    }

    if (persistTarget.kind === 'character') {
        return {
            kind: 'character',
            avatar_url: String(persistTarget.avatar_url || ''),
            file_name: String(persistTarget.file_name || ''),
        };
    }

    return {
        kind: String(persistTarget.kind || ''),
    };
}

function summarizeLukerGenerationIdsForMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }

    return [...new Set(messages
        .map(message => String(message?.extra?.luker_generation_id || '').trim())
        .filter(Boolean))]
        .slice(0, 8);
}

function logLukerPersistenceDebug(api, phase, details = {}) {
    console.debug('[LukerPersist]', {
        api: String(api || main_api || ''),
        phase: String(phase || ''),
        ...details,
    });
}

function applyLukerGenerationMetaForApi(api = main_api, { generationId = '', persisted = undefined } = {}) {
    if (api === 'openai') {
        return;
    }
    if (typeof generationId === 'string' && generationId) {
        lastLukerGenerationId = generationId;
    }
    if (typeof persisted === 'boolean') {
        lastLukerReplyPersistedByServer = persisted;
    }
}

function applyLukerGenerationMetaFromHeaders(api, response) {
    if (!response || api === 'openai') {
        return;
    }
    const generationId = response.headers.get('x-luker-generation-id');
    const persistedHeader = response.headers.get('x-luker-server-persisted');
    const persisted = persistedHeader === '1' ? true : persistedHeader === '0' ? false : undefined;
    applyLukerGenerationMetaForApi(api, {
        generationId,
        persisted,
    });
    if (generationId || typeof persisted === 'boolean') {
        logLukerPersistenceDebug(api, 'response_header_meta', {
            generation_id: generationId || '',
            ...(typeof persisted === 'boolean' ? { persisted } : {}),
        });
    }
}

function getLastLukerGenerationIdForApi(api = main_api) {
    if (api === 'openai') {
        return getLastOpenAIGenerationId();
    }
    if (!supportsLukerServerPersistence(api)) {
        return '';
    }
    return lastLukerGenerationId;
}

function isLastLukerReplyPersistedByServerForApi(api = main_api) {
    if (api === 'openai') {
        return isLastOpenAIReplyPersistedByServer();
    }
    if (!supportsLukerServerPersistence(api)) {
        return false;
    }
    return lastLukerReplyPersistedByServer;
}

function shouldUseLukerServerPersistenceForType(type) {
    return type === 'normal' || type === 'regenerate';
}

function buildLukerGenerationRequestOptions(type, api = main_api) {
    if (!shouldUseLukerServerPersistenceForType(type) || !supportsLukerServerPersistence(api)) {
        return null;
    }

    const persistTarget = getLukerPersistTargetForCurrentChat();
    if (!persistTarget) {
        return null;
    }

    const generationId = uuidv4();
    applyLukerGenerationMetaForApi(api, { generationId, persisted: false });
    logLukerPersistenceDebug(api, 'request_init', {
        type,
        generation_id: generationId,
        persist_target: summarizeLukerPersistTargetForDebug(persistTarget),
    });
    return {
        job_id: generationId,
        persist_target: persistTarget,
    };
}

export function setChatServerState({ nextOlderIndex = 0, totalMessages = 0, hasMore = false } = {}) {
    chatServerState.nextOlderIndex = Math.max(0, Number(nextOlderIndex) || 0);
    chatServerState.totalMessages = Math.max(0, Number(totalMessages) || 0);
    chatServerState.hasMore = Boolean(hasMore);
}

function getLukerPersistTargetForCurrentChat() {
    if (selected_group) {
        const group = groups.find(x => x.id == selected_group);
        if (!group?.chat_id) {
            return null;
        }

        return {
            kind: 'group',
            id: group.chat_id,
            char_name: name2,
            chat_metadata: { ...chat_metadata },
            integrity: chat_metadata?.integrity,
        };
    }

    const character = characters[this_chid];
    if (!character?.avatar || !character?.chat) {
        return null;
    }

    return {
        kind: 'character',
        avatar_url: character.avatar,
        file_name: character.chat,
        char_name: name2,
        chat_metadata: { ...chat_metadata },
        integrity: chat_metadata?.integrity,
    };
}

function removeLukerRecoveryPreview() {
    chatElement.find(`#${LUKER_RECOVERY_PREVIEW_ID}`).remove();
}

function stopLukerGenerationRecovery() {
    if (lukerRecoveryPollTimer) {
        clearInterval(lukerRecoveryPollTimer);
        lukerRecoveryPollTimer = null;
    }
    lukerRecoveryPollBusy = false;
    lukerRecoveryJobId = '';
    lukerRecoveryChatId = '';
    removeLukerRecoveryPreview();
}

function renderLukerRecoveryPreview(text, status = 'running') {
    let preview = chatElement.find(`#${LUKER_RECOVERY_PREVIEW_ID}`);

    if (!preview.length) {
        preview = $(`
            <div id="${LUKER_RECOVERY_PREVIEW_ID}" class="wide100p" style="padding: 8px 12px; border: 1px dashed var(--SmartThemeBorderColor); border-radius: 8px; margin: 10px 0;">
                <div class="flex-container justifyCenter alignitemscenter" style="gap: 8px;">
                    <i class="fa-solid fa-link"></i>
                    <strong>Luker recovery stream</strong>
                </div>
                <div class="luker_preview_status" style="margin-top: 6px; opacity: 0.85; font-size: 0.9em;"></div>
                <div class="luker_preview_text" style="margin-top: 8px; white-space: pre-wrap;"></div>
            </div>
        `);
        chatElement.append(preview);
    }

    const statusText = status === 'failed'
        ? t`Generation failed on server`
        : status === 'completed'
            ? t`Generation completed on server`
            : status === 'awaiting_ack'
                ? t`Waiting for client save confirmation`
                : status === 'persisting'
                    ? t`Persisting generation on server`
                    : t`Generation in progress on server`;
    preview.find('.luker_preview_status').text(statusText);
    preview.find('.luker_preview_text').text(String(text || ''));
}

async function startLukerGenerationRecovery() {
    stopLukerGenerationRecovery();

    const persistTarget = getLukerPersistTargetForCurrentChat();
    if (!persistTarget) {
        return;
    }

    const chatIdSnapshot = getCurrentChatId();

    try {
        const activeResponse = await fetch('/api/backends/chat-completions/jobs/active', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ persist_target: persistTarget }),
            cache: 'no-cache',
        });

        if (!activeResponse.ok) {
            return;
        }

        const activeData = await activeResponse.json();
        const activeJob = Array.isArray(activeData?.jobs) ? activeData.jobs[0] : null;
        if (!activeJob?.id) {
            return;
        }

        lukerRecoveryJobId = String(activeJob.id);
        lukerRecoveryChatId = chatIdSnapshot;
        renderLukerRecoveryPreview(activeJob.text || '', activeJob.status || 'running');

        lukerRecoveryPollTimer = setInterval(async () => {
            if (lukerRecoveryPollBusy) {
                return;
            }

            if (lukerRecoveryChatId !== getCurrentChatId()) {
                stopLukerGenerationRecovery();
                return;
            }

            lukerRecoveryPollBusy = true;
            try {
                const statusResponse = await fetch('/api/backends/chat-completions/jobs/status', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ id: lukerRecoveryJobId }),
                    cache: 'no-cache',
                });

                if (!statusResponse.ok) {
                    stopLukerGenerationRecovery();
                    return;
                }

                const statusData = await statusResponse.json();
                renderLukerRecoveryPreview(statusData?.text || '', statusData?.status || 'running');

                if (statusData?.status === 'failed') {
                    stopLukerGenerationRecovery();
                    return;
                }

                if (statusData?.status === 'completed') {
                    stopLukerGenerationRecovery();
                    await reloadCurrentChat();
                }
            } catch (error) {
                console.warn('Failed to poll recovered generation status', error);
            } finally {
                lukerRecoveryPollBusy = false;
            }
        }, 1000);
    } catch (error) {
        console.warn('Failed to query active generation jobs', error);
    }
}

/**
 * @type {import('./scripts/constants.js').SWIPE_STATE}
 */
export let swipeState = SWIPE_STATE.NONE;
let chatSaveTimeout;
let importFlashTimeout;
export let isChatSaving = false;
let firstRun = false;
export let settingsReady = false;
let currentVersion = '0.0.0';
export let displayVersion = 'Luker';

let generation_started = new Date();
/** @type {Character[]} */
export let characters = [];
let primedCharacters = null;
/**
 * Stringified index of a currently chosen entity in the characters array.
 * @type {string|undefined} Yes, we hate it as much as you do.
 */
export let this_chid;
let saveCharactersPage = 0;
export const default_avatar = 'img/ai4.png';
export const system_avatar = 'img/five.png';
export const comment_avatar = 'img/quill.png';
export const default_user_avatar = 'img/user-default.png';
export let CLIENT_VERSION = 'Luker:UNKNOWN:Cohee#1207'; // For Horde header
export let EXTENSIONS_CLIENT_VERSION = 'Luker:1.15.0:Cohee#1207';
let optionsPopper = Popper.createPopper(document.getElementById('options_button'), document.getElementById('options'), {
    placement: 'top-start',
});
let exportPopper = Popper.createPopper(document.getElementById('export_button'), document.getElementById('export_format_popup'), {
    placement: 'left',
});
let isExportPopupOpen = false;
let isImmersiveModeEnabled = false;
let immersiveModeUsesFullscreen = false;
let androidFullscreenShimInstalled = false;
let androidFullscreenElement = null;

function setElementStylePriority(element, property, value, priority = '') {
    if (!(element instanceof HTMLElement)) {
        return;
    }
    if (value === null || value === undefined || value === '') {
        element.style.removeProperty(property);
        return;
    }
    element.style.setProperty(property, String(value), priority);
}

function applyImmersiveLayoutOverrides(enabled) {
    if (!isRunningInLukerAndroidApp()) {
        return;
    }
    const sheld = document.getElementById('sheld');
    const chatContainer = document.getElementById('chat');
    const shouldEnable = Boolean(enabled);
    if (shouldEnable) {
        setElementStylePriority(sheld, 'top', '0', 'important');
        // In Android WebView immersive mode, 100dvh can lag during IME transitions.
        // Use container-relative height so layout follows native insets immediately.
        setElementStylePriority(sheld, 'height', 'calc(100% - 1px)', 'important');
        setElementStylePriority(sheld, 'max-height', 'calc(100% - 1px)', 'important');
        setElementStylePriority(chatContainer, 'max-height', 'calc(100% - var(--bottomFormBlockSize))', 'important');
        return;
    }
    setElementStylePriority(sheld, 'top', '');
    setElementStylePriority(sheld, 'height', '');
    setElementStylePriority(sheld, 'max-height', '');
    setElementStylePriority(chatContainer, 'max-height', '');
}

function isRunningInLukerAndroidApp() {
    return typeof window !== 'undefined'
        && typeof window.LukerAndroid === 'object';
}

function canUseAndroidImmersiveBridge() {
    return isRunningInLukerAndroidApp()
        && typeof window.LukerAndroid.setImmersiveModeEnabled === 'function';
}

function syncAndroidImmersiveMode(enabled) {
    if (!canUseAndroidImmersiveBridge()) {
        return;
    }
    try {
        window.LukerAndroid.setImmersiveModeEnabled(Boolean(enabled));
    } catch (error) {
        console.warn('Failed to sync Android immersive mode', error);
    }
}

function getFullscreenElement() {
    if (isRunningInLukerAndroidApp()) {
        return androidFullscreenElement;
    }
    return document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || document.msFullscreenElement
        || null;
}

function dispatchFullscreenChangeEvent() {
    const eventNames = [
        'fullscreenchange',
        'webkitfullscreenchange',
        'mozfullscreenchange',
        'MSFullscreenChange',
    ];
    for (const name of eventNames) {
        document.dispatchEvent(new Event(name));
    }
}

function setAndroidFullscreenState(enabled, element = null) {
    if (!isRunningInLukerAndroidApp()) {
        return;
    }
    const nextElement = enabled ? (element || document.documentElement) : null;
    const changed = androidFullscreenElement !== nextElement;
    androidFullscreenElement = nextElement;
    if (changed) {
        dispatchFullscreenChangeEvent();
    }
}

function definePropertyIfPossible(target, propertyName, descriptor) {
    if (!target) {
        return;
    }
    try {
        Object.defineProperty(target, propertyName, descriptor);
    } catch {
        // Ignore non-configurable built-ins on some WebView builds.
    }
}

function overrideMethodIfPossible(target, methodName, replacement) {
    if (!target || typeof replacement !== 'function') {
        return;
    }
    try {
        Object.defineProperty(target, methodName, {
            configurable: true,
            writable: true,
            value: replacement,
        });
    } catch {
        // Ignore non-configurable built-ins on some WebView builds.
    }
}

function installAndroidFullscreenApiShim() {
    if (!isRunningInLukerAndroidApp() || androidFullscreenShimInstalled) {
        return;
    }

    androidFullscreenShimInstalled = true;
    const doc = /** @type {any} */ (document);
    const elementProto = /** @type {any} */ (Element.prototype);

    const requestShim = function () {
        setAndroidFullscreenState(true, this);
        void setImmersiveMode(true, { useFullscreen: false });
        return Promise.resolve();
    };

    const exitShim = function () {
        setAndroidFullscreenState(false, null);
        void setImmersiveMode(false, { useFullscreen: false });
        return Promise.resolve();
    };

    overrideMethodIfPossible(elementProto, 'requestFullscreen', requestShim);
    overrideMethodIfPossible(elementProto, 'webkitRequestFullscreen', requestShim);
    overrideMethodIfPossible(elementProto, 'mozRequestFullScreen', requestShim);
    overrideMethodIfPossible(elementProto, 'msRequestFullscreen', requestShim);

    overrideMethodIfPossible(doc, 'exitFullscreen', exitShim);
    overrideMethodIfPossible(doc, 'webkitExitFullscreen', exitShim);
    overrideMethodIfPossible(doc, 'mozCancelFullScreen', exitShim);
    overrideMethodIfPossible(doc, 'msExitFullscreen', exitShim);

    definePropertyIfPossible(doc, 'fullscreenEnabled', {
        configurable: true,
        get: () => true,
    });
    definePropertyIfPossible(doc, 'webkitFullscreenEnabled', {
        configurable: true,
        get: () => true,
    });
    definePropertyIfPossible(doc, 'mozFullScreenEnabled', {
        configurable: true,
        get: () => true,
    });
    definePropertyIfPossible(doc, 'msFullscreenEnabled', {
        configurable: true,
        get: () => true,
    });

    definePropertyIfPossible(doc, 'fullscreenElement', {
        configurable: true,
        get: () => androidFullscreenElement,
    });
    definePropertyIfPossible(doc, 'webkitFullscreenElement', {
        configurable: true,
        get: () => androidFullscreenElement,
    });
    definePropertyIfPossible(doc, 'mozFullScreenElement', {
        configurable: true,
        get: () => androidFullscreenElement,
    });
    definePropertyIfPossible(doc, 'msFullscreenElement', {
        configurable: true,
        get: () => androidFullscreenElement,
    });
}

function canUseFullscreenApi() {
    if (isRunningInLukerAndroidApp()) {
        return false;
    }

    const doc = /** @type {any} */ (document);
    const root = /** @type {any} */ (document.documentElement);
    return Boolean(
        doc.fullscreenEnabled
        || doc.webkitFullscreenEnabled
        || doc.mozFullScreenEnabled
        || doc.msFullscreenEnabled
        || typeof root.requestFullscreen === 'function'
        || typeof root.webkitRequestFullscreen === 'function'
        || typeof root.mozRequestFullScreen === 'function'
        || typeof root.msRequestFullscreen === 'function',
    );
}

async function requestImmersiveFullscreen() {
    if (!canUseFullscreenApi() || getFullscreenElement()) {
        return;
    }
    const root = /** @type {any} */ (document.documentElement);
    const request =
        root.requestFullscreen
        || root.webkitRequestFullscreen
        || root.mozRequestFullScreen
        || root.msRequestFullscreen;
    if (typeof request !== 'function') {
        return;
    }
    try {
        await request.call(root);
    } catch (error) {
        console.debug('Immersive fullscreen request was rejected', error);
    }
}

async function exitImmersiveFullscreen() {
    if (!getFullscreenElement()) {
        return;
    }
    const doc = /** @type {any} */ (document);
    const exit =
        doc.exitFullscreen
        || doc.webkitExitFullscreen
        || doc.mozCancelFullScreen
        || doc.msExitFullscreen;
    if (typeof exit !== 'function') {
        return;
    }
    try {
        await exit.call(doc);
    } catch (error) {
        console.debug('Immersive fullscreen exit was rejected', error);
    }
}

function updateImmersiveModeUi() {
    const toggle = $('#immersive_mode_toggle');
    const icon = $('#immersiveModeIcon');
    const label = $('#immersiveModeLabel');
    const translationKey = isImmersiveModeEnabled ? 'Exit immersive mode' : 'Enter immersive mode';
    const title = isImmersiveModeEnabled ? t`Exit immersive mode` : t`Enter immersive mode`;

    if (!icon.length && !toggle.length) {
        return;
    }

    icon
        .toggleClass('fa-expand', !isImmersiveModeEnabled)
        .toggleClass('fa-compress', isImmersiveModeEnabled)
        .attr('title', title);

    if (icon.hasClass('drawer-icon')) {
        icon
            .toggleClass('closedIcon', !isImmersiveModeEnabled)
            .toggleClass('openIcon', isImmersiveModeEnabled);
    }

    toggle
        .attr('data-i18n', `[title]${translationKey}`)
        .attr('title', title)
        .attr('aria-pressed', String(isImmersiveModeEnabled));

    if (label.length) {
        label.attr('data-i18n', translationKey);
        label.text(title);
    }
}

async function onImmersiveFullscreenChanged() {
    updateImmersiveModeUi();
    if (!immersiveModeUsesFullscreen) {
        return;
    }
    if (!getFullscreenElement() && isImmersiveModeEnabled) {
        await setImmersiveMode(false, { useFullscreen: false });
    }
}

async function setImmersiveMode(enabled, { useFullscreen = true } = {}) {
    const shouldEnable = Boolean(enabled);
    immersiveModeUsesFullscreen = shouldEnable ? Boolean(useFullscreen && canUseFullscreenApi()) : false;
    isImmersiveModeEnabled = shouldEnable;
    setAndroidFullscreenState(shouldEnable, document.documentElement);
    document.body.classList.toggle('luker-immersive-mode', shouldEnable);
    syncAndroidImmersiveMode(shouldEnable);
    applyImmersiveLayoutOverrides(shouldEnable);
    updateImmersiveModeUi();

    if (shouldEnable) {
        if (useFullscreen) {
            await requestImmersiveFullscreen();
        }
        return;
    }

    if (useFullscreen) {
        await exitImmersiveFullscreen();
    }
}

async function toggleImmersiveMode() {
    await setImmersiveMode(!isImmersiveModeEnabled);
}

if (typeof window !== 'undefined') {
    installAndroidFullscreenApiShim();
    window.__lukerSetImmersiveModeFromNative = (enabled) => {
        void setImmersiveMode(Boolean(enabled), { useFullscreen: false });
    };
}

// Saved here for performance reasons
const messageTemplate = $('#message_template .mes');
export const chatElement = $('#chat');

let dialogueResolve = null;
let dialogueCloseStop = false;
/** @type {ChatMetadata} */
export let chat_metadata = {};
const chatMetadataSnapshotCache = new Map();
const chatMessageSnapshotCache = new Map();
/** @type {StreamingProcessor} */
export let streamingProcessor = null;
let crop_data = undefined;
let is_delete_mode = false;
let fav_ch_checked = false;
let scrollLock = false;
export let abortStatusCheck = new AbortController();
export let charDragDropHandler = null;
export let chatDragDropHandler = null;

/** @type {debounce_timeout} The debounce timeout used for chat/settings save. debounce_timeout.long: 1.000 ms */
export const DEFAULT_SAVE_EDIT_TIMEOUT = debounce_timeout.relaxed;
/** @type {debounce_timeout} The debounce timeout used for printing. debounce_timeout.quick: 100 ms */
export const DEFAULT_PRINT_TIMEOUT = debounce_timeout.quick;

export const saveSettingsDebounced = debounce((loopCounter = 0, options = undefined) => saveSettings(loopCounter, options), DEFAULT_SAVE_EDIT_TIMEOUT);
export const saveCharacterDebounced = debounce(() => $('#create_button').trigger('click'), DEFAULT_SAVE_EDIT_TIMEOUT);

/**
 * Prints the character list in a debounced fashion without blocking, with a delay of 100 milliseconds.
 * Use this function instead of a direct `printCharacters()` whenever the reprinting of the character list is not the primary focus.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 */
export const printCharactersDebounced = debounce(() => { printCharacters(false); }, DEFAULT_PRINT_TIMEOUT);
let isCharacterDeletionInProgress = false;

/**
 * @enum {number} Extension prompt types
 */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/**
 * @enum {number} Extension prompt roles
 */
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export const MAX_INJECTION_DEPTH = 10000;

async function getClientVersion() {
    try {
        const response = await fetch('/version');
        const data = await response.json();
        CLIENT_VERSION = data.agent;
        EXTENSIONS_CLIENT_VERSION = data.compatAgent || data.agent || EXTENSIONS_CLIENT_VERSION;
        displayVersion = `Luker ${data.pkgVersion}`;
        currentVersion = data.pkgVersion;

        if (data.gitRevision && data.gitBranch) {
            displayVersion += ` '${data.gitBranch}' (${data.gitRevision})`;
        }

        $('#version_display').text(displayVersion);
        $('#version_display_welcome').text(displayVersion);

        maybeNotifyLukerUpdate(data);
    } catch (err) {
        console.error('Couldn\'t get client version', err);
    }
}

function maybeNotifyLukerUpdate(versionData) {
    if (!versionData || versionData.isLatest !== false) {
        return;
    }

    if (versionData.isDocker === true) {
        if (lukerUpdatePromptShown) {
            return;
        }
        lukerUpdatePromptShown = true;
        toastr.info(
            t`A Luker update is available for this Docker deployment. Pull the latest image and recreate the container to update.`,
            t`Update Available`,
            {
                timeOut: 0,
                extendedTimeOut: 0,
                closeButton: true,
                preventDuplicates: true,
            },
        );
        return;
    }

    void showLukerUpdatePrompt(versionData);
}

let lukerUpdatePromptShown = false;

function hasAndroidUpdateBridge() {
    return typeof window !== 'undefined'
        && typeof window.LukerAndroid === 'object'
        && typeof window.LukerAndroid.installApkFromUrl === 'function';
}

async function callLukerUpdateApi(path, payload = {}) {
    const response = await fetch(`/api/users/update/${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const errorData = await response.json();
            message = String(errorData?.error || errorData?.message || message);
        } catch {
            // Keep fallback message.
        }
        throw new Error(message);
    }

    if (response.status === 204) {
        return null;
    }

    return await response.json();
}

function formatUpdateLogLine(entry) {
    const timestamp = Number(entry?.timestamp);
    const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : '--:--:--';
    return `[${time}] ${String(entry?.message || '').trim()}`;
}

async function showUpdateProgressPopup(title, runner) {
    const template = $(`
        <div class="justifyLeft">
            <div class="menu_button_note lukerUpdateStatus"></div>
            <textarea class="text_pole lukerUpdateLogs" rows="16" readonly></textarea>
        </div>
    `);

    const statusElement = template.find('.lukerUpdateStatus');
    const logsElement = template.find('.lukerUpdateLogs');
    const pushLog = (line) => {
        const text = String(line ?? '').trim();
        if (!text) {
            return;
        }
        const previous = String(logsElement.val() || '');
        const next = previous ? `${previous}\n${text}` : text;
        logsElement.val(next);
        logsElement.scrollTop(logsElement[0]?.scrollHeight || 0);
    };
    const setStatus = (text) => {
        statusElement.text(String(text || ''));
    };

    let canClose = false;
    let flowError = null;
    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        cancelButton: false,
        wide: true,
        large: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        onOpen: (instance) => {
            instance.okButton.classList.add('disabled');
            instance.okButton.style.pointerEvents = 'none';
        },
        onClosing: () => canClose,
    });

    const popupPromise = popup.show();
    void (async () => {
        try {
            await runner({ pushLog, setStatus });
        } catch (error) {
            flowError = error;
            setStatus(t`Update failed.`);
            pushLog(String(error?.message || error));
        } finally {
            canClose = true;
            popup.okButton.classList.remove('disabled');
            popup.okButton.style.pointerEvents = '';
        }
    })();

    await popupPromise;
    if (flowError) {
        throw flowError;
    }
}

function getGitUpdateStatusLabel(status) {
    switch (status) {
        case 'running':
            return t`Updating repository...`;
        case 'succeeded':
            return t`Update completed.`;
        case 'failed':
            return t`Update failed.`;
        default:
            return t`Preparing update...`;
    }
}

async function runServerGitUpdateFlow() {
    let finalState = null;
    await showUpdateProgressPopup(t`Luker Update`, async ({ pushLog, setStatus }) => {
        setStatus(t`Submitting update request...`);
        try {
            const startResult = await callLukerUpdateApi('start', {});
            if (startResult?.started) {
                pushLog(t`Update task started.`);
            }
        } catch (error) {
            const conflict = String(error?.message || '').toLowerCase().includes('already_running');
            if (!conflict) {
                throw error;
            }
            pushLog(t`An update task is already running. Attaching to the current task...`);
        }

        let sinceId = 0;
        while (true) {
            const payload = await callLukerUpdateApi('status', { sinceId, limit: 600 });
            const gitState = payload?.git;
            if (!gitState) {
                throw new Error(t`Update status payload is invalid.`);
            }

            finalState = gitState;
            setStatus(getGitUpdateStatusLabel(String(gitState.status || 'idle')));

            const logs = Array.isArray(gitState.logs) ? gitState.logs : [];
            for (const entry of logs) {
                const id = Number(entry?.id);
                if (Number.isFinite(id)) {
                    sinceId = Math.max(sinceId, id);
                }
                pushLog(formatUpdateLogLine(entry));
            }

            if (!gitState.running && ['succeeded', 'failed', 'idle'].includes(String(gitState.status || ''))) {
                break;
            }

            await delay(1000);
        }

        if (!finalState || finalState.status === 'failed') {
            throw new Error(String(finalState?.lastError || t`Update failed.`));
        }
    });

    if (!finalState) {
        throw new Error(t`Update finished without status.`);
    }

    if (finalState.status === 'succeeded' && finalState.restartRecommended) {
        await Popup.show.text(
            t`Manual Restart Required`,
            t`The update has been applied. Please restart your backend process manually to use the new version.`,
        );
        return;
    }

    if (finalState.status === 'succeeded') {
        const updated = finalState.updated === true;
        toastr.success(
            updated ? t`Luker update completed.` : t`Luker is already up to date.`,
            t`Luker Update`,
        );
    }
}

async function runAndroidApkUpdateFlow() {
    if (!hasAndroidUpdateBridge()) {
        throw new Error(t`Android update bridge is unavailable.`);
    }

    await showUpdateProgressPopup(t`Luker App Update`, async ({ pushLog, setStatus }) => {
        setStatus(t`Fetching latest APK release...`);
        const release = await callLukerUpdateApi('apk-latest', {});
        const apkName = String(release?.apk?.name || '');
        const apkUrl = String(release?.apk?.url || '');
        const tagName = String(release?.tagName || '');

        if (!apkName || !apkUrl) {
            throw new Error(t`Latest release does not include a valid APK asset.`);
        }

        pushLog(tagName ? `${t`Release`}: ${tagName}` : t`Release metadata loaded.`);
        pushLog(`${t`APK`}: ${apkName}`);
        setStatus(t`Starting APK download...`);
        window.LukerAndroid.installApkFromUrl(apkUrl, apkName);
        pushLog(t`APK download started. Android will open the installer when the download finishes.`);
        setStatus(t`Installer handoff started.`);
    });
}

async function showLukerUpdatePrompt(versionData) {
    if (lukerUpdatePromptShown) {
        return;
    }
    lukerUpdatePromptShown = true;

    try {
        const branch = String(versionData.gitBranch || '').trim();
        const revision = String(versionData.gitRevision || '').trim();
        const environmentText = hasAndroidUpdateBridge()
            ? t`This instance is running inside the Android app.`
            : t`This instance is running in Node.js server mode.`;
        const branchText = branch ? `${branch}${revision ? ` @ ${revision}` : ''}` : t`unknown branch`;
        const promptBody = `
            <div class="justifyLeft">
                <div>${t`A Luker update is available.`}</div>
                <div class="menu_button_note">${environmentText}</div>
                <div class="menu_button_note">${t`Current source`}: ${branchText}</div>
            </div>
        `;

        const result = await callGenericPopup(promptBody, POPUP_TYPE.CONFIRM, '', {
            okButton: hasAndroidUpdateBridge() ? t`Download Update` : t`Update Now`,
            cancelButton: t`Later`,
            wide: true,
            large: false,
            leftAlign: true,
        });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        if (hasAndroidUpdateBridge()) {
            await runAndroidApkUpdateFlow();
        } else {
            await runServerGitUpdateFlow();
        }
    } catch (error) {
        console.error('Luker update flow failed:', error);
        toastr.error(String(error?.message || error), t`Luker Update`);
    }
}

export function reloadMarkdownProcessor() {
    converter = new showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
        extensions: [markdownUnderscoreExt()],
    });

    // Inject the dinkus extension after creating the converter
    // Maybe move this into power_user init?
    converter.addExtension(markdownExclusionExt(), 'exclusion');

    return converter;
}

export function getCurrentChatId() {
    if (selected_group) {
        return groups.find(x => x.id == selected_group)?.chat_id;
    } else if (this_chid !== undefined) {
        return characters[this_chid]?.chat;
    }
}

export const talkativeness_default = 0.5;
export const depth_prompt_depth_default = 4;
export const depth_prompt_role_default = 'system';
const per_page_default = 50;

var is_advanced_char_open = false;

/**
 * The type of the right menu
 * @typedef {'characters' | 'character_edit' | 'create' | 'group_edit' | 'group_create' | '' } MenuType
 */

/**
 * The type of the right menu that is currently open
 * @type {MenuType}
 */
export let menu_type = '';

export let selected_button = ''; //which button pressed

//create pole save
export let create_save = {
    name: '',
    description: '',
    creator_notes: '',
    post_history_instructions: '',
    character_version: '',
    system_prompt: '',
    tags: '',
    creator: '',
    personality: '',
    first_message: '',
    /** @type {FileList|null} */
    avatar: null,
    scenario: '',
    mes_example: '',
    world: '',
    talkativeness: talkativeness_default,
    alternate_greetings: [],
    depth_prompt_prompt: '',
    depth_prompt_depth: depth_prompt_depth_default,
    depth_prompt_role: depth_prompt_role_default,
    extensions: {},
    extra_books: [],
};

//animation right menu
export const ANIMATION_DURATION_DEFAULT = 125;
export let animation_duration = ANIMATION_DURATION_DEFAULT;
export let animation_easing = 'ease-in-out';
let popup_type = '';
export let online_status = 'no_connection';

export let is_send_press = false; //Send generation
export const isGenerating = () => (is_send_press || is_group_generating);
let isSendTextareaComposing = false;
let pendingUserInputText = null;
let activeWorldInfoPromptSnapshot = {
    chatId: '',
    worldInfoBeforeEntries: [],
    worldInfoAfterEntries: [],
};

let this_del_mes = -1;

/** @type {string} */
let this_edit_mes_chname = '';
/** @type {number|undefined} */
let this_edit_mes_id = undefined;

//settings
export let settings;
let settingsSnapshotCache = null;
let settingsSaveInFlight = null;
let settingsSaveQueued = false;
let settingsSaveQueuedOptions = null;
let forceAsyncDiffForNextSettingsSave = false;
let forceAsyncDiffForNextSettingsSaveTimer = null;
let fullSettingsLoaded = false;
let fullSettingsLoadPromise = null;
export let amount_gen = 80; //default max length of AI generated responses
export let max_context = 2048;

/** User preference for swipeable messages */
let swipes = true;
/** Forcefully hide swipes. */
export let swipesHidden = false;
/** @type {{ now: number, direction: string }} */
export let lastSwipeInfo = { now: performance.now(), direction: SWIPE_DIRECTION.RIGHT };
export let recentSwipes = 0;

export let extension_prompts = {};

export let main_api;// = "kobold";
let abortController = new AbortController();

//css
var css_send_form_display = $('<div id=send_form></div>').css('display');

var kobold_horde_model = '';

export let token;


/** The tag of the active character. (NOT the id) */
export let active_character = '';
/** The tag of the active group. (Coincidentally also the id) */
export let active_group = '';

export const entitiesFilter = new FilterHelper(printCharactersDebounced);

export function getRequestHeaders({ omitContentType = false } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    };

    if (omitContentType) {
        delete headers['Content-Type'];
    }

    return headers;
}

export function getSlideToggleOptions() {
    return {
        miliseconds: animation_duration * 1.5,
        transitionFunction: animation_duration > 0 ? 'ease-in-out' : 'step-start',
    };
}

$.ajaxPrefilter((options, originalOptions, xhr) => {
    xhr.setRequestHeader('X-CSRF-Token', token);
});

/**
 * Pings the STserver to check if it is reachable.
 * @returns {Promise<boolean>} True if the server is reachable, false otherwise.
 */
export async function pingServer() {
    try {
        const result = await fetch('api/ping', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!result.ok) {
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error pinging server', error);
        return false;
    }
}

//MARK: firstLoadInit
async function firstLoadInit() {
    installSettingsGetRequestInterceptor();

    try {
        const tokenResponse = await fetch('/csrf-token');
        const tokenData = await tokenResponse.json();
        token = tokenData.token;
    } catch {
        toastr.error(t`Couldn't get CSRF token. Please refresh the page.`, t`Error`, { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true });
        throw new Error('Initialization failed');
    }

    showLoader();
    const clientVersionPromise = getClientVersion();
    const bootstrapPromise = fetchBootstrapSnapshot();
    registerPromptManagerMigration();
    initDomHandlers();
    initStandaloneMode();
    initLibraryShims();
    addShowdownPatch(showdown);
    addDOMPurifyHooks();
    reloadMarkdownProcessor();
    applyBrowserFixes();
    await clientVersionPromise;
    await initSecrets();
    const bootstrapSnapshot = await bootstrapPromise;
    if (bootstrapSnapshot?.secret_state) {
        primeSecretStateSnapshot(bootstrapSnapshot.secret_state);
    }
    await readSecretState();
    await initLocales();
    initChatUtilities();
    initDefaultSlashCommands();
    initTextGenModels();
    initOpenAI();
    initTextGenSettings();
    initKoboldSettings();
    initNovelAISettings();
    initSystemPrompts();
    await getSettings({ bootstrap: true, payload: bootstrapSnapshot?.settings });
    primeRecentChatsSnapshotPromise(fetchRecentChatsSnapshot());
    initWelcomeScreen();
    initKeyboard();
    initDynamicStyles();
    initNavPanelPins();
    initSendTextareaState();
    restoreCharacterSearchVisibility();

    if (isLoaderVisible()) {
        await hideLoader();
    }
    await fixViewport();
    await yieldToBrowser();
    await initPresetManager();

    if (bootstrapSnapshot) {
        primeUserAvatarsSnapshot(bootstrapSnapshot.avatars);
        primeGroupsSnapshot(bootstrapSnapshot.groups);
        primeCharactersSnapshot(bootstrapSnapshot.characters);
    }

    await runStartupTasks([
        () => initTags(),
        () => initBookmarks(),
        () => initBackgrounds(),
        () => initAuthorsNote(),
        () => getUserAvatars(true, user_avatar),
        () => getCharacters(),
    ]);
    await yieldToBrowser();

    const shouldAutoloadCurrentChat = Boolean(power_user.auto_load_chat && (active_character || active_group));
    if (!shouldAutoloadCurrentChat) {
        await openWelcomeScreen({ force: true });
        await yieldToBrowser();
    }

    await runStartupTasks([
        () => initTextGenModelSelects(),
        () => initSystemMessages(),
        () => initExtensions(),
        () => bootstrapExtensions(),
        () => initExtensionSlashCommands(),
        () => ToolManager.initToolSlashCommands(),
        () => initTokenizers(),
        () => initPersonas(),
        () => initSlashCommandAutoComplete(),
        () => loadMacroAutoCompleteModule().then(({ initMacroAutoComplete }) => initMacroAutoComplete()),
    ]);
    await yieldToBrowser();

    await runStartupTasks([
        () => initWorldInfo(),
        () => initHorde(),
        () => initRossMods(),
        () => initStats(),
        () => initCfg(),
        () => initLogprobs(),
        () => initInputMarkdown(),
        () => initServerHistory(),
        () => initSettingsSearch(),
        () => initBulkEdit(),
        () => initReasoning(),
        () => initScrapers(),
        () => initCustomSelectedSamplers(),
        () => initDataMaid(),
        () => initItemizedPrompts(),
        () => initAccessibility(),
        () => addDebugFunctions(),
        () => doDailyExtensionUpdatesCheck(),
    ]);
    await eventSource.emit(event_types.APP_READY);
}

async function fixViewport() {
    document.body.style.position = 'absolute';
    await delay(1);
    document.body.style.position = '';
}

function runStartupTasks(tasks) {
    return tasks.reduce(
        (chain, task) => chain.then(() => task()),
        Promise.resolve(),
    );
}

async function yieldToBrowser() {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await delay(0);
}

let macroAutoCompleteModulePromise;

function loadMacroAutoCompleteModule() {
    return macroAutoCompleteModulePromise ??= import('./scripts/autocomplete/MacroAutoComplete.js');
}

function initStandaloneMode() {
    const isPwaMode = window.matchMedia('(display-mode: standalone)').matches;
    if (isPwaMode) {
        $('body').addClass('PWA');
    }
}

export function cancelStatusCheck(reason = 'Manually cancelled status check') {
    abortStatusCheck?.abort(new AbortReason(reason));
    abortStatusCheck = new AbortController();
    setOnlineStatus('no_connection');
}

export function displayOnlineStatus() {
    if (online_status == 'no_connection') {
        $('.online_status_indicator').removeClass('success');
        $('.online_status_text').text($('#API-status-top').attr('no_connection_text'));
    } else {
        $('.online_status_indicator').addClass('success');
        $('.online_status_text').text(online_status);
    }
}

/**
 * Sets the duration of JS animations.
 * @param {number} ms Duration in milliseconds. Resets to default if null.
 */
export function setAnimationDuration(ms = null) {
    animation_duration = ms ?? ANIMATION_DURATION_DEFAULT;
    // Set CSS variable to document
    document.documentElement.style.setProperty('--animation-duration', `${animation_duration}ms`);
}

/**
 * Sets the currently active character
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active character is reset to `null`.
 */
export function setActiveCharacter(entityOrKey) {
    active_character = entityOrKey ? getTagKeyForEntity(entityOrKey) : null;
    if (active_character) active_group = null;
}

/**
 * Sets the currently active group.
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active group is reset to `null`.
 */
export function setActiveGroup(entityOrKey) {
    active_group = entityOrKey ? getTagKeyForEntity(entityOrKey) : null;
    if (active_group) active_character = null;
}

export function startStatusLoading() {
    $('.api_loading').show();
    $('.api_button').addClass('disabled');
}

export function stopStatusLoading() {
    $('.api_loading').hide();
    $('.api_button').removeClass('disabled');
}

export function resultCheckStatus() {
    displayOnlineStatus();
    stopStatusLoading();
}

/**
 * Switches the currently selected character to the one with the given ID. (character index, not the character key!)
 *
 * If the character ID doesn't exist, if the chat is being saved, or if a group is being generated, this function does nothing.
 * If the character is different from the currently selected one, it will clear the chat and reset any selected character or group.
 * @param {number} id The ID of the character to switch to.
 * @param {object} [options] Options for the switch.
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the character edit menu if the character is already selected.
 * @returns {Promise<void>} A promise that resolves when the character is switched.
 */
export async function selectCharacterById(id, { switchMenu = true } = {}) {
    if (characters[id] === undefined) {
        return;
    }

    if (shouldBlockChatSwitchWhileSaving()) {
        toastr.info(t`Please wait until the chat is saved before switching characters.`, t`Your chat is still saving...`);
        return;
    }

    if (selected_group && is_group_generating) {
        return;
    }

    if (selected_group || String(this_chid) !== String(id)) {
        //if clicked on a different character from what was currently selected
        if (!is_send_press) {
            setCharacterId(undefined);
            setCharacterName('');
            resetSelectedGroup();
            await clearChat({ clearData: true });
            cancelTtsPlay();
            this_edit_mes_id = undefined;
            selected_button = 'character_edit';
            setCharacterId(id);
            chat_metadata = {};
            await getChat();
        }
    } else {
        //if clicked on character that was already selected
        switchMenu && (selected_button = 'character_edit');
        await unshallowCharacter(this_chid);
        select_selected_character(this_chid, { switchMenu });
    }
}

function getBackBlock() {
    const template = $('#bogus_folder_back_template .bogus_folder_select').clone();
    return template;
}

async function getEmptyBlock() {
    const icons = ['fa-dragon', 'fa-otter', 'fa-kiwi-bird', 'fa-crow', 'fa-frog'];
    const texts = [t`Here be dragons`, t`Otterly empty`, t`Kiwibunga`, t`Pump-a-Rum`, t`Croak it`];
    const roll = new Date().getMinutes() % icons.length;
    const params = {
        text: texts[roll],
        icon: icons[roll],
    };
    const emptyBlock = await renderTemplateAsync('emptyBlock', params);
    return $(emptyBlock);
}

/**
 * @param {number} hidden Number of hidden characters
 */
async function getHiddenBlock(hidden) {
    const params = {
        text: (hidden > 1 ? t`${hidden} characters hidden.` : t`${hidden} character hidden.`),
    };
    const hiddenBlock = await renderTemplateAsync('hiddenBlock', params);
    return $(hiddenBlock);
}

function getCharacterBlock(item, id) {
    const itemName = getCharacterName(item);
    const isFavorite = isCharacterFavorite(item);
    let this_avatar = default_avatar;
    if (item.avatar != 'none') {
        this_avatar = getThumbnailUrl('avatar', item.avatar);
    }
    // Populate the template
    const template = $('#character_template .character_select').clone();
    template.attr({ 'data-chid': id, 'id': `CharID${id}` });
    template.find('img').attr('src', this_avatar).attr('alt', itemName);
    template.find('.avatar').attr('title', `[Character] ${itemName}\nFile: ${item.avatar}`);
    template.find('.ch_name').text(itemName).attr('title', `[Character] ${itemName}`);
    if (power_user.show_card_avatar_urls) {
        template.find('.ch_avatar_url').text(item.avatar);
    }
    template.find('.ch_fav_icon').css('display', 'none');
    template.toggleClass('is_fav', isFavorite);
    template.find('.ch_fav').val(String(isFavorite));

    const isAssistant = item.avatar === getPermanentAssistantAvatar();
    if (!isAssistant) {
        template.find('.ch_assistant').remove();
    }

    const description = getCharacterCreatorNotes(item);
    if (description) {
        template.find('.ch_description').text(description);
    } else {
        template.find('.ch_description').hide();
    }

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (item.data && item.data[auxFieldName]) || '';
    if (auxFieldValue) {
        template.find('.character_version').text(auxFieldValue);
    } else {
        template.find('.character_version').hide();
    }

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: id, tagOptions: { isCharacterList: true } });

    // Add to the list
    return template;
}

/**
 * Prints the global character list, optionally doing a full refresh of the list
 * Use this function whenever the reprinting of the character list is the primary focus, otherwise using `printCharactersDebounced` is preferred for a cleaner, non-blocking experience.
 *
 * The printing will also always reprint all filter options of the global list, to keep them up to date.
 *
 * @param {boolean} fullRefresh - If true, the list is fully refreshed and the navigation is being reset
 */
export async function printCharacters(fullRefresh = false) {
    const storageKey = 'Characters_PerPage';
    const listId = '#rm_print_characters_block';

    let currentScrollTop = $(listId).scrollTop();

    if (fullRefresh) {
        saveCharactersPage = 0;
        currentScrollTop = 0;
        await delay(1);
    }

    // Before printing the personas, we check if we should enable/disable search sorting
    verifyCharactersSearchSortRule();

    // We are actually always reprinting filters, as it "doesn't hurt", and this way they are always up to date
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_members_list);
    printTagFilters(tag_filter_type.group_candidates_list);

    // We are also always reprinting the lists on character/group edit window, as these ones doesn't get updated otherwise
    applyTagsOnCharacterSelect();
    applyTagsOnGroupSelect();

    const entities = getEntitiesList({ doFilter: true });

    const pageSize = Number(accountStorage.getItem(storageKey)) || per_page_default;
    const sizeChangerOptions = [10, 25, 50, 100, 250, 500, 1000];
    $('#rm_print_characters_pagination').pagination({
        dataSource: entities,
        pageSize,
        pageRange: 1,
        pageNumber: saveCharactersPage || 1,
        position: 'top',
        showPageNumbers: false,
        showSizeChanger: true,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
        showNavigator: true,
        callback: async function (/** @type {Entity[]} */ data) {
            $(listId).empty();
            if (power_user.bogus_folders && isBogusFolderOpen()) {
                $(listId).append(getBackBlock());
            }
            if (!data.length) {
                const emptyBlock = await getEmptyBlock();
                $(listId).append(emptyBlock);
            }
            let displayCount = 0;
            for (const i of data) {
                switch (i.type) {
                    case 'character':
                        $(listId).append(getCharacterBlock(i.item, i.id));
                        displayCount++;
                        break;
                    case 'group':
                        $(listId).append(getGroupBlock(i.item));
                        displayCount++;
                        break;
                    case 'tag':
                        $(listId).append(getTagBlock(i.item, i.entities, i.hidden, i.isUseless));
                        break;
                }
            }

            const hidden = (characters.length + groups.length) - displayCount;
            if (hidden > 0 && entitiesFilter.hasAnyFilter()) {
                const hiddenBlock = await getHiddenBlock(hidden);
                $(listId).append(hiddenBlock);
            }
            localizePagination($('#rm_print_characters_pagination'));

            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
        },
        afterSizeSelectorChange: function (e, size) {
            accountStorage.setItem(storageKey, e.target.value);
            paginationDropdownChangeHandler(e, size);
        },
        afterPaging: function (e) {
            saveCharactersPage = e;
        },
        afterRender: function () {
            $(listId).scrollTop(currentScrollTop);
        },
    });

    favsToHotswap();
    updatePersonaConnectionsAvatarList();
}

/** Checks the state of the current search, and adds/removes the search sorting option accordingly */
function verifyCharactersSearchSortRule() {
    const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH);
    const searchOption = $('#character_sort_order option[data-field="search"]');
    const selector = $('#character_sort_order');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        searchOption.prop('selected', true);
        flashHighlight(selector);
    }
    // If search got cleared, we make sure to hide the option and go back to the one before
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        $(`#character_sort_order option[data-order="${power_user.sort_order}"][data-field="${power_user.sort_field}"]`).prop('selected', true);
    }
}

/**
 * @typedef {object} Entity - Object representing a display entity
 * @property {Character|Group|import('./scripts/tags.js').Tag|*} item - The item
 * @property {string|number} id - The id
 * @property {'character'|'group'|'tag'} type - The type of this entity (character, group, tag)
 * @property {Entity[]?} [entities=null] - An optional list of entities relevant for this item
 * @property {number?} [hidden=null] - An optional number representing how many hidden entities this entity contains
 * @property {boolean?} [isUseless=null] - Specifies if the entity is useless (not relevant, but should still be displayed for consistency) and should be displayed greyed out
 */

/**
 * Converts the given character to its entity representation
 *
 * @param {Character} character - The character
 * @param {string|number} id - The id of this character
 * @returns {Entity} The entity for this character
 */
export function characterToEntity(character, id) {
    return { item: character, id, type: 'character' };
}

/**
 * Converts the given group to its entity representation
 *
 * @param {Group} group - The group
 * @returns {Entity} The entity for this group
 */
export function groupToEntity(group) {
    return { item: group, id: group.id, type: 'group' };
}

/**
 * Converts the given tag to its entity representation
 *
 * @param {import('./scripts/tags.js').Tag} tag - The tag
 * @returns {Entity} The entity for this tag
 */
export function tagToEntity(tag) {
    return { item: structuredClone(tag), id: tag.id, type: 'tag', entities: [] };
}

/**
 * Builds the full list of all entities available
 *
 * They will be correctly marked and filtered.
 *
 * @param {object} param0 - Optional parameters
 * @param {boolean} [param0.doFilter] - Whether this entity list should already be filtered based on the global filters
 * @param {boolean} [param0.doSort] - Whether the entity list should be sorted when returned
 * @returns {Entity[]} All entities
 */
export function getEntitiesList({ doFilter = false, doSort = true } = {}) {
    let entities = [
        ...characters.map((item, index) => characterToEntity(item, index)),
        ...groups.map(item => groupToEntity(item)),
        ...(power_user.bogus_folders ? tags.filter(isBogusFolder).sort(compareTagsForSort).map(item => tagToEntity(item)) : []),
    ];

    // We need to do multiple filter runs in a specific order, otherwise different settings might override each other
    // and screw up tags and search filter, sub lists or similar.
    // The specific filters are written inside the "filterByTagState" method and its different parameters.
    // Generally what we do is the following:
    //   1. First swipe over the list to remove the most obvious things
    //   2. Build sub entity lists for all folders, filtering them similarly to the second swipe
    //   3. We do the last run, where global filters are applied, and the search filters last

    // First run filters, that will hide what should never be displayed
    if (doFilter) {
        entities = filterByTagState(entities);
    }

    // Run over all entities between first and second filter to save some states
    for (const entity of entities) {
        // For folders, we remember the sub entities so they can be displayed later, even if they might be filtered
        // Those sub entities should be filtered and have the search filters applied too
        if (entity.type === 'tag') {
            let subEntities = filterByTagState(entities, { subForEntity: entity, filterHidden: false });
            const subCount = subEntities.length;
            subEntities = filterByTagState(entities, { subForEntity: entity });
            if (doFilter) {
                // sub entities filter "hacked" because folder filter should not be applied there, so even in "only folders" mode characters show up
                subEntities = entitiesFilter.applyFilters(subEntities, { clearScoreCache: false, tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
            }
            if (doSort) {
                sortEntitiesList(subEntities, false);
            }
            entity.entities = subEntities;
            entity.hidden = subCount - subEntities.length;
        }
    }

    // Second run filters, hiding whatever should be filtered later
    if (doFilter) {
        const beforeFinalEntities = filterByTagState(entities, { globalDisplayFilters: true });
        entities = entitiesFilter.applyFilters(beforeFinalEntities, { clearFuzzySearchCaches: false });

        // Magic for folder filter. If that one is enabled, and no folders are display anymore, we remove that filter to actually show the characters.
        if (isFilterState(entitiesFilter.getFilterData(FILTER_TYPES.FOLDER), FILTER_STATES.SELECTED) && entities.filter(x => x.type == 'tag').length == 0) {
            entities = entitiesFilter.applyFilters(beforeFinalEntities, { tempOverrides: { [FILTER_TYPES.FOLDER]: FILTER_STATES.UNDEFINED }, clearFuzzySearchCaches: false });
        }
    }

    // Final step, updating some properties after the last filter run
    const nonTagEntitiesCount = entities.filter(entity => entity.type !== 'tag').length;
    for (const entity of entities) {
        if (entity.type === 'tag') {
            if (entity.entities?.length == nonTagEntitiesCount) entity.isUseless = true;
        }
    }

    // Sort before returning if requested
    if (doSort) {
        sortEntitiesList(entities, false);
    }
    entitiesFilter.clearFuzzySearchCaches();
    return entities;
}

export async function getOneCharacter(avatarUrl) {
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatarUrl,
        }),
    });

    if (response.ok) {
        const getData = await response.json();
        getData.name = DOMPurify.sanitize(getData.name);
        getData.chat = String(getData.chat);

        const indexOf = characters.findIndex(x => x.avatar === avatarUrl);

        if (indexOf !== -1) {
            characters[indexOf] = getData;
        } else {
            console.warn(`Character ${avatarUrl} not found in the list; skip in-place refresh.`);
        }
    }
}

export function getCharacterSource(chId = this_chid) {
    const character = characters[chId];

    if (!character) {
        return '';
    }

    const chubId = characters[chId]?.data?.extensions?.chub?.full_path;

    if (chubId) {
        return `https://chub.ai/characters/${chubId}`;
    }

    const pygmalionId = characters[chId]?.data?.extensions?.pygmalion_id;

    if (pygmalionId) {
        return `https://pygmalion.chat/${pygmalionId}`;
    }

    const githubRepo = characters[chId]?.data?.extensions?.github_repo;

    if (githubRepo) {
        return `https://github.com/${githubRepo}`;
    }

    const sourceUrl = characters[chId]?.data?.extensions?.source_url;

    if (sourceUrl) {
        return sourceUrl;
    }

    const risuId = characters[chId]?.data?.extensions?.risuai?.source;

    if (Array.isArray(risuId) && risuId.length && typeof risuId[0] === 'string' && risuId[0].startsWith('risurealm:')) {
        const realmId = risuId[0].split(':')[1];
        return `https://realm.risuai.net/character/${realmId}`;
    }

    const perchanceSlug = characters[chId]?.data?.extensions?.perchance_data?.slug;

    if (perchanceSlug) {
        return `https://perchance.org/ai-character-chat?data=${perchanceSlug}`;
    }

    return '';
}

export async function getCharacters() {
    const primedCharacterPayload = primedCharacters;
    primedCharacters = null;

    /** @type {Character[] | null} */
    let getData = Array.isArray(primedCharacterPayload) ? primedCharacterPayload : null;

    if (!getData) {
        const response = await fetch('/api/characters/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            console.error('Failed to fetch characters:', response.statusText);
            const errorData = await response.json().catch(() => null);
            if (errorData?.overflow) {
                await Popup.show.text(t`Character data length limit reached`, t`To resolve this, set "performance.lazyLoadCharacters" to "true" in config.yaml and restart the server.`);
            }
            return;
        }

        getData = await response.json();
    }

    if (Array.isArray(getData)) {
        const previousAvatar = this_chid !== undefined ? characters[this_chid]?.avatar : null;
        characters.splice(0, characters.length);
        for (let i = 0; i < getData.length; i++) {
            characters[i] = getData[i];
            characters[i].name = DOMPurify.sanitize(characters[i].name);

            // For dropped-in cards
            if (!characters[i].chat) {
                characters[i].chat = `${characters[i].name} - ${humanizedDateTime()}`;
            }

            characters[i].chat = String(characters[i].chat);
        }

        if (previousAvatar) {
            const newCharacterId = characters.findIndex(x => x.avatar === previousAvatar);
            if (newCharacterId >= 0) {
                setCharacterId(newCharacterId);
                await selectCharacterById(newCharacterId, { switchMenu: false });
            } else {
                await Popup.show.text(t`ERROR: The active character is no longer available.`, t`The page will be refreshed to prevent data loss. Press "OK" to continue.`);
                return location.reload();
            }
        }

        await getGroups();
        await printCharacters(true);
    }
}

async function getReplacementCharacterChatName(character) {
    const chatsResponse = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar }),
    });
    const chats = Object.values(await chatsResponse.json());
    chats.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));
    return chats.length && typeof chats[0] === 'object'
        ? chats[0].file_name.replace('.jsonl', '')
        : `${getCharacterName(character)} - ${humanizedDateTime()}`;
}

async function getRawCharacterChatSnapshot(characterId, fileName) {
    await unshallowCharacter(characterId);

    const character = characters[characterId];
    if (!character) {
        return null;
    }

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            ch_name: getCharacterName(character),
            file_name: fileName,
            avatar_url: character.avatar,
        }),
    });

    if (!response.ok) {
        return null;
    }

    const data = await response.json();
    return Array.isArray(data) ? structuredClone(data) : null;
}

async function restoreCharacterChatSnapshot(characterId, fileName, chatFile) {
    await unshallowCharacter(characterId);

    const character = characters[characterId];
    if (!character || !Array.isArray(chatFile)) {
        return false;
    }

    const response = await fetch('/api/chats/save', {
        method: 'POST',
        cache: 'no-cache',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: getCharacterName(character),
            file_name: fileName,
            chat: structuredClone(chatFile),
            avatar_url: character.avatar,
            force: true,
        }),
    });

    return response.ok;
}

function decodeBase64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

async function getCharacterDeletionUndoSnapshot(characterId, { includeChats = false, wasCurrentCharacter = false } = {}) {
    await unshallowCharacter(characterId);

    const character = characters[characterId];
    if (!character?.avatar) {
        return null;
    }

    const snapshotResponse = await fetch('/api/characters/snapshot', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({ avatar_url: character.avatar }),
    });

    if (!snapshotResponse.ok) {
        return null;
    }

    const snapshotData = await snapshotResponse.json();
    if (!snapshotData?.card) {
        return null;
    }

    const chats = [];
    if (includeChats) {
        const pastChats = await getPastCharacterChats(characterId);
        for (const chatInfo of pastChats) {
            const fileName = String(chatInfo?.file_name || '').trim().replace(/\.jsonl$/i, '');
            if (!fileName) {
                continue;
            }

            const chatData = await getRawCharacterChatSnapshot(characterId, fileName);
            if (Array.isArray(chatData)) {
                chats.push({ fileName, chat: structuredClone(chatData) });
            }
        }
    }

    return {
        avatarUrl: character.avatar,
        characterName: String(getCharacterName(character) || ''),
        cardBase64: String(snapshotData.card),
        states: Array.isArray(snapshotData.states) ? structuredClone(snapshotData.states) : [],
        chats,
        hadTagMap: Object.hasOwn(tag_map, character.avatar),
        tagMap: structuredClone(tag_map[character.avatar] || []),
        accountStorage: {
            worldInfoAlert: accountStorage.getItem(`AlertWI_${character.avatar}`),
            regexAlert: accountStorage.getItem(`AlertRegex_${character.avatar}`),
            mediaWarning: accountStorage.getItem(`mediaWarningShown:${character.avatar}`),
        },
        wasCurrentCharacter,
    };
}

function restoreDeletedCharacterAccountStorage(snapshot) {
    const avatarUrl = String(snapshot?.avatarUrl || '').trim();
    if (!avatarUrl) {
        return;
    }

    const storageEntries = [
        [`AlertWI_${avatarUrl}`, snapshot?.accountStorage?.worldInfoAlert],
        [`AlertRegex_${avatarUrl}`, snapshot?.accountStorage?.regexAlert],
        [`mediaWarningShown:${avatarUrl}`, snapshot?.accountStorage?.mediaWarning],
    ];

    for (const [key, value] of storageEntries) {
        if (value === null || value === undefined || value === '') {
            accountStorage.removeItem(key);
        } else {
            accountStorage.setItem(key, String(value));
        }
    }
}

async function restoreDeletedCharacterSnapshot(snapshot, { refreshCharacters = true } = {}) {
    const avatarUrl = String(snapshot?.avatarUrl || '').trim();
    if (!avatarUrl || !snapshot?.cardBase64) {
        return false;
    }

    let importedAvatarUrl = '';
    try {
        const cardFile = new File([decodeBase64ToBytes(snapshot.cardBase64)], avatarUrl, { type: 'image/png' });
        importedAvatarUrl = await importCharacter(cardFile, { preserveFileName: avatarUrl, suppressToast: true });
        if (!importedAvatarUrl) {
            return false;
        }

        for (const state of snapshot.states || []) {
            const namespace = String(state?.namespace || '').trim();
            if (!namespace || !state?.data || typeof state.data !== 'object' || Array.isArray(state.data)) {
                continue;
            }

            const response = await fetch('/api/characters/state/set', {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify({
                    avatar_url: avatarUrl,
                    namespace,
                    data: structuredClone(state.data),
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to restore character state sidecar: ${namespace}`);
            }
        }

        for (const chatSnapshot of snapshot.chats || []) {
            const fileName = String(chatSnapshot?.fileName || '').trim();
            if (!fileName || !Array.isArray(chatSnapshot?.chat)) {
                continue;
            }

            const response = await fetch('/api/chats/save', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: snapshot.characterName,
                    file_name: fileName,
                    chat: structuredClone(chatSnapshot.chat),
                    avatar_url: avatarUrl,
                    force: true,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to restore character chat: ${fileName}`);
            }
        }

        if (snapshot.hadTagMap) {
            tag_map[avatarUrl] = structuredClone(snapshot.tagMap);
        } else {
            delete tag_map[avatarUrl];
        }

        restoreDeletedCharacterAccountStorage(snapshot);
        requestAsyncDiffForNextSettingsSave();
        saveSettingsDebounced();
        if (refreshCharacters) {
            await getCharacters();
        }
        return true;
    } catch (error) {
        console.error('Failed to restore deleted character', error);
        if (importedAvatarUrl) {
            try {
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    cache: 'no-cache',
                    body: JSON.stringify({
                        avatar_url: avatarUrl,
                        delete_chats: Array.isArray(snapshot?.chats) && snapshot.chats.length > 0,
                    }),
                });
            } catch (cleanupError) {
                console.error('Failed to clean up partially restored character', cleanupError);
            }
        }
        if (refreshCharacters) {
            await getCharacters().catch(() => undefined);
        }
        return false;
    }
}

async function commitDeletedCharacterUndoSnapshot(snapshot) {
    if (!snapshot) {
        return;
    }

    for (const chatName of snapshot.deletedChatNames || []) {
        await eventSource.emit(event_types.CHAT_DELETED, chatName);
    }

    if (snapshot.deletedEvent) {
        await eventSource.emit(event_types.CHARACTER_DELETED, snapshot.deletedEvent);
    }
}

async function restoreDeletedCharacterUndoSnapshots(snapshots) {
    const snapshotList = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
    const restoredSnapshots = [];
    const failedSnapshots = [];

    for (const snapshot of snapshotList) {
        const restored = await restoreDeletedCharacterSnapshot(snapshot, { refreshCharacters: false });
        if (restored) {
            restoredSnapshots.push(snapshot);
        } else {
            failedSnapshots.push(snapshot);
        }
    }

    if (restoredSnapshots.length > 0) {
        await getCharacters();
    }

    for (const snapshot of failedSnapshots) {
        await commitDeletedCharacterUndoSnapshot(snapshot);
    }

    const currentCharacterSnapshot = restoredSnapshots.find(snapshot => snapshot.wasCurrentCharacter);
    if (currentCharacterSnapshot && !selected_group && this_chid === undefined) {
        const restoredCharacterId = characters.findIndex(entry => entry.avatar === currentCharacterSnapshot.avatarUrl);
        if (restoredCharacterId >= 0) {
            await selectCharacterById(restoredCharacterId);
        }
    }

    return { restoredSnapshots, failedSnapshots };
}

async function refreshVisibleDeletedChatViews(fileName = '') {
    if ($('#select_chat_popup').is(':visible')) {
        await displayPastChats(fileName ? [fileName] : []);
    }

    if (document.querySelector('#chat .welcomePanel')) {
        await openWelcomeScreen({ force: true });
    }
}

async function deleteCharacterChatInternal(characterId, fileName) {
    await unshallowCharacter(characterId);

    /** @type {Character} */
    const character = characters[characterId];
    if (!character) {
        console.warn(`Character with ID ${characterId} not found.`);
        return false;
    }

    const rawChatSnapshot = await getRawCharacterChatSnapshot(characterId, fileName);
    const previousSelectedChat = String(character.chat || '');
    const deletedCurrentChat = previousSelectedChat === fileName;

    const response = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chatfile: `${fileName}.jsonl`,
            avatar_url: character.avatar,
        }),
    });

    if (!response.ok) {
        console.error('Failed to delete chat for character.');
        return false;
    }

    if (deletedCurrentChat) {
        if (Number(characterId) === Number(this_chid)) {
            chat_metadata = {};
            await replaceCurrentChat();
        } else {
            const newChatName = await getReplacementCharacterChatName(character);
            await updateRemoteChatName(characterId, newChatName);
        }
    }

    const replacementChatName = String(character.chat || '');

    if (!Array.isArray(rawChatSnapshot)) {
        toastr.success(t`Chat deleted.`);
        await eventSource.emit(event_types.CHAT_DELETED, fileName);
        return true;
    }

    showUndoToast({
        message: t`Chat deleted.`,
        onUndo: async () => {
            const restored = await restoreCharacterChatSnapshot(characterId, fileName, rawChatSnapshot);
            if (!restored) {
                toastr.error(t`Failed to restore chat.`);
                return;
            }

            if (deletedCurrentChat) {
                if (Number(characterId) !== Number(this_chid)) {
                    await updateRemoteChatName(characterId, fileName);
                } else if (String(character.chat || '') === replacementChatName) {
                    await updateRemoteChatName(characterId, fileName);
                    await openCharacterChat(fileName);
                }
            }

            await refreshVisibleDeletedChatViews(fileName);
        },
        onCommit: async () => {
            await eventSource.emit(event_types.CHAT_DELETED, fileName);
        },
    });

    return true;
}

async function delChat(chatfile) {
    const fileName = String(chatfile || '').replace(/\.jsonl$/i, '');
    if (!fileName) {
        return false;
    }

    return await deleteCharacterChatInternal(String(this_chid), fileName);
}

/**
 * Deletes a character chat by its name.
 * @param {string} characterId Character ID to delete chat for
 * @param {string} fileName Name of the chat file to delete (without .jsonl extension)
 * @returns {Promise<void>} A promise that resolves when the chat is deleted.
 */
export async function deleteCharacterChatByName(characterId, fileName) {
    return await deleteCharacterChatInternal(String(characterId), fileName);
}

export async function replaceCurrentChat() {
    await clearChat({ clearData: true });

    const chatsResponse = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: characters[this_chid].avatar }),
    });

    if (chatsResponse.ok) {
        const chats = Object.values(await chatsResponse.json());
        chats.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));

        if (chats.length && typeof chats[0] === 'object') {
            // pick existing chat
            characters[this_chid].chat = chats[0].file_name.replace('.jsonl', '');
            $('#selected_chat_pole').val(characters[this_chid].chat);
            await updateRemoteChatName(this_chid, characters[this_chid].chat);
            await getChat();
        } else {
            // start new chat
            characters[this_chid].chat = `${name2} - ${humanizedDateTime()}`;
            $('#selected_chat_pole').val(characters[this_chid].chat);
            await updateRemoteChatName(this_chid, characters[this_chid].chat);
            await getChat();
        }
    }
}

export async function showMoreMessages(messagesToLoad = null) {
    const showMoreButton = $('#show_more_messages');
    const firstDisplayedMesId = chatElement.children('.mes').first().attr('mesid');
    let messageId = Number(firstDisplayedMesId);
    let count = messagesToLoad || power_user.chat_truncation || Number.MAX_SAFE_INTEGER;

    // If there are no messages displayed, or the message somehow has no mesid, we default to one higher than last message id,
    // so the first "new" message being shown will be the last available message
    if (isNaN(messageId)) {
        messageId = getLastMessageId() + 1;
    }

    if (messageId <= 0 && chatServerState.hasMore) {
        const prevHeight = chatElement.prop('scrollHeight');
        const isButtonInView = isElementInViewport($('#show_more_messages')[0]);
        const startIndex = Math.max(0, chatServerState.nextOlderIndex - count);
        const limit = Math.max(1, chatServerState.nextOlderIndex - startIndex);
        const endpoint = selected_group ? '/api/chats/group/get-delta' : '/api/chats/get-delta';
        const body = selected_group
            ? { id: groups.find(x => x.id == selected_group)?.chat_id, from_index: startIndex, limit }
            : {
                ch_name: getCharacterName(characters[this_chid]),
                file_name: characters[this_chid]?.chat,
                avatar_url: characters[this_chid]?.avatar,
                from_index: startIndex,
                limit,
            };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
        });

        if (response.ok) {
            const delta = await response.json();
            const olderMessages = Array.isArray(delta?.chat) ? delta.chat : [];
            if (olderMessages.length > 0) {
                chat.unshift(...olderMessages);
                const olderMessageElements = olderMessages.map((olderMessage, offset) => addOneMessage(olderMessage, {
                    scroll: false,
                    forceId: offset,
                    showSwipes: false,
                    insert: false,
                })[0]);

                if (olderMessageElements.length) {
                    if (showMoreButton[0]) {
                        showMoreButton.after(olderMessageElements);
                    } else {
                        chatElement.prepend(olderMessageElements);
                    }
                }

                updateViewMessageIds(0);
                refreshSwipeButtons();
                applyCharacterTagsToMessageDivs({ mesIds: lodash.range(0, olderMessages.length, 1) });
                applyStylePins();

                chatServerState.nextOlderIndex = Math.max(0, Number(delta?.from_index) || 0);
                chatServerState.totalMessages = Math.max(chatServerState.totalMessages, Number(delta?.total_messages) || chat.length);
                chatServerState.hasMore = Boolean(delta?.has_more);
            } else {
                chatServerState.hasMore = false;
            }
        } else {
            console.warn('Could not load older messages from server delta endpoint.');
        }

        if (!chatServerState.hasMore && messageId === 0) {
            $('#show_more_messages').remove();
        }

        if (isButtonInView) {
            const newHeight = chatElement.prop('scrollHeight');
            chatElement.scrollTop(newHeight - prevHeight);
        }

        await eventSource.emit(event_types.MORE_MESSAGES_LOADED);
        return;
    }

    console.debug('Inserting messages before', messageId, 'count', count, 'chat length', chat.length);
    const prevHeight = chatElement.prop('scrollHeight');
    const isButtonInView = isElementInViewport($('#show_more_messages')[0]);
    const firstId = clamp(messageId - count, 0, Infinity);
    const messageElements = chat.slice(firstId, messageId).map((message, offset) => addOneMessage(message, {
        scroll: false,
        forceId: firstId + offset,
        showSwipes: false,
        insert: false,
    })[0]);

    if (messageElements.length) {
        if (showMoreButton[0]) {
            showMoreButton.after(messageElements);
        } else {
            chatElement.prepend(messageElements);
        }
        applyCharacterTagsToMessageDivs({ mesIds: lodash.range(firstId, messageId, 1) });
    }
    messageId = firstId;
    refreshSwipeButtons();

    if (messageId == 0 && !chatServerState.hasMore) {
        $('#show_more_messages').remove();
    }

    if (isButtonInView) {
        const newHeight = chatElement.prop('scrollHeight');
        chatElement.scrollTop(newHeight - prevHeight);
    }

    applyStylePins();
    await eventSource.emit(event_types.MORE_MESSAGES_LOADED);
}

export async function printMessages() {
    let startIndex = 0;
    let count = power_user.chat_truncation || Number.MAX_SAFE_INTEGER;

    if (chat.length > count || chatServerState.hasMore) {
        startIndex = chat.length - count;
        startIndex = Math.max(0, startIndex);
        if (!$('#show_more_messages').length) {
            chatElement.append('<div id="show_more_messages">Show more messages</div>');
        }
    }

    await redisplayChat({ startIndex, fade: false });

    scrollChatToBottom({ waitForFrame: true });
    delay(debounce_timeout.short).then(() => scrollOnMediaLoad());
}

/**
 * Visually updates all chat messages including and after index by removing them, then adding them.
 * @param {object} [options] Options
 * @param {ChatMessage[]} [options.targetChat=chat] All messages in chat before startIndex will remain unchanged.
 * @param {Number} [options.startIndex=0] Everything including and after startIndex will be replaced.
 * @param {Boolean} [options.fade=true] When false, the swipe chevrons will not fade in.
 */
export async function redisplayChat({ targetChat = chat, startIndex = 0, fade = true } = {}) {
    const messageElements = chatElement.find('.mes');
    messageElements.removeClass('last_mes');

    //Remove messages after index.
    messageElements.filter(`.mes[mesid="${startIndex}"]`).nextAll('.mes').addBack().remove();

    const t1 = performance.now();

    const messages = targetChat.slice(startIndex);

    if (messages.length > 0) {
        const newMessageElements = messages.map( (message, offset) => {
            const i = startIndex + offset;
            const messageElement = addOneMessage(message, { scroll: false, forceId: i, showSwipes: false, insert: false });

            return messageElement[0];
        });

        //The last_mes has been removed, add it to the new last message.
        newMessageElements.at(-1).classList.add('last_mes');

        //Append to chat in one DOM update.
        chatElement.append(newMessageElements);

        applyCharacterTagsToMessageDivs({ mesIds: lodash.range(startIndex, targetChat.length, 1) });
    }

    refreshSwipeButtons(false, fade);
    applyStylePins();
    updateEditArrowClasses();

    console.info(`Rendered ${targetChat.length - startIndex} messages in ${((performance.now() - t1) / 1000).toFixed(3)} seconds.`);
}

export function scrollOnMediaLoad() {
    const started = Date.now();
    const media = chatElement.find('.mes_block img, .mes_block video, .mes_block audio').toArray();
    let mediaLoaded = 0;

    for (const currentElement of media) {
        if (currentElement instanceof HTMLImageElement) {
            if (currentElement.complete) {
                incrementAndCheck();
            } else {
                currentElement.addEventListener('load', incrementAndCheck);
                currentElement.addEventListener('error', incrementAndCheck);
            }
        }
        if (currentElement instanceof HTMLMediaElement) {
            if (currentElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                incrementAndCheck();
            } else {
                currentElement.addEventListener('loadeddata', incrementAndCheck);
                currentElement.addEventListener('error', incrementAndCheck);
            }
        }
    }

    function incrementAndCheck() {
        const MAX_DELAY = 1000; // 1 second
        if ((Date.now() - started) > MAX_DELAY) {
            return;
        }
        mediaLoaded++;
        if (mediaLoaded === media.length) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }
}

/**
 * Cancels the debounced chat save if it is currently pending.
 */
export function cancelDebouncedChatSave() {
    if (chatSaveTimeout) {
        console.debug('Debounced chat save cancelled');
        clearTimeout(chatSaveTimeout);
        chatSaveTimeout = null;
    }
}

/**
 * Visually removes all chat message elements.
 * @param {object} [options] Options
 * @param {boolean} [options.clearData=false] Optionally clear the chat array's contents.
 */
export async function clearChat({ clearData = false } = {}) {
    stopLukerGenerationRecovery();
    cancelDebouncedChatSave();
    cancelDebouncedMetadataSave();
    closeMessageEditor();
    extension_prompts = {};
    if (is_delete_mode) {
        $('#dialogue_del_mes_cancel').trigger('click');
    }
    //This will also remove non '.mes' elements, e.g. '<div id="show_more_messages">Show more messages</div>'.
    chatElement.children().remove();
    if ($('.zoomed_avatar[forChar]').length) {
        console.debug('saw avatars to remove');
        $('.zoomed_avatar[forChar]').remove();
    } else { console.debug('saw no avatars'); }

    await saveItemizedPrompts(getCurrentChatId());
    itemizedPrompts.length = 0;

    if (clearData) chat.length = 0;
}

export async function deleteLastMessage() {
    const deletedMessage = chat[chat.length - 1];
    const deletedPlayableSeq = deletedMessage && !deletedMessage.is_system
        ? chat.reduce((count, message) => count + (message && !message.is_system ? 1 : 0), 0)
        : null;
    const deletedAssistantSeq = deletedMessage && !deletedMessage.is_system && !deletedMessage.is_user
        ? chat.reduce((count, message) => count + (message && !message.is_system && !message.is_user ? 1 : 0), 0)
        : null;
    chat.length = chat.length - 1;
    chatElement.children('.mes').last().remove();
    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, {
        kind: 'delete',
        deletedPlayableSeqFrom: deletedPlayableSeq,
        deletedPlayableSeqTo: deletedPlayableSeq,
        deletedAssistantSeqFrom: deletedAssistantSeq,
        deletedAssistantSeqTo: deletedAssistantSeq,
    });
}

async function getChatBoundLorebookName(chatFile, groupId = null, { avatarUrl = '', characterName = '' } = {}) {
    const normalizedFileName = String(chatFile || '').trim().replace(/\.jsonl$/i, '');
    if (!normalizedFileName) {
        return '';
    }

    try {
        if (groupId) {
            const response = await fetch('/api/chats/group/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: normalizedFileName }),
            });

            if (!response.ok) {
                return '';
            }

            const data = await response.json();
            const metadata = Array.isArray(data) ? data?.[0]?.chat_metadata : data?.chat_metadata;
            return typeof metadata?.world_info === 'string' ? metadata.world_info.trim() : '';
        }

        const resolvedAvatarUrl = String(avatarUrl || characters?.[this_chid]?.avatar || '').trim();
        if (!resolvedAvatarUrl) {
            return '';
        }

        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: String(characterName || getCharacterName(characters?.[this_chid]) || name2 || ''),
                file_name: normalizedFileName,
                avatar_url: resolvedAvatarUrl,
            }),
        });

        if (!response.ok) {
            return '';
        }

        const data = await response.json();
        const metadata = Array.isArray(data) ? data?.[0]?.chat_metadata : data?.chat_metadata;
        return typeof metadata?.world_info === 'string' ? metadata.world_info.trim() : '';
    } catch (error) {
        console.warn('Failed to inspect chat-bound lorebook before chat deletion', error);
        return '';
    }
}

async function hasWorldInfoFile(lorebookName) {
    const safeName = String(lorebookName || '').trim();
    if (!safeName) {
        return false;
    }
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: safeName }),
            cache: 'no-cache',
        });
        return response.ok;
    } catch (error) {
        console.warn('Failed to verify lorebook existence', error);
        return false;
    }
}

async function maybeDeleteChatBoundLorebook(chatFile, groupId = null, { avatarUrl = '', characterName = '' } = {}) {
    const lorebookName = await getChatBoundLorebookName(chatFile, groupId, { avatarUrl, characterName });
    if (!lorebookName) {
        return { lorebookName: '', deleted: false };
    }
    if (!await hasWorldInfoFile(lorebookName)) {
        return { lorebookName: '', deleted: false };
    }

    const safeLorebookName = DOMPurify.sanitize(lorebookName);
    const promptHtml = [
        `<h3>${t`Delete bound lorebook too?`}</h3>`,
        `<p>${t`This chat is bound to lorebook:`} <code>${safeLorebookName}</code></p>`,
        `<p>${t`If this lorebook is shared by other chats or characters, they will lose that binding too.`}</p>`,
    ].join('');
    const result = await callGenericPopup(promptHtml, POPUP_TYPE.CONFIRM);

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return { lorebookName, deleted: false };
    }

    const deleted = await deleteWorldInfoWithUndo(lorebookName);
    if (!deleted) {
        toastr.warning(t`Lorebook could not be deleted.`, t`Delete Chat`);
    }

    return { lorebookName, deleted: Boolean(deleted) };
}

function getCharacterBoundImportedLorebookName(character) {
    const boundLorebook = String(character?.data?.extensions?.world || '').trim();
    const embeddedBook = character?.data?.character_book;
    if (!boundLorebook || !embeddedBook || !Array.isArray(embeddedBook?.entries)) {
        return '';
    }
    return boundLorebook;
}

async function maybeDeleteCharacterBoundImportedLorebook(character, { alreadyPromptedLorebooks = new Set() } = {}) {
    const lorebookName = getCharacterBoundImportedLorebookName(character);
    if (!lorebookName || alreadyPromptedLorebooks.has(lorebookName)) {
        return { lorebookName: '', deleted: false };
    }
    if (!await hasWorldInfoFile(lorebookName)) {
        return { lorebookName: '', deleted: false };
    }

    const safeLorebookName = DOMPurify.sanitize(lorebookName);
    const promptHtml = [
        `<h3>${t`Delete imported lorebook too?`}</h3>`,
        `<p>${t`This character is bound to lorebook:`} <code>${safeLorebookName}</code></p>`,
        `<p>${t`The character card includes an embedded lorebook for this binding.`}</p>`,
        `<p>${t`If this lorebook is shared by other chats or characters, they will lose that binding too.`}</p>`,
    ].join('');
    const result = await callGenericPopup(promptHtml, POPUP_TYPE.CONFIRM);

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return { lorebookName, deleted: false };
    }

    const deleted = await deleteWorldInfoWithUndo(lorebookName);
    if (!deleted) {
        toastr.warning(t`Lorebook could not be deleted.`, t`Delete Character`);
    }

    return { lorebookName, deleted: Boolean(deleted) };
}

/**
 * Deletes a message from the chat by its ID, optionally asking for confirmation.
 * @param {number} id The ID of the message to delete.
 * @param {number} [swipeDeletionIndex] Deletes the swipe with that index.
 * @param {boolean} [askConfirmation=false] Whether to ask for confirmation before deleting.
 */
export async function deleteMessage(id, swipeDeletionIndex = undefined, askConfirmation = false) {
    const canDeleteSwipe = swipeDeletionIndex !== undefined && swipeDeletionIndex !== null;
    if (canDeleteSwipe) {
        if (swipeDeletionIndex < 0) {
            throw new Error('Swipe index cannot be negative');
        }
        if (!Array.isArray(chat[id].swipes)) {
            throw new Error('Message has no swipes to delete');
        }
        if (chat[id].swipes.length <= swipeDeletionIndex) {
            throw new Error('Swipe index out of bounds');
        }
    }

    const minId = getFirstDisplayedMessageId();
    const messageElement = chatElement.find(`.mes[mesid="${id}"]`);
    if (messageElement.length === 0) {
        return;
    }

    let deleteOnlySwipe = canDeleteSwipe;
    if (askConfirmation) {
        const result = await callGenericPopup(t`Are you sure you want to delete this message?`, POPUP_TYPE.CONFIRM, null, {
            okButton: canDeleteSwipe ? t`Delete Swipe` : t`Delete Message`,
            cancelButton: 'Cancel',
            customButtons: canDeleteSwipe ? [t`Delete Message`] : null,
        });
        if (!result) {
            return;
        }
        deleteOnlySwipe = canDeleteSwipe && result === POPUP_RESULT.AFFIRMATIVE; // Default button, not the custom one
    }

    if (deleteOnlySwipe) {
        await deleteSwipe(swipeDeletionIndex, id);
        return;
    }

    const deletedMessage = chat[id];
    const deletedPlayableSeq = deletedMessage && !deletedMessage.is_system
        ? chat.slice(0, id + 1).reduce((count, message) => count + (message && !message.is_system ? 1 : 0), 0)
        : null;
    const deletedAssistantSeq = deletedMessage && !deletedMessage.is_system && !deletedMessage.is_user
        ? chat.slice(0, id + 1).reduce((count, message) => count + (message && !message.is_system && !message.is_user ? 1 : 0), 0)
        : null;

    chat.splice(id, 1);
    messageElement.remove();

    chat_metadata.tainted = true;

    const startIndex = [0, minId].includes(id) ? id : null;
    deleteItemizedPromptForMessage(id);
    updateViewMessageIds(startIndex);
    const patched = await patchChatMessages([{ op: 'remove', path: `/${id}` }]);
    if (!patched) {
        saveChatDebounced();
    }

    if (this_edit_mes_id === id) {
        this_edit_mes_id = undefined;
    }

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, {
        kind: 'delete',
        deletedPlayableSeqFrom: deletedPlayableSeq,
        deletedPlayableSeqTo: deletedPlayableSeq,
        deletedAssistantSeqFrom: deletedAssistantSeq,
        deletedAssistantSeqTo: deletedAssistantSeq,
    });
}

export const reloadChatMutex = new SimpleMutex(reloadCurrentChatUnsafe);
export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex);

/**
 * Reloads the current chat unsafely, without mutex protection.
 * Use `reloadCurrentChat` instead to ensure thread safety.
 * @returns {Promise<void>} A promise that resolves when the chat is reloaded.
 */
export async function reloadCurrentChatUnsafe() {
    preserveNeutralChat();
    await clearChat({ clearData: true });

    if (selected_group) {
        await getGroupChat(selected_group, true);
    } else if (this_chid !== undefined) {
        await getChat();
    } else {
        resetChatState();
        restoreNeutralChat();
        await getCharacters();
        await printMessages();
        await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    }

    refreshSwipeButtons();
}

async function getSettledSendTextareaState(maxWaitMs = 700) {
    const startedAt = Date.now();

    while (isSendTextareaComposing && (Date.now() - startedAt) < maxWaitMs) {
        await delay(16);
    }

    // Let potential trailing input events flush after compositionend.
    await delay(0);

    return {
        text: String($('#send_textarea').val()),
        composing: isSendTextareaComposing,
    };
}

/**
 * Send the message currently typed into the chat box.
 */
export async function sendTextareaMessage() {
    // don't proceed during swipeGenerate()
    if (swipeState == SWIPE_STATE.EDITING) {
        toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
        return;
    }
    if (swipeState !== SWIPE_STATE.NONE) return; // don't proceed if mid-swipe.
    if (is_send_press) return;
    if (isExecutingCommandsFromChatInput) return;

    hideSwipeButtons(); //Swipe buttons must be hidden now, otherwise concurrent generations are possible.

    let generateType = 'normal';
    // "Continue on send" is activated when the user hits "send" (or presses enter) on an empty chat box, and the last
    // message was sent from a character (not the user or the system).
    const textareaState = await getSettledSendTextareaState();
    if (textareaState.composing) {
        toastr.warning(t`Finish current input composition before sending.`);
        showSwipeButtons();
        return;
    }
    const textareaText = textareaState.text;
    if (power_user.continue_on_send &&
        !hasPendingFileAttachment() &&
        !textareaText &&
        !selected_group &&
        chat.length &&
        !lastMessage.is_user &&
        !lastMessage.is_system
    ) {
        generateType = 'continue';
    }

    if (textareaText && !selected_group && this_chid === undefined && name2 !== neutralCharacterName) {
        await newAssistantChat({ temporary: false });
    }

    try {
        pendingUserInputText = textareaText;
        let generation = await Generate(generateType);
        return generation;
    } finally {
        pendingUserInputText = null;
        showSwipeButtons();
    }
}

/**
 * Formats the message text into an HTML string using Markdown and other formatting.
 * @param {string} mes Message text
 * @param {string} ch_name Character name
 * @param {boolean} isSystem If the message was sent by the system
 * @param {boolean} isUser If the message was sent by the user
 * @param {number} messageId Message index in chat array
 * @param {Partial<DOMPurify.Config>} [sanitizerOverrides] DOMPurify sanitizer option overrides
 * @param {boolean} [isReasoning] If the message is reasoning output
 * @returns {string} HTML string
 */
export function messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false) {
    if (!mes) {
        return '';
    }

    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
        const mesBeforeReplace = mes;
        const chatMessage = chat[messageId];
        mes = substituteParams(mes, undefined, ch_name);
        if (chatMessage && chatMessage.mes === mesBeforeReplace && chatMessage.extra?.display_text !== mesBeforeReplace) {
            chatMessage.mes = mes;
        }
    }

    mesForShowdownParse = mes;

    // Force isSystem = false on comment messages so they get formatted properly
    if (ch_name === COMMENT_NAME_DEFAULT && isSystem && !isUser) {
        isSystem = false;
    }

    // Let hidden messages have markdown
    if (isSystem && ch_name !== systemUserName) {
        isSystem = false;
    }

    // Prompt bias replacement should be applied on the raw message
    const replacedPromptBias = power_user.user_prompt_bias && substituteParams(power_user.user_prompt_bias);
    if (!power_user.show_user_prompt_bias && ch_name && !isUser && !isSystem && replacedPromptBias && mes.startsWith(replacedPromptBias)) {
        mes = mes.slice(replacedPromptBias.length);
    }

    if (!isSystem) {
        function getRegexPlacement() {
            try {
                if (isReasoning) {
                    return regex_placement.REASONING;
                }
                if (isUser) {
                    return regex_placement.USER_INPUT;
                } else if (chat[messageId]?.extra?.type === 'narrator') {
                    return regex_placement.SLASH_COMMAND;
                } else {
                    return regex_placement.AI_OUTPUT;
                }
            } catch {
                return regex_placement.AI_OUTPUT;
            }
        }

        const regexPlacement = getRegexPlacement();
        const usableMessages = chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
        const indexOf = usableMessages.findIndex(x => x.index === Number(messageId));
        const depth = messageId >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

        // Always override the character name
        mes = getRegexedString(mes, regexPlacement, {
            characterOverride: ch_name,
            isMarkdown: true,
            depth: depth,
        });
    }

    if (power_user.auto_fix_generated_markdown) {
        mes = fixMarkdown(mes, true);
    }

    if (!isSystem && power_user.encode_tags) {
        mes = canUseNegativeLookbehind()
            ? mes.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\\n\\s*)>', 'g'), '&gt;')
            : mes.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }

    // Make sure reasoning strings are always shown, even if they include "<" or ">"
    [power_user.reasoning.prefix, power_user.reasoning.suffix].forEach((reasoningString) => {
        if (!reasoningString || !reasoningString.trim().length) {
            return;
        }
        // Only replace the first occurrence of the reasoning string
        if (mes.includes(reasoningString)) {
            mes = mes.replace(reasoningString, escapeHtml(reasoningString));
        }
    });

    if (!isSystem) {
        // Save double quotes in tags as a special character to prevent them from being encoded
        if (!power_user.encode_tags) {
            mes = mes.replace(/<([^>]+)>/g, function (_, contents) {
                return '<' + contents.replace(/"/g, '\ufffe') + '>';
            });
        }

        mes = mes.replace(
            /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
            function (match, p1, p2, p3, p4, p5, p6) {
                if (p1) {
                    // English double quotes
                    return `<q>"${p1.slice(1, -1)}"</q>`;
                } else if (p2) {
                    // Curly double quotes “ ”
                    return `<q>“${p2.slice(1, -1)}”</q>`;
                } else if (p3) {
                    // Guillemets « »
                    return `<q>«${p3.slice(1, -1)}»</q>`;
                } else if (p4) {
                    // Corner brackets 「 」
                    return `<q>「${p4.slice(1, -1)}」</q>`;
                } else if (p5) {
                    // White corner brackets 『 』
                    return `<q>『${p5.slice(1, -1)}』</q>`;
                } else if (p6) {
                    // Fullwidth quotes ＂ ＂
                    return `<q>＂${p6.slice(1, -1)}＂</q>`;
                } else {
                    // Return the original match if no quotes are found
                    return match;
                }
            },
        );

        // Restore double quotes in tags
        if (!power_user.encode_tags) {
            mes = mes.replace(/\ufffe/g, '"');
        }

        mes = mes.replaceAll('\\begin{align*}', '$$');
        mes = mes.replaceAll('\\end{align*}', '$$');
        mes = converter.makeHtml(mes);

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            // Firefox creates extra newlines from <br>s in code blocks, so we replace them before converting newlines to <br>s.
            return match.replace(/\n/gm, '\u0000');
        });
        mes = mes.replace(/\u0000/g, '\n'); // Restore converted newlines
        mes = mes.trim();

        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            return match.replace(/&amp;/g, '&');
        });
    }

    if (!power_user.allow_name2_display && ch_name && !isUser && !isSystem) {
        mes = mes.replace(new RegExp(`(^|\n)${escapeRegex(ch_name)}:`, 'g'), '$1');
    }

    /** @type {DOMPurify.Config} */
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
        ...sanitizerOverrides,
    };
    mes = encodeStyleTags(mes);
    mes = DOMPurify.sanitize(mes, config);
    mes = decodeStyleTags(mes, { prefix: '.mes_text ' });

    return mes;
}

/**
 * Inserts or replaces an SVG icon adjacent to the provided message's timestamp.
 *
 * @param {JQuery<HTMLElement>} mes - The message element containing the timestamp where the icon should be inserted or replaced.
 * @param {ChatMessageExtra} extra - Contains the API and model details.
 */
function insertSVGIcon(mes, extra) {
    // Determine the SVG filename
    let modelName = extra?.api || '';

    // If there's no API information, we can't determine which SVG to use
    if (!modelName) {
        return;
    }

    const insertOrReplaceSVG = (image, className, targetSelector, insertBefore) => {
        image.onload = async function () {
            let existingSVG = insertBefore ? mes.find(targetSelector).prev(`.${className}`) : mes.find(targetSelector).next(`.${className}`);
            if (existingSVG.length) {
                existingSVG.replaceWith(image);
            } else {
                if (insertBefore) mes.find(targetSelector).before(image);
                else mes.find(targetSelector).after(image);
            }
            await SVGInject(image);
        };
    };

    const createModelImage = (className, targetSelector, insertBefore) => {
        const image = new Image();
        image.classList.add('icon-svg', className);
        image.src = `/img/${modelName}.svg`;
        image.title = `${extra?.api ? extra.api + ' - ' : ''}${extra?.model ?? ''}`;
        insertOrReplaceSVG(image, className, targetSelector, insertBefore);
    };

    createModelImage('timestamp-icon', '.timestamp');
    createModelImage('thinking-icon', '.mes_reasoning_header_title', true);
}

let modelMetadataTapHintBound = false;
let modelMetadataTapHintElement = null;
let modelMetadataTapHintTarget = null;

function isCoarsePointerDevice() {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
}

function hideModelMetadataTapHint() {
    if (!modelMetadataTapHintElement) {
        return;
    }

    modelMetadataTapHintElement.style.display = 'none';
    modelMetadataTapHintTarget = null;
}

function getModelMetadataHintText(target) {
    const directTitle = String(target?.getAttribute?.('title') || '').trim();
    if (directTitle) {
        return directTitle;
    }

    const fallbackTitle = String(target?.closest?.('.mes')?.querySelector?.('.timestamp')?.getAttribute?.('title') || '').trim();
    return fallbackTitle;
}

function positionModelMetadataTapHint(target) {
    if (!modelMetadataTapHintElement) {
        return;
    }

    const rect = target.getBoundingClientRect();
    const viewportPadding = 8;
    const hintRect = modelMetadataTapHintElement.getBoundingClientRect();
    const hintWidth = hintRect.width;
    const hintHeight = hintRect.height;

    const left = clamp(
        Math.round(rect.left + (rect.width / 2) - (hintWidth / 2)),
        viewportPadding,
        Math.max(viewportPadding, window.innerWidth - hintWidth - viewportPadding),
    );

    let top = Math.round(rect.bottom + viewportPadding);
    if (top + hintHeight > window.innerHeight - viewportPadding) {
        top = Math.round(rect.top - hintHeight - viewportPadding);
    }
    top = clamp(
        top,
        viewportPadding,
        Math.max(viewportPadding, window.innerHeight - hintHeight - viewportPadding),
    );

    modelMetadataTapHintElement.style.left = `${left}px`;
    modelMetadataTapHintElement.style.top = `${top}px`;
}

function showModelMetadataTapHint(target, text) {
    if (!modelMetadataTapHintElement) {
        modelMetadataTapHintElement = document.createElement('div');
        modelMetadataTapHintElement.className = 'model_metadata_tap_hint';
        document.body.appendChild(modelMetadataTapHintElement);
    }

    modelMetadataTapHintElement.textContent = text;
    modelMetadataTapHintElement.style.display = 'block';
    modelMetadataTapHintTarget = target;
    positionModelMetadataTapHint(target);
}

function ensureModelMetadataTapHintBinding() {
    if (modelMetadataTapHintBound) {
        return;
    }

    modelMetadataTapHintBound = true;

    $(document).on('click', '#chat .timestamp-icon, #chat .timestamp', function (event) {
        if (!isCoarsePointerDevice()) {
            return;
        }

        const text = getModelMetadataHintText(this);
        if (!text) {
            return;
        }

        if (modelMetadataTapHintTarget === this && modelMetadataTapHintElement?.style.display === 'block') {
            hideModelMetadataTapHint();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        showModelMetadataTapHint(this, text);
        event.preventDefault();
        event.stopPropagation();
    });

    $(document).on('pointerdown', function (event) {
        if (!modelMetadataTapHintElement || modelMetadataTapHintElement.style.display !== 'block') {
            return;
        }

        const target = event.target;
        const clickedOnTrigger = $(target).closest('#chat .timestamp-icon, #chat .timestamp').length > 0;
        const clickedOnTooltip = modelMetadataTapHintElement.contains(target);
        if (!clickedOnTrigger && !clickedOnTooltip) {
            hideModelMetadataTapHint();
        }
    });

    window.addEventListener('resize', hideModelMetadataTapHint);
    window.addEventListener('scroll', hideModelMetadataTapHint, true);
}


function getMessageFromTemplate({
    mesId,
    swipeId,
    characterName,
    isUser,
    avatarImg,
    bias,
    isSystem,
    title,
    timerValue,
    timerTitle,
    bookmarkLink,
    forceAvatar,
    timestamp,
    tokenCount,
    extra,
    type,
}) {
    const mes = messageTemplate.clone();
    mes.attr({
        'mesid': mesId,
        'swipeid': swipeId,
        'ch_name': characterName,
        'is_user': isUser,
        'is_system': !!isSystem,
        'bookmark_link': bookmarkLink,
        'force_avatar': !!forceAvatar,
        'timestamp': timestamp,
        ...(type ? { type } : {}),
    });
    mes.find('.avatar img').attr('src', avatarImg);
    mes.find('.ch_name .name_text').text(characterName);
    mes.find('.mes_bias').html(bias);
    mes.find('.timestamp').text(timestamp).attr('title', `${extra?.api ? extra.api + ' - ' : ''}${extra?.model ?? ''}`);
    mes.find('.mesIDDisplay').text(`#${mesId}`);
    tokenCount && mes.find('.tokenCounterDisplay').text(`${tokenCount}t`);
    title && mes.attr('title', title);
    timerValue && mes.find('.mes_timer').attr('title', timerTitle).text(timerValue);
    bookmarkLink && updateBookmarkDisplay(mes);

    updateReasoningUI(mes);

    if (power_user.timestamp_model_icon && extra?.api) {
        insertSVGIcon(mes, extra);
    }

    ensureModelMetadataTapHintBinding();

    return mes;
}

/**
 * Re-renders a message block with updated content.
 * @param {number} messageId Message ID
 * @param {object} message Message object
 * @param {object} [options={}] Optional arguments
 * @param {boolean} [options.rerenderMessage=true] Whether to re-render the message content (inside <c>.mes_text</c>)
 */
export function updateMessageBlock(messageId, message, { rerenderMessage = true } = {}) {
    const messageElement = chatElement.find(`[mesid="${messageId}"]`);
    if (messageElement.length === 0) {
        return;
    }

    // MESSAGE_EDITED listeners may refresh the block before the editor fully closes.
    // Preserve the live textarea so confirm/cancel can finish against the same DOM.
    const hasActiveEditor = messageElement.find('.edit_textarea').length > 0;
    if (rerenderMessage && !hasActiveEditor) {
        const text = message?.extra?.display_text ?? message.mes;
        messageElement.find('.mes_text').html(messageFormatting(text, message.name, message.is_system, message.is_user, messageId, {}, false));
    }

    updateReasoningUI(messageElement);

    addCopyToCodeBlocks(messageElement);
    appendMediaToMessage(message, messageElement);
}

/**
 * Ensures that the message media properties are arrays, adding getters/setters for single media items.
 * @param {ChatMessage} mes Message object
 */
export function ensureMessageMediaIsArray(mes) {
    /**
     * Determines if a property of an object is a plain property (not a getter/setter or non-enumerable).
     * @param {object} obj Object to check
     * @param {string} name Property name
     * @returns {boolean} True if the property is a plain property, false otherwise
     */
    function isPlainObjectProperty(obj, name) {
        const hasProperty = Object.hasOwn(obj, name);
        if (hasProperty) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, name);
            return descriptor && descriptor.enumerable && descriptor.configurable && descriptor.writable;
        }
        return false;
    }

    /**
     * Determines if a property of an object is a getter (not a plain property).
     * @param {object} obj Object to check
     * @param {string} name Property name
     * @returns {boolean} True if the property is a getter, false otherwise
     */
    function isGetterObjectProperty(obj, name) {
        const hasProperty = Object.hasOwn(obj, name);
        if (hasProperty) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, name);
            return descriptor && typeof descriptor.get === 'function';
        }
        return false;
    }

    /**
     * Adds a plain property to an object that wraps around an array property.
     * @param {object} obj Object to add property to
     * @param {string} plainProperty Plain property name
     * @param {string} arrayProperty Array property to back the plain property
     * @param {(value: any) => boolean} [filterFn] Optional filter function to apply when getting/setting the plain property
     * @param {(value: any) => any} [mapFn] Optional map function to apply when getting/setting the plain property
     */
    function addArrayAutoWrapper(obj, plainProperty, arrayProperty, filterFn = () => true, mapFn = (t) => t) {
        // If the plain property is already a getter, do nothing.
        const hasGetterProperty = isGetterObjectProperty(obj, plainProperty);
        if (hasGetterProperty) {
            return;
        }

        // Define the plain property as a getter/setter that wraps around the array property.
        Object.defineProperty(obj, plainProperty, {
            // Getting the plain property returns the first item in the array property, or undefined if the array is empty.
            get: function () {
                console.trace(`Attempting to GET an array-wrapped property '${plainProperty}'. Use the array property '${arrayProperty}' instead.`);
                const array = Array.isArray(this[arrayProperty]) ? this[arrayProperty].filter(filterFn).map(mapFn) : [];
                return array.length > 0 ? array[0] : void 0;
            },
            // Setting the plain property is not supported, as it would be ambiguous.
            set: function () {
                console.trace(`Attempting to SET an array-wrapped property '${plainProperty}'. Use the array property '${arrayProperty}' instead.`);
            },
            // Exclude the property from JSON serialization and from being listed in for...in loops.
            enumerable: false,
            // Make the property non-configurable to prevent deletion or redefinition.
            configurable: false,
        });
    }

    /**
     * Migrates image swipes from a single image property to an array.
     * @param {ChatMessageExtra} obj
     */
    function migrateMediaToArray(obj) {
        if (isPlainObjectProperty(obj, 'file')) {
            if (!Array.isArray(obj.files)) {
                obj.files = [];
            }
            const fileValue = obj.file;
            delete obj.file;
            if (fileValue) {
                obj.files.push(fileValue);
            }
        }

        if (Array.isArray(obj.image_swipes)) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            for (const swipe of obj.image_swipes) {
                if (swipe && typeof swipe === 'string') {
                    obj.media_display = MEDIA_DISPLAY.GALLERY;
                    obj.media.push({ type: MEDIA_TYPE.IMAGE, url: swipe });
                }
            }
            delete obj.image_swipes;
        }

        if (isPlainObjectProperty(obj, 'image')) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            const imageValue = obj.image;
            delete obj.image;
            if (imageValue && typeof imageValue === 'string') {
                obj.media.push({ type: MEDIA_TYPE.IMAGE, url: imageValue });
            }
            if (obj.media_display === MEDIA_DISPLAY.GALLERY) {
                const selectedIndex = obj.media.findIndex(t => t.url === imageValue);
                if (selectedIndex > -1) {
                    obj.media_index = selectedIndex;
                }
            }
            obj.media = obj.media.filter((v, i, a) => i === a.findIndex(t => t.url === v.url));
        }

        if (isPlainObjectProperty(obj, 'video')) {
            if (!Array.isArray(obj.media)) {
                obj.media = [];
            }
            const videoValue = obj.video;
            delete obj.video;
            if (videoValue && typeof videoValue === 'string') {
                obj.media.push({ type: MEDIA_TYPE.VIDEO, url: videoValue });
            }
        }
    }

    if (!mes || !mes.extra || typeof mes.extra !== 'object') {
        return;
    }

    migrateMediaToArray(mes.extra);
    addArrayAutoWrapper(mes.extra, 'file', 'files');
    addArrayAutoWrapper(mes.extra, 'image', 'media', (t) => t.type === MEDIA_TYPE.IMAGE, (t) => t.url);
    addArrayAutoWrapper(mes.extra, 'video', 'media', (t) => t.type === MEDIA_TYPE.VIDEO, (t) => t.url);
}

/**
 * Gets the media display setting for a message.
 * @param {ChatMessage} mes Message object
 * @returns {MEDIA_DISPLAY} Media display setting
 */
export function getMediaDisplay(mes) {
    const value = mes?.extra?.media_display || power_user.media_display || MEDIA_DISPLAY.LIST;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

/**
 * Gets the media index for a message.
 * @param {ChatMessage} mes Message object
 * @returns {number} Media index
 */
export function getMediaIndex(mes) {
    if (!Array.isArray(mes?.extra?.media)) {
        return 0;
    }
    const value = mes.extra?.media_index;
    if (isNaN(value) || value < 0 || value >= mes.extra.media.length) {
        return 0;
    }
    return value;
}

const MESSAGE_MEDIA_SELECTOR = '.mes_text img, .mes_text video, .mes_media_wrapper img, .mes_media_wrapper video';
const MESSAGE_MEDIA_LAZY_ROOT_MARGIN = '200px 0px';
let messageMediaObserver = null;
let messageMediaMutationObserver = null;

/**
 * Determines whether lazy loading of message media should be used.
 * @returns {boolean}
 */
function isMessageMediaLazyLoadEnabled() {
    return power_user.message_media_lazy_load && typeof IntersectionObserver === 'function';
}

/**
 * Determines whether a media element opted out from core lazy loading.
 * @param {Element} element Media element
 * @returns {boolean}
 */
function shouldSkipMessageMediaLazyLoad(element) {
    return Boolean(element.closest?.('[data-no-lazy-media]'));
}

/**
 * Applies low-priority loading hints to message media.
 * @param {HTMLImageElement|HTMLVideoElement} element Media element
 */
function applyMessageMediaHints(element) {
    if (shouldSkipMessageMediaLazyLoad(element)) {
        if (element instanceof HTMLVideoElement) {
            element.preload = 'metadata';
        }
        return;
    }

    if (element instanceof HTMLImageElement) {
        element.loading = 'lazy';
        element.decoding = 'async';
        element.setAttribute('fetchpriority', 'low');
        return;
    }

    if (element instanceof HTMLVideoElement) {
        element.preload = 'none';
    }
}

/**
 * Activates a deferred media element by assigning its real source.
 * @param {Element} target Deferred media element
 */
function activateDeferredMessageMedia(target) {
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) {
        return;
    }

    const sourceUrl = target.dataset.lazyMediaSource;
    if (!sourceUrl) {
        return;
    }

    if (target instanceof HTMLImageElement) {
        if (target.getAttribute('src') !== sourceUrl) {
            target.setAttribute('src', sourceUrl);
        }
    } else {
        target.preload = target.dataset.lazyMediaPreload || 'metadata';
        if (target.getAttribute('src') !== sourceUrl) {
            target.setAttribute('src', sourceUrl);
        }
        target.load();
    }

    target.dataset.lazyMediaActive = 'true';
    delete target.dataset.lazyMediaSource;
    delete target.dataset.lazyMediaPreload;

    if (messageMediaObserver) {
        messageMediaObserver.unobserve(target);
    }
}

/**
 * Gets the shared observer used for deferred message media.
 * @returns {IntersectionObserver|null}
 */
function getMessageMediaObserver() {
    if (messageMediaObserver || typeof IntersectionObserver !== 'function') {
        return messageMediaObserver;
    }

    messageMediaObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                activateDeferredMessageMedia(entry.target);
            }
        }
    }, {
        root: chatElement.get(0) || null,
        rootMargin: MESSAGE_MEDIA_LAZY_ROOT_MARGIN,
        threshold: 0.01,
    });

    return messageMediaObserver;
}

/**
 * Defers the loading of a message media element until it enters the viewport.
 * @param {HTMLImageElement|HTMLVideoElement} element Media element
 * @param {string} sourceUrl Media source URL
 */
function deferMessageMediaLoad(element, sourceUrl) {
    element.dataset.lazyMediaSource = sourceUrl;
    delete element.dataset.lazyMediaActive;

    if (element instanceof HTMLImageElement) {
        element.removeAttribute('src');
    } else {
        element.dataset.lazyMediaPreload = 'metadata';
        element.removeAttribute('src');
        element.load();
    }

    if (element.isConnected) {
        getMessageMediaObserver()?.observe(element);
    }
}

/**
 * Prepares a media element for eager or deferred loading.
 * @param {Element} target Media element
 * @param {object} [options]
 * @param {string} [options.sourceUrl] Explicit media source
 * @param {boolean} [options.preserveExistingSource=true] Keep already-assigned sources intact
 */
function prepareMessageMediaElement(target, { sourceUrl, preserveExistingSource = true } = {}) {
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) {
        return;
    }

    applyMessageMediaHints(target);

    const resolvedSource = sourceUrl || target.dataset.lazyMediaSource || target.getAttribute('src') || target.currentSrc;
    if (!resolvedSource) {
        return;
    }

    if (shouldSkipMessageMediaLazyLoad(target) || !isMessageMediaLazyLoadEnabled()) {
        activateDeferredMessageMedia(target);
        if (target instanceof HTMLImageElement) {
            target.setAttribute('src', resolvedSource);
        } else {
            target.preload = 'metadata';
            target.setAttribute('src', resolvedSource);
            target.load();
        }
        return;
    }

    if (preserveExistingSource && (target.getAttribute('src') || target.currentSrc)) {
        return;
    }

    deferMessageMediaLoad(target, resolvedSource);
}

/**
 * Gets all managed media elements within a message subtree.
 * @param {ParentNode | Element} root Root element
 * @returns {(HTMLImageElement|HTMLVideoElement)[]}
 */
function getMessageMediaTargets(root) {
    if (!(root instanceof Element || root instanceof DocumentFragment)) {
        return [];
    }

    const matches = [];
    if (root instanceof Element && root.matches(MESSAGE_MEDIA_SELECTOR)) {
        matches.push(root);
    }

    matches.push(...Array.from(root.querySelectorAll(MESSAGE_MEDIA_SELECTOR)));
    return matches.filter((element) => element instanceof HTMLImageElement || element instanceof HTMLVideoElement);
}

/**
 * Applies message media optimizations to an existing subtree.
 * @param {ParentNode | Element | null | undefined} root Root element
 * @param {object} [options]
 * @param {boolean} [options.preserveExistingSource=true] Keep already-assigned sources intact
 */
function enhanceMessageMediaTree(root, { preserveExistingSource = true } = {}) {
    for (const element of getMessageMediaTargets(root)) {
        prepareMessageMediaElement(element, { preserveExistingSource });
    }
}

/**
 * Starts observing chat DOM mutations so plugin-added media at least receives lazy hints.
 */
function ensureMessageMediaMutationObserver() {
    if (messageMediaMutationObserver || typeof MutationObserver !== 'function') {
        return;
    }

    const chatRoot = chatElement.get(0);
    if (!chatRoot) {
        return;
    }

    messageMediaMutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    enhanceMessageMediaTree(node, { preserveExistingSource: true });
                }
            }
        }
    });

    messageMediaMutationObserver.observe(chatRoot, {
        childList: true,
        subtree: true,
    });
}

/**
 * Appends image or file to the message element.
 * @param {ChatMessage} mes Message object
 * @param {JQuery<HTMLElement>} messageElement Message element
 * @param {string} [scrollBehavior] Scroll behavior when adjusting scroll position
 */
export function appendMediaToMessage(mes, messageElement, scrollBehavior = SCROLL_BEHAVIOR.ADJUST) {
    ensureMessageMediaIsArray(mes);

    const fileWrapper = messageElement.find('.mes_file_wrapper');
    const mediaWrapper = messageElement.find('.mes_media_wrapper');

    const hasMedia = Array.isArray(mes?.extra?.media) && mes.extra.media.length > 0;
    const hasFiles = Array.isArray(mes?.extra?.files) && mes.extra.files.length > 0;
    const mediaDisplay = hasMedia ? getMediaDisplay(mes) : null;
    const hideMessageText = hasMedia && mes?.extra?.inline_image === false;

    const mediaBlocks = [];
    const mediaPromises = [];

    const chatHeight = (hasMedia || hasFiles) ? chatElement.prop('scrollHeight') : 0;
    const scrollPosition = (hasMedia || hasFiles) ? chatElement.scrollTop() : 0;
    const doAdjustScroll = () => {
        if (!hasMedia && !hasFiles) {
            return;
        }
        if (scrollBehavior === SCROLL_BEHAVIOR.NONE) {
            return;
        }
        if (scrollBehavior === SCROLL_BEHAVIOR.KEEP) {
            chatElement.scrollTop(scrollPosition);
            return;
        }
        const newChatHeight = chatElement.prop('scrollHeight');
        const diff = newChatHeight - chatHeight;
        if (Math.abs(diff) < 1) {
            return;
        }
        chatElement.scrollTop(scrollPosition + diff);
    };

    // Set media display attribute
    messageElement.attr('data-media-display', mediaDisplay);
    // Toggle text visibility
    messageElement.find('.mes_text').toggleClass('inline_media', hideMessageText);

    /**
     * Appends a single image attachment to the message element.
     * @param {MediaAttachment} attachment Image attachment object
     * @param {number} index Index of the image attachment
     * @returns {JQuery<HTMLElement>} The appended image container element
     */
    function appendImageAttachment(attachment, index) {
        const template = $('#message_image_template .mes_img_container').clone();
        template.attr('data-index', index);

        const image = template.find('.mes_img');
        const imageElement = image.get(0);
        if (imageElement instanceof HTMLImageElement) {
            prepareMessageMediaElement(imageElement, {
                sourceUrl: attachment.url,
                preserveExistingSource: false,
            });
        }
        image.attr('title', attachment.title || mes.extra.title || '');
        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                image.removeAttr('alt');
                image.removeClass('error');
                resolve();
            }
            function onError() {
                image.attr('alt', '');
                image.addClass('error');
                resolve();
            }
            if (imageElement instanceof HTMLImageElement && imageElement.complete && imageElement.naturalWidth > 0) {
                onLoad();
            } else {
                image.off('load').on('load', onLoad);
                image.off('error').on('error', onError);
            }
        }));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a single video attachment to the message element.
     * @param {MediaAttachment} attachment Video attachment object
     * @param {number} index Index of the video attachment
     * @returns {JQuery<HTMLElement>} The appended video container element
     */
    function appendVideoAttachment(attachment, index) {
        const template = $('#message_video_template .mes_video_container').clone();
        template.attr('data-index', index);

        const video = template.find('.mes_video');
        const videoElement = video.get(0);
        if (videoElement instanceof HTMLVideoElement) {
            prepareMessageMediaElement(videoElement, {
                sourceUrl: attachment.url,
                preserveExistingSource: false,
            });
        }
        video.attr('title', attachment.title || mes.extra.title || '');
        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                resolve();
            }
            function onError() {
                video.addClass('error');
                resolve();
            }
            if (videoElement instanceof HTMLVideoElement && videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoad();
            } else {
                video.off('loadeddata').on('loadeddata', onLoad);
                video.off('error').on('error', onError);
            }
        }));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a single audio attachment to the message element.
     * @param {MediaAttachment} attachment Audio attachment object
     * @param {number} index Index of the audio attachment
     * @returns {JQuery<HTMLElement>} The appended audio container element
     */
    function appendAudioAttachment(attachment, index) {
        const template = $('#message_audio_template .mes_audio_container').clone();
        template.attr('data-index', index);
        const audio = template.find('.mes_audio');
        audio.attr('src', attachment.url);
        audio.attr('title', attachment.title || mes.extra.title || '');

        mediaPromises.push(new Promise((resolve) => {
            function onLoad() {
                resolve();
            }
            function onError() {
                audio.addClass('error');
                resolve();
            }
            if (audio.prop('readyState') >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoad();
            } else {
                audio.off('loadeddata').on('loadeddata', onLoad);
                audio.off('error').on('error', onError);
            }
        }));

        new AudioPlayer(audio.get(0), template.get(0));

        mediaBlocks.push(template);
        return template;
    }

    /**
     * Appends a media attachment to the message element.
     * @param {MediaAttachment} attachment Media attachment object
     * @param {number} index Index of the media attachment
     * @returns {JQuery<HTMLElement>} The appended media container element
     */
    function appendMediaAttachment(attachment, index) {
        if (!attachment.type) {
            attachment.type = MEDIA_TYPE.IMAGE;
        }
        switch (attachment.type) {
            case MEDIA_TYPE.IMAGE:
                return appendImageAttachment(attachment, index);
            case MEDIA_TYPE.VIDEO:
                return appendVideoAttachment(attachment, index);
            case MEDIA_TYPE.AUDIO:
                return appendAudioAttachment(attachment, index);
        }

        console.warn(`Unknown media type: ${attachment.type}, defaulting to image.`, attachment);
        return appendImageAttachment(attachment, index);
    }

    /**
     * Saves the current playback times of media elements in the message.
     * @returns {Map<string, MediaState>} Media playback times by source URL
     */
    function saveMediaStates() {
        const states = new Map();
        const media = mediaWrapper.find('video, audio');
        media.each((_, element) => {
            if (element instanceof HTMLMediaElement) {
                if (!element.currentSrc || element.readyState === HTMLMediaElement.HAVE_NOTHING) {
                    return;
                }
                const state = { currentTime: element.currentTime, paused: element.paused };
                states.set(element.currentSrc, state);
            }
        });
        return states;
    }

    /**
     * Restores the playback times of media elements in the message.
     * @param {Map<string, MediaState>} states Media playback times by source URL
     */
    function restoreMediaStates(states) {
        const media = mediaWrapper.find('video, audio');
        media.each((_, element) => {
            if (element instanceof HTMLMediaElement) {
                const restoreState = () => {
                    if (!states.has(element.currentSrc)) {
                        return;
                    }
                    const state = states.get(element.currentSrc);
                    element.currentTime = state.currentTime;
                    if (!state.paused) {
                        element.play();
                    }
                };
                if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
                    element.addEventListener('loadedmetadata', () => restoreState(), { once: true });
                } else {
                    restoreState();
                }
            }
        });
    }

    // Add media gallery to message
    if (hasMedia && mediaDisplay === MEDIA_DISPLAY.GALLERY) {
        const mediaIndex = getMediaIndex(mes);
        const selectedMedia = mes.extra.media[mediaIndex];

        const galleryControls = $('#message_gallery_controls .mes_img_swipes').clone();
        const counter = galleryControls.find('.mes_img_swipe_counter');
        counter.text(`${mediaIndex + 1}/${mes.extra.media.length}`);

        const template = appendMediaAttachment(selectedMedia, mediaIndex);
        template.addClass('img_swipes');
        template.append(galleryControls);
    }

    // Add media as a list to message
    if (hasMedia && mediaDisplay === MEDIA_DISPLAY.LIST) {
        for (let index = 0; index < mes.extra.media.length; index++) {
            const attachment = mes.extra.media[index];
            appendMediaAttachment(attachment, index);
        }
    }

    // Remove existing file containers
    fileWrapper.empty();

    // Add files to message
    if (hasFiles) {
        for (let index = 0; index < mes.extra.files.length; index++) {
            const file = mes.extra.files[index];
            const template = $('#message_file_template .mes_file_container').clone();
            template.attr('data-index', index);
            template.find('.mes_file_name').text(file.name).attr('title', file.name);
            template.find('.mes_file_size').text(humanFileSize(file.size)).attr('title', file.size);
            fileWrapper.append(template);
        }
    }

    // Early return if no media
    if (!hasMedia) {
        mediaWrapper.empty();
        ensureMessageMediaMutationObserver();
        enhanceMessageMediaTree(messageElement.get(0));
        doAdjustScroll();
        return;
    }

    // TODO: Consider making this awaitable
    Promise.race([Promise.all(mediaPromises), delay(debounce_timeout.short)]).then(() => {
        const states = saveMediaStates();
        mediaWrapper.empty().append(mediaBlocks);
        ensureMessageMediaMutationObserver();
        enhanceMessageMediaTree(mediaWrapper.get(0), { preserveExistingSource: false });
        enhanceMessageMediaTree(messageElement.get(0));
        restoreMediaStates(states);
        doAdjustScroll();
    });
}

export function addCopyToCodeBlocks(messageElement) {
    const codeBlocks = $(messageElement).find('pre code');
    for (let i = 0; i < codeBlocks.length; i++) {
        hljs.highlightElement(codeBlocks.get(i));
        const copyButton = document.createElement('i');
        copyButton.classList.add('fa-solid', 'fa-copy', 'code-copy', 'interactable');
        copyButton.title = 'Copy code';
        codeBlocks.get(i).appendChild(copyButton);
        copyButton.addEventListener('click', function (e) {
            e.stopPropagation();
        });
        copyButton.addEventListener('pointerup', async function () {
            const text = codeBlocks.get(i).textContent;
            await copyText(text);
            toastr.info(t`Copied!`, '', { timeOut: 2000 });
        });
    }
}

/**
 * Shows or hides the Prompt display button
 * @param {ChatMessage} message Message object
 * @param {object} options Options
 * @param {number} [options.messageId] Message ID
 * @param {JQuery<HTMLElement>} [options.messageElement] Message element
 * @return {void}
 */
function updateMessageItemizedPromptButton(message, { messageId = chat.indexOf(message), messageElement = chatElement.find(`.mes[mesid="${messageId}"]`) }) {
    //if we have itemized messages, and the array isn't null..
    if (!message.is_user && Array.isArray(itemizedPrompts) && itemizedPrompts.length > 0) {
        const itemizedPrompt = itemizedPrompts.find(x => Number(x.mesId) === Number(messageId));
        if (itemizedPrompt) {
            messageElement.find('.mes_prompt').show();
        }
    }
}

/**
 * Gets messageFormatting for a ChatMessage object.
 * @param {ChatMessage} message
 * @param {object} options Options
 * @param {number} [options.messageId] Message ID
 * @returns {string} Formatted message HTML
 */
function getMessageTextHTML(message, { messageId = chat.indexOf(message) }) {
    // if mes.extra.uses_system_ui is true, set an override on the sanitizer options
    /** @type {Partial<DOMPurify.Config>} */
    const sanitizerOverrides = message.extra?.uses_system_ui ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};

    return messageFormatting(
        message.extra?.display_text || message.mes,
        message.name,
        message.is_system,
        message.is_user,
        messageId,
        sanitizerOverrides,
        false,
    );
}

/**
 * Adds a single message to the chat.
 * @param {ChatMessage} mes Message object
 * @param {object} [options] Options
 * @param {string} [options.type=undefined|'swipe'] Deprecated. Use updateMessageElement instead.
 * @param {number} [options.insertAfter=null] Message ID to insert the new message after
 * @param {boolean} [options.scroll=true] Whether to scroll to the new message
 * @param {number} [options.insertBefore=null] Message ID to insert the new message before
 * @param {number} [options.forceId=null] Force the message ID
 * @param {boolean} [options.showSwipes=true] Whether to refresh the swipe buttons.
 * @param {boolean} [options.insert=true] Whether to insert the message into the DOM.
 * @returns {JQuery<HTMLElement>} The newly added message element
 */
export function addOneMessage(mes, { type = 'normal', insertAfter = null, scroll = true, insertBefore = null, forceId = null, showSwipes = true, insert = true } = {}) {
    let messageText = mes.mes;
    const momentDate = timestampToMoment(mes.send_date);
    const timestamp = momentDate.isValid() ? momentDate.format('LL LT') : '';

    if (mes?.extra?.display_text) {
        messageText = mes.extra.display_text;
    }

    // Forbidden black magic
    // This allows to use "continue" on user messages
    if (type === 'swipe' && mes.swipe_id === undefined) {
        mes.swipe_id = 0;
        mes.swipes = [mes.mes];
    }

    // Resolve message index for both append and explicit insert scenarios.
    const messageId = (() => {
        if (typeof forceId === 'number') {
            return forceId;
        }
        if (typeof insertBefore === 'number') {
            return insertBefore - 1;
        }
        if (typeof insertAfter === 'number') {
            return insertAfter + 1;
        }
        const index = chat.indexOf(mes);
        return index !== -1 ? index : chat.length - 1;
    })();

    let avatarImg = getThumbnailUrl('persona', user_avatar);
    const isSystem = mes.is_system;
    const title = mes.title;

    //for non-user mesages
    if (!mes['is_user']) {
        if (mes.force_avatar) {
            avatarImg = mes.force_avatar;
        } else if (this_chid === undefined) {
            avatarImg = system_avatar;
        } else {
            if (characters[this_chid].avatar !== 'none') {
                avatarImg = getThumbnailUrl('avatar', characters[this_chid].avatar);
            } else {
                avatarImg = default_avatar;
            }
        }
        //old processing:
        //if messge is from sytem, use the name provided in the message JSONL to proceed,
        //if not system message, use name2 (char's name) to proceed
        //characterName = mes.is_system || mes.force_avatar ? mes.name : name2;
    } else if (mes['is_user'] && mes['force_avatar']) {
        // Special case for persona images.
        avatarImg = mes['force_avatar'];
    }

    // if mes.extra.uses_system_ui is true, set an override on the sanitizer options
    const sanitizerOverrides = mes.extra?.uses_system_ui ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};

    messageText = messageFormatting(
        messageText,
        mes.name,
        isSystem,
        mes.is_user,
        chat.indexOf(mes),
        sanitizerOverrides,
        false,
    );
    const bias = messageFormatting(mes.extra?.bias ?? '', '', false, false, -1, {}, false);
    let bookmarkLink = mes?.extra?.bookmark_link ?? '';

    let params = {
        mesId: messageId,
        swipeId: mes.swipe_id ?? 0,
        characterName: mes.name,
        isUser: mes.is_user,
        avatarImg: avatarImg,
        bias: bias,
        isSystem: isSystem,
        title: title,
        bookmarkLink: bookmarkLink,
        forceAvatar: mes.force_avatar,
        timestamp: timestamp,
        extra: mes.extra,
        tokenCount: mes.extra?.token_count ?? 0,
        type: mes.extra?.type ?? '',
        ...formatGenerationTimer(mes.gen_started, mes.gen_finished, mes.extra?.token_count, mes.extra?.reasoning_duration, mes.extra?.time_to_first_token),
    };

    const renderedMessage = getMessageFromTemplate(params);

    if (type !== 'swipe' && insert) {
        if (typeof insertAfter !== 'number' && typeof insertBefore !== 'number') {
            chatElement.append(renderedMessage);
        }
        else if (typeof insertAfter === 'number' && insertAfter >= 0) {
            const target = chatElement.find(`.mes[mesid="${insertAfter}"]`);
            $(renderedMessage).insertAfter(target);
        } else if (typeof insertBefore === 'number' && insertBefore >= 0) {
            const target = chatElement.find(`.mes[mesid="${insertBefore}"]`);
            $(renderedMessage).insertBefore(target);
        } else {
            chatElement.append(renderedMessage);
        }
    }

    const newMessage = insert ? chatElement.find(`[mesid="${messageId}"]`) : renderedMessage;
    const isSmallSys = mes?.extra?.isSmallSys;

    if (isSmallSys === true) {
        newMessage.addClass('smallSysMes');
    }

    if (Array.isArray(mes?.extra?.tool_invocations)) {
        newMessage.addClass('toolCall');
    }

    //shows or hides the Prompt display button
    let mesIdToFind = type === 'swipe' ? messageId - 1 : messageId;  //Number(newMessage.attr('mesId'));

    //if we have itemized messages, and the array isn't null..
    if (params.isUser === false && Array.isArray(itemizedPrompts) && itemizedPrompts.length > 0) {
        const itemizedPrompt = itemizedPrompts.find(x => Number(x.mesId) === Number(mesIdToFind));
        if (itemizedPrompt) {
            newMessage.find('.mes_prompt').show();
        }
    }

    if (type === 'swipe') {
        newMessage.attr('swipeid', params.swipeId);
        newMessage.find('.mes_text').html(messageText).attr('title', title);
        newMessage.find('.timestamp').text(timestamp).attr('title', `${params.extra.api} - ${params.extra.model}`);
        updateReasoningUI(newMessage);
        appendMediaToMessage(mes, newMessage, scroll ? SCROLL_BEHAVIOR.ADJUST : SCROLL_BEHAVIOR.NONE);
        if (power_user.timestamp_model_icon && params.extra?.api) {
            insertSVGIcon(newMessage, params.extra);
        }

        if (mes.swipe_id == mes.swipes.length - 1) {
            newMessage.find('.mes_timer').text(params.timerValue).attr('title', params.timerTitle);
            newMessage.find('.tokenCounterDisplay').text(`${params.tokenCount}t`);
        } else {
            newMessage.find('.mes_timer').empty();
            newMessage.find('.tokenCounterDisplay').empty();
        }
    } else {
        newMessage.find('.mes_text').append(messageText);
        appendMediaToMessage(mes, newMessage, scroll ? SCROLL_BEHAVIOR.ADJUST : SCROLL_BEHAVIOR.NONE);
    }

    addCopyToCodeBlocks(newMessage);

    // Set the swipes counter for all non-user messages.
    if (!params.isUser) {
        updateSwipeCounter(messageId, { messageElement: newMessage });
    }

    // The caller should handle the rest after adding a message to DOM.
    if (!insert) {
        return newMessage;
    }

    //last_mes should always be updated.
    chatElement.find('.mes').removeClass('last_mes');
    chatElement.find('.mes').last().addClass('last_mes');

    if (showSwipes) refreshSwipeButtons();
    // Don't scroll if not inserting last
    if (typeof insertAfter !== 'number' && typeof insertBefore !== 'number' && scroll) {
        scrollChatToBottom({ waitForFrame: true });
    }

    applyCharacterTagsToMessageDivs({ mesIds: messageId });
    updateEditArrowClasses();
    return newMessage;
}

/**
 * Creates the element of a single message as if it were the last message or at forceMesId
 * @param {ChatMessage} mes Message object
 * @param {object} [options] Options
 * @param {number} [options.messageId=chat.length - 1] Force the message ID
 * @param {JQuery<HTMLElement>} [options.messageElement=messageTemplate.clone()] This message element will be updated with the ChatMessage object.
 * @param {SCROLL_BEHAVIOR} [options.adjustMediaScroll=SCROLL_BEHAVIOR.NONE] Scroll behavior option passed to appendMediaToMessage.
 * @returns {JQuery<HTMLElement>} Rendered HTMLElement.
 */
export function updateMessageElement(mes, { messageId = chat.length - 1, messageElement = messageTemplate.clone(), adjustMediaScroll = SCROLL_BEHAVIOR.NONE } = {}) {
    let avatarImg = getThumbnailUrl('persona', user_avatar);

    //for non-user messages
    if (!mes.is_user) {
        if (mes.force_avatar) {
            avatarImg = mes.force_avatar;
        } else if (this_chid === undefined) {
            avatarImg = system_avatar;
        } else if (characters[this_chid] && characters[this_chid].avatar !== 'none') {
            avatarImg = getThumbnailUrl('avatar', characters[this_chid].avatar);
        } else {
            avatarImg = default_avatar;
        }
        //old processing:
        //if message is from system, use the name provided in the message JSONL to proceed,
        //if not system message, use name2 (char's name) to proceed
        //characterName = mes.is_system || mes.force_avatar ? mes.name : name2;
    } else if (mes.is_user && mes.force_avatar) {
        // Special case for persona images.
        avatarImg = mes.force_avatar;
    }
    const momentDate = timestampToMoment(mes.send_date);
    const timestamp = momentDate.isValid() ? momentDate.format('LL LT') : '';
    const messageHTML = getMessageTextHTML(mes, { messageId });
    const bookmarkLink = mes?.extra?.bookmark_link;
    const tokenCount = mes.extra?.token_count;
    const { timerValue, timerTitle } = formatGenerationTimer(mes.gen_started, mes.gen_finished, mes.extra?.token_count, mes.extra?.reasoning_duration, mes.extra?.time_to_first_token);

    messageElement.attr({
        'mesid': messageId,
        'swipeid': mes.swipe_id ?? 0,
        'ch_name': mes.name,
        'is_user': mes.is_user,
        'is_system': !!mes.is_system,
        'bookmark_link': bookmarkLink,
        'force_avatar': !!mes.force_avatar,
        'timestamp': timestamp,
        // ...(type ?? { type }),
        'type': mes.extra?.type ?? '',
    });

    messageElement.find('.avatar img').attr('src', avatarImg);
    messageElement.find('.ch_name .name_text').text(mes.name);
    messageElement.find('.timestamp').text(timestamp).attr('title', `${mes.extra?.api ? mes.extra.api + ' - ' : ''}${mes.extra?.model ?? ''}`);
    messageElement.find('.mesIDDisplay').text(`#${messageId}`);
    tokenCount && messageElement.find('.tokenCounterDisplay').text(`${tokenCount}t`);
    mes.title && messageElement.attr('title', mes.title);
    timerValue && messageElement.find('.mes_timer').attr('title', timerTitle).text(timerValue);
    bookmarkLink && updateBookmarkDisplay(messageElement);

    if (mes.extra?.bias !== '') {
        const bias = messageFormatting(mes.extra?.bias, '', false, false, -1, {}, false);
        messageElement.find('.mes_bias').html(bias);
    }

    updateReasoningUI(messageElement);

    if (power_user.timestamp_model_icon && mes.extra?.api) {
        insertSVGIcon(messageElement, mes.extra);
    }

    if (mes?.extra?.isSmallSys === true) {
        messageElement.addClass('smallSysMes');
    }

    if (Array.isArray(mes?.extra?.tool_invocations)) {
        messageElement.addClass('toolCall');
    }

    updateMessageItemizedPromptButton(mes, { messageId, messageElement });

    messageElement.find('.avatar img').on('error', function () {
        $(this).hide();
        $(this).parent().html('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    });

    appendMediaToMessage(mes, messageElement, adjustMediaScroll);
    messageElement.find('.mes_text').html(messageHTML);
    addCopyToCodeBlocks(messageElement);

    // Set the swipes counter for all non-user messages.
    if (!mes.is_user) {
        updateSwipeCounter(messageId, { message: mes, messageElement });
    }

    return messageElement;
}

/**
 * Returns the URL of the avatar for the given character Id.
 * @param {number|string} characterId Character Id
 * @returns {string} Avatar URL
 */
export function getCharacterAvatar(characterId) {
    const character = characters[characterId];
    const avatarImg = character?.avatar;

    if (!avatarImg || avatarImg === 'none') {
        return default_avatar;
    }

    return formatCharacterAvatar(avatarImg);
}

export function formatCharacterAvatar(characterAvatar) {
    return `characters/${characterAvatar}`;
}

/**
 * Formats the title for the generation timer.
 * @param {MessageTimestamp} gen_started Date when generation was started
 * @param {MessageTimestamp} gen_finished Date when generation was finished
 * @param {number} tokenCount Number of tokens generated (0 if not available)
 * @param {number?} [reasoningDuration=null] Reasoning duration (null if no reasoning was done)
 * @param {number?} [timeToFirstToken=null] Time to first token
 * @returns {Object} Object containing the formatted timer value and title
 * @example
 * const { timerValue, timerTitle } = formatGenerationTimer(gen_started, gen_finished, tokenCount);
 * console.log(timerValue); // 1.2s
 * console.log(timerTitle); // Generation queued: 12:34:56 7 Jan 2021\nReply received: 12:34:57 7 Jan 2021\nTime to generate: 1.2 seconds\nToken rate: 5 t/s
 */
function formatGenerationTimer(gen_started, gen_finished, tokenCount, reasoningDuration = null, timeToFirstToken = null) {
    if (!gen_started || !gen_finished) {
        return {};
    }

    const dateFormat = 'HH:mm:ss D MMM YYYY';
    const start = moment(gen_started);
    const finish = moment(gen_finished);
    const seconds = finish.diff(start, 'seconds', true);
    const timerValue = `${seconds.toFixed(1)}s`;
    const timerTitle = [
        `Generation queued: ${start.format(dateFormat)}`,
        `Reply received: ${finish.format(dateFormat)}`,
        `Time to generate: ${seconds} seconds`,
        timeToFirstToken ? `Time to first token: ${timeToFirstToken / 1000} seconds` : '',
        reasoningDuration > 0 ? `Time to think: ${reasoningDuration / 1000} seconds` : '',
        tokenCount > 0 ? `Token rate: ${Number(tokenCount / seconds).toFixed(3)} t/s` : '',
    ].filter(x => x).join('\n').trim();

    if (isNaN(seconds) || seconds < 0) {
        return { timerValue: '', timerTitle };
    }

    return { timerValue, timerTitle };
}

let requestId = null;

/**
 * Scrolls the chat to the bottom if configured to do so.
 * @param {object} [options] Options
 * @param {boolean} [options.waitForFrame] If true, waits for the animation frame before scrolling
 */
export function scrollChatToBottom({ waitForFrame } = {}) {
    if (!power_user.auto_scroll_chat_to_bottom) {
        return;
    }

    const doScroll = () => {
        let position = chatElement[0].scrollHeight;

        if (power_user.waifuMode) {
            const lastMessage = chatElement.find('.mes').last();
            if (lastMessage.length) {
                const lastMessagePosition = lastMessage.position().top;
                position = chatElement.scrollTop() + lastMessagePosition;
            }
        }

        chatElement.scrollTop(position);
        requestId = null;
    };

    // Do not check truthiness. requestId can loop to zero.
    if (requestId !== null) {
        cancelAnimationFrame(requestId);
    }

    if (!waitForFrame) {
        doScroll();
        return;
    }

    // This prevents layout thrashing.
    // https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame#return_value
    // https://gist.github.com/paulirish/5d52fb081b3570c81e3a#file-what-forces-layout-md
    requestId = requestAnimationFrame(() => doScroll());
}

/**
 * @deprecated Function is not needed anymore, as the new signature of substituteParams is more flexible.
 *
 * Substitutes {{macro}} parameters in a string.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParamsExtended(content, additionalMacro = {}, postProcessFn = (x) => x) {
    return substituteParams(content, { dynamicMacros: additionalMacro, postProcessFn });
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @param {string} content - The string to substitute parameters in.
 * @param {string} [_name1] - The name of the user. Uses global name1 if not provided.
 * @param {string} [_name2] - The name of the character. Uses global name2 if not provided.
 * @param {string} [_original] - The original message for {{original}} substitution.
 * @param {string} [_group] - The group members list for {{group}} substitution.
 * @param {boolean} [_replaceCharacterCard] - Whether to replace character card macros.
 * @param {Record<string,any>} [additionalMacro] - Additional environment variables for substitution.
 * @param {(x: string) => string} [postProcessFn] - Post-processing function for each substituted macro.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParamsLegacy(content, _name1, _name2, _original, _group, _replaceCharacterCard = true, additionalMacro = {}, postProcessFn = (x) => x) {
    if (!content) {
        return '';
    }

    // If experimental macro engine is enabled, use it. This code will be cleaned up in the future.
    if (power_user?.experimental_macro_engine) {
        return substituteParams(content, {
            name1Override: _name1,
            name2Override: _name2,
            original: _original,
            groupOverride: _group,
            replaceCharacterCard: _replaceCharacterCard ?? true,
            dynamicMacros: additionalMacro ?? {},
            postProcessFn: postProcessFn ?? ((x) => x),
        });
    }

    // Try to roughly detect experimental macro features to show the onboarding if needed.
    // This does not have to be 100% accurate, only best effort what we can quickly check.
    // Only do this if the warning wasn't shown yet, to prevent needless regex checks.
    if (accountStorage.getItem('slash_command_experimental_engine_warning_shown') !== 'true') {
        let feature = /** @type {string|null} */ (null);
        if (/{{\s*if/.test(content)) feature = '{{if}} macro';
        else if (/{{\s*\//.test(content)) feature = 'scoped macro';
        else if (/{{\s*[!?~#/]/.test(content)) feature = 'macro flags';
        else if (/{{\s*[.$]/.test(content)) feature = 'variable shorthands';
        else if (/\{\{(?:(?!\}\}).)*\{\{(?=[\s\S]*?\}\}[\s\S]*?\}\})/.test(content)) feature = 'nested macro';
        else if (/{{(?:greeting|charFirstMessage)(?:::\d+)?}}/i.test(content)) feature = 'greeting macro';

        if (feature) void onboardingExperimentalMacroEngine(feature);
    }

    const environment = {};

    if (typeof _original === 'string') {
        let originalSubstituted = false;
        environment.original = () => {
            if (originalSubstituted) {
                return '';
            }

            originalSubstituted = true;
            return _original;
        };
    }

    const getGroupValue = (includeMuted) => {
        if (typeof _group === 'string') {
            return _group;
        }

        if (selected_group) {
            const members = groups.find(x => x.id === selected_group)?.members;
            /** @type {string[]} */
            const disabledMembers = groups.find(x => x.id === selected_group)?.disabled_members ?? [];
            const isMuted = x => includeMuted ? true : !disabledMembers.includes(x);
            const names = Array.isArray(members)
                ? members.filter(isMuted).map(m => getCharacterName(characters.find(c => c.avatar === m))).filter(Boolean).join(', ')
                : '';
            return names;
        } else {
            return _name2 ?? name2;
        }
    };

    const getNotCharValue = () => {
        const currentUser = _name1 ?? name1;
        const currentSpeaker = _name2 ?? name2;

        // Single character chat
        if (!selected_group) {
            return currentUser;
        }

        // Group chat
        const members = groups.find(x => x.id === selected_group)?.members;

        if (!Array.isArray(members)) {
            return currentUser;
        }

        const memberNames = members
            .map(m => getCharacterName(characters.find(c => c.avatar === m)))
            .filter(Boolean); // Filter out any null/undefined names

        // Filter out the current speaker and add the user
        const otherMembers = memberNames.filter(name => name !== currentSpeaker);
        otherMembers.push(currentUser);

        return otherMembers.join(', ');
    };

    if (_replaceCharacterCard) {
        const fields = getCharacterCardFields();
        environment.charPrompt = fields.system || '';
        environment.charInstruction = environment.charJailbreak = fields.jailbreak || '';
        environment.description = fields.description || '';
        environment.personality = fields.personality || '';
        environment.scenario = fields.scenario || '';
        environment.persona = fields.persona || '';
        environment.mesExamples = () => {
            const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
            const mesExamplesArray = parseMesExamples(fields.mesExamples, isInstruct);
            if (isInstruct) {
                const instructExamples = formatInstructModeExamples(mesExamplesArray, name1, name2);
                return instructExamples.join('');
            }
            return mesExamplesArray.join('');
        };
        environment.mesExamplesRaw = fields.mesExamples || '';
        environment.charVersion = fields.version || '';
        environment.char_version = fields.version || '';
        environment.charDepthPrompt = fields.charDepthPrompt || '';
        environment.creatorNotes = fields.creatorNotes || '';
    }

    // Must be substituted last so that they're replaced inside {{description}}
    environment.user = _name1 ?? name1;
    environment.char = _name2 ?? name2;
    environment.group = environment.charIfNotGroup = getGroupValue(true);
    environment.groupNotMuted = getGroupValue(false);
    environment.notChar = getNotCharValue();
    environment.model = getGeneratingModel();

    if (additionalMacro && typeof additionalMacro === 'object') {
        Object.assign(environment, additionalMacro);
    }

    return evaluateMacros(content, environment, postProcessFn);
}

/** @typedef {import('./scripts/macros/engine/MacroRegistry.js').MacroHandler} MacroHandler */

/**
 * Substitutes {{macros}} in a string using the new macro engine.
 *
 * This will replace all registered macros and dynamic additional macros as environment context.
 *
 * @param {string} content - The string to substitute parameters in.
 * @param {Object} [options={}] - Options for the substitution.
 * @param {string} [options.name1Override] - The name of the user. Uses global name1 if not provided.
 * @param {string} [options.name2Override] - The name of the character. Uses global name2 if not provided.
 * @param {string} [options.original] - The original message for {{original}} substitution.
 * @param {string} [options.groupOverride] - The group members list for {{group}} substitution.
 * @param {boolean} [options.replaceCharacterCard=true] - Whether to replace character card macros.
 * @param {Record<string, import('./scripts/macros/engine/MacroEnv.types.js').DynamicMacroValue>} [options.dynamicMacros={}] - Additional environment variables as dynamic macros for substitution. Registered as macro functions.
 * @param {(x: string) => string} [options.postProcessFn=(x) => x] - Post-processing function for each substituted macro.
 * @returns {string} The string with substituted parameters.
 */
export function substituteParams(content, options = {}) {
    if (!content) return '';

    // Handle legacy signature calls to substituteParams
    // We'll simply re-route them to a temporary legacy function. In the future, we'll remove this and cleanly build the options object ourselves.
    const isOptionsObject = options && typeof options === 'object' && !Array.isArray(options);
    if (!isOptionsObject) {
        return substituteParamsLegacy.call(this, ...arguments);
    }

    // Keep the new macro engine behind a feature switch for now
    if (!power_user?.experimental_macro_engine) {
        return substituteParamsLegacy(content, options.name1Override, options.name2Override, options.original, options.groupOverride, options.replaceCharacterCard, options.dynamicMacros, options.postProcessFn);
    }

    const ctx = /** @type {import('./scripts/macros/engine/MacroEnvBuilder.js').MacroEnvRawContext} */ ({
        content,
        name1Override: options.name1Override,
        name2Override: options.name2Override,
        original: options.original,
        groupOverride: options.groupOverride,
        replaceCharacterCard: options.replaceCharacterCard ?? true,
        dynamicMacros: options.dynamicMacros ?? {},
        postProcessFn: options.postProcessFn ?? ((x) => x),
    });

    const env = MacroEnvBuilder.buildFromRawEnv(ctx);
    const result = MacroEngine.evaluate(content, env);
    return result;
}


/**
 * Gets stopping sequences for the prompt.
 * @param {boolean} isImpersonate A request is made to impersonate a user
 * @param {boolean} isContinue A request is made to continue the message
 * @param {string} [api] Optional API name to get API-specific stopping sequences for
 * @returns {string[]} Array of stopping strings
 */
export function getStoppingStrings(isImpersonate, isContinue, api = main_api) {
    // Only custom stop strings apply to Chat Completion
    if (api === 'openai') {
        return getCustomStoppingStrings();
    }

    const result = [];

    if (power_user.context.names_as_stop_strings) {
        const charString = `\n${name2}:`;
        const userString = `\n${name1}:`;
        result.push(isImpersonate ? charString : userString);

        result.push(userString);

        if (isContinue && Array.isArray(chat) && chat[chat.length - 1]?.is_user) {
            result.push(charString);
        }

        // Add group members as stopping strings if generating for a specific group member or user. (Allow slash commands to work around name stopping string restrictions)
        if (selected_group && (name2 || isImpersonate)) {
            const group = groups.find(x => x.id === selected_group);

            if (group && Array.isArray(group.members)) {
                const names = group.members
                    .map(x => characters.find(y => y.avatar == x))
                    .filter(x => x && x.name && x.name !== name2)
                    .map(x => `\n${x.name}:`);
                result.push(...names);
            }
        }
    }

    result.push(...getInstructStoppingSequences());
    result.push(...getCustomStoppingStrings());

    if (power_user.single_line) {
        result.unshift('\n');
    }

    return result.filter(x => x).filter(onlyUnique);
}

/**
 * Background generation based on the provided prompt.
 * @typedef {object} GenerateQuietPromptParams
 * @prop {string} [quietPrompt] Instruction prompt for the AI
 * @prop {boolean} [quietToLoud] Whether the message should be sent in a foreground (loud) or background (quiet) mode
 * @prop {boolean} [skipWIAN] Whether to skip addition of World Info and Author's Note into the prompt
 * @prop {string} [quietImage] Image to use for the quiet prompt
 * @prop {string} [quietName] Name to use for the quiet prompt (defaults to "System:")
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {number} [forceChId] Character ID to use for this generation run. Works in groups only.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {boolean} [removeReasoning] Parses and removes the reasoning block according to reasoning format preferences
 * @prop {boolean} [trimToSentence] Whether to trim the response to the last complete sentence
 * @param {GenerateQuietPromptParams} params Parameters for the quiet prompt generation
 * @returns {Promise<string>} Generated text. If using structured output, will contain a serialized JSON object.
 */
export async function generateQuietPrompt({ quietPrompt = '', quietToLoud = false, skipWIAN = false, quietImage = null, quietName = null, responseLength = null, forceChId = null, jsonSchema = null, removeReasoning = true, trimToSentence = false } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateQuietPrompt called with positional arguments. Please use an object instead.');
        [quietPrompt, quietToLoud, skipWIAN, quietImage, quietName, responseLength, forceChId, jsonSchema] = arguments;
    }

    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;
    let eventHook = () => { };
    try {
        /** @type {GenerateOptions} */
        const generateOptions = {
            quiet_prompt: quietPrompt ?? '',
            quietToLoud: quietToLoud ?? false,
            skipWIAN: skipWIAN ?? false,
            force_name2: true,
            quietImage: quietImage ?? null,
            quietName: quietName ?? null,
            force_chid: forceChId ?? null,
            jsonSchema: jsonSchema ?? null,
        };
        if (responseLengthCustomized) {
            TempResponseLength.save(main_api, responseLength);
            eventHook = TempResponseLength.setupEventHook(main_api);
        }
        let result = await Generate('quiet', generateOptions);
        result = trimToSentence ? trimToEndSentence(result) : result;
        result = removeReasoning ? removeReasoningFromString(result) : result;
        return result;
    } finally {
        if (responseLengthCustomized && TempResponseLength.isCustomized()) {
            TempResponseLength.restore(main_api);
            TempResponseLength.removeEventHook(main_api, eventHook);
        }
    }
}

/**
 * Executes slash commands and returns the new text and whether the generation was interrupted.
 * @param {string} message Text to be sent
 * @returns {Promise<boolean>} Whether the message sending was interrupted
 */
export async function processCommands(message) {
    if (!message || !message.trim().startsWith('/')) {
        return false;
    }
    await executeSlashCommandsOnChatInput(message, {
        clearChatInput: true,
    });
    return true;
}

/**
 * Extracts the contents of bias macros from a message.
 * @param {string} message Message text
 * @returns {string} Message bias extracted from the message (or an empty string if not found)
 */
export function extractMessageBias(message) {
    if (!message) {
        return '';
    }

    try {
        const biasHandlebars = Handlebars.create();
        const biasMatches = [];
        biasHandlebars.registerHelper('bias', function (text) {
            biasMatches.push(text);
            return '';
        });
        const template = biasHandlebars.compile(message);
        template({});

        if (biasMatches && biasMatches.length > 0) {
            return ` ${biasMatches.join(' ')}`;
        }

        return '';
    } catch {
        return '';
    }
}

/**
 * Removes impersonated group member lines from the group member messages.
 * Doesn't do anything if group reply trimming is disabled.
 * @param {string} getMessage Group message
 * @returns Cleaned-up group message
 */
function cleanGroupMessage(getMessage) {
    if (power_user.disable_group_trimming) {
        return getMessage;
    }

    const group = groups.find((x) => x.id == selected_group);

    if (group && Array.isArray(group.members) && group.members) {
        for (let member of group.members) {
            const character = characters.find(x => x.avatar == member);

            if (!character) {
                continue;
            }

            const name = getCharacterName(character);

            // Skip current speaker.
            if (name === name2) {
                continue;
            }

            const regex = new RegExp(`(^|\n)${escapeRegex(name)}:`);
            const nameMatch = getMessage.match(regex);
            if (nameMatch) {
                getMessage = getMessage.substring(0, nameMatch.index);
            }
        }
    }
    return getMessage;
}

function addPersonaDescriptionExtensionPrompt() {
    const INJECT_TAG = 'PERSONA_DESCRIPTION';
    setExtensionPrompt(INJECT_TAG, '', extension_prompt_types.IN_PROMPT, 0);

    if (!power_user.persona_description || power_user.persona_description_position === persona_description_positions.NONE) {
        return;
    }

    const promptPositions = [persona_description_positions.BOTTOM_AN, persona_description_positions.TOP_AN];

    if (promptPositions.includes(power_user.persona_description_position) && shouldWIAddPrompt) {
        const originalAN = extension_prompts[NOTE_MODULE_NAME].value;
        const ANWithDesc = power_user.persona_description_position === persona_description_positions.TOP_AN
            ? `${power_user.persona_description}\n${originalAN}`
            : `${originalAN}\n${power_user.persona_description}`;

        setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, chat_metadata[metadata_keys.position], chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
    }

    if (power_user.persona_description_position === persona_description_positions.AT_DEPTH) {
        setExtensionPrompt(INJECT_TAG, power_user.persona_description, extension_prompt_types.IN_CHAT, power_user.persona_description_depth, true, power_user.persona_description_role);
    }
}

/**
 * Returns all extension prompts combined.
 * @returns {Promise<string>} Combined extension prompts
 */
async function getAllExtensionPrompts() {
    const values = [];

    for (const prompt of Object.values(extension_prompts)) {
        const value = prompt?.value?.trim();

        if (!value) {
            continue;
        }

        const hasFilter = typeof prompt.filter === 'function';
        if (hasFilter && !await prompt.filter()) {
            continue;
        }

        values.push(value);
    }

    return substituteParams(values.join('\n'));
}

/**
 * Wrapper to fetch extension prompts by module name
 * @param {string} moduleName Module name
 * @returns {Promise<string>} Extension prompt
 */
export async function getExtensionPromptByName(moduleName) {
    if (!moduleName) {
        return '';
    }

    const prompt = extension_prompts[moduleName];

    if (!prompt) {
        return '';
    }

    const hasFilter = typeof prompt.filter === 'function';

    if (hasFilter && !await prompt.filter()) {
        return '';
    }

    return substituteParams(prompt.value);
}

/**
 * Gets the maximum depth of extension prompts.
 * @returns {number} Maximum depth of extension prompts
 */
export function getExtensionPromptMaxDepth() {
    return MAX_INJECTION_DEPTH;
    /*
    const prompts = Object.values(extension_prompts);
    const maxDepth = Math.max(...prompts.map(x => x.depth ?? 0));
    // Clamp to 1 <= depth <= MAX_INJECTION_DEPTH
    return Math.max(Math.min(maxDepth, MAX_INJECTION_DEPTH), 1);
    */
}

/**
 * Returns the extension prompt for the given position, depth, and role.
 * If multiple prompts are found, they are joined with a separator.
 * @param {number} [position] Position of the prompt
 * @param {number} [depth] Depth of the prompt
 * @param {string} [separator] Separator for joining multiple prompts
 * @param {number} [role] Role of the prompt
 * @param {boolean} [wrap] Wrap start and end with a separator
 * @returns {Promise<string>} Extension prompt
 */
export async function getExtensionPrompt(position = extension_prompt_types.IN_PROMPT, depth = undefined, separator = '\n', role = undefined, wrap = true) {
    const filterByFunction = async (prompt) => {
        const hasFilter = typeof prompt.filter === 'function';
        if (hasFilter && !await prompt.filter()) {
            return false;
        }
        return true;
    };
    const promptPromises = Object.keys(extension_prompts)
        .sort()
        .map((x) => extension_prompts[x])
        .filter(x => x.position == position && x.value)
        .filter(x => depth === undefined || x.depth === undefined || x.depth === depth)
        .filter(x => role === undefined || x.role === undefined || x.role === role)
        .filter(filterByFunction);
    const prompts = await Promise.all(promptPromises);

    let values = prompts.map(x => x.value.trim()).join(separator);
    if (wrap && values.length && !values.startsWith(separator)) {
        values = separator + values;
    }
    if (wrap && values.length && !values.endsWith(separator)) {
        values = values + separator;
    }
    if (values.length) {
        values = substituteParams(values);
    }
    return values;
}

/**
 * Base chat replacement function for character card fields.
 * 1. Substitutes macros using substituteParams.
 * 2. Collapses newlines if enabled in power user settings.
 * 3. Removes carriage return characters.
 * @param {string} value Input string
 * @param {string?} name1Override Override for name1
 * @param {string?} name2Override Override for name2
 * @returns {string} Processed string
 */
export function baseChatReplace(value, name1Override = null, name2Override = null) {
    if (typeof value === 'string' && value.length > 0) {
        value = substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false });

        if (power_user.collapse_newlines) {
            value = collapseNewlines(value);
        }

        value = value.replace(/\r/g, '');
    }
    return value;
}

/**
 * @typedef {Object} CharacterCardFields
 * @property {string} system System prompt
 * @property {string} mesExamples Message examples
 * @property {string} description Description
 * @property {string} personality Personality
 * @property {string} persona Persona
 * @property {string} scenario Scenario
 * @property {string} jailbreak Jailbreak instructions
 * @property {string} version Character version
 * @property {string} charDepthPrompt Character depth note
 * @property {string} creatorNotes Character creator notes
 * @property {string} firstMessage Character first message / greeting
 * @property {string[]} alternateGreetings Character alternate greetings
 */

/**
 * Helper to create an object with lazy, memoized getters from a map of field resolvers.
 * @param {Record<string, () => string|string[]>} resolvers Map of field names to resolver functions
 * @returns {CharacterCardFields} Object with lazy getters
 */
export function createLazyFields(resolvers) {
    const result = /** @type {CharacterCardFields} */ ({});
    for (const [key, resolver] of Object.entries(resolvers)) {
        let cached;
        let resolved = false;
        Object.defineProperty(result, key, {
            get() {
                if (!resolved) {
                    cached = resolver();
                    resolved = true;
                }
                return cached;
            },
            enumerable: true,
            configurable: true,
        });
    }
    return result;
}

/**
 * @param {Character|any} character
 * @returns {Record<string, any>|undefined}
 */
function getCharacterData(character) {
    return character && typeof character === 'object' && character.data && typeof character.data === 'object'
        ? character.data
        : undefined;
}

/**
 * @param {Character|any} character
 * @returns {Record<string, any>|undefined}
 */
function getCharacterExtensions(character) {
    const data = getCharacterData(character);
    return data && typeof data.extensions === 'object' ? data.extensions : undefined;
}

export function getCharacterName(character) {
    return getCharacterData(character)?.name ?? character?.name ?? '';
}

export function getCharacterDescription(character) {
    return getCharacterData(character)?.description ?? character?.description ?? '';
}

export function getCharacterPersonality(character) {
    return getCharacterData(character)?.personality ?? character?.personality ?? '';
}

export function getCharacterScenario(character) {
    return getCharacterData(character)?.scenario ?? character?.scenario ?? '';
}

export function getCharacterFirstMessage(character) {
    return getCharacterData(character)?.first_mes ?? character?.first_mes ?? '';
}

export function getCharacterMesExample(character) {
    return getCharacterData(character)?.mes_example ?? character?.mes_example ?? '';
}

export function getCharacterCreatorNotes(character) {
    return getCharacterData(character)?.creator_notes ?? character?.creator_notes ?? character?.creatorcomment ?? '';
}

export function getCharacterTags(character) {
    const tags = getCharacterData(character)?.tags ?? character?.tags;
    return Array.isArray(tags) ? tags : [];
}

export function getCharacterSystemPrompt(character) {
    return getCharacterData(character)?.system_prompt ?? character?.system_prompt ?? '';
}

export function getCharacterPostHistoryInstructions(character) {
    return getCharacterData(character)?.post_history_instructions ?? character?.post_history_instructions ?? '';
}

export function getCharacterVersion(character) {
    return getCharacterData(character)?.character_version ?? character?.character_version ?? '';
}

export function getCharacterCreator(character) {
    return getCharacterData(character)?.creator ?? character?.creator ?? '';
}

export function getCharacterAlternateGreetings(character) {
    const alternateGreetings = getCharacterData(character)?.alternate_greetings ?? character?.alternate_greetings;
    return Array.isArray(alternateGreetings) ? alternateGreetings : [];
}

export function getCharacterWorld(character) {
    return getCharacterExtensions(character)?.world ?? character?.world ?? '';
}

export function getCharacterDepthPromptPrompt(character) {
    return getCharacterExtensions(character)?.depth_prompt?.prompt ?? character?.depth_prompt_prompt ?? '';
}

export function getCharacterDepthPromptDepth(character) {
    return getCharacterExtensions(character)?.depth_prompt?.depth ?? character?.depth_prompt_depth;
}

export function getCharacterDepthPromptRole(character) {
    return getCharacterExtensions(character)?.depth_prompt?.role ?? character?.depth_prompt_role;
}

export function getCharacterTalkativeness(character) {
    return getCharacterExtensions(character)?.talkativeness ?? character?.talkativeness;
}

export function isCharacterFavorite(character) {
    const favorite = getCharacterExtensions(character)?.fav ?? character?.fav;
    return favorite === true || favorite === 'true';
}

/**
 * Returns the character card fields for the current character as lazy getters.
 * Each field is only processed (baseChatReplace) when first accessed.
 * @param {Object} [options={}]
 * @param {number} [options.chid] Optional character index
 * @returns {CharacterCardFields} Character card fields with lazy evaluation
 */
export function getCharacterCardFieldsLazy({ chid = undefined } = {}) {
    const currentChid = chid ?? this_chid;
    const character = characters[currentChid];

    // For group chats, we need to check if group cards should be used
    const useGroupCards = selected_group && character;
    const groupCardsLazy = useGroupCards ? getGroupCharacterCardsLazy(selected_group, Number(currentChid)) : null;

    /** @type {Record<string, () => string|string[]>} */
    const resolvers = {
        persona: () => baseChatReplace(power_user.persona_description?.trim()),
        system: () => {
            if (!character) return '';
            const systemPrompt = chat_metadata['system_prompt'] || getCharacterSystemPrompt(character) || '';
            return power_user.prefer_character_prompt ? baseChatReplace(systemPrompt.trim()) : '';
        },
        jailbreak: () => {
            if (!character) return '';
            return power_user.prefer_character_jailbreak ? baseChatReplace(getCharacterPostHistoryInstructions(character)?.trim()) : '';
        },
        version: () => getCharacterVersion(character),
        charDepthPrompt: () => {
            if (!character) return '';
            return baseChatReplace(getCharacterDepthPromptPrompt(character)?.trim());
        },
        creatorNotes: () => {
            if (!character) return '';
            return baseChatReplace(getCharacterCreatorNotes(character)?.trim());
        },
        // These four fields may be overridden by group cards
        description: () => {
            if (groupCardsLazy) return groupCardsLazy.description;
            if (!character) return '';
            return baseChatReplace(getCharacterDescription(character)?.trim());
        },
        personality: () => {
            if (groupCardsLazy) return groupCardsLazy.personality;
            if (!character) return '';
            return baseChatReplace(getCharacterPersonality(character)?.trim());
        },
        scenario: () => {
            if (groupCardsLazy) return groupCardsLazy.scenario;
            if (!character) return '';
            const scenarioText = chat_metadata['scenario'] || getCharacterScenario(character) || '';
            return baseChatReplace(scenarioText.trim());
        },
        mesExamples: () => {
            if (groupCardsLazy) return groupCardsLazy.mesExamples;
            if (!character) return '';
            const exampleDialog = chat_metadata['mes_example'] || getCharacterMesExample(character) || '';
            return baseChatReplace(exampleDialog.trim());
        },
        firstMessage: () => {
            if (!character) return '';
            const firstMes = character.first_mes?.trim() || '';
            return baseChatReplace(firstMes);
        },
        alternateGreetings: () => {
            if (!character) return [];
            const altGreetings = character.data?.alternate_greetings;
            if (!Array.isArray(altGreetings)) return [];
            return altGreetings.map(greeting => baseChatReplace(greeting?.trim()));
        },
    };

    return createLazyFields(resolvers);
}

/**
 * Returns the character card fields for the current character.
 * @param {Object} [options={}]
 * @param {number} [options.chid] Optional character index
 * @returns {CharacterCardFields} Character card fields
 */
export function getCharacterCardFields({ chid = undefined } = {}) {
    const lazy = getCharacterCardFieldsLazy({ chid });

    // Resolve all lazy fields into a plain object
    return {
        system: lazy.system,
        mesExamples: lazy.mesExamples,
        description: lazy.description,
        personality: lazy.personality,
        persona: lazy.persona,
        scenario: lazy.scenario,
        jailbreak: lazy.jailbreak,
        version: lazy.version,
        charDepthPrompt: lazy.charDepthPrompt,
        creatorNotes: lazy.creatorNotes,
        firstMessage: lazy.firstMessage,
        alternateGreetings: lazy.alternateGreetings,
    };
}

/**
 * Parses an examples string.
 * @param {string} examplesStr
 * @returns {string[]} Examples array with block heading
 */
export function parseMesExamples(examplesStr, isInstruct) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }

    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }

    const exampleSeparator = power_user.context.example_separator ? `${substituteParams(power_user.context.example_separator)}\n` : '';
    const blockHeading = (main_api === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator;
    const splitExamples = examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);

    return splitExamples;
}

export function isStreamingEnabled() {
    return (
        (main_api == 'openai' &&
            oai_settings.stream_openai &&
            !(oai_settings.chat_completion_source == chat_completion_sources.OPENAI && ['o1-2024-12-17', 'o1'].includes(oai_settings.openai_model))
        )
        || (main_api == 'kobold' && kai_settings.streaming_kobold && kai_flags.can_use_streaming)
        || (main_api == 'novel' && nai_settings.streaming_novel)
        || (main_api == 'textgenerationwebui' && textgen_settings.streaming));
}

let activeGenerationTypeForStopButton = '';

function showStopButton(generationType = '') {
    if (typeof generationType === 'string' && generationType.length > 0) {
        activeGenerationTypeForStopButton = generationType;
    }
    $('#mes_stop').css({ 'display': 'flex' });
}

function hideStopButton() {
    // prevent NOOP, because hideStopButton() gets called multiple times
    if ($('#mes_stop').css('display') !== 'none') {
        if (activeGenerationTypeForStopButton && activeGenerationTypeForStopButton !== 'quiet') {
            consumeEphemeralScriptInjectsForMainGeneration();
        }
        activeGenerationTypeForStopButton = '';
        $('#mes_stop').css({ 'display': 'none' });
        eventSource.emit(event_types.GENERATION_ENDED, chat.length);
    }
}

class StreamingProcessor {
    /**
     * Creates a new streaming processor.
     * @param {string} type Generation type
     * @param {boolean} forceName2 If true, force the use of name2
     * @param {Date} timeStarted Date when generation was started
     * @param {string} continueMessage Previous message if the type is 'continue'
     * @param {PromptReasoning} promptReasoning Prompt reasoning instance
     */
    constructor(type, forceName2, timeStarted, continueMessage, promptReasoning) {
        this.result = '';
        this.messageId = -1;
        /** @type {HTMLElement} */
        this.messageDom = null;
        /** @type {HTMLElement} */
        this.messageTextDom = null;
        /** @type {HTMLElement} */
        this.messageTimerDom = null;
        /** @type {HTMLElement} */
        this.messageTokenCounterDom = null;
        /** @type {HTMLTextAreaElement} */
        this.sendTextarea = document.querySelector('#send_textarea');
        this.type = type;
        this.force_name2 = forceName2;
        this.isStopped = false;
        this.isFinished = false;
        this.generator = this.nullStreamingGeneration;
        this.abortController = new AbortController();
        this.firstMessageText = '...';
        this.timeStarted = timeStarted;
        /** @type {number?} */
        this.timeToFirstToken = null;
        this.createdAt = new Date();
        this.continueMessage = type === 'continue' ? continueMessage : '';
        this.swipes = [];
        /** @type {import('./scripts/logprobs.js').TokenLogprobs[]} */
        this.messageLogprobs = [];
        this.toolCalls = [];
        // Initialize reasoning in its own handler
        this.reasoningHandler = new ReasoningHandler(timeStarted);
        /** @type {PromptReasoning} */
        this.promptReasoning = promptReasoning;
        /** @type {string[]} */
        this.images = [];
        /** @type {string?} */
        this.reasoningSignature = null;
    }

    /**
     * Initializes DOM elements for the current message.
     * @param {number} messageId Current message ID
     * @param {boolean?} continueOnReasoning If continuing on reasoning
     */
    async #checkDomElements(messageId, continueOnReasoning = null) {
        if (this.messageDom === null || this.messageTextDom === null) {
            this.messageDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
            this.messageTextDom = this.messageDom?.querySelector('.mes_text');
            this.messageTimerDom = this.messageDom?.querySelector('.mes_timer');
            this.messageTokenCounterDom = this.messageDom?.querySelector('.tokenCounterDisplay');
        }
        if (continueOnReasoning) {
            await this.reasoningHandler.process(messageId, false, this.promptReasoning);
        }
        this.reasoningHandler.updateDom(messageId);
    }

    #updateMessageBlockVisibility() {
        if (this.messageDom instanceof HTMLElement && Array.isArray(this.toolCalls) && this.toolCalls.length > 0) {
            const shouldHide = ['', '...'].includes(this.result) && !this.reasoningHandler.reasoning;
            this.messageDom.classList.toggle('displayNone', shouldHide);
        }
    }

    markUIGenStarted() {
        deactivateSendButtons();
    }

    markUIGenStopped() {
        unblockGeneration();
    }

    async onStartStreaming(text) {
        const continueOnReasoning = !!(this.type === 'continue' && this.promptReasoning.prefixReasoning);
        if (continueOnReasoning) {
            this.reasoningHandler.initContinue(this.promptReasoning);
        }

        let messageId = -1;

        if (this.type == 'impersonate') {
            this.sendTextarea.value = '';
            this.sendTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            await saveReply({ type: this.type, getMessage: text, fromStreaming: true });
            messageId = chat.length - 1;
            await this.#checkDomElements(messageId, continueOnReasoning);
            this.markUIGenStarted();
        }
        hideSwipeButtons({ hideCounters: true });
        scrollChatToBottom({ waitForFrame: true });
        return messageId;
    }

    async onProgressStreaming(messageId, text, isFinal) {
        const isImpersonate = this.type == 'impersonate';
        const isContinue = this.type == 'continue';

        if (!isImpersonate && !isContinue && Array.isArray(this.swipes) && this.swipes.length > 0) {
            for (let i = 0; i < this.swipes.length; i++) {
                this.swipes[i] = cleanUpMessage({
                    getMessage: this.swipes[i],
                    isImpersonate: false,
                    isContinue: false,
                    displayIncompleteSentences: true,
                    stoppingStrings: this.stoppingStrings,
                });
            }
        }

        let processedText = cleanUpMessage({
            getMessage: text,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: !isFinal,
            stoppingStrings: this.stoppingStrings,
        });

        const charsToBalance = ['*', '"', '```', '~~~'];
        for (const char of charsToBalance) {
            if (!isFinal && isOdd(countOccurrences(processedText, char))) {
                const separator = char.length > 1 ? '\n' : '';
                processedText = processedText.trimEnd() + separator + char;
            }
        }

        if (isImpersonate) {
            this.sendTextarea.value = processedText;
            this.sendTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            const mesChanged = chat[messageId].mes !== processedText;
            await this.#checkDomElements(messageId);
            this.#updateMessageBlockVisibility();
            const currentTime = new Date();
            chat[messageId].mes = processedText;
            chat[messageId].gen_started = this.timeStarted;
            chat[messageId].gen_finished = currentTime;
            if (!chat[messageId].extra) {
                chat[messageId].extra = {};
            }
            chat[messageId].extra.time_to_first_token = this.timeToFirstToken;

            // Update reasoning
            await this.reasoningHandler.process(messageId, mesChanged, this.promptReasoning);
            processedText = chat[messageId].mes;

            // Token count update.
            const tokenCountText = this.reasoningHandler.reasoning + processedText;
            const currentTokenCount = isFinal && power_user.message_token_count_enabled ? await getTokenCountAsync(tokenCountText, 0) : 0;
            if (currentTokenCount) {
                chat[messageId].extra.token_count = currentTokenCount;
                if (this.messageTokenCounterDom instanceof HTMLElement) {
                    this.messageTokenCounterDom.textContent = `${currentTokenCount}t`;
                }
            }

            if ((this.type == 'swipe' || this.type === 'continue') && Array.isArray(chat[messageId].swipes)) {
                chat[messageId].swipes[chat[messageId].swipe_id] = processedText;
                chat[messageId].swipe_info[chat[messageId].swipe_id] = {
                    'send_date': chat[messageId].send_date,
                    'gen_started': chat[messageId].gen_started,
                    'gen_finished': chat[messageId].gen_finished,
                    'extra': structuredClone(chat[messageId].extra),
                };
            }

            const formattedText = messageFormatting(
                processedText,
                chat[messageId].name,
                chat[messageId].is_system,
                chat[messageId].is_user,
                messageId,
                {},
                false,
            );
            if (this.messageTextDom instanceof HTMLElement) {
                if (power_user.stream_fade_in) {
                    applyStreamFadeIn(this.messageTextDom, formattedText);
                } else {
                    this.messageTextDom.innerHTML = formattedText;
                }
            }

            const timePassed = formatGenerationTimer(this.timeStarted, currentTime, currentTokenCount, this.reasoningHandler.getDuration(), this.timeToFirstToken);
            if (this.messageTimerDom instanceof HTMLElement) {
                this.messageTimerDom.textContent = timePassed.timerValue;
                this.messageTimerDom.title = timePassed.timerTitle;
            }

            this.setFirstSwipe(messageId);
        }

        if (!scrollLock) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }

    /**
     * Finalizes an intermediary message after generation is complete, or a tool call is performed.
     * Performs essential message processing (code blocks, reasoning, swipes, attachments, events)
     * without the heavier finish operations (UI unlock - optional, auto-swipe, sound, save chat).
     * @param {number} messageId - The message ID to finalize.
     * @param {string} text - The message text.
     * @param {Object} options - Additional options for finalization.
     * @param {boolean} options.unlockUI - Whether to unlock the generation UI.
     */
    async finalizeIntermediaryMessage(messageId, text, { unlockUI = true }) {
        await this.onProgressStreaming(messageId, text, true);
        const messageElement = chatElement.find(`.mes[mesid="${messageId}"]`);
        const message = chat[messageId];
        addCopyToCodeBlocks(messageElement);

        await this.reasoningHandler.finish(messageId);

        if (Array.isArray(this.swipes) && this.swipes.length > 0) {
            const swipeInfoExtra = structuredClone(message.extra ?? {});
            delete swipeInfoExtra.token_count;
            delete swipeInfoExtra.reasoning;
            delete swipeInfoExtra.reasoning_duration;
            const swipeInfo = {
                send_date: message.send_date,
                gen_started: message.gen_started,
                gen_finished: message.gen_finished,
                extra: swipeInfoExtra,
            };
            const swipeInfoArray = Array(this.swipes.length).fill().map(() => structuredClone(swipeInfo));
            parseReasoningInSwipes(this.swipes, swipeInfoArray, message.extra?.reasoning_duration);
            message.swipes.push(...this.swipes);
            message.swipe_info.push(...swipeInfoArray);
        }

        syncMesToSwipe(messageId);
        saveLogprobsForActiveMessage(this.messageLogprobs.filter(Boolean), this.continueMessage);

        if (Array.isArray(this.images) && this.images.length > 0) {
            await processImageAttachment(message, { imageUrls: this.images });
            appendMediaToMessage(message, $(this.messageDom));
        }

        // Store reasoning signature for models that support multi-turn context
        if (this.reasoningSignature) {
            message.extra = message.extra || {};
            message.extra.reasoning_signature = this.reasoningSignature;
        }

        if (unlockUI) {
            this.markUIGenStopped();
        }

        if (this.type !== 'impersonate') {
            await eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, this.messageId, this.type);
        } else {
            await eventSource.emit(event_types.IMPERSONATE_READY, text);
        }

        updateSwipeCounter(messageId, { message, messageElement });
    }

    async onFinishStreaming(messageId, text) {
        await this.finalizeIntermediaryMessage(messageId, text, { unlockUI: true });

        const isAborted = this.abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(text)) {
            return await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }
        if (shouldUseLukerServerPersistenceForType(this.type) && this.messageId >= 0 && chat[this.messageId]) {
            chat[this.messageId].extra = chat[this.messageId].extra || {};
            chat[this.messageId].extra.luker_generation_id = getLastLukerGenerationIdForApi() || chat[this.messageId].extra.luker_generation_id;
        }
        const serverPersistedReply = isLastLukerReplyPersistedByServerForApi();
        const canUseIncrementalAppend = !isAborted
            && this.type === 'normal'
            && this.messageId >= 0
            && this.messageId === (chat.length - 1)
            && !chat[this.messageId]?.is_user
            && !serverPersistedReply;
        const localSaveStrategy = serverPersistedReply ? 'skip_local_save' : canUseIncrementalAppend ? 'append' : 'save';
        if (shouldUseLukerServerPersistenceForType(this.type)) {
            logLukerPersistenceDebug(main_api, 'save_decision', {
                type: this.type,
                strategy: localSaveStrategy,
                generation_id: getLastLukerGenerationIdForApi(),
                server_persisted: serverPersistedReply,
                aborted: isAborted,
                message_id: this.messageId,
            });
        }
        if (serverPersistedReply) {
            // Backend persisted the reply after ACK timeout; avoid writing it again on the client.
        } else if (canUseIncrementalAppend) {
            const appended = await appendChatMessages([chat[this.messageId]]);
            if (!appended) {
                await saveChatConditional();
            }
        } else {
            await saveChatConditional();
        }

        playMessageSound();
        notifyMessageComplete(text, String(chat[this.messageId]?.name || ''));
    }

    onErrorStreaming() {
        this.abortController.abort();
        this.isStopped = true;

        this.markUIGenStopped();

        const noEmitTypes = ['swipe', 'impersonate', 'continue'];
        if (!noEmitTypes.includes(this.type)) {
            eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
            eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, this.messageId, this.type);
        }
    }

    setFirstSwipe(messageId) {
        if (this.type !== 'swipe' && this.type !== 'impersonate') {
            if (Array.isArray(chat[messageId].swipes) && chat[messageId].swipes.length === 1 && chat[messageId].swipe_id === 0) {
                chat[messageId].swipes[0] = chat[messageId].mes;
                chat[messageId].swipe_info[0] = {
                    'send_date': chat[messageId].send_date,
                    'gen_started': chat[messageId].gen_started,
                    'gen_finished': chat[messageId].gen_finished,
                    'extra': structuredClone(chat[messageId].extra),
                };
            }
        }
    }

    onStopStreaming() {
        this.abortController.abort();
        this.isFinished = true;
    }

    /**
     * @returns {AsyncGenerator<{ text: string, swipes: string[], logprobs: import('./scripts/logprobs.js').TokenLogprobs, toolCalls: any[], state: any }, void, void>}
     */
    async* nullStreamingGeneration() {
        throw new Error('Generation function for streaming is not hooked up');
    }

    async generate() {
        if (this.messageId == -1) {
            this.messageId = await this.onStartStreaming(this.firstMessageText);
            await delay(1); // delay for message to be rendered
            scrollLock = false;
        }

        // Stopping strings are expensive to calculate, especially with macros enabled. To remove stopping strings
        // when streaming, we cache the result of getStoppingStrings instead of calling it once per token.
        const isImpersonate = this.type == 'impersonate';
        const isContinue = this.type == 'continue';
        this.stoppingStrings = getStoppingStrings(isImpersonate, isContinue, main_api);

        try {
            const sw = new Stopwatch(1000 / power_user.streaming_fps);
            const timestamps = [];
            for await (const { text, swipes, logprobs, toolCalls, state } of this.generator()) {
                const now = Date.now();
                timestamps.push(now);
                if (!this.timeToFirstToken) {
                    this.timeToFirstToken = now - this.createdAt.getTime();
                }
                if (this.isStopped || this.abortController.signal.aborted) {
                    return this.result;
                }

                this.toolCalls = toolCalls;
                this.result = text;
                this.swipes = Array.from(swipes ?? []);
                if (logprobs) {
                    this.messageLogprobs.push(...(Array.isArray(logprobs) ? logprobs : [logprobs]));
                }
                // Get the updated reasoning string into the handler
                this.reasoningHandler.updateReasoning(this.messageId, state?.reasoning);
                this.images = state?.images ?? [];
                this.reasoningSignature = state?.signature ?? null;
                await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, text);
                await sw.tick(async () => await this.onProgressStreaming(this.messageId, this.continueMessage + text));
            }
            const seconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
            console.warn(`Stream stats: ${timestamps.length} tokens, ${seconds.toFixed(2)} seconds, rate: ${Number(timestamps.length / seconds).toFixed(2)} TPS`);
        } catch (err) {
            // in the case of a self-inflicted abort, we have already cleaned up
            if (!this.isFinished) {
                console.error(err);
                this.onErrorStreaming();
            }
            return this.result;
        }

        this.isFinished = true;
        return this.result;
    }
}

/**
 * Constructs a prompt to be used for either Text Completion or Chat Completion. Input is format-agnostic.
 * @param {string | object[]} prompt Input prompt. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @param {string} api API to use.
 * @param {boolean} instructOverride true to override instruct mode, false to use the default value
 * @param {boolean} quietToLoud true to generate a message in system mode, false to generate a message in character mode
 * @param {string} [systemPrompt] System prompt to use.
 * @param {string} [prefill] Prefill for the prompt.
 * @returns {string | object[]} Prompt ready for use in generation. If using TC, this will be a string. If using CC, this will be an array of chat-style messages.
 */
export function createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill) {
    const isInstruct = power_user.instruct.enabled && api !== 'openai' && api !== 'novel' && !instructOverride;

    // If the prompt was given as a string, convert to a message-style object assuming user role
    if (typeof prompt === 'string') {
        const message = api === 'openai'
            ? { role: 'user', content: prompt.trim() }
            : { role: 'system', content: prompt };
        prompt = [message];
    } else {  // checks for message-style object
        if (prompt.length === 0 && !systemPrompt) throw Error('No messages provided');
    }

    // Substitute the prefill if provided
    prefill = substituteParams(prefill ?? '');

    // Format each message in the prompt, accounting for the provided roles
    for (const message of prompt) {
        let name = '';
        if (message.role === 'user') name = message.name ?? name1;
        if (message.role === 'assistant') name = message.name ?? name2;
        if (message.role === 'system') name = message.name ?? '';
        const prefix = isInstruct || api === 'openai' ? '' : (name ? `${name}: ` : '');
        message.content = prefix + substituteParams(message.content ?? '');
        if (isInstruct) {  // instruct formatting for text completion
            const isUser = message.role === 'user';
            const isNarrator = message.role === 'system';
            message.content = formatInstructModeChat(name, message.content, isUser, isNarrator, '', name1, name2, false);
        }
    }

    // prepend system prompt, if provided
    if (systemPrompt) {
        systemPrompt = substituteParams(systemPrompt);
        systemPrompt = isInstruct ? (formatInstructModeStoryString(systemPrompt) + '\n') : systemPrompt.trim();
        prompt.unshift({ role: 'system', content: systemPrompt });
    }

    // with Chat Completion, the prefill is an additional assistant message at the end.
    if (api === 'openai' && prefill) {
        prompt.push({ role: 'assistant', content: prefill });
    }

    // if text completion, convert to text prompt by concatenating all message contents and adding the prefill as a promptBias.
    if (api !== 'openai') {
        const joiner = isInstruct ? '' : '\n';
        prompt = prompt.map(message => message.content).join(joiner);
        prompt = api === 'novel' ? adjustNovelInstructionPrompt(prompt) : prompt;
        prompt = prompt + (isInstruct ? formatInstructModePrompt(name2, false, prefill, name1, name2, true, quietToLoud) : `\n${prefill}`);  // add last line
    }

    return prompt;
}

/**
 * @typedef {object} GenerateRawParams
 * @prop {string | object[]} [prompt] Prompt to generate a message from. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @prop {string} [api] API to use. Main API is used if not specified.
 * @prop {boolean} [instructOverride] true to override instruct mode, false to use the default value
 * @prop {boolean} [quietToLoud] true to generate a message in system mode, false to generate a message in character mode
 * @prop {string} [systemPrompt] System prompt to use.
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {boolean} [trimNames] Whether to allow trimming "{{user}}:" and "{{char}}:" from the response.
 * @prop {string} [prefill] An optional prefill for the prompt.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {string} [llmPresetName] Optional OpenAI chat-completion preset name for this request only.
 * @prop {string} [apiPresetName] Optional OpenAI API preset name for connection settings only.
 * @prop {object} [apiSettingsOverride] Optional OpenAI connection settings override object for this request only.
 * @param {GenerateRawParams} params Parameters for generating a message
 * @returns {Promise<string>} Generated message
 */
export async function generateRaw({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, trimNames = true, prefill = '', jsonSchema = null, llmPresetName = '', apiPresetName = '', apiSettingsOverride = null } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateRaw called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema, llmPresetName, apiPresetName, apiSettingsOverride] = arguments;
    }

    const data = await generateRawData({ prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, prefill, jsonSchema });

    // JSON string (matching the provided schema) will already be extracted.
    if (jsonSchema) {
        return data;
    }

    // format result, exclude user prompt bias
    const message = cleanUpMessage({
        getMessage: extractMessageFromData(data, api),
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
        trimNames: trimNames,
        trimWrongNames: trimNames,
    });

    if (!message) {
        throw new Error('No message generated');
    }

    return message;
}

/**
 * Generates a raw data object using the provided prompt.
 * This used to be part of `generateRaw`, but separating it out allows extensions to access other data such as reasoning message.
 * @param {GenerateRawParams} params Parameters for generating a message
 * @returns {Promise<object | string>} Raw API response data, or a JSON string extracted from the response when `jsonSchema` is provided.
 */
export async function generateRawData({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, prefill = '', jsonSchema = null } = {}) {
    if (!api) {
        api = main_api;
    }

    const abortController = new AbortController();
    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;
    let eventHook = () => { };

    // construct final prompt from the input. Can either be a string or an array of chat-style messages.
    prompt = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);

    // Allow extensions to stop generation before it happens
    const eventAbortController = new AbortController();
    const abortHook = () => {
        abortController.abort(new Error('Cancelled by stop event'));
        eventAbortController.abort(new Error('Cancelled by extension'));
    };
    eventSource.on(event_types.GENERATION_STOPPED, abortHook);

    try {
        if (responseLengthCustomized) {
            TempResponseLength.save(api, responseLength);
        }
        /** @type {object|any[]} */
        let generateData = {};

        // Allow extensions to modify the prompt before generation
        // 1. for text completion
        if (typeof prompt === 'string') {
            const eventData = { prompt: prompt, dryRun: false };
            await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
            prompt = eventData.prompt;
        }
        // 2. for chat completion
        if (Array.isArray(prompt)) {
            const eventData = { chat: prompt, dryRun: false };
            await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
            prompt = eventData.chat;
        }

        // Check if the generation was aborted during the event
        eventAbortController.signal.throwIfAborted();

        switch (api) {
            case 'kobold':
            case 'koboldhorde':
                if (kai_settings.preset_settings === 'gui') {
                    generateData = { prompt: prompt, gui_settings: true, max_length: amount_gen, max_context_length: max_context, api_server: kai_settings.api_server };
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                    generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, amount_gen, max_context, isHorde, 'quiet');
                }
                TempResponseLength.restore(api);
                break;
            case 'novel': {
                const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                generateData = getNovelGenerationData(prompt, novelSettings, amount_gen, false, false, null, 'quiet');
                TempResponseLength.restore(api);
                break;
            }
            case 'textgenerationwebui':
                generateData = await getTextGenGenerationData(prompt, amount_gen, false, false, null, 'quiet');
                TempResponseLength.restore(api);
                break;
            case 'openai': {
                generateData = prompt;  // generateData is just the chat message object
                eventHook = TempResponseLength.setupEventHook(api);
            } break;
        }

        let data = {};

        if (api === 'koboldhorde') {
            data = await generateHorde(prompt.toString(), generateData, abortController.signal, false);
        } else if (api === 'openai') {
            data = await sendOpenAIRequest('quiet', generateData, abortController.signal, {
                jsonSchema,
                llmPresetName: String(llmPresetName || '').trim(),
                apiPresetName: String(apiPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            });
        } else {
            const generateUrl = getGenerateUrl(api);
            const response = await fetch(generateUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(generateData),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw await response.json();
            }

            data = await response.json();
        }

        // should only happen for text completions
        // other frontend paths do not return data if calling the backend fails,
        // they throw things instead
        if (data.error) {
            throw new Error(data.response);
        }

        if (jsonSchema) {
            return extractJsonFromData(data, { mainApi: api });
        }

        return data;
    } finally {
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHook);
        if (responseLengthCustomized && TempResponseLength.isCustomized()) {
            TempResponseLength.restore(api);
            TempResponseLength.removeEventHook(api, eventHook);
        }
    }
}

class TempResponseLength {
    static #originalResponseLength = -1;
    static #lastApi = null;

    static isCustomized() {
        return this.#originalResponseLength > -1;
    }

    /**
     * Save the current response length for the specified API.
     * @param {string} api API identifier
     * @param {number} responseLength New response length
     */
    static save(api, responseLength) {
        if (api === 'openai') {
            this.#originalResponseLength = oai_settings.openai_max_tokens;
            oai_settings.openai_max_tokens = responseLength;
        } else {
            this.#originalResponseLength = amount_gen;
            amount_gen = responseLength;
        }

        this.#lastApi = api;
        console.log('[TempResponseLength] Saved original response length:', TempResponseLength.#originalResponseLength);
    }

    /**
     * Restore the original response length for the specified API.
     * @param {string|null} api API identifier
     * @returns {void}
     */
    static restore(api) {
        if (this.#originalResponseLength === -1) {
            return;
        }
        if (!api && this.#lastApi) {
            api = this.#lastApi;
        }
        if (api === 'openai') {
            oai_settings.openai_max_tokens = this.#originalResponseLength;
        } else {
            amount_gen = this.#originalResponseLength;
        }

        console.log('[TempResponseLength] Restored original response length:', this.#originalResponseLength);
        this.#originalResponseLength = -1;
        this.#lastApi = null;
    }

    /**
     * Sets up an event hook to restore the original response length when the event is emitted.
     * @param {string} api API identifier
     * @returns {function(): void} Event hook function
     */
    static setupEventHook(api) {
        const eventHook = () => {
            if (this.isCustomized()) {
                this.restore(api);
            }
        };

        switch (api) {
            case 'openai':
                eventSource.once(event_types.CHAT_COMPLETION_SETTINGS_READY, eventHook);
                break;
            default:
                eventSource.once(event_types.GENERATE_AFTER_DATA, eventHook);
                break;
        }

        return eventHook;
    }

    /**
     * Removes the event hook for the specified API.
     * @param {string} api API identifier
     * @param {function(): void} eventHook Previously set up event hook
     */
    static removeEventHook(api, eventHook) {
        switch (api) {
            case 'openai':
                eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, eventHook);
                break;
            default:
                eventSource.removeListener(event_types.GENERATE_AFTER_DATA, eventHook);
                break;
        }
    }
}

/**
 * Removes last message from the chat DOM.
 * @returns {Promise<void>} Resolves when the message is removed.
 */
function removeLastMessage() {
    return new Promise((resolve) => {
        const lastMes = chatElement.children('.mes').last();
        if (lastMes.length === 0) {
            return resolve();
        }
        lastMes.hide(animation_duration, function () {
            $(this).remove();
            resolve();
        });
    });
}

/**
 * @typedef {object} JsonSchema
 * @property {string} name Name of the schema.
 * @property {object} value JSON schema value.
 * @property {string} [description] Description of the schema.
 * @property {boolean} [strict] If true, the schema will be used in strict mode, meaning that only the fields defined in the schema will be allowed.
 *
 * @typedef {object} GenerateOptions
 * @property {boolean} [automatic_trigger] If the generation was triggered automatically (e.g. group auto mode).
 * @property {boolean} [force_name2] If a char name should be forced to add to the prompt's last line (Text Completion, non-Instruct only).
 * @property {string} [quiet_prompt] A system instruction to use for the quiet prompt.
 * @property {boolean} [quietToLoud] Whether the system instruction should be sent in background (quiet) or a foreground (loud) mode.
 * @property {boolean} [skipWIAN] Skip adding World Info and Author's Note to the prompt.
 * @property {number} [force_chid] Force character ID to use for the generation. Only works in groups.
 * @property {AbortSignal} [signal] Abort signal to cancel the generation. If not provided, will create a new AbortController.
 * @property {string} [quietImage] Image URL to use for the quiet prompt (defaults to empty string)
 * @property {string} [quietName] Name to use for the quiet prompt (defaults to "System:")
 * @property {number} [depth] Recursion depth for the generation. Used to prevent infinite loops in tool calls.
 * @property {JsonSchema} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 */

function normalizeGenerationTrigger(type) {
    return GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal';
}

/**
 * Builds the chat text array used by world info scanning.
 * @param {ChatMessage[]} messages Chat messages in chronological order.
 * @param {boolean} [includeNames=world_info_include_names] Whether to include speaker names.
 * @returns {string[]} Reversed array expected by WI scanner.
 */
export function buildWorldInfoChatInput(messages, includeNames = world_info_include_names) {
    const source = Array.isArray(messages) ? messages : [];
    return source
        .map(message => includeNames ? `${message?.name}: ${message?.mes}` : String(message?.mes ?? ''))
        .reverse();
}

function setActiveWorldInfoPromptSnapshot({ worldInfoBeforeEntries = [], worldInfoAfterEntries = [] } = {}) {
    activeWorldInfoPromptSnapshot = {
        chatId: String(getCurrentChatId() || ''),
        worldInfoBeforeEntries: Array.isArray(worldInfoBeforeEntries) ? worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(worldInfoAfterEntries) ? worldInfoAfterEntries : [],
    };
}

/**
 * Returns cached WI prompt fields for plugin preset assembly.
 * Snapshot is scoped by chat and refreshed during generation WI pipeline.
 * @returns {{ worldInfoBeforeEntries: string[], worldInfoAfterEntries: string[] }}
 */
export function getActiveWorldInfoPromptFields() {
    const currentChatId = String(getCurrentChatId() || '');
    if (!currentChatId || activeWorldInfoPromptSnapshot.chatId !== currentChatId) {
        return { worldInfoBeforeEntries: [], worldInfoAfterEntries: [] };
    }
    return {
        worldInfoBeforeEntries: Array.isArray(activeWorldInfoPromptSnapshot.worldInfoBeforeEntries) ? activeWorldInfoPromptSnapshot.worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(activeWorldInfoPromptSnapshot.worldInfoAfterEntries) ? activeWorldInfoPromptSnapshot.worldInfoAfterEntries : [],
    };
}

/**
 * Builds default WI global scan data for the current character context.
 * @param {string} type Generation type.
 * @param {Partial<import('./scripts/world-info.js').WIGlobalScanData>} [overrides={}] Additional fields to override.
 * @returns {import('./scripts/world-info.js').WIGlobalScanData}
 */
export function buildWorldInfoGlobalScanData(type, overrides = {}) {
    const {
        description,
        personality,
        persona,
        scenario,
        charDepthPrompt,
        creatorNotes,
    } = getCharacterCardFields();

    return {
        personaDescription: persona,
        characterDescription: description,
        characterPersonality: personality,
        characterDepthPrompt: charDepthPrompt,
        scenario: scenario,
        creatorNotes: creatorNotes,
        trigger: normalizeGenerationTrigger(type),
        ...(overrides || {}),
    };
}

/**
 * Simulates world info activation for a provided chat snapshot.
 * Useful for extensions that need hypothetical WI activation before final prompt assembly.
 * @param {object} params Parameters.
 * @param {ChatMessage[]} [params.coreChat=[]] Chat snapshot to scan.
 * @param {number} [params.maxContext] Max context for WI scan.
 * @param {boolean} [params.dryRun=false] Dry run flag.
 * @param {string} [params.type='normal'] Generation type.
 * @param {string[]} [params.chatForWI] Optional prebuilt WI chat array.
 * @param {boolean} [params.includeNames=world_info_include_names] Include speaker names when building WI chat.
 * @param {import('./scripts/world-info.js').WIGlobalScanData} [params.globalScanData] Optional custom global scan data.
 * @returns {Promise<import('./scripts/world-info.js').WIResults & { chatForWI: string[], maxContext: number, globalScanData: import('./scripts/world-info.js').WIGlobalScanData }>}
 */
export async function simulateWorldInfoActivation({
    coreChat = [],
    maxContext: maxContextOverride = undefined,
    dryRun = false,
    type = 'normal',
    chatForWI = undefined,
    includeNames = world_info_include_names,
    globalScanData = undefined,
} = {}) {
    const resolvedCoreChat = Array.isArray(coreChat) ? coreChat : [];
    const resolvedMaxContext = Number.isFinite(maxContextOverride) && Number(maxContextOverride) > 0
        ? Number(maxContextOverride)
        : getMaxContextSize();
    const resolvedChatForWI = Array.isArray(chatForWI)
        ? chatForWI
        : buildWorldInfoChatInput(resolvedCoreChat, includeNames);
    const resolvedGlobalScanData = globalScanData && typeof globalScanData === 'object'
        ? { ...globalScanData, trigger: normalizeGenerationTrigger(globalScanData.trigger || type) }
        : buildWorldInfoGlobalScanData(type);

    const worldInfoResolution = await getWorldInfoPrompt(resolvedChatForWI, resolvedMaxContext, dryRun, resolvedGlobalScanData);
    return {
        ...worldInfoResolution,
        chatForWI: resolvedChatForWI,
        maxContext: resolvedMaxContext,
        globalScanData: resolvedGlobalScanData,
    };
}

function normalizeWorldInfoEntries(entries) {
    return Array.isArray(entries)
        ? entries.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

function joinWorldInfoEntries(entries) {
    return normalizeWorldInfoEntries(entries).join('\n');
}

function normalizeWorldInfoResolutionData(worldInfoResolution) {
    const safeResolution = worldInfoResolution && typeof worldInfoResolution === 'object' ? worldInfoResolution : {};
    const worldInfoBeforeEntries = normalizeWorldInfoEntries(safeResolution.worldInfoBeforeEntries);
    const worldInfoAfterEntries = normalizeWorldInfoEntries(safeResolution.worldInfoAfterEntries);
    return {
        worldInfoString: String(safeResolution.worldInfoString || '') || [...worldInfoBeforeEntries, ...worldInfoAfterEntries].join('\n'),
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        worldInfoExamples: Array.isArray(safeResolution.worldInfoExamples) ? safeResolution.worldInfoExamples : [],
        worldInfoDepth: Array.isArray(safeResolution.worldInfoDepth) ? safeResolution.worldInfoDepth : [],
        outletEntries: safeResolution.outletEntries && typeof safeResolution.outletEntries === 'object' ? safeResolution.outletEntries : {},
        anBefore: Array.isArray(safeResolution.anBefore) ? safeResolution.anBefore : [],
        anAfter: Array.isArray(safeResolution.anAfter) ? safeResolution.anAfter : [],
    };
}

function applyFinalizedAuthorsNoteInjections(anBefore = [], anAfter = []) {
    setFloatingPrompt();
    if (!shouldWIAddPrompt) {
        return;
    }

    const beforeEntries = Array.isArray(anBefore)
        ? anBefore.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
    const afterEntries = Array.isArray(anAfter)
        ? anAfter.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];

    if (beforeEntries.length === 0 && afterEntries.length === 0) {
        return;
    }

    const originalAN = String(extension_prompts[NOTE_MODULE_NAME]?.value || '').trim();
    const mergedAuthorsNote = [...beforeEntries, originalAN, ...afterEntries]
        .filter(Boolean)
        .join('\n')
        .trim();

    setExtensionPrompt(
        NOTE_MODULE_NAME,
        mergedAuthorsNote,
        chat_metadata[metadata_keys.position],
        chat_metadata[metadata_keys.depth],
        extension_settings.note.allowWIScan,
        chat_metadata[metadata_keys.role],
    );
}

/**
 * MARK:Generate()
 * Runs a generation using the current chat context.
 * @param {string} type Generation type
 * @param {GenerateOptions} options Generation options
 * @param {boolean} dryRun Whether to actually generate a message or just assemble the prompt
 * @returns {Promise<any>} Returns a promise that resolves when the text is done generating.
 */
export async function Generate(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_chid, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false) {
    console.log('Generate entered');
    setGenerationProgress(0);
    generation_started = new Date();
    setActiveWorldInfoPromptSnapshot();
    const generationEventParams = { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_chid, signal, quietImage };

    // Prevent generation from shallow characters
    await unshallowCharacter(this_chid);

    // Occurs every time, even if the generation is aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_STARTED, type, generationEventParams, dryRun);

    // Don't recreate abort controller if signal is passed
    if (!(abortController && signal)) {
        abortController = new AbortController();
    }

    const isGenerationAborted = () => Boolean(
        abortController?.signal?.aborted
        || (signal && typeof signal === 'object' && 'aborted' in signal && signal.aborted),
    );

    const exitAbortedGenerationIfNeeded = () => {
        if (!isGenerationAborted()) {
            return false;
        }

        setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);

        if (!dryRun && type !== 'quiet') {
            unblockGeneration(type);
        }

        return true;
    };

    // OpenAI doesn't need instruct mode. Use OAI main prompt instead.
    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isImpersonate = type == 'impersonate';

    if (!(dryRun || depth || type == 'regenerate' || type == 'swipe' || type == 'quiet')) {
        const interruptedByCommand = await processCommands(String($('#send_textarea').val()));

        if (interruptedByCommand) {
            //$("#send_textarea").val('')[0].dispatchEvent(new Event('input', { bubbles:true }));
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    // Occurs only if the generation is not aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, generationEventParams, dryRun);

    // Compatibility bridge for scripts that rewrite #send_textarea during GENERATION_AFTER_COMMANDS.
    // v1.4.0 snapshots textarea early to protect IME input; if a listener intentionally rewrites the
    // textarea text in this phase, sync the one-shot pending input with the rewritten value.
    if (!dryRun && type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate) {
        const currentTextareaText = String($('#send_textarea').val());
        const textareaChangedAfterSnapshot = typeof pendingUserInputText === 'string'
            && currentTextareaText !== pendingUserInputText;

        if (textareaChangedAfterSnapshot) {
            pendingUserInputText = currentTextareaText;
        }
    }

    // Script injects persist in chat metadata, but the live prompt cache is extension_prompts.
    // Re-sync before every generation so the final request body cannot drift from /inject state.
    processChatSlashCommands();

    if (main_api == 'kobold' && kai_settings.streaming_kobold && !kai_flags.can_use_streaming) {
        toastr.error(t`Streaming is enabled, but the version of Kobold used does not support token streaming.`, undefined, { timeOut: 10000, preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (isHordeGenerationNotAllowed()) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (!dryRun) {
        // Ping server to make sure it is still alive
        const pingResult = await pingServer();

        if (!pingResult) {
            unblockGeneration(type);
            toastr.error(t`Verify that the server is running and accessible.`, t`ST Server cannot be reached`);
            if (type !== 'quiet') {
                notifyMessageFailure(t`Server cannot be reached.`, String(name2 || ''));
            }
            throw new Error('Server unreachable');
        }

        // Hide swipes if not in a dry run.
        hideSwipeButtons();
        // If generated any message, set the flag to indicate it can't be recreated again.
        chat_metadata.tainted = true;
    }

    if (selected_group && !is_group_generating) {
        if (!dryRun) {
            // Returns the promise that generateGroupWrapper returns; resolves when generation is done
            return generateGroupWrapper(false, type, { quiet_prompt, force_chid, signal: abortController.signal, quietImage });
        }

        const characterIndexMap = new Map(characters.map((char, index) => [char.avatar, index]));
        const group = groups.find((x) => x.id === selected_group);

        const enabledMembers = group.members.reduce((acc, member) => {
            if (!group.disabled_members.includes(member) && !acc.includes(member)) {
                acc.push(member);
            }
            return acc;
        }, []);

        const memberIds = enabledMembers
            .map((member) => characterIndexMap.get(member))
            .filter((index) => index !== undefined && index !== null);

        if (memberIds.length > 0) {
            if (menu_type != 'character_edit') setCharacterId(memberIds[0]);
            setCharacterName('');
        } else {
            console.log('No enabled members found');
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    //#########QUIET PROMPT STUFF##############
    //this function just gives special care to novel quiet instruction prompts
    if (quiet_prompt) {
        quiet_prompt = substituteParams(quiet_prompt);
        quiet_prompt = main_api == 'novel' && !quietToLoud ? adjustNovelInstructionPrompt(quiet_prompt) : quiet_prompt;
    }

    const hasBackendConnection = online_status !== 'no_connection';

    // We can't do anything because we're not in a chat right now. (Unless it's a dry run, in which case we need to
    // assemble the prompt so we can count its tokens regardless of whether a chat is active.)
    if (!dryRun && !hasBackendConnection) {
        is_send_press = false;
        return Promise.resolve();
    }

    const lastMessage = chat[chat.length - 1];

    let textareaText;
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun && !depth) {
        is_send_press = true;
        if (typeof pendingUserInputText === 'string') {
            textareaText = pendingUserInputText;
        } else {
            const textareaState = await getSettledSendTextareaState();
            textareaText = textareaState.text;
        }
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        textareaText = '';
        if (chat.length && lastMessage.is_user) {
            //do nothing? why does this check exist?
        }
        else if (type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun && !depth && chat.length) {
            deleteItemizedPromptForMessage(chat.length - 1);
            const deletedMessage = chat[chat.length - 1];
            const deletedPlayableSeq = deletedMessage && !deletedMessage.is_system
                ? chat.reduce((count, message) => count + (message && !message.is_system ? 1 : 0), 0)
                : null;
            const deletedAssistantSeq = deletedMessage && !deletedMessage.is_system && !deletedMessage.is_user
                ? chat.reduce((count, message) => count + (message && !message.is_system && !message.is_user ? 1 : 0), 0)
                : null;
            const removedMessageIndex = chat.length - 1;
            chat.length = chat.length - 1;
            await removeLastMessage();
            const patchedRemove = await patchChatMessages([{ op: 'remove', path: `/${removedMessageIndex}` }]);
            if (!patchedRemove) {
                await saveChatConditional();
            }
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, {
                kind: 'delete',
                deletedPlayableSeqFrom: deletedPlayableSeq,
                deletedPlayableSeqTo: deletedPlayableSeq,
                deletedAssistantSeqFrom: deletedAssistantSeq,
                deletedAssistantSeqTo: deletedAssistantSeq,
            });
        }
    }

    const isContinue = type == 'continue';

    // Rewrite the generation timer to account for the time passed for all the continuations.
    if (isContinue && chat.length) {
        const prevFinished = lastMessage.gen_finished;
        const prevStarted = lastMessage.gen_started;

        if (prevFinished && prevStarted) {
            const timePassed = Number(prevFinished) - Number(prevStarted);
            generation_started = new Date(Date.now() - timePassed);
            lastMessage.gen_started = generation_started;
        }
    }

    if (!dryRun) {
        deactivateSendButtons();
    }

    let { messageBias, promptBias, isUserPromptBias } = getBiasStrings(textareaText, type);

    //*********************************
    //PRE FORMATING STRING
    //*********************************

    // These generation types should not attach pending files to the chat
    const noAttachTypes = [
        'regenerate',
        'swipe',
        'impersonate',
        'quiet',
        'continue',
    ];
    //for normal messages sent from user..
    if ((textareaText != '' || (hasPendingFileAttachment() && !noAttachTypes.includes(type))) && !automatic_trigger && type !== 'quiet' && !dryRun && !depth) {
        // If user message contains no text other than bias - send as a system message
        if (messageBias && !removeMacros(textareaText)) {
            sendSystemMessage(system_message_types.GENERIC, ' ', { bias: messageBias });
        } else {
            await sendMessageAsUser(textareaText, messageBias);
        }
    } else if (textareaText == '' && !automatic_trigger && !dryRun && [undefined, 'normal'].includes(type) && main_api == 'openai' && oai_settings.send_if_empty.trim().length > 0 && !depth) {
        // Use send_if_empty if set and the user message is empty. Only when sending messages normally
        await sendMessageAsUser(oai_settings.send_if_empty.trim(), messageBias);
    }

    let {
        description,
        personality,
        persona,
        scenario,
        mesExamples,
        system,
        jailbreak,
        charDepthPrompt,
        creatorNotes,
    } = getCharacterCardFields();

    // Depth prompt (character-specific A/N)
    removeDepthPrompts();
    const groupDepthPrompts = getGroupDepthPrompts(selected_group, Number(this_chid));

    if (selected_group && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((value, index) => {
            const role = getExtensionPromptRoleByName(value.role);
            setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, extension_settings.note.allowWIScan, role);
        });
    } else {
        const depthPromptText = charDepthPrompt || '';
        const depthPromptDepth = characters[this_chid]?.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = getExtensionPromptRoleByName(characters[this_chid]?.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
        setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, extension_prompt_types.IN_CHAT, depthPromptDepth, extension_settings.note.allowWIScan, depthPromptRole);
    }

    // First message in fresh 1-on-1 chat reacts to user/character settings changes
    if (chat.length) {
        chat[0].mes = substituteParams(chat[0].mes);
    }

    // Collect messages with usable content
    const canUseTools = ToolManager.isToolCallingSupported();
    const canPerformToolCalls = !dryRun && ToolManager.canPerformToolCalls(type) && depth < ToolManager.RECURSE_LIMIT;
    let coreChat = chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (type === 'swipe') {
        coreChat.pop();
    }

    coreChat = await Promise.all(coreChat.map(async (/** @type {ChatMessage} */ chatItem, index) => {
        let message = chatItem.mes;
        let regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        let options = { isPrompt: true, depth: (coreChat.length - index - (isContinue ? 2 : 1)) };

        let regexedMessage = getRegexedString(message, regexType, options);
        regexedMessage = await appendFileContent(chatItem, regexedMessage);

        const titles = [];
        if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
            titles.push(chatItem.extra.title);
        }
        if (Array.isArray(chatItem?.extra?.media)) {
            for (const mediaItem of chatItem.extra.media) {
                if (mediaItem?.title && mediaItem?.append_title) {
                    titles.push(mediaItem.title);
                }
            }
        }
        if (titles.length > 0) {
            regexedMessage = `${regexedMessage}\n\n${titles.join('\n\n')}`;
        }

        return {
            ...chatItem,
            mes: regexedMessage,
            index,
        };
    }));

    if (canUseTools) {
        const normalizedCoreChat = [];
        for (const chatItem of coreChat) {
            const invocations = chatItem?.extra?.tool_invocations;
            const previousMessage = normalizedCoreChat[normalizedCoreChat.length - 1];
            const shouldMergeToolInvocationSummary =
                chatItem?.extra?.isSmallSys === true
                && Array.isArray(invocations)
                && invocations.length > 0
                && previousMessage
                && !previousMessage.is_user
                && previousMessage?.extra?.type !== system_message_types.NARRATOR;

            if (shouldMergeToolInvocationSummary) {
                normalizedCoreChat[normalizedCoreChat.length - 1] = {
                    ...previousMessage,
                    extra: {
                        ...(previousMessage.extra || {}),
                        tool_invocations: Array.isArray(previousMessage?.extra?.tool_invocations)
                            ? previousMessage.extra.tool_invocations.concat(invocations)
                            : invocations.slice(),
                    },
                };
                continue;
            }

            normalizedCoreChat.push(chatItem);
        }

        coreChat = normalizedCoreChat;
    }

    const promptReasoning = new PromptReasoning();
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const depth = coreChat.length - i - (isContinue ? 2 : 1);
        const isPrefix = isContinue && i === coreChat.length - 1;
        coreChat[i] = {
            ...coreChat[i],
            mes: promptReasoning.addToMessage(
                coreChat[i].mes,
                getRegexedString(
                    String(coreChat[i].extra?.reasoning ?? ''),
                    regex_placement.REASONING,
                    { isPrompt: true, depth: depth },
                ),
                isPrefix,
                coreChat[i].extra?.reasoning_duration,
            ),
        };
        if (promptReasoning.isLimitReached()) {
            break;
        }
    }

    // Determine token limit
    let this_max_context = getMaxPromptTokens();

    if (!dryRun) {
        console.debug('Running extension interceptors');
        const aborted = await runGenerationInterceptors(coreChat, this_max_context, type);

        if (aborted) {
            console.debug('Generation aborted by extension interceptors');
            unblockGeneration(type);
            return Promise.resolve();
        }
    } else {
        console.debug('Skipping extension interceptors for dry run');
    }

    // Adjust token limit for Horde
    let adjustedParams;
    if (main_api == 'koboldhorde' && (horde_settings.auto_adjust_context_length || horde_settings.auto_adjust_response_length)) {
        try {
            adjustedParams = await adjustHordeGenerationParams(max_context, amount_gen);
        } catch {
            unblockGeneration(type);
            return Promise.resolve();
        }
        if (horde_settings.auto_adjust_context_length) {
            this_max_context = (adjustedParams.maxContextLength - adjustedParams.maxLength);
        }
    }

    // Fetches the combined prompt for both negative and positive prompts
    const cfgGuidanceScale = getGuidanceScale();
    const useCfgPrompt = cfgGuidanceScale && cfgGuidanceScale.value !== 1;

    // Adjust max context based on CFG prompt to prevent overfitting
    if (useCfgPrompt) {
        const negativePrompt = getCfgPrompt(cfgGuidanceScale, true, true)?.value || '';
        const positivePrompt = getCfgPrompt(cfgGuidanceScale, false, true)?.value || '';
        if (negativePrompt || positivePrompt) {
            const previousMaxContext = this_max_context;
            const [negativePromptTokenCount, positivePromptTokenCount] = await Promise.all([getTokenCountAsync(negativePrompt), getTokenCountAsync(positivePrompt)]);
            const decrement = Math.max(negativePromptTokenCount, positivePromptTokenCount);
            this_max_context -= decrement;
            console.log(`Max context reduced by ${decrement} tokens of CFG prompt (${previousMaxContext} -> ${this_max_context})`);
        }
    }

    const generationContextPayload = {
        type,
        dryRun,
        isContinue,
        isImpersonate,
        coreChat,
        maxContext: this_max_context,
    };
    await eventSource.emit(event_types.GENERATION_CONTEXT_READY, generationContextPayload);
    if (Array.isArray(generationContextPayload.coreChat)) {
        coreChat = generationContextPayload.coreChat;
    }
    if (Number.isFinite(generationContextPayload.maxContext) && Number(generationContextPayload.maxContext) > 0) {
        this_max_context = Number(generationContextPayload.maxContext);
    }

    console.log(`Core/all messages: ${coreChat.length}/${chat.length}`);

    if ((promptBias && !isUserPromptBias) || power_user.always_force_name2 || main_api == 'novel') {
        force_name2 = true;
    }

    if (isImpersonate) {
        force_name2 = false;
    }

    let mesExamplesArray = parseMesExamples(mesExamples, isInstruct);

    // Set non-WI AN
    setFloatingPrompt();

    // Add WI to prompt (and also inject WI to AN value via hijack)
    // Make quiet prompt available for WIAN
    setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt || '', extension_prompt_types.IN_PROMPT, 0, true);
    let chatForWI = buildWorldInfoChatInput(coreChat);
    let globalScanData = buildWorldInfoGlobalScanData(type, {
        personaDescription: persona,
        characterDescription: description,
        characterPersonality: personality,
        characterDepthPrompt: charDepthPrompt,
        scenario: scenario,
        creatorNotes: creatorNotes,
    });

    const runWIScan = async (overrides = {}) => {
        return await simulateWorldInfoActivation({
            coreChat: overrides.coreChat ?? coreChat,
            maxContext: overrides.maxContext ?? this_max_context,
            dryRun,
            type,
            chatForWI: overrides.chatForWI ?? chatForWI,
            globalScanData: overrides.globalScanData ?? globalScanData,
        });
    };

    const wiScanPayload = {
        type,
        dryRun,
        signal: abortController?.signal || null,
        chatStateTarget: resolveChatStateTarget(),
        maxContext: this_max_context,
        coreChat,
        chatForWI,
        useCustomChatForWI: false,
        globalScanData,
        requestRescan: false,
        worldInfoResolutionOverride: null,
        simulateWorldInfo: async (overrides = {}) => await runWIScan(overrides),
    };
    await eventSource.emit(event_types.GENERATION_BEFORE_WORLD_INFO_SCAN, wiScanPayload);
    if (exitAbortedGenerationIfNeeded()) {
        return Promise.resolve();
    }
    if (Array.isArray(wiScanPayload.coreChat)) {
        coreChat = wiScanPayload.coreChat;
    }
    if (Number.isFinite(wiScanPayload.maxContext) && Number(wiScanPayload.maxContext) > 0) {
        this_max_context = Number(wiScanPayload.maxContext);
    }
    if (wiScanPayload.useCustomChatForWI === true && Array.isArray(wiScanPayload.chatForWI)) {
        chatForWI = wiScanPayload.chatForWI;
    } else {
        chatForWI = buildWorldInfoChatInput(coreChat);
    }
    if (wiScanPayload.globalScanData && typeof wiScanPayload.globalScanData === 'object') {
        globalScanData = wiScanPayload.globalScanData;
    }

    const initialWorldInfoResult = await runWIScan();
    if (exitAbortedGenerationIfNeeded()) {
        return Promise.resolve();
    }
    chatForWI = initialWorldInfoResult.chatForWI;
    this_max_context = initialWorldInfoResult.maxContext;
    globalScanData = initialWorldInfoResult.globalScanData;
    let worldInfoResolution = initialWorldInfoResult;

    const wiAfterPayload = {
        ...wiScanPayload,
        chatForWI,
        maxContext: this_max_context,
        globalScanData,
        ...normalizeWorldInfoResolutionData(worldInfoResolution),
        worldInfoResolution,
        requestRescan: Boolean(wiScanPayload.requestRescan),
        worldInfoResolutionOverride: wiScanPayload.worldInfoResolutionOverride ?? null,
        simulateWorldInfo: async (overrides = {}) => await runWIScan(overrides),
    };
    // Expose latest WI prompt snapshot before AFTER_WORLD_INFO_SCAN hooks run.
    setActiveWorldInfoPromptSnapshot({
        worldInfoBeforeEntries: Array.isArray(wiAfterPayload.worldInfoBeforeEntries) ? wiAfterPayload.worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(wiAfterPayload.worldInfoAfterEntries) ? wiAfterPayload.worldInfoAfterEntries : [],
    });
    await eventSource.emit(event_types.GENERATION_AFTER_WORLD_INFO_SCAN, wiAfterPayload);
    if (exitAbortedGenerationIfNeeded()) {
        return Promise.resolve();
    }

    if (Array.isArray(wiAfterPayload.coreChat)) {
        coreChat = wiAfterPayload.coreChat;
    }
    if (Number.isFinite(wiAfterPayload.maxContext) && Number(wiAfterPayload.maxContext) > 0) {
        this_max_context = Number(wiAfterPayload.maxContext);
    }
    if (wiAfterPayload.useCustomChatForWI === true && Array.isArray(wiAfterPayload.chatForWI)) {
        chatForWI = wiAfterPayload.chatForWI;
    } else {
        chatForWI = buildWorldInfoChatInput(coreChat);
    }
    if (wiAfterPayload.globalScanData && typeof wiAfterPayload.globalScanData === 'object') {
        globalScanData = wiAfterPayload.globalScanData;
    }

    let worldInfoRescanned = false;
    if (wiAfterPayload.worldInfoResolutionOverride && typeof wiAfterPayload.worldInfoResolutionOverride === 'object') {
        worldInfoResolution = wiAfterPayload.worldInfoResolutionOverride;
    } else if (wiAfterPayload.requestRescan === true) {
        worldInfoResolution = await runWIScan();
        if (exitAbortedGenerationIfNeeded()) {
            return Promise.resolve();
        }
        chatForWI = Array.isArray(worldInfoResolution.chatForWI) ? worldInfoResolution.chatForWI : chatForWI;
        this_max_context = Number.isFinite(worldInfoResolution.maxContext) ? Number(worldInfoResolution.maxContext) : this_max_context;
        globalScanData = worldInfoResolution.globalScanData && typeof worldInfoResolution.globalScanData === 'object'
            ? worldInfoResolution.globalScanData
            : globalScanData;
        worldInfoRescanned = true;
    }

    let {
        worldInfoString,
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        worldInfoExamples,
        worldInfoDepth,
        outletEntries,
        anBefore,
        anAfter,
    } = normalizeWorldInfoResolutionData(worldInfoResolution);

    setActiveWorldInfoPromptSnapshot({
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
    });

    const wiFinalizedPayload = {
        ...wiAfterPayload,
        coreChat,
        chatForWI,
        maxContext: this_max_context,
        globalScanData,
        worldInfoString,
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        worldInfoExamples,
        worldInfoDepth,
        anBefore,
        anAfter,
        outletEntries,
        worldInfoResolution,
        rescanned: worldInfoRescanned,
    };
    await eventSource.emit(event_types.GENERATION_WORLD_INFO_FINALIZED, wiFinalizedPayload);
    if (exitAbortedGenerationIfNeeded()) {
        return Promise.resolve();
    }

    if (Array.isArray(wiFinalizedPayload.coreChat)) {
        coreChat = wiFinalizedPayload.coreChat;
    }
    if (Array.isArray(wiFinalizedPayload.chatForWI)) {
        chatForWI = wiFinalizedPayload.chatForWI;
    }
    if (Number.isFinite(wiFinalizedPayload.maxContext) && Number(wiFinalizedPayload.maxContext) > 0) {
        this_max_context = Number(wiFinalizedPayload.maxContext);
    }
    if (wiFinalizedPayload.globalScanData && typeof wiFinalizedPayload.globalScanData === 'object') {
        globalScanData = wiFinalizedPayload.globalScanData;
    }
    if (wiFinalizedPayload.worldInfoResolution && typeof wiFinalizedPayload.worldInfoResolution === 'object') {
        worldInfoResolution = wiFinalizedPayload.worldInfoResolution;
    }

    ({
        worldInfoString,
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        worldInfoExamples,
        worldInfoDepth,
        outletEntries,
        anBefore,
        anAfter,
    } = normalizeWorldInfoResolutionData({
        ...worldInfoResolution,
        ...wiFinalizedPayload,
    }));

    setActiveWorldInfoPromptSnapshot({
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
    });

    applyFinalizedAuthorsNoteInjections(anBefore, anAfter);
    setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);
    const worldInfoBefore = joinWorldInfoEntries(worldInfoBeforeEntries);
    const worldInfoAfter = joinWorldInfoEntries(worldInfoAfterEntries);

    // Add message example WI
    for (const example of worldInfoExamples) {
        const exampleMessage = example.content;

        if (exampleMessage.length === 0) {
            continue;
        }

        const formattedExample = baseChatReplace(exampleMessage);
        const cleanedExample = parseMesExamples(formattedExample, isInstruct);

        // Insert depending on before or after position
        if (example.position === wi_anchor_position.before) {
            mesExamplesArray.unshift(...cleanedExample);
        } else {
            mesExamplesArray.push(...cleanedExample);
        }
    }

    // At this point, the raw message examples can be created
    const mesExamplesRawArray = [...mesExamplesArray];

    if (mesExamplesArray && isInstruct) {
        mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2);
    }

    if (skipWIAN !== true) {
        console.log('skipWIAN not active, adding WIAN');
        // Add all depth WI entries to prompt
        flushWIInjections();
        if (Array.isArray(worldInfoDepth)) {
            worldInfoDepth.forEach((e) => {
                const joinedEntries = e.entries.join('\n');
                setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
            });
        }
        if (outletEntries && typeof outletEntries === 'object' && Object.keys(outletEntries).length > 0) {
            Object.entries(outletEntries).forEach(([key, value]) => {
                setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
            });
        }
    } else {
        console.log('skipping WIAN');
    }

    // Add persona description to prompt
    addPersonaDescriptionExtensionPrompt();

    // Prepare the system prompt for Text Completion APIs
    if (main_api !== 'openai') {
        if (power_user.sysprompt.enabled) {
            system = power_user.prefer_character_prompt && system
                ? substituteParams(system, { original: power_user.sysprompt.content ?? '' })
                : baseChatReplace(power_user.sysprompt.content);
            system = isInstruct ? substituteParams(system, { original: power_user.sysprompt.content ?? '' }) : system;
        } else {
            // Nullify if it's not enabled
            system = '';
        }
    }

    // Collect before / after story string injections
    const beforeScenarioAnchor = await getExtensionPrompt(extension_prompt_types.BEFORE_PROMPT);
    const afterScenarioAnchor = await getExtensionPrompt(extension_prompt_types.IN_PROMPT);

    const storyStringParams = {
        description: description,
        personality: personality,
        persona: power_user.persona_description_position == persona_description_positions.IN_PROMPT ? persona : '',
        scenario: scenario,
        system: system,
        char: name2,
        user: name1,
        wiBefore: worldInfoBefore,
        wiAfter: worldInfoAfter,
        loreBefore: worldInfoBefore,
        loreAfter: worldInfoAfter,
        anchorBefore: beforeScenarioAnchor.trim(),
        anchorAfter: afterScenarioAnchor.trim(),
        mesExamples: mesExamplesArray.join(''),
        mesExamplesRaw: mesExamplesRawArray.join(''),
    };

    // Render the story string and combine with injections
    const storyString = renderStoryString(storyStringParams);
    let combinedStoryString = isInstruct ? formatInstructModeStoryString(storyString) : storyString;

    // Inject the story string as in-chat prompt (if needed)
    const applyStoryStringInject = main_api !== 'openai' && power_user.context.story_string_position === extension_prompt_types.IN_CHAT;
    if (applyStoryStringInject) {
        const depth = power_user.context.story_string_depth ?? 1;
        const role = power_user.context.story_string_role ?? extension_prompt_roles.SYSTEM;
        setExtensionPrompt(inject_ids.STORY_STRING, combinedStoryString, extension_prompt_types.IN_CHAT, depth, false, role);
        // Remove to prevent duplication
        combinedStoryString = '';
    } else {
        setExtensionPrompt(inject_ids.STORY_STRING, '', extension_prompt_types.IN_CHAT, 0);
    }

    // Story string rendered, safe to remove
    if (power_user.strip_examples) {
        mesExamplesArray = [];
    }

    // Inject all Depth prompts. Chat Completion does it separately
    let injectedIndices = [];
    if (main_api !== 'openai') {
        injectedIndices = await doChatInject(coreChat, isContinue);
    }

    if (main_api !== 'openai' && power_user.sysprompt.enabled) {
        jailbreak = power_user.prefer_character_jailbreak && jailbreak
            ? substituteParams(jailbreak, { original: power_user.sysprompt.post_history ?? '' })
            : baseChatReplace(power_user.sysprompt.post_history);

        // Only inject the jb if there is one
        if (jailbreak) {
            // When continuing generation of previous output, last user message precedes the message to continue
            if (isContinue) {
                coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true });
            } else {
                // This operation will result in the injectedIndices indexes being off by one
                coreChat.push({ mes: jailbreak, is_user: true });
                // Add +1 to the elements to correct for the new PHI/Jailbreak message.
                injectedIndices.forEach(shiftUpByOne);
            }
        }
    }

    let chat2 = [];
    let continue_mag = '';
    let userMessageIndices = [];
    const lastUserMessageIndex = coreChat.findLastIndex(x => x.is_user);

    for (let i = coreChat.length - 1, j = 0; i >= 0; i--, j++) {
        if (main_api == 'openai') {
            chat2[i] = coreChat[j].mes;
            if (i === 0 && isContinue) {
                chat2[i] = chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
                continue_mag = coreChat[j].mes;
            }
            continue;
        }

        chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, false);

        if (j === 0 && isInstruct) {
            // Reformat with the first output sequence (if any)
            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.FIRST);
        }

        if (lastUserMessageIndex >= 0 && j === lastUserMessageIndex && isInstruct) {
            // Reformat with the last input sequence (if any)
            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.LAST);
        }

        // Do not suffix the message for continuation
        if (i === 0 && isContinue) {
            // Pick something that's very unlikely to be in a message
            const FORMAT_TOKEN = '\u0000\ufffc\u0000\ufffd';

            if (isInstruct) {
                const originalMessage = String(coreChat[j].mes ?? '');
                coreChat[j].mes = originalMessage.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN;
                // Reformat with the last output sequence (if any)
                chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.LAST);
                coreChat[j].mes = originalMessage;
            }

            chat2[i] = chat2[i].includes(FORMAT_TOKEN)
                ? chat2[i].slice(0, chat2[i].lastIndexOf(FORMAT_TOKEN))
                : chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
            continue_mag = coreChat[j].mes;
        }

        if (coreChat[j].is_user) {
            userMessageIndices.push(i);
        }
    }

    let addUserAlignment = isInstruct && power_user.instruct.user_alignment_message;
    let userAlignmentMessage = '';

    if (addUserAlignment) {
        const alignmentMessage = {
            name: name1,
            mes: substituteParams(power_user.instruct.user_alignment_message),
            is_user: true,
        };
        userAlignmentMessage = formatMessageHistoryItem(alignmentMessage, isInstruct, force_output_sequence.FIRST);
    }

    let oaiMessages = [];
    let oaiMessageExamples = [];

    if (main_api === 'openai') {
        oaiMessages = setOpenAIMessages(coreChat);
        oaiMessageExamples = setOpenAIMessageExamples(mesExamplesArray);
    }

    // hack for regeneration of the first message
    if (chat2.length == 0) {
        chat2.push('');
    }

    let examplesString = '';
    let chatString = addChatsPreamble(addChatsSeparator(''));
    let cyclePrompt = '';

    async function getMessagesTokenCount() {
        const encodeString = [
            combinedStoryString,
            examplesString,
            userAlignmentMessage,
            chatString,
            modifyLastPromptLine(''),
            cyclePrompt,
        ].join('').replace(/\r/gm, '');
        return getTokenCountAsync(encodeString, power_user.token_padding);
    }

    // Force pinned examples into the context
    let pinExmString;
    if (power_user.pin_examples) {
        pinExmString = examplesString = mesExamplesArray.join('');
    }

    // Only add the chat in context if past the greeting message
    if (isContinue && (chat2.length > 1 || main_api === 'openai')) {
        cyclePrompt = chat2.shift();
        // Adjust indices to account for the shift
        injectedIndices = injectedIndices.map(shiftDownByOne).filter(x => x >= 0);
        userMessageIndices = userMessageIndices.map(shiftDownByOne).filter(x => x >= 0);
    }

    // Collect enough messages to fill the context
    let arrMes = new Array(chat2.length);
    let tokenCount = await getMessagesTokenCount();
    let lastAddedIndex = 0;

    // Pre-allocate all injections first.
    // If it doesn't fit - user shot himself in the foot
    for (const index of injectedIndices) {
        // not needed for OAI prompting
        if (main_api == 'openai') {
            break;
        }

        const item = chat2[index];

        if (typeof item !== 'string') {
            continue;
        }

        tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
        if (tokenCount < this_max_context) {
            chatString = chatString + item;
            arrMes[index] = item;
            lastAddedIndex = Math.max(lastAddedIndex, index);
        } else {
            break;
        }
    }

    for (let i = 0; i < chat2.length; i++) {
        // not needed for OAI prompting
        if (main_api == 'openai') {
            break;
        }

        // Skip already injected messages
        if (arrMes[i] !== undefined) {
            continue;
        }

        const item = chat2[i];

        if (typeof item !== 'string') {
            continue;
        }

        tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
        if (tokenCount < this_max_context) {
            chatString = chatString + item;
            arrMes[i] = item;
            lastAddedIndex = Math.max(lastAddedIndex, i);
        } else {
            break;
        }
    }

    // Add user alignment message if last message is not a user message
    const stoppedAtUser = userMessageIndices.includes(lastAddedIndex);
    if (addUserAlignment && !stoppedAtUser) {
        tokenCount += await getTokenCountAsync(userAlignmentMessage.replace(/\r/gm, ''));
        chatString = userAlignmentMessage + chatString;
        arrMes.push(userAlignmentMessage);
        injectedIndices.push(arrMes.length - 1);
    }

    // Unsparse the array. Adjust injected indices
    const newArrMes = [];
    const newInjectedIndices = [];
    for (let i = 0; i < arrMes.length; i++) {
        if (arrMes[i] !== undefined) {
            newArrMes.push(arrMes[i]);
            if (injectedIndices.includes(i)) {
                newInjectedIndices.push(newArrMes.length - 1);
            }
        }
    }

    arrMes = newArrMes;
    injectedIndices = newInjectedIndices;

    if (main_api !== 'openai') {
        setInContextMessages(arrMes.length - injectedIndices.length, type);
    }

    // Estimate how many unpinned example messages fit in the context
    tokenCount = await getMessagesTokenCount();
    let count_exm_add = 0;
    if (!power_user.pin_examples) {
        for (let example of mesExamplesArray) {
            tokenCount += await getTokenCountAsync(example.replace(/\r/gm, ''));
            examplesString += example;
            if (tokenCount < this_max_context) {
                count_exm_add++;
            } else {
                break;
            }
        }
    }

    let mesSend = [];
    console.debug('calling runGenerate');

    if (isContinue) {
        // Coping mechanism for OAI spacing
        if (main_api === 'openai' && !cyclePrompt.endsWith(' ')) {
            cyclePrompt += oai_settings.continue_postfix;
            continue_mag += oai_settings.continue_postfix;
        }
    }

    const originalType = type;

    if (!dryRun) {
        is_send_press = true;
    }

    let generatedPromptCache = cyclePrompt || '';
    if (generatedPromptCache.length == 0 || type === 'continue') {
        console.debug('generating prompt');
        chatString = '';
        arrMes = arrMes.reverse();
        arrMes.forEach(function (item, i, arr) {
            // OAI doesn't need all of this
            if (main_api === 'openai') {
                return;
            }

            // Cohee: This removes a newline from the end of the last message in the context
            // Last prompt line will add a newline if it's not a continuation
            // In instruct mode it only removes it if wrap is enabled and it's not a quiet generation
            if (i === arrMes.length - 1 && type !== 'continue') {
                if (!isInstruct || (power_user.instruct.wrap && type !== 'quiet')) {
                    item = item.replace(/\n?$/, '');
                }
            }

            mesSend[mesSend.length] = { message: item, extensionPrompts: [] };
        });
    }

    let mesExmString = '';

    function setPromptString() {
        if (main_api == 'openai') {
            return;
        }

        console.debug('--setting Prompt string');
        mesExmString = pinExmString ?? mesExamplesArray.slice(0, count_exm_add).join('');

        if (mesSend.length) {
            mesSend[mesSend.length - 1].message = modifyLastPromptLine(mesSend[mesSend.length - 1].message);
        }
    }

    function modifyLastPromptLine(lastMesString) {
        //#########QUIET PROMPT STUFF PT2##############

        // Add quiet generation prompt at depth 0
        if (quiet_prompt && quiet_prompt.length) {
            // here name1 is forced for all quiet prompts..why?
            const name = name1;
            //checks if we are in instruct, if so, formats the chat as such, otherwise just adds the quiet prompt
            const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, '', name1, name2, false) : `\n${quiet_prompt}`;

            //This begins to fix quietPrompts (particularly /sysgen) for instruct
            //previously instruct input sequence was being appended to the last chat message w/o '\n'
            //and no output sequence was added after the input's content.
            //TODO: respect output_sequence vs last_output_sequence settings
            //TODO: decide how to prompt this to clarify who is talking 'Narrator', 'System', etc.
            if (isInstruct) {
                lastMesString += quietAppend; // + power_user.instruct.output_sequence + '\n';
            } else {
                lastMesString += quietAppend;
            }


            // Ross: bailing out early prevents quiet prompts from respecting other instruct prompt toggles
            // for sysgen, SD, and summary this is desireable as it prevents the AI from responding as char..
            // but for idle prompting, we want the flexibility of the other prompt toggles, and to respect them as per settings in the extension
            // need a detection for what the quiet prompt is being asked for...

            // Bail out early?
            if (!isInstruct && !quietToLoud) {
                return lastMesString;
            }
        }


        // Get instruct mode line
        if (isInstruct && !isContinue) {
            const name = (quiet_prompt && !quietToLoud && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
            const isQuiet = quiet_prompt && type == 'quiet';
            lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud);
        }

        // Get non-instruct impersonation line
        if (!isInstruct && isImpersonate && !isContinue) {
            const name = name1;
            if (!lastMesString.endsWith('\n')) {
                lastMesString += '\n';
            }
            lastMesString += name + ':';
        }

        // Add character's name
        // Force name append on continue (if not continuing on user message or first message)
        const isContinuingOnFirstMessage = chat.length === 1 && isContinue;
        if (!isInstruct && force_name2 && !isContinuingOnFirstMessage) {
            if (!lastMesString.endsWith('\n')) {
                lastMesString += '\n';
            }
            if (!isContinue || !(chat[chat.length - 1]?.is_user)) {
                lastMesString += `${name2}:`;
            }
        }

        return lastMesString;
    }

    async function checkPromptSize() {
        console.debug('---checking Prompt size');
        setPromptString();
        const jointMessages = mesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
        const prompt = [
            combinedStoryString,
            mesExmString,
            addChatsPreamble(addChatsSeparator(jointMessages)),
            '\n',
            modifyLastPromptLine(''),
            generatedPromptCache,
        ].join('').replace(/\r/gm, '');
        let thisPromptContextSize = await getTokenCountAsync(prompt, power_user.token_padding);

        if (thisPromptContextSize > this_max_context) {        //if the prepared prompt is larger than the max context size...
            if (count_exm_add > 0) {                            // ..and we have example messages..
                count_exm_add--;                            // remove the example messages...
                await checkPromptSize();                            // and try agin...
            } else if (mesSend.length > 0) {                    // if the chat history is longer than 0
                mesSend.shift();                            // remove the first (oldest) chat entry..
                await checkPromptSize();                            // and check size again..
            } else {
                //end
                console.debug(`---mesSend.length = ${mesSend.length}`);
            }
        }
    }

    if (generatedPromptCache.length > 0 && main_api !== 'openai') {
        console.debug('---Generated Prompt Cache length: ' + generatedPromptCache.length);
        await checkPromptSize();
    } else {
        console.debug('---calling setPromptString ' + generatedPromptCache.length);
        setPromptString();
    }

    // For prompt bit itemization
    let mesSendString = '';

    async function getCombinedPrompt(isNegative) {
        // Only return if the guidance scale doesn't exist or the value is 1
        // Also don't return if constructing the neutral prompt
        if (isNegative && !useCfgPrompt) {
            return;
        }

        // OAI has its own prompt manager. No need to do anything here
        if (main_api === 'openai') {
            return '';
        }

        // Deep clone
        let finalMesSend = structuredClone(mesSend);

        if (useCfgPrompt) {
            const cfgPrompt = getCfgPrompt(cfgGuidanceScale, isNegative);
            if (cfgPrompt.value) {
                if (cfgPrompt.depth === 0) {
                    finalMesSend[finalMesSend.length - 1].message +=
                        /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                            ? cfgPrompt.value
                            : ` ${cfgPrompt.value}`;
                } else {
                    // TODO: Make all extension prompts use an array/splice method
                    const lengthDiff = mesSend.length - cfgPrompt.depth;
                    const cfgDepth = lengthDiff >= 0 ? lengthDiff : 0;
                    const cfgMessage = finalMesSend[cfgDepth];
                    if (cfgMessage) {
                        if (!Array.isArray(finalMesSend[cfgDepth].extensionPrompts)) {
                            finalMesSend[cfgDepth].extensionPrompts = [];
                        }
                        finalMesSend[cfgDepth].extensionPrompts.push(`${cfgPrompt.value}\n`);
                    }
                }
            }
        }

        // Add prompt bias after everything else
        // Always run with continue
        if (!isInstruct && !isImpersonate) {
            if (promptBias.trim().length !== 0) {
                finalMesSend[finalMesSend.length - 1].message +=
                    /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                        ? promptBias.trimStart()
                        : ` ${promptBias.trimStart()}`;
            }
        }

        // Flattens the multiple prompt objects to a string.
        const combine = () => {
            // Right now, everything is suffixed with a newline
            mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

            // add a custom dingus (if defined)
            mesSendString = addChatsSeparator(mesSendString);

            // add chat preamble
            mesSendString = addChatsPreamble(mesSendString);

            let combinedPrompt = [
                combinedStoryString,
                mesExmString,
                mesSendString,
                generatedPromptCache,
            ].join('').replace(/\r/gm, '');

            if (power_user.collapse_newlines) {
                combinedPrompt = collapseNewlines(combinedPrompt);
            }

            return combinedPrompt;
        };

        finalMesSend.forEach((item, i) => {
            item.injected = injectedIndices.includes(finalMesSend.length - i - 1);
        });

        let data = {
            api: main_api,
            combinedPrompt: null,
            description,
            personality,
            persona,
            scenario,
            char: name2,
            user: name1,
            worldInfoBefore,
            worldInfoAfter,
            beforeScenarioAnchor,
            afterScenarioAnchor,
            storyString,
            mesExmString,
            mesSendString,
            finalMesSend,
            generatedPromptCache,
            main: system,
            jailbreak,
            naiPreamble: nai_settings.preamble,
        };

        // Before returning the combined prompt, give available context related information to all subscribers.
        await eventSource.emit(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, data);

        // If one or multiple subscribers return a value, forfeit the responsibillity of flattening the context.
        return !data.combinedPrompt ? combine() : data.combinedPrompt;
    }

    let finalPrompt = await getCombinedPrompt(false);

    const eventData = { prompt: finalPrompt, dryRun: dryRun };
    await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
    finalPrompt = eventData.prompt;

    let maxLength = Number(amount_gen); // how many tokens the AI will be requested to generate
    let thisPromptBits = [];

    let generate_data;
    switch (main_api) {
        case 'koboldhorde':
        case 'kobold':
            if (main_api == 'koboldhorde' && horde_settings.auto_adjust_response_length) {
                maxLength = Math.min(maxLength, adjustedParams.maxLength);
                maxLength = Math.max(maxLength, MIN_LENGTH); // prevent validation errors
            }

            generate_data = {
                prompt: finalPrompt,
                gui_settings: true,
                max_length: maxLength,
                max_context_length: max_context,
                api_server: kai_settings.api_server,
            };

            if (kai_settings.preset_settings != 'gui') {
                const isHorde = main_api == 'koboldhorde';
                const presetSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                const maxContext = (adjustedParams && horde_settings.auto_adjust_context_length) ? adjustedParams.maxContextLength : max_context;
                generate_data = getKoboldGenerationData(finalPrompt, presetSettings, maxLength, maxContext, isHorde, type);
            }
            break;
        case 'textgenerationwebui': {
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale, negativePrompt: await getCombinedPrompt(true) } : null;
            generate_data = await getTextGenGenerationData(finalPrompt, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'novel': {
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale } : null;
            const presetSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
            generate_data = getNovelGenerationData(finalPrompt, presetSettings, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'openai': {
            let [prompt, counts] = await prepareOpenAIMessages({
                name2: name2,
                charDescription: description,
                charPersonality: personality,
                scenario: scenario,
                worldInfoBeforeEntries: worldInfoBeforeEntries,
                worldInfoAfterEntries: worldInfoAfterEntries,
                extensionPrompts: extension_prompts,
                bias: promptBias,
                type: type,
                quietPrompt: quiet_prompt,
                quietImage: quietImage,
                cyclePrompt: cyclePrompt,
                systemPromptOverride: system,
                jailbreakPromptOverride: jailbreak,
                messages: oaiMessages,
                messageExamples: oaiMessageExamples,
            }, dryRun);
            generate_data = { prompt: prompt };

            // TODO: move these side-effects somewhere else, so this switch-case solely sets generate_data
            // counts will return false if the user has not enabled the token breakdown feature
            if (counts) {
                parseTokenCounts(counts, thisPromptBits);
            }

            if (!dryRun) {
                setInContextMessages(openai_messages_count, type);
            }
            break;
        }
    }

    await eventSource.emit(event_types.GENERATE_AFTER_DATA, generate_data, dryRun);

    if (dryRun) {
        return Promise.resolve();
    }

    /**
     * Saves itemized prompt bits and calls streaming or non-streaming generation API.
     * @returns {Promise<void|*|Awaited<*>|String|{fromStream}|string|undefined|Object>}
     * @throws {Error|object} Error with message text, or Error with response JSON (OAI/Horde), or the actual response JSON (novel|textgenerationwebui|kobold)
     */
    async function finishGenerating() {
        if (power_user.console_log_prompts) {
            console.log(generate_data.prompt);
        }

        console.debug('rungenerate calling API');

        showStopButton(type);

        //set array object for prompt token itemization of this message
        let currentArrayEntry = Number(thisPromptBits.length - 1);
        let additionalPromptStuff = {
            ...thisPromptBits[currentArrayEntry],
            rawPrompt: generate_data.prompt || generate_data.input,
            mesId: getNextMessageId(type),
            allAnchors: await getAllExtensionPrompts(),
            chatInjects: injectedIndices?.map(index => arrMes[arrMes.length - index - 1])?.join('') || '',
            authorsNoteString: (extension_prompts['2_floating_prompt']?.value || ''),
            smartContextString: (extension_prompts.chromadb?.value || ''),
            chatVectorsString: (extension_prompts['3_vectors']?.value || ''),
            dataBankVectorsString: (extension_prompts['4_vectors_data_bank']?.value || ''),
            worldInfoString: worldInfoString,
            storyString: storyString,
            beforeScenarioAnchor: beforeScenarioAnchor,
            afterScenarioAnchor: afterScenarioAnchor,
            examplesString: examplesString,
            mesSendString: mesSendString,
            generatedPromptCache: generatedPromptCache,
            promptBias: promptBias,
            finalPrompt: finalPrompt,
            charDescription: description,
            charPersonality: personality,
            scenarioText: scenario,
            this_max_context: this_max_context,
            padding: power_user.token_padding,
            main_api: main_api,
            instruction: main_api !== 'openai' && power_user.sysprompt.enabled ? substituteParams(power_user.prefer_character_prompt && system ? system : power_user.sysprompt.content) : '',
            userPersona: (power_user.persona_description_position == persona_description_positions.IN_PROMPT ? (persona || '') : ''),
            tokenizer: getFriendlyTokenizerName(main_api).tokenizerName || '',
            presetName: getPresetManager()?.getSelectedPresetName() || '',
            messagesCount: main_api !== 'openai' ? mesSend.length : oaiMessages.length,
            examplesCount: main_api !== 'openai' ? (pinExmString ? mesExamplesArray.length : count_exm_add) : oaiMessageExamples.length,
        };

        //console.log(additionalPromptStuff);
        const itemizedIndex = itemizedPrompts.findIndex((item) => item.mesId === additionalPromptStuff.mesId);

        if (itemizedIndex !== -1) {
            itemizedPrompts[itemizedIndex] = additionalPromptStuff;
        } else {
            itemizedPrompts.push(additionalPromptStuff);
        }

        console.debug(`pushed prompt bits to itemizedPrompts array. Length is now: ${itemizedPrompts.length}`);

        if (isStreamingEnabled() && type !== 'quiet') {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            streamingProcessor = new StreamingProcessor(type, force_name2, generation_started, continue_mag, promptReasoning);
            if (isContinue) {
                // Save reply does add cycle text to the prompt, so it's not needed here
                streamingProcessor.firstMessageText = '';
            }

            streamingProcessor.generator = await sendStreamingRequest(type, generate_data);

            hideSwipeButtons();
            let getMessage = await streamingProcessor.generate();
            let messageChunk = cleanUpMessage({
                getMessage: getMessage,
                isImpersonate: isImpersonate,
                isContinue: isContinue,
                displayIncompleteSentences: false,
            });

            if (isContinue) {
                getMessage = continue_mag + getMessage;
            }

            const isStreamFinished = streamingProcessor && !streamingProcessor.isStopped && streamingProcessor.isFinished;
            const isStreamWithToolCalls = streamingProcessor && Array.isArray(streamingProcessor.toolCalls) && streamingProcessor.toolCalls.length;
            if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {
                const lastMessage = chat[chat.length - 1];
                const hasToolCalls = ToolManager.hasToolCalls(streamingProcessor.toolCalls);
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage?.mes) && !lastMessage?.extra?.reasoning && ['', '...'].includes(streamingProcessor?.result);
                hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
                if (hasToolCalls && !shouldDeleteMessage) {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const invocationResult = await ToolManager.invokeFunctionTools(streamingProcessor.toolCalls, {
                    reasoningText: streamingProcessor.reasoningHandler.reasoning,
                });
                const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
                if (hasToolCalls) {
                    if (shouldStopGeneration) {
                        if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                            ToolManager.showToolCallError(invocationResult.errors);
                        }
                        unblockGeneration(type);
                        streamingProcessor = null;
                        return;
                    }

                    streamingProcessor = null;
                    depth = depth + 1;
                    await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                    return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_chid, signal, quietImage, quietName, depth }, dryRun);
                }
            }

            if (isStreamFinished) {
                await streamingProcessor.onFinishStreaming(streamingProcessor.messageId, getMessage);
                streamingProcessor = null;
                triggerAutoContinue(messageChunk, isImpersonate);
                return Object.defineProperties(new String(getMessage), {
                    'messageChunk': { value: messageChunk },
                    'fromStream': { value: true },
                });
            }
        } else {
            return await sendGenerationRequest(type, generate_data, { jsonSchema });
        }
    }

    if (type !== 'quiet') {
        notifyMessageProgressStart(String(name2 || chat?.[chat.length - 1]?.name || ''));
    }

    return finishGenerating().then(onSuccess, onError);

    /**
     * Handles the successful response from the generation API.
     * @param data
     * @returns {Promise<String|{fromStream}|*|string|string|void|Awaited<*>|undefined>}
     * @throws {Error} Throws an error if the response data contains an error message
     */
    async function onSuccess(data) {
        if (!data) return;

        if (data?.fromStream) {
            return data;
        }

        let messageChunk = '';

        // if an error was returned in data (textgenwebui), show it and throw it
        if (data.error) {
            unblockGeneration(type);

            if (data?.response) {
                toastr.error(data.response, t`API Error`, { preventDuplicates: true });
            }
            throw new Error(data?.response);
        }

        if (jsonSchema) {
            unblockGeneration(type);
            return extractJsonFromData(data);
        }

        //const getData = await response.json();
        let getMessage = extractMessageFromData(data);
        let title = extractTitleFromData(data);
        let reasoning = extractReasoningFromData(data);
        let imageUrls = extractImagesFromData(data);
        const reasoningSignature = extractReasoningSignatureFromData(data);
        kobold_horde_model = title;

        const swipes = extractMultiSwipes(data, type);

        messageChunk = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: false,
        });


        reasoning = getRegexedString(reasoning, regex_placement.REASONING);

        if (power_user.trim_spaces) {
            reasoning = reasoning.trim();
        }

        if (isContinue) {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            getMessage = continue_mag + getMessage;
        }

        //Formating
        const displayIncomplete = type === 'quiet' && !quietToLoud;
        getMessage = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: displayIncomplete,
        });

        if (isImpersonate) {
            $('#send_textarea').val(getMessage)[0].dispatchEvent(new Event('input', { bubbles: true }));
            await eventSource.emit(event_types.IMPERSONATE_READY, getMessage);
        } else if (type == 'quiet') {
            unblockGeneration(type);
            return getMessage;
        } else {
            // Without streaming we'll be having a full message on continuation. Treat it as a last chunk.
            if (originalType !== 'continue') {
                ({ type, getMessage } = await saveReply({ type, getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            } else {
                ({ type, getMessage } = await saveReply({ type: 'appendFinal', getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            }

            // This relies on `saveReply` having been called to add the message to the chat, so it must be last.
            parseAndSaveLogprobs(data, continue_mag);
        }

        if (canPerformToolCalls) {
            const hasToolCalls = ToolManager.hasToolCalls(data);
            const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(getMessage) && !reasoning;
            hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
            const invocationResult = await ToolManager.invokeFunctionTools(data, { reasoningText: reasoning });
            const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
            if (hasToolCalls) {
                if (shouldStopGeneration) {
                    if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                        ToolManager.showToolCallError(invocationResult.errors);
                    }
                    unblockGeneration(type);
                    return;
                }

                depth = depth + 1;
                await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_chid, signal, quietImage, quietName, depth }, dryRun);
            }
        }

        if (type !== 'quiet') {
            playMessageSound();
            notifyMessageComplete(getMessage, String(chat[chat.length - 1]?.name || ''));
        }

        const isAborted = abortController && abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(getMessage)) {
            is_send_press = false;
            return await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }

        console.debug('/api/chats/save called by /Generate');
        if (shouldUseLukerServerPersistenceForType(type) && chat.length > 0 && !chat[chat.length - 1]?.is_user) {
            chat[chat.length - 1].extra = chat[chat.length - 1].extra || {};
            chat[chat.length - 1].extra.luker_generation_id = getLastLukerGenerationIdForApi() || chat[chat.length - 1].extra.luker_generation_id;
        }
        const serverPersistedReply = isLastLukerReplyPersistedByServerForApi();
        const canUseIncrementalAppend = !isImpersonate
            && type === 'normal'
            && chat.length > 0
            && !chat[chat.length - 1]?.is_user
            && !serverPersistedReply;
        const localSaveStrategy = serverPersistedReply ? 'skip_local_save' : canUseIncrementalAppend ? 'append' : 'save';
        if (shouldUseLukerServerPersistenceForType(type)) {
            logLukerPersistenceDebug(main_api, 'save_decision', {
                type,
                strategy: localSaveStrategy,
                generation_id: getLastLukerGenerationIdForApi(),
                server_persisted: serverPersistedReply,
                aborted: Boolean(isAborted),
                message_id: chat.length - 1,
            });
        }
        if (serverPersistedReply) {
            // Backend persisted the reply after ACK timeout; avoid writing it again on the client.
        } else if (canUseIncrementalAppend) {
            const appended = await appendChatMessages([chat[chat.length - 1]]);
            if (!appended) {
                await saveChatConditional();
            }
        } else {
            await saveChatConditional();
        }
        unblockGeneration(type);
        streamingProcessor = null;

        if (type !== 'quiet') {
            triggerAutoContinue(messageChunk, isImpersonate);
        }

        // Don't break the API chain that expects a single string in return
        return Object.defineProperty(new String(getMessage), 'messageChunk', { value: messageChunk });
    }

    /**
     * Exception handler for finishGenerating
     * @param {Error|object} exception Error or response JSON
     * @throws {Error|object} Re-throws the exception
     */
    function onError(exception) {
        clearMessageProgressNotification();

        const isAbortedError = abortController?.signal?.aborted
            || exception?.name === 'AbortError'
            || /aborted/i.test(String(exception?.message || ''));
        const errorMessage = typeof exception?.error?.message === 'string'
            ? exception.error.message
            : (typeof exception?.message === 'string'
                ? exception.message
                : (typeof exception?.response === 'string' ? exception.response : ''));

        if (type !== 'quiet' && !isAbortedError) {
            notifyMessageFailure(errorMessage, String(name2 || chat?.[chat.length - 1]?.name || ''));
        }

        // if the response JSON was thrown (novel|textgenerationwebui|kobold), show the error message
        if (typeof exception?.error?.message === 'string') {
            toastr.error(exception.error.message, t`Text generation error`, { timeOut: 10000, extendedTimeOut: 20000 });
        }

        unblockGeneration(type);
        console.log(exception);
        streamingProcessor = null;
        throw exception;
    }
}
//MARK: Generate() ends

/**
 * Stops the generation and any streaming if it is currently running.
 */
export function stopGeneration() {
    clearMessageProgressNotification();

    let stopped = false;
    const generationId = getLastLukerGenerationIdForApi();
    if (generationId) {
        fetch('/api/backends/chat-completions/jobs/cancel', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: generationId }),
            cache: 'no-cache',
            keepalive: true,
        }).catch(error => {
            console.warn('Failed to cancel generation job on server', error);
        });
    }

    if (streamingProcessor) {
        streamingProcessor.onStopStreaming();
        stopped = true;
    }
    if (abortController) {
        abortController.abort('Clicked stop button');
        stopped = true;
    }
    if (stopped) {
        // Release the UI lock immediately after a user-driven stop. If the aborted request never
        // settles cleanly, waiting for Generate() cleanup leaves both send and stop controls hidden.
        forceUnblockGenerationUi();
    }
    eventSource.emit(event_types.GENERATION_STOPPED);
    return stopped;
}

/**
 * Injects extension prompts into chat messages.
 * @param {object[]} messages Array of chat messages
 * @param {boolean} isContinue Whether the generation is a continuation. If true, the extension prompts of depth 0 are injected at position 1.
 * @returns {Promise<number[]>} Array of indices where the extension prompts were injected
 */
async function doChatInject(messages, isContinue) {
    const injectedMessages = [];
    let totalInsertedMessages = 0;
    messages.reverse();

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
        // Order of priority (most important go lower)
        const roles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        const names = {
            [extension_prompt_roles.SYSTEM]: '',
            [extension_prompt_roles.USER]: name1,
            [extension_prompt_roles.ASSISTANT]: name2,
        };
        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        for (const role of roles) {
            const extensionPrompt = String(await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, role, wrap)).trimStart();
            const isNarrator = role === extension_prompt_roles.SYSTEM;
            const isUser = role === extension_prompt_roles.USER;
            const name = names[role];

            if (extensionPrompt) {
                roleMessages.push({
                    name: name,
                    is_user: isUser,
                    mes: extensionPrompt,
                    extra: {
                        type: isNarrator ? system_message_types.NARRATOR : null,
                    },
                });
            }
        }

        if (roleMessages.length) {
            const depth = isContinue && i === 0 ? 1 : i;
            const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
            injectedMessages.push(...roleMessages);
        }
    }

    const injectedIndices = injectedMessages.map(msg => messages.indexOf(msg));
    messages.reverse();
    return injectedIndices;
}

function flushWIInjections() {
    const depthPrefix = inject_ids.CUSTOM_WI_DEPTH;
    const outletPrefix = inject_ids.CUSTOM_WI_OUTLET('');

    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(depthPrefix) || key.startsWith(outletPrefix)) {
            delete extension_prompts[key];
        }
    }
}

/**
 * Unblocks the UI after a generation is complete.
 * @param {string} [type] Generation type (optional)
 */
function unblockGeneration(type) {
    // Don't unblock if a parallel stream is still running
    if (type === 'quiet' && streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    is_send_press = false;
    activateSendButtons();
    setGenerationProgress(0);
    flushEphemeralStoppingStrings();
    flushWIInjections();
}

function forceUnblockGenerationUi() {
    activateSendButtons();
    setGenerationProgress(0);
    flushEphemeralStoppingStrings();
    flushWIInjections();
}

export function getNextMessageId(type) {
    return type == 'swipe' ? chat.length - 1 : chat.length;
}

/**
 * Determines if the message should be auto-continued.
 * @param {string} messageChunk Current message chunk
 * @param {boolean} isImpersonate Is the user impersonation
 * @returns {boolean} Whether the message should be auto-continued
 */
export function shouldAutoContinue(messageChunk, isImpersonate) {
    if (!power_user.auto_continue.enabled) {
        console.debug('Auto-continue is disabled by user.');
        return false;
    }

    if (typeof messageChunk !== 'string') {
        console.debug('Not triggering auto-continue because message chunk is not a string');
        return false;
    }

    if (isImpersonate) {
        console.log('Continue for impersonation is not implemented yet');
        return false;
    }

    if (is_send_press) {
        console.debug('Auto-continue is disabled because a message is currently being sent.');
        return false;
    }

    if (abortController && abortController.signal.aborted) {
        console.debug('Auto-continue is not triggered because the generation was stopped.');
        return false;
    }

    if (power_user.auto_continue.target_length <= 0) {
        console.log('Auto-continue target length is 0, not triggering auto-continue');
        return false;
    }

    if (main_api === 'openai' && !power_user.auto_continue.allow_chat_completions) {
        console.log('Auto-continue for OpenAI is disabled by user.');
        return false;
    }

    const textareaText = String($('#send_textarea').val());
    const USABLE_LENGTH = 5;

    if (textareaText.length > 0) {
        console.log('Not triggering auto-continue because user input is not empty');
        return false;
    }

    if (messageChunk.trim().length > USABLE_LENGTH && chat.length) {
        const lastMessage = chat[chat.length - 1];
        const messageLength = getTokenCount(lastMessage.mes);
        const shouldAutoContinue = messageLength < power_user.auto_continue.target_length;

        if (shouldAutoContinue) {
            console.log(`Triggering auto-continue. Message tokens: ${messageLength}. Target tokens: ${power_user.auto_continue.target_length}. Message chunk: ${messageChunk}`);
            return true;
        } else {
            console.log(`Not triggering auto-continue. Message tokens: ${messageLength}. Target tokens: ${power_user.auto_continue.target_length}`);
            return false;
        }
    } else {
        console.log('Last generated chunk was empty, not triggering auto-continue');
        return false;
    }
}

/**
 * Triggers auto-continue if the message meets the criteria.
 * @param {string} messageChunk Current message chunk
 * @param {boolean} isImpersonate Is the user impersonation
 */
export function triggerAutoContinue(messageChunk, isImpersonate) {
    if (selected_group) {
        console.debug('Auto-continue is disabled for group chat');
        return;
    }

    if (shouldAutoContinue(messageChunk, isImpersonate)) {
        $('#option_continue').trigger('click');
    }
}

export function getBiasStrings(textareaText, type) {
    if (type == 'impersonate' || type == 'continue') {
        return { messageBias: '', promptBias: '', isUserPromptBias: false };
    }

    let promptBias = '';
    let messageBias = extractMessageBias(textareaText);

    // If user input is not provided, retrieve the bias of the most recent relevant message
    if (!textareaText) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const mes = chat[i];
            if (type === 'swipe' && chat.length - 1 === i) {
                continue;
            }
            if (mes && (mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR)) {
                if (mes.extra?.bias?.trim()?.length > 0) {
                    promptBias = mes.extra.bias;
                }
                break;
            }
        }
    }

    promptBias = messageBias || promptBias || power_user.user_prompt_bias || '';
    const isUserPromptBias = promptBias === power_user.user_prompt_bias;

    // Substitute params for everything
    messageBias = substituteParams(messageBias);
    promptBias = substituteParams(promptBias);

    return { messageBias, promptBias, isUserPromptBias };
}

/**
 * @param {Object} chatItem Message history item.
 * @param {boolean} isInstruct Whether instruct mode is enabled.
 * @param {boolean|number} forceOutputSequence Whether to force the first/last output sequence for instruct mode.
 */
function formatMessageHistoryItem(chatItem, isInstruct, forceOutputSequence) {
    const isNarratorType = chatItem?.extra?.type === system_message_types.NARRATOR;
    const characterName = chatItem?.name ? chatItem.name : name2;
    const itemName = chatItem.is_user ? chatItem.name : characterName;
    const shouldPrependName = !isNarratorType;

    // If this symbol flag is set, completely ignore the message.
    // This can be used to hide messages without affecting the number of messages in the chat.
    if (chatItem.extra?.[IGNORE_SYMBOL]) {
        return '';
    }

    // Don't include a name if it's empty
    let textResult = chatItem?.name && shouldPrependName ? `${itemName}: ${chatItem.mes}\n` : `${chatItem.mes}\n`;

    if (isInstruct) {
        textResult = formatInstructModeChat(itemName, chatItem.mes, chatItem.is_user, isNarratorType, chatItem.force_avatar, name1, name2, forceOutputSequence);
    }

    return textResult;
}

/**
 * Removes all {{macros}} from a string.
 * @param {string} str String to remove macros from.
 * @returns {string} String with macros removed.
 */
export function removeMacros(str) {
    return (str ?? '').replace(/\{\{[\s\S]*?\}\}/gm, '').trim();
}

/**
 * Inserts a user message into the chat history.
 * @param {string} messageText Message text.
 * @param {string} messageBias Message bias.
 * @param {number} [insertAt] Optional index to insert the message at.
 * @param {boolean} [compact] Send as a compact display message.
 * @param {string} [name] Name of the user sending the message. Defaults to name1.
 * @param {string} [avatar] Avatar of the user sending the message. Defaults to user_avatar.
 * @returns {Promise<any>} A promise that resolves to the message when it is inserted.
 */
export async function sendMessageAsUser(messageText, messageBias, insertAt = null, compact = false, name = name1, avatar = user_avatar) {
    messageText = getRegexedString(messageText, regex_placement.USER_INPUT);

    const message = {
        name: name,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(messageText),
        extra: {
            isSmallSys: compact,
        },
    };

    if (power_user.message_token_count_enabled) {
        message.extra.token_count = await getTokenCountAsync(message.mes, 0);
    }

    // Lock user avatar to a persona.
    if (avatar in power_user.personas) {
        message.force_avatar = getThumbnailUrl('persona', avatar);
    }

    if (messageBias) {
        message.extra.bias = messageBias;
        message.mes = removeMacros(message.mes);
    }

    await populateFileAttachment(message);
    statMesProcess(message, 'user', characters, this_chid, '');

    chat_metadata.tainted = true;

    if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        const patched = await patchChatMessages([{ op: 'add', path: `/${insertAt}`, value: message }]);
        if (!patched) {
            await saveChatConditional();
        }
        await eventSource.emit(event_types.MESSAGE_SENT, insertAt);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, insertAt);
    } else {
        chat.push(message);
        const chat_id = (chat.length - 1);
        await eventSource.emit(event_types.MESSAGE_SENT, chat_id);
        addOneMessage(message);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, chat_id);
        const appended = await appendChatMessages([message]);
        if (!appended) {
            await saveChatConditional();
        }
    }

    return message;
}

/**
 * Gets the maximum context token limit (the full context window size before subtracting response length).
 * @returns {number} The maximum context token limit for the current API.
 */
export function getMaxContextTokens() {
    if (main_api == 'kobold' || main_api == 'koboldhorde' || main_api == 'textgenerationwebui') {
        return max_context;
    }
    if (main_api == 'novel') {
        let this_max_context = Number(max_context);
        if (nai_settings.model_novel.includes('clio')) {
            this_max_context = Math.min(max_context, 8192);
        }
        if (nai_settings.model_novel.includes('kayra')) {
            this_max_context = Math.min(max_context, 8192);

            const subscriptionLimit = getKayraMaxContextTokens();
            if (typeof subscriptionLimit === 'number' && this_max_context > subscriptionLimit) {
                this_max_context = subscriptionLimit;
                console.log(`NovelAI subscription limit reached. Max context size is now ${this_max_context}`);
            }
        }
        if (nai_settings.model_novel.includes('erato')) {
            // subscriber limits coming soon
            this_max_context = Math.min(max_context, 8192);

            // Added special tokens and whatnot
            this_max_context -= 10;
        }
        return this_max_context;
    }
    if (main_api == 'openai') {
        return oai_settings.openai_max_context;
    }
    return 1487;
}

/**
 * Gets the maximum response token limit (the max generation/reply length).
 * @returns {number} The maximum response token limit for the current API.
 */
export function getMaxResponseTokens() {
    if (main_api == 'kobold' || main_api == 'koboldhorde' || main_api == 'textgenerationwebui' || main_api == 'novel') {
        return amount_gen;
    }
    if (main_api == 'openai') {
        return oai_settings.openai_max_tokens;
    }
    return 0;
}

/**
 * Gets the maximum usable prompt size for the current API.
 * @param {number|null} overrideResponseLength Optional override for the response length.
 * @returns {number} Maximum usable prompt size.
 */
export function getMaxPromptTokens(overrideResponseLength = null) {
    if (typeof overrideResponseLength !== 'number' || overrideResponseLength <= 0 || isNaN(overrideResponseLength)) {
        overrideResponseLength = null;
    }

    return getMaxContextTokens() - (overrideResponseLength || getMaxResponseTokens());
}

function parseTokenCounts(counts, thisPromptBits) {
    /**
     * @param {any[]} numbers
     */
    function getSum(...numbers) {
        return numbers.map(x => Number(x)).filter(x => !Number.isNaN(x)).reduce((acc, val) => acc + val, 0);
    }
    const total = getSum(Object.values(counts));

    thisPromptBits.push({
        oaiStartTokens: (counts?.start + counts?.controlPrompts) || 0,
        oaiPromptTokens: getSum(counts?.prompt, counts?.charDescription, counts?.charPersonality, counts?.scenario) || 0,
        oaiBiasTokens: counts?.bias || 0,
        oaiNudgeTokens: counts?.nudge || 0,
        oaiJailbreakTokens: counts?.jailbreak || 0,
        oaiImpersonateTokens: counts?.impersonate || 0,
        oaiExamplesTokens: (counts?.dialogueExamples + counts?.examples) || 0,
        oaiConversationTokens: (counts?.conversation + counts?.chatHistory) || 0,
        oaiNsfwTokens: counts?.nsfw || 0,
        oaiMainTokens: counts?.main || 0,
        oaiTotalTokens: total,
    });
}

function addChatsPreamble(mesSendString) {
    return main_api === 'novel'
        ? substituteParams(nai_settings.preamble) + '\n' + mesSendString
        : mesSendString;
}

function addChatsSeparator(mesSendString) {
    if (power_user.context.chat_start) {
        return substituteParams(power_user.context.chat_start + '\n') + mesSendString;
    } else {
        return mesSendString;
    }
}

/**
 * Duplicates a character.
 * @param {object} [options={}] - Options
 * @param {string} [options.avatar] - Avatar key of the character to duplicate. Uses current character if not provided.
 * @param {boolean} [options.silent=false] - Whether to skip the confirmation popup
 * @returns {Promise<string>} The avatar key of the duplicated character, or empty string if cancelled/failed
 */
export async function duplicateCharacter({ avatar = null, silent = false } = {}) {
    // Determine the character to duplicate
    let targetAvatar;
    if (avatar) {
        const character = characters.find(c => c.avatar === avatar);
        if (!character) {
            toastr.warning(t`Character not found: ${avatar}`);
            return '';
        }
        targetAvatar = avatar;
    } else {
        if (this_chid === undefined || !characters[this_chid]) {
            toastr.warning(t`You must first select a character to duplicate!`);
            return '';
        }
        targetAvatar = characters[this_chid].avatar;
    }

    // Show confirmation unless silent
    if (!silent) {
        const confirmMessage = $(await renderTemplateAsync('duplicateConfirm'));
        const confirm = await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);

        if (!confirm) {
            console.log('User cancelled duplication');
            return '';
        }
    }

    const body = { avatar_url: targetAvatar };
    const response = await fetch('/api/characters/duplicate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        toastr.error(t`Failed to duplicate character`);
        return '';
    }

    toastr.success(t`Character Duplicated`);
    const data = await response.json();
    await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: targetAvatar, newAvatar: data.path });
    await getCharacters();

    return data.path;
}

function setInContextMessages(msgInContextCount, type) {
    chatElement.find('.mes').removeClass('lastInContext');

    if (type === 'swipe' || type === 'regenerate' || type === 'continue') {
        msgInContextCount++;
    }

    const lastMessageBlock = chatElement.find('.mes:not([is_system="true"]), .mes.toolCall').eq(-msgInContextCount);
    lastMessageBlock.addClass('lastInContext');

    if (lastMessageBlock.length === 0) {
        const firstMessageId = getFirstDisplayedMessageId();
        chatElement.find(`.mes[mesid="${firstMessageId}"`).addClass('lastInContext');
    }

    // Update last id to chat. No metadata save on purpose, gets hopefully saved via another call
    const lastMessageId = Math.max(0, chat.length - msgInContextCount);
    chat_metadata.lastInContextMessageId = lastMessageId;
}

/**
 * @typedef {object} AdditionalRequestOptions
 * @property {JsonSchema} [jsonSchema]
 * @property {string} [llmPresetName]
 * @property {string} [apiPresetName]
 * @property {object} [apiSettingsOverride]
 */

/**
 * Sends a non-streaming request to the API.
 * @param {string} type Generation type
 * @param {object} data Generation data
 * @param {AdditionalRequestOptions} [options] Additional options for the generation request
 * @returns {Promise<object>} Response data from the API
 * @throws {Error|object}
 */
export async function sendGenerationRequest(type, data, options = {}) {
    const requestPayload = { type, data, options, mainApi: main_api, stream: false };
    await eventSource.emit(event_types.GENERATION_BEFORE_API_REQUEST, requestPayload);
    data = requestPayload.data;
    options = requestPayload.options || options;

    if (main_api === 'openai') {
        return await sendOpenAIRequest(type, data.prompt, abortController.signal, options);
    }

    if (main_api === 'koboldhorde') {
        return await generateHorde(data.prompt, data, abortController.signal, true);
    }

    const shouldTrackLukerGenerationState = shouldUseLukerServerPersistenceForType(type) && supportsLukerServerPersistence(main_api);
    if (shouldTrackLukerGenerationState) {
        resetLukerGenerationState(main_api);
    }
    const lukerGenerationOptions = shouldTrackLukerGenerationState
        ? buildLukerGenerationRequestOptions(type, main_api)
        : null;
    const requestData = lukerGenerationOptions
        ? { ...data, luker_generation: lukerGenerationOptions }
        : data;

    const response = await fetch(getGenerateUrl(main_api), {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(requestData),
        signal: abortController.signal,
    });

    if (shouldTrackLukerGenerationState) {
        applyLukerGenerationMetaFromHeaders(main_api, response);
    }

    if (!response.ok) {
        throw await response.json();
    }

    return await response.json();
}

/**
 * Sends a streaming request to the API.
 * @param {string} type Generation type
 * @param {object} data Generation data
 * @param {AdditionalRequestOptions} [options] Additional options for the generation request
 * @returns {Promise<any>} Streaming generator
 */
export async function sendStreamingRequest(type, data, options = {}) {
    if (abortController?.signal?.aborted) {
        throw new Error('Generation was aborted.');
    }

    const requestPayload = { type, data, options, mainApi: main_api, stream: true };
    await eventSource.emit(event_types.GENERATION_BEFORE_API_REQUEST, requestPayload);
    data = requestPayload.data;
    options = requestPayload.options || options;

    const shouldTrackLukerGenerationState = shouldUseLukerServerPersistenceForType(type) && supportsLukerServerPersistence(main_api);
    const onLukerMeta = shouldTrackLukerGenerationState
        ? (meta) => {
            applyLukerGenerationMetaForApi(main_api, meta);
            if (meta?.generationId || typeof meta?.persisted === 'boolean') {
                logLukerPersistenceDebug(main_api, 'stream_meta', {
                    ...(meta?.generationId ? { generation_id: meta.generationId } : {}),
                    ...(typeof meta?.persisted === 'boolean' ? { persisted: meta.persisted } : {}),
                });
            }
        }
        : null;
    if (main_api !== 'openai') {
        if (shouldTrackLukerGenerationState) {
            resetLukerGenerationState(main_api);
        }
        const lukerGenerationOptions = shouldTrackLukerGenerationState
            ? buildLukerGenerationRequestOptions(type, main_api)
            : null;
        if (lukerGenerationOptions) {
            data = { ...data, luker_generation: lukerGenerationOptions };
        }
    }

    switch (main_api) {
        case 'openai':
            return await sendOpenAIRequest(type, data.prompt, streamingProcessor.abortController.signal, options);
        case 'textgenerationwebui':
            return await generateTextGenWithStreaming(data, streamingProcessor.abortController.signal, { onLukerMeta });
        case 'novel':
            return await generateNovelWithStreaming(data, streamingProcessor.abortController.signal, { onLukerMeta });
        case 'kobold':
            return await generateKoboldWithStreaming(data, streamingProcessor.abortController.signal, { onLukerMeta });
        default:
            throw new Error('Streaming is enabled, but the current API does not support streaming.');
    }
}

/**
 * Gets the generation endpoint URL for the specified API.
 * @param {string} api API name
 * @returns {string} Generation URL
 * @throws {Error} If the API is unknown
 */
export function getGenerateUrl(api) {
    switch (api) {
        case 'kobold':
            return '/api/backends/kobold/generate';
        case 'koboldhorde':
            return '/api/backends/koboldhorde/generate';
        case 'textgenerationwebui':
            return '/api/backends/text-completions/generate';
        case 'novel':
            return '/api/novelai/generate';
        default:
            throw new Error(`Unknown API: ${api}`);
    }
}

function extractTitleFromData(data) {
    if (main_api == 'koboldhorde') {
        return data.workerName;
    }

    return undefined;
}

/**
 * Extracts the image from the response data.
 * @param {object} data Response data
 * @param {object} [options] Extraction options
 * @param {string} [options.mainApi] Main API to use
 * @param {string} [options.chatCompletionSource] Chat completion source
 * @returns {string[]} Extracted images or empty array
 */
function extractImagesFromData(data, { mainApi = null, chatCompletionSource = null } = {}) {
    switch (mainApi ?? main_api) {
        case 'openai': {
            switch (chatCompletionSource ?? oai_settings.chat_completion_source) {
                case chat_completion_sources.VERTEXAI:
                case chat_completion_sources.MAKERSUITE: {
                    const inlineData = data?.responseContent?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData);
                    if (Array.isArray(inlineData) && inlineData.length > 0) {
                        return inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL);
                    }
                } break;
                case chat_completion_sources.OPENROUTER: {
                    const imageUrl = data?.choices[0]?.message?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url);
                    if (Array.isArray(imageUrl) && imageUrl.length > 0) {
                        return imageUrl.filter(isDataURL);
                    }
                    // TODO: Handle remote URLs
                }
            }
        } break;
    }

    return [];
}

/**
 * parseAndSaveLogprobs receives the full data response for a non-streaming
 * generation, parses logprobs for all tokens in the message, and saves them
 * to the currently active message.
 * @param {object} data - response data containing all tokens/logprobs
 * @param {string} continueFrom - for 'continue' generations, the prompt
 *  */
function parseAndSaveLogprobs(data, continueFrom) {
    /** @type {import('./scripts/logprobs.js').TokenLogprobs[] | null} */
    let logprobs = null;

    switch (main_api) {
        case 'novel':
            // parser only handles one token/logprob pair at a time
            logprobs = data.logprobs?.map(parseNovelAILogprobs) || null;
            break;
        case 'openai':
            // OAI and other chat completion APIs must handle this earlier in
            // `sendOpenAIRequest`. `data` for these APIs is just a string with
            // the text of the generated message, logprobs are not included.
            return;
        case 'textgenerationwebui':
            switch (textgen_settings.type) {
                case textgen_types.LLAMACPP: {
                    logprobs = data?.completion_probabilities?.map(x => parseTextgenLogprobs(x.content, [x])) || null;
                } break;
                case textgen_types.KOBOLDCPP:
                case textgen_types.VLLM:
                case textgen_types.INFERMATICAI:
                case textgen_types.APHRODITE:
                case textgen_types.MANCER:
                case textgen_types.TABBY: {
                    logprobs = parseTabbyLogprobs(data) || null;
                } break;
            } break;
        default:
            return;
    }

    saveLogprobsForActiveMessage(logprobs, continueFrom);
}

/**
 * Extracts the message from the response data.
 * @param {object} data Response data
 * @param {string} activeApi If it's set, ignores active API
 * @returns {string} Extracted message
 */
export function extractMessageFromData(data, activeApi = null) {
    function getResult() {
        if (typeof data === 'string') {
            return data;
        }

        switch (activeApi ?? main_api) {
            case 'kobold':
                return data.results[0].text;
            case 'koboldhorde':
                return data.text;
            case 'textgenerationwebui':
                return data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data[0]?.content ?? '';
            case 'novel':
                return data.output;
            case 'openai':
                return data?.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join('\n\n') ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.text ?? data?.message?.content?.[0]?.text ?? data?.message?.tool_plan ?? '';
            default:
                return '';
        }
    }

    const result = getResult();
    return Array.isArray(result) ? result.map(x => x.text).filter(x => x).join('') : result;
}

/**
 * Extracts JSON from the response data.
 * @param {object} data Response data
 * @returns {string} Extracted JSON string from the response data
 */
export function extractJsonFromData(data, { mainApi = null, chatCompletionSource = null } = {}) {
    mainApi = mainApi ?? main_api;
    chatCompletionSource = chatCompletionSource ?? oai_settings.chat_completion_source;

    const tryParse = (/** @type {string} */ value) => {
        try {
            return JSON.parse(value);
        } catch (e) {
            console.debug('Failed to parse content as JSON.', e);
        }
    };

    let result = {};

    switch (mainApi) {
        case 'openai': {
            const text = extractMessageFromData(data, mainApi);
            switch (chatCompletionSource) {
                case chat_completion_sources.CLAUDE:
                    result = data?.content?.find(x => x.type === 'tool_use')?.input;
                    break;
                case chat_completion_sources.PERPLEXITY:
                    result = tryParse(removeReasoningFromString(text));
                    break;
                case chat_completion_sources.VERTEXAI:
                case chat_completion_sources.MAKERSUITE:
                case chat_completion_sources.DEEPSEEK:
                case chat_completion_sources.AI21:
                case chat_completion_sources.GROQ:
                case chat_completion_sources.POLLINATIONS:
                case chat_completion_sources.AIMLAPI:
                case chat_completion_sources.OPENAI:
                case chat_completion_sources.OPENROUTER:
                case chat_completion_sources.MISTRALAI:
                case chat_completion_sources.CUSTOM:
                case chat_completion_sources.COHERE:
                case chat_completion_sources.XAI:
                case chat_completion_sources.ELECTRONHUB:
                case chat_completion_sources.CHUTES:
                case chat_completion_sources.AZURE_OPENAI:
                case chat_completion_sources.ZAI:
                default:
                    result = tryParse(text);
                    break;
            }
        } break;
    }

    return JSON.stringify(result ?? {});
}

/**
 * Extracts multiswipe swipes from the response data.
 * @param {Object} data Response data
 * @param {string} type Type of generation
 * @returns {string[]} Array of extra swipes
 */
function extractMultiSwipes(data, type) {
    const swipes = [];

    if (!data) {
        return swipes;
    }

    if (type === 'continue' || type === 'impersonate' || type === 'quiet') {
        return swipes;
    }

    if (main_api === 'textgenerationwebui' && textgen_settings.type === textgen_types.LLAMACPP) {
        if (!Array.isArray(data)) {
            return swipes;
        }

        const multiSwipeCount = data.length - 1;
        if (multiSwipeCount <= 0) {
            return swipes;
        }

        for (let i = 1; i < data.length; i++) {
            const text = data?.[i]?.content ?? '';
            swipes.push(text);
        }
    }

    if (main_api === 'openai' || (main_api === 'textgenerationwebui' && [textgen_types.MANCER, textgen_types.VLLM, textgen_types.APHRODITE, textgen_types.TABBY, textgen_types.INFERMATICAI].includes(textgen_settings.type))) {
        if (!Array.isArray(data.choices)) {
            return swipes;
        }

        const multiSwipeCount = data.choices.length - 1;

        if (multiSwipeCount <= 0) {
            return swipes;
        }

        for (let i = 1; i < data.choices.length; i++) {
            const text = data?.choices[i]?.message?.content ?? data?.choices[i]?.text ?? '';
            swipes.push(text);
        }
    }

    const cleanedSwipes = swipes.map(text => cleanUpMessage({
        getMessage: text,
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: false,
    }));

    return cleanedSwipes;
}

/**
 * Formats a message according to user settings
 * @param {object} [options] - Additional options.
 * @param {string} [options.getMessage] The message to clean up
 * @param {boolean} [options.isImpersonate] Whether this is an impersonated message
 * @param {boolean} [options.isContinue] Whether this is a continued message
 * @param {boolean} [options.displayIncompleteSentences] Whether to keep incomplete sentences at the end.
 * @param {array} [options.stoppingStrings] Array of stopping strings.
 * @param {boolean} [options.includeUserPromptBias] Whether to permit prepending the user prompt bias at the beginning.
 * @param {boolean} [options.trimNames] Whether to allow trimming "{{char}}:" or "{{user}}:" from the beginning.
 * @param {boolean} [options.trimWrongNames] Whether to allow deleting responses prefixed by the incorrect name, depending on isImpersonate
 *
 * @returns {string} The formatted message
 */
export function cleanUpMessage({ getMessage, isImpersonate, isContinue, displayIncompleteSentences = false, stoppingStrings = null, includeUserPromptBias = true, trimNames = true, trimWrongNames = true } = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('cleanUpMessage called with positional arguments. Please use an object instead.');
        [getMessage, isImpersonate, isContinue, displayIncompleteSentences, stoppingStrings, includeUserPromptBias, trimNames, trimWrongNames] = arguments;
    }

    if (!getMessage) {
        return '';
    }

    // Add the prompt bias before anything else
    if (
        includeUserPromptBias &&
        power_user.user_prompt_bias &&
        !isImpersonate &&
        !isContinue &&
        power_user.user_prompt_bias.length !== 0
    ) {
        getMessage = substituteParams(power_user.user_prompt_bias) + getMessage;
    }

    // Allow for caching of stopping strings. getStoppingStrings is an expensive function, especially with macros
    // enabled, so for streaming, we call it once and then pass it into each cleanUpMessage call.
    if (!stoppingStrings) {
        stoppingStrings = getStoppingStrings(isImpersonate, isContinue, main_api);
    }

    for (const stoppingString of stoppingStrings) {
        if (stoppingString.length) {
            for (let j = stoppingString.length; j > 0; j--) {
                if (getMessage.slice(-j) === stoppingString.slice(0, j)) {
                    getMessage = getMessage.slice(0, -j);
                    break;
                }
            }
        }
    }

    // Regex uses vars, so add before formatting
    getMessage = getRegexedString(getMessage, isImpersonate ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT);

    if (power_user.collapse_newlines) {
        getMessage = collapseNewlines(getMessage);
    }

    // trailing invisible whitespace before every newlines, on a multiline string
    // "trailing whitespace on newlines       \nevery line of the string    \n?sample text" ->
    // "trailing whitespace on newlines\nevery line of the string\nsample text"
    getMessage = getMessage.replace(/[^\S\r\n]+$/gm, '');

    if (trimWrongNames) {
        // If this is an impersonation, delete the entire response if it starts with "{{char}}:"
        // If this isn't an impersonation, delete the entire response if it starts with "{{user}}:"
        // Also delete any trailing text that starts with the wrong name.
        // This only occurs if the corresponding "power_user.allow_nameX_display" is false.

        let wrongName = isImpersonate
            ? (!power_user.allow_name2_display ? name2 : '')  // char
            : (!power_user.allow_name1_display ? name1 : '');  // user

        if (wrongName) {
            // If the message starts with the wrong name, delete the entire response
            let startIndex = getMessage.indexOf(`${wrongName}:`);
            if (startIndex === 0) {
                getMessage = '';
                console.debug(`Message started with the wrong name: "${wrongName}" - response was deleted.`);
            }

            // If there is trailing text starting with the wrong name, trim it off.
            startIndex = getMessage.indexOf(`\n${wrongName}:`);
            if (startIndex >= 0) {
                getMessage = getMessage.substring(0, startIndex);
            }
        }
    }

    if (getMessage.indexOf('<|endoftext|>') != -1) {
        getMessage = getMessage.substring(0, getMessage.indexOf('<|endoftext|>'));
    }
    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isNotEmpty = (str) => str && str.trim() !== '';
    if (isInstruct && power_user.instruct.stop_sequence) {
        if (getMessage.indexOf(power_user.instruct.stop_sequence) != -1) {
            getMessage = getMessage.substring(0, getMessage.indexOf(power_user.instruct.stop_sequence));
        }
    }
    // Hana: Only use the first sequence (should be <|model|>)
    // of the prompt before <|user|> (as KoboldAI Lite does it).
    if (isInstruct && isNotEmpty(power_user.instruct.input_sequence)) {
        if (getMessage.indexOf(power_user.instruct.input_sequence) != -1) {
            getMessage = getMessage.substring(0, getMessage.indexOf(power_user.instruct.input_sequence));
        }
    }

    // Remove instruct sequences leaking to the output
    if (isInstruct && power_user.instruct.sequences_as_stop_strings) {
        const sequences = [
            { value: power_user.instruct.input_sequence, apply: isImpersonate && isNotEmpty(power_user.instruct.input_sequence) },
            { value: power_user.instruct.output_sequence, apply: !isImpersonate && isNotEmpty(power_user.instruct.output_sequence) },
            { value: power_user.instruct.last_output_sequence, apply: !isImpersonate && isNotEmpty(power_user.instruct.last_output_sequence) },
        ];
        for (const seq of sequences.filter(s => s.apply)) {
            seq.value.split('\n').filter(line => line.trim() !== '').forEach(line => { getMessage = getMessage.replaceAll(line, ''); });
        }
    }

    // clean-up group message from excessive generations
    if (selected_group) {
        getMessage = cleanGroupMessage(getMessage);
    }

    if (!power_user.allow_name2_display) {
        const name2Escaped = escapeRegex(name2);
        getMessage = getMessage.replace(new RegExp(`(^|\n)${name2Escaped}:\\s*`, 'g'), '$1');
    }

    if (isImpersonate) {
        getMessage = getMessage.trim();
    }

    if (power_user.auto_fix_generated_markdown) {
        getMessage = fixMarkdown(getMessage, false);
    }

    if (trimNames) {
        // If this is an impersonation, trim "{{user}}:" from the beginning
        // If this isn't an impersonation, trim "{{char}}:" from the beginning.
        // Only applied when the corresponding "power_user.allow_nameX_display" is false.
        const nameToTrim2 = isImpersonate
            ? (!power_user.allow_name1_display ? name1 : '')  // user
            : (!power_user.allow_name2_display ? name2 : '');  // char

        if (nameToTrim2 && getMessage.startsWith(nameToTrim2 + ':')) {
            getMessage = getMessage.replace(nameToTrim2 + ':', '');
            getMessage = getMessage.trimStart();
        }
    }

    if (isImpersonate) {
        getMessage = getMessage.trim();
    }

    if (!displayIncompleteSentences && power_user.trim_sentences) {
        getMessage = trimToEndSentence(getMessage);
    }

    if (power_user.trim_spaces && !PromptReasoning.getLatestPrefix()) {
        getMessage = getMessage.trim();
    }

    return getMessage;
}

/**
 * Adds an image to the message.
 * @param {object} message Message object
 * @param {object} sources Image sources
 * @param {string[]} [sources.imageUrls] Image URLs
 *
 * @returns {Promise<void>}
 */
async function processImageAttachment(message, { imageUrls }) {
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        return;
    }

    for (const [index, imageUrl] of imageUrls.filter(onlyUnique).entries()) {
        if (!imageUrl) {
            continue;
        }

        let url = imageUrl;
        if (isDataURL(url)) {
            const fileName = `inline_image_${Date.now().toString()}_${index}`;
            const [mime, base64] = /^data:(.*?);base64,(.*)$/.exec(imageUrl).slice(1);
            url = await saveBase64AsFile(base64, message.name, fileName, mime.split('/')[1]);
        }
        saveImageToMessage({ image: url, inline: true }, message);
    }
}

/**
 * Saves a resulting message to the chat.
 * @param {SaveReplyParams} params
 * @returns {Promise<SaveReplyResult>} Promise when the message is saved
 *
 * @typedef {object} SaveReplyParams
 * @property {string} type Type of generation
 * @property {string} getMessage Generated message
 * @property {boolean} [fromStreaming] If the message is from streaming
 * @property {string} [title] Message tooltip
 * @property {string[]} [swipes] Extra swipes
 * @property {string} [reasoning] Message reasoning
 * @property {string[]} [imageUrls] Links to images
 * @property {string?} [reasoningSignature] Encrypted signature of the reasoning text
 *
 * @typedef {object} SaveReplyResult
 * @property {string} type Type of generation
 * @property {string} getMessage Generated message
 */
export async function saveReply({ type, getMessage, fromStreaming = false, title = '', swipes = [], reasoning = '', imageUrls = [], reasoningSignature = null }) {
    // Backward compatibility
    if (arguments.length > 1 && typeof arguments[0] !== 'object') {
        console.trace('saveReply called with positional arguments. Please use an object instead.');
        [type, getMessage, fromStreaming, title, swipes, reasoning, imageUrls, reasoningSignature] = arguments;
    }

    const lastMessage = chat[chat.length - 1];

    if (type != 'append' && type != 'continue' && type != 'appendFinal' && chat.length && (lastMessage.swipe_id === undefined ||
        lastMessage.is_user)) {
        type = 'normal';
    }

    if (chat.length && (!lastMessage.extra || typeof lastMessage.extra !== 'object')) {
        lastMessage.extra = {};
    }

    // Coerce null/undefined to empty string
    if (chat.length && !lastMessage.extra.reasoning) {
        lastMessage.extra.reasoning = '';
    }

    if (!reasoning) {
        reasoning = '';
    }

    let oldMessage = '';
    const generationFinished = new Date();
    if (type === 'swipe') {
        oldMessage = lastMessage.mes;
        lastMessage.swipes.length++;
        if (lastMessage.swipe_id === lastMessage.swipes.length - 1) {
            lastMessage.title = title;
            lastMessage.mes = getMessage;
            lastMessage.gen_started = generation_started;
            lastMessage.gen_finished = generationFinished;
            lastMessage.send_date = getMessageTimeStamp();
            lastMessage.extra.api = getGeneratingApi();
            lastMessage.extra.model = getGeneratingModel();
            lastMessage.extra.reasoning = reasoning;
            lastMessage.extra.reasoning_duration = null;
            lastMessage.extra.reasoning_signature = reasoningSignature;
            await processImageAttachment(lastMessage, { imageUrls });
            if (power_user.message_token_count_enabled) {
                const tokenCountText = (reasoning || '') + lastMessage.mes;
                lastMessage.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
            }
            const chat_id = (chat.length - 1);
            !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
            addOneMessage(chat[chat_id], { type: 'swipe' });
            !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
        } else {
            lastMessage.mes = getMessage;
        }
    } else if (type === 'append' || type === 'continue') {
        console.debug('Trying to append.');
        oldMessage = lastMessage.mes;
        lastMessage.title = title;
        lastMessage.mes += getMessage;
        lastMessage.gen_started = generation_started;
        lastMessage.gen_finished = generationFinished;
        lastMessage.send_date = getMessageTimeStamp();
        lastMessage.extra.api = getGeneratingApi();
        lastMessage.extra.model = getGeneratingModel();
        lastMessage.extra.reasoning = reasoning;
        lastMessage.extra.reasoning_duration = null;
        lastMessage.extra.reasoning_signature = reasoningSignature;
        await processImageAttachment(lastMessage, { imageUrls });
        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + lastMessage.mes;
            lastMessage.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
        }
        const chat_id = (chat.length - 1);
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else if (type === 'appendFinal') {
        oldMessage = lastMessage.mes;
        console.debug('Trying to appendFinal.');
        lastMessage.title = title;
        lastMessage.mes = getMessage;
        lastMessage.gen_started = generation_started;
        lastMessage.gen_finished = generationFinished;
        lastMessage.send_date = getMessageTimeStamp();
        lastMessage.extra.api = getGeneratingApi();
        lastMessage.extra.model = getGeneratingModel();
        lastMessage.extra.reasoning += reasoning;
        lastMessage.extra.reasoning_signature = reasoningSignature;
        await processImageAttachment(lastMessage, { imageUrls });
        // We don't know if the reasoning duration extended, so we don't update it here on purpose.
        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + lastMessage.mes;
            lastMessage.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
        }
        const chat_id = (chat.length - 1);
        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id], { type: 'swipe' });
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    } else {
        console.debug('entering chat update routine for non-swipe post');
        const newMessage = {};
        chat.push(newMessage);
        newMessage.extra = {};
        newMessage.name = name2;
        newMessage.is_user = false;
        newMessage.send_date = getMessageTimeStamp();
        newMessage.extra.api = getGeneratingApi();
        newMessage.extra.model = getGeneratingModel();
        newMessage.extra.reasoning = reasoning;
        newMessage.extra.reasoning_duration = null;
        newMessage.extra.reasoning_signature = reasoningSignature;
        if (power_user.trim_spaces) {
            getMessage = getMessage.trim();
        }
        newMessage.mes = getMessage;
        newMessage.title = title;
        newMessage.gen_started = generation_started;
        newMessage.gen_finished = generationFinished;

        if (power_user.message_token_count_enabled) {
            const tokenCountText = (reasoning || '') + newMessage.mes;
            newMessage.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
        }

        if (selected_group) {
            console.debug('entering chat update for groups');
            let avatarImg = 'img/ai4.png';
            if (characters[this_chid].avatar != 'none') {
                avatarImg = getThumbnailUrl('avatar', characters[this_chid].avatar);
            }
            newMessage.force_avatar = avatarImg;
            newMessage.original_avatar = characters[this_chid].avatar;
            newMessage.extra.gen_id = group_generation_id;
        }

        await processImageAttachment(newMessage, { imageUrls });
        const chat_id = (chat.length - 1);

        !fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
        addOneMessage(chat[chat_id]);
        !fromStreaming && await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, type);
    }

    const item = chat[chat.length - 1];
    if (item.swipe_info === undefined) {
        item.swipe_info = [];
    }
    if (item.swipe_id !== undefined) {
        const swipeId = item.swipe_id;
        item.swipes[swipeId] = item.mes;
        item.swipe_info[swipeId] = {
            send_date: item.send_date,
            gen_started: item.gen_started,
            gen_finished: item.gen_finished,
            extra: structuredClone(item.extra),
        };
    } else {
        item.swipe_id = 0;
        item.swipes = [];
        item.swipes[0] = item.mes;
        item.swipe_info[0] = {
            send_date: item.send_date,
            gen_started: item.gen_started,
            gen_finished: item.gen_finished,
            extra: structuredClone(item.extra),
        };
    }

    if (Array.isArray(swipes) && swipes.length > 0) {
        const swipeInfoExtra = structuredClone(item.extra ?? {});
        delete swipeInfoExtra.token_count;
        delete swipeInfoExtra.reasoning;
        delete swipeInfoExtra.reasoning_duration;
        /** @type {SwipeInfo} */
        const swipeInfo = {
            send_date: item.send_date,
            extra: swipeInfoExtra,
        };
        if (item.gen_started !== undefined) {
            swipeInfo.gen_started = item.gen_started;
        }
        if (item.gen_finished !== undefined) {
            swipeInfo.gen_finished = item.gen_finished;
        }
        const swipeInfoArray = Array(swipes.length).fill().map(() => structuredClone(swipeInfo));
        parseReasoningInSwipes(swipes, swipeInfoArray, item.extra?.reasoning_duration);
        item.swipes.push(...swipes);
        item.swipe_info.push(...swipeInfoArray);
    }

    statMesProcess(item, type, characters, this_chid, oldMessage);
    return { type, getMessage };
}

/**
 * Creates a message's `swipes`, `swipe_id` and `swipe_info` if necessary.
 * @param {ChatMessage} message
 * @returns {boolean} true if the message was updated.
 */
export function ensureSwipes(message) {
    let updated = false;

    if (!message || typeof message !== 'object') {
        console.trace(`[ensureSwipes] failed. '${message}' is not an object.`);
        return updated;
    }

    //Small system messages and user messages should not have swipes.
    if (message?.is_user || message?.extra?.isSmallSys) {
        return updated;
    }

    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes ?? ''];
        updated = true;
    }

    if (typeof message.swipe_id !== 'number') {
        message.swipe_id = 0;
        updated = true;
    }

    /** @type {() => SwipeInfo} */
    const createSwipeInfo = () => {
        /** @type {SwipeInfo} */
        const swipeInfo = {
            send_date: message.send_date,
            extra: {},
        };
        if (message.gen_started !== undefined) {
            swipeInfo.gen_started = message.gen_started;
        }
        if (message.gen_finished !== undefined) {
            swipeInfo.gen_finished = message.gen_finished;
        }
        return swipeInfo;
    };

    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(_ => createSwipeInfo());
        updated = true;
    }

    for (let i = 0; i < message.swipes.length; i++) {
        if (typeof message.swipes[i] !== 'string') {
            updated = true;
            console.warn('The message had a swipe that is not a string. It has has been set to \'\'.', message);
            message.swipes[i] = '';
        }
        if (!message.swipe_info[i] || typeof message.swipe_info[i] !== 'object') {
            updated = true;
            console.warn('The message had missing or invalid swipe_info for a swipe. It has been backfilled.', message);
            message.swipe_info[i] = createSwipeInfo();
        }
    }

    return updated;
}

/**
 * Syncs the current message and all its data into the swipe data at the given message ID (or the last message if no ID is given).
 *
 * If the swipe data is invalid in some way, this function will exit out without doing anything.
 * @param {number?} [messageId=null] - The ID of the message to sync with the swipe data. If no ID is given, the last message is used.
 * @returns {boolean} Whether the message was successfully synced
 */
export function syncMesToSwipe(messageId = null) {
    if (!chat.length) {
        return false;
    }

    const targetMessageId = messageId ?? chat.length - 1;
    if (targetMessageId >= chat.length || targetMessageId < 0) {
        console.warn(`[syncMesToSwipe] Invalid message ID: ${messageId}`);
        return false;
    }

    const targetMessage = chat[targetMessageId];
    if (!targetMessage) {
        return false;
    }

    // No swipe data there yet, exit out
    if (typeof targetMessage.swipe_id !== 'number') {
        return false;
    }
    // If swipes structure is invalid, exit out (for now?)
    if (!Array.isArray(targetMessage.swipe_info) || !Array.isArray(targetMessage.swipes)) {
        return false;
    }
    // If the swipe is not present yet, exit out (will likely be copied later)
    // "" is falsy. An empty string is a valid message.
    if (typeof targetMessage.swipes[targetMessage.swipe_id] !== 'string' || !targetMessage.swipe_info[targetMessage.swipe_id]) {
        return false;
    }

    const targetSwipeInfo = targetMessage.swipe_info[targetMessage.swipe_id];
    if (typeof targetSwipeInfo !== 'object') {
        return false;
    }

    // Only sync swipes if the chat is not pristine, so that macros in the greeting can resolve again on swipe
    if (chat_metadata.tainted || chat.length > 1) {
        targetMessage.swipes[targetMessage.swipe_id] = targetMessage.mes;
    }

    targetSwipeInfo.send_date = targetMessage.send_date;
    if (targetMessage.gen_started !== undefined) {
        targetSwipeInfo.gen_started = targetMessage.gen_started;
    } else {
        delete targetSwipeInfo.gen_started;
    }
    if (targetMessage.gen_finished !== undefined) {
        targetSwipeInfo.gen_finished = targetMessage.gen_finished;
    } else {
        delete targetSwipeInfo.gen_finished;
    }
    targetSwipeInfo.extra = structuredClone(targetMessage.extra);

    return true;
}

/**
 * Syncs swipe data back to the message data at the given message ID (or the last message if no ID is given).
 * If the swipe ID is not provided, the current swipe ID in the message object is used.
 *
 * If the swipe data is invalid in some way, this function will exit out without doing anything.
 * @param {number?} [messageId=null] - The ID of the message to sync with the swipe data. If no ID is given, the last message is used.
 * @param {number?} [swipeId=null] - The ID of the swipe to sync. If no ID is given, the current swipe ID in the message object is used.
 * @param {ChatMessage?} [targetMessage=null] - The message object to sync instead of resolving one from `chat`.
 * @returns {boolean} Whether the swipe data was successfully synced to the message
 */
export function syncSwipeToMes(messageId = null, swipeId = null, targetMessage = null) {
    if (!targetMessage && !chat.length) {
        return false;
    }

    if (!targetMessage) {
        const targetMessageId = messageId ?? chat.length - 1;
        if (targetMessageId >= chat.length || targetMessageId < 0) {
            console.warn(`[syncSwipeToMes] Invalid message ID: ${messageId}`);
            return false;
        }

        targetMessage = chat[targetMessageId];
    }

    if (!targetMessage) {
        return false;
    }

    if (swipeId !== null) {
        if (isNaN(swipeId) || swipeId < 0) {
            console.warn(`[syncSwipeToMes] Invalid swipe ID: ${swipeId}`);
            return false;
        }
        targetMessage.swipe_id = swipeId;
    }

    // No swipe data there yet, exit out
    if (typeof targetMessage.swipe_id !== 'number') {
        return false;
    }
    // If swipes structure is invalid, exit out
    if (!Array.isArray(targetMessage.swipes)) {
        return false;
    }

    // Backfill swipe_info if missing.
    if (!Array.isArray(targetMessage.swipe_info)) {
        targetMessage.swipe_info = targetMessage.swipes.map(_ => ({
            send_date: targetMessage.send_date,
            extra: {},
        }));
    }

    const targetSwipeId = targetMessage.swipe_id;
    if (typeof targetMessage.swipes[targetSwipeId] !== 'string') {
        console.warn(`[syncSwipeToMes] Invalid swipe ID: ${targetSwipeId}`);
        return false;
    }

    const targetSwipeInfo = targetMessage?.swipe_info?.[targetSwipeId];
    if (typeof targetSwipeInfo !== 'object') {
        console.warn(`[syncSwipeToMes] Invalid swipe info: ${targetSwipeId}`);
    }

    targetMessage.mes = targetMessage.swipes[targetSwipeId];
    targetMessage.send_date = targetSwipeInfo?.send_date;
    targetMessage.gen_started = targetSwipeInfo?.gen_started;
    targetMessage.gen_finished = targetSwipeInfo?.gen_finished;
    targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {};

    return true;
}

/**
 * Saves the image to the message object.
 * @param {ParsedImage} img Image object
 * @param {ChatMessage} mes Chat message object
 * @typedef {{ image?: string, title?: string, inline?: boolean }} ParsedImage
 */
function saveImageToMessage(img, mes) {
    if (mes && img.image) {
        if (!mes.extra || typeof mes.extra !== 'object') {
            mes.extra = {};
        }
        if (!Array.isArray(mes.extra.media)) {
            mes.extra.media = [];
        }
        mes.extra.media.push({ url: img.image, type: MEDIA_TYPE.IMAGE, title: img.title, source: MEDIA_SOURCE.API });
        mes.extra.inline_image = img.inline;
    }
}

export function getGeneratingApi() {
    switch (main_api) {
        case 'openai':
            return oai_settings.chat_completion_source || 'openai';
        case 'textgenerationwebui':
            return textgen_settings.type === textgen_types.OOBA ? 'textgenerationwebui' : textgen_settings.type;
        default:
            return main_api;
    }
}

export function getGeneratingModel(mes) {
    let model = '';
    switch (main_api) {
        case 'kobold':
            model = online_status;
            break;
        case 'novel':
            model = nai_settings.model_novel;
            break;
        case 'openai':
            model = getChatCompletionModel();
            break;
        case 'textgenerationwebui':
            model = online_status;
            break;
        case 'koboldhorde':
            model = kobold_horde_model;
            break;
    }
    return model;
}

/**
 * A function mainly used to switch 'generating' state - setting it to false and activating the buttons again
 */
export function activateSendButtons() {
    is_send_press = false;
    hideStopButton();
    showSwipeButtons();
    delete document.body.dataset.generating;
}

/**
 * A function mainly used to switch 'generating' state - setting it to true and deactivating the buttons
 */
export function deactivateSendButtons() {
    showStopButton();
    hideSwipeButtons();
    document.body.dataset.generating = 'true';
}

export function resetChatState() {
    // replaces deleted charcter name with system user since it will be displayed next.
    name2 = (this_chid === undefined && neutralCharacterName) ? neutralCharacterName : systemUserName;
    //unsets expected chid before reloading (related to getCharacters/printCharacters from using old arrays)
    setCharacterId(undefined);
    // sets up system user to tell user about having deleted a character
    chat.splice(0, chat.length, ...SAFETY_CHAT);
    // resets chat metadata
    chat_metadata = {};
    // resets the characters array, forcing getcharacters to reset
    characters.length = 0;
}

/**
 *
 * @param {'characters' | 'character_edit' | 'create' | 'group_edit' | 'group_create'} value
 */
export function setMenuType(value) {
    menu_type = value;
    // Allow custom CSS to see which menu type is active
    document.getElementById('right-nav-panel').dataset.menuType = menu_type;
}

export function setExternalAbortController(controller) {
    abortController = controller;
}

/**
 * Sets a character array index.
 * @param {number|string|undefined} value
 */
export function setCharacterId(value) {
    switch (typeof value) {
        case 'bigint':
        case 'number':
            this_chid = String(value);
            break;
        case 'string':
            this_chid = !isNaN(parseInt(value)) ? value : undefined;
            break;
        case 'object':
            this_chid = characters.indexOf(value) !== -1 ? String(characters.indexOf(value)) : undefined;
            break;
        case 'undefined':
            this_chid = undefined;
            break;
        default:
            console.error('Invalid character ID type:', value);
            break;
    }
}

export function setCharacterName(value) {
    name2 = value;
}

/**
 * Sets the API connection status of the application
 * @param {string|'no_connection'} value Connection status value
 */
export function setOnlineStatus(value) {
    const previousStatus = online_status;
    online_status = value;
    displayOnlineStatus();
    if (previousStatus !== online_status) {
        eventSource.emitAndWait(event_types.ONLINE_STATUS_CHANGED, online_status);
    }
}

export function setEditedMessageId(value) {
    this_edit_mes_id = value;
}

export function setSendButtonState(value) {
    is_send_press = value;
}

/**
 * Renames the currently selected character, updating relevant references and optionally renaming past chats.
 *
 * If no name is provided, a popup prompts for a new name. If the new name matches the current name,
 * the renaming process is aborted. The function sends a request to the server to rename the character
 * and handles updates to other related fields such as tags, lore, and author notes.
 *
 * If the renaming is successful, the character list is reloaded and the renamed character is selected.
 * Optionally, past chats can be renamed to reflect the new character name.
 *
 * @param {string?} [name=null] - The new name for the character. If not provided, a popup will prompt for it.
 * @param {object} [options] - Additional options.
 * @param {boolean} [options.silent=false] - If true, suppresses popups and warnings.
 * @param {boolean?} [options.renameChats=null] - If true, renames past chats to reflect the new character name.
 * @returns {Promise<boolean>} - Returns true if the character was successfully renamed, false otherwise.
 */

export async function renameCharacter(name = null, { silent = false, renameChats = null } = {}) {
    if (!name && silent) {
        toastr.warning(t`No character name provided.`, t`Rename Character`);
        return false;
    }
    if (this_chid === undefined) {
        toastr.warning(t`No character selected.`, t`Rename Character`);
        return false;
    }

    const oldAvatar = characters[this_chid].avatar;
    const currentCharacterName = getCharacterName(characters[this_chid]);
    const newValue = name || await callGenericPopup('<h3>' + t`New name:` + '</h3>', POPUP_TYPE.INPUT, currentCharacterName);

    if (!newValue) {
        toastr.warning(t`No character name provided.`, t`Rename Character`);
        return false;
    }
    if (newValue === currentCharacterName) {
        toastr.info(t`Same character name provided, so name did not change.`, t`Rename Character`);
        return false;
    }

    const body = JSON.stringify({ avatar_url: oldAvatar, new_name: newValue });
    const response = await fetch('/api/characters/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body,
    });

    try {
        if (response.ok) {
            const data = await response.json();
            const newAvatar = data.avatar;

            const oldName = getCharaFilename(null, { manualAvatarKey: oldAvatar });
            const newName = getCharaFilename(null, { manualAvatarKey: newAvatar });

            // Replace other auxiliary fields where was referenced by avatar key
            // Tag List
            renameTagKey(oldAvatar, newAvatar);

            // Additional lore books
            const charLore = world_info.charLore?.find(x => x.name == oldName);
            if (charLore) {
                charLore.name = newName;
                saveSettingsDebounced();
            }

            // Char-bound Author's Notes
            const charNote = extension_settings.note.chara?.find(x => x.name == oldName);
            if (charNote) {
                charNote.name = newName;
                saveSettingsDebounced();
            }

            // Update active character, if the current one was the currently active one
            if (active_character === oldAvatar) {
                active_character = newAvatar;
                saveSettingsDebounced();
            }

            await eventSource.emit(event_types.CHARACTER_RENAMED, oldAvatar, newAvatar);

            // Unload current character
            setCharacterId(undefined);
            // Reload characters list
            await getCharacters();

            // Find newly renamed character
            const newChId = characters.findIndex(c => c.avatar == data.avatar);

            if (newChId !== -1) {
                // Select the character after the renaming
                await selectCharacterById(newChId);

                // Async delay to update UI
                await delay(1);

                if (this_chid === undefined) {
                    throw new Error('New character not selected');
                }

                // Also rename as a group member
                await renameGroupMember(oldAvatar, newAvatar, newValue.toString());
                const renamePastChatsConfirm = renameChats !== null
                    ? renameChats
                    : silent
                        ? false
                        : await Popup.show.confirm(
                            t`Character renamed!`,
                            `<p>${t`Past chats will still contain the old character name. Would you like to update the character name in previous chats as well?`}</p>
                            <i><b>${t`Sprites folder (if any) should be renamed manually.`}</b></i>`,
                        ) == POPUP_RESULT.AFFIRMATIVE;

                if (renamePastChatsConfirm) {
                    await renamePastChats(oldAvatar, newAvatar, newValue);
                    await reloadCurrentChat();
                    toastr.success(t`Character renamed and past chats updated!`, t`Rename Character`);
                } else {
                    toastr.success(t`Character renamed!`, t`Rename Character`);
                }
            } else {
                throw new Error('Newly renamed character was lost?');
            }
        } else {
            throw new Error('Could not rename the character');
        }
    } catch (error) {
        // Reloading to prevent data corruption
        if (!silent) await Popup.show.text(t`Rename Character`, t`Something went wrong. The page will be reloaded.`);
        else toastr.error(t`Something went wrong. The page will be reloaded.`, t`Rename Character`);

        console.log('Renaming character error:', error);
        location.reload();
        return false;
    }

    return true;
}

async function renamePastChats(oldAvatar, newAvatar, newName) {
    const pastChats = await getPastCharacterChats();

    for (const { file_name } of pastChats) {
        try {
            const fileNameWithoutExtension = file_name.replace('.jsonl', '');
            const getChatResponse = await fetch('/api/chats/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: newName,
                    file_name: fileNameWithoutExtension,
                    avatar_url: newAvatar,
                }),
                cache: 'no-cache',
            });

            if (!getChatResponse.ok) {
                continue;
            }

            const currentChat = await getChatResponse.json();
            if (!Array.isArray(currentChat) || currentChat.length === 0) {
                continue;
            }

            const previousMessages = currentChat.slice(1).map(message => cloneJsonValue(message));
            for (let lineIndex = 1; lineIndex < currentChat.length; lineIndex++) {
                const message = currentChat[lineIndex];
                if (message?.is_user || message?.is_system || message?.extra?.type == system_message_types.NARRATOR) {
                    continue;
                }
                if (message?.name === undefined) {
                    continue;
                }

                const nextMessage = { ...message, name: newName };
                currentChat[lineIndex] = nextMessage;
            }

            const operations = buildChatMessagePatchOperations(previousMessages, currentChat.slice(1));

            if (operations.length === 0) {
                continue;
            }

            await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, currentChat, oldAvatar, newAvatar);

            const patchResponse = await fetch('/api/chats/patch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: newName,
                    file_name: fileNameWithoutExtension,
                    avatar_url: newAvatar,
                    operations,
                    chat_metadata: currentChat?.[0]?.chat_metadata || {},
                    integrity: currentChat?.[0]?.chat_metadata?.integrity,
                }),
                cache: 'no-cache',
            });

            if (!patchResponse.ok) {
                throw new Error('Could not patch chat');
            }
        } catch (error) {
            toastr.error(t`Past chat could not be updated: ${file_name}`);
            console.error(error);
        }
    }
}

export function saveChatDebounced() {
    const chid = this_chid;
    const selectedGroup = selected_group;

    cancelDebouncedChatSave();

    chatSaveTimeout = setTimeout(async () => {
        if (selectedGroup !== selected_group) {
            console.warn('Chat save timeout triggered, but group changed. Aborting.');
            return;
        }

        if (chid !== this_chid) {
            console.warn('Chat save timeout triggered, but chid changed. Aborting.');
            return;
        }

        console.debug('Chat save timeout triggered');
        await saveChatConditional();
        console.debug('Chat saved');
    }, DEFAULT_SAVE_EDIT_TIMEOUT);
}

/**
 * Builds chat-state target payload for state/get|patch|delete endpoints.
 * @param {object|null} [target] Explicit target override.
 * @returns {object|null} Request target payload or null when no active chat target is available.
 */
export function resolveChatStateTarget(target = null) {
    if (target && typeof target === 'object') {
        if (target.is_group) {
            const id = String(target.id || '').trim();
            return id ? { is_group: true, id } : null;
        }
        const avatar_url = String(target.avatar_url || '').trim();
        const file_name = String(target.file_name || '').trim();
        const char_name = String(target.char_name || '').trim();
        return avatar_url && file_name
            ? { is_group: false, avatar_url, file_name, ...(char_name ? { char_name } : {}) }
            : null;
    }

    if (selected_group) {
        const group = groups.find(x => x.id == selected_group);
        const groupChatId = String(group?.chat_id || '').trim();
        return groupChatId ? { is_group: true, id: groupChatId } : null;
    }

    const avatar_url = String(characters[this_chid]?.avatar || '').trim();
    const file_name = String(characters[this_chid]?.chat || '').trim();
    const char_name = String(getCharacterName(characters[this_chid]) || '').trim();
    return avatar_url && file_name
        ? { is_group: false, avatar_url, file_name, ...(char_name ? { char_name } : {}) }
        : null;
}

const chatStateRequestCache = new Map();
const presetStateRequestCache = new Map();
let settingsGetCacheGeneration = 0;

function normalizePresetStateApiId(apiId = '') {
    const normalized = String(apiId || (main_api === 'koboldhorde' ? 'kobold' : main_api) || '').trim();
    if (!normalized) {
        return '';
    }
    return normalized === 'koboldhorde' ? 'kobold' : normalized;
}

function resolvePresetStateTarget(target = null) {
    if (target && typeof target === 'object') {
        const apiId = normalizePresetStateApiId(target.collection || target.apiId || target.type || '');
        const requestedName = String(target.name || '').trim();
        if (!apiId || !requestedName) {
            return null;
        }
        const manager = getPresetManager(apiId);
        const resolvedName = typeof manager?.resolvePresetName === 'function'
            ? manager.resolvePresetName(requestedName)
            : (findCanonicalNameInList(manager?.getAllPresets?.() || [], requestedName) || requestedName);
        return resolvedName
            ? { apiId, name: resolvedName }
            : { apiId, name: requestedName };
    }

    const apiId = normalizePresetStateApiId();
    const manager = getPresetManager(apiId);
    const name = String(manager?.getSelectedPresetName?.() || '').trim();
    return apiId && name ? { apiId, name } : null;
}

function getPresetStateTargetKey(target) {
    if (!target || typeof target !== 'object') {
        return '';
    }
    const apiId = normalizePresetStateApiId(target.collection || target.apiId || target.type || '');
    const name = String(target.name || '').trim();
    return apiId && name
        ? `preset:${apiId}:${name.toLowerCase()}`
        : '';
}

function getPresetStateRequestKey(target, namespace) {
    return `${getPresetStateTargetKey(target)}::${String(namespace || '').trim().toLowerCase()}`;
}

function invalidatePresetStateRequestCache(target, namespaces = []) {
    const targetKey = getPresetStateTargetKey(target);
    if (!targetKey) {
        return;
    }

    const normalizedNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces])
        .map((namespace) => String(namespace || '').trim().toLowerCase())
        .filter(Boolean))];
    for (const namespace of normalizedNamespaces) {
        presetStateRequestCache.delete(getPresetStateRequestKey(target, namespace));
    }
}

function invalidateAllPresetStateRequestCache(target) {
    const targetKey = getPresetStateTargetKey(target);
    if (!targetKey) {
        return;
    }

    for (const cacheKey of [...presetStateRequestCache.keys()]) {
        if (cacheKey.startsWith(`${targetKey}::`)) {
            presetStateRequestCache.delete(cacheKey);
        }
    }
}

function getChatStateTargetKey(target) {
    if (!target || typeof target !== 'object') {
        return '';
    }

    if (target.is_group) {
        return `group:${String(target.id || '').trim()}`;
    }

    return `chat:${String(target.avatar_url || '').trim()}:${String(target.file_name || '').trim()}`;
}

function getChatStateRequestKey(target, namespace) {
    return `${getChatStateTargetKey(target)}::${String(namespace || '').trim().toLowerCase()}`;
}

function invalidateChatStateRequestCache(target, namespaces = []) {
    const targetKey = getChatStateTargetKey(target);
    if (!targetKey) {
        return;
    }

    const normalizedNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces])
        .map((namespace) => String(namespace || '').trim().toLowerCase())
        .filter(Boolean))];
    for (const namespace of normalizedNamespaces) {
        chatStateRequestCache.delete(getChatStateRequestKey(target, namespace));
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall back to JSON-safe cloning for values that cannot be structured-cloned
            // (e.g. functions attached by extensions).
        }
    }
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_, nextValue) => {
        if (typeof nextValue === 'function' || typeof nextValue === 'symbol') {
            return undefined;
        }
        if (typeof nextValue === 'bigint') {
            return String(nextValue);
        }
        if (nextValue && typeof nextValue === 'object') {
            if (seen.has(nextValue)) {
                return undefined;
            }
            seen.add(nextValue);
        }
        return nextValue;
    });
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function normalizeJsonObject(value) {
    const normalized = cloneJsonValue(value);
    return isPlainObject(normalized) ? normalized : {};
}

function getChatMetadataSnapshotKey(target = resolveChatStateTarget()) {
    if (!target || typeof target !== 'object') {
        return '';
    }
    if (target.is_group) {
        return `group:${String(target.id || '').trim()}`;
    }
    const avatar = String(target.avatar_url || '').trim();
    const file = String(target.file_name || '').trim();
    if (!avatar || !file) {
        return '';
    }
    return `char:${avatar}:${file}`;
}

function getChatMessageSnapshotKey(target = resolveChatStateTarget()) {
    return getChatMetadataSnapshotKey(target);
}

let objectPatchWorker = null;
let objectPatchWorkerSequence = 0;
const objectPatchWorkerPending = new Map();

export function buildObjectPatchOperations(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const next = isPlainObject(nextState) ? nextState : null;
    if (!next) {
        return [];
    }
    const previous = isPlainObject(previousState) ? previousState : {};
    const operations = compareJsonPatch(previous, next);
    if (operations.length > maxOperations) {
        return [{ op: 'replace', path: '', value: cloneJsonValue(next) }];
    }
    return attachObjectPatchTests(previous, operations);
}

function cleanupObjectPatchWorker(error = null) {
    if (objectPatchWorker) {
        objectPatchWorker.terminate();
        objectPatchWorker = null;
    }

    if (objectPatchWorkerPending.size === 0) {
        return;
    }

    for (const [, request] of objectPatchWorkerPending) {
        clearTimeout(request.timeoutId);
        if (error) {
            request.reject(error);
        } else {
            request.reject(new Error('Object patch worker terminated'));
        }
    }
    objectPatchWorkerPending.clear();
}

function ensureObjectPatchWorker() {
    if (typeof Worker === 'undefined') {
        return null;
    }

    if (objectPatchWorker) {
        return objectPatchWorker;
    }

    try {
        objectPatchWorker = new Worker(new URL('./scripts/workers/object-patch-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
        console.warn('Failed to initialize object patch worker', error);
        objectPatchWorker = null;
        return null;
    }

    objectPatchWorker.addEventListener('message', (event) => {
        const id = Number(event?.data?.id);
        if (!Number.isInteger(id)) {
            return;
        }

        const pending = objectPatchWorkerPending.get(id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeoutId);
        objectPatchWorkerPending.delete(id);

        if (event.data?.ok) {
            pending.resolve(event.data.operations || []);
        } else {
            pending.reject(new Error(String(event.data?.error || 'Object patch worker failed')));
        }
    });

    objectPatchWorker.addEventListener('error', (event) => {
        console.warn('Object patch worker crashed', event?.error || event);
        cleanupObjectPatchWorker(event?.error || new Error('Object patch worker crashed'));
    });

    return objectPatchWorker;
}

async function buildObjectPatchOperationsWithWorker(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 15000;

    const worker = ensureObjectPatchWorker();
    if (!worker) {
        return buildObjectPatchOperations(previousState, nextState, { maxOperations });
    }

    return await new Promise((resolve, reject) => {
        const id = ++objectPatchWorkerSequence;
        const timeoutId = setTimeout(() => {
            objectPatchWorkerPending.delete(id);
            reject(new Error('Object patch worker timeout'));
        }, timeoutMs);

        objectPatchWorkerPending.set(id, { resolve, reject, timeoutId });

        try {
            worker.postMessage({ id, previousState, nextState, maxOperations });
        } catch (error) {
            clearTimeout(timeoutId);
            objectPatchWorkerPending.delete(id);
            reject(error);
        }
    });
}

export async function buildObjectPatchOperationsAsync(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const next = isPlainObject(nextState) ? nextState : null;
    if (!next) {
        return [];
    }

    const previous = isPlainObject(previousState) ? previousState : {};

    try {
        return await buildObjectPatchOperationsWithWorker(previous, next, options);
    } catch (error) {
        console.warn('Falling back to synchronous object patch diff', error);
        return buildObjectPatchOperations(previous, next, { maxOperations });
    }
}

function decodeJsonPointerSegment(segment) {

    return String(segment || '').replace(/~1/g, '/').replace(/~0/g, '~');
}

function getJsonPointerValue(root, path) {
    if (path === '') {
        return { found: true, value: root };
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
        return { found: false, value: undefined };
    }
    const segments = path.slice(1).split('/').map(decodeJsonPointerSegment);
    let cursor = root;
    for (const segment of segments) {
        if (Array.isArray(cursor)) {
            if (segment === '-') {
                return { found: false, value: undefined };
            }
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
                return { found: false, value: undefined };
            }
            cursor = cursor[index];
            continue;
        }
        if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
            return { found: false, value: undefined };
        }
        cursor = cursor[segment];
    }
    return { found: true, value: cursor };
}

function attachObjectPatchTests(previousState, operations) {
    const sourceOperations = Array.isArray(operations)
        ? operations.filter(op => op && typeof op === 'object')
        : [];
    if (sourceOperations.length === 0) {
        return sourceOperations;
    }

    let workingState = cloneJsonValue(previousState);
    let lastTestedPath = null;
    /** @type {object[]} */
    const guardedOperations = [];

    for (const operation of sourceOperations) {
        const opName = String(operation.op || '').trim().toLowerCase();
        const path = typeof operation.path === 'string' ? operation.path : null;
        if (opName === 'test') {
            guardedOperations.push(operation);
            if (typeof path === 'string') {
                lastTestedPath = path;
            }
            continue;
        }

        const shouldAddTest = (opName === 'replace' || opName === 'remove')
            && typeof path === 'string'
            && path !== lastTestedPath;
        if (shouldAddTest) {
            const resolved = getJsonPointerValue(workingState, path);
            if (resolved.found) {
                guardedOperations.push({
                    op: 'test',
                    path,
                    value: cloneJsonValue(resolved.value),
                });
                lastTestedPath = path;
            }
        }

        guardedOperations.push(operation);

        try {
            const patchResult = applyJsonPatch(workingState, [operation], true, false);
            workingState = patchResult?.newDocument;
        } catch {
            // Keep operation list intact even if local simulation fails.
        }

        if (opName === 'add' || opName === 'remove') {
            lastTestedPath = null;
        }
    }

    return guardedOperations;
}

function extractTopMessageIndexFromPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
        return null;
    }
    const firstSegment = decodeJsonPointerSegment(path.slice(1).split('/')[0] || '');
    if (!firstSegment || firstSegment === '-') {
        return null;
    }
    const index = Number(firstSegment);
    return Number.isInteger(index) && index >= 0 ? index : null;
}

function attachChatMessagePatchTests(previousMessages, operations) {
    const baseMessages = Array.isArray(previousMessages) ? cloneJsonValue(previousMessages) : null;
    const sourceOperations = Array.isArray(operations)
        ? operations.filter(op => op && typeof op === 'object')
        : [];
    if (!Array.isArray(baseMessages) || sourceOperations.length === 0) {
        return sourceOperations;
    }

    let workingMessages = baseMessages;
    let lastTestedIndex = null;
    /** @type {object[]} */
    const guardedOperations = [];

    for (const operation of sourceOperations) {
        const opName = String(operation.op || '').trim().toLowerCase();
        if (opName === 'test') {
            guardedOperations.push(operation);
            const testedIndex = extractTopMessageIndexFromPath(operation.path);
            if (Number.isInteger(testedIndex)) {
                lastTestedIndex = testedIndex;
            }
            continue;
        }

        const index = extractTopMessageIndexFromPath(operation.path);
        const shouldAddTest = (opName === 'replace' || opName === 'remove')
            && Number.isInteger(index)
            && index >= 0
            && index < workingMessages.length
            && index !== lastTestedIndex;

        if (shouldAddTest) {
            guardedOperations.push({
                op: 'test',
                path: `/${index}`,
                value: cloneJsonValue(workingMessages[index]),
            });
            lastTestedIndex = index;
        }

        guardedOperations.push(operation);

        try {
            const patchResult = applyJsonPatch(workingMessages, [operation], true, false);
            if (Array.isArray(patchResult?.newDocument)) {
                workingMessages = patchResult.newDocument;
            }
        } catch {
            // Keep operation list intact even if local simulation fails.
        }

        if (opName === 'add' || opName === 'remove') {
            lastTestedIndex = null;
        }
    }

    return guardedOperations;
}

export function buildChatMessagePatchOperations(previousMessages, nextMessages) {
    const previous = Array.isArray(previousMessages) ? previousMessages : [];
    const next = Array.isArray(nextMessages) ? nextMessages : [];
    const operations = compareJsonPatch(previous, next);
    return attachChatMessagePatchTests(previous, operations);
}

function normalizeChatMetadataForPatch(metadata) {
    // `integrity` is a concurrency token, not business metadata.
    // Excluding it avoids stale-snapshot JSON-Patch test failures on /integrity.
    const source = isPlainObject(metadata) ? cloneJsonValue(metadata) : {};
    delete source.integrity;
    return source;
}

export function buildChatMetadataPatchOperations(previousMetadata, nextMetadata) {
    return buildObjectPatchOperations(
        normalizeChatMetadataForPatch(previousMetadata),
        normalizeChatMetadataForPatch(nextMetadata),
        { maxOperations: 2000 },
    );
}

export async function buildChatMetadataPatchOperationsAsync(previousMetadata, nextMetadata) {
    return await buildObjectPatchOperationsAsync(
        normalizeChatMetadataForPatch(previousMetadata),
        normalizeChatMetadataForPatch(nextMetadata),
        { maxOperations: 2000 },
    );
}

function rememberChatMetadataSnapshot(target = resolveChatStateTarget(), metadata = chat_metadata) {
    const key = getChatMetadataSnapshotKey(target);
    if (!key) {
        return;
    }
    chatMetadataSnapshotCache.set(key, cloneJsonValue(isPlainObject(metadata) ? metadata : {}));
}

export function seedChatMetadataSnapshot(target = null, metadata = chat_metadata) {
    const resolvedTarget = resolveChatStateTarget(target);
    rememberChatMetadataSnapshot(resolvedTarget, metadata);
}

export function getChatMetadataSnapshot(target = null) {
    const resolvedTarget = resolveChatStateTarget(target);
    const key = getChatMetadataSnapshotKey(resolvedTarget);
    if (!key) {
        return null;
    }
    const snapshot = chatMetadataSnapshotCache.get(key);
    return isPlainObject(snapshot) ? cloneJsonValue(snapshot) : null;
}

function rememberChatMessageSnapshot(target = resolveChatStateTarget(), messages = chat) {
    const key = getChatMessageSnapshotKey(target);
    if (!key) {
        return;
    }
    if (!Array.isArray(messages)) {
        chatMessageSnapshotCache.delete(key);
        return;
    }
    chatMessageSnapshotCache.set(key, cloneJsonValue(messages));
}

export function seedChatMessageSnapshot(target = null, messages = chat) {
    const resolvedTarget = resolveChatStateTarget(target);
    rememberChatMessageSnapshot(resolvedTarget, messages);
}

export function getChatMessageSnapshot(target = null) {
    const resolvedTarget = resolveChatStateTarget(target);
    const key = getChatMessageSnapshotKey(resolvedTarget);
    if (!key) {
        return null;
    }
    const snapshot = chatMessageSnapshotCache.get(key);
    return Array.isArray(snapshot) ? cloneJsonValue(snapshot) : null;
}

let chatWriteQueue = Promise.resolve();
let activeChatSaveContext = null;

export function runSerializedChatWrite(task) {
    if (typeof task !== 'function') {
        return Promise.resolve(undefined);
    }

    const run = chatWriteQueue
        .catch(() => undefined)
        .then(() => task());

    chatWriteQueue = run.catch(() => undefined);
    return run;
}

function syncCurrentChatIntegrityFromMetadata(metadata = null) {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return;
    }

    const nextIntegrity = typeof metadata?.integrity === 'string'
        ? metadata.integrity.trim()
        : '';

    if (nextIntegrity) {
        chat_metadata.integrity = nextIntegrity;
    } else {
        delete chat_metadata.integrity;
    }
}

function isActiveChatStateTarget(target = null) {
    return getChatStateTargetKey(resolveChatStateTarget(target)) === getChatStateTargetKey(resolveChatStateTarget());
}

export function applyIntegrityFromWritePayloadToTarget(payload, target = null, metadata = null) {
    const nextIntegrity = typeof payload?.integrity === 'string' ? payload.integrity.trim() : '';
    if (!nextIntegrity) {
        return;
    }

    if (metadata && typeof metadata === 'object') {
        metadata.integrity = nextIntegrity;
    }

    if (isActiveChatStateTarget(target)) {
        syncCurrentChatIntegrityFromMetadata({ integrity: nextIntegrity });
    }
}

async function fetchCurrentServerChatSnapshot(target = resolveChatStateTarget()) {
    const resolvedTarget = resolveChatStateTarget(target);
    if (!resolvedTarget) {
        return null;
    }

    try {
        let response;

        if (resolvedTarget.is_group) {
            response = await fetch('/api/chats/group/get', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: resolvedTarget.id,
                }),
            });
        } else {
            const charName = String(resolvedTarget.char_name || getCharacterName(characters[this_chid]) || '').trim();
            if (!charName) {
                return null;
            }

            response = await fetch('/api/chats/get', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: charName,
                    file_name: resolvedTarget.file_name,
                    avatar_url: resolvedTarget.avatar_url,
                }),
            });
        }

        if (!response.ok) {
            return null;
        }

        const payload = await response.json().catch(() => null);
        if (!Array.isArray(payload) || payload.length === 0) {
            return {
                target: resolvedTarget,
                metadata: {},
                messages: [],
            };
        }

        const [header, ...rawMessages] = payload;
        const metadata = isPlainObject(header?.chat_metadata)
            ? cloneJsonValue(header.chat_metadata)
            : {};
        const messages = rawMessages
            .map(message => cloneJsonValue(message))
            .filter(message => message && typeof message === 'object');

        messages.forEach(ensureMessageMediaIsArray);

        return {
            target: resolvedTarget,
            metadata,
            messages,
        };
    } catch (error) {
        console.warn('Failed to fetch current server chat snapshot', error);
        return null;
    }
}

export async function refreshChatWriteSnapshotsFromServer(target = resolveChatStateTarget()) {
    const snapshot = await fetchCurrentServerChatSnapshot(target);
    if (!snapshot) {
        return null;
    }

    rememberChatMetadataSnapshot(snapshot.target, snapshot.metadata);
    rememberChatMessageSnapshot(snapshot.target, snapshot.messages);

    if (getChatStateTargetKey(snapshot.target) === getChatStateTargetKey(resolveChatStateTarget())) {
        syncCurrentChatIntegrityFromMetadata(snapshot.metadata);
    }

    return snapshot;
}

async function rebuildChatMessagePatchOperationsFromServer(desiredMessages = chat, target = resolveChatStateTarget()) {
    const snapshot = await refreshChatWriteSnapshotsFromServer(target);
    if (!snapshot) {
        return null;
    }

    const nextMessages = Array.isArray(desiredMessages)
        ? cloneJsonValue(desiredMessages)
        : [];

    return {
        ...snapshot,
        operations: buildChatMessagePatchOperations(snapshot.messages, nextMessages),
    };
}

/**
 * Builds lightweight mutation metadata for a chat message index.
 * @param {number} messageId Message index in current chat array.
 * @param {object[]} [messages=chat] Source messages.
 * @returns {{messageId:number, playableSeq:number|null, assistantSeq:number|null, isUser:boolean, isAssistant:boolean, isSystem:boolean}|null}
 */
export function getChatMessageMutationMeta(messageId, messages = chat) {
    const source = Array.isArray(messages) ? messages : [];
    const resolvedId = Math.floor(Number(messageId));
    if (!Number.isInteger(resolvedId) || resolvedId < 0 || resolvedId >= source.length) {
        return null;
    }

    const message = source[resolvedId];
    if (!message) {
        return null;
    }

    const playableSeq = !message.is_system
        ? source.slice(0, resolvedId + 1).reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0)
        : null;
    const assistantSeq = !message.is_system && !message.is_user
        ? source.slice(0, resolvedId + 1).reduce((count, item) => count + (item && !item.is_system && !item.is_user ? 1 : 0), 0)
        : null;

    return {
        messageId: resolvedId,
        playableSeq,
        assistantSeq,
        isUser: Boolean(message.is_user),
        isAssistant: Boolean(!message.is_system && !message.is_user),
        isSystem: Boolean(message.is_system),
    };
}

/**
 * Gets chat-bound plugin state payload from server side.
 * @param {string[]} namespaces Chat state namespaces.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit chat target.
 * @returns {Promise<Map<string, object|null>>} Stored state payloads keyed by namespace.
 */
export async function getChatStateBatch(namespaces, options = {}) {
    try {
        const requestedNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [])
            .map((namespace) => String(namespace || '').trim().toLowerCase())
            .filter(Boolean))];
        if (!requestedNamespaces.length) {
            return new Map();
        }

        const target = resolveChatStateTarget(options?.target || null);
        if (!target) {
            return new Map();
        }

        const results = new Map();
        const awaitedRequests = [];
        const pendingNamespaces = [];

        for (const namespace of requestedNamespaces) {
            const requestKey = getChatStateRequestKey(target, namespace);
            if (chatStateRequestCache.has(requestKey)) {
                awaitedRequests.push(chatStateRequestCache.get(requestKey).then((data) => {
                    results.set(namespace, cloneJsonValue(data));
                }));
                continue;
            }

            pendingNamespaces.push(namespace);
        }

        if (pendingNamespaces.length) {
            const batchPromise = (async () => {
                const response = await fetch('/api/chats/state/get-batch', {
                    method: 'POST',
                    cache: 'no-cache',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        ...target,
                        namespaces: pendingNamespaces,
                    }),
                });

                if (!response.ok) {
                    return new Map(pendingNamespaces.map((namespace) => [namespace, null]));
                }

                const payload = await response.json();
                const batchResults = new Map();
                for (const namespace of pendingNamespaces) {
                    const data = payload?.data?.[namespace];
                    batchResults.set(namespace, data && typeof data === 'object' ? data : null);
                }
                return batchResults;
            })();

            for (const namespace of pendingNamespaces) {
                const requestKey = getChatStateRequestKey(target, namespace);
                chatStateRequestCache.set(requestKey, batchPromise.then((batchResults) => batchResults.get(namespace) ?? null));
            }

            try {
                const batchResults = await batchPromise;
                for (const namespace of pendingNamespaces) {
                    results.set(namespace, cloneJsonValue(batchResults.get(namespace) ?? null));
                }
            } finally {
                for (const namespace of pendingNamespaces) {
                    chatStateRequestCache.delete(getChatStateRequestKey(target, namespace));
                }
            }
        }

        if (awaitedRequests.length) {
            await Promise.all(awaitedRequests);
        }

        return results;
    } catch (error) {
        console.warn('Incremental chat state batch get failed', error);
        return new Map();
    }
}

/**
 * Gets chat-bound plugin state payload from server side.
 * @param {string} namespace Chat state namespace.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit chat target.
 * @returns {Promise<object|null>} Stored state object or null when not found/failed.
 */
export async function getChatState(namespace, options = {}) {
    const stateNamespace = String(namespace || '').trim().toLowerCase();
    if (!stateNamespace) {
        return null;
    }

    const results = await getChatStateBatch([stateNamespace], options);
    return results.get(stateNamespace) ?? null;
}

/**
 * Applies incremental patch operations to chat-bound plugin state payload.
 * @param {string} namespace Chat state namespace.
 * @param {object[]} operations Patch operations.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit chat target.
 * @returns {Promise<boolean>} True when patch request succeeded.
 */
export async function patchChatState(namespace, operations, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace || !Array.isArray(operations) || operations.length === 0) {
            return false;
        }
        const target = resolveChatStateTarget(options?.target || null);
        if (!target) {
            return false;
        }
        invalidateChatStateRequestCache(target, [stateNamespace]);
        const sourceOperations = operations.filter(op => op && typeof op === 'object');
        // Rebuild optimistic tests from the freshest state to avoid stale test collisions.
        const baseOperations = sourceOperations.filter(op => String(op.op || '').trim().toLowerCase() !== 'test');
        if (baseOperations.length === 0) {
            return true;
        }

        const patchOnce = async (baseState) => {
            const guardedOperations = attachObjectPatchTests(baseState || {}, baseOperations);
            return fetch('/api/chats/state/patch', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ...target,
                    namespace: stateNamespace,
                    operations: guardedOperations,
                }),
            });
        };

        let currentState = await getChatState(stateNamespace, { target });
        let response = await patchOnce(currentState);

        if (response.status === 409) {
            currentState = await getChatState(stateNamespace, { target });
            response = await patchOnce(currentState);
        }

        if (response.ok) {
            invalidateChatStateRequestCache(target, [stateNamespace]);
        }

        return response.ok;
    } catch (error) {
        console.warn('Incremental chat state patch failed', error);
        return false;
    }
}

/**
 * Updates chat-bound plugin state by applying a reducer against the latest server state.
 * @param {string} namespace Chat state namespace.
 * @param {(currentState: object, meta?: { attempt: number, target: object, namespace: string }) => (object|null|undefined|Promise<object|null|undefined>)} updater
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit chat target.
 * @param {number} [options.maxOperations] Max patch ops before fallback replace patch is used.
 * @param {number} [options.maxRetries] Number of retry rounds when patch update fails.
 * @returns {Promise<{ ok: boolean, state: object|null, updated: boolean }>} Update result.
 */
export async function updateChatState(namespace, updater, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace || typeof updater !== 'function') {
            return { ok: false, state: null, updated: false };
        }

        const target = resolveChatStateTarget(options?.target || null);
        if (!target) {
            return { ok: false, state: null, updated: false };
        }
        invalidateChatStateRequestCache(target, [stateNamespace]);

        const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
            ? Number(options.maxOperations)
            : 2000;
        const maxRetries = Number.isInteger(options?.maxRetries) && options.maxRetries >= 0
            ? Number(options.maxRetries)
            : 1;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const currentStateRaw = await getChatState(stateNamespace, { target });
            const currentState = normalizeJsonObject(currentStateRaw);
            const nextStateRaw = await updater(cloneJsonValue(currentState), {
                attempt,
                target: cloneJsonValue(target),
                namespace: stateNamespace,
            });

            if (nextStateRaw === undefined || nextStateRaw === null) {
                return {
                    ok: true,
                    state: currentState,
                    updated: false,
                };
            }

            const nextState = normalizeJsonObject(nextStateRaw);
            const operations = options?.asyncDiff === false
                ? buildObjectPatchOperations(currentState, nextState, { maxOperations })
                : await buildObjectPatchOperationsAsync(currentState, nextState, { maxOperations });
            if (operations.length === 0) {
                return {
                    ok: true,
                    state: nextState,
                    updated: false,
                };
            }

            const ok = await patchChatState(stateNamespace, operations, { target });
            if (ok) {
                invalidateChatStateRequestCache(target, [stateNamespace]);
                return {
                    ok: true,
                    state: nextState,
                    updated: true,
                };
            }
        }

        return { ok: false, state: null, updated: false };
    } catch (error) {
        console.warn('Incremental chat state update failed', error);
        return { ok: false, state: null, updated: false };
    }
}

/**
 * Deletes chat-bound plugin state payload for namespace.
 * @param {string} namespace Chat state namespace.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit chat target.
 * @returns {Promise<boolean>} True when delete request succeeded.
 */
export async function deleteChatState(namespace, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace) {
            return false;
        }
        const target = resolveChatStateTarget(options?.target || null);
        if (!target) {
            return false;
        }
        invalidateChatStateRequestCache(target, [stateNamespace]);

        const response = await fetch('/api/chats/state/delete', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...target,
                namespace: stateNamespace,
            }),
        });

        if (response.ok) {
            invalidateChatStateRequestCache(target, [stateNamespace]);
        }

        return response.ok;
    } catch (error) {
        console.warn('Incremental chat state delete failed', error);
        return false;
    }
}

/**
 * Gets preset-bound plugin state payloads from server side.
 * @param {string[]} namespaces Preset state namespaces.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit preset target.
 * @returns {Promise<Map<string, object|null>>} Stored state payloads keyed by namespace.
 */
export async function getPresetStateBatch(namespaces, options = {}) {
    try {
        const requestedNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [])
            .map((namespace) => String(namespace || '').trim().toLowerCase())
            .filter(Boolean))];
        if (!requestedNamespaces.length) {
            return new Map();
        }

        const target = resolvePresetStateTarget(options?.target || null);
        if (!target) {
            return new Map();
        }

        const results = new Map();
        const awaitedRequests = [];
        const pendingNamespaces = [];

        for (const namespace of requestedNamespaces) {
            const requestKey = getPresetStateRequestKey(target, namespace);
            if (presetStateRequestCache.has(requestKey)) {
                awaitedRequests.push(presetStateRequestCache.get(requestKey).then((data) => {
                    results.set(namespace, cloneJsonValue(data));
                }));
                continue;
            }

            pendingNamespaces.push(namespace);
        }

        if (pendingNamespaces.length) {
            const batchPromise = (async () => {
                const response = await fetch('/api/presets/state/get-batch', {
                    method: 'POST',
                    cache: 'no-cache',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        apiId: target.apiId,
                        name: target.name,
                        namespaces: pendingNamespaces,
                    }),
                });

                if (!response.ok) {
                    return new Map(pendingNamespaces.map((namespace) => [namespace, null]));
                }

                const payload = await response.json();
                const batchResults = new Map();
                for (const namespace of pendingNamespaces) {
                    const data = payload?.data?.[namespace];
                    batchResults.set(namespace, data && typeof data === 'object' ? data : null);
                }
                return batchResults;
            })();

            for (const namespace of pendingNamespaces) {
                const requestKey = getPresetStateRequestKey(target, namespace);
                presetStateRequestCache.set(requestKey, batchPromise.then((batchResults) => batchResults.get(namespace) ?? null));
            }

            try {
                const batchResults = await batchPromise;
                for (const namespace of pendingNamespaces) {
                    results.set(namespace, cloneJsonValue(batchResults.get(namespace) ?? null));
                }
            } finally {
                for (const namespace of pendingNamespaces) {
                    presetStateRequestCache.delete(getPresetStateRequestKey(target, namespace));
                }
            }
        }

        if (awaitedRequests.length) {
            await Promise.all(awaitedRequests);
        }

        return results;
    } catch (error) {
        console.warn('Incremental preset state batch get failed', error);
        return new Map();
    }
}

/**
 * Gets preset-bound plugin state payload from server side.
 * @param {string} namespace Preset state namespace.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit preset target.
 * @returns {Promise<object|null>} Stored state object or null when not found/failed.
 */
export async function getPresetState(namespace, options = {}) {
    const stateNamespace = String(namespace || '').trim().toLowerCase();
    if (!stateNamespace) {
        return null;
    }

    const results = await getPresetStateBatch([stateNamespace], options);
    return results.get(stateNamespace) ?? null;
}

/**
 * Applies incremental patch operations to preset-bound plugin state payload.
 * @param {string} namespace Preset state namespace.
 * @param {object[]} operations Patch operations.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit preset target.
 * @returns {Promise<boolean>} True when patch request succeeded.
 */
export async function patchPresetState(namespace, operations, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace || !Array.isArray(operations) || operations.length === 0) {
            return false;
        }
        const target = resolvePresetStateTarget(options?.target || null);
        if (!target) {
            return false;
        }
        invalidatePresetStateRequestCache(target, [stateNamespace]);
        const sourceOperations = operations.filter(op => op && typeof op === 'object');
        const baseOperations = sourceOperations.filter(op => String(op.op || '').trim().toLowerCase() !== 'test');
        if (baseOperations.length === 0) {
            return true;
        }

        const patchOnce = async (baseState) => {
            const guardedOperations = attachObjectPatchTests(baseState || {}, baseOperations);
            return fetch('/api/presets/state/patch', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    apiId: target.apiId,
                    name: target.name,
                    namespace: stateNamespace,
                    operations: guardedOperations,
                }),
            });
        };

        let currentState = await getPresetState(stateNamespace, { target });
        let response = await patchOnce(currentState);

        if (response.status === 409) {
            currentState = await getPresetState(stateNamespace, { target });
            response = await patchOnce(currentState);
        }

        if (response.ok) {
            invalidatePresetStateRequestCache(target, [stateNamespace]);
        }

        return response.ok;
    } catch (error) {
        console.warn('Incremental preset state patch failed', error);
        return false;
    }
}

/**
 * Updates preset-bound plugin state by applying a reducer against the latest server state.
 * @param {string} namespace Preset state namespace.
 * @param {(currentState: object, meta?: { attempt: number, target: object, namespace: string }) => (object|null|undefined|Promise<object|null|undefined>)} updater
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit preset target.
 * @param {number} [options.maxOperations] Max patch ops before fallback replace patch is used.
 * @param {number} [options.maxRetries] Number of retry rounds when patch update fails.
 * @returns {Promise<{ ok: boolean, state: object|null, updated: boolean }>} Update result.
 */
export async function updatePresetState(namespace, updater, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace || typeof updater !== 'function') {
            return { ok: false, state: null, updated: false };
        }

        const target = resolvePresetStateTarget(options?.target || null);
        if (!target) {
            return { ok: false, state: null, updated: false };
        }
        invalidatePresetStateRequestCache(target, [stateNamespace]);

        const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
            ? Number(options.maxOperations)
            : 2000;
        const maxRetries = Number.isInteger(options?.maxRetries) && options.maxRetries >= 0
            ? Number(options.maxRetries)
            : 1;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const currentStateRaw = await getPresetState(stateNamespace, { target });
            const currentState = normalizeJsonObject(currentStateRaw);
            const nextStateRaw = await updater(cloneJsonValue(currentState), {
                attempt,
                target: cloneJsonValue(target),
                namespace: stateNamespace,
            });

            if (nextStateRaw === undefined || nextStateRaw === null) {
                return {
                    ok: true,
                    state: currentState,
                    updated: false,
                };
            }

            const nextState = normalizeJsonObject(nextStateRaw);
            const operations = options?.asyncDiff === false
                ? buildObjectPatchOperations(currentState, nextState, { maxOperations })
                : await buildObjectPatchOperationsAsync(currentState, nextState, { maxOperations });
            if (operations.length === 0) {
                return {
                    ok: true,
                    state: nextState,
                    updated: false,
                };
            }

            const ok = await patchPresetState(stateNamespace, operations, { target });
            if (ok) {
                invalidatePresetStateRequestCache(target, [stateNamespace]);
                return {
                    ok: true,
                    state: nextState,
                    updated: true,
                };
            }
        }

        return { ok: false, state: null, updated: false };
    } catch (error) {
        console.warn('Incremental preset state update failed', error);
        return { ok: false, state: null, updated: false };
    }
}

/**
 * Deletes preset-bound plugin state payload for namespace.
 * @param {string} namespace Preset state namespace.
 * @param {object} [options] Additional options.
 * @param {object|null} [options.target] Optional explicit preset target.
 * @returns {Promise<boolean>} True when delete request succeeded.
 */
export async function deletePresetState(namespace, options = {}) {
    try {
        const stateNamespace = String(namespace || '').trim();
        if (!stateNamespace) {
            return false;
        }
        const target = resolvePresetStateTarget(options?.target || null);
        if (!target) {
            return false;
        }
        invalidatePresetStateRequestCache(target, [stateNamespace]);

        const response = await fetch('/api/presets/state/delete', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiId: target.apiId,
                name: target.name,
                namespace: stateNamespace,
            }),
        });

        if (response.ok) {
            invalidatePresetStateRequestCache(target, [stateNamespace]);
        }

        return response.ok;
    } catch (error) {
        console.warn('Incremental preset state delete failed', error);
        return false;
    }
}

/**
 * Deletes all preset-bound plugin state payloads for a preset target.
 * @param {object|null} target Explicit preset target.
 * @returns {Promise<boolean>} True when delete request succeeded.
 */
export async function deleteAllPresetState(target = null) {
    try {
        const resolvedTarget = resolvePresetStateTarget(target);
        if (!resolvedTarget) {
            return false;
        }
        invalidateAllPresetStateRequestCache(resolvedTarget);

        const response = await fetch('/api/presets/state/delete-all', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiId: resolvedTarget.apiId,
                name: resolvedTarget.name,
            }),
        });

        if (response.ok) {
            invalidateAllPresetStateRequestCache(resolvedTarget);
        }

        return response.ok;
    } catch (error) {
        console.warn('Preset state delete-all failed', error);
        return false;
    }
}

/**
 * Renames all preset-bound plugin state payloads from one preset target to another.
 * @param {object|null} sourceTarget Source preset target.
 * @param {object|null} targetTarget Target preset target.
 * @returns {Promise<boolean>} True when rename request succeeded.
 */
export async function renamePresetStateTarget(sourceTarget = null, targetTarget = null) {
    try {
        const source = resolvePresetStateTarget(sourceTarget);
        const target = resolvePresetStateTarget(targetTarget);
        if (!source || !target || source.apiId !== target.apiId) {
            return false;
        }
        invalidateAllPresetStateRequestCache(source);
        invalidateAllPresetStateRequestCache(target);

        const response = await fetch('/api/presets/state/rename', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiId: source.apiId,
                oldName: source.name,
                newName: target.name,
            }),
        });

        if (response.ok) {
            invalidateAllPresetStateRequestCache(source);
            invalidateAllPresetStateRequestCache(target);
        }

        return response.ok;
    } catch (error) {
        console.warn('Preset state rename failed', error);
        return false;
    }
}

function applyIntegrityFromWritePayload(payload) {
    applyIntegrityFromWritePayloadToTarget(payload, resolveChatStateTarget(), chat_metadata);
}

function invalidateChatWriteSnapshot(target = resolveChatStateTarget()) {
    const snapshotKey = getChatMessageSnapshotKey(target);
    if (!snapshotKey) {
        return;
    }

    chatMessageSnapshotCache.delete(snapshotKey);
    chatMetadataSnapshotCache.delete(snapshotKey);
}

function invalidateCurrentChatWriteSnapshot() {
    invalidateChatWriteSnapshot(resolveChatStateTarget());
    if (chat_metadata && typeof chat_metadata === 'object') {
        delete chat_metadata.integrity;
    }
}

async function readChatWriteConflictPayload(response) {
    if (!response || typeof response.clone !== 'function') {
        return null;
    }

    try {
        return await response.clone().json();
    } catch {
        return null;
    }
}

async function resolveChatWriteConflict(response, retryCount = 0) {
    return await resolveChatWriteConflictForTarget(response, resolveChatStateTarget(), chat_metadata, retryCount);
}

export async function resolveChatWriteConflictForTarget(response, target = null, metadata = null, retryCount = 0) {
    if (!response || response.status !== 409 || retryCount > 0) {
        return 'none';
    }

    const payload = await readChatWriteConflictPayload(response);
    const errorType = String(payload?.error || '').trim().toLowerCase();
    const currentIntegrity = typeof payload?.current_integrity === 'string'
        ? payload.current_integrity.trim()
        : '';

    if (errorType === 'integrity') {
        if (metadata && typeof metadata === 'object') {
            if (currentIntegrity) {
                metadata.integrity = currentIntegrity;
            } else {
                delete metadata.integrity;
            }
        }
        if (isActiveChatStateTarget(target)) {
            syncCurrentChatIntegrityFromMetadata(metadata);
        }
        return 'integrity';
    }

    // Keep local in-memory edits/generation state intact. Reloading chat here can
    // overwrite current local mutations (e.g. regenerate/edit-in-progress) and
    // make behavior look like random refresh or duplicate replies.
    invalidateChatWriteSnapshot(target);
    if (isActiveChatStateTarget(target) && chat_metadata && typeof chat_metadata === 'object') {
        delete chat_metadata.integrity;
    }
    return 'snapshot';
}

async function shouldRetryChatWriteOnConflict(response, retryCount = 0) {
    return (await resolveChatWriteConflict(response, retryCount)) !== 'none';
}

/**
 * Appends new chat messages to server-side chat storage.
 * Falls back to legacy full-save callers when this returns false.
 * @param {ChatMessage[]} messages Messages to append.
 * @returns {Promise<boolean>} True on successful append.
 */
async function appendChatMessagesInternal(messages, retryCount = 0) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return true;
    }

    try {
        const target = resolveChatStateTarget();
        const generationIds = summarizeLukerGenerationIdsForMessages(messages);

        if (selected_group) {
            const group = groups.find(x => x.id == selected_group);
            const groupChatId = group?.chat_id;
            if (!groupChatId) {
                return false;
            }

            const response = await fetch('/api/chats/group/append', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: groupChatId,
                    messages: messages,
                    chat_metadata: { ...chat_metadata },
                    integrity: chat_metadata?.integrity,
                }),
            });

            if (response.ok) {
                const payload = await response.json().catch(() => null);
                console.debug('[ChatWrite]', {
                    phase: 'append_result',
                    target: { kind: 'group', id: String(groupChatId) },
                    generation_ids: generationIds,
                    appended: Number(payload?.appended || 0),
                    skipped: Number(payload?.skipped || 0),
                    matched_existing_generation_id: Boolean(payload?.matched_existing_generation_id),
                });
                if (payload?.matched_existing_generation_id && Number(payload?.appended || 0) === 0) {
                    const refreshed = await refreshChatWriteSnapshotsFromServer(target);
                    return Boolean(refreshed && lodash.isEqual(refreshed.messages, chat));
                }
                applyIntegrityFromWritePayload(payload);
                rememberChatMessageSnapshot({ is_group: true, id: groupChatId }, chat);
                return true;
            }
            const conflictResolution = await resolveChatWriteConflict(response, retryCount);
            if (conflictResolution !== 'none') {
                if (conflictResolution === 'integrity') {
                    await refreshChatWriteSnapshotsFromServer(target);
                }
                return await appendChatMessagesInternal(messages, retryCount + 1);
            }
            return false;
        }

        const fileName = characters[this_chid]?.chat;
        const avatar = characters[this_chid]?.avatar;
        const charName = getCharacterName(characters[this_chid]);

        if (!fileName || !avatar || !charName) {
            return false;
        }

        const response = await fetch('/api/chats/append', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: charName,
                file_name: fileName,
                messages: messages,
                avatar_url: avatar,
                chat_metadata: { ...chat_metadata },
                integrity: chat_metadata?.integrity,
            }),
        });

        if (response.ok) {
            const payload = await response.json().catch(() => null);
            console.debug('[ChatWrite]', {
                phase: 'append_result',
                target: { kind: 'character', avatar_url: String(avatar), file_name: String(fileName) },
                generation_ids: generationIds,
                appended: Number(payload?.appended || 0),
                skipped: Number(payload?.skipped || 0),
                matched_existing_generation_id: Boolean(payload?.matched_existing_generation_id),
            });
            if (payload?.matched_existing_generation_id && Number(payload?.appended || 0) === 0) {
                const refreshed = await refreshChatWriteSnapshotsFromServer(target);
                return Boolean(refreshed && lodash.isEqual(refreshed.messages, chat));
            }
            applyIntegrityFromWritePayload(payload);
            rememberChatMessageSnapshot({ is_group: false, avatar_url: avatar, file_name: fileName }, chat);
            return true;
        }
        const conflictResolution = await resolveChatWriteConflict(response, retryCount);
        if (conflictResolution !== 'none') {
            if (conflictResolution === 'integrity') {
                await refreshChatWriteSnapshotsFromServer(target);
            }
            return await appendChatMessagesInternal(messages, retryCount + 1);
        }
        return false;
    } catch (error) {
        console.warn('Incremental chat append failed', error);
        return false;
    }
}

export async function appendChatMessages(messages, retryCount = 0) {
    const queuedMessages = cloneJsonValue(messages) ?? messages;
    return await runSerializedChatWrite(() => appendChatMessagesInternal(queuedMessages, retryCount));
}

/**
 * Applies incremental patch operations to chat messages on server-side chat storage.
 * Falls back to legacy full-save callers when this returns false.
 * @param {object[]|object} operations Patch operations (single op or op array).
 * @returns {Promise<boolean>} True on successful patch.
 */
async function patchChatMessagesInternal(operations, retryCount = 0) {
    const normalizedOperations = Array.isArray(operations)
        ? operations
        : (operations && typeof operations === 'object' ? [operations] : []);

    if (normalizedOperations.length === 0) {
        return true;
    }

    try {
        const target = resolveChatStateTarget();
        const previousMessages = target ? chatMessageSnapshotCache.get(getChatMessageSnapshotKey(target)) : null;
        const guardedOperations = attachChatMessagePatchTests(previousMessages, normalizedOperations);

        if (selected_group) {
            const group = groups.find(x => x.id == selected_group);
            const groupChatId = group?.chat_id;
            if (!groupChatId) {
                return false;
            }

            const response = await fetch('/api/chats/group/patch', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: groupChatId,
                    operations: guardedOperations,
                    chat_metadata: { ...chat_metadata },
                    integrity: chat_metadata?.integrity,
                }),
            });

            if (response.ok) {
                const payload = await response.json().catch(() => null);
                applyIntegrityFromWritePayload(payload);
                rememberChatMessageSnapshot({ is_group: true, id: groupChatId }, chat);
                return true;
            }
            const conflictResolution = await resolveChatWriteConflict(response, retryCount);
            if (conflictResolution === 'integrity') {
                const rebuilt = await rebuildChatMessagePatchOperationsFromServer(chat, target);
                if (!rebuilt) {
                    return false;
                }
                if (rebuilt.operations.length === 0) {
                    rememberChatMessageSnapshot(target, chat);
                    return true;
                }
                return await patchChatMessagesInternal(rebuilt.operations, retryCount + 1);
            }
            if (conflictResolution === 'snapshot') {
                return false;
            }
            return false;
        }

        const fileName = characters[this_chid]?.chat;
        const avatar = characters[this_chid]?.avatar;
        const charName = getCharacterName(characters[this_chid]);

        if (!fileName || !avatar || !charName) {
            return false;
        }

        const response = await fetch('/api/chats/patch', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: charName,
                file_name: fileName,
                operations: guardedOperations,
                avatar_url: avatar,
                chat_metadata: { ...chat_metadata },
                integrity: chat_metadata?.integrity,
            }),
        });

        if (response.ok) {
            const payload = await response.json().catch(() => null);
            applyIntegrityFromWritePayload(payload);
            rememberChatMessageSnapshot({ is_group: false, avatar_url: avatar, file_name: fileName }, chat);
            return true;
        }
        const conflictResolution = await resolveChatWriteConflict(response, retryCount);
        if (conflictResolution === 'integrity') {
            const rebuilt = await rebuildChatMessagePatchOperationsFromServer(chat, target);
            if (!rebuilt) {
                return false;
            }
            if (rebuilt.operations.length === 0) {
                rememberChatMessageSnapshot(target, chat);
                return true;
            }
            return await patchChatMessagesInternal(rebuilt.operations, retryCount + 1);
        }
        if (conflictResolution === 'snapshot') {
            return false;
        }
        return false;
    } catch (error) {
        console.warn('Incremental chat patch failed', error);
        return false;
    }
}

export async function patchChatMessages(operations, retryCount = 0) {
    const queuedOperations = cloneJsonValue(operations) ?? operations;
    return await runSerializedChatWrite(() => patchChatMessagesInternal(queuedOperations, retryCount));
}

function buildActiveChatSaveContext({ withMetadata = undefined, chatName = undefined, mesId = undefined } = {}) {
    const activeTarget = resolveChatStateTarget();
    if (!activeTarget) {
        return null;
    }

    const metadataPatch = (withMetadata && typeof withMetadata === 'object')
        ? (cloneJsonValue(withMetadata) ?? withMetadata)
        : {};
    const baseMetadata = isPlainObject(chat_metadata)
        ? (cloneJsonValue(chat_metadata) ?? chat_metadata)
        : {};
    const metadataSnapshot = {
        ...baseMetadata,
        ...metadataPatch,
    };
    const requestedChatId = String(chatName || '').trim();
    const chatIdSnapshot = requestedChatId || String(getCurrentChatId() || '').trim() || null;
    const endIndex = Number.isInteger(mesId) && Number(mesId) >= 0 && Number(mesId) < chat.length
        ? Number(mesId) + 1
        : chat.length;
    const messagesSnapshot = cloneJsonValue(chat.slice(0, endIndex)) ?? chat.slice(0, endIndex);
    const itemizedPromptsSnapshot = Array.isArray(itemizedPrompts)
        ? (cloneJsonValue(itemizedPrompts) ?? itemizedPrompts)
        : [];

    if (activeTarget.is_group) {
        const groupId = String(selected_group || '').trim();
        const group = groups.find(x => String(x?.id || '') === groupId);
        if (!groupId || !group?.chat_id) {
            return null;
        }

        return {
            kind: 'group',
            target: activeTarget,
            groupId,
            chatIdSnapshot,
            metadataSnapshot,
            messagesSnapshot,
            itemizedPromptsSnapshot,
        };
    }

    const characterId = this_chid;
    const avatarUrl = String(activeTarget.avatar_url || '').trim();
    const fileName = requestedChatId || String(activeTarget.file_name || '').trim();
    const charName = String(activeTarget.char_name || getCharacterName(characters[characterId]) || '').trim();
    if (characterId === undefined || !avatarUrl || !fileName || !charName) {
        return null;
    }

    return {
        kind: 'character',
        target: { is_group: false, avatar_url: avatarUrl, file_name: fileName, char_name: charName },
        characterId,
        avatarUrl,
        fileName,
        charName,
        chatIdSnapshot,
        metadataSnapshot,
        messagesSnapshot,
        itemizedPromptsSnapshot,
    };
}

function finishActiveChatSaveContext(saveContext) {
    if (!saveContext) {
        return;
    }

    saveTokenCache();
    saveItemizedPrompts(saveContext.chatIdSnapshot, saveContext.itemizedPromptsSnapshot);
}

export function shouldBlockChatSwitchWhileSaving() {
    return Boolean(isChatSaving && !activeChatSaveContext);
}

export async function waitForChatSwitchAvailability({ requireCompletedSave = false } = {}) {
    const predicate = requireCompletedSave
        ? () => !isChatSaving
        : () => !shouldBlockChatSwitchWhileSaving();

    try {
        await waitUntilCondition(predicate, debounce_timeout.extended, 10);
        return true;
    } catch {
        console.warn(requireCompletedSave
            ? 'Timeout waiting for chat save to finish before changing chats'
            : 'Timeout waiting for chat to reach a safe switch state');
        toastr.info(
            requireCompletedSave
                ? t`Please wait until the current chat is fully saved before deleting or replacing it.`
                : t`Please wait until the chat is saved before changing or closing chats.`,
            t`Your chat is still saving...`,
        );
        return false;
    }
}

/**
 * Updates only chat metadata on server-side chat storage.
 * Falls back to legacy full-save callers when this returns false.
 * @param {object} [withMetadata] Optional metadata patch to merge before save.
 * @returns {Promise<boolean>} True on successful metadata save.
 */
async function saveChatMetadataInternal(withMetadata = undefined, retryCount = 0, context = null) {
    try {
        const saveContext = context ?? buildActiveChatSaveContext({ withMetadata });
        if (!saveContext?.target) {
            return false;
        }
        const metadata = isPlainObject(saveContext.metadataSnapshot)
            ? saveContext.metadataSnapshot
            : {};
        const target = saveContext.target;

        const snapshotKey = getChatMetadataSnapshotKey(target);
        const previousMetadata = snapshotKey ? chatMetadataSnapshotCache.get(snapshotKey) : null;
        const operations = await buildChatMetadataPatchOperationsAsync(previousMetadata, metadata);

        // Nothing changed.
        if (operations.length === 0) {
            return true;
        }

        // Prefer metadata patch route to avoid re-sending huge metadata payloads.
        if (target.is_group) {
            const response = await fetch('/api/chats/group/meta/patch', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: target.id,
                    operations,
                    integrity: metadata?.integrity,
                }),
            });

            if (response.ok) {
                const payload = await response.json().catch(() => null);
                applyIntegrityFromWritePayloadToTarget(payload, target, metadata);
                rememberChatMetadataSnapshot(target, metadata);
                return true;
            }
            const conflictResolution = await resolveChatWriteConflictForTarget(response, target, metadata, retryCount);
            if (conflictResolution !== 'none') {
                if (conflictResolution === 'integrity' || conflictResolution === 'snapshot') {
                    await refreshChatWriteSnapshotsFromServer(target);
                }
                return await saveChatMetadataInternal(withMetadata, retryCount + 1, {
                    ...(saveContext ?? {}),
                    metadataSnapshot: cloneJsonValue(metadata) ?? metadata,
                });
            }
        } else {
            const charName = String(saveContext.charName || target.char_name || getCharacterName(characters[this_chid]) || '').trim();
            if (!charName) {
                return false;
            }
            const response = await fetch('/api/chats/meta/patch', {
                method: 'POST',
                cache: 'no-cache',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: charName,
                    file_name: target.file_name,
                    avatar_url: target.avatar_url,
                    operations,
                    integrity: metadata?.integrity,
                }),
            });

            if (response.ok) {
                const payload = await response.json().catch(() => null);
                applyIntegrityFromWritePayloadToTarget(payload, target, metadata);
                rememberChatMetadataSnapshot(target, metadata);
                return true;
            }
            const conflictResolution = await resolveChatWriteConflictForTarget(response, target, metadata, retryCount);
            if (conflictResolution !== 'none') {
                if (conflictResolution === 'integrity' || conflictResolution === 'snapshot') {
                    await refreshChatWriteSnapshotsFromServer(target);
                }
                return await saveChatMetadataInternal(withMetadata, retryCount + 1, {
                    ...(saveContext ?? {}),
                    metadataSnapshot: cloneJsonValue(metadata) ?? metadata,
                });
            }
        }

        return false;
    } catch (error) {
        console.warn('Incremental chat metadata save failed', error);
        return false;
    }
}

export async function saveChatMetadata(withMetadata = undefined, retryCount = 0) {
    const metadataPatch = cloneJsonValue(withMetadata) ?? withMetadata;
    return await runSerializedChatWrite(() => saveChatMetadataInternal(metadataPatch, retryCount));
}

/**
 * Saves the chat to the server.
 * @param {object} [options] - Additional options.
 * @param {string} [options.chatName] The name of the chat file to save to
 * @param {object} [options.withMetadata] Additional metadata to save with the chat
 * @param {number} [options.mesId] The message ID to save the chat up to
 * @param {boolean} [options.force] Force the saving despite the integrity check result
 * @param {ChatMessage[]} [options.chatData] Chat snapshot to save instead of the current in-memory chat
 *
 * @returns {Promise<void>}
 */
async function saveChatInternal({ chatName, withMetadata, mesId, force = false, _retryAttempt = 0 } = {}) {
    const saveContext = arguments?.[0]?._context ?? buildActiveChatSaveContext({ withMetadata, chatName, mesId });
    const target = saveContext?.target ?? resolveChatStateTarget();

    if (target?.is_group) {
        toastr.error(t`Operation was aborted to prevent data corruption.`, t`saveChat called for a group chat`);
        throw new Error('saveChat called for a group chat');
    }

    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('saveChat called with positional arguments. Please use an object instead.');
        [chatName, withMetadata, mesId, force] = arguments;
    }

    const metadata = isPlainObject(saveContext?.metadataSnapshot)
        ? saveContext.metadataSnapshot
        : { ...chat_metadata, ...(withMetadata || {}) };
    const fileName = String(saveContext?.fileName ?? chatName ?? characters[this_chid]?.chat ?? '').trim();

    if (!fileName && name2 === neutralCharacterName) {
        // TODO: Do something for a temporary chat with no character.
        return;
    }

    if (!fileName) {
        console.warn('saveChat called without chat_name and no chat file found');
        return;
    }

    const charName = String(saveContext?.charName || target?.char_name || getCharacterName(characters[this_chid]) || '').trim();
    const avatar = String(saveContext?.avatarUrl || target?.avatar_url || characters[this_chid]?.avatar || '').trim();
    if (!charName || !avatar) {
        console.warn('saveChat called without active character identity');
        return;
    }

    if (saveContext?.characterId !== undefined && characters[saveContext.characterId]) {
        characters[saveContext.characterId].date_last_chat = Date.now();
    } else if (characters[this_chid]) {
        characters[this_chid].date_last_chat = Date.now();
    }

    const trimmedChat = Array.isArray(saveContext?.messagesSnapshot)
        ? saveContext.messagesSnapshot
        : ((mesId !== undefined && mesId >= 0 && mesId < chat.length)
            ? chat.slice(0, Number(mesId) + 1)
            : chat.slice());

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };

    try {
        // "Save as branch/checkpoint" writes to a different chat file, so snapshot keys must follow the destination file.
        const writeTarget = target?.is_group
            ? target
            : { is_group: false, avatar_url: avatar, file_name: fileName, char_name: charName };
        const previousMessages = chatMessageSnapshotCache.get(getChatMessageSnapshotKey(writeTarget));

        if (!force && Array.isArray(previousMessages)) {
            const operations = buildChatMessagePatchOperations(previousMessages, trimmedChat);

            if (operations.length > 0) {
                const patchResult = await fetch('/api/chats/patch', {
                    method: 'POST',
                    cache: 'no-cache',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        ch_name: charName,
                        file_name: fileName,
                        operations,
                        avatar_url: avatar,
                        chat_metadata: metadata,
                        integrity: metadata?.integrity,
                        force: force,
                    }),
                });

                if (patchResult.ok) {
                    const payload = await patchResult.json().catch(() => null);
                    applyIntegrityFromWritePayloadToTarget(payload, writeTarget, metadata);
                    rememberChatMessageSnapshot(writeTarget, trimmedChat);
                    rememberChatMetadataSnapshot(writeTarget, metadata);
                    return;
                }

                if (!force) {
                    const conflictResolution = await resolveChatWriteConflictForTarget(patchResult, writeTarget, metadata, _retryAttempt);
                    if (conflictResolution !== 'none') {
                        if (conflictResolution === 'integrity' || conflictResolution === 'snapshot') {
                            await refreshChatWriteSnapshotsFromServer(writeTarget);
                        }
                        await saveChatInternal({ chatName, withMetadata, mesId, force, _retryAttempt: _retryAttempt + 1, _context: { ...(saveContext ?? {}), metadataSnapshot: cloneJsonValue(metadata) ?? metadata, messagesSnapshot: cloneJsonValue(trimmedChat) ?? trimmedChat } });
                        return;
                    }
                }
            } else {
                const metadataSaved = await saveChatMetadataInternal(withMetadata, _retryAttempt, { ...(saveContext ?? {}), metadataSnapshot: cloneJsonValue(metadata) ?? metadata, messagesSnapshot: cloneJsonValue(trimmedChat) ?? trimmedChat });
                if (metadataSaved) {
                    rememberChatMessageSnapshot(writeTarget, trimmedChat);
                    return;
                }
            }
        }

        const result = await fetch('/api/chats/save', {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: charName,
                file_name: fileName,
                chat: [chatHeader, ...trimmedChat],
                avatar_url: avatar,
                force: force,
            }),
        });

        if (result.ok) {
            const payload = await result.json().catch(() => null);
            applyIntegrityFromWritePayloadToTarget(payload, writeTarget, metadata);
            rememberChatMessageSnapshot(writeTarget, trimmedChat);
            rememberChatMetadataSnapshot(writeTarget, metadata);
            return;
        }

        if (!force) {
            const conflictResolution = await resolveChatWriteConflictForTarget(result, writeTarget, metadata, _retryAttempt);
            if (conflictResolution !== 'none') {
                if (conflictResolution === 'integrity' || conflictResolution === 'snapshot') {
                    await refreshChatWriteSnapshotsFromServer(writeTarget);
                }
                await saveChatInternal({ chatName, withMetadata, mesId, force, _retryAttempt: _retryAttempt + 1, _context: { ...(saveContext ?? {}), metadataSnapshot: cloneJsonValue(metadata) ?? metadata, messagesSnapshot: cloneJsonValue(trimmedChat) ?? trimmedChat } });
                return;
            }
        }

        throw new Error(result.statusText);
    } catch (error) {
        console.error(error);
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Chat could not be saved`);
    }
}

export async function saveChat() {
    const args = cloneJsonValue(Array.from(arguments)) ?? Array.from(arguments);
    return await runSerializedChatWrite(() => saveChatInternal(...args));
}

/**
 * Processes the avatar image from the input element, allowing the user to crop it if necessary.
 * @param {HTMLInputElement} input - The input element containing the avatar file.
 * @returns {Promise<void>}
 */
async function read_avatar_load(input) {
    if (input.files && input.files[0]) {
        if (selected_button == 'create') {
            create_save.avatar = input.files;
        }

        crop_data = undefined;
        const file = input.files[0];
        const fileData = await getBase64Async(file);

        if (!power_user.never_resize_avatars) {
            const dlg = new Popup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: fileData });
            const croppedImage = await dlg.show();

            if (!croppedImage) {
                return;
            }

            crop_data = dlg.cropData;
            $('#avatar_load_preview').attr('src', String(croppedImage));
        } else {
            $('#avatar_load_preview').attr('src', fileData);
        }

        if (menu_type == 'create') {
            return;
        }

        await createOrEditCharacter();

        const formData = new FormData(/** @type {HTMLFormElement} */($('#form_create').get(0)));
        const avatarKey = formData.get('avatar_url').toString();

        // Bust cache for the avatar thumbnail and character image
        const thumbnailUrl = getThumbnailUrl('avatar', avatarKey);
        await fetch(thumbnailUrl, { method: 'GET', cache: 'reload' });
        await fetch(`/characters/${avatarKey}`, { method: 'GET', cache: 'reload' });

        // Refresh all visible avatar images that use this thumbnail URL
        // This handles messages, character list, and any other place using the thumbnail
        const avatarImages = document.querySelectorAll(`img[src^="${thumbnailUrl}"]`);
        for (const img of avatarImages) {
            if (img instanceof HTMLImageElement) {
                const originalSrc = img.src;
                img.src = '';
                img.src = originalSrc;
            }
        }
        console.debug(`Refreshed ${avatarImages.length} avatar images for ${avatarKey}`);

        console.log('Avatar refreshed');
    }
}

/**
 * Gets the URL for a thumbnail of a specific type and file.
 * @param {import('../src/endpoints/thumbnails.js').ThumbnailType} type The type of the thumbnail to get
 * @param {string} file The file name or path for which to get the thumbnail URL
 * @param {boolean} [t=false] Whether to add a cache-busting timestamp to the URL
 * @returns {string} The URL for the thumbnail
 */
export function getThumbnailUrl(type, file, t = false) {
    return `/thumbnail?type=${type}&file=${encodeURIComponent(file)}${t ? `&t=${Date.now()}` : ''}`;
}

export function buildAvatarList(block, entities, { templateId = 'inline_avatar_template', empty = true, interactable = false, highlightFavs = true } = {}) {
    if (empty) {
        block.empty();
    }

    for (const entity of entities) {
        const id = entity.id;

        // Populate the template
        const avatarTemplate = $(`#${templateId} .avatar`).clone();

        let this_avatar = default_avatar;
        if (entity.item.avatar !== undefined && entity.item.avatar != 'none') {
            this_avatar = getThumbnailUrl('avatar', entity.item.avatar);
        }

        avatarTemplate.attr('data-type', entity.type);
        avatarTemplate.attr('data-chid', id);
        const itemName = getCharacterName(entity.item);
        avatarTemplate.find('img').attr('src', this_avatar).attr('alt', itemName);
        avatarTemplate.attr('title', `[Character] ${itemName}\nFile: ${entity.item.avatar}`);
        if (highlightFavs) {
            const isFavorite = isCharacterFavorite(entity.item);
            avatarTemplate.toggleClass('is_fav', isFavorite);
            avatarTemplate.find('.ch_fav').val(String(isFavorite));
        }

        // If this is a group, we need to hack slightly. We still want to keep most of the css classes and layout, but use a group avatar instead.
        if (entity.type === 'group') {
            const grpTemplate = getGroupAvatar(entity.item);

            avatarTemplate.addClass(grpTemplate.attr('class'));
            avatarTemplate.empty();
            avatarTemplate.append(grpTemplate.children());
            avatarTemplate.attr({ 'data-grid': id, 'data-chid': null });
            avatarTemplate.attr('title', `[Group] ${entity.item.name}`);
        } else if (entity.type === 'persona') {
            avatarTemplate.attr({ 'data-pid': id, 'data-chid': null });
            avatarTemplate.find('img').attr('src', getThumbnailUrl('persona', entity.item.avatar));
            avatarTemplate.attr('title', `[Persona] ${entity.item.name}\nFile: ${entity.item.avatar}`);
        }

        if (interactable) {
            avatarTemplate.addClass(INTERACTABLE_CONTROL_CLASS);
            avatarTemplate.toggleClass('character_select', entity.type === 'character');
            avatarTemplate.toggleClass('group_select', entity.type === 'group');
        }

        block.append(avatarTemplate);
    }
}

/**
 * Loads all the data of a shallow character.
 * @param {string|undefined} characterId Array index
 * @returns {Promise<void>} Promise that resolves when the character is unshallowed
 */
export async function unshallowCharacter(characterId) {
    if (characterId === undefined) {
        console.debug('Undefined character cannot be unshallowed');
        return;
    }

    /** @type {Character} */
    const character = characters[characterId];
    if (!character) {
        console.debug('Character not found:', characterId);
        return;
    }

    // Character is not shallow
    if (!character.shallow) {
        return;
    }

    const avatar = character.avatar;
    if (!avatar) {
        console.debug('Character has no avatar field:', characterId);
        return;
    }

    await getOneCharacter(avatar);
}

export async function getChat() {
    try {
        await unshallowCharacter(this_chid);

        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                ch_name: getCharacterName(characters[this_chid]),
                file_name: characters[this_chid].chat,
                avatar_url: characters[this_chid].avatar,
            }),
        });

        if (!response.ok) {
            throw new Error('Chat could not be loaded');
        }

        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            /** @type {ChatHeader} */
            const chatHeader = data.shift();
            chat_metadata = chatHeader?.chat_metadata ?? {};
            chat.splice(0, chat.length, ...data);
        } else {
            // An empty/corrupted chat file.
            chat.splice(0, chat.length);
            chat_metadata = {};
        }
        chat.forEach(ensureMessageMediaIsArray);
        chatServerState.nextOlderIndex = 0;
        chatServerState.totalMessages = chat.length;
        chatServerState.hasMore = false;

        if (!chat_metadata['integrity']) {
            chat_metadata['integrity'] = uuidv4();
        }
        rememberChatMetadataSnapshot();
        rememberChatMessageSnapshot();
        await getChatResult();
        eventSource.emit(event_types.CHAT_LOADED, { detail: { id: this_chid, character: characters[this_chid] } });

        // Focus on the textarea if not already focused on a visible text input
        delay(debounce_timeout.short).then(() => {
            if ($(document.activeElement).is('input:visible, textarea:visible')) {
                return;
            }
            $('#send_textarea').trigger('click').trigger('focus');
        });
    } catch (error) {
        await getChatResult();
        console.log(error);
    }
}

async function getChatResult() {
    name2 = getCharacterName(characters[this_chid]);
    let freshChat = false;
    if (chat.length === 0) {
        const message = getFirstMessage();
        if (message.mes) {
            chat.push(message);
            freshChat = true;
        }
        // Make sure the chat appears on the server
        await saveChatConditional();
    }
    chatServerState.totalMessages = Math.max(chatServerState.totalMessages, chat.length);
    if (!chatServerState.hasMore) {
        chatServerState.nextOlderIndex = 0;
    }
    await loadItemizedPrompts(getCurrentChatId());
    await printMessages();
    select_selected_character(this_chid);

    await eventSource.emit(event_types.CHAT_CHANGED, (getCurrentChatId()));
    if (freshChat) await eventSource.emit(event_types.CHAT_CREATED);

    if (chat.length === 1) {
        const chat_id = (chat.length - 1);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, 'first_message');
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat_id, 'first_message');
    }
}

function getFirstMessage() {
    const character = characters[this_chid];
    const firstMes = getCharacterFirstMessage(character);
    const alternateGreetings = getCharacterAlternateGreetings(character);

    const message = {
        name: name2,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: getRegexedString(firstMes, regex_placement.AI_OUTPUT),
        extra: {},
    };

    if (Array.isArray(alternateGreetings) && alternateGreetings.length > 0) {
        const swipes = [message.mes, ...(alternateGreetings.map(greeting => getRegexedString(greeting, regex_placement.AI_OUTPUT)))];

        if (!message.mes) {
            swipes.shift();
            message.mes = swipes[0];
        }

        message.swipe_id = 0;
        message.swipes = swipes;
        message.swipe_info = swipes.map(_ => ({
            send_date: message.send_date,
            extra: {},
        }));
    }

    return message;
}

async function regenerateFirstCharacterMessageIfNeeded({ isNewChat = false } = {}) {
    const message = getFirstMessage();
    const shouldRegenerateMessage =
        !isNewChat &&
        message.mes &&
        !selected_group &&
        !chat_metadata['tainted'] &&
        (chat.length === 0 || (chat.length === 1 && !chat[0].is_user && !chat[0].is_system));

    if (!shouldRegenerateMessage) {
        return false;
    }

    chat.splice(0, chat.length, message);
    const messageId = chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'first_message');
    await clearChat();
    await printMessages();
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
    await saveChatConditional();
    return true;
}

export async function refreshFirstMessageOnEmptyCharacterChat() {
    return await regenerateFirstCharacterMessageIfNeeded();
}

export async function openCharacterChat(file_name) {
    if (!await waitForChatSwitchAvailability()) {
        return;
    }
    await clearChat({ clearData: true });
    characters[this_chid].chat = file_name;
    chat_metadata = {};
    chatServerState.nextOlderIndex = 0;
    chatServerState.totalMessages = 0;
    chatServerState.hasMore = false;
    await getChat();
    $('#selected_chat_pole').val(file_name);
    await updateRemoteChatName(this_chid, file_name);
}

////////// OPTIMZED MAIN API CHANGE FUNCTION ////////////

export function changeMainAPI(api = null) {
    const selectedVal = api ?? $('#main_api').val();
    //console.log(selectedVal);
    const apiElements = {
        'koboldhorde': {
            apiStreaming: $('#NULL_SELECTOR'),
            apiSettings: $('#kobold_api-settings'),
            apiConnector: $('#kobold_horde'),
            apiPresets: $('#kobold_api-presets'),
            apiRanges: $('#range_block'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'kobold': {
            apiStreaming: $('#streaming_kobold_block'),
            apiSettings: $('#kobold_api-settings'),
            apiConnector: $('#kobold_api'),
            apiPresets: $('#kobold_api-presets'),
            apiRanges: $('#range_block'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'textgenerationwebui': {
            apiStreaming: $('#streaming_textgenerationwebui_block'),
            apiSettings: $('#textgenerationwebui_api-settings'),
            apiConnector: $('#textgenerationwebui_api'),
            apiPresets: $('#textgenerationwebui_api-presets'),
            apiRanges: $('#range_block_textgenerationwebui'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'novel': {
            apiStreaming: $('#streaming_novel_block'),
            apiSettings: $('#novel_api-settings'),
            apiConnector: $('#novel_api'),
            apiPresets: $('#novel_api-presets'),
            apiRanges: $('#range_block_novel'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
        'openai': {
            apiStreaming: $('#NULL_SELECTOR'),
            apiSettings: $('#openai_settings'),
            apiConnector: $('#openai_api'),
            apiPresets: $('#openai_api-presets'),
            apiRanges: $('#range_block_openai'),
            maxContextElem: $('#max_context_block'),
            amountGenElem: $('#amount_gen_block'),
        },
    };
    //console.log('--- apiElements--- ');
    //console.log(apiElements);

    //first, disable everything so the old elements stop showing
    for (const apiName in apiElements) {
        const apiObj = apiElements[apiName];
        //do not hide items to then proceed to immediately show them.
        if (selectedVal === apiName) {
            continue;
        }
        apiObj.apiSettings.css('display', 'none');
        apiObj.apiConnector.css('display', 'none');
        apiObj.apiRanges.css('display', 'none');
        apiObj.apiPresets.css('display', 'none');
        apiObj.apiStreaming.css('display', 'none');
    }

    //then, find and enable the active item.
    //This is split out of the loop so that different apis can share settings divs
    let activeItem = apiElements[selectedVal];

    activeItem.apiStreaming.css('display', 'block');
    activeItem.apiSettings.css('display', 'block');
    activeItem.apiConnector.css('display', 'block');
    activeItem.apiRanges.css('display', 'block');
    activeItem.apiPresets.css('display', 'block');

    if (selectedVal === 'openai') {
        activeItem.apiPresets.css('display', 'flex');
    }

    if (selectedVal === 'textgenerationwebui' || selectedVal === 'novel') {
        console.debug('enabling amount_gen for ooba/novel');
        activeItem.amountGenElem.find('input').prop('disabled', false);
        activeItem.amountGenElem.css('opacity', 1.0);
    }

    //custom because streaming has been moved up under response tokens, which exists inside common settings block
    if (selectedVal === 'novel') {
        $('#ai_module_block_novel').css('display', 'block');
    } else {
        $('#ai_module_block_novel').css('display', 'none');
    }

    $('#prompt_cost_block').toggle(selectedVal === 'textgenerationwebui' && textgen_settings.type === textgen_types.OPENROUTER);

    // Hide common settings for OpenAI
    console.debug('value?', selectedVal);
    if (selectedVal == 'openai') {
        console.debug('hiding settings?');
        $('#common-gen-settings-block').css('display', 'none');
    } else {
        $('#common-gen-settings-block').css('display', 'block');
    }

    main_api = selectedVal;
    setOnlineStatus('no_connection');

    if (main_api == 'koboldhorde') {
        getStatusHorde();
        getHordeModels(true);
    }
    validateDisabledSamplers();
    setupChatCompletionPromptManager(oai_settings);
    forceCharacterEditorTokenize();
}

export function setUserName(value, { toastPersonaNameChange = true } = {}) {
    name1 = value;
    if (name1 === undefined || name1 == '')
        name1 = default_user_name;
    console.log(`User name changed to ${name1}`);
    $('#your_name').text(name1);
    if (toastPersonaNameChange && power_user.persona_show_notifications && !isPersonaPanelOpen()) {
        toastr.success(t`Your messages will now be sent as ${name1}`, t`Persona Changed`);
    }
    saveSettingsDebounced();
}

async function doOnboarding(avatarId) {
    const template = $('#onboarding_template .onboarding').clone();
    bindOnboardingImportActions(template);
    let userName = await callGenericPopup(template, POPUP_TYPE.INPUT, currentUser?.name || name1, { wider: true, cancelButton: false });

    if (userName) {
        userName = String(userName).replace('\n', ' ');
        setUserName(userName);
        console.log(`Binding persona ${avatarId} to name ${userName}`);
        power_user.personas[avatarId] = userName;
        power_user.persona_descriptions[avatarId] = {
            description: '',
            position: persona_description_positions.IN_PROMPT,
        };
    }
}

async function uploadOnboardingImport(url, file) {
    const formData = new FormData();
    formData.append('avatar', file);

    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || t`Import failed`);
    }

    return data;
}

function bindOnboardingImportActions(template) {
    const status = template.find('.onboardingMigrationStatus');
    const dataButton = template.find('.onboardingImportDataZipButton');
    const configButton = template.find('.onboardingImportConfigButton');
    const globalExtensionsButton = template.find('.onboardingImportGlobalExtensionsButton');
    const dataInput = template.find('.onboardingImportDataZipInput');
    const configInput = template.find('.onboardingImportConfigInput');
    const globalExtensionsInput = template.find('.onboardingImportGlobalExtensionsInput');
    let serverLevelLocked = false;

    const setStatus = (text = '') => {
        status.text(String(text || ''));
    };

    const setBusy = (busy) => {
        dataButton.toggleClass('disabled', Boolean(busy));
        if (!serverLevelLocked) {
            configButton.toggleClass('disabled', Boolean(busy));
            globalExtensionsButton.toggleClass('disabled', Boolean(busy));
        }
    };

    const runImport = async (label, input, endpoint, successTextFactory) => {
        const file = input[0] instanceof HTMLInputElement ? input[0].files?.[0] : null;
        if (!file) {
            return;
        }

        setBusy(true);
        setStatus(t`Importing ${label}...`);
        try {
            const result = await uploadOnboardingImport(endpoint, file);
            const message = typeof successTextFactory === 'function' ? successTextFactory(result) : t`Import completed`;
            setStatus(message);
            toastr.success(message, t`Import completed`);
        } catch (error) {
            const message = String(error?.message || error || t`Import failed`);
            setStatus(message);
            toastr.error(message, t`Import failed`);
        } finally {
            if (input[0] instanceof HTMLInputElement) {
                input[0].value = '';
            }
            setBusy(false);
        }
    };

    dataButton.on('click', () => {
        if (dataButton.hasClass('disabled')) {
            return;
        }
        dataInput.trigger('click');
    });
    dataInput.on('change', () => runImport(
        t`Data ZIP`,
        dataInput,
        '/api/users/import/data-zip',
        (result) => t`Data ZIP imported: restored ${result?.restoredCount ?? 0}, skipped ${result?.skippedCount ?? 0}, rejected ${result?.rejectedCount ?? 0}.`,
    ));

    const canImportServerLevel = isAdmin();
    if (!canImportServerLevel) {
        serverLevelLocked = true;
        const hint = t`Only administrators can import config.yaml and global extensions.`;
        configButton.addClass('disabled').attr('title', hint);
        globalExtensionsButton.addClass('disabled').attr('title', hint);
        setStatus(hint);
        return;
    }

    configButton.on('click', () => {
        if (configButton.hasClass('disabled')) {
            return;
        }
        configInput.trigger('click');
    });
    configInput.on('change', () => runImport(
        t`config.yaml`,
        configInput,
        '/api/users/import/config',
        () => t`config.yaml imported. Some settings may require backend restart to fully apply.`,
    ));

    globalExtensionsButton.on('click', () => {
        if (globalExtensionsButton.hasClass('disabled')) {
            return;
        }
        globalExtensionsInput.trigger('click');
    });
    globalExtensionsInput.on('change', () => runImport(
        t`Global Extensions ZIP`,
        globalExtensionsInput,
        '/api/users/import/global-extensions',
        (result) => t`Global extensions imported: ${result?.importedCount ?? 0} files.`,
    ));
}

function reloadLoop() {
    const MAX_RELOADS = 5;
    let reloads = Number(sessionStorage.getItem('reloads') || 0);
    if (reloads < MAX_RELOADS) {
        reloads++;
        sessionStorage.setItem('reloads', String(reloads));
        window.location.reload();
    }
}

//MARK: getSettings()
///////////////////////////////////////////
const SETTINGS_GET_ENDPOINT = '/api/settings/get';
let settingsGetRequestInterceptorInstalled = false;
let settingsGetResponseCache = null;
let settingsGetRequestPromise = null;

function buildSettingsGetCachedResponse() {
    if (!settingsGetResponseCache) {
        return null;
    }

    return new Response(settingsGetResponseCache.body, {
        headers: new Headers(settingsGetResponseCache.headers),
        status: settingsGetResponseCache.status,
        statusText: settingsGetResponseCache.statusText,
    });
}

async function cacheSettingsGetResponse(response) {
    const clone = response.clone();
    return {
        body: await clone.text(),
        headers: Array.from(response.headers.entries()),
        status: response.status,
        statusText: response.statusText,
    };
}

function isSettingsGetRequest(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
        return false;
    }

    try {
        const requestUrl = request?.url ?? String(input);
        const url = new URL(requestUrl, window.location.origin);
        return url.origin === window.location.origin && url.pathname === SETTINGS_GET_ENDPOINT;
    } catch {
        return false;
    }
}

function invalidateSettingsGetResponseCache() {
    settingsGetCacheGeneration += 1;
    settingsGetRequestPromise = null;
    settingsGetResponseCache = null;
}

function installSettingsGetRequestInterceptor() {
    if (settingsGetRequestInterceptorInstalled) {
        return;
    }

    const baseFetch = window.fetch.bind(window);
    window.fetch = async function settingsGetRequestInterceptor(input, init) {
        if (!isSettingsGetRequest(input, init)) {
            return await baseFetch(input, init);
        }

        const cachedResponse = buildSettingsGetCachedResponse();
        if (cachedResponse) {
            return cachedResponse;
        }

        if (!settingsGetRequestPromise) {
            const requestGeneration = settingsGetCacheGeneration;
            settingsGetRequestPromise = (async () => {
                const response = await baseFetch(input, init);
                const cached = await cacheSettingsGetResponse(response);
                if (response.ok && requestGeneration === settingsGetCacheGeneration) {
                    settingsGetResponseCache = cached;
                }
                return cached;
            })().finally(() => {
                settingsGetRequestPromise = null;
            });
        }

        const requestCache = await settingsGetRequestPromise;
        return new Response(requestCache.body, {
            headers: new Headers(requestCache.headers),
            status: requestCache.status,
            statusText: requestCache.statusText,
        });
    };
    settingsGetRequestInterceptorInstalled = true;
}

async function fetchSettingsPayload(endpoint, { silent = false } = {}) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });

    if (!response.ok) {
        if (!silent) {
            reloadLoop();
            toastr.error(t`Settings could not be loaded after multiple attempts. Please try again later.`);
        }
        throw new Error(`Error getting settings from ${endpoint}`);
    }

    return response.json();
}

async function fetchBootstrapSnapshot() {
    try {
        const response = await fetch('/api/bootstrap', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`Error getting bootstrap snapshot: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.warn('Initial bootstrap snapshot unavailable', error);
        return null;
    }
}

function hydrateFullSettingsPresetData(data) {
    hydrateKoboldPresetData(data);
    hydrateNovelPresetData(data);
    hydrateTextGenPresetData(data);
    hydrateOpenAIPresetData(data);
    fullSettingsLoaded = true;
}

async function warmPreloadFullSettings() {
    if (fullSettingsLoaded) {
        return true;
    }

    if (fullSettingsLoadPromise) {
        return fullSettingsLoadPromise;
    }

    fullSettingsLoadPromise = (async () => {
        try {
            const data = await fetchSettingsPayload('/api/settings/get', { silent: true });
            hydrateFullSettingsPresetData(data);
            return true;
        } catch (error) {
            console.warn('Deferred settings preload failed', error);
            return false;
        }
    })();

    try {
        return await fullSettingsLoadPromise;
    } finally {
        fullSettingsLoadPromise = null;
    }
}

export async function ensureFullSettingsLoaded() {
    if (fullSettingsLoaded) {
        return true;
    }

    return await warmPreloadFullSettings();
}

export async function getSettings(options = {}) {
    let shouldPersistFirstRunCompletion = false;
    const useBootstrap = options?.bootstrap === true;
    const data = options?.payload ?? await fetchSettingsPayload(useBootstrap ? '/api/settings/bootstrap' : '/api/settings/get');

    if (!useBootstrap) {
        hydrateFullSettingsPresetData(data);
    }

    if (data.result != 'file not find' && data.settings) {
        settings = JSON.parse(data.settings);
        if (settings.username !== undefined && settings.username !== '') {
            name1 = settings.username;
            $('#your_name').text(name1);
        }

        setFrontendConsoleDebugLoggingEnabled(Boolean(settings?.power_user?.frontend_debug_logging), { announce: false });
        accountStorage.init(settings?.accountStorage);
        await setUserControls(data.enable_accounts);
        setRequestCompressionConfig(data.request_compression);

        // Allow subscribers to mutate settings
        await eventSource.emit(event_types.SETTINGS_LOADED_BEFORE, settings);

        //Load AI model config settings
        amount_gen = settings.amount_gen;
        if (settings.max_context !== undefined)
            max_context = parseInt(settings.max_context);

        swipes = settings.swipes !== undefined ? !!settings.swipes : true;  // enable swipes by default
        $('#swipes-checkbox').prop('checked', swipes); /// swipecode
        refreshSwipeButtons();

        // Kobold
        loadKoboldSettings(data, settings.kai_settings ?? settings, settings);

        // Novel
        loadNovelSettings(data, settings.nai_settings ?? settings);

        // TextGen
        await loadTextGenSettings(data, settings);

        // OpenAI
        loadOpenAISettings(data, settings.oai_settings ?? settings);

        // Horde
        loadHordeSettings(settings);

        // Load power user settings
        await loadPowerUserSettings(settings, data);

        // Apply theme toggles from power user settings
        applyPowerUserSettings();

        // Load character tags
        loadTagsSettings(settings);

        // Load background
        loadBackgroundSettings(settings);

        // Load proxy presets
        loadProxyPresets(settings);

        // Allow subscribers to mutate settings
        await eventSource.emit(event_types.SETTINGS_LOADED_AFTER, settings);

        // Set context size after loading power user (may override the max value)
        $('#max_context').val(max_context);
        $('#max_context_counter').val(max_context);

        $('#amount_gen').val(amount_gen);
        $('#amount_gen_counter').val(amount_gen);

        //Load which API we are using
        if (settings.main_api == undefined) {
            settings.main_api = 'kobold';
        }

        if (settings.main_api == 'poe') {
            settings.main_api = 'openai';
        }

        main_api = settings.main_api;
        $('#main_api').val(main_api);
        $(`#main_api option[value=${main_api}]`).attr('selected', 'true');
        changeMainAPI();

        //Load User's Name and Avatar
        initUserAvatar(settings.user_avatar);
        setPersonaDescription();

        //Load the active character and group
        active_character = settings.active_character;
        active_group = settings.active_group;

        setWorldInfoSettings(settings.world_info_settings ?? settings, data);

        selected_button = settings.selected_button;

        // TODO: Move me into firstLoadInit when experimental toggle is removed
        // power_user.experimental_macro_engine
        initMacros();

        if (data.enable_extensions) {
            const enableAutoUpdate = Boolean(data.enable_extensions_auto_update);
            const isVersionChanged = settings.currentVersion !== currentVersion;
            primeExtensionSettings(settings, isVersionChanged, enableAutoUpdate);
        }

        firstRun = !!settings.firstRun;

        if (firstRun) {
            if (isLoaderVisible()) {
                await hideLoader();
            }
            await doOnboarding(user_avatar);
            firstRun = false;
            shouldPersistFirstRunCompletion = true;
        }
    }
    await validateDisabledSamplers();
    rememberSettingsSnapshot(buildSettingsPayload());
    settingsReady = true;
    await eventSource.emit(event_types.SETTINGS_LOADED);

    if (shouldPersistFirstRunCompletion) {
        await saveSettings(0, { directSave: true });
    }

    if (useBootstrap) {
        void warmPreloadFullSettings();
    }
}

function primeCharactersSnapshot(snapshot) {
    primedCharacters = Array.isArray(snapshot)
        ? structuredClone(snapshot)
        : null;
}

function rememberSettingsSnapshot(nextSettings = null) {
    if (!isPlainObject(nextSettings)) {
        settingsSnapshotCache = null;
        return;
    }
    settingsSnapshotCache = normalizeJsonObject(nextSettings);
}

function getSettingsSnapshot() {
    if (isPlainObject(settingsSnapshotCache)) {
        return cloneJsonValue(settingsSnapshotCache);
    }
    if (isPlainObject(settings)) {
        return normalizeJsonObject(settings);
    }
    return null;
}

function mergeSettingsSaveOptions(baseOptions = null, overrideOptions = null) {
    return {
        asyncDiff: overrideOptions?.asyncDiff ?? baseOptions?.asyncDiff ?? true,
        directSave: overrideOptions?.directSave ?? baseOptions?.directSave ?? false,
    };
}

function normalizeSettingsSaveOptions(options = null) {
    const normalized = {
        asyncDiff: options?.asyncDiff !== false && options?.diffMode !== 'sync',
        directSave: options?.directSave === true,
    };

    if (forceAsyncDiffForNextSettingsSave) {
        normalized.asyncDiff = true;
        forceAsyncDiffForNextSettingsSave = false;
        if (forceAsyncDiffForNextSettingsSaveTimer) {
            clearTimeout(forceAsyncDiffForNextSettingsSaveTimer);
            forceAsyncDiffForNextSettingsSaveTimer = null;
        }
    }

    return normalized;
}

export function requestAsyncDiffForNextSettingsSave() {
    forceAsyncDiffForNextSettingsSave = true;
    if (forceAsyncDiffForNextSettingsSaveTimer) {
        clearTimeout(forceAsyncDiffForNextSettingsSaveTimer);
    }
    forceAsyncDiffForNextSettingsSaveTimer = setTimeout(() => {
        forceAsyncDiffForNextSettingsSave = false;
        forceAsyncDiffForNextSettingsSaveTimer = null;
    }, 5000);
}

function buildSettingsPayload() {

    return normalizeJsonObject({
        firstRun: firstRun,
        accountStorage: accountStorage.getState(),
        currentVersion: currentVersion,
        username: name1,
        active_character: active_character,
        active_group: active_group,
        user_avatar: user_avatar,
        amount_gen: amount_gen,
        max_context: max_context,
        main_api: main_api,
        world_info_settings: getWorldInfoSettings(),
        textgenerationwebui_settings: textgen_settings,
        swipes: swipes,
        horde_settings: horde_settings,
        power_user: power_user,
        extension_settings: extension_settings,
        tags: tags,
        tag_map: tag_map,
        nai_settings: nai_settings,
        kai_settings: kai_settings,
        oai_settings: oai_settings,
        background: background_settings,
        proxies: proxies,
        selected_proxy: selected_proxy,
    });
}

//MARK: saveSettings()
async function saveSettingsInternal(loopCounter = 0, options = {}) {
    if (!settingsReady) {
        console.warn('Settings not ready, scheduling another save');
        saveSettingsDebounced();
        return;
    }

    const MAX_RETRIES = 3;
    if (TempResponseLength.isCustomized()) {
        if (loopCounter < MAX_RETRIES) {
            console.warn('Response length is currently being overridden, scheduling another save');
            saveSettingsDebounced(++loopCounter, options);
            return;
        }
        console.error('Response length is currently being overridden, but the save loop has reached the maximum number of retries');
        TempResponseLength.restore(null);
    }

    const payload = buildSettingsPayload();

    try {
        let saved = false;
        const previousSnapshot = getSettingsSnapshot();

        if (!options.directSave && isPlainObject(previousSnapshot)) {
            const operations = options.asyncDiff
                ? await buildObjectPatchOperationsAsync(previousSnapshot, payload, { maxOperations: 4000 })
                : buildObjectPatchOperations(previousSnapshot, payload, { maxOperations: 4000 });
            if (operations.length === 0) {
                saved = true;
            } else {
                const patchBody = JSON.stringify({ operations });
                const fullBody = JSON.stringify(payload);
                // If patch is not meaningfully smaller, prefer legacy full-save path.
                if (patchBody.length < fullBody.length) {
                    const patchResult = await fetch('/api/settings/patch', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: patchBody,
                        cache: 'no-cache',
                    });
                    saved = patchResult.ok;
                }
            }
        }

        if (!saved) {
            const result = await fetch('/api/settings/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(payload),
                cache: 'no-cache',
            });

            if (!result.ok) {
                throw new Error(`Failed to save settings: ${result.statusText}`);
            }
        }

        invalidateSettingsGetResponseCache();
        settings = payload;
        rememberSettingsSnapshot(payload);
        await eventSource.emit(event_types.SETTINGS_UPDATED);
    } catch (error) {
        console.error('Error saving settings:', error);
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Settings could not be saved`);
    }
}

export async function saveSettings(loopCounter = 0, options = null) {
    const normalizedOptions = normalizeSettingsSaveOptions(options);

    if (settingsSaveInFlight) {
        settingsSaveQueued = true;
        settingsSaveQueuedOptions = mergeSettingsSaveOptions(settingsSaveQueuedOptions, normalizedOptions);
        return settingsSaveInFlight;
    }

    settingsSaveInFlight = (async () => {
        try {
            await saveSettingsInternal(loopCounter, normalizedOptions);
        } finally {
            settingsSaveInFlight = null;
            if (settingsSaveQueued) {
                const queuedOptions = settingsSaveQueuedOptions;
                settingsSaveQueued = false;
                settingsSaveQueuedOptions = null;
                await saveSettings(0, queuedOptions);
            }
        }
    })();

    return settingsSaveInFlight;
}


/**
 * Sets the generation parameters from a preset object.
 * @param {{ genamt?: number, max_length?: number }} preset Preset object
 */
export function setGenerationParamsFromPreset(preset) {
    const needsUnlock = (preset.max_length ?? max_context) > MAX_CONTEXT_DEFAULT || (preset.genamt ?? amount_gen) > MAX_RESPONSE_DEFAULT;
    $('#max_context_unlocked').prop('checked', needsUnlock).trigger('change');

    if (preset.genamt !== undefined) {
        amount_gen = preset.genamt;
        $('#amount_gen').val(amount_gen);
        $('#amount_gen_counter').val(amount_gen);
    }

    if (preset.max_length !== undefined) {
        max_context = preset.max_length;
        $('#max_context').val(max_context);
        $('#max_context_counter').val(max_context);
    }
}

// Common code for message editor done and auto-save
function updateMessage(div) {
    const mesBlock = div.closest('.mes_block');
    let text = mesBlock.find('.edit_textarea').val()
        ?? mesBlock.find('.mes_text').text();
    const mesElement = div.closest('.mes');
    const mes = chat[mesElement.attr('mesid')];

    // editing old messages
    mes.extra ??= {};

    let regexPlacement;
    if (mes?.is_user) {
        regexPlacement = regex_placement.USER_INPUT;
    } else if (mes.extra?.type === 'narrator') {
        regexPlacement = regex_placement.SLASH_COMMAND;
    } else {
        regexPlacement = regex_placement.AI_OUTPUT;
    }

    // Ignore character override if sent as system
    text = getRegexedString(
        text,
        regexPlacement,
        {
            characterOverride: mes.extra?.type === 'narrator' ? undefined : mes.name,
            isEdit: true,
        },
    );


    if (power_user.trim_spaces) {
        text = text.trim();
    }

    const bias = substituteParams(extractMessageBias(text));
    text = substituteParams(text);
    if (bias) {
        text = removeMacros(text);
    }
    mes.mes = text;
    if (mes.swipe_id !== undefined) {
        ensureSwipes(mes);
        mes.swipes[mes.swipe_id] = text;
    }

    if (mes?.is_system || mes?.is_user || mes.extra?.type === system_message_types.NARRATOR) {
        mes.extra.bias = bias ?? null;
    } else {
        mes.extra.bias = null;
    }

    chat_metadata.tainted = true;

    return { mesBlock, text, mes, bias };
}

/**
 * Re-renders a message from the current chat state after exiting edit mode.
 * @param {number} messageId
 * @param {object} [options={}]
 * @param {JQuery<HTMLElement>} [options.messageElement]
 * @param {string|null|undefined} [options.bias]
 * @param {boolean} [options.updateBias=false]
 * @returns {JQuery<HTMLElement>}
 */
function renderEditedMessage(messageId, { messageElement = null, bias = undefined, updateBias = false } = {}) {
    const message = chat[messageId];
    if (!message) {
        return $();
    }

    const resolvedMessageElement = messageElement?.length
        ? messageElement
        : chatElement.children('.mes').filter(`[mesid="${messageId}"]`);

    if (resolvedMessageElement.length === 0) {
        return resolvedMessageElement;
    }

    const messageBlock = resolvedMessageElement.find('.mes_block');
    messageBlock.find('.mes_edit_buttons').css('display', 'none');
    messageBlock.find('.mes_buttons').css('display', '');
    const messageName = message.name || (message.is_user ? name1 : name2);
    const text = message?.extra?.display_text ?? message.mes;
    messageBlock.find('.mes_text')
        .empty()
        .append(messageFormatting(
            text,
            messageName,
            message.is_system,
            message.is_user,
            messageId,
            {},
            false,
        ));

    updateReasoningUI(resolvedMessageElement);

    if (updateBias) {
        messageBlock.find('.mes_bias').empty();
        messageBlock.find('.mes_bias').append(messageFormatting(bias, '', false, false, -1, {}, false));
    }

    appendMediaToMessage(message, resolvedMessageElement);
    addCopyToCodeBlocks(resolvedMessageElement);
    return resolvedMessageElement;
}

function openMessageDelete(fromSlashCommand) {
    closeMessageEditor();
    hideSwipeButtons();
    if (fromSlashCommand || (!is_send_press) || (selected_group && !is_group_generating)) {
        $('#dialogue_del_mes').css('display', 'block');
        $('#send_form').css('display', 'none');
        $('.del_checkbox').each(function () {
            $(this).css('display', 'grid');
            $(this).parent().children('.for_checkbox').css('display', 'none');
        });
    } else {
        console.debug(`
            ERR -- could not enter del mode
            this_chid: ${this_chid}
            is_send_press: ${is_send_press}
            selected_group: ${selected_group}
            is_group_generating: ${is_group_generating}`);
    }
    this_del_mes = -1;
    is_delete_mode = true;
}

function messageEditAuto(div) {
    const { mesBlock, text, mes, bias } = updateMessage(div);

    mesBlock.find('.mes_text').val('');
    mesBlock.find('.mes_text').val(messageFormatting(
        text,
        this_edit_mes_chname,
        mes.is_system,
        mes.is_user,
        this_edit_mes_id,
        {},
        false,
    ));
    mesBlock.find('.mes_bias').empty();
    mesBlock.find('.mes_bias').append(messageFormatting(bias, '', false, false, -1, {}, false));
    saveChatDebounced();
}

/**
 * Create the message edit UI.
 * @param {number} editMessageId The ID of the message to edit
 */
export async function messageEdit(editMessageId) {
    const editMessage = chat[editMessageId];
    if (!editMessage) {
        console.warn(`Message with id ${editMessageId} not found in chat array.`);
        return;
    }

    const messageElement = chatElement.find(`.mes[mesid="${editMessageId}"]`);
    if (messageElement.length === 0) {
        console.warn(`Message element with id ${editMessageId} not found in DOM.`);
        return;
    }

    this_edit_mes_id = editMessageId;
    this_edit_mes_chname = editMessage.name || (editMessage.is_user ? name1 : name2);

    refreshSwipeButtons();

    const chatScrollPosition = chatElement.scrollTop();
    const messageBlock = messageElement.find('.mes_block');
    const messageText = messageBlock.find('.mes_text');

    messageText.empty();
    messageBlock.find('.mes_buttons').css('display', 'none');
    messageBlock.find('.mes_edit_buttons').css('display', 'inline-flex');

    // Also edit reasoning, if it exists
    const reasoningEdit = messageBlock.find('.mes_reasoning_edit:visible');
    if (reasoningEdit.length > 0) {
        reasoningEdit.trigger('click');
    }

    const editTextArea = document.createElement('textarea');
    editTextArea.id = 'curEditTextarea';
    editTextArea.className = 'edit_textarea mdHotkeys';
    editTextArea.dataset.macros = '';
    messageText.append(editTextArea);

    const text = trimSpaces(editMessage.mes || '');
    const $editTextArea = $(editTextArea);
    $editTextArea.val(text);

    const cssAutofit = CSS.supports('field-sizing', 'content');
    if (!cssAutofit) {
        $editTextArea.height(0);
        $editTextArea.height(editTextArea.scrollHeight);
    }

    $editTextArea.trigger('focus');

    // Sets the cursor at the end of the text
    editTextArea.setSelectionRange(text.length, text.length);

    if (Number(this_edit_mes_id) === chat.length - 1) {
        chatElement.scrollTop(chatScrollPosition);
    }

    updateEditArrowClasses();
}

/**
 * Close the open message editor.
 * This deletes the user's unsaved changes.
 * @param {number} [messageId=this_edit_mes_id]
 */
async function messageEditCancel(messageId = this_edit_mes_id) {
    if (!(messageId >= 0) || !chat[messageId]) {
        return;
    }

    let thisMesDiv;
    // If this is the button then select it's parent. Otherwise, select by messageId.
    if (this?.classList?.contains('mes_edit_cancel')) {
        thisMesDiv = $(this).closest('.mes');
    } else {
        thisMesDiv = chatElement.children('.mes').filter(`[mesid="${messageId}"]`);
    }

    const thisMesBlock = thisMesDiv.find('.mes_block');
    thisMesDiv.find('.mes_edit_buttons').css('display', 'none');
    thisMesBlock.find('.mes_buttons').css('display', '');

    const reasoningEditDone = thisMesBlock.find('.mes_reasoning_edit_cancel:visible');
    if (reasoningEditDone.length > 0) {
        reasoningEditDone.trigger('click');
    }

    renderEditedMessage(messageId);

    if (messageId == this_edit_mes_id) {
        this_edit_mes_id = undefined;
    } else {
        console.warn(`The message editor was closed on message #${messageId} while #${this_edit_mes_id} is being edited.`);
    }

    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    showSwipeButtons();
}

/**
 * Swaps chat[sourceId] with chat[targetId]. They must be adjacent.
 * @param {number} sourceId Index of the message to move
 * @param {number} targetId Index of the target message
 * @returns {Promise<boolean>} True if the messages were moved, false otherwise
 */
async function messageEditMove(sourceId, targetId) {
    if (is_send_press) {
        console.warn(`The message #${sourceId} was not moved to #${targetId} because a generation is in progress.`);
        return false;
    }

    if (Math.abs(sourceId - targetId) !== 1) {
        console.error(`Message #${sourceId} and #${targetId} are not adjacent.`);
        return false;
    }

    const targetMessageDiv = chatElement.find(`.mes[mesid="${targetId}"]`);
    const sourceMessageDiv = chatElement.find(`.mes[mesid="${sourceId}"]`);

    if (sourceMessageDiv.length === 0 || targetMessageDiv.length === 0) {
        console.error(`Message #${sourceId} or #${targetId} were not found.`);
        return false;
    }

    if (sourceId <= targetId) {
        sourceMessageDiv.insertAfter(targetMessageDiv);
    } else {
        sourceMessageDiv.insertBefore(targetMessageDiv);
    }

    //Swap Ids.
    targetMessageDiv.attr('mesid', sourceId);
    sourceMessageDiv.attr('mesid', targetId);

    // Swap chat array entries.
    [chat[sourceId], chat[targetId]] = [chat[targetId], chat[sourceId]];

    // Update edited message id
    if (this_edit_mes_id === sourceId) {
        this_edit_mes_id = targetId;
    }

    swapItemizedPrompts(sourceId, targetId);
    updateViewMessageIds();
    refreshSwipeButtons();
    const patched = await patchChatMessages([
        { op: 'replace', path: `/${sourceId}`, value: chat[sourceId] },
        { op: 'replace', path: `/${targetId}`, value: chat[targetId] },
    ]);
    if (!patched) {
        await saveChatConditional();
    }
    return true;
}

async function messageEditDone(div) {
    if (!(this_edit_mes_id >= 0)) {
        console.trace('this_edit_mes_id cannot be blank when calling messageEditDone.');
        return;
    }
    const editedMessageId = Number(this_edit_mes_id);

    let { mesBlock, text, mes, bias } = updateMessage(div);

    const messageElement = chatElement.children('.mes').filter(`[mesid="${editedMessageId}"]`);
    messageElement.find('.mes_edit_buttons').css('display', 'none');
    mesBlock.find('.mes_buttons').css('display', '');

    const reasoningEditDone = mesBlock.find('.mes_reasoning_edit_done:visible');
    if (reasoningEditDone.length > 0) {
        reasoningEditDone.trigger('click');
    }

    // Close the editor before async MESSAGE_EDITED listeners run, so slow listeners
    // cannot leave the textarea stranded after the action buttons disappear.
    renderEditedMessage(editedMessageId, {
        bias: chat[editedMessageId]?.extra?.bias ?? bias,
        updateBias: true,
    });
    this_edit_mes_id = undefined;

    await eventSource.emit(event_types.MESSAGE_EDITED, editedMessageId, getChatMessageMutationMeta(editedMessageId));
    await eventSource.emit(event_types.MESSAGE_UPDATED, editedMessageId);
    const patched = await patchChatMessages([
        { op: 'replace', path: `/${editedMessageId}`, value: chat[editedMessageId] },
    ]);
    if (!patched) {
        await saveChatConditional();
    }
    showSwipeButtons();
}

/**
 * Fetches the chat content for each chat file from the server and compiles them into a dictionary.
 * The function iterates over a provided list of chat metadata and requests the actual chat content
 * for each chat, either as an individual chat or a group chat based on the context.
 *
 * @param {Array} data - An array containing metadata about each chat such as file_name.
 * @param {boolean} isGroupChat - A flag indicating if the chat is a group chat.
 * @returns {Promise<Object>} chat_dict - A dictionary where each key is a file_name and the value is the
 * corresponding chat content fetched from the server.
 */
export async function getChatsFromFiles(data, isGroupChat) {
    const context = getContext();
    let chat_dict = {};
    let chat_list = Object.values(data).sort((a, b) => a.file_name.localeCompare(b.file_name)).reverse();

    let chat_promise = chat_list.map(({ file_name }) => {
        return new Promise(async (res, rej) => {
            try {
                const endpoint = isGroupChat ? '/api/chats/group/get' : '/api/chats/get';
                const requestBody = isGroupChat
                    ? JSON.stringify({ id: file_name })
                    : JSON.stringify({
                        ch_name: getCharacterName(characters[context.characterId]),
                        file_name: file_name.replace('.jsonl', ''),
                        avatar_url: characters[context.characterId].avatar,
                    });

                const chatResponse = await fetch(endpoint, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: requestBody,
                    cache: 'no-cache',
                });

                if (!chatResponse.ok) {
                    return res();
                    // continue;
                }

                const currentChat = await chatResponse.json();
                if (!isGroupChat) {
                    // remove the first message, which is metadata, only for individual chats
                    currentChat.shift();
                }
                chat_dict[file_name] = currentChat;
            } catch (error) {
                console.error(error);
            }

            return res();
        });
    });

    await Promise.all(chat_promise);

    return chat_dict;
}

/**
 * Fetches the metadata of all past chats related to a specific character based on its avatar URL.
 * The function sends a POST request to the server to retrieve all chats for the character. It then
 * processes the received data, sorts it by the file name, and returns the sorted data.
 *
 * @param {null|number} [characterId=null] - When set, the function will use this character id instead of this_chid.
 *
 * @returns {Promise<Array>} - An array containing metadata of all past chats of the character, sorted
 * in descending order by file name. Returns an empty array if the fetch request is unsuccessful or the
 * response is an object with an `error` property set to `true`.
 */
export async function getPastCharacterChats(characterId = null) {
    characterId = characterId ?? parseInt(this_chid);
    if (!characters[characterId]) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: characters[characterId].avatar }),
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        return [];
    }

    const data = await response.json();
    if (typeof data === 'object' && data.error === true) {
        return [];
    }

    const chats = Object.values(data);
    return chats.sort((a, b) => a.file_name.localeCompare(b.file_name)).reverse();
}

/**
 * Helper for `displayPastChats`, to make the same info consistently available for other functions
 */
export function getCurrentChatDetails() {
    if (!characters[this_chid] && !selected_group) {
        return { sessionName: '', group: null, characterName: '', avatarImgURL: '' };
    }

    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const currentChat = selected_group ? group?.chat_id : characters[this_chid]['chat'];
    const displayName = selected_group ? group?.name : getCharacterName(characters[this_chid]);
    const avatarImg = selected_group ? group?.avatar_url : getThumbnailUrl('avatar', characters[this_chid]['avatar']);
    return { sessionName: currentChat, group: group, characterName: displayName, avatarImgURL: avatarImg };
}

function buildCurrentChatFileActionContext() {
    if (selected_group) {
        const groupId = String(selected_group || '').trim();
        const group = groups.find(x => String(x?.id || '') === groupId);
        const chatFile = String(group?.chat_id || '').trim();
        if (!groupId || !group || !chatFile) {
            return null;
        }

        return {
            kind: 'group',
            groupId,
            chatFile,
        };
    }

    const characterId = String(this_chid ?? '').trim();
    const character = characters[this_chid];
    const chatFile = String(character?.chat || '').trim();
    const avatarUrl = String(character?.avatar || '').trim();
    const characterName = String(getCharacterName(character) || name2 || '').trim();
    if (!characterId || !character || !chatFile || !avatarUrl) {
        return null;
    }

    return {
        kind: 'character',
        characterId,
        chatFile,
        avatarUrl,
        characterName,
    };
}

function isCurrentChatFileActionContextActive(context) {
    if (!context || typeof context !== 'object') {
        return false;
    }

    if (context.kind === 'group') {
        return String(selected_group || '').trim() === String(context.groupId || '').trim();
    }

    return !selected_group && String(this_chid ?? '').trim() === String(context.characterId || '').trim();
}

async function createNewCharacterChatForContext(context) {
    const characterId = String(context?.characterId || '').trim();
    const character = characters[characterId];
    if (!character) {
        return '';
    }

    const prefix = String(context?.characterName || getCharacterName(character) || name2 || neutralCharacterName).trim() || neutralCharacterName;
    const newChatName = `${prefix} - ${humanizedDateTime()}`;

    if (isCurrentChatFileActionContextActive(context)) {
        await clearChat({ clearData: true });
        chat_metadata = {};
        character.chat = newChatName;
        $('#selected_chat_pole').val(character.chat);
        await getChat();
        await updateRemoteChatName(characterId, newChatName);
        return character.chat;
    }

    await updateRemoteChatName(characterId, newChatName);
    return newChatName;
}

async function createNewGroupChatForContext(context) {
    const groupId = String(context?.groupId || '').trim();
    const group = groups.find(x => String(x?.id || '') === groupId);
    if (!group) {
        return '';
    }

    if (isCurrentChatFileActionContextActive(context)) {
        await createNewGroupChat(groupId);
        return String(group.chat_id || '').trim();
    }

    const newChatName = humanizedDateTime();
    group.chats.push(newChatName);
    group.chat_id = newChatName;
    await editGroup(group.id, true, false);
    return newChatName;
}

/**
 * Displays the past chats for a character or a group based on the selected context.
 * The function first fetches the chats, processes them, and then displays them in
 * the HTML. It also has a built-in search functionality that allows filtering the
 * displayed chats based on a search query.
 * @param {string[]} hightlightNames - An array of chat names to highlight
 */
export async function displayPastChats(hightlightNames = []) {
    $('#select_chat_div').empty();
    $('#select_chat_search').val('').off('input');

    const chatDetails = getCurrentChatDetails();
    const currentChat = chatDetails.sessionName;
    const displayName = chatDetails.characterName;
    const avatarImg = chatDetails.avatarImgURL;

    await displayChats('', currentChat, displayName, avatarImg, selected_group, hightlightNames);

    const debouncedDisplay = debounce((searchQuery) => {
        displayChats(searchQuery, currentChat, displayName, avatarImg, selected_group, []);
    });

    // Define the search input listener
    $('#select_chat_search').off('input').on('input', function () {
        const searchQuery = $(this).val();
        debouncedDisplay(searchQuery);
    });

    // UX convenience: Focus the search field when the Manage Chat Files view opens.
    setTimeout(function () {
        const textSearchElement = $('#select_chat_search');
        textSearchElement.trigger('click').trigger('focus').trigger('select');
    }, 200);

    addChatBackupsBrowser();
}

async function displayChats(searchQuery, currentChat, displayName, avatarImg, selected_group, highlightNames) {
    try {
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                query: searchQuery,
                avatar_url: selected_group ? null : characters[this_chid].avatar,
                group_id: selected_group || null,
            }),
        });

        if (!response.ok) {
            throw new Error('Search failed');
        }

        const filteredData = await response.json();
        $('#select_chat_div').empty();

        filteredData.sort((a, b) => sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));

        for (const chat of filteredData) {
            const isSelected = currentChat === chat.file_name;
            const template = $('#past_chat_template .select_chat_block_wrapper').clone();
            template.find('.select_chat_block').attr('file_name', chat.file_name);
            template.find('.avatar img').attr('src', avatarImg);
            template.find('.select_chat_block_filename').text(chat.file_name);
            template.find('.chat_file_size').text(`(${chat.file_size},`);
            template.find('.chat_messages_num').text(`${chat.message_count} 💬)`);
            template.find('.select_chat_block_mes').text(chat.preview_message);
            template.find('.PastChat_cross').attr('file_name', chat.file_name);
            template.find('.chat_messages_date').text(timestampToMoment(chat.last_mes).format('lll'));

            if (isSelected) {
                template.find('.select_chat_block').attr('highlight', String(true));
            }

            $('#select_chat_div').append(template);

            if (Array.isArray(highlightNames) && highlightNames.includes(chat.file_name)) {
                const templateOffset = template.offset().top - template.parent().offset().top;
                $('#select_chat_div').scrollTop(templateOffset);
                flashHighlight(template, debounce_timeout.extended);
            }
        }
    } catch (error) {
        console.error('Error loading chats:', error);
        toastr.error('Could not load chat data. Try reloading the page.');
    }
}

export function selectRightMenuWithAnimation(selectedMenuId) {
    const displayModes = {
        'rm_group_chats_block': 'flex',
        'rm_api_block': 'grid',
        'rm_characters_block': 'flex',
    };
    $('#result_info').toggle(selectedMenuId === 'rm_ch_create_block');
    document.querySelectorAll('#right-nav-panel .right_menu').forEach((menu) => {
        $(menu).css('display', 'none');

        if (selectedMenuId && selectedMenuId.replace('#', '') === menu.id) {
            const mode = displayModes[menu.id] ?? 'block';
            $(menu).css('display', mode);
            $(menu).css('opacity', 0.0);
            $(menu).transition({
                opacity: 1.0,
                duration: animation_duration,
                easing: animation_easing,
                complete: function () { },
            });
        }
    });
}

export function select_rm_info(type, charId, previousCharId = null) {
    if (!type) {
        toastr.error(t`Invalid process (no 'type')`);
        return;
    }
    if (type !== 'group_create') {
        var displayName = String(charId).replace('.png', '');
    }

    if (type === 'char_delete') {
        toastr.warning(t`Character Deleted: ${displayName}`);
    }
    if (type === 'char_create') {
        toastr.success(t`Character Created: ${displayName}`);
    }
    if (type === 'group_create') {
        toastr.success(t`Group Created`);
    }
    if (type === 'group_delete') {
        toastr.warning(t`Group Deleted`);
    }

    if (type === 'char_import') {
        toastr.success(t`Character Imported: ${displayName}`);
    }

    selectRightMenuWithAnimation('rm_characters_block');

    // Set a timeout so multiple flashes don't overlap
    clearTimeout(importFlashTimeout);
    importFlashTimeout = setTimeout(function () {
        if (type === 'char_import' || type === 'char_create' || type === 'char_import_no_toast') {
            // Find the page at which the character is located
            const avatarFileName = charId;
            const charData = getEntitiesList({ doFilter: true });
            const charIndex = charData.findIndex((x) => x?.item?.avatar?.startsWith(avatarFileName));

            if (charIndex === -1) {
                console.log(`Could not find character ${charId} in the list`);
                return;
            }

            try {
                const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
                const page = Math.floor(charIndex / perPage) + 1;
                const selector = `#rm_print_characters_block [title*="${avatarFileName}"]`;
                $('#rm_print_characters_pagination').pagination('go', page);

                waitUntilCondition(() => document.querySelector(selector) !== null).then(() => {
                    const element = $(selector).parent();

                    if (element.length === 0) {
                        console.log(`Could not find element for character ${charId}`);
                        return;
                    }

                    const scrollOffset = element.offset().top - element.parent().offset().top;
                    element.parent().scrollTop(scrollOffset);
                    flashHighlight(element, 5000);
                });
            } catch (e) {
                console.error(e);
            }
        }

        if (type === 'group_create') {
            // Find the page at which the character is located
            const charData = getEntitiesList({ doFilter: true });
            const charIndex = charData.findIndex((x) => String(x?.item?.id) === String(charId));

            if (charIndex === -1) {
                console.log(`Could not find group ${charId} in the list`);
                return;
            }

            const perPage = Number(accountStorage.getItem('Characters_PerPage')) || per_page_default;
            const page = Math.floor(charIndex / perPage) + 1;
            $('#rm_print_characters_pagination').pagination('go', page);
            const selector = `#rm_print_characters_block [grid="${charId}"]`;
            try {
                waitUntilCondition(() => document.querySelector(selector) !== null).then(() => {
                    const element = $(selector);
                    const scrollOffset = element.offset().top - element.parent().offset().top;
                    element.parent().scrollTop(scrollOffset);
                    flashHighlight(element, 5000);
                });
            } catch (e) {
                console.error(e);
            }
        }
    }, 250);

    if (previousCharId) {
        const newId = characters.findIndex((x) => x.avatar == previousCharId);
        if (newId >= 0) {
            setCharacterId(newId);
        }
    }
}

/**
 * Selects the right menu for displaying the character editor.
 * @param {string} chid Character array index
 * @param {object} [param1] Options for the switch
 * @param {boolean} [param1.switchMenu=true] Whether to switch the menu
 */
export function select_selected_character(chid, { switchMenu = true } = {}) {
    const character = characters[chid];
    //character select
    //console.log('select_selected_character() -- starting with input of -- ' + chid + ' (name:' + characters[chid].name + ')');
    select_rm_create({ switchMenu });
    switchMenu && setMenuType('character_edit');
    $('#delete_button').css('display', 'flex');
    $('#export_button').css('display', 'flex');

    //create text poles
    $('#rm_button_back').css('display', 'none');
    //$("#character_import_button").css("display", "none");
    $('#create_button').attr('value', 'Save');              // what is the use case for this?
    $('#dupe_button').show();
    $('#create_button_label').css('display', 'none');
    $('#char_connections_button').show();

    // Hide the chat scenario button if we're peeking the group member defs
    $('#set_chat_character_settings').toggle(!selected_group);

    // Don't update the navbar name if we're peeking the group member defs
    if (!selected_group) {
        $('#rm_button_selected_ch').children('h2').text(getCharacterName(character));
    }

    $('#add_avatar_button').val('');

    $('#character_popup-button-h3').text(getCharacterName(character));
    $('#character_name_pole').val(getCharacterName(character));
    $('#description_textarea').val(getCharacterDescription(character));
    $('#character_world').val(getCharacterWorld(character));
    $('#creator_notes_textarea').val(getCharacterCreatorNotes(character));
    $('#creator_notes_spoiler').html(formatCreatorNotes(getCharacterCreatorNotes(character), character.avatar));
    $('#character_version_textarea').val(getCharacterVersion(character));
    $('#system_prompt_textarea').val(getCharacterSystemPrompt(character));
    $('#post_history_instructions_textarea').val(getCharacterPostHistoryInstructions(character));
    $('#tags_textarea').val(getCharacterTags(character).join(', '));
    $('#creator_textarea').val(getCharacterCreator(character));
    $('#character_version_textarea').val(getCharacterVersion(character));
    $('#personality_textarea').val(getCharacterPersonality(character));
    $('#firstmessage_textarea').val(getCharacterFirstMessage(character));
    $('#scenario_pole').val(getCharacterScenario(character));
    $('#depth_prompt_prompt').val(getCharacterDepthPromptPrompt(character));
    $('#depth_prompt_depth').val(getCharacterDepthPromptDepth(character) ?? depth_prompt_depth_default);
    $('#depth_prompt_role').val(getCharacterDepthPromptRole(character) ?? depth_prompt_role_default);
    $('#talkativeness_slider').val(getCharacterTalkativeness(character) ?? talkativeness_default);
    $('#mes_example_textarea').val(getCharacterMesExample(character));

    // Populate CardApp settings
    const cardAppConfig = character.data?.extensions?.card_app;
    $('#card_app_enabled').prop('checked', !!cardAppConfig?.enabled);
    $('#card_app_entry').val(cardAppConfig?.entry || 'index.js');

    $('#selected_chat_pole').val(character.chat);
    $('#create_date_pole').val(timestampToMoment(character.create_date).toISOString());
    $('#avatar_url_pole').val(character.avatar);
    $('#chat_import_avatar_url').val(character.avatar);
    $('#chat_import_character_name').val(getCharacterName(character));
    $('#character_json_data').val(character.json_data);

    updateFavButtonState(isCharacterFavorite(character));

    const avatarUrl = character.avatar != 'none' ? getThumbnailUrl('avatar', character.avatar) : default_avatar;
    $('#avatar_load_preview').attr('src', avatarUrl);
    $('.open_alternate_greetings').data('chid', chid);
    $('#set_character_world').data('chid', chid);
    setWorldInfoButtonClass(chid);
    checkEmbeddedWorld(chid);

    $('#name_div').removeClass('displayBlock');
    $('#name_div').addClass('displayNone');
    $('#renameCharButton').css('display', '');

    $('#form_create').attr('actiontype', 'editcharacter');
    $('.form_create_bottom_buttons_block .chat_lorebook_button').show();

    const externalMediaState = isExternalMediaAllowed();
    $('#character_open_media_overrides').toggle(!selected_group);
    $('#character_media_allowed_icon').toggle(externalMediaState);
    $('#character_media_forbidden_icon').toggle(!externalMediaState);

    // Update some stuff about the char management dropdown
    $('#character_source').attr('disabled', !getCharacterSource(chid) ? '' : null);

    eventSource.emit(event_types.CHARACTER_EDITOR_OPENED, chid);

    saveSettingsDebounced();
}

/**
 * Selects the right menu for creating a new character.
 * @param {object} [options] Options for the switch
 * @param {boolean} [options.switchMenu=true] Whether to switch the menu
 */
function select_rm_create({ switchMenu = true } = {}) {
    switchMenu && setMenuType('create');

    //console.log('select_rm_Create() -- selected button: '+selected_button);
    if (selected_button == 'create' && create_save.avatar) {
        const addAvatarInput = /** @type {HTMLInputElement} */ ($('#add_avatar_button').get(0));
        addAvatarInput.files = create_save.avatar;
        read_avatar_load(addAvatarInput);
    }

    switchMenu && selectRightMenuWithAnimation('rm_ch_create_block');

    $('#set_chat_character_settings').hide();
    $('#delete_button_div').css('display', 'none');
    $('#delete_button').css('display', 'none');
    $('#export_button').css('display', 'none');
    $('#create_button_label').css('display', '');
    $('#create_button').attr('value', 'Create');
    $('#dupe_button').hide();
    $('#char_connections_button').hide();

    //create text poles
    $('#rm_button_back').css('display', '');
    $('#character_import_button').css('display', '');
    $('#character_popup-button-h3').text('Create character');
    $('#character_name_pole').val(create_save.name);
    $('#description_textarea').val(create_save.description);
    $('#character_world').val(create_save.world);
    $('#creator_notes_textarea').val(create_save.creator_notes);
    $('#creator_notes_spoiler').html(formatCreatorNotes(create_save.creator_notes, ''));
    $('#post_history_instructions_textarea').val(create_save.post_history_instructions);
    $('#system_prompt_textarea').val(create_save.system_prompt);
    $('#tags_textarea').val(create_save.tags);
    $('#creator_textarea').val(create_save.creator);
    $('#character_version_textarea').val(create_save.character_version);
    $('#personality_textarea').val(create_save.personality);
    $('#firstmessage_textarea').val(create_save.first_message);
    $('#talkativeness_slider').val(create_save.talkativeness);
    $('#scenario_pole').val(create_save.scenario);
    $('#depth_prompt_prompt').val(create_save.depth_prompt_prompt);
    $('#depth_prompt_depth').val(create_save.depth_prompt_depth);
    $('#depth_prompt_role').val(create_save.depth_prompt_role);
    $('#mes_example_textarea').val(create_save.mes_example);
    $('#character_json_data').val('');
    $('#avatar_div').css('display', 'flex');
    $('#avatar_load_preview').attr('src', default_avatar);
    $('#renameCharButton').css('display', 'none');
    $('#name_div').removeClass('displayNone');
    $('#name_div').addClass('displayBlock');
    $('.open_alternate_greetings').data('chid', -1);
    $('#set_character_world').data('chid', -1);
    setWorldInfoButtonClass(undefined, !!create_save.world);
    updateFavButtonState(false);
    checkEmbeddedWorld();

    $('#form_create').attr('actiontype', 'createcharacter');
    $('.form_create_bottom_buttons_block .chat_lorebook_button').hide();
    $('#character_open_media_overrides').hide();
}

function select_rm_characters() {
    const doFullRefresh = menu_type === 'characters';
    setMenuType('characters');
    selectRightMenuWithAnimation('rm_characters_block');
    printCharacters(doFullRefresh);
}

/**
 * Sets a prompt injection to insert custom text into any outgoing prompt. For use in UI extensions.
 * @param {string} key Prompt injection id.
 * @param {string} value Prompt injection value.
 * @param {number} position Insertion position. 0 is after story string, 1 is in-chat with custom depth.
 * @param {number} depth Insertion depth. 0 represets the last message in context. Expected values up to MAX_INJECTION_DEPTH.
 * @param {number} role Extension prompt role. Defaults to SYSTEM.
 * @param {boolean} scan Should the prompt be included in the world info scan.
 * @param {(function(): Promise<boolean>|boolean)} filter Filter function to determine if the prompt should be injected.
 */
export function setExtensionPrompt(key, value, position, depth, scan = false, role = extension_prompt_roles.SYSTEM, filter = null) {
    extension_prompts[key] = {
        value: String(value),
        position: Number(position),
        depth: Number(depth),
        scan: !!scan,
        role: Number(role ?? extension_prompt_roles.SYSTEM),
        filter: filter,
    };
}

/**
 * Gets a enum value of the extension prompt role by its name.
 * @param {string} roleName The name of the extension prompt role.
 * @returns {number} The role id of the extension prompt.
 */
export function getExtensionPromptRoleByName(roleName) {
    // If the role is already a valid number, return it
    if (typeof roleName === 'number' && Object.values(extension_prompt_roles).includes(roleName)) {
        return roleName;
    }

    switch (roleName) {
        case 'system':
            return extension_prompt_roles.SYSTEM;
        case 'user':
            return extension_prompt_roles.USER;
        case 'assistant':
            return extension_prompt_roles.ASSISTANT;
    }

    // Skill issue?
    return extension_prompt_roles.SYSTEM;
}

/**
 * Removes all char A/N prompt injections from the chat.
 * To clean up when switching from groups to solo and vice versa.
 */
export function removeDepthPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(inject_ids.DEPTH_PROMPT)) {
            delete extension_prompts[key];
        }
    }
}

/**
 * Adds or updates the metadata for the currently active chat.
 * @param {Object} newValues An object with collection of new values to be added into the metadata.
 * @param {boolean} reset Should a metadata be reset by this call.
 */
export function updateChatMetadata(newValues, reset) {
    chat_metadata = reset ? { ...newValues } : { ...chat_metadata, ...newValues };
}


/**
 * Updates the state of the favorite button based on the provided state.
 * @param {boolean} state Whether the favorite button should be on or off.
 */
function updateFavButtonState(state) {
    // Update global state of the flag
    // TODO: This is bad and needs to be refactored.
    fav_ch_checked = state;
    $('#fav_checkbox').prop('checked', state);
    $('#favorite_button').toggleClass('fav_on', state);
    $('#favorite_button').toggleClass('fav_off', !state);
}

export async function setCharacterSettingsOverrides() {
    if (!selected_group && (this_chid === undefined || !characters[this_chid])) {
        console.warn('setCharacterSettingsOverrides() -- no selected group or character');
        return;
    }

    const scenarioOverrideValue = chat_metadata.scenario || '';
    const exampleMessagesValue = chat_metadata.mes_example || '';
    const systemPromptValue = chat_metadata.system_prompt || '';
    const isGroup = !!selected_group;

    const $template = $(await renderTemplateAsync('scenarioOverride'));
    $template.find('[data-group="true"]').toggle(isGroup);
    $template.find('[data-character="true"]').toggle(!isGroup);
    const pendingChanges = {
        scenario: scenarioOverrideValue,
        examples: exampleMessagesValue,
        system_prompt: systemPromptValue,
    };

    // Keep edits local until the popup is closed/confirmed
    const $scenario = $template.find('.chat_scenario');
    $scenario.val(scenarioOverrideValue).on('input', function () {
        pendingChanges.scenario = String($(this).val());
    });
    const $examples = $template.find('.chat_examples');
    $examples.val(exampleMessagesValue).on('input', function () {
        pendingChanges.examples = String($(this).val());
    });
    const $systemPrompt = $template.find('.chat_system_prompt');
    $systemPrompt.val(systemPromptValue).on('input', function () {
        pendingChanges.system_prompt = String($(this).val());
    });

    $template.find('.remove_scenario_override').on('click', async function () {
        const confirm = await Popup.show.confirm(t`Are you sure you want to remove all overrides?`, t`This action cannot be undone.`);
        if (!confirm) {
            return;
        }

        $scenario.val('');
        pendingChanges.scenario = '';
        $examples.val('');
        pendingChanges.examples = '';
        $systemPrompt.val('');
        pendingChanges.system_prompt = '';
    });

    // Wait for popup close/confirm.
    await callGenericPopup($template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    chat_metadata.scenario = pendingChanges.scenario;
    chat_metadata.mes_example = pendingChanges.examples;
    chat_metadata.system_prompt = pendingChanges.system_prompt;
    await saveMetadata();
}

/**
 * Displays a blocking popup with a given text and type.
 * @param {JQuery<HTMLElement>|string|Element} text - Text to display in the popup.
 * @param {string} type
 * @param {string} inputValue - Value to set the input to.
 * @param {PopupOptions} options - Options for the popup.
 * @typedef {{okButton?: string, rows?: number, wide?: boolean, wider?: boolean, large?: boolean, allowHorizontalScrolling?: boolean, allowVerticalScrolling?: boolean, cropAspect?: number }} PopupOptions - Options for the popup.
 * @returns {Promise<any>} A promise that resolves when the popup is closed.
 * @deprecated Use `callGenericPopup` instead.
 */
export function callPopup(text, type, inputValue = '', { okButton, rows, wide, wider, large, allowHorizontalScrolling, allowVerticalScrolling, cropAspect } = {}) {
    function getOkButtonText() {
        if (['text', 'char_not_selected'].includes(popup_type)) {
            $dialoguePopupCancel.css('display', 'none');
            return okButton ?? t`Ok`;
        } else if (['delete_extension'].includes(popup_type)) {
            return okButton ?? t`Ok`;
        } else if (['new_chat', 'confirm'].includes(popup_type)) {
            return okButton ?? t`Yes`;
        } else if (['input'].includes(popup_type)) {
            return okButton ?? t`Save`;
        }
        return okButton ?? t`Delete`;
    }

    dialogueCloseStop = true;
    if (type) {
        popup_type = type;
    }

    const $dialoguePopup = $('#dialogue_popup');
    const $dialoguePopupCancel = $('#dialogue_popup_cancel');
    const $dialoguePopupOk = $('#dialogue_popup_ok');
    const $dialoguePopupInput = $('#dialogue_popup_input');
    const $dialoguePopupText = $('#dialogue_popup_text');
    const $shadowPopup = $('#shadow_popup');

    $dialoguePopup.toggleClass('wide_dialogue_popup', !!wide)
        .toggleClass('wider_dialogue_popup', !!wider)
        .toggleClass('large_dialogue_popup', !!large)
        .toggleClass('horizontal_scrolling_dialogue_popup', !!allowHorizontalScrolling)
        .toggleClass('vertical_scrolling_dialogue_popup', !!allowVerticalScrolling);

    $dialoguePopupCancel.css('display', 'inline-block');
    $dialoguePopupOk.text(getOkButtonText());
    $dialoguePopupInput.toggle(popup_type === 'input').val(inputValue).attr('rows', rows ?? 1);
    $dialoguePopupText.empty().append(text);
    $shadowPopup.css('display', 'block');

    if (popup_type == 'input') {
        $dialoguePopupInput.trigger('focus');
    }

    $shadowPopup.transition({
        opacity: 1,
        duration: animation_duration,
        easing: animation_easing,
    });

    return new Promise((resolve) => {
        dialogueResolve = resolve;
    });
}

/**
 * Update the swipe counter for mesId.
 * By default, the swipe counter's opacity will appear greyed out. The opacity is changed with CSS.
 * @param {Number} mesId
 * @param {object} [options] Options
 * @param {ChatMessage} [options.message=undefined] Swipe numbers from this message will be used instead of mesId.
 * @param {JQuery<HTMLElement>} [options.messageElement=undefined] Target Element. Passing in the message's element will save a DOM query.
 */
export async function updateSwipeCounter(mesId, { message = undefined, messageElement = undefined } = {}) {
    message ??= chat[mesId];
    messageElement ??= chatElement.children('.mes').filter(`[mesid="${mesId}"]`);

    //If the message does not have swipes, create them.
    if (ensureSwipes(message)) {
        syncMesToSwipe(mesId);
    }

    const swipeCounterText = formatSwipeCounter((message?.swipe_id + 1), message?.swipes?.length);
    const swipeCounter = messageElement.find('.swipes-counter');
    const swipePickerButton = messageElement.find('.mes_swipe_picker');
    const canOpenSwipePicker = canOpenSwipePickerForMessage(mesId);
    const canJumpToSwipe = canJumpToSwipeForMessage(mesId);

    swipeCounter
        .text(swipeCounterText)
        .prop('hidden', false)
        .toggleClass('swipe-picker-enabled', canOpenSwipePicker)
        .toggleClass(INTERACTABLE_CONTROL_CLASS, canOpenSwipePicker)
        .attr('role', canOpenSwipePicker ? 'button' : null)
        .attr('title', canJumpToSwipe ? t`Click to jump to a swipe` : canOpenSwipePicker ? t`Click to view swipe history` : null);
    swipePickerButton.toggle(canOpenSwipePicker);

    if (!canOpenSwipePicker) {
        swipeCounter.removeAttr('tabindex');
    }
}

/**
 * Returns true if messages are generally swipeable.
 * @returns {boolean}
 */
export function isSwipingAllowed() {
    return (
        //Swipe cannot be called on an empty chat.
        chat.length !== 0 &&
        //The swipes setting must be enabled, and swipes can't be hidden.
        swipes && !swipesHidden &&
        //Cannot swipe while generating.
        !isGenerating() &&
        //If mid-swipe, the message cannot be swiped.
        swipeState === SWIPE_STATE.NONE
    );
}

/**
 * Returns true if the message is swipeable.
 * This does not check if messages are generally swipeable. See isSwipingAllowed().
 * This does not check if the swipes exist or are valid.
 * @param {number} messageId The message Id to check.
 * @param {ChatMessage} [message=undefined] If undefined, then the message checks will be skipped.
 * @returns {boolean}
 */
export function isMessageSwipeable(messageId, message = undefined) {
    message ??= chat[messageId];

    //If the message does not have swipes, create them.
    if (ensureSwipes(message)) {
        syncMesToSwipe(messageId);
    }

    if (
        //Only messages below the currently edited message can be swiped, if it's not mid-swipe edit.
        ((messageId > (this_edit_mes_id ?? -1)) && (swipeState != SWIPE_STATE.EDITING)) &&

        //If the message is the last message, and it exists.
        (messageId == chat.length - 1) &&
        (message &&
            //Small system messages cannot be swiped.
            !(message?.extra?.isSmallSys) &&
            //Some messages, like the welcome screen, are not swipeable.
            !(message?.extra?.swipeable === false) &&
            //User messages are not swipeable.
            !message.is_user
        )
    ) {
        // The message is swipeable.
        return true;
    } else {
        // The message is not swipeable.
        return false;
    }
}

/**
 * Returns the message's behavior when swiped past it's last branch.
 * This does not check if the message can currently be swiped. See isMessageSwipeable().
 * This does not check if messages are generally swipeable. See isSwipingAllowed().
 * This does not check if the swipes exist or are valid.
 * @param {number} messageId The message Id to check.
 * @param {ChatMessage} [message=undefined] If defined, this will be used instead of chat[messageId].
 * @returns {OVERSWIPE_BEHAVIOR}
 */
export function getOverswipeBehavior(messageId, message = undefined) {
    message ??= chat[messageId];

    const isPristine = !chat_metadata?.tainted;
    const isGreeting = messageId === 0;

    //Do not override explicitly set overswipe_behavior.
    if (typeof message?.extra?.overswipe_behavior == 'string') return message.extra.overswipe_behavior;
    //Some messages, like the welcome screen, are not swipeable.
    else if (message?.extra?.swipeable === false) return OVERSWIPE_BEHAVIOR.NONE;
    //Small System messages can't be swiped.
    else if (message?.extra?.isSmallSys) return OVERSWIPE_BEHAVIOR.NONE;
    //The first message in a priistine chat will loop. It's chevrons will always be visible https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3557893373
    else if (isGreeting && isPristine) return OVERSWIPE_BEHAVIOR.PRISTINE_GREETING;
    //Non-user and non-prompt hidden messages will regenerate.
    else if (!message?.is_user && !message?.is_system) return OVERSWIPE_BEHAVIOR.REGENERATE;
    //By default, all other messages will loop. Their swipe chevrons will only be shown if there is more than one swipe.
    else { return OVERSWIPE_BEHAVIOR.LOOP; }
}

/**
 * Refreshes all swipe buttons and updates their swipe counters.
 * This has been optimized for bulk updates by minimizing DOM queries.
 * @param {boolean} updateCounters When true, the swipe counters will also be updated. Typically redundant because addOneMessage updates the counters.
 * @param {boolean} fade By default, the chevrons fade in and out.
 * @returns
 */
export function refreshSwipeButtons(updateCounters = false, fade = true) {
    //Never show swipe buttons on an empty chat.
    if (chat?.length === 0) return false;

    //If swipes are disabled or hidden, hide all swipe buttons.
    if (!isSwipingAllowed()) {
        $('body').addClass('hideAllSwipeButtons');
        return;
        //Don't hide all swipe buttons.
    } else {
        //CSS will hide all messages.
        $('body').removeClass('hideAllSwipeButtons');
    }
    //Non-messages can appear in chat. '.mes' is required.
    const messageElements = chatElement.children('.mes[mesid]');

    const firstDisplayedMesId = Number(messageElements.first().attr('mesid'));

    //Group each message.
    messageElements.each((index, div) => {
        //This assumes the messages are in order and their Id's are accurate.
        const messageId = firstDisplayedMesId + index;
        //Number($(div).attr('mesid')); Would not misscount due to a missing div, but is much slower.

        const message = chat[messageId];

        //Chevrons should not fade-in during printMessages. //https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3539315919
        div.classList.toggle('fade', fade);

        if (isMessageSwipeable(messageId, message)) {
            //If a right swipe would trigger a generation or loop to the first swipe.
            const isLastSwipe = (message?.swipes?.length ?? 1) - 1 <= (message?.swipe_id ?? 0);
            const hasSwipes = (message?.swipes?.length > 1);
            const overswipe = getOverswipeBehavior(messageId, message);
            const swipePickerButton = $(div).find('.mes_swipe_picker');
            const canOpenSwipePicker = canOpenSwipePickerForMessage(messageId);

            // Chevrons should always be shown on pristine greetings: https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3557893373
            const pristineGreeting = overswipe == OVERSWIPE_BEHAVIOR.PRISTINE_GREETING;

            //The swipe button will be shown if an overswipe would trigger REGENERATE or EDIT_GENERATE.
            const isOverswipeable = isLastSwipe &&
                overswipe == OVERSWIPE_BEHAVIOR.REGENERATE ||
                overswipe == OVERSWIPE_BEHAVIOR.EDIT_GENERATE;

            div.classList.toggle('last_swipe', isOverswipeable);

            //If there's only one swipe, the left arrow should not be shown.
            div.classList.toggle('swipes_visible', hasSwipes || pristineGreeting);
            swipePickerButton.toggle(canOpenSwipePicker);

            //updateSwipeCounter does not need to be awaited, It can run a bit later.
            if (updateCounters) updateSwipeCounter(messageId, { message, messageElement: $(div) });
        } else {
            //Hide all messages that are not swipeable.
            div.classList.remove('swipes_visible', 'last_swipe');
            $(div).find('.mes_swipe_picker').toggle(canOpenSwipePickerForMessage(messageId));
        }
    });
}
/**
 * This function is misleadingly named. It allows generation then refreshes the swipe buttons and counters.
 */
export function showSwipeButtons() {
    swipesHidden = false;
    refreshSwipeButtons();
}

/**
 * This function is misleadingly named. It blocks generation then refreshes the swipe buttons and counters.
 * @param {object} [options] Options
 * @param {boolean} [options.hideCounters=false] Also hide the swipes counter.
 */
export function hideSwipeButtons({ hideCounters = false } = {}) {
    swipesHidden = true;
    refreshSwipeButtons();

    if (hideCounters === true) {
        chatElement.find('.last_mes .swipes-counter').prop('hidden', true);
    }
}

/**
 * Deletes a swipe from the chat.
 *
 * @param {number?} [swipeId = null] - The ID of the swipe to delete. If not provided, the current swipe will be deleted.
 * @param {number?} [messageId = chat.length - 1] - The ID of the message to delete from. If not provided, the last message will be targeted.
 * @returns {Promise<number>|undefined} - The ID of the new swipe after deletion.
 */
export async function deleteSwipe(swipeId = null, messageId = chat.length - 1) {
    if (swipeId != null) {
        swipeId = Number(swipeId);
        if (!Number.isInteger(swipeId) || swipeId < 0) {
            toastr.warning(t`Invalid swipe ID.`);
            return;
        }
    }

    const message = chat[messageId];
    if (!message || !Array.isArray(message.swipes) || !message.swipes.length) {
        toastr.warning(t`No messages to delete swipes from.`);
        return;
    }

    if (message.swipes.length <= 1) {
        toastr.warning(t`Can't delete the last swipe.`);
        return;
    }

    swipeId = Number(swipeId ?? message.swipe_id);
    const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);

    if (swipeId < 0 || swipeId >= message.swipes.length) {
        toastr.warning(t`Invalid swipe ID: ${swipeId + 1}`);
        return;
    }

    message.swipes.splice(swipeId, 1);

    if (Array.isArray(message.swipe_info) && message.swipe_info.length) {
        message.swipe_info.splice(swipeId, 1);
    }

    let newSwipeId;
    if (swipeId < currentSwipeId) {
        newSwipeId = currentSwipeId - 1;
    } else if (swipeId > currentSwipeId) {
        newSwipeId = currentSwipeId;
    } else {
        // Select the next swipe, or the one before if it was the last one.
        newSwipeId = Math.min(swipeId, message.swipes.length - 1);
    }

    chat_metadata.tainted = true;

    messageId = Number(messageId);
    swipeId = Number(swipeId);
    message.swipe_id = newSwipeId;
    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId, swipeId, newSwipeId });

    if (swipeId === currentSwipeId) {
        const direction = (swipeId <= newSwipeId) ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        // Animate swipe and swap displayed message when the currently visible swipe was deleted.
        await swipe(null, direction, { source: SWIPE_SOURCE.DELETE, repeated: false, forceMesId: messageId, forceSwipeId: newSwipeId });
    } else {
        await updateSwipeCounter(messageId);
        if (messageId !== chat.length - 1) {
            await updateSwipeCounter(chat.length - 1);
        }
        refreshSwipeButtons();
        saveChatDebounced();
    }

    const patched = await patchChatMessages([
        { op: 'replace', path: `/${messageId}`, value: chat[messageId] },
    ]);
    if (!patched) {
        await saveChatConditional();
    }

    return newSwipeId;
}

export async function saveMetadata(options = {}) {
    const withMetadata = (options && typeof options === 'object') ? options.withMetadata : undefined;

    try {
        await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);
    } catch {
        console.warn('Timeout waiting for chat to save');
        return;
    }

    try {
        cancelDebouncedChatSave();
        const saveContext = buildActiveChatSaveContext({ withMetadata });
        if (!saveContext) {
            return;
        }

        await runSerializedChatWrite(async () => {
            activeChatSaveContext = saveContext;
            isChatSaving = true;

            const saved = await saveChatMetadataInternal(withMetadata, 0, saveContext);
            if (!saved) {
                if (saveContext.kind === 'group') {
                    await saveGroupChat(saveContext.groupId, true, false, 0, { ...saveContext, skipSerialization: true });
                } else {
                    await saveChatInternal({ withMetadata, _context: saveContext });
                }
            }

            finishActiveChatSaveContext(saveContext);
        });
    } catch (error) {
        console.error('Error saving chat metadata', error);
    } finally {
        activeChatSaveContext = null;
        isChatSaving = false;
    }
}

export async function saveChatConditional() {
    try {
        await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);
    } catch {
        console.warn('Timeout waiting for chat to save');
        return;
    }

    try {
        cancelDebouncedChatSave();
        const saveContext = buildActiveChatSaveContext();
        if (!saveContext) {
            return;
        }

        await runSerializedChatWrite(async () => {
            activeChatSaveContext = saveContext;
            isChatSaving = true;

            if (saveContext.kind === 'group') {
                await saveGroupChat(saveContext.groupId, true, false, 0, { ...saveContext, skipSerialization: true });
            }
            else {
                await saveChatInternal({ _context: saveContext });
            }

            finishActiveChatSaveContext(saveContext);
        });
    } catch (error) {
        console.error('Error saving chat', error);
    } finally {
        activeChatSaveContext = null;
        isChatSaving = false;
    }
}

/**
 * Saves the chat to the server.
 * @param {FormData} formData Form data to send to the server.
 * @param {object} [options={}] Options for the import
 * @param {boolean} [options.refresh] Whether to refresh the group chat list after import
 * @returns {Promise<string[]>} List of imported file names.
 */
export async function importCharacterChat(formData, { refresh = true } = {}) {
    const fetchResult = await fetch('/api/chats/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (fetchResult.ok) {
        const data = await fetchResult.json();
        if (data.res && refresh) {
            await displayPastChats();
        }
        return data?.fileNames || [];
    }

    return [];
}

export function updateViewMessageIds(startIndex = null) {
    const minId = startIndex ?? getFirstDisplayedMessageId();

    chatElement.find('.mes').each(function (index, element) {
        $(element).attr('mesid', minId + index);
        $(element).find('.mesIDDisplay').text(`#${minId + index}`);
    });

    chatElement.find('.mes').removeClass('last_mes');
    chatElement.find('.mes').last().addClass('last_mes');

    updateEditArrowClasses();
}

export function getFirstDisplayedMessageId() {
    const allIds = Array.from(document.querySelectorAll('#chat .mes')).map(el => Number(el.getAttribute('mesid'))).filter(x => !isNaN(x));
    const minId = Math.min(...allIds);
    return minId;
}

export function updateEditArrowClasses() {
    if (!(this_edit_mes_id >= 0)) {
        return;
    }

    const message = chatElement.children('.mes').filter(`.mes[mesid="${this_edit_mes_id}"]`);

    const downButton = message.find('.mes_edit_down');
    const upButton = message.find('.mes_edit_up');
    const copyButton = message.find('.mes_edit_copy');
    const deleteButton = message.find('.mes_edit_delete');
    const lastId = Number(chatElement.find('.mes').last().attr('mesid'));
    const firstId = Number(chatElement.find('.mes').first().attr('mesid'));

    copyButton.removeClass('disabled');
    deleteButton.removeClass('disabled');

    // The last message cannot be moved down.
    downButton.toggleClass('disabled', lastId === Number(this_edit_mes_id));
    // The first message cannot be moved up.
    upButton.toggleClass('disabled', firstId === Number(this_edit_mes_id));
}

/**
 * Closes the message editor.
 * @param {'message'|'reasoning'|'all'} what What to close. Default is 'all'.
 */
export function closeMessageEditor(what = 'all') {
    if (what === 'message' || what === 'all') {
        if (this_edit_mes_id >= 0) {
            chatElement.find(`.mes[mesid="${this_edit_mes_id}"] .mes_edit_cancel`).trigger('click');
        }
    }
    if (what === 'reasoning' || what === 'all') {
        document.querySelectorAll('.reasoning_edit_textarea').forEach((el) => {
            const cancelButton = el.closest('.mes')?.querySelector('.mes_reasoning_edit_cancel');
            if (cancelButton instanceof HTMLElement) {
                cancelButton.click();
            }
        });
    }
}

export function setGenerationProgress(progress) {
    if (!progress) {
        $('#send_textarea').css({ 'background': '', 'transition': '' });
    } else {
        $('#send_textarea').css({
            'background': `linear-gradient(90deg, #008000d6 ${progress}%, transparent ${progress}%)`,
            'transition': '0.25s ease-in-out',
        });
    }
}

export function cancelTtsPlay() {
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}

function updateAlternateGreetingsHintVisibility(root) {
    const numberOfGreetings = root.find('.alternate_greetings_list .alternate_greeting').length;
    $(root).find('.alternate_grettings_hint').toggle(numberOfGreetings == 0);
}

async function openCharacterWorldPopup() {
    const chid = $('#set_character_world').data('chid');
    if (menu_type != 'create' && chid === undefined) {
        toastr.error('Does not have an Id for this character in world select menu.');
        return;
    }

    // TODO: Maybe make this utility function not use the window context?
    const fileName = getCharaFilename(chid);
    const charName = (menu_type == 'create' ? create_save.name : characters[chid]?.data?.name) || 'Nameless';
    const worldId = (menu_type == 'create' ? create_save.world : characters[chid]?.data?.extensions?.world) || '';
    const template = $('#character_world_template .character_world').clone();
    template.find('.character_name').text(charName);

    // --- Event Handlers ---
    async function handlePrimaryWorldSelect() {
        const selectedValue = $(this).val();
        const worldIndex = selectedValue !== '' ? Number(selectedValue) : NaN;
        const name = !isNaN(worldIndex) ? world_names[worldIndex] : '';
        await charUpdatePrimaryWorld(name);
    }

    function handleExtrasWorldSelect(evt) {
        const el = evt?.currentTarget ?? this;
        const selectedValues = $(el).val();
        const selected = Array.isArray(selectedValues) ? selectedValues : [];
        const fileName = getCharaFilename(null, {});
        const nextList = selected.map(i => world_names[i]).filter(Boolean);
        charSetAuxWorlds(fileName, nextList);
    }

    // --- Populate Dropdowns ---
    // Append to primary dropdown.
    const primarySelect = template.find('.character_world_info_selector');
    world_names.forEach((item, i) => {
        primarySelect.append(new Option(item, String(i), item === worldId, item === worldId));
    });

    // Append to extras dropdown.
    const extrasSelect = template.find('.character_extra_world_info_selector');
    const existingCharLore = world_info.charLore?.find((e) => e.name === fileName);
    world_names.forEach((item, i) => {
        const array = (menu_type == 'create' ? create_save.extra_books : existingCharLore?.extraBooks);
        const isSelected = !!array?.includes(item);
        extrasSelect.append(new Option(item, String(i), isSelected, isSelected));
    });

    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        onOpen: function (popup) {
            const popupDialog = $(popup.dlg);

            primarySelect.on('change', handlePrimaryWorldSelect);
            extrasSelect.on('change', handleExtrasWorldSelect);

            // Not needed on mobile.
            if (!isMobile()) {
                extrasSelect.select2({
                    width: '100%',
                    placeholder: t`No auxiliary Lorebooks set. Click here to select.`,
                    allowClear: true,
                    closeOnSelect: false,
                    dropdownParent: popupDialog,
                });
            }
        },
    });

    await popup.show();
}

function openAlternateGreetings() {
    const chid = $('.open_alternate_greetings').data('chid');

    if (menu_type != 'create' && chid === undefined) {
        toastr.error('Does not have an Id for this character in editor menu.');
        return;
    } else {
        // If the character does not have alternate greetings, create an empty array
        if (characters[chid] && !Array.isArray(characters[chid].data.alternate_greetings)) {
            characters[chid].data.alternate_greetings = [];
        }
    }

    const template = $('#alternate_greetings_template .alternate_grettings').clone();
    const getArray = () => menu_type == 'create' ? create_save.alternate_greetings : characters[chid].data.alternate_greetings;
    const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClose: async () => {
            if (menu_type !== 'create') {
                await createOrEditCharacter();
            }
        },
    });

    for (let index = 0; index < getArray().length; index++) {
        addAlternateGreeting(template, getArray()[index], index, getArray, popup);
    }

    template.find('.add_alternate_greeting').on('click', function () {
        const array = getArray();
        const index = array.length;
        array.push('');
        addAlternateGreeting(template, '', index, getArray, popup);
        updateAlternateGreetingsHintVisibility(template);
        const list = template.find('.alternate_greetings_list');
        list.scrollTop(list.prop('scrollHeight'));
    });

    popup.show();
    updateAlternateGreetingsHintVisibility(template);
}

/**
 * Adds an alternate greeting to the template.
 * @param {JQuery<HTMLElement>} template
 * @param {string} greeting
 * @param {number} index
 * @param {() => any[]} getArray
 * @param {Popup} popup
 */
function addAlternateGreeting(template, greeting, index, getArray, popup) {
    const greetingBlock = $('#alternate_greeting_form_template .alternate_greeting').clone();
    greetingBlock.attr('data-index', index);
    greetingBlock.find('.alternate_greeting_text')
        .attr('id', `alternate_greeting_${index}`)
        .on('input', async function () {
            const value = $(this).val();
            const array = getArray();
            array[index] = value;
        }).val(greeting);
    greetingBlock.find('.editor_maximize').attr('data-for', `alternate_greeting_${index}`);
    greetingBlock.find('.greeting_index').text(index + 1);
    greetingBlock.find('.delete_alternate_greeting').on('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();

        const confirm = await callGenericPopup(t`Are you sure you want to delete this alternate greeting?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }

        const array = getArray();
        array.splice(index, 1);

        // We need to reopen the popup to update the index numbers
        await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        openAlternateGreetings();
    });
    greetingBlock.find('.move_up_alternate_greeting').on('click', function (event) {
        handleMoveAlternateGreeting(event, -1);
    });
    greetingBlock.find('.move_down_alternate_greeting').on('click', function (event) {
        handleMoveAlternateGreeting(event, 1);
    });

    /**
     * Handles moving an alternate greeting up or down in the list.
     * @param {JQuery.ClickEvent} event - The click event
     * @param {number} direction - Direction to move: -1 for up, 1 for down
     */
    function handleMoveAlternateGreeting(event, direction) {
        event.preventDefault();
        event.stopPropagation();

        const array = getArray();
        const index = Number(greetingBlock.attr('data-index'));
        const newIndex = index + direction;

        // Check bounds
        if (direction === -1 && index <= 0) {
            return;
        }
        if (direction === 1 && index >= array.length - 1) {
            return;
        }

        // Swap the greetings
        [array[index], array[newIndex]] = [array[newIndex], array[index]];

        // Update current greeting
        greetingBlock.find('.alternate_greeting_text').val(array[index]);

        // Update adjacent greeting
        const adjacentGreetingBlock = template.find(`.alternate_greeting[data-index="${newIndex}"]`);
        adjacentGreetingBlock.find('.alternate_greeting_text').val(array[newIndex]);
    }

    template.find('.alternate_greetings_list').append(greetingBlock);
}

/**
 * Creates or edits a character based on the form data.
 * @param {Event} [e] Event that triggered the function call.
 */
export async function createOrEditCharacter(e) {
    if (isCharacterDeletionInProgress) {
        return;
    }

    $('#rm_info_avatar').html('');
    const formData = new FormData(/** @type {HTMLFormElement} */($('#form_create').get(0)));
    formData.set('fav', String(fav_ch_checked));
    const isNewChat = e instanceof CustomEvent && e.type === 'newChat';

    const rawFile = formData.get('avatar');
    if (rawFile instanceof File) {
        const convertedFile = await ensureImageFormatSupported(rawFile);
        formData.set('avatar', convertedFile);
    }

    const headers = getRequestHeaders({ omitContentType: true });

    if ($('#form_create').attr('actiontype') == 'createcharacter') {
        if (String($('#character_name_pole').val()).length === 0) {
            toastr.error(t`Name is required`);
            return;
        }
        if (is_group_generating || is_send_press) {
            toastr.error(t`Cannot create characters while generating. Stop the request and try again.`, t`Creation aborted`);
            return;
        }
        try {
            //if the character name text area isn't empty (only posible when creating a new character)
            let url = '/api/characters/create';

            if (crop_data != undefined) {
                url += `?crop=${encodeURIComponent(JSON.stringify(crop_data))}`;
            }

            formData.delete('alternate_greetings');
            for (const value of create_save.alternate_greetings) {
                formData.append('alternate_greetings', value);
            }

            formData.append('extensions', JSON.stringify(create_save.extensions));

            const fetchResult = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: formData,
                cache: 'no-cache',
            });

            if (!fetchResult.ok) {
                throw new Error('Fetch result is not ok');
            }

            const avatarId = await fetchResult.text();

            $('#character_cross').trigger('click'); //closes the advanced character editing popup
            const fields = [
                { id: '#character_name_pole', callback: value => create_save.name = value },
                { id: '#description_textarea', callback: value => create_save.description = value },
                { id: '#creator_notes_textarea', callback: value => create_save.creator_notes = value },
                { id: '#character_version_textarea', callback: value => create_save.character_version = value },
                { id: '#post_history_instructions_textarea', callback: value => create_save.post_history_instructions = value },
                { id: '#system_prompt_textarea', callback: value => create_save.system_prompt = value },
                { id: '#tags_textarea', callback: value => create_save.tags = value },
                { id: '#creator_textarea', callback: value => create_save.creator = value },
                { id: '#personality_textarea', callback: value => create_save.personality = value },
                { id: '#firstmessage_textarea', callback: value => create_save.first_message = value },
                { id: '#talkativeness_slider', callback: value => create_save.talkativeness = value, defaultValue: talkativeness_default },
                { id: '#scenario_pole', callback: value => create_save.scenario = value },
                { id: '#depth_prompt_prompt', callback: value => create_save.depth_prompt_prompt = value },
                { id: '#depth_prompt_depth', callback: value => create_save.depth_prompt_depth = value, defaultValue: depth_prompt_depth_default },
                { id: '#depth_prompt_role', callback: value => create_save.depth_prompt_role = value, defaultValue: depth_prompt_role_default },
                { id: '#mes_example_textarea', callback: value => create_save.mes_example = value },
                { id: '#character_json_data', callback: () => { } },
                { id: '#alternate_greetings_template', callback: value => create_save.alternate_greetings = value, defaultValue: [] },
                { id: '#character_world', callback: value => create_save.world = value },
                { id: '#_character_extensions_fake', callback: value => create_save.extensions = {} },
            ];

            fields.forEach(field => {
                const fieldValue = field.defaultValue !== undefined ? field.defaultValue : '';
                $(field.id).val(fieldValue);
                field.callback && field.callback(fieldValue);
            });

            if (Array.isArray(create_save.extra_books) && create_save.extra_books.length > 0) {
                const fileName = getCharaFilename(null, { manualAvatarKey: avatarId });
                const charLore = world_info.charLore ?? [];
                charLore.push({ name: fileName, extraBooks: create_save.extra_books });
                Object.assign(world_info, { charLore: charLore });
                saveSettingsDebounced();
            }
            create_save.extra_books = [];

            $('#character_popup-button-h3').text('Create character');

            create_save.avatar = null;

            $('#add_avatar_button').replaceWith(
                $('#add_avatar_button').val('').clone(true),
            );

            let oldSelectedChar = null;
            if (this_chid !== undefined) {
                oldSelectedChar = characters[this_chid].avatar;
            }

            console.log(`new avatar id: ${avatarId}`);
            createTagMapFromList('#tagList', avatarId);
            await getCharacters();

            select_rm_info('char_create', avatarId, oldSelectedChar);

            crop_data = undefined;
        } catch (error) {
            console.error('Error creating character', error);
            toastr.error(t`Failed to create character`);
        }
    } else {
        try {
            let url = '/api/characters/edit';

            if (crop_data != undefined) {
                url += `?crop=${encodeURIComponent(JSON.stringify(crop_data))}`;
            }

            formData.delete('alternate_greetings');
            const chid = $('.open_alternate_greetings').data('chid');
            if (characters[chid] && Array.isArray(characters[chid]?.data?.alternate_greetings)) {
                for (const value of characters[chid].data.alternate_greetings) {
                    formData.append('alternate_greetings', value);
                }
            }

            const fetchResult = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: formData,
                cache: 'no-cache',
            });

            if (!fetchResult.ok) {
                throw new Error('Fetch result is not ok');
            }

            await getOneCharacter(formData.get('avatar_url'));
            favsToHotswap(); // Update fav state

            $('#add_avatar_button').replaceWith(
                $('#add_avatar_button').val('').clone(true),
            );
            $('#create_button').attr('value', 'Save');
            crop_data = undefined;
            await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: this_chid, character: characters[this_chid] } });

            await regenerateFirstCharacterMessageIfNeeded({ isNewChat });
        } catch (error) {
            console.log(error);
            toastr.error(t`Something went wrong while saving the character, or the image file provided was in an invalid format. Double check that the image is not a webp.`);
        }
    }
}

/**
 * Formats a counter for a swipe view.
 * @param {number} current The current number of items.
 * @param {number} total The total number of items.
 * @returns {string} The formatted counter.
 */
function formatSwipeCounter(current, total) {
    if (isNaN(current) && isNaN(total)) {
        return '';
    }
    return `${!isNaN(current) ? current : '?'}\u200b/\u200b${!isNaN(total) ? total : '?'}`;
}

/**
 * Handles the swipe event.
 * @param {SwipeEvent} event Event.
 * @param {SWIPE_DIRECTION} direction The direction to swipe.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source]  The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {ChatMessage} [params.message=chat[chat.length - 1]] The chat message to swipe.
 * @param {number} [params.forceMesId] The message id to swipe.
 * @param {number} [params.forceSwipeId] The target swipe_id. When out of range, it will be looped or clamped.
 * @param {number} [params.forceDuration] Overwrites the default swipe duration.
 */
export async function swipe(event, direction, { source, repeated, message = chat[chat.length - 1], forceMesId, forceSwipeId, forceDuration } = {}) {
    if (chat.length === 0) {
        console.warn('Swipe was called on an empty chat.');
        return;
    }

    let messageIndex;

    //Only set messageIndex if message exists because -1 is truthy.
    if (message) {
        messageIndex = chat.indexOf(message);
        if (messageIndex === -1 && typeof (forceMesId) != 'number') {
            console.error(`The message must exist in chat. ${message};`);
            return;
        }
    }

    const mesId = Number(forceMesId ?? event?.currentTarget?.closest('.mes')?.getAttribute('mesid') ?? messageIndex ?? chat.length - 1);

    if ([SWIPE_SOURCE.DELETE, SWIPE_SOURCE.BACK, SWIPE_SOURCE.AUTO_SWIPE, SWIPE_SOURCE.SLASH_COMMAND, SWIPE_SOURCE.SWIPE_PICKER].includes(source)) {
        console.info(`The ${direction} swipe source on message #${mesId} is ${source}, Most checks have been bypassed. `);
    } else {
        //Only show an error if swipes are not hidden and a message is generating.
        if (isGenerating() && (swipes && !swipesHidden && (swipeState === SWIPE_STATE.NONE))) {
            toastr.warning(t`Cannot swipe while generating. Stop the request and try again.`, t`Swipe aborted`);
            return;
        }
        //Only allow one concurrent swipe.
        if (!isSwipingAllowed()) {
            console.info('The swipe has been ignored messages cannot currently be swiped.');
            return;
        }
        if (!isMessageSwipeable(mesId, message)) {
            console.info(`Message #${mesId} cannot be swiped. ${message}`);
            return;
        }
    }

    // Cancel pending save to prevent accidental swipe_id overwrites.
    cancelDebouncedChatSave();

    swipeState = SWIPE_STATE.SWIPING;
    let generation;

    const thisMesDiv = chatElement.children('.mes').filter(`[mesid="${mesId}"]`);
    const thisMesText = thisMesDiv.find('.mes_block .mes_text');
    const thisMesDivHeight = thisMesDiv[0]?.scrollHeight;
    const thisMesTextHeight = thisMesText[0]?.scrollHeight;
    if (![thisMesDiv.length, thisMesText.length].every(num => num > 0)) {
        console.error(`Message #${mesId}'s DOM element is not valid.`);
        return;
    }
    const originalSwipeId = Number(chat[mesId]?.swipe_id ?? 0);
    let newSwipeId = Number(forceSwipeId ?? originalSwipeId);

    /**
     * Calculates the next swipe duration with how many swipes have been repeated.
     * @param {number} animation_duration
     * @returns {number} The adjusted swipe duration.
     */
    function getSwipeDuration(animation_duration) {
        const now = performance.now();
        const resetTime = animation_duration * 2 + 300;

        //Reset the counter if the last swipe was more than half a second ago.
        if (now - lastSwipeInfo.now >= resetTime || direction !== lastSwipeInfo.direction) recentSwipes = 0;
        recentSwipes++;
        lastSwipeInfo = { now, direction };

        //At 4 swipes, animation_duration will be halved.
        const sigmoid = 1 / (1 + Math.exp(recentSwipes - 4));

        return animation_duration * sigmoid;
    }

    const swipeDuration = forceDuration ?? getSwipeDuration(animation_duration);

    //The offscreen messages may be visible if the user resizes the viewport during a swipe.
    const thisMesDivWidth = thisMesDiv.width() + 30;
    let swipeRange = (direction === SWIPE_DIRECTION.RIGHT) ? -thisMesDivWidth : thisMesDivWidth;

    /**
     * Waits for the generation to end, reverts the swipe if swipe_id has not changed.
     * @param {boolean} revert Attept to revert the swipe without saving.
     */
    async function endSwipe(revert = false) {
        //Wait for the generation to end.
        try {
            //`mes_buttons` need to be hidden until the animation completes.
            if (generation) {
                document.body.dataset.swiping = 'true';
                await generation;
            }
        } catch (error) {
            console.warn(`Swipe failed, Swiping back. ${error}`);
        }

        //Clamp Id between swipes.
        let clampedId = clamp(chat[mesId].swipe_id, 0, Math.max(0, chat[mesId].swipes.length - 1));

        await updateSwipeCounter(mesId);
        //Fallback.
        if (mesId != chat.length - 1) {
            await updateSwipeCounter(chat.length - 1);
        }

        // If swipe_id has not changed, give the user feedback.
        if (clampedId == originalSwipeId && source != SWIPE_SOURCE.DELETE) {
            try {
                //Shake 700/140=5px
                shakeElement(thisMesDiv, -swipeRange / 140, animation_duration, 'ease-in');
                //Flash red.
                const flashTime = Math.max(animation_duration * 2, 100);
                await Promise.race([thisMesDiv.find('.swipes-counter').animate({ color: 'red' }, flashTime).animate({ color: '' }).promise(), createTimeout(flashTime * 4, `The shake animation did not end within ${flashTime * 4}ms`)].filter(Boolean));
            } catch (error) {
                console.warn(error);
            }
        }

        //If the id is not within bounds, Swipe back.
        if (chat[mesId]?.swipe_id !== clampedId || revert) {
            // Prevent recursion.
            if (source != SWIPE_SOURCE.BACK) {
                source = SWIPE_SOURCE.BACK;
                chat[mesId].swipe_id = clampedId;

                //Update the chat.
                await loadFromSwipeId(mesId, chat[mesId].swipe_id);
                await redisplayChat({ startIndex: mesId });
            } else {
                await Popup.show.confirm(
                    t`ERROR: <code>syncSwipeToMes</code> has failed to revert the failed ${direction} swipe on message #${mesId}.`,
                    t`<p>After you click OK, the chat will be reloaded to prevent data corruption.</p>`,
                    { okButton: 'OK', cancelButton: false },
                );
                console.trace(`Error! Recursion detected when reverting failed ${direction} swipe on message #${mesId}. Something has broken.`);
                await reloadCurrentChat();
            }
            //Out of bounds swipes should not be saved.
        } else if (source != SWIPE_SOURCE.BACK) {
            //Save the chat if swipe_id has changed.
            saveChatDebounced();
        }

        //Allow for another swipe.
        swipeState = SWIPE_STATE.NONE;
        delete document.body.dataset.swiping;
        showSwipeButtons();
    }

    async function standardSwipe(newSwipeId) {
        //If swipe_id has changed, or the source is being deleted.
        if (newSwipeId !== originalSwipeId || source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
            //Update the chat.
            await loadFromSwipeId(mesId, newSwipeId);
            //Transition to the new chat.
            await animateSwipe();
        }
        await endSwipe();
    }

    /**
     * Removes a message's extra and gen times.
     * @param {ChatMessage} message
     */
    function clearMessageData(message) {
        if (message.extra && typeof message.extra === 'object') {
            delete message.extra.memory;
            delete message.extra.display_text;
            delete message.extra.media;
            delete message.extra.inline_image;
            delete message.extra.files;
            delete message.extra.fileLength;
            delete message.extra.generationType;
            delete message.extra.negative;
            delete message.extra.title;
            delete message.extra.append_title;
        }
        delete message.gen_started;
        delete message.gen_finished;
    }

    /**
     * Sets the message to the newSwipeId and loads it.
     * @param {number} mesId
     * @param {number} newSwipeId
     */
    async function loadFromSwipeId(mesId, newSwipeId) {
        //Update the swipe_id.
        chat[mesId].swipe_id = newSwipeId;

        clearMessageData(chat[mesId]);

        //Load from swipes.
        if (syncSwipeToMes(mesId, newSwipeId) == false) {
            let errorMessage = t`When swiping ${direction} on message ${mesId}, syncSwipeToMes has returned false. Attempting to swipe back!`;
            toastr.error(errorMessage);

            chat[mesId].swipe_id = originalSwipeId;
            await endSwipe(true);
        }
        return true;
    }

    /**
     * Animates a swipe for all messages >= mesId.
     * @param {number} mesId
     * @param {object} params
     * @param {string} [params.xStart='opx']
     * @param {string} [params.xEnd='0px']
     * @param {number} [params.duration=animation_duration]
     * @param {string} [params.classes=''] Additional CSS classes to target during the swipe.
     * @param {boolean} [params.freeze=true] When true, do not remove the class from the animation, leaving it stuck at xEnd.
     * @returns {Promise<boolean|Function>} endSlide unfreezes the messages from xEnd.
     */
    async function animateSwipeTransition(mesId, { xStart = '0px', xEnd = '0px', duration = animation_duration, classes = '', freeze = false } = {}) {
        // If the animation_duration is zero, the 'animationend' promise will never resolve.
        //Skip the animation if it's faster than 50ms.
        if (duration <= 50) return;

        //Select MAXIMUM_ANIMATED messages after mesId. Ideally, only visible messages would be animated.
        const MAXIMUM_ANIMATED = 100;

        const messages = chatElement.children('.mes');
        const firstDisplayedMesId = Number(messages.first().attr('mesid'));

        const swipedMessagesDiv = messages.filter((index, div) => {
            // const messageId = Number($(div).attr('mesid')); //Slower.
            //This assumes the messages are in order and their Id's are accurate.
            const divMessageId = firstDisplayedMesId + index;

            return (divMessageId < mesId + MAXIMUM_ANIMATED && divMessageId >= mesId);
        });
        if (swipedMessagesDiv.length > 0) {
            let swipeClasses = '.mes_block, .mesAvatarWrapper';
            swipeClasses += classes;

            //Select only the target classes.
            const swipedElementsDiv = swipedMessagesDiv.children(swipeClasses);
            if (swipedElementsDiv.length > 0) {
                //This is a global variable, only one swipe transition can occur concurrently.
                document.documentElement.style.setProperty('--slide-mes-x-start', xStart);
                document.documentElement.style.setProperty('--slide-mes-x-end', xEnd);
                document.documentElement.style.setProperty('--slide-mes-x-duration', `${duration}ms`);

                //The class must be removed to unfreze previous slides.
                swipedElementsDiv.removeClass('slide');
                //CSS starts the animation.
                void swipedElementsDiv[0].offsetWidth;
                swipedElementsDiv.addClass('slide');

                const endSlide = () => {
                    //Remove the style when done.
                    swipedElementsDiv.removeClass('slide');

                    document.documentElement.style.setProperty('--slide-mes-x-start', '');
                    document.documentElement.style.setProperty('--slide-mes-x-end', '');
                    document.documentElement.style.setProperty('--slide-mes-duration', '');
                    return true;
                };
                //Wait for the animation's end. https://developer.mozilla.org/en-US/docs/Web/API/Animation/finished
                const animations = swipedElementsDiv[0]?.getAnimations() ?? [];
                const animation = animations.filter((a) => a instanceof globalThis.CSSAnimation && a.animationName == 'slide')[0];
                try {
                    await Promise.race([animation?.finished, createTimeout(duration * 2, `The ${duration}ms swipe animation has not ended after ${duration * 2}ms. It has been skipped.`)].filter(Boolean));
                } catch (error) {
                    console.warn(error);
                }

                //If not frozen, end the slide now.
                return freeze ? endSlide : endSlide();
            }
        }
        console.warn(`No animatable messages were found after message #${mesId}.`);
        return false;
    }

    function getMessageBottomHeight(thisMesDiv) {
        const thisMesRect = thisMesDiv[0].getBoundingClientRect();
        //Scroll position + Chat height = Bottom of chat height.
        const chatBottom = chatElement.scrollTop() - chatElement.height();
        //Message offset from viewport top + height = Bottom of message offset.
        const messageBottom = thisMesRect.top + thisMesDiv.height();
        // Bottom of chat + Bottom of message offset = target scroll position.
        const scrollHeight = (chatBottom + messageBottom);
        return scrollHeight;
    }

    function expandNewMessage(thisMesDiv) {
        //Only scroll if the view is not near the bottom.
        const is_animation_scroll = (chatElement.scrollTop() >= (chatElement.prop('scrollHeight') - chatElement.outerHeight()) - 10);

        let new_height = thisMesDivHeight - (thisMesTextHeight - thisMesText[0].scrollHeight);
        if (new_height < 103) new_height = 103;

        //Keep the swipe buttons at the same height when scrolling is finished.

        //Expand new message.
        thisMesDiv.animate({ height: new_height + 'px' }, {
            duration: 0, //used to be 100 //Disabled on Cohee's request. https://github.com/SillyTavern/SillyTavern/pull/4610/files#r2408731744
            queue: false,
            progress: function (animation, progress, remainingMs) {
                if (is_animation_scroll) chatElement.scrollTop(getMessageBottomHeight(thisMesDiv));
            },
            complete: function () {
                thisMesDiv.css('height', 'auto');
                //Correct height auto offset.
                if (is_animation_scroll) chatElement.scrollTop(getMessageBottomHeight(thisMesDiv));
            },
        });
    }

    /**
     * Anime a swipe, optionally running a generation.
     * @param {boolean} run_generate
     * @param {boolean} [skipSwipeOut=false]
     */
    async function animateSwipe(run_generate = false, skipSwipeOut = false) {
        if (!skipSwipeOut) {
            //Swipe out.
            await animateSwipeTransition(mesId, { xEnd: `${swipeRange}px`, duration: swipeDuration });
        }


        if (run_generate) {
            await updateSwipeCounter(mesId);
            //shows "..." while generating
            thisMesDiv.find('.mes_text').html('...');
            // resets the timer
            thisMesDiv.find('.mes_timer').html('');
            thisMesDiv.find('.tokenCounterDisplay').text('');
            updateReasoningUI(thisMesDiv, { reset: true });
        } else {
            //console.log('showing previously generated swipe candidate, or "..."');
            //console.log('onclick right swipe calling addOneMessage');

            //Only scroll when swiping the last message.
            const scroll = (mesId == chat.length - 1);
            //The swipe buttons will be refreshed in endSwipe(), refreshing them now will cause flickering.
            addOneMessage(chat[mesId], { type: 'swipe', forceId: mesId, scroll: scroll, showSwipes: false });

            if (power_user.message_token_count_enabled) {
                if (!chat[mesId].extra) {
                    chat[mesId].extra = {};
                }

                const tokenCountText = (chat[mesId]?.extra?.reasoning || '') + chat[mesId].mes;
                const tokenCount = await getTokenCountAsync(tokenCountText, 0);
                chat[mesId].extra.token_count = tokenCount;
                thisMesDiv.find('.tokenCounterDisplay').text(`${tokenCount}t`);
            }
        }

        //Animate expanding to the new message height.
        thisMesDiv.css('height', thisMesDivHeight);
        expandNewMessage(thisMesDiv);

        if (run_generate) {
            appendMediaToMessage(chat[mesId], thisMesDiv);
        }

        await eventSource.emit(event_types.MESSAGE_SWIPED, mesId, {
            pendingGeneration: Boolean(run_generate),
            previousSwipeId: originalSwipeId,
            nextSwipeId: newSwipeId,
        });

        if (run_generate && !is_send_press) {
            is_send_press = true;
            generation = Generate('swipe');
        }

        //Swipe in from the opposite side.
        await animateSwipeTransition(mesId, { xStart: `${-swipeRange}px`, xEnd: `${0}px`, duration: swipeDuration });
    }

    if (mesId === Number(this_edit_mes_id)) {
        closeMessageEditor();
    }
    if (isStreamingEnabled() && streamingProcessor) {
        streamingProcessor.onStopStreaming();
    }

    if (isHordeGenerationNotAllowed()) {
        return unblockGeneration();
    }

    //If the swipe is not being deleted.
    if (source != SWIPE_SOURCE.DELETE && source != SWIPE_SOURCE.BACK) {
        // Make sure ad-hoc changes to extras are saved before swiping away
        syncMesToSwipe(mesId);

        if (chat[mesId].swipe_id === undefined) {              // if there is no swipe-message in the last spot of the chat array
            chat[mesId].swipe_id = 0;                        // set it to id 0
            chat[mesId].swipes = [];                         // empty the array
            chat[mesId].swipe_info = [];
            chat[mesId].swipes[0] = chat[mesId].mes;  //assign swipe array with last chat[mesId] from chat
            chat[mesId].swipe_info[0] = {
                'send_date': chat[mesId].send_date,
                'gen_started': chat[mesId].gen_started,
                'gen_finished': chat[mesId].gen_finished,
                'extra': structuredClone(chat[mesId].extra),
            };
        }
        // If the user is holding down the key and we're at the last or first swipe, don't do anything.
        let isLastSwipe = (direction === SWIPE_DIRECTION.RIGHT) ? (chat[mesId].swipe_id === Math.max(0, chat[mesId].swipes.length - 1)) : chat[mesId].swipe_id === 0;
        if (source === SWIPE_SOURCE.KEYBOARD && repeated && isLastSwipe) {
            await endSwipe();
            return;
        }
    } else if (source == SWIPE_SOURCE.DELETE || source == SWIPE_SOURCE.BACK) {
        //If the swipe is being deleted or reverted.
        await standardSwipe(newSwipeId);
        return;
    }

    //If swiping left.
    if (direction === SWIPE_DIRECTION.LEFT) {
        if (forceSwipeId == null) newSwipeId--;
        //Loop to last swipe if negative.
        if (newSwipeId < 0) {
            newSwipeId = Math.max(0, chat[mesId].swipes.length - 1);
        }
        //Limit swipe_id to swipes.
        if (newSwipeId > chat[mesId].swipes.length - 1) {
            toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to ${chat[mesId].swipes.length - 1}.`);
            chat[mesId].swipe_id = chat[mesId].swipes.length - 1;
            await endSwipe();
            return;
        }
        await standardSwipe(newSwipeId);
        return;
    } else if (direction === SWIPE_DIRECTION.RIGHT) {
        //If swiping right.
        // make new slot in array
        if (forceSwipeId == null) newSwipeId++;

        //Minimum of zero.
        if (newSwipeId < 0) {
            toastr.warning(`The swipe_id for message #${mesId} was ${newSwipeId}. It has been reset to zero.`);
            chat[mesId].swipe_id = 0;
            await endSwipe();
            return;
        }

        //If overswiping.
        if (newSwipeId >= chat[mesId].swipes.length) {
            newSwipeId = chat[mesId].swipes.length;

            //Update the swipe_id.
            chat[mesId].swipe_id = newSwipeId;

            const overswipe = getOverswipeBehavior(mesId);

            //Cancel the generation.
            if (overswipe == OVERSWIPE_BEHAVIOR.NONE) {
                //Cancel swipe.
                chat[mesId].swipe_id = originalSwipeId;
                await endSwipe();
                return;
            } else if (overswipe == OVERSWIPE_BEHAVIOR.REGENERATE) {
                //Regenerate the message
                clearMessageData(chat[mesId]);
                let run_generate = true;
                //Generate.
                await animateSwipe(run_generate);
                await endSwipe();
                return;
            } else if (overswipe == OVERSWIPE_BEHAVIOR.LOOP || overswipe == OVERSWIPE_BEHAVIOR.PRISTINE_GREETING) {
                // Loop to the first swipe.
                newSwipeId = 0;
            }
        }
        await standardSwipe(newSwipeId);
        return;
    }
}

/**
 * @deprecated Use `swipe` instead.
 * Handles the swipe to the left event.
 * @param {SwipeEvent} [event] Event.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source]  The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {object} [params.message] The chat message to swipe.
 */
export async function swipe_left(event, { source, repeated, message } = {}) {
    await swipe.call(this, event, SWIPE_DIRECTION.LEFT, { source: source, repeated: repeated, message: message });
}

/**
 * @deprecated Use `swipe` instead.
 * Handles the swipe to the right event.
 * @param {SwipeEvent} [event] Event.
 * @param {object} params Additional parameters.
 * @param {import('./scripts/constants.js').SWIPE_SOURCE} [params.source] The source of the swipe event.
 * @param {boolean} [params.repeated] Is the swipe event repeated.
 * @param {object} [params.message] The chat message to swipe.
 */
//MARK: swipe_right
export async function swipe_right(event = null, { source, repeated, message } = {}) {
    await swipe.call(this, event, SWIPE_DIRECTION.RIGHT, { source: source, repeated: repeated, message: message });
}

/**
 * Imports supported files dropped into the app window.
 * @param {File[]} files Array of files to process
 * @param {Map<File, string>} [data] Extra data to pass to the import function
 * @returns {Promise<void>}
 */
export async function processDroppedFiles(files, data = new Map()) {
    const allowedMimeTypes = [
        'application/json',
        'image/png',
        'application/yaml',
        'application/x-yaml',
        'text/yaml',
        'text/x-yaml',
    ];

    const allowedExtensions = [
        'charx',
        'byaf',
    ];

    const avatarFileNames = [];
    for (const file of files) {
        const extension = file.name.split('.').pop().toLowerCase();
        if (allowedMimeTypes.some(x => file.type.startsWith(x)) || allowedExtensions.includes(extension)) {
            const preservedName = data instanceof Map && data.get(file);
            const avatarFileName = await importCharacter(file, { preserveFileName: preservedName });
            if (avatarFileName !== undefined) {
                avatarFileNames.push(avatarFileName);
            }
        } else {
            toastr.warning(t`Unsupported file type: ` + file.name);
        }
    }

    if (avatarFileNames.length > 0) {
        await importCharactersTags(avatarFileNames);
        selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);
    }
}

/**
 * Imports tags for the given characters
 * @param {string[]} avatarFileNames character avatar filenames whose tags are to import
 */
async function importCharactersTags(avatarFileNames) {
    await getCharacters();
    for (let i = 0; i < avatarFileNames.length; i++) {
        if (power_user.tag_import_setting !== tag_import_setting.NONE) {
            const importedCharacter = characters.find(character => character.avatar === avatarFileNames[i]);
            await importTags(importedCharacter);
        }
    }
}

/**
 * Selects the given imported char
 * @param {string} charId char to select
 */
function selectImportedChar(charId) {
    let oldSelectedChar = null;
    if (this_chid !== undefined) {
        oldSelectedChar = characters[this_chid].avatar;
    }
    select_rm_info('char_import_no_toast', charId, oldSelectedChar);
}

/**
 * Imports a character from a file.
 * @param {File} file File to import
 * @param {object} [options] - Options
 * @param {string} [options.preserveFileName] Whether to preserve original file name
 * @param {Boolean} [options.importTags=false] Whether to import tags
 * @param {Boolean} [options.suppressToast=false] Whether to suppress success toasts
 * @returns {Promise<string>}
 */
async function importCharacter(file, { preserveFileName = '', importTags = false, suppressToast = false } = {}) {
    if (is_group_generating || is_send_press) {
        toastr.error(t`Cannot import characters while generating. Stop the request and try again.`, t`Import aborted`);
        throw new Error('Cannot import character while generating');
    }

    const ext = file.name.match(/\.(\w+)$/);
    if (!ext || !(['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(ext[1].toLowerCase()))) {
        return;
    }

    const exists = preserveFileName ? characters.find(character => character.avatar === preserveFileName) : undefined;

    const format = ext[1].toLowerCase();
    $('#character_import_file_type').val(format);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', name1);
    if (preserveFileName) formData.append('preserved_name', preserveFileName);

    try {
        const result = await fetch('/api/characters/import', {
            method: 'POST',
            body: formData,
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
        });

        if (!result.ok) {
            throw new Error(`Failed to import character: ${result.statusText}`);
        }

        const data = await result.json();

        if (data.error) {
            throw new Error(`Server returned an error: ${data.error}`);
        }

        if (data.file_name !== undefined) {
            let avatarFileName = `${data.file_name}.png`;

            // Refresh existing thumbnail
            if (exists && this_chid !== undefined) {
                await fetch(getThumbnailUrl('avatar', avatarFileName), { cache: 'reload' });
            }

            $('#character_search_bar').val('').trigger('input');

            if (exists) {
                if (!suppressToast) {
                    toastr.success(t`Character Replaced: ${String(data.file_name).replace('.png', '')}`);
                }
            } else {
                if (!suppressToast) {
                    toastr.success(t`Character Created: ${String(data.file_name).replace('.png', '')}`);
                }
            }
            if (importTags) {
                await importCharactersTags([avatarFileName]);
                selectImportedChar(data.file_name);
            }
            return avatarFileName;
        }
    } catch (error) {
        console.error('Error importing character', error);
        toastr.error(t`The file is likely invalid or corrupted.`, t`Could not import character`);
    }
}

async function importFromURL(items, files) {
    for (const item of items) {
        if (item.type === 'text/uri-list') {
            const uriList = await new Promise((resolve) => {
                item.getAsString((uriList) => { resolve(uriList); });
            });
            const uris = uriList.split('\n').filter(uri => uri.trim() !== '');
            try {
                for (const uri of uris) {
                    const request = await fetch(uri);
                    const data = await request.blob();
                    const fileName = request.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || uri.split('/').pop() || 'file.png';
                    const file = new File([data], fileName, { type: data.type });
                    files.push(file);
                }
            } catch (error) {
                console.error('Failed to import from URL', error);
            }
        }
    }
}

export async function doNewChat({ deleteCurrentChat = false } = {}) {
    //Make a new chat for selected character
    if ((!selected_group && this_chid == undefined) || menu_type == 'create') {
        return;
    }

    const actionContext = buildCurrentChatFileActionContext();
    if (!actionContext) {
        return;
    }
    const deleteSaveContext = deleteCurrentChat ? buildActiveChatSaveContext() : null;

    const canChangeChat = deleteCurrentChat
        ? await waitForChatSwitchAvailability({ requireCompletedSave: true })
        : await waitForChatSwitchAvailability();
    if (!canChangeChat) {
        return;
    }

    // Make it easier to find in backups
    if (deleteCurrentChat) {
        if (deleteSaveContext?.kind === 'group') {
            await saveGroupChat(deleteSaveContext.groupId, true, false, 0, { ...deleteSaveContext, skipSerialization: true });
            finishActiveChatSaveContext(deleteSaveContext);
        } else if (deleteSaveContext?.kind === 'character') {
            await saveChatInternal({ _context: deleteSaveContext });
            finishActiveChatSaveContext(deleteSaveContext);
        } else {
            await saveChatConditional();
        }
    }

    if (deleteCurrentChat && actionContext.kind === 'group') {
        await maybeDeleteChatBoundLorebook(actionContext.chatFile, actionContext.groupId);
    }

    if (deleteCurrentChat && actionContext.kind === 'character') {
        await maybeDeleteChatBoundLorebook(actionContext.chatFile, null, {
            avatarUrl: actionContext.avatarUrl,
            characterName: actionContext.characterName,
        });
    }

    if (actionContext.kind === 'group') {
        await createNewGroupChatForContext(actionContext);
        if (deleteCurrentChat) {
            await deleteGroupChat(actionContext.groupId, actionContext.chatFile, { jumpToNewChat: false });
        }
    } else {
        await createNewCharacterChatForContext(actionContext);
        if (deleteCurrentChat) {
            await deleteCharacterChatByName(actionContext.characterId, actionContext.chatFile);
        }
    }
}

/**
 * Renames a group or character chat.
 * @param {object} param Parameters for renaming chat
 * @param {string} [param.characterId] Character ID to rename chat for
 * @param {string} [param.groupId] Group ID to rename chat for
 * @param {string} param.oldFileName Old name of the chat (no JSONL extension)
 * @param {string} param.newFileName New name for the chat (no JSONL extension)
 * @param {boolean} [param.loader=true] Whether to show loader during the operation
 */
export async function renameGroupOrCharacterChat({ characterId, groupId, oldFileName, newFileName, loader: showLoader }) {
    const currentChatId = getCurrentChatId();
    const body = {
        is_group: !!groupId,
        avatar_url: characters[characterId]?.avatar,
        original_file: `${oldFileName}.jsonl`,
        renamed_file: `${newFileName.trim()}.jsonl`,
    };

    if (body.original_file === body.renamed_file) {
        console.debug('Chat rename cancelled, old and new names are the same');
        return;
    }
    if (equalsIgnoreCaseAndAccents(body.original_file, body.renamed_file)) {
        toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename Chat`);
        return;
    }

    const loaderHandle = showLoader ? loader.show({
        title: t`Rename Chat`,
        message: t`Renaming chat…`,
        toastMode: loader.ToastMode.STATIC,
    }) : null;

    try {
        const response = await fetch('/api/chats/rename', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Unsuccessful request.');
        }

        const data = await response.json();

        if (data.error) {
            throw new Error('Server returned an error.');
        }

        if (data.sanitizedFileName) {
            newFileName = data.sanitizedFileName;
        }

        if (groupId) {
            await renameGroupChat(groupId, oldFileName, newFileName);
        } else if (characterId !== undefined && String(characterId) === String(this_chid) && characters[characterId]?.chat === oldFileName) {
            characters[characterId].chat = newFileName;
            $('#selected_chat_pole').val(characters[characterId].chat);
            await updateRemoteChatName(characterId, newFileName);
        }

        if (currentChatId) {
            await reloadCurrentChat();
        }
    } catch {
        await delay(500);
        await callGenericPopup('An error has occurred. Chat was not renamed.', POPUP_TYPE.TEXT);
    } finally {
        await loaderHandle?.hide();
    }
}

/**
 * Renames the currently selected chat.
 * @param {string} oldFileName Old name of the chat (no JSONL extension)
 * @param {string} newName New name for the chat (no JSONL extension)
 */
export async function renameChat(oldFileName, newName) {
    return await renameGroupOrCharacterChat({
        characterId: this_chid,
        groupId: selected_group,
        oldFileName: oldFileName,
        newFileName: newName,
        loader: true,
    });
}

/**
 * Closes the current chat, clearing all associated data and resetting the UI.
 * If a message generation is in progress, it prompts the user to stop it first.
 * @returns {Promise<boolean>} True if the chat was successfully closed, false otherwise.
 */
export async function closeCurrentChat() {
    if (is_send_press == false) {
        if (!await waitForChatSwitchAvailability()) {
            return false;
        }
        await clearChat({ clearData: true });
        resetSelectedGroup();
        setCharacterId(undefined);
        setCharacterName('');
        setActiveCharacter(null);
        setActiveGroup(null);
        this_edit_mes_id = undefined;
        chat_metadata = {};
        selected_button = 'characters';
        $('#rm_button_selected_ch').children('h2').text('');
        select_rm_characters();
        await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
        return true;
    } else {
        toastr.info(t`Please stop the message generation first.`);
        return false;
    }
}

/**
 * Forces the update of the chat name for a remote character.
 * @param {string|number} characterId Character ID to update chat name for
 * @param {string} newName New name for the chat
 * @returns {Promise<void>}
 */
export async function updateRemoteChatName(characterId, newName) {
    const character = characters[characterId];
    if (!character) {
        console.warn(`Character not found for ID: ${characterId}`);
        return;
    }
    character.chat = newName;
    const mergeRequest = {
        avatar: character.avatar,
        chat: newName,
    };
    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(mergeRequest),
    });
    if (!mergeResponse.ok) {
        console.error('Failed to save extension field', mergeResponse.statusText);
    }
}


function doCharListDisplaySwitch() {
    power_user.charListGrid = !power_user.charListGrid;
    document.body.classList.toggle('charListGrid', power_user.charListGrid);
    saveSettingsDebounced();
}

/**
 * Function to handle the deletion of a character, given a specific popup type and character ID.
 * If popup type equals "del_ch", it will proceed with deletion otherwise it will exit the function.
 * It fetches the delete character route, sending necessary parameters, and in case of success,
 * it proceeds to delete character from UI and saves settings.
 * In case of error during the fetch request, it logs the error details.
 *
 * @param {string} this_chid - The character ID to be deleted.
 * @param {boolean} delete_chats - Whether to delete chats or not.
 */
export async function handleDeleteCharacter(this_chid, delete_chats) {
    if (!characters[this_chid]) {
        return;
    }

    await deleteCharacter(characters[this_chid].avatar, { deleteChats: delete_chats });
}

/**
 * Deletes a character completely, including associated chats if specified
 *
 * @param {string|string[]} characterKey - The key (avatar) of the character to be deleted
 * @param {Object} [options] - Optional parameters for the deletion
 * @param {boolean} [options.deleteChats=true] - Whether to delete associated chats or not
 * @return {Promise<boolean>} - A promise that resolves when the character is successfully deleted
 */
export async function deleteCharacter(characterKey, { deleteChats = true } = {}) {
    if (!Array.isArray(characterKey)) {
        characterKey = [characterKey];
    }

    const normalizedCharacterKeys = characterKey.map(key => String(key));
    const uniqueCharacterKeys = normalizedCharacterKeys.filter((key, index) => normalizedCharacterKeys.indexOf(key) === index);

    const inTempChat = this_chid === undefined && name2 === neutralCharacterName;
    if (inTempChat) {
        const confirmClose = await Popup.show.confirm(
            t`You are currently in a temporary chat.`,
            t`Deleting this character will close the chat and you will lose any unsaved messages. Do you want to proceed?`,
        );
        if (!confirmClose) {
            return false;
        }
    }

    cancelDebounce(saveCharacterDebounced);
    isCharacterDeletionInProgress = true;
    try {
        const canOfferUndo = uniqueCharacterKeys.length > 0;
        const activeAvatarBeforeDelete = this_chid !== undefined ? String(characters[this_chid]?.avatar || '') : '';
        const pendingCharacterUndos = [];

        if (canOfferUndo) {
            let undoReady = true;
            for (const key of uniqueCharacterKeys) {
                const targetCharacter = characters.find(character => character?.avatar === key);
                const targetCharacterId = targetCharacter ? characters.indexOf(targetCharacter) : -1;
                if (targetCharacterId < 0) {
                    undoReady = false;
                    break;
                }

                const snapshot = await getCharacterDeletionUndoSnapshot(targetCharacterId, {
                    includeChats: deleteChats,
                    wasCurrentCharacter: activeAvatarBeforeDelete === targetCharacter.avatar,
                });
                if (!snapshot) {
                    undoReady = false;
                    break;
                }

                pendingCharacterUndos.push(snapshot);
            }

            if (!undoReady) {
                pendingCharacterUndos.splice(0, pendingCharacterUndos.length);
            }
        }

        const closeChatResult = await closeCurrentChat();
        if (!closeChatResult) {
            return;
        }

        const pendingCharacterUndoByAvatar = new Map(pendingCharacterUndos.map(snapshot => [snapshot.avatarUrl, snapshot]));

        for (const key of uniqueCharacterKeys) {
            const character = characters.find(x => x.avatar == key);
            if (!character) {
                toastr.warning(t`Character ${key} not found. Skipping deletion.`);
                continue;
            }

            const chid = characters.indexOf(character);
            const pastChats = await getPastCharacterChats(chid);
            const promptedLorebooks = new Set();

            if (deleteChats) {
                for (const chat of pastChats) {
                    const fileName = String(chat?.file_name || '').trim().replace(/\.jsonl$/i, '');
                    if (!fileName) {
                        continue;
                    }
                    const result = await maybeDeleteChatBoundLorebook(fileName, null, {
                        avatarUrl: character.avatar,
                        characterName: getCharacterName(character),
                    });
                    if (result?.lorebookName) {
                        promptedLorebooks.add(result.lorebookName);
                    }
                }
            }

            const importedLorebookResult = await maybeDeleteCharacterBoundImportedLorebook(character, {
                alreadyPromptedLorebooks: promptedLorebooks,
            });
            if (importedLorebookResult?.lorebookName) {
                promptedLorebooks.add(importedLorebookResult.lorebookName);
            }

            const msg = { avatar_url: character.avatar, delete_chats: deleteChats };

            const response = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(msg),
                cache: 'no-cache',
            });

            if (!response.ok) {
                toastr.error(`${response.status} ${response.statusText}`, t`Failed to delete character`);
                continue;
            }

            accountStorage.removeItem(`AlertWI_${character.avatar}`);
            accountStorage.removeItem(`AlertRegex_${character.avatar}`);
            accountStorage.removeItem(`mediaWarningShown:${character.avatar}`);
            delete tag_map[character.avatar];
            select_rm_info('char_delete', getCharacterName(character));

            const pendingCharacterUndo = pendingCharacterUndoByAvatar.get(character.avatar);
            const shouldDelayDeleteCommit = Boolean(pendingCharacterUndo);
            if (shouldDelayDeleteCommit) {
                pendingCharacterUndo.deletedEvent = { id: chid, character };
                pendingCharacterUndo.deletedChatNames = deleteChats
                    ? pastChats
                        .map(chat => String(chat?.file_name || '').trim().replace(/\.jsonl$/i, ''))
                        .filter(Boolean)
                    : [];
            } else {
                if (deleteChats) {
                    for (const chat of pastChats) {
                        const name = chat.file_name.replace('.jsonl', '');
                        await eventSource.emit(event_types.CHAT_DELETED, name);
                    }
                }

                await eventSource.emit(event_types.CHARACTER_DELETED, { id: chid, character: character });
            }
        }

        const hasIncompleteCharacterUndo = pendingCharacterUndos.some(snapshot => !snapshot.deletedEvent);
        if (hasIncompleteCharacterUndo) {
            for (const snapshot of pendingCharacterUndos.filter(snapshot => snapshot.deletedEvent)) {
                await commitDeletedCharacterUndoSnapshot(snapshot);
            }
            pendingCharacterUndos.splice(0, pendingCharacterUndos.length);
        }

        await removeCharacterFromUI();

        if (pendingCharacterUndos.length > 0) {
            const deletedCharacterCount = pendingCharacterUndos.length;
            showUndoToast({
                message: deletedCharacterCount > 1 ? t`Characters deleted.` : t`Character deleted.`,
                onUndo: async () => {
                    const { restoredSnapshots, failedSnapshots } = await restoreDeletedCharacterUndoSnapshots(pendingCharacterUndos);
                    if (restoredSnapshots.length === 0) {
                        toastr.error(deletedCharacterCount > 1 ? t`Failed to restore characters.` : t`Failed to restore character.`);
                        return;
                    }

                    if (failedSnapshots.length > 0) {
                        toastr.error(t`Failed to restore some characters.`);
                    }
                },
                onCommit: async () => {
                    for (const snapshot of pendingCharacterUndos) {
                        await commitDeletedCharacterUndoSnapshot(snapshot);
                    }
                },
            });
        }
    } finally {
        isCharacterDeletionInProgress = false;
    }
}

/**
 * Function to delete a character from UI after character deletion API success.
 * It manages necessary UI changes such as closing advanced editing popup, unsetting
 * character ID, resetting characters array and chat metadata, deselecting character's tab
 * panel, removing character name from navigation tabs, clearing chat, fetching updated list of characters.
 * It also ensures to save the settings after all the operations.
 */
async function removeCharacterFromUI() {
    preserveNeutralChat();
    await clearChat();
    $('#character_cross').trigger('click');
    resetChatState();
    $(document.getElementById('rm_button_selected_ch')).children('h2').text('');
    restoreNeutralChat();
    await getCharacters();
    await printMessages();
    saveSettingsDebounced();
    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
}

/**
 * Creates a new assistant chat.
 * @param {object} params - Parameters for the new assistant chat
 * @param {boolean} [params.temporary=false] I need a temporary secretary
 * @returns {Promise<void>} - A promise that resolves when the new assistant chat is created
 */
export async function newAssistantChat({ temporary = false } = {}) {
    await clearChat();
    if (!temporary) {
        return openPermanentAssistantChat();
    }
    chat.splice(0, chat.length);
    chat_metadata = {};
    setCharacterName(neutralCharacterName);
    sendSystemMessage(system_message_types.ASSISTANT_NOTE);
}

/**
 * Event handler to open a navbar drawer when a drawer open button is clicked.
 * Handles click events on .drawer-opener elements.
 * Opens the drawer associated with the clicked button according to the data-target attribute.
 * @returns {void}
 */
function doDrawerOpenClick() {
    const targetDrawerID = $(this).attr('data-target');
    const drawer = $(`#${targetDrawerID}`);
    const drawerToggle = drawer.find('.drawer-toggle');
    const drawerWasOpenAlready = drawerToggle.parent().find('.drawer-content').hasClass('openDrawer');
    if (drawerWasOpenAlready || drawer.hasClass('resizing')) { return; }
    doNavbarIconClick.call(drawerToggle);
}

/**
 * Event handler to open or close a navbar drawer when a navbar icon is clicked.
 * Handles click events on .drawer-toggle elements.
 * @returns {Promise<void>}
 */
export async function doNavbarIconClick() {
    const icon = $(this).find('.drawer-icon');
    const drawer = $(this).parent().find('.drawer-content');
    const drawerWasOpenAlready = $(this).parent().find('.drawer-content').hasClass('openDrawer');
    const targetDrawerID = $(this).parent().find('.drawer-content').attr('id');

    if (!drawerWasOpenAlready) {
        const $openDrawers = $('.openDrawer:not(.pinnedOpen)');
        const $openIcons = $('.openIcon:not(.drawerPinnedOpen)');
        for (const iconEl of $openIcons) {
            $(iconEl).toggleClass('closedIcon openIcon');
        }
        for (const el of $openDrawers) {
            $(el).toggleClass('closedDrawer openDrawer');
        }
        if ($openDrawers.length && animation_duration) {
            await delay(animation_duration);
        }
        icon.toggleClass('openIcon closedIcon');
        drawer.toggleClass('openDrawer closedDrawer');

        if (targetDrawerID === 'right-nav-panel') {
            favsToHotswap();
            $('#rm_print_characters_block').trigger('scroll');
        }

        // Set the height of "autoSetHeight" textareas within the drawer to their scroll height
        if (!CSS.supports('field-sizing', 'content')) {
            const textareas = $(this).closest('.drawer').find('.drawer-content textarea.autoSetHeight');
            for (const textarea of textareas) {
                await resetScrollHeight($(textarea));
            }
        }
    } else if (drawerWasOpenAlready) {
        icon.toggleClass('closedIcon openIcon');
        drawer.toggleClass('closedDrawer openDrawer');
    }
}

function addDebugFunctions() {
    const doBackfill = async () => {
        for (const message of chat) {
            // System messages are not counted
            if (message.is_system) {
                continue;
            }

            if (!message.extra) {
                message.extra = {};
            }

            const tokenCountText = (message?.extra?.reasoning || '') + message.mes;
            message.extra.token_count = await getTokenCountAsync(tokenCountText, 0);
        }

        await saveChatConditional();
        await reloadCurrentChat();
    };

    registerDebugFunction('forceOnboarding', 'Force onboarding', 'Forces the onboarding process to restart.', async () => {
        firstRun = true;
        await saveSettings();
        location.reload();
    });

    registerDebugFunction('backfillTokenCounts', 'Backfill token counters',
        `Recalculates token counts of all messages in the current chat to refresh the counters.
        Useful when you switch between models that have different tokenizers.
        This is a visual change only. Your chat will be reloaded.`, doBackfill);

    registerDebugFunction('generationTest', 'Send a generation request', 'Generates text using the currently selected API.', async () => {
        const text = prompt('Input text:', 'Hello');
        toastr.info('Working on it...');
        const message = await generateRaw({ prompt: text });
        alert(message);
    });
    registerDebugFunction('toggleEventTracing', 'Toggle event tracing', 'Useful to see what triggered a certain event.', () => {
        localStorage.setItem('eventTracing', localStorage.getItem('eventTracing') === 'true' ? 'false' : 'true');
        toastr.info('Event tracing is now ' + (localStorage.getItem('eventTracing') === 'true' ? 'enabled' : 'disabled'));
    });

    registerDebugFunction('toggleRegenerateWarning', 'Toggle Ctrl+Enter regeneration confirmation', 'Toggle the warning when regenerating a message with a Ctrl+Enter hotkey.', () => {
        accountStorage.setItem('RegenerateWithCtrlEnter', accountStorage.getItem('RegenerateWithCtrlEnter') === 'true' ? 'false' : 'true');
        toastr.info('Regenerate warning is now ' + (accountStorage.getItem('RegenerateWithCtrlEnter') === 'true' ? 'disabled' : 'enabled'));
    });

    registerDebugFunction('copySetup', 'Copy ST setup to clipboard [WIP]', 'Useful data when reporting bugs', async () => {
        const getContextContents = getContext();
        const getSettingsContents = settings;
        //console.log(getSettingsContents);
        const logMessage = `
\`\`\`
API: ${getSettingsContents.main_api}
API Type: ${getSettingsContents[getSettingsContents.main_api + '_settings'].type}
API server: ${getSettingsContents.api_server}
Model: ${getContextContents.onlineStatus}
Context Template: ${power_user.context.preset}
Instruct Template: ${power_user.instruct.preset}
API Settings: ${JSON.stringify(getSettingsContents[getSettingsContents.main_api + '_settings'], null, 2)}
\`\`\`
    `;

        //console.log(getSettingsContents)
        //console.log(logMessage);

        try {
            await copyText(logMessage);
            toastr.info('Your ST API setup data has been copied to the clipboard.');
        } catch (error) {
            toastr.error('Failed to copy ST Setup to clipboard:', error);
        }
    });
}

function initCharacterSearch() {
    const debouncedCharacterSearch = debounce((searchQuery) => {
        entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, searchQuery);
    });

    const searchForm = $('#form_character_search_form');
    const searchInput = $('#character_search_bar');
    const searchButton = $('#rm_button_search');

    searchInput.on('input', function () {
        const searchQuery = String($(this).val());
        debouncedCharacterSearch(searchQuery);
    });

    searchButton.on('click', function () {
        const newVisibility = !searchForm.is(':visible');
        searchForm.toggle(newVisibility);
        searchButton.toggleClass('active', newVisibility);
        accountStorage.setItem(CHARACTER_SEARCH_VISIBILITY_STORAGE_KEY, String(newVisibility));
        if (newVisibility) {
            searchInput.trigger('focus');
        }
    });
}

const CHARACTER_SEARCH_VISIBILITY_STORAGE_KEY = 'characterSearchFormVisible';

function restoreCharacterSearchVisibility() {
    const searchForm = $('#form_character_search_form');
    const searchButton = $('#rm_button_search');
    const isVisible = accountStorage.getItem(CHARACTER_SEARCH_VISIBILITY_STORAGE_KEY) === 'true';
    searchForm.toggle(isVisible);
    searchButton.toggleClass('active', isVisible);
}

// MARK: DOM Handlers Start
jQuery(async function () {
    setTimeout(function () {
        $('#groupControlsToggle').trigger('click');
        $('#groupCurrentMemberListToggle .inline-drawer-icon').trigger('click');
    }, 200);

    $(document).on('click', '.api_loading', () => cancelStatusCheck('Canceled because connecting was manually canceled'));

    //////////INPUT BAR FOCUS-KEEPING LOGIC/////////////
    let S_TAPreviouslyFocused = false;
    $('#send_textarea').on('focusin focus click', () => {
        S_TAPreviouslyFocused = true;
    });
    $('#send_textarea').on('compositionstart', () => {
        isSendTextareaComposing = true;
    });
    $('#send_textarea').on('compositionend', () => {
        isSendTextareaComposing = false;
    });
    $('#send_textarea').on('blur', () => {
        isSendTextareaComposing = false;
    });
    $('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate').on('click', () => {
        if (S_TAPreviouslyFocused) {
            $('#send_textarea').trigger('focus');
        }
    });
    $(document).on('click', event => {
        if ($(':focus').attr('id') !== 'send_textarea') {
            var validIDs = ['options_button', 'send_but', 'mes_impersonate', 'mes_continue', 'send_textarea', 'option_regenerate', 'option_continue'];
            if (!validIDs.includes($(event.target).attr('id'))) {
                S_TAPreviouslyFocused = false;
            }
        } else {
            S_TAPreviouslyFocused = true;
        }
    });

    /////////////////

    $('#swipes-checkbox').on('change', function () {
        swipes = !!$('#swipes-checkbox').prop('checked');
        if (swipes) {
            //console.log('toggle change calling showswipebtns');
            showSwipeButtons();
        } else {
            hideSwipeButtons();
        }
        saveSettingsDebounced();
    });

    ///// SWIPE BUTTON CLICKS ///////

    //limit swiping to only last message clicks
    $(document).on('click', '.last_mes .swipe_right', async (e, data) => await swipe(e, SWIPE_DIRECTION.RIGHT, data));
    $(document).on('click', '.last_mes .swipe_left', async (e, data) => await swipe(e, SWIPE_DIRECTION.LEFT, data));

    initCharacterSearch();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        void startLukerGenerationRecovery();
    });
    eventSource.on(event_types.GENERATION_STARTED, () => {
        stopLukerGenerationRecovery();
    });

    $('#mes_impersonate').on('click', function () {
        $('#option_impersonate').trigger('click');
    });

    $('#mes_continue').on('click', function () {
        $('#option_continue').trigger('click');
    });

    const userInputGenerateMutex = new SimpleMutex(sendTextareaMessage);
    $('#send_but').on('click', async function () {
        await userInputGenerateMutex.update();
    });

    //menu buttons setup

    $('#rm_button_settings').on('click', function () {
        selected_button = 'settings';
        selectRightMenuWithAnimation('rm_api_block');
    });
    $('#rm_button_characters').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });
    $('#rm_button_back').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });
    $('#rm_button_create').on('click', function () {
        selected_button = 'create';
        select_rm_create();
    });
    $('#rm_button_selected_ch').on('click', function () {
        if (selected_group) {
            select_group_chats(selected_group, false);
        } else {
            selected_button = 'character_edit';
            select_selected_character(this_chid);
        }
        $('#character_search_bar').val('').trigger('input');
    });

    $(document).on('click', '.character_select', async function () {
        const id = Number($(this).attr('data-chid'));
        await selectCharacterById(id);
    });

    $(document).on('click', '.bogus_folder_select', function () {
        const tagId = $(this).attr('tagid');
        console.debug('Bogus folder clicked', tagId);
        chooseBogusFolder($(this), tagId);
    });

    const cssAutofit = CSS.supports('field-sizing', 'content');
    if (!cssAutofit) {
        /**
         * Sets the scroll height of the edit textarea to fit the content.
         * @param {HTMLTextAreaElement} e Textarea element to auto-fit
         */
        function autoFitEditTextArea(e) {
            const scrollTop = chatElement.scrollTop();
            e.style.height = '0px';
            const newHeight = e.scrollHeight + 4;
            e.style.height = `${newHeight}px`;
            chatElement.scrollTop(scrollTop);
        }
        const autoFitEditTextAreaDebounced = debounce(autoFitEditTextArea, debounce_timeout.short);
        document.addEventListener('input', e => {
            if (e.target instanceof HTMLTextAreaElement && e.target.classList.contains('edit_textarea')) {
                const scrollbarShown = e.target.clientWidth < e.target.offsetWidth && e.target.offsetHeight >= window.innerHeight * 0.75;
                const immediately = (e.target.scrollHeight > e.target.offsetHeight && !scrollbarShown) || e.target.value === '';
                immediately ? autoFitEditTextArea(e.target) : autoFitEditTextAreaDebounced(e.target);
            }
        });
    }

    const chatElementScroll = document.getElementById('chat');
    const chatScrollHandler = function () {
        if (power_user.waifuMode) {
            scrollLock = true;
            return;
        }

        const scrollIsAtBottom = Math.abs(chatElementScroll.scrollHeight - chatElementScroll.clientHeight - chatElementScroll.scrollTop) < 5;

        // Resume autoscroll if the user scrolls to the bottom
        if (scrollLock && scrollIsAtBottom) {
            scrollLock = false;
        }

        // Cancel autoscroll if the user scrolls up
        if (!scrollLock && !scrollIsAtBottom) {
            scrollLock = true;
        }
    };
    chatElementScroll.addEventListener('scroll', chatScrollHandler, { passive: true });

    $(document).on('click', '.mes', function () {
        //when a 'delete message' parent div is clicked
        // and we are in delete mode and del_checkbox is visible
        if (!is_delete_mode || !$(this).children('.del_checkbox').is(':visible')) {
            return;
        }
        $('.mes').children('.del_checkbox').each(function () {
            $(this).prop('checked', false);
            $(this).parent().removeClass('selected');
        });
        $(this).addClass('selected'); //sets the bg of the mes selected for deletion
        var i = Number($(this).attr('mesid')); //checks the message ID in the chat
        this_del_mes = i;
        //as long as the current message ID is less than the total chat length
        while (i < chat.length) {
            //sets the bg of the all msgs BELOW the selected .mes
            $(`.mes[mesid="${i}"]`).addClass('selected');
            $(`.mes[mesid="${i}"]`).children('.del_checkbox').prop('checked', true);
            i++;
        }
    });

    /**
     * Handles the deletion of a chat file, including group chats.
     *
     * @param {string} chatFile - The name of the chat file to delete.
     * @param {object} group - The group object if the chat is part of a group.
     * @param {boolean} [fromSlashCommand=false] - Whether the deletion was triggered from a slash command.
     * @returns {Promise<void>}
     */
    async function handleDeleteChat(chatFile, group, fromSlashCommand = false) {
        await maybeDeleteChatBoundLorebook(chatFile, group);

        // Close past chat popup.
        $('#select_chat_cross').trigger('click');
        showLoader();
        if (group) {
            await deleteGroupChat(group, chatFile);
        } else {
            await delChat(`${chatFile}.jsonl`);
        }

        if (fromSlashCommand) {  // When called from `/delchat` command, don't re-open the history view.
            $('#options').hide();  // Hide option popup menu.
            await loaderHandle.hide();
        } else {  // Open the history view again after 2 seconds (delay to avoid edge cases for deleting last chat).
            setTimeout(async function () {
                $('#option_select_chat').trigger('click');
                $('#options').hide();  // Hide option popup menu.
                await loaderHandle.hide();
            }, 2000);
        }
    }

    $(document).on('click', '.PastChat_cross', async function (e, { fromSlashCommand = false } = {}) {
        e.stopPropagation();
        const deleteFileName = $(this).attr('file_name');
        console.debug('detected cross click for' + deleteFileName);

        // Skip confirmation if called from a slash command.
        if (fromSlashCommand) {
            await handleDeleteChat(deleteFileName, selected_group, true);
            return;
        }

        const result = await callGenericPopup('<h3>' + t`Delete the Chat File?` + '</h3>', POPUP_TYPE.CONFIRM);
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            await handleDeleteChat(deleteFileName, selected_group, false);
        }
    });

    $('#advanced_div').on('click', function () {
        if (!is_advanced_char_open) {
            is_advanced_char_open = true;
            $('#character_popup').css({ 'display': 'flex', 'opacity': 0.0 }).addClass('open');
            $('#character_popup').transition({
                opacity: 1.0,
                duration: animation_duration,
                easing: animation_easing,
            });
        } else {
            is_advanced_char_open = false;
            $('#character_popup').css('display', 'none').removeClass('open');
        }
    });

    $('#character_cross').on('click', function () {
        is_advanced_char_open = false;
        $('#character_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () { $('#character_popup').css('display', 'none'); }, animation_duration);
    });

    $('#character_popup_ok').on('click', function () {
        is_advanced_char_open = false;
        $('#character_popup').css('display', 'none');
    });

    $('#dialogue_popup_ok').on('click', async function (_e) {
        dialogueCloseStop = false;
        $('#shadow_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () {
            if (dialogueCloseStop) return;
            $('#shadow_popup').css('display', 'none');
            $('#dialogue_popup').removeClass('large_dialogue_popup');
            $('#dialogue_popup').removeClass('wide_dialogue_popup');
        }, animation_duration);

        if (dialogueResolve) {
            if (popup_type == 'input') {
                dialogueResolve($('#dialogue_popup_input').val());
                $('#dialogue_popup_input').val('');
            } else {
                dialogueResolve(true);
            }

            dialogueResolve = null;
        }
    });

    $('#dialogue_popup_cancel').on('click', function (e) {
        dialogueCloseStop = false;
        $('#shadow_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () {
            if (dialogueCloseStop) return;
            $('#shadow_popup').css('display', 'none');
            $('#dialogue_popup').removeClass('large_dialogue_popup');
        }, animation_duration);

        popup_type = '';

        if (dialogueResolve) {
            dialogueResolve(false);
            dialogueResolve = null;
        }
    });

    $('#add_avatar_button').on('change', function () {
        const inputElement = /** @type {HTMLInputElement} */ (this);
        read_avatar_load(inputElement);
    });

    $('#form_create').on('submit', (e) => createOrEditCharacter(e.originalEvent));

    $('#delete_button').on('click', async function () {
        if (this_chid === undefined || !characters[this_chid]) {
            toastr.warning('No character selected.');
            return;
        }

        let deleteChats = false;

        const confirm = await Popup.show.confirm(t`Delete the character?`, await renderTemplateAsync('deleteConfirm'), {
            onClose: () => { deleteChats = !!$('#del_char_checkbox').prop('checked'); },
        });
        if (!confirm) {
            return;
        }

        await deleteCharacter(characters[this_chid].avatar, { deleteChats: deleteChats });
    });

    //////// OPTIMIZED ALL CHAR CREATION/EDITING TEXTAREA LISTENERS ///////////////

    $('#character_name_pole').on('input', function () {
        if (menu_type == 'create') {
            create_save.name = String($('#character_name_pole').val());
        }
    });

    const elementsToUpdate = {
        '#description_textarea': function () { create_save.description = String($('#description_textarea').val()); },
        '#creator_notes_textarea': function () { create_save.creator_notes = String($('#creator_notes_textarea').val()); },
        '#character_version_textarea': function () { create_save.character_version = String($('#character_version_textarea').val()); },
        '#system_prompt_textarea': function () { create_save.system_prompt = String($('#system_prompt_textarea').val()); },
        '#post_history_instructions_textarea': function () { create_save.post_history_instructions = String($('#post_history_instructions_textarea').val()); },
        '#creator_textarea': function () { create_save.creator = String($('#creator_textarea').val()); },
        '#tags_textarea': function () { create_save.tags = String($('#tags_textarea').val()); },
        '#personality_textarea': function () { create_save.personality = String($('#personality_textarea').val()); },
        '#scenario_pole': function () { create_save.scenario = String($('#scenario_pole').val()); },
        '#mes_example_textarea': function () { create_save.mes_example = String($('#mes_example_textarea').val()); },
        '#firstmessage_textarea': function () { create_save.first_message = String($('#firstmessage_textarea').val()); },
        '#talkativeness_slider': function () { create_save.talkativeness = Number($('#talkativeness_slider').val()); },
        '#depth_prompt_prompt': function () { create_save.depth_prompt_prompt = String($('#depth_prompt_prompt').val()); },
        '#depth_prompt_depth': function () { create_save.depth_prompt_depth = Number($('#depth_prompt_depth').val()); },
        '#depth_prompt_role': function () { create_save.depth_prompt_role = String($('#depth_prompt_role').val()); },
    };

    Object.keys(elementsToUpdate).forEach(function (id) {
        $(id).on('input', function () {
            if (menu_type == 'create') {
                elementsToUpdate[id]();
            } else {
                saveCharacterDebounced();
            }
        });
    });

    $('#creator_notes_textarea').on('input', function () {
        const notes = String($('#creator_notes_textarea').val());
        const avatar = menu_type === 'create' ? '' : characters[this_chid]?.avatar;
        $('#creator_notes_spoiler').html(formatCreatorNotes(notes, avatar));
    });

    $('#favorite_button').on('click', function () {
        updateFavButtonState(!fav_ch_checked);
        if (menu_type != 'create') {
            saveCharacterDebounced();
        }
    });

    // CardApp settings save handlers
    $('#card_app_enabled').on('change', function () {
        if (menu_type === 'create') {
            if (!create_save.extensions) create_save.extensions = {};
            if (!create_save.extensions.card_app) create_save.extensions.card_app = {};
            create_save.extensions.card_app.enabled = !!$(this).prop('checked');
        } else if (this_chid !== undefined && characters[this_chid]) {
            if (!characters[this_chid].data.extensions) characters[this_chid].data.extensions = {};
            if (!characters[this_chid].data.extensions.card_app) characters[this_chid].data.extensions.card_app = {};
            characters[this_chid].data.extensions.card_app.enabled = !!$(this).prop('checked');
            saveCharacterDebounced();
        }
    });
    $('#card_app_entry').on('input', function () {
        const entry = String($(this).val() || 'index.js').trim();
        if (menu_type === 'create') {
            if (!create_save.extensions) create_save.extensions = {};
            if (!create_save.extensions.card_app) create_save.extensions.card_app = {};
            create_save.extensions.card_app.entry = entry;
        } else if (this_chid !== undefined && characters[this_chid]) {
            if (!characters[this_chid].data.extensions) characters[this_chid].data.extensions = {};
            if (!characters[this_chid].data.extensions.card_app) characters[this_chid].data.extensions.card_app = {};
            characters[this_chid].data.extensions.card_app.entry = entry;
            saveCharacterDebounced();
        }
    });

    /* $("#renameCharButton").on('click', renameCharacter); */

    $(document).on('click', '.renameChatButton', async function (e) {
        e.stopPropagation();
        const oldFileName = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block_filename').text();

        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, oldFileName);

        if (!newName || typeof newName !== 'string' || newName == oldFileName) {
            console.log('no new name found, aborting');
            return;
        }

        await renameChat(oldFileName, newName);

        await delay(250);
        $('#option_select_chat').trigger('click');
        $('#options').hide();
    });

    $(document).on('click', '.exportChatButton, .exportRawChatButton', async function (e) {
        e.stopPropagation();
        const format = $(this).data('format') || 'txt';
        await saveChatConditional();
        const filename = $(this).closest('.select_chat_block_wrapper').find('.select_chat_block_filename').text();
        console.log(`exporting ${filename} in ${format} format`);

        const body = {
            is_group: !!selected_group,
            avatar_url: characters[this_chid]?.avatar,
            file: `${filename}.jsonl`,
            exportfilename: `${filename}.${format}`,
            format: format,
        };
        console.log(body);
        try {
            const response = await fetch('/api/chats/export', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: getRequestHeaders(),
            });
            const data = await response.json();
            if (!response.ok) {
                // display error message
                console.log(data.message);
                await delay(250);
                toastr.error(`Error: ${data.message}`);
                return;
            } else {
                const mimeType = format == 'txt' ? 'text/plain' : 'application/octet-stream';
                // success, handle response data
                console.log(data);
                await delay(250);
                toastr.success(data.message);
                download(data.result, body.exportfilename, mimeType);
            }
        } catch (error) {
            // display error message
            console.log(`An error has occurred: ${error.message}`);
            await delay(250);
            toastr.error(`Error: ${error.message}`);
        }
    });


    const currentChatToolsPanel = $('#current_chat_tools_panel');
    const currentChatToolsQuery = $('#current_chat_tools_query');
    const currentChatToolsStatus = $('#current_chat_tools_status');
    const currentChatToolsPrev = $('#current_chat_tools_prev');
    const currentChatToolsNext = $('#current_chat_tools_next');
    const currentChatToolsClose = $('#current_chat_tools_close');
    const currentChatToolsHide = $('#current_chat_tools_hide');
    const currentChatToolsUnhide = $('#current_chat_tools_unhide');
    const currentChatToolsDelete = $('#current_chat_tools_delete');
    const currentChatToolsDeleteMode = $('#current_chat_tools_delete_mode');
    const currentChatToolsSelectAll = $('#current_chat_tools_select_all');
    const currentChatToolsSelectInvert = $('#current_chat_tools_select_invert');
    const currentChatToolsSelectClear = $('#current_chat_tools_select_clear');
    const currentChatToolsInsertRole = $('#current_chat_tools_insert_role');
    const currentChatToolsInsertText = $('#current_chat_tools_insert_text');
    const currentChatToolsInsertAt = $('#current_chat_tools_insert_at');
    const currentChatToolsInsertBefore = $('#current_chat_tools_insert_before');
    const currentChatToolsInsertAfter = $('#current_chat_tools_insert_after');
    const currentChatToolsList = $('#current_chat_tools_list');

    /** @type {JQuery<HTMLElement>[]} */
    let currentChatToolsMatches = [];
    let currentChatToolsMatchIndex = -1;
    let currentChatToolsLastQuery = '';
    /** @type {Set<number>} */
    const currentChatToolsSelectedIds = new Set();
    const CURRENT_CHAT_TOOLS_PREVIEW_MAX_CHARS = 120;

    function isCurrentChatToolsOpen() {
        return !currentChatToolsPanel.hasClass('displayNone');
    }

    function setCurrentChatToolsStatus(text) {
        currentChatToolsStatus.text(text);
    }

    function clearCurrentChatToolsHighlight() {
        chatElement.children('.mes.chat_tools_match_active, .mes.chat_tools_match_found')
            .removeClass('chat_tools_match_active chat_tools_match_found');
    }

    function clearCurrentChatToolsInlineHighlights(scope = chatElement) {
        scope.find('mark.chat_tools_inline_mark').each((_, markElement) => {
            const mark = markElement;
            const parent = mark.parentNode;
            if (!parent) {
                return;
            }
            parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
            parent.normalize();
        });
    }

    function escapeCurrentChatToolsRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function applyCurrentChatToolsInlineHighlights() {
        clearCurrentChatToolsInlineHighlights();

        const query = String(currentChatToolsQuery.val() ?? '').trim();
        if (!query) {
            return;
        }

        const regex = new RegExp(escapeCurrentChatToolsRegex(query), 'gi');
        const blockedTags = new Set(['MARK', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT']);

        const highlightElement = (element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                acceptNode(textNode) {
                    const parent = textNode.parentElement;
                    const text = textNode.nodeValue || '';
                    if (!parent || !text.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (blockedTags.has(parent.tagName)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return regex.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                },
            });

            /** @type {Text[]} */
            const nodes = [];
            let node = walker.nextNode();
            while (node) {
                nodes.push(/** @type {Text} */ (node));
                node = walker.nextNode();
            }

            for (const textNode of nodes) {
                const source = textNode.nodeValue || '';
                regex.lastIndex = 0;
                if (!regex.test(source)) {
                    continue;
                }

                const fragment = document.createDocumentFragment();
                let lastIndex = 0;
                regex.lastIndex = 0;

                source.replace(regex, (match, offset) => {
                    const index = Number(offset);
                    if (index > lastIndex) {
                        fragment.appendChild(document.createTextNode(source.slice(lastIndex, index)));
                    }
                    const mark = document.createElement('mark');
                    mark.className = 'chat_tools_inline_mark';
                    mark.textContent = match;
                    fragment.appendChild(mark);
                    lastIndex = index + match.length;
                    return match;
                });

                if (lastIndex < source.length) {
                    fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
                }

                textNode.parentNode?.replaceChild(fragment, textNode);
            }
        };

        for (const message of currentChatToolsMatches) {
            message.find('.mes_text, .mes_reasoning').each((_, element) => highlightElement(element));
        }
    }

    function applyCurrentChatToolsMatchHighlights() {
        chatElement.children('.mes.chat_tools_match_found').removeClass('chat_tools_match_found');
        for (const message of currentChatToolsMatches) {
            message.addClass('chat_tools_match_found');
        }
    }

    function scrollCurrentChatToolsMessageIntoView(messageElement) {
        const container = chatElement?.[0];
        const target = messageElement?.[0];
        if (!container || !target) {
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const currentScrollTop = container.scrollTop;
        const targetCenter = (targetRect.top - containerRect.top) + (targetRect.height / 2);
        const desiredScrollTop = currentScrollTop + targetCenter - (container.clientHeight / 2);
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const nextScrollTop = Math.max(0, Math.min(maxScrollTop, desiredScrollTop));

        chatElement.stop(true).animate({ scrollTop: nextScrollTop }, 140);
    }

    function getCurrentChatToolsMessageId() {
        if (currentChatToolsMatchIndex < 0 || currentChatToolsMatchIndex >= currentChatToolsMatches.length) {
            return null;
        }
        const messageId = Number(currentChatToolsMatches[currentChatToolsMatchIndex].attr('mesid'));
        return Number.isInteger(messageId) ? messageId : null;
    }

    function getCurrentChatToolsVisibleMessageIds() {
        return currentChatToolsMatches
            .map(message => Number(message.attr('mesid')))
            .filter(messageId => Number.isInteger(messageId));
    }

    function sanitizeCurrentChatToolsSelections() {
        for (const messageId of Array.from(currentChatToolsSelectedIds)) {
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= chat.length) {
                currentChatToolsSelectedIds.delete(messageId);
            }
        }
    }

    function getCurrentChatToolsSelectedMessageIds({ fallbackToActive = false } = {}) {
        sanitizeCurrentChatToolsSelections();
        const ids = Array.from(currentChatToolsSelectedIds)
            .filter(messageId => Number.isInteger(messageId) && messageId >= 0 && messageId < chat.length)
            .sort((a, b) => a - b);

        if (ids.length > 0 || !fallbackToActive) {
            return ids;
        }

        const activeId = getCurrentChatToolsMessageId();
        return activeId === null ? [] : [activeId];
    }

    function getCurrentChatToolsRoleLabel(message) {
        if (!message) {
            return t`Unknown`;
        }
        if (message.is_system || message.extra?.type === system_message_types.NARRATOR) {
            return t`System`;
        }
        return message.is_user ? t`User` : t`Assistant`;
    }

    function canMutateCurrentChatToolsMessages() {
        return Boolean(resolveChatStateTarget());
    }

    function getCurrentChatToolsReadOnlyText() {
        return document.querySelector('#chat .welcomePanel')
            ? t`Welcome screen messages are read-only.`
            : t`Current chat is read-only.`;
    }

    function getCurrentChatToolsMessagePreview(message) {
        const raw = String(message?.extra?.display_text ?? message?.mes ?? '');
        if (!raw) {
            return '';
        }

        const previewNode = document.createElement('div');
        previewNode.innerHTML = raw;
        const text = previewNode.textContent || previewNode.innerText || raw;
        return text.replace(/\s+/g, ' ').trim();
    }

    function truncateCurrentChatToolsPreview(text, maxChars = CURRENT_CHAT_TOOLS_PREVIEW_MAX_CHARS) {
        if (!text || text.length <= maxChars) {
            return text;
        }
        return `${text.slice(0, maxChars)}...`;
    }

    function appendCurrentChatToolsHighlightedText(target, text, query) {
        target.empty();
        if (!text) {
            return;
        }

        const normalizedQuery = String(query ?? '').trim();
        if (!normalizedQuery) {
            target.text(text);
            return;
        }

        const source = text;
        const sourceLower = source.toLocaleLowerCase();
        const queryLower = normalizedQuery.toLocaleLowerCase();
        if (!queryLower) {
            target.text(source);
            return;
        }

        let cursor = 0;
        while (cursor < source.length) {
            const hitIndex = sourceLower.indexOf(queryLower, cursor);
            if (hitIndex < 0) {
                target.append(document.createTextNode(source.slice(cursor)));
                break;
            }

            if (hitIndex > cursor) {
                target.append(document.createTextNode(source.slice(cursor, hitIndex)));
            }

            const mark = $('<mark class="chat_tools_match_mark"></mark>');
            mark.text(source.slice(hitIndex, hitIndex + normalizedQuery.length));
            target.append(mark);
            cursor = hitIndex + normalizedQuery.length;
        }
    }

    function getCurrentChatToolsInsertAt() {
        const raw = String(currentChatToolsInsertAt.val() ?? '').trim();
        if (!raw) {
            return null;
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > chat.length) {
            return Number.NaN;
        }
        return parsed;
    }

    function updateCurrentChatToolsStatus() {
        const query = String(currentChatToolsQuery.val() ?? '').trim();
        const selectedCount = getCurrentChatToolsSelectedMessageIds().length;
        const totalCount = currentChatToolsMatches.length;
        const readOnly = !canMutateCurrentChatToolsMessages();

        if (totalCount === 0) {
            if (!query && chat.length === 0) {
                setCurrentChatToolsStatus(readOnly ? getCurrentChatToolsReadOnlyText() : t`No messages in current chat.`);
                return;
            }
            setCurrentChatToolsStatus(t`No messages matched.`);
            return;
        }

        const currentIndex = Math.max(0, currentChatToolsMatchIndex) + 1;
        const status = selectedCount > 0
            ? `${t`Match`} ${currentIndex} / ${totalCount} · ${t`Selected`} ${selectedCount}`
            : `${t`Match`} ${currentIndex} / ${totalCount}`;
        setCurrentChatToolsStatus(readOnly ? `${status} · ${getCurrentChatToolsReadOnlyText()}` : status);
    }

    function toggleCurrentChatToolsButton(button, disabled) {
        button.toggleClass('disabled', disabled);
        button.attr('aria-disabled', String(disabled));
    }

    function updateCurrentChatToolsButtons() {
        const hasMatches = currentChatToolsMatches.length > 0;
        const hasSelectedOrActive = getCurrentChatToolsSelectedMessageIds({ fallbackToActive: true }).length > 0;
        const hasInsertText = String(currentChatToolsInsertText.val() ?? '').trim().length > 0;
        const explicitInsertAt = getCurrentChatToolsInsertAt();
        const hasValidExplicitInsertAt = explicitInsertAt === null || Number.isFinite(explicitInsertAt);
        const hasAnchorForInsert = getCurrentChatToolsMessageId() !== null || getCurrentChatToolsSelectedMessageIds().length > 0 || chat.length === 0;
        const canInsert = hasInsertText && hasValidExplicitInsertAt && (explicitInsertAt !== null || hasAnchorForInsert);
        const canMutate = canMutateCurrentChatToolsMessages();

        toggleCurrentChatToolsButton(currentChatToolsPrev, !hasMatches);
        toggleCurrentChatToolsButton(currentChatToolsNext, !hasMatches);
        toggleCurrentChatToolsButton(currentChatToolsSelectAll, !hasMatches);
        toggleCurrentChatToolsButton(currentChatToolsSelectInvert, !hasMatches);
        toggleCurrentChatToolsButton(currentChatToolsSelectClear, getCurrentChatToolsSelectedMessageIds().length === 0);
        toggleCurrentChatToolsButton(currentChatToolsHide, !canMutate || !hasSelectedOrActive);
        toggleCurrentChatToolsButton(currentChatToolsUnhide, !canMutate || !hasSelectedOrActive);
        toggleCurrentChatToolsButton(currentChatToolsDelete, !canMutate || !hasSelectedOrActive);
        toggleCurrentChatToolsButton(currentChatToolsDeleteMode, !canMutate || chat.length === 0);
        toggleCurrentChatToolsButton(currentChatToolsInsertBefore, !canMutate || !canInsert);
        toggleCurrentChatToolsButton(currentChatToolsInsertAfter, !canMutate || !canInsert);
    }

    function collectCurrentChatMatches(query) {
        const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
        /** @type {JQuery<HTMLElement>[]} */
        const found = [];

        chatElement.children('.mes').each((_, messageElement) => {
            const message = $(messageElement);
            if (!normalizedQuery) {
                found.push(message);
                return;
            }

            const searchableText = [
                String(message.find('.name_text').first().text() || ''),
                String(message.find('.mes_text').text() || ''),
                String(message.find('.mes_reasoning').text() || ''),
            ].join('\n').toLocaleLowerCase();

            if (searchableText.includes(normalizedQuery)) {
                found.push(message);
            }
        });

        return found;
    }

    function renderCurrentChatToolsList() {
        currentChatToolsList.empty();

        if (!currentChatToolsMatches.length) {
            return;
        }

        const activeMessageId = getCurrentChatToolsMessageId();
        const currentQuery = String(currentChatToolsQuery.val() ?? '').trim();
        for (const messageElement of currentChatToolsMatches) {
            const messageId = Number(messageElement.attr('mesid'));
            if (!Number.isInteger(messageId)) {
                continue;
            }

            const message = chat[messageId];
            const selected = currentChatToolsSelectedIds.has(messageId);
            const active = messageId === activeMessageId;
            const hidden = Boolean(message?.extra?.[IGNORE_SYMBOL]);

            const row = $('<div class="current_chat_tools_list_item"></div>');
            row.attr('data-mesid', String(messageId));
            if (selected) {
                row.addClass('selected');
            }
            if (active) {
                row.addClass('active');
            }

            const checkbox = $('<input type="checkbox" class="chat_tools_select_box">');
            checkbox.prop('checked', selected);

            const body = $('<div class="flex-container flexFlowColumn flex1"></div>');
            const meta = $('<div class="current_chat_tools_list_meta"></div>');
            meta.append($('<span></span>').text(`#${messageId + 1}`));
            meta.append($('<span></span>').text(getCurrentChatToolsRoleLabel(message)));
            if (hidden) {
                meta.append($('<span class="text_muted"></span>').text(t`Hidden from AI`));
            }

            const previewText = getCurrentChatToolsMessagePreview(message);
            const preview = $('<div class="current_chat_tools_list_preview"></div>');
            const previewDisplayText = truncateCurrentChatToolsPreview(previewText || t`(empty)`);
            appendCurrentChatToolsHighlightedText(preview, previewDisplayText, currentQuery);
            if (previewText) {
                preview.attr('title', previewText);
            }

            body.append(meta);
            body.append(preview);
            row.append(checkbox);
            row.append(body);
            currentChatToolsList.append(row);
        }
    }

    function setCurrentChatToolsActiveMatch(index, { scroll = true, flash = false } = {}) {
        if (!currentChatToolsMatches.length) {
            currentChatToolsMatchIndex = -1;
            clearCurrentChatToolsHighlight();
            renderCurrentChatToolsList();
            updateCurrentChatToolsStatus();
            updateCurrentChatToolsButtons();
            return;
        }

        currentChatToolsMatchIndex = ((index % currentChatToolsMatches.length) + currentChatToolsMatches.length) % currentChatToolsMatches.length;
        const currentMatch = currentChatToolsMatches[currentChatToolsMatchIndex];
        const activeMessageId = getCurrentChatToolsMessageId();

        clearCurrentChatToolsHighlight();
        applyCurrentChatToolsMatchHighlights();
        applyCurrentChatToolsInlineHighlights();
        if (activeMessageId !== null) {
            const activeMessage = chatElement.find(`.mes[mesid="${activeMessageId}"]`).first();
            activeMessage.addClass('chat_tools_match_active');
            if (flash) {
                flashHighlight(activeMessage, 1000);
            }
        }

        if (scroll) {
            scrollCurrentChatToolsMessageIntoView(currentMatch);
        }

        renderCurrentChatToolsList();
        updateCurrentChatToolsStatus();
        updateCurrentChatToolsButtons();
    }

    function refreshCurrentChatMatches({ recollect = false, scroll = false, flash = false } = {}) {
        const query = String(currentChatToolsQuery.val() ?? '').trim();
        const previousActiveId = getCurrentChatToolsMessageId();

        if (recollect || query !== currentChatToolsLastQuery) {
            currentChatToolsMatches = collectCurrentChatMatches(query);
            currentChatToolsLastQuery = query;

            if (previousActiveId !== null) {
                const index = currentChatToolsMatches.findIndex(message => Number(message.attr('mesid')) === previousActiveId);
                currentChatToolsMatchIndex = index >= 0 ? index : 0;
            }
        }

        if (!currentChatToolsMatches.length) {
            currentChatToolsMatchIndex = -1;
            clearCurrentChatToolsHighlight();
            clearCurrentChatToolsInlineHighlights();
            renderCurrentChatToolsList();
            updateCurrentChatToolsStatus();
            updateCurrentChatToolsButtons();
            return;
        }

        if (currentChatToolsMatchIndex < 0 || currentChatToolsMatchIndex >= currentChatToolsMatches.length) {
            currentChatToolsMatchIndex = 0;
        }

        setCurrentChatToolsActiveMatch(currentChatToolsMatchIndex, { scroll, flash });
    }

    function openCurrentChatToolsPanel() {
        currentChatToolsPanel.removeClass('displayNone');
        currentChatToolsQuery.trigger('focus');
        refreshCurrentChatMatches({ recollect: true, scroll: false });
    }

    function closeCurrentChatToolsPanel() {
        currentChatToolsPanel.addClass('displayNone');
        clearCurrentChatToolsHighlight();
        clearCurrentChatToolsInlineHighlights();
    }

    function toggleCurrentChatToolsPanel() {
        if (isCurrentChatToolsOpen()) {
            closeCurrentChatToolsPanel();
            return;
        }
        openCurrentChatToolsPanel();
    }

    function toMessageRanges(messageIds) {
        if (!messageIds.length) {
            return [];
        }

        const sortedIds = Array.from(new Set(messageIds)).sort((a, b) => a - b);
        const ranges = [];
        let start = sortedIds[0];
        let end = sortedIds[0];

        for (let i = 1; i < sortedIds.length; i++) {
            const messageId = sortedIds[i];
            if (messageId === end + 1) {
                end = messageId;
                continue;
            }
            ranges.push([start, end]);
            start = messageId;
            end = messageId;
        }
        ranges.push([start, end]);
        return ranges;
    }

    async function applyActionToCurrentSelection(action) {
        if (!canMutateCurrentChatToolsMessages()) {
            toastr.info(getCurrentChatToolsReadOnlyText());
            return;
        }

        const messageIds = getCurrentChatToolsSelectedMessageIds({ fallbackToActive: true });
        if (!messageIds.length) {
            toastr.info(t`No messages matched.`);
            return;
        }

        if (action === 'hide' || action === 'unhide') {
            const unhide = action === 'unhide';
            for (const [start, end] of toMessageRanges(messageIds)) {
                await hideChatMessageRange(start, end, unhide);
            }
        } else if (action === 'delete') {
            if (power_user.confirm_message_delete) {
                const confirmed = await callGenericPopup(t`Are you sure you want to delete selected messages?`, POPUP_TYPE.CONFIRM);
                if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                    return;
                }
            }

            for (const messageId of [...messageIds].sort((a, b) => b - a)) {
                await deleteMessage(messageId, undefined, false);
            }
        }

        currentChatToolsSelectedIds.clear();
        currentChatToolsLastQuery = '';
        refreshCurrentChatMatches({ recollect: true, scroll: false });
    }

    function createCurrentChatToolsInsertedMessage(role, text) {
        const baseMessage = {
            send_date: getMessageTimeStamp(),
            mes: text,
            extra: {},
        };

        if (role === 'user') {
            return {
                ...baseMessage,
                name: name1,
                is_user: true,
                is_system: false,
            };
        }

        if (role === 'system') {
            return {
                ...baseMessage,
                name: systemUserName,
                is_user: false,
                is_system: true,
                force_avatar: system_avatar,
                extra: {
                    type: system_message_types.GENERIC,
                },
            };
        }

        return {
            ...baseMessage,
            name: name2,
            is_user: false,
            is_system: false,
        };
    }

    function resolveInsertAnchorId(direction) {
        const selectedMessageIds = getCurrentChatToolsSelectedMessageIds();
        if (selectedMessageIds.length === 1) {
            return selectedMessageIds[0];
        }
        if (selectedMessageIds.length > 1) {
            return direction === 'before' ? selectedMessageIds[0] : selectedMessageIds[selectedMessageIds.length - 1];
        }
        return getCurrentChatToolsMessageId();
    }

    async function insertCurrentChatMessage(direction) {
        if (!canMutateCurrentChatToolsMessages()) {
            toastr.info(getCurrentChatToolsReadOnlyText());
            return;
        }

        const text = String(currentChatToolsInsertText.val() ?? '').trim();
        if (!text) {
            toastr.warning(t`Message text cannot be empty.`);
            return;
        }

        const role = String(currentChatToolsInsertRole.val() ?? 'assistant');
        const explicitInsertAt = getCurrentChatToolsInsertAt();
        let insertAt = 0;

        if (Number.isNaN(explicitInsertAt)) {
            toastr.warning(t`Insert position is invalid.`);
            return;
        }

        if (Number.isFinite(explicitInsertAt)) {
            const bounded = Math.max(0, Math.min(chat.length, explicitInsertAt));
            insertAt = direction === 'before'
                ? bounded
                : Math.min(chat.length, bounded + 1);
        } else {
            const anchorId = resolveInsertAnchorId(direction);
            insertAt = anchorId === null
                ? (direction === 'before' ? 0 : chat.length)
                : (direction === 'before' ? anchorId : anchorId + 1);
        }

        const message = createCurrentChatToolsInsertedMessage(role, text);
        chat.splice(insertAt, 0, message);
        chat_metadata['tainted'] = true;

        const patched = await patchChatMessages([{ op: 'add', path: `/${insertAt}`, value: message }]);
        if (!patched) {
            saveChatDebounced();
        }

        await reloadCurrentChat();

        currentChatToolsSelectedIds.clear();
        currentChatToolsSelectedIds.add(insertAt);
        currentChatToolsLastQuery = '';
        currentChatToolsInsertText.val('');
        refreshCurrentChatMatches({ recollect: true, scroll: true, flash: true });
    }

    currentChatToolsQuery.on('input', () => {
        currentChatToolsLastQuery = '';
        refreshCurrentChatMatches({ recollect: true, scroll: false });
    });

    currentChatToolsQuery.on('keydown', (event) => {
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        if (currentChatToolsMatches.length === 0) {
            refreshCurrentChatMatches({ recollect: true, scroll: true });
            return;
        }
        setCurrentChatToolsActiveMatch(currentChatToolsMatchIndex + 1, { scroll: true, flash: true });
    });

    currentChatToolsInsertText.on('input', () => {
        updateCurrentChatToolsButtons();
    });

    currentChatToolsInsertAt.on('input', () => {
        updateCurrentChatToolsButtons();
    });

    currentChatToolsPrev.on('click', (event) => {
        event.preventDefault();
        if (currentChatToolsPrev.hasClass('disabled')) {
            return;
        }
        setCurrentChatToolsActiveMatch(currentChatToolsMatchIndex - 1, { scroll: true, flash: true });
    });

    currentChatToolsNext.on('click', (event) => {
        event.preventDefault();
        if (currentChatToolsNext.hasClass('disabled')) {
            return;
        }
        setCurrentChatToolsActiveMatch(currentChatToolsMatchIndex + 1, { scroll: true, flash: true });
    });

    currentChatToolsClose.on('click', (event) => {
        event.preventDefault();
        closeCurrentChatToolsPanel();
    });

    currentChatToolsSelectAll.on('click', (event) => {
        event.preventDefault();
        if (currentChatToolsSelectAll.hasClass('disabled')) {
            return;
        }
        for (const messageId of getCurrentChatToolsVisibleMessageIds()) {
            currentChatToolsSelectedIds.add(messageId);
        }
        renderCurrentChatToolsList();
        updateCurrentChatToolsStatus();
        updateCurrentChatToolsButtons();
    });

    currentChatToolsSelectInvert.on('click', (event) => {
        event.preventDefault();
        if (currentChatToolsSelectInvert.hasClass('disabled')) {
            return;
        }
        for (const messageId of getCurrentChatToolsVisibleMessageIds()) {
            if (currentChatToolsSelectedIds.has(messageId)) {
                currentChatToolsSelectedIds.delete(messageId);
            } else {
                currentChatToolsSelectedIds.add(messageId);
            }
        }
        renderCurrentChatToolsList();
        updateCurrentChatToolsStatus();
        updateCurrentChatToolsButtons();
    });

    currentChatToolsSelectClear.on('click', (event) => {
        event.preventDefault();
        if (currentChatToolsSelectClear.hasClass('disabled')) {
            return;
        }
        currentChatToolsSelectedIds.clear();
        renderCurrentChatToolsList();
        updateCurrentChatToolsStatus();
        updateCurrentChatToolsButtons();
    });

    currentChatToolsHide.on('click', async (event) => {
        event.preventDefault();
        if (currentChatToolsHide.hasClass('disabled')) {
            return;
        }
        await applyActionToCurrentSelection('hide');
    });

    currentChatToolsUnhide.on('click', async (event) => {
        event.preventDefault();
        if (currentChatToolsUnhide.hasClass('disabled')) {
            return;
        }
        await applyActionToCurrentSelection('unhide');
    });

    currentChatToolsDelete.on('click', async (event) => {
        event.preventDefault();
        if (currentChatToolsDelete.hasClass('disabled')) {
            return;
        }
        await applyActionToCurrentSelection('delete');
    });

    currentChatToolsDeleteMode.on('click', (event) => {
        event.preventDefault();
        setTimeout(() => openMessageDelete(false), animation_duration);
    });

    currentChatToolsInsertBefore.on('click', async (event) => {
        event.preventDefault();
        if (currentChatToolsInsertBefore.hasClass('disabled')) {
            return;
        }
        await insertCurrentChatMessage('before');
    });

    currentChatToolsInsertAfter.on('click', async (event) => {
        event.preventDefault();
        if (currentChatToolsInsertAfter.hasClass('disabled')) {
            return;
        }
        await insertCurrentChatMessage('after');
    });

    currentChatToolsList.on('click', '.current_chat_tools_list_item', (event) => {
        const row = $(event.currentTarget);
        const messageId = Number(row.attr('data-mesid'));
        if (!Number.isInteger(messageId)) {
            return;
        }

        const index = currentChatToolsMatches.findIndex(message => Number(message.attr('mesid')) === messageId);
        if (index >= 0) {
            currentChatToolsInsertAt.val(String(messageId));
            setCurrentChatToolsActiveMatch(index, { scroll: true, flash: true });
        }
    });

    currentChatToolsList.on('click', '.chat_tools_select_box', (event) => {
        event.stopPropagation();
    });

    currentChatToolsList.on('change', '.chat_tools_select_box', (event) => {
        event.stopPropagation();
        const checkbox = $(event.currentTarget);
        const row = checkbox.closest('.current_chat_tools_list_item');
        const messageId = Number(row.attr('data-mesid'));
        if (!Number.isInteger(messageId)) {
            return;
        }

        if (checkbox.prop('checked')) {
            currentChatToolsSelectedIds.add(messageId);
        } else {
            currentChatToolsSelectedIds.delete(messageId);
        }

        renderCurrentChatToolsList();
        updateCurrentChatToolsStatus();
        updateCurrentChatToolsButtons();
    });

    const refreshCurrentChatToolsOnUpdate = () => {
        if (!isCurrentChatToolsOpen()) {
            return;
        }
        currentChatToolsLastQuery = '';
        refreshCurrentChatMatches({ recollect: true, scroll: false });
    };

    eventSource.on(event_types.MESSAGE_SENT, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.MESSAGE_RECEIVED, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.MESSAGE_UPDATED, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.MESSAGE_EDITED, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.MESSAGE_DELETED, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.CHAT_CHANGED, refreshCurrentChatToolsOnUpdate);
    eventSource.on(event_types.CHAT_LOADED, refreshCurrentChatToolsOnUpdate);

    updateCurrentChatToolsButtons();

    const button = $('#options_button');
    const menu = $('#options');
    let isOptionsMenuVisible = false;

    function showMenu() {
        showBookmarksButtons();
        menu.fadeIn(animation_duration);
        optionsPopper.update();
        isOptionsMenuVisible = true;
    }

    function hideMenu() {
        menu.fadeOut(animation_duration);
        optionsPopper.update();
        isOptionsMenuVisible = false;
    }

    function isMouseOverButtonOrMenu() {
        return menu.is(':hover, :focus-within') || button.is(':hover, :focus');
    }

    button.on('click', function () {
        if (isOptionsMenuVisible) {
            hideMenu();
        } else {
            showMenu();
        }
    });
    $('#immersive_mode_toggle').on('click', async function () {
        await toggleImmersiveMode();
    });
    document.addEventListener('fullscreenchange', () => { void onImmersiveFullscreenChanged(); });
    document.addEventListener('webkitfullscreenchange', () => { void onImmersiveFullscreenChanged(); });
    updateImmersiveModeUi();
    $(document).on('click', function () {
        if (!isOptionsMenuVisible) return;
        if (!isMouseOverButtonOrMenu()) { hideMenu(); }
    });

    /* $('#set_chat_character_settings').on('click', setScenarioOverride); */

    ///////////// OPTIMIZED LISTENERS FOR LEFT SIDE OPTIONS POPUP MENU //////////////////////
    $('#options [id]').on('click', async function (event, customData) {
        const fromSlashCommand = customData?.fromSlashCommand || false;
        var id = $(this).attr('id');

        // Check whether a custom prompt was provided via custom data (for example through a slash command)
        const additionalPrompt = customData?.additionalPrompt?.trim() || undefined;
        const buildOrFillAdditionalArgs = (args = {}) => ({
            ...args,
            ...(additionalPrompt !== undefined && { quiet_prompt: additionalPrompt, quietToLoud: true }),
        });

        if (id == 'option_select_chat') {
            if (this_chid === undefined && !is_send_press && !selected_group) {
                await openPermanentAssistantCard();
            }
            if ((selected_group && !is_group_generating) || (this_chid !== undefined && !is_send_press) || fromSlashCommand) {
                await displayPastChats();
                //this is just to avoid the shadow for past chat view when using /delchat
                //however, the dialog popup still gets one..
                if (!fromSlashCommand) {
                    console.log('displaying shadow');
                    $('#shadow_select_chat_popup').css('display', 'block');
                    $('#shadow_select_chat_popup').css('opacity', 0.0);
                    $('#shadow_select_chat_popup').transition({
                        opacity: 1.0,
                        duration: animation_duration,
                        easing: animation_easing,
                    });
                }
            }
        } else if (id == 'option_start_new_chat') {
            if ((selected_group || this_chid !== undefined) && !is_send_press) {
                let deleteCurrentChat = false;
                const result = await Popup.show.confirm(t`Start new chat?`, await renderTemplateAsync('newChatConfirm'), {
                    onClose: () => { deleteCurrentChat = !!$('#del_chat_checkbox').prop('checked'); },
                });
                if (!result) {
                    return;
                }

                await doNewChat({ deleteCurrentChat: deleteCurrentChat });
            }
            if (!selected_group && this_chid === undefined && !is_send_press) {
                const alreadyInTempChat = this_chid === undefined && name2 === neutralCharacterName;
                await newAssistantChat({ temporary: alreadyInTempChat });
            }
        } else if (id == 'option_regenerate') {
            //Attempting to regenerate a user message will instead generate a new message.
            if (chat.length && chat.length - 1 === this_edit_mes_id && chat[this_edit_mes_id]?.is_user == false) {
                toastr.warning(t`Finish the edit before starting a generation.`, t`You cannot regenerate the message you are editing.`);
                return;
            }
            if (is_send_press == false) {
                if (selected_group) {
                    regenerateGroup();
                } else {
                    is_send_press = true;
                    Generate('regenerate', buildOrFillAdditionalArgs());
                }
            }
        } else if (id == 'option_impersonate') {
            if (is_send_press == false || fromSlashCommand) {
                is_send_press = true;
                Generate('impersonate', buildOrFillAdditionalArgs());
            }
        } else if (id == 'option_continue') {
            if (swipeState == SWIPE_STATE.EDITING) {
                toastr.warning(t`Confirm the edit to start a generation.`, t`You cannot send a message during a swipe-edit.`);
                return;
            }
            if (chat.length && chat.length - 1 === this_edit_mes_id) {
                toastr.warning(t`Finish the edit before starting a generation.`, t`You cannot continue the message you are editing.`);
                return;
            }

            if (is_send_press == false || fromSlashCommand) {
                is_send_press = true;
                Generate('continue', buildOrFillAdditionalArgs());
            }
        } else if (id == 'option_delete_mes') {
            setTimeout(() => openMessageDelete(fromSlashCommand), animation_duration);
        }

        else if (id == 'option_search_chat') {
            toggleCurrentChatToolsPanel();
        }

        else if (id == 'option_close_chat') {
            await closeCurrentChat();
        }

        else if (id === 'option_settings') {
            await toggleImmersiveMode();
        }
        hideMenu();
    });

    $('#newChatFromManageScreenButton').on('click', async function () {
        await doNewChat({ deleteCurrentChat: false });
        $('#select_chat_cross').trigger('click');
    });

    //////////////////////////////////////////////////////////////////////////////////////////////

    //functionality for the cancel delete messages button, reverts to normal display of input form
    $('#dialogue_del_mes_cancel').on('click', function () {
        $('#dialogue_del_mes').css('display', 'none');
        $('#send_form').css('display', css_send_form_display);
        $('.del_checkbox').each(function () {
            $(this).css('display', 'none');
            $(this).parent().children('.for_checkbox').css('display', 'block');
            $(this).parent().removeClass('selected');
            $(this).prop('checked', false);
        });
        showSwipeButtons();
        this_del_mes = -1;
        is_delete_mode = false;
    });

    //confirms message deletion with the "ok" button
    $('#dialogue_del_mes_ok').on('click', async function () {
        $('#dialogue_del_mes').css('display', 'none');
        $('#send_form').css('display', css_send_form_display);
        $('.del_checkbox').each(function () {
            $(this).css('display', 'none');
            $(this).parent().children('.for_checkbox').css('display', 'block');
            $(this).parent().removeClass('selected');
            $(this).prop('checked', false);
        });

        if (this_del_mes >= 0) {
            const deletedPlayablePrefix = chat
                .slice(0, this_del_mes)
                .reduce((count, message) => count + (message && !message.is_system ? 1 : 0), 0);
            const deletedPlayableCount = chat
                .slice(this_del_mes)
                .reduce((count, message) => count + (message && !message.is_system ? 1 : 0), 0);
            const deletedAssistantPrefix = chat
                .slice(0, this_del_mes)
                .reduce((count, message) => count + (message && !message.is_system && !message.is_user ? 1 : 0), 0);
            const deletedAssistantCount = chat
                .slice(this_del_mes)
                .reduce((count, message) => count + (message && !message.is_system && !message.is_user ? 1 : 0), 0);
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).nextAll('div').remove();
            chatElement.find(`.mes[mesid="${this_del_mes}"]`).remove();
            chat.length = this_del_mes;
            chat_metadata.tainted = true;
            await saveChatConditional();
            chatElement.scrollTop(chatElement[0].scrollHeight);
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length, {
                kind: 'delete',
                deletedPlayableSeqFrom: deletedPlayableCount > 0 ? deletedPlayablePrefix + 1 : null,
                deletedPlayableSeqTo: deletedPlayableCount > 0 ? deletedPlayablePrefix + deletedPlayableCount : null,
                deletedAssistantSeqFrom: deletedAssistantCount > 0 ? deletedAssistantPrefix + 1 : null,
                deletedAssistantSeqTo: deletedAssistantCount > 0 ? deletedAssistantPrefix + deletedAssistantCount : null,
            });
            chatElement.find('.mes').removeClass('last_mes');
            chatElement.find('.mes').last().addClass('last_mes');
        } else {
            console.log('this_del_mes is not >= 0, not deleting');
        }

        showSwipeButtons();
        this_del_mes = -1;
        is_delete_mode = false;
    });

    $('#main_api').on('change', async function () {
        cancelStatusCheck('Canceled because main api changed');
        changeMainAPI();
        saveSettingsDebounced();
        await eventSource.emit(event_types.MAIN_API_CHANGED, { apiId: main_api });
    });

    ////////////////// OPTIMIZED RANGE SLIDER LISTENERS////////////////

    var sliderLocked = true;
    var sliderTimer;

    $('input[type=\'range\']').on('touchstart', function () {
        // Unlock the slider after 300ms
        setTimeout(function () {
            sliderLocked = false;
            $(this).css('background-color', 'var(--SmartThemeQuoteColor)');
        }.bind(this), 300);
    });

    $('input[type=\'range\']').on('touchend', function () {
        clearTimeout(sliderTimer);
        $(this).css('background-color', '');
        sliderLocked = true;
    });

    $('input[type=\'range\']').on('touchmove', function (event) {
        if (sliderLocked) {
            event.preventDefault();
        }
    });

    const sliders = [
        {
            sliderId: '#amount_gen',
            counterId: '#amount_gen_counter',
            format: (val) => `${val}`,
            setValue: (val) => { amount_gen = Number(val); },
        },
        {
            sliderId: '#max_context',
            counterId: '#max_context_counter',
            format: (val) => `${val}`,
            setValue: (val) => { max_context = Number(val); },
        },
    ];

    sliders.forEach(slider => {
        $(document).on('input', slider.sliderId, function () {
            const value = $(this).val();
            const formattedValue = slider.format(value);
            slider.setValue(value);
            $(slider.counterId).val(formattedValue);
            saveSettingsDebounced();
        });
    });

    //////////////////////////////////////////////////////////////

    $('#select_chat_cross').on('click', function () {
        $('#shadow_select_chat_popup').transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
        });
        setTimeout(function () { $('#shadow_select_chat_popup').css('display', 'none'); }, animation_duration);
    });

    $(document).on('pointerup', '.mes_copy', async function () {
        if (this_chid !== undefined || selected_group || name2 === neutralCharacterName) {
            try {
                const messageId = $(this).closest('.mes').attr('mesid');
                const text = chat[messageId].mes;
                await copyText(text);
                toastr.info('Copied!', '', { timeOut: 2000 });
            } catch (err) {
                console.error('Failed to copy: ', err);
            }
        }
    });

    //********************
    //***Message Editor***
    $(document).on('click', '.mes_edit', async function () {
        if (is_delete_mode) {
            return;
        }
        if (this_chid !== undefined || selected_group || name2 === neutralCharacterName) {
            // Previously system messages we're allowed to be edited
            /*const message = $(this).closest(".mes");

            if (message.data("isSystem")) {
                return;
            }*/

            if (this_edit_mes_id >= 0) {
                let mes_edited = chatElement.find(`[mesid="${this_edit_mes_id}"]`).find('.mes_edit_done');
                if (Number(edit_mes_id) == chat.length - 1) { //if the generating swipe (...)
                    let run_edit = true;
                    if (chat[edit_mes_id].swipe_id !== undefined) {
                        if (chat[edit_mes_id].swipes.length === chat[edit_mes_id].swipe_id) {
                            run_edit = false;
                        }
                    }
                    if (run_edit) {
                        hideSwipeButtons();
                    }
                }
                await messageEditDone(mes_edited);
            }
            var edit_mes_id = Number($(this).closest('.mes').attr('mesid'));

            await messageEdit(edit_mes_id);
        }
    });

    $(document).on('input', '#curEditTextarea', function () {
        if (power_user.auto_save_msg_edits === true) {
            messageEditAuto($(this));
        }
    });

    $(document).on('click', '.extraMesButtonsHint', function (e) {
        const $hint = $(e.target);
        const $buttons = $hint.siblings('.extraMesButtons');

        $hint.transition({
            opacity: 0,
            duration: animation_duration,
            easing: animation_easing,
            complete: function () {
                $hint.hide();
                $buttons
                    .addClass('visible')
                    .css({
                        opacity: 0,
                        display: 'flex',
                    })
                    .transition({
                        opacity: 1,
                        duration: animation_duration,
                        easing: animation_easing,
                    });
            },
        });
    });

    $(document).on('click', function (e) {
        // Expanded options don't need to be closed
        if (power_user.expand_message_actions) {
            return;
        }

        // Check if the click was outside the relevant elements
        if (!$(e.target).closest('.extraMesButtons, .extraMesButtonsHint').length) {
            const $visibleButtons = $('.extraMesButtons.visible');

            if (!$visibleButtons.length) {
                return;
            }

            const $hiddenHints = $('.extraMesButtonsHint:hidden');

            // Transition out the .extraMesButtons first
            $visibleButtons.transition({
                opacity: 0,
                duration: animation_duration,
                easing: animation_easing,
                complete: function () {
                    // Hide the .extraMesButtons after the transition
                    $(this)
                        .hide()
                        .removeClass('visible');

                    // Transition the .extraMesButtonsHint back in
                    $hiddenHints
                        .show()
                        .transition({
                            opacity: 0.3,
                            duration: animation_duration,
                            easing: animation_easing,
                            complete: function () {
                                $(this).css('opacity', '');
                            },
                        });
                },
            });
        }
    });

    $(document).on('click', '.mes_edit_cancel', async function () {
        await messageEditCancel.call(this, this_edit_mes_id);
    });

    $(document).on('click', '.mes_edit_up', async function () {
        if (this_edit_mes_id <= 0) {
            return;
        }
        const targetId = Number(this_edit_mes_id) - 1;
        await messageEditMove(this_edit_mes_id, targetId);
    });

    $(document).on('click', '.mes_edit_down', async function () {
        if (this_edit_mes_id >= chat.length - 1) {
            return;
        }

        const targetId = Number(this_edit_mes_id) + 1;
        await messageEditMove(this_edit_mes_id, targetId);
    });

    $(document).on('click', '.mes_edit_copy', async function () {
        const confirmation = await callGenericPopup(t`Create a copy of this message?`, POPUP_TYPE.CONFIRM);
        if (!confirmation) {
            return;
        }

        hideSwipeButtons();
        const oldScroll = chatElement[0].scrollTop;
        const clone = structuredClone(chat[this_edit_mes_id]);
        clone.send_date = Date.now();
        const this_edit_mes_element = $(this).closest('.mes');
        clone.mes = this_edit_mes_element.find('.edit_textarea').val().toString();

        if (power_user.trim_spaces) {
            clone.mes = clone.mes.trim();
        }

        chat.splice(Number(this_edit_mes_id) + 1, 0, clone);
        const newMessageElement = updateMessageElement(clone);
        this_edit_mes_element.after(newMessageElement);

        updateViewMessageIds();
        await saveChatConditional();
        chatElement[0].scrollTop = oldScroll;
        showSwipeButtons();
    });

    $(document).on('click', '.mes_edit_delete', async function (event, customData) {
        const fromSlashCommand = customData?.fromSlashCommand || false;
        const message = chat[this_edit_mes_id];
        const selectedSwipe = message.swipe_id ?? undefined;
        const swipesArray = Array.isArray(message.swipes) ? message.swipes : [];
        const canDeleteSwipe = power_user.confirm_message_delete && !fromSlashCommand && !message.is_user && swipesArray.length > 1 && this_edit_mes_id === chat.length - 1 && selectedSwipe !== undefined;
        await deleteMessage(Number(this_edit_mes_id), canDeleteSwipe ? selectedSwipe : undefined, power_user.confirm_message_delete && fromSlashCommand !== true);
    });

    $(document).on('click', '.mes_edit_done', async function () {
        await messageEditDone($(this));
    });

    //Select chat

    //**************************CHARACTER IMPORT EXPORT*************************//
    $('#character_import_button').on('click', function () {
        $('#character_import_file').trigger('click');
    });

    $('#character_import_file').on('change', async function (e) {
        $('#rm_info_avatar').html('');

        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }

        if (!e.target.files.length) {
            return;
        }

        const avatarFileNames = [];
        for (const file of e.target.files) {
            const avatarFileName = await importCharacter(file);
            if (avatarFileName !== undefined) {
                avatarFileNames.push(avatarFileName);
            }
        }

        if (avatarFileNames.length > 0) {
            await importCharactersTags(avatarFileNames);
            selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);
        }

        // Clear the file input value to allow re-uploading the same file
        e.target.value = '';
    });

    $('#export_button').on('click', function () {
        isExportPopupOpen = !isExportPopupOpen;
        $('#export_format_popup').toggle(isExportPopupOpen);
        exportPopper.update();
    });

    $(document).on('click', '.export_format', async function () {
        const format = $(this).data('format');

        if (!format) {
            return;
        }

        $('#export_format_popup').hide();
        isExportPopupOpen = false;
        exportPopper.update();

        // Save before exporting
        await createOrEditCharacter();
        const body = { format, avatar_url: characters[this_chid].avatar };

        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const filename = characters[this_chid].avatar.replace('.png', `.${format}`);
            const blob = await response.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.setAttribute('download', filename);
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            document.body.removeChild(a);
        }
    });
    //**************************CHAT IMPORT EXPORT*************************//
    $('#chat_import_button').on('click', function () {
        $('#chat_import_file').trigger('click');
    });

    $('#chat_import_file').on('change', async function (e) {
        const targetElement = e.target;
        const formElement = document.getElementById('form_import_chat');
        if (!(targetElement instanceof HTMLInputElement) || !(formElement instanceof HTMLFormElement)) {
            return;
        }

        const importedFileNames = [];

        for (const file of targetElement.files) {
            const ext = file.name.match(/\.(\w+)$/);
            const format = ext?.[1]?.toLowerCase();

            if (!['json', 'jsonl'].includes(format)) {
                toastr.warning(t`Only JSON and JSONL files are supported for chat imports.`);
                continue;
            }

            if (selected_group && format === 'json') {
                toastr.warning(t`Only Luker's own format is supported for group chat imports. Sorry!`);
                continue;
            }

            const formData = new FormData(formElement);
            formData.set('file_type', format);
            formData.set('avatar', file);
            formData.set('user_name', name1);

            const importFn = selected_group ? importGroupChat : importCharacterChat;
            const result = await importFn(formData, { refresh: false });
            importedFileNames.push(...result);
        }

        if (importedFileNames.length > 0) {
            toastr.success(t`Successfully imported ${importedFileNames.length} chat(s).`);
        }

        await displayPastChats(importedFileNames);

        targetElement.value = '';
    });

    $('#rm_button_group_chats').on('click', function () {
        selected_button = 'group_chats';
        select_group_chats(null, false);
    });

    $('#rm_button_back_from_group').on('click', function () {
        selected_button = 'characters';
        select_rm_characters();
    });

    $('#dupe_button').on('click', async function () {
        await duplicateCharacter();
    });

    $(document).on('click', '.mes_stop', function () {
        stopGeneration();
    });

    $(document).on('click', '#form_sheld .stscript_continue', function () {
        pauseScriptExecution();
    });

    $(document).on('click', '#form_sheld .stscript_pause', function () {
        pauseScriptExecution();
    });

    $(document).on('click', '#form_sheld .stscript_stop', function () {
        stopScriptExecution();
    });

    $(document).on('click', '.drawer-opener', doDrawerOpenClick);

    $('.drawer-toggle').on('click', doNavbarIconClick);

    $('html').on('touchstart mousedown', async function (e) {
        const clickTarget = $(e.target);

        if (isExportPopupOpen
            && clickTarget.closest('#export_button').length == 0
            && clickTarget.closest('#export_format_popup').length == 0) {
            $('#export_format_popup').hide();
            isExportPopupOpen = false;
            exportPopper.update();
        }

        const forbiddenTargets = [
            '#character_cross',
            '#avatar-and-name-block',
            '#shadow_popup',
            '.popup',
            '#world_popup',
            '.ui-widget',
            '.text_pole',
            '#toast-container',
            '.select2-results',
        ];

        for (const id of forbiddenTargets) {
            if (clickTarget.closest(id).length > 0) {
                return;
            }
        }

        // This autocloses open drawers that are not pinned if a click happens inside the app which does not target them.
        const targetParentHasOpenDrawer = clickTarget.parents('.openDrawer').length;
        if (!clickTarget.hasClass('drawer-icon') && !clickTarget.hasClass('openDrawer')) {
            const $openDrawers = $('.openDrawer').not('.pinnedOpen');
            if ($openDrawers.length && targetParentHasOpenDrawer === 0) {
                // Toggle icon and drawer classes
                $('.openIcon').not('.drawerPinnedOpen').toggleClass('closedIcon openIcon');
                $openDrawers.toggleClass('closedDrawer openDrawer');
            }
        }
    });

    $(document).on('click', '.inline-drawer-toggle', async function (e) {
        if ($(e.target).hasClass('text_pole')) {
            return;
        }
        const drawer = $(this).closest('.inline-drawer');
        const icon = drawer.find('>.inline-drawer-header .inline-drawer-icon');
        const drawerContent = drawer.find('>.inline-drawer-content');
        icon.toggleClass('down up');
        icon.toggleClass('fa-circle-chevron-down fa-circle-chevron-up');
        drawer.trigger('inline-drawer-toggle');
        drawerContent.stop().slideToggle({
            complete: function () {
                $(this).css('height', '');
            },
        });

        // Set the height of "autoSetHeight" textareas within the inline-drawer to their scroll height
        if (!CSS.supports('field-sizing', 'content')) {
            const textareas = drawerContent.find('textarea.autoSetHeight');
            for (const textarea of textareas) {
                await resetScrollHeight($(textarea));
            }
        }
    });

    $(document).on('click', '.inline-drawer-maximize', function () {
        const icon = $(this).find('.inline-drawer-icon, .floating_panel_maximize');
        icon.toggleClass('fa-window-maximize fa-window-restore');
        const drawerContent = $(this).closest('.drawer-content');
        drawerContent.toggleClass('maximized');
        const drawerId = drawerContent.attr('id');
        resetMovableStyles(drawerId);
    });

    $(document).on('click', '.mes .avatar', function () {
        const messageElement = $(this).closest('.mes');
        const thumbURL = $(this).children('img').attr('src');
        const charsPath = '/characters/';
        const targetAvatarImg = thumbURL.substring(thumbURL.lastIndexOf('=') + 1);
        const charname = targetAvatarImg.replace('.png', '');
        const isValidCharacter = characters.some(x => x.avatar === decodeURIComponent(targetAvatarImg));

        // Remove existing zoomed avatars for characters that are not the clicked character when moving UI is not enabled
        if (!power_user.movingUI) {
            $('.zoomed_avatar').each(function () {
                const currentForChar = $(this).attr('forChar');
                if (currentForChar !== charname && typeof currentForChar !== 'undefined') {
                    console.debug(`Removing zoomed avatar for character: ${currentForChar}`);
                    $(this).remove();
                }
            });
        }

        const avatarSrc = (isDataURL(thumbURL) || /^\/?img\/(?:.+)/.test(thumbURL)) ? thumbURL : charsPath + targetAvatarImg;
        if ($(`.zoomed_avatar[forChar="${charname}"]`).length) {
            console.debug('removing container as it already existed');
            $(`.zoomed_avatar[forChar="${charname}"]`).fadeOut(animation_duration, () => {
                $(`.zoomed_avatar[forChar="${charname}"]`).remove();
            });
        } else {
            console.debug('making new container from template');
            const template = $('#zoomed_avatar_template').html();
            const newElement = $(template);
            newElement.attr('forChar', charname);
            newElement.attr('id', `zoomFor_${charname}`);
            newElement.addClass('draggable');
            newElement.find('.drag-grabber').attr('id', `zoomFor_${charname}header`);

            $('body').append(newElement);
            newElement.fadeIn(animation_duration);
            const zoomedAvatarImgElement = $(`.zoomed_avatar[forChar="${charname}"] img`);
            if (messageElement.attr('is_user') == 'true' || (messageElement.attr('is_system') == 'true' && !isValidCharacter)) {
                //handle user and system avatars
                const isValidPersona = decodeURIComponent(targetAvatarImg) in power_user.personas;
                if (isValidPersona) {
                    const personaSrc = getUserAvatar(targetAvatarImg);
                    zoomedAvatarImgElement.attr('src', personaSrc);
                    zoomedAvatarImgElement.attr('data-izoomify-url', personaSrc);
                } else {
                    zoomedAvatarImgElement.attr('src', thumbURL);
                    zoomedAvatarImgElement.attr('data-izoomify-url', thumbURL);
                }
            } else if (messageElement.attr('is_user') == 'false') { //handle char avatars
                zoomedAvatarImgElement.attr('src', avatarSrc);
                zoomedAvatarImgElement.attr('data-izoomify-url', avatarSrc);
            }
            loadMovingUIState();
            $(`.zoomed_avatar[forChar="${charname}"]`).css('display', 'flex');
            dragElement(newElement);

            if (power_user.zoomed_avatar_magnification) {
                $('.zoomed_avatar_container').izoomify();
            }

            $('.zoomed_avatar, .zoomed_avatar .dragClose').on('click touchend', (e) => {
                if (e.target.closest('.dragClose')) {
                    $(`.zoomed_avatar[forChar="${charname}"]`).fadeOut(animation_duration, () => {
                        $(`.zoomed_avatar[forChar="${charname}"]`).remove();
                    });
                }
            });

            zoomedAvatarImgElement.on('dragstart', (e) => {
                console.log('saw drag on avatar!');
                e.preventDefault();
                return false;
            });
        }
    });

    document.addEventListener('click', function (e) {
        if (!(e.target instanceof HTMLElement)) return;
        if (e.target.matches('#OpenAllWIEntries')) {
            document.querySelectorAll('#world_popup_entries_list .inline-drawer').forEach((/** @type {HTMLElement} */ drawer) => {
                delay(0).then(() => toggleDrawer(drawer, true));
            });
        } else if (e.target.matches('#CloseAllWIEntries')) {
            document.querySelectorAll('#world_popup_entries_list .inline-drawer').forEach((/** @type {HTMLElement} */ drawer) => {
                toggleDrawer(drawer, false);
            });
        }
    });

    $(document).on('click', '.open_alternate_greetings', openAlternateGreetings);
    /* $('#set_character_world').on('click', openCharacterWorldPopup); */

    $(document).on('focus', 'input.auto-select, textarea.auto-select', function () {
        if (!power_user.enable_auto_select_input) return;
        const control = $(this)[0];
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
            control.select();
            console.debug('Auto-selecting content of input control', control);
        }
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && !e.originalEvent.isComposing) {
            const isEditVisible = $('#curEditTextarea').is(':visible') || $('.reasoning_edit_textarea').length > 0;
            if (isEditVisible && power_user.auto_save_msg_edits === false) {
                closeMessageEditor('all');
                $('#send_textarea').trigger('focus');
                return;
            }
            if (isEditVisible && power_user.auto_save_msg_edits === true) {
                chatElement.find(`.mes[mesid="${this_edit_mes_id}"] .mes_edit_done`).trigger('click');
                closeMessageEditor('reasoning');
                $('#send_textarea').trigger('focus');
                return;
            }
            if (this_edit_mes_id === undefined && $('#mes_stop').is(':visible')) {
                $('#mes_stop').trigger('click');
                if (chat.length === 0) return;
                const lastMessage = chat[chat.length - 1];
                if (Array.isArray(lastMessage.swipes) && lastMessage.swipe_id == lastMessage.swipes.length) {
                    $('.last_mes .swipe_left').trigger('click');
                }
            }
        }
    });

    $('#char-management-dropdown').on('change', async (e) => {
        const targetElement = /** @type {HTMLSelectElement} */ (e.target);
        const target = $(targetElement.selectedOptions).attr('id');
        switch (target) {
            case 'set_character_world':
                await openCharacterWorldPopup();
                break;
            case 'set_chat_character_settings':
                await setCharacterSettingsOverrides();
                break;
            case 'renameCharButton':
                await renameCharacter();
                break;
            case 'import_character_info':
                await importEmbeddedWorldInfo();
                saveCharacterDebounced();
                break;
            case 'character_source': {
                const source = getCharacterSource(this_chid);
                if (source && isValidUrl(source)) {
                    const url = new URL(source);
                    const confirm = await Popup.show.confirm('Open Source', `<span>Do you want to open the link to ${url.hostname} in a new tab?</span><var>${url}</var>`);
                    if (confirm) {
                        window.open(source, '_blank');
                    }
                } else {
                    toastr.info('This character doesn\'t seem to have a source.');
                }
            } break;
            case 'replace_update': {
                let onlineUrl = getCharacterSource(this_chid);
                const previousCharacter = (characters[this_chid] && typeof characters[this_chid] === 'object')
                    ? (typeof structuredClone === 'function'
                        ? structuredClone(characters[this_chid])
                        : JSON.parse(JSON.stringify(characters[this_chid])))
                    : null;
                const previousAvatar = String(previousCharacter?.avatar || characters[this_chid]?.avatar || '').trim();
                const previousBookName = String(previousCharacter?.data?.extensions?.world || '').trim();
                let previousLorebookSnapshot = null;
                if (previousBookName) {
                    try {
                        const response = await fetch('/api/worldinfo/get', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({ name: previousBookName }),
                            cache: 'no-cache',
                        });
                        if (response.ok) {
                            const payload = await response.json();
                            const entries = payload && typeof payload === 'object' && payload.entries && typeof payload.entries === 'object'
                                ? payload.entries
                                : {};
                            previousLorebookSnapshot = {
                                avatar: previousAvatar,
                                characterName: String(getCharacterName(previousCharacter) || ''),
                                bookName: previousBookName,
                                entries,
                                capturedAt: Date.now(),
                            };
                        }
                    } catch (error) {
                        console.warn('Failed to capture previous lorebook snapshot before replace', error);
                    }
                }

                async function emitCharacterReplacedEvent() {
                    try {
                        const replacedIndex = previousAvatar
                            ? characters.findIndex(item => String(item?.avatar || '').trim() === previousAvatar)
                            : this_chid;
                        let replacedCharacter = null;
                        if (previousAvatar) {
                            const response = await fetch('/api/characters/get', {
                                method: 'POST',
                                headers: getRequestHeaders(),
                                body: JSON.stringify({ avatar_url: previousAvatar }),
                                cache: 'no-cache',
                            });
                            if (response.ok) {
                                replacedCharacter = await response.json();
                            }
                        }
                        if (!replacedCharacter) {
                            if (previousAvatar) {
                                await getOneCharacter(previousAvatar);
                            }
                            replacedCharacter = replacedIndex >= 0
                                ? characters[replacedIndex]
                                : characters[this_chid];
                        }
                        if (!replacedCharacter) {
                            return;
                        }
                        await eventSource.emit(event_types.CHARACTER_REPLACED, {
                            detail: {
                                id: replacedIndex >= 0 ? replacedIndex : this_chid,
                                character: replacedCharacter,
                                previousCharacter,
                                previousLorebookSnapshot,
                                source: 'replace_update',
                            },
                        });
                    } catch (error) {
                        console.warn('Failed to emit character replaced event', error);
                    }
                }

                const POPUP_RESULT_URL = POPUP_RESULT.CUSTOM1, POPUP_RESULT_FILE = POPUP_RESULT.CUSTOM2;
                const result = await Popup.show.confirm(t`Replace Character`,
                    `<p>${t`Choose a new character card to replace this character with.`}</p>` +
                    `<p>${t`You can also replace this character with the one from the online source.`}${onlineUrl ? `<br />This character was downloaded from: <var>${onlineUrl}</var>` : ''}</p>` +
                    `<p>${t`All chats, assets and group memberships will be preserved, but local changes to the character data will be lost.`}<br />${t`Proceed?`}</p>`,
                    {
                        okButton: false,
                        customButtons: [{
                            text: t`Replace with URL`,
                            result: POPUP_RESULT_URL,
                            classes: ['popup-button-ok'],
                        }, {
                            text: t`Replace with File`,
                            result: POPUP_RESULT_FILE,
                            classes: ['popup-button-ok'],
                        }],
                        defaultResult: onlineUrl ? POPUP_RESULT_URL : POPUP_RESULT_FILE,
                    });

                // Remember the chat currently selected, so we can reload it after the replacement
                const currentChatFile = characters[this_chid].chat;
                async function postReplace() {
                    await openCharacterChat(currentChatFile);
                }

                switch (result) {
                    case POPUP_RESULT_FILE: {
                        async function uploadReplacementCard(e) {
                            const file = e.target.files[0];
                            if (!file) {
                                return;
                            }

                            try {
                                const data = new Map();
                                data.set(file, characters[this_chid].avatar);
                                await processDroppedFiles([file], data);
                                await postReplace();
                                await emitCharacterReplacedEvent();
                            } catch {
                                toastr.error('Failed to replace the character card.', 'Something went wrong');
                            }
                        }
                        $('#character_replace_file').off('change').on('change', uploadReplacementCard).trigger('click');
                        break;
                    }
                    case POPUP_RESULT_URL: {
                        const inputUrl = await Popup.show.input(t`Replace Character from URL`,
                            `<p>${t`Enter the URL of the character card to replace this character with.`}</p>` +
                            (onlineUrl ? `<p>${t`This character was downloaded from: <var>${onlineUrl}</var>`}</p>` : ''),
                            onlineUrl);
                        if (!inputUrl) {
                            break;
                        }
                        onlineUrl = inputUrl;
                        await importFromExternalUrl(onlineUrl, { preserveFileName: characters[this_chid].avatar });
                        await postReplace();
                        await emitCharacterReplacedEvent();
                        break;
                    }
                }
            } break;
            case 'import_tags': {
                await importTags(characters[this_chid], { importSetting: tag_import_setting.ASK });
            } break;
            case 'bind_character_chat_completion_preset': {
                await bindCurrentChatCompletionPresetToCharacter(this_chid);
            } break;
            case 'clear_character_chat_completion_preset': {
                await clearCharacterBoundChatCompletionPreset(this_chid);
            } break;
            /*case 'delete_button':
                popup_type = "del_ch";
                callPopup(`
                        <h3>Delete the character?</h3>
                        <b>THIS IS PERMANENT!<br><br>
                        THIS WILL ALSO DELETE ALL<br>
                        OF THE CHARACTER'S CHAT FILES.<br><br></b>`
                );
                break;*/
            default:
                await eventSource.emit(event_types.CHARACTER_MANAGEMENT_DROPDOWN, target);
        }
        $('#char-management-dropdown').prop('selectedIndex', 0);
    });

    function shouldWarnBeforeUnload() {
        const mode = String(power_user.before_unload_guard_mode || 'smart').trim().toLowerCase();
        if (mode === 'off') {
            return false;
        }
        if (mode === 'always') {
            return true;
        }

        // Smart mode: only warn when there's obvious risk of data loss.
        if (is_send_press || streamingProcessor) {
            return true;
        }
        if (this_edit_mes_id >= 0) {
            return true;
        }
        if (String($('#send_textarea').val() ?? '').trim().length > 0) {
            return true;
        }
        return false;
    }

    $(window).on('beforeunload', (event) => {
        cancelTtsPlay();
        if (streamingProcessor) {
            console.log('Page reloaded. Aborting streaming...');
            streamingProcessor.onStopStreaming();
        }

        if (!shouldWarnBeforeUnload()) {
            return;
        }

        const nativeEvent = event?.originalEvent ?? event;
        if (nativeEvent) {
            nativeEvent.returnValue = '';
        }
        if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
        }
        return '';
    });


    var isManualInput = false;
    var valueBeforeManualInput;

    $(document).on('input', '.range-block-counter input, .neo-range-input', function () {
        valueBeforeManualInput = $(this).val();
        console.log(valueBeforeManualInput);
    });

    $(document).on('change', '.range-block-counter input, .neo-range-input', function (e) {
        if (!(e.target instanceof HTMLElement)) {
            return;
        }
        e.target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });

    $(document).on('keydown', '.range-block-counter input, .neo-range-input', function (e) {
        const masterSelector = '#' + $(this).data('for');
        const masterElement = $(masterSelector);
        if (e.key === 'Enter') {
            let manualInput = Number($(this).val());
            if (isManualInput) {
                //disallow manual inputs outside acceptable range
                if (manualInput >= Number($(this).attr('min')) && manualInput <= Number($(this).attr('max'))) {
                    //if value is ok, assign to slider and update handle text and position
                    //newSlider.val(manualInput)
                    //handleSlideEvent.call(newSlider, null, { value: parseFloat(manualInput) }, 'manual');
                    valueBeforeManualInput = manualInput;
                    $(masterElement).val($(this).val()).trigger('input', { forced: true });
                } else {
                    //if value not ok, warn and reset to last known valid value
                    toastr.warning(`Invalid value. Must be between ${$(this).attr('min')} and ${$(this).attr('max')}`);
                    //newSlider.val(valueBeforeManualInput)
                    $(this).val(valueBeforeManualInput);
                }
            }
        }
    });

    $(document).on('keyup', '.range-block-counter input, .neo-range-input', function () {
        valueBeforeManualInput = $(this).val();
        isManualInput = true;
    });

    //trigger slider changes when user clicks away
    $(document).on('mouseup blur', '.range-block-counter input, .neo-range-input', function () {
        const masterSelector = '#' + $(this).data('for');
        const masterElement = $(masterSelector);
        let manualInput = Number($(this).val());
        if (isManualInput) {
            //if value is between correct range for the slider
            if (manualInput >= Number($(this).attr('min')) && manualInput <= Number($(this).attr('max'))) {
                valueBeforeManualInput = manualInput;
                //set the slider value to input value
                $(masterElement).val($(this).val()).trigger('input', { forced: true });
            } else {
                //if value not ok, warn and reset to last known valid value
                toastr.warning(`Invalid value. Must be between ${$(this).attr('min')} and ${$(this).attr('max')}`);
                $(this).val(valueBeforeManualInput);
            }
        }
        isManualInput = false;
    });

    $('.user_stats_button').on('click', function () {
        userStatsHandler();
    });

    $(document).on('click', '.external_import_button, #external_import_button', async () => {
        const html = await renderTemplateAsync('importCharacters');
        const input = await callGenericPopup(html, POPUP_TYPE.INPUT, '', { allowVerticalScrolling: true, wider: true, okButton: $('#popup_template').attr('popup-button-import'), rows: 4 });

        if (!input) {
            console.debug('Custom content import cancelled');
            return;
        }

        // break input into one input per line
        const inputs = String(input).split('\n').map(x => x.trim()).filter(x => x.length > 0);

        for (const url of inputs) {
            await importFromExternalUrl(url);
        }
    });

    charDragDropHandler = new DragAndDropHandler('body', async (files, event) => {
        if (!files.length) {
            await importFromURL(event.originalEvent.dataTransfer.items, files);
        }
        await processDroppedFiles(files);
    }, { noAnimation: true });

    chatDragDropHandler = new DragAndDropHandler('#select_chat_popup', async (_, event) => {
        const importFile = document.getElementById('chat_import_file');
        if (importFile instanceof HTMLInputElement) {
            importFile.files = event.originalEvent.dataTransfer.files;
            $(importFile).trigger('change');
        }
    });

    $('#charListGridToggle').on('click', async () => {
        doCharListDisplaySwitch();
    });

    $('#hideCharPanelAvatarButton').on('click', () => {
        $('#avatar-and-name-block').slideToggle();
    });

    $(document).on('mouseup touchend', '#show_more_messages', async function () {
        await showMoreMessages();
    });

    $(document).on('click', '.open_characters_library', async function () {
        await getCharacters();
        await eventSource.emit(event_types.OPEN_CHARACTER_LIBRARY);
    });

    // Added here to prevent execution before script.js is loaded and get rid of quirky timeouts
    await firstLoadInit();

    window.addEventListener('beforeunload', (e) => {
        if (isChatSaving || this_edit_mes_id >= 0) {
            e.preventDefault();
            e.returnValue = true;
        }
    });
});
