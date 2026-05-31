// SPDX-License-Identifier: AGPL-3.0-or-later
//
// search-tools/orchestrator-tools.js — registers search-tools' 2 read
// tools into the orchestrator's Layer-2 extension registry.
//
// search-tools publishes these tools so any of the four orchestration
// modes (loop / spec / agenda / director) can dispatch them through the
// same Layer-2 path third-party plugins use. The orchestrator does not
// know search-tools exists — coupling is one-directional and opt-in via
// `registerSearchToolsOrchestrationTools()`. When orchestrator is not
// loaded the register call is a silent no-op so search-tools stays
// independently functional.
//
// No session lifecycle: both tools are stateless adapters over
// `Luker.searchTools` (installed by search-tools/main.js at init).
// Each call resolves an adapter on demand — preferring
// `context.__searchAdapter` (test injection) and falling back to
// `globalThis.Luker.searchTools` for production.

// ---------------------------------------------------------------------------
// ToolError shim
//
// The original tools lived inside orchestrator and imported `ToolError`
// from `loop-runtime.js`. Inside search-tools we keep the same wire
// shape (the dispatcher inspects `err.code` / `err.hint`) but declare
// the class locally so search-tools does not depend on orchestrator's
// internal modules.
// ---------------------------------------------------------------------------

class ToolError extends Error {
    constructor(message, code, hint) {
        super(String(message || 'Tool error.'));
        this.name = 'ToolError';
        this.code = String(code || 'TOOL_ERROR');
        this.hint = String(hint || '');
    }
}

// ---------------------------------------------------------------------------
// Adapter resolution (ported from loop-tools/search.js)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exec functions (ported verbatim from orchestrator/loop-tools/search.js)
// ---------------------------------------------------------------------------

async function execSearchSearch(args, context) {
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
        // Duck-typed instead of `instanceof ToolError` because the class
        // lives in this module — adapter implementations that throw their
        // own ToolError-shaped errors should propagate unwrapped.
        if (error && error.name === 'ToolError' && typeof error.code === 'string') {
            throw error;
        }
        throw new ToolError(
            `search_search failed: ${String(error?.message || error)}`,
            'SEARCH_FAILED',
            'The search provider returned an error. Try a different query, or pivot to a non-web tool.',
        );
    }
}

async function execSearchVisit(args, context) {
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
        if (error && error.name === 'ToolError' && typeof error.code === 'string') {
            throw error;
        }
        throw new ToolError(
            `search_visit failed: ${String(error?.message || error)}`,
            'SEARCH_FAILED',
            'The page could not be fetched. Try a different URL, or fall back to the search summary.',
        );
    }
}

// ---------------------------------------------------------------------------
// Schemas (copied verbatim from orchestrator/loop-tools.js's
// registerTool('search_*', ...) calls — only the `parameters` blob
// changes; the rest is wrapped by the registration loop below.)
// ---------------------------------------------------------------------------

const SCHEMAS = [
    {
        name: 'search_search',
        mode: 'read',
        exec: execSearchSearch,
        description: 'Web search via the search-tools plugin (DuckDuckGo / SearXNG / Brave, depending on plugin settings). Use only when the user asks about current events, fresh facts, or external information not present in chat / lorebook / memory. Returns provider-shaped results (typically a list of {title, url, snippet}). Follow up with search_visit on a specific URL to read full readable text.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Non-empty search query. Whitespace-only is rejected.',
                },
                max_results: {
                    type: 'integer',
                    description: 'Maximum number of results (1-20). Provider may cap further.',
                    minimum: 1,
                    maximum: 20,
                },
                safe_search: {
                    type: 'string',
                    enum: ['off', 'moderate', 'strict'],
                    description: 'Safe-search level. Defaults to plugin settings.',
                },
                time_range: {
                    type: 'string',
                    enum: ['day', 'week', 'month', 'year'],
                    description: 'Optional time filter. Omit for no filter.',
                },
                region: {
                    type: 'string',
                    description: 'Optional provider-specific locale or region hint.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_visit',
        mode: 'read',
        exec: execSearchVisit,
        description: 'Fetch one webpage discovered via search_search and return its readable text. Use sparingly: prefer the search snippet when it already answers the question.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'HTTP/HTTPS page URL.',
                },
                max_chars: {
                    type: 'integer',
                    description: 'Maximum output characters (0-50000). 0 means no truncation.',
                    minimum: 0,
                    maximum: 50000,
                },
            },
            required: ['url'],
            additionalProperties: false,
        },
    },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const SEARCH_TOOL_NAMES = Object.freeze(SCHEMAS.map(s => s.name));

/**
 * Dynamically load the orchestrator's Layer-2 register helpers. Lazy
 * import so search-tools can boot before orchestrator without ESM
 * load-order constraints, and so search-tools stays standalone-usable
 * when orchestrator isn't installed.
 *
 * Returns null when orchestrator cannot be located, so the public
 * register / unregister functions can no-op without throwing.
 */
async function loadOrchestratorRegistrar() {
    try {
        const mod = await import('../orchestrator/register-custom-tool.js');
        if (typeof mod?.registerOrchestrationTool !== 'function') return null;
        return mod;
    } catch (_err) {
        // Orchestrator not installed / not bundled — that's expected.
        return null;
    }
}

/**
 * Publish search-tools' 2 read tools into the orchestrator's Layer-2
 * extension registry. Both tools are stateless adapters that resolve
 * `Luker.searchTools` (installed by main.js) at call time, so no per-ctx
 * session wrapping is needed.
 *
 * Silent no-op when orchestrator isn't loaded — search-tools remains
 * independently usable.
 */
export async function registerSearchToolsOrchestrationTools() {
    const orch = await loadOrchestratorRegistrar();
    if (!orch) return;
    for (const s of SCHEMAS) {
        orch.registerOrchestrationTool({
            name: s.name,
            description: s.description,
            parameters: s.parameters,
            mode: s.mode,
            exec: s.exec,
        });
    }
}

/**
 * Remove search-tools' 2 tools from the orchestrator's Layer-2
 * registry. Silent no-op when orchestrator isn't loaded.
 */
export async function unregisterSearchToolsOrchestrationTools() {
    const orch = await loadOrchestratorRegistrar();
    if (!orch || typeof orch.unregisterOrchestrationTool !== 'function') return;
    for (const name of SEARCH_TOOL_NAMES) {
        orch.unregisterOrchestrationTool(name);
    }
}
