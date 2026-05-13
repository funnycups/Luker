/**
 * loop-tools/search.js — web search / page visit tools for loop mode.
 *
 * Bridges the loop agent to the search-tools plugin's exposed
 * `globalThis.Luker.searchTools` API:
 *
 *   - search_search({ query, max_results?, safe_search?, time_range?, region? })
 *     forwards to the plugin's `searchWeb`, returning whatever shape the
 *     active provider (DuckDuckGo / SearXNG / Brave) emits.
 *   - search_visit({ url, max_chars? }) forwards to the plugin's
 *     `visitWebPage`, returning a readable text excerpt.
 *
 * Adapter resolution prefers `context.__searchAdapter` (test injection
 * point) and falls back to `globalThis.Luker?.searchTools` so production
 * picks up the plugin without any runtime wiring on the orchestrator
 * side. The plugin's master enable flag (`settings.enabled` OR
 * `settings.preRequestEnabled`) gates calls — when disabled, the agent
 * sees `ToolError(SEARCH_DISABLED)` and can pivot. Adapter not present
 * at all → `ToolError(SEARCH_UNAVAILABLE)`. Any unexpected error from
 * the underlying provider is wrapped as `ToolError(SEARCH_FAILED)` so
 * loop-runtime feeds it back as a structured `role: tool` message
 * instead of aborting the whole run.
 */

import { ToolError } from '../loop-runtime.js';

function resolveAdapter(context) {
    if (context && typeof context === 'object' && context.__searchAdapter) {
        return context.__searchAdapter;
    }
    const root = typeof globalThis !== 'undefined' ? globalThis : null;
    return root?.Luker?.searchTools || null;
}

function assertAdapterReady(adapter) {
    if (!adapter || typeof adapter !== 'object') {
        throw new ToolError(
            'Web search is unavailable: the search-tools plugin is not loaded.',
            'SEARCH_UNAVAILABLE',
            'Ensure the search-tools extension is enabled, then retry.',
        );
    }
    if (typeof adapter.getSettings === 'function') {
        let settings = null;
        try { settings = adapter.getSettings(); } catch { settings = null; }
        const enabled = Boolean(settings?.enabled || settings?.preRequestEnabled);
        if (!enabled) {
            throw new ToolError(
                'Web search is disabled in plugin settings.',
                'SEARCH_DISABLED',
                'Open the search-tools settings panel and enable the plugin (or its pre-request mode), then retry.',
            );
        }
    }
}

function buildOpts(context) {
    const abortSignal = (context && typeof context === 'object' && context.abortSignal) || null;
    return abortSignal ? { abortSignal } : {};
}

/**
 * Forward a search request to the search-tools plugin.
 *
 * @param {{ query: string, max_results?: number, safe_search?: string,
 *           time_range?: string, region?: string }} args
 * @param {object} context — exposes optional `__searchAdapter` injection
 * @returns {Promise<unknown>} provider-shaped result
 */
export async function execSearchSearch(args, context) {
    const queryRaw = String(args?.query ?? '');
    if (!queryRaw.trim()) {
        throw new ToolError(
            'search_search: query must be non-empty.',
            'SEARCH_QUERY_EMPTY',
            'Provide a non-empty query string.',
        );
    }
    const adapter = resolveAdapter(context);
    assertAdapterReady(adapter);
    if (typeof adapter.search !== 'function') {
        throw new ToolError(
            'search_search: search-tools adapter is missing a `search` function.',
            'SEARCH_UNAVAILABLE',
            'Ensure the search-tools extension is up to date.',
        );
    }
    try {
        return await adapter.search(args || {}, buildOpts(context));
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(
            `search_search failed: ${String(error?.message || error)}`,
            'SEARCH_FAILED',
            'The search provider returned an error. Try a different query, or pivot to a non-web tool.',
        );
    }
}

/**
 * Forward a visit (fetch + readable extract) request to the search-tools
 * plugin.
 *
 * @param {{ url: string, max_chars?: number }} args
 * @param {object} context
 * @returns {Promise<unknown>}
 */
export async function execSearchVisit(args, context) {
    const urlRaw = String(args?.url ?? '');
    if (!urlRaw.trim()) {
        throw new ToolError(
            'search_visit: url must be a non-empty HTTP/HTTPS URL.',
            'SEARCH_URL_INVALID',
            'Pass an http:// or https:// URL discovered via search_search.',
        );
    }
    const adapter = resolveAdapter(context);
    assertAdapterReady(adapter);
    if (typeof adapter.visit !== 'function') {
        throw new ToolError(
            'search_visit: search-tools adapter is missing a `visit` function.',
            'SEARCH_UNAVAILABLE',
            'Ensure the search-tools extension is up to date.',
        );
    }
    try {
        return await adapter.visit(args || {}, buildOpts(context));
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(
            `search_visit failed: ${String(error?.message || error)}`,
            'SEARCH_FAILED',
            'The page could not be fetched. Try a different URL, or fall back to the search summary.',
        );
    }
}
