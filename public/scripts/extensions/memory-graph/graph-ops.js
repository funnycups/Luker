/**
 * Pure graph-operation primitives for the memory-graph store.
 *
 * Sits one layer above primitives.js: depends on `LEVEL` / `normalizeText`,
 * never on persistence, UI, or ST internals. Every function here mutates
 * (or clones) only its store argument and returns plain data.
 *
 * All functions are intentionally side-effect-free except for the explicit
 * `store` mutations callers pass in. No event emission, no logging, no
 * floor-state coupling. That keeps this layer trivially testable and lets
 * persistence.js / main.js compose these primitives into higher-level
 * transactions.
 */

import { LEVEL, normalizeText } from './primitives.js';

/**
 * Deep-clone a single node down to a stable rollback-friendly shape.
 *
 * Used by:
 * - rollback history capture (so subsequent mutations can't bleed in)
 * - opLog snapshots replayed during memory-log rebuild
 * - `repairStoreAfterRollback` edge cleanup (via the edge variant)
 *
 * Returns null for non-objects so callers can `.filter(Boolean)`.
 *
 * @param {object|null|undefined} rawNode
 * @returns {object|null}
 */
export function cloneRollbackNodeSnapshot(rawNode) {
    if (!rawNode || typeof rawNode !== 'object') {
        return null;
    }
    return {
        id: String(rawNode.id || '').trim(),
        type: String(rawNode.type || 'unknown'),
        level: String(rawNode.level || LEVEL.SEMANTIC),
        title: normalizeText(rawNode.title || rawNode.id || ''),
        parentId: String(rawNode.parentId || '').trim(),
        childrenIds: Array.isArray(rawNode.childrenIds)
            ? rawNode.childrenIds.map(child => String(child || '').trim()).filter(Boolean)
            : [],
        fields: rawNode.fields && typeof rawNode.fields === 'object' && !Array.isArray(rawNode.fields)
            ? structuredClone(rawNode.fields)
            : {},
        semanticDepth: Number.isFinite(Number(rawNode.semanticDepth)) ? Number(rawNode.semanticDepth) : 0,
        semanticRollup: Boolean(rawNode.semanticRollup),
        // Node-local last-touched/visible-through index for sorting/filtering helpers; main replay uses opLog entry.seq.
        seqTo: Number.isFinite(Number(rawNode.seqTo)) ? Math.max(0, Math.floor(Number(rawNode.seqTo))) : undefined,
        archived: Boolean(rawNode.archived),
    };
}

/**
 * Edge counterpart to `cloneRollbackNodeSnapshot`. Drops self-edges and
 * blank endpoints; defaults the relation type to `'related'`.
 *
 * @param {object|null|undefined} rawEdge
 * @returns {{from: string, to: string, type: string} | null}
 */
export function cloneRollbackEdgeSnapshot(rawEdge) {
    if (!rawEdge || typeof rawEdge !== 'object') {
        return null;
    }
    const from = String(rawEdge.from || '').trim();
    const to = String(rawEdge.to || '').trim();
    if (!from || !to || from === to) {
        return null;
    }
    return {
        from,
        to,
        type: normalizeText(rawEdge.type || 'related') || 'related',
    };
}

/**
 * Stable string key for an edge using the U+241F unit-separator as a
 * delimiter that cannot collide with node ids or relation labels. Used
 * for de-duplication in `repairStoreAfterRollback` and for diffing edge
 * sets in rollback history.
 *
 * @param {object|null|undefined} edge
 * @returns {string} empty string for invalid edges
 */
export function getRollbackEdgeKey(edge) {
    const snapshot = cloneRollbackEdgeSnapshot(edge);
    if (!snapshot) {
        return '';
    }
    return `${snapshot.from}\u241F${snapshot.type}\u241F${snapshot.to}`;
}

/**
 * Idempotent edge insertion. Drops self-edges, dedupes on
 * `(from, to, type)` triple. Mutates `store.edges` in place.
 *
 * @param {{edges: Array}} store
 * @param {string} from
 * @param {string} to
 * @param {string} [type='related']
 */
export function addEdge(store, from, to, type = 'related') {
    if (!from || !to || from === to) {
        return;
    }

    const found = store.edges.find(edge => edge.from === from && edge.to === to && edge.type === type);
    if (found) {
        return;
    }

    store.edges.push({
        from,
        to,
        type,
    });
}

/**
 * Recursively delete a node from the store. By default also drops its
 * descendants; pass `recursive=false` to splice out a single node and
 * orphan its children. Removes the node from its parent's `childrenIds`
 * and prunes any incident edges.
 *
 * Mutates `store.nodes` and `store.edges` in place.
 *
 * @param {{nodes: Object, edges: Array}} store
 * @param {string} nodeId
 * @param {boolean} [recursive=true]
 */
export function dropNode(store, nodeId, recursive = true) {
    const node = store.nodes[nodeId];
    if (!node) {
        return;
    }

    if (recursive && Array.isArray(node.childrenIds)) {
        for (const childId of [...node.childrenIds]) {
            dropNode(store, childId, true);
        }
    }

    if (node.parentId && store.nodes[node.parentId]) {
        const parent = store.nodes[node.parentId];
        parent.childrenIds = parent.childrenIds.filter(id => id !== nodeId);
    }

    delete store.nodes[nodeId];
    store.edges = store.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
}

/**
 * Restore parent/child consistency and prune dangling edges after a
 * rollback (or any bulk node deletion). Walks every node twice:
 *
 * 1. Sanitize own `childrenIds` (drop blanks, self-refs, missing nodes)
 *    and clear `parentId` if the parent no longer exists.
 * 2. Re-sync each node's parent so the parent's `childrenIds` includes
 *    it (or clear `parentId` if the parent is malformed).
 *
 * Then rebuilds `store.edges` keeping only well-formed, deduped edges
 * whose endpoints are both still present.
 *
 * @param {{nodes: Object, edges: Array}} store
 */
export function repairStoreAfterRollback(store) {
    if (!store || typeof store !== 'object') {
        return;
    }
    const validNodeIds = new Set(Object.keys(store.nodes || {}));
    for (const node of Object.values(store.nodes || {})) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        node.childrenIds = Array.isArray(node.childrenIds)
            ? [...new Set(node.childrenIds.map(child => String(child || '').trim()).filter(child => child && child !== node.id && validNodeIds.has(child)))]
            : [];
        const parentId = String(node.parentId || '').trim();
        node.parentId = parentId && parentId !== node.id && validNodeIds.has(parentId) ? parentId : '';
    }
    for (const node of Object.values(store.nodes || {})) {
        if (!node || typeof node !== 'object' || !node.parentId) {
            continue;
        }
        const parent = store.nodes?.[node.parentId];
        if (!parent || typeof parent !== 'object') {
            node.parentId = '';
            continue;
        }
        if (!Array.isArray(parent.childrenIds)) {
            parent.childrenIds = [];
        }
        if (!parent.childrenIds.includes(node.id)) {
            parent.childrenIds.push(node.id);
        }
    }
    const nextEdges = [];
    const seen = new Set();
    for (const edge of Array.isArray(store.edges) ? store.edges : []) {
        const snapshot = cloneRollbackEdgeSnapshot(edge);
        const key = getRollbackEdgeKey(snapshot);
        if (!snapshot || !key || seen.has(key)) {
            continue;
        }
        if (!validNodeIds.has(snapshot.from) || !validNodeIds.has(snapshot.to)) {
            continue;
        }
        seen.add(key);
        nextEdges.push(snapshot);
    }
    store.edges = nextEdges;
}

/**
 * Total order on nodes by `seqTo` ascending, then by id for stability.
 * Nodes without a `seqTo` sort to the end. Used by recall pipelines and
 * compression scopes that need a deterministic timeline ordering.
 *
 * @param {{seqTo?: number, id?: string}} a
 * @param {{seqTo?: number, id?: string}} b
 * @returns {number}
 */
export function compareNodesByTimeline(a, b) {
    const aTo = Number(a?.seqTo ?? Number.MAX_SAFE_INTEGER);
    const bTo = Number(b?.seqTo ?? Number.MAX_SAFE_INTEGER);
    if (aTo !== bTo) {
        return aTo - bTo;
    }
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * Highest `seqTo` among non-archived semantic nodes in the store.
 *
 * Used as one of three coverage signals (alongside `appliedSeqTo` and
 * `loggedSeqTo`) to compute the global covered-seq watermark. A live
 * semantic node always extends coverage at least to its own `seqTo`,
 * even if metadata fields lost their counter values.
 *
 * @param {{nodes?: Object}|null|undefined} store
 * @returns {number}
 */
export function getSemanticCoverageSeq(store) {
    const nodes = Object.values(store?.nodes || {})
        .filter(node => node && !node.archived && node.level === LEVEL.SEMANTIC);
    if (nodes.length === 0) {
        return 0;
    }
    const maxSeq = nodes.reduce((maxSeq, node) => {
        const seq = Number(node?.seqTo ?? 0);
        if (!Number.isFinite(seq)) {
            return maxSeq;
        }
        return Math.max(maxSeq, Math.max(0, Math.floor(seq)));
    }, 0);
    return Number.isFinite(maxSeq) ? maxSeq : 0;
}
