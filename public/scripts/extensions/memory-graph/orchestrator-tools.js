// SPDX-License-Identifier: AGPL-3.0-or-later
//
// memory-graph/orchestrator-tools.js — registers memory-graph's 15
// read + write tools into the orchestrator's Layer-2 extension registry.
//
// memory-graph publishes these tools so any of the four orchestration
// modes (loop / spec / agenda / director) can dispatch them through the
// same Layer-2 path third-party plugins use. The orchestrator does not
// know memory-graph exists — coupling is one-directional and opt-in via
// `registerMemoryGraphOrchestrationTools()`. When orchestrator is not
// loaded the register call is a silent no-op so memory-graph stays
// independently functional.
//
// Session lifecycle: each tool dispatch lazily opens a memory-graph
// Layer-1 session via `openSession(context)` and caches it on a per-ctx
// WeakMap. All 15 tools called against the same orchestration ctx share
// the same session so writes are visible to subsequent reads. The ctx
// object provided by the orchestrator runtime is the per-tool-call
// context (not the per-run context); since the orchestrator currently
// spreads new objects per call inside `executeLoopTool`, the WeakMap
// effectively caches per-call. That is fine — opening a session is
// cheap (it reuses the active store cached by memory-graph's
// `ensureMemoryStoreLoaded`) and writes still flush through the same
// commit path because the underlying store is the singleton.
//
// Read tools never throw; write tools include a `simulate` peer that
// validates arg shape + node existence without mutating. Both surfaces
// raise a structured `ToolError(MEMORY_DISABLED)` when the session
// cannot be opened (memory-graph extension disabled, no chat loaded).

// ---------------------------------------------------------------------------
// ToolError shim
//
// The original tools lived inside orchestrator and imported `ToolError`
// from `loop-runtime.js`. Inside memory-graph we keep the same wire
// shape (the dispatcher inspects `err.code` / `err.hint`) but declare
// the class locally so memory-graph does not depend on orchestrator's
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

const MEMORY_DISABLED_HINT = 'Memory-graph is disabled or not loaded. Enable it in the memory-graph extension.';

// ---------------------------------------------------------------------------
// Session cache
//
// Keyed by the per-loop ctx object the orchestrator dispatches against.
// In production loop-runtime creates `toolContext = Object.create(context)`
// once per run, so the WeakMap entry stays valid for every tool call in
// that loop and gets GC'd when the loop completes.
//
// Tests pre-populate via `__setSessionForTest` on the source ctx; the
// orchestrator runtime then creates a derived `toolContext` via
// `Object.create(ctx)`. The proto-chain walk in `findCachedSession`
// follows the chain so the same stub is visible to the derived
// toolContext without forcing tests to know about the runtime's
// derivation step.
// ---------------------------------------------------------------------------

let SESSION_CACHE = new WeakMap();

function findCachedSession(context) {
    if (!context || typeof context !== 'object') return undefined;
    let cur = context;
    while (cur && typeof cur === 'object') {
        if (SESSION_CACHE.has(cur)) return SESSION_CACHE.get(cur);
        cur = Object.getPrototypeOf(cur);
    }
    return undefined;
}

async function getOrCreateOrchestrationSession(context) {
    if (!context || typeof context !== 'object') return null;
    const cached = findCachedSession(context);
    if (cached !== undefined) return cached;
    // Lazy import keeps this module loadable even when the memory-graph
    // store isn't fully bootstrapped at extension init time (the
    // jQuery-ready handler runs before some downstream stores exist).
    let session = null;
    try {
        const mg = await import('./api.js');
        if (typeof mg.openSession === 'function') {
            session = await mg.openSession(context);
        }
    } catch (err) {
        console.warn('[memory-graph] failed to open orchestration session:', err);
    }
    SESSION_CACHE.set(context, session);
    return session;
}

function loadSession(context) {
    if (!context || typeof context !== 'object') return null;
    const cached = findCachedSession(context);
    return cached === undefined ? null : cached;
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

/**
 * @internal — exposed for tests. Tests can pre-populate the session
 * cache so a tool exec runs against a stub without hitting the real
 * memory-graph Layer-1 API.
 */
export function __setSessionForTest(context, session) {
    if (!context || typeof context !== 'object') return;
    SESSION_CACHE.set(context, session);
}

/**
 * @internal — exposed for tests. Resets the entire session cache by
 * rebinding the module-level reference to a fresh WeakMap. Useful
 * between test cases that reuse ctx-like objects and need a guaranteed
 * cold start. (WeakMap has no `clear()`, so re-binding is the only way
 * to invalidate every entry at once.)
 */
export function __clearSessionCacheForTest() {
    SESSION_CACHE = new WeakMap();
}

// ---------------------------------------------------------------------------
// Helpers (ported verbatim from loop-tools/memory.js)
// ---------------------------------------------------------------------------

function pickFiniteInt(value) {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
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

/**
 * Strict-typed check for a usable `{start, end}` floor range stamped by
 * A2's `createNode`. Mirrors the same predicate used in
 * `createRollupWithChildren` (main.js) — kept local to orchestrator-tools
 * because all four trimmers / brief paths need it and inlining repeats
 * the type checks four times.
 */
function hasValidFloorRange(obj) {
    return Boolean(
        obj?.floorRange
        && typeof obj.floorRange.start === 'number' && Number.isFinite(obj.floorRange.start)
        && typeof obj.floorRange.end === 'number' && Number.isFinite(obj.floorRange.end),
    );
}

/**
 * Translate a memory-graph internal assistant-message-ordinal range
 * (the coord A3 extraction wrote into `node.floorRange`) into chat[]
 * indices the LLM can pass directly to the `chat_read_range` tool.
 *
 * Coord systems:
 *   - Internal: assistant ordinal = position among `isExtractableAssistantMessage`
 *     matches (non-user, non-empty `mes`; `is_system` is deliberately ignored
 *     per primitives.js doc so /hide doesn't drift seq). 1-based.
 *   - External: chat[] index = raw position in the SillyTavern chat array,
 *     0-based, what `chat_read_range` consumes.
 *
 * Mapping rules:
 *   - end: chat[] index of the assistant at ordinal `range.end`.
 *   - start: chat[] index of the user message immediately preceding the
 *     assistant at ordinal `range.start`. We walk back from that assistant's
 *     chat[] position until `is_user` is found, so the LLM also gets the
 *     prompt that triggered the bot turn. If no user precedes (e.g. an
 *     opening greeting), we fall back to that assistant's own chat[]
 *     index.
 *   - Returns null when `range.end` exceeds the live assistant count
 *     (the referenced message has been deleted since extraction).
 *
 * Predicate parity is load-bearing: extraction recorded the ordinal via
 * `getFloorFromAssistantSeq` which uses the SAME `isExtractableAssistantMessage`
 * predicate (primitives.js). Diverging here would map ordinals to the
 * wrong chat[] indices and the LLM would read unrelated text.
 */
function assistantSeqRangeToChatRange(range, context) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (chat.length === 0) return null;
    if (!range || typeof range !== 'object') return null;
    const targetStart = Number(range.start);
    const targetEnd = Number(range.end);
    if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd)) return null;

    // Inline the predicate to keep this module free of cross-extension
    // imports. Mirrors `isExtractableAssistantMessage` in primitives.js:
    // not user + non-empty trimmed `mes`. is_system is deliberately
    // NOT filtered (see primitives.js doc).
    let ordinal = 0;
    let chatStartForStart = -1;
    let chatIndexForEnd = -1;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const raw = msg.mes;
        if (typeof raw !== 'string' || raw.trim().length === 0) continue;
        ordinal += 1;
        if (ordinal === targetStart) {
            let k = i - 1;
            while (k >= 0 && !chat[k]?.is_user) k -= 1;
            chatStartForStart = k >= 0 ? k : i;
        }
        if (ordinal === targetEnd) {
            chatIndexForEnd = i;
            break;
        }
    }
    if (chatStartForStart < 0 || chatIndexForEnd < 0) return null;
    return { start: chatStartForStart, end: chatIndexForEnd };
}

function trimCandidatePreview(node, context = null) {
    if (!node || typeof node !== 'object') return null;
    const out = {
        id: String(node.id || ''),
        type: String(node.type || ''),
        level: node.level === 'semantic' ? 'semantic' : 'episodic',
        title: String(node.title || ''),
        semanticDepth: Number.isFinite(Number(node.semanticDepth)) ? Number(node.semanticDepth) : 0,
    };
    if (hasValidFloorRange(node)) {
        // null when the referenced messages have been deleted; the LLM
        // sees an explicit null so it can decide whether to drop the node.
        out.floorRange = assistantSeqRangeToChatRange(node.floorRange, context);
    } else {
        out.seqTo = Number.isFinite(Number(node.seqTo)) ? Number(node.seqTo) : -1;
    }
    return out;
}

function trimExpandPreview(node, context = null) {
    if (!node || typeof node !== 'object') return null;
    const out = {
        id: String(node.id || ''),
        type: String(node.type || ''),
        level: node.level === 'semantic' ? 'semantic' : 'episodic',
        title: String(node.title || ''),
    };
    if (hasValidFloorRange(node)) {
        out.floorRange = assistantSeqRangeToChatRange(node.floorRange, context);
    } else {
        out.seqTo = Number.isFinite(Number(node.seqTo)) ? Number(node.seqTo) : -1;
    }
    return out;
}

function trimRankedPreview(entry, context = null) {
    if (!entry || typeof entry !== 'object') return null;
    const out = {
        id: String(entry.id || ''),
        type: String(entry.type || ''),
        title: String(entry.title || ''),
        score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0,
        scoreMode: String(entry.scoreMode || ''),
    };
    if (hasValidFloorRange(entry)) {
        out.floorRange = assistantSeqRangeToChatRange(entry.floorRange, context);
    } else {
        out.seqTo = Number.isFinite(Number(entry.seqTo)) ? Number(entry.seqTo) : -1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Read-api wrappers
// ---------------------------------------------------------------------------

async function execMemoryListCandidates(args, context) {
    const session = requireSession('memory_list_candidates', context);
    const options = {};
    const types = normalizeStringArrayArg(args?.types);
    if (types) options.types = types;
    const excludeRecent = pickFiniteInt(args?.exclude_recent_messages);
    if (excludeRecent !== undefined && excludeRecent >= 0) {
        options.excludeRecentMessages = excludeRecent;
    }
    const candidates = session.listVisibleCandidates(options) || [];
    return {
        candidates: Array.from(candidates).map(n => trimCandidatePreview(n, context)).filter(Boolean),
    };
}

async function execMemoryEdgeSummary(args, context) {
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

async function execMemoryNodeBrief(args, context) {
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
    const brief = session.getNodeBrief(idRaw, options);
    if (brief && hasValidFloorRange(brief)) {
        // brief is a frozen view from freezeNodeBriefView; spread into a
        // mutable object before adjusting. Translate the internal seq
        // range to chat[] coords (or null if the chat slice no longer
        // exists). When floorRange is present we drop the legacy `toSeq`
        // watermark so the agent has exactly one positional signal —
        // matching the trimmer behaviour for list/search results.
        const translated = assistantSeqRangeToChatRange(brief.floorRange, context);
        // brief.toSeq is the legacy watermark we drop in favour of floorRange.
        // Manual property pluck is cleaner than a destructure with an unused
        // sink variable (which trips no-unused-vars in eslint).
        const next = {};
        for (const key of Object.keys(brief)) {
            if (key === 'toSeq') continue;
            next[key] = brief[key];
        }
        next.floorRange = translated;
        return { brief: next };
    }
    return { brief };
}

async function execMemoryExpandSeeds(args, context) {
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
    return { nodes: Array.from(nodes).map(n => trimExpandPreview(n, context)).filter(Boolean) };
}

async function execMemorySchema(_args, context) {
    const session = requireSession('memory_schema', context);
    return { schema: session.getSchema() };
}

async function execMemoryKeywordSearch(args, context) {
    const session = requireSession('memory_keyword_search', context);
    const results = session.keywordSearch({
        query: String(args?.query || ''),
        types: Array.isArray(args?.types) ? args.types : undefined,
        k: args?.k,
    });
    return { results: Array.from(results).map(e => trimRankedPreview(e, context)).filter(Boolean) };
}

async function execMemoryVectorSearch(args, context) {
    const session = requireSession('memory_vector_search', context);
    try {
        const results = await session.vectorSearch({
            query: String(args?.query || ''),
            types: Array.isArray(args?.types) ? args.types : undefined,
            k: args?.k,
        });
        return { results: Array.from(results).map(e => trimRankedPreview(e, context)).filter(Boolean) };
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

async function execMemoryFindByName(args, context) {
    const session = requireSession('memory_find_by_name', context);
    const result = session.findByName({
        query: String(args?.query || ''),
        types: Array.isArray(args?.types) ? args.types : undefined,
    });
    return { matches: Array.from(result.matches).map(m => trimCandidatePreview(m, context)).filter(Boolean) };
}

async function execMemoryCompactionCandidates(args, context) {
    const session = requireSession('memory_compaction_candidates', context);
    const result = session.compactionCandidates({
        type: String(args?.type || ''),
        depth: args?.depth,
    });
    return result;
}

// ---------------------------------------------------------------------------
// Write-api wrappers
// ---------------------------------------------------------------------------

async function execMemoryNodeCreate(args, context) {
    const session = requireSession('memory_node_create', context);
    const result = await session.createNode({
        type: String(args?.type || ''),
        title: String(args?.title || ''),
        fields: args?.fields || {},
        links: Array.isArray(args?.links) ? args.links : undefined,
        ref: args?.ref || undefined,
    });
    return { ok: true, id: result.id };
}

async function execMemoryNodeEdit(args, context) {
    const session = requireSession('memory_node_edit', context);
    const result = await session.editNode({
        id: String(args?.node_id || ''),
        setFields: args?.set_fields || undefined,
        clearFields: Array.isArray(args?.clear_fields) ? args.clear_fields : undefined,
        title: args?.title,
    });
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error || { code: 'OP_FAILED', message: 'edit produced no change.' } };
}

async function execMemoryNodeDelete(args, context) {
    const session = requireSession('memory_node_delete', context);
    const result = await session.deleteNode({ id: String(args?.node_id || '') });
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error || { code: 'OP_FAILED', message: 'delete produced no change.' } };
}

async function execMemoryLinkUpsert(args, context) {
    const session = requireSession('memory_link_upsert', context);
    const result = await session.upsertLinks({
        source: {
            id: args?.source_node_id || undefined,
            ref: args?.source_ref || undefined,
        },
        links: Array.isArray(args?.links) ? args.links : [],
    });
    const applied = Number(result.applied || 0);
    if (applied > 0) return { ok: true, applied };
    return {
        ok: false,
        applied: 0,
        error: result.error || { code: 'OP_FAILED', message: 'link_upsert applied no edges.' },
    };
}

async function execMemoryLinkDelete(args, context) {
    const session = requireSession('memory_link_delete', context);
    const result = await session.deleteLinks({
        source: { id: args?.source_node_id || undefined },
        target: { id: args?.target_node_id || undefined },
        relation: String(args?.relation || ''),
        direction: args?.direction || undefined,
    });
    return { ok: result.removed > 0, removed: result.removed };
}

async function execMemoryCompactNodes(args, context) {
    const session = requireSession('memory_compact_nodes', context);
    const result = await session.compactNodes({
        type: String(args?.type || ''),
        childIds: Array.isArray(args?.child_ids) ? args.child_ids : [],
        summary: String(args?.summary || ''),
        fields: args?.fields || undefined,
    });
    return { ok: true, rollup_node_id: result.rollupNodeId };
}

// ---------------------------------------------------------------------------
// Simulate handlers
// ---------------------------------------------------------------------------

const NODE_NOT_FOUND_HINT = 'Pick an id present in the current graph or create the node first.';

function requireNonEmptyString(value, code, message) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ToolError(message, code, message);
    }
    return value.trim();
}

function requireNodeExists(session, id, code) {
    if (!session || typeof session.getNodeBrief !== 'function') return;
    if (!session.getNodeBrief(id)) {
        throw new ToolError(
            `Node ${id} does not exist on the live memory graph.`,
            code,
            NODE_NOT_FOUND_HINT,
        );
    }
}

function simulatedId(prefix) {
    return `${prefix}-sim-${Math.random().toString(36).slice(2, 10)}`;
}

async function simulateMemoryNodeCreate(args, context) {
    requireNonEmptyString(args?.type, 'MEMORY_NODE_CREATE_BAD_ARGS', 'type is required');
    requireNonEmptyString(args?.title, 'MEMORY_NODE_CREATE_BAD_ARGS', 'title is required');
    const session = loadSession(context);
    if (Array.isArray(args?.links)) {
        for (const link of args.links) {
            if (link && typeof link.target_node_id === 'string' && link.target_node_id.trim()) {
                requireNodeExists(session, link.target_node_id.trim(), 'MEMORY_NODE_CREATE_TARGET_NOT_FOUND');
            }
        }
    }
    return { ok: true, simulated: true, id: simulatedId('n') };
}

async function simulateMemoryNodeEdit(args, context) {
    const id = requireNonEmptyString(args?.node_id, 'MEMORY_NODE_EDIT_BAD_ARGS', 'node_id is required');
    const hasSet = args?.set_fields && typeof args.set_fields === 'object';
    const hasClear = Array.isArray(args?.clear_fields) && args.clear_fields.length > 0;
    const hasTitle = typeof args?.title === 'string';
    if (!hasSet && !hasClear && !hasTitle) {
        throw new ToolError(
            'memory_node_edit: at least one of set_fields / clear_fields / title is required.',
            'MEMORY_NODE_EDIT_BAD_ARGS',
            'Provide the fields you want to change, fields to clear, or a new title.',
        );
    }
    requireNodeExists(loadSession(context), id, 'MEMORY_NODE_EDIT_NODE_NOT_FOUND');
    return { ok: true, simulated: true };
}

async function simulateMemoryNodeDelete(args, context) {
    const id = requireNonEmptyString(args?.node_id, 'MEMORY_NODE_DELETE_BAD_ARGS', 'node_id is required');
    requireNodeExists(loadSession(context), id, 'MEMORY_NODE_DELETE_NODE_NOT_FOUND');
    return { ok: true, simulated: true };
}

async function simulateMemoryLinkUpsert(args, context) {
    const links = Array.isArray(args?.links) ? args.links : null;
    if (!links || links.length === 0) {
        throw new ToolError(
            'memory_link_upsert: links must be a non-empty array.',
            'MEMORY_LINK_UPSERT_BAD_ARGS',
            'Provide at least one link entry with relation + target.',
        );
    }
    const sourceId = typeof args?.source_node_id === 'string' ? args.source_node_id.trim() : '';
    const sourceRef = typeof args?.source_ref === 'string' ? args.source_ref.trim() : '';
    if (!sourceId && !sourceRef) {
        throw new ToolError(
            'memory_link_upsert: source_node_id or source_ref is required.',
            'MEMORY_LINK_UPSERT_BAD_ARGS',
            'Specify the source node by id, or by ref if it was created in the same call.',
        );
    }
    for (const link of links) {
        if (!link || typeof link !== 'object') {
            throw new ToolError(
                'memory_link_upsert: link entries must be objects.',
                'MEMORY_LINK_UPSERT_BAD_ARGS',
                'Each link is { target_node_id|target_ref, relation, direction? }.',
            );
        }
        requireNonEmptyString(link.relation, 'MEMORY_LINK_UPSERT_BAD_ARGS', 'link.relation is required');
        const targetId = typeof link.target_node_id === 'string' ? link.target_node_id.trim() : '';
        const targetRef = typeof link.target_ref === 'string' ? link.target_ref.trim() : '';
        if (!targetId && !targetRef) {
            throw new ToolError(
                'memory_link_upsert: each link needs target_node_id or target_ref.',
                'MEMORY_LINK_UPSERT_BAD_ARGS',
                'Specify the target by id, or by ref if it was created in the same call.',
            );
        }
    }
    const session = loadSession(context);
    if (sourceId) requireNodeExists(session, sourceId, 'MEMORY_LINK_UPSERT_NODE_NOT_FOUND');
    for (const link of links) {
        const targetId = typeof link.target_node_id === 'string' ? link.target_node_id.trim() : '';
        if (targetId) requireNodeExists(session, targetId, 'MEMORY_LINK_UPSERT_NODE_NOT_FOUND');
    }
    return { ok: true, simulated: true, applied: links.length };
}

async function simulateMemoryLinkDelete(args, context) {
    const source = requireNonEmptyString(args?.source_node_id, 'MEMORY_LINK_DELETE_BAD_ARGS', 'source_node_id is required');
    const target = requireNonEmptyString(args?.target_node_id, 'MEMORY_LINK_DELETE_BAD_ARGS', 'target_node_id is required');
    requireNonEmptyString(args?.relation, 'MEMORY_LINK_DELETE_BAD_ARGS', 'relation is required');
    const session = loadSession(context);
    requireNodeExists(session, source, 'MEMORY_LINK_DELETE_NODE_NOT_FOUND');
    requireNodeExists(session, target, 'MEMORY_LINK_DELETE_NODE_NOT_FOUND');
    return { ok: true, simulated: true, removed: 1 };
}

async function simulateMemoryCompactNodes(args, context) {
    requireNonEmptyString(args?.type, 'MEMORY_COMPACT_NODES_BAD_ARGS', 'type is required');
    const ids = Array.isArray(args?.child_ids) ? args.child_ids : null;
    if (!ids || ids.length === 0) {
        throw new ToolError(
            'memory_compact_nodes: child_ids must be a non-empty array.',
            'MEMORY_COMPACT_NODES_BAD_ARGS',
            'List the ids of the child nodes to roll up.',
        );
    }
    requireNonEmptyString(args?.summary, 'MEMORY_COMPACT_NODES_BAD_ARGS', 'summary is required');
    const session = loadSession(context);
    for (const id of ids) {
        const cleanId = requireNonEmptyString(id, 'MEMORY_COMPACT_NODES_BAD_ARGS', 'child_ids entries must be non-empty strings');
        requireNodeExists(session, cleanId, 'MEMORY_COMPACT_NODES_NODE_NOT_FOUND');
    }
    return { ok: true, simulated: true, rollup_node_id: simulatedId('rollup') };
}

// ---------------------------------------------------------------------------
// Schemas (copied verbatim from orchestrator/loop-tools.js's
// registerTool('memory_*', ...) calls — only the `parameters` blob
// changes; the rest is wrapped by the registration loop below.)
// ---------------------------------------------------------------------------

const SCHEMAS = [
    {
        name: 'memory_list_candidates',
        mode: 'read',
        exec: execMemoryListCandidates,
        simulate: null,
        description: 'Enumerate the visible memory-graph candidate pool — the same pool the memory-graph\'s own recall LLM sees. Returns { candidates: [{ id, type, level, title, semanticDepth, <positionField> }] } in recency-first order, where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `seqTo: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only). Use this as the FIRST step of a recall pipeline.',
        parameters: {
            type: 'object',
            properties: {
                types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional node-type filter (e.g. ["event", "character_sheet"]).',
                },
                exclude_recent_messages: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Drop nodes inside the recent-N raw turns window so freshly-injected context is not duplicated.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'memory_edge_summary',
        mode: 'read',
        exec: execMemoryEdgeSummary,
        simulate: null,
        description: 'Get a node\'s edge_summary: { degree, relations: [{ relation, direction, count }], sample_neighbors: [{ id, type, title }] }. The native recall LLM uses this structural signal; reach for it when a brief is overkill and you just need "is this node a hub?".',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id from memory_list_candidates / memory_keyword_search / memory_find_by_name.',
                },
                edge_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relation-type filter.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Sample-neighbors cap (default 8).',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_node_brief',
        mode: 'read',
        exec: execMemoryNodeBrief,
        simulate: null,
        description: 'Get the canonical recall-side brief for one node: { id, title, summary, keyValues, rowValues, childCount, exposure, edgeSummary, alwaysInject, <positionField> }, where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `toSeq: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only). This is the SAME per-row format the memory-graph recall LLM sees. Returns { brief: null } when the node does not exist or is archived.',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id to fetch the brief for.',
                },
                include_edge_summary: {
                    type: 'boolean',
                    description: 'Include edge_summary in the brief (default true). Set false to save tokens when you only need the textual fields.',
                },
                edge_summary_limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'sample_neighbors cap inside the embedded edge_summary (default 8).',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_expand_seeds',
        mode: 'read',
        exec: execMemoryExpandSeeds,
        simulate: null,
        description: 'BFS-expand from seed ids along children + projected edges (default 1 hop). Returns { nodes: [{ id, type, level, title, <positionField> }] } for the union of seeds + reachable nodes, where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `seqTo: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only). Use SPARINGLY: when a brief is on-topic but compressed (high_only exposure, large childCount) and you need to surface specific children.',
        parameters: {
            type: 'object',
            properties: {
                seed_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Non-empty list of node ids to expand around.',
                },
                hops: {
                    type: 'integer',
                    minimum: 1,
                    description: 'BFS depth (default 1). Keep low; wide drilling wastes budget.',
                },
                edge_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relation-type filter for projected edges.',
                },
                include_children: {
                    type: 'boolean',
                    description: 'Include hierarchical children (rollup → leaves). Default true.',
                },
                exclude_internal: {
                    type: 'boolean',
                    description: 'Drop nodes reached only through contains / semantic_contains internal edges. Default false (mirrors native expandRouteCandidates).',
                },
            },
            required: ['seed_ids'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_schema',
        mode: 'read',
        exec: execMemorySchema,
        simulate: null,
        description: 'Return the active node-type schema: { types: [{ type, tableName, tableColumns, requiredColumns, primaryKeyColumns, forceUpdate, alwaysInject, editable, compressionMode }] }. This is the SAME schema_overview the native recall LLM sees. Read once at the start of a recall pass to understand which fields are key vs detail and which types use hierarchical compression.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'memory_keyword_search',
        mode: 'read',
        exec: execMemoryKeywordSearch,
        simulate: null,
        description: 'Token-intersection search across node title + projected columns. Always available (no profile required). Returns { results: [{ id, type, title, score, scoreMode: "keyword", <positionField> }] } sorted by score desc, where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `seqTo: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only). Use to locate existing nodes by name / keyword for dedup or relevance.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query — name, keyword, or short phrase.' },
                types: { type: 'array', items: { type: 'string' }, description: 'Optional type filter (e.g. ["character_sheet"]).' },
                k: { type: 'integer', minimum: 1, description: 'Max results (default 20).' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_vector_search',
        mode: 'read',
        exec: execMemoryVectorSearch,
        simulate: null,
        description: 'Semantic vector search. REQUIRES an embedding profile configured in memory-graph settings. Throws NO_EMBEDDING_PROFILE error when not configured — fall back to memory_keyword_search in that case. Returns { results: [{ id, type, title, score, scoreMode: "vector", <positionField> }] }, where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `seqTo: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only).',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Semantic query — descriptive phrase.' },
                types: { type: 'array', items: { type: 'string' } },
                k: { type: 'integer', minimum: 1 },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_find_by_name',
        mode: 'read',
        exec: execMemoryFindByName,
        simulate: null,
        description: 'Find existing nodes by name (case-insensitive substring match on title + primary key columns including aliases). Use BEFORE creating a character_sheet or location_state to verify the entity is not already in the graph. Returns { matches: [{ id, type, title, <positionField>, ... }] } — empty array if no match — where <positionField> is either `floorRange: {start, end}` — a chat-floor span in chat[] index coords when the node was written with floor anchoring enabled in its type schema; pass that range directly to `chat_read_range` to inspect the source dialogue — or `seqTo: <int>` for legacy nodes / types without floor anchoring (last-touched watermark only).',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name or alias to look up.' },
                types: { type: 'array', items: { type: 'string' }, description: 'Optional type filter.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_compaction_candidates',
        mode: 'read',
        exec: execMemoryCompactionCandidates,
        simulate: null,
        description: 'Returns the set of node groups currently eligible for hierarchical compaction at the given depth. { groups: [{ depth, childIds, fanIn }] }. Empty groups means no compaction warranted right now. Returns empty for types with compression.mode === "none".',
        parameters: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Type id (e.g. "event").' },
                depth: { type: 'integer', minimum: 0, description: 'Depth to scan (default 0).' },
            },
            required: ['type'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_node_create',
        mode: 'write',
        exec: execMemoryNodeCreate,
        simulate: simulateMemoryNodeCreate,
        description: 'Create a new semantic node in the memory graph. Use sparingly — first call memory_find_by_name to check for an existing entity. Returns { ok, id }.',
        parameters: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Node type from schema (e.g. "character_sheet").' },
                title: { type: 'string', description: 'Canonical short title.' },
                fields: { type: 'object', description: 'Field values per the type schema.' },
                links: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            target_node_id: { type: 'string' },
                            target_ref: { type: 'string' },
                            relation: { type: 'string' },
                            direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                        },
                        additionalProperties: false,
                    },
                    description: 'Optional: links to add at create time.',
                },
                ref: { type: 'string', description: 'Optional ref for same-call link targeting.' },
            },
            required: ['type', 'title'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_node_edit',
        mode: 'write',
        exec: execMemoryNodeEdit,
        simulate: simulateMemoryNodeEdit,
        description: 'Patch fields on an existing node. Use set_fields for sparse updates; clear_fields to drop specific columns. Returns { ok }.',
        parameters: {
            type: 'object',
            properties: {
                node_id: { type: 'string' },
                set_fields: { type: 'object', description: 'Field → new value map. Only these fields are changed.' },
                clear_fields: { type: 'array', items: { type: 'string' }, description: 'Field names to clear.' },
                title: { type: 'string', description: 'New title (optional).' },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_node_delete',
        mode: 'write',
        exec: execMemoryNodeDelete,
        simulate: simulateMemoryNodeDelete,
        description: 'Delete a node by id. Use only when the node is clearly wrong / duplicate / stale. Returns { ok }.',
        parameters: {
            type: 'object',
            properties: { node_id: { type: 'string' } },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_link_upsert',
        mode: 'write',
        exec: execMemoryLinkUpsert,
        simulate: simulateMemoryLinkUpsert,
        description: 'Add relation edges between nodes. Use canonical relation vocabulary only. Composite states allowed (multiple relations between same pair). Returns { ok, applied }.',
        parameters: {
            type: 'object',
            properties: {
                source_node_id: { type: 'string' },
                source_ref: { type: 'string', description: 'Alternative to source_node_id; references a same-call create.' },
                links: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            target_node_id: { type: 'string' },
                            target_ref: { type: 'string' },
                            relation: { type: 'string' },
                            direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                        },
                        additionalProperties: false,
                    },
                },
            },
            required: ['links'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_link_delete',
        mode: 'write',
        exec: execMemoryLinkDelete,
        simulate: simulateMemoryLinkDelete,
        description: 'Delete a relation edge between two nodes. Use when the relation in that direction is no longer in effect (relationship dissolved, alliance broken, debt repaid). Returns { ok, removed }. Do NOT delete to "replace" — composite multi-edge states are valid.',
        parameters: {
            type: 'object',
            properties: {
                source_node_id: { type: 'string' },
                target_node_id: { type: 'string' },
                relation: { type: 'string' },
                direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'], description: 'Default: bidirectional.' },
            },
            required: ['source_node_id', 'target_node_id', 'relation'],
            additionalProperties: false,
        },
    },
    {
        name: 'memory_compact_nodes',
        mode: 'write',
        exec: execMemoryCompactNodes,
        simulate: simulateMemoryCompactNodes,
        description: 'Compact a group of child nodes into one higher-tier rollup node. Children get reparented; semantic_contains edges added. Use after memory_compaction_candidates returns groups. Summary must follow the type\'s compression style standard. Returns { ok, rollup_node_id }.',
        parameters: {
            type: 'object',
            properties: {
                type: { type: 'string' },
                child_ids: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string', description: 'Telegraphic-style summary per the compression style standard.' },
                fields: { type: 'object', description: 'Optional additional fields beyond summary.' },
            },
            required: ['type', 'child_ids', 'summary'],
            additionalProperties: false,
        },
    },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const MEMORY_TOOL_NAMES = Object.freeze(SCHEMAS.map(s => s.name));

/**
 * Wrap an exec / simulate so it lazy-opens a memory-graph session on
 * first call against each ctx. The opened session is cached on the
 * module-level WeakMap; downstream `requireSession(ctx)` retrieves it
 * synchronously.
 */
function wrapExecWithSession(exec) {
    if (typeof exec !== 'function') return exec;
    return async function wrappedExec(args, ctx) {
        await getOrCreateOrchestrationSession(ctx);
        return exec(args, ctx);
    };
}

/**
 * Resolve the orchestrator's published extension API. Silent null when
 * orchestrator isn't installed, so the register / unregister functions
 * can no-op without throwing.
 */
function loadOrchestratorRegistrar() {
    const orch = Luker.getContext().getExtensionApi('orchestrator');
    if (!orch || typeof orch.registerOrchestrationTool !== 'function') return null;
    return orch;
}

/**
 * Publish memory-graph's 15 read + write tools into the orchestrator's
 * Layer-2 extension registry. Each entry's exec / simulate is wrapped
 * so a memory-graph session is opened (and cached) on first call.
 *
 * Silent no-op when orchestrator isn't loaded — memory-graph remains
 * independently usable.
 */
export function registerMemoryGraphOrchestrationTools() {
    const orch = loadOrchestratorRegistrar();
    if (!orch) return;
    for (const s of SCHEMAS) {
        orch.registerOrchestrationTool({
            name: s.name,
            description: s.description,
            parameters: s.parameters,
            mode: s.mode,
            exec: wrapExecWithSession(s.exec),
            simulate: s.simulate ? wrapExecWithSession(s.simulate) : undefined,
        });
    }
}

/**
 * Remove memory-graph's 15 tools from the orchestrator's Layer-2
 * registry. Silent no-op when orchestrator isn't loaded.
 */
export function unregisterMemoryGraphOrchestrationTools() {
    const orch = loadOrchestratorRegistrar();
    if (!orch || typeof orch.unregisterOrchestrationTool !== 'function') return;
    for (const name of MEMORY_TOOL_NAMES) {
        orch.unregisterOrchestrationTool(name);
    }
}

// ---------------------------------------------------------------------------
// Test-only exports
//
// Trimmers and the seq→chat translator are module-private helpers, but the
// floor-range translation behavior is the core of A5 and deserves direct
// unit coverage without spinning up a memory-graph session. Names are
// prefixed `_*ForTest` per the project convention.
// ---------------------------------------------------------------------------

export {
    trimCandidatePreview as _trimCandidatePreviewForTest,
    trimRankedPreview as _trimRankedPreviewForTest,
    trimExpandPreview as _trimExpandPreviewForTest,
    assistantSeqRangeToChatRange as _assistantSeqRangeToChatRangeForTest,
    SCHEMAS,
};
