// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, extractProviderErrorMessage } from '../errors.js';
import {
    GEMINI_BLOCKED_FINISH_REASONS,
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeFinishReason,
    normalizeGeminiUsage,
} from '../protocol.js';
import { cloneValue, parseSseJsonFrame } from './common.js';

const PROTOCOL = WIRE_PROTOCOLS.GEMINI;

function assertNotForeignPayload(payload, location) {
    if (Array.isArray(payload.choices)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Gemini GenerateContent payload, received OpenAI Chat choices shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.output) || payload.object === 'response' || (typeof payload.type === 'string' && payload.type.startsWith('response.'))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Gemini GenerateContent payload, received OpenAI Responses shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.content) || (typeof payload.type === 'string' && /^(message_|content_block_)/.test(payload.type))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Gemini GenerateContent payload, received Anthropic Messages shape.',
            rawDiagnostic: payload,
        });
    }
    if (payload.message && typeof payload.message === 'object') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Gemini GenerateContent payload, received Cohere message shape.',
            rawDiagnostic: payload,
        });
    }
}

function makeFallbackCallId(index) {
    return `gemini_call_${index}`;
}

function createAccumulator() {
    let text = '';
    let reasoning = '';
    let signature = null;
    /** @type {object[]} */
    const nativeParts = [];
    /** @type {object[]} */
    const toolCalls = [];
    /** @type {string[]} */
    const images = [];
    /** @type {object[]} */
    const citations = [];
    const citationKeys = new Set();
    /** @type {object[]} */
    const parts = [];
    let usage = null;
    let nativeFinishReason = null;
    let promptBlockReason = null;
    let callCounter = 0;

    function ingestGroundingMetadata(groundingMetadata) {
        const chunks = Array.isArray(groundingMetadata?.groundingChunks) ? groundingMetadata.groundingChunks : [];
        let added = false;
        for (const chunk of chunks) {
            if (!chunk || typeof chunk !== 'object') continue;
            const web = chunk.web && typeof chunk.web === 'object' ? chunk.web : null;
            const retrieved = chunk.retrievedContext && typeof chunk.retrievedContext === 'object' ? chunk.retrievedContext : null;
            const record = web
                ? { type: 'grounding_web', url: String(web.uri || web.url || ''), title: String(web.title || '') }
                : (retrieved
                    ? { type: 'grounding_retrieved', url: String(retrieved.uri || ''), title: String(retrieved.title || '') }
                    : cloneValue(chunk));
            if ((web || retrieved) && !record.url && !record.title) continue;
            const key = JSON.stringify(record);
            if (citationKeys.has(key)) continue;
            citationKeys.add(key);
            citations.push(record);
            added = true;
        }
        return added;
    }

    function appendOrderedTextPart(kind, chunkText, sig) {
        if (!chunkText) return;
        const last = parts[parts.length - 1];
        if (kind === 'thinking') {
            if (last && last.type === 'reasoning' && last.kind === 'thinking' && !last.signature && !sig) {
                last.text += chunkText;
            } else {
                parts.push({
                    type: 'reasoning',
                    kind: 'thinking',
                    text: chunkText,
                    ...(sig ? { signature: sig } : {}),
                });
            }
        } else if (last && last.type === 'text') {
            last.text += chunkText;
        } else {
            parts.push({ type: 'text', text: chunkText });
        }
    }

    function ingestParts(rawParts) {
        let textDelta = '';
        let reasoningDelta = '';
        const imagesDelta = [];

        for (const part of rawParts) {
            if (!part || typeof part !== 'object') continue;

            // Preserve ordered native Parts without merging across signed
            // boundaries or non-text parts.
            const prevNative = nativeParts[nativeParts.length - 1];
            const isMergeableText = typeof part.text === 'string'
                && !part.functionCall && !part.function_call && !part.inlineData
                && !part.thoughtSignature;
            if (isMergeableText && prevNative && typeof prevNative.text === 'string'
                && Boolean(prevNative.thought) === Boolean(part.thought)
                && !prevNative.functionCall && !prevNative.function_call && !prevNative.inlineData
                && !prevNative.thoughtSignature) {
                prevNative.text += part.text;
            } else {
                nativeParts.push(cloneValue(part));
            }

            const sig = typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
                ? part.thoughtSignature
                : null;
            if (sig && (typeof part.text === 'string' || !signature)) {
                signature = sig;
            }

            if (part.thought && typeof part.text === 'string') {
                reasoning += part.text;
                reasoningDelta += part.text;
                appendOrderedTextPart('thinking', part.text, sig);
            } else if (!part.thought && typeof part.text === 'string') {
                text += part.text;
                textDelta += part.text;
                appendOrderedTextPart('text', part.text, sig);
            }

            const fc = part.functionCall || part.function_call;
            if (fc && typeof fc === 'object') {
                callCounter += 1;
                const callId = (typeof fc.id === 'string' && fc.id.length > 0) ? fc.id : makeFallbackCallId(callCounter);
                const callName = String(fc.name || '');
                const callArgs = fc.args && typeof fc.args === 'object' ? fc.args : {};
                toolCalls.push({
                    id: callId,
                    type: 'function',
                    ...(sig ? { signature: sig } : {}),
                    function: {
                        name: callName,
                        arguments: JSON.stringify(callArgs),
                    },
                });
                parts.push({
                    type: 'tool_call',
                    id: typeof fc.id === 'string' ? fc.id : '',
                    name: callName,
                    args: cloneValue(callArgs),
                    ...(sig ? { signature: sig } : {}),
                });
            }

            if (part.inlineData && typeof part.inlineData === 'object' && !part.thought) {
                const mime = String(part.inlineData.mimeType || '');
                const data = String(part.inlineData.data || '');
                if (mime && data) {
                    const dataUrl = `data:${mime};base64,${data}`;
                    images.push(dataUrl);
                    imagesDelta.push(dataUrl);
                }
                parts.push({
                    type: 'image',
                    mime,
                    data,
                });
            }
        }

        return { textDelta, reasoningDelta, imagesDelta };
    }

    function ingestPayload(payload) {
        let hasMetadataUpdate = false;
        if (payload.usageMetadata && typeof payload.usageMetadata === 'object') {
            const u = normalizeGeminiUsage(payload.usageMetadata);
            if (u) {
                usage = mergeNormalizedUsage(usage, u);
                hasMetadataUpdate = true;
            }
        }
        if (payload.promptFeedback?.blockReason) {
            promptBlockReason = String(payload.promptFeedback.blockReason);
            hasMetadataUpdate = true;
        }
        const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
        if (candidate?.finishReason) {
            nativeFinishReason = String(candidate.finishReason);
            hasMetadataUpdate = true;
        }
        if (candidate?.groundingMetadata && ingestGroundingMetadata(candidate.groundingMetadata)) {
            hasMetadataUpdate = true;
        }
        const rawParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const prevToolCount = toolCalls.length;
        const prevSignature = signature;
        const partDelta = ingestParts(rawParts);
        if (toolCalls.length !== prevToolCount || signature !== prevSignature) {
            hasMetadataUpdate = true;
        }
        return { ...partDelta, hasMetadataUpdate };
    }

    function getSnapshot() {
        let finishReason = normalizeFinishReason(PROTOCOL, nativeFinishReason);
        if (toolCalls.length > 0 && (!finishReason || finishReason === 'stop')) {
            finishReason = 'tool_calls';
        }
        const blockedReason = promptBlockReason
            || (!text && toolCalls.length === 0 && images.length === 0 && nativeFinishReason && GEMINI_BLOCKED_FINISH_REASONS.has(nativeFinishReason)
                ? nativeFinishReason
                : null);

        return {
            protocol: PROTOCOL,
            text,
            swipes: [],
            reasoning,
            signature,
            reasoningBlocks: null,
            reasoningDetails: null,
            nativeParts: nativeParts.length > 0 ? nativeParts.map(cloneValue) : null,
            nativeContentBlocks: null,
            responsesOutputItems: null,
            toolCalls: toolCalls.map(cloneValue),
            images: images.slice(),
            citations: citations.length > 0 ? citations.map(cloneValue) : null,
            refusal: null,
            parts: parts.map(cloneValue),
            usage: usage ? cloneValue(usage) : null,
            finishReason,
            nativeFinishReason,
            stopSequence: null,
            stopDetails: null,
            blockedReason,
        };
    }

    return { ingestPayload, getSnapshot };
}

/**
 * Parse a non-streaming Gemini GenerateContent response payload strictly.
 * @param {*} payload
 */
export function parseGeminiResponse(payload) {
    if (Array.isArray(payload) && payload.length > 0 && payload[0] && typeof payload[0] === 'object' && payload[0].error != null) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: '[0].error',
            message: extractProviderErrorMessage(payload[0].error),
            providerError: payload[0].error,
            rawDiagnostic: payload,
        });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'payload',
            location: 'root',
            message: 'Expected Gemini GenerateContent JSON object response.',
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
    if (!Array.isArray(payload.candidates) && !payload.promptFeedback) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location: 'candidates',
            message: 'Gemini GenerateContent response is missing candidates[] and promptFeedback.',
            rawDiagnostic: payload,
        });
    }

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const blockReason = payload.promptFeedback?.blockReason ? String(payload.promptFeedback.blockReason) : '';
    if (candidates.length === 0 && blockReason) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'promptFeedback.blockReason',
            message: `Gemini API returned no candidate (blocked by ${blockReason}).`,
            providerError: { message: `Gemini API returned no candidate (blocked by ${blockReason}).`, code: blockReason },
            rawDiagnostic: payload,
        });
    }

    const acc = createAccumulator();
    acc.ingestPayload(payload);
    const turn = acc.getSnapshot();
    if (turn.blockedReason && !turn.text && turn.toolCalls.length === 0 && turn.images.length === 0) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'candidates[0].finishReason',
            message: `Gemini candidate content empty (finishReason=${turn.blockedReason}).`,
            providerError: { message: `Gemini candidate content empty (finishReason=${turn.blockedReason}).`, code: turn.blockedReason },
            rawDiagnostic: payload,
        });
    }
    return turn;
}

/**
 * Create a strict incremental Gemini streamGenerateContent SSE parser.
 */
export function createGeminiStreamParser() {
    const acc = createAccumulator();
    let frameIndex = 0;
    let sawFrames = false;
    let sawTerminalSignal = false;
    let sawAnyCandidate = false;
    let promptBlockReason = '';
    let lastBlockedPayload = null;

    function feedFrame(rawData, eventName = '') {
        const location = `frame[${frameIndex}]${eventName ? `(${eventName})` : ''}`;
        frameIndex += 1;

        if (rawData === '[DONE]') {
            sawTerminalSignal = true;
            return { textDelta: '', reasoningDelta: '', refusalDelta: '', imagesDelta: [], logprobsPayload: null, hasMetadataUpdate: false };
        }

        const parsed = parseSseJsonFrame(rawData, { protocol: PROTOCOL, location, label: 'Gemini' });

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

        if (!Array.isArray(parsed.candidates) && !parsed.usageMetadata && !parsed.promptFeedback) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'protocol_mismatch',
                location,
                message: `Gemini SSE ${location} is missing candidates[], usageMetadata, and promptFeedback.`,
                rawDiagnostic: parsed,
            });
        }

        sawFrames = true;
        if (Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
            sawAnyCandidate = true;
        }
        if (parsed.promptFeedback?.blockReason) {
            promptBlockReason = String(parsed.promptFeedback.blockReason);
            lastBlockedPayload = parsed;
        }
        const delta = acc.ingestPayload(parsed);
        const rawFinish = parsed.candidates?.[0]?.finishReason ? String(parsed.candidates[0].finishReason).toUpperCase() : '';
        if (rawFinish === 'BLOCKLIST' || rawFinish === 'SPII') {
            lastBlockedPayload = parsed;
        }
        if (parsed.candidates?.[0]?.finishReason || parsed.promptFeedback?.blockReason) {
            sawTerminalSignal = true;
        }
        return {
            textDelta: delta.textDelta,
            reasoningDelta: delta.reasoningDelta,
            refusalDelta: '',
            imagesDelta: delta.imagesDelta,
            logprobsPayload: null,
            hasMetadataUpdate: delta.hasMetadataUpdate,
        };
    }

    function finish() {
        if (sawFrames && !sawTerminalSignal) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'eof',
                location: 'eof',
                message: 'Gemini SSE stream ended prematurely without finishReason or promptFeedback.',
            });
        }
        const turn = acc.getSnapshot();
        if (!sawAnyCandidate && promptBlockReason) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'provider_error',
                location: 'promptFeedback.blockReason',
                message: `Gemini API returned no candidate (blocked by ${promptBlockReason}).`,
                providerError: { message: `Gemini API returned no candidate (blocked by ${promptBlockReason}).`, code: promptBlockReason },
                rawDiagnostic: lastBlockedPayload,
            });
        }
        if (turn.blockedReason && !turn.text && turn.toolCalls.length === 0 && turn.images.length === 0) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'provider_error',
                location: 'candidates[0].finishReason',
                message: `Gemini candidate content empty (finishReason=${turn.blockedReason}).`,
                providerError: { message: `Gemini candidate content empty (finishReason=${turn.blockedReason}).`, code: turn.blockedReason },
                rawDiagnostic: lastBlockedPayload,
            });
        }
        return turn;
    }

    return { feedFrame, finish, getSnapshot: acc.getSnapshot };
}
