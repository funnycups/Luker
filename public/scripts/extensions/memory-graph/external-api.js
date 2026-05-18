// SPDX-License-Identifier: AGPL-3.0-or-later
//
// External API for memory-graph. Read-only queries safe for other extensions
// (orchestrator loop mode and similar) to import.
//
// Contracts:
//   - All exports are READ-ONLY. Do not mutate the store.
//   - The caller is responsible for loading/passing the store. This module
//     never triggers store loading.
//   - When memory-graph is disabled or its store is unavailable, the queries
//     return empty results rather than throwing. Callers may additionally
//     short-circuit before importing/calling these helpers.
//
// Reserved for future expansion (NOT in MVP):
//   - searchNodesHybrid(store, query, options)  // calls runHybridRecall, requires vector config
//   - hasNode(store, id) -> boolean              // existence check
//   - findNodesByEntity(store, entityName)       // browse by entity
//   - getNeighbors(store, id, {edgeTypes})       // standalone neighbor fetch with filtering

import { compareNodesByTimeline } from './graph-ops.js';

// ---------------------------------------------------------------------------
// Currently-injected node id capture
// ---------------------------------------------------------------------------
//
// memory-graph's main flow records the id sets that get injected into the
// main model context for the current chat turn here. Other extensions read
// the union as `excludeIds` to avoid surfacing nodes the model already has,
// and may subscribe via `addInjectionChangedListener` to be notified each
// time the snapshot updates.

let injectedState = {
    alwaysInjectIds: new Set(),
    recallSelectedIds: new Set(),
};

// Most-recent visibleIds snapshot recorded alongside the injected id sets.
// Defaults to an empty Set until callers begin supplying it (Phase 3).
let _lastVisibleIds = new Set();

// Subscribers to injection-changed events. Each entry is a callback that
// receives the snapshot object built by `__recordInjectedNodeIds`. Listener
// callbacks are wrapped in try/catch so one bad listener cannot block others.
const _changeListeners = new Set();

function toIdSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) {
        return new Set(value);
    }
    if (typeof value[Symbol.iterator] === 'function') {
        const out = new Set();
        for (const item of value) {
            if (item === undefined || item === null) continue;
            const id = String(item).trim();
            if (id) out.add(id);
        }
        return out;
    }
    return new Set();
}

/**
 * Returns the node id sets that memory-graph's main flow has currently injected
 * into the main model context for this chat. Three classes:
 *   - alwaysInjectIds: nodes flagged alwaysInject (persistent injection)
 *   - recallSelectedIds: nodes selected by this turn's recall pipeline
 *   - visibleIds: nodes inside the active recall/visibility window (may be
 *     empty until a caller starts supplying them; see Phase 3)
 *
 * Callers (e.g. loop mode's memory.search dedup) typically union the two id
 * sets and pass the result as `excludeIds` to `searchNodesLexical` /
 * `listRecentNodes`.
 *
 * @param {object} _context unused at MVP; reserved for chat-scoped state
 * @returns {{alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}}
 */
export function getCurrentlyInjectedNodeIds(_context) {
    return {
        alwaysInjectIds: new Set(injectedState.alwaysInjectIds),
        recallSelectedIds: new Set(injectedState.recallSelectedIds),
        visibleIds: new Set(_lastVisibleIds),
    };
}

/**
 * Spec §4.1 InjectionState alias. Returns the same shape as
 * `getCurrentlyInjectedNodeIds` — defensive copies of the three id Sets that
 * describe the current main-flow injection decision.
 *
 * Kept as a separate export so read-api consumers can program against the
 * spec name without worrying about future divergence between the two.
 *
 * @param {object} _context unused at MVP; reserved for chat-scoped state
 * @returns {{alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}}
 */
export function getMemoryGraphInjectionState(_context) {
    return getCurrentlyInjectedNodeIds(_context);
}

/**
 * Internal: invoked by main.js when the main-flow injection decision settles
 * (recall has resolved selectedNodes + alwaysInjectNodes). All three inputs
 * may be Sets, arrays, or any iterable of id strings; each defaults to an
 * empty Set when omitted.
 *
 * After the state is updated, any callbacks registered via
 * `addInjectionChangedListener` are invoked once with a frozen snapshot
 * containing defensive copies of the three id Sets. Listener errors are
 * caught and logged so one bad subscriber cannot block the others.
 *
 * @param {{alwaysInjectIds?: Iterable<string>, recallSelectedIds?: Iterable<string>, visibleIds?: Iterable<string>}} payload
 */
export function __recordInjectedNodeIds(payload) {
    injectedState = {
        alwaysInjectIds: toIdSet(payload?.alwaysInjectIds),
        recallSelectedIds: toIdSet(payload?.recallSelectedIds),
    };
    _lastVisibleIds = toIdSet(payload?.visibleIds);

    // Build a frozen snapshot for listeners. Object.freeze only seals the
    // wrapper object — the inner Sets stay mutable. That is intentional:
    // each listener gets its own defensive Set copies, so accidental mutation
    // by one listener cannot leak into others.
    const snapshot = Object.freeze({
        alwaysInjectIds: new Set(injectedState.alwaysInjectIds),
        recallSelectedIds: new Set(injectedState.recallSelectedIds),
        visibleIds: new Set(_lastVisibleIds),
    });

    for (const cb of _changeListeners) {
        try {
            cb(snapshot);
        } catch (err) {
            try {
                console.warn('[memory-graph/external-api] injection-changed listener threw:', err);
            } catch (_) { /* logger itself failed; ignore */ }
        }
    }
}

/**
 * Registers a callback that fires whenever `__recordInjectedNodeIds` updates
 * the injection snapshot. The callback receives a frozen object containing
 * defensive copies of `{ alwaysInjectIds, recallSelectedIds, visibleIds }`.
 *
 * Returns an idempotent unsubscribe function — calling it more than once is
 * safe and returns no value either way.
 *
 * @param {(snapshot: {alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}) => void} cb
 * @returns {() => void} unsubscribe
 */
export function addInjectionChangedListener(cb) {
    if (typeof cb !== 'function') {
        return () => { /* no-op for invalid input */ };
    }
    _changeListeners.add(cb);
    return () => { _changeListeners.delete(cb); };
}

/**
 * Removes a previously registered injection-changed listener. Returns true
 * if the listener was present and removed, false otherwise — matches the
 * semantics of `Set.prototype.delete`.
 *
 * @param {Function} cb the callback originally passed to `addInjectionChangedListener`
 * @returns {boolean}
 */
export function removeInjectionChangedListener(cb) {
    return _changeListeners.delete(cb);
}

/** @internal test helper: set a snapshot directly */
export function __setInjectedForTest(payload) {
    __recordInjectedNodeIds(payload);
}

/** @internal test helper: clear the snapshot back to empty sets */
export function __resetInjectedForTest() {
    injectedState = {
        alwaysInjectIds: new Set(),
        recallSelectedIds: new Set(),
    };
}

/**
 * @internal test helper: drop every registered injection-changed listener
 * and reset the cached visibleIds snapshot to an empty Set.
 */
export function __resetListenersForTest() {
    _changeListeners.clear();
    _lastVisibleIds = new Set();
}

/**
 * @internal test helper: overwrite the cached visibleIds snapshot directly,
 * bypassing `__recordInjectedNodeIds`. Useful when a test wants to assert
 * `getCurrentlyInjectedNodeIds` / `getMemoryGraphInjectionState` exposes the
 * visible-ids field without firing change listeners.
 *
 * @param {Iterable<string>} ids
 */
export function __setVisibleIdsForTest(ids) {
    _lastVisibleIds = toIdSet(ids);
}

// ---------------------------------------------------------------------------
// Read-only node queries (Task 2)
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 300;

function makePreview(text) {
    const s = String(text || '');
    return s.length <= PREVIEW_MAX ? s : s.slice(0, PREVIEW_MAX);
}

/**
 * Best-effort canonical text for a node, drawn from the same fields the
 * recall pipeline scans (`node.title`, `fields.title`/`fields.name` first;
 * then `fields.summary`, `fields.state`, `fields.traits`, `fields.constraint`,
 * `fields.key_sentences`, `fields.aliases`). Joined with spaces so a single
 * substring search hits any of them.
 *
 * @param {object} node
 * @returns {string}
 */
function nodeText(node) {
    if (!node || typeof node !== 'object') return '';
    const fields = (node.fields && typeof node.fields === 'object') ? node.fields : {};
    const candidates = [
        node.title,
        fields.title,
        fields.name,
        fields.summary,
        fields.state,
        fields.traits,
        fields.constraint,
        fields.key_sentences,
        fields.aliases,
    ];
    return candidates
        .map(v => (v === undefined || v === null) ? '' : String(v))
        .filter(s => s.length > 0)
        .join(' ');
}

function nodeTime(node) {
    if (!node || typeof node !== 'object') return undefined;
    const seq = Number(node.seqTo);
    if (Number.isFinite(seq)) return seq;
    return undefined;
}

function iterateStoreNodes(store) {
    const nodes = store?.nodes;
    if (!nodes) return [];
    if (nodes instanceof Map) return Array.from(nodes.values());
    if (typeof nodes === 'object') return Object.values(nodes);
    return [];
}

/**
 * Lexical / substring search across store nodes. Case-insensitive, scans
 * the union of title + key field strings for each node. Does NOT depend on
 * vector embedding configuration (that's deliberate — keeps the function
 * usable from extensions without vector setup).
 *
 * Skips archived nodes. Skips ids in `excludeIds`. Stops once `limit`
 * matches are accumulated (insertion order).
 *
 * @param {object} store memory-graph store; `store.nodes` is the node map
 * @param {string} query
 * @param {{limit?: number, excludeIds?: Set<string>|Iterable<string>}} [options]
 * @returns {{nodes: Array<{id: string, preview: string, type?: string, time?: number}>}}
 */
export function searchNodesLexical(store, query, options = {}) {
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
        ? Math.floor(Number(options.limit))
        : 5;
    const excludeIds = options.excludeIds instanceof Set
        ? options.excludeIds
        : toIdSet(options.excludeIds);
    if (!query || !String(query).trim()) return { nodes: [] };

    const q = String(query).toLowerCase();
    const matches = [];
    for (const node of iterateStoreNodes(store)) {
        if (!node || node.archived) continue;
        const id = String(node.id || '').trim();
        if (!id) continue;
        if (excludeIds.has(id)) continue;
        const text = nodeText(node);
        if (!text) continue;
        if (!text.toLowerCase().includes(q)) continue;
        matches.push({
            id,
            preview: makePreview(text),
            type: node.type ?? undefined,
            time: nodeTime(node),
        });
        if (matches.length >= limit) break;
    }
    return { nodes: matches };
}

/**
 * Browse the most recent nodes in time-descending order (uses
 * `compareNodesByTimeline` from graph-ops, then reverses). Skips archived
 * nodes and any id in `excludeIds`.
 *
 * @param {object} store
 * @param {{limit?: number, excludeIds?: Set<string>|Iterable<string>}} [options]
 * @returns {{nodes: Array<{id: string, preview: string, time?: number, type?: string}>}}
 */
export function listRecentNodes(store, options = {}) {
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
        ? Math.floor(Number(options.limit))
        : 10;
    const excludeIds = options.excludeIds instanceof Set
        ? options.excludeIds
        : toIdSet(options.excludeIds);

    const filtered = [];
    for (const node of iterateStoreNodes(store)) {
        if (!node || node.archived) continue;
        const id = String(node.id || '').trim();
        if (!id) continue;
        if (excludeIds.has(id)) continue;
        filtered.push(node);
    }
    filtered.sort((a, b) => compareNodesByTimeline(b, a)); // reverse for newest-first
    return {
        nodes: filtered.slice(0, limit).map(node => ({
            id: String(node.id),
            preview: makePreview(nodeText(node)),
            type: node.type ?? undefined,
            time: nodeTime(node),
        })),
    };
}

/**
 * Fetch a node by id, optionally including direct neighbors with edge metadata.
 * Neighbors are returned as `{id, edgeType, relation?}` — full neighbor
 * payloads are NOT inlined; callers fetch them with another `getNodeById`
 * call when needed.
 *
 * @param {object} store
 * @param {string} id
 * @param {{includeNeighbors?: boolean}} [options]
 * @returns {{node: object, neighbors: Array<{id: string, edgeType?: string, relation?: string}>} | null}
 */
export function getNodeById(store, id, options = {}) {
    const wantNeighbors = options.includeNeighbors !== false;
    if (!store || !store.nodes) return null;
    const key = String(id || '').trim();
    if (!key) return null;
    let node = null;
    if (store.nodes instanceof Map) {
        node = store.nodes.get(key) || null;
    } else if (typeof store.nodes === 'object') {
        node = store.nodes[key] || null;
    }
    if (!node) return null;
    if (!wantNeighbors) return { node, neighbors: [] };

    const neighbors = [];
    const edges = Array.isArray(store.edges) ? store.edges : [];
    for (const edge of edges) {
        if (!edge) continue;
        if (edge.from === key) {
            neighbors.push({
                id: String(edge.to ?? ''),
                edgeType: edge.type ?? undefined,
                relation: edge.relation ?? undefined,
            });
        } else if (edge.to === key) {
            neighbors.push({
                id: String(edge.from ?? ''),
                edgeType: edge.type ?? undefined,
                relation: edge.relation ?? undefined,
            });
        }
    }
    return { node, neighbors };
}
