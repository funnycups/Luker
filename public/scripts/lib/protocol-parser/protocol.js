// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError } from './errors.js';

export const WIRE_PROTOCOLS = Object.freeze({
    OPENAI_CHAT: 'openai-chat',
    OPENAI_RESPONSES: 'openai-responses',
    CLAUDE: 'claude',
    GEMINI: 'gemini',
    COHERE: 'cohere',
});

const OPENAI_CHAT_SOURCES = new Set([
    'openai',
    'openrouter',
    'ai21',
    'mistralai',
    'custom',
    'perplexity',
    'groq',
    'chutes',
    'electronhub',
    'nanogpt',
    'deepseek',
    'aimlapi',
    'xai',
    'pollinations',
    'moonshot',
    'fireworks',
    'cometapi',
    'azure_openai',
    'zai',
    'siliconflow',
    'minimax',
    'workers_ai',
    'openai-chat',
]);

const GEMINI_SOURCES = new Set([
    'makersuite',
    'google_ai_studio',
    'vertexai',
    'gemini',
]);

const CLAUDE_SOURCES = new Set([
    'claude',
]);

const RESPONSES_SOURCES = new Set([
    'openai_responses',
    'openai-responses',
]);

const COHERE_SOURCES = new Set([
    'cohere',
]);

/**
 * Resolve a declared chat completion source (or protocol identifier) into its
 * canonical wire protocol. Returns `null` for non-chat backends (kobold,
 * novelai, textgenerationwebui, image backends, unknown) so callers never
 * misclassify them as OpenAI Chat.
 *
 * @param {unknown} source
 * @returns {'openai-chat'|'openai-responses'|'claude'|'gemini'|'cohere'|null}
 */
export function resolveWireProtocol(source) {
    const normalized = String(source || '').trim().toLowerCase();
    if (!normalized) return null;
    if (CLAUDE_SOURCES.has(normalized)) return WIRE_PROTOCOLS.CLAUDE;
    if (GEMINI_SOURCES.has(normalized)) return WIRE_PROTOCOLS.GEMINI;
    if (RESPONSES_SOURCES.has(normalized)) return WIRE_PROTOCOLS.OPENAI_RESPONSES;
    if (COHERE_SOURCES.has(normalized)) return WIRE_PROTOCOLS.COHERE;
    if (OPENAI_CHAT_SOURCES.has(normalized)) return WIRE_PROTOCOLS.OPENAI_CHAT;
    return null;
}

/**
 * Resolve a declared source to a canonical wire protocol or throw a strict
 * ProtocolParseError when the source is missing or unsupported.
 *
 * @param {unknown} source
 * @returns {'openai-chat'|'openai-responses'|'claude'|'gemini'|'cohere'}
 */
export function requireWireProtocol(source) {
    const protocol = resolveWireProtocol(source);
    if (!protocol) {
        throw new ProtocolParseError({
            protocol: String(source || 'unknown'),
            stage: 'protocol_mismatch',
            location: 'source',
            message: `Unsupported or undeclared chat wire protocol source: "${String(source || '')}"`,
        });
    }
    return protocol;
}

export const CLAUDE_STOP_REASON_TO_OAI = Object.freeze({
    end_turn: 'stop',
    max_tokens: 'length',
    model_context_window_exceeded: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    pause_turn: 'pause_turn',
    refusal: 'content_filter',
});

export const GEMINI_FINISH_REASON_TO_OAI = Object.freeze({
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    BLOCKLIST: 'content_filter',
    SPII: 'content_filter',
    LANGUAGE: 'content_filter',
    IMAGE_SAFETY: 'content_filter',
    IMAGE_PROHIBITED_CONTENT: 'content_filter',
    IMAGE_RECITATION: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'error',
    MISSING_THOUGHT_SIGNATURE: 'error',
    UNEXPECTED_TOOL_CALL: 'error',
    MALFORMED_RESPONSE: 'error',
    CONTINUATION: 'incomplete',
    OTHER: 'stop',
});

// Deterministic content-policy blocks only: hard keyword blocklist (BLOCKLIST)
// and PII detector (SPII). Probabilistic filters (SAFETY, RECITATION,
// PROHIBITED_CONTENT) can flip on retry, so empty candidates with those reasons
// remain legal empty turns rather than terminal provider errors.
export const GEMINI_BLOCKED_FINISH_REASONS = new Set([
    'BLOCKLIST',
    'SPII',
]);

export const COHERE_FINISH_REASON_TO_OAI = Object.freeze({
    complete: 'stop',
    max_tokens: 'length',
    tool_call: 'tool_calls',
    stop_sequence: 'stop',
    error: 'error',
});

/**
 * Normalize a provider-native finish/stop reason to the canonical OAI-style
 * finish_reason vocabulary. Unknown non-empty reasons pass through verbatim so
 * forward-compatible upstream reasons are never silently collapsed.
 *
 * @param {string} protocolOrSource
 * @param {unknown} rawReason
 * @returns {string|null}
 */
export function normalizeFinishReason(protocolOrSource, rawReason) {
    if (rawReason === null || rawReason === undefined || rawReason === '') return null;
    const value = String(rawReason);
    const protocol = resolveWireProtocol(protocolOrSource) ?? String(protocolOrSource || '').toLowerCase();
    if (protocol === WIRE_PROTOCOLS.CLAUDE) {
        return CLAUDE_STOP_REASON_TO_OAI[value] ?? value;
    }
    if (protocol === WIRE_PROTOCOLS.GEMINI) {
        return GEMINI_FINISH_REASON_TO_OAI[value] ?? value;
    }
    if (protocol === WIRE_PROTOCOLS.COHERE) {
        return COHERE_FINISH_REASON_TO_OAI[value.toLowerCase()] ?? value;
    }
    return value;
}

function finiteOrZero(n) {
    return Number.isFinite(n) ? n : 0;
}

function pickFiniteNumber(...values) {
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Normalize an OpenAI Chat / OpenAI-compatible usage object into canonical
 * OpenAI snake_case shape.
 * @param {*} rawUsage
 * @returns {object|null}
 */
export function normalizeOpenAIChatUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const prompt = pickFiniteNumber(rawUsage.prompt_tokens, rawUsage.input_tokens);
    const completion = pickFiniteNumber(rawUsage.completion_tokens, rawUsage.output_tokens);
    const total = pickFiniteNumber(rawUsage.total_tokens);
    if (prompt === null && completion === null && total === null) return null;

    const p = prompt ?? 0;
    const c = completion ?? 0;
    const out = {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: total !== null ? total : p + c,
    };

    const inputDetails = rawUsage.prompt_tokens_details
        ?? rawUsage.prompt_token_details
        ?? rawUsage.input_tokens_details
        ?? rawUsage.input_token_details;
    const normalizedInputDetails = inputDetails && typeof inputDetails === 'object' ? { ...inputDetails } : {};
    const cached = pickFiniteNumber(
        normalizedInputDetails.cached_tokens,
        normalizedInputDetails.cache_read_input_tokens,
        normalizedInputDetails.cache_read_tokens,
        rawUsage.cache_read_input_tokens,
        rawUsage.cache_read_tokens,
        rawUsage.prompt_cache_hit_tokens,
        rawUsage.cached_tokens,
    );
    if (cached !== null) {
        normalizedInputDetails.cached_tokens = cached;
    }
    const cacheWrite = pickFiniteNumber(
        normalizedInputDetails.cache_creation_tokens,
        normalizedInputDetails.cache_creation_input_tokens,
        normalizedInputDetails.cache_write_tokens,
        rawUsage.cache_creation_input_tokens,
        rawUsage.cache_creation_tokens,
        rawUsage.cache_write_input_tokens,
        rawUsage.cache_write_tokens,
        rawUsage.cache_write,
    );
    if (cacheWrite !== null) {
        normalizedInputDetails.cache_creation_tokens = cacheWrite;
    }
    if (Object.keys(normalizedInputDetails).length > 0) {
        out.prompt_tokens_details = normalizedInputDetails;
    }

    const outputDetails = rawUsage.completion_tokens_details
        ?? rawUsage.completion_token_details
        ?? rawUsage.output_tokens_details
        ?? rawUsage.output_token_details;
    if (outputDetails && typeof outputDetails === 'object' && Object.keys(outputDetails).length > 0) {
        out.completion_tokens_details = { ...outputDetails };
    }
    return out;
}

/**
 * Normalize an OpenAI Responses API usage object into canonical snake_case shape.
 * @param {*} rawUsage
 * @returns {object|null}
 */
export function normalizeOpenAIResponsesUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const prompt = pickFiniteNumber(rawUsage.input_tokens, rawUsage.prompt_tokens);
    const completion = pickFiniteNumber(rawUsage.output_tokens, rawUsage.completion_tokens);
    const total = pickFiniteNumber(rawUsage.total_tokens);
    if (prompt === null && completion === null && total === null) return null;

    const p = prompt ?? 0;
    const c = completion ?? 0;
    const out = {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: total !== null ? total : p + c,
    };

    const inputDetails = rawUsage.input_tokens_details
        ?? rawUsage.input_token_details
        ?? rawUsage.prompt_tokens_details
        ?? rawUsage.prompt_token_details;
    const promptDetails = inputDetails && typeof inputDetails === 'object' ? { ...inputDetails } : {};
    const cached = pickFiniteNumber(
        promptDetails.cached_tokens,
        promptDetails.cache_read_input_tokens,
        promptDetails.cache_read_tokens,
        rawUsage.cache_read_input_tokens,
        rawUsage.cache_read_tokens,
        rawUsage.cached_tokens,
    );
    if (cached !== null) promptDetails.cached_tokens = cached;
    const cacheWrite = pickFiniteNumber(
        promptDetails.cache_creation_tokens,
        promptDetails.cache_creation_input_tokens,
        promptDetails.cache_write_tokens,
        rawUsage.cache_creation_input_tokens,
        rawUsage.cache_creation_tokens,
        rawUsage.cache_write_input_tokens,
        rawUsage.cache_write_tokens,
        rawUsage.cache_write,
    );
    if (cacheWrite !== null) promptDetails.cache_creation_tokens = cacheWrite;
    if (Object.keys(promptDetails).length > 0) {
        out.prompt_tokens_details = promptDetails;
    }

    const outputDetails = rawUsage.output_tokens_details
        ?? rawUsage.output_token_details
        ?? rawUsage.completion_tokens_details
        ?? rawUsage.completion_token_details;
    if (outputDetails && typeof outputDetails === 'object' && Object.keys(outputDetails).length > 0) {
        out.completion_tokens_details = { ...outputDetails };
    }
    return out;
}

/**
 * Normalize an Anthropic Messages API usage object.
 * Anthropic reports `input_tokens`, `cache_read_input_tokens`, and
 * `cache_creation_input_tokens` as disjoint counters; total prompt tokens is
 * the sum of all three.
 * @param {*} rawUsage
 * @returns {object|null}
 */
export function normalizeClaudeUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const uncachedInput = pickFiniteNumber(rawUsage.input_tokens);
    const cacheRead = pickFiniteNumber(rawUsage.cache_read_input_tokens);
    const cacheCreate = pickFiniteNumber(rawUsage.cache_creation_input_tokens);
    const completionTokens = pickFiniteNumber(rawUsage.output_tokens);
    if (uncachedInput === null && cacheRead === null && cacheCreate === null && completionTokens === null) {
        return null;
    }
    const prompt = (uncachedInput ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
    const completion = completionTokens ?? 0;
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
    };
    const promptDetails = {};
    if (cacheRead !== null) promptDetails.cached_tokens = cacheRead;
    if (cacheCreate !== null) promptDetails.cache_creation_tokens = cacheCreate;
    if (rawUsage.cache_creation && typeof rawUsage.cache_creation === 'object') {
        promptDetails.cache_creation = { ...rawUsage.cache_creation };
    }
    if (Object.keys(promptDetails).length > 0) {
        out.prompt_tokens_details = promptDetails;
    }
    const thinkingTokens = pickFiniteNumber(rawUsage.output_tokens_details?.thinking_tokens);
    if (thinkingTokens !== null) {
        out.completion_tokens_details = { reasoning_tokens: thinkingTokens };
    }
    if (rawUsage.server_tool_use && typeof rawUsage.server_tool_use === 'object') {
        out.server_tool_use = { ...rawUsage.server_tool_use };
    }
    return out;
}

/**
 * Normalize a Gemini `usageMetadata` object.
 * Folds `thoughtsTokenCount` into `completion_tokens` and surfaces it under
 * `completion_tokens_details.reasoning_tokens`, preserves `cachedContentTokenCount`
 * and `toolUsePromptTokenCount` under `prompt_tokens_details`.
 * @param {*} meta
 * @returns {object|null}
 */
export function normalizeGeminiUsage(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const promptTokens = pickFiniteNumber(meta.promptTokenCount);
    const candidatesTokens = pickFiniteNumber(meta.candidatesTokenCount);
    const thoughtsTokens = pickFiniteNumber(meta.thoughtsTokenCount);
    const toolUsePromptTokens = pickFiniteNumber(meta.toolUsePromptTokenCount);
    const totalTokens = pickFiniteNumber(meta.totalTokenCount);
    if (promptTokens === null && candidatesTokens === null && thoughtsTokens === null && totalTokens === null) {
        return null;
    }
    const prompt = promptTokens ?? 0;
    const candidates = candidatesTokens ?? 0;
    const thoughts = thoughtsTokens ?? 0;
    const toolUsePrompt = toolUsePromptTokens ?? 0;
    const completion = candidates + thoughts;
    const total = totalTokens !== null ? totalTokens : prompt + completion + toolUsePrompt;
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    };
    const cached = pickFiniteNumber(meta.cachedContentTokenCount);
    const promptDetails = {};
    if (cached !== null) promptDetails.cached_tokens = cached;
    if (toolUsePromptTokens !== null) promptDetails.tool_use_prompt_tokens = toolUsePromptTokens;
    if (Object.keys(promptDetails).length > 0) {
        out.prompt_tokens_details = promptDetails;
    }
    if (thoughtsTokens !== null) {
        out.completion_tokens_details = { reasoning_tokens: thoughts };
    }
    return out;
}

/**
 * Normalize a Cohere v2 usage object (preferring `billed_units` over `tokens`).
 * @param {*} rawUsage
 * @returns {object|null}
 */
export function normalizeCohereUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const candidate = (rawUsage.billed_units && typeof rawUsage.billed_units === 'object')
        ? rawUsage.billed_units
        : ((rawUsage.tokens && typeof rawUsage.tokens === 'object') ? rawUsage.tokens : rawUsage);
    const prompt = pickFiniteNumber(candidate.input_tokens, candidate.prompt_tokens);
    const completion = pickFiniteNumber(candidate.output_tokens, candidate.completion_tokens);
    if (prompt === null && completion === null) return null;
    const p = prompt ?? 0;
    const c = completion ?? 0;
    return {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: p + c,
    };
}

function mergeDetails(a, b) {
    if (!a && !b) return null;
    if (!a) return { ...b };
    if (!b) return { ...a };
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
            out[k] = Math.max(finiteOrZero(out[k]), v);
        } else if (out[k] === undefined) {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Merge two streaming usage snapshots across multiple SSE frames.
 * @param {object|null} prev
 * @param {object|null} next
 * @returns {object|null}
 */
export function mergeNormalizedUsage(prev, next) {
    if (!prev) return next ? { ...next } : null;
    if (!next) return { ...prev };
    const prompt = Math.max(finiteOrZero(prev.prompt_tokens), finiteOrZero(next.prompt_tokens));
    const completion = Math.max(finiteOrZero(prev.completion_tokens), finiteOrZero(next.completion_tokens));
    const reportedTotal = Math.max(finiteOrZero(prev.total_tokens), finiteOrZero(next.total_tokens));
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: Math.max(reportedTotal, prompt + completion),
    };
    const promptDetails = mergeDetails(prev.prompt_tokens_details, next.prompt_tokens_details);
    if (promptDetails) out.prompt_tokens_details = promptDetails;
    const completionDetails = mergeDetails(prev.completion_tokens_details, next.completion_tokens_details);
    if (completionDetails) out.completion_tokens_details = completionDetails;
    const serverToolUse = mergeDetails(prev.server_tool_use, next.server_tool_use);
    if (serverToolUse) out.server_tool_use = serverToolUse;
    return out;
}

/**
 * Project canonical normalized usage onto the Request Inspector usage view.
 * Preserves numeric 0 values faithfully (never collapsing 0 to null).
 * @param {object|null|undefined} usage
 * @returns {{prompt_tokens: number|null, completion_tokens: number|null, total_tokens: number|null, cache_read: number|null, cache_write: number|null}}
 */
export function toInspectorUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return {
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            cache_read: null,
            cache_write: null,
        };
    }
    const promptDetails = usage.prompt_tokens_details || {};
    return {
        prompt_tokens: pickFiniteNumber(usage.prompt_tokens),
        completion_tokens: pickFiniteNumber(usage.completion_tokens),
        total_tokens: pickFiniteNumber(usage.total_tokens),
        cache_read: pickFiniteNumber(promptDetails.cached_tokens),
        cache_write: pickFiniteNumber(promptDetails.cache_creation_tokens),
    };
}
