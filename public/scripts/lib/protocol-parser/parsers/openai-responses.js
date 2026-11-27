// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, extractProviderErrorMessage } from '../errors.js';
import {
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeOpenAIResponsesUsage,
} from '../protocol.js';
import { cloneValue, coerceToolArgs, parseSseJsonFrame } from './common.js';
import { createJsonToolPreviewTracker } from './json-argument-preview.js';

const PROTOCOL = WIRE_PROTOCOLS.OPENAI_RESPONSES;

function extractResponsesAnnotations(annotations, target, seenKeys) {
    if (!Array.isArray(annotations)) return false;
    let added = false;
    for (const ann of annotations) {
        if (!ann || typeof ann !== 'object') continue;
        const key = JSON.stringify([ann.type || '', ann.url || '', ann.title || '', ann.start_index ?? null, ann.end_index ?? null]);
        if (seenKeys && seenKeys.has(key)) continue;
        if (seenKeys) seenKeys.add(key);
        target.push(cloneValue(ann));
        added = true;
    }
    return added;
}

function assertNotForeignPayload(payload, location) {
    if (Array.isArray(payload.choices)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Responses payload, received OpenAI Chat choices shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.candidates) || payload.promptFeedback) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Responses payload, received Gemini candidates shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.content) || (typeof payload.type === 'string' && /^(message_|content_block_)/.test(payload.type))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Responses payload, received Anthropic Messages shape.',
            rawDiagnostic: payload,
        });
    }
    if (payload.message && typeof payload.message === 'object') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Responses payload, received Cohere message shape.',
            rawDiagnostic: payload,
        });
    }
}

function resolveResponsesFinishReason({ status, incompleteReason, hasToolCalls, hasRefusal, hasText }) {
    if (status === 'cancelled') return 'cancelled';
    if (status === 'incomplete') {
        return incompleteReason === 'content_filter' ? 'content_filter' : 'length';
    }
    if (hasToolCalls) return 'tool_calls';
    if (hasRefusal && !hasText) return 'content_filter';
    if (status === 'completed') return 'stop';
    return status || null;
}

/**
 * Parse a non-streaming OpenAI Responses API JSON object strictly.
 * @param {*} payload
 */
export function parseOpenAIResponsesResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'payload',
            location: 'root',
            message: 'Expected OpenAI Responses JSON object response.',
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
    if (payload.status === 'failed') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'status',
            message: 'OpenAI Responses API returned status "failed".',
            providerError: { message: 'OpenAI Responses API returned status "failed".', code: 'failed' },
            rawDiagnostic: payload,
        });
    }
    assertNotForeignPayload(payload, 'root');
    if (!Array.isArray(payload.output) && payload.object !== 'response' && typeof payload.status !== 'string') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location: 'output',
            message: 'OpenAI Responses payload is missing output[] and response status.',
            rawDiagnostic: payload,
        });
    }

    const output = Array.isArray(payload.output) ? payload.output : [];
    const textPieces = [];
    const refusalPieces = [];
    const reasoningPieces = [];
    const toolCalls = [];
    const citations = [];
    const citationKeys = new Set();
    const parts = [];
    const responsesOutputItems = [];

    for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        responsesOutputItems.push(cloneValue(item));

        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    textPieces.push(part.text);
                    extractResponsesAnnotations(part.annotations, citations, citationKeys);
                    if (part.text) parts.push({ type: 'text', text: part.text });
                } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                    refusalPieces.push(part.refusal);
                    if (part.refusal) parts.push({ type: 'text', text: part.refusal });
                }
            }
        } else if (item.type === 'reasoning') {
            if (Array.isArray(item.summary)) {
                for (const s of item.summary) {
                    if (s?.type === 'summary_text' && typeof s.text === 'string' && s.text) {
                        reasoningPieces.push(s.text);
                        parts.push({ type: 'reasoning', kind: 'thinking', text: s.text });
                    }
                }
            }
            if (typeof item.text === 'string' && item.text) {
                reasoningPieces.push(item.text);
                parts.push({ type: 'reasoning', kind: 'thinking', text: item.text });
            }
        } else if (item.type === 'function_call') {
            const callId = String(item.call_id || item.id || '');
            const name = String(item.name || '');
            const argsStr = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
            toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                    name,
                    arguments: argsStr,
                },
            });
            parts.push({
                type: 'tool_call',
                id: callId,
                name,
                args: coerceToolArgs(argsStr),
            });
        }
    }

    const rawText = textPieces.join('');
    const refusal = refusalPieces.join('') || null;
    const text = rawText || refusal || '';
    const reasoning = reasoningPieces.join('');
    const status = typeof payload.status === 'string' ? payload.status : null;
    const incompleteReason = typeof payload.incomplete_details?.reason === 'string'
        ? payload.incomplete_details.reason
        : null;
    const finishReason = resolveResponsesFinishReason({
        status,
        incompleteReason,
        hasToolCalls: toolCalls.length > 0,
        hasRefusal: Boolean(refusal),
        hasText: Boolean(rawText),
    });

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
        responsesOutputItems: responsesOutputItems.length > 0 ? responsesOutputItems : null,
        toolCalls,
        images: [],
        citations: citations.length > 0 ? citations : null,
        refusal,
        parts,
        usage: normalizeOpenAIResponsesUsage(payload.usage),
        finishReason,
        nativeFinishReason: incompleteReason || status,
        stopSequence: null,
        stopDetails: payload.incomplete_details ? cloneValue(payload.incomplete_details) : null,
        blockedReason: null,
    };
}

/**
 * Create a strict incremental OpenAI Responses SSE parser.
 */
export function createOpenAIResponsesStreamParser() {
    let text = '';
    let refusal = '';
    let reasoning = '';
    /** @type {object[]} */
    const orderedParts = [];
    let pendingText = '';
    let pendingReasoning = '';
    /** @type {Map<number, { id: string, name: string, argsStr: string, closed: boolean, emittedPart: boolean, jsonParseError: ProtocolParseError|null }>} */
    const toolCallsByOutputIndex = new Map();
    /** @type {number[]} */
    const toolOrder = [];
    const previewTracker = createJsonToolPreviewTracker();
    /** @type {Map<number, object>} */
    const doneItemsByIndex = new Map();
    /** @type {object[]} */
    const citations = [];
    const citationKeys = new Set();
    /** @type {object[]|null} */
    let terminalOutputItems = null;
    let usage = null;
    let status = null;
    let incompleteReason = null;
    let stopDetails = null;
    let frameIndex = 0;
    let sawFrames = false;
    let sawTerminal = false;

    function flushPendingText() {
        if (pendingText) {
            orderedParts.push({ type: 'text', text: pendingText });
            pendingText = '';
        }
    }

    function flushPendingReasoning() {
        if (pendingReasoning) {
            orderedParts.push({ type: 'reasoning', kind: 'thinking', text: pendingReasoning });
            pendingReasoning = '';
        }
    }

    function snapshotResponsesOutputItems() {
        if (Array.isArray(terminalOutputItems) && terminalOutputItems.length > 0) {
            return terminalOutputItems.map(cloneValue);
        }
        if (doneItemsByIndex.size === 0) return null;
        return [...doneItemsByIndex.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, item]) => cloneValue(item));
    }

    function getSnapshot() {
        const parts = orderedParts.map(cloneValue);
        if (pendingReasoning) parts.push({ type: 'reasoning', kind: 'thinking', text: pendingReasoning });
        if (pendingText) parts.push({ type: 'text', text: pendingText });
        const toolCalls = [];
        for (const idx of toolOrder) {
            const tc = toolCallsByOutputIndex.get(idx);
            if (!tc || !tc.closed || !tc.name) continue;
            toolCalls.push({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: tc.argsStr,
                },
            });
            if (!tc.emittedPart) {
                parts.push({
                    type: 'tool_call',
                    id: tc.id,
                    name: tc.name,
                    args: coerceToolArgs(tc.argsStr),
                });
            }
        }

        const finishReason = resolveResponsesFinishReason({
            status,
            incompleteReason,
            hasToolCalls: toolCalls.length > 0,
            hasRefusal: Boolean(refusal),
            hasText: Boolean(text),
        });

        return {
            protocol: PROTOCOL,
            text: text || refusal,
            swipes: [],
            reasoning,
            signature: null,
            reasoningBlocks: null,
            reasoningDetails: null,
            nativeParts: null,
            nativeContentBlocks: null,
            responsesOutputItems: snapshotResponsesOutputItems(),
            toolCalls,
            images: [],
            citations: citations.length > 0 ? citations.map(cloneValue) : null,
            refusal: refusal || null,
            parts,
            usage: usage ? cloneValue(usage) : null,
            finishReason,
            nativeFinishReason: incompleteReason || status,
            stopSequence: null,
            stopDetails: stopDetails ? cloneValue(stopDetails) : null,
            blockedReason: null,
        };
    }

    function feedFrame(rawData, eventName = '') {
        const location = `frame[${frameIndex}]${eventName ? `(${eventName})` : ''}`;
        frameIndex += 1;

        if (rawData === '[DONE]') {
            return { textDelta: '', reasoningDelta: '', refusalDelta: '', imagesDelta: [], logprobsPayload: null, hasMetadataUpdate: false };
        }

        const parsed = parseSseJsonFrame(rawData, { protocol: PROTOCOL, location, label: 'OpenAI Responses' });

        if (parsed.type === 'error' || parsed.type === 'response.failed' || parsed.error != null) {
            const providerError = parsed.response?.error ?? parsed.error ?? parsed;
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

        const type = typeof parsed.type === 'string' ? parsed.type : '';
        if (!type.startsWith('response.')) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'protocol_mismatch',
                location,
                message: `Expected OpenAI Responses "response.*" event type, got "${type || '(missing)'}" at ${location}.`,
                rawDiagnostic: parsed,
            });
        }

        sawFrames = true;
        let textDelta = '';
        let reasoningDelta = '';
        let refusalDelta = '';
        let hasMetadataUpdate = false;

        if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
            flushPendingReasoning();
            text += parsed.delta;
            pendingText += parsed.delta;
            textDelta = parsed.delta;
        } else if (type === 'response.refusal.delta' && typeof parsed.delta === 'string') {
            flushPendingReasoning();
            refusal += parsed.delta;
            pendingText += parsed.delta;
            refusalDelta = parsed.delta;
            hasMetadataUpdate = true;
        } else if ((type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') && typeof parsed.delta === 'string') {
            flushPendingText();
            reasoning += parsed.delta;
            pendingReasoning += parsed.delta;
            reasoningDelta = parsed.delta;
        } else if (type === 'response.output_text.annotation.added' && parsed.annotation && typeof parsed.annotation === 'object') {
            if (extractResponsesAnnotations([parsed.annotation], citations, citationKeys)) {
                hasMetadataUpdate = true;
            }
        } else if (type === 'response.output_item.added') {
            const item = parsed.item;
            if (item?.type === 'function_call') {
                const idx = Number.isInteger(parsed.output_index) ? parsed.output_index : toolOrder.length;
                if (!toolCallsByOutputIndex.has(idx)) {
                    toolOrder.push(idx);
                }
                toolCallsByOutputIndex.set(idx, {
                    id: String(item.call_id || item.id || ''),
                    name: String(item.name || ''),
                    argsStr: typeof item.arguments === 'string' ? item.arguments : '',
                    closed: false,
                    emittedPart: false,
                    jsonParseError: null,
                });
                hasMetadataUpdate = true;
            }
        } else if (type === 'response.function_call_arguments.delta') {
            const idx = Number.isInteger(parsed.output_index) ? parsed.output_index : null;
            const slot = idx !== null ? toolCallsByOutputIndex.get(idx) : null;
            if (!slot) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location,
                    message: `Received function_call_arguments.delta for unknown output_index ${String(parsed.output_index)} at ${location}.`,
                    rawDiagnostic: parsed,
                });
            }
            if (typeof parsed.delta === 'string') {
                slot.argsStr += parsed.delta;
            }
        } else if (type === 'response.function_call_arguments.done') {
            const idx = Number.isInteger(parsed.output_index) ? parsed.output_index : null;
            const slot = idx !== null ? toolCallsByOutputIndex.get(idx) : null;
            if (!slot) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location,
                    message: `Received function_call_arguments.done for unknown output_index ${String(parsed.output_index)} at ${location}.`,
                    rawDiagnostic: parsed,
                });
            }
            if (typeof parsed.arguments === 'string' && !slot.argsStr) {
                slot.argsStr = parsed.arguments;
            }
            if (typeof parsed.name === 'string' && !slot.name) {
                slot.name = parsed.name;
            }
            const rawArgs = slot.argsStr.trim();
            if (rawArgs.length > 0) {
                try {
                    JSON.parse(rawArgs);
                    if (slot.name) {
                        slot.closed = true;
                    }
                } catch (cause) {
                    slot.jsonParseError = new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'tool_correlation',
                        location,
                        message: `Malformed tool arguments JSON on OpenAI Responses output_index ${idx} ("${slot.name}"): ${cause.message}`,
                        cause,
                        rawDiagnostic: parsed,
                    });
                }
            } else if (slot.name) {
                slot.closed = true;
            }
            hasMetadataUpdate = true;
        } else if (type === 'response.output_item.done') {
            if (parsed.item && typeof parsed.item === 'object') {
                const idx = Number.isInteger(parsed.output_index) ? parsed.output_index : doneItemsByIndex.size;
                hasMetadataUpdate = true;
                if (parsed.item.type === 'message' && Array.isArray(parsed.item.content)) {
                    doneItemsByIndex.set(idx, cloneValue(parsed.item));
                    for (const part of parsed.item.content) {
                        if (part?.type === 'output_text' && Array.isArray(part.annotations)) {
                            extractResponsesAnnotations(part.annotations, citations, citationKeys);
                        }
                    }
                } else if (parsed.item.type === 'function_call') {
                    flushPendingReasoning();
                    flushPendingText();
                    let slot = toolCallsByOutputIndex.get(idx);
                    if (!slot) {
                        toolOrder.push(idx);
                        slot = {
                            id: String(parsed.item.call_id || parsed.item.id || ''),
                            name: String(parsed.item.name || ''),
                            argsStr: typeof parsed.item.arguments === 'string' ? parsed.item.arguments : '',
                            closed: false,
                            emittedPart: false,
                            jsonParseError: null,
                        };
                        toolCallsByOutputIndex.set(idx, slot);
                    } else {
                        if (!slot.id) {
                            slot.id = String(parsed.item.call_id || parsed.item.id || '');
                        }
                        if (!slot.name && typeof parsed.item.name === 'string') {
                            slot.name = parsed.item.name;
                        }
                        if (typeof parsed.item.arguments === 'string' && !slot.argsStr) {
                            slot.argsStr = parsed.item.arguments;
                        }
                    }
                    if (!slot.name) {
                        throw new ProtocolParseError({
                            protocol: PROTOCOL,
                            stage: 'tool_correlation',
                            location,
                            message: `OpenAI Responses tool call at output_index ${idx} is missing function name.`,
                            rawDiagnostic: parsed,
                        });
                    }
                    const rawArgs = slot.argsStr.trim();
                    let argsValid = true;
                    if (rawArgs.length > 0) {
                        try {
                            JSON.parse(rawArgs);
                        } catch (cause) {
                            argsValid = false;
                            slot.jsonParseError = new ProtocolParseError({
                                protocol: PROTOCOL,
                                stage: 'tool_correlation',
                                location,
                                message: `Malformed tool arguments JSON on OpenAI Responses output_index ${idx} ("${slot.name}"): ${cause.message}`,
                                cause,
                                rawDiagnostic: parsed,
                            });
                        }
                    }
                    if (argsValid && parsed.item.status !== 'incomplete') {
                        doneItemsByIndex.set(idx, cloneValue(parsed.item));
                        slot.closed = true;
                        if (!slot.emittedPart) {
                            slot.emittedPart = true;
                            orderedParts.push({
                                type: 'tool_call',
                                id: slot.id,
                                name: slot.name,
                                args: coerceToolArgs(slot.argsStr),
                            });
                        }
                    }
                } else {
                    doneItemsByIndex.set(idx, cloneValue(parsed.item));
                }
            }
        } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.cancelled') {
            sawTerminal = true;
            hasMetadataUpdate = true;
            const resp = parsed.response || {};
            status = typeof resp.status === 'string'
                ? resp.status
                : (type === 'response.completed'
                    ? 'completed'
                    : (type === 'response.cancelled' ? 'cancelled' : 'incomplete'));
            if (resp.incomplete_details && typeof resp.incomplete_details === 'object') {
                stopDetails = resp.incomplete_details;
                if (typeof resp.incomplete_details.reason === 'string') {
                    incompleteReason = resp.incomplete_details.reason;
                }
            }
            if (Array.isArray(resp.output) && resp.output.length > 0) {
                const filteredOutput = type === 'response.incomplete'
                    ? resp.output.filter((item) => {
                        if (!item || typeof item !== 'object') return false;
                        if (item.type !== 'function_call') return true;
                        if (item.status === 'incomplete') return false;
                        const argText = typeof item.arguments === 'string' ? item.arguments.trim() : '';
                        if (!argText) return false;
                        try {
                            JSON.parse(argText);
                            return true;
                        } catch {
                            return false;
                        }
                    })
                    : resp.output;
                terminalOutputItems = filteredOutput.length > 0 ? filteredOutput.map(cloneValue) : null;
                for (const item of resp.output) {
                    if (item?.type === 'message' && Array.isArray(item.content)) {
                        for (const part of item.content) {
                            if (part?.type === 'output_text' && Array.isArray(part.annotations)) {
                                extractResponsesAnnotations(part.annotations, citations, citationKeys);
                            }
                        }
                    }
                }
            }
            const u = normalizeOpenAIResponsesUsage(resp.usage ?? parsed.usage);
            if (u) usage = mergeNormalizedUsage(usage, u);
        }

        return {
            textDelta,
            reasoningDelta,
            refusalDelta,
            imagesDelta: [],
            logprobsPayload: null,
            hasMetadataUpdate,
        };
    }

    function finish() {
        const isPrematureEof = sawFrames && !sawTerminal;
        const isLengthTruncated = !isPrematureEof && status === 'incomplete' && incompleteReason !== 'content_filter';
        for (const idx of toolOrder) {
            const slot = toolCallsByOutputIndex.get(idx);
            if (!slot) continue;
            if (!slot.name) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location: `output[${idx}]`,
                    message: `OpenAI Responses tool call at output_index ${idx} is missing function name.`,
                    rawDiagnostic: slot,
                });
            }
            if (slot.closed) continue;
            if (slot.jsonParseError) {
                if (isLengthTruncated) continue;
                throw slot.jsonParseError;
            }
            const rawArgs = slot.argsStr.trim();
            if (rawArgs.length > 0) {
                try {
                    JSON.parse(rawArgs);
                    slot.closed = true;
                } catch (cause) {
                    if (isLengthTruncated) continue;
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'tool_correlation',
                        location: `output[${idx}].arguments`,
                        message: `OpenAI Responses tool call at output_index ${idx} has truncated JSON arguments at EOF.`,
                        cause,
                        rawDiagnostic: slot,
                    });
                }
            } else if (!isPrematureEof && !isLengthTruncated) {
                slot.closed = true;
            }
        }
        if (isPrematureEof) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'eof',
                location: 'eof',
                message: 'OpenAI Responses SSE stream ended prematurely before response.completed, response.incomplete, or response.cancelled.',
            });
        }
        return getSnapshot();
    }

    function getToolCallPreview(name, argument) {
        for (let i = toolOrder.length - 1; i >= 0; i -= 1) {
            const slot = toolCallsByOutputIndex.get(toolOrder[i]);
            if (slot && slot.name === name) {
                return previewTracker.getPreview(slot, slot.argsStr, argument);
            }
        }
        return '';
    }

    return { feedFrame, finish, getSnapshot, getToolCallPreview };
}
