/*
* CODE FOR OPENAI SUPPORT
* By CncAnon (@CncAnon1)
* https://github.com/CncAnon1/TavernAITurbo
*/
import { Fuse, DOMPurify } from '../lib.js';

import {
    abortStatusCheck,
    cancelStatusCheck,
    chat_metadata,
    characters,
    ensureFullSettingsLoaded,
    event_types,
    eventSource,
    extension_prompt_roles,
    extension_prompt_types,
    Generate,
    deleteAllPresetState,
    getExtensionPrompt,
    getExtensionPromptMaxDepth,
    getMediaDisplay,
    getMediaIndex,
    getRequestHeaders,
    is_send_press,
    main_api,
    name1,
    name2,
    resultCheckStatus,
    saveSettingsDebounced,
    setOnlineStatus,
    startStatusLoading,
    substituteParams,
    substituteParamsExtended,
    system_message_types,
    this_chid,
} from '../script.js';
import { getGroupNames, groups, selected_group } from './group-chats.js';

import {
    chatCompletionDefaultPrompts,
    INJECTION_POSITION,
    Prompt,
    PromptManager,
    promptManagerDefaultPromptOrders,
} from './PromptManager.js';

import { forceCharacterEditorTokenize, getCustomStoppingStrings, persona_description_positions, power_user } from './power-user.js';
import { SECRET_KEYS, secret_state, writeSecret } from './secrets.js';
import { extension_settings } from './extensions.js';
import { acquire as acquireRequestSlot } from './extensions/connection-manager/request-throttler.js';
import { getMaxRequestRetries } from './extensions/connection-manager/max-retries.js';
import { withRetry } from './request-retry.js';

import { getEventSourceStream } from './sse-stream.js';
import {
    buildPresetNameIndexMap,
    findCanonicalNameInList,
    clamp,
    createThumbnail,
    delay,
    download,
    getAudioDurationFromDataURL,
    getBase64Async,
    getFileText,
    getImageSizeFromDataURL,
    getSortableDelay,
    getOrderedPresetNames,
    getStringHash,
    getVideoDurationFromDataURL,
    isDataURL,
    isUuid,
    isValidUrl,
    parseJsonFile,
    resetScrollHeight,
    stringFormat,
    textValueMatcher,
    uuidv4,
} from './utils.js';
import { countTokensOpenAIAsync, countTokensOpenAIItemsAsync, getTokenizerModel } from './tokenizers.js';
import { extractStreamingUsage, mergeStreamingUsage } from './openai-streaming-usage.js';
import { setLastUsage } from './last-usage.js';
import { isMobile } from './RossAscends-mods.js';
import { saveLogprobsForActiveMessage } from './logprobs.js';
import { persistPreset } from './preset-persistence.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { renderTemplateAsync } from './templates.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { AbortReason } from './util/AbortReason.js';
import { resolveChatCompletionRequestProfile } from './extensions/connection-manager/profile-resolver.js';
import { COMETAPI_IGNORE_PATTERNS, IGNORE_SYMBOL, MEDIA_DISPLAY, MEDIA_TYPE } from './constants.js';
import { maybeDeleteLinkedLorebookForPresetDeletion } from './world-info.js';
import { showUndoToast } from './undo-toast.js';
import {
    buildFunctionCallRetryAddendum,
    diagnosePlainTextFunctionCallError,
    isToolCallMandatory,
    PlainTextFunctionCallStreamDetector,
    TOOL_PROTOCOL_STYLE,
    buildPlainTextToolProtocolMessage,
    extractAllFunctionCallsFromText,
    extractDisplayTextFromPlainTextFunctionResponse,
    findLastTriggerSignalOutsideThought,
    getResponseMessageContent,
    generateRandomTriggerSignal,
    mergeSystemAddendumIntoPromptMessages,
    normalizeToolMessagesForPlainTextFunctionCalling,
    resolveFunctionCallMode,
    validateParsedToolCalls,
} from './extensions/function-call-runtime.js';
import { syncNanoGptProvidersForModel, syncOpenRouterProvidersForModel, updateNanoGptProvidersWarning, updateOpenRouterProvidersWarning } from './textgen-models.js';
import { unescapeMacroBracesInRequestData } from './macros/util/escape.js';

export {
    openai_messages_count,
    oai_settings,
    loadOpenAISettings,
    setOpenAIMessages,
    setOpenAIMessageExamples,
    setupChatCompletionPromptManager,
    sendOpenAIRequest,
    isLastOpenAIReplyPersistedByServer,
    getLastOpenAIGenerationId,
    bindCurrentChatCompletionPresetToCharacter,
    clearCharacterBoundChatCompletionPreset,
    saveOpenAIPreset,
    hasUnsavedOpenAIPresetChanges,
    TokenHandler,
    IdentifierNotFoundError,
    Message,
    MessageCollection,
};

let openai_messages_count = 0;

const default_main_prompt = 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.';
const default_nsfw_prompt = '';
const default_jailbreak_prompt = '';
const default_impersonation_prompt = '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]';
const default_enhance_definitions_prompt = 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.';
const default_wi_format = '{0}';
const default_new_chat_prompt = '[Start a new Chat]';
const default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]';
const default_new_example_chat_prompt = '[Example Chat]';
const default_continue_nudge_prompt = '[Continue your last message without repeating its original content.]';
const default_bias = 'Default (none)';
const default_personality_format = '{{personality}}';
const default_scenario_format = '{{scenario}}';
const default_group_nudge_prompt = '[Write the next reply only as {{char}}.]';
const default_bias_presets = {
    [default_bias]: [],
    'Anti-bond': [
        { id: '22154f79-dd98-41bc-8e34-87015d6a0eaf', text: ' bond', value: -50 },
        { id: '8ad2d5c4-d8ef-49e4-bc5e-13e7f4690e0f', text: ' future', value: -50 },
        { id: '52a4b280-0956-4940-ac52-4111f83e4046', text: ' bonding', value: -50 },
        { id: 'e63037c7-c9d1-4724-ab2d-7756008b433b', text: ' connection', value: -25 },
    ],
};

const max_2k = 2047;
const max_4k = 4095;
const max_8k = 8191;
const max_16k = 16383;
const max_32k = 32767;
const max_64k = 65535;
const max_128k = 128 * 1000;
const max_200k = 200 * 1000;
const max_256k = 256 * 1000;
const max_400k = 400 * 1000;
const max_1mil = 1000 * 1000;
const max_2mil = 2000 * 1000;
const unlocked_max = max_2mil;
const oai_max_temp = 2.0;
const claude_max_temp = 1.0;
const mistral_max_temp = 1.5;
const openrouter_website_model = 'OR_Website';
const openai_max_stop_strings = 4;

const textCompletionModels = [
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'text-davinci-003',
    'text-davinci-002',
    'text-davinci-001',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'code-davinci-001',
    'code-cushman-002',
    'code-cushman-001',
    'text-davinci-edit-001',
    'code-davinci-edit-001',
    'text-embedding-ada-002',
    'text-similarity-davinci-001',
    'text-similarity-curie-001',
    'text-similarity-babbage-001',
    'text-similarity-ada-001',
    'text-search-davinci-doc-001',
    'text-search-curie-doc-001',
    'text-search-babbage-doc-001',
    'text-search-ada-doc-001',
    'code-search-babbage-code-001',
    'code-search-ada-code-001',
];

let biasCache = undefined;
export let model_list = [];
let lastOpenAIReplyPersistedByServer = false;
let lastOpenAIGenerationId = '';
let openAIPresetChangeNotificationToken = 0;

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

function logOpenAILukerPersistenceDebug(phase, details = {}) {
    console.debug('[LukerPersist]', {
        api: 'openai',
        phase: String(phase || ''),
        ...details,
    });
}

const characterBoundPresetState = {
    active: false,
    previousPreset: '',
    runtimeOptionValue: '__luker_char_bound_preset__',
    runtimePresetName: '',
    runtimePresetBody: null,
};
let lastOpenAIPresetSelectValue = '';
let characterJsonDataWorker = null;
let characterJsonDataWorkerRequestId = 0;
const characterJsonDataWorkerPending = new Map();

function scheduleOpenAIPresetChangeNotifications(presetName) {
    const token = ++openAIPresetChangeNotificationToken;
    setTimeout(async () => {
        if (token !== openAIPresetChangeNotificationToken) {
            return;
        }

        await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        if (token !== openAIPresetChangeNotificationToken) {
            return;
        }

        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: presetName });
    }, 0);
}

export const chat_completion_sources = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    AI21: 'ai21',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    ELECTRONHUB: 'electronhub',
    CHUTES: 'chutes',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    WORKERS_AI: 'workers_ai',
    MINIMAX: 'minimax',
};

const lukerServerPersistenceUnsupportedSources = new Set();

function isLukerServerPersistenceSupported(source) {
    return !lukerServerPersistenceUnsupportedSources.has(String(source || '').trim().toLowerCase());
}

function buildLukerPersistTarget() {
    if (selected_group) {
        const group = groups.find(x => x.id == selected_group);
        const groupChatId = group?.chat_id;
        if (!groupChatId) {
            return null;
        }

        return {
            kind: 'group',
            id: groupChatId,
            char_name: name2,
            chat_metadata: { ...chat_metadata },
            integrity: chat_metadata?.integrity,
        };
    }

    const character = characters[this_chid];
    const avatar = character?.avatar;
    const fileName = character?.chat;

    if (!avatar || !fileName) {
        return null;
    }

    return {
        kind: 'character',
        avatar_url: avatar,
        file_name: fileName,
        char_name: name2,
        chat_metadata: { ...chat_metadata },
        integrity: chat_metadata?.integrity,
    };
}

function shouldUseLukerServerPersistence(type, source = oai_settings.chat_completion_source) {
    return (type === 'normal' || type === 'regenerate') && isLukerServerPersistenceSupported(source);
}

function isLastOpenAIReplyPersistedByServer() {
    return lastOpenAIReplyPersistedByServer;
}

function getLastOpenAIGenerationId() {
    return lastOpenAIGenerationId;
}

const character_names_behavior = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};

const continue_postfix_types = {
    NONE: '',
    SPACE: ' ',
    NEWLINE: '\n',
    DOUBLE_NEWLINE: '\n\n',
};

export const custom_prompt_post_processing_types = {
    NONE: '',
    /** @deprecated Use MERGE instead. */
    CLAUDE: 'claude',
    MERGE: 'merge',
    SEMI: 'semi',
    STRICT: 'strict',
    SINGLE: 'single',
};

const openrouter_middleout_types = {
    AUTO: 'auto',
    ON: 'on',
    OFF: 'off',
};

export const reasoning_effort_types = {
    auto: 'auto',
    low: 'low',
    medium: 'medium',
    high: 'high',
    min: 'min',
    max: 'max',
};

export const verbosity_levels = {
    auto: 'auto',
    low: 'low',
    medium: 'medium',
    high: 'high',
};

export const tool_reasoning_modes = {
    DISABLED: 'disabled',
    SINCE_LAST_USER: 'since_last_user',
    ACTIVE_CHAIN: 'active_chain',
};

// Providers that support interleaved reasoning forwarding in tool-call chains.
const interleaved_reasoning_providers = [
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.CUSTOM,
];

export const ZAI_ENDPOINT = {
    COMMON: 'common',
    CODING: 'coding',
};

export const SILICONFLOW_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};

export const MINIMAX_ENDPOINT = {
    GLOBAL: 'global',
    CN: 'cn',
};

const sensitiveFields = [
    'reverse_proxy',
    'proxy_password',
    'base_url',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
];

/**
 * preset_name -> [selector, setting_name, is_checkbox, is_connection]
 * @type {Record<string, [string, string, boolean, boolean]>}
 */
export const settingsToUpdate = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false],
    presence_penalty: ['#pres_pen_openai', 'pres_pen_openai', false, false],
    top_p: ['#top_p_openai', 'top_p_openai', false, false],
    top_k: ['#top_k_openai', 'top_k_openai', false, false],
    top_a: ['#top_a_openai', 'top_a_openai', false, false],
    min_p: ['#min_p_openai', 'min_p_openai', false, false],
    repetition_penalty: ['#repetition_penalty_openai', 'repetition_penalty_openai', false, false],
    max_context_unlocked: ['#oai_max_context_unlocked', 'max_context_unlocked', true, false],
    group_models: ['#cc_group_models', 'group_models', true, true],
    sort_models: ['#cc_sort_models', 'sort_models', false, true],
    openai_model: ['#openai_model_id', 'openai_model', false, true],
    claude_model: ['#claude_model_id', 'claude_model', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_use_fallback: ['#openrouter_use_fallback', 'openrouter_use_fallback', true, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    openrouter_quantizations: ['#openrouter_quantizations_chat', 'openrouter_quantizations', false, true],
    openrouter_allow_fallbacks: ['#openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
    openrouter_middleout: ['#openrouter_middleout', 'openrouter_middleout', false, true],
    tool_reasoning_mode: ['#tool_reasoning_mode', 'tool_reasoning_mode', false, false],
    ai21_model: ['#model_ai21_select', 'ai21_model', false, true],
    mistralai_model: ['#mistralai_model_id', 'mistralai_model', false, true],
    cohere_model: ['#model_cohere_select', 'cohere_model', false, true],
    perplexity_model: ['#model_perplexity_select', 'perplexity_model', false, true],
    groq_model: ['#model_groq_select', 'groq_model', false, true],
    chutes_model: ['#model_chutes_select', 'chutes_model', false, true],
    siliconflow_model: ['#model_siliconflow_select', 'siliconflow_model', false, true],
    siliconflow_endpoint: ['#siliconflow_endpoint', 'siliconflow_endpoint', false, true],
    minimax_model: ['#model_minimax_select', 'minimax_model', false, true],
    minimax_endpoint: ['#minimax_endpoint', 'minimax_endpoint', false, true],
    electronhub_model: ['#model_electronhub_select', 'electronhub_model', false, true],
    nanogpt_model: ['#model_nanogpt_select', 'nanogpt_model', false, true],
    nanogpt_provider: ['#nanogpt_provider', 'nanogpt_provider', false, true],
    nanogpt_payg_override: ['#nanogpt_payg_override', 'nanogpt_payg_override', true, true],
    deepseek_model: ['#deepseek_model_id', 'deepseek_model', false, true],
    aimlapi_model: ['#model_aimlapi_select', 'aimlapi_model', false, true],
    xai_model: ['#xai_model_id', 'xai_model', false, true],
    pollinations_model: ['#model_pollinations_select', 'pollinations_model', false, true],
    moonshot_model: ['#moonshot_model_id', 'moonshot_model', false, true],
    fireworks_model: ['#model_fireworks_select', 'fireworks_model', false, true],
    cometapi_model: ['#model_cometapi_select', 'cometapi_model', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    custom_include_body: ['#custom_include_body', 'custom_include_body', false, true],
    custom_exclude_body: ['#custom_exclude_body', 'custom_exclude_body', false, true],
    custom_include_headers: ['#custom_include_headers', 'custom_include_headers', false, true],
    custom_prompt_post_processing: ['#custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
    google_model: ['#google_model_id', 'google_model', false, true],
    vertexai_model: ['#vertexai_model_id', 'vertexai_model', false, true],
    zai_model: ['#zai_model_id', 'zai_model', false, true],
    zai_endpoint: ['#zai_endpoint', 'zai_endpoint', false, true],
    workers_ai_model: ['#model_workers_ai_select', 'workers_ai_model', false, true],
    workers_ai_account_id: ['#workers_ai_account_id', 'workers_ai_account_id', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    names_behavior: ['#names_behavior', 'names_behavior', false, false],
    send_if_empty: ['#send_if_empty_textarea', 'send_if_empty', false, false],
    impersonation_prompt: ['#impersonation_prompt_textarea', 'impersonation_prompt', false, false],
    new_chat_prompt: ['#newchat_prompt_textarea', 'new_chat_prompt', false, false],
    new_group_chat_prompt: ['#newgroupchat_prompt_textarea', 'new_group_chat_prompt', false, false],
    new_example_chat_prompt: ['#newexamplechat_prompt_textarea', 'new_example_chat_prompt', false, false],
    continue_nudge_prompt: ['#continue_nudge_prompt_textarea', 'continue_nudge_prompt', false, false],
    bias_preset_selected: ['#openai_logit_bias_preset', 'bias_preset_selected', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    base_url: ['#openai_base_url', 'base_url', false, true],
    wi_format: ['#wi_format_textarea', 'wi_format', false, false],
    scenario_format: ['#scenario_format_textarea', 'scenario_format', false, false],
    personality_format: ['#personality_format_textarea', 'personality_format', false, false],
    group_nudge_prompt: ['#group_nudge_prompt_textarea', 'group_nudge_prompt', false, false],
    stream_openai: ['#stream_toggle', 'stream_openai', true, false],
    prompts: ['', 'prompts', false, false],
    prompt_order: ['', 'prompt_order', false, false],
    show_external_models: ['#openai_show_external_models', 'show_external_models', true, true],
    proxy_password: ['#openai_proxy_password', 'proxy_password', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    assistant_impersonation: ['#claude_assistant_impersonation', 'assistant_impersonation', false, false],
    use_sysprompt: ['#use_sysprompt', 'use_sysprompt', true, false],
    vertexai_auth_mode: ['#vertexai_auth_mode', 'vertexai_auth_mode', false, true],
    vertexai_region: ['#vertexai_region', 'vertexai_region', false, true],
    vertexai_express_project_id: ['#vertexai_express_project_id', 'vertexai_express_project_id', false, true],
    squash_system_messages: ['#squash_system_messages', 'squash_system_messages', true, false],
    media_inlining: ['#openai_media_inlining', 'media_inlining', true, false],
    inline_image_quality: ['#openai_inline_image_quality', 'inline_image_quality', false, false],
    continue_prefill: ['#continue_prefill', 'continue_prefill', true, false],
    continue_postfix: ['#continue_postfix', 'continue_postfix', false, false],
    function_calling: ['#openai_function_calling', 'function_calling', true, false],
    function_calling_plain_text: ['#connection_profile_function_calling_plain_text', 'function_calling_plain_text', true, true],
    function_calling_plain_text_error_retry: ['#connection_profile_function_calling_plain_text_error_retry', 'function_calling_plain_text_error_retry', true, true],
    function_calling_plain_text_error_retry_max_attempts: ['#connection_profile_function_calling_plain_text_error_retry_max_attempts', 'function_calling_plain_text_error_retry_max_attempts', false, true],
    claude_enable_system_prompt_cache: ['#connection_profile_claude_enable_system_prompt_cache', 'claude_enable_system_prompt_cache', true, true],
    claude_caching_at_depth: ['#connection_profile_claude_caching_at_depth', 'claude_caching_at_depth', false, true],
    claude_extended_ttl: ['#connection_profile_claude_extended_ttl', 'claude_extended_ttl', true, true],
    gemini_enable_system_prompt_cache: ['#connection_profile_gemini_enable_system_prompt_cache', 'gemini_enable_system_prompt_cache', true, true],
    tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    reasoning_effort: ['#openai_reasoning_effort', 'reasoning_effort', false, false],
    verbosity: ['#openai_verbosity', 'verbosity', false, false],
    enable_web_search: ['#openai_enable_web_search', 'enable_web_search', true, false],
    seed: ['#seed_openai', 'seed', false, false],
    n: ['#n_openai', 'n', false, false],
    bypass_status_check: ['#openai_bypass_status_check', 'bypass_status_check', true, true],
    request_images: ['#openai_request_images', 'request_images', true, false],
    request_image_aspect_ratio: ['#request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
    request_image_resolution: ['#request_image_resolution', 'request_image_resolution', false, false],
    azure_base_url: ['#azure_base_url', 'azure_base_url', false, true],
    azure_deployment_name: ['#azure_deployment_name', 'azure_deployment_name', false, true],
    azure_api_version: ['#azure_api_version', 'azure_api_version', false, true],
    azure_openai_model: ['#azure_openai_model', 'azure_openai_model', false, true],
    extensions: ['#NULL_SELECTOR', 'extensions', false, false],
};

const connectionProfileOnlyPresetKeys = new Set([
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
]);

const settingsKeyToPresetKey = Object.entries(settingsToUpdate).reduce((acc, [presetKey, [, settingsKey]]) => {
    if (!acc[settingsKey]) {
        acc[settingsKey] = presetKey;
    }
    return acc;
}, {});

/**
 * Returns true if the OpenAI preset field belongs to API connection/model settings.
 * @param {string} presetKey
 * @returns {boolean}
 */
export function isOpenAIConnectionPresetField(presetKey) {
    return Boolean(settingsToUpdate?.[presetKey]?.[3]);
}

/**
 * Remove connection/model fields from a chat-completion preset object.
 * @param {object} preset
 * @returns {object}
 */
export function stripOpenAIConnectionFieldsFromPreset(preset) {
    const source = preset && typeof preset === 'object' ? structuredClone(preset) : {};
    for (const key of Object.keys(source)) {
        if (isOpenAIConnectionPresetField(key)) {
            delete source[key];
        }
    }
    return source;
}

function getOpenAIPresetByName(presetName) {
    const targetName = findCanonicalNameInList(Object.keys(openai_setting_names || {}), presetName) || String(presetName || '').trim();
    if (!targetName) {
        return null;
    }

    const presetIndex = openai_setting_names?.[targetName];
    const presetSource = Number.isInteger(presetIndex) ? openai_settings?.[presetIndex] : null;
    if (!presetSource || typeof presetSource !== 'object') {
        console.warn(`[openai] Preset '${targetName}' not found, using current settings.`);
        return null;
    }

    return presetSource;
}

function applyOpenAIPresetToSettings(settings, presetSource, {
    includeConnectionFields = false,
    includeGenerationFields = true,
} = {}) {
    if (!presetSource || typeof presetSource !== 'object') {
        return;
    }

    for (const [presetKey, value] of Object.entries(presetSource)) {
        if (isConnectionProfileOnlyPresetField(presetKey)) {
            continue;
        }
        const settingToUpdate = settingsToUpdate[presetKey];
        if (!settingToUpdate) {
            continue;
        }
        const isConnection = isOpenAIConnectionPresetField(presetKey);
        if (isConnection && !includeConnectionFields) {
            continue;
        }
        if (!isConnection && !includeGenerationFields) {
            continue;
        }
        const [, settingsKey] = settingToUpdate;
        settings[settingsKey] = structuredClone(value);
    }
}

function applyOpenAIConnectionSettingsOverride(settings, overrides) {
    if (!overrides || typeof overrides !== 'object') {
        return;
    }

    for (const [rawKey, rawValue] of Object.entries(overrides)) {
        const presetKey = settingsToUpdate[rawKey]
            ? rawKey
            : settingsKeyToPresetKey[rawKey];
        if (!presetKey || !isOpenAIConnectionPresetField(presetKey)) {
            continue;
        }
        const [, settingsKey] = settingsToUpdate[presetKey];
        settings[settingsKey] = structuredClone(rawValue);
    }
}

function isConnectionProfileOnlyPresetField(presetKey) {
    return connectionProfileOnlyPresetKeys.has(String(presetKey || '').trim());
}

/**
 * Build the per-request settings, layering chat-completion preset (generation params),
 * a connection profile resolved from `apiPresetName`, and a direct `apiSettingsOverride`
 * on top of the live `oai_settings`. Both `apiPresetName` and `apiSettingsOverride`
 * are connection-side; if both are passed, `apiSettingsOverride` wins (applied last).
 *
 * @param {object} [options]
 * @param {string} [options.llmPresetName] Chat completion preset name — generation parameters only.
 * @param {string} [options.apiPresetName] Connection profile name. Resolved internally via `resolveChatCompletionRequestProfile`; the resulting connection-field override is applied to the request.
 * @param {object|null} [options.apiSettingsOverride] Connection fields override, typically pre-resolved from `connectionProfiles.resolve(...).apiSettingsOverride`. Takes precedence over `apiPresetName` when both are provided.
 * @returns {object} The merged settings used to build a single request.
 */
function getSettingsForRequest({ llmPresetName = '', apiPresetName = '', apiSettingsOverride = null } = {}) {
    const settings = structuredClone(oai_settings);

    const llmPreset = getOpenAIPresetByName(llmPresetName);
    applyOpenAIPresetToSettings(settings, llmPreset, {
        includeConnectionFields: false,
        includeGenerationFields: true,
    });

    if (apiPresetName) {
        const resolved = resolveChatCompletionRequestProfile({
            profileName: apiPresetName,
            defaultSource: settings.chat_completion_source,
        });
        applyOpenAIConnectionSettingsOverride(settings, resolved?.apiSettingsOverride);
    }

    applyOpenAIConnectionSettingsOverride(settings, apiSettingsOverride);
    return settings;
}

const default_settings = {
    preset_settings_openai: 'Default',
    temp_openai: 1.0,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1.0,
    top_k_openai: 0,
    min_p_openai: 0,
    top_a_openai: 0,
    repetition_penalty_openai: 1,
    stream_openai: false,
    openai_max_context: max_4k,
    openai_max_tokens: 300,
    ...chatCompletionDefaultPrompts,
    ...promptManagerDefaultPromptOrders,
    send_if_empty: '',
    impersonation_prompt: default_impersonation_prompt,
    new_chat_prompt: default_new_chat_prompt,
    new_group_chat_prompt: default_new_group_chat_prompt,
    new_example_chat_prompt: default_new_example_chat_prompt,
    continue_nudge_prompt: default_continue_nudge_prompt,
    bias_preset_selected: default_bias,
    bias_presets: default_bias_presets,
    wi_format: default_wi_format,
    group_nudge_prompt: default_group_nudge_prompt,
    scenario_format: default_scenario_format,
    personality_format: default_personality_format,
    sort_models: 'alphabetically',
    group_models: false,
    openai_model: 'gpt-4-turbo',
    claude_model: 'claude-sonnet-4-5',
    google_model: 'gemini-2.5-pro',
    vertexai_model: 'gemini-2.5-pro',
    ai21_model: 'jamba-large',
    mistralai_model: 'mistral-large-latest',
    cohere_model: 'command-r-plus',
    perplexity_model: 'sonar-pro',
    groq_model: 'llama-3.3-70b-versatile',
    chutes_model: 'deepseek-ai/DeepSeek-V3-0324',
    siliconflow_model: 'deepseek-ai/DeepSeek-V3',
    siliconflow_endpoint: SILICONFLOW_ENDPOINT.GLOBAL,
    minimax_model: 'MiniMax-M2.7',
    minimax_endpoint: MINIMAX_ENDPOINT.GLOBAL,
    electronhub_model: 'gpt-4o-mini',
    nanogpt_model: 'gpt-4o-mini',
    nanogpt_provider: '',
    nanogpt_payg_override: false,
    deepseek_model: 'deepseek-v4-flash',
    aimlapi_model: 'chatgpt-4o-latest',
    xai_model: 'grok-3-beta',
    pollinations_model: 'openai',
    cometapi_model: 'gpt-4o',
    moonshot_model: 'kimi-latest',
    fireworks_model: 'accounts/fireworks/models/kimi-k2-instruct',
    zai_model: 'glm-4.6',
    zai_endpoint: ZAI_ENDPOINT.COMMON,
    workers_ai_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    workers_ai_account_id: '',
    azure_base_url: '',
    azure_deployment_name: '',
    azure_api_version: '2024-02-15-preview',
    azure_openai_model: '',
    custom_model: '',
    custom_url: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
    openrouter_model: openrouter_website_model,
    openrouter_use_fallback: false,
    openrouter_providers: [],
    openrouter_quantizations: [],
    openrouter_allow_fallbacks: true,
    openrouter_middleout: openrouter_middleout_types.ON,
    tool_reasoning_mode: tool_reasoning_modes.DISABLED,
    reverse_proxy: '',
    base_url: '',
    chat_completion_source: chat_completion_sources.OPENAI,
    max_context_unlocked: false,
    show_external_models: false,
    custom_models_by_source: {},
    proxy_password: '',
    assistant_prefill: '',
    assistant_impersonation: '',
    use_sysprompt: false,
    vertexai_auth_mode: 'express',
    vertexai_region: 'us-central1',
    vertexai_express_project_id: '',
    squash_system_messages: false,
    media_inlining: true,
    inline_image_quality: 'auto',
    bypass_status_check: false,
    continue_prefill: false,
    function_calling: false,
    function_calling_plain_text: false,
    function_calling_plain_text_error_retry: false,
    function_calling_plain_text_error_retry_max_attempts: 3,
    claude_enable_system_prompt_cache: false,
    claude_caching_at_depth: -1,
    claude_extended_ttl: false,
    gemini_enable_system_prompt_cache: false,
    tool_call_recurse_limit: 5,
    names_behavior: character_names_behavior.DEFAULT,
    continue_postfix: continue_postfix_types.SPACE,
    custom_prompt_post_processing: custom_prompt_post_processing_types.NONE,
    show_thoughts: true,
    reasoning_effort: reasoning_effort_types.auto,
    verbosity: verbosity_levels.auto,
    enable_web_search: false,
    request_images: false,
    request_image_aspect_ratio: '',
    request_image_resolution: '',
    seed: -1,
    n: 1,
    extensions: {},
};

const oai_settings = structuredClone(default_settings);

export let proxies = [
    {
        name: 'None',
        url: '',
        password: '',
    },
];
export let selected_proxy = proxies[0];

export let openai_setting_names;
export let openai_settings;

/** @type {import('./PromptManager.js').PromptManager} */
export let promptManager = null;

async function validateReverseProxy() {
    if (!oai_settings.reverse_proxy) {
        return;
    }

    try {
        new URL(oai_settings.reverse_proxy);
    } catch (err) {
        toastr.error(t`Entered reverse proxy address is not a valid URL`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw err;
    }
    const rememberKey = `Proxy_SkipConfirm_${getStringHash(oai_settings.reverse_proxy)}`;
    const skipConfirm = accountStorage.getItem(rememberKey) === 'true';

    const confirmation = skipConfirm || await Popup.show.confirm(t`Connecting To Proxy`, await renderTemplateAsync('proxyConnectionWarning', { proxyURL: DOMPurify.sanitize(oai_settings.reverse_proxy) }));

    if (!confirmation) {
        toastr.error(t`Update or remove your reverse proxy settings.`);
        setOnlineStatus('no_connection');
        resultCheckStatus();
        throw new Error('Proxy connection denied.');
    }

    accountStorage.setItem(rememberKey, String(true));
}

/**
 * Formats chat messages into chat completion messages.
 * @param {ChatMessage[]} chat - Array containing all messages.
 * @returns {object[]} - Array containing all messages formatted for chat completion.
 */
function setOpenAIMessages(chat) {
    let j = 0;
    // clean openai msgs
    const messages = [];
    // Get current API and model for thought signature validation
    const currentApi = oai_settings.chat_completion_source;
    const currentModel = getChatCompletionModel();

    for (let i = chat.length - 1; i >= 0; i--) {
        let role = chat[j].is_user ? 'user' : 'assistant';
        let content = chat[j].mes;

        // If this symbol flag is set, completely ignore the message.
        // This can be used to hide messages without affecting the number of messages in the chat.
        if (chat[j].extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }

        // 100% legal way to send a message as system
        if (chat[j].extra?.type === system_message_types.NARRATOR) {
            role = 'system';
        }

        // for groups or sendas command - prepend a character's name
        switch (oai_settings.names_behavior) {
            case character_names_behavior.NONE:
                break;
            case character_names_behavior.DEFAULT:
                if ((selected_group && chat[j].name !== name1) || (chat[j].force_avatar && chat[j].name !== name1 && chat[j].extra?.type !== system_message_types.NARRATOR)) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.CONTENT:
                if (chat[j].extra?.type !== system_message_types.NARRATOR) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.COMPLETION:
                break;
            default:
                break;
        }

        // remove caret return (waste of tokens)
        content = content.replace(/\r/gm, '');

        const name = chat[j].name;
        const media = chat[j]?.extra?.media;
        const mediaDisplay = getMediaDisplay(chat[j]);
        const mediaIndex = getMediaIndex(chat[j]);
        const invocations = chat[j]?.extra?.tool_invocations?.slice();

        // Only send thought signatures if they were generated by the same API and model
        const originApi = chat[j]?.extra?.api;
        const originModel = chat[j]?.extra?.model;
        const isSameModel = originApi === currentApi && originModel === currentModel;
        // In group chats, only include reasoning from the currently generating character
        const isOtherGroupMember = selected_group && chat[j].name !== name2;
        const signature = isSameModel && !isOtherGroupMember ? chat[j]?.extra?.reasoning_signature : null;
        const reasoning = isSameModel && !isOtherGroupMember ? String(chat[j]?.extra?.reasoning ?? '') : '';

        // Remove reasoning metadata from invocations if the API/model don't match
        if (Array.isArray(invocations) && invocations.length > 0) {
            invocations.forEach((invocation, index) => {
                if (!isSameModel && (invocation.signature || invocation.reasoning)) {
                    const cloneInvocation = structuredClone(invocation);
                    delete cloneInvocation.signature;
                    delete cloneInvocation.reasoning;
                    invocations[index] = cloneInvocation;
                }
            });
        }

        // Tool invocation summaries are persisted as compact system display messages.
        // When building prompt history, merge them back into the immediately preceding
        // assistant turn so the request shape matches assistant -> tool results flow.
        const previousMessage = messages[i + 1];
        const shouldMergeInvocationSummary =
            chat[j]?.extra?.isSmallSys === true
            && Array.isArray(invocations)
            && invocations.length > 0
            && previousMessage?.role === 'assistant';

        if (shouldMergeInvocationSummary) {
            previousMessage.invocations = Array.isArray(previousMessage.invocations)
                ? previousMessage.invocations.concat(invocations)
                : invocations;
            j++;
            continue;
        }

        messages[i] = { 'role': role, 'content': content, name: name, 'media': media, 'mediaDisplay': mediaDisplay, 'mediaIndex': mediaIndex, 'invocations': invocations, 'signature': signature, 'reasoning': reasoning };
        j++;
    }

    return messages.filter(Boolean);
}

/**
 * Formats chat examples into chat completion messages.
 * @param {string[]} mesExamplesArray - Array containing all examples.
 * @returns {object[]} - Array containing all examples formatted for chat completion.
 */
function setOpenAIMessageExamples(mesExamplesArray) {
    // get a nice array of all blocks of all example messages = array of arrays (important!)
    const examples = [];
    for (let item of mesExamplesArray) {
        // remove <START> {Example Dialogue:} and replace \r\n with just \n
        let replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        let parsed = parseExampleIntoIndividual(replaced, true);
        // add to the example message blocks array
        examples.push(parsed);
    }
    return examples;
}

/**
 * One-time setup for prompt manager module.
 *
 * @param openAiSettings
 * @returns {PromptManager|null}
 */
function setupChatCompletionPromptManager(openAiSettings) {
    // Do not set up prompt manager more than once
    if (promptManager) {
        promptManager.render(false);
        return promptManager;
    }

    promptManager = new PromptManager();

    const configuration = {
        prefix: 'completion_',
        containerIdentifier: 'completion_prompt_manager',
        listIdentifier: 'completion_prompt_manager_list',
        toggleDisabled: [],
        sortableDelay: getSortableDelay(),
        defaultPrompts: {
            main: default_main_prompt,
            nsfw: default_nsfw_prompt,
            jailbreak: default_jailbreak_prompt,
            enhanceDefinitions: default_enhance_definitions_prompt,
        },
        promptOrder: {
            strategy: 'global',
            dummyId: 100001,
        },
    };

    promptManager.saveServiceSettings = () => {
        saveSettingsDebounced();
        return new Promise((resolve) => eventSource.once(event_types.SETTINGS_UPDATED, resolve));
    };

    promptManager.tryGenerate = () => {
        if (characters[this_chid]) {
            return Generate('normal', {}, true);
        } else {
            return Promise.resolve();
        }
    };

    promptManager.tokenHandler = tokenHandler;

    promptManager.init(configuration, openAiSettings);
    promptManager.render(false);

    return promptManager;
}

/**
 * Parses the example messages into individual messages.
 * @param {string} messageExampleString - The string containing the example messages
 * @param {boolean} appendNamesForGroup - Whether to append the character name for group chats
 * @returns {Message[]} Array of message objects
 */
export function parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true) {
    const groupBotNames = getGroupNames().map(name => `${name}:`);

    let result = []; // array of msgs
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    // DRY my cock and balls :)
    function add_msg(name, role, system_name) {
        // join different newlines (we split them by \n and join by \n)
        // remove char name
        // strip to remove extra spaces
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && selected_group && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    // skip first line as it'll always be "This is how {bot name} should talk"
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        // if it's the user message, switch into user mode and out of bot mode
        // yes, repeated code, but I don't care
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            // we were in the bot mode previously, add the message
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            // we were in the user mode previously, add the message
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        // push the current line into the current message array only after checking for presence of user/bot
        cur_msg_lines.push(cur_str);
    }
    // Special case for last message in a block because we don't have a new message to trigger the switch
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

export function formatWorldInfo(value, { wiFormat = null } = {}) {
    if (!value) {
        return '';
    }

    const format = wiFormat ?? oai_settings.wi_format;

    if (!format.trim()) {
        return value;
    }

    return stringFormat(format, value);
}

function normalizeWorldInfoEntries(entries) {
    return Array.isArray(entries)
        ? entries
            .map(entry => typeof entry === 'string' ? entry : String(entry ?? ''))
            .filter(entry => entry.length > 0)
        : [];
}

function formatSplitWorldInfoEntries(entries, { wiFormat = null } = {}) {
    const format = String(wiFormat ?? oai_settings.wi_format ?? '');

    if (!format.trim() || format === default_wi_format) {
        return [...entries];
    }

    const placeholderCount = (format.match(/\{0\}/g) || []).length;
    if (placeholderCount !== 1) {
        return [formatWorldInfo(entries.join('\n'), { wiFormat: format })];
    }

    const [prefix, suffix] = format.split('{0}');
    const lastIndex = entries.length - 1;

    return entries.map((entry, index) => `${index === 0 ? prefix : ''}${entry}${index === lastIndex ? suffix : ''}`);
}

function getWorldInfoMessageContents(entries, { wiFormat = null } = {}) {
    const normalizedEntries = normalizeWorldInfoEntries(entries);
    if (normalizedEntries.length === 0) {
        return [];
    }

    return formatSplitWorldInfoEntries(normalizedEntries, { wiFormat });
}

/**
 * This function populates the injections in the conversation.
 *
 * @param {Prompt[]} prompts - Array containing injection prompts.
 * @param {Object[]} messages - Array containing all messages.
 * @returns {Promise<Object[]>} - Array containing all messages with injections.
 */
async function populationInjectionPrompts(prompts, messages) {
    let totalInsertedMessages = 0;

    const roleTypes = {
        'system': extension_prompt_roles.SYSTEM,
        'user': extension_prompt_roles.USER,
        'assistant': extension_prompt_roles.ASSISTANT,
    };

    const maxDepth = getExtensionPromptMaxDepth();
    for (let i = 0; i <= maxDepth; i++) {
        // Get prompts for current depth
        const depthPrompts = prompts.filter(prompt => prompt.injection_depth === i && prompt.content);

        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        // Group prompts by priority
        const extensionPromptsOrder = '100';
        const orderGroups = {
            [extensionPromptsOrder]: [],
        };
        for (const prompt of depthPrompts) {
            const order = prompt.injection_order ?? 100;
            if (!orderGroups[order]) {
                orderGroups[order] = [];
            }
            orderGroups[order].push(prompt);
        }

        // Process each order group in order (b - a = low to high ; a - b = high to low)
        const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
        for (const order of orders) {
            const orderPrompts = orderGroups[order];

            // Order of priority for roles (most important go lower)
            const roles = ['system', 'user', 'assistant'];
            for (const role of roles) {
                const rolePrompts = orderPrompts
                    .filter(prompt => prompt.role === role)
                    .map(x => x.content)
                    .join(separator);

                // Get extension prompt
                const extensionPrompt = order === extensionPromptsOrder
                    ? await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, roleTypes[role], wrap)
                    : '';
                const jointPrompt = [rolePrompts, extensionPrompt].filter(x => x).map(x => x.trim()).join(separator);

                if (jointPrompt && jointPrompt.length) {
                    roleMessages.push({ 'role': role, 'content': jointPrompt, injected: true });
                }
            }
        }

        if (roleMessages.length) {
            const injectIdx = i + totalInsertedMessages;
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
        }
    }

    messages = messages.reverse();
    return messages;
}

/**
 * Populates the chat history of the conversation.
 * @param {object[]} messages - Array containing all messages.
 * @param {import('./PromptManager').PromptCollection} prompts - Map object containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param type
 * @param cyclePrompt
 */
async function populateChatHistory(messages, prompts, chatCompletion, type = null, cyclePrompt = null) {
    if (!prompts.has('chatHistory')) {
        return;
    }

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    // Reserve budget for new chat message
    const newChat = selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt;
    const newChatMessage = await Message.createAsync('system', substituteParams(newChat), 'newMainChat');
    chatCompletion.reserveBudget(newChatMessage);

    // Reserve budget for group nudge
    let groupNudgeMessage = null;
    const noGroupNudgeTypes = ['impersonate'];
    if (selected_group && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'));
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    // Reserve budget for continue nudge
    let continueMessageCollection = null;
    if (type === 'continue' && cyclePrompt && !oai_settings.continue_prefill) {
        const promptObject = {
            identifier: 'continueNudge',
            role: 'system',
            content: substituteParamsExtended(oai_settings.continue_nudge_prompt, { lastChatMessage: String(cyclePrompt).trim() }),
            system_prompt: true,
        };
        continueMessageCollection = new MessageCollection('continueNudge');
        const continueMessageIndex = messages.findLastIndex(x => !x.injected);
        if (continueMessageIndex >= 0) {
            const continueMessage = messages.splice(continueMessageIndex, 1)[0];
            const prompt = new Prompt(continueMessage);
            const chatMessage = await Message.fromPromptAsync(promptManager.preparePrompt(prompt));
            continueMessageCollection.add(chatMessage);
        }
        const continueNudgePrompt = new Prompt(promptObject);
        const preparedNudgePrompt = promptManager.preparePrompt(continueNudgePrompt);
        const continueNudgeMessage = await Message.fromPromptAsync(preparedNudgePrompt);
        continueMessageCollection.add(continueNudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const message = await Message.createAsync('user', oai_settings.send_if_empty, 'emptyUserMessageReplacement');
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && oai_settings.send_if_empty && chatCompletion.canAfford(message)) {
        chatCompletion.insert(message, 'chatHistory');
    }

    const imageInlining = isImageInliningSupported();
    const videoInlining = isVideoInliningSupported();
    const audioInlining = isAudioInliningSupported();
    const canUseTools = ToolManager.isToolCallingSupported();
    const includeSignature = isReasoningSignatureSupported();
    const isToolReasoningProvider = interleaved_reasoning_providers.includes(oai_settings.chat_completion_source);
    const toolReasoningMode = isToolReasoningProvider
        ? getEffectiveToolReasoningMode()
        : tool_reasoning_modes.DISABLED;
    const includeToolReasoning = toolReasoningMode !== tool_reasoning_modes.DISABLED;
    const lastUserIdx = messages.findLastIndex(x => x.role === 'user');

    // Insert chat messages as long as there is budget available
    const chatPool = [...messages].reverse();
    const chatEntries = [];
    const batchedMessageDefinitions = [];

    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index];
        const prompt = new Prompt(chatPrompt);
        prompt.identifier = `chatHistory-${messages.length - index}`;
        const preparedPrompt = promptManager.preparePrompt(prompt);
        const messageName = promptManager.serviceSettings.names_behavior === character_names_behavior.COMPLETION && prompt.name
            ? (promptManager.isValidName(prompt.name) ? prompt.name : promptManager.sanitizeName(prompt.name))
            : undefined;
        const invocations = canUseTools && Array.isArray(chatPrompt.invocations)
            ? chatPrompt.invocations
            : [];
        const shouldCountSignature = invocations.length > 0 && includeSignature && Boolean(chatPrompt.signature);
        const chatMessageDefinition = {
            role: preparedPrompt.role,
            content: preparedPrompt.content,
            identifier: preparedPrompt.identifier || prompt.identifier,
            ...(messageName ? { name: messageName } : {}),
            ...(invocations.length > 0 ? { tool_calls: Message.formatToolCalls(invocations, includeSignature) } : {}),
            ...(shouldCountSignature ? { signature: chatPrompt.signature } : {}),
        };
        const chatMessageIndex = batchedMessageDefinitions.length;
        batchedMessageDefinitions.push(chatMessageDefinition);

        const toolResultStartIndex = batchedMessageDefinitions.length;
        if (invocations.length > 0) {
            batchedMessageDefinitions.push(...invocations.slice().reverse().map((invocation) => ({
                role: 'tool',
                content: invocation.result || '[No content]',
                identifier: invocation.id,
            })));
        }

        chatEntries.push({
            chatPrompt,
            chatMessageIndex,
            toolResultStartIndex,
            toolResultCount: invocations.length,
            postCountSignature: !shouldCountSignature && includeSignature ? chatPrompt.signature : null,
        });
    }

    const batchedMessages = await Message.createManyAsync(batchedMessageDefinitions);
    for (const entry of chatEntries) {
        const chatMessage = batchedMessages[entry.chatMessageIndex];
        const toolResultMessages = batchedMessages.slice(entry.toolResultStartIndex, entry.toolResultStartIndex + entry.toolResultCount);

        if (entry.postCountSignature) {
            chatMessage.signature = entry.postCountSignature;
        }

        /**
         * Inline a media attachment into the chat message.
         * @param {MediaAttachment} media - The media attachment to inline.
         */
        async function inlineMediaAttachment(media) {
            if (!media || !media.url) {
                return;
            }
            if (!media.type) {
                media.type = MEDIA_TYPE.IMAGE;
            }
            if (imageInlining && media.type === MEDIA_TYPE.IMAGE) {
                await chatMessage.addImage(media.url);
            }
            if (videoInlining && media.type === MEDIA_TYPE.VIDEO) {
                await chatMessage.addVideo(media.url);
            }
            if (audioInlining && media.type === MEDIA_TYPE.AUDIO) {
                await chatMessage.addAudio(media.url);
            }
        }

        if (Array.isArray(entry.chatPrompt.media) && entry.chatPrompt.media.length) {
            if (entry.chatPrompt.mediaDisplay === MEDIA_DISPLAY.LIST) {
                for (const media of entry.chatPrompt.media) {
                    await inlineMediaAttachment(media);
                }
            }
            if (entry.chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY) {
                const media = entry.chatPrompt.media[entry.chatPrompt.mediaIndex];
                await inlineMediaAttachment(media);
            }
        }

        if (canUseTools && Array.isArray(entry.chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(entry.chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== tool_reasoning_modes.DISABLED
                && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === tool_reasoning_modes.ACTIVE_CHAIN) {
                    // Strict chain mode: skip tool/tool-call messages, then use only the first assistant text boundary.
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') {
                            continue;
                        }
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) {
                            continue;
                        }
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (hasAssistantText) {
                            previousAssistantReasoning = String(candidate.reasoning ?? '');
                        }
                        break;
                    }
                } else if (toolReasoningMode === tool_reasoning_modes.SINCE_LAST_USER) {
                    // Broad mode: use the latest assistant text reasoning anywhere since the last user.
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant'
                            && !Array.isArray(candidate.invocations)
                            && typeof candidate.content === 'string'
                            && candidate.content.trim().length > 0;
                        if (!hasAssistantText) {
                            continue;
                        }
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) {
                            previousAssistantReasoning = candidateReasoning;
                            break;
                        }
                    }
                }
            }
            /** @type {import('./tool-calling.js').ToolInvocation[]} */
            const invocations = entry.chatPrompt.invocations.map(invocation => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) {
                    delete clone.reasoning;
                } else if (previousAssistantReasoning && !clone.reasoning) {
                    // Fall back to adjacent assistant-text reasoning only when the invocation has none of its own.
                    clone.reasoning = previousAssistantReasoning;
                }
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier);
            const toolResultMessages = await Promise.all(invocations.slice().reverse().map((invocation) => Message.createAsync('tool', invocation.result || '[No content]', invocation.id)));
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) {
                    chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                }
                chatCompletion.insertAtStart(chatMessage, 'chatHistory');
            } else {
                break;
            }

            continue;
        }

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    // Insert and free new chat
    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    // Reserve budget for group nudge
    if (selected_group && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    // Insert and free continue nudge
    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}

/**
 * This function populates the dialogue examples in the conversation.
 *
 * @param {import('./PromptManager').PromptCollection} prompts - Map object containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param {Object[]} messageExamples - Array containing all message examples.
 */
async function populateDialogueExamples(prompts, chatCompletion, messageExamples) {
    if (!prompts.has('dialogueExamples')) {
        return;
    }

    chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
    if (Array.isArray(messageExamples) && messageExamples.length) {
        const newExampleChat = await Message.createAsync('system', substituteParams(oai_settings.new_example_chat_prompt), 'newChat');
        for (const dialogue of [...messageExamples]) {
            const dialogueIndex = messageExamples.indexOf(dialogue);
            const chatMessages = await Message.createManyAsync(dialogue.map((prompt, promptIndex) => ({
                role: 'system',
                content: prompt.content || '',
                identifier: `dialogueExamples ${dialogueIndex}-${promptIndex}`,
                name: prompt.name,
            })));

            if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) {
                break;
            }

            chatCompletion.insert(newExampleChat, 'dialogueExamples');
            for (const chatMessage of chatMessages) {
                chatCompletion.insert(chatMessage, 'dialogueExamples');
            }
        }
    }
}

/**
 * @param {number} position - Prompt position in the extensions object.
 * @returns {string|false} - The prompt position for prompt collection.
 */
export function getPromptPosition(position) {
    if (position == extension_prompt_types.BEFORE_PROMPT) {
        return 'start';
    }

    if (position == extension_prompt_types.IN_PROMPT) {
        return 'end';
    }

    return false;
}

/**
 * Gets a Chat Completion role based on the prompt role.
 * @param {number} role Role of the prompt.
 * @returns {string} Mapped role.
 */
export function getPromptRole(role) {
    switch (role) {
        case extension_prompt_roles.SYSTEM:
            return 'system';
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

/**
 * Populate a chat conversation by adding prompts to the conversation and managing system and user prompts.
 *
 * @param {import('./PromptManager.js').PromptCollection} prompts - PromptCollection containing all prompts where the key is the prompt identifier and the value is the prompt object.
 * @param {ChatCompletion} chatCompletion - An instance of ChatCompletion class that will be populated with the prompts.
 * @param {Object} options - An object with optional settings.
 * @param {string} options.bias - A bias to be added in the conversation.
 * @param {string} options.quietPrompt - Instruction prompt for extras
 * @param {string} options.quietImage - Image prompt for extras
 * @param {string} options.type - The type of the chat, can be 'impersonate'.
 * @param {string} options.cyclePrompt - The last prompt in the conversation.
 * @param {string[]} [options.worldInfoBeforeEntries] - Raw world info entries before the main conversation.
 * @param {string[]} [options.worldInfoAfterEntries] - Raw world info entries after the main conversation.
 * @param {object[]} options.messages - Array containing all messages.
 * @param {object[]} options.messageExamples - Array containing all message examples.
 * @returns {Promise<void>}
 */
async function populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, worldInfoBeforeEntries, worldInfoAfterEntries, messages, messageExamples }) {
    // Helper function for preparing a prompt, that already exists within the prompt collection, for completion
    const addToChatCompletion = async (source, target = null) => {
        // We need the prompts array to determine a position for the source.
        if (false === prompts.has(source)) return;

        if (promptManager.isPromptDisabledForActiveCharacter(source) && source !== 'main') {
            promptManager.log(`Skipping prompt ${source} because it is disabled`);
            return;
        }

        const prompt = prompts.get(source);

        if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
            promptManager.log(`Skipping prompt ${source} because it is an absolute prompt`);
            return;
        }

        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        if (source === 'worldInfoBefore' || source === 'worldInfoAfter') {
            const messageContents = getWorldInfoMessageContents(
                source === 'worldInfoBefore' ? worldInfoBeforeEntries : worldInfoAfterEntries,
            );

            if (messageContents.length === 0) {
                return;
            }

            const batchedMessages = await Message.createManyAsync(messageContents.map((content, entryIndex) => ({
                role: prompt.role,
                content,
                identifier: `${source}-${entryIndex + 1}`,
            })));

            for (const message of batchedMessages) {
                collection.add(message);
            }
        } else {
            const message = await Message.fromPromptAsync(prompt);
            collection.add(message);
        }

        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3); // every reply is primed with <|start|>assistant<|message|>
    // Character and world information
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    // Collection of control prompts that will always be positioned last
    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate')) ?? null;
    if (type === 'impersonate') controlPrompts.add(impersonateMessage);

    // Add quiet prompt to control prompts
    // This should always be last, even in control prompts. Add all further control prompts BEFORE this prompt
    const quietPromptMessage = await Message.fromPromptAsync(prompts.get('quietPrompt')) ?? null;
    if (quietPromptMessage && quietPromptMessage.content) {
        if (isImageInliningSupported() && quietImage) {
            await quietPromptMessage.addImage(quietImage);
        }

        controlPrompts.add(quietPromptMessage);
    }

    chatCompletion.reserveBudget(controlPrompts);

    // Add ordered system and user prompts
    const systemPrompts = ['nsfw', 'jailbreak'];
    const userRelativePrompts = prompts.collection
        .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt.identifier);
            return acc;
        }, []);
    const absolutePrompts = prompts.collection
        .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => {
            acc.push(prompt);
            return acc;
        }, []);

    for (const identifier of [...systemPrompts, ...userRelativePrompts]) {
        await addToChatCompletion(identifier);
    }

    // Add enhance definition instruction
    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');

    // Bias
    if (bias && bias.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (/** @type {Prompt} */ prompt, /** @type {string|number} */ position) => {
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt);
            chatCompletion.insert(message, 'main', position);
        } else {
            // Convert the relative prompt to an injection and place it relative to main prompt
            // Keeping prompts in the same order bucket will squash them together during in-chat injection
            const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain];
                const promptCopy = new Prompt(prompt);
                promptCopy.role = main.role;
                promptCopy.injection_position = main.injection_position;
                promptCopy.injection_depth = main.injection_depth;
                promptCopy.injection_order = main.injection_order;
                const newIndex = position === 'end' ? indexOfMain + 1 : indexOfMain;
                absolutePrompts.splice(newIndex, 0, promptCopy);
            }
        }
    };

    const knownPrompts = [
        'authorsNote',
        'vectorsMemory',
        'vectorsDataBank',
        'smartContext',
    ];

    // Known relative extension prompts
    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const prompt = prompts.get(key);
            if (prompt.position) {
                await injectToMain(prompt, prompt.position);
            }
        }
    }

    // Other relative extension prompts
    for (const prompt of prompts.collection.filter(p => p.extension && p.position)) {
        await injectToMain(prompt, prompt.position);
    }

    // Pre-allocation of tokens for tool data
    if (ToolManager.canPerformToolCalls(type)) {
        const toolData = {};
        await ToolManager.registerFunctionToolsOpenAI(toolData);
        const toolMessage = [{ role: 'user', content: JSON.stringify(toolData) }];
        const toolTokens = await tokenHandler.countAsync(toolMessage);
        chatCompletion.reserveBudget(toolTokens);
    }

    // Displace the message to be continued from its original position before performing in-chat injections
    // In case if it is an assistant message, we want to prepend the users assistant prefill on the message
    if (type === 'continue' && oai_settings.continue_prefill && messages.length) {
        const chatMessage = messages.shift();
        const isAssistantRole = chatMessage.role === 'assistant';
        const supportsAssistantPrefill = oai_settings.chat_completion_source === chat_completion_sources.CLAUDE;
        const namesInCompletion = oai_settings.names_behavior === character_names_behavior.COMPLETION;
        const assistantPrefill = isAssistantRole && supportsAssistantPrefill ? substituteParams(oai_settings.assistant_prefill) : '';
        const messageContent = [assistantPrefill, chatMessage.content].filter(x => x).join('\n\n');
        const continueMessage = await Message.createAsync(chatMessage.role, messageContent, 'continuePrefill');
        chatMessage.name && namesInCompletion && await continueMessage.setName(promptManager.sanitizeName(chatMessage.name));
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    // Add in-chat injections
    messages = await populationInjectionPrompts(absolutePrompts, messages);

    // Decide whether dialogue examples should always be added
    if (power_user.pin_examples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
    } else {
        await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
}

/**
 * Combines system prompts with prompt manager prompts
 *
 * @param {Object} options - An object with optional settings.
 * @param {string} options.scenario - The scenario or context of the dialogue.
 * @param {string} options.charPersonality - Description of the character's personality.
 * @param {string} options.name2 - The second name to be used in the messages.
 * @param {string} options.charDescription - Description of the character.
 * @param {string} options.quietPrompt - The quiet prompt to be used in the conversation.
 * @param {string} options.bias - The bias to be added in the conversation.
 * @param {Object} options.extensionPrompts - An object containing additional prompts.
 * @param {string} options.systemPromptOverride - Character card override of the main prompt
 * @param {string} options.jailbreakPromptOverride - Character card override of the PHI
 * @param {string} options.type - The type of generation that triggered the prompt
 * @returns {Promise<Object>} prompts - The prepared and merged system and user-defined prompts.
 */
async function preparePromptsForChatCompletion({ scenario, charPersonality, name2, charDescription, quietPrompt, bias, extensionPrompts, systemPromptOverride, jailbreakPromptOverride, type }) {
    const scenarioText = scenario && oai_settings.scenario_format ? substituteParams(oai_settings.scenario_format) : (scenario || '');
    const charPersonalityText = charPersonality && oai_settings.personality_format ? substituteParams(oai_settings.personality_format) : (charPersonality || '');
    const groupNudge = substituteParams(oai_settings.group_nudge_prompt);
    const impersonationPrompt = oai_settings.impersonation_prompt ? substituteParams(oai_settings.impersonation_prompt) : '';

    // Create entries for system prompts
    const systemPrompts = [
        // Ordered prompts for which a marker should exist
        { role: 'system', content: '', identifier: 'worldInfoBefore' },
        { role: 'system', content: '', identifier: 'worldInfoAfter' },
        { role: 'system', content: charDescription, identifier: 'charDescription' },
        { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
        { role: 'system', content: scenarioText, identifier: 'scenario' },
        // Unordered prompts without marker
        { role: 'system', content: impersonationPrompt, identifier: 'impersonate' },
        { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
        { role: 'system', content: groupNudge, identifier: 'groupNudge' },
        { role: 'assistant', content: bias, identifier: 'bias' },
    ];

    // Authors Note
    const authorsNote = extensionPrompts['2_floating_prompt'];
    if (authorsNote && authorsNote.value) systemPrompts.push({
        role: getPromptRole(authorsNote.role),
        content: authorsNote.value,
        identifier: 'authorsNote',
        position: getPromptPosition(authorsNote.position),
    });

    // Vectors Memory
    const vectorsMemory = extensionPrompts['3_vectors'];
    if (vectorsMemory && vectorsMemory.value) systemPrompts.push({
        role: 'system',
        content: vectorsMemory.value,
        identifier: 'vectorsMemory',
        position: getPromptPosition(vectorsMemory.position),
    });

    const vectorsDataBank = extensionPrompts['4_vectors_data_bank'];
    if (vectorsDataBank && vectorsDataBank.value) systemPrompts.push({
        role: getPromptRole(vectorsDataBank.role),
        content: vectorsDataBank.value,
        identifier: 'vectorsDataBank',
        position: getPromptPosition(vectorsDataBank.position),
    });

    // Smart Context (ChromaDB)
    const smartContext = extensionPrompts.chromadb;
    if (smartContext && smartContext.value) systemPrompts.push({
        role: 'system',
        content: smartContext.value,
        identifier: 'smartContext',
        position: getPromptPosition(smartContext.position),
    });

    // Persona Description
    if (power_user.persona_description && power_user.persona_description_position === persona_description_positions.IN_PROMPT) {
        systemPrompts.push({ role: 'system', content: power_user.persona_description, identifier: 'personaDescription' });
    }

    const knownExtensionPrompts = [
        '2_floating_prompt',
        '3_vectors',
        '4_vectors_data_bank',
        'chromadb',
        'PERSONA_DESCRIPTION',
        'QUIET_PROMPT',
        'DEPTH_PROMPT',
    ];

    // Anything that is not a known extension prompt
    for (const key in extensionPrompts) {
        if (Object.hasOwn(extensionPrompts, key)) {
            const prompt = extensionPrompts[key];
            if (knownExtensionPrompts.includes(key)) continue;
            if (!extensionPrompts[key].value) continue;
            if (![extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT].includes(prompt.position)) continue;

            const hasFilter = typeof prompt.filter === 'function';
            if (hasFilter && !await prompt.filter()) continue;

            systemPrompts.push({
                identifier: key.replace(/\W/g, '_'),
                position: getPromptPosition(prompt.position),
                role: getPromptRole(prompt.role),
                content: prompt.value,
                extension: true,
            });
        }
    }

    // This is the prompt order defined by the user
    const prompts = promptManager.getPromptCollection(type);

    // Merge system prompts with prompt manager prompts
    systemPrompts.forEach(prompt => {
        const collectionPrompt = prompts.get(prompt.identifier);

        // Apply system prompt role/depth overrides if they set in the prompt manager
        if (collectionPrompt) {
            // In-Chat / Relative
            prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
            // Depth for In-Chat
            prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
            // Priority for In-Chat
            prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
            // Role (system, user, assistant)
            prompt.role = collectionPrompt.role ?? prompt.role;
        }

        const newPrompt = promptManager.preparePrompt(prompt);
        const markerIndex = prompts.index(prompt.identifier);

        if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
        else prompts.add(newPrompt);
    });

    // Apply character-specific main prompt
    const systemPrompt = prompts.get('main') ?? null;
    const isSystemPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('main');
    if (systemPromptOverride && systemPrompt && systemPrompt.forbid_overrides !== true && !isSystemPromptDisabled) {
        const mainOriginalContent = systemPrompt.content;
        systemPrompt.content = systemPromptOverride;
        const mainReplacement = promptManager.preparePrompt(systemPrompt, mainOriginalContent);
        prompts.override(mainReplacement, prompts.index('main'));
    }

    // Apply character-specific jailbreak
    const jailbreakPrompt = prompts.get('jailbreak') ?? null;
    const isJailbreakPromptDisabled = promptManager.isPromptDisabledForActiveCharacter('jailbreak');
    if (jailbreakPromptOverride && jailbreakPrompt && jailbreakPrompt.forbid_overrides !== true && !isJailbreakPromptDisabled) {
        const jbOriginalContent = jailbreakPrompt.content;
        jailbreakPrompt.content = jailbreakPromptOverride;
        const jbReplacement = promptManager.preparePrompt(jailbreakPrompt, jbOriginalContent);
        prompts.override(jbReplacement, prompts.index('jailbreak'));
    }

    return prompts;
}

/**
 * Take a configuration object and prepares messages for a chat with OpenAI's chat completion API.
 * Handles prompts, prepares chat history, manages token budget, and processes various user settings.
 *
 * @param {Object} content - System prompts provided by SillyTavern
 * @param {string} content.name2 - The second name to be used in the messages.
 * @param {string} content.charDescription - Description of the character.
 * @param {string} content.charPersonality - Description of the character's personality.
 * @param {string} content.scenario - The scenario or context of the dialogue.
 * @param {string[]} [content.worldInfoBeforeEntries] - Raw world info entries before the main conversation.
 * @param {string[]} [content.worldInfoAfterEntries] - Raw world info entries after the main conversation.
 * @param {string} content.bias - The bias to be added in the conversation.
 * @param {string} content.type - The type of the chat, can be 'impersonate'.
 * @param {string} content.quietPrompt - The quiet prompt to be used in the conversation.
 * @param {string} content.quietImage - Image prompt for extras
 * @param {string} content.cyclePrompt - The last prompt used for chat message continuation.
 * @param {string} content.systemPromptOverride - The system prompt override.
 * @param {string} content.jailbreakPromptOverride - The jailbreak prompt override.
 * @param {object} content.extensionPrompts - An array of additional prompts.
 * @param {object[]} content.messages - An array of messages to be used as chat history.
 * @param {string[]} content.messageExamples - An array of messages to be used as dialogue examples.
 * @param dryRun - Whether this is a live call or not.
 * @returns {Promise<(any[]|boolean)[]>} An array where the first element is the prepared chat and the second element is a boolean flag.
 */
export async function prepareOpenAIMessages({
    name2,
    charDescription,
    charPersonality,
    scenario,
    worldInfoBeforeEntries,
    worldInfoAfterEntries,
    bias,
    type,
    quietPrompt,
    quietImage,
    extensionPrompts,
    cyclePrompt,
    systemPromptOverride,
    jailbreakPromptOverride,
    messages,
    messageExamples,
}, dryRun) {
    // Without a character selected, there is no way to accurately calculate tokens
    if (!promptManager.activeCharacter && dryRun) return [null, false];

    const chatCompletion = new ChatCompletion();
    if (power_user.console_log_prompts) chatCompletion.enableLogging();

    const userSettings = promptManager.serviceSettings;
    chatCompletion.setTokenBudget(userSettings.openai_max_context, userSettings.openai_max_tokens);

    try {
        // Merge markers and ordered user prompts with system prompts
        const prompts = await preparePromptsForChatCompletion({
            scenario,
            charPersonality,
            name2,
            charDescription,
            quietPrompt,
            bias,
            extensionPrompts,
            systemPromptOverride,
            jailbreakPromptOverride,
            type,
        });

        // Fill the chat completion with as much context as the budget allows
        await populateChatCompletion(prompts, chatCompletion, {
            bias,
            quietPrompt,
            quietImage,
            type,
            cyclePrompt,
            worldInfoBeforeEntries,
            worldInfoAfterEntries,
            messages,
            messageExamples,
        });
    } catch (error) {
        if (error instanceof TokenBudgetExceededError) {
            toastr.error(t`Mandatory prompts exceed the context size.`);
            chatCompletion.log('Mandatory prompts exceed the context size.');
            promptManager.error = t`Not enough free tokens for mandatory prompts. Raise your token limit or disable custom prompts.`;
        } else if (error instanceof InvalidCharacterNameError) {
            toastr.warning(t`An error occurred while counting tokens: Invalid character name`);
            chatCompletion.log('Invalid character name');
            promptManager.error = t`The name of at least one character contained whitespaces or special characters. Please check your user and character name.`;
        } else {
            toastr.error(t`An unknown error occurred while counting tokens. Further information may be available in console.`);
            console.error('Unexpected error while preparing prompts', error);
            chatCompletion.log('----- Unexpected error while preparing prompts -----');
            chatCompletion.log(error);
            chatCompletion.log(error.stack);
            chatCompletion.log('----------------------------------------------------');
        }
    } finally {
        // Pass chat completion to prompt manager for inspection
        promptManager.setChatCompletion(chatCompletion);

        if (oai_settings.squash_system_messages && dryRun == false) {
            await chatCompletion.squashSystemMessages();
        }

        // All information is up-to-date, render.
        if (false === dryRun) promptManager.render(false);
    }

    const chat = chatCompletion.getChat();

    const eventData = { chat, dryRun };
    await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);

    openai_messages_count = chat.filter(x => !x?.tool_calls && ['user', 'assistant', 'tool'].includes(x?.role)).length || 0;

    return [chat, promptManager.tokenHandler.counts];
}

/**
 * Handles errors during streaming requests.
 * @param {Response} response
 * @param {string} decoded - response text or decoded stream data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 */
export function tryParseStreamingError(response, decoded, { quiet = false } = {}) {
    try {
        const data = JSON.parse(decoded);

        if (!data) {
            return;
        }

        checkQuotaError(data, { quiet });
        checkModerationError(data, { quiet });

        // these do not throw correctly (equiv to Error("[object Object]"))
        // if trying to fix "[object Object]" displayed to users, start here

        if (data.error) {
            !quiet && toastr.error(data.error.message || response.statusText, 'Chat Completion API');
            throw new Error(data);
        }

        if (data.message) {
            !quiet && toastr.error(data.message, 'Chat Completion API');
            throw new Error(data);
        }

        if (data.detail) {
            !quiet && toastr.error(data.detail?.error?.message || response.statusText, 'Chat Completion API');
            throw new Error(data);
        }
    } catch {
        // No JSON. Do nothing.
    }
}

/**
 * Checks if the response contains a quota error and displays a popup if it does.
 * @param data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 * @returns {void}
 * @throws {object} - response JSON
 */
function checkQuotaError(data, { quiet = false } = {}) {
    if (!data) {
        return;
    }

    if (data.quota_error) {
        !quiet && renderTemplateAsync('quotaError').then((html) => Popup.show.text('Quota Error', html));

        // this does not throw correctly (equiv to Error("[object Object]"))
        // if trying to fix "[object Object]" displayed to users, start here
        throw new Error(data);
    }
}

/**
 * @param {any} data
 * @param {object} [options]
 * @param {boolean?} [options.quiet=false] Suppress toast messages
 */
function checkModerationError(data, { quiet = false } = {}) {
    const moderationError = data?.error?.message?.includes('requires moderation');
    if (moderationError && !quiet) {
        const moderationReason = `Reasons: ${data?.error?.metadata?.reasons?.join(', ') ?? '(N/A)'}`;
        const flaggedText = data?.error?.metadata?.flagged_input ?? '(N/A)';
        toastr.info(flaggedText, moderationReason, { timeOut: 10000 });
    }
}

/**
 * Gets the API model for the selected chat completion source.
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @returns {string} API model
 */
export function getChatCompletionModel(settings = null) {
    settings = settings ?? oai_settings;
    const source = settings.chat_completion_source;
    switch (source) {
        case chat_completion_sources.CLAUDE:
            return settings.claude_model;
        case chat_completion_sources.OPENAI:
            return settings.openai_model;
        case chat_completion_sources.MAKERSUITE:
            return settings.google_model;
        case chat_completion_sources.VERTEXAI:
            return settings.vertexai_model;
        case chat_completion_sources.OPENROUTER:
            return settings.openrouter_model !== openrouter_website_model ? settings.openrouter_model : null;
        case chat_completion_sources.AI21:
            return settings.ai21_model;
        case chat_completion_sources.MISTRALAI:
            return settings.mistralai_model;
        case chat_completion_sources.CUSTOM:
            return settings.custom_model;
        case chat_completion_sources.COHERE:
            return settings.cohere_model;
        case chat_completion_sources.PERPLEXITY:
            return settings.perplexity_model;
        case chat_completion_sources.GROQ:
            return settings.groq_model;
        case chat_completion_sources.SILICONFLOW:
            return settings.siliconflow_model;
        case chat_completion_sources.MINIMAX:
            return settings.minimax_model;
        case chat_completion_sources.ELECTRONHUB:
            return settings.electronhub_model;
        case chat_completion_sources.CHUTES:
            return settings.chutes_model;
        case chat_completion_sources.NANOGPT:
            return settings.nanogpt_model;
        case chat_completion_sources.DEEPSEEK:
            return settings.deepseek_model;
        case chat_completion_sources.AIMLAPI:
            return settings.aimlapi_model;
        case chat_completion_sources.XAI:
            return settings.xai_model;
        case chat_completion_sources.POLLINATIONS:
            return settings.pollinations_model;
        case chat_completion_sources.COMETAPI:
            return settings.cometapi_model;
        case chat_completion_sources.MOONSHOT:
            return settings.moonshot_model;
        case chat_completion_sources.FIREWORKS:
            return settings.fireworks_model;
        case chat_completion_sources.AZURE_OPENAI:
            return settings.azure_openai_model;
        case chat_completion_sources.ZAI:
            return settings.zai_model;
        case chat_completion_sources.WORKERS_AI:
            return settings.workers_ai_model;
        default:
            console.error(`Unknown chat completion source: ${source}`);
            return '';
    }
}

function getOpenRouterModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    let tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
    let tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);

    const price = 0 === Number(model.pricing?.prompt) ? 'Free' : `${tokens_rounded}k t/$ `;

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.context_length} ctx | <small>${price}</small></div>
        </div>
    `));
}

function calculateOpenRouterCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.OPENROUTER) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.openrouter_model);

    if (model?.pricing) {
        const completionCost = Number(model.pricing.completion);
        const promptCost = Number(model.pricing.prompt);
        const completionTokens = oai_settings.openai_max_tokens;
        const promptTokens = (oai_settings.openai_max_context - completionTokens);
        const totalCost = (completionCost * completionTokens) + (promptCost * promptTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(3);
        }
    }

    if (oai_settings.enable_web_search) {
        const webSearchCost = (0.02).toFixed(2);
        cost = t`${cost} + $${webSearchCost}`;
    }

    $('#openrouter_max_prompt_cost').text(cost);
}

function getElectronHubModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;
    const price = inputPrice && outputPrice ? `$${inputPrice}/$${outputPrice} in/out Mtoken` : 'Unknown';

    const visionIcon = model.metadata?.vision ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.metadata?.reasoning ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.metadata?.function_call ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';
    const premiumIcon = model?.premium_model ? '<i class="fa-solid fa-crown fa-sm" title="This model requires a subscription"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);
    iconsContainer.insertAdjacentHTML('beforeend', premiumIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.tokens} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function calculateElectronHubCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.ELECTRONHUB) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.electronhub_model);

    if (model?.pricing) {
        const outputCost = Number(model.pricing.output / 1000000);
        const inputCost = Number(model.pricing.input / 1000000);
        const outputTokens = oai_settings.openai_max_tokens;
        const inputTokens = (oai_settings.openai_max_context - outputTokens);
        const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(4);
        }
    }

    $('#electronhub_max_prompt_cost').text(cost);
}

function getChutesModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.input;
    const outputPrice = model.pricing?.output;

    let price = 'Unknown';
    if (inputPrice !== undefined && outputPrice !== undefined) {
        // Check if both prices are 0 (free model)
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${inputPrice}/$${outputPrice} in/out Mtoken`;
        }
    }

    const contextLength = model.context_length || model.max_model_len || 'Unknown';
    const visionIcon = model.input_modalities?.includes('image') ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.supported_features?.includes('reasoning') ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.supported_features?.includes('structured_outputs') ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports function tools"></i>' : '';

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(model.id)}</strong> | ${contextLength} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function calculateChutesCost() {
    if (oai_settings.chat_completion_source !== chat_completion_sources.CHUTES) {
        return;
    }

    let cost = 'Unknown';
    const model = model_list.find(x => x.id === oai_settings.chutes_model);

    if (model?.pricing) {
        const outputPrice = model.pricing?.output;
        const inputPrice = model.pricing?.input;

        if (outputPrice !== undefined && inputPrice !== undefined) {
            const outputCost = Number(outputPrice / 1000000);
            const inputCost = Number(inputPrice / 1000000);
            const outputTokens = oai_settings.openai_max_tokens;
            const inputTokens = (oai_settings.openai_max_context - outputTokens);
            const totalCost = (outputCost * outputTokens) + (inputCost * inputTokens);
            if (!isNaN(totalCost)) {
                cost = '$' + totalCost.toFixed(4);
            }
        }
    }

    $('#chutes_max_prompt_cost').text(cost);
}

const sourceModelBindings = {
    [chat_completion_sources.OPENAI]: { settingKey: 'openai_model', selector: '#openai_model_id', extraSelectors: ['#model_openai_select_fill', '#model_openai_select'] },
    // Claude binds the text input as its source-of-truth; the `Available Models`
    // select is a separate one-shot picker.
    [chat_completion_sources.CLAUDE]: { settingKey: 'claude_model', selector: '#claude_model_id', extraSelectors: ['#model_claude_select_fill', '#model_claude_select'] },
    [chat_completion_sources.MAKERSUITE]: { settingKey: 'google_model', selector: '#google_model_id', extraSelectors: ['#model_google_select_fill', '#model_google_select'] },
    [chat_completion_sources.VERTEXAI]: { settingKey: 'vertexai_model', selector: '#vertexai_model_id', extraSelectors: ['#model_vertexai_select_fill', '#model_vertexai_select'] },
    [chat_completion_sources.OPENROUTER]: { settingKey: 'openrouter_model', selector: '#model_openrouter_select' },
    [chat_completion_sources.AI21]: { settingKey: 'ai21_model', selector: '#model_ai21_select' },
    [chat_completion_sources.MISTRALAI]: { settingKey: 'mistralai_model', selector: '#mistralai_model_id', extraSelectors: ['#model_mistralai_select_fill', '#model_mistralai_select'] },
    [chat_completion_sources.COHERE]: { settingKey: 'cohere_model', selector: '#model_cohere_select' },
    [chat_completion_sources.PERPLEXITY]: { settingKey: 'perplexity_model', selector: '#model_perplexity_select' },
    [chat_completion_sources.GROQ]: { settingKey: 'groq_model', selector: '#model_groq_select' },
    [chat_completion_sources.CHUTES]: { settingKey: 'chutes_model', selector: '#model_chutes_select' },
    [chat_completion_sources.SILICONFLOW]: { settingKey: 'siliconflow_model', selector: '#model_siliconflow_select' },
    [chat_completion_sources.ELECTRONHUB]: { settingKey: 'electronhub_model', selector: '#model_electronhub_select' },
    [chat_completion_sources.NANOGPT]: { settingKey: 'nanogpt_model', selector: '#model_nanogpt_select' },
    [chat_completion_sources.DEEPSEEK]: { settingKey: 'deepseek_model', selector: '#deepseek_model_id', extraSelectors: ['#model_deepseek_select_fill', '#model_deepseek_select'] },
    [chat_completion_sources.AIMLAPI]: { settingKey: 'aimlapi_model', selector: '#model_aimlapi_select' },
    [chat_completion_sources.CUSTOM]: { settingKey: 'custom_model', selector: '#model_custom_select', extraSelectors: ['#model_custom_select_fill'] },
    [chat_completion_sources.XAI]: { settingKey: 'xai_model', selector: '#xai_model_id', extraSelectors: ['#model_xai_select_fill', '#model_xai_select'] },
    [chat_completion_sources.POLLINATIONS]: { settingKey: 'pollinations_model', selector: '#model_pollinations_select' },
    [chat_completion_sources.COMETAPI]: { settingKey: 'cometapi_model', selector: '#model_cometapi_select' },
    [chat_completion_sources.MOONSHOT]: { settingKey: 'moonshot_model', selector: '#moonshot_model_id', extraSelectors: ['#model_moonshot_select_fill', '#model_moonshot_select'] },
    [chat_completion_sources.FIREWORKS]: { settingKey: 'fireworks_model', selector: '#model_fireworks_select' },
    [chat_completion_sources.AZURE_OPENAI]: { settingKey: 'azure_openai_model', selector: '#azure_openai_model' },
    [chat_completion_sources.ZAI]: { settingKey: 'zai_model', selector: '#zai_model_id', extraSelectors: ['#model_zai_select_fill', '#model_zai_select'] },
};

function getModelBindingForSource(source = oai_settings.chat_completion_source) {
    return sourceModelBindings[source] ?? null;
}

function parseCustomModelList(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }

    const result = [];
    const seen = new Set();
    const normalizedInput = text.replace(/,/g, '\n');
    const lines = normalizedInput.split('\n');
    for (const line of lines) {
        const modelId = String(line || '').trim();
        if (!modelId || seen.has(modelId)) {
            continue;
        }
        seen.add(modelId);
        result.push(modelId);
    }

    return result;
}

function normalizeCustomModelsBySource(value) {
    const normalized = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return normalized;
    }

    for (const [rawSource, rawModels] of Object.entries(value)) {
        const source = String(rawSource || '').trim();
        if (!source || !sourceModelBindings[source]) {
            continue;
        }

        const models = Array.isArray(rawModels)
            ? rawModels.map(x => String(x || '').trim()).filter(Boolean)
            : parseCustomModelList(String(rawModels || ''));

        if (!models.length) {
            continue;
        }

        normalized[source] = [...new Set(models)];
    }

    return normalized;
}

function getCustomModelsForSource(source = oai_settings.chat_completion_source) {
    const normalized = normalizeCustomModelsBySource(oai_settings.custom_models_by_source);
    oai_settings.custom_models_by_source = normalized;
    return normalized[source] ?? [];
}

function setCustomModelsForSource(source, modelIds) {
    const normalized = normalizeCustomModelsBySource(oai_settings.custom_models_by_source);
    if (Array.isArray(modelIds) && modelIds.length > 0) {
        normalized[source] = [...new Set(modelIds.map(id => String(id || '').trim()).filter(Boolean))];
    } else {
        delete normalized[source];
    }
    oai_settings.custom_models_by_source = normalized;
}

function mergeModelRecordsWithCustom(models, source = oai_settings.chat_completion_source) {
    const merged = Array.isArray(models) ? models.map(model => ({ ...model })) : [];
    const customModels = getCustomModelsForSource(source);
    if (!customModels.length) {
        return merged;
    }

    const existing = new Set(merged.map(model => String(model?.id || '').trim()).filter(Boolean));
    for (const modelId of customModels) {
        if (!existing.has(modelId)) {
            merged.push({ id: modelId });
            existing.add(modelId);
        }
    }

    return merged;
}

function appendMissingModelOptions($select, modelIds) {
    if (!$select?.length || !Array.isArray(modelIds) || modelIds.length === 0) {
        return;
    }

    const existing = new Set($select.find('option').map((_, option) => String(option.value || '').trim()).get().filter(Boolean));
    for (const modelId of modelIds) {
        if (!modelId || existing.has(modelId)) {
            continue;
        }
        $select.append(new Option(modelId, modelId));
        existing.add(modelId);
    }
}

function applyCustomModelsToCurrentSource({ triggerModelChange = false, includeSelected = true } = {}) {
    const source = oai_settings.chat_completion_source;
    const binding = getModelBindingForSource(source);
    if (!binding) {
        return;
    }

    const customModels = getCustomModelsForSource(source);
    const selectedModel = String(oai_settings[binding.settingKey] || '').trim();
    const allModels = (includeSelected && selectedModel) ? [...customModels, selectedModel] : customModels;

    const targets = [binding.selector, ...(binding.extraSelectors || [])];
    for (const selector of targets) {
        appendMissingModelOptions($(selector), allModels);
    }

    if (includeSelected && selectedModel) {
        const $select = $(binding.selector);
        $select.val(selectedModel);
        if (triggerModelChange) {
            $select.trigger('change');
        }
    }
}

function refreshCustomModelsEditorForCurrentSource() {
    const source = oai_settings.chat_completion_source;
    const binding = getModelBindingForSource(source);
    const $textarea = $('#chat_completion_custom_models_text');
    const $applyButton = $('#chat_completion_custom_models_apply');

    if (!binding) {
        $textarea.val('').prop('disabled', true);
        $applyButton.addClass('disabled').attr('aria-disabled', 'true');
        return;
    }

    const customModels = getCustomModelsForSource(source);
    $textarea.val(customModels.join('\n')).prop('disabled', false);
    $applyButton.removeClass('disabled').removeAttr('aria-disabled');
}

function getNanoGptModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const inputPrice = model.pricing?.prompt;
    const outputPrice = model.pricing?.completion;
    let price = 'Unknown';

    if (inputPrice !== undefined && outputPrice !== undefined) {
        if (inputPrice === 0 && outputPrice === 0) {
            price = 'Free';
        } else {
            price = `$${Math.round(inputPrice * 100) / 100}/$${Math.round(outputPrice * 100) / 100} in/out Mtoken`;
        }
    }

    const visionIcon = model.capabilities?.vision ? '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i>' : '';
    const reasoningIcon = model.capabilities?.reasoning ? '<i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>' : '';
    const toolCallsIcon = model.capabilities?.tool_calling ? '<i class="fa-solid fa-wrench fa-sm" title="This model supports tool calling"></i>' : '';

    let subHtml = '';
    const sub = model.subscription;

    if (sub) {
        if (sub.included) {
            let titleText = 'Included in subscription';
            let multiplierText = '';

            if (sub.inputTokenMultiplier && sub.inputTokenMultiplier !== 1) {
                multiplierText = ` (${sub.inputTokenMultiplier}x)`;
                titleText += ` - Input Multiplier: ${sub.inputTokenMultiplier}x`;
            }
            subHtml = ` <small title="${titleText}"><i class="fa-solid fa-crown fa-sm"></i> Sub${multiplierText}</small>`;
        } else if (sub.note) {
            const safeNote = DOMPurify.sanitize(sub.note);
            subHtml = ` <small title="${safeNote}"><i class="fa-solid fa-circle-info fa-sm"></i> Not in Sub</small>`;
        }
    }

    const iconsContainer = document.createElement('span');
    iconsContainer.insertAdjacentHTML('beforeend', visionIcon);
    iconsContainer.insertAdjacentHTML('beforeend', reasoningIcon);
    iconsContainer.insertAdjacentHTML('beforeend', toolCallsIcon);
    iconsContainer.insertAdjacentHTML('beforeend', subHtml);

    const capabilities = (iconsContainer.children.length) ? ` | ${iconsContainer.innerHTML}` : '';

    const contextLength = model.context_length || 'Unknown';
    const modelName = model.name || model.id;

    return $((`
        <div class="flex-container alignItemsBaseline" title="${DOMPurify.sanitize(model.id)}">
            <strong>${DOMPurify.sanitize(modelName)}</strong> | ${contextLength} ctx | <small>${price}</small>${capabilities}
        </div>
    `));
}

function getAimlapiModelTemplate(option) {
    const model = model_list.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const vendor = model.id.split('/')[0];

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.info?.name || model.name || model.id)}</strong> | ${vendor}</div>
        </div>
    `));
}

/**
 * Reconcile a saved model id against a freshly fetched model list.
 * - Non-empty saved id missing from the list: append it as a "(custom)" option
 *   so the select keeps the user's chosen id intact.
 * - Empty saved id: fall back to the first list entry.
 * - Otherwise: leave the saved id intact.
 *
 * @param {string} selectSelector jQuery selector for the model `<select>`
 * @param {Array<{id?: string}>} modelList Fetched models
 * @param {string} savedModelId Currently saved model id
 * @returns {string} The model id that should be applied to oai_settings + DOM
 */
function reconcileModelSelection(selectSelector, modelList, savedModelId) {
    const safeList = Array.isArray(modelList) ? modelList : [];
    if (safeList.length === 0) {
        return savedModelId;
    }
    const id = String(savedModelId || '');
    const matches = safeList.some(model => model?.id === id);
    if (id && !matches) {
        const $select = $(selectSelector);
        if ($select.length && $select.find(`option[value="${CSS.escape(id)}"]`).length === 0) {
            $select.append($('<option>', { value: id, text: `${id} (custom)` }));
        }
        return id;
    }
    if (!id) {
        return safeList[0].id;
    }
    return id;
}

/**
 * Keep the "Available Models" `<select>` and its sibling `<datalist>` mutually
 * consistent for reverse-proxy capable sources.
 *
 * - On first call: mirror whatever side carries the HTML-declared baseline
 *   into the other side (Claude declares it in the datalist; the rest declare
 *   it in the select).
 * - On every call: append fetched `modelList` entries to both sides if absent,
 *   and reflect `savedModelId` on the select via `.val()` so it visually tracks
 *   the source-of-truth text input.
 *
 * @param {{ selectSelector: string, datalistSelector: string, modelList?: Array<{id?: string}>, savedModelId?: string }} params
 */
function syncSourceModelInputs({ selectSelector, datalistSelector, modelList = [], savedModelId = '' }) {
    const $select = $(selectSelector);
    const $datalist = $(datalistSelector);
    if (!$select.length || !$datalist.length) {
        return;
    }

    // Drop stale dynamic entries from a previous fetch so changing base_url
    // (or switching reverse proxies) doesn't accumulate model ids over time.
    $select.find('option[data-dynamic="1"]').remove();
    $datalist.find('option[data-dynamic="1"]').remove();

    const datalistIds = new Set($datalist.find('option').map(function () { return String($(this).attr('value') || ''); }).get());
    const selectIds = new Set($select.find('option').map(function () { return String($(this).attr('value') || ''); }).get());

    // One-way mirror datalist → select if select is still empty (Claude shape).
    if ($select.find('option').length === 0) {
        for (const id of datalistIds) {
            if (id) {
                $select.append($('<option>', { value: id, text: id, 'data-mirror': '1' }));
                selectIds.add(id);
            }
        }
    }
    // Mirror select baseline into datalist exactly once (other sources' shape).
    if ($datalist.find('option[data-mirror="1"]').length === 0 && datalistIds.size === 0) {
        for (const id of selectIds) {
            if (id) {
                $datalist.append($('<option>', { value: id, 'data-mirror': '1' }));
                datalistIds.add(id);
            }
        }
    }

    // Append dynamically fetched models if absent on either side.
    const safeList = Array.isArray(modelList) ? modelList : [];
    for (const model of safeList) {
        const id = String(model?.id || '').trim();
        if (!id) continue;
        if (!selectIds.has(id)) {
            $select.append($('<option>', { value: id, text: id, 'data-dynamic': '1' }));
            selectIds.add(id);
        }
        if (!datalistIds.has(id)) {
            $datalist.append($('<option>', { value: id, 'data-dynamic': '1' }));
            datalistIds.add(id);
        }
    }

    // Reflect the saved id onto the picker so it tracks the text input.
    const savedId = String(savedModelId || '');
    if (savedId && $select.find(`option[value="${CSS.escape(savedId)}"]`).length > 0) {
        $select.val(savedId);
    } else {
        $select.val('');
    }
}

// All chat-completion sources where the model id is a free-form text input
// backed by a sibling <select> picker + <datalist> for suggestions.
// Used to register input/select handlers and to seed the picker on settings load.
const INPUT_BASED_MODEL_BINDINGS = [
    { input: '#openai_model_id', select: '#model_openai_select', datalist: '#model_openai_select_fill', key: 'openai_model' },
    { input: '#claude_model_id', select: '#model_claude_select', datalist: '#model_claude_select_fill', key: 'claude_model' },
    { input: '#google_model_id', select: '#model_google_select', datalist: '#model_google_select_fill', key: 'google_model' },
    { input: '#vertexai_model_id', select: '#model_vertexai_select', datalist: '#model_vertexai_select_fill', key: 'vertexai_model' },
    { input: '#mistralai_model_id', select: '#model_mistralai_select', datalist: '#model_mistralai_select_fill', key: 'mistralai_model' },
    { input: '#deepseek_model_id', select: '#model_deepseek_select', datalist: '#model_deepseek_select_fill', key: 'deepseek_model' },
    { input: '#xai_model_id', select: '#model_xai_select', datalist: '#model_xai_select_fill', key: 'xai_model' },
    { input: '#moonshot_model_id', select: '#model_moonshot_select', datalist: '#model_moonshot_select_fill', key: 'moonshot_model' },
    { input: '#zai_model_id', select: '#model_zai_select', datalist: '#model_zai_select_fill', key: 'zai_model' },
    { input: '#custom_model_id', select: '#model_custom_select', datalist: '#model_custom_select_fill', key: 'custom_model' },
];

function saveModelList(data) {    model_list = mergeModelRecordsWithCustom(data, oai_settings.chat_completion_source);
    model_list.sort((a, b) => a?.id && b?.id && a.id.localeCompare(b.id));

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.OPENROUTER);
        $('#model_openrouter_select').empty();
        $('#model_openrouter_select').append($('<option>', { value: openrouter_website_model, text: t`Use OpenRouter website setting` }));

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.OPENROUTER).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name }));
                });
                $('#model_openrouter_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_openrouter_select').append($('<option>', { value: model.id, text: model.name }));
            });
        }

        $('#model_openrouter_select').val(oai_settings.openrouter_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENAI) {
        $('#openai_external_category').empty();
        model_list.forEach((model) => {
            $('#openai_external_category').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });
        if (oai_settings.show_external_models) {
            syncSourceModelInputs({
                selectSelector: '#model_openai_select',
                datalistSelector: '#model_openai_select_fill',
                modelList: model_list,
                savedModelId: oai_settings.openai_model,
            });
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE && model_list.length > 0) {
        syncSourceModelInputs({
            selectSelector: '#model_claude_select',
            datalistSelector: '#model_claude_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.claude_model,
        });

        if (!oai_settings.claude_model) {
            oai_settings.claude_model = model_list[0].id;
            $('#claude_model_id').val(oai_settings.claude_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI && model_list.length > 0) {
        syncSourceModelInputs({
            selectSelector: '#model_vertexai_select',
            datalistSelector: '#model_vertexai_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.vertexai_model,
        });
        if (!oai_settings.vertexai_model) {
            oai_settings.vertexai_model = model_list[0].id;
            $('#vertexai_model_id').val(oai_settings.vertexai_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        syncSourceModelInputs({
            selectSelector: '#model_custom_select',
            datalistSelector: '#model_custom_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.custom_model,
        });
        if (!oai_settings.custom_model && model_list.length > 0) {
            oai_settings.custom_model = model_list[0].id;
            $('#custom_model_id').val(oai_settings.custom_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        model_list = model_list.filter(m => m.type === 'chat-completion');
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.AIMLAPI);
        $('#model_aimlapi_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.AIMLAPI).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.info?.name || model.id }));
                });
                $('#model_aimlapi_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_aimlapi_select').append($('<option>', { value: model.id, text: model.info?.name || model.id }));
            });
        }

        oai_settings.aimlapi_model = reconcileModelSelection('#model_aimlapi_select', model_list, oai_settings.aimlapi_model);

        $('#model_aimlapi_select').val(oai_settings.aimlapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        const completionList = model_list.filter(model => model?.capabilities?.completion_chat);
        syncSourceModelInputs({
            selectSelector: '#model_mistralai_select',
            datalistSelector: '#model_mistralai_select_fill',
            modelList: completionList,
            savedModelId: oai_settings.mistralai_model,
        });
        if (!oai_settings.mistralai_model && completionList.length > 0) {
            oai_settings.mistralai_model = completionList[0].id;
            $('#mistralai_model_id').val(oai_settings.mistralai_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        model_list = model_list.filter(model => model?.endpoints?.includes('/v1/chat/completions'));
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.ELECTRONHUB);
        $('#model_electronhub_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.ELECTRONHUB).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name }));
                });
                $('#model_electronhub_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_electronhub_select').append($('<option>', { value: model.id, text: model.name }));
            });
        }

        oai_settings.electronhub_model = reconcileModelSelection('#model_electronhub_select', model_list, oai_settings.electronhub_model);
        $('#model_electronhub_select').val(oai_settings.electronhub_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        model_list = model_list.filter(model => typeof model.id === 'string' && !model.id.toLowerCase().includes('affine'));
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.CHUTES);
        $('#model_chutes_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.CHUTES).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.id }));
                });
                $('#model_chutes_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_chutes_select').append($('<option>', { value: model.id, text: model.id }));
            });
        }

        oai_settings.chutes_model = reconcileModelSelection('#model_chutes_select', model_list, oai_settings.chutes_model);
        $('#model_chutes_select').val(oai_settings.chutes_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        model_list = sortModelsBy(model_list, oai_settings.sort_models, chat_completion_sources.NANOGPT);
        $('#model_nanogpt_select').empty();

        if (oai_settings.group_models) {
            groupModelsByVendor(model_list, chat_completion_sources.NANOGPT).forEach((models, vendor) => {
                const optgroup = $('<optgroup>').attr('label', vendor);
                models.forEach((model) => {
                    optgroup.append($('<option>', { value: model.id, text: model.name || model.id }));
                });
                $('#model_nanogpt_select').append(optgroup);
            });
        } else {
            model_list.forEach((model) => {
                $('#model_nanogpt_select').append($('<option>', { value: model.id, text: model.name || model.id }));
            });
        }

        oai_settings.nanogpt_model = reconcileModelSelection('#model_nanogpt_select', model_list, oai_settings.nanogpt_model);
        $('#model_nanogpt_select').val(oai_settings.nanogpt_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        syncSourceModelInputs({
            selectSelector: '#model_deepseek_select',
            datalistSelector: '#model_deepseek_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.deepseek_model,
        });
        if (!oai_settings.deepseek_model && model_list.length > 0) {
            oai_settings.deepseek_model = model_list[0].id;
            $('#deepseek_model_id').val(oai_settings.deepseek_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        $('#model_pollinations_select').empty();
        model_list.forEach((model) => {
            $('#model_pollinations_select').append($('<option>', { value: model.id, text: model.id }));
        });

        oai_settings.pollinations_model = reconcileModelSelection('#model_pollinations_select', model_list, oai_settings.pollinations_model);
        $('#model_pollinations_select').val(oai_settings.pollinations_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MAKERSUITE) {
        // Clear only the "Other" optgroup for dynamic models
        $('#google_other_models').empty();

        // Get static model options that are already in the HTML
        const staticModels = [];
        $('#model_google_select option').each(function () {
            staticModels.push($(this).val());
        });

        // Add dynamic models to the "Other" group
        model_list.forEach((model) => {
            // Only add if not already in static list
            if (!staticModels.includes(model.id)) {
                $('#google_other_models').append(
                    $('<option>', {
                        value: model.id,
                        text: model.id,
                    }));
            }
        });

        // Merge static models into model_list
        staticModels.forEach(modelId => {
            if (!model_list.some(model => model.id === modelId)) {
                model_list.push({ id: modelId });
            }
        });

        syncSourceModelInputs({
            selectSelector: '#model_google_select',
            datalistSelector: '#model_google_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.google_model,
        });
        if (!oai_settings.google_model && model_list.length > 0) {
            oai_settings.google_model = model_list[0].id;
            $('#google_model_id').val(oai_settings.google_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.GROQ) {
        $('#model_groq_select').empty();
        model_list.forEach((model) => {
            $('#model_groq_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        oai_settings.groq_model = reconcileModelSelection('#model_groq_select', model_list, oai_settings.groq_model);
        $('#model_groq_select').val(oai_settings.groq_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').empty();
        model_list.forEach((model) => {
            $('#model_siliconflow_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        oai_settings.siliconflow_model = reconcileModelSelection('#model_siliconflow_select', model_list, oai_settings.siliconflow_model);
        $('#model_siliconflow_select').val(oai_settings.siliconflow_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').empty();
        model_list.forEach((model) => {
            if (!model?.supports_chat) {
                return;
            }
            $('#model_fireworks_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        oai_settings.fireworks_model = reconcileModelSelection('#model_fireworks_select', model_list, oai_settings.fireworks_model);
        $('#model_fireworks_select').val(oai_settings.fireworks_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').empty();
        model_list.forEach((model) => {
            $('#model_workers_ai_select').append(
                $('<option>', {
                    value: model.id,
                    text: model.id,
                }));
        });

        oai_settings.workers_ai_model = reconcileModelSelection('#model_workers_ai_select', model_list, oai_settings.workers_ai_model);
        $('#model_workers_ai_select').val(oai_settings.workers_ai_model).trigger('change');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').empty();

        model_list.forEach((model) => {
            const modelId = model.id.toLowerCase();
            const isIgnoredModel = COMETAPI_IGNORE_PATTERNS.some(pattern => modelId.includes(pattern));

            if (isIgnoredModel) {
                return;
            }

            $('#model_cometapi_select').append(new Option(model.id, model.id));
        });

        const reconciledCometApi = reconcileModelSelection('#model_cometapi_select', model_list, oai_settings.cometapi_model);
        if (reconciledCometApi !== oai_settings.cometapi_model) {
            oai_settings.cometapi_model = reconciledCometApi;
            saveSettingsDebounced();
        }

        $('#model_cometapi_select').val(oai_settings.cometapi_model).trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        const modelId = model_list?.[0]?.id || '';
        oai_settings.azure_openai_model = modelId;

        $('#azure_openai_model')
            .empty()
            .append(new Option(modelId || 'None', modelId || '', true, true))
            .trigger('change');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        syncSourceModelInputs({
            selectSelector: '#model_xai_select',
            datalistSelector: '#model_xai_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.xai_model,
        });
        if (!oai_settings.xai_model && model_list.length > 0) {
            oai_settings.xai_model = model_list[0].id;
            $('#xai_model_id').val(oai_settings.xai_model).trigger('input');
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        syncSourceModelInputs({
            selectSelector: '#model_moonshot_select',
            datalistSelector: '#model_moonshot_select_fill',
            modelList: model_list,
            savedModelId: oai_settings.moonshot_model,
        });
        if (!oai_settings.moonshot_model && model_list.length > 0) {
            oai_settings.moonshot_model = model_list[0].id;
            $('#moonshot_model_id').val(oai_settings.moonshot_model).trigger('input');
        }
    }

    applyCustomModelsToCurrentSource({ includeSelected: false });
}

/**
 * Sorts models by the specified property for the given source.
 * @param {object[]} data - Array of model objects
 * @param {string} property - Sort property ('alphabetically', 'context_length', 'pricing.prompt', 'pricing.completion')
 * @param {string} source - Chat Completion source (e.g., 'openrouter', 'chutes', 'electronhub', 'nanogpt')
 * @returns {object[]} Sorted array of model objects
 */
function sortModelsBy(data, property, source) {
    switch (source) {
        case chat_completion_sources.OPENROUTER:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.prompt || 0) - parseFloat(b.pricing?.prompt || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.completion || 0) - parseFloat(b.pricing?.completion || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.CHUTES:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.input || 0) - parseFloat(b.pricing?.input || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.output || 0) - parseFloat(b.pricing?.output || 0);
                } else {
                    return a?.id && b?.id ? a.id.localeCompare(b.id) : 0;
                }
            });
        case chat_completion_sources.ELECTRONHUB:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.tokens || 0) - (a.tokens || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.input || 0) - parseFloat(b.pricing?.input || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.output || 0) - parseFloat(b.pricing?.output || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.NANOGPT:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.context_length || 0) - (a.context_length || 0);
                } else if (property === 'pricing.input' || property === 'pricing.prompt') {
                    return parseFloat(a.pricing?.prompt || 0) - parseFloat(b.pricing?.prompt || 0);
                } else if (property === 'pricing.output' || property === 'pricing.completion') {
                    return parseFloat(a.pricing?.completion || 0) - parseFloat(b.pricing?.completion || 0);
                } else {
                    return a?.name && b?.name ? a.name.localeCompare(b.name) : 0;
                }
            });
        case chat_completion_sources.AIMLAPI:
            return data.sort((a, b) => {
                if (property === 'context_length') {
                    return (b.info?.contextLength || 0) - (a.info?.contextLength || 0);
                } else {
                    // No pricing information on the API. Sort alphabetically by name.
                    return a?.info?.name && b?.info?.name ? a.info.name.localeCompare(b.info.name) : 0;
                }
            });
        default:
            return data;
    }
}

/**
 * Groups models by vendor for the given source. If not supported, returns a map with a single entry containing all models.
 * @param {object[]} array Array of model objects
 * @param {string} source Chat Completion source (e.g., 'openrouter')
 * @returns {Map<string, object[]>} Map of vendor to array of models
 */
function groupModelsByVendor(array, source) {
    switch (source) {
        case chat_completion_sources.OPENROUTER:
            return array.reduce((acc, curr) => {
                const vendor = curr.id.split('/')[0];
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.ELECTRONHUB:
            return array.reduce((acc, curr) => {
                const vendor = String(curr?.name || curr?.id || 'Other').split(':')[0].trim() || 'Other';
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.NANOGPT:
            return array.reduce((acc, curr) => {
                const vendorPart = /\//.test(curr.id) ? curr.id.split('/')[0] : curr.id.split('-')[0];
                const vendor = String(vendorPart?.trim()?.toLowerCase() || 'Other');
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.CHUTES:
            return array.reduce((acc, curr) => {
                const vendor = curr.id.split('/')[0];
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        case chat_completion_sources.AIMLAPI:
            return array.reduce((acc, curr) => {
                const vendor = curr.info?.developer || 'Other';
                if (!acc.has(vendor)) {
                    acc.set(vendor, []);
                }
                acc.get(vendor).push(curr);
                return acc;
            }, new Map());
        default:
            return new Map([['', array]]);
    }
}

/**
 * Get the reasoning effort from chat completion settings
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @param {string} model Model name (optional, used for ElectronHub)
 * @returns {string} Reasoning effort, if present
 */
function getReasoningEffort(settings = null, model = null) {
    settings = settings ?? oai_settings;
    model = model ?? getChatCompletionModel(settings);

    // These sources expect the effort as string.
    const reasoningEffortSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.COMETAPI,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
        chat_completion_sources.DEEPSEEK,
    ];

    if (!reasoningEffortSources.includes(settings.chat_completion_source)) {
        return settings.reasoning_effort;
    }

    function resolveReasoningEffort() {
        if (settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto:
                    return undefined;
                case reasoning_effort_types.max:
                    return reasoning_effort_types.max;
                default:
                    return reasoning_effort_types.high;
            }
        }

        if (settings.chat_completion_source === chat_completion_sources.CUSTOM && /^koboldcpp\/(.+)$/.test(model)) {
            switch (settings.reasoning_effort) {
                case reasoning_effort_types.auto:
                    return undefined;
                case reasoning_effort_types.min:
                    return 'minimal';
                case reasoning_effort_types.low:
                    return 'low';
                case reasoning_effort_types.medium:
                    return 'medium';
                case reasoning_effort_types.high:
                    return 'high';
                case reasoning_effort_types.max:
                    return 'xhigh';
                default:
                    return settings.reasoning_effort;
            }
        }

        switch (settings.reasoning_effort) {
            case reasoning_effort_types.auto:
                return undefined;
            case reasoning_effort_types.min:
                if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source)) {
                    if (/^gpt-5\.(4|5)/.test(model)) {
                        return 'none';
                    }
                    if (/^gpt-5/.test(model)) {
                        return reasoning_effort_types.min;
                    }
                }

                return reasoning_effort_types.low;
            case reasoning_effort_types.max:
                return reasoning_effort_types.high;
            default:
                return settings.reasoning_effort;
        }
    }

    const reasoningEffort = resolveReasoningEffort();

    // Check if the resolved effort supported by the model
    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        if (Array.isArray(model_list) && reasoningEffort) {
            const currentModel = model_list.find(m => m.id === model);
            const supportedEfforts = currentModel?.metadata?.supported_reasoning_efforts;
            if (Array.isArray(supportedEfforts) && supportedEfforts.includes(reasoningEffort)) {
                return reasoningEffort;
            }
            return undefined;
        }
    }

    return reasoningEffort;
}

/**
 * Get the verbosity from chat completion settings
 * @param {ChatCompletionSettings} settings Chat completion settings
 * @returns {string} Verbosity level, if present
 */
function getVerbosity(settings = null) {
    settings = settings ?? oai_settings;

    if (settings.verbosity === verbosity_levels.auto) {
        return undefined;
    }

    // TODO: Adjust verbosity based on model capabilities
    return settings.verbosity;
}

/**
 * Build the generation parameter object for an OAI request.
 * @param {ChatCompletionSettings} settings Initial chat completion settings
 * @param {string} model Model name
 * @param {string} type Request type (impersonate, quiet, continue, etc)
 * @param {ChatCompletionMessage[]} messages Array of chat completion messages
 * @param {import('../script.js').AdditionalRequestOptions} options Additional request options
 * @returns {Promise<object>} Final generation parameters object appropriate for the chat completion source
 */
export async function createGenerationParameters(settings, model, type, messages, { jsonSchema = null, tools = null, toolChoice = null, replaceTools = false, responseLength = null, allowStreamingForQuiet = false } = {}) {
    // HACK: Filter out null and non-object messages
    if (!Array.isArray(messages)) {
        throw new Error('messages must be an array');
    }
    messages = messages.filter(msg => msg && typeof msg === 'object');

    // "OpenAI-like" sources
    const gptSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
    ];

    // Sources that support the "seed" parameter
    const seedSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.COHERE,
        chat_completion_sources.GROQ,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.NANOGPT,
        chat_completion_sources.XAI,
        chat_completion_sources.POLLINATIONS,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.CHUTES,
    ];

    // Sources that support proxying
    const proxySupportedSources = [
        chat_completion_sources.CLAUDE,
        chat_completion_sources.OPENAI,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.ZAI,
        chat_completion_sources.MOONSHOT,
    ];

    // Sources that support logprobs
    const logprobsSupportedSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.CHUTES,
    ];

    // Sources that support logit bias
    const logitBiasSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.OPENROUTER,
        chat_completion_sources.ELECTRONHUB,
        chat_completion_sources.CHUTES,
        chat_completion_sources.CUSTOM,
    ];

    // Sources that support "n" parameter for multi-swipe
    const multiswipeSources = [
        chat_completion_sources.OPENAI,
        chat_completion_sources.AZURE_OPENAI,
        chat_completion_sources.CUSTOM,
        chat_completion_sources.XAI,
        chat_completion_sources.AIMLAPI,
        chat_completion_sources.MOONSHOT,
    ];

    const isO1 = gptSources.includes(settings.chat_completion_source) && ['o1-2024-12-17', 'o1'].includes(model);
    const isWorkersAIJsonMode = settings.chat_completion_source === chat_completion_sources.WORKERS_AI && jsonSchema;
    const stream = allowStreamingForQuiet
        ? (!isO1 && !isWorkersAIJsonMode)
        : (settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode);

    const noMultiSwipeTypes = ['quiet', 'impersonate', 'continue'];
    const canMultiSwipe = settings.n > 1 && !noMultiSwipeTypes.includes(type) && multiswipeSources.includes(settings.chat_completion_source);

    let logit_bias = {};
    if (settings.bias_preset_selected
        && logitBiasSources.includes(settings.chat_completion_source)
        && Array.isArray(settings.bias_presets[settings.bias_preset_selected])
        && settings.bias_presets[settings.bias_preset_selected].length) {
        logit_bias = biasCache || await calculateLogitBias();
        biasCache = logit_bias;
    }

    if (Object.keys(logit_bias).length === 0) {
        logit_bias = undefined;
    }

    const generate_data = {
        'type': type,
        'messages': messages,
        'model': model,
        'temperature': Number(settings.temp_openai),
        'frequency_penalty': Number(settings.freq_pen_openai),
        'presence_penalty': Number(settings.pres_pen_openai),
        'top_p': Number(settings.top_p_openai),
        'max_tokens': settings.openai_max_tokens,
        'stream': stream,
        'logit_bias': logit_bias,
        'stop': getCustomStoppingStrings(openai_max_stop_strings),
        'chat_completion_source': settings.chat_completion_source,
        'n': canMultiSwipe ? settings.n : undefined,
        'user_name': name1,
        'char_name': name2,
        'group_names': getGroupNames(),
        'include_reasoning': Boolean(settings.show_thoughts),
        'reasoning_effort': getReasoningEffort(settings, model),
        'enable_web_search': Boolean(settings.enable_web_search),
        'request_images': Boolean(settings.request_images),
        'request_image_resolution': String(settings.request_image_resolution),
        'request_image_aspect_ratio': String(settings.request_image_aspect_ratio),
        'custom_prompt_post_processing': settings.custom_prompt_post_processing,
        'verbosity': getVerbosity(settings),
    };

    if (Number.isFinite(Number(responseLength)) && Number(responseLength) > 0) {
        generate_data.max_tokens = Number(responseLength);
    }

    if (settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        generate_data.azure_base_url = settings.azure_base_url;
        generate_data.azure_deployment_name = settings.azure_deployment_name;
        generate_data.azure_api_version = settings.azure_api_version;
        // Reasoning effort is not supported on some Azure models (e.g. GPT-3.x, GPT-4.x)
        if (/^gpt-[34]/.test(model)) {
            delete generate_data.reasoning_effort;
        }
    }

    if (!canMultiSwipe && ToolManager.canPerformToolCalls(type, settings, model)) {
        await ToolManager.registerFunctionToolsOpenAI(generate_data);
    }

    if (Array.isArray(tools)) {
        if (replaceTools) {
            generate_data.tools = structuredClone(tools);
        } else {
            const existingTools = Array.isArray(generate_data.tools) ? generate_data.tools : [];
            generate_data.tools = [...existingTools, ...structuredClone(tools)];
        }
    }

    if (toolChoice !== null && toolChoice !== undefined) {
        generate_data.tool_choice = structuredClone(toolChoice);
    }

    if (replaceTools && Array.isArray(tools) && tools.length === 0) {
        delete generate_data.tools;
        if (toolChoice === null || toolChoice === undefined) {
            delete generate_data.tool_choice;
        }
    }

    // Empty array will produce a validation error
    if (!Array.isArray(generate_data.stop) || !generate_data.stop.length) {
        delete generate_data.stop;
    }

    if (settings.base_url && proxySupportedSources.includes(settings.chat_completion_source)) {
        generate_data.base_url = settings.base_url;
    }

    if (settings.reverse_proxy && proxySupportedSources.includes(settings.chat_completion_source)) {
        await validateReverseProxy();
        generate_data.reverse_proxy = settings.reverse_proxy;
        generate_data.proxy_password = settings.proxy_password;
    }

    // Add logprobs request (max 5 per OpenAI docs)
    const useLogprobs = !!power_user.request_token_probabilities;
    if (useLogprobs && logprobsSupportedSources.includes(settings.chat_completion_source)) {
        generate_data.logprobs = 5;
    }

    // Remove logit bias/logprobs/stop-strings if not supported by the model
    const isVision = (m) => ['gpt', 'vision'].every(x => typeof m === 'string' && m.includes(x));
    if (gptSources.includes(settings.chat_completion_source) && isVision(model)) {
        delete generate_data.logit_bias;
        delete generate_data.stop;
        delete generate_data.logprobs;
    }
    if (gptSources.includes(settings.chat_completion_source) && /gpt-4.5/.test(model)) {
        delete generate_data.logprobs;
    }

    if (settings.chat_completion_source === chat_completion_sources.CLAUDE) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.use_sysprompt = settings.use_sysprompt;
        generate_data.stop = getCustomStoppingStrings(); // Claude shouldn't have limits on stop strings.
        // Don't add a prefill on quiet gens (summarization) and when using continue prefill.
        if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) {
            generate_data.assistant_prefill = type === 'impersonate'
                ? substituteParams(settings.assistant_impersonation)
                : substituteParams(settings.assistant_prefill);
        }
        generate_data.claude_enable_system_prompt_cache = Boolean(settings.claude_enable_system_prompt_cache);
        generate_data.claude_extended_ttl = Boolean(settings.claude_extended_ttl);
        generate_data.claude_caching_at_depth = Number.isInteger(Number(settings.claude_caching_at_depth))
            ? Number(settings.claude_caching_at_depth)
            : -1;
    }

    if (settings.chat_completion_source === chat_completion_sources.OPENROUTER) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
        generate_data.use_fallback = settings.openrouter_use_fallback;
        generate_data.provider = settings.openrouter_providers;
        generate_data.quantizations = settings.openrouter_quantizations;
        generate_data.allow_fallbacks = settings.openrouter_allow_fallbacks;
        generate_data.middleout = settings.openrouter_middleout;
        generate_data.claude_enable_system_prompt_cache = Boolean(settings.claude_enable_system_prompt_cache);
        generate_data.claude_extended_ttl = Boolean(settings.claude_extended_ttl);
        generate_data.claude_caching_at_depth = Number.isInteger(Number(settings.claude_caching_at_depth))
            ? Number(settings.claude_caching_at_depth)
            : -1;
        generate_data.gemini_enable_system_prompt_cache = Boolean(settings.gemini_enable_system_prompt_cache);
    }

    if (settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        generate_data.nanogpt_provider = settings.nanogpt_provider;
        generate_data.nanogpt_payg_override = settings.nanogpt_payg_override;
        generate_data.claude_enable_system_prompt_cache = Boolean(settings.claude_enable_system_prompt_cache);
        generate_data.claude_extended_ttl = Boolean(settings.claude_extended_ttl);
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(settings.chat_completion_source)) {
        const stopStringsLimit = 5;
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.stop = getCustomStoppingStrings(stopStringsLimit).slice(0, stopStringsLimit).filter(x => x.length >= 1 && x.length <= 16);
        generate_data.use_sysprompt = settings.use_sysprompt;
        if (settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
            generate_data.vertexai_auth_mode = settings.vertexai_auth_mode;
            generate_data.vertexai_region = settings.vertexai_region;
            generate_data.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        generate_data.safe_prompt = false; // already defaults to false, but just incase they change that in the future.
        generate_data.stop = getCustomStoppingStrings(); // Mistral shouldn't have limits on stop strings.
    }

    if (settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        generate_data.custom_url = settings.custom_url;
    }

    if ([chat_completion_sources.CUSTOM, chat_completion_sources.DEEPSEEK, chat_completion_sources.CLAUDE].includes(settings.chat_completion_source)) {
        generate_data.custom_include_body = settings.custom_include_body;
        generate_data.custom_exclude_body = settings.custom_exclude_body;
        generate_data.custom_include_headers = settings.custom_include_headers;
    }

    if (settings.chat_completion_source === chat_completion_sources.COHERE) {
        // Clamp to 0.01 -> 0.99
        generate_data.top_p = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
        generate_data.top_k = Number(settings.top_k_openai);
        // Clamp to 0 -> 1
        generate_data.frequency_penalty = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
        generate_data.presence_penalty = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
        generate_data.stop = getCustomStoppingStrings(5);
    }

    if (settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.frequency_penalty = Number(settings.freq_pen_openai);
        generate_data.presence_penalty = Number(settings.pres_pen_openai);
        delete generate_data.stop;
    }

    // https://console.groq.com/docs/openai
    if (settings.chat_completion_source === chat_completion_sources.GROQ) {
        delete generate_data.logprobs;
        delete generate_data.logit_bias;
        delete generate_data.top_logprobs;
        delete generate_data.n;
    }

    // https://api-docs.deepseek.com/api/create-chat-completion
    if (settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
        generate_data.top_p = generate_data.top_p || Number.EPSILON;
    }

    if (settings.chat_completion_source === chat_completion_sources.XAI) {
        if (model.includes('grok-3-mini')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;
            delete generate_data.stop;
        } else {
            // As of 2025/09/21, only grok-3-mini accepts reasoning_effort
            delete generate_data.reasoning_effort;
        }

        if (model.includes('grok-4') || model.includes('grok-code')) {
            delete generate_data.presence_penalty;
            delete generate_data.frequency_penalty;

            // grok-4-fast-non-reasoning accepts stop
            if (!model.includes('grok-4-fast-non-reasoning')) {
                delete generate_data.stop;
            }
        }
    }

    // https://docs.electronhub.ai/api-reference/chat/completions
    if (settings.chat_completion_source === chat_completion_sources.ELECTRONHUB) {
        generate_data.top_k = Number(settings.top_k_openai);
    }

    if (settings.chat_completion_source === chat_completion_sources.CHUTES) {
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.stop = getCustomStoppingStrings();
    }

    // https://docs.z.ai/api-reference/llm/chat-completion
    if (settings.chat_completion_source === chat_completion_sources.ZAI) {
        generate_data.top_p = generate_data.top_p || 0.01;
        generate_data.stop = getCustomStoppingStrings(1);
        generate_data.zai_endpoint = settings.zai_endpoint || ZAI_ENDPOINT.COMMON;
        delete generate_data.presence_penalty;
        delete generate_data.frequency_penalty;
    }

    if (settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        generate_data.siliconflow_endpoint = settings.siliconflow_endpoint || SILICONFLOW_ENDPOINT.GLOBAL;
    }

    // https://platform.moonshot.ai/docs/api/chat#public-service-address
    if (settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        // Kimi K2.5 uses constrained parameters and rejects some OpenAI-style controls.
        if (/kimi-k2.5/.test(model)) {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        generate_data.minimax_endpoint = settings.minimax_endpoint || MINIMAX_ENDPOINT.GLOBAL;
        // MiniMax requires temperature in (0.0, 1.0]; zero is rejected.
        if (Number.isFinite(generate_data.temperature)) {
            generate_data.temperature = clamp(generate_data.temperature, Number.EPSILON, 1.0);
        }
    }

    if (settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        generate_data.workers_ai_account_id = settings.workers_ai_account_id;
        generate_data.top_k = settings.top_k_openai > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.seed = settings.seed >= 1 ? Number(settings.seed) : undefined;
        generate_data.top_p = Math.max(Number(settings.top_p_openai), 0.001);
        delete generate_data.n;
        delete generate_data.logit_bias;
    }

    // https://docs.nano-gpt.com/api-reference/endpoint/chat-completion#temperature-&-nucleus
    if (settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        generate_data.top_k = Number(settings.top_k_openai);
        generate_data.min_p = Number(settings.min_p_openai);
        generate_data.repetition_penalty = Number(settings.repetition_penalty_openai);
        generate_data.top_a = Number(settings.top_a_openai);
    }

    // https://platform.moonshot.ai/docs/api/chat#public-service-address
    if (settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        // >Kimi API is fully compatible with OpenAI's API format
        if (/kimi-k2.5/.test(model)) {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
        }
    }

    // https://platform.moonshot.ai/docs/api/chat#public-service-address
    if (settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        // >Kimi API is fully compatible with OpenAI's API format
        if (/kimi-k2.5/.test(model)) {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
        }
    }

    if (seedSupportedSources.includes(settings.chat_completion_source) && settings.seed >= 0) {
        generate_data.seed = settings.seed;
    }

    if ([chat_completion_sources.OPENAI, chat_completion_sources.AZURE_OPENAI].includes(settings.chat_completion_source) && /^(o1|o3|o4)/.test(model) ||
        (chat_completion_sources.OPENROUTER === settings.chat_completion_source && /^openai\/(o1|o3|o4)/.test(model))) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        delete generate_data.stop;
        delete generate_data.logit_bias;
        delete generate_data.temperature;
        delete generate_data.top_p;
        delete generate_data.frequency_penalty;
        delete generate_data.presence_penalty;
        if (/^(openai\/)?(o1)/.test(model)) {
            generate_data.messages.forEach((msg) => {
                if (msg.role === 'system') {
                    msg.role = 'user';
                }
            });
            delete generate_data.n;
            delete generate_data.tools;
            delete generate_data.tool_choice;
        }
    }

    if (gptSources.includes(settings.chat_completion_source) && /gpt-5/.test(model)) {
        generate_data.max_completion_tokens = generate_data.max_tokens;
        delete generate_data.max_tokens;
        delete generate_data.logprobs;
        delete generate_data.top_logprobs;
        if (/gpt-5-chat-latest/.test(model)) {
            delete generate_data.tools;
            delete generate_data.tool_choice;
        } else if (/gpt-5\.(1|2|3|4)/.test(model) && !/chat-latest/.test(model) && !generate_data.reasoning_effort) {
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        } else {
            delete generate_data.temperature;
            delete generate_data.top_p;
            delete generate_data.frequency_penalty;
            delete generate_data.presence_penalty;
            delete generate_data.logit_bias;
            delete generate_data.stop;
        }
    }

    if (jsonSchema) {
        generate_data.json_schema = jsonSchema;
    }

    return { generate_data, stream, canMultiSwipe };
}

function getPlainTextFunctionCallRetryConfig(settings = null) {
    settings = settings ?? oai_settings;
    let maxAttempts = Number(settings.function_calling_plain_text_error_retry_max_attempts);
    if (!Number.isFinite(maxAttempts)) {
        maxAttempts = Number(default_settings.function_calling_plain_text_error_retry_max_attempts);
    }
    maxAttempts = Math.min(Math.max(Math.round(maxAttempts || 0), 1), 10);

    return {
        enabled: Boolean(settings.function_calling_plain_text_error_retry),
        maxAttempts,
    };
}

function inspectPlainTextFunctionCallResponse(responseData, runtimeFunctionCallContext = null) {
    const triggerSignal = String(runtimeFunctionCallContext?.triggerSignal || '').trim();
    const triggerRequired = Boolean(triggerSignal);
    const assistantTextRaw = getResponseMessageContent(responseData);
    const assistantTextDisplay = extractDisplayTextFromPlainTextFunctionResponse(
        assistantTextRaw,
        { triggerSignal },
    );
    const hasTrigger = triggerRequired
        && findLastTriggerSignalOutsideThought(assistantTextRaw, triggerSignal) >= 0;

    let parsedCalls = [];
    let error = null;
    try {
        parsedCalls = extractAllFunctionCallsFromText(responseData, null, {
            triggerSignal,
            triggerRequired,
        });
        const validationError = validateParsedToolCalls(parsedCalls, runtimeFunctionCallContext?.tools);
        if (validationError) {
            throw new Error(validationError);
        }
    } catch (reason) {
        error = reason instanceof Error ? reason : new Error(String(reason));
    }

    const diagnostic = error
        ? diagnosePlainTextFunctionCallError(assistantTextRaw, {
            triggerSignal,
            triggerRequired,
        })
        : '';
    const errorDetails = error
        ? (error.message === 'Model text output did not contain parseable function-call XML.'
            ? diagnostic || error.message
            : error.message || diagnostic || t`Unknown error`)
        : '';

    return {
        assistantTextRaw,
        assistantTextDisplay,
        parsedCalls,
        error,
        errorDetails,
        hasTrigger,
    };
}

function applyParsedPlainTextToolCallsToResponse(responseData, inspection) {
    const firstChoice = Array.isArray(responseData?.choices) ? responseData.choices[0] : null;
    if (!firstChoice || typeof firstChoice !== 'object') {
        return responseData;
    }

    if (!firstChoice.message || typeof firstChoice.message !== 'object') {
        firstChoice.message = { role: 'assistant', content: '' };
    }

    firstChoice.message.tool_calls = inspection.parsedCalls.map((call) => ({
        id: String(call?.id || `call_${uuidv4().replaceAll('-', '')}`),
        type: 'function',
        function: {
            name: String(call?.name || ''),
            arguments: JSON.stringify(call?.args ?? {}),
        },
    }));
    firstChoice.message.content = inspection.assistantTextDisplay;
    return responseData;
}

async function postChatCompletionGenerateRequest(requestBody, signal, { quietErrors = false, apiPresetName = '' } = {}) {
    const maxRetries = getMaxRequestRetries(apiPresetName);

    const response = await withRetry(async () => {
        return await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            body: JSON.stringify(unescapeMacroBracesInRequestData(requestBody)),
            headers: getRequestHeaders(),
            signal,
        });
    }, {
        maxRetries,
        signal,
        label: 'chat-completion',
        onAttempt: (attempt) => {
            if (quietErrors) return;
            toastr.info(
                t`Retrying request… (${attempt}/${maxRetries})`,
                t`Request failed`,
                { timeOut: 3000 },
            );
        },
    });

    if (!response.ok) {
        const responseBody = await response.text();
        tryParseStreamingError(response, responseBody, { quiet: quietErrors });
        console.error(`[openai] ${response.status} from ${response.url}`, {
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            body: responseBody.substring(0, 500),
        });
        throw new Error(`Got response status ${response.status} from ${response.url}: ${responseBody.substring(0, 200)}`);
    }

    return response;
}

async function attemptPlainTextFunctionCallRetry({
    initialResponseData,
    type,
    requestMessages,
    requestSettings,
    runtimeFunctionCallContext,
    model,
    signal,
    jsonSchema = null,
    responseLength = null,
    requestSecretId = '',
    apiPresetName = '',
} = {}) {
    let currentResponseData = initialResponseData;
    let currentInspection = inspectPlainTextFunctionCallResponse(initialResponseData, runtimeFunctionCallContext);
    const retryConfig = getPlainTextFunctionCallRetryConfig(requestSettings);
    const requiresToolCall = Boolean(runtimeFunctionCallContext?.requiresToolCall);

    if (!retryConfig.enabled || !currentInspection.error || (!currentInspection.hasTrigger && !requiresToolCall) || retryConfig.maxAttempts <= 1) {
        return { responseData: currentResponseData, inspection: currentInspection };
    }

    let currentMessages = structuredClone(Array.isArray(requestMessages) ? requestMessages : []);
    for (let attempt = 1; attempt < retryConfig.maxAttempts; attempt += 1) {
        const retryPrompt = buildFunctionCallRetryAddendum({
            rawResponse: currentInspection.assistantTextRaw,
            errorDetails: currentInspection.errorDetails,
            triggerSignal: runtimeFunctionCallContext?.triggerSignal,
            requiredFunctionName: runtimeFunctionCallContext?.requiredFunctionName,
            plainTextMode: true,
        });
        const retryMessages = currentMessages.concat([
            { role: 'assistant', content: currentInspection.assistantTextRaw },
            { role: 'user', content: retryPrompt },
        ]);

        console.info(`[openai] Plain-text function call parsing failed, attempting retry ${attempt + 1}/${retryConfig.maxAttempts}`);

        try {
            const retrySettings = {
                ...requestSettings,
                stream_openai: false,
                n: 1,
            };
            const { generate_data } = await createGenerationParameters(retrySettings, model, type, retryMessages, {
                jsonSchema,
                tools: [],
                toolChoice: 'auto',
                replaceTools: true,
                responseLength,
            });
            let requestBody = structuredClone(generate_data);
            if (requestSecretId) {
                requestBody.secret_id = requestSecretId;
            }

            const retryResponse = await postChatCompletionGenerateRequest(requestBody, signal, { quietErrors: true, apiPresetName });
            const retryData = await retryResponse.json();
            checkQuotaError(retryData, { quiet: true });
            checkModerationError(retryData, { quiet: true });

            if (retryData.error) {
                console.warn('[openai] Plain-text function-call retry returned an error response', retryData.error);
                return { responseData: currentResponseData, inspection: currentInspection };
            }

            currentResponseData = retryData;
            currentInspection = inspectPlainTextFunctionCallResponse(retryData, runtimeFunctionCallContext);
            currentMessages = retryMessages;

            if (!currentInspection.error || (!currentInspection.hasTrigger && !requiresToolCall)) {
                return { responseData: currentResponseData, inspection: currentInspection };
            }
        } catch (error) {
            console.warn('[openai] Plain-text function-call retry request failed', error);
            return { responseData: currentResponseData, inspection: currentInspection };
        }
    }

    return { responseData: currentResponseData, inspection: currentInspection };
}

/**
 * Send a chat completion request to backend
 * @param {string} type Request type (impersonate, quiet, continue, etc)
 * @param {ChatCompletionMessage[]} messages Array of chat completion messages
 * @param {AbortSignal?} signal Abort signal for request cancellation
 * @param {import('../script.js').AdditionalRequestOptions} options Additional request options
 * @returns {Promise<unknown>}
 * @throws {Error}
 */
async function sendOpenAIRequest(type, messages, signal, {
    jsonSchema = null,
    tools = null,
    toolChoice = null,
    replaceTools = false,
    responseLength = null,
    llmPresetName = '',
    apiPresetName = '',
    apiSettingsOverride = null,
    requestScope = 'chat',
    functionCallMode = 'auto',
    functionCallOptions = null,
    allowStreamingForQuiet = false,
} = {}) {
    // Provide default abort signal
    if (!signal) {
        signal = new AbortController().signal;
    }

    setLastUsage(null);

    // RPM throttle gate. When apiPresetName is provided (typical for
    // generateTask callers), look the named profile up so plugin requests
    // get throttled against their own profile's bucket rather than the
    // main-chat profile's. Falls back to selectedProfile otherwise.
    // Skipped when no profile is resolved or rpm-limit is unset/zero.
    const cmSettings = extension_settings?.connectionManager;
    const cmProfiles = cmSettings?.profiles;
    let throttleProfile = null;
    if (Array.isArray(cmProfiles) && cmProfiles.length > 0) {
        const trimmedName = String(apiPresetName || '').trim();
        if (trimmedName) {
            throttleProfile = cmProfiles.find(p => p?.name === trimmedName) || null;
        }
        if (!throttleProfile) {
            const activeProfileId = cmSettings?.selectedProfile;
            if (activeProfileId) {
                throttleProfile = cmProfiles.find(p => p.id === activeProfileId) || null;
            }
        }
    }
    if (throttleProfile) {
        const activeRpm = Number(throttleProfile['rpm-limit']) || 0;
        if (activeRpm > 0) {
            await acquireRequestSlot(throttleProfile.id, activeRpm, {
                signal,
                label: throttleProfile.name || throttleProfile.id,
            });
        }
    }

    const requestSettings = getSettingsForRequest({ llmPresetName, apiPresetName, apiSettingsOverride });
    const resolvedFunctionCallMode = resolveFunctionCallMode({
        requestedMode: functionCallMode,
        plainTextEnabled: Boolean(requestSettings?.function_calling_plain_text),
    });
    const usePromptXmlFunctionCalls =
        resolvedFunctionCallMode === 'prompt_xml'
        || resolvedFunctionCallMode === 'prompt_json';
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const normalizedToolChoice = toolChoice ?? 'auto';
    const modeOptions = functionCallOptions && typeof functionCallOptions === 'object' ? functionCallOptions : {};
    let requestMessages = Array.isArray(messages)
        ? messages.map(message => ({ ...message }))
        : messages;
    let effectiveTools = tools;
    let effectiveToolChoice = toolChoice;
    let effectiveReplaceTools = replaceTools;
    let runtimeFunctionCallContext = null;

    if (usePromptXmlFunctionCalls && normalizedTools.length > 0) {
        const triggerSignal = String(modeOptions.triggerSignal || generateRandomTriggerSignal()).trim();
        if (Array.isArray(requestMessages)) {
            requestMessages = normalizeToolMessagesForPlainTextFunctionCalling(requestMessages, { triggerSignal });
        }

        const protocolStyle = modeOptions.protocolStyle === TOOL_PROTOCOL_STYLE.TABLE
            ? TOOL_PROTOCOL_STYLE.TABLE
            : TOOL_PROTOCOL_STYLE.JSON_SCHEMA;
        const requiredFunctionName = String(
            modeOptions.requiredFunctionName
            || normalizedToolChoice?.function?.name
            || normalizedToolChoice?.name
            || '',
        ).trim();
        const requiresToolCall = isToolCallMandatory({
            toolChoice: normalizedToolChoice,
            requiredFunctionName,
        });

        requestMessages = mergeSystemAddendumIntoPromptMessages(
            requestMessages,
            buildPlainTextToolProtocolMessage(normalizedTools, {
                requiredFunctionName,
                style: protocolStyle,
                triggerSignal,
                toolChoice: normalizedToolChoice,
            }),
        );

        effectiveTools = [];
        effectiveToolChoice = 'auto';
        effectiveReplaceTools = true;
        runtimeFunctionCallContext = {
            triggerSignal,
            tools: normalizedTools,
            requiredFunctionName,
            requiresToolCall,
        };
    }

    const model = getChatCompletionModel(requestSettings);
    const { generate_data, stream, canMultiSwipe } = await createGenerationParameters(requestSettings, model, type, requestMessages, {
        jsonSchema,
        tools: effectiveTools,
        toolChoice: effectiveToolChoice,
        replaceTools: effectiveReplaceTools,
        responseLength,
        allowStreamingForQuiet,
    });
    const shouldRunChatCompletionHooks = requestScope !== 'extension_internal';
    if (shouldRunChatCompletionHooks) {
        await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data);
    }

    let requestBody = structuredClone(generate_data);
    const requestSecretId = String(
        apiSettingsOverride?.secret_id
        || apiSettingsOverride?.['secret-id']
        || apiSettingsOverride?.secretId
        || '',
    ).trim();
    if (requestSecretId) {
        requestBody.secret_id = requestSecretId;
    }
    const shouldTrackLukerGenerationState = shouldUseLukerServerPersistence(type, requestSettings.chat_completion_source);
    if (shouldTrackLukerGenerationState) {
        lastOpenAIReplyPersistedByServer = false;
        lastOpenAIGenerationId = '';
        const persistTarget = buildLukerPersistTarget();
        if (persistTarget) {
            const generationId = uuidv4();
            requestBody = {
                ...requestBody,
                luker_generation: {
                    job_id: generationId,
                    persist_target: persistTarget,
                },
            };
            lastOpenAIGenerationId = generationId;
            logOpenAILukerPersistenceDebug('request_init', {
                type,
                generation_id: generationId,
                persist_target: summarizeLukerPersistTargetForDebug(persistTarget),
            });
        }
    }
    const response = await postChatCompletionGenerateRequest(requestBody, signal, { apiPresetName });
    const generationIdHeader = response.headers.get('x-luker-generation-id');
    if (shouldTrackLukerGenerationState && generationIdHeader) {
        lastOpenAIGenerationId = generationIdHeader;
        logOpenAILukerPersistenceDebug('response_header_meta', {
            generation_id: generationIdHeader,
        });
    }

    if (stream) {
        const eventStream = getEventSourceStream();
        response.body.pipeThrough(eventStream);
        const reader = eventStream.readable.getReader();
        return async function* streamData() {
            let text = '';
            const swipes = [];
            const toolCalls = [];
            const state = { reasoning: '', images: [], signature: '', toolSignatures: {}, usage: null };
            const plainTextToolCallDetector = runtimeFunctionCallContext
                ? new PlainTextFunctionCallStreamDetector({ triggerSignal: runtimeFunctionCallContext.triggerSignal })
                : null;
            let plainTextToolCallFinalized = false;
            const finalizePlainTextToolCalls = async () => {
                if (!plainTextToolCallDetector || plainTextToolCallFinalized) {
                    return false;
                }

                plainTextToolCallFinalized = true;
                const finalState = plainTextToolCallDetector.finalize();
                const requiresToolCall = Boolean(runtimeFunctionCallContext?.requiresToolCall);
                let changed = false;

                if (finalState.displayDelta) {
                    text += finalState.displayDelta;
                    changed = true;
                }

                if (finalState.detected || requiresToolCall) {
                    try {
                        const retryOutcome = await attemptPlainTextFunctionCallRetry({
                            initialResponseData: finalState.rawText,
                            type,
                            requestMessages,
                            requestSettings,
                            runtimeFunctionCallContext,
                            model,
                            signal,
                            jsonSchema,
                            responseLength,
                            requestSecretId,
                            apiPresetName,
                        });
                        const inspection = retryOutcome.inspection;
                        if (inspection.error) {
                            throw inspection.error;
                        }

                        text = inspection.assistantTextDisplay;
                        toolCalls[0] = inspection.parsedCalls.map((call) => ({
                            id: String(call?.id || `call_${uuidv4().replaceAll('-', '')}`),
                            type: 'function',
                            function: {
                                name: String(call?.name || ''),
                                arguments: JSON.stringify(call?.args ?? {}),
                            },
                        }));
                        changed = true;
                    } catch (error) {
                        console.warn('[openai] Failed to parse plain-text function calls from streaming response', error);
                        if (requiresToolCall) {
                            throw error;
                        }
                        if (finalState.hiddenText) {
                            text += finalState.hiddenText;
                            changed = true;
                        }
                    }
                }

                return changed;
            };
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (await finalizePlainTextToolCalls()) {
                        yield { text, swipes: swipes, logprobs: null, toolCalls: toolCalls, state: state };
                    }
                    setLastUsage(state.usage);
                    return;
                }
                const rawData = value.data;
                if (rawData === '[DONE]') {
                    if (await finalizePlainTextToolCalls()) {
                        yield { text, swipes: swipes, logprobs: null, toolCalls: toolCalls, state: state };
                    }
                    continue;
                }
                tryParseStreamingError(response, rawData);
                const parsed = JSON.parse(rawData);
                if (parsed?.luker && typeof parsed.luker === 'object') {
                    if (shouldTrackLukerGenerationState) {
                        const logPayload = {};
                        if (typeof parsed.luker.generation_id === 'string' && parsed.luker.generation_id) {
                            lastOpenAIGenerationId = parsed.luker.generation_id;
                            logPayload.generation_id = parsed.luker.generation_id;
                        }
                        if (typeof parsed.luker.persisted === 'boolean') {
                            lastOpenAIReplyPersistedByServer = parsed.luker.persisted;
                            logPayload.persisted = parsed.luker.persisted;
                        }
                        if (Object.keys(logPayload).length > 0) {
                            logOpenAILukerPersistenceDebug('stream_meta', logPayload);
                        }
                    }
                    continue;
                }

                if (canMultiSwipe && Array.isArray(parsed?.choices) && parsed?.choices?.[0]?.index > 0) {
                    const swipeIndex = parsed.choices[0].index - 1;
                    // FIXME: state.reasoning should be an array to support multi-swipe
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + getStreamingReply(parsed, state, { chatCompletionSource: requestSettings.chat_completion_source, overrideShowThoughts: false });
                } else {
                    const replyDelta = getStreamingReply(parsed, state, { chatCompletionSource: requestSettings.chat_completion_source });
                    if (plainTextToolCallDetector) {
                        const processed = plainTextToolCallDetector.processTextDelta(replyDelta);
                        text += processed.displayDelta;
                    } else {
                        text += replyDelta;
                    }
                }

                ToolManager.parseToolCalls(toolCalls, parsed, state.toolSignatures, { force: normalizedTools.length > 0 });

                const usageDelta = extractStreamingUsage(parsed, requestSettings.chat_completion_source);
                if (usageDelta) {
                    state.usage = mergeStreamingUsage(state.usage, usageDelta);
                }

                yield { text, swipes: swipes, logprobs: parseChatCompletionLogprobs(parsed), toolCalls: toolCalls, state: state };
            }
        };
    } else {
        if (shouldTrackLukerGenerationState) {
            lastOpenAIReplyPersistedByServer = response.headers.get('x-luker-server-persisted') === '1';
            logOpenAILukerPersistenceDebug('response_header_meta', {
                generation_id: generationIdHeader || lastOpenAIGenerationId || '',
                persisted: lastOpenAIReplyPersistedByServer,
            });
        }
        let data = await response.json();

        checkQuotaError(data);
        checkModerationError(data);

        if (data.error) {
            const message = data.error.message || response.statusText || t`Unknown error`;
            toastr.error(message, t`API returned an error`);
            throw new Error(message);
        }

        if (runtimeFunctionCallContext) {
            const retryOutcome = await attemptPlainTextFunctionCallRetry({
                initialResponseData: data,
                type,
                requestMessages,
                requestSettings,
                runtimeFunctionCallContext,
                model,
                signal,
                jsonSchema,
                responseLength,
                requestSecretId,
                apiPresetName,
            });
            data = retryOutcome.responseData;
            const inspection = retryOutcome.inspection;

            if (inspection.error && (inspection.hasTrigger || runtimeFunctionCallContext?.requiresToolCall)) {
                throw inspection.error;
            }

            applyParsedPlainTextToolCallsToResponse(data, inspection);
        }

        if (type !== 'quiet') {
            const logprobs = parseChatCompletionLogprobs(data);
            // Delay is required to allow the active message to be updated to
            // the one we are generating (happens right after sendOpenAIRequest)
            delay(1).then(() => saveLogprobsForActiveMessage(logprobs, null));
        }

        setLastUsage(data?.usage);
        return data;
    }
}

/**
 * Extracts the reply from the response data from a chat completions-like source
 * @param {object} data Response data from the chat completions-like source
 * @param {object} state Additional state to keep track of
 * @param {object} [options] Additional options
 * @param {string?} [options.chatCompletionSource] Chat completion source
 * @param {boolean?} [options.overrideShowThoughts] Override show thoughts
 * @returns {string} The reply extracted from the response data
 */
export function getStreamingReply(data, state, { chatCompletionSource = null, overrideShowThoughts = null } = {}) {
    const chat_completion_source = chatCompletionSource ?? oai_settings.chat_completion_source;
    const show_thoughts = overrideShowThoughts ?? oai_settings.show_thoughts;

    if (chat_completion_source === chat_completion_sources.CLAUDE) {
        if (show_thoughts) {
            state.reasoning += data?.delta?.thinking || '';
        }
        return data?.delta?.text || '';
    } else if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(chat_completion_source)) {
        const inlineData = data?.candidates?.[0]?.content?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData) || [];
        if (Array.isArray(inlineData) && inlineData.length > 0) {
            state.images.push(...inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning += (data?.candidates?.[0]?.content?.parts?.filter(x => x.thought)?.map(x => x.text)?.[0] || '');
        }
        // Extract thought signatures from streaming chunks (typically in final chunk)
        const parts = data?.candidates?.[0]?.content?.parts || [];
        parts.forEach((part) => {
            if (part.thoughtSignature && typeof part.text === 'string') {
                state.signature = part.thoughtSignature;
            }
        });
        return data?.candidates?.[0]?.content?.parts?.filter(x => !x.thought)?.map(x => x.text)?.[0] || '';
    } else if (chat_completion_source === chat_completion_sources.COHERE) {
        return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
    } else if (chat_completion_source === chat_completion_sources.DEEPSEEK) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.XAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chat_completion_source === chat_completion_sources.OPENROUTER) {
        const imageUrls = data?.choices?.[0]?.delta?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url) || [];
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            state.images.push(...imageUrls.filter(isDataURL));
        }
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning ??
                data.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content ??
                '';
        }
        // Extract thought signatures from OpenRouter streaming.
        const reasoningDetails = [
            ...(data?.choices?.[0]?.delta?.reasoning_details || []),
            ...(data?.choices?.[0]?.message?.reasoning_details || []),
        ];
        reasoningDetails.forEach((detail) => {
            if (detail.type === 'reasoning.encrypted' && detail.data) {
                const isToolLikeId = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id);
                if (typeof detail.id === 'string' && detail.id.length > 0) {
                    state.toolSignatures[detail.id] = detail.data;
                }
                if (!isToolLikeId) {
                    state.signature = detail.data;
                }
            }
        });
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if ([chat_completion_sources.CUSTOM, chat_completion_sources.POLLINATIONS, chat_completion_sources.AIMLAPI, chat_completion_sources.MOONSHOT, chat_completion_sources.COMETAPI, chat_completion_sources.ELECTRONHUB, chat_completion_sources.NANOGPT, chat_completion_sources.ZAI, chat_completion_sources.SILICONFLOW, chat_completion_sources.CHUTES, chat_completion_sources.WORKERS_AI].includes(chat_completion_source)) {
        if (show_thoughts) {
            state.reasoning +=
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                '';
        }
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if (chat_completion_source === chat_completion_sources.MISTRALAI) {
        if (show_thoughts) {
            state.reasoning += (data.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '');
        }
        const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
        return Array.isArray(content) ? content.map(x => x.text).filter(x => x).join('') : content;
    } else {
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    }
}

/**
 * parseChatCompletionLogprobs converts the response data returned from a chat
 * completions-like source into an array of TokenLogprobs found in the response.
 * @param {Object} data - response data from a chat completions-like source
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseChatCompletionLogprobs(data) {
    if (!data) {
        return null;
    }

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.AIMLAPI:
            return Object.keys(data?.choices?.[0]?.logprobs ?? {}).includes('content')
                ? parseOpenAIChatLogprobs(data.choices[0]?.logprobs)
                : parseOpenAITextLogprobs(data.choices[0]?.logprobs);
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.AZURE_OPENAI:
        case chat_completion_sources.DEEPSEEK:
        case chat_completion_sources.XAI:
        case chat_completion_sources.CUSTOM:
        case chat_completion_sources.CHUTES:
            if (!data.choices?.length) {
                return null;
            }
            // OpenAI Text Completion API is treated as a chat completion source
            // by SillyTavern, hence its presence in this function.
            return textCompletionModels.includes(getChatCompletionModel())
                ? parseOpenAITextLogprobs(data.choices[0]?.logprobs)
                : parseOpenAIChatLogprobs(data.choices[0]?.logprobs);
        default:
        // implement other chat completion sources here
    }
    return null;
}

/**
 * parseOpenAIChatLogprobs receives a `logprobs` response from OpenAI's chat
 * completion API and converts into the structure used by the Token Probabilities
 * view.
 * @param {{content: { token: string, logprob: number, top_logprobs: { token: string, logprob: number }[] }[]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseOpenAIChatLogprobs(logprobs) {
    const { content } = logprobs ?? {};

    if (!Array.isArray(content)) {
        return null;
    }

    /** @type {(x: { token: string, logprob: number }) => [string, number]} */
    const toTuple = (x) => [x.token, x.logprob];

    return content.map(({ token, logprob, top_logprobs = [] }) => {
        // Add the chosen token to top_logprobs if it's not already there, then
        // convert to a list of [token, logprob] pairs
        const chosenTopToken = top_logprobs.some((top) => token === top.token);
        /** @type {import('./logprobs.js').Candidate[]} */
        const topLogprobs = chosenTopToken
            ? top_logprobs.map(toTuple)
            : [...top_logprobs.map(toTuple), [token, logprob]];
        return { token, topLogprobs };
    });
}

/**
 * parseOpenAITextLogprobs receives a `logprobs` response from OpenAI's text
 * completion API and converts into the structure used by the Token Probabilities
 * view.
 * @param {{tokens: string[], token_logprobs: number[], top_logprobs: { token: string, logprob: number }[][]}} logprobs
 * @returns {import('./logprobs.js').TokenLogprobs[] | null} converted logprobs
 */
function parseOpenAITextLogprobs(logprobs) {
    const { tokens, token_logprobs, top_logprobs } = logprobs ?? {};

    if (!Array.isArray(tokens)) {
        return null;
    }

    return tokens.map((token, i) => {
        // Add the chosen token to top_logprobs if it's not already there, then
        // convert to a list of [token, logprob] pairs
        /** @type {any[]} */
        const topLogprobs = top_logprobs[i] ? Object.entries(top_logprobs[i]) : [];
        const chosenTopToken = topLogprobs.some(([topToken]) => token === topToken);
        if (!chosenTopToken) {
            topLogprobs.push([token, token_logprobs[i]]);
        }
        return { token, topLogprobs };
    });
}

async function calculateLogitBias() {
    const body = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected]);
    let result = {};

    try {
        const reply = await fetch(`/api/backends/chat-completions/bias?model=${getTokenizerModel()}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
        });

        result = await reply.json();
    } catch (err) {
        result = {};
        console.error(err);
    }
    return result;
}

class TokenHandler {
    /**
     * @param {(messages: object[] | object, full?: boolean) => Promise<number>} countTokenAsyncFn Function to count tokens
     * @param {(messages: object[] | object, full?: boolean) => Promise<number[]>} [countTokenItemsAsyncFn] Function to count tokens per item
     */
    constructor(countTokenAsyncFn, countTokenItemsAsyncFn = async (messages, full) => {
        const normalizedMessages = Array.isArray(messages) ? messages : [messages];
        return Promise.all(normalizedMessages.map(message => countTokenAsyncFn(message, full)));
    }) {
        this.countTokenAsyncFn = countTokenAsyncFn;
        this.countTokenItemsAsyncFn = countTokenItemsAsyncFn;
        this.counts = {
            'start_chat': 0,
            'prompt': 0,
            'bias': 0,
            'nudge': 0,
            'jailbreak': 0,
            'impersonate': 0,
            'examples': 0,
            'conversation': 0,
        };
    }

    getCounts() {
        return this.counts;
    }

    resetCounts() {
        Object.keys(this.counts).forEach((key) => this.counts[key] = 0);
    }

    setCounts(counts) {
        this.counts = counts;
    }

    uncount(value, type) {
        this.counts[type] -= value;
    }

    /**
     * Count tokens for a message or messages.
     * @param {object|any[]} messages Messages to count tokens for
     * @param {boolean} [full] Count full tokens
     * @param {string} [type] Identifier for the token count
     * @returns {Promise<number>} The token count
     */
    async countAsync(messages, full, type) {
        const token_count = await this.countTokenAsyncFn(messages, full);
        if (type && Object.hasOwn(this.counts, type)) {
            this.counts[type] += token_count;
        }

        return token_count;
    }

    /**
     * Count tokens for many items and return the individual counts.
     * @param {object[]|object} messages Messages to count tokens for
     * @param {boolean} [full] Count full tokens
     * @param {string} [type] Identifier for the token count
     * @returns {Promise<number[]>} The token counts
     */
    async countManyAsync(messages, full, type) {
        const token_counts = await this.countTokenItemsAsyncFn(messages, full);

        if (type && Object.hasOwn(this.counts, type)) {
            this.counts[type] += token_counts.reduce((total, count) => total + count, 0);
        }

        return token_counts;
    }

    getTokensForIdentifier(identifier) {
        return this.counts[identifier] ?? 0;
    }

    getTotal() {
        return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
    }

    log() {
        console.table({ ...this.counts, 'total': this.getTotal() });
    }
}


const tokenHandler = new TokenHandler(countTokensOpenAIAsync, countTokensOpenAIItemsAsync);

// Thrown by ChatCompletion when a requested prompt couldn't be found.
class IdentifierNotFoundError extends Error {
    constructor(identifier) {
        super(`Identifier ${identifier} not found.`);
        this.name = 'IdentifierNotFoundError';
    }
}

// Thrown by ChatCompletion when the token budget is unexpectedly exceeded
class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

// Thrown when a character name is invalid
class InvalidCharacterNameError extends Error {
    constructor(identifier = '') {
        super(`Invalid character name. Message: ${identifier}`);
        this.name = 'InvalidCharacterName';
    }
}

/**
 * Used for creating, managing, and interacting with a specific message object.
 */
class Message {
    static tokensPerImage = 85;

    /** @type {number} */
    tokens;
    /** @type {string} */
    identifier;
    /** @type {string} */
    role;
    /** @type {string|any[]} */
    content;
    /** @type {string} */
    name;
    /** @type {object} */
    tool_call = null;
    /** @type {string?} */
    signature = null;
    /** @type {string?} */
    reasoning = null;

    /**
     * @constructor
     * @param {string} role - The role of the entity creating the message.
     * @param {string} content - The actual content of the message.
     * @param {string} identifier - A unique identifier for the message.
     * @private Don't use this constructor directly. Use createAsync instead.
     */
    constructor(role, content, identifier) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;

        if (!this.role) {
            console.log(`Message role not set, defaulting to 'system' for identifier '${this.identifier}'`);
            this.role = 'system';
        }

        this.tokens = 0;
    }

    /**
     * Create a new Message instance.
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @returns {Promise<Message>} Message instance
     */
    static async createAsync(role, content, identifier) {
        const message = new Message(role, content, identifier);
        await Message.countManyAsync([message]);
        return message;
    }

    /**
     * Create many Message instances and count them in a single batch.
     * @param {{ role: string, content: string|any[], identifier: string, name?: string, tool_calls?: object[], signature?: string|null }[]} definitions
     * @returns {Promise<Message[]>} Message instances
     */
    static async createManyAsync(definitions) {
        const messages = definitions.map(({ role, content, identifier, name, tool_calls, signature }) => {
            const message = new Message(role, content, identifier);
            message.name = name;
            message.tool_calls = tool_calls;
            message.signature = signature ?? null;
            return message;
        });

        await Message.countManyAsync(messages);
        return messages;
    }

    /**
     * Count many messages in a single batch.
     * @param {Message[]} messages
     * @returns {Promise<Message[]>} Counted messages
     */
    static async countManyAsync(messages) {
        const countableMessages = messages.filter(message => message.hasTokenCountPayload());
        if (countableMessages.length === 0) {
            return messages;
        }

        const tokenCounts = await tokenHandler.countManyAsync(
            countableMessages.map(message => message.toTokenCountPayload()),
        );

        for (let i = 0; i < countableMessages.length; i++) {
            countableMessages[i].tokens = tokenCounts[i];
        }

        return messages;
    }

    /**
     * Formats tool invocations into the payload expected by the OpenAI API.
     * @param {import('./tool-calling.js').ToolInvocation[]} invocations
     * @param {boolean} includeSignature
     * @returns {object[]} Tool call payloads
     */
    static formatToolCalls(invocations, includeSignature) {
        return invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
    }

    /**
     * Reconstruct the message from a tool invocation.
     * @param {import('./tool-calling.js').ToolInvocation[]} invocations - The tool invocations to reconstruct the message from.
     * @param {boolean} includeSignature Whether to include the signature in the tool calls.
     * @param {boolean} includeReasoning Whether to include plaintext reasoning fallback.
     * @returns {Promise<void>}
     */
    async setToolCalls(invocations, includeSignature, includeReasoning = false) {
        this.tool_calls = invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
        const fallbackReasoning = invocations.find(i => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await tokenHandler.countAsync({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    /**
     * Add a name to the message.
     * @param {string} name Name to set for the message.
     * @returns {Promise<void>}
     */
    async setName(name) {
        this.name = name;
        this.tokens = await tokenHandler.countAsync(this.toTokenCountPayload());
    }

    /**
     * Checks whether the message needs tokenizer work.
     * @returns {boolean} Whether tokenization is required.
     */
    hasTokenCountPayload() {
        return (typeof this.content === 'string' && this.content.length > 0)
            || Array.isArray(this.content)
            || Array.isArray(this.tool_calls)
            || Boolean(this.name);
    }

    /**
     * Builds the tokenizer payload for the current message state.
     * @returns {object} Tokenizer payload.
     */
    toTokenCountPayload() {
        return {
            role: this.role,
            ...(Array.isArray(this.tool_calls) ? { tool_calls: JSON.stringify(this.tool_calls) } : {}),
            ...(this.content !== undefined ? { content: this.content } : {}),
            ...(this.name ? { name: this.name } : {}),
            ...(this.signature ? { signature: this.signature } : {}),
        };
    }

    /**
     * Ensures the content is an array. If it's a string, converts it to an array with a single text object.
     * @returns {any[]} Content as an array
     */
    ensureContentIsArray() {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                this.content.push({ type: 'text', text: textContent });
            }
        }
        return this.content;
    }

    /**
     * Adds an image to the message.
     * @param {string} image Image URL or Data URL.
     * @returns {Promise<void>}
     */
    async addImage(image) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(image);
        if (!isDataUrl) {
            try {
                const response = await fetch(image, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch image');
                const blob = await response.blob();
                image = await getBase64Async(blob);
            } catch (error) {
                console.error('Image adding skipped', error);
                return;
            }
        }

        image = await this.compressImage(image);

        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'image_url', image_url: { 'url': image, 'detail': quality } });

        try {
            const tokens = await this.getImageTokenCost(image, quality);
            this.tokens += tokens;
        } catch (error) {
            this.tokens += Message.tokensPerImage;
            console.error('Failed to get image token cost', error);
        }
    }

    /**
     * Adds a video to the message.
     * @param {string} video Video URL or Data URL.
     * @returns {Promise<void>}
     */
    async addVideo(video) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(video);
        if (!isDataUrl) {
            try {
                const response = await fetch(video, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch video');
                const blob = await response.blob();
                video = await getBase64Async(blob);
            } catch (error) {
                console.error('Video adding skipped', error);
                return;
            }
        }

        // Note: No compression for videos (unlike images)
        const quality = oai_settings.inline_image_quality || default_settings.inline_image_quality;
        this.content.push({ type: 'video_url', video_url: { 'url': video, 'detail': quality } });

        try {
            // Using Gemini calculation (263 tokens per second)
            const duration = await getVideoDurationFromDataURL(video);
            this.tokens += 263 * Math.ceil(duration);
        } catch (error) {
            // Convservative estimate for video token cost without knowing duration
            this.tokens += 263 * 40; // ~40 second video (60 seconds max)
            console.error('Failed to get video token cost', error);
        }
    }

    /**
     * Adds a audio to the message.
     * @param {string} audio Audio URL or Data URL.
     * @returns {Promise<void>}
     */
    async addAudio(audio) {
        this.content = this.ensureContentIsArray();
        const isDataUrl = isDataURL(audio);
        if (!isDataUrl) {
            try {
                const response = await fetch(audio, { method: 'GET', cache: 'force-cache' });
                if (!response.ok) throw new Error('Failed to fetch audio');
                const blob = await response.blob();
                audio = await getBase64Async(blob);
            } catch (error) {
                console.error('Audio adding skipped', error);
                return;
            }
        }

        this.content.push({ type: 'audio_url', audio_url: { 'url': audio } });

        try {
            // Using Gemini calculation (32 tokens per second)
            const duration = await getAudioDurationFromDataURL(audio);
            this.tokens += 32 * Math.ceil(duration);
        } catch (error) {
            // Estimate for audio token cost without knowing duration
            const tokens = 32 * 300; // ~5 minute audio
            this.tokens += tokens;
            console.error('Failed to get audio token cost', error);
        }
    }

    /**
     * Compress an image if it exceeds the size threshold for the current chat completion source.
     * @param {string} image Data URL of the image.
     * @returns {Promise<string>} Compressed image as a Data URL.
     */
    async compressImage(image) {
        const compressImageSources = [
            chat_completion_sources.OPENROUTER,
            chat_completion_sources.MAKERSUITE,
            chat_completion_sources.MISTRALAI,
            chat_completion_sources.VERTEXAI,
        ];
        const sizeThreshold = 2 * 1024 * 1024;
        const dataSize = image.length * 0.75;
        const safeMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
        const mimeType = image?.split(';')?.[0]?.split(':')?.[1];
        if (compressImageSources.includes(oai_settings.chat_completion_source) && dataSize > sizeThreshold) {
            const maxSide = 2048;
            image = await createThumbnail(image, maxSide, maxSide);
        } else if (!safeMimeTypes.includes(mimeType)) {
            image = await createThumbnail(image, null, null);
        }
        return image;
    }

    /**
     * Get the token cost of an image.
     * @param {string} dataUrl Data URL of the image.
     * @param {string} quality String representing the quality of the image. Can be 'low', 'auto', or 'high'.
     * @returns {Promise<number>} The token cost of the image.
     */
    async getImageTokenCost(dataUrl, quality) {
        if (quality === 'low') {
            return Message.tokensPerImage;
        }

        const size = await getImageSizeFromDataURL(dataUrl);

        // If the image is small enough, we can use the low quality token cost
        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return Message.tokensPerImage;
        }

        /*
        * Images are first scaled to fit within a 2048 x 2048 square, maintaining their aspect ratio.
        * Then, they are scaled such that the shortest side of the image is 768px long.
        * Finally, we count how many 512px squares the image consists of.
        * Each of those squares costs 170 tokens. Another 85 tokens are always added to the final total.
        * https://platform.openai.com/docs/guides/vision/calculating-costs
        */

        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);

        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);

        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        const tokens = squares * 170 + 85;
        return tokens;
    }

    /**
     * Create a new Message instance from a prompt asynchronously.
     * @static
     * @param {Object} prompt - The prompt object.
     * @returns {Promise<Message>} A new instance of Message.
     */
    static fromPromptAsync(prompt) {
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier);
    }

    /**
     * Returns the number of tokens in the message.
     * @returns {number} Number of tokens in the message.
     */
    getTokens() { return this.tokens; }
}

/**
 * Used for creating, managing, and interacting with a collection of Message instances.
 *
 * @class MessageCollection
 */
class MessageCollection {
    collection = [];
    identifier;

    /**
     * @constructor
     * @param {string} identifier - A unique identifier for the MessageCollection.
     * @param {...Object} items - An array of Message or MessageCollection instances to be added to the collection.
     */
    constructor(identifier, ...items) {
        for (let item of items) {
            if (!(item instanceof Message || item instanceof MessageCollection)) {
                throw new Error('Only Message and MessageCollection instances can be added to MessageCollection');
            }
        }

        this.collection.push(...items);
        this.identifier = identifier;
    }

    /**
     * Get chat in the format of {role, name, content, tool_calls}.
     * @returns {Array} Array of objects with role, name, and content properties.
     */
    getChat() {
        return this.collection.reduce((acc, message) => {
            if (message.content || message.tool_calls) {
                acc.push({
                    role: message.role,
                    content: message.content,
                    ...(message.name && { name: message.name }),
                    ...(message.tool_calls && { tool_calls: message.tool_calls }),
                    ...(message.role === 'tool' && { tool_call_id: message.identifier }),
                    ...(message.signature && { signature: message.signature }),
                    ...(message.reasoning && { reasoning: message.reasoning }),
                });
            }
            return acc;
        }, []);
    }

    /**
     * Method to get the collection of messages.
     * @returns {Array} The collection of Message instances.
     */
    getCollection() {
        return this.collection;
    }

    /**
     * Add a new item to the collection.
     * @param {Object} item - The Message or MessageCollection instance to be added.
     */
    add(item) {
        this.collection.push(item);
    }

    /**
     * Get an item from the collection by its identifier.
     * @param {string} identifier - The identifier of the item to be found.
     * @returns {Object} The found item, or undefined if no item was found.
     */
    getItemByIdentifier(identifier) {
        return this.collection.find(item => item?.identifier === identifier);
    }

    /**
     * Check if an item with the given identifier exists in the collection.
     * @param {string} identifier - The identifier to check.
     * @returns {boolean} True if an item with the given identifier exists, false otherwise.
     */
    hasItemWithIdentifier(identifier) {
        return this.collection.some(message => message.identifier === identifier);
    }

    /**
     * Get the total number of tokens in the collection.
     * @returns {number} The total number of tokens.
     */
    getTokens() {
        return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0);
    }

    /**
     * Combines message collections into a single collection.
     * @returns {Message[]} The collection of messages flattened into a single array.
     */
    flatten() {
        return this.collection.reduce((acc, message) => {
            if (message instanceof MessageCollection) {
                acc.push(...message.flatten());
            } else {
                acc.push(message);
            }
            return acc;
        }, []);
    }
}

/**
 * OpenAI API chat completion representation
 * const map = [{identifier: 'example', message: {role: 'system', content: 'exampleContent'}}, ...];
 *
 * This class creates a chat context that can be sent to Open AI's api
 * Includes message management and token budgeting.
 *
 * @see https://platform.openai.com/docs/guides/gpt/chat-completions-api
 *
 */
export class ChatCompletion {
    /**
     * Combines consecutive system messages into one if they have no name attached.
     * @returns {Promise<void>}
     */
    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        this.messages.collection = this.messages.flatten();

        let lastMessage = null;
        let squashedMessages = [];

        for (let message of this.messages.collection) {
            // Force exclude empty messages
            if (message.role === 'system' && !message.content) {
                continue;
            }

            const shouldSquash = (message) => {
                return !excludeList.includes(message.identifier) && message.role === 'system' && !message.name;
            };

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = await tokenHandler.countAsync({ role: lastMessage.role, content: lastMessage.content });
                } else {
                    squashedMessages.push(message);
                    lastMessage = message;
                }
            } else {
                squashedMessages.push(message);
                lastMessage = message;
            }
        }

        this.messages.collection = squashedMessages;
    }

    /**
     * Initializes a new instance of ChatCompletion.
     * Sets up the initial token budget and a new message collection.
     */
    constructor() {
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.loggingEnabled = false;
        this.overriddenPrompts = [];
    }

    /**
     * Retrieves all messages.
     *
     * @returns {MessageCollection} The MessageCollection instance holding all messages.
     */
    getMessages() {
        return this.messages;
    }

    /**
     * Calculates and sets the token budget based on context and response.
     *
     * @param {number} context - Number of tokens in the context.
     * @param {number} response - Number of tokens in the response.
     */
    setTokenBudget(context, response) {
        this.log(`Prompt tokens: ${context}`);
        this.log(`Completion tokens: ${response}`);

        this.tokenBudget = context - response;

        this.log(`Token budget: ${this.tokenBudget}`);
    }

    /**
     * Adds a message or message collection to the collection.
     *
     * @param {Message|MessageCollection} collection - The message or message collection to add.
     * @param {number|null} position - The position at which to add the collection.
     * @returns {ChatCompletion} The current instance for chaining.
     */
    add(collection, position = null) {
        this.validateMessageCollection(collection);
        this.checkTokenBudget(collection, collection.identifier);

        if (null !== position && -1 !== position) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.decreaseTokenBudgetBy(collection.getTokens());

        this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);

        return this;
    }

    /**
     * Inserts a message at the start of the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    /**
     * Inserts a message at the end of the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     */
    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    /**
     * Inserts a message at the specified position in the specified collection.
     *
     * @param {Message} message - The message to insert.
     * @param {string} identifier - The identifier of the collection where to insert the message.
     * @param {string|number} position - The position at which to insert the message ('start' or 'end').
     */
    insert(message, identifier, position = 'end') {
        this.validateMessage(message);
        this.checkTokenBudget(message, message.identifier);

        const index = this.findMessageIndex(identifier);
        if (message.content || message.tool_calls) {
            if ('start' === position) this.messages.collection[index].collection.unshift(message);
            else if ('end' === position) this.messages.collection[index].collection.push(message);
            else if (typeof position === 'number') this.messages.collection[index].collection.splice(position, 0, message);

            this.decreaseTokenBudgetBy(message.getTokens());

            this.log(`Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`);
        }
    }

    /**
     * Remove the last item of the collection
     *
     * @param identifier
     */
    removeLastFrom(identifier) {
        const index = this.findMessageIndex(identifier);
        const message = this.messages.collection[index].collection.pop();

        if (!message) {
            this.log(`No message to remove from ${identifier}`);
            return;
        }

        this.increaseTokenBudgetBy(message.getTokens());

        this.log(`Removed ${message.identifier} from ${identifier}. Remaining tokens: ${this.tokenBudget}`);
    }

    /**
     * Checks if the token budget can afford the tokens of the specified message.
     *
     * @param {Message|MessageCollection} message - The message to check for affordability.
     * @returns {boolean} True if the budget can afford the message, false otherwise.
     */
    canAfford(message) {
        return 0 <= this.tokenBudget - message.getTokens();
    }

    /**
     * Checks if the token budget can afford the tokens of all the specified messages.
     * @param {Message[]} messages - The messages to check for affordability.
     * @returns {boolean} True if the budget can afford all the messages, false otherwise.
     */
    canAffordAll(messages) {
        return 0 <= this.tokenBudget - messages.reduce((total, message) => total + message.getTokens(), 0);
    }

    /**
     * Checks if a message with the specified identifier exists in the collection.
     *
     * @param {string} identifier - The identifier to check for existence.
     * @returns {boolean} True if a message with the specified identifier exists, false otherwise.
     */
    has(identifier) {
        return this.messages.hasItemWithIdentifier(identifier);
    }

    /**
     * Retrieves the total number of tokens in the collection.
     *
     * @returns {number} The total number of tokens.
     */
    getTotalTokenCount() {
        return this.messages.getTokens();
    }

    /**
     * Retrieves the chat as a flattened array of messages.
     *
     * @returns {Array} The chat messages.
     */
    getChat() {
        const chat = [];
        for (let item of this.messages.collection) {
            if (item instanceof MessageCollection) {
                chat.push(...item.getChat());
            } else if (item instanceof Message && (item.content || item.tool_calls)) {
                const message = {
                    role: item.role,
                    content: item.content,
                    ...(item.name ? { name: item.name } : {}),
                    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                    ...(item.signature ? { signature: item.signature } : {}),
                    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                };
                chat.push(message);
            } else {
                this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
            }
        }
        return chat;
    }

    /**
     * Logs an output message to the console if logging is enabled.
     *
     * @param {string} output - The output message to log.
     */
    log(output) {
        if (this.loggingEnabled) console.log('[ChatCompletion] ' + output);
    }

    /**
     * Enables logging of output messages to the console.
     */
    enableLogging() {
        this.loggingEnabled = true;
    }

    /**
     * Disables logging of output messages to the console.
     */
    disableLogging() {
        this.loggingEnabled = false;
    }

    /**
     * Validates if the given argument is an instance of MessageCollection.
     * Throws an error if the validation fails.
     *
     * @param {MessageCollection|Message} collection - The collection to validate.
     */
    validateMessageCollection(collection) {
        if (!(collection instanceof MessageCollection)) {
            console.log(collection);
            throw new Error('Argument must be an instance of MessageCollection');
        }
    }

    /**
     * Validates if the given argument is an instance of Message.
     * Throws an error if the validation fails.
     *
     * @param {Message} message - The message to validate.
     */
    validateMessage(message) {
        if (!(message instanceof Message)) {
            console.log(message);
            throw new Error('Argument must be an instance of Message');
        }
    }

    /**
     * Checks if the token budget can afford the tokens of the given message.
     * Throws an error if the budget can't afford the message.
     *
     * @param {Message|MessageCollection} message - The message to check.
     * @param {string} identifier - The identifier of the message.
     */
    checkTokenBudget(message, identifier) {
        if (!this.canAfford(message)) {
            throw new TokenBudgetExceededError(identifier);
        }
    }

    /**
     * Reserves the tokens required by the given message from the token budget.
     *
     * @param {Message|MessageCollection|number} message - The message whose tokens to reserve.
     */
    reserveBudget(message) {
        const tokens = typeof message === 'number' ? message : message.getTokens();
        this.decreaseTokenBudgetBy(tokens);
    }

    /**
     * Frees up the tokens used by the given message from the token budget.
     *
     * @param {Message|MessageCollection} message - The message whose tokens to free.
     */
    freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }

    /**
     * Increases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     *
     * @param {number} tokens - The number of tokens to increase the budget by.
     */
    increaseTokenBudgetBy(tokens) {
        this.tokenBudget += tokens;
    }

    /**
     * Decreases the token budget by the given number of tokens.
     * This function should be used sparingly, per design the completion should be able to work with its initial budget.
     *
     * @param {number} tokens - The number of tokens to decrease the budget by.
     */
    decreaseTokenBudgetBy(tokens) {
        this.tokenBudget -= tokens;
    }

    /**
     * Finds the index of a message in the collection by its identifier.
     * Throws an error if a message with the given identifier is not found.
     *
     * @param {string} identifier - The identifier of the message to find.
     * @returns {number} The index of the message in the collection.
     */
    findMessageIndex(identifier) {
        const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
        if (index < 0) {
            throw new IdentifierNotFoundError(identifier);
        }
        return index;
    }

    /**
     * Sets the list of overridden prompts.
     * @param {string[]} list A list of prompts that were overridden.
     */
    setOverriddenPrompts(list) {
        this.overriddenPrompts = list;
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts ?? [];
    }
}

/**
 * Migrate old Chat Completion settings to new format.
 * @param {ChatCompletionSettings} settings Settings to migrate
 */
function migrateChatCompletionSettings(settings) {
    const migrateMap = [
        { oldKey: 'names_in_completion', oldValue: true, newKey: 'names_behavior', newValue: character_names_behavior.COMPLETION },
        { oldKey: 'chat_completion_source', oldValue: 'palm', newKey: 'chat_completion_source', newValue: chat_completion_sources.MAKERSUITE },
        { oldKey: 'custom_prompt_post_processing', oldValue: custom_prompt_post_processing_types.CLAUDE, newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.MERGE },
        { oldKey: 'custom_prompt_post_processing', oldValue: 'merge_tools', newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.MERGE },
        { oldKey: 'custom_prompt_post_processing', oldValue: 'semi_tools', newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.SEMI },
        { oldKey: 'custom_prompt_post_processing', oldValue: 'strict_tools', newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.STRICT },
        { oldKey: 'ai21_model', oldValue: /^j2-/, newKey: 'ai21_model', newValue: 'jamba-large' },
        { oldKey: 'image_inlining', oldValue: false, newKey: 'media_inlining', newValue: false },
        { oldKey: 'image_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'video_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'audio_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'claude_use_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'use_makersuite_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'mistralai_model', oldValue: /^(mistral-medium|mistral-small)$/, newKey: 'mistralai_model', newValue: (settings.mistralai_model + '-latest') },
        { oldKey: 'deepseek_model', oldValue: /^deepseek-(chat|reasoner|coder)$/, newKey: 'deepseek_model', newValue: 'deepseek-v4-flash' },
        { oldKey: 'openrouter_sort_models', oldValue: 'alphabetically', newKey: 'sort_models', newValue: 'alphabetically' },
        { oldKey: 'openrouter_sort_models', oldValue: 'pricing.prompt', newKey: 'sort_models', newValue: 'pricing.prompt' },
        { oldKey: 'openrouter_sort_models', oldValue: 'context_length', newKey: 'sort_models', newValue: 'context_length' },
        { oldKey: 'openrouter_group_models', oldValue: true, newKey: 'group_models', newValue: true },
    ];

    for (const migration of migrateMap) {
        if (Object.hasOwn(settings, migration.oldKey)) {
            const shouldMigrate = migration.oldValue instanceof RegExp
                ? migration.oldValue.test(settings[migration.oldKey])
                : settings[migration.oldKey] === migration.oldValue;
            if (shouldMigrate) {
                settings[migration.newKey] = migration.newValue;
            }
            if (migration.oldKey !== migration.newKey) {
                delete settings[migration.oldKey];
            }
        }
    }
}

/**
 * Load OpenAI settings from backend data
 * @param {any} data Settings data from backend
 * @param {ChatCompletionSettings} settings Saved settings from backend
 */
export function hydrateOpenAIPresetData(data = {}) {
    openai_setting_names = buildPresetNameIndexMap(data.openai_setting_names ?? openai_setting_names);
    openai_settings = Array.isArray(data.openai_settings)
        ? data.openai_settings.map((item) => {
            if (typeof item !== 'string') {
                return null;
            }
            const parsed = JSON.parse(item);
            return structuredClone(parsed);
        })
        : [];
}

function loadOpenAISettings(data, settings) {
    hydrateOpenAIPresetData(data);

    $('#settings_preset_openai').empty();
    getOrderedPresetNames(openai_setting_names).forEach(function (item) {
        const option = document.createElement('option');
        option.value = String(openai_setting_names[item]);
        option.text = item;
        $('#settings_preset_openai').append(option);
    });

    migrateChatCompletionSettings(settings);

    for (const key of Object.keys(default_settings)) {
        oai_settings[key] = settings[key] ?? default_settings[key];
        const settingToUpdate = Object.values(settingsToUpdate).find(([_, k]) => k === key);
        if (settingToUpdate) {
            const [selector] = settingToUpdate;
            const $element = $(selector);

            if ($element.length === 0) {
                continue;
            }

            if ($element.is('input[type="checkbox"]')) {
                $element.prop('checked', oai_settings[key]);
            } else if ($element.is('select')) {
                $element.val(oai_settings[key]);
                $element.find(`option[value="${CSS.escape(oai_settings[key])}"]`).prop('selected', true);
            } else {
                $element.val(oai_settings[key]);
                if ($element.is('input[type="range"]')) {
                    const id = $element.attr('id');
                    const $counter = $(`input[type="number"][data-for="${id}"]`);
                    if ($counter.length > 0) {
                        $counter.val(Number(oai_settings[key]));
                    }
                }
            }
        }
    }
    // Preserve preset-body alias keys that the active preset (or programmatic
    // callers) mirrored onto oai_settings before save. default_settings only
    // covers runtime keys (e.g. `temp_openai`), so without this any extra
    // alias (e.g. `temperature`) is dropped on reload — leaving callers that
    // read via the preset-body shape with undefined after a restart.
    if (settings && typeof settings === 'object') {
        for (const key of Object.keys(settings)) {
            if (key in default_settings) {
                continue;
            }
            if (key in oai_settings) {
                continue;
            }
            if (!Object.hasOwn(settingsToUpdate, key)) {
                continue;
            }
            oai_settings[key] = settings[key];
        }
    }
    // Fall back to the active preset body for any alias key still missing.
    // settings.json is debounced and may lag behind the persisted preset file
    // when a switch happens immediately before a process restart — in that
    // window settings.json carries the previous preset's runtime keys but
    // the preset cache (just hydrated above) carries the canonical body.
    const activePresetIndex = openai_setting_names?.[oai_settings.preset_settings_openai];
    const activePresetBody = Number.isInteger(activePresetIndex) ? openai_settings?.[activePresetIndex] : null;
    if (activePresetBody && typeof activePresetBody === 'object') {
        for (const [presetKey, value] of Object.entries(activePresetBody)) {
            const mapping = settingsToUpdate[presetKey];
            if (!mapping) {
                continue;
            }
            const [, settingsKey] = mapping;
            if (!(presetKey in oai_settings)) {
                oai_settings[presetKey] = value;
            }
            if (settingsKey && !(settingsKey in default_settings) && !(settingsKey in oai_settings)) {
                oai_settings[settingsKey] = value;
            }
        }
    }
    oai_settings.custom_models_by_source = normalizeCustomModelsBySource(oai_settings.custom_models_by_source);

    const selectedOpenAIPresetValue = openai_setting_names[oai_settings.preset_settings_openai];
    if (selectedOpenAIPresetValue !== undefined) {
        $('#settings_preset_openai').val(String(selectedOpenAIPresetValue));
        $(`#settings_preset_openai option[value="${selectedOpenAIPresetValue}"]`).prop('selected', true);
    }
    lastOpenAIPresetSelectValue = String($('#settings_preset_openai').val() ?? selectedOpenAIPresetValue ?? '');
    updateCharacterBoundPresetBadge(false);
    $('#openai_external_category').toggle(oai_settings.show_external_models);
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy !== '' || oai_settings.base_url !== '');

    // Don't display Service Account JSON in textarea - it's stored in backend secrets
    $('#vertexai_service_account_json').val('');
    updateVertexAIServiceAccountStatus();

    $('#openai_logit_bias_preset').empty();
    for (const preset of Object.keys(oai_settings.bias_presets)) {
        // Backfill missing IDs
        if (Array.isArray(oai_settings.bias_presets[preset])) {
            oai_settings.bias_presets[preset].forEach((bias) => {
                if (bias && !bias.id) {
                    bias.id = uuidv4();
                }
            });
        }
        const option = document.createElement('option');
        option.innerText = preset;
        option.value = preset;
        option.selected = preset === oai_settings.bias_preset_selected;
        $('#openai_logit_bias_preset').append(option);
    }
    $('#openai_logit_bias_preset').trigger('change');

    setNamesBehaviorControls();
    setContinuePostfixControls();
    setToolReasoningControls();
    ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit;

    // Mirror the HTML-declared model options between each input-driven source's
    // <select> and <datalist>, and reflect the saved id back to the picker.
    for (const binding of INPUT_BASED_MODEL_BINDINGS) {
        syncSourceModelInputs({
            selectSelector: binding.select,
            datalistSelector: binding.datalist,
            modelList: [],
            savedModelId: oai_settings[binding.key],
        });
    }

    $('#openrouter_providers_chat').trigger('change');
    $('#openrouter_quantizations_chat').trigger('change');
    $('#nanogpt_provider').trigger('change');
    $('#chat_completion_source').trigger('change');
}

function setNamesBehaviorControls() {
    switch (oai_settings.names_behavior) {
        case character_names_behavior.NONE:
            $('#character_names_none').prop('checked', true);
            break;
        case character_names_behavior.DEFAULT:
            $('#character_names_default').prop('checked', true);
            break;
        case character_names_behavior.COMPLETION:
            $('#character_names_completion').prop('checked', true);
            break;
        case character_names_behavior.CONTENT:
            $('#character_names_content').prop('checked', true);
            break;
    }

    const checkedItemText = $('input[name="character_names"]:checked ~ span').text().trim();
    $('#character_names_display').text(checkedItemText);
}

function setContinuePostfixControls() {
    switch (oai_settings.continue_postfix) {
        case continue_postfix_types.NONE:
            $('#continue_postfix_none').prop('checked', true);
            break;
        case continue_postfix_types.SPACE:
            $('#continue_postfix_space').prop('checked', true);
            break;
        case continue_postfix_types.NEWLINE:
            $('#continue_postfix_newline').prop('checked', true);
            break;
        case continue_postfix_types.DOUBLE_NEWLINE:
            $('#continue_postfix_double_newline').prop('checked', true);
            break;
        default:
            // Prevent preset value abuse
            oai_settings.continue_postfix = continue_postfix_types.SPACE;
            $('#continue_postfix_space').prop('checked', true);
            break;
    }

    $('#continue_postfix').val(oai_settings.continue_postfix);
    const checkedItemText = $('input[name="continue_postfix"]:checked ~ span').text().trim();
    $('#continue_postfix_display').text(checkedItemText);
}

async function syncOpenAIPresetUiAfterApply() {
    $('#temp_counter_openai').val(Number(oai_settings.temp_openai).toFixed(2));
    $('#freq_pen_counter_openai').val(Number(oai_settings.freq_pen_openai).toFixed(2));
    $('#pres_pen_counter_openai').val(Number(oai_settings.pres_pen_openai).toFixed(2));
    $('#top_p_counter_openai').val(Number(oai_settings.top_p_openai).toFixed(2));
    $('#top_k_counter_openai').val(Number(oai_settings.top_k_openai).toFixed(0));
    $('#top_a_counter_openai').val(Number(oai_settings.top_a_openai));
    $('#min_p_counter_openai').val(Number(oai_settings.min_p_openai));
    $('#repetition_penalty_counter_openai').val(Number(oai_settings.repetition_penalty_openai));
    $('#openai_max_context_counter').val(`${oai_settings.openai_max_context}`);

    setNamesBehaviorControls();
    setContinuePostfixControls();
    updateFeatureSupportFlags();
    calculateOpenRouterCost();
    calculateElectronHubCost();
    calculateChutesCost();

    if (!CSS.supports('field-sizing', 'content')) {
        const autoHeightSelectors = [
            '#send_if_empty_textarea',
            '#impersonation_prompt_textarea',
            '#newchat_prompt_textarea',
            '#newgroupchat_prompt_textarea',
            '#newexamplechat_prompt_textarea',
            '#continue_nudge_prompt_textarea',
            '#wi_format_textarea',
            '#scenario_format_textarea',
            '#personality_format_textarea',
            '#group_nudge_prompt_textarea',
            '#claude_assistant_prefill',
            '#claude_assistant_impersonation',
            '#continue_postifx',
        ];

        for (const selector of autoHeightSelectors) {
            const element = $(selector);
            if (!element.length) {
                continue;
            }
            await resetScrollHeight(element);
        }
    }

    if (promptManager) {
        promptManager.render(false);
    }

    $('#openai_logit_bias_preset').trigger('change');
}

function getCharacterBoundPresetName(character) {
    const raw = character?.data?.extensions?.luker?.chat_completion_preset;
    if (typeof raw === 'string') {
        return raw.trim();
    }
    if (raw && typeof raw === 'object') {
        return String(raw.name || '').trim();
    }
    return '';
}

function getCharacterBoundPresetPayload(character) {
    const raw = character?.data?.extensions?.luker?.chat_completion_preset;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const name = String(raw.name || '').trim();
        const preset = raw.preset && typeof raw.preset === 'object' ? stripOpenAIConnectionFieldsFromPreset(raw.preset) : null;
        if (name && preset) {
            return { name, preset };
        }
    }
    return null;
}

function getCharacterById(characterId = this_chid) {
    const id = Number(characterId);
    return Number.isInteger(id) ? characters[id] : undefined;
}

function getCharacterJsonDataWorker() {
    if (characterJsonDataWorker || typeof Worker === 'undefined') {
        return characterJsonDataWorker;
    }

    characterJsonDataWorker = new Worker(new URL('./workers/character-json-data-worker.js', import.meta.url), { type: 'module' });
    characterJsonDataWorker.addEventListener('message', (event) => {
        const id = Number(event?.data?.id);
        if (!Number.isInteger(id)) {
            return;
        }

        const pending = characterJsonDataWorkerPending.get(id);
        if (!pending) {
            return;
        }

        characterJsonDataWorkerPending.delete(id);
        if (event?.data?.ok && typeof event.data.jsonData === 'string') {
            pending.resolve(event.data.jsonData);
            return;
        }

        pending.reject(new Error(String(event?.data?.error || 'Character JSON data worker failed.')));
    });
    characterJsonDataWorker.addEventListener('error', (event) => {
        const error = new Error(event?.message || 'Character JSON data worker failed.');
        for (const pending of characterJsonDataWorkerPending.values()) {
            pending.reject(error);
        }
        characterJsonDataWorkerPending.clear();
        characterJsonDataWorker?.terminate();
        characterJsonDataWorker = null;
    });

    return characterJsonDataWorker;
}

function updateCharacterJsonDataSnapshot(jsonDataText, boundPreset) {
    const jsonData = JSON.parse(String(jsonDataText || ''));
    jsonData.data = jsonData.data && typeof jsonData.data === 'object' && !Array.isArray(jsonData.data)
        ? jsonData.data
        : {};
    jsonData.data.extensions = jsonData.data.extensions && typeof jsonData.data.extensions === 'object' && !Array.isArray(jsonData.data.extensions)
        ? jsonData.data.extensions
        : {};
    jsonData.data.extensions.luker = jsonData.data.extensions.luker && typeof jsonData.data.extensions.luker === 'object' && !Array.isArray(jsonData.data.extensions.luker)
        ? jsonData.data.extensions.luker
        : {};
    jsonData.data.extensions.luker.chat_completion_preset = boundPreset;
    return JSON.stringify(jsonData);
}

async function syncCharacterBoundPresetJsonData(characterId, boundPreset) {
    const id = Number(characterId);
    if (Number(this_chid) !== id) {
        return;
    }

    const character = getCharacterById(id);
    if (!character?.json_data) {
        return;
    }

    const sourceJsonData = character.json_data;
    const worker = getCharacterJsonDataWorker();
    try {
        let nextJsonData;
        if (!worker) {
            nextJsonData = updateCharacterJsonDataSnapshot(sourceJsonData, boundPreset);
        } else {
            const requestId = ++characterJsonDataWorkerRequestId;
            const responsePromise = new Promise((resolve, reject) => {
                characterJsonDataWorkerPending.set(requestId, { resolve, reject });
            });
            // boundPreset may carry Promises / Proxies / function getters from
            // upstream callers (e.g. CPA commit after applyEdits). worker.postMessage
            // uses structuredClone, which would reject them. Round-trip through
            // JSON to drop non-data fields before sending.
            worker.postMessage({
                id: requestId,
                jsonData: sourceJsonData,
                boundPreset: JSON.parse(JSON.stringify(boundPreset)),
            });
            nextJsonData = await responsePromise;
        }

        if (Number(this_chid) !== id || character.json_data !== sourceJsonData) {
            return;
        }

        character.json_data = nextJsonData;
        $('#character_json_data').val(nextJsonData);
    } catch (error) {
        console.warn('Failed to sync character-bound preset to character JSON snapshot', error);
    }
}

export function applyPresetByName(presetName, { forceChange = false } = {}) {
    const target = findCanonicalNameInList(Object.keys(openai_setting_names || {}), presetName) || String(presetName ?? '').trim();
    if (!target) {
        return false;
    }

    const presetIndex = openai_setting_names?.[target];
    if (!Number.isInteger(presetIndex)) {
        return false;
    }

    const selectValue = String(presetIndex);
    if ($('#settings_preset_openai').val() !== selectValue) {
        $('#settings_preset_openai').val(selectValue).trigger('change');
    } else if (forceChange) {
        $('#settings_preset_openai').trigger('change');
    }
    return true;
}

function isCharacterBoundPresetOptionSelected() {
    const selected = $('#settings_preset_openai').find(':selected');
    return selected.attr('data-luker-char-bound') === '1';
}

function updateCharacterBoundPresetBadge(forceVisible = null) {
    const visible = typeof forceVisible === 'boolean' ? forceVisible : isCharacterBoundPresetOptionSelected();
    $('#luker_char_bound_preset_badge').toggleClass('displayNone', !visible);
}

function getSelectedNonCharacterBoundPresetName() {
    const selected = $('#settings_preset_openai').find(':selected');
    if (selected.attr('data-luker-char-bound') === '1') {
        return '';
    }
    return String(selected.text() || '').trim();
}

function resolveExistingOpenAIPresetName(name = '') {
    const presetNames = getOrderedPresetNames(openai_setting_names || {});
    return findCanonicalNameInList(presetNames, name) || '';
}

function resolveOpenAIPresetRestoreTarget(preferredName = '') {
    return resolveExistingOpenAIPresetName(preferredName)
        || resolveExistingOpenAIPresetName(getSelectedNonCharacterBoundPresetName())
        || resolveExistingOpenAIPresetName(String(oai_settings.preset_settings_openai ?? '').trim())
        || getOrderedPresetNames(openai_setting_names || {})[0]
        || '';
}

function removeCharacterBoundRuntimeOption() {
    $('#settings_preset_openai option[data-luker-char-bound="1"]').remove();
    characterBoundPresetState.runtimePresetName = '';
    characterBoundPresetState.runtimePresetBody = null;
    updateCharacterBoundPresetBadge(false);
}

function restoreOpenAIPresetAfterCharacterBound(preferredName = '') {
    const targetPresetName = resolveOpenAIPresetRestoreTarget(preferredName);
    removeCharacterBoundRuntimeOption();

    if (!targetPresetName) {
        $('#settings_preset_openai').prop('selectedIndex', -1);
        oai_settings.preset_settings_openai = '';
        lastOpenAIPresetSelectValue = '';
        updateCharacterBoundPresetBadge(false);
        return false;
    }

    const restored = applyPresetByName(targetPresetName, { forceChange: true });
    if (!restored) {
        console.warn(`Failed to restore chat completion preset after removing character binding: ${targetPresetName}`);
    }
    return restored;
}

function upsertCharacterBoundRuntimeOption(presetName, presetBody) {
    const name = String(presetName || '').trim();
    if (!name || !presetBody || typeof presetBody !== 'object') {
        removeCharacterBoundRuntimeOption();
        return false;
    }
    const normalizedPreset = stripOpenAIConnectionFieldsFromPreset(structuredClone(presetBody));
    removeCharacterBoundRuntimeOption();
    const option = document.createElement('option');
    option.value = characterBoundPresetState.runtimeOptionValue;
    option.innerText = name;
    option.setAttribute('data-luker-char-bound', '1');
    $('#settings_preset_openai').append(option);
    characterBoundPresetState.runtimePresetName = name;
    characterBoundPresetState.runtimePresetBody = normalizedPreset;
    return true;
}

function getCurrentPresetBodyForBinding() {
    if (isCharacterBoundPresetOptionSelected() && characterBoundPresetState.runtimePresetBody) {
        return getChatCompletionPreset(oai_settings, { includeConnectionFields: false });
    }

    const currentPreset = String(oai_settings.preset_settings_openai ?? '').trim();
    const presetIndex = openai_setting_names?.[currentPreset];
    if (Number.isInteger(presetIndex) && openai_settings[presetIndex]) {
        return structuredClone(openai_settings[presetIndex]);
    }

    return getChatCompletionPreset(oai_settings, { includeConnectionFields: false });
}

async function setCharacterBoundPresetValue(characterId, presetName, presetBody = null) {
    const id = Number(characterId);
    const character = Number.isInteger(id) ? characters[id] : null;
    if (!character) {
        return false;
    }

    const trimmed = String(presetName ?? '').trim();
    const sanitizedPreset = trimmed && presetBody && typeof presetBody === 'object'
        ? stripOpenAIConnectionFieldsFromPreset(structuredClone(presetBody))
        : null;
    const currentExtensions = character?.data?.extensions && typeof character.data.extensions === 'object' && !Array.isArray(character.data.extensions)
        ? character.data.extensions
        : {};
    const currentLukerExtensions = currentExtensions.luker && typeof currentExtensions.luker === 'object' && !Array.isArray(currentExtensions.luker)
        ? currentExtensions.luker
        : {};
    const currentRaw = currentLukerExtensions.chat_completion_preset;
    const currentName = typeof currentRaw === 'string'
        ? currentRaw.trim()
        : String(currentRaw?.name || '').trim();
    const currentPreset = currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
        ? currentRaw.preset
        : null;

    if (currentName === trimmed) {
        const samePreset = (!trimmed && !currentPreset && !sanitizedPreset)
            || (trimmed && JSON.stringify(currentPreset || null) === JSON.stringify(sanitizedPreset || null));
        if (samePreset) {
            return true;
        }
    }

    if (trimmed && !sanitizedPreset) {
        console.warn('Skipped character-bound preset save: missing preset body.');
        return true;
    }

    const nextBoundPreset = trimmed
        ? {
            name: trimmed,
            preset: sanitizedPreset,
        }
        : null;
    const nextLukerExtensions = {
        ...currentLukerExtensions,
        // merge-attributes deep-merges nested objects, so deletion-by-omission
        // would keep the old bound preset on the character card. Persist an
        // explicit null to clear the field reliably.
        chat_completion_preset: nextBoundPreset,
    };
    const nextExtensions = {
        ...currentExtensions,
        luker: nextLukerExtensions,
    };

    character.data = character.data || {};
    character.data.extensions = nextExtensions;
    const jsonDataSyncPromise = syncCharacterBoundPresetJsonData(id, nextBoundPreset);

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar: character.avatar,
            data: {
                extensions: {
                    luker: {
                        chat_completion_preset: nextBoundPreset,
                    },
                },
            },
        }),
    });

    await jsonDataSyncPromise;

    if (!response.ok) {
        console.error('Failed to save character-bound chat completion preset', response.statusText);
    }

    return response.ok;
}

async function maybeApplyCharacterBoundPreset() {
    if (!openai_setting_names || Object.keys(openai_setting_names).length === 0) {
        updateCharacterBoundPresetBadge(false);
        return;
    }

    if (selected_group) {
        if (characterBoundPresetState.active) {
            const restored = restoreOpenAIPresetAfterCharacterBound(characterBoundPresetState.previousPreset);
            if (!restored && characterBoundPresetState.previousPreset) {
                console.warn(`Failed to restore previous chat completion preset: ${characterBoundPresetState.previousPreset}`);
            }
            characterBoundPresetState.active = false;
            characterBoundPresetState.previousPreset = '';
        } else {
            removeCharacterBoundRuntimeOption();
        }
        updateCharacterBoundPresetBadge(false);
        return;
    }

    const character = getCharacterById(this_chid);
    const embeddedPayload = getCharacterBoundPresetPayload(character);
    const legacyBoundPresetName = getCharacterBoundPresetName(character);
    if (!embeddedPayload && !legacyBoundPresetName) {
        if (characterBoundPresetState.active) {
            const restored = restoreOpenAIPresetAfterCharacterBound(characterBoundPresetState.previousPreset);
            if (!restored && characterBoundPresetState.previousPreset) {
                console.warn(`Failed to restore previous chat completion preset: ${characterBoundPresetState.previousPreset}`);
            }
            characterBoundPresetState.active = false;
            characterBoundPresetState.previousPreset = '';
        } else {
            removeCharacterBoundRuntimeOption();
        }
        updateCharacterBoundPresetBadge(false);
        return;
    }

    if (!characterBoundPresetState.active) {
        characterBoundPresetState.previousPreset = resolveExistingOpenAIPresetName(getSelectedNonCharacterBoundPresetName())
            || resolveExistingOpenAIPresetName(String(oai_settings.preset_settings_openai ?? '').trim());
        characterBoundPresetState.active = true;
    }

    if (embeddedPayload) {
        const prepared = upsertCharacterBoundRuntimeOption(embeddedPayload.name, embeddedPayload.preset);
        if (!prepared) {
            toastr.warning(t`Bound chat completion preset '${embeddedPayload.name}' was not found.`, t`Preset Not Found`);
            return;
        }
        if ($('#settings_preset_openai').val() !== characterBoundPresetState.runtimeOptionValue) {
            $('#settings_preset_openai').val(characterBoundPresetState.runtimeOptionValue).trigger('change');
        } else {
            updateCharacterBoundPresetBadge(true);
        }
        return;
    }

    // Legacy fallback: name-only binding, use global preset if present.
    removeCharacterBoundRuntimeOption();
    const changed = applyPresetByName(legacyBoundPresetName);
    if (!changed) {
        toastr.warning(t`Bound chat completion preset '${legacyBoundPresetName}' was not found.`, t`Preset Not Found`);
    }
}

let syncCharacterBoundPresetFromSettingsInFlight = false;
let syncCharacterBoundPresetFromSettingsQueued = false;

/**
 * Mirror the current oai_settings back into the bound character's preset snapshot.
 * Without this, edits made while a card-bound preset is active (sampler tweaks,
 * prompt edits, prompt-group changes) live only in settings.json — the next
 * character switch / reload calls maybeApplyCharacterBoundPreset, which loads
 * the stale snapshot and overwrites oai_settings.extensions, silently dropping
 * the user's work.
 *
 * Safe to call from SETTINGS_UPDATED: setCharacterBoundPresetValue short-circuits
 * when the snapshot already matches, so the round-trip after onSettingsPresetChange
 * does not loop.
 */
async function syncCharacterBoundPresetFromSettings() {
    if (!characterBoundPresetState.active) {
        return;
    }
    const presetName = String(characterBoundPresetState.runtimePresetName || '').trim();
    if (!presetName) {
        return;
    }
    const characterId = Number(this_chid);
    if (!Number.isInteger(characterId)) {
        return;
    }
    const character = getCharacterById(characterId);
    if (!character) {
        return;
    }

    if (syncCharacterBoundPresetFromSettingsInFlight) {
        syncCharacterBoundPresetFromSettingsQueued = true;
        return;
    }
    syncCharacterBoundPresetFromSettingsInFlight = true;
    try {
        do {
            syncCharacterBoundPresetFromSettingsQueued = false;
            const presetBody = getChatCompletionPreset(oai_settings, { includeConnectionFields: false });
            await setCharacterBoundPresetValue(characterId, presetName, presetBody);
            characterBoundPresetState.runtimePresetBody = stripOpenAIConnectionFieldsFromPreset(structuredClone(presetBody));
        } while (syncCharacterBoundPresetFromSettingsQueued);
    } catch (error) {
        console.error('Failed to sync character-bound chat completion preset from settings', error);
    } finally {
        syncCharacterBoundPresetFromSettingsInFlight = false;
    }
}

async function bindCurrentChatCompletionPresetToCharacter(characterId = this_chid) {
    const character = getCharacterById(characterId);
    if (!character) {
        toastr.warning(t`No character selected.`);
        return;
    }

    const currentPreset = String($('#settings_preset_openai').find(':selected').text() || '').trim();
    if (!currentPreset) {
        toastr.warning(t`No chat completion preset selected.`);
        return;
    }
    const presetBody = getCurrentPresetBodyForBinding();

    const confirmation = await Popup.show.confirm(
        t`Bind Character Preset`,
        t`Bind current chat completion preset '${currentPreset}' to character '${character.name}'?`,
    );

    if (!confirmation) {
        return;
    }

    const ok = await setCharacterBoundPresetValue(characterId, currentPreset, presetBody);
    if (ok) {
        toastr.success(t`Bound preset '${currentPreset}' to '${character.name}'.`, t`Character Preset Bound`);
        await maybeApplyCharacterBoundPreset();
    } else {
        toastr.error(t`Failed to bind character preset.`);
    }
}

async function clearCharacterBoundChatCompletionPreset(characterId = this_chid) {
    const character = getCharacterById(characterId);
    if (!character) {
        toastr.warning(t`No character selected.`);
        return;
    }

    const current = getCharacterBoundPresetName(character);
    if (!current) {
        toastr.info(t`This character has no bound chat completion preset.`);
        return;
    }

    const confirmation = await Popup.show.confirm(
        t`Clear Character Preset`,
        t`Clear bound chat completion preset '${current}' from '${character.name}'?`,
    );

    if (!confirmation) {
        return;
    }

    const ok = await setCharacterBoundPresetValue(characterId, '');
    if (ok) {
        toastr.success(t`Cleared bound preset from '${character.name}'.`, t`Character Preset Cleared`);
        await maybeApplyCharacterBoundPreset();
    } else {
        toastr.error(t`Failed to clear character preset.`);
    }
}

function setToolReasoningControls() {
    const isEnabled = oai_settings.show_thoughts;
    $('#tool_reasoning_mode').prop('disabled', !isEnabled);
    $('#openrouter_interleaved_thinking_disabled_hint').toggle(!isEnabled);
}

async function getStatusOpen() {
    const noValidateSources = [
        chat_completion_sources.AI21,
        chat_completion_sources.PERPLEXITY,
        chat_completion_sources.ZAI,
        chat_completion_sources.MINIMAX,
    ];
    if (noValidateSources.includes(oai_settings.chat_completion_source)) {
        let status = t`Key saved; press \"Test Message\" to verify.`;
        setOnlineStatus(status);
        updateFeatureSupportFlags();
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM && !isValidUrl(oai_settings.custom_url)) {
        console.debug('Invalid endpoint URL of Custom OpenAI API:', oai_settings.custom_url);
        setOnlineStatus(t`Invalid endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI && !isValidUrl(oai_settings.azure_base_url)) {
        console.debug('Invalid endpoint URL of Azure OpenAI API:', oai_settings.azure_base_url);
        setOnlineStatus(t`Invalid Azure endpoint URL. Requests may fail.`);
        return resultCheckStatus();
    }

    let data = {
        reverse_proxy: oai_settings.reverse_proxy,
        proxy_password: oai_settings.proxy_password,
        base_url: oai_settings.base_url,
        chat_completion_source: oai_settings.chat_completion_source,
    };

    const validateProxySources = [
        chat_completion_sources.CLAUDE,
        chat_completion_sources.OPENAI,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
        chat_completion_sources.ZAI,
        chat_completion_sources.MOONSHOT,
    ];
    if (oai_settings.reverse_proxy && validateProxySources.includes(oai_settings.chat_completion_source)) {
        await validateReverseProxy();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        data.custom_url = oai_settings.custom_url;
    }

    if ([chat_completion_sources.CUSTOM, chat_completion_sources.DEEPSEEK, chat_completion_sources.CLAUDE].includes(oai_settings.chat_completion_source)) {
        data.custom_include_headers = oai_settings.custom_include_headers;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI) {
        data.azure_base_url = oai_settings.azure_base_url;
        data.azure_deployment_name = oai_settings.azure_deployment_name;
        data.azure_api_version = oai_settings.azure_api_version;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        data.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI) {
        data.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
        data.vertexai_region = oai_settings.vertexai_region;
        data.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        data.minimax_endpoint = oai_settings.minimax_endpoint;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        data.workers_ai_account_id = oai_settings.workers_ai_account_id;
    }

    const canBypass = (oai_settings.chat_completion_source === chat_completion_sources.OPENAI && oai_settings.bypass_status_check) || oai_settings.chat_completion_source === chat_completion_sources.CUSTOM;
    if (canBypass) {
        setOnlineStatus(t`Status check bypassed`);
    }

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(data),
            signal: abortStatusCheck.signal,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        const responseData = await response.json();

        if ('data' in responseData && Array.isArray(responseData.data)) {
            saveModelList(responseData.data);
        }
        if (!('error' in responseData)) {
            setOnlineStatus(t`Valid`);
        }
        if (responseData.bypass) {
            setOnlineStatus(t`Status check bypassed`);
        }
    } catch (error) {
        if (error instanceof AbortReason) {
            return resultCheckStatus();
        }
        console.error(error);

        if (!canBypass) {
            setOnlineStatus('no_connection');
        }
    }

    updateFeatureSupportFlags();
    return resultCheckStatus();
}

/**
 * Get OpenAI preset body from settings
 * @param {ChatCompletionSettings} settings The settings object
 * @param {{ includeConnectionFields?: boolean, clone?: boolean }} [options] Serialization options
 * @returns {Object} The preset body object
 */
export function getChatCompletionPreset(settings = oai_settings, { includeConnectionFields = true, clone = true } = {}) {
    const presetBody = {};
    for (const [presetKey, [, settingsKey]] of Object.entries(settingsToUpdate)) {
        if (!includeConnectionFields && isOpenAIConnectionPresetField(presetKey)) {
            continue;
        }
        if (isConnectionProfileOnlyPresetField(presetKey)) {
            continue;
        }
        presetBody[presetKey] = settings[settingsKey];
    }
    return clone ? structuredClone(presetBody) : presetBody;
}

function mergeStoredOpenAIPreset(targetPreset, presetBody) {
    const target = targetPreset && typeof targetPreset === 'object' ? targetPreset : {};
    const normalizedPresetBody = presetBody && typeof presetBody === 'object' ? presetBody : {};

    for (const key of Object.keys(settingsToUpdate)) {
        if (isConnectionProfileOnlyPresetField(key)) {
            continue;
        }
        if (!(key in normalizedPresetBody)) {
            delete target[key];
        }
    }

    Object.assign(target, normalizedPresetBody);
    return target;
}

/**
 * Persist a settings preset with the given name
 *
 * @param {string} name - Name of the preset
 * @param {Object} presetBody The preset body object
 * @param {boolean} triggerUi Whether the change event of preset UI element should be emitted
 * @returns {Promise<void>}
 */
async function saveOpenAIPresetBody(name, presetBody, triggerUi = true) {
    const saveResult = await persistPreset({
        apiId: 'openai',
        name,
        preset: presetBody,
    });

    if (!saveResult.ok) {
        toastr.error(t`Failed to save preset`);
        throw new Error('Failed to save preset');
    }

    const data = saveResult.data || { name };
    const existingName = findCanonicalNameInList(Object.keys(openai_setting_names || {}), data.name);
    if (existingName) {
        const value = openai_setting_names[existingName];
        openai_settings[value] = mergeStoredOpenAIPreset(openai_settings[value], structuredClone(presetBody));

        if (triggerUi) {
            oai_settings.preset_settings_openai = existingName;
            $(`#settings_preset_openai option[value="${value}"]`).prop('selected', true);
            $('#settings_preset_openai').trigger('change');
        }
        return;
    }

    const storedPresetBody = structuredClone(presetBody);
    openai_settings.push(storedPresetBody);
    openai_setting_names[data.name] = openai_settings.length - 1;
    const option = document.createElement('option');
    option.value = String(openai_settings.length - 1);
    option.innerText = data.name;
    if (triggerUi) {
        option.selected = true;
        $('#settings_preset_openai').append(option).trigger('change');
    } else {
        $('#settings_preset_openai').append(option);
    }
}

/**
 * Persist a settings preset with the given name
 *
 * @param {string} name - Name of the preset
 * @param {ChatCompletionSettings} settings The settings object
 * @param {boolean} triggerUi Whether the change event of preset UI element should be emitted
 * @returns {Promise<void>}
 */
async function saveOpenAIPreset(name, settings, triggerUi = true) {
    const presetBody = getChatCompletionPreset(settings, { clone: false, includeConnectionFields: false });
    await saveOpenAIPresetBody(name, presetBody, triggerUi);
}

function onLogitBiasPresetChange() {
    const value = String($('#openai_logit_bias_preset').find(':selected').val());
    const preset = oai_settings.bias_presets[value];

    if (!Array.isArray(preset)) {
        console.error('Preset not found');
        return;
    }

    oai_settings.bias_preset_selected = value;
    const list = $('.openai_logit_bias_list');
    list.empty();

    for (const entry of preset) {
        if (entry) {
            createLogitBiasListItem(entry);
        }
    }

    // Check if a sortable instance exists
    if (list.sortable('instance') !== undefined) {
        // Destroy the instance
        list.sortable('destroy');
    }

    // Make the list sortable
    list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: function () {
            const order = [];
            list.children().each(function () {
                order.unshift($(this).data('id'));
            });
            preset.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            console.log('Logit bias reordered:', preset);
            saveSettingsDebounced();
        },
    });

    biasCache = undefined;
    saveSettingsDebounced();
}


function createNewLogitBiasEntry() {
    const entry = { id: uuidv4(), text: '', value: 0 };
    oai_settings.bias_presets[oai_settings.bias_preset_selected].push(entry);
    biasCache = undefined;
    createLogitBiasListItem(entry);
    saveSettingsDebounced();
}

function createLogitBiasListItem(entry) {
    if (!entry.id) {
        entry.id = uuidv4();
    }
    const id = entry.id;
    const template = $('#openai_logit_bias_template .openai_logit_bias_form').clone();
    template.data('id', id);
    template.find('.openai_logit_bias_text').val(entry.text).on('input', function () {
        entry.text = String($(this).val());
        biasCache = undefined;
        saveSettingsDebounced();
    });
    template.find('.openai_logit_bias_value').val(entry.value).on('input', function () {
        const min = Number($(this).attr('min'));
        const max = Number($(this).attr('max'));
        let value = Number($(this).val());

        if (value < min) {
            $(this).val(min);
            value = min;
        }

        if (value > max) {
            $(this).val(max);
            value = max;
        }

        entry.value = value;
        biasCache = undefined;
        saveSettingsDebounced();
    });
    template.find('.openai_logit_bias_remove').on('click', function () {
        $(this).closest('.openai_logit_bias_form').remove();
        const preset = oai_settings.bias_presets[oai_settings.bias_preset_selected];
        const index = preset.findIndex(item => item.id === id);
        if (index >= 0) {
            preset.splice(index, 1);
        }
        onLogitBiasPresetChange();
    });
    $('.openai_logit_bias_list').prepend(template);
}

async function createNewLogitBiasPreset() {
    const name = await Popup.show.input(t`Preset name:`, null);

    if (!name) {
        return;
    }

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    oai_settings.bias_preset_selected = name;
    oai_settings.bias_presets[name] = [];

    addLogitBiasPresetOption(name);
    saveSettingsDebounced();
}

function addLogitBiasPresetOption(name) {
    const option = document.createElement('option');
    option.innerText = name;
    option.value = name;
    option.selected = true;

    $('#openai_logit_bias_preset').append(option);
    $('#openai_logit_bias_preset').trigger('change');
}

function onImportPresetClick() {
    $('#openai_preset_import_file').trigger('click');
}

function onLogitBiasPresetImportClick() {
    $('#openai_logit_bias_import_file').trigger('click');
}

async function onPresetImportFileChange(e) {
    const file = e.target.files[0];

    if (!file) {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await getFileText(file);
    let presetBody;
    e.target.value = '';

    try {
        presetBody = JSON.parse(importedFile);
    } catch (err) {
        toastr.error(t`Invalid file`);
        return;
    }

    if (name in openai_setting_names) {
        const confirm = await callGenericPopup('Preset name already exists. Overwrite?', POPUP_TYPE.CONFIRM);

        if (!confirm) {
            return;
        }
    }

    await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, { data: presetBody, presetName: name });

    await saveOpenAIPresetBody(name, presetBody, true);
}

async function onExportPresetClick() {
    const presetName = String(oai_settings.preset_settings_openai || '').trim();
    if (!presetName) {
        toastr.error(t`No preset selected`);
        return;
    }

    let preset = getOpenAIPresetByName(presetName);
    if (!preset) {
        await ensureFullSettingsLoaded();
        preset = getOpenAIPresetByName(presetName);
    }
    if (!preset || typeof preset !== 'object') {
        toastr.error(t`Failed to resolve preset for export`);
        return;
    }

    const presetBody = structuredClone(preset);
    await eventSource.emit(event_types.OAI_PRESET_EXPORT_READY, presetBody);
    const presetJsonString = JSON.stringify(presetBody, null, 4);
    const presetFileName = `${presetName}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onLogitBiasPresetImportFileChange(e) {
    const file = e.target.files[0];

    const isJsonFile = file && (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json'));
    if (!isJsonFile) {
        return;
    }

    const name = file.name.replace(/\.[^/.]+$/, '');
    const importedFile = await parseJsonFile(file);
    e.target.value = '';

    if (name in oai_settings.bias_presets) {
        toastr.error(t`Preset name should be unique.`);
        return;
    }

    if (!Array.isArray(importedFile)) {
        toastr.error(t`Invalid logit bias preset file.`);
        return;
    }

    const validEntries = [];

    for (const entry of importedFile) {
        if (typeof entry == 'object' && entry !== null) {
            if (Object.hasOwn(entry, 'text') &&
                Object.hasOwn(entry, 'value')) {
                if (!entry.id) {
                    entry.id = uuidv4();
                }
                validEntries.push(entry);
            }
        }
    }

    oai_settings.bias_presets[name] = validEntries;
    oai_settings.bias_preset_selected = name;

    addLogitBiasPresetOption(name);
    saveSettingsDebounced();
}

function onLogitBiasPresetExportClick() {
    if (!oai_settings.bias_preset_selected || Object.keys(oai_settings.bias_presets).length === 0) {
        return;
    }

    const presetJsonString = JSON.stringify(oai_settings.bias_presets[oai_settings.bias_preset_selected], null, 4);
    const presetFileName = `${oai_settings.bias_preset_selected}.json`;
    download(presetJsonString, presetFileName, 'application/json');
}

async function onDeletePresetClick() {
    const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    const nameToDelete = oai_settings.preset_settings_openai;
    const value = openai_setting_names[oai_settings.preset_settings_openai];
    const presetBodyToDelete = structuredClone(openai_settings[value] || {});
    $(`#settings_preset_openai option[value="${value}"]`).remove();
    delete openai_setting_names[oai_settings.preset_settings_openai];
    oai_settings.preset_settings_openai = null;

    if (Object.keys(openai_setting_names).length) {
        oai_settings.preset_settings_openai = Object.keys(openai_setting_names)[0];
        const newValue = openai_setting_names[oai_settings.preset_settings_openai];
        $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
        $('#settings_preset_openai').trigger('change');
    }

    const response = await fetch('/api/presets/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
    });

    if (!response.ok) {
        toastr.warning(t`Preset was not deleted from server`);
    } else {
        if (!presetBodyToDelete || typeof presetBodyToDelete !== 'object' || !Object.keys(presetBodyToDelete).length) {
            toastr.success(t`Preset deleted`);
            await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
            await deleteAllPresetState({ apiId: 'openai', name: nameToDelete });
            await maybeDeleteLinkedLorebookForPresetDeletion({ presetName: nameToDelete, extensions: presetBodyToDelete.extensions });
        } else {
            showUndoToast({
                message: t`Preset deleted`,
                onUndo: async () => {
                    try {
                        await saveOpenAIPreset(nameToDelete, structuredClone(presetBodyToDelete), true);
                    } catch (error) {
                        console.error('Failed to restore deleted OpenAI preset', error);
                        toastr.error(t`Failed to restore preset.`);
                    }
                },
                onCommit: async () => {
                    await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
                    await deleteAllPresetState({ apiId: 'openai', name: nameToDelete });
                    await maybeDeleteLinkedLorebookForPresetDeletion({ presetName: nameToDelete, extensions: presetBodyToDelete.extensions });
                },
            });
        }
    }

    saveSettingsDebounced(0, { directSave: true });
}

async function onLogitBiasPresetDeleteClick() {
    const value = await callGenericPopup(t`Delete the preset?`, POPUP_TYPE.CONFIRM);

    if (!value) {
        return;
    }

    $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).remove();
    delete oai_settings.bias_presets[oai_settings.bias_preset_selected];
    oai_settings.bias_preset_selected = null;

    if (Object.keys(oai_settings.bias_presets).length) {
        oai_settings.bias_preset_selected = Object.keys(oai_settings.bias_presets)[0];
        $(`#openai_logit_bias_preset option[value="${oai_settings.bias_preset_selected}"]`).prop('selected', true);
        $('#openai_logit_bias_preset').trigger('change');
    }

    biasCache = undefined;
    saveSettingsDebounced();
}

function getComparableOpenAIPresetBody(presetBody, fallbackSettings = oai_settings) {
    const excludedKeys = new Set(['extensions']);
    const comparable = {};
    const normalizedPresetBody = presetBody && typeof presetBody === 'object' ? presetBody : {};

    for (const [presetKey, [, settingKey, , isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection || excludedKeys.has(presetKey)) {
            continue;
        }

        if (normalizedPresetBody[presetKey] !== undefined) {
            comparable[presetKey] = structuredClone(normalizedPresetBody[presetKey]);
        } else {
            comparable[presetKey] = structuredClone(fallbackSettings?.[settingKey]);
        }
    }

    return comparable;
}

function canonicalizeComparableOpenAIPresetValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeComparableOpenAIPresetValue);
    }
    if (value && typeof value === 'object' && value.constructor === Object) {
        const canonical = {};
        for (const key of Object.keys(value).sort()) {
            canonical[key] = canonicalizeComparableOpenAIPresetValue(value[key]);
        }
        return canonical;
    }
    return value;
}

function normalizePromptEntryForUnsavedCheck(prompt, index) {
    const source = prompt && typeof prompt === 'object' ? prompt : {};
    const normalizedIdentifier = String(source.identifier ?? '').trim();

    const normalizeNumber = (value, fallback) => {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : fallback;
    };

    const normalizedTriggers = Array.isArray(source.injection_trigger)
        ? Array.from(new Set(source.injection_trigger.map(trigger => String(trigger))))
            .sort((a, b) => a.localeCompare(b))
        : [];

    return {
        identifier: normalizedIdentifier,
        name: String(source.name ?? ''),
        role: String(source.role ?? ''),
        content: String(source.content ?? ''),
        system_prompt: Boolean(source.system_prompt),
        marker: Boolean(source.marker),
        injection_position: normalizeNumber(source.injection_position, 0),
        injection_depth: normalizeNumber(source.injection_depth, 4),
        injection_order: normalizeNumber(source.injection_order, 100),
        injection_trigger: normalizedTriggers,
        forbid_overrides: Boolean(source.forbid_overrides),
        plugin_extra: Boolean(source.plugin_extra),
        extension: Boolean(source.extension),
        _index: index,
    };
}

function normalizePromptsForUnsavedCheck(prompts) {
    if (!Array.isArray(prompts)) {
        return [];
    }

    return prompts
        .map((prompt, index) => normalizePromptEntryForUnsavedCheck(prompt, index))
        .filter(prompt => prompt.identifier.length > 0)
        .sort((a, b) => {
            const byIdentifier = a.identifier.localeCompare(b.identifier);
            if (byIdentifier !== 0) {
                return byIdentifier;
            }
            return a._index - b._index;
        })
        .map(({ _index, ...prompt }) => prompt);
}

function normalizePromptOrderForUnsavedCheck(promptOrder) {
    if (!Array.isArray(promptOrder)) {
        return [];
    }

    return promptOrder
        .map((entry, index) => {
            const source = entry && typeof entry === 'object' ? entry : {};
            const characterId = String(source.character_id ?? '').trim();
            const normalizedOrder = Array.isArray(source.order)
                ? source.order
                    .map(item => ({
                        identifier: String(item?.identifier ?? '').trim(),
                        enabled: Boolean(item?.enabled),
                    }))
                    .filter(item => item.identifier.length > 0)
                : [];

            return {
                character_id: characterId,
                order: normalizedOrder,
                _index: index,
            };
        })
        .filter(entry => entry.character_id.length > 0)
        .sort((a, b) => {
            const byCharacter = a.character_id.localeCompare(b.character_id);
            if (byCharacter !== 0) {
                return byCharacter;
            }
            return a._index - b._index;
        })
        .map(({ _index, ...entry }) => entry);
}

function normalizeComparableOpenAIPresetBodyTypes(body) {
    const normalized = body && typeof body === 'object' ? structuredClone(body) : {};

    for (const [presetKey, [, settingKey, isCheckbox]] of Object.entries(settingsToUpdate)) {
        if (!(presetKey in normalized)) {
            continue;
        }

        const value = normalized[presetKey];
        if (presetKey === 'prompts') {
            normalized[presetKey] = normalizePromptsForUnsavedCheck(value);
            continue;
        }
        if (presetKey === 'prompt_order') {
            normalized[presetKey] = normalizePromptOrderForUnsavedCheck(value);
            continue;
        }
        if (isCheckbox) {
            normalized[presetKey] = Boolean(value);
            continue;
        }

        const currentValue = oai_settings?.[settingKey];
        if (typeof currentValue === 'number') {
            const numericValue = Number(value);
            if (Number.isFinite(numericValue)) {
                normalized[presetKey] = numericValue;
            }
            continue;
        }

        if (typeof currentValue === 'string' && value !== null && value !== undefined && typeof value !== 'string') {
            normalized[presetKey] = String(value);
        }
    }

    return normalized;
}

export function areComparableOpenAIPresetBodiesEqual(leftPresetBody, rightPresetBody) {
    const leftComparableBody = getComparableOpenAIPresetBody(leftPresetBody);
    const rightComparableBody = getComparableOpenAIPresetBody(rightPresetBody);
    const canonicalLeft = canonicalizeComparableOpenAIPresetValue(normalizeComparableOpenAIPresetBodyTypes(leftComparableBody));
    const canonicalRight = canonicalizeComparableOpenAIPresetValue(normalizeComparableOpenAIPresetBodyTypes(rightComparableBody));
    return JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight);
}

function hasUnsavedOpenAIPresetChanges(presetName) {
    const normalizedName = String(presetName || '').trim();
    if (!normalizedName) {
        return false;
    }

    const presetIndex = openai_setting_names?.[normalizedName];
    if (!Number.isInteger(presetIndex)) {
        return false;
    }

    const savedPresetBody = openai_settings?.[presetIndex];
    if (!savedPresetBody || typeof savedPresetBody !== 'object') {
        return false;
    }

    return !areComparableOpenAIPresetBodiesEqual(getChatCompletionPreset(oai_settings, { clone: false }), savedPresetBody);
}

async function confirmOpenAIPresetSwitch(presetNameBefore) {
    const popupResult = await callGenericPopup(
        `${t`You have unsaved changes in the current preset.`}\n${String(presetNameBefore || '')}`,
        POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: t`Save and switch preset`,
            cancelButton: t`Discard and switch preset`,
            customButtons: [{ text: t`Cancel`, result: POPUP_RESULT.CANCELLED, appendAtEnd: true }],
        },
    );

    if (popupResult === POPUP_RESULT.CANCELLED || popupResult === null) {
        return false;
    }

    if (popupResult === POPUP_RESULT.AFFIRMATIVE) {
        await saveOpenAIPreset(presetNameBefore, oai_settings, false);
    }

    return true;
}

// Load OpenAI preset settings
async function onSettingsPresetChange(event) {
    const presetNameBefore = oai_settings.preset_settings_openai;
    const previousSelectValue = lastOpenAIPresetSelectValue;
    const currentSelectValue = String($('#settings_preset_openai').val() ?? '');
    const wasCharacterBoundPreset = previousSelectValue === characterBoundPresetState.runtimeOptionValue;
    const selectedOption = $('#settings_preset_openai').find(':selected');
    const usingCharacterBoundPreset = selectedOption.attr('data-luker-char-bound') === '1';
    const presetName = selectedOption.text();

    if (Boolean(event?.originalEvent) && !wasCharacterBoundPreset && !usingCharacterBoundPreset && presetNameBefore && presetName !== presetNameBefore && hasUnsavedOpenAIPresetChanges(presetNameBefore)) {
        try {
            const shouldSwitch = await confirmOpenAIPresetSwitch(presetNameBefore);
            if (!shouldSwitch) {
                if (previousSelectValue) {
                    $('#settings_preset_openai').val(previousSelectValue);
                }
                return;
            }
        } catch (error) {
            console.error('Failed to resolve unsaved preset switch confirmation', error);
            if (previousSelectValue) {
                $('#settings_preset_openai').val(previousSelectValue);
            }
            return;
        }
    }

    if (!usingCharacterBoundPreset) {
        oai_settings.preset_settings_openai = presetName;
    }
    let preset = usingCharacterBoundPreset
        ? structuredClone(characterBoundPresetState.runtimePresetBody || {})
        : structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);
    if (!usingCharacterBoundPreset && (!preset || typeof preset !== 'object')) {
        await ensureFullSettingsLoaded();
        preset = structuredClone(openai_settings[openai_setting_names[oai_settings.preset_settings_openai]]);
    }
    updateCharacterBoundPresetBadge(usingCharacterBoundPreset);

    if (!preset || typeof preset !== 'object') {
        lastOpenAIPresetSelectValue = currentSelectValue;
        return;
    }

    migrateChatCompletionSettings(preset);

    const updateInput = (selector, value) => $(selector).val(value);
    const updateCheckbox = (selector, value) => $(selector).prop('checked', value);

    // Allow subscribers to alter the preset before applying deltas
    try {
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
            preset: preset,
            presetName: presetName,
            settingsToUpdate: settingsToUpdate,
            settings: oai_settings,
            savePreset: saveOpenAIPreset,
            presetNameBefore: presetNameBefore,
        });
    } finally {
        for (const [key, [selector, setting, isCheckbox, isConnection]] of Object.entries(settingsToUpdate)) {
            if (isConnectionProfileOnlyPresetField(key)) {
                continue;
            }
            if (isConnection) {
                // Luker decouples chat-completion presets from API connection/profile state.
                continue;
            }

            // Extensions don't need UI updates and shouldn't fallback to current settings
            if (key === 'extensions') {
                oai_settings.extensions = preset.extensions || {};
                continue;
            }

            if (preset[key] !== undefined) {
                oai_settings[setting] = preset[key];
                // Mirror the preset-body key onto oai_settings as well when it
                // differs from the runtime settings key (e.g. preset body uses
                // `temperature`, runtime uses `temp_openai`). Without this,
                // reads via the preset-body alias return whatever the previous
                // session left behind, which can disagree with the active
                // preset after a switch-away/back cycle.
                if (key !== setting) {
                    oai_settings[key] = preset[key];
                }

                if (!selector || selector === '#NULL_SELECTOR') {
                    continue;
                }

                if (isCheckbox) {
                    updateCheckbox(selector, preset[key]);
                } else {
                    updateInput(selector, preset[key]);
                }
            }
        }

        // These cannot be changed via preset if unbound to connection
        if (oai_settings.bind_preset_to_connection) {
            $('#chat_completion_source').trigger('change');
            $('#openrouter_providers_chat').trigger('change');
            $('#openrouter_quantizations_chat').trigger('change');
            $('#nanogpt_provider').trigger('change');
        }

        await syncOpenAIPresetUiAfterApply();
        saveSettingsDebounced(0, { directSave: true });
        scheduleOpenAIPresetChangeNotifications(presetName);
    }

    lastOpenAIPresetSelectValue = String($('#settings_preset_openai').val() ?? currentSelectValue);
}

/**
 * Get the maximum context size for the OpenAI model
 * @param {string} value Model identifier
 * @returns {number} Maximum context size in tokens
 */
function getMaxContextOpenAI(value) {
    if (oai_settings.max_context_unlocked) {
        return unlocked_max;
    }

    /** @type {[RegExp, number][]} */
    const contextMap = [
        [/^gpt-5\.[45]/, max_1mil],
        [/^gpt-5/, max_400k],
        [/gpt-4\.1/, max_1mil],
        [/gpt-audio/, max_128k],
        [/^o1/, max_128k],
        [/^o[34]/, max_200k],
        [/chatgpt-4o-latest|gpt-4-turbo|gpt-4o|gpt-4-1106|gpt-4-0125|gpt-4-vision/, max_128k],
        [/gpt-3\.5-turbo-1106/, max_16k],
        [/^(gpt-4|gpt-4-0314|gpt-4-0613)$/, max_8k],
        [/^(gpt-4-32k|gpt-4-32k-0314|gpt-4-32k-0613)$/, max_32k],
        [/gpt-realtime/, max_32k],
        [/^(gpt-3\.5-turbo-16k|gpt-3\.5-turbo-16k-0613)$/, max_16k],
        [/^code-davinci-002$/, max_8k],
        [/^(text-curie-001|text-babbage-001|text-ada-001)$/, max_2k],
        [/gpt-3/, max_4k],
    ];

    for (const [regex, max] of contextMap) {
        if (regex.test(value)) {
            return max;
        }
    }

    // Safe default for most modern models
    return max_128k;
}

/**
 * Get the maximum context size for Gemini models based on model identifier and optional model list.
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getGeminiMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const contextLength = model_list.find((record) => record.id === model)?.inputTokenLimit;
        if (Number.isFinite(contextLength) && contextLength > 0) {
            return contextLength;
        }
    }

    /** @type {[RegExp, number][]} */
    const contextMap = [
        [/gemini-2\.5-flash-image/, max_32k],
        [/gemini-3-pro-image/, max_64k],
        [/gemini-(?:3[.\d]*|2\.(?:5|0))-(pro|flash)/, max_1mil],
        [/(gemini-exp|learnlm-2\.0-flash|gemini-robotics)/, max_1mil],
        [/gemma-3-27b-it/, max_128k],
        [/gemma-3n-e4b-it/, max_8k],
        [/gemma-3/, max_32k],
        [/gemma-4/, max_256k],
    ];

    for (const [regex, max] of contextMap) {
        if (regex.test(model)) {
            return max;
        }
    }

    return max_128k;
}

/**
 * Get the maximum temperature for Gemini models based on model identifier and optional model list.
 * @param {string} model Model identifier
 * @returns {number} Maximum temperature for Gemini models
 */
function getGeminiMaxTemp(model) {
    if (Array.isArray(model_list) && model_list.length > 0) {
        const temp = model_list.find((record) => record.id === model)?.maxTemperature;
        if (Number.isFinite(temp) && temp > 0) {
            return temp;
        }
    }

    if (/(vision|ultra|gemma)/.test(model)) {
        return 1.0;
    }

    return 2.0;
}

/**
 * Get the maximum context size for the Mistral model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getMistralMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const contextLength = model_list.find((record) => record.id === model)?.max_context_length;
        if (contextLength) {
            return contextLength;
        }
    }

    // Return context size if model found, otherwise default to 32k
    return max_32k;
}

/**
 * Get the maximum context size for the Groq model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getGroqMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const contextLength = model_list.find((record) => record.id === model)?.context_window;
        if (contextLength) {
            return contextLength;
        }
    }

    const contextMap = {
        'gemma2-9b-it': max_8k,
        'llama-3.3-70b-versatile': max_128k,
        'llama-3.1-8b-instant': max_128k,
        'llama3-70b-8192': max_8k,
        'llama3-8b-8192': max_8k,
        'llama-guard-3-8b': max_8k,
        'mixtral-8x7b-32768': max_32k,
        'deepseek-r1-distill-llama-70b': max_128k,
        'llama-3.3-70b-specdec': max_8k,
        'llama-3.2-1b-preview': max_128k,
        'llama-3.2-3b-preview': max_128k,
        'llama-3.2-11b-vision-preview': max_128k,
        'llama-3.2-90b-vision-preview': max_128k,
        'qwen-2.5-32b': max_128k,
        'deepseek-r1-distill-qwen-32b': max_128k,
        'deepseek-r1-distill-llama-70b-specdec': max_128k,
        'mistral-saba-24b': max_32k,
        'meta-llama/llama-4-scout-17b-16e-instruct': max_128k,
        'meta-llama/llama-4-maverick-17b-128e-instruct': max_128k,
        'compound-beta': max_128k,
        'compound-beta-mini': max_128k,
        'qwen/qwen3-32b': max_128k,
    };

    // Return context size if model found, otherwise default to 128k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_128k;
}

/**
 * Get the maximum context size for the Z.AI model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked If context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getZaiMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    const contextMap = {
        'glm-5.1': max_200k,
        'glm-5-turbo': max_200k,
        'glm-5v-turbo': max_200k,
        'glm-5': max_200k,
        'glm-4.7': max_200k,
        'glm-4.7-flash': max_200k,
        'glm-4.7-flashx': max_200k,
        'glm-4.6v': max_128k,
        'glm-4.6v-flash': max_128k,
        'glm-4.6v-flashx': max_128k,
        'glm-4.6': max_200k,
        'glm-4.5': max_128k,
        'glm-4-32b-0414-128k': max_128k,
        'glm-4.5-air': max_128k,
        'glm-4.5v': max_64k,
        'autoglm-phone-multilingual': max_64k,
    };

    // Return context size if model found, otherwise default to 128k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_128k;
}

/**
 * Get the maximum context size for the SiliconFlow model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getSiliconflowMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    const contextMap = {
        'baidu/ERNIE-4.5-300B-A47B': max_128k,
        'ByteDance-Seed/Seed-OSS-36B-Instruct': max_256k,
        'deepseek-ai/DeepSeek-R1': max_128k,
        'deepseek-ai/DeepSeek-V3': max_128k,
        'deepseek-ai/DeepSeek-V3.1': max_128k,
        'deepseek-ai/DeepSeek-V3.1-Terminus': max_128k,
        'deepseek-ai/DeepSeek-V3.2-Exp': max_128k,
        'deepseek-ai/deepseek-vl2': max_4k,
        'inclusionAI/Ling-1T': max_128k,
        'inclusionAI/Ling-flash-2.0': max_128k,
        'inclusionAI/Ling-mini-2.0': max_128k,
        'inclusionAI/Ring-1T': max_128k,
        'inclusionAI/Ring-flash-2.0': max_128k,
        'meta-llama/Llama-3.3-70B-Instruct': max_32k,
        'meta-llama/Meta-Llama-3.1-8B-Instruct': max_32k,
        'MiniMaxAI/MiniMax-M1-80k': max_128k,
        'MiniMaxAI/MiniMax-M2': max_128k,
        'moonshotai/Kimi-K2-Instruct': max_128k,
        'moonshotai/Kimi-K2-Instruct-0905': max_256k,
        'moonshotai/Kimi-K2-Thinking': max_256k,
        'openai/gpt-oss-120b': max_128k,
        'openai/gpt-oss-20b': max_128k,
        'Qwen/Qwen3-235B-A22B-Instruct-2507': max_256k,
        'Qwen/Qwen3-235B-A22B-Thinking-2507': max_256k,
        'Qwen/Qwen3-30B-A3B-Instruct-2507': max_256k,
        'Qwen/Qwen3-30B-A3B-Thinking-2507': max_256k,
        'Qwen/Qwen3-VL-235B-A22B-Instruct': max_256k,
        'Qwen/Qwen3-VL-235B-A22B-Thinking': max_256k,
        'Qwen/Qwen3-VL-30B-A3B-Instruct': max_256k,
        'Qwen/Qwen3-VL-30B-A3B-Thinking': max_256k,
        'Qwen/Qwen3-VL-32B-Instruct': max_256k,
        'Qwen/Qwen3-VL-32B-Thinking': max_256k,
        'Qwen/Qwen3-VL-8B-Instruct': max_256k,
        'Qwen/Qwen3-VL-8B-Thinking': max_256k,
        'stepfun-ai/step3': max_64k,
        'tencent/Hunyuan-A13B-Instruct': max_128k,
        'zai-org/GLM-4.5': max_128k,
        'zai-org/GLM-4.5-Air': max_128k,
        'zai-org/GLM-4.5V': max_64k,
        'zai-org/GLM-4.6': max_200k,
    };

    // Return context size if model found, otherwise default to 32k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_32k;
}

/**
 * Get the maximum context size for the Moonshot model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked If context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getMoonshotMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list) && model_list.length > 0) {
        const modelInfo = model_list.find((record) => record.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }

    const contextMap = {
        'moonshot-v1-8k': max_8k,
        'moonshot-v1-32k': max_32k,
        'moonshot-v1-128k': max_128k,
        'moonshot-v1-auto': max_128k,
        'moonshot-v1-8k-vision-preview': max_8k,
        'moonshot-v1-32k-vision-preview': max_32k,
        'moonshot-v1-128k-vision-preview': max_128k,
        'kimi-k2-0711-preview': max_32k,
        'kimi-latest': max_256k,
        'kimi-thinking-preview': max_32k,
        'kimi-k2.5': max_256k,
        'kimi-k2-0905-preview': max_256k,
        'kimi-k2-turbo-preview': max_256k,
        'kimi-k2-thinking': max_256k,
        'kimi-k2-thinking-turbo': max_256k,
    };

    // Return context size if model found, otherwise default to 32k
    return Object.entries(contextMap).find(([key]) => model.includes(key))?.[1] || max_32k;
}

/**
 * Get the maximum context size for the Fireworks model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getFireworksMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    // First check if model info is available from model_list
    if (Array.isArray(model_list) && model_list.length > 0) {
        const modelInfo = model_list.find((record) => record.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
        if (modelInfo?.context_window) {
            return modelInfo.context_window;
        }
    }

    return max_32k;
}

/**
 * Get the maximum context size for the Chutes model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getChutesMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }
    return max_8k;
}

/**
 * Get the maximum context size for the ElectronHub model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getElectronHubMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.tokens) {
            return modelInfo.tokens;
        }
    }
    return max_128k;
}

/**
 * Get the maximum context size for the NanoGPT model
 * @param {string} model Model identifier
 * @param {boolean} isUnlocked Whether context limits are unlocked
 * @returns {number} Maximum context size in tokens
 */
function getNanoGptMaxContext(model, isUnlocked) {
    if (isUnlocked) {
        return unlocked_max;
    }

    if (Array.isArray(model_list)) {
        const modelInfo = model_list.find(m => m.id === model);
        if (modelInfo?.context_length) {
            return modelInfo.context_length;
        }
    }

    return max_128k;
}

async function onModelChange() {
    biasCache = undefined;
    let value = String($(this).val() || '');

    // Skip setting the context size for sources that get it from external APIs
    const hasModelsLoaded = Array.isArray(model_list) && model_list.length > 0;

    if ($(this).is('#model_openai_select')) {
        console.log('OpenAI model picked from list:', value);
        if (value) {
            $('#openai_model_id').val(value).trigger('input');
        }
    }

    if ($(this).is('#model_openrouter_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null OR model selected. Ignoring.');
            return;
        }

        console.log('OpenRouter model changed to', value);
        oai_settings.openrouter_model = value;
        syncOpenRouterProvidersForModel(value, '#openrouter_providers_chat');
    }

    if ($(this).is('#model_ai21_select')) {
        if (value === '' || value.startsWith('j2-')) {
            value = 'jamba-large';
            $('#model_ai21_select').val(value);
        }

        console.log('AI21 model changed to', value);
        oai_settings.ai21_model = value;
    }

    if ($(this).is('#model_google_select')) {
        if (!value) {
            console.debug('Null Google model selected. Ignoring.');
            return;
        }

        console.log('Google model picked from list:', value);
        $('#google_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_vertexai_select')) {
        if (!value) {
            console.debug('Null Vertex AI model selected. Ignoring.');
            return;
        }
        console.log('Vertex AI model picked from list:', value);
        $('#vertexai_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_mistralai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null MistralAI model selected. Ignoring.');
            return;
        }
        console.log('MistralAI model picked from list:', value);
        $('#mistralai_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_cohere_select')) {
        console.log('Cohere model changed to', value);
        oai_settings.cohere_model = value;
    }

    if ($(this).is('#model_perplexity_select')) {
        console.log('Perplexity model changed to', value);
        oai_settings.perplexity_model = value;
    }

    if ($(this).is('#model_groq_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Groq model selected. Ignoring.');
            return;
        }
        console.log('Groq model changed to', value);
        oai_settings.groq_model = value;
    }

    if ($(this).is('#model_siliconflow_select')) {
        if (!value) {
            console.debug('Null SiliconFlow model selected. Ignoring.');
            return;
        }
        console.log('SiliconFlow model changed to', value);
        oai_settings.siliconflow_model = value;
    }

    if ($(this).is('#model_minimax_select')) {
        if (!value) {
            console.debug('Null MiniMax model selected. Ignoring.');
            return;
        }
        console.log('MiniMax model changed to', value);
        oai_settings.minimax_model = value;
    }

    if ($(this).is('#model_electronhub_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null ElectronHub model selected. Ignoring.');
            return;
        }
        console.log('ElectronHub model changed to', value);
        oai_settings.electronhub_model = value;
    }

    if ($(this).is('#model_chutes_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Chutes model selected. Ignoring.');
            return;
        }
        console.log('Chutes model changed to', value);
        oai_settings.chutes_model = value;
    }

    if ($(this).is('#model_nanogpt_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null NanoGPT model selected. Ignoring.');
            return;
        }

        console.log('NanoGPT model changed to', value);
        oai_settings.nanogpt_model = value;
        syncNanoGptProvidersForModel(value, '#nanogpt_provider');
    }

    if ($(this).is('#model_deepseek_select')) {
        if (!value) {
            console.debug('Null DeepSeek model selected. Ignoring.');
            return;
        }

        console.log('DeepSeek model picked from list:', value);
        $('#deepseek_model_id').val(value).trigger('input');
    }

    if (value && $(this).is('#model_custom_select')) {
        console.log('Custom model picked from list:', value);
        $('#custom_model_id').val(value).trigger('input');
    }

    if (value && $(this).is('#model_claude_select')) {
        console.log('Claude model picked from list:', value);
        $('#claude_model_id').val(value).trigger('input');
    }

    if (value && $(this).is('#model_pollinations_select')) {
        console.log('Pollinations model changed to', value);
        oai_settings.pollinations_model = value;
    }

    if ($(this).is('#model_aimlapi_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null AI/ML model selected. Ignoring.');
            return;
        }
        console.log('AI/ML model changed to', value);
        oai_settings.aimlapi_model = value;
    }

    if ($(this).is('#model_xai_select')) {
        if (!value) {
            console.debug('Null XAI model selected. Ignoring.');
            return;
        }
        console.log('XAI model picked from list:', value);
        $('#xai_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_moonshot_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Moonshot model selected. Ignoring.');
            return;
        }
        console.log('Moonshot model picked from list:', value);
        $('#moonshot_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_fireworks_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Fireworks model selected. Ignoring.');
            return;
        }
        console.log('Fireworks model changed to', value);
        oai_settings.fireworks_model = value;
    }

    if ($(this).is('#model_cometapi_select')) {
        if (!value) {
            console.debug('Null CometAPI model selected. Ignoring.');
            return;
        }
        console.log('CometAPI model changed to', value);
        oai_settings.cometapi_model = value;
    }

    if ($(this).is('#azure_openai_model')) {
        if (!value) {
            console.debug('Null Azure OpenAI model selected. Ignoring.');
            return;
        }
        oai_settings.azure_openai_model = value;
    }

    if ($(this).is('#model_zai_select')) {
        if (!value) {
            console.debug('Null ZAI model selected. Ignoring.');
            return;
        }
        console.log('ZAI model picked from list:', value);
        $('#zai_model_id').val(value).trigger('input');
    }

    if ($(this).is('#model_workers_ai_select')) {
        if (!value || !hasModelsLoaded) {
            console.debug('Null Workers AI model selected. Ignoring.');
            return;
        }
        console.log('Workers AI model changed to', value);
        oai_settings.workers_ai_model = value;
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI].includes(oai_settings.chat_completion_source)) {
        const contextSize = getGeminiMaxContext(value, oai_settings.max_context_unlocked);
        const maxTemp = getGeminiMaxTemp(value);
        $('#openai_max_context').attr('max', contextSize);
        oai_settings.temp_openai = Math.min(maxTemp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', maxTemp).val(oai_settings.temp_openai).trigger('input');
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else {
            const model = model_list.find(m => m.id == oai_settings.openrouter_model);
            if (model?.context_length) {
                $('#openai_max_context').attr('max', model.context_length);
            } else {
                $('#openai_max_context').attr('max', max_128k);
            }
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');

        if (value && (value.includes('claude') || value.includes('palm-2'))) {
            oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
            $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
        } else {
            oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
            $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
        }

        calculateOpenRouterCost();
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (/^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7)/.test(value)) {
            $('#openai_max_context').attr('max', max_1mil);
        } else if (/^claude-(3|opus|haiku|sonnet)/.test(value)) {
            $('#openai_max_context').attr('max', max_200k);
        } else {
            $('#openai_max_context').attr('max', max_200k);
        }

        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');

        $('#openai_reverse_proxy').attr('placeholder', 'https://api.anthropic.com/v1');

        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if ([chat_completion_sources.AZURE_OPENAI, chat_completion_sources.OPENAI].includes(oai_settings.chat_completion_source)) {
        $('#openai_max_context').attr('max', getMaxContextOpenAI(value));
        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');

        $('#openai_reverse_proxy').attr('placeholder', 'https://api.openai.com/v1');

        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        const maxContext = getMistralMaxContext(oai_settings.mistralai_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(oai_settings.openai_max_context, Number($('#openai_max_context').attr('max')));
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(mistral_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', mistral_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COHERE) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (['command-light-nightly', 'command-light', 'command'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_4k);
        } else if (oai_settings.cohere_model.includes('command-r') || ['c4ai-aya-23', 'c4ai-aya-expanse-32b', 'command-nightly', 'command-a-vision-07-2025'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_128k);
        } else if (['command-a-03-2025'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_256k);
        } else if (['c4ai-aya-23-8b', 'c4ai-aya-expanse-8b'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_8k);
        } else if (['c4ai-aya-vision-8b', 'c4ai-aya-vision-32b'].includes(oai_settings.cohere_model)) {
            $('#openai_max_context').attr('max', max_16k);
        } else {
            $('#openai_max_context').attr('max', max_4k);
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (['sonar', 'sonar-reasoning', 'sonar-reasoning-pro', 'r1-1776'].includes(oai_settings.perplexity_model)) {
            $('#openai_max_context').attr('max', 127000);
        } else if (['sonar-pro'].includes(oai_settings.perplexity_model)) {
            $('#openai_max_context').attr('max', 200000);
        } else if (oai_settings.perplexity_model.includes('llama-3.1')) {
            const isOnline = oai_settings.perplexity_model.includes('online');
            const contextSize = isOnline ? 128 * 1024 - 4000 : 128 * 1024;
            $('#openai_max_context').attr('max', contextSize);
        } else {
            $('#openai_max_context').attr('max', max_128k);
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.GROQ) {
        const maxContext = getGroqMaxContext(oai_settings.groq_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (oai_settings.ai21_model.startsWith('jamba-')) {
            $('#openai_max_context').attr('max', max_256k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        $('#openai_max_context').attr('max', unlocked_max);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        const maxContext = getChutesMaxContext(oai_settings.chutes_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');

        calculateChutesCost();
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        const maxContext = getElectronHubMaxContext(oai_settings.electronhub_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');

        calculateElectronHubCost();
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.NANOGPT) {
        const maxContext = getNanoGptMaxContext(oai_settings.nanogpt_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else {
            $('#openai_max_context').attr('max', max_128k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
        const maxContext = oai_settings.max_context_unlocked ? unlocked_max : max_1mil;
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.WORKERS_AI) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else {
            const model = model_list.find(m => m.id === oai_settings.workers_ai_model);
            const ctxProp = Array.isArray(model?.properties) && model.properties.find(p => p.property_id === 'context_window');
            const contextLength = ctxProp ? Number(ctxProp.value) : max_8k;
            $('#openai_max_context').attr('max', contextLength || max_8k);
        }
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        const workersAiMaxTemp = 5.0;
        oai_settings.temp_openai = Math.min(workersAiMaxTemp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', workersAiMaxTemp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COMETAPI) {
        $('#openai_max_context').attr('max', oai_settings.max_context_unlocked ? unlocked_max : max_128k);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.XAI) {
        if (oai_settings.max_context_unlocked) {
            $('#openai_max_context').attr('max', unlocked_max);
        } else if (oai_settings.xai_model.includes('grok-2-vision')) {
            $('#openai_max_context').attr('max', max_32k);
        } else if (oai_settings.xai_model.includes('grok-4-fast')) {
            $('#openai_max_context').attr('max', max_2mil);
        } else if (oai_settings.xai_model.includes('grok-4')) {
            $('#openai_max_context').attr('max', max_256k);
        } else if (oai_settings.xai_model.includes('grok-code')) {
            $('#openai_max_context').attr('max', max_256k);
        } else {
            // grok 2 and grok 3
            $('#openai_max_context').attr('max', max_128k);
        }

        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.AIMLAPI) {
        let maxContext;
        if (oai_settings.max_context_unlocked) {
            maxContext = unlocked_max;
        } else {
            const model = model_list.find(m => m.id === oai_settings.aimlapi_model);
            maxContext = (model?.info?.contextLength ?? model?.context_length) || max_32k;
            console.log('[AI/ML API] Model CTX:', model?.info?.contextLength);
        }

        $('#openai_max_context')
            .prop('max', maxContext)
            .val(Math.min(Number(oai_settings.openai_max_context), maxContext))
            .trigger('input');

        $('#temp_openai')
            .prop('max', oai_max_temp)
            .val(Number(oai_settings.temp_openai))
            .trigger('input');

        oai_settings.openai_max_context = Number($('#openai_max_context').val());
        oai_settings.temp_openai = Number($('#temp_openai').val());
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.COHERE) {
        oai_settings.pres_pen_openai = Math.min(Math.max(0, oai_settings.pres_pen_openai), 1);
        $('#pres_pen_openai').attr('max', 1).attr('min', 0).val(oai_settings.pres_pen_openai).trigger('input');
        oai_settings.freq_pen_openai = Math.min(Math.max(0, oai_settings.freq_pen_openai), 1);
        $('#freq_pen_openai').attr('max', 1).attr('min', 0).val(oai_settings.freq_pen_openai).trigger('input');
    } else {
        $('#pres_pen_openai').attr('max', 2).attr('min', -2).val(oai_settings.pres_pen_openai).trigger('input');
        $('#freq_pen_openai').attr('max', 2).attr('min', -2).val(oai_settings.freq_pen_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MOONSHOT) {
        const maxContext = getMoonshotMaxContext(oai_settings.moonshot_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.FIREWORKS) {
        const maxContext = getFireworksMaxContext(oai_settings.fireworks_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.SILICONFLOW) {
        const maxContext = getSiliconflowMaxContext(oai_settings.siliconflow_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(oai_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', oai_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.MINIMAX) {
        const maxContext = oai_settings.minimax_model === 'M2-her' ? 65536 : 204800;
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        const maxContext = getZaiMaxContext(oai_settings.zai_model, oai_settings.max_context_unlocked);
        $('#openai_max_context').attr('max', maxContext);
        oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
        $('#openai_max_context').val(oai_settings.openai_max_context).trigger('input');
        oai_settings.temp_openai = Math.min(claude_max_temp, oai_settings.temp_openai);
        $('#temp_openai').attr('max', claude_max_temp).val(oai_settings.temp_openai).trigger('input');
    }

    $('#openai_max_context_counter').attr('max', Number($('#openai_max_context').attr('max')));

    saveSettingsDebounced();
    updateFeatureSupportFlags();
    eventSource.emit(event_types.CHATCOMPLETION_MODEL_CHANGED, value);
}

async function onNewPresetClick() {
    const defaultName = characterBoundPresetState.active && characterBoundPresetState.runtimePresetName
        ? characterBoundPresetState.runtimePresetName
        : oai_settings.preset_settings_openai;
    const name = await Popup.show.input(t`Preset name:`, t`Hint: Use a character/group name to bind preset to a specific chat.`, defaultName);

    if (!name) {
        return;
    }

    await saveOpenAIPreset(name, oai_settings);
}

function onReverseProxyInput() {
    oai_settings.reverse_proxy = String($(this).val());
    $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy != '' || oai_settings.base_url != '');
    saveSettingsDebounced();
}

async function onConnectButtonClick(e) {
    e.stopPropagation();

    /** @type {Object.<string, {key: string, selector: string, proxy?: boolean, keyless?: boolean}>} */
    const apiSourceConfig = {
        [chat_completion_sources.OPENROUTER]: { key: SECRET_KEYS.OPENROUTER, selector: '#api_key_openrouter', proxy: false },
        [chat_completion_sources.MAKERSUITE]: { key: SECRET_KEYS.MAKERSUITE, selector: '#api_key_makersuite', proxy: true },
        [chat_completion_sources.CLAUDE]: { key: SECRET_KEYS.CLAUDE, selector: '#api_key_claude', proxy: true },
        [chat_completion_sources.OPENAI]: { key: SECRET_KEYS.OPENAI, selector: '#api_key_openai', proxy: true },
        [chat_completion_sources.AI21]: { key: SECRET_KEYS.AI21, selector: '#api_key_ai21', proxy: false },
        [chat_completion_sources.MISTRALAI]: { key: SECRET_KEYS.MISTRALAI, selector: '#api_key_mistralai', proxy: true },
        [chat_completion_sources.CUSTOM]: { key: SECRET_KEYS.CUSTOM, selector: '#api_key_custom', proxy: false, keyless: true },
        [chat_completion_sources.COHERE]: { key: SECRET_KEYS.COHERE, selector: '#api_key_cohere', proxy: false },
        [chat_completion_sources.PERPLEXITY]: { key: SECRET_KEYS.PERPLEXITY, selector: '#api_key_perplexity', proxy: false },
        [chat_completion_sources.GROQ]: { key: SECRET_KEYS.GROQ, selector: '#api_key_groq', proxy: false },
        [chat_completion_sources.SILICONFLOW]: { key: SECRET_KEYS.SILICONFLOW, selector: '#api_key_siliconflow', proxy: false },
        [chat_completion_sources.ELECTRONHUB]: { key: SECRET_KEYS.ELECTRONHUB, selector: '#api_key_electronhub', proxy: false },
        [chat_completion_sources.NANOGPT]: { key: SECRET_KEYS.NANOGPT, selector: '#api_key_nanogpt', proxy: false },
        [chat_completion_sources.DEEPSEEK]: { key: SECRET_KEYS.DEEPSEEK, selector: '#api_key_deepseek', proxy: true },
        [chat_completion_sources.XAI]: { key: SECRET_KEYS.XAI, selector: '#api_key_xai', proxy: true },
        [chat_completion_sources.AIMLAPI]: { key: SECRET_KEYS.AIMLAPI, selector: '#api_key_aimlapi', proxy: false },
        [chat_completion_sources.MOONSHOT]: { key: SECRET_KEYS.MOONSHOT, selector: '#api_key_moonshot', proxy: true },
        [chat_completion_sources.FIREWORKS]: { key: SECRET_KEYS.FIREWORKS, selector: '#api_key_fireworks', proxy: false },
        [chat_completion_sources.COMETAPI]: { key: SECRET_KEYS.COMETAPI, selector: '#api_key_cometapi', proxy: false },
        [chat_completion_sources.AZURE_OPENAI]: { key: SECRET_KEYS.AZURE_OPENAI, selector: '#api_key_azure_openai', proxy: false },
        [chat_completion_sources.ZAI]: { key: SECRET_KEYS.ZAI, selector: '#api_key_zai', proxy: true },
        [chat_completion_sources.CHUTES]: { key: SECRET_KEYS.CHUTES, selector: '#api_key_chutes', proxy: false },
        [chat_completion_sources.POLLINATIONS]: { key: SECRET_KEYS.POLLINATIONS, selector: '#api_key_pollinations', proxy: false },
        [chat_completion_sources.WORKERS_AI]: { key: SECRET_KEYS.WORKERS_AI, selector: '#api_key_workers_ai', proxy: false },
        [chat_completion_sources.MINIMAX]: { key: SECRET_KEYS.MINIMAX, selector: '#api_key_minimax', proxy: false },
    };

    // Vertex AI Express version - use API key
    if (oai_settings.vertexai_auth_mode === 'express') {
        apiSourceConfig[chat_completion_sources.VERTEXAI] = { key: SECRET_KEYS.VERTEXAI, selector: '#api_key_vertexai', proxy: true };
    }

    // Vertex AI Full version - use service account
    if (oai_settings.chat_completion_source === chat_completion_sources.VERTEXAI && oai_settings.vertexai_auth_mode === 'full') {
        if (!secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
            toastr.error(t`Service Account JSON is required for Vertex AI full version. Please validate and save your Service Account JSON.`);
            return;
        }
    }

    // Other generic configs
    const config = apiSourceConfig[oai_settings.chat_completion_source];
    if (config) {
        const apiKey = String($(config.selector).val()).trim();
        if (apiKey.length) {
            await writeSecret(config.key, apiKey);
        }

        if (!secret_state[config.key] && (!config.proxy || !oai_settings.reverse_proxy) && !config.keyless) {
            console.log(`No secret key saved for ${oai_settings.chat_completion_source}`);
            return;
        }
    }

    startStatusLoading();
    saveSettingsDebounced();
    await getStatusOpen();
}

function toggleChatCompletionForms() {
    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        // Claude model id is a free-form text input, no select to re-trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENAI) {
        // OpenAI uses an input + datalist; the picker is not the source of truth.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MAKERSUITE) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI) {
        // Update UI based on authentication mode
        onVertexAIAuthModeChange.call($('#vertexai_auth_mode')[0]);
    } else if (oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER) {
        $('#model_openrouter_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        $('#model_ai21_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COHERE) {
        $('#model_cohere_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.PERPLEXITY) {
        $('#model_perplexity_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.GROQ) {
        $('#model_groq_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES) {
        $('#model_chutes_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.SILICONFLOW) {
        $('#model_siliconflow_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MINIMAX) {
        $('#model_minimax_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB) {
        $('#model_electronhub_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.NANOGPT) {
        $('#model_nanogpt_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI) {
        $('#model_aimlapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.XAI) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.POLLINATIONS) {
        $('#model_pollinations_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.FIREWORKS) {
        $('#model_fireworks_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.COMETAPI) {
        $('#model_cometapi_select').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        $('#azure_openai_model').trigger('change');
    } else if (oai_settings.chat_completion_source == chat_completion_sources.ZAI) {
        // input-driven, no trigger.
    } else if (oai_settings.chat_completion_source == chat_completion_sources.WORKERS_AI) {
        $('#model_workers_ai_select').trigger('change');
    }

    $('[data-source]').each(function () {
        const mode = $(this).data('source-mode');
        const validSources = $(this).data('source').split(',');
        const matchesSource = validSources.includes(oai_settings.chat_completion_source);
        $(this).toggle(mode !== 'except' ? matchesSource : !matchesSource);
    });

    applyCustomModelsToCurrentSource({ triggerModelChange: true });
    refreshCustomModelsEditorForCurrentSource();
    setToolReasoningControls();
}

async function testApiConnection() {
    // Check if the previous request is still in progress
    if (is_send_press) {
        toastr.info(t`Please wait for the previous request to complete.`);
        return;
    }

    try {
        const reply = await sendOpenAIRequest('quiet', [{ 'role': 'user', 'content': 'Hi' }], new AbortController().signal);
        console.log(reply);
        toastr.success(t`API connection successful!`);
    } catch (err) {
        toastr.error(t`Could not get a reply from API. Check your connection settings / API key and try again.`);
    }
}

function reconnectOpenAi() {
    if (main_api == 'openai') {
        setOnlineStatus('no_connection');
        resultCheckStatus();
        $('#api_button_openai').trigger('click');
    }
}

function onProxyPasswordShowClick() {
    const $input = $('#openai_proxy_password');
    const type = $input.attr('type') === 'password' ? 'text' : 'password';
    $input.attr('type', type);
    $(this).toggleClass('fa-eye-slash fa-eye');
}

async function onCustomizeParametersClick() {
    const template = $(await renderTemplateAsync('customEndpointAdditionalParameters'));

    template.find('#custom_include_body').val(oai_settings.custom_include_body).on('input', function () {
        oai_settings.custom_include_body = String($(this).val());
        saveSettingsDebounced();
    });

    template.find('#custom_exclude_body').val(oai_settings.custom_exclude_body).on('input', function () {
        oai_settings.custom_exclude_body = String($(this).val());
        saveSettingsDebounced();
    });

    template.find('#custom_include_headers').val(oai_settings.custom_include_headers).on('input', function () {
        oai_settings.custom_include_headers = String($(this).val());
        saveSettingsDebounced();
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

/**
 * Check if the model supports image inlining
 * @returns {boolean} True if the model supports image inlining
 */
export function isImageInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    // gultra just isn't being offered as multimodal, thanks google.
    const visionSupportedModels = [
        // OpenAI
        'chatgpt-4o-latest',
        'gpt-4-turbo',
        'gpt-4-vision',
        'gpt-4.1',
        'gpt-4.5-preview',
        'gpt-4o',
        'gpt-5',
        'o1',
        'o3',
        'o4-mini',
        // Claude
        'claude-3',
        'claude-opus-4',
        'claude-sonnet-4',
        'claude-haiku-4',
        // Cohere
        'c4ai-aya-vision',
        'command-a-vision',
        // Google AI Studio
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'learnlm',
        'gemini-robotics',
        'gemma-3-27b',
        'gemma-3-12b',
        'gemma-3-4b',
        'gemma-4',
        // MistralAI
        'mistral-small-2503',
        'mistral-small-2506',
        'mistral-small-latest',
        'mistral-medium-latest',
        'mistral-medium-2505',
        'mistral-medium-2508',
        'pixtral',
        // xAI (Grok)
        'grok-4',
        'grok-2-vision',
        // Moonshot
        'moonshot-v1-8k-vision-preview',
        'moonshot-v1-32k-vision-preview',
        'moonshot-v1-128k-vision-preview',
        'kimi-k2.5',
        'kimi-latest',
        // Z.AI (GLM)
        'glm-4.5v',
        'glm-4.6v',
        'glm-5v-turbo',
        'autoglm-phone',
        // SiliconFlow
        'Qwen/Qwen3-VL-32B-Instruct',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'zai-org/GLM-4.5V',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.AZURE_OPENAI: {
            const modelToCheck = oai_settings.chat_completion_source === chat_completion_sources.AZURE_OPENAI
                ? oai_settings.azure_openai_model
                : oai_settings.openai_model;
            return visionSupportedModels.some(model =>
                modelToCheck.includes(model)
                && ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some(x => !modelToCheck.includes(x)),
            );
        }
        case chat_completion_sources.MAKERSUITE:
            return visionSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return visionSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.CLAUDE:
            return visionSupportedModels.some(model => oai_settings.claude_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('image'));
        case chat_completion_sources.CUSTOM:
            return true;
        case chat_completion_sources.MISTRALAI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.mistralai_model)?.capabilities?.vision);
        case chat_completion_sources.COHERE:
            return visionSupportedModels.some(model => oai_settings.cohere_model.includes(model));
        case chat_completion_sources.XAI:
            // TODO: xAI's /models endpoint doesn't return modality info
            return visionSupportedModels.some(model => oai_settings.xai_model.includes(model));
        case chat_completion_sources.AIMLAPI:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.aimlapi_model)?.features?.includes('openai/chat-completion.vision'));
        case chat_completion_sources.CHUTES:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.chutes_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.ELECTRONHUB:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.electronhub_model)?.metadata?.vision);
        case chat_completion_sources.POLLINATIONS:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.pollinations_model)?.input_modalities?.includes('image'));
        case chat_completion_sources.COMETAPI:
            return true;
        case chat_completion_sources.MOONSHOT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.moonshot_model)?.supports_image_in);
        case chat_completion_sources.NANOGPT:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.nanogpt_model)?.capabilities?.vision);
        case chat_completion_sources.ZAI:
            return visionSupportedModels.some(model => oai_settings.zai_model.includes(model));
        case chat_completion_sources.SILICONFLOW:
            return visionSupportedModels.some(model => oai_settings.siliconflow_model.includes(model));
        case chat_completion_sources.WORKERS_AI: {
            const waiModel = Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.workers_ai_model);
            return Boolean(waiModel && Array.isArray(waiModel.properties) && waiModel.properties.some(p => p.property_id === 'vision' && p.value === 'true'));
        }
        default:
            return false;
    }
}

/**
 * Check if the model supports video inlining
 * @returns {boolean} True if the model supports video inlining
 */
export function isVideoInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const videoSupportedModels = [
        // Gemini
        'gemini-2.0',
        'gemini-2.5',
        'gemini-exp-1206',
        'gemini-3',
        'gemma-4',
        // Z.AI (GLM)
        'glm-4.5v',
        'glm-4.6v',
        'glm-5v-turbo',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.MAKERSUITE:
            return videoSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return videoSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('video'));
        case chat_completion_sources.ZAI:
            return videoSupportedModels.some(model => oai_settings.zai_model.includes(model));
        default:
            return false;
    }
}

/**
 * Check if the model supports video inlining
 * @returns {boolean} True if the model supports audio inlining
 */
export function isAudioInliningSupported() {
    if (main_api !== 'openai') {
        return false;
    }

    if (!oai_settings.media_inlining) {
        return false;
    }

    const audioSupportedModels = [
        'gemini-2.0',
        'gemini-2.5',
        'gemini-3',
        'gemini-exp-1206',
        'gpt-4o-audio',
        'gpt-4o-realtime',
        'gpt-4o-mini-audio',
        'gpt-4o-mini-realtime',
        'gpt-audio',
        'gpt-realtime',
    ];

    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.OPENAI:
            return audioSupportedModels.some(model => oai_settings.openai_model.includes(model));
        case chat_completion_sources.MAKERSUITE:
            return audioSupportedModels.some(model => oai_settings.google_model.includes(model));
        case chat_completion_sources.VERTEXAI:
            return audioSupportedModels.some(model => oai_settings.vertexai_model.includes(model));
        case chat_completion_sources.OPENROUTER:
            return (Array.isArray(model_list) && model_list.find(m => m.id === oai_settings.openrouter_model)?.architecture?.input_modalities?.includes('audio'));
        case chat_completion_sources.CUSTOM:
            return true;
        default:
            return false;
    }
}

/**
 * Gets the tool-call reasoning forwarding mode.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {string} Reasoning forwarding mode
 */
function getToolReasoningMode(settings = oai_settings) {
    const mode = String(settings.tool_reasoning_mode ?? '');
    if (Object.values(tool_reasoning_modes).includes(mode)) {
        return mode;
    }
    return tool_reasoning_modes.DISABLED;
}

/**
 * Gets the effective tool-call reasoning forwarding mode.
 * Interleaved thinking requires explicit reasoning requests.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {string} Effective reasoning forwarding mode
 */
function getEffectiveToolReasoningMode(settings = oai_settings) {
    if (!settings.show_thoughts) {
        return tool_reasoning_modes.DISABLED;
    }

    return getToolReasoningMode(settings);
}

/**
 * Check if the model supports encrypted reasoning signatures.
 * @param {ChatCompletionSettings} settings Settings object to use
 * @returns {boolean} True if reasoning signatures should be included in the request
 */
export function isReasoningSignatureSupported(settings = oai_settings) {
    // If it's Vertex AI or Makersuite, that's OK - convertGooglePrompt() will handle it later
    const isGoogle = [chat_completion_sources.VERTEXAI, chat_completion_sources.MAKERSUITE].includes(settings.chat_completion_source);
    // Need a more crunchy check for OpenRouter: look for Gemini models
    const isOpenRouterGemini = settings.chat_completion_source === chat_completion_sources.OPENROUTER && /google\/gemini/i.test(settings.openrouter_model);
    return isGoogle || isOpenRouterGemini;
}

/**
 * Proxy stuff
 */
function syncProxyPresetSelectionByConnection() {
    const currentUrl = String(oai_settings.reverse_proxy || '');
    const currentPassword = String(oai_settings.proxy_password || '');
    const matched = proxies.find((preset) => String(preset?.url || '') === currentUrl && String(preset?.password || '') === currentPassword);

    if (matched) {
        selected_proxy = matched;
        $('#openai_proxy_preset').val(matched.name);
        $('#openai_reverse_proxy_name').val(matched.name);
        return;
    }

    if (!currentUrl && !currentPassword) {
        const nonePreset = proxies.find((preset) => String(preset?.name || '') === 'None');
        if (nonePreset) {
            selected_proxy = nonePreset;
            $('#openai_proxy_preset').val(nonePreset.name);
            $('#openai_reverse_proxy_name').val(nonePreset.name);
        } else {
            selected_proxy = { name: 'None', url: '', password: '' };
            $('#openai_proxy_preset').val('');
            $('#openai_reverse_proxy_name').val(selected_proxy.name);
        }
        return;
    }

    // Keep arbitrary proxy values even if they don't match a named preset.
    selected_proxy = { name: '', url: currentUrl, password: currentPassword };
    $('#openai_proxy_preset').val('');
    $('#openai_reverse_proxy_name').val('');
}

function ensureProxyPresetOption(name) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        return;
    }

    const existingOption = $('#openai_proxy_preset option').filter(function () {
        return String($(this).val()) === normalizedName;
    });

    if (existingOption.length > 0) {
        return;
    }

    const option = document.createElement('option');
    option.innerText = normalizedName;
    option.value = normalizedName;
    $('#openai_proxy_preset').append(option);
}

function persistCurrentProxyPresetSelection() {
    const currentUrl = String(oai_settings.reverse_proxy || $('#openai_reverse_proxy').val() || '');
    const currentPassword = String(oai_settings.proxy_password || $('#openai_proxy_password').val() || '');

    if (!currentUrl && !currentPassword) {
        syncProxyPresetSelectionByConnection();
        return selected_proxy;
    }

    const matched = proxies.find((preset) => String(preset?.url || '') === currentUrl && String(preset?.password || '') === currentPassword);
    const typedName = String($('#openai_reverse_proxy_name').val() || '').trim();
    const selectedName = String($('#openai_proxy_preset').val() || '').trim();
    const candidateName = [typedName, selectedName, matched?.name]
        .map(name => String(name || '').trim())
        .find(name => name && name !== 'None');

    if (!candidateName) {
        syncProxyPresetSelectionByConnection();
        return selected_proxy;
    }

    const existingPreset = proxies.find((preset) => String(preset?.name || '') === candidateName);
    if (existingPreset) {
        existingPreset.url = currentUrl;
        existingPreset.password = currentPassword;
        selected_proxy = existingPreset;
    } else {
        const newPreset = { name: candidateName, url: currentUrl, password: currentPassword };
        proxies.push(newPreset);
        selected_proxy = newPreset;
    }

    ensureProxyPresetOption(candidateName);
    $('#openai_proxy_preset').val(candidateName);
    $('#openai_reverse_proxy_name').val(candidateName);
    return selected_proxy;
}

export function getCurrentProxyProfileEntry({ persist = false } = {}) {
    if (persist) {
        persistCurrentProxyPresetSelection();
    }

    const currentUrl = String(oai_settings.reverse_proxy || $('#openai_reverse_proxy').val() || '');
    const currentPassword = String(oai_settings.proxy_password || $('#openai_proxy_password').val() || '');
    const matched = proxies.find((preset) => String(preset?.url || '') === currentUrl && String(preset?.password || '') === currentPassword);
    const selectedName = String($('#openai_proxy_preset').val() || '').trim();
    const typedName = String($('#openai_reverse_proxy_name').val() || '').trim();
    const name = [matched?.name, selectedName, typedName]
        .map(value => String(value || '').trim())
        .find(value => value && value !== 'None') || '';

    return {
        name,
        url: currentUrl,
        password: currentPassword,
    };
}

export function applyProxyProfileEntry({
    name = '',
    url = '',
    password = '',
} = {}) {
    const normalizedName = String(name || '').trim();
    const effectiveName = normalizedName === 'None' ? '' : normalizedName;
    const normalizedUrl = String(url || '');
    const normalizedPassword = String(password || '');

    if (!normalizedUrl && !normalizedPassword) {
        const nonePreset = proxies.find((preset) => String(preset?.name || '') === 'None');
        if (nonePreset) {
            setProxyPreset(nonePreset.name, nonePreset.url, nonePreset.password);
            $('#openai_proxy_preset').val(nonePreset.name);
            return nonePreset.name;
        }

        setProxyPreset('None', '', '');
        $('#openai_proxy_preset').val('None');
        return 'None';
    }

    if (effectiveName) {
        ensureProxyPresetOption(effectiveName);
        setProxyPreset(effectiveName, normalizedUrl, normalizedPassword);
        $('#openai_proxy_preset').val(effectiveName);
        return effectiveName;
    }

    oai_settings.reverse_proxy = normalizedUrl;
    $('#openai_reverse_proxy').val(normalizedUrl);
    oai_settings.proxy_password = normalizedPassword;
    $('#openai_proxy_password').val(normalizedPassword);
    syncProxyPresetSelectionByConnection();
    reconnectOpenAi();
    return selected_proxy?.name || '';
}

export function loadProxyPresets(settings) {
    let proxyPresets = Array.isArray(settings.proxies) && settings.proxies.length > 0 ? settings.proxies : proxies;
    proxyPresets = proxyPresets
        .filter((preset) => preset && typeof preset === 'object')
        .map((preset) => ({
            name: String(preset.name || '').trim(),
            url: String(preset.url || ''),
            password: String(preset.password || ''),
        }))
        .filter((preset) => preset.name);

    if (!proxyPresets.some((preset) => preset.name === 'None')) {
        proxyPresets.unshift({ name: 'None', url: '', password: '' });
    }

    proxies = proxyPresets;

    $('#openai_proxy_preset').empty();

    for (const preset of proxyPresets) {
        const option = document.createElement('option');
        option.innerText = preset.name;
        option.value = preset.name;
        option.selected = preset.name === 'None';
        $('#openai_proxy_preset').append(option);
    }

    syncProxyPresetSelectionByConnection();
}

function setProxyPreset(name, url, password) {
    const preset = proxies.find(p => p.name === name);
    if (preset) {
        preset.url = url;
        preset.password = password;
        selected_proxy = preset;
    } else {
        let new_proxy = { name, url, password };
        proxies.push(new_proxy);
        selected_proxy = new_proxy;
    }

    $('#openai_reverse_proxy_name').val(name);
    oai_settings.reverse_proxy = url;
    $('#openai_reverse_proxy').val(oai_settings.reverse_proxy);
    oai_settings.proxy_password = password;
    $('#openai_proxy_password').val(oai_settings.proxy_password);
    reconnectOpenAi();
}

function onProxyPresetChange() {
    const value = String($('#openai_proxy_preset').find(':selected').val());
    const selectedPreset = proxies.find(preset => preset.name === value);

    if (selectedPreset) {
        setProxyPreset(selectedPreset.name, selectedPreset.url, selectedPreset.password);
    } else {
        console.error(t`Proxy preset '${value}' not found in proxies array.`);
    }
    saveSettingsDebounced();
}

$('#save_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const reverseProxy = $('#openai_reverse_proxy').val();
    const proxyPassword = $('#openai_proxy_password').val();

    setProxyPreset(presetName, reverseProxy, proxyPassword);
    saveSettingsDebounced();
    toastr.success(t`Proxy Saved`);
    if ($('#openai_proxy_preset').val() !== presetName) {
        const option = document.createElement('option');
        option.text = String(presetName);
        option.value = String(presetName);

        $('#openai_proxy_preset').append(option);
    }
    $('#openai_proxy_preset').val(presetName);
});

$('#delete_proxy').on('click', async function () {
    const presetName = $('#openai_reverse_proxy_name').val();
    const index = proxies.findIndex(preset => preset.name === presetName);

    if (index !== -1) {
        proxies.splice(index, 1);
        $('#openai_proxy_preset option[value="' + presetName + '"]').remove();

        if (proxies.length > 0) {
            const newIndex = Math.max(0, index - 1);
            selected_proxy = proxies[newIndex];
        } else {
            selected_proxy = { name: 'None', url: '', password: '' };
        }

        $('#openai_reverse_proxy_name').val(selected_proxy.name);
        oai_settings.reverse_proxy = selected_proxy.url;
        $('#openai_reverse_proxy').val(selected_proxy.url);
        oai_settings.proxy_password = selected_proxy.password;
        $('#openai_proxy_password').val(selected_proxy.password);

        saveSettingsDebounced();
        $('#openai_proxy_preset').val(selected_proxy.name);
        toastr.success(t`Proxy Deleted`);
    } else {
        toastr.error(t`Could not find proxy with name '${presetName}'`);
    }
});

function runProxyCallback(args, value) {
    if (!value) {
        const shouldPersist = String(args?.persist || '').trim().toLowerCase() === 'true';
        if (shouldPersist) {
            persistCurrentProxyPresetSelection();
        }

        const currentUrl = String(oai_settings.reverse_proxy || '');
        const currentPassword = String(oai_settings.proxy_password || '');
        const matched = proxies.find((preset) => String(preset?.url || '') === currentUrl && String(preset?.password || '') === currentPassword);

        if (matched) {
            selected_proxy = matched;
            return matched.name;
        }

        if (!currentUrl && !currentPassword) {
            const nonePreset = proxies.find((preset) => String(preset?.name || '') === 'None');
            if (nonePreset) {
                selected_proxy = nonePreset;
                return nonePreset.name;
            }
        }

        return '';
    }

    const proxyNames = proxies.map(preset => preset.name);
    const fuse = new Fuse(proxyNames);
    const result = fuse.search(value);

    if (result.length === 0) {
        toastr.warning(t`Proxy preset '${value}' not found`);
        return '';
    }

    const foundName = result[0].item;
    $('#openai_proxy_preset').val(foundName).trigger('change');
    return foundName;
}

/**
 * Handle Vertex AI authentication mode change
 */
function onVertexAIAuthModeChange() {
    const authMode = String($(this).val());
    oai_settings.vertexai_auth_mode = authMode;

    $('#vertexai_form [data-mode]').each(function () {
        const mode = $(this).data('mode');
        $(this).toggle(mode === authMode);
        $(this).find('option').toggle(mode === authMode);
    });

    saveSettingsDebounced();
}

/**
 * Validate Vertex AI service account JSON
 */
async function onVertexAIValidateServiceAccount() {
    const jsonContent = String($('#vertexai_service_account_json').val()).trim();

    if (!jsonContent) {
        toastr.error(t`Please enter Service Account JSON content`);
        return;
    }

    try {
        const serviceAccount = JSON.parse(jsonContent);
        const requiredFields = ['type', 'project_id', 'private_key', 'client_email', 'client_id'];
        const missingFields = requiredFields.filter(field => !serviceAccount[field]);

        if (missingFields.length > 0) {
            toastr.error(t`Missing required fields: ${missingFields.join(', ')}`);
            updateVertexAIServiceAccountStatus(false, t`Missing fields: ${missingFields.join(', ')}`);
            return;
        }

        if (serviceAccount.type !== 'service_account') {
            toastr.error(t`Invalid service account type. Expected "service_account"`);
            updateVertexAIServiceAccountStatus(false, t`Invalid service account type`);
            return;
        }

        // Save to backend secret storage
        const keyLabel = serviceAccount.client_email || '';
        await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, jsonContent, keyLabel);

        // Show success status
        updateVertexAIServiceAccountStatus(true, `Project: ${serviceAccount.project_id}, Email: ${serviceAccount.client_email}`);

        toastr.success(t`Service Account JSON is valid and saved securely`);
        saveSettingsDebounced();
    } catch (error) {
        console.error('JSON validation error:', error);
        toastr.error(t`Invalid JSON format`);
        updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
    }
}

/**
 * Clear Vertex AI service account JSON
 */
async function onVertexAIClearServiceAccount() {
    $('#vertexai_service_account_json').val('');

    // Clear from backend secret storage
    await writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, '');

    updateVertexAIServiceAccountStatus(false);
    toastr.info(t`Service Account JSON cleared`);
    saveSettingsDebounced();
}

/**
 * Handle Vertex AI service account JSON input change
 */
function onVertexAIServiceAccountJsonChange() {
    const jsonContent = String($(this).val()).trim();

    // Autocomplete has been triggered, don't validate if the input is a UUID
    if (isUuid(jsonContent)) {
        return;
    }

    if (jsonContent) {
        // Auto-validate when content is pasted
        try {
            const serviceAccount = JSON.parse(jsonContent);
            const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
            const hasAllFields = requiredFields.every(field => serviceAccount[field]);

            if (hasAllFields && serviceAccount.type === 'service_account') {
                updateVertexAIServiceAccountStatus(false, t`JSON appears valid - click "Validate JSON" to save`);
            } else {
                updateVertexAIServiceAccountStatus(false, t`Incomplete or invalid JSON`);
            }
        } catch (error) {
            updateVertexAIServiceAccountStatus(false, t`Invalid JSON format`);
        }
    } else {
        updateVertexAIServiceAccountStatus(false);
    }

    // Don't save settings automatically
    // saveSettingsDebounced();
}

/**
 * Update the Vertex AI service account status display
 * @param {boolean} isValid - Whether the service account is valid
 * @param {string} message - Status message to display
 */
function updateVertexAIServiceAccountStatus(isValid = false, message = '') {
    const statusDiv = $('#vertexai_service_account_status');
    const infoSpan = $('#vertexai_service_account_info');

    // If no explicit message provided, check if we have a saved service account
    if (!message && secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT]) {
        isValid = true;
        message = t`Service Account JSON is saved and ready to use`;
    }

    if (isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-check-circle" style="color: green;"></i> ${message}`);
        statusDiv.show();
    } else if (!isValid && message) {
        infoSpan.html(`<i class="fa-solid fa-exclamation-triangle" style="color: orange;"></i> ${message}`);
        statusDiv.show();
    } else {
        statusDiv.hide();
    }
}

function updateFeatureSupportFlags() {
    const featureFlags = {
        openai_function_calling_supported: ToolManager.isToolCallingSupported(),
        openai_image_inlining_supported: isImageInliningSupported(),
        openai_video_inlining_supported: isVideoInliningSupported(),
        openai_audio_inlining_supported: isAudioInliningSupported(),
    };

    for (const [key, value] of Object.entries(featureFlags)) {
        const element = document.getElementById(key);
        if (element) {
            element.dataset.ccToggle = String(value ?? false);
        }
    }
}

function registerConnectionProfileAdditionalParameterSlashCommands() {
    const definitions = [
        {
            name: 'custom-include-body',
            settingKey: 'custom_include_body',
            label: t`Include Body Parameters`,
        },
        {
            name: 'custom-exclude-body',
            settingKey: 'custom_exclude_body',
            label: t`Exclude Body Parameters`,
        },
        {
            name: 'custom-include-headers',
            settingKey: 'custom_include_headers',
            label: t`Include Request Headers`,
        },
    ];
    const truthy = new Set(['true', '1', 'yes', 'on']);
    const falsy = new Set(['false', '0', 'no', 'off']);
    const parseBooleanValue = (value) => {
        const raw = String(value ?? '').trim().toLowerCase();
        if (!truthy.has(raw) && !falsy.has(raw)) {
            throw new Error(t`Value must be true/false (also supports 1/0, yes/no, on/off).`);
        }
        return truthy.has(raw);
    };
    const clampPlainTextRetryAttempts = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            throw new Error(t`Value must be a number between 1 and 10.`);
        }
        return Math.min(Math.max(Math.round(numeric), 1), 10);
    };

    for (const definition of definitions) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: definition.name,
            callback: (args, value) => {
                const forceApply = String(args?.force || '').toLowerCase() === 'true';
                if (value === undefined || value === null || (value === '' && !forceApply)) {
                    return String(oai_settings[definition.settingKey] || '');
                }
                oai_settings[definition.settingKey] = String(value);
                saveSettingsDebounced();
                return String(oai_settings[definition.settingKey] || '');
            },
            returns: definition.label,
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: t`value`,
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: t`Sets ${definition.label}. Gets current value if no argument is provided.`,
        }));
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'function-calling-plain-text',
        callback: (args, value) => {
            const forceApply = String(args?.force || '').toLowerCase() === 'true';
            if (!String(value ?? '').trim() && !forceApply) {
                return String(Boolean(oai_settings.function_calling_plain_text));
            }
            oai_settings.function_calling_plain_text = parseBooleanValue(value);
            saveSettingsDebounced();
            return String(Boolean(oai_settings.function_calling_plain_text));
        },
        returns: t`plain-text function calling state`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: t`Sets plain-text function calling mode. Gets current value if no argument is provided.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'function-calling-plain-text-error-retry',
        callback: (args, value) => {
            const forceApply = String(args?.force || '').toLowerCase() === 'true';
            if (!String(value ?? '').trim() && !forceApply) {
                return String(Boolean(oai_settings.function_calling_plain_text_error_retry));
            }
            oai_settings.function_calling_plain_text_error_retry = parseBooleanValue(value);
            saveSettingsDebounced();
            return String(Boolean(oai_settings.function_calling_plain_text_error_retry));
        },
        returns: t`plain-text function calling error retry state`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: t`Sets plain-text function call error retry. Gets current value if no argument is provided.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'function-calling-plain-text-error-retry-max-attempts',
        callback: (args, value) => {
            const forceApply = String(args?.force || '').toLowerCase() === 'true';
            if (!String(value ?? '').trim() && !forceApply) {
                return String(clampPlainTextRetryAttempts(oai_settings.function_calling_plain_text_error_retry_max_attempts));
            }
            oai_settings.function_calling_plain_text_error_retry_max_attempts = clampPlainTextRetryAttempts(value);
            saveSettingsDebounced();
            return String(oai_settings.function_calling_plain_text_error_retry_max_attempts);
        },
        returns: t`plain-text function calling retry attempts`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: t`Sets plain-text function call retry attempts. Gets current value if no argument is provided.`,
    }));

    // Cache toggles. These must be registered as slash commands so that
    // applyConnectionProfile() in connection-manager can translate the
    // kebab-case profile keys back into oai_settings when a profile is loaded.
    // Without the registration the profile field exists but never reaches
    // generate_data on the request path.
    const registerCacheBooleanCommand = (commandName, settingKey, label, help, syncSelector = '') => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: commandName,
            callback: (args, value) => {
                const forceApply = String(args?.force || '').toLowerCase() === 'true';
                if (!String(value ?? '').trim() && !forceApply) {
                    return String(Boolean(oai_settings[settingKey]));
                }
                oai_settings[settingKey] = parseBooleanValue(value);
                if (syncSelector) {
                    $(syncSelector).prop('checked', Boolean(oai_settings[settingKey]));
                }
                saveSettingsDebounced();
                return String(Boolean(oai_settings[settingKey]));
            },
            returns: label,
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: t`value`,
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: help,
        }));
    };

    registerCacheBooleanCommand(
        'claude-enable-system-prompt-cache',
        'claude_enable_system_prompt_cache',
        t`Claude system prompt cache toggle state`,
        t`Sets Claude system prompt caching on/off. Gets current value if no argument is provided.`,
    );
    registerCacheBooleanCommand(
        'claude-extended-ttl',
        'claude_extended_ttl',
        t`Claude extended (1h) cache TTL state`,
        t`Sets Claude cache TTL to 1h (true) or 5m (false). Gets current value if no argument is provided.`,
    );
    registerCacheBooleanCommand(
        'gemini-enable-system-prompt-cache',
        'gemini_enable_system_prompt_cache',
        t`OpenRouter Gemini system prompt cache toggle state`,
        t`Sets OpenRouter Gemini system prompt caching on/off. Gets current value if no argument is provided.`,
    );

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'claude-caching-at-depth',
        callback: (args, value) => {
            const forceApply = String(args?.force || '').toLowerCase() === 'true';
            if (!String(value ?? '').trim() && !forceApply) {
                return String(Number(oai_settings.claude_caching_at_depth ?? -1));
            }
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
                throw new Error(t`Value must be an integer (-1 to disable, >= 0 to enable at that depth).`);
            }
            oai_settings.claude_caching_at_depth = numeric < 0 ? -1 : numeric;
            saveSettingsDebounced();
            return String(oai_settings.claude_caching_at_depth);
        },
        returns: t`Claude caching-at-depth value`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: t`Sets Claude caching-at-depth (-1 to disable). Gets current value if no argument is provided.`,
    }));

    // OpenRouter per-source knobs. Without a slash command they have no
    // hook into connection-manager's per-profile snapshot/apply pipeline,
    // so they end up sharing a single global value across profiles.
    const registerOpenRouterListCommand = (commandName, settingKey, selector, onAfterApply, label, help) => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: commandName,
            callback: (args, value) => {
                const forceApply = String(args?.force || '').toLowerCase() === 'true';
                const raw = String(value ?? '').trim();
                if (!raw && !forceApply) {
                    return JSON.stringify(Array.isArray(oai_settings[settingKey]) ? oai_settings[settingKey] : []);
                }
                const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : [];
                if (!Array.isArray(parsed)) {
                    throw new Error(t`Value must be a JSON-serialized array of strings.`);
                }
                const normalized = parsed.map(item => String(item));
                oai_settings[settingKey] = normalized;
                $(selector).val(normalized).trigger('change');
                if (typeof onAfterApply === 'function') {
                    onAfterApply();
                }
                saveSettingsDebounced();
                return JSON.stringify(oai_settings[settingKey]);
            },
            returns: label,
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'force',
                    description: t`force set an empty value`,
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                    enumList: commonEnumProviders.boolean('trueFalse')(),
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: t`JSON-encoded list`,
                    typeList: [ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: help,
        }));
    };

    registerOpenRouterListCommand(
        'openrouter-providers',
        'openrouter_providers',
        '#openrouter_providers_chat',
        () => updateOpenRouterProvidersWarning('#openrouter_providers_chat'),
        t`OpenRouter provider allowlist`,
        t`Sets the OpenRouter Model Providers allowlist (JSON-encoded array). Gets the current list if no value is provided.`,
    );

    registerOpenRouterListCommand(
        'openrouter-quantizations',
        'openrouter_quantizations',
        '#openrouter_quantizations_chat',
        null,
        t`OpenRouter quantization allowlist`,
        t`Sets the OpenRouter Model Quantizations allowlist (JSON-encoded array). Gets the current list if no value is provided.`,
    );

    registerCacheBooleanCommand(
        'openrouter-allow-fallbacks',
        'openrouter_allow_fallbacks',
        t`OpenRouter allow fallback providers state`,
        t`Sets OpenRouter "Allow fallback providers" on/off. Gets current value if no argument is provided.`,
        '#openrouter_allow_fallbacks',
    );

    registerCacheBooleanCommand(
        'openrouter-use-fallback',
        'openrouter_use_fallback',
        t`OpenRouter allow fallback models state`,
        t`Sets OpenRouter "Allow fallback models" on/off. Gets current value if no argument is provided.`,
        '#openrouter_use_fallback',
    );

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'openrouter-middleout',
        callback: (args, value) => {
            const forceApply = String(args?.force || '').toLowerCase() === 'true';
            const raw = String(value ?? '').trim().toLowerCase();
            if (!raw && !forceApply) {
                return String(oai_settings.openrouter_middleout || openrouter_middleout_types.ON);
            }
            const allowed = Object.values(openrouter_middleout_types);
            if (!allowed.includes(raw)) {
                throw new Error(t`Value must be one of: ${allowed.join(', ')}.`);
            }
            oai_settings.openrouter_middleout = raw;
            $('#openrouter_middleout').val(raw).trigger('change');
            saveSettingsDebounced();
            return String(oai_settings.openrouter_middleout);
        },
        returns: t`OpenRouter middle-out transform mode`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`auto | on | off`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: Object.values(openrouter_middleout_types).map(v => new SlashCommandEnumValue(v)),
            }),
        ],
        helpString: t`Sets the OpenRouter Middle-out transform mode. Gets current value if no argument is provided.`,
    }));
}

export function initOpenAI() {
    registerConnectionProfileAdditionalParameterSlashCommands();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'proxy',
        callback: runProxyCallback,
        returns: 'current proxy',
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => proxies.map(preset => new SlashCommandEnumValue(preset.name, preset.url)),
            }),
        ],
        helpString: 'Sets a proxy preset by name.',
    }));

    $('#test_api_button').on('click', testApiConnection);

    $('#temp_openai').on('input', function () {
        oai_settings.temp_openai = Number($(this).val());
        $('#temp_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#freq_pen_openai').on('input', function () {
        oai_settings.freq_pen_openai = Number($(this).val());
        $('#freq_pen_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#pres_pen_openai').on('input', function () {
        oai_settings.pres_pen_openai = Number($(this).val());
        $('#pres_pen_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#top_p_openai').on('input', function () {
        oai_settings.top_p_openai = Number($(this).val());
        $('#top_p_counter_openai').val(Number($(this).val()).toFixed(2));
        saveSettingsDebounced();
    });

    $('#top_k_openai').on('input', function () {
        oai_settings.top_k_openai = Number($(this).val());
        $('#top_k_counter_openai').val(Number($(this).val()).toFixed(0));
        saveSettingsDebounced();
    });

    $('#top_a_openai').on('input', function () {
        oai_settings.top_a_openai = Number($(this).val());
        $('#top_a_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#min_p_openai').on('input', function () {
        oai_settings.min_p_openai = Number($(this).val());
        $('#min_p_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#repetition_penalty_openai').on('input', function () {
        oai_settings.repetition_penalty_openai = Number($(this).val());
        $('#repetition_penalty_counter_openai').val(Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#openai_max_context').on('input', function () {
        oai_settings.openai_max_context = Number($(this).val());
        $('#openai_max_context_counter').val(`${$(this).val()}`);
        calculateOpenRouterCost();
        calculateElectronHubCost();
        calculateChutesCost();
        saveSettingsDebounced();
    });

    $('#openai_max_tokens').on('input', function () {
        oai_settings.openai_max_tokens = Number($(this).val());
        calculateOpenRouterCost();
        calculateElectronHubCost();
        calculateChutesCost();
        saveSettingsDebounced();
    });

    $('#stream_toggle').on('change', function () {
        oai_settings.stream_openai = !!$('#stream_toggle').prop('checked');
        saveSettingsDebounced();
    });

    $('#use_sysprompt').on('change', function () {
        oai_settings.use_sysprompt = !!$('#use_sysprompt').prop('checked');
        saveSettingsDebounced();
    });

    $('#send_if_empty_textarea').on('input', function () {
        oai_settings.send_if_empty = String($('#send_if_empty_textarea').val());
        saveSettingsDebounced();
    });

    $('#impersonation_prompt_textarea').on('input', function () {
        oai_settings.impersonation_prompt = String($('#impersonation_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newchat_prompt_textarea').on('input', function () {
        oai_settings.new_chat_prompt = String($('#newchat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newgroupchat_prompt_textarea').on('input', function () {
        oai_settings.new_group_chat_prompt = String($('#newgroupchat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#newexamplechat_prompt_textarea').on('input', function () {
        oai_settings.new_example_chat_prompt = String($('#newexamplechat_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#continue_nudge_prompt_textarea').on('input', function () {
        oai_settings.continue_nudge_prompt = String($('#continue_nudge_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#wi_format_textarea').on('input', function () {
        oai_settings.wi_format = String($('#wi_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#scenario_format_textarea').on('input', function () {
        oai_settings.scenario_format = String($('#scenario_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#personality_format_textarea').on('input', function () {
        oai_settings.personality_format = String($('#personality_format_textarea').val());
        saveSettingsDebounced();
    });

    $('#group_nudge_prompt_textarea').on('input', function () {
        oai_settings.group_nudge_prompt = String($('#group_nudge_prompt_textarea').val());
        saveSettingsDebounced();
    });

    $('#update_oai_preset').on('click', async function () {
        if (characterBoundPresetState.active) {
            // The "update preset" button targets oai_settings.preset_settings_openai,
            // which during character-bound mode still points to the pre-bind preset
            // (onSettingsPresetChange skips updating it). Writing to that name would
            // silently overwrite an unrelated global preset with the bound body.
            // Instead, force-flush the snapshot back to the character card.
            await syncCharacterBoundPresetFromSettings();
            toastr.success(t`Preset updated`);
            return;
        }
        const name = oai_settings.preset_settings_openai;
        await saveOpenAIPreset(name, oai_settings, false);
        saveSettingsDebounced(0, { directSave: true });
        toastr.success(t`Preset updated`);
    });

    $('#impersonation_prompt_restore').on('click', function () {
        oai_settings.impersonation_prompt = default_impersonation_prompt;
        $('#impersonation_prompt_textarea').val(oai_settings.impersonation_prompt);
        saveSettingsDebounced();
    });

    $('#newchat_prompt_restore').on('click', function () {
        oai_settings.new_chat_prompt = default_new_chat_prompt;
        $('#newchat_prompt_textarea').val(oai_settings.new_chat_prompt);
        saveSettingsDebounced();
    });

    $('#newgroupchat_prompt_restore').on('click', function () {
        oai_settings.new_group_chat_prompt = default_new_group_chat_prompt;
        $('#newgroupchat_prompt_textarea').val(oai_settings.new_group_chat_prompt);
        saveSettingsDebounced();
    });

    $('#newexamplechat_prompt_restore').on('click', function () {
        oai_settings.new_example_chat_prompt = default_new_example_chat_prompt;
        $('#newexamplechat_prompt_textarea').val(oai_settings.new_example_chat_prompt);
        saveSettingsDebounced();
    });

    $('#continue_nudge_prompt_restore').on('click', function () {
        oai_settings.continue_nudge_prompt = default_continue_nudge_prompt;
        $('#continue_nudge_prompt_textarea').val(oai_settings.continue_nudge_prompt);
        saveSettingsDebounced();
    });

    $('#wi_format_restore').on('click', function () {
        oai_settings.wi_format = default_wi_format;
        $('#wi_format_textarea').val(oai_settings.wi_format);
        saveSettingsDebounced();
    });

    $('#scenario_format_restore').on('click', function () {
        oai_settings.scenario_format = default_scenario_format;
        $('#scenario_format_textarea').val(oai_settings.scenario_format);
        saveSettingsDebounced();
    });

    $('#personality_format_restore').on('click', function () {
        oai_settings.personality_format = default_personality_format;
        $('#personality_format_textarea').val(oai_settings.personality_format);
        saveSettingsDebounced();
    });

    $('#group_nudge_prompt_restore').on('click', function () {
        oai_settings.group_nudge_prompt = default_group_nudge_prompt;
        $('#group_nudge_prompt_textarea').val(oai_settings.group_nudge_prompt);
        saveSettingsDebounced();
    });

    $('#openai_bypass_status_check').on('input', function () {
        oai_settings.bypass_status_check = !!$(this).prop('checked');
        getStatusOpen();
        saveSettingsDebounced();
    });

    $('#chat_completion_source').on('change', function () {
        cancelStatusCheck('Chat Completion source changed');
        model_list = [];
        oai_settings.chat_completion_source = String($(this).find(':selected').val());
        toggleChatCompletionForms();
        saveSettingsDebounced();
        reconnectOpenAi();
        forceCharacterEditorTokenize();
        updateFeatureSupportFlags();
        eventSource.emit(event_types.CHATCOMPLETION_SOURCE_CHANGED, oai_settings.chat_completion_source);
    });

    $('#chat_completion_custom_models_apply').on('click', async function () {
        const source = oai_settings.chat_completion_source;
        const binding = getModelBindingForSource(source);
        if (!binding) {
            return;
        }

        const modelIds = parseCustomModelList(String($('#chat_completion_custom_models_text').val() || ''));
        setCustomModelsForSource(source, modelIds);
        applyCustomModelsToCurrentSource({ triggerModelChange: true });
        refreshCustomModelsEditorForCurrentSource();
        saveSettingsDebounced();
        startStatusLoading();
        try {
            await getStatusOpen();
        } catch {
            // getStatusOpen already handles user-facing status/error updates.
        }
        toastr.success(t`Custom models updated.`);
    });

    $('#oai_max_context_unlocked').on('input', function (_e, data) {
        oai_settings.max_context_unlocked = !!$(this).prop('checked');
        if (data?.source !== 'preset') {
            $('#chat_completion_source').trigger('change');
        }
        saveSettingsDebounced();
    });

    $('#openai_show_external_models').on('input', function () {
        oai_settings.show_external_models = !!$(this).prop('checked');
        $('#openai_external_category').toggle(oai_settings.show_external_models);
        saveSettingsDebounced();
    });

    $('#openai_proxy_password').on('input', function () {
        oai_settings.proxy_password = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_base_url').on('input', function () {
        oai_settings.base_url = String($(this).val()).trim();
        $('.reverse_proxy_warning').toggle(oai_settings.reverse_proxy != '' || oai_settings.base_url != '');
        saveSettingsDebounced();
        reconnectOpenAi();
    });

    $('#claude_assistant_prefill').on('input', function () {
        oai_settings.assistant_prefill = String($(this).val());
        saveSettingsDebounced();
    });

    $('#claude_assistant_impersonation').on('input', function () {
        oai_settings.assistant_impersonation = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openrouter_use_fallback').on('input', function () {
        oai_settings.openrouter_use_fallback = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openrouter_allow_fallbacks').on('input', function () {
        oai_settings.openrouter_allow_fallbacks = !!$(this).prop('checked');
        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        saveSettingsDebounced();
    });

    $('#openrouter_middleout').on('input', function () {
        oai_settings.openrouter_middleout = String($(this).val());
        saveSettingsDebounced();
    });

    $('#squash_system_messages').on('input', function () {
        oai_settings.squash_system_messages = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openai_media_inlining').on('input', function () {
        oai_settings.media_inlining = !!$(this).prop('checked');
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#openai_inline_image_quality').on('input', function () {
        oai_settings.inline_image_quality = String($(this).val());
        saveSettingsDebounced();
    });

    $('#continue_prefill').on('input', function () {
        oai_settings.continue_prefill = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#openai_function_calling').on('input', function () {
        oai_settings.function_calling = !!$(this).prop('checked');
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#tool_call_recurse_limit').on('input', function () {
        oai_settings.tool_call_recurse_limit = Number($(this).val());
        $('#tool_call_recurse_limit_counter').val(oai_settings.tool_call_recurse_limit);
        ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit;
        saveSettingsDebounced();
    });

    $('#tool_reasoning_mode').on('input', function () {
        oai_settings.tool_reasoning_mode = getToolReasoningMode({
            ...oai_settings,
            tool_reasoning_mode: String($(this).val()),
        });
        saveSettingsDebounced();
    });

    $('#seed_openai').on('input', function () {
        oai_settings.seed = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#n_openai').on('input', function () {
        oai_settings.n = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#custom_api_url_text').on('input', function () {
        oai_settings.custom_url = String($(this).val());
        saveSettingsDebounced();
    });

    $('#custom_prompt_post_processing').on('change', function () {
        oai_settings.custom_prompt_post_processing = String($(this).val());
        updateFeatureSupportFlags();
        saveSettingsDebounced();
    });

    $('#names_behavior').on('input', function () {
        oai_settings.names_behavior = Number($(this).val());
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#azure_base_url').on('input', function () {
        oai_settings.azure_base_url = String($(this).val());
        saveSettingsDebounced();
    });

    $('#azure_deployment_name').on('input', function () {
        oai_settings.azure_deployment_name = String($(this).val());
        saveSettingsDebounced();
    });

    $('#azure_api_version').on('input change', function () {
        oai_settings.azure_api_version = String($(this).val());
        saveSettingsDebounced();
    });

    $('#character_names_none').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.NONE;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_default').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.DEFAULT;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_completion').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.COMPLETION;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#character_names_content').on('input', function () {
        oai_settings.names_behavior = character_names_behavior.CONTENT;
        setNamesBehaviorControls();
        saveSettingsDebounced();
    });

    $('#continue_postifx').on('input', function () {
        oai_settings.continue_postfix = String($(this).val());
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_none').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.NONE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_space').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.SPACE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_newline').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.NEWLINE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#continue_postfix_double_newline').on('input', function () {
        oai_settings.continue_postfix = continue_postfix_types.DOUBLE_NEWLINE;
        setContinuePostfixControls();
        saveSettingsDebounced();
    });

    $('#openai_show_thoughts').on('input', function () {
        oai_settings.show_thoughts = !!$(this).prop('checked');
        setToolReasoningControls();
        saveSettingsDebounced();
    });

    $('#openai_reasoning_effort').on('input', function () {
        oai_settings.reasoning_effort = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_verbosity').on('input', function () {
        oai_settings.verbosity = String($(this).val());
        saveSettingsDebounced();
    });

    $('#openai_enable_web_search').on('input', function () {
        oai_settings.enable_web_search = !!$(this).prop('checked');
        calculateOpenRouterCost();
        saveSettingsDebounced();
    });

    $('#openai_request_images').on('input', function () {
        oai_settings.request_images = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#request_image_resolution').on('input', function () {
        oai_settings.request_image_resolution = String($(this).val());
        saveSettingsDebounced();
    });

    $('#request_image_aspect_ratio').on('input', function () {
        oai_settings.request_image_aspect_ratio = String($(this).val());
        saveSettingsDebounced();
    });

    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#openai_settings .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    if (!isMobile()) {
        $('#model_openrouter_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getOpenRouterModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_aimlapi_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getAimlapiModelTemplate,
        });
        $('#model_electronhub_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getElectronHubModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_chutes_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getChutesModelTemplate,
            matcher: textValueMatcher,
        });
        $('#model_nanogpt_select').select2({
            placeholder: t`Select a model`,
            searchInputPlaceholder: t`Search models...`,
            searchInputCssClass: 'text_pole',
            width: '100%',
            templateResult: getNanoGptModelTemplate,
            matcher: textValueMatcher,
        });
        $('#completion_prompt_manager_popup_entry_form_injection_trigger').select2({
            placeholder: t`All types (default)`,
            width: '100%',
            closeOnSelect: false,
        });
    }

    $('#openrouter_providers_chat').on('change', function () {
        const selectedProviders = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedProviders)) {
            return;
        }

        oai_settings.openrouter_providers = selectedProviders;

        updateOpenRouterProvidersWarning('#openrouter_providers_chat');
        saveSettingsDebounced();
    });

    $('#openrouter_quantizations_chat').on('change', function () {
        const selectedQuantizations = $(this).val();

        // Not a multiple select?
        if (!Array.isArray(selectedQuantizations)) {
            return;
        }

        oai_settings.openrouter_quantizations = selectedQuantizations;

        saveSettingsDebounced();
    });

    $('#nanogpt_provider').on('change', function () {
        oai_settings.nanogpt_provider = String($(this).val() || '');
        updateNanoGptProvidersWarning('#nanogpt_provider');
        saveSettingsDebounced();
    });

    $('#nanogpt_payg_override').on('input', function () {
        oai_settings.nanogpt_payg_override = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#bind_preset_to_connection').on('input', function () {
        oai_settings.bind_preset_to_connection = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cc_group_models').on('input', async () => {
        oai_settings.group_models = $('#cc_group_models').prop('checked');
        reconnectOpenAi();
        saveSettingsDebounced();
    });

    $('#cc_sort_models').on('input', async () => {
        oai_settings.sort_models = $('#cc_sort_models').val().toString();
        reconnectOpenAi();
        saveSettingsDebounced();
    });

    $('#api_button_openai').on('click', onConnectButtonClick);
    $('#openai_reverse_proxy').on('input', onReverseProxyInput);

    // Input-driven sources all share the same "input is source of truth, select
    // is a picker that mirrors it" wiring (Claude/OpenAI/etc + Custom).
    for (const { input, select, key } of INPUT_BASED_MODEL_BINDINGS) {
        $(input).on('input', function () {
            const value = String($(this).val() || '').trim();
            oai_settings[key] = value;
            const $picker = $(select);
            if (value && $picker.find(`option[value="${CSS.escape(value)}"]`).length > 0) {
                $picker.val(value);
            } else {
                $picker.val('');
            }
            saveSettingsDebounced();
        });
        $(select).on('change', onModelChange);
    }

    $('#vertexai_auth_mode').on('change', onVertexAIAuthModeChange);
    $('#vertexai_region').on('input', function () {
        oai_settings.vertexai_region = String($(this).val());
        saveSettingsDebounced();
    });
    $('#vertexai_express_project_id').on('input', function () {
        oai_settings.vertexai_express_project_id = String($(this).val());
        saveSettingsDebounced();
    });
    $('#zai_endpoint').on('input', function () {
        oai_settings.zai_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#siliconflow_endpoint').on('input', function () {
        oai_settings.siliconflow_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#minimax_endpoint').on('input', function () {
        oai_settings.minimax_endpoint = String($(this).val());
        saveSettingsDebounced();
    });
    $('#workers_ai_account_id').on('input', function () {
        oai_settings.workers_ai_account_id = String($(this).val());
        saveSettingsDebounced();
    });
    $('#vertexai_service_account_json').on('input', onVertexAIServiceAccountJsonChange);
    $('#vertexai_validate_service_account').on('click', onVertexAIValidateServiceAccount);
    $('#vertexai_clear_service_account').on('click', onVertexAIClearServiceAccount);
    $('#model_openrouter_select').on('change', onModelChange);
    $('#model_ai21_select').on('change', onModelChange);
    $('#model_cohere_select').on('change', onModelChange);
    $('#model_perplexity_select').on('change', onModelChange);
    $('#model_groq_select').on('change', onModelChange);
    $('#model_chutes_select').on('change', onModelChange);
    $('#model_siliconflow_select').on('change', onModelChange);
    $('#model_minimax_select').on('change', onModelChange);
    $('#model_electronhub_select').on('change', onModelChange);
    $('#model_nanogpt_select').on('change', onModelChange);
    $('#model_aimlapi_select').on('change', onModelChange);
    $('#model_pollinations_select').on('change', onModelChange);
    $('#model_cometapi_select').on('change', onModelChange);
    $('#model_fireworks_select').on('change', onModelChange);
    $('#azure_openai_model').on('change', onModelChange);
    $('#model_workers_ai_select').on('change', onModelChange);
    $('#settings_preset_openai').on('change', onSettingsPresetChange);
    $('#new_oai_preset').on('click', onNewPresetClick);
    $('#delete_oai_preset').on('click', onDeletePresetClick);
    $('#openai_logit_bias_preset').on('change', onLogitBiasPresetChange);
    $('#openai_logit_bias_new_preset').on('click', createNewLogitBiasPreset);
    $('#openai_logit_bias_new_entry').on('click', createNewLogitBiasEntry);
    $('#openai_logit_bias_import_file').on('input', onLogitBiasPresetImportFileChange);
    $('#openai_preset_import_file').on('input', onPresetImportFileChange);
    $('#export_oai_preset').on('click', onExportPresetClick);
    $('#openai_logit_bias_import_preset').on('click', onLogitBiasPresetImportClick);
    $('#openai_logit_bias_export_preset').on('click', onLogitBiasPresetExportClick);
    $('#openai_logit_bias_delete_preset').on('click', onLogitBiasPresetDeleteClick);
    $('#import_oai_preset').on('click', onImportPresetClick);
    $('#openai_proxy_password_show').on('click', onProxyPasswordShowClick);
    $('#customize_additional_parameters').on('click', onCustomizeParametersClick);
    $('#openai_proxy_preset').on('change', onProxyPresetChange);

    eventSource.makeFirst(event_types.CHAT_CHANGED, onOpenAIChatChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, syncCharacterBoundPresetFromSettings);
}

async function onOpenAIChatChanged() {
    await maybeApplyCharacterBoundPreset();
}
