// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, extractProviderErrorMessage } from '../errors.js';
import {
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeCohereUsage,
    normalizeFinishReason,
} from '../protocol.js';
import { cloneValue, coerceToolArgs, parseSseJsonFrame } from './common.js';

const PROTOCOL = WIRE_PROTOCOLS.COHERE;

const COHERE_STREAM_EVENTS = new Set([
    'message-start',
    'content-start',
    'content-delta',
    'content-end',
    'tool-plan-delta',
    'tool-call-start',
    'tool-call-delta',
    'tool-call-end',
    'citation-start',
    'citation-end',
    'message-end',
    'debug',
    'error',
]);

function assertNotForeignPayload(payload, location) {
    if (Array.isArray(payload.choices)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Cohere v2 payload, received OpenAI Chat choices shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.candidates) || payload.promptFeedback) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Cohere v2 payload, received Gemini candidates shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.output) || payload.object === 'response' || (typeof payload.type === 'string' && payload.type.startsWith('response.'))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Cohere v2 payload, received OpenAI Responses shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.content) || (typeof payload.type === 'string' && /^(message_|content_block_)/.test(payload.type))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Cohere v2 payload, received Anthropic Messages shape.',
            rawDiagnostic: payload,
        });
    }
}

/**
 * Parse a non-streaming Cohere v2 Chat response strictly.
 * @param {*} payload
 */
export function parseCohereResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'payload',
            location: 'root',
            message: 'Expected Cohere v2 JSON object response.',
            rawDiagnostic: payload,
        });
    }
    if (payload.error != null) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'error',
            message: extractProviderErrorMessage(payload.error),
            providerError: payload.error,
            rawDiagnostic: payload,
        });
    }
    if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'message',
            message: payload.message,
            providerError: { message: payload.message },
            rawDiagnostic: payload,
        });
    }
    assertNotForeignPayload(payload, 'root');
    if (!payload.message || typeof payload.message !== 'object') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location: 'message',
            message: 'Cohere v2 response is missing message object.',
            rawDiagnostic: payload,
        });
    }

    const msg = payload.message;
    let text = '';
    let reasoning = '';
    const parts = [];
    if (typeof msg.content === 'string') {
        text = msg.content;
        if (text) parts.push({ type: 'text', text });
    } else {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                reasoning += block.thinking;
                if (block.thinking) parts.push({ type: 'reasoning', kind: 'thinking', text: block.thinking });
            } else if (typeof block.text === 'string') {
                text += block.text;
                if (block.text) parts.push({ type: 'text', text: block.text });
            }
        }
    }
    if (typeof msg.tool_plan === 'string' && msg.tool_plan) {
        if (!text) {
            text = msg.tool_plan;
            parts.push({ type: 'text', text });
        } else {
            reasoning = reasoning ? `${reasoning}\n\n${msg.tool_plan}` : msg.tool_plan;
            parts.push({ type: 'reasoning', kind: 'thinking', text: msg.tool_plan });
        }
    }

    const toolCalls = [];
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;
            const argsStr = typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {});
            toolCalls.push({
                id: String(tc.id || ''),
                type: 'function',
                function: {
                    name: String(tc.function?.name || ''),
                    arguments: argsStr,
                },
            });
            parts.push({
                type: 'tool_call',
                id: String(tc.id || ''),
                name: String(tc.function?.name || ''),
                args: coerceToolArgs(argsStr),
            });
        }
    }

    const nativeFinishReason = typeof payload.finish_reason === 'string' && payload.finish_reason
        ? payload.finish_reason
        : null;
    const finishReason = normalizeFinishReason(PROTOCOL, nativeFinishReason)
        ?? (toolCalls.length > 0 ? 'tool_calls' : null);

    return {
        protocol: PROTOCOL,
        text,
        swipes: [],
        reasoning,
        signature: null,
        reasoningBlocks: null,
        reasoningDetails: null,
        nativeParts: null,
        nativeContentBlocks: null,
        responsesOutputItems: null,
        toolCalls,
        images: [],
        citations: Array.isArray(msg.citations) && msg.citations.length > 0 ? msg.citations.map(cloneValue) : null,
        refusal: null,
        parts,
        usage: normalizeCohereUsage(payload.usage),
        finishReason,
        nativeFinishReason,
        stopSequence: null,
        stopDetails: null,
        blockedReason: null,
    };
}

/**
 * Create a strict incremental Cohere v2 SSE parser.
 */
export function createCohereStreamParser() {
    let text = '';
    let reasoning = '';
    /** @type {Map<number, { id: string, name: string, argsStr: string }>} */
    const toolCallsByIndex = new Map();
    /** @type {number[]} */
    const toolOrder = [];
    /** @type {Array<object>} */
    const citations = [];
    let usage = null;
    let nativeFinishReason = null;
    let frameIndex = 0;
    let sawFrames = false;
    let sawMessageEnd = false;

    function getSnapshot() {
        const parts = [];
        if (reasoning) parts.push({ type: 'reasoning', kind: 'thinking', text: reasoning });
        if (text) parts.push({ type: 'text', text });
        const toolCalls = [];
        for (const idx of toolOrder) {
            const tc = toolCallsByIndex.get(idx);
            if (!tc) continue;
            toolCalls.push({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: tc.argsStr,
                },
            });
            parts.push({
                type: 'tool_call',
                id: tc.id,
                name: tc.name,
                args: coerceToolArgs(tc.argsStr),
            });
        }
        const finishReason = normalizeFinishReason(PROTOCOL, nativeFinishReason)
            ?? (toolCalls.length > 0 ? 'tool_calls' : null);
        return {
            protocol: PROTOCOL,
            text,
            swipes: [],
            reasoning,
            signature: null,
            reasoningBlocks: null,
            reasoningDetails: null,
            nativeParts: null,
            nativeContentBlocks: null,
            responsesOutputItems: null,
            toolCalls,
            images: [],
            citations: citations.length > 0 ? citations.map(cloneValue) : null,
            refusal: null,
            parts,
            usage: usage ? cloneValue(usage) : null,
            finishReason,
            nativeFinishReason,
            stopSequence: null,
            stopDetails: null,
            blockedReason: null,
        };
    }

    function feedFrame(rawData, eventName = '') {
        const location = `frame[${frameIndex}]${eventName ? `(${eventName})` : ''}`;
        frameIndex += 1;

        if (rawData === '[DONE]') {
            return { textDelta: '', reasoningDelta: '', refusalDelta: '', imagesDelta: [], logprobsPayload: null, hasMetadataUpdate: false };
        }

        const parsed = parseSseJsonFrame(rawData, { protocol: PROTOCOL, location, label: 'Cohere' });

        if (parsed.type === 'error' || parsed.error != null) {
            const providerError = parsed.error ?? parsed;
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'provider_error',
                location,
                message: extractProviderErrorMessage(providerError),
                providerError,
                rawDiagnostic: parsed,
            });
        }

        assertNotForeignPayload(parsed, location);

        const type = typeof parsed.type === 'string' ? parsed.type : String(eventName || '');
        if (!COHERE_STREAM_EVENTS.has(type)) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'protocol_mismatch',
                location,
                message: `Unrecognized Cohere SSE event type "${type || '(missing)'}" at ${location}.`,
                rawDiagnostic: parsed,
            });
        }

        sawFrames = true;
        let textDelta = '';
        let reasoningDelta = '';
        let hasMetadataUpdate = false;

        if (type === 'content-start' || type === 'content-delta') {
            const contentDelta = parsed.delta?.message?.content;
            if (typeof contentDelta?.text === 'string' && contentDelta.text) {
                text += contentDelta.text;
                textDelta += contentDelta.text;
            } else if (typeof contentDelta?.thinking === 'string' && contentDelta.thinking) {
                reasoning += contentDelta.thinking;
                reasoningDelta += contentDelta.thinking;
            }
        } else if (type === 'tool-plan-delta') {
            const plan = parsed.delta?.message?.tool_plan;
            if (typeof plan === 'string' && plan) {
                reasoning += plan;
                reasoningDelta += plan;
            }
        } else if (type === 'tool-call-start') {
            const idx = Number.isInteger(parsed.index) ? parsed.index : toolOrder.length;
            const tc = parsed.delta?.message?.tool_calls;
            if (!toolCallsByIndex.has(idx)) toolOrder.push(idx);
            toolCallsByIndex.set(idx, {
                id: String(tc?.id || ''),
                name: String(tc?.function?.name || ''),
                argsStr: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '',
            });
            hasMetadataUpdate = true;
        } else if (type === 'tool-call-delta') {
            const idx = Number.isInteger(parsed.index) ? parsed.index : null;
            const slot = idx !== null ? toolCallsByIndex.get(idx) : null;
            if (!slot) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location,
                    message: `Cohere tool-call-delta referenced unknown index ${String(parsed.index)} at ${location}.`,
                    rawDiagnostic: parsed,
                });
            }
            const argDelta = parsed.delta?.message?.tool_calls?.function?.arguments;
            if (typeof argDelta === 'string') slot.argsStr += argDelta;
        } else if (type === 'tool-call-end') {
            hasMetadataUpdate = true;
        } else if (type === 'citation-start') {
            const incoming = parsed.delta?.message?.citations;
            if (Array.isArray(incoming)) {
                for (const citation of incoming) {
                    if (citation && typeof citation === 'object') {
                        citations.push(cloneValue(citation));
                        hasMetadataUpdate = true;
                    }
                }
            } else if (incoming && typeof incoming === 'object') {
                citations.push(cloneValue(incoming));
                hasMetadataUpdate = true;
            }
        } else if (type === 'message-end') {
            sawMessageEnd = true;
            hasMetadataUpdate = true;
            if (typeof parsed.delta?.finish_reason === 'string' && parsed.delta.finish_reason) {
                nativeFinishReason = parsed.delta.finish_reason;
            }
            const u = normalizeCohereUsage(parsed.delta?.usage ?? parsed.usage);
            if (u) usage = mergeNormalizedUsage(usage, u);
        }

        return {
            textDelta,
            reasoningDelta,
            refusalDelta: '',
            imagesDelta: [],
            logprobsPayload: null,
            hasMetadataUpdate,
        };
    }

    function finish() {
        if (sawFrames && !sawMessageEnd) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'eof',
                location: 'eof',
                message: 'Cohere SSE stream ended prematurely before message-end.',
            });
        }
        return getSnapshot();
    }

    return { feedFrame, finish, getSnapshot };
}
