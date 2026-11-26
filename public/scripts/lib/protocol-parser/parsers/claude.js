// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError, extractProviderErrorMessage } from '../errors.js';
import {
    WIRE_PROTOCOLS,
    mergeNormalizedUsage,
    normalizeClaudeUsage,
    normalizeFinishReason,
} from '../protocol.js';
import { cloneValue, parseSseJsonFrame } from './common.js';

const PROTOCOL = WIRE_PROTOCOLS.CLAUDE;

const CLAUDE_TOOL_BLOCK_TYPES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);

const CLAUDE_STREAM_EVENTS = new Set([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
    'ping',
    'error',
]);

function assertNotForeignPayload(payload, location) {
    if (Array.isArray(payload.choices)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Anthropic Messages payload, received OpenAI Chat choices shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.candidates) || payload.promptFeedback) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Anthropic Messages payload, received Gemini candidates shape.',
            rawDiagnostic: payload,
        });
    }
    if (Array.isArray(payload.output) || payload.object === 'response' || (typeof payload.type === 'string' && payload.type.startsWith('response.'))) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Anthropic Messages payload, received OpenAI Responses shape.',
            rawDiagnostic: payload,
        });
    }
    if (payload.message && typeof payload.message === 'object' && payload.type !== 'message_start') {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location,
            message: 'Expected Anthropic Messages payload, received Cohere message shape.',
            rawDiagnostic: payload,
        });
    }
}

function buildParsedTurnFromBlocks({
    nativeContentBlocks,
    usage,
    nativeFinishReason,
    stopSequence,
    stopDetails,
}) {
    let text = '';
    let reasoning = '';
    const reasoningBlocks = [];
    const toolCalls = [];
    const citations = [];
    const parts = [];

    for (const block of nativeContentBlocks) {
        if (!block || typeof block !== 'object') continue;
        const type = String(block.type || '');
        if (type === 'text') {
            const blockText = String(block.text || '');
            text += blockText;
            if (Array.isArray(block.citations) && block.citations.length > 0) {
                citations.push(...block.citations.map(cloneValue));
            }
            if (blockText) {
                parts.push({
                    type: 'text',
                    text: blockText,
                    ...(Array.isArray(block.citations) && block.citations.length > 0 ? { citations: block.citations.map(cloneValue) } : {}),
                });
            }
        } else if (type === 'thinking') {
            const thinkingText = String(block.thinking || '');
            reasoning += thinkingText;
            const preserved = { type: 'thinking', thinking: thinkingText };
            if (typeof block.signature === 'string' && block.signature.length > 0) {
                preserved.signature = block.signature;
            }
            reasoningBlocks.push(preserved);
            parts.push({
                type: 'reasoning',
                kind: 'thinking',
                text: thinkingText,
                signature: typeof block.signature === 'string' ? block.signature : '',
            });
        } else if (type === 'redacted_thinking') {
            const data = String(block.data || '');
            reasoningBlocks.push({ type: 'redacted_thinking', data });
            parts.push({
                type: 'reasoning',
                kind: 'redacted_thinking',
                data,
            });
        } else if (type === 'tool_use') {
            const id = String(block.id || '');
            const name = String(block.name || '');
            const inputObj = block.input && typeof block.input === 'object' ? block.input : {};
            toolCalls.push({
                id,
                type: 'function',
                function: {
                    name,
                    arguments: JSON.stringify(inputObj),
                },
            });
            parts.push({
                type: 'tool_call',
                id,
                name,
                args: cloneValue(inputObj),
            });
        }
    }

    const finishReason = normalizeFinishReason(PROTOCOL, nativeFinishReason) ?? (toolCalls.length > 0 ? 'tool_calls' : null);

    return {
        protocol: PROTOCOL,
        text,
        swipes: [],
        reasoning,
        signature: null,
        reasoningBlocks: reasoningBlocks.length > 0 ? reasoningBlocks : null,
        reasoningDetails: null,
        nativeParts: null,
        nativeContentBlocks: nativeContentBlocks.length > 0 ? nativeContentBlocks.map(cloneValue) : null,
        responsesOutputItems: null,
        toolCalls,
        images: [],
        citations: citations.length > 0 ? citations : null,
        refusal: null,
        parts,
        usage: usage ?? null,
        finishReason,
        nativeFinishReason: nativeFinishReason || null,
        stopSequence: stopSequence || null,
        stopDetails: stopDetails ? cloneValue(stopDetails) : null,
        blockedReason: null,
    };
}

/**
 * Parse a non-streaming Anthropic Messages API response payload strictly.
 * @param {*} payload
 */
export function parseClaudeResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'payload',
            location: 'root',
            message: 'Expected Anthropic Messages JSON object response.',
            rawDiagnostic: payload,
        });
    }
    if (payload.error != null || payload.type === 'error') {
        const providerError = payload.error ?? payload;
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'provider_error',
            location: 'error',
            message: extractProviderErrorMessage(providerError),
            providerError,
            rawDiagnostic: payload,
        });
    }
    assertNotForeignPayload(payload, 'root');
    if (!Array.isArray(payload.content)) {
        throw new ProtocolParseError({
            protocol: PROTOCOL,
            stage: 'protocol_mismatch',
            location: 'content',
            message: 'Anthropic Messages response is missing a content[] array.',
            rawDiagnostic: payload,
        });
    }

    return buildParsedTurnFromBlocks({
        nativeContentBlocks: payload.content,
        usage: normalizeClaudeUsage(payload.usage),
        nativeFinishReason: typeof payload.stop_reason === 'string' && payload.stop_reason ? payload.stop_reason : null,
        stopSequence: typeof payload.stop_sequence === 'string' && payload.stop_sequence ? payload.stop_sequence : null,
        stopDetails: payload.stop_details && typeof payload.stop_details === 'object' ? payload.stop_details : null,
    });
}

/**
 * Create a strict incremental Anthropic Messages SSE parser.
 */
export function createClaudeStreamParser() {
    /** @type {Map<number, { block: object, inputJsonBuffer: string, hasInputJson: boolean, closed: boolean }>} */
    const blockSlots = new Map();
    /** @type {number[]} */
    const blockOrder = [];
    let usage = null;
    let nativeFinishReason = null;
    let stopSequence = null;
    let stopDetails = null;
    let frameIndex = 0;
    let sawFrames = false;
    let sawMessageStop = false;

    function orderedBlocks() {
        const out = [];
        for (const idx of blockOrder) {
            const slot = blockSlots.get(idx);
            if (!slot) continue;
            // Never expose unclosed tool blocks in snapshots (abort / premature
            // EOF / mid-stream error) so incomplete tool_use inputs are never
            // fabricated as executable `{}` arguments.
            if (CLAUDE_TOOL_BLOCK_TYPES.has(slot.block.type) && !slot.closed) {
                continue;
            }
            out.push(slot.block);
        }
        return out;
    }

    function getSnapshot() {
        return buildParsedTurnFromBlocks({
            nativeContentBlocks: orderedBlocks(),
            usage,
            nativeFinishReason,
            stopSequence,
            stopDetails,
        });
    }

    function feedFrame(rawData, eventName = '') {
        const location = `frame[${frameIndex}]${eventName ? `(${eventName})` : ''}`;
        frameIndex += 1;

        if (rawData === '[DONE]') {
            return { textDelta: '', reasoningDelta: '', refusalDelta: '', imagesDelta: [], logprobsPayload: null, hasMetadataUpdate: false };
        }

        const parsed = parseSseJsonFrame(rawData, { protocol: PROTOCOL, location, label: 'Anthropic' });

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

        const type = typeof parsed.type === 'string' ? parsed.type : '';
        if (!CLAUDE_STREAM_EVENTS.has(type)) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'protocol_mismatch',
                location,
                message: `Unrecognized Anthropic SSE event type "${type || '(missing)'}" at ${location}.`,
                rawDiagnostic: parsed,
            });
        }

        sawFrames = true;
        let textDelta = '';
        let reasoningDelta = '';
        let hasMetadataUpdate = false;

        if (type === 'message_start') {
            const msgUsage = normalizeClaudeUsage(parsed.message?.usage);
            if (msgUsage) {
                usage = mergeNormalizedUsage(usage, msgUsage);
                hasMetadataUpdate = true;
            }
            if (typeof parsed.message?.stop_reason === 'string' && parsed.message.stop_reason) {
                nativeFinishReason = parsed.message.stop_reason;
                hasMetadataUpdate = true;
            }
        } else if (type === 'content_block_start') {
            const idx = Number.isInteger(parsed.index) ? parsed.index : null;
            if (idx === null || !parsed.content_block || typeof parsed.content_block !== 'object') {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'payload',
                    location,
                    message: `Anthropic content_block_start at ${location} requires integer index and content_block object.`,
                    rawDiagnostic: parsed,
                });
            }
            const cb = parsed.content_block;
            let block;
            if (cb.type === 'thinking') {
                block = { type: 'thinking', thinking: String(cb.thinking || '') };
                if (typeof cb.signature === 'string' && cb.signature.length > 0) block.signature = cb.signature;
                if (block.thinking) reasoningDelta += block.thinking;
            } else if (cb.type === 'redacted_thinking') {
                block = { type: 'redacted_thinking', data: String(cb.data || '') };
            } else if (cb.type === 'text') {
                block = { type: 'text', text: String(cb.text || '') };
                if (Array.isArray(cb.citations) && cb.citations.length > 0) {
                    block.citations = cb.citations.map(cloneValue);
                }
                if (block.text) textDelta += block.text;
            } else if (CLAUDE_TOOL_BLOCK_TYPES.has(cb.type)) {
                block = {
                    ...cloneValue(cb),
                    input: cb.input && typeof cb.input === 'object' ? cloneValue(cb.input) : {},
                };
            } else {
                block = cloneValue(cb);
            }
            if (!blockSlots.has(idx)) {
                blockOrder.push(idx);
            }
            blockSlots.set(idx, {
                block,
                inputJsonBuffer: '',
                hasInputJson: false,
                closed: !CLAUDE_TOOL_BLOCK_TYPES.has(block.type),
            });
            hasMetadataUpdate = true;
        } else if (type === 'content_block_delta') {
            const idx = Number.isInteger(parsed.index) ? parsed.index : null;
            if (idx === null || !parsed.delta || typeof parsed.delta !== 'object') {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'payload',
                    location,
                    message: `Anthropic content_block_delta at ${location} requires integer index and delta object.`,
                    rawDiagnostic: parsed,
                });
            }
            let slot = blockSlots.get(idx);
            const d = parsed.delta;
            if (!slot) {
                // Proxies occasionally omit `content_block_start` for plain
                // text or thinking deltas; auto-vivify those slots while
                // keeping strict tool_correlation enforcement on tool inputs.
                if (d.type === 'text_delta' || d.type === 'citations_delta') {
                    slot = { block: { type: 'text', text: '' }, inputJsonBuffer: '', hasInputJson: false, closed: true };
                    blockOrder.push(idx);
                    blockSlots.set(idx, slot);
                } else if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
                    slot = { block: { type: 'thinking', thinking: '' }, inputJsonBuffer: '', hasInputJson: false, closed: true };
                    blockOrder.push(idx);
                    blockSlots.set(idx, slot);
                } else {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'tool_correlation',
                        location,
                        message: `Anthropic content_block_delta referenced unstarted content block index ${idx} at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
            }
            if (d.type === 'text_delta' && typeof d.text === 'string') {
                if (slot.block.type !== 'text') {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'payload',
                        location,
                        message: `Received text_delta for block ${idx} of type "${slot.block.type}" at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
                slot.block.text += d.text;
                textDelta += d.text;
            } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
                if (slot.block.type !== 'thinking') {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'payload',
                        location,
                        message: `Received thinking_delta for block ${idx} of type "${slot.block.type}" at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
                slot.block.thinking += d.thinking;
                reasoningDelta += d.thinking;
            } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
                if (slot.block.type !== 'thinking') {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'payload',
                        location,
                        message: `Received signature_delta for block ${idx} of type "${slot.block.type}" at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
                slot.block.signature = (slot.block.signature || '') + d.signature;
                hasMetadataUpdate = true;
            } else if (d.type === 'citations_delta' && d.citation && typeof d.citation === 'object') {
                if (!Array.isArray(slot.block.citations)) slot.block.citations = [];
                slot.block.citations.push(cloneValue(d.citation));
                hasMetadataUpdate = true;
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                if (!CLAUDE_TOOL_BLOCK_TYPES.has(slot.block.type)) {
                    throw new ProtocolParseError({
                        protocol: PROTOCOL,
                        stage: 'tool_correlation',
                        location,
                        message: `Received input_json_delta for non-tool block ${idx} ("${slot.block.type}") at ${location}.`,
                        rawDiagnostic: parsed,
                    });
                }
                slot.inputJsonBuffer += d.partial_json;
                slot.hasInputJson = true;
            }
        } else if (type === 'content_block_stop') {
            const idx = Number.isInteger(parsed.index) ? parsed.index : null;
            if (idx === null) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'payload',
                    location,
                    message: `Anthropic content_block_stop at ${location} requires integer index.`,
                    rawDiagnostic: parsed,
                });
            }
            const slot = blockSlots.get(idx);
            if (!slot) {
                throw new ProtocolParseError({
                    protocol: PROTOCOL,
                    stage: 'tool_correlation',
                    location,
                    message: `Anthropic content_block_stop referenced unstarted block index ${idx} at ${location}.`,
                    rawDiagnostic: parsed,
                });
            }
            if (CLAUDE_TOOL_BLOCK_TYPES.has(slot.block.type) && slot.hasInputJson) {
                const rawJson = slot.inputJsonBuffer.trim();
                if (rawJson.length > 0) {
                    try {
                        slot.block.input = JSON.parse(rawJson);
                    } catch (cause) {
                        throw new ProtocolParseError({
                            protocol: PROTOCOL,
                            stage: 'tool_correlation',
                            location,
                            message: `Malformed tool input JSON on Anthropic block ${idx} ("${slot.block.name || ''}"): ${cause.message}`,
                            cause,
                            rawDiagnostic: rawJson,
                        });
                    }
                }
                slot.inputJsonBuffer = '';
                slot.hasInputJson = false;
            }
            slot.closed = true;
            hasMetadataUpdate = true;
        } else if (type === 'message_delta') {
            const deltaUsage = normalizeClaudeUsage(parsed.usage);
            if (deltaUsage) usage = mergeNormalizedUsage(usage, deltaUsage);
            if (typeof parsed.delta?.stop_reason === 'string' && parsed.delta.stop_reason) {
                nativeFinishReason = parsed.delta.stop_reason;
            }
            if (typeof parsed.delta?.stop_sequence === 'string' && parsed.delta.stop_sequence) {
                stopSequence = parsed.delta.stop_sequence;
            }
            if (parsed.delta?.stop_details && typeof parsed.delta.stop_details === 'object') {
                stopDetails = parsed.delta.stop_details;
            }
            hasMetadataUpdate = true;
        } else if (type === 'message_stop') {
            sawMessageStop = true;
            hasMetadataUpdate = true;
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
        const isPrematureEof = sawFrames && !sawMessageStop;
        // Validate any unclosed tool block before throwing premature EOF:
        // - Complete valid buffered JSON is committed so proxies dropping only
        //   closing markers preserve full tool arguments.
        // - Truncated/malformed buffered JSON ALWAYS throws `tool_correlation`
        //   (never silently falling back to `{}`).
        // - Tool blocks without content_block_stop or complete JSON stay
        //   unclosed on premature EOF so snapshots never fabricate `{}` calls.
        for (const idx of blockOrder) {
            const slot = blockSlots.get(idx);
            if (!slot || !CLAUDE_TOOL_BLOCK_TYPES.has(slot.block.type) || slot.closed) {
                continue;
            }
            if (slot.hasInputJson) {
                const rawJson = slot.inputJsonBuffer.trim();
                if (rawJson.length > 0) {
                    try {
                        slot.block.input = JSON.parse(rawJson);
                        slot.closed = true;
                    } catch (cause) {
                        throw new ProtocolParseError({
                            protocol: PROTOCOL,
                            stage: 'tool_correlation',
                            location: `block[${idx}]`,
                            message: `Malformed tool input JSON on Anthropic block ${idx}: ${cause.message}`,
                            cause,
                            rawDiagnostic: rawJson,
                        });
                    }
                } else if (!isPrematureEof) {
                    slot.closed = true;
                }
                slot.inputJsonBuffer = '';
                slot.hasInputJson = false;
            } else if (!isPrematureEof) {
                slot.closed = true;
            }
        }
        if (isPrematureEof) {
            throw new ProtocolParseError({
                protocol: PROTOCOL,
                stage: 'eof',
                location: 'eof',
                message: 'Anthropic SSE stream ended prematurely before message_stop.',
            });
        }
        return getSnapshot();
    }

    return { feedFrame, finish, getSnapshot };
}
