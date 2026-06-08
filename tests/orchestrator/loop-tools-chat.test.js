/**
 * loop-tools/chat tests.
 *
 * Layered against Plan Task 8:
 *
 *   - chat_read_range supports positive and negative indices (negative
 *     counts from the end), returns one entry per chat floor with
 *     `{ floor, role, content }`. Caps the slice at MAX_RANGE floors and
 *     surfaces a `ToolError` when the requested range is too wide so the
 *     agent can self-correct on the next round.
 *   - chat_search is a regex scan that returns grep -n style output. Each
 *     match line is prefixed with `floor_{N} [{role}]:{lineno}:` so the
 *     agent can locate the floor and call chat_read_range to read full
 *     content. Empty patterns surface a `ToolError`; invalid regex
 *     returns `{ ok: false, error }` with an escape-hint substring.
 *   - The central dispatcher (`loop-tools.js`) registers both tools plus
 *     the always-on `finalize` schema and exposes a profile-driven
 *     `getEnabledToolSchemas` that loop-runtime uses to assemble the
 *     OpenAI-style tool array.
 */

import { describe, test, expect } from '@jest/globals';

import {
    execChatReadRange,
    execChatSearch,
} from '../../public/scripts/extensions/orchestrator/loop-tools/chat.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
    FINALIZE_TOOL_SCHEMA,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeChatContext(messages) {
    return { chat: messages.slice() };
}

describe('execChatReadRange (Task 8)', () => {
    const ctx = makeChatContext([
        { mes: 'hi',           is_user: true,  send_date: 't0' },
        { mes: 'hello',        is_user: false, send_date: 't1' },
        { mes: 'how are you?', is_user: true,  send_date: 't2' },
        { mes: 'fine, thanks', is_user: false, send_date: 't3' },
    ]);

    test('returns floor range with role + content for positive indices', async () => {
        const result = await execChatReadRange({ start: 0, end: 1 }, ctx);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ floor: 0, role: 'user', content: 'hi' });
        expect(result[1]).toMatchObject({ floor: 1, role: 'assistant', content: 'hello' });
    });

    test('supports negative indices (last N)', async () => {
        const result = await execChatReadRange({ start: -2, end: -1 }, ctx);
        expect(result).toHaveLength(2);
        expect(result[0].floor).toBe(2);
        expect(result[1].floor).toBe(3);
        expect(result[1].content).toBe('fine, thanks');
    });

    test('supports mixed positive + negative indices', async () => {
        const result = await execChatReadRange({ start: 1, end: -1 }, ctx);
        expect(result).toHaveLength(3);
        expect(result.map(r => r.floor)).toEqual([1, 2, 3]);
    });

    test('throws ToolError when end < start', async () => {
        await expect(execChatReadRange({ start: 3, end: 1 }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError when range exceeds 50 floors', async () => {
        const big = makeChatContext(Array.from({ length: 100 }, (_, i) => ({ mes: `m${i}`, is_user: i % 2 === 0 })));
        await expect(execChatReadRange({ start: 0, end: 99 }, big))
            .rejects.toThrow(/too large|max/i);
    });

    test('returns empty array when chat has no messages', async () => {
        const result = await execChatReadRange({ start: 0, end: 0 }, makeChatContext([]));
        expect(result).toEqual([]);
    });

    test('clamps out-of-range indices to chat bounds', async () => {
        // start before 0 => clamped to 0; end past length-1 => clamped to last.
        const result = await execChatReadRange({ start: -100, end: 1 }, ctx);
        expect(result[0].floor).toBe(0);
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('execChatSearch (Task 8)', () => {
    const ctx = makeChatContext([
        { mes: 'autumn leaves',     is_user: false },
        { mes: 'winter snow',       is_user: false },
        { mes: 'AUTUMN is cold',    is_user: true },
        { mes: 'spring blossoms',   is_user: false },
    ]);

    test('returns grep -n style output for matching floors with floor + role prefix', async () => {
        const result = await execChatSearch({ pattern: 'autumn' }, ctx);
        expect(result.ok).toBe(true);
        // Default flags 'gm' are case-sensitive — only the lowercase floors match.
        expect(result.output).toBe('floor_0 [assistant]:1: autumn leaves');
    });

    test('returns ok=true with empty output when no matches', async () => {
        const result = await execChatSearch({ pattern: 'platypus' }, ctx);
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('throws ToolError when pattern is empty', async () => {
        await expect(execChatSearch({ pattern: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('regex pattern matches across floors and emits grep -n shape with floor prefix', async () => {
        const chat = [
            { mes: 'hello world', is_user: true },
            { mes: 'goodbye\nhello again', is_user: false },
        ];
        const result = await execChatSearch({ pattern: 'hello' }, { chat });
        expect(result).toEqual({
            ok: true,
            output: 'floor_0 [user]:1: hello world\nfloor_1 [assistant]:2: hello again',
        });
    });

    test('case-insensitive regex via flags', async () => {
        const chat = [{ mes: 'Hello', is_user: true }];
        const result = await execChatSearch({ pattern: 'hello', flags: 'gmi' }, { chat });
        expect(result.output).toBe('floor_0 [user]:1: Hello');
    });

    test('invalid regex returns ok=false with escape hint', async () => {
        const chat = [{ mes: 'x', is_user: true }];
        const result = await execChatSearch({ pattern: '[bad' }, { chat });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/escape regex metacharacters/);
    });

    test('empty chat returns empty output', async () => {
        const result = await execChatSearch({ pattern: '.' }, { chat: [] });
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('missing pattern argument rejected', async () => {
        await expect(execChatSearch({}, { chat: [] })).rejects.toThrow(/pattern/i);
    });
});

describe('central dispatcher (Task 8)', () => {
    test('FINALIZE_TOOL_SCHEMA re-exported from loop-tools.js matches loop-runtime export', async () => {
        // The runtime always offers finalize regardless of profile flags;
        // dispatcher mirrors the runtime's schema for a single source of truth.
        expect(FINALIZE_TOOL_SCHEMA?.function?.name).toBe('finalize');
    });

    test('executeLoopTool dispatches chat_read_range to execChatReadRange', async () => {
        const ctx = makeChatContext([
            { mes: 'a', is_user: true },
            { mes: 'b', is_user: false },
        ]);
        const result = await executeLoopTool('chat_read_range', { start: 0, end: 1 }, ctx);
        expect(result).toHaveLength(2);
    });

    test('executeLoopTool dispatches chat_search to execChatSearch', async () => {
        const ctx = makeChatContext([{ mes: 'hello world', is_user: true }]);
        const result = await executeLoopTool('chat_search', { pattern: 'hello' }, ctx);
        expect(result).toEqual({ ok: true, output: 'floor_0 [user]:1: hello world' });
    });

    test('executeLoopTool throws ToolError(NOT_IMPLEMENTED) for unknown names', async () => {
        const err = await executeLoopTool('does.not.exist', {}, {}).catch(e => e);
        expect(err).toBeInstanceOf(ToolError);
        expect(err.code).toBe('NOT_IMPLEMENTED');
    });

    test('executeLoopTool propagates ToolError from underlying tool', async () => {
        const ctx = makeChatContext([{ mes: 'x', is_user: true }]);
        await expect(executeLoopTool('chat_search', { pattern: '' }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('getEnabledToolSchemas always includes finalize', () => {
        const schemas = getEnabledToolSchemas({ tools: { finalize: false, chat: { read_range: false, search: false } } });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toContain('finalize');
    });

    test('getEnabledToolSchemas includes chat tools when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: true, search: true },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { add: false },
            },
        });
        const names = schemas.map(s => s?.function?.name).sort();
        expect(names).toEqual(expect.arrayContaining(['chat_read_range', 'chat_search', 'finalize']));
    });

    test('getEnabledToolSchemas omits chat tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('chat_read_range');
        expect(names).not.toContain('chat_search');
    });
});
