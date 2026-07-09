// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Shared "OpenAI-compatible" chat-completions dispatch. Covers 13 providers
// that all speak the OpenAI Chat Completions wire format and share a single
// fetch/stream tail. Extracted from the legacy else-if cascade at
// src/endpoints/backends/chat-completions.js:2947-3396 (lines ~3251-3378 for
// the shared tail after the 13 per-provider branches).
//
// Providers routed here (dispatch key = ctx.body.chat_completion_source):
//   OPENAI, OPENROUTER, CUSTOM, PERPLEXITY, GROQ, FIREWORKS, NANOGPT,
//   POLLINATIONS, MOONSHOT, COMETAPI, ZAI, SILICONFLOW, WORKERS_AI
//
// Everything else (CLAUDE, AI21, MAKERSUITE, VERTEXAI, MISTRALAI, COHERE,
// DEEPSEEK, AIMLAPI, XAI, CHUTES, MINIMAX, ELECTRONHUB, AZURE_OPENAI) has
// its own dedicated dispatch file.
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js. Per-provider quirks
// (URL, key resolution, extra headers, body params) live in `resolveXxx`
// resolvers; the shared tail handles the fetch, stream forwarding, and
// error mapping.

import {
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    NANOGPT_REASONING_EFFORT_MAP,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENAI_VERBOSITY_MODELS,
    OPENROUTER_HEADERS,
    SILICONFLOW_ENDPOINT,
    ZAI_ENDPOINT,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { TEXT_COMPLETION_MODELS } from '../../../endpoints/tokenizers.js';
import {
    excludeKeysByYaml,
    getConfigValue,
    mergeObjectWithYaml,
    normalizeOpenAIBaseUrl,
    uuidv4,
} from '../../../util.js';
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
} from '../../../prompt-converters.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

// Provider base URLs (mirror the constants defined at the top of
// src/endpoints/backends/chat-completions.js:95-122).
const API_OPENAI = 'https://api.openai.com/v1';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_POLLINATIONS = 'https://gen.pollinations.ai/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4';
const API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';

// Cache for cacheable (writing) OpenRouter model IDs. Populated on-demand by
// isOpenRouterModelCacheable; mirrors the module-scope cache used by the
// legacy handler (chat-completions.js:171).
const openRouterCacheableModels = [];

/**
 * Build a minimal Express-request shim for legacy helpers that expect
 * `.body` (e.g. getPromptNames).
 * @param {object} ctx DispatchContext
 * @returns {{ body: any }}
 */
function shim(ctx) {
    return { body: ctx.body };
}

/**
 * Mirror of legacy resolveClaudeCacheConfig() in chat-completions.js:134.
 * Reads UI-driven body fields with config.yaml fallback.
 * @param {object} body ctx.body
 */
function resolveClaudeCacheConfig(body) {
    const sysFromBody = body?.claude_enable_system_prompt_cache;
    const depthFromBody = body?.claude_caching_at_depth;
    const ttlFromBody = body?.claude_extended_ttl;

    const enableSystemPromptCache = typeof sysFromBody === 'boolean'
        ? sysFromBody
        : getConfigValue('claude.enableSystemPromptCache', false, 'boolean');

    const useExtendedTtl = typeof ttlFromBody === 'boolean'
        ? ttlFromBody
        : getConfigValue('claude.extendedTTL', false, 'boolean');
    const cacheTTL = useExtendedTtl ? '1h' : '5m';

    const depthRaw = typeof depthFromBody === 'number'
        ? depthFromBody
        : getConfigValue('claude.cachingAtDepth', -1, 'number');
    const cachingAtDepth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : -1;

    return { cacheTTL, enableSystemPromptCache, cachingAtDepth };
}

/**
 * Mirror of legacy resolveGeminiSystemPromptCache() in chat-completions.js:160.
 * @param {object} body ctx.body
 */
function resolveGeminiSystemPromptCache(body) {
    const fromBody = body?.gemini_enable_system_prompt_cache;
    return typeof fromBody === 'boolean'
        ? fromBody
        : getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');
}

/**
 * Mirror of legacy getOpenRouterTransforms() in chat-completions.js:223.
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
 * Mirror of legacy getOpenRouterPlugins() in chat-completions.js:239.
 * @param {object} body ctx.body
 * @returns {any[]}
 */
function getOpenRouterPlugins(body) {
    const plugins = [];
    if (body.enable_web_search) plugins.push({ 'id': 'web' });
    return plugins;
}

/**
 * Mirror of legacy isOpenRouterModelCacheable() in chat-completions.js:179.
 * Uses ctx.fetch so tests can stub.
 * @param {object} ctx DispatchContext
 * @param {string} modelId
 * @returns {Promise<boolean>}
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
            return false;
        }
        /** @type {any} */
        const data = await response.json();
        if (!Array.isArray(data?.data)) {
            console.warn('OpenRouter API response format unexpected');
            return false;
        }
        const model = data.data.find(m => m.id === modelId);
        const supportsCache = model?.pricing?.input_cache_write != null;
        if (supportsCache) openRouterCacheableModels.push(modelId);
        return supportsCache;
    } catch (error) {
        console.warn(`Failed to check OpenRouter cache support for ${modelId}:`, error.message);
        return false;
    }
}

/**
 * Mirror of legacy setJsonObjectFormat() in chat-completions.js:255.
 * Mutates bodyParams and appends a schema-hint user message.
 * @param {object} bodyParams
 * @param {any[]} messages
 * @param {object} jsonSchema
 */
function setJsonObjectFormat(bodyParams, messages, jsonSchema) {
    bodyParams['response_format'] = { type: 'json_object' };
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

/** OPENAI — chat-completions.js:2947-2966 */
async function resolveOpenAI(ctx) {
    const body = ctx.body;
    const isTextCompletion = detectTextCompletion(body);
    const apiUrl = normalizeOpenAIBaseUrl(body.reverse_proxy || body.base_url || API_OPENAI);
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
    if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
        bodyParams['user'] = uuidv4();
    }
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    return { apiUrl, apiKey, headers, bodyParams };
}

/** OPENROUTER — chat-completions.js:2967-3055 */
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
        reasoning: { exclude: !includeReasoning },
    };
    if (body.min_p !== undefined) bodyParams['min_p'] = body.min_p;
    if (body.top_a !== undefined) bodyParams['top_a'] = body.top_a;
    if (body.repetition_penalty !== undefined) bodyParams['repetition_penalty'] = body.repetition_penalty;
    if (Array.isArray(body.provider) && body.provider.length > 0) {
        bodyParams['provider'] = {
            allow_fallbacks: body.allow_fallbacks ?? true,
            order: body.provider ?? [],
        };
    }
    if (Array.isArray(body.quantizations) && body.quantizations.length > 0) {
        bodyParams['provider'] ??= {};
        bodyParams['provider']['quantizations'] = body.quantizations;
    }
    if (body.use_fallback) bodyParams['route'] = 'fallback';
    if (body.reasoning_effort) bodyParams['reasoning']['effort'] = body.reasoning_effort;
    if (body.verbosity) bodyParams['verbosity'] = body.verbosity;
    if (body.json_schema) {
        bodyParams['response_format'] = {
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
    const isCacheableGemini = isGemini && await isOpenRouterModelCacheable(ctx, body.model);
    const enableGeminiSystemPromptCache = resolveGeminiSystemPromptCache(body);
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
        if (isCacheableGemini && enableGeminiSystemPromptCache) {
            cachingSystemPromptForOpenRouter(body.messages);
        }
    }
    if (isGemini) bodyParams['safety_settings'] = GEMINI_SAFETY;
    return { apiUrl, apiKey, headers, bodyParams };
}

/** CUSTOM — chat-completions.js:3056-3083 */
async function resolveCustom(ctx) {
    const body = ctx.body;
    const isTextCompletion = detectTextCompletion(body);
    const apiUrl = normalizeOpenAIBaseUrl(body.custom_url);
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
    mergeObjectWithYaml(bodyParams, body.custom_include_body);
    mergeObjectWithYaml(headers, body.custom_include_headers);
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    if (body.json_schema) {
        bodyParams['response_format'] = {
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

/** PERPLEXITY — chat-completions.js:3084-3099 */
async function resolvePerplexity(ctx) {
    const body = ctx.body;
    const apiUrl = API_PERPLEXITY;
    const apiKey = ctx.secrets.read(SECRET_KEYS.PERPLEXITY);
    const headers = {};
    /** @type {any} */
    const bodyParams = { reasoning_effort: body.reasoning_effort };
    body.messages = postProcessPrompt(body.messages, PROMPT_PROCESSING_TYPE.STRICT, getPromptNames(shim(ctx)));
    if (body.json_schema) {
        bodyParams['response_format'] = {
            type: 'json_schema',
            json_schema: { schema: body.json_schema.value },
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** GROQ — chat-completions.js:3100-3115 */
async function resolveGroq(ctx) {
    const body = ctx.body;
    const apiUrl = API_GROQ;
    const apiKey = ctx.secrets.read(SECRET_KEYS.GROQ);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    if (body.json_schema) {
        bodyParams['response_format'] = {
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

/** FIREWORKS — chat-completions.js:3116-3131 (structurally identical to GROQ) */
async function resolveFireworks(ctx) {
    const body = ctx.body;
    const apiUrl = API_FIREWORKS;
    const apiKey = ctx.secrets.read(SECRET_KEYS.FIREWORKS);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    if (body.json_schema) {
        bodyParams['response_format'] = {
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

/** NANOGPT — chat-completions.js:3132-3168 */
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
        bodyParams['billing_mode'] = 'paygo';
    }
    if (body.enable_web_search && !/:online$/.test(body.model)) {
        body.model = `${body.model}:online`;
    }
    if (body.min_p !== undefined) bodyParams['min_p'] = body.min_p;
    if (body.top_a !== undefined) bodyParams['top_a'] = body.top_a;
    if (body.repetition_penalty !== undefined) bodyParams['repetition_penalty'] = body.repetition_penalty;
    if (body.reasoning_effort) {
        const effort = NANOGPT_REASONING_EFFORT_MAP[body.reasoning_effort] ?? body.reasoning_effort;
        bodyParams['reasoning'] = { effort: effort };
    }
    const isClaude = /(?:^|\/)claude[-_]/.test(body.model);
    if (enableSystemPromptCache && isClaude) {
        bodyParams['cache_control'] = { 'enabled': true, 'ttl': cacheTTL };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** POLLINATIONS — chat-completions.js:3169-3184 (uses readSecret with secret_id, not readProviderSecret) */
async function resolvePollinations(ctx) {
    const body = ctx.body;
    const apiUrl = API_POLLINATIONS;
    const secretId = typeof body.secret_id === 'string' ? body.secret_id : undefined;
    const apiKey = ctx.secrets.read(SECRET_KEYS.POLLINATIONS, { secretId });
    const headers = {};
    /** @type {any} */
    const bodyParams = {
        reasoning_effort: body.reasoning_effort,
        seed: body.seed ?? Math.floor(Math.random() * 99999999),
    };
    if (body.json_schema) {
        bodyParams['response_format'] = {
            type: 'json_schema',
            json_schema: { schema: body.json_schema.value },
        };
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** MOONSHOT — chat-completions.js:3185-3195 */
async function resolveMoonshot(ctx) {
    const body = ctx.body;
    const apiUrl = new URL(body.reverse_proxy || body.base_url || API_MOONSHOT).toString();
    const apiKey = body.proxy_password || ctx.secrets.read(SECRET_KEYS.MOONSHOT) || '';
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    if (body.reasoning_effort) bodyParams.thinking = { type: 'enabled' };
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    } else {
        addAssistantPrefix(body.messages, [], 'partial');
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** COMETAPI — chat-completions.js:3196-3203 (temporarily disabled upstream) */
async function resolveCometapi(ctx) {
    const body = ctx.body;
    // Mirror legacy behavior: read config then throw. The throw propagates to
    // dispatchOpenAICompatible's catch and becomes emit.error.
    const apiUrl = API_COMETAPI;
    const apiKey = ctx.secrets.read(SECRET_KEYS.COMETAPI);
    const headers = {};
    /** @type {any} */
    const bodyParams = { reasoning_effort: body.reasoning_effort };
    // Preserve unused reads to avoid dead-code warnings and match legacy sequencing.
    void apiUrl; void apiKey; void headers; void bodyParams;
    throw new Error('This provider is temporarily disabled.');
}

/** ZAI — chat-completions.js:3204-3217 */
async function resolveZai(ctx) {
    const body = ctx.body;
    const defaultApiUrl = body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON;
    const apiUrl = new URL(body.reverse_proxy || body.base_url || defaultApiUrl).toString();
    const apiKey = body.proxy_password || ctx.secrets.read(SECRET_KEYS.ZAI) || '';
    const headers = { 'Accept-Language': 'en-US,en' };
    /** @type {any} */
    const bodyParams = {};
    if (body.reasoning_effort) bodyParams.thinking = { type: 'enabled' };
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/** SILICONFLOW — chat-completions.js:3218-3227 */
async function resolveSiliconflow(ctx) {
    const body = ctx.body;
    const apiUrl = body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
        ? API_SILICONFLOW_CN : API_SILICONFLOW;
    const apiKey = ctx.secrets.read(SECRET_KEYS.SILICONFLOW);
    const headers = {};
    /** @type {any} */
    const bodyParams = {};
    if (body.json_schema) {
        setJsonObjectFormat(bodyParams, body.messages, body.json_schema);
    }
    return { apiUrl, apiKey, headers, bodyParams };
}

/**
 * WORKERS_AI — chat-completions.js:3228-3245.
 * Uses readSecret with secret_id (not readProviderSecret) and constructs a
 * per-account URL. Missing account_id short-circuits (throws → emit.error).
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
    if (body.json_schema) {
        bodyParams['response_format'] = {
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
 * Detect text-completion mode. Mirrors chat-completions.js:2945.
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
    const source = body.chat_completion_source;
    const resolver = RESOLVERS[source];
    if (!resolver) {
        ctx.emit.error(new Error(`OpenAI-compatible dispatch: unsupported source: ${source}`));
        return;
    }

    ctx.inspection.start();

    try {
        const isTextCompletion = detectTextCompletion(body);
        const { apiUrl, apiKey, headers, bodyParams } = await resolver(ctx);

        // Reasoning effort — OPENAI/CUSTOM only, gated by model list.
        if (body.reasoning_effort && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(source)) {
            if (OPENAI_REASONING_EFFORT_MODELS.includes(body.model)) {
                bodyParams['reasoning_effort'] = OPENAI_FIXED_REASONING_EFFORT[body.model]
                    ?? OPENAI_REASONING_EFFORT_MAP[body.reasoning_effort]
                    ?? body.reasoning_effort;
            }
            if (source === CHAT_COMPLETION_SOURCES.CUSTOM && /^koboldcpp\/(.+)$/.test(body.model)) {
                bodyParams['reasoning_effort'] = body.reasoning_effort;
            }
        }

        // Verbosity — OPENAI/CUSTOM only, gated by model regex.
        if (body.verbosity && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(source)) {
            if (OPENAI_VERBOSITY_MODELS.test(body.model)) {
                bodyParams['verbosity'] = body.verbosity;
            }
        }

        // Missing API key check (CUSTOM is exempt because it may be a local server).
        if (!apiKey && !body.base_url && !body.reverse_proxy && source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            const err = new Error('OpenAI API key is missing.');
            ctx.inspection.fail(err);
            ctx.emit.error(err);
            return;
        }

        // Custom stop sequences.
        if (Array.isArray(body.stop) && body.stop.length > 0) {
            bodyParams['stop'] = body.stop;
        }

        const textPrompt = isTextCompletion ? convertTextCompletionPrompt(body.messages) : '';
        const endpointUrl = isTextCompletion && source !== CHAT_COMPLETION_SOURCES.OPENROUTER
            ? `${apiUrl}/completions`
            : `${apiUrl}/chat/completions`;

        // Tools/tool_choice (chat-completion only).
        if (!isTextCompletion && Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams['tools'] = body.tools;
            bodyParams['tool_choice'] = body.tool_choice;
        }

        // Fallback json_schema translation when the resolver did not already
        // set response_format (e.g. GROQ/FIREWORKS/OPENROUTER/CUSTOM handle
        // this themselves; OPENAI does not).
        if (body.json_schema && !bodyParams['response_format']) {
            bodyParams['response_format'] = {
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
            'messages': isTextCompletion === false ? body.messages : undefined,
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

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            excludeKeysByYaml(requestBody, body.custom_exclude_body);
        }

        ctx.inspection.attach(endpointUrl);
        const resp = await ctx.fetch(endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `OpenAI-compatible upstream ${resp.status}: ${errText.slice(0, 500)}`;
            const err = new Error(msg);
            ctx.inspection.fail(err);
            ctx.emit.error(err);
            return;
        }

        if (body.stream) {
            await pipeResponseBodyToEmit(resp, ctx);
        } else {
            const buf = await resp.arrayBuffer();
            ctx.emit.chunk(new Uint8Array(buf));
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
