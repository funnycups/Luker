/**
 * loop-tools/memory.js — memory-graph query tools for loop mode.
 *
 * Wraps `memory-graph/read-api.js` (`getMemoryGraphReadApi(context)`) so the
 * agent sees the same inputs the native recall LLM sees:
 *
 *   - memory_list_candidates → listVisibleCandidates(options)
 *   - memory_edge_summary    → getEdgeSummary(id, options)
 *   - memory_node_brief      → getNodeBrief(id, options)
 *   - memory_expand_seeds    → expandFromSeeds(ids, options)
 *   - memory_rank            → rankNodes(options)  [async]
 *   - memory_schema          → getSchema()
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
 *     (any object with a `nodes` property satisfies the contract). Tests
 *     inject a stub read-api through `context.__memoryReadApi`; when
 *     present, tools call its methods directly instead of building one
 *     via `getMemoryGraphReadApi(context)`. Lazy import of the real module
 *     keeps the Node test runner from pulling memory-graph/main.js (the
 *     build-only `lib.js` chain).
 */

import { ToolError } from '../loop-runtime.js';

/**
 * Resolve a read-api instance. Tests inject through `context.__memoryReadApi`;
 * production lazily imports `memory-graph/read-api.js` and builds a per-call
 * instance bound to the orchestrator context (which carries `__memoryStore`).
 */
async function pickReadApi(context) {
    if (context && context.__memoryReadApi && typeof context.__memoryReadApi === 'object') {
        return context.__memoryReadApi;
    }
    const mod = await import('../../memory-graph/read-api.js');
    return mod.getMemoryGraphReadApi(context);
}

const MEMORY_DISABLED_HINT = 'Memory-graph is disabled or not loaded. Enable it in the memory-graph extension.';

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

function requireStoreForReadApi(toolName, context) {
    const store = loadStore(context);
    if (!store) {
        throw new ToolError(
            `${toolName}: memory-graph store is not loaded.`,
            'MEMORY_DISABLED',
            MEMORY_DISABLED_HINT,
        );
    }
    return store;
}

// ---------------------------------------------------------------------------
// Spec 2 — read-api pipeline wrappers
//
// Each wrapper:
//   1. Validates that `__memoryStore` is loaded (raises MEMORY_DISABLED).
//   2. Validates required args (raises MEMORY_*_EMPTY codes when missing).
//   3. Builds a per-call read-api instance via `pickReadApi(context)`
//      (tests inject a stub through `context.__memoryReadApi`).
//   4. Forwards args, trimming returns to LLM-friendly shapes where the
//      raw view would be too verbose for tool-output rendering.
//
// The return-shape trimming policy:
//   - `listVisibleCandidates` / `expandFromSeeds` / `rankNodes` return arrays
//     of full NodeView records (fields object can be sizable); we project to
//     `{ id, type, level?, title, seqTo, ... }` so the agent can shortlist
//     and then fetch full briefs via `memory_node_brief` only for the few
//     ids it wants to inspect.
//   - `getEdgeSummary` / `getNodeBrief` / `getSchema` are already
//     LLM-formatted views; we pass them through unchanged.
// ---------------------------------------------------------------------------

function pickFiniteInt(value) {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function normalizeSeqWindow(value) {
    if (!value || typeof value !== 'object') return undefined;
    const from = pickFiniteInt(value.from);
    const to = pickFiniteInt(value.to);
    if (from === undefined && to === undefined) return undefined;
    const out = {};
    if (from !== undefined) out.from = from;
    if (to !== undefined) out.to = to;
    return out;
}

function normalizeStringArrayArg(value) {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    for (const item of value) {
        const s = String(item ?? '').trim();
        if (s) out.push(s);
    }
    return out.length > 0 ? out : undefined;
}

function trimCandidatePreview(node) {
    if (!node || typeof node !== 'object') return null;
    return {
        id: String(node.id || ''),
        type: String(node.type || ''),
        level: node.level === 'semantic' ? 'semantic' : 'episodic',
        title: String(node.title || ''),
        seqTo: Number.isFinite(Number(node.seqTo)) ? Number(node.seqTo) : -1,
        semanticDepth: Number.isFinite(Number(node.semanticDepth)) ? Number(node.semanticDepth) : 0,
    };
}

function trimExpandPreview(node) {
    if (!node || typeof node !== 'object') return null;
    return {
        id: String(node.id || ''),
        type: String(node.type || ''),
        level: node.level === 'semantic' ? 'semantic' : 'episodic',
        title: String(node.title || ''),
        seqTo: Number.isFinite(Number(node.seqTo)) ? Number(node.seqTo) : -1,
    };
}

function trimRankedPreview(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        id: String(entry.id || ''),
        type: String(entry.type || ''),
        title: String(entry.title || ''),
        seqTo: Number.isFinite(Number(entry.seqTo)) ? Number(entry.seqTo) : -1,
        score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0,
        scoreMode: String(entry.scoreMode || ''),
    };
}

/**
 * Enumerate the visible memory-graph candidate pool — the same pool the
 * memory-graph's own recall LLM sees. Wraps `listVisibleCandidates`.
 *
 * @param {{ seq_window?: { from?: number, to?: number }, types?: string[], exclude_recent_messages?: number }} args
 * @param {object} context
 * @returns {Promise<{ candidates: Array<{ id, type, level, title, seqTo, semanticDepth }> }>}
 */
export async function execMemoryListCandidates(args, context) {
    requireStoreForReadApi('memory_list_candidates', context);
    const api = await pickReadApi(context);
    const options = {};
    const seqWindow = normalizeSeqWindow(args?.seq_window);
    if (seqWindow) options.seqWindow = seqWindow;
    const types = normalizeStringArrayArg(args?.types);
    if (types) options.types = types;
    const excludeRecent = pickFiniteInt(args?.exclude_recent_messages);
    if (excludeRecent !== undefined && excludeRecent >= 0) {
        options.excludeRecentMessages = excludeRecent;
    }
    const candidates = api.listVisibleCandidates(options) || [];
    return {
        candidates: Array.from(candidates).map(trimCandidatePreview).filter(Boolean),
    };
}

/**
 * Get the degree-and-relations summary for a node (no full brief). Wraps
 * `getEdgeSummary`.
 *
 * @param {{ node_id: string, edge_types?: string[], limit?: number }} args
 * @param {object} context
 * @returns {Promise<{ summary: { degree: number, relations: object[], sample_neighbors: object[] } }>}
 */
export async function execMemoryEdgeSummary(args, context) {
    const idRaw = String(args?.node_id ?? '').trim();
    if (!idRaw) {
        throw new ToolError(
            'memory_edge_summary: node_id must be non-empty.',
            'MEMORY_ID_EMPTY',
            'Pass an id from memory_list_candidates / memory_rank.',
        );
    }
    requireStoreForReadApi('memory_edge_summary', context);
    const api = await pickReadApi(context);
    const options = {};
    const edgeTypes = normalizeStringArrayArg(args?.edge_types);
    if (edgeTypes) options.edgeTypes = edgeTypes;
    const limit = pickFiniteInt(args?.limit);
    if (limit !== undefined && limit >= 1) options.limit = limit;
    return { summary: api.getEdgeSummary(idRaw, options) };
}

/**
 * Get the canonical recall-side brief for a node. Wraps `getNodeBrief`.
 *
 * @param {{ node_id: string, include_edge_summary?: boolean, edge_summary_limit?: number }} args
 * @param {object} context
 * @returns {Promise<{ brief: object | null }>}
 */
export async function execMemoryNodeBrief(args, context) {
    const idRaw = String(args?.node_id ?? '').trim();
    if (!idRaw) {
        throw new ToolError(
            'memory_node_brief: node_id must be non-empty.',
            'MEMORY_ID_EMPTY',
            'Pass an id from memory_list_candidates / memory_rank.',
        );
    }
    requireStoreForReadApi('memory_node_brief', context);
    const api = await pickReadApi(context);
    const options = {};
    if (args?.include_edge_summary === false) options.includeEdgeSummary = false;
    const edgeSummaryLimit = pickFiniteInt(args?.edge_summary_limit);
    if (edgeSummaryLimit !== undefined && edgeSummaryLimit >= 1) {
        options.edgeSummaryLimit = edgeSummaryLimit;
    }
    return { brief: api.getNodeBrief(idRaw, options) };
}

/**
 * BFS-expand a small seed set along children + projected edges. Wraps
 * `expandFromSeeds`.
 *
 * @param {{ seed_ids: string[], hops?: number, edge_types?: string[], include_children?: boolean, exclude_internal?: boolean }} args
 * @param {object} context
 * @returns {Promise<{ nodes: Array<{ id, type, level, title, seqTo }> }>}
 */
export async function execMemoryExpandSeeds(args, context) {
    const seedIds = normalizeStringArrayArg(args?.seed_ids);
    if (!seedIds) {
        throw new ToolError(
            'memory_expand_seeds: seed_ids must be a non-empty array of ids.',
            'MEMORY_SEEDS_EMPTY',
            'Provide one or more ids from memory_list_candidates / memory_rank to expand around.',
        );
    }
    requireStoreForReadApi('memory_expand_seeds', context);
    const api = await pickReadApi(context);
    const options = {};
    const hops = pickFiniteInt(args?.hops);
    if (hops !== undefined && hops >= 1) options.hops = hops;
    const edgeTypes = normalizeStringArrayArg(args?.edge_types);
    if (edgeTypes) options.edgeTypes = edgeTypes;
    if (args?.include_children === false) options.includeChildren = false;
    if (args?.exclude_internal === true) options.excludeInternal = true;
    const nodes = api.expandFromSeeds(seedIds, options) || [];
    return { nodes: Array.from(nodes).map(trimExpandPreview).filter(Boolean) };
}

/**
 * Rank candidate nodes by recency / vector / keyword / hybrid. Wraps
 * `rankNodes` (the only async read-api method).
 *
 * @param {{ query: string, mode?: 'recency'|'vector'|'keyword'|'hybrid', types?: string[], k?: number }} args
 * @param {object} context
 * @returns {Promise<{ ranked: Array<{ id, type, title, seqTo, score, scoreMode }> }>}
 */
export async function execMemoryRank(args, context) {
    const queryRaw = String(args?.query ?? '');
    // `recency` mode is the only one that does not require a query; for the
    // other modes (vector / keyword / hybrid) an empty query degrades to a
    // recency-mode fall-through inside read-api. Either way the caller's
    // intent is unambiguous only when query OR explicit non-recency mode is
    // present; reject when both are missing so the agent learns to brief.
    const explicitMode = ['recency', 'vector', 'keyword', 'hybrid'].includes(args?.mode) ? args.mode : null;
    if (!queryRaw.trim() && explicitMode !== 'recency') {
        throw new ToolError(
            'memory_rank: query must be non-empty (or explicitly set mode: "recency").',
            'MEMORY_QUERY_EMPTY',
            'Pass a topical one-line summary; or pass mode: "recency" to rank by recency alone.',
        );
    }
    requireStoreForReadApi('memory_rank', context);
    const api = await pickReadApi(context);
    const options = { query: queryRaw };
    if (explicitMode) options.mode = explicitMode;
    const types = normalizeStringArrayArg(args?.types);
    if (types) options.types = types;
    const k = pickFiniteInt(args?.k);
    if (k !== undefined && k >= 1) options.k = k;
    const ranked = (await api.rankNodes(options)) || [];
    return { ranked: Array.from(ranked).map(trimRankedPreview).filter(Boolean) };
}

/**
 * Get the active node-type schema (the same shape the native recall LLM
 * sees as `schema_overview`). Wraps `getSchema`.
 *
 * @param {object} _args  unused
 * @param {object} context
 * @returns {Promise<{ schema: object }>}
 */
export async function execMemorySchema(_args, context) {
    requireStoreForReadApi('memory_schema', context);
    const api = await pickReadApi(context);
    return { schema: api.getSchema() };
}
