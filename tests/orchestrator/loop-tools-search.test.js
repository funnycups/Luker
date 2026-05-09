/**
 * loop-tools/search tests — bridges the loop agent to the search-tools
 * plugin's exposed `globalThis.Luker.searchTools` API.
 *
 * Wiring:
 *   - Production: search-tools plugin installs `Luker.searchTools` at
 *     init; loop-runtime resolves it onto the tool context as
 *     `__searchAdapter`. (Search exec also falls back to the global if
 *     no per-context adapter is provided.)
 *   - Tests: inject `context.__searchAdapter` directly with a fake
 *     exposing `search(args, opts)` / `visit(args, opts)` /
 *     `getSettings()`.
 *
 * Constraints:
 *   - Empty / whitespace-only query → ToolError(SEARCH_QUERY_EMPTY)
 *   - Missing or empty url → ToolError(SEARCH_URL_INVALID)
 *   - Adapter not present at all → ToolError(SEARCH_UNAVAILABLE)
 *   - Adapter present but plugin disabled in settings →
 *     ToolError(SEARCH_DISABLED)
 *   - sanitizeLoopProfile recognizes `tools.search.{search, visit}` and
 *     defaults both to true (loop profile defaults the namespace on; the
 *     search-tools plugin's own enable flag still gates execution at
 *     runtime, and the loop tool surfaces SEARCH_DISABLED / SEARCH_UNAVAILABLE
 *     as structured errors so the agent self-corrects).
 */

import { describe, test, expect } from '@jest/globals';

import {
    execSearchSearch,
    execSearchVisit,
} from '../../public/scripts/extensions/orchestrator/loop-tools/search.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';
import { sanitizeLoopProfile } from '../../public/scripts/extensions/orchestrator/persistence.js';

function makeFakeSearchAdapter({ enabled = true, searchImpl = null, visitImpl = null } = {}) {
    const calls = { search: [], visit: [] };
    return {
        calls,
        toolNames: { SEARCH: 'luker_web_search', VISIT: 'luker_web_visit' },
        getSettings: () => ({ enabled }),
        search: async (args, opts) => {
            calls.search.push({ args, opts });
            if (typeof searchImpl === 'function') return await searchImpl(args, opts);
            return { results: [{ title: 'r1', url: 'https://example.com', snippet: 's1' }] };
        },
        visit: async (args, opts) => {
            calls.visit.push({ args, opts });
            if (typeof visitImpl === 'function') return await visitImpl(args, opts);
            return { url: args?.url, content: 'visited page text' };
        },
    };
}

describe('execSearchSearch', () => {
    test('forwards args to adapter.search and returns its result', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        const result = await execSearchSearch(
            { query: 'capybara facts', max_results: 5 },
            ctx,
        );
        expect(adapter.calls.search).toHaveLength(1);
        expect(adapter.calls.search[0].args).toEqual({ query: 'capybara facts', max_results: 5 });
        expect(result).toEqual({ results: [{ title: 'r1', url: 'https://example.com', snippet: 's1' }] });
    });

    test('rejects empty query', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        await expect(execSearchSearch({ query: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execSearchSearch({ query: '' }, ctx)).rejects.toThrow(/non-empty/i);
    });

    test('rejects whitespace-only query', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        await expect(execSearchSearch({ query: '   \t  ' }, ctx)).rejects.toThrow(/non-empty/i);
    });

    test('rejects when no adapter is available (no global, no injection)', async () => {
        const ctx = {}; // no __searchAdapter, no globalThis.Luker.searchTools
        try {
            await execSearchSearch({ query: 'hello' }, ctx);
            throw new Error('expected ToolError');
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect(e.code).toBe('SEARCH_UNAVAILABLE');
        }
    });

    test('rejects when adapter is present but plugin is disabled', async () => {
        const adapter = makeFakeSearchAdapter({ enabled: false });
        const ctx = { __searchAdapter: adapter };
        try {
            await execSearchSearch({ query: 'hello' }, ctx);
            throw new Error('expected ToolError');
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect(e.code).toBe('SEARCH_DISABLED');
        }
    });

    test('wraps unexpected adapter errors as SEARCH_FAILED', async () => {
        const adapter = makeFakeSearchAdapter({
            searchImpl: async () => { throw new Error('network blew up'); },
        });
        const ctx = { __searchAdapter: adapter };
        try {
            await execSearchSearch({ query: 'hello' }, ctx);
            throw new Error('expected ToolError');
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect(e.code).toBe('SEARCH_FAILED');
            expect(e.message).toMatch(/network blew up/);
        }
    });
});

describe('execSearchVisit', () => {
    test('forwards args to adapter.visit and returns its result', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        const result = await execSearchVisit(
            { url: 'https://example.com/page', max_chars: 1000 },
            ctx,
        );
        expect(adapter.calls.visit).toHaveLength(1);
        expect(adapter.calls.visit[0].args).toEqual({ url: 'https://example.com/page', max_chars: 1000 });
        expect(result).toEqual({ url: 'https://example.com/page', content: 'visited page text' });
    });

    test('rejects empty url', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        await expect(execSearchVisit({ url: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execSearchVisit({ url: '' }, ctx)).rejects.toThrow(/url/i);
    });

    test('rejects missing url field', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        await expect(execSearchVisit({}, ctx)).rejects.toThrow(/url/i);
    });

    test('rejects when no adapter is available', async () => {
        const ctx = {};
        try {
            await execSearchVisit({ url: 'https://example.com' }, ctx);
            throw new Error('expected ToolError');
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect(e.code).toBe('SEARCH_UNAVAILABLE');
        }
    });

    test('rejects when adapter is disabled', async () => {
        const adapter = makeFakeSearchAdapter({ enabled: false });
        const ctx = { __searchAdapter: adapter };
        try {
            await execSearchVisit({ url: 'https://example.com' }, ctx);
            throw new Error('expected ToolError');
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect(e.code).toBe('SEARCH_DISABLED');
        }
    });
});

describe('central dispatcher routes search.* tools', () => {
    test('executeLoopTool dispatches search.search', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        const r = await executeLoopTool('search.search', { query: 'routed' }, ctx);
        expect(adapter.calls.search).toHaveLength(1);
        expect(r.results).toBeDefined();
    });

    test('executeLoopTool dispatches search.visit', async () => {
        const adapter = makeFakeSearchAdapter();
        const ctx = { __searchAdapter: adapter };
        const r = await executeLoopTool('search.visit', { url: 'https://example.com' }, ctx);
        expect(adapter.calls.visit).toHaveLength(1);
        expect(r.content).toBeDefined();
    });

    test('getEnabledToolSchemas includes search.* when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { add: false, delete: false },
                search: { search: true, visit: true },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toContain('search.search');
        expect(names).toContain('search.visit');
    });

    test('getEnabledToolSchemas omits search.* when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                search: { search: false, visit: false },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('search.search');
        expect(names).not.toContain('search.visit');
    });
});

describe('sanitizeLoopProfile recognizes the search namespace', () => {
    test('round-trips tools.search.{search, visit} when explicitly set', () => {
        const out = sanitizeLoopProfile({
            tools: {
                search: { search: true, visit: true },
            },
        });
        expect(out.tools.search).toEqual({ search: true, visit: true });
    });

    test('defaults tools.search.{search, visit} to TRUE for absent input', () => {
        const out = sanitizeLoopProfile({});
        expect(out.tools.search).toEqual({ search: true, visit: true });
    });

    test('readBooleanFlag semantics: only explicit false disables', () => {
        const out = sanitizeLoopProfile({
            tools: { search: { search: false, visit: true } },
        });
        expect(out.tools.search).toEqual({ search: false, visit: true });
    });
});
