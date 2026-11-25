// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Shared OpenAI-compatible chat-completions dispatch covering 13 providers
// that speak the OpenAI Chat Completions wire format and share one upstream
// fetch/relay tail.
//
// Providers routed here (dispatch key = ctx.body.chat_completion_source):
//   OPENAI, OPENROUTER, CUSTOM, PERPLEXITY, GROQ, FIREWORKS, NANOGPT,
//   POLLINATIONS, MOONSHOT, COMETAPI, ZAI, SILICONFLOW, WORKERS_AI
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import {
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENROUTER_HEADERS,
    POLLINATIONS_ENDPOINT,
    SILICONFLOW_ENDPOINT,
    ZAI_ENDPOINT,
} from '../../../constants.js';
import { createHmac } from 'node:crypto';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { getCookieSecret } from '../../../users.js';
import { TEXT_COMPLETION_MODELS } from '../../../endpoints/tokenizers.js';
import {
    getConfigValue,
    modelIdMatchesFamily,
    uuidv4,
} from '../../../util.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';
import {
    addAssistantPrefix,
    addOpenRouterSignatures,
    cachingAtDepthForOpenRouterClaude,
    cachingSystemPromptForOpenRouter,
    convertTextCompletionPrompt,
    embedOpenRouterMedia,
    getPromptNames,
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    renameAssistantReasoningToReasoningContent,
    stripNonChatReplayFields,
} from '../../../prompt-converters.js';
import { GeminiHistoryCache } from '../../gemini-history-cache.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { resolveOpenAIEffort, passthroughReasoningEffort, applyReasoningExclude, normalizeReasoningToken } from './reasoning-params.js';
import { applyAdditionalParameters } from './custom-params.js';
import {
    emitCapabilityConflict,
    handleProviderDispatchError,
    relayUpstreamResponse,
    resolveClaudeCacheConfig,
} from './upstream-relay.js';
import {
    resolveOpenAIModelCapabilities,
    validateOpenAIChatCapabilities,
} from '../../../../public/scripts/lib/provider-capabilities.js';

const geminiHistoryCache = new GeminiHistoryCache();

const API_OPENAI = 'https://api.openai.com/v1';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_POLLINATIONS = 'https://gen.pollinations.ai/v1';
const API_POLLINATIONS_ANON = 'https://text.pollinations.ai/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4';
const API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Lazily-cached HMAC key (instance cookie secret) for session-affinity hashing.
 * @type {string|undefined}
 */
let affinityKey;
function getAffinityKey() {
    if (affinityKey === undefined) {
        affinityKey = getCookieSecret(globalThis.DATA_ROOT);
    }
    return affinityKey;
}

// Cache for cacheable (writing) OpenRouter model IDs, populated on demand by
// isOpenRouterModelCacheable.
const openRouterCacheableModels = [];

/**
 * Build a minimal request shim for helpers expecting `.body` (e.g. getPromptNames).
 * @param {object} ctx DispatchContext
 * @returns {{ body: any }}
 */
function shim(ctx) {
    return { body: ctx.body };
}

/**
 * Resolve Gemini system-prompt caching toggle from body or config.yaml.
 * @param {object} body ctx.body
 */
function resolveGeminiSystemPromptCache(body) {
    const fromBody = body?.gemini_enable_system_prompt_cache;
    return typeof fromBody === 'boolean'
        ? fromBody
        : getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');
}

/**
 * @param {object} body ctx.body
 * @returns {string[] | undefined}
 */
function getOpenRouterTransforms(body) {
    switch (body.middleout) {
        case 'on': return ['middle-out'];
        case 'off': return [];
        case 'auto': return undefined;
    }
}

/**
 * @param {object} body ctx.body
 * @returns {any[]}
 */
function getOpenRouterPlugins(body) {
    const plugins = [];
    if (body.enable_web_search) plugins.push({ 'id': 'web' });
    return plugins;
}

/**
 * Query OpenRouter's models endpoint to verify prompt-cache write support.
 * @param {object} ctx DispatchContext
 * @param {string} modelId
 * @returns {Promise<boolean|null>} true/false when verified from the models
 *   API, null when verification could not be performed (network failure,
 *   non-ok response, unexpected payload).
 */
async function isOpenRouterModelCacheable(ctx, modelId) {
    if (openRouterCacheableModels.includes(modelId)) return true;
    try {
        const response = await ctx.fetch('https://openrouter.ai/api/v1/models', {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
            return null;
        }
        /** @type {any} */
        const data = await response.json();
        if (!Array.isArray(data?.data)) {
            console.warn('OpenRouter API response format unexpected');
            return null;
        }
        const model = data.data.find(m => m.id === modelId);
        if (!model) return false;
        const supportsCache = model?.pricing?.input_cache_write != null;
        if (supportsCache) openRouterCacheableModels.push(modelId);
        return supportsCache;
    } catch (error) {
        console.warn(`Failed to check OpenRouter cache support for ${modelId}:`, error.message);
        return null;
    }
}

/**
 * Mutates bodyParams to request `json_object` output and appends a schema-hint
 * user message for providers without native json_schema support.
 * @param {object} bodyParams
 * @param {any[]} messages
 * @param {object} jsonSchema
 */
function setJsonObjectFormat(bodyParams, messages, jsonSchema) {
    bodyParams.response_format = { type: 'json_object' };
    const message = {
        role: 'user',
        content: `JSON schema for the response:\n${JSON.stringify(jsonSchema.value, null, 4)}`,
    };
    messages.push(message);
}

// ---------------------------------------------------------------------------
// Per-provider resolvers. Each returns:
//   { apiUrl, apiKey, headers, bodyParams }
// or throws (async allowed) to short-circuit dispatch.
// ---------------------------------------------------------------------------

/** OPENAI */
async function resolveOpenAI(ctx) {
    const body = ctx.body;
    const isTextCompletion = detectTextCompletion(body);
    const apiUrl = normalizeProviderBaseUrl('openai', body.reverse_proxy || body.base_url || API_OPENAI);
    const apiKey = body.proxy_password || ctx.secrets.read(SECRET_KEYS.OPENAI) || '';
    const headers = {};
    /** @type {any} */
    const bodyParams = {
        logprobs: body.logprobs,
        top_logprobs: undefined,
    };
    if (!isTextCompletion && bodyParams.logprobs > 0) {
        bodyParams.top_logprobs = bodyParams.logprobs;
        bodyParams.logprobs = true;
    }
    if (!isTextCompletion && body.stream) {
        // Native OpenAI Chat Completions streaming requires explicit opt-in to emit usage.
        bodyParams.stream_options = { include_usage: true };
    }
    if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
        bodyParams.user = uuidv4();
    }
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    return { apiUrl, apiKey, headers, bodyParams };
}

/** OPENROUTER */
async function resolveOpenRouter(ctx) {
    const body = ctx.body;
    const apiUrl = 'https://openrouter.ai/api/v1';
    const apiKey = ctx.secrets.read(SECRET_KEYS.OPENROUTER);
    /** @type {any} */
    const headers = { ...OPENROUTER_HEADERS };
    const includeReasoning = Boolean(body.include_reasoning);
    const { cacheTTL, enableSystemPromptCache, cachingAtDepth } = resolveClaudeCacheConfig(body);
    /** @type {any} */
    const bodyParams = {
        transforms: getOpenRouterTransforms(body),
        plugins: getOpenRouterPlugins(body),
        reasoning: {},
    };
    applyReasoningExclude(bodyParams.reasoning, includeReasoning);
    if (body.logprobs > 0) {
        bodyParams.top_logprobs = body.logprobs;
        bodyParams.logprobs = true;
    }
    if (body.min_p !== undefined) bodyParams.min_p = body.min_p;
    if (body.top_a !== undefined) bodyParams.top_a = body.top_a;
    if (body.repetition_penalty !== undefined) bodyParams.repetition_penalty = body.repetition_penalty;
    if (Array.isArray(body.provider) && body.provider.length > 0) {
        bodyParams.provider = {
            allow_fallbacks: body.allow_fallbacks ?? true,
            order: body.provider ?? [],
        };
    }
    if (Array.isArray(body.quantizations) && body.quantizations.length > 0) {
        bodyParams.provider ??= {};
        bodyParams.provider.quantizations = body.quantizations;
    }
    if (body.use_fallback) bodyParams.route = 'fallback';
    const openrouterEffort = passthroughReasoningEffort(body.reasoning_effort);
    if (openrouterEffort) bodyParams.reasoning.effort = openrouterEffort;
    if (body.verbosity) bodyParams.verbosity = body.verbosity;
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: body.json_schema.name,
                strict: body.json_schema.strict ?? true,
                schema: body.json_schema.value,
            },
        };
    }
    const isClaude = /^anthropic\/claude/.test(body.model);
    const isGemini = /google\/gemini/.test(body.model);
    const modelCacheSupport = isGemini ? await isOpenRouterModelCacheable(ctx, body.model) : false;
    const enableGeminiSystemPromptCache = resolveGeminiSystemPromptCache(body);
    const enableGeminiHistoryCache = typeof body.gemini_enable_history_cache === 'boolean'
        ? body.gemini_enable_history_cache
        : getConfigValue('gemini.enableHistoryCache', false, 'boolean');
    // The models API is only advisory for cache eligibility. When it cannot be
    // reached, fall back to sending the request without markers instead of
    // failing the whole generation; the provider ignores stray cache markers.
    if (isGemini && enableGeminiHistoryCache && modelCacheSupport === false) {
        throw new Error('OpenRouter Gemini history cache: this model does not support explicit caching.');
    }
    if (isGemini && enableGeminiHistoryCache && modelCacheSupport === null) {
        console.warn('OpenRouter Gemini history cache: model cache support could not be verified, skipping markers for this request.');
    }
    const isCacheableGemini = modelCacheSupport === true;
    if (Array.isArray(body.messages)) {
        embedOpenRouterMedia(body.messages, { audio: true, video: true });
        addOpenRouterSignatures(body.messages, body.model);
        if (isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(body.messages, cacheTTL);
            }
            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(body.messages, cachingAtDepth, cacheTTL);
            }
        }
        if (isCacheableGemini && enableGeminiSystemPromptCache && !enableGeminiHistoryCache) {
            cachingSystemPromptForOpenRouter(body.messages);
        }
    }
    if (isGemini) bodyParams.safety_settings = GEMINI_SAFETY;
    const geminiCacheOptions = isCacheableGemini && enableGeminiHistoryCache ? {
        scope: JSON.stringify([ctx.user?.handle, apiKey]),
        session: body.gemini_cache_session,
        keepRecentTurns: body.gemini_cache_keep_recent_turns
            ?? getConfigValue('gemini.cacheKeepRecentTurns', 2, 'number'),
    } : null;
    return { apiUrl, apiKey, headers, bodyParams, geminiCacheOptions };
}

/** CUSTOM */
async function resolveCustom(ctx) {
    const body = ctx.body;
    const isTextCompletion = detectTextCompletion(body);
    const apiUrl = normalizeProviderBaseUrl('custom', body.custom_url);
    const apiKey = ctx.secrets.read(SECRET_KEYS.CUSTOM);
    /** @type {any} */
    const headers = {};
    /** @type {any} */
    const bodyParams = {
        logprobs: body.logprobs,
        top_logprobs: undefined,
    };
    if (!isTextCompletion && bodyParams.logprobs > 0) {
        bodyParams.top_logprobs = bodyParams.logprobs;
        bodyParams.logprobs = true;
    }
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: body.json_schema.name,
                strict: body.json_schema.strict ?? true,
                schema: body.json_schema.value,
            },
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** PERPLEXITY */
async function resolvePerplexity(ctx) {
    const body = ctx.body;
    const apiUrl = API_PERPLEXITY;
    const apiKey = ctx.secrets.read(SECRET_KEYS.PERPLEXITY);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    const effort = passthroughReasoningEffort(body.reasoning_effort);
    if (effort) bodyParams.reasoning_effort = effort;
    body.messages = postProcessPrompt(stripNonChatReplayFields(body.messages), PROMPT_PROCESSING_TYPE.STRICT, getPromptNames(shim(ctx)));
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: { schema: body.json_schema.value },
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** GROQ */
async function resolveGroq(ctx) {
    const body = ctx.body;
    const apiUrl = API_GROQ;
    const apiKey = ctx.secrets.read(SECRET_KEYS.GROQ);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    // Groq only accepts reasoning_effort on Qwen3 and GPT-OSS models; other
    // models reject a non-default value with a 400. GPT-OSS does not support
    // reasoning_format, so it is only used to hide reasoning elsewhere.
    const isGroqGptOss = /gpt-oss/i.test(body.model);
    const groqSupportsEffort = /qwen3|gpt-oss/i.test(body.model);
    const groqToken = normalizeReasoningToken(body.reasoning_effort);
    if (groqToken === 'off') {
        if (!isGroqGptOss) bodyParams.reasoning_format = 'hidden';
    } else if (groqToken !== 'auto' && groqSupportsEffort) {
        bodyParams.reasoning_effort = groqToken;
    }
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: body.json_schema.name,
                description: body.json_schema.description,
                schema: body.json_schema.value,
                strict: body.json_schema.strict ?? true,
            },
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** FIREWORKS */
async function resolveFireworks(ctx) {
    const body = ctx.body;
    const apiUrl = API_FIREWORKS;
    const apiKey = ctx.secrets.read(SECRET_KEYS.FIREWORKS);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    const effort = passthroughReasoningEffort(body.reasoning_effort);
    if (effort) {
        bodyParams.reasoning_effort = effort;
    }
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: body.json_schema.name,
                description: body.json_schema.description,
                schema: body.json_schema.value,
                strict: body.json_schema.strict ?? true,
            },
        };
    }
    if (body.chat_id) {
        headers['x-session-affinity'] = createHmac('sha256', getAffinityKey()).update(body.chat_id).digest('hex').slice(0, 16);
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** NANOGPT */
async function resolveNanogpt(ctx) {
    const body = ctx.body;
    const apiUrl = API_NANOGPT;
    const apiKey = ctx.secrets.read(SECRET_KEYS.NANOGPT);
    /** @type {any} */
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    const { cacheTTL, enableSystemPromptCache } = resolveClaudeCacheConfig(body);
    if (body.nanogpt_provider) headers['X-Provider'] = body.nanogpt_provider;
    if (body.nanogpt_payg_override) {
        headers['X-Billing-Mode'] = 'paygo';
        bodyParams.billing_mode = 'paygo';
    }
    if (body.enable_web_search && !/:online$/.test(body.model)) {
        body.model = `${body.model}:online`;
    }
    if (body.min_p !== undefined) bodyParams.min_p = body.min_p;
    if (body.top_a !== undefined) bodyParams.top_a = body.top_a;
    if (body.repetition_penalty !== undefined) bodyParams.repetition_penalty = body.repetition_penalty;
    const effort = passthroughReasoningEffort(body.reasoning_effort);
    const reasoning = {};
    if (effort) reasoning.effort = effort;
    if (!body.include_reasoning) reasoning.exclude = true;
    if (Object.keys(reasoning).length) bodyParams.reasoning = reasoning;
    const isClaude = /(?:^|\/)claude[-_]/.test(body.model);
    if (enableSystemPromptCache && isClaude) {
        bodyParams.cache_control = { 'enabled': true, 'ttl': cacheTTL };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** POLLINATIONS (uses explicit secret_id lookup) */
async function resolvePollinations(ctx) {
    const body = ctx.body;
    const isAnonymous = body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
    const apiUrl = isAnonymous ? API_POLLINATIONS_ANON : API_POLLINATIONS;
    const secretId = typeof body.secret_id === 'string' ? body.secret_id : undefined;
    const apiKey = isAnonymous ? 'anonymous' : ctx.secrets.read(SECRET_KEYS.POLLINATIONS, { secretId });
    const headers = {};
    /** @type {any} */
    const bodyParams = {
        seed: body.seed ?? Math.floor(Math.random() * 99999999),
    };
    if (!isAnonymous) {
        const effort = passthroughReasoningEffort(body.reasoning_effort);
        if (effort) bodyParams.reasoning_effort = effort;
        if (body.json_schema) {
            bodyParams.response_format = {
                type: 'json_schema',
                json_schema: { schema: body.json_schema.value },
            };
        }
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

function applyKimiPartial(messages, content, name) {
    if (!Array.isArray(messages) || !messages.length) {
        return;
    }
    const toolInvolved = messages.some((message) =>
        (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) || message?.role === 'tool');
    if (toolInvolved) {
        return;
    }
    const prefix = typeof content === 'string' ? content : '';
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && (typeof last.content === 'string' || last.content == null)) {
        last.content = `${last.content ?? ''}${prefix}`;
        last.partial = true;
        return;
    }
    const injected = { role: 'assistant', content: prefix, partial: true };
    if (name) {
        injected.name = String(name);
    }
    messages.push(injected);
}

/**
 * Kimi reasoning params differ per model family (platform.moonshot.ai docs):
 *   kimi-k3        — top-level `reasoning_effort` (low/high/max), thinking always on
 *   kimi-k2.6      — `thinking.type` enabled/disabled
 *   kimi-k2.7-code — thinking always on, only `enabled` accepted
 * Other models accept neither field.
 *
 * Family detection matches on the LAST path segment so vendor-prefixed ids
 * (moonshotai/kimi-k3, moonshot/kimi-k2.6, ...) resolve to the same family.
 */
function getKimiModelFamily(model) {
    if (modelIdMatchesFamily(model, /^kimi-k3/)) {
        return 'k3';
    }
    if (modelIdMatchesFamily(model, /^kimi-k2\.7-code/)) {
        return 'k2.7-code';
    }
    if (modelIdMatchesFamily(model, /^kimi-k2\.6/)) {
        return 'k2.6';
    }
    return null;
}

function applyMoonshotReasoningParams(bodyParams, model, effort) {
    const token = normalizeReasoningToken(effort);
    const family = getKimiModelFamily(model);
    if (family === 'k3') {
        if (token === 'auto' || token === 'off') {
            return;
        }
        // K3 accepts low/high/max only; the canonical buckets collapse onto them.
        const K3_EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' };
        bodyParams.reasoning_effort = K3_EFFORT_MAP[token];
        return;
    }
    if (family === 'k2.7-code') {
        if (token === 'off') {
            return;
        }
        bodyParams.thinking = { type: 'enabled' };
        return;
    }
    if (family === 'k2.6') {
        // keep:'all' = Preserved Thinking. K2.6's server default is keep:null,
        // which silently drops echoed historical reasoning_content — without
        // this, the reasoning we replay from chat history is ignored upstream.
        bodyParams.thinking = { type: token === 'off' ? 'disabled' : 'enabled', keep: 'all' };
    }
}

/** MOONSHOT */
async function resolveMoonshot(ctx) {
    const body = ctx.body;
    const apiUrl = normalizeProviderBaseUrl('moonshot', body.reverse_proxy || body.base_url || API_MOONSHOT);
    const apiKey = body.proxy_password || ctx.secrets.read(SECRET_KEYS.MOONSHOT) || '';
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    applyMoonshotReasoningParams(bodyParams, body.model, body.reasoning_effort);
    // Kimi K3 / K2.7-code always keep Preserved Thinking; K2.6 with thinking.keep="all" does too.
    // In all cases, previous turns' reasoning must be echoed as `reasoning_content` (Moonshot's
    // field name), not `reasoning` (which is what setOpenAIMessages / getChat emit). Rename in place.
    renameAssistantReasoningToReasoningContent(body.messages);
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    } else if (body.kimi_partial === true) {
        applyKimiPartial(body.messages, body.kimi_partial_content, body.kimi_partial_name);
    } else {
        addAssistantPrefix(body.messages, [], 'partial');
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** COMETAPI (temporarily disabled upstream) */
async function resolveCometapi() {
    throw new Error('This provider is temporarily disabled.');
}

/** ZAI */
async function resolveZai(ctx) {
    const body = ctx.body;
    const defaultApiUrl = body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON;
    const apiUrl = normalizeProviderBaseUrl('zai', body.reverse_proxy || body.base_url || defaultApiUrl);
    const apiKey = body.proxy_password || ctx.secrets.read(SECRET_KEYS.ZAI) || '';
    const headers = { 'Accept-Language': 'en-US,en' };
    /** @type {any} */
    const bodyParams = {};
    const zaiToken = normalizeReasoningToken(body.reasoning_effort);
    if (zaiToken !== 'auto') {
        bodyParams.thinking = { type: zaiToken === 'off' ? 'disabled' : 'enabled' };
        if (zaiToken !== 'off') {
            bodyParams.reasoning_effort = zaiToken;
        }
    }
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** SILICONFLOW */
async function resolveSiliconflow(ctx) {
    const body = ctx.body;
    const apiUrl = body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
        ? API_SILICONFLOW_CN : API_SILICONFLOW;
    const apiKey = ctx.secrets.read(SECRET_KEYS.SILICONFLOW);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    if (body.min_p !== undefined) bodyParams.min_p = body.min_p;
    const siliconflowToken = normalizeReasoningToken(body.reasoning_effort);
    if (siliconflowToken !== 'auto') {
        bodyParams.enable_thinking = siliconflowToken !== 'off';
    }
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/**
 * WORKERS_AI
 * Uses explicit secret_id lookup and constructs a per-account URL.
 */
async function resolveWorkersai(ctx) {
    const body = ctx.body;
    const secretId = typeof body.secret_id === 'string' ? body.secret_id : undefined;
    const apiKey = ctx.secrets.read(SECRET_KEYS.WORKERS_AI, { secretId });
    const accountId = String(body.workers_ai_account_id || '').trim();
    if (!accountId) {
        throw new Error('Cloudflare Workers AI Account ID is missing.');
    }
    const apiUrl = `${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/v1`;
    const headers = {};
    /** @type {any} */
    const bodyParams = { repetition_penalty: body.repetition_penalty };
    const effort = passthroughReasoningEffort(body.reasoning_effort);
    if (effort) bodyParams.reasoning_effort = effort;
    if (body.json_schema) {
        bodyParams.response_format = {
            type: 'json_schema',
            json_schema: body.json_schema.value,
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

const RESOLVERS = {
    [CHAT_COMPLETION_SOURCES.OPENAI]: resolveOpenAI,
    [CHAT_COMPLETION_SOURCES.OPENROUTER]: resolveOpenRouter,
    [CHAT_COMPLETION_SOURCES.CUSTOM]: resolveCustom,
    [CHAT_COMPLETION_SOURCES.PERPLEXITY]: resolvePerplexity,
    [CHAT_COMPLETION_SOURCES.GROQ]: resolveGroq,
    [CHAT_COMPLETION_SOURCES.FIREWORKS]: resolveFireworks,
    [CHAT_COMPLETION_SOURCES.NANOGPT]: resolveNanogpt,
    [CHAT_COMPLETION_SOURCES.POLLINATIONS]: resolvePollinations,
    [CHAT_COMPLETION_SOURCES.MOONSHOT]: resolveMoonshot,
    [CHAT_COMPLETION_SOURCES.COMETAPI]: resolveCometapi,
    [CHAT_COMPLETION_SOURCES.ZAI]: resolveZai,
    [CHAT_COMPLETION_SOURCES.SILICONFLOW]: resolveSiliconflow,
    [CHAT_COMPLETION_SOURCES.WORKERS_AI]: resolveWorkersai,
};

/**
 * Detect text-completion mode.
 * @param {object} body ctx.body
 */
function detectTextCompletion(body) {
    return Boolean(body.model && TEXT_COMPLETION_MODELS.includes(body.model)) || typeof body.messages === 'string';
}

/**
 * Dispatch a chat-completion request to one of 13 OpenAI-compatible upstreams.
 * Results flow via ctx.emit.{head,chunk,end,error}. Never touches Express.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchOpenAICompatible(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();
    const source = body.chat_completion_source;
    const resolver = RESOLVERS[source];
    if (!resolver) {
        console.warn('This chat completion source is not supported yet.');
        const err = new Error(`OpenAI-compatible dispatch: unsupported source: ${source}`);
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const isTextCompletion = detectTextCompletion(body);
        const { apiUrl, apiKey, headers, bodyParams, geminiCacheOptions } = await resolver(ctx);

        // Reasoning effort. Official OpenAI stays on the model allowlist.
        // Custom forwards any resolved effort: the endpoint may be a proxy
        // whose model names are not in OPENAI_REASONING_EFFORT_MODELS.
        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const effort = passthroughReasoningEffort(body.reasoning_effort);
            if (effort) bodyParams.reasoning_effort = effort;
        } else if (source === CHAT_COMPLETION_SOURCES.OPENAI
            && (OPENAI_REASONING_EFFORT_MODELS.includes(body.model)
                || resolveOpenAIModelCapabilities(body.model).supportsReasoningEffort)) {
            const fixed = OPENAI_FIXED_REASONING_EFFORT[body.model];
            const effort = fixed ?? resolveOpenAIEffort(body.reasoning_effort, body.model);
            if (effort) bodyParams.reasoning_effort = effort;
        }

        // Verbosity — OPENAI/CUSTOM only, gated by model capability.
        if (body.verbosity && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(source)) {
            if (resolveOpenAIModelCapabilities(body.model).supportsVerbosity) {
                bodyParams.verbosity = body.verbosity;
            }
        }

        // Missing API key check (CUSTOM is exempt because it may be a local server).
        if (!apiKey && !body.base_url && !body.reverse_proxy && source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('OpenAI API key is missing.');
            const err = new Error('OpenAI API key is missing.');
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }

        // Custom stop sequences.
        if (Array.isArray(body.stop) && body.stop.length > 0) {
            bodyParams.stop = body.stop;
        }

        const textPrompt = isTextCompletion ? convertTextCompletionPrompt(body.messages) : '';
        const endpointUrl = isTextCompletion && source !== CHAT_COMPLETION_SOURCES.OPENROUTER
            ? `${apiUrl}/completions`
            : `${apiUrl}/chat/completions`;

        // Tools/tool_choice (chat-completion only).
        if (!isTextCompletion && Array.isArray(body.tools) && body.tools.length > 0) {
            if (source === CHAT_COMPLETION_SOURCES.OPENAI) {
                const capabilityConflict = validateOpenAIChatCapabilities({ model: body.model, hasTools: true });
                if (capabilityConflict) {
                    emitCapabilityConflict(ctx, capabilityConflict, 'OpenAI');
                    return;
                }
            }
            bodyParams.tools = body.tools;
            bodyParams.tool_choice = body.tool_choice;
        }

        // Fallback json_schema translation when the resolver did not already
        // set response_format (e.g. GROQ/FIREWORKS/OPENROUTER/CUSTOM handle
        // this themselves; OPENAI does not).
        if (body.json_schema && !bodyParams.response_format) {
            bodyParams.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    strict: body.json_schema.strict ?? true,
                    schema: body.json_schema.value,
                },
            };
        }

        /** @type {any} */
        const requestBody = {
            'messages': isTextCompletion === false ? stripNonChatReplayFields(body.messages) : undefined,
            'prompt': isTextCompletion === true ? textPrompt : undefined,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.max_tokens,
            'max_completion_tokens': body.max_completion_tokens,
            'stream': body.stream,
            'presence_penalty': body.presence_penalty,
            'frequency_penalty': body.frequency_penalty,
            'top_p': body.top_p,
            'top_k': body.top_k,
            'stop': isTextCompletion === false ? body.stop : undefined,
            'logit_bias': body.logit_bias,
            'seed': body.seed,
            'n': body.n,
            ...bodyParams,
        };

        if (geminiCacheOptions) {
            const plan = geminiHistoryCache.apply(requestBody, geminiCacheOptions);
            if (plan.reason === 'no-history' && resolveGeminiSystemPromptCache(body)) {
                cachingSystemPromptForOpenRouter(requestBody.messages);
            }
            console.debug('OpenRouter Gemini history cache:', plan);
        }

        applyAdditionalParameters(requestBody, headers, body);

        const requestHeaders = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            ...headers,
        };
        ctx.inspection.attach(endpointUrl, resolveEffectiveApiKey(requestHeaders, apiKey, ['authorization']), requestBody);

        console.debug('Chat Completion request:', requestBody);

        const resp = await ctx.fetch(endpointUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'OpenAI-compatible',
            stream: Boolean(requestBody.stream),
            logResponse: (json) => console.debug('Chat Completion response:', json),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'OpenAI-compatible');
    }
}
