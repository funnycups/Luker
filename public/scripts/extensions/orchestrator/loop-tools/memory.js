/**
 * loop-tools/memory.js — memory-graph query + write tools for loop mode.
 *
 * Wraps the memory-graph Layer-1 session object so the agent sees the same
 * inputs the native recall LLM sees and can mutate the graph through the
 * same boundary used by the extraction pipeline:
 *
 *   - memory_list_candidates       → listVisibleCandidates(options)
 *   - memory_edge_summary          → getEdgeSummary(id, options)
 *   - memory_node_brief            → getNodeBrief(id, options)
 *   - memory_expand_seeds          → expandFromSeeds(ids, options)
 *   - memory_schema                → getSchema()
 *   - memory_keyword_search        → keywordSearch(options)
 *   - memory_vector_search         → vectorSearch(options)        [async]
 *   - memory_find_by_name          → findByName(options)
 *   - memory_compaction_candidates → compactionCandidates(options)
 *   - memory_node_create           → createNode(op)
 *   - memory_node_edit             → editNode(op)
 *   - memory_node_delete           → deleteNode(op)
 *   - memory_link_upsert           → upsertLinks(op)
 *   - memory_link_delete           → deleteLinks(op)
 *   - memory_compact_nodes         → compactNodes(op)
 *
 * Store + dependency wiring:
 *
 *   - Production: `loop-runtime` calls `attachMemoryGraphSession(context)`
 *     once at the start of `runLoopOrchestration`, which opens a session
 *     through memory-graph's Layer-1 API
 *     (`getExtensionApi('memory-graph').openSession(context)`) and stashes
 *     it on `context.__memoryGraphSession`. When memory-graph is disabled
 *     or the open fails, the field is null and these tools throw a
 *     structured `ToolError(MEMORY_DISABLED)`.
 *   - Tests: skip the production opener by setting
 *     `context.__memoryGraphSession` directly to a stub object exposing
 *     the methods the wrappers call.
 */

import { ToolError } from '../loop-runtime.js';

const MEMORY_DISABLED_HINT = 'Memory-graph is disabled or not loaded. Enable it in the memory-graph extension.';

function loadSession(context) {
    return context?.__memoryGraphSession ?? null;
}

function requireSession(toolName, context) {
    const session = loadSession(context);
    if (!session) {
        throw new ToolError(
            `${toolName}: memory-graph store is not loaded.`,
            'MEMORY_DISABLED',
            MEMORY_DISABLED_HINT,
        );
    }
    return session;
}

// ---------------------------------------------------------------------------
// Spec 2 — read-api pipeline wrappers
//
// Each wrapper:
//   1. Validates that `__memoryGraphSession` is loaded (raises MEMORY_DISABLED).
//   2. Validates required args (raises MEMORY_*_EMPTY codes when missing).
//   3. Forwards args to the session method, trimming returns to LLM-friendly
//      shapes where the raw view would be too verbose for tool-output rendering.
//
// The return-shape trimming policy:
//   - `listVisibleCandidates` / `expandFromSeeds` return arrays
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
    const session = requireSession('memory_list_candidates', context);
    const options = {};
    const seqWindow = normalizeSeqWindow(args?.seq_window);
    if (seqWindow) options.seqWindow = seqWindow;
    const types = normalizeStringArrayArg(args?.types);
    if (types) options.types = types;
    const excludeRecent = pickFiniteInt(args?.exclude_recent_messages);
    if (excludeRecent !== undefined && excludeRecent >= 0) {
        options.excludeRecentMessages = excludeRecent;
    }
    const candidates = session.listVisibleCandidates(options) || [];
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
            'Pass an id from memory_list_candidates / memory_keyword_search / memory_find_by_name.',
        );
    }
    const session = requireSession('memory_edge_summary', context);
    const options = {};
    const edgeTypes = normalizeStringArrayArg(args?.edge_types);
    if (edgeTypes) options.edgeTypes = edgeTypes;
    const limit = pickFiniteInt(args?.limit);
    if (limit !== undefined && limit >= 1) options.limit = limit;
    return { summary: session.getEdgeSummary(idRaw, options) };
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
            'Pass an id from memory_list_candidates / memory_keyword_search / memory_find_by_name.',
        );
    }
    const session = requireSession('memory_node_brief', context);
    const options = {};
    if (args?.include_edge_summary === false) options.includeEdgeSummary = false;
    const edgeSummaryLimit = pickFiniteInt(args?.edge_summary_limit);
    if (edgeSummaryLimit !== undefined && edgeSummaryLimit >= 1) {
        options.edgeSummaryLimit = edgeSummaryLimit;
    }
    return { brief: session.getNodeBrief(idRaw, options) };
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
            'Provide one or more ids from memory_list_candidates / memory_keyword_search / memory_find_by_name to expand around.',
        );
    }
    const session = requireSession('memory_expand_seeds', context);
    const options = {};
    const hops = pickFiniteInt(args?.hops);
    if (hops !== undefined && hops >= 1) options.hops = hops;
    const edgeTypes = normalizeStringArrayArg(args?.edge_types);
    if (edgeTypes) options.edgeTypes = edgeTypes;
    if (args?.include_children === false) options.includeChildren = false;
    if (args?.exclude_internal === true) options.excludeInternal = true;
    const nodes = session.expandFromSeeds(seedIds, options) || [];
    return { nodes: Array.from(nodes).map(trimExpandPreview).filter(Boolean) };
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
    const session = requireSession('memory_schema', context);
    return { schema: session.getSchema() };
}

// ---------------------------------------------------------------------------
// Spec 2 (continued) — read-api keyword/vector/find/compaction wrappers
//
// These four wrap the targeted lookups added in Tasks 13–16 (keyword and
// vector search, exact-name lookup, and hierarchical compaction candidates).
// They take the place of the old `memory_rank` aggregate so the agent picks
// a retrieval mode by tool choice instead of by a `mode` argument.
// ---------------------------------------------------------------------------

/**
 * Token-overlap keyword search over visible nodes. Wraps `keywordSearch`.
 *
 * @param {{ query: string, types?: string[], k?: number }} args
 * @param {object} context
 * @returns {Promise<{ results: Array<{ id, type, title, seqTo, score, scoreMode }> }>}
 */
export async function execMemoryKeywordSearch(args, context) {
    const session = requireSession('memory_keyword_search', context);
    const results = session.keywordSearch({
        query: String(args?.query || ''),
        types: Array.isArray(args?.types) ? args.types : undefined,
        k: args?.k,
    });
    return { results: Array.from(results).map(trimRankedPreview).filter(Boolean) };
}

/**
 * Embedding-based semantic search. Wraps `vectorSearch`. Translates the
 * raw `NO_EMBEDDING_PROFILE` error into a structured `ToolError` so the
 * agent learns to fall back to `memory_keyword_search`.
 *
 * @param {{ query: string, types?: string[], k?: number }} args
 * @param {object} context
 * @returns {Promise<{ results: Array<{ id, type, title, seqTo, score, scoreMode }> }>}
 */
export async function execMemoryVectorSearch(args, context) {
    const session = requireSession('memory_vector_search', context);
    try {
        const results = await session.vectorSearch({
            query: String(args?.query || ''),
            types: Array.isArray(args?.types) ? args.types : undefined,
            k: args?.k,
        });
        return { results: Array.from(results).map(trimRankedPreview).filter(Boolean) };
    } catch (err) {
        if (err?.code === 'NO_EMBEDDING_PROFILE') {
            throw new ToolError(
                'memory_vector_search: no embedding profile configured.',
                'NO_EMBEDDING_PROFILE',
                'Use memory_keyword_search instead, or configure an embedding profile in memory-graph settings.',
            );
        }
        throw err;
    }
}

/**
 * Exact / substring lookup against node titles and primary-key columns
 * (typically aliases). Used for dedup before creating a new node. Wraps
 * `findByName`.
 *
 * @param {{ query: string, types?: string[] }} args
 * @param {object} context
 * @returns {Promise<{ matches: Array<{ id, type, level, title, seqTo, semanticDepth }> }>}
 */
export async function execMemoryFindByName(args, context) {
    const session = requireSession('memory_find_by_name', context);
    const result = session.findByName({
        query: String(args?.query || ''),
        types: Array.isArray(args?.types) ? args.types : undefined,
    });
    return { matches: Array.from(result.matches).map(trimCandidatePreview).filter(Boolean) };
}

/**
 * Plan-side helper: which semantic roots at a given depth qualify for
 * compaction into a rollup parent. Wraps `compactionCandidates`.
 *
 * @param {{ type: string, depth?: number }} args
 * @param {object} context
 * @returns {Promise<{ groups: object[] }>}
 */
export async function execMemoryCompactionCandidates(args, context) {
    const session = requireSession('memory_compaction_candidates', context);
    const result = session.compactionCandidates({
        type: String(args?.type || ''),
        depth: args?.depth,
    });
    return result;
}

// ---------------------------------------------------------------------------
// Spec 3 — write-api wrappers (node create/edit/delete, link upsert/delete,
// rollup compaction). Mirror the read-side trim-and-forward pattern; the
// write-api enforces semantics + persistence and returns minimal ack shapes.
// ---------------------------------------------------------------------------

/**
 * Create a node of the given type with title + fields and optional
 * outgoing links. Wraps `createNode`.
 *
 * @param {{ type: string, title?: string, fields?: object, links?: object[], ref?: string }} args
 * @param {object} context
 * @returns {Promise<{ ok: true, id: string }>}
 */
export async function execMemoryNodeCreate(args, context) {
    const session = requireSession('memory_node_create', context);
    const result = session.createNode({
        type: String(args?.type || ''),
        title: String(args?.title || ''),
        fields: args?.fields || {},
        links: Array.isArray(args?.links) ? args.links : undefined,
        ref: args?.ref || undefined,
    });
    return { ok: true, id: result.id };
}

/**
 * Patch an existing node: set / clear fields and optionally rename.
 * Wraps `editNode`.
 *
 * @param {{ node_id: string, set_fields?: object, clear_fields?: string[], title?: string }} args
 * @param {object} context
 * @returns {Promise<{ ok: boolean }>}
 */
export async function execMemoryNodeEdit(args, context) {
    const session = requireSession('memory_node_edit', context);
    const result = session.editNode({
        id: String(args?.node_id || ''),
        setFields: args?.set_fields || undefined,
        clearFields: Array.isArray(args?.clear_fields) ? args.clear_fields : undefined,
        title: args?.title,
    });
    return { ok: result.ok };
}

/**
 * Archive a node (soft-delete + sweep dangling edges). Wraps `deleteNode`.
 *
 * @param {{ node_id: string }} args
 * @param {object} context
 * @returns {Promise<{ ok: boolean }>}
 */
export async function execMemoryNodeDelete(args, context) {
    const session = requireSession('memory_node_delete', context);
    const result = session.deleteNode({ id: String(args?.node_id || '') });
    return { ok: result.ok };
}

/**
 * Add or update edges from a source node. Wraps `upsertLinks`.
 *
 * @param {{ source_node_id?: string, source_ref?: string, links?: object[] }} args
 * @param {object} context
 * @returns {Promise<{ ok: boolean, applied: number }>}
 */
export async function execMemoryLinkUpsert(args, context) {
    const session = requireSession('memory_link_upsert', context);
    const result = session.upsertLinks({
        source: {
            id: args?.source_node_id || undefined,
            ref: args?.source_ref || undefined,
        },
        links: Array.isArray(args?.links) ? args.links : [],
    });
    return { ok: result.applied > 0, applied: result.applied };
}

/**
 * Remove a specific edge. Wraps `deleteLinks`.
 *
 * @param {{ source_node_id: string, target_node_id: string, relation: string, direction?: 'in'|'out'|'bidirectional' }} args
 * @param {object} context
 * @returns {Promise<{ ok: boolean, removed: number }>}
 */
export async function execMemoryLinkDelete(args, context) {
    const session = requireSession('memory_link_delete', context);
    const result = session.deleteLinks({
        source: { id: args?.source_node_id || undefined },
        target: { id: args?.target_node_id || undefined },
        relation: String(args?.relation || ''),
        direction: args?.direction || undefined,
    });
    return { ok: result.removed > 0, removed: result.removed };
}

/**
 * Roll a set of children up into a new semantic parent of the given type.
 * Wraps `compactNodes`.
 *
 * @param {{ type: string, child_ids: string[], summary: string, fields?: object }} args
 * @param {object} context
 * @returns {Promise<{ ok: true, rollup_node_id: string }>}
 */
export async function execMemoryCompactNodes(args, context) {
    const session = requireSession('memory_compact_nodes', context);
    const result = session.compactNodes({
        type: String(args?.type || ''),
        childIds: Array.isArray(args?.child_ids) ? args.child_ids : [],
        summary: String(args?.summary || ''),
        fields: args?.fields || undefined,
    });
    return { ok: true, rollup_node_id: result.rollupNodeId };
}
