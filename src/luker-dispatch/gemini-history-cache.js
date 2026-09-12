// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

const CACHE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ANCHORS = 256;

function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasBreakpoint(message) {
    return message.cache_control || (Array.isArray(message.content)
        && message.content.some(part => part?.cache_control));
}

function canMark(message) {
    if (!['user', 'assistant'].includes(message.role) || message.tool_calls?.length) return false;
    if (typeof message.content === 'string') return message.content.length > 0;
    const last = Array.isArray(message.content) ? message.content.at(-1) : null;
    return last?.type === 'text' && typeof last.text === 'string' && last.text.length > 0;
}

// Keep completed user turns plus the current input outside the cache. A tool
// call and its results stay together; system injections don't start a turn.
function findBoundary(messages, keepRecentTurns) {
    const starts = [];
    let previousRole;
    for (let i = 0; i < messages.length; i++) {
        if (['system', 'developer'].includes(messages[i].role)) continue;
        if (messages[i].role === 'user' && previousRole !== 'user') starts.push(i);
        previousRole = messages[i].role;
    }
    const tailStart = starts.at(-(keepRecentTurns + 1));
    if (tailStart === undefined) return -1;

    const pending = new Set();
    let boundary = -1;
    for (let i = 0; i < tailStart; i++) {
        const message = messages[i];
        for (const call of message.tool_calls ?? []) pending.add(call.id);
        if (message.role === 'tool') pending.delete(message.tool_call_id);
        if (!pending.size && canMark(message)) boundary = i;
    }
    return boundary;
}

/**
 * Plan a single OpenRouter Gemini breakpoint on an unchanged history prefix.
 * Only bounded hashes/indices live in memory, never prompts or credentials.
 * OpenRouter owns the actual cache and billing; an anchor is not a cache hit.
 */
export class GeminiHistoryCache {
    #anchors = new Map();

    /**
     * Mutates only cache metadata/content representation, preserving all text,
     * roles, tool calls and multimodal parts. Caller-supplied markers win.
     * @param {object} request Final OpenRouter request body
     * @param {object} options Cache scope and tail policy
     * @param {string} options.scope User and credential scope (hashed, not stored)
     * @param {string} [options.session] Local conversation identity
     * @param {number} [options.keepRecentTurns] Uncached completed turns, in addition to current input
     * @returns {{reason: string, messageIndex?: number}}
     */
    apply(request, { scope, session = '', keepRecentTurns = 2 }) {
        if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1) {
            throw new Error('Gemini history cache: keepRecentTurns must be a positive integer.');
        }
        const messages = request.messages;
        if (!Array.isArray(messages)) return { reason: 'no-history' };
        if (request.cache_control || messages.some(hasBreakpoint)) return { reason: 'external-breakpoint' };
        const candidate = findBoundary(messages, keepRecentTurns);
        if (candidate < 0) return { reason: 'no-history' };

        const systems = messages.filter(message => ['system', 'developer'].includes(message.role));
        const key = fingerprint([scope, request.model, session || [systems, messages.find(message => message.role === 'user')]]);
        // Include tools and every system injection, even after the breakpoint:
        // Gemini's cached systemInstruction/tool configuration is immutable.
        const context = {
            systems, tools: request.tools, tool_choice: request.tool_choice,
            response_format: request.response_format, provider: request.provider,
            transforms: request.transforms, plugins: request.plugins,
            safety_settings: request.safety_settings,
        };
        const prefixHash = index => fingerprint([context, messages.slice(0, index + 1)]);
        const now = Date.now();
        const previous = this.#anchors.get(key);
        const reusable = previous && now - previous.createdAt < CACHE_WINDOW_MS
            && previous.index <= candidate && canMark(messages[previous.index])
            && previous.hash === prefixHash(previous.index);
        const index = reusable ? previous.index : candidate;
        const reason = reusable ? 'reused' : previous ? 'refreshed' : 'created';
        const anchor = reusable ? previous : { index, hash: prefixHash(index), createdAt: now };

        for (const [entryKey, entry] of this.#anchors) {
            if (now - entry.createdAt >= CACHE_WINDOW_MS) this.#anchors.delete(entryKey);
        }
        this.#anchors.delete(key);
        this.#anchors.set(key, anchor);
        while (this.#anchors.size > MAX_ANCHORS) this.#anchors.delete(this.#anchors.keys().next().value);

        const message = messages[index];
        if (typeof message.content === 'string') {
            message.content = [{ type: 'text', text: message.content }];
        }
        message.content.at(-1).cache_control = { type: 'ephemeral' };
        return { reason, messageIndex: index };
    }
}
