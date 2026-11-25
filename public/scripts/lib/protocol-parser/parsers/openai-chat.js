// SPDX-License-Identifier: AGPL-3.0-or-later

import { joinReasoningDetailsText, mergeReasoningDetails } from '../../../util/reasoning-details.js';
import { ProtocolParseError, extractProviderErrorMessage } from '../errors.js';
import {
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeOpenAIChatUsage,
} from '../protocol.js';
import { cloneValue, coerceToolArgs, parseSseJsonFrame } from './common.js';

const PROTOCOL = WIRE_PROTOCOLS.OPENAI_CHAT;

function assertNotForeignPayload(payload, location) {
    if (Array.isArray(payload.candidates) || payload.promptFeedback) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Chat Completions payload, received Gemini candidates shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.output) || payload.object === 'response' || (typeof payload.type === 'string' && payload.type.startsWith('response.'))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Chat Completions payload, received OpenAI Responses shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.content) || (typeof payload.type === 'string' && /^(message_|content_block_)/.test(payload.type))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Chat Completions payload, received Anthropic Messages shape.',
            rawDiagnostic: payload,
        });
    }
    if ((payload.message && typeof payload.message === 'object')
        || (typeof payload.type === 'string' && /^(message-|content-|tool-call-|tool-plan-|citation-)/.test(payload.type))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected OpenAI Chat Completions payload, received Cohere shape.',
            rawDiagnostic: payload,
        });
    }
}

/**
 * Extract text, reasoning, and images from OpenAI Chat string or array content
 * (including Mistral Magistral `{ type: 'thinking', thinking: [{ type: 'text', text }] }` parts).
 */
function extractContentParts(content) {
    let text = '';
    let reasoning = '';
    const images = [];

    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'thinking') {
                if (typeof part.thinking === 'string') {
                    reasoning += part.thinking;
                } else if (Array.isArray(part.thinking)) {
                    for (const sub of part.thinking) {
                        if (typeof sub?.text === 'string') reasoning += sub.text;
                    }
                }
            } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
                images.push(part.image_url.url);
            } else if (typeof part.text === 'string' && !part.thought) {
                text += part.text;
            }
        }
    }
    return { text, reasoning, images };
}

function extractEncryptedSignatureFromDetails(details) {
    if (!Array.isArray(details)) return null;
    for (const detail of details) {
        if (!detail || typeof detail !== 'object') continue;
        if (detail.type === 'reasoning.encrypted'
            && typeof detail.data === 'string'
            && detail.data.length > 0
            && !(typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id))) {
            return detail.data;
        }
    }
    return null;
}

function buildParts({ text, reasoning, reasoningDetails, reasoningBlocks, images, toolCalls }) {
    const parts = [];
    const detailsText = reasoningDetails.length > 0 ? joinReasoningDetailsText(reasoningDetails) : '';
    const reasoningDuplicated = Boolean(reasoning && detailsText && reasoning === detailsText);
    if (reasoning && !reasoningDuplicated) {
        parts.push({ type: 'reasoning', kind: 'text', text: reasoning });
    }
    if (reasoningDetails.length > 0) {
        parts.push({ type: 'reasoning', kind: 'details', details: reasoningDetails.map(cloneValue) });
    }
    if (Array.isArray(reasoningBlocks) && reasoningBlocks.length > 0) {
        for (const b of reasoningBlocks) {
            if (b?.type === 'thinking') {
                parts.push({
                    type: 'reasoning',
                    kind: 'thinking',
                    text: typeof b.thinking === 'string' ? b.thinking : '',
                    signature: typeof b.signature === 'string' ? b.signature : '',
                });
            } else if (b?.type === 'redacted_thinking') {
                parts.push({
                    type: 'reasoning',
                    kind: 'redacted_thinking',
                    data: typeof b.data === 'string' ? b.data : '',
                });
            }
        }
    }
    if (text) {
        parts.push({ type: 'text', text });
    }
    for (const img of images) {
        parts.push({ type: 'image', url: img });
    }
    for (const tc of toolCalls) {
        parts.push({
            type: 'tool_call',
            id: tc.id || '',
            name: tc.function?.name || '',
            args: coerceToolArgs(tc.function?.arguments),
        });
    }
    return parts;
}

/**
 * Parse a non-streaming OpenAI Chat Completions JSON response strictly.
 * @param {*} payload
 */
export function parseOpenAIChatResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'payload',
            location: 'root',
            message: 'Expected OpenAI Chat Completions JSON object response.',
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
    assertNotForeignPayload(payload, 'root');
    if (!Array.isArray(payload.choices)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location: 'choices',
            message: 'OpenAI Chat Completions response is missing choices[] array.',
            rawDiagnostic: payload,
        });
    }

    const choice = payload.choices[0] || null;
    const msg = choice?.message || {};
    const extracted = extractContentParts(msg.content ?? choice?.text ?? '');
    let text = extracted.text;
    let reasoning = extracted.reasoning;
    const images = [...extracted.images];

    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
        reasoning = reasoning ? `${reasoning}${msg.reasoning_content}` : msg.reasoning_content;
    } else if (typeof msg.reasoning === 'string' && msg.reasoning) {
        reasoning = reasoning ? `${reasoning}${msg.reasoning}` : msg.reasoning;
    }

    const reasoningDetails = Array.isArray(msg.reasoning_details) && msg.reasoning_details.length > 0
        ? msg.reasoning_details.filter(d => d && typeof d === 'object').map(cloneValue)
        : [];
    const toolSignaturesById = {};
    for (const d of reasoningDetails) {
        if (d.type === 'reasoning.encrypted'
            && typeof d.data === 'string' && d.data
            && typeof d.id === 'string' && /^(tool_|call_)/.test(d.id)) {
            toolSignaturesById[d.id] = d.data;
        }
    }
    const reasoningBlocks = Array.isArray(msg.reasoning_blocks) && msg.reasoning_blocks.length > 0
        ? msg.reasoning_blocks.filter(b => b && typeof b === 'object').map(cloneValue)
        : null;

    if (Array.isArray(msg.images)) {
        for (const img of msg.images) {
            if (img?.type === 'image_url' && typeof img?.image_url?.url === 'string') {
                images.push(img.image_url.url);
            }
        }
    }

    const refusal = typeof msg.refusal === 'string' && msg.refusal.length > 0 ? msg.refusal : null;
    if (!text && refusal) {
        text = refusal;
    }

    const swipes = [];
    for (let i = 1; i < payload.choices.length; i++) {
        const swipeChoice = payload.choices[i];
        const swipeExtracted = extractContentParts(swipeChoice?.message?.content ?? swipeChoice?.text ?? '');
        swipes.push(swipeExtracted.text);
    }

    const toolCalls = [];
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;
            const callId = String(tc.id || '');
            const sig = typeof tc.signature === 'string' && tc.signature
                ? tc.signature
                : (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature
                    ? tc.thoughtSignature
                    : (callId && toolSignaturesById[callId] ? toolSignaturesById[callId] : undefined));
            const extraContent = tc.extra_content && typeof tc.extra_content === 'object'
                ? cloneValue(tc.extra_content)
                : undefined;
            const fnName = String(tc.function?.name || tc.name || '');
            const fnArgs = tc.function?.arguments ?? tc.arguments ?? '';
            toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                    name: fnName,
                    arguments: typeof fnArgs === 'string' ? fnArgs : JSON.stringify(fnArgs ?? {}),
                },
                ...(sig ? { signature: sig } : {}),
                ...(extraContent ? { extra_content: extraContent } : {}),
            });
        }
    } else if (msg.function_call && typeof msg.function_call === 'object') {
        toolCalls.push({
            id: '',
            type: 'function',
            function: {
                name: String(msg.function_call.name || ''),
                arguments: typeof msg.function_call.arguments === 'string'
                    ? msg.function_call.arguments
                    : JSON.stringify(msg.function_call.arguments ?? {}),
            },
        });
    }

    const signature = (typeof msg.signature === 'string' && msg.signature)
        ? msg.signature
        : extractEncryptedSignatureFromDetails(reasoningDetails);
    const finishReason = choice?.finish_reason ? String(choice.finish_reason) : null;
    const nativeFinishReason = choice?.native_finish_reason
        ? String(choice.native_finish_reason)
        : finishReason;

    return {
        protocol: PROTOCOL,
        text,
        swipes,
        reasoning,
        signature,
        reasoningBlocks,
        reasoningDetails: reasoningDetails.length > 0 ? reasoningDetails : null,
        nativeParts: Array.isArray(msg.native_parts) && msg.native_parts.length > 0 ? msg.native_parts.map(cloneValue) : null,
        nativeContentBlocks: Array.isArray(msg.native_content_blocks) && msg.native_content_blocks.length > 0 ? msg.native_content_blocks.map(cloneValue) : null,
        responsesOutputItems: Array.isArray(msg.responses_output_items) && msg.responses_output_items.length > 0 ? msg.responses_output_items.map(cloneValue) : null,
        toolCalls,
        images,
        citations: Array.isArray(msg.citations) && msg.citations.length > 0
            ? msg.citations.map(cloneValue)
            : (Array.isArray(payload.citations) && payload.citations.length > 0 ? payload.citations.map(cloneValue) : null),
        refusal,
        parts: buildParts({ text, reasoning, reasoningDetails, reasoningBlocks, images, toolCalls }),
        usage: normalizeOpenAIChatUsage(payload.usage),
        finishReason,
        nativeFinishReason,
        stopSequence: typeof choice?.stop_sequence === 'string' ? choice.stop_sequence : null,
        stopDetails: choice?.stop_details && typeof choice.stop_details === 'object' ? cloneValue(choice.stop_details) : null,
        blockedReason: null,
    };
}

/**
 * Create a strict incremental OpenAI Chat Completions SSE parser.
 */
export function createOpenAIChatStreamParser() {
    let text = '';
    const swipes = [];
    let reasoning = '';
    let directSignature = null;
    /** @type {object[]|null} */
    let reasoningBlocks = null;
    const reasoningDetails = [];
    /** @type {Record<string, string>} */
    const toolSignatures = {};
    const images = [];
    /** @type {any[]} */
    let citations = [];
    let refusal = '';
    /** @type {Map<number, { id: string, name: string, argsStr: string, signature?: string, extra_content?: object }>} */
    const toolCallsByIndex = new Map();
    /** @type {number[]} */
    const toolOrder = [];
    let usage = null;
    let finishReason = null;
    let nativeFinishReason = null;
    let frameIndex = 0;
    let sawFrames = false;
    let sawTerminal = false;

    function ensureToolSlot(idx) {
        let slot = toolCallsByIndex.get(idx);
        if (!slot) {
            slot = { id: '', name: '', argsStr: '' };
            toolCallsByIndex.set(idx, slot);
            toolOrder.push(idx);
        }
        return slot;
    }

    function resolveUnindexedToolSlotIndex(incomingId) {
        if (toolOrder.length === 0) return 0;
        const lastIdx = toolOrder[toolOrder.length - 1];
        const lastSlot = toolCallsByIndex.get(lastIdx);
        if (incomingId && lastSlot && lastSlot.id && lastSlot.id !== incomingId) {
            let nextIdx = lastIdx + 1;
            while (toolCallsByIndex.has(nextIdx)) nextIdx += 1;
            return nextIdx;
        }
        return lastIdx;
    }

    function materializeToolCalls() {
        return toolOrder.map((idx) => {
            const slot = toolCallsByIndex.get(idx);
            const sig = slot.signature || (slot.id && toolSignatures[slot.id]) || undefined;
            return {
                id: slot.id,
                type: 'function',
                function: {
                    name: slot.name,
                    arguments: slot.argsStr,
                },
                ...(sig ? { signature: sig } : {}),
                ...(slot.extra_content ? { extra_content: cloneValue(slot.extra_content) } : {}),
            };
        });
    }

    function getSnapshot() {
        const toolCalls = materializeToolCalls();
        const effectiveText = text || refusal;
        const sig = directSignature || extractEncryptedSignatureFromDetails(reasoningDetails);
        return {
            protocol: PROTOCOL,
            text: effectiveText,
            swipes: swipes.slice(),
            reasoning,
            signature: sig,
            reasoningBlocks: reasoningBlocks ? reasoningBlocks.map(cloneValue) : null,
            reasoningDetails: reasoningDetails.length > 0 ? reasoningDetails.map(cloneValue) : null,
            nativeParts: null,
            nativeContentBlocks: null,
            responsesOutputItems: null,
            toolCalls,
            images: images.slice(),
            citations: citations.length > 0 ? citations.map(cloneValue) : null,
            refusal: refusal || null,
            parts: buildParts({ text: effectiveText, reasoning, reasoningDetails, reasoningBlocks, images, toolCalls }),
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
            sawTerminal = true;
            return {
                textDelta: '',
                choiceTextDeltas: {},
                reasoningDelta: '',
                refusalDelta: '',
                imagesDelta: [],
                logprobsPayload: null,
                hasMetadataUpdate: false,
            };
        }

        const parsed = parseSseJsonFrame(rawData, { protocol: PROTOCOL, location, label: 'OpenAI Chat' });

        if (parsed.error != null) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'provider_error',
                location,
                message: extractProviderErrorMessage(parsed.error),
                providerError: parsed.error,
                rawDiagnostic: parsed,
            });
        }

        assertNotForeignPayload(parsed, location);

        if (!Array.isArray(parsed.choices) && parsed.usage == null) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'protocol_mismatch',
                location,
                message: `OpenAI Chat SSE ${location} is missing choices[] and usage.`,
                rawDiagnostic: parsed,
            });
        }

        sawFrames = true;
        let textDelta = '';
        const choiceTextDeltas = {};
        let reasoningDelta = '';
        let refusalDelta = '';
        const imagesDelta = [];
        let hasMetadataUpdate = false;

        if (parsed.usage && typeof parsed.usage === 'object') {
            const u = normalizeOpenAIChatUsage(parsed.usage);
            if (u) {
                usage = mergeNormalizedUsage(usage, u);
                hasMetadataUpdate = true;
            }
        }
        if (Array.isArray(parsed.citations) && parsed.citations.length > 0) {
            citations = parsed.citations.map(cloneValue);
            hasMetadataUpdate = true;
        }

        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        for (const choice of choices) {
            if (!choice || typeof choice !== 'object') continue;
            const choiceIdx = Number.isInteger(choice.index) ? choice.index : 0;
            const delta = choice.delta || choice.message || {};

            const extracted = extractContentParts(delta.content ?? choice.text ?? '');
            if (choiceIdx > 0) {
                if (extracted.text) {
                    const swipeIdx = choiceIdx - 1;
                    swipes[swipeIdx] = (swipes[swipeIdx] || '') + extracted.text;
                    choiceTextDeltas[choiceIdx] = (choiceTextDeltas[choiceIdx] || '') + extracted.text;
                }
                continue;
            }

            if (extracted.text) {
                text += extracted.text;
                textDelta += extracted.text;
            }
            if (extracted.reasoning) {
                reasoning += extracted.reasoning;
                reasoningDelta += extracted.reasoning;
            }
            if (extracted.images.length > 0) {
                images.push(...extracted.images);
                imagesDelta.push(...extracted.images);
            }

            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                reasoningDelta += delta.reasoning_content;
            } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
                reasoning += delta.reasoning;
                reasoningDelta += delta.reasoning;
            }

            if (typeof delta.signature === 'string' && delta.signature) {
                directSignature = delta.signature;
                hasMetadataUpdate = true;
            }
            if (Array.isArray(delta.reasoning_blocks) && delta.reasoning_blocks.length > 0) {
                reasoningBlocks = [
                    ...(reasoningBlocks || []),
                    ...delta.reasoning_blocks.filter(b => b && typeof b === 'object').map(cloneValue),
                ];
                hasMetadataUpdate = true;
            }

            const incomingDetails = [
                ...(Array.isArray(choice.delta?.reasoning_details) ? choice.delta.reasoning_details : []),
                ...(Array.isArray(choice.message?.reasoning_details) ? choice.message.reasoning_details : []),
            ];
            if (incomingDetails.length > 0) {
                for (const d of incomingDetails) {
                    if (d && d.type === 'reasoning.encrypted'
                        && typeof d.data === 'string' && d.data
                        && typeof d.id === 'string' && /^(tool_|call_)/.test(d.id)) {
                        toolSignatures[d.id] = d.data;
                    }
                }
                mergeReasoningDetails(reasoningDetails, incomingDetails);
                hasMetadataUpdate = true;
            }

            if (Array.isArray(delta.images)) {
                for (const img of delta.images) {
                    if (img?.type === 'image_url' && typeof img?.image_url?.url === 'string') {
                        images.push(img.image_url.url);
                        imagesDelta.push(img.image_url.url);
                    }
                }
            }

            if (typeof delta.refusal === 'string' && delta.refusal) {
                refusal += delta.refusal;
                refusalDelta += delta.refusal;
                hasMetadataUpdate = true;
            }
            if (Array.isArray(delta.citations) && delta.citations.length > 0) {
                citations = delta.citations.map(cloneValue);
                hasMetadataUpdate = true;
            } else if (Array.isArray(choice.message?.citations) && choice.message.citations.length > 0) {
                citations = choice.message.citations.map(cloneValue);
                hasMetadataUpdate = true;
            }

            if (delta.tool_calls !== undefined) {
                if (!Array.isArray(delta.tool_calls)) {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'tool_correlation',
                        location,
                        message: `OpenAI Chat delta.tool_calls must be an array at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
                for (const tc of delta.tool_calls) {
                    if (!tc || typeof tc !== 'object') continue;
                    const incomingId = typeof tc.id === 'string' && tc.id ? tc.id : '';
                    const idx = Number.isInteger(tc.index) ? tc.index : resolveUnindexedToolSlotIndex(incomingId);
                    const slot = ensureToolSlot(idx);
                    if (incomingId) slot.id = incomingId;
                    if (typeof tc.function?.name === 'string' && tc.function.name) slot.name += tc.function.name;
                    if (typeof tc.function?.arguments === 'string') slot.argsStr += tc.function.arguments;
                    const sig = typeof tc.signature === 'string' && tc.signature
                        ? tc.signature
                        : (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature ? tc.thoughtSignature : '');
                    if (sig) slot.signature = sig;
                    if (tc.extra_content && typeof tc.extra_content === 'object') {
                        slot.extra_content = cloneValue(tc.extra_content);
                    }
                    hasMetadataUpdate = true;
                }
            } else if (delta.function_call && typeof delta.function_call === 'object') {
                const slot = ensureToolSlot(0);
                if (typeof delta.function_call.name === 'string' && delta.function_call.name) {
                    slot.name += delta.function_call.name;
                }
                if (typeof delta.function_call.arguments === 'string') {
                    slot.argsStr += delta.function_call.arguments;
                }
                hasMetadataUpdate = true;
            }

            const rawFinish = choice.finish_reason ?? choice.delta?.finish_reason ?? null;
            const rawNative = choice.native_finish_reason ?? choice.delta?.native_finish_reason ?? null;
            if (rawFinish) {
                finishReason = String(rawFinish);
                nativeFinishReason = rawNative ? String(rawNative) : finishReason;
                sawTerminal = true;
                hasMetadataUpdate = true;
            } else if (rawNative) {
                nativeFinishReason = String(rawNative);
                hasMetadataUpdate = true;
            }
        }

        return {
            textDelta,
            choiceTextDeltas,
            reasoningDelta,
            refusalDelta,
            imagesDelta,
            logprobsPayload: parsed,
            hasMetadataUpdate,
        };
    }

    function finish() {
        if (sawFrames && !sawTerminal) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'eof',
                location: 'eof',
                message: 'OpenAI Chat SSE stream ended prematurely without finish_reason or [DONE].',
            });
        }
        for (const idx of toolOrder) {
            const slot = toolCallsByIndex.get(idx);
            if (slot && !slot.name) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location: `tool_calls[${idx}]`,
                    message: `OpenAI Chat tool call at index ${idx} is missing function name.`,
                    rawDiagnostic: slot,
                });
            }
        }
        return getSnapshot();
    }

    return { feedFrame, finish, getSnapshot };
}
