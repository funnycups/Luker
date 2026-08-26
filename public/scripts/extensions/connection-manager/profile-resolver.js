import { CONNECT_API_MAP } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { chat_completion_sources, proxies } from '../../openai.js';

let _chatModelSettingBySource;
function getChatModelSettingBySource() {
    if (!_chatModelSettingBySource) {
        _chatModelSettingBySource = {
            [chat_completion_sources.OPENAI]: 'openai_model',
            [chat_completion_sources.CLAUDE]: 'claude_model',
            [chat_completion_sources.OPENROUTER]: 'openrouter_model',
            [chat_completion_sources.AI21]: 'ai21_model',
            [chat_completion_sources.MAKERSUITE]: 'google_model',
            [chat_completion_sources.VERTEXAI]: 'vertexai_model',
            [chat_completion_sources.MISTRALAI]: 'mistralai_model',
            [chat_completion_sources.CUSTOM]: 'custom_model',
            [chat_completion_sources.COHERE]: 'cohere_model',
            [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
            [chat_completion_sources.GROQ]: 'groq_model',
            [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
            [chat_completion_sources.CHUTES]: 'chutes_model',
            [chat_completion_sources.NANOGPT]: 'nanogpt_model',
            [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
            [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
            [chat_completion_sources.XAI]: 'xai_model',
            [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
            [chat_completion_sources.MOONSHOT]: 'moonshot_model',
            [chat_completion_sources.FIREWORKS]: 'fireworks_model',
            [chat_completion_sources.COMETAPI]: 'cometapi_model',
            [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
            [chat_completion_sources.ZAI]: 'zai_model',
            [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
            [chat_completion_sources.OPENAI_RESPONSES]: 'openai_responses_model',
        };
    }
    return _chatModelSettingBySource;
}

let _apiAliasToChatSource;
function getApiAliasToChatSource() {
    if (!_apiAliasToChatSource) {
        _apiAliasToChatSource = {
            openai: chat_completion_sources.OPENAI,
            claude: chat_completion_sources.CLAUDE,
            openrouter: chat_completion_sources.OPENROUTER,
            ai21: chat_completion_sources.AI21,
            makersuite: chat_completion_sources.MAKERSUITE,
            vertexai: chat_completion_sources.VERTEXAI,
            mistralai: chat_completion_sources.MISTRALAI,
            custom: chat_completion_sources.CUSTOM,
            cohere: chat_completion_sources.COHERE,
            perplexity: chat_completion_sources.PERPLEXITY,
            groq: chat_completion_sources.GROQ,
            electronhub: chat_completion_sources.ELECTRONHUB,
            chutes: chat_completion_sources.CHUTES,
            nanogpt: chat_completion_sources.NANOGPT,
            deepseek: chat_completion_sources.DEEPSEEK,
            aimlapi: chat_completion_sources.AIMLAPI,
            xai: chat_completion_sources.XAI,
            pollinations: chat_completion_sources.POLLINATIONS,
            moonshot: chat_completion_sources.MOONSHOT,
            fireworks: chat_completion_sources.FIREWORKS,
            cometapi: chat_completion_sources.COMETAPI,
            azure_openai: chat_completion_sources.AZURE_OPENAI,
            zai: chat_completion_sources.ZAI,
            siliconflow: chat_completion_sources.SILICONFLOW,
            openai_responses: chat_completion_sources.OPENAI_RESPONSES,
        };
    }
    return _apiAliasToChatSource;
}

export function getChatCompletionConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) {
        return [];
    }

    return profiles
        .filter(profile => profile && typeof profile === 'object' && String(profile.mode || '') === 'cc')
        .map(profile => ({ ...profile, name: String(profile.name || '').trim() }))
        .filter(profile => profile.name)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export function getChatCompletionConnectionProfileByName(name = '') {
    const target = String(name || '').trim();
    if (!target) {
        return null;
    }
    return getChatCompletionConnectionProfiles().find(profile => profile.name === target) || null;
}

function resolveChatSourceFromApiAlias(value, fallbackSource = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return String(fallbackSource || '').trim();
    }

    const aliasMap = getApiAliasToChatSource();
    if (aliasMap[normalized]) {
        return aliasMap[normalized];
    }

    const mapEntry = Object.entries(CONNECT_API_MAP || {})
        .find(([alias]) => String(alias || '').toLowerCase() === normalized)?.[1];
    if (mapEntry?.selected === 'openai' && mapEntry?.source) {
        return String(mapEntry.source);
    }

    return String(fallbackSource || '').trim();
}

function resolveRequestApiFromProfile(defaultApi, profile) {
    if (!profile) {
        return defaultApi;
    }

    const alias = String(profile.api || '').trim().toLowerCase();
    if (!alias) {
        return defaultApi;
    }

    const mapEntry = CONNECT_API_MAP?.[alias];
    const selectedApi = String(mapEntry?.selected || '').trim();
    if (selectedApi) {
        return selectedApi;
    }

    if (alias === 'koboldhorde') {
        return 'kobold';
    }
    return defaultApi;
}

function parseProfileBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return null;
}

function parseProfileInteger(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return null;
    }

    return Math.max(1, Math.round(numeric));
}

function parseProfileStringList(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item));
    }
    const raw = String(value ?? '').trim();
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(item => String(item)) : null;
    } catch {
        return null;
    }
}

function buildApiSettingsOverrideFromProfile(profile, fallbackSource = '') {
    if (!profile) {
        return null;
    }

    const overrides = {};
    const source = resolveChatSourceFromApiAlias(profile.api, fallbackSource);
    if (source) {
        overrides.chat_completion_source = source;
    }

    const resolvedSource = String(source || fallbackSource || '').trim();
    const modelField = getChatModelSettingBySource()[resolvedSource];
    const modelValue = String(profile.model || '').trim();
    if (modelField && modelValue) {
        overrides[modelField] = modelValue;
    }

    const apiUrlValue = String(profile['api-url'] || '').trim();
    if (apiUrlValue) {
        if (resolvedSource === chat_completion_sources.CUSTOM) {
            overrides.custom_url = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.VERTEXAI) {
            overrides.vertexai_region = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.ZAI) {
            overrides.zai_endpoint = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.OPENAI_RESPONSES) {
            overrides.responses_url = apiUrlValue;
        }
    }

    // Always overwrite cross-source connection fields so a sibling source's
    // main-API value can't leak into this profile's request. Without this,
    // getSettingsForRequest's structuredClone(oai_settings) would carry the
    // main API's base_url / reverse_proxy into the override-merged settings —
    // e.g. a Claude main API with `https://proxy/v1` would bleed into a
    // plugin-side Gemini recall and produce `/v1/v1beta/models/...:generateContent`.
    overrides.base_url = String(profile['base-url'] || '');

    const promptPostProcessing = String(profile['prompt-post-processing'] || '').trim();
    if (promptPostProcessing) {
        overrides.custom_prompt_post_processing = promptPostProcessing;
    }

    if (Object.hasOwn(profile, 'function-calling-plain-text')) {
        const plainTextFunctionCalling = parseProfileBoolean(profile['function-calling-plain-text']);
        if (plainTextFunctionCalling !== null) {
            overrides.function_calling_plain_text = plainTextFunctionCalling;
        }
    }

    if (Object.hasOwn(profile, 'function-calling-plain-text-error-retry')) {
        const plainTextFunctionCallingErrorRetry = parseProfileBoolean(profile['function-calling-plain-text-error-retry']);
        if (plainTextFunctionCallingErrorRetry !== null) {
            overrides.function_calling_plain_text_error_retry = plainTextFunctionCallingErrorRetry;
        }
    }

    if (Object.hasOwn(profile, 'function-calling-plain-text-error-retry-max-attempts')) {
        const plainTextFunctionCallingErrorRetryMaxAttempts = parseProfileInteger(profile['function-calling-plain-text-error-retry-max-attempts']);
        if (plainTextFunctionCallingErrorRetryMaxAttempts !== null) {
            overrides.function_calling_plain_text_error_retry_max_attempts = plainTextFunctionCallingErrorRetryMaxAttempts;
        }
    }

    if (Object.hasOwn(profile, 'claude-enable-system-prompt-cache')) {
        const value = parseProfileBoolean(profile['claude-enable-system-prompt-cache']);
        if (value !== null) {
            overrides.claude_enable_system_prompt_cache = value;
        }
    }

    if (Object.hasOwn(profile, 'claude-extended-ttl')) {
        const value = parseProfileBoolean(profile['claude-extended-ttl']);
        if (value !== null) {
            overrides.claude_extended_ttl = value;
        }
    }

    if (Object.hasOwn(profile, 'claude-caching-at-depth')) {
        const numeric = Number(profile['claude-caching-at-depth']);
        if (Number.isInteger(numeric)) {
            overrides.claude_caching_at_depth = numeric < 0 ? -1 : numeric;
        }
    }

    if (Object.hasOwn(profile, 'gemini-enable-system-prompt-cache')) {
        const value = parseProfileBoolean(profile['gemini-enable-system-prompt-cache']);
        if (value !== null) {
            overrides.gemini_enable_system_prompt_cache = value;
        }
    }

    if (Object.hasOwn(profile, 'openrouter-providers')) {
        const parsed = parseProfileStringList(profile['openrouter-providers']);
        if (parsed !== null) {
            overrides.openrouter_providers = parsed;
        }
    }

    if (Object.hasOwn(profile, 'openrouter-quantizations')) {
        const parsed = parseProfileStringList(profile['openrouter-quantizations']);
        if (parsed !== null) {
            overrides.openrouter_quantizations = parsed;
        }
    }

    if (Object.hasOwn(profile, 'openrouter-allow-fallbacks')) {
        const value = parseProfileBoolean(profile['openrouter-allow-fallbacks']);
        if (value !== null) {
            overrides.openrouter_allow_fallbacks = value;
        }
    }

    if (Object.hasOwn(profile, 'openrouter-use-fallback')) {
        const value = parseProfileBoolean(profile['openrouter-use-fallback']);
        if (value !== null) {
            overrides.openrouter_use_fallback = value;
        }
    }

    if (Object.hasOwn(profile, 'openrouter-middleout')) {
        const raw = String(profile['openrouter-middleout'] ?? '').trim().toLowerCase();
        if (['auto', 'on', 'off'].includes(raw)) {
            overrides.openrouter_middleout = raw;
        }
    }

    if (Object.hasOwn(profile, 'custom-include-body')) {
        overrides.custom_include_body = String(profile['custom-include-body'] ?? '');
    }

    if (Object.hasOwn(profile, 'custom-exclude-body')) {
        overrides.custom_exclude_body = String(profile['custom-exclude-body'] ?? '');
    }

    if (Object.hasOwn(profile, 'custom-include-headers')) {
        overrides.custom_include_headers = String(profile['custom-include-headers'] ?? '');
    }

    const secretId = String(profile['secret-id'] || '').trim();
    if (secretId) {
        overrides.secret_id = secretId;
    }

    const proxyName = String(profile.proxy || '').trim();
    const proxyPreset = proxyName && Array.isArray(proxies)
        ? proxies.find(item => String(item?.name || '') === proxyName)
        : null;
    if (proxyPreset) {
        overrides.reverse_proxy = String(proxyPreset.url || '');
        overrides.proxy_password = String(proxyPreset.password || '');
    } else {
        // Same anti-bleed rationale as base_url above: always write these
        // (possibly to empty string) so the main API's proxy doesn't carry
        // over when this profile didn't pick a proxy preset.
        overrides.reverse_proxy = String(profile['proxy-url'] || '');
        overrides.proxy_password = String(profile['proxy-password'] || '');
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
}

export function resolveChatCompletionRequestProfile({
    profileName = '',
    defaultSource = '',
    defaultApi = 'openai',
} = {}) {
    const profile = getChatCompletionConnectionProfileByName(profileName);
    const requestApi = resolveRequestApiFromProfile(String(defaultApi || 'openai').trim() || 'openai', profile);
    const apiSettingsOverride = buildApiSettingsOverrideFromProfile(profile, defaultSource);
    return {
        profile,
        requestApi,
        apiSettingsOverride,
    };
}
