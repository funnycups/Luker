/**
 * loop-tools/chat.js — chat-based tool implementations for loop mode.
 *
 * Two tools cover the "look at recent context" and "search the whole
 * conversation" use cases without leaking SillyTavern internals into the
 * agent's prompt:
 *
 *   - chat_read_range({ start, end }) returns a contiguous slice of
 *     `context.chat` floors normalized to `{ floor, role, content }`.
 *     Negative indices count from the end (Pythonic). The slice is hard
 *     capped at MAX_RANGE floors so a hallucinated `end: 9999` cannot
 *     blow up token budget; over-wide ranges raise a structured
 *     `ToolError(CHAT_RANGE_TOO_LARGE)` so the agent reads the failure
 *     and retries with a saner window.
 *   - chat_search({ pattern, flags }) is a regex scan over `mes` text.
 *     Results are emitted in grep -n shape: one matched line per result
 *     as `floor_{N} [{role}]:{lineno}: {line_content}`. Empty patterns
 *     raise `ToolError(CHAT_PATTERN_EMPTY)`; invalid regex is returned
 *     as `{ ok: false, error }` with an escape hint so the agent can
 *     self-correct on the next round.
 *
 * Both tools are pure functions of `(args, context)` and never write back
 * to the chat array; they exist purely to shape input for the agent.
 */

import { ToolError } from '../loop-runtime.js';
import { gatherGrepMatches } from '../grep-tool.js';

const MAX_RANGE = 50;

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
            `chat_read_range: end (${end}) must be >= start (${start}).`,
            'CHAT_RANGE_INVALID',
            'Pass start <= end. Negative indices count from the end of the chat.',
        );
    }
    const span = end - start + 1;
    if (span > MAX_RANGE) {
        throw new ToolError(
            `chat_read_range: range too large (${span} floors), max ${MAX_RANGE}.`,
            'CHAT_RANGE_TOO_LARGE',
            `Reduce the range so end - start + 1 <= ${MAX_RANGE}. Use chat_search to locate specific floors first.`,
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
 * Regex search across all chat floors. Emits grep -n style output with a
 * "floor_{N} [{role}]" prefix on each match line.
 *
 * @param {{ pattern: string, flags?: string }} args
 * @param {object} context — must expose `context.chat`
 * @returns {Promise<{ok: true, output: string} | {ok: false, error: string}>}
 */
export async function execChatSearch(args, context) {
    const pattern = String(args?.pattern ?? '');
    if (!pattern) {
        throw new ToolError(
            'chat_search: pattern must be non-empty.',
            'CHAT_PATTERN_EMPTY',
            'Provide a non-empty regex pattern. To match literal text, escape regex metacharacters.',
        );
    }
    const flags = typeof args?.flags === 'string' && args.flags.length > 0 ? args.flags : 'gm';
    const chat = Array.isArray(context?.chat) ? context.chat : [];

    function* corpus() {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            yield {
                prefix: `floor_${i} [${roleFromMessage(msg)}]`,
                content: String(msg?.mes || ''),
            };
        }
    }

    return gatherGrepMatches(corpus(), pattern, flags);
}
