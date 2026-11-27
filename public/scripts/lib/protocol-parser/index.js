// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, extractProviderErrorMessage } from './errors.js';
import {
    CLAUDE_STOP_REASON_TO_OAI,
    COHERE_FINISH_REASON_TO_OAI,
    GEMINI_BLOCKED_FINISH_REASONS,
    GEMINI_FINISH_REASON_TO_OAI,
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeClaudeUsage,
    normalizeCohereUsage,
    normalizeFinishReason,
    normalizeGeminiUsage,
    normalizeOpenAIChatUsage,
    normalizeOpenAIResponsesUsage,
    requireWireProtocol,
    resolveWireProtocol,
    toInspectorUsage,
} from './protocol.js';
import { createSseFramer } from './sse-framer.js';
import { createClaudeStreamParser, parseClaudeResponse } from './parsers/claude.js';
import { createGeminiStreamParser, parseGeminiResponse } from './parsers/gemini.js';
import { createOpenAIResponsesStreamParser, parseOpenAIResponsesResponse } from './parsers/openai-responses.js';
import { createOpenAIChatStreamParser, parseOpenAIChatResponse } from './parsers/openai-chat.js';
import { createCohereStreamParser, parseCohereResponse } from './parsers/cohere.js';

export {
    CLAUDE_STOP_REASON_TO_OAI,
    COHERE_FINISH_REASON_TO_OAI,
    GEMINI_BLOCKED_FINISH_REASONS,
    GEMINI_FINISH_REASON_TO_OAI,
    ProtocolParseError,
    WIRE_PROTOCOLS,
    createSseFramer,
    extractProviderErrorMessage,
    mergeNormalizedUsage,
    normalizeClaudeUsage,
    normalizeCohereUsage,
    normalizeFinishReason,
    normalizeGeminiUsage,
    normalizeOpenAIChatUsage,
    normalizeOpenAIResponsesUsage,
    requireWireProtocol,
    resolveWireProtocol,
    toInspectorUsage,
};

/**
 * Parse a non-streaming upstream response strictly according to the declared
 * request protocol or chat_completion_source. Never sniffs or switches
 * protocols on mismatch.
 *
 * @param {string} protocolOrSource
 * @param {*} payload
 * @returns {object} Unified ParsedTurn
 */
export function parseProtocolResponse(protocolOrSource, payload) {
    const protocol = requireWireProtocol(protocolOrSource);
    switch (protocol) {
        case WIRE_PROTOCOLS.CLAUDE:
            return parseClaudeResponse(payload);
        case WIRE_PROTOCOLS.GEMINI:
            return parseGeminiResponse(payload);
        case WIRE_PROTOCOLS.OPENAI_RESPONSES:
            return parseOpenAIResponsesResponse(payload);
        case WIRE_PROTOCOLS.COHERE:
            return parseCohereResponse(payload);
        case WIRE_PROTOCOLS.OPENAI_CHAT:
            return parseOpenAIChatResponse(payload);
        default:
            throw new ProtocolParseError({
                protocol,
                stage: 'protocol_mismatch',
                location: 'protocol',
                message: `No parser registered for wire protocol "${protocol}".`,
            });
    }
}

/**
 * Create a strict incremental SSE stream parser for the declared request
 * protocol or chat_completion_source.
 *
 * @param {string} protocolOrSource
 */
export function createProtocolStreamParser(protocolOrSource) {
    const protocol = requireWireProtocol(protocolOrSource);
    let inner;
    switch (protocol) {
        case WIRE_PROTOCOLS.CLAUDE:
            inner = createClaudeStreamParser();
            break;
        case WIRE_PROTOCOLS.GEMINI:
            inner = createGeminiStreamParser();
            break;
        case WIRE_PROTOCOLS.OPENAI_RESPONSES:
            inner = createOpenAIResponsesStreamParser();
            break;
        case WIRE_PROTOCOLS.COHERE:
            inner = createCohereStreamParser();
            break;
        case WIRE_PROTOCOLS.OPENAI_CHAT:
            inner = createOpenAIChatStreamParser();
            break;
        default:
            throw new ProtocolParseError({
                protocol,
                stage: 'protocol_mismatch',
                location: 'protocol',
                message: `No stream parser registered for wire protocol "${protocol}".`,
            });
    }

    const framer = createSseFramer();
    let sawAnyFrame = false;

    function feedFrame(rawData, eventName = '') {
        sawAnyFrame = true;
        return inner.feedFrame(rawData, eventName);
    }

    function feedSseChunk(textChunk) {
        const frames = framer.push(textChunk);
        const deltas = [];
        for (const frame of frames) {
            sawAnyFrame = true;
            deltas.push(inner.feedFrame(frame.data, frame.event));
        }
        return deltas;
    }

    function finish() {
        const tailFrames = framer.flush();
        for (const frame of tailFrames) {
            sawAnyFrame = true;
            inner.feedFrame(frame.data, frame.event);
        }
        const invalidDiagnostic = framer.getInvalidDiagnostic();
        if (!sawAnyFrame && invalidDiagnostic) {
            throw new ProtocolParseError({
                protocol,
                stage: 'sse',
                location: 'stream',
                message: 'Expected text/event-stream SSE frames, received non-SSE response body.',
                rawDiagnostic: invalidDiagnostic,
            });
        }
        return inner.finish();
    }

    return {
        protocol,
        feedFrame,
        feedSseChunk,
        finish,
        getSnapshot: inner.getSnapshot,
        getToolCallPreview: inner.getToolCallPreview,
    };
}

/**
 * Convert a unified ParsedTurn into the internal OpenAI-shaped chat completion
 * object expected by client consumers (`script.js`, `generate-task.js`,
 * `tool-calling.js`, `reasoning.js`). This runs strictly in-process AFTER raw
 * HTTP response delivery so fetch interceptors observe the native upstream body.
 *
 * @param {object} turn
 * @param {*} [rawPayload]
 * @returns {object}
 */
export function parsedTurnToChatCompletion(turn, rawPayload = null) {
    const message = {
        role: 'assistant',
        content: turn.text ?? '',
    };
    if (turn.reasoning) message.reasoning_content = turn.reasoning;
    if (turn.signature) message.signature = turn.signature;
    if (Array.isArray(turn.reasoningBlocks) && turn.reasoningBlocks.length > 0) {
        message.reasoning_blocks = turn.reasoningBlocks;
    }
    if (Array.isArray(turn.reasoningDetails) && turn.reasoningDetails.length > 0) {
        message.reasoning_details = turn.reasoningDetails;
    }
    if (Array.isArray(turn.nativeParts) && turn.nativeParts.length > 0) {
        message.native_parts = turn.nativeParts;
    }
    if (Array.isArray(turn.nativeContentBlocks) && turn.nativeContentBlocks.length > 0) {
        message.native_content_blocks = turn.nativeContentBlocks;
    }
    if (Array.isArray(turn.responsesOutputItems) && turn.responsesOutputItems.length > 0) {
        message.responses_output_items = turn.responsesOutputItems;
    }
    if (Array.isArray(turn.citations) && turn.citations.length > 0) {
        message.citations = turn.citations;
    }
    if (turn.refusal) {
        message.refusal = turn.refusal;
    }
    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
        message.tool_calls = turn.toolCalls;
    }
    if (Array.isArray(turn.images) && turn.images.length > 0) {
        message.images = turn.images.map(url => ({ type: 'image_url', image_url: { url } }));
    }

    const choice = {
        index: 0,
        message,
        finish_reason: turn.finishReason ?? 'stop',
    };
    if (turn.nativeFinishReason) choice.native_finish_reason = turn.nativeFinishReason;
    if (turn.stopSequence) choice.stop_sequence = turn.stopSequence;
    if (turn.stopDetails) choice.stop_details = turn.stopDetails;
    if (rawPayload?.choices?.[0]?.logprobs !== undefined) {
        choice.logprobs = rawPayload.choices[0].logprobs;
    }

    const choices = [choice];
    if (Array.isArray(turn.swipes)) {
        for (let i = 0; i < turn.swipes.length; i++) {
            choices.push({
                index: i + 1,
                message: { role: 'assistant', content: turn.swipes[i] ?? '' },
                finish_reason: turn.finishReason ?? 'stop',
            });
        }
    }

    const reply = {
        object: 'chat.completion',
        choices,
    };
    if (rawPayload?.id !== undefined) {
        reply.id = rawPayload.id;
    }
    if (rawPayload?.model !== undefined) {
        reply.model = rawPayload.model;
    }
    if (turn.usage) {
        reply.usage = turn.usage;
    }
    if (Array.isArray(turn.citations) && turn.citations.length > 0) {
        reply.citations = turn.citations;
    }
    if (turn.protocol === WIRE_PROTOCOLS.CLAUDE && Array.isArray(turn.nativeContentBlocks)) {
        reply.content = turn.nativeContentBlocks;
    }
    if (turn.protocol === WIRE_PROTOCOLS.COHERE
        && typeof rawPayload?.message?.tool_plan === 'string'
        && rawPayload.message.tool_plan
        && !message.reasoning_content
        && message.content !== rawPayload.message.tool_plan) {
        message.reasoning_content = rawPayload.message.tool_plan;
    }
    if (turn.protocol === WIRE_PROTOCOLS.GEMINI && rawPayload?.candidates?.[0]?.content) {
        reply.responseContent = rawPayload.candidates[0].content;
    } else if (turn.protocol === WIRE_PROTOCOLS.GEMINI && Array.isArray(turn.nativeParts)) {
        reply.responseContent = { role: 'model', parts: turn.nativeParts };
    }
    return reply;
}

/**
 * Build a non-streaming compatibility superset payload that preserves all
 * native upstream fields (`content`, `candidates`, `message`, `output`,
 * `usageMetadata`, etc.) alongside the standard OpenAI `choices[0].message`
 * shape expected by SillyTavern-compatible clients and extensions.
 *
 * @param {object} turn
 * @param {*} rawPayload
 * @returns {object}
 */
export function buildCompatChatCompletionPayload(turn, rawPayload) {
    const oai = parsedTurnToChatCompletion(turn, rawPayload);
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        return oai;
    }
    const mergedUsage = (rawPayload.usage && typeof rawPayload.usage === 'object' && oai.usage)
        ? { ...rawPayload.usage, ...oai.usage }
        : (oai.usage ?? rawPayload.usage);
    return {
        ...rawPayload,
        ...oai,
        ...(mergedUsage ? { usage: mergedUsage } : {}),
    };
}

/**
 * Parse a non-streaming chat completion payload that may be either the raw
 * provider-native payload OR a compatibility superset / OpenAI-shaped object
 * (`choices[]`) returned by the backend compat layer or a client fetch hook.
 * Strict `parseProtocolResponse` remains unchanged for raw wire inspection.
 *
 * @param {string} protocolOrSource
 * @param {*} payload
 * @returns {object} Unified ParsedTurn
 */
export function parseCompatChatCompletionResponse(protocolOrSource, payload) {
    const protocol = requireWireProtocol(protocolOrSource);
    if (protocol !== WIRE_PROTOCOLS.OPENAI_CHAT
        && payload
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && Array.isArray(payload.choices)
        && payload.choices.length > 0) {
        const oaiView = {
            choices: payload.choices,
            ...(payload.id !== undefined ? { id: payload.id } : {}),
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
            ...(payload.citations !== undefined ? { citations: payload.citations } : {}),
            ...(payload.error !== undefined ? { error: payload.error } : {}),
            ...(payload.quota_error !== undefined ? { quota_error: payload.quota_error } : {}),
            ...(payload.moderation !== undefined ? { moderation: payload.moderation } : {}),
        };
        const turn = parseOpenAIChatResponse(oaiView);
        const choice0 = payload.choices[0];
        const msg0 = choice0?.message || {};
        turn.protocol = protocol;
        if (typeof msg0.signature === 'string' && msg0.signature && !turn.signature) {
            turn.signature = msg0.signature;
        }
        if (Array.isArray(msg0.native_parts) && msg0.native_parts.length > 0) {
            turn.nativeParts = msg0.native_parts;
        }
        if (Array.isArray(msg0.native_content_blocks) && msg0.native_content_blocks.length > 0) {
            turn.nativeContentBlocks = msg0.native_content_blocks;
        }
        if (Array.isArray(msg0.responses_output_items) && msg0.responses_output_items.length > 0) {
            turn.responsesOutputItems = msg0.responses_output_items;
        }
        if (choice0?.native_finish_reason != null) {
            turn.nativeFinishReason = choice0.native_finish_reason;
        }
        if (choice0?.stop_sequence != null) {
            turn.stopSequence = choice0.stop_sequence;
        }
        if (choice0?.stop_details != null) {
            turn.stopDetails = choice0.stop_details;
        }
        return turn;
    }
    return parseProtocolResponse(protocol, payload);
}

/**
 * Determine whether a ParsedTurn contains no assistant output at all (no text,
 * no refusal, no tool calls, no images).
 * @param {object|null|undefined} turn
 * @returns {boolean}
 */
export function isParsedTurnEmpty(turn) {
    if (!turn || typeof turn !== 'object') return true;
    const hasText = typeof turn.text === 'string' && turn.text.length > 0;
    const hasRefusal = typeof turn.refusal === 'string' && turn.refusal.length > 0;
    const hasTools = Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0;
    const hasImages = Array.isArray(turn.images) && turn.images.length > 0;
    const isPausedTurn = turn.finishReason === 'pause_turn'
        && Array.isArray(turn.nativeContentBlocks)
        && turn.nativeContentBlocks.length > 0;
    return !hasText && !hasRefusal && !hasTools && !hasImages && !isPausedTurn;
}
