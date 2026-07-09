// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Shared "text-completions" dispatch. Covers the 15 provider variants that
// share the `/api/backends/text-completions/generate` endpoint. Extracted
// from the legacy switch-in-handler at
// src/endpoints/backends/text-completions.js:357-545.
//
// Providers routed here (dispatch key = ctx.body.api_type — see
// TEXTGEN_TYPES in src/constants.js):
//   GENERIC, VLLM, FEATHERLESS, APHRODITE, OOBA, TABBY, KOBOLDCPP,
//   TOGETHERAI, INFERMATICAI, HUGGINGFACE, DREAMGEN, MANCER, LLAMACPP,
//   OLLAMA, OPENROUTER
//
// Unlike chat-completions, all 15 upstreams speak nearly the same request
// shape and share a single fetch/stream/error tail. Per-provider quirks
// (URL suffix, body pickBy filter, OpenRouter/Ollama body rewriting)
// live in the resolver table + a couple of narrow branches. Everything
// else is unified.
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Special behaviors preserved from the legacy handler:
//   • localhost → 127.0.0.1 rewrite for api_server (mirrors legacy line 367)
//   • KOBOLDCPP abort side-channel: on ctx.signal abort we POST
//     `{baseUrl}/api/extra/abort` (legacy abortKoboldCppRequest)
//   • Ollama NDJSON → SSE frames (legacy parseOllamaStream) with dispatch
//     emitting the SSE-formatted bytes as `chunk` events + a trailing
//     `data: [DONE]\n\n`.
//   • INFERMATICAI non-streaming response reshape (message.content → text)
//   • timeout: 0 on fetch (never add timeouts to LLM requests — see AGENTS.md)

import _ from 'lodash';
import {
    TEXTGEN_TYPES,
    TOGETHERAI_KEYS,
    OLLAMA_KEYS,
    INFERMATICAI_KEYS,
    OPENROUTER_KEYS,
    VLLM_KEYS,
    FEATHERLESS_KEYS,
    OPENAI_KEYS,
    OPENROUTER_HEADERS,
    FEATHERLESS_HEADERS,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { getOverrideHeaders } from '../../../additional-headers.js';
import { trimV1, getConfigValue } from '../../../util.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

/**
 * Per-api_type URL suffix. Mirrors legacy switch at
 * src/endpoints/backends/text-completions.js:386-414.
 * @type {Record<string, string>}
 */
const URL_SUFFIX = {
    [TEXTGEN_TYPES.GENERIC]: '/v1/completions',
    [TEXTGEN_TYPES.VLLM]: '/v1/completions',
    [TEXTGEN_TYPES.FEATHERLESS]: '/v1/completions',
    [TEXTGEN_TYPES.APHRODITE]: '/v1/completions',
    [TEXTGEN_TYPES.OOBA]: '/v1/completions',
    [TEXTGEN_TYPES.TABBY]: '/v1/completions',
    [TEXTGEN_TYPES.KOBOLDCPP]: '/v1/completions',
    [TEXTGEN_TYPES.TOGETHERAI]: '/v1/completions',
    [TEXTGEN_TYPES.INFERMATICAI]: '/v1/completions',
    [TEXTGEN_TYPES.HUGGINGFACE]: '/v1/completions',
    [TEXTGEN_TYPES.DREAMGEN]: '/api/openai/v1/completions',
    [TEXTGEN_TYPES.MANCER]: '/oai/v1/completions',
    [TEXTGEN_TYPES.LLAMACPP]: '/completion',
    [TEXTGEN_TYPES.OLLAMA]: '/api/generate',
    [TEXTGEN_TYPES.OPENROUTER]: '/v1/chat/completions',
};

/**
 * Per-api_type auth header shape. Mirrors the getXxxHeaders helpers in
 * src/additional-headers.js. Returns { authHeaders, baseHeaders }:
 *   • authHeaders — apiKey-derived auth headers (empty if no key)
 *   • baseHeaders — provider-static headers (e.g. OpenRouter attribution)
 *     applied regardless of whether a key was resolved.
 *
 * @param {string} apiType TEXTGEN_TYPES value
 * @param {string} apiKey resolved via ctx.secrets.read
 * @returns {{ authHeaders: object, baseHeaders: object }}
 */
function providerHeaderShape(apiType, apiKey) {
    switch (apiType) {
        case TEXTGEN_TYPES.MANCER:
            return {
                authHeaders: apiKey ? { 'X-API-KEY': apiKey, 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: {},
            };
        case TEXTGEN_TYPES.APHRODITE:
            return {
                authHeaders: apiKey ? { 'X-API-KEY': apiKey, 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: {},
            };
        case TEXTGEN_TYPES.TABBY:
            return {
                authHeaders: apiKey ? { 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: {},
            };
        case TEXTGEN_TYPES.OPENROUTER:
            return {
                authHeaders: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: { ...OPENROUTER_HEADERS },
            };
        case TEXTGEN_TYPES.FEATHERLESS:
            return {
                authHeaders: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: { ...FEATHERLESS_HEADERS },
            };
        // All other TEXTGEN_TYPES (VLLM/TOGETHERAI/OOBA/INFERMATICAI/
        // DREAMGEN/KOBOLDCPP/LLAMACPP/HUGGINGFACE/GENERIC) use a simple
        // Bearer-when-present shape and no static base headers.
        default:
            return {
                authHeaders: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                baseHeaders: {},
            };
    }
}

/**
 * Maps api_type → SECRET_KEYS entry. Mirrors the readSecret keys used by
 * the getXxxHeaders helpers in additional-headers.js. `null` means no
 * secret is read for this provider (currently no such case, but kept
 * defensive).
 * @type {Record<string, string>}
 */
const SECRET_KEY_BY_API_TYPE = {
    [TEXTGEN_TYPES.MANCER]: SECRET_KEYS.MANCER,
    [TEXTGEN_TYPES.VLLM]: SECRET_KEYS.VLLM,
    [TEXTGEN_TYPES.APHRODITE]: SECRET_KEYS.APHRODITE,
    [TEXTGEN_TYPES.TABBY]: SECRET_KEYS.TABBY,
    [TEXTGEN_TYPES.TOGETHERAI]: SECRET_KEYS.TOGETHERAI,
    [TEXTGEN_TYPES.OOBA]: SECRET_KEYS.OOBA,
    [TEXTGEN_TYPES.INFERMATICAI]: SECRET_KEYS.INFERMATICAI,
    [TEXTGEN_TYPES.DREAMGEN]: SECRET_KEYS.DREAMGEN,
    [TEXTGEN_TYPES.OPENROUTER]: SECRET_KEYS.OPENROUTER,
    [TEXTGEN_TYPES.KOBOLDCPP]: SECRET_KEYS.KOBOLDCPP,
    [TEXTGEN_TYPES.LLAMACPP]: SECRET_KEYS.LLAMACPP,
    [TEXTGEN_TYPES.FEATHERLESS]: SECRET_KEYS.FEATHERLESS,
    [TEXTGEN_TYPES.HUGGINGFACE]: SECRET_KEYS.HUGGINGFACE,
    [TEXTGEN_TYPES.GENERIC]: SECRET_KEYS.GENERIC,
    // OLLAMA has no api_key in the getXxxHeaders table; leave undefined.
};

/**
 * Assemble upstream headers for a text-completions request. Composes:
 *   Content-Type + baseHeaders (static per-provider) + authHeaders
 *   (Bearer/X-API-KEY from ctx.secrets.read) + host-based override headers
 *   from config.yaml's requestOverrides.
 *
 * Mirrors legacy setAdditionalHeaders(request, args, baseUrl) in
 * src/additional-headers.js:218-264. Kept dispatch-native so tests can
 * stub ctx.secrets.read without touching disk.
 *
 * @param {object} ctx DispatchContext
 * @param {string} apiType TEXTGEN_TYPES value
 * @param {string} apiServer raw api_server (used for host-based overrides)
 * @param {string|null} secretId optional secret_id (currently unused —
 *     legacy setAdditionalHeaders forwards it but no api_type actually
 *     branches on it; forwarded here for parity).
 * @returns {object} headers dict
 */
function buildHeaders(ctx, apiType, apiServer, secretId) {
    /** @type {any} */
    const headers = { 'Content-Type': 'application/json' };
    const secretKey = SECRET_KEY_BY_API_TYPE[apiType];
    const apiKey = secretKey
        ? (ctx.secrets.read(secretKey, { secretId }) || '')
        : '';
    const { authHeaders, baseHeaders } = providerHeaderShape(apiType, apiKey);
    Object.assign(headers, baseHeaders, authHeaders);

    // Config.yaml requestOverrides keyed by URL host. Mirrors the tail of
    // setAdditionalHeadersByType (additional-headers.js:251-262).
    if (typeof apiServer === 'string' && apiServer.length > 0) {
        try {
            const url = new URL(apiServer);
            const overrides = getOverrideHeaders(url.host);
            if (overrides && Object.keys(overrides).length > 0) {
                Object.assign(headers, overrides);
            }
        } catch { /* invalid URL — skip overrides */ }
    }

    return headers;
}

/**
 * Build the outgoing request body for a given api_type. Mirrors the six
 * body-transform branches at src/endpoints/backends/text-completions.js:428-491.
 *
 * Returns the JSON string to send. Never mutates ctx.body — creates a
 * shallow clone with `luker_generation` stripped, then applies the
 * per-provider pickBy / OpenRouter provider-flattening / Ollama re-shape.
 *
 * @param {string} apiType TEXTGEN_TYPES value
 * @param {object} body ctx.body (not mutated)
 * @returns {string} JSON-serialized upstream body
 */
function buildUpstreamBody(apiType, body) {
    const { luker_generation: _lg, ...rest } = body || {};
    /** @type {any} */
    let payload = rest;

    switch (apiType) {
        case TEXTGEN_TYPES.TOGETHERAI:
            payload = _.pickBy(payload, (_v, k) => TOGETHERAI_KEYS.includes(k));
            break;
        case TEXTGEN_TYPES.INFERMATICAI:
            payload = _.pickBy(payload, (_v, k) => INFERMATICAI_KEYS.includes(k));
            break;
        case TEXTGEN_TYPES.FEATHERLESS:
            payload = _.pickBy(payload, (_v, k) => FEATHERLESS_KEYS.includes(k));
            break;
        case TEXTGEN_TYPES.DREAMGEN:
            // Legacy: no pickBy (there is no DREAMGEN_KEYS in constants.js);
            // the body is re-serialized as-is. Preserve that behavior.
            break;
        case TEXTGEN_TYPES.GENERIC: {
            payload = _.pickBy(payload, (_v, k) => OPENAI_KEYS.includes(k));
            if (Array.isArray(payload.stop)) {
                payload.stop = payload.stop.slice(0, 4);
            }
            break;
        }
        case TEXTGEN_TYPES.OPENROUTER: {
            // Provider array → { allow_fallbacks, order } object.
            if (Array.isArray(payload.provider) && payload.provider.length > 0) {
                payload.provider = {
                    allow_fallbacks: payload.allow_fallbacks ?? true,
                    order: payload.provider,
                };
            } else {
                delete payload.provider;
            }
            if (Array.isArray(payload.quantizations) && payload.quantizations.length > 0) {
                payload.provider ??= {};
                payload.provider.quantizations = payload.quantizations;
            }
            payload = _.pickBy(payload, (_v, k) => OPENROUTER_KEYS.includes(k));
            break;
        }
        case TEXTGEN_TYPES.VLLM:
            payload = _.pickBy(payload, (_v, k) => VLLM_KEYS.includes(k));
            break;
        case TEXTGEN_TYPES.OLLAMA: {
            const keepAlive = Number(getConfigValue('ollama.keepAlive', -1, 'number'));
            const numBatch = Number(getConfigValue('ollama.batchSize', -1, 'number'));
            if (numBatch > 0) {
                payload.num_batch = numBatch;
            }
            payload = {
                model: payload.model,
                prompt: payload.prompt,
                stream: payload.stream ?? false,
                keep_alive: keepAlive,
                raw: true,
                options: _.pickBy(payload, (_v, k) => OLLAMA_KEYS.includes(k)),
            };
            break;
        }
        default:
            // GENERIC-shaped providers pass the body through untouched
            // (matches the legacy handler's fall-through behavior).
            break;
    }
    return JSON.stringify(payload);
}

/**
 * KOBOLDCPP abort side channel. Mirrors legacy abortKoboldCppRequest()
 * (text-completions.js:165-182). Invoked from the ctx.signal 'abort'
 * listener registered inside dispatchTextCompletions.
 *
 * @param {object} ctx DispatchContext
 * @param {string} baseUrl already trimV1'd base URL
 * @param {string|null} secretId
 * @returns {Promise<void>}
 */
async function fireKoboldCppAbort(ctx, baseUrl, secretId) {
    try {
        console.info('Aborting Kobold generation...');
        const headers = buildHeaders(ctx, TEXTGEN_TYPES.KOBOLDCPP, baseUrl, secretId);
        const abortResponse = await ctx.fetch(`${baseUrl}/api/extra/abort`, {
            method: 'POST',
            headers,
        });
        if (!abortResponse.ok) {
            console.error('Error sending abort request to Kobold:', abortResponse.status, abortResponse.statusText);
        }
    } catch (error) {
        console.error(error);
    }
}

/**
 * Parse an Ollama NDJSON stream and emit SSE-formatted chunks via
 * ctx.emit.chunk. Mirrors legacy parseOllamaStream (text-completions.js:38-157)
 * with response/write plumbing swapped for ctx.emit.
 *
 * The runner layer handles job-completion bookkeeping via appendGenerationEvent
 * hooks on ctx.emit, so this function is dispatch-pure: it only emits chunks
 * and returns.
 *
 * @param {any} upstream node-fetch Response
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
async function parseOllamaStream(upstream, ctx) {
    if (!upstream.body) {
        throw new Error('Ollama upstream: no body');
    }

    let partialData = '';
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    function emitFrame(text, thinking) {
        const frameData = JSON.stringify({ choices: [{ text, thinking }] });
        ctx.emit.chunk(encoder.encode(`data: ${frameData}\n\n`));
    }

    for await (const data of upstream.body) {
        const chunk = decoder.decode(data, { stream: true });
        partialData += chunk;
        const lines = partialData.split('\n');
        partialData = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let json;
            try { json = JSON.parse(trimmed); } catch { continue; }
            emitFrame(json.response || '', json.thinking || '');
        }
    }

    partialData += decoder.decode();
    if (partialData.trim()) {
        try {
            const json = JSON.parse(partialData.trim());
            emitFrame(json.response || '', json.thinking || '');
        } catch { /* ignore trailing incomplete chunk */ }
    }

    // Emit the terminal SSE sentinel; matches legacy parseOllamaStream
    // which wrote `data: [DONE]\n\n` before response.end().
    ctx.emit.chunk(encoder.encode('data: [DONE]\n\n'));
}

/**
 * Dispatch a text-completion request to one of 15 provider upstreams.
 * Results flow via ctx.emit.{chunk,end,error}. Never touches Express.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchTextCompletions(ctx) {
    const body = ctx.body || {};
    const apiType = body.api_type;
    const suffix = URL_SUFFIX[apiType];
    if (!suffix) {
        ctx.emit.error(new Error(`text-completions dispatch: unsupported api_type: ${apiType}`));
        return;
    }
    if (!body.api_server) {
        ctx.emit.error(new Error('text-completions dispatch: api_server missing'));
        return;
    }

    ctx.inspection.start();

    try {
        // localhost → 127.0.0.1 rewrite. Node fetch does not resolve
        // "localhost" to IPv4 on IPv6-preferred stacks, so upstreams
        // listening on 127.0.0.1 only would silently fail. Legacy line 367.
        let apiServer = body.api_server;
        if (apiServer.indexOf('localhost') !== -1) {
            apiServer = apiServer.replace('localhost', '127.0.0.1');
        }
        const baseUrl = trimV1(apiServer);
        const url = baseUrl + suffix;

        const secretId = body.secret_id ?? null;
        const headers = buildHeaders(ctx, apiType, apiServer, secretId);
        const upstreamBody = buildUpstreamBody(apiType, body);

        // KOBOLDCPP abort side channel — fire a POST to /api/extra/abort
        // when the dispatch signal aborts.
        if (apiType === TEXTGEN_TYPES.KOBOLDCPP) {
            const onAbort = () => {
                // Fire-and-forget; we don't want abort side-effects to
                // block the dispatch error path.
                void fireKoboldCppAbort(ctx, baseUrl, secretId);
            };
            if (ctx.signal.aborted) {
                onAbort();
            } else {
                ctx.signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        ctx.inspection.attach(url);
        const resp = await ctx.fetch(url, {
            method: 'POST',
            body: upstreamBody,
            headers,
            signal: ctx.signal,
            timeout: 0,
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `text-completions upstream ${resp.status}: ${errText.slice(0, 500)}`;
            const err = new Error(msg);
            ctx.inspection.fail(err);
            ctx.emit.error(err);
            return;
        }

        const streamMode = body.stream;

        if (apiType === TEXTGEN_TYPES.OLLAMA && streamMode) {
            await parseOllamaStream(resp, ctx);
            ctx.emit.end();
            return;
        }

        if (streamMode) {
            await pipeResponseBodyToEmit(resp, ctx);
            return;
        }

        // Non-streaming: read full JSON body, apply INFERMATICAI reshape,
        // emit a single chunk of the (possibly-rewritten) JSON.
        /** @type {any} */
        const data = await resp.json();
        if (apiType === TEXTGEN_TYPES.INFERMATICAI) {
            data.choices = (data?.choices || []).map(choice => ({
                text: choice?.message?.content || choice.text,
                logprobs: choice?.logprobs,
                index: choice?.index,
            }));
        }
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(data)));
        ctx.emit.end();
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
