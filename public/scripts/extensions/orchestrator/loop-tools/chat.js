/**
 * loop-tools/chat.js — chat-based tool implementations for loop mode.
 *
 * Two tools cover the "look at recent context" and "search the whole
 * conversation" use cases without leaking SillyTavern internals into the
 * agent's prompt:
 *
 *   - chat.read_range({ start, end }) returns a contiguous slice of
 *     `context.chat` floors normalized to `{ floor, role, content }`.
 *     Negative indices count from the end (Pythonic). The slice is hard
 *     capped at MAX_RANGE floors so a hallucinated `end: 9999` cannot
 *     blow up token budget; over-wide ranges raise a structured
 *     `ToolError(CHAT_RANGE_TOO_LARGE)` so the agent reads the failure
 *     and retries with a saner window.
 *   - chat.search({ query, limit }) is a case-insensitive substring scan
 *     over `mes` text. Results carry `content_preview` truncated to
 *     PREVIEW_LEN to keep the tool result small. Empty queries are
 *     rejected — without that guard `''.includes('')` matches every
 *     floor and wastes the round.
 *
 * Both tools are pure functions of `(args, context)` and never write back
 * to the chat array; they exist purely to shape input for the agent.
 */

import { ToolError } from '../loop-runtime.js';

const PREVIEW_LEN = 300;
const MAX_RANGE = 50;

function preview(text) {
    const s = String(text || '');
    return s.length <= PREVIEW_LEN ? s : s.slice(0, PREVIEW_LEN);
}

/**
 * Resolve a (potentially negative) chat index against `len` chat floors.
 * Negative values count from the end like Python slicing; out-of-range
 * values are clamped to `[0, len-1]`. Returns -1 when `len === 0`.
 */
function resolveIndex(idx, len) {
    if (!Number.isFinite(len) || len <= 0) return -1;
    let n = Math.trunc(Number(idx));
    if (!Number.isFinite(n)) n = 0;
    if (n < 0) n = len + n;
    if (n < 0) n = 0;
    if (n > len - 1) n = len - 1;
    return n;
}

function roleFromMessage(message) {
    if (message?.is_user) return 'user';
    if (message?.is_system) return 'system';
    return 'assistant';
}

/**
 * Read a contiguous range of chat floors. Negative indices count from the
 * end. Range size is capped at MAX_RANGE; oversize requests raise
 * `ToolError(CHAT_RANGE_TOO_LARGE)` so the agent self-corrects.
 *
 * @param {{ start: number, end: number }} args
 * @param {object} context — must expose `context.chat` array
 * @returns {Promise<Array<{floor: number, role: string, content: string}>>}
 */
export async function execChatReadRange(args, context) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (chat.length === 0) return [];

    const start = resolveIndex(args?.start, chat.length);
    const end = resolveIndex(args?.end, chat.length);
    if (start < 0 || end < 0) return [];
    if (end < start) {
        throw new ToolError(
            `chat.read_range: end (${end}) must be >= start (${start}).`,
            'CHAT_RANGE_INVALID',
            'Pass start <= end. Negative indices count from the end of the chat.',
        );
    }
    const span = end - start + 1;
    if (span > MAX_RANGE) {
        throw new ToolError(
            `chat.read_range: range too large (${span} floors), max ${MAX_RANGE}.`,
            'CHAT_RANGE_TOO_LARGE',
            `Reduce the range so end - start + 1 <= ${MAX_RANGE}. Use chat.search to locate specific floors first.`,
        );
    }

    const out = [];
    for (let i = start; i <= end; i += 1) {
        const message = chat[i];
        out.push({
            floor: i,
            role: roleFromMessage(message),
            content: String(message?.mes || ''),
        });
    }
    return out;
}

/**
 * Substring search across all chat floors. Case-insensitive. Returns up
 * to `limit` (default 10) results in floor-ascending order.
 *
 * @param {{ query: string, limit?: number }} args
 * @param {object} context — must expose `context.chat`
 * @returns {Promise<Array<{floor: number, role: string, content_preview: string}>>}
 */
export async function execChatSearch(args, context) {
    const queryRaw = String(args?.query ?? '');
    if (!queryRaw.trim()) {
        throw new ToolError(
            'chat.search: query must be non-empty.',
            'CHAT_QUERY_EMPTY',
            'Provide a non-empty query string. Use whole words for best results.',
        );
    }
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args?.limit) || 10)));
    const q = queryRaw.toLowerCase();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const out = [];
    for (let i = 0; i < chat.length; i += 1) {
        const text = String(chat[i]?.mes || '');
        if (!text.toLowerCase().includes(q)) continue;
        out.push({
            floor: i,
            role: roleFromMessage(chat[i]),
            content_preview: preview(text),
        });
        if (out.length >= limit) break;
    }
    return out;
}
