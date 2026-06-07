import { describe, test, expect, beforeEach } from '@jest/globals';
import {
    registerSearchToolsOrchestrationTools,
    unregisterSearchToolsOrchestrationTools,
    SEARCH_TOOL_NAMES,
} from '../../public/scripts/extensions/search-tools/orchestrator-tools.js';
import { __getExtensionRegistryForTest } from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';

describe('search-tools orchestrator tools', () => {
    beforeEach(async () => {
        __getExtensionRegistryForTest().clear();
        // The register implementation is async (it dynamically imports
        // the orchestrator API). Tests await register/unregister.
        await unregisterSearchToolsOrchestrationTools();
    });

    test('exports the canonical list of 2 tool names', () => {
        expect(SEARCH_TOOL_NAMES).toEqual(['search_search', 'search_visit']);
    });

    test('register populates the orchestrator extension registry with both as read tools', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        expect(reg.get('search_search')?.mode).toBe('read');
        expect(reg.get('search_visit')?.mode).toBe('read');
    });

    test('neither registered entry carries a simulate hook (both are read tools)', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        // Registry normalizes a missing simulate hook to `null` (see
        // register-custom-tool.js), so the read-tool contract is
        // "no callable simulate", not "key absent".
        expect(reg.get('search_search')?.simulate).toBeNull();
        expect(reg.get('search_visit')?.simulate).toBeNull();
    });

    test('unregister removes both', async () => {
        await registerSearchToolsOrchestrationTools();
        await unregisterSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        expect(reg.has('search_search')).toBe(false);
        expect(reg.has('search_visit')).toBe(false);
    });

    test('exec forwards through context.__searchAdapter (test injection path)', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const adapter = {
            getSettings: () => ({ enabled: true }),
            search: async (args) => ({ ok: true, query: args?.query }),
            visit: async (args) => ({ ok: true, url: args?.url }),
        };
        const searchEntry = reg.get('search_search');
        const visitEntry = reg.get('search_visit');
        const ctx = { __searchAdapter: adapter };
        const searchOut = await searchEntry.exec({ query: 'capybara' }, ctx);
        const visitOut = await visitEntry.exec({ url: 'https://example.com' }, ctx);
        expect(searchOut).toEqual({ ok: true, query: 'capybara' });
        expect(visitOut).toEqual({ ok: true, url: 'https://example.com' });
    });

    test('exec surfaces structured errors when the adapter is missing', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const searchEntry = reg.get('search_search');
        await expect(searchEntry.exec({ query: 'x' }, {})).rejects.toMatchObject({
            name: 'ToolError',
            code: 'SEARCH_UNAVAILABLE',
        });
    });

    test('search_search rejects empty / whitespace-only query with SEARCH_QUERY_EMPTY', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const adapter = {
            getSettings: () => ({ enabled: true }),
            search: async () => ({ results: [] }),
        };
        const ctx = { __searchAdapter: adapter };
        const searchEntry = reg.get('search_search');
        // Empty string and whitespace-only both fail the trim() guard.
        for (const query of ['', '   \t  ']) {
            let caught = null;
            try {
                await searchEntry.exec({ query }, ctx);
            } catch (err) {
                caught = err;
            }
            expect(caught).not.toBeNull();
            expect(caught.name).toBe('ToolError');
            expect(caught.code).toBe('SEARCH_QUERY_EMPTY');
            expect(typeof caught.hint).toBe('string');
            expect(caught.hint.length).toBeGreaterThan(0);
        }
    });

    test('search_visit rejects empty / missing url with SEARCH_URL_INVALID', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const adapter = {
            getSettings: () => ({ enabled: true }),
            visit: async () => ({ content: '' }),
        };
        const ctx = { __searchAdapter: adapter };
        const visitEntry = reg.get('search_visit');
        // Both an empty string and a missing url field are rejected before
        // the adapter is touched.
        for (const args of [{ url: '' }, {}]) {
            let caught = null;
            try {
                await visitEntry.exec(args, ctx);
            } catch (err) {
                caught = err;
            }
            expect(caught).not.toBeNull();
            expect(caught.name).toBe('ToolError');
            expect(caught.code).toBe('SEARCH_URL_INVALID');
            expect(typeof caught.hint).toBe('string');
            expect(caught.hint.length).toBeGreaterThan(0);
        }
    });

    test('exec ignores the plugin enabled / preRequestEnabled flags (those gate unrelated internal surfaces)', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const adapter = {
            getSettings: () => ({ enabled: false, preRequestEnabled: false }),
            search: async (args) => ({ ok: true, query: args?.query }),
            visit: async (args) => ({ ok: true, url: args?.url }),
        };
        const ctx = { __searchAdapter: adapter };
        const searchOut = await reg.get('search_search').exec({ query: 'capybara' }, ctx);
        const visitOut = await reg.get('search_visit').exec({ url: 'https://example.com' }, ctx);
        expect(searchOut).toEqual({ ok: true, query: 'capybara' });
        expect(visitOut).toEqual({ ok: true, url: 'https://example.com' });
    });

    test('exec wraps non-ToolError adapter failures as SEARCH_FAILED', async () => {
        await registerSearchToolsOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const adapter = {
            getSettings: () => ({ enabled: true }),
            search: async () => { throw new Error('network blew up'); },
            visit: async () => { throw new Error('fetch denied'); },
        };
        const ctx = { __searchAdapter: adapter };
        for (const [name, args, needle] of [
            ['search_search', { query: 'capybara' }, /network blew up/],
            ['search_visit', { url: 'https://example.com' }, /fetch denied/],
        ]) {
            let caught = null;
            try {
                await reg.get(name).exec(args, ctx);
            } catch (err) {
                caught = err;
            }
            expect(caught).not.toBeNull();
            expect(caught.name).toBe('ToolError');
            expect(caught.code).toBe('SEARCH_FAILED');
            // The wrapper message should preserve the original error text.
            expect(caught.message).toMatch(needle);
            expect(typeof caught.hint).toBe('string');
            expect(caught.hint.length).toBeGreaterThan(0);
        }
    });
});
