// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError } from '../errors.js';

/**
 * Deep-clone plain JSON/protocol data structures safely.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneValue(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

/**
 * Coerce a wire tool-call arguments string or object into a structured object
 * when valid JSON, or return the raw string when unparseable.
 * @param {*} raw
 * @returns {*}
 */
export function coerceToolArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
}

/**
 * Parse a single SSE `data:` frame into a non-array JSON object or throw a
 * structured `ProtocolParseError`.
 * @param {string} rawData
 * @param {{ protocol: string, location: string, label: string }} options
 * @returns {Record<string, any>}
 */
export function parseSseJsonFrame(rawData, { protocol, location, label }) {
    let parsed;
    try {
        parsed = JSON.parse(rawData);
    } catch (cause) {
        throw new ProtocolParseError({
            protocol,
            stage: 'json',
            location,
            message: `Malformed JSON in ${label} SSE ${location}: ${cause.message}`,
            cause,
            rawDiagnostic: rawData,
        });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProtocolParseError({
            protocol,
            stage: 'payload',
            location,
            message: `Expected JSON object in ${label} SSE ${location}.`,
            rawDiagnostic: parsed,
        });
    }

    return parsed;
}

/**
 * Describe a recognizable foreign wire protocol shape when a payload lacks the
 * declared protocol's required structure, purely for actionable diagnostics.
 * Never call before checking whether the payload can be parsed as the declared
 * protocol.
 *
 * @param {*} payload
 * @param {string} currentProtocol
 * @returns {string|null}
 */
export function describeForeignPayloadShape(payload, currentProtocol) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (currentProtocol !== 'openai-chat' && Array.isArray(payload.choices)) {
        return 'OpenAI Chat choices shape';
    }
    if (currentProtocol !== 'gemini' && (Array.isArray(payload.candidates) || payload.promptFeedback)) {
        return 'Gemini candidates shape';
    }
    if (currentProtocol !== 'openai-responses'
        && (Array.isArray(payload.output) || payload.object === 'response' || (typeof payload.type === 'string' && payload.type.startsWith('response.')))) {
        return 'OpenAI Responses shape';
    }
    if (currentProtocol !== 'claude'
        && (Array.isArray(payload.content) || (typeof payload.type === 'string' && /^(message_|content_block_)/.test(payload.type)))) {
        return 'Anthropic Messages shape';
    }
    if (currentProtocol !== 'cohere'
        && ((payload.message && typeof payload.message === 'object')
            || (typeof payload.type === 'string' && /^(message-|content-|tool-call-|tool-plan-|citation-)/.test(payload.type)))) {
        return 'Cohere shape';
    }
    return null;
}
