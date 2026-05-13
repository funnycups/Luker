/**
 * loop-tools/memory.js — memory-graph query tools for loop mode.
 *
 * Three thin wrappers over `memory-graph/external-api.js`:
 *
 *   - memory_search → searchNodesLexical(store, query, { limit, excludeIds })
 *   - memory_list_recent → listRecentNodes(store, { limit, excludeIds })
 *   - memory_get → getNodeById(store, id, { includeNeighbors: true })
 *
 * Dedup contract: every search / list call passes `excludeIds = union(
 *     getCurrentlyInjectedNodeIds(context).alwaysInjectIds,
 *     getCurrentlyInjectedNodeIds(context).recallSelectedIds)` so the agent
 * never re-surfaces nodes already injected into the main model context for
 * this turn. `memory_get` does NOT dedup — the agent may legitimately want
 * to inspect an already-injected node's neighbors.
 *
 * Store + dependency wiring:
 *
 *   - Production: `loop-runtime` calls `attachMemoryStore(context)` once at
 *     the start of `runLoopOrchestration`, which loads the memory-graph
 *     store via the floor-state instance and stashes it on
 *     `context.__memoryStore`. When memory-graph is disabled or the loader
 *     fails, the field is left null and these tools throw a structured
 *     `ToolError(MEMORY_DISABLED)` so the agent reads the failure and
 *     pivots to other tools.
 *   - Tests: skip the loader by setting `context.__memoryStore` directly
 *     (any object with a `nodes` property satisfies the contract). The
 *     external-api functions can also be swapped by setting
 *     `context.__memoryDeps`, which the loader prefers over importing
 *     the real module — that import would otherwise pull in
 *     memory-graph/graph-ops.js → ../../primitives.js etc., and ultimately
 *     ../../../script.js which is the build-time `lib.js` chain Node tests
 *     can't load.
 */

import { ToolError } from '../loop-runtime.js';

/**
 * Resolve the external-api function set. Tests inject through
 * `context.__memoryDeps`; production lazily imports the real module.
 * The lazy import keeps the test runner from pulling memory-graph
 * (which transitively pulls the build-only `lib.js`).
 */
async function pickDeps(context) {
    if (context && context.__memoryDeps && typeof context.__memoryDeps === 'object') {
        return context.__memoryDeps;
    }
    const mod = await import('../../memory-graph/external-api.js');
    return {
        searchNodesLexical: mod.searchNodesLexical,
        listRecentNodes: mod.listRecentNodes,
        getNodeById: mod.getNodeById,
        getCurrentlyInjectedNodeIds: mod.getCurrentlyInjectedNodeIds,
    };
}

/**
 * Read the chat-scoped store from the context. `attachMemoryStore` in the
 * runtime sets this to the materialized memory-graph payload (or null when
 * memory-graph is disabled / unloaded). `undefined` is treated as
 * "loader never ran" and surfaces the same MEMORY_DISABLED error so the
 * agent doesn't get a confusing "no nodes" response when the underlying
 * extension isn't present at all.
 */
function loadStore(context) {
    return context?.__memoryStore ?? null;
}

function unionInjected(deps, context) {
    const injected = deps?.getCurrentlyInjectedNodeIds
        ? deps.getCurrentlyInjectedNodeIds(context)
        : { alwaysInjectIds: new Set(), recallSelectedIds: new Set() };
    const out = new Set();
    for (const id of injected?.alwaysInjectIds || []) out.add(id);
    for (const id of injected?.recallSelectedIds || []) out.add(id);
    return out;
}

function requireStore(context) {
    const store = loadStore(context);
    if (!store) {
        throw new ToolError(
            'memory-graph not enabled or store unavailable.',
            'MEMORY_DISABLED',
            'Enable memory-graph in extension settings, or skip memory_* tools and rely on chat / lorebook context.',
        );
    }
    return store;
}

/**
 * Lexical / substring search across memory-graph nodes for the current
 * chat. Excludes nodes already injected (always-inject + recall-selected).
 *
 * @param {{ query: string, limit?: number }} args
 * @param {object} context — must carry `__memoryStore` (and optionally
 *                           `__memoryDeps` for tests)
 * @returns {Promise<{ nodes: Array<{ id: string, preview: string, type?: string, time?: number }> }>}
 */
export async function execMemorySearch(args, context) {
    const queryRaw = String(args?.query ?? '');
    if (!queryRaw.trim()) {
        throw new ToolError(
            'memory_search: query must be non-empty.',
            'MEMORY_QUERY_EMPTY',
            'Provide a non-empty query. Use whole words for best results.',
        );
    }
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args?.limit) || 5)));
    const store = requireStore(context);
    const deps = await pickDeps(context);
    const excludeIds = unionInjected(deps, context);
    const result = deps.searchNodesLexical(store, queryRaw, { limit, excludeIds });
    return result || { nodes: [] };
}

/**
 * Browse most-recent nodes in time-descending order. Excludes already-
 * injected nodes (same union as memory_search).
 *
 * @param {{ limit?: number }} args
 * @param {object} context
 * @returns {Promise<{ nodes: Array<{ id: string, preview: string, time?: number, type?: string }> }>}
 */
export async function execMemoryListRecent(args, context) {
    const limit = Math.max(1, Math.min(100, Math.floor(Number(args?.limit) || 10)));
    const store = requireStore(context);
    const deps = await pickDeps(context);
    const excludeIds = unionInjected(deps, context);
    const result = deps.listRecentNodes(store, { limit, excludeIds });
    return result || { nodes: [] };
}

/**
 * Fetch a node by id with direct neighbor metadata (`{id, edgeType,
 * relation?}`). Does NOT dedup — the agent may want to inspect an
 * already-injected node's neighbors.
 *
 * @param {{ node_id: string }} args
 * @param {object} context
 * @returns {Promise<{ node: object, neighbors: Array<object> }>}
 */
export async function execMemoryGet(args, context) {
    const idRaw = String(args?.node_id ?? '');
    if (!idRaw.trim()) {
        throw new ToolError(
            'memory_get: node_id must be non-empty.',
            'MEMORY_ID_EMPTY',
            'Pass the id string returned by memory_search or memory_list_recent.',
        );
    }
    const store = requireStore(context);
    const deps = await pickDeps(context);
    const result = deps.getNodeById(store, idRaw.trim(), { includeNeighbors: true });
    if (!result) {
        throw new ToolError(
            `memory_get: node '${idRaw.trim()}' not found.`,
            'MEMORY_NOT_FOUND',
            'Verify the id with memory_search or memory_list_recent first.',
        );
    }
    return result;
}
