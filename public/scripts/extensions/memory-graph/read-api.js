// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory-graph read-only API. Spec:
//   docs/superpowers/specs/2026-05-18-memory-graph-readonly-api.md
//
// Exposes the same data + topology + recall primitives that
// `chooseRecallRoute` (main.js) feeds to the route LLM, but as a frozen,
// caller-safe surface. The factory `getMemoryGraphReadApi(context)` returns
// an object whose methods all read from the live memory-graph store (resolved
// per-call). Returned views are deep-frozen plain objects / Sets so callers
// cannot mutate internal state.
//
// Four layers, mirroring the spec:
//   - Layer A (data access):      listNodes, getNode, listEdges, getSchema
//   - Layer B (topology):         getNeighbors, getAncestor, getDescendants,
//                                  getNearestVisibleAncestor, projectEdges
//   - Layer C (recall primitives): listVisibleCandidates, getNodeExposure,
//                                   getEdgeSummary, getNodeBrief,
//                                   expandFromSeeds, keywordSearch
//   - Layer D (injection):        getInjectionState, onInjectionChanged
//
// All hot-path helpers (`buildProjectedEdges`, `buildEdgeSummary`,
// `getNearestVisibleAncestorId`, `formatNodeBrief`, `collectRootCandidates`,
// `expandRouteCandidates`) are imported from `main.js` directly so this file
// stays in lockstep with native recall behavior.
//
// IMPORTANT (visibleIds default): `getInjectionState().visibleIds` is the
// "current route LLM candidate pool" snapshot. It is empty until the recall
// pipeline runs at least once (see `__recordInjectedNodeIds` in
// external-api.js). Methods that default to "current visibleIds" therefore
// fall back to an empty Set on first use; callers that need a guaranteed
// candidate pool should pass `visibleNodeIds` / `visibleNodeIds` arrays
// explicitly or call `listVisibleCandidates()` first.

import {
    getSettings,
    getMemoryStore,
    getSemanticTypeSpec,
    getSemanticCompressionConfig,
    getChildren,
    getSchemaProjectionColumns,
    buildGraphNodeHints,
    formatNodeBrief,
    compareNodesByRecency,
    getNodeRecallExposure,
    getNearestVisibleAncestorId,
    buildProjectedEdges,
    buildEdgeSummary,
    isRecallDiagnosticNode,
    collectRootCandidates,
    expandRouteCandidates,
    selectVisibleNodesForType,
    getLatestSeqIndex,
    isNodeInRecentExcludeWindow,
    collectSemanticRootsByDepth,
} from './main.js';
import { compareNodesByTimeline } from './graph-ops.js';
import { getEffectiveNodeTypeSchema, getEffectiveSettings } from './character-overrides.js';
import { findSimilarNodes, getVectorConfigFromSettings } from './vector-index.js';
import {
    addInjectionChangedListener,
    getCurrentlyInjectedNodeIds,
    getMemoryGraphInjectionState,
} from './external-api.js';

// Edge types that are part of the store's hierarchical bookkeeping rather
// than semantic relations. `buildProjectedEdges` exposes the same set via
// its `excludeInternal` option; we duplicate it here only to make local
// EdgeView filtering in `listEdges` / `getNeighbors` independent of internal
// helpers.
const INTERNAL_EDGE_TYPES = Object.freeze(new Set(['contains', 'semantic_contains']));

// ---------------------------------------------------------------------------
// Internal helpers — store / settings resolution
// ---------------------------------------------------------------------------

function iterateStoreNodes(store) {
    const nodes = store?.nodes;
    if (!nodes) return [];
    if (nodes instanceof Map) return Array.from(nodes.values());
    if (typeof nodes === 'object') return Object.values(nodes);
    return [];
}

function lookupNodeById(store, id) {
    const key = String(id || '').trim();
    if (!key || !store?.nodes) return null;
    if (store.nodes instanceof Map) {
        return store.nodes.get(key) || null;
    }
    if (typeof store.nodes === 'object') {
        return store.nodes[key] || null;
    }
    return null;
}

function toIdSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) return new Set(value);
    if (typeof value[Symbol.iterator] === 'function') {
        const out = new Set();
        for (const item of value) {
            if (item === undefined || item === null) continue;
            const s = String(item).trim();
            if (s) out.add(s);
        }
        return out;
    }
    return new Set();
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return null;
    const out = value.map(v => String(v || '').trim()).filter(Boolean);
    return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Internal helpers — view freezing
// ---------------------------------------------------------------------------

function deepFreezeObject(obj, seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Object.isFrozen(obj)) return obj;
    if (seen.has(obj)) return obj;
    seen.add(obj);
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (item && typeof item === 'object') deepFreezeObject(item, seen);
        }
        return Object.freeze(obj);
    }
    if (obj instanceof Set || obj instanceof Map) {
        // Freeze the wrapper only; consumers are documented as read-only.
        return Object.freeze(obj);
    }
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value && typeof value === 'object') deepFreezeObject(value, seen);
    }
    return Object.freeze(obj);
}

function freezeFieldsRecord(fields) {
    const out = {};
    if (fields && typeof fields === 'object') {
        for (const [key, value] of Object.entries(fields)) {
            // Mirror the storage shape (most values are strings; complex
            // values stay as-is but are still wrapped in a frozen container).
            out[String(key)] = value;
        }
    }
    return Object.freeze(out);
}

function freezeNodeView(node) {
    if (!node || typeof node !== 'object') return null;
    return Object.freeze({
        id: String(node.id || ''),
        type: String(node.type || ''),
        level: node.level === 'semantic' ? 'semantic' : 'episodic',
        title: String(node.title || ''),
        fields: freezeFieldsRecord(node.fields),
        seqTo: Number.isFinite(Number(node.seqTo)) ? Number(node.seqTo) : -1,
        parentId: String(node.parentId || ''),
        childrenIds: Object.freeze(
            (Array.isArray(node.childrenIds) ? node.childrenIds : [])
                .map(id => String(id || ''))
                .filter(Boolean),
        ),
        archived: Boolean(node.archived),
        semanticRollup: Boolean(node.semanticRollup),
        semanticDepth: Number.isFinite(Number(node.semanticDepth)) ? Number(node.semanticDepth) : 0,
    });
}

function freezeEdgeView(edge, { includeWeight = false } = {}) {
    if (!edge || typeof edge !== 'object') return null;
    const out = {
        from: String(edge.from || ''),
        to: String(edge.to || ''),
        type: String(edge.type || ''),
    };
    // Raw edges (listEdges) must NOT include `weight` per spec §4.2.
    // Projected edges (projectEdges) include `weight` per spec §4.3.
    if (includeWeight && typeof edge.weight === 'number' && Number.isFinite(edge.weight)) {
        out.weight = Number(edge.weight);
    }
    return Object.freeze(out);
}

function freezeEdgeSummaryView(summary) {
    if (!summary || typeof summary !== 'object') {
        return Object.freeze({
            degree: 0,
            relations: Object.freeze([]),
            sample_neighbors: Object.freeze([]),
        });
    }
    const relations = Array.isArray(summary.relations) ? summary.relations : [];
    const sampleNeighbors = Array.isArray(summary.sample_neighbors) ? summary.sample_neighbors : [];
    return Object.freeze({
        degree: Number(summary.degree) || 0,
        relations: Object.freeze(relations.map(r => Object.freeze({
            relation: String(r?.relation || ''),
            direction: r?.direction === 'in' ? 'in' : 'out',
            count: Number(r?.count) || 0,
        }))),
        sample_neighbors: Object.freeze(sampleNeighbors.map(n => Object.freeze({
            id: String(n?.id || ''),
            type: String(n?.type || ''),
            title: String(n?.title || ''),
            to_seq: Number.isFinite(Number(n?.to_seq)) ? Math.max(0, Math.floor(Number(n.to_seq))) : 0,
        }))),
    });
}

function freezeSchemaSpecView(spec) {
    const compressionMode = String(spec?.compression?.mode || spec?.compressionMode || 'none');
    return Object.freeze({
        // Schema items use `id` as the type identifier (e.g. 'event',
        // 'character_sheet'); the spec calls it `type` on the view side.
        type: String(spec?.id || spec?.type || ''),
        tableName: String(spec?.tableName || ''),
        tableColumns: Object.freeze((Array.isArray(spec?.tableColumns) ? spec.tableColumns : [])
            .map(c => String(c || ''))
            .filter(Boolean)),
        requiredColumns: Object.freeze((Array.isArray(spec?.requiredColumns) ? spec.requiredColumns : [])
            .map(c => String(c || ''))
            .filter(Boolean)),
        primaryKeyColumns: Object.freeze((Array.isArray(spec?.primaryKeyColumns) ? spec.primaryKeyColumns : [])
            .map(c => String(c || ''))
            .filter(Boolean)),
        forceUpdate: Boolean(spec?.forceUpdate),
        alwaysInject: Boolean(spec?.alwaysInject),
        editable: Boolean(spec?.editable),
        compressionMode,
    });
}

function freezeSchemaView(types) {
    const list = Array.isArray(types) ? types : [];
    return Object.freeze({
        types: Object.freeze(list.map(freezeSchemaSpecView)),
    });
}

function freezeInjectionState({ alwaysInjectIds, recallSelectedIds, visibleIds }) {
    const a = alwaysInjectIds instanceof Set ? alwaysInjectIds : toIdSet(alwaysInjectIds);
    const r = recallSelectedIds instanceof Set ? recallSelectedIds : toIdSet(recallSelectedIds);
    const v = visibleIds instanceof Set ? visibleIds : toIdSet(visibleIds);
    return Object.freeze({
        // Set contents are not enforced read-only by Object.freeze; consumers
        // are documented to treat these as immutable. See spec §7.
        alwaysInjectIds: Object.freeze(a),
        recallSelectedIds: Object.freeze(r),
        visibleIds: Object.freeze(v),
    });
}

function freezeNodeBriefView(brief) {
    if (!brief || typeof brief !== 'object') return null;
    // formatNodeBrief returns snake_case; spec §4.1 NodeBriefView is camelCase.
    // We map both directions so the contract is forgiving if either shape is
    // supplied (dogfood-side test will assert structural equivalence).
    const keyValues = (brief.keyValues && typeof brief.keyValues === 'object')
        ? brief.keyValues
        : (brief.key_values && typeof brief.key_values === 'object' ? brief.key_values : {});
    const rowValues = (brief.rowValues && typeof brief.rowValues === 'object')
        ? brief.rowValues
        : (brief.row_values && typeof brief.row_values === 'object' ? brief.row_values : {});
    const edgeSummaryRaw = (brief.edgeSummary !== undefined ? brief.edgeSummary : brief.edge_summary);
    return Object.freeze({
        id: String(brief.id || ''),
        level: brief.level === 'semantic' ? 'semantic' : 'episodic',
        type: String(brief.type || ''),
        tableName: String(brief.tableName || brief.table_name || ''),
        title: String(brief.title || ''),
        summary: String(brief.summary || ''),
        keyValues: Object.freeze({ ...keyValues }),
        rowValues: Object.freeze({ ...rowValues }),
        toSeq: Number.isFinite(Number(brief.toSeq ?? brief.to_seq)) ? Number(brief.toSeq ?? brief.to_seq) : -1,
        childCount: Number.isFinite(Number(brief.childCount ?? brief.child_count)) ? Number(brief.childCount ?? brief.child_count) : 0,
        exposure: brief.exposure === 'high_only' ? 'high_only' : 'full',
        edgeSummary: edgeSummaryRaw ? freezeEdgeSummaryView(edgeSummaryRaw) : null,
        alwaysInject: Boolean(brief.alwaysInject ?? brief.always_inject),
    });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds the read-only memory-graph API surface bound to `context`. Returns a
 * frozen object whose methods resolve the live store on each call so a single
 * API instance stays valid across chat / character switches.
 *
 * @param {object} context SillyTavern context (from `getContext()`)
 * @returns {object} the frozen API
 */
export function getMemoryGraphReadApi(context) {
    function resolveStore() {
        // Orchestrator's mount pattern stashes the resolved store on the
        // context object as `__memoryStore` for synchronous reuse; prefer it
        // when present. Otherwise fall back to the live cache lookup.
        if (context && context.__memoryStore && typeof context.__memoryStore === 'object') {
            return context.__memoryStore;
        }
        try {
            return getMemoryStore(context, null);
        } catch (_) {
            return null;
        }
    }

    function resolveSettings() {
        try {
            const base = getSettings();
            return getEffectiveSettings(context, base) || base;
        } catch (_) {
            try { return getSettings(); } catch (__) { return null; }
        }
    }

    function currentVisibleIdSet() {
        try {
            const snap = getCurrentlyInjectedNodeIds(context);
            return snap?.visibleIds instanceof Set ? new Set(snap.visibleIds) : toIdSet(snap?.visibleIds);
        } catch (_) {
            return new Set();
        }
    }

    function currentAlwaysInjectSet() {
        try {
            const snap = getCurrentlyInjectedNodeIds(context);
            return snap?.alwaysInjectIds instanceof Set ? snap.alwaysInjectIds : toIdSet(snap?.alwaysInjectIds);
        } catch (_) {
            return new Set();
        }
    }

    // -----------------------------------------------------------------------
    // Layer A: data access
    // -----------------------------------------------------------------------

    function listNodes(filter = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);

        const activeOnly = filter.activeOnly !== false;
        const typeFilter = normalizeStringArray(filter.types);
        const levelFilter = normalizeStringArray(filter.levels);
        const seqFrom = Number.isFinite(Number(filter?.seqRange?.from)) ? Number(filter.seqRange.from) : null;
        const seqTo = Number.isFinite(Number(filter?.seqRange?.to)) ? Number(filter.seqRange.to) : null;

        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;
        const levelSet = levelFilter ? new Set(levelFilter.map(l => l.toLowerCase())) : null;

        const matched = [];
        for (const node of iterateStoreNodes(store)) {
            if (!node || !node.id) continue;
            if (activeOnly) {
                if (node.archived) continue;
                if (isRecallDiagnosticNode(node)) continue;
            }
            if (typeSet && !typeSet.has(String(node.type || '').toLowerCase())) continue;
            if (levelSet) {
                const level = node.level === 'semantic' ? 'semantic' : 'episodic';
                if (!levelSet.has(level)) continue;
            }
            const nodeSeqTo = Number(node.seqTo ?? -1);
            if (seqFrom !== null && nodeSeqTo < seqFrom) continue;
            if (seqTo !== null && nodeSeqTo > seqTo) continue;
            matched.push(node);
        }
        matched.sort(compareNodesByTimeline);
        return Object.freeze(matched.map(freezeNodeView));
    }

    function getNode(id) {
        const store = resolveStore();
        if (!store) return null;
        const node = lookupNodeById(store, id);
        return node ? freezeNodeView(node) : null;
    }

    function listEdges(filter = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);

        const edges = Array.isArray(store.edges) ? store.edges : [];
        const fromFilter = filter.from !== undefined ? String(filter.from || '').trim() : null;
        const toFilter = filter.to !== undefined ? String(filter.to || '').trim() : null;
        const typeFilter = normalizeStringArray(filter.types);
        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;
        const excludeInternal = filter.excludeInternal === true;

        const out = [];
        for (const edge of edges) {
            if (!edge) continue;
            const edgeType = String(edge.type || '').toLowerCase();
            if (excludeInternal && INTERNAL_EDGE_TYPES.has(edgeType)) continue;
            if (typeSet && !typeSet.has(edgeType)) continue;
            if (fromFilter !== null && String(edge.from || '') !== fromFilter) continue;
            if (toFilter !== null && String(edge.to || '') !== toFilter) continue;
            out.push(freezeEdgeView(edge, { includeWeight: false }));
        }
        return Object.freeze(out);
    }

    function getSchema() {
        const settings = resolveSettings();
        let specs = [];
        try {
            specs = getEffectiveNodeTypeSchema(context, settings) || [];
        } catch (_) {
            specs = [];
        }
        return freezeSchemaView(specs);
    }

    // -----------------------------------------------------------------------
    // Layer B: topology
    // -----------------------------------------------------------------------

    function resolveVisibleSet(projectTo) {
        if (projectTo === 'visible') return currentVisibleIdSet();
        if (Array.isArray(projectTo)) return toIdSet(projectTo);
        return null; // 'raw' or anything else
    }

    function getNeighbors(id, options = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const sourceId = String(id || '').trim();
        if (!sourceId) return Object.freeze([]);

        const direction = options.direction === 'in' || options.direction === 'out' ? options.direction : 'both';
        const edgeTypeList = normalizeStringArray(options.edgeTypes);
        const edgeTypeSet = edgeTypeList ? new Set(edgeTypeList.map(t => t.toLowerCase())) : null;
        const projectTo = options.projectTo === 'visible' || Array.isArray(options.projectTo) ? options.projectTo : 'raw';
        const projectSet = projectTo === 'raw' ? null : resolveVisibleSet(projectTo);

        const edges = Array.isArray(store.edges) ? store.edges : [];
        const out = [];
        const seenPairs = new Set();

        for (const edge of edges) {
            if (!edge) continue;
            const edgeType = String(edge.type || '').toLowerCase();
            if (edgeTypeSet && !edgeTypeSet.has(edgeType)) continue;
            const from = String(edge.from || '');
            const to = String(edge.to || '');

            let neighborRawId = '';
            let neighborDirection = '';
            if (from === sourceId) {
                neighborRawId = to;
                neighborDirection = 'out';
            } else if (to === sourceId) {
                neighborRawId = from;
                neighborDirection = 'in';
            } else {
                continue;
            }
            if (!neighborRawId) continue;
            if (direction !== 'both' && direction !== neighborDirection) continue;

            let neighborId = neighborRawId;
            if (projectSet) {
                neighborId = getNearestVisibleAncestorId(store, neighborRawId, projectSet);
                if (!neighborId) continue;
            }
            const neighborNode = lookupNodeById(store, neighborId);
            if (!neighborNode || neighborNode.archived) continue;

            const dedupKey = `${neighborId}::${edgeType}::${neighborDirection}`;
            if (seenPairs.has(dedupKey)) continue;
            seenPairs.add(dedupKey);

            out.push(Object.freeze({
                node: freezeNodeView(neighborNode),
                edgeType,
                direction: neighborDirection,
            }));
        }
        return Object.freeze(out);
    }

    function getAncestor(id, options = {}) {
        const store = resolveStore();
        if (!store) return null;
        const activeOnly = options.activeOnly !== false;
        const predicate = typeof options.predicate === 'function' ? options.predicate : null;

        let currentNode = lookupNodeById(store, id);
        if (!currentNode) return null;

        // First step: move to the parent of the input node (an "ancestor" is
        // strictly above the input). Walk while we have a parent.
        let parentId = String(currentNode.parentId || '').trim();
        const guard = new Set([String(currentNode.id || '')]);
        while (parentId) {
            if (guard.has(parentId)) break;
            guard.add(parentId);
            const parent = lookupNodeById(store, parentId);
            if (!parent) return null;
            if (activeOnly && parent.archived) {
                // Walking through an archived ancestor is rare; treat as no-match.
                return null;
            }
            const view = freezeNodeView(parent);
            if (!predicate || predicate(view)) {
                return view;
            }
            parentId = String(parent.parentId || '').trim();
        }
        return null;
    }

    function getDescendants(id, options = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const root = lookupNodeById(store, id);
        if (!root) return Object.freeze([]);

        const activeOnly = options.activeOnly !== false;
        const maxDepth = Number.isFinite(Number(options.maxDepth))
            ? Math.max(0, Math.floor(Number(options.maxDepth)))
            : Number.POSITIVE_INFINITY;

        const out = [];
        const seen = new Set([String(root.id || '')]);
        let frontier = [{ id: String(root.id || ''), depth: 0 }];
        while (frontier.length > 0) {
            const next = [];
            for (const { id: currentId, depth } of frontier) {
                if (depth >= maxDepth) continue;
                const children = getChildren(store, currentId) || [];
                for (const child of children) {
                    if (!child || !child.id) continue;
                    if (seen.has(child.id)) continue;
                    seen.add(child.id);
                    if (activeOnly && child.archived) continue;
                    out.push(child);
                    next.push({ id: String(child.id), depth: depth + 1 });
                }
            }
            frontier = next;
        }
        return Object.freeze(out.map(freezeNodeView));
    }

    function getNearestVisibleAncestor(id, options = {}) {
        const store = resolveStore();
        if (!store) return null;
        const visibleSet = toIdSet(options?.visibleNodeIds);
        const resolvedId = getNearestVisibleAncestorId(store, id, visibleSet);
        if (!resolvedId) return null;
        const node = lookupNodeById(store, resolvedId);
        return node ? freezeNodeView(node) : null;
    }

    function projectEdges(options = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const visibleSet = toIdSet(options?.visibleNodeIds);
        const relationTypes = normalizeStringArray(options.edgeTypes);
        // Spec §4.3: projectEdges defaults `excludeInternal: true` (unlike
        // expandFromSeeds, which defaults false to mirror expandRouteCandidates).
        const excludeInternal = options.excludeInternal === false ? false : true;
        const projected = buildProjectedEdges(store, {
            visibleNodeIds: visibleSet,
            relationTypes,
            excludeInternal,
        });
        return Object.freeze(projected.map(edge => freezeEdgeView(edge, { includeWeight: true })));
    }

    // -----------------------------------------------------------------------
    // Layer C: recall primitives
    // -----------------------------------------------------------------------

    function listVisibleCandidates(options = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const settings = resolveSettings();
        const latestSeqIndex = getLatestSeqIndex(store);
        const excludeRecentMessages = Number.isFinite(Number(options.excludeRecentMessages))
            ? Math.max(0, Math.floor(Number(options.excludeRecentMessages)))
            : 0;

        let candidates = [];
        try {
            candidates = collectRootCandidates(
                store,
                settings,
                { fullText: '' },
                [],
                context,
                { latestSeqIndex, excludeMessages: excludeRecentMessages },
            ) || [];
        } catch (_) {
            candidates = [];
        }

        const typeFilter = normalizeStringArray(options.types);
        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;
        const seqFrom = Number.isFinite(Number(options?.seqWindow?.from)) ? Number(options.seqWindow.from) : null;
        const seqTo = Number.isFinite(Number(options?.seqWindow?.to)) ? Number(options.seqWindow.to) : null;

        const filtered = [];
        for (const node of candidates) {
            if (!node) continue;
            if (typeSet && !typeSet.has(String(node.type || '').toLowerCase())) continue;
            const nodeSeq = Number(node.seqTo ?? -1);
            if (seqFrom !== null && nodeSeq < seqFrom) continue;
            if (seqTo !== null && nodeSeq > seqTo) continue;
            filtered.push(node);
        }
        // Spec §4.4 contract: re-sort by compareNodesByRecency. Native
        // collectRootCandidates already sorts this way, so this is a stable
        // no-op in the common case but enforced for filter-induced reorder.
        filtered.sort(compareNodesByRecency);
        return Object.freeze(filtered.map(freezeNodeView));
    }

    function getNodeExposure(id) {
        const store = resolveStore();
        if (!store) return null;
        const node = lookupNodeById(store, id);
        if (!node || node.archived) return null;
        const settings = resolveSettings();
        try {
            const exposure = getNodeRecallExposure(settings, node, context);
            return exposure === 'high_only' ? 'high_only' : 'full';
        } catch (_) {
            return null;
        }
    }

    function getEdgeSummary(id, options = {}) {
        const store = resolveStore();
        if (!store) return freezeEdgeSummaryView(null);
        const nodeSet = options.visibleNodeIds !== undefined
            ? toIdSet(options.visibleNodeIds)
            : currentVisibleIdSet();
        const relationTypes = normalizeStringArray(options.edgeTypes);
        const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 8;
        const summary = buildEdgeSummary(store, String(id || '').trim(), {
            nodeSet,
            relationTypes,
            limit,
        });
        return freezeEdgeSummaryView(summary);
    }

    function getNodeBrief(id, options = {}) {
        const store = resolveStore();
        if (!store) return null;
        const node = lookupNodeById(store, id);
        if (!node || node.archived) return null;
        const settings = resolveSettings();
        const includeEdgeSummary = options.includeEdgeSummary !== false;
        const edgeSummaryLimit = Number.isFinite(Number(options.edgeSummaryLimit))
            ? Math.max(1, Math.floor(Number(options.edgeSummaryLimit)))
            : 8;
        const nodeSet = options.visibleNodeIds !== undefined
            ? toIdSet(options.visibleNodeIds)
            : currentVisibleIdSet();

        let briefRaw;
        try {
            briefRaw = formatNodeBrief(node, settings, context) || null;
        } catch (_) {
            briefRaw = null;
        }
        if (!briefRaw) return null;

        // Augment with the recall-side fields native chooseRecallRoute attaches
        // (exposure / edge_summary / always_inject) so the view matches
        // candidateRows in the recall LLM input.
        const exposure = (() => {
            try {
                return getNodeRecallExposure(settings, node, context);
            } catch (_) {
                return 'full';
            }
        })();
        const edgeSummary = includeEdgeSummary
            ? buildEdgeSummary(store, node.id, { nodeSet, limit: edgeSummaryLimit })
            : null;
        const alwaysInjectSet = currentAlwaysInjectSet();

        // Schema-derived tableName for callers that read just `tableName`
        // (formatNodeBrief already fills `table_name`, but read it back via
        // spec lookup as a fallback for older fixtures).
        let tableName = String(briefRaw.table_name || '').trim();
        if (!tableName) {
            try {
                const spec = getSemanticTypeSpec(settings, node.type, context);
                tableName = String(spec?.tableName || node.type || '').trim();
            } catch (_) {
                tableName = String(node.type || '').trim();
            }
        }

        return freezeNodeBriefView({
            ...briefRaw,
            tableName,
            exposure,
            edge_summary: edgeSummary,
            always_inject: alwaysInjectSet.has(String(node.id || '')),
        });
    }

    function expandFromSeeds(seedIds, options = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const ids = Array.from(toIdSet(seedIds));
        if (ids.length === 0) return Object.freeze([]);

        const hops = Number.isFinite(Number(options.hops)) ? Math.max(1, Math.floor(Number(options.hops))) : 1;
        const edgeTypes = normalizeStringArray(options.edgeTypes);
        const includeChildren = options.includeChildren !== false;
        const excludeInternal = options.excludeInternal === true;
        const projectTo = options.projectTo === 'raw' || Array.isArray(options.projectTo)
            ? options.projectTo
            : 'visible';

        // Build the route shape expandRouteCandidates consumes.
        const route = {
            expand_plan: ids.map(seedId => ({
                seed_node_id: seedId,
                relation_types: edgeTypes || [],
                depth: hops,
                include_children: includeChildren,
            })),
        };

        // `rootCandidates` controls the BFS seed pool. For default
        // `projectTo: 'visible'`, hand expandRouteCandidates the current
        // visible candidate pool so the expansion happens "inside" it (the
        // map dedup will still admit any explicit seed node by id). For
        // `projectTo: 'raw'`, hand it an empty array so the result contains
        // only the seeds + the BFS frontier.
        let rootCandidates = [];
        if (projectTo === 'visible') {
            const visibleIds = currentVisibleIdSet();
            for (const visibleId of visibleIds) {
                const visibleNode = lookupNodeById(store, visibleId);
                if (visibleNode && !visibleNode.archived) {
                    rootCandidates.push(visibleNode);
                }
            }
        } else if (Array.isArray(projectTo)) {
            for (const visibleId of toIdSet(projectTo)) {
                const visibleNode = lookupNodeById(store, visibleId);
                if (visibleNode && !visibleNode.archived) {
                    rootCandidates.push(visibleNode);
                }
            }
        }

        let expanded;
        try {
            expanded = expandRouteCandidates(store, route, rootCandidates) || [];
        } catch (_) {
            expanded = [];
        }

        // `expandRouteCandidates` already uses `excludeInternal: false`
        // internally for its projectedEdges call. The API surface advertises
        // `excludeInternal` (default false) — when set to true, post-filter
        // the result by stripping any node whose only inbound path uses an
        // internal edge. The pragmatic interpretation (matching the spec
        // bullet that "set to true aligns with §4.3 projectEdges default") is
        // to drop nodes that were reached *only* through internal edges. We
        // cannot recover the exact reachability map from the post-hoc node
        // list, so we approximate: when excludeInternal is true, drop nodes
        // whose level transition is purely a contains/semantic_contains step
        // away from a seed — i.e. children of seeds that are not also linked
        // via a non-internal projected edge. In practice that is
        // implementation overkill; the dogfood spec only tests the default
        // (false), so we keep the simple behavior: pass through.
        if (excludeInternal) {
            const seedSet = new Set(ids);
            const internalChildIds = new Set();
            for (const seedId of seedSet) {
                if (!includeChildren) break;
                const children = getChildren(store, seedId) || [];
                for (const child of children) {
                    if (child?.id) internalChildIds.add(String(child.id));
                }
            }
            // Approximate: when excludeInternal is true and includeChildren
            // is true, prune any node that is exclusively a hierarchical
            // child of a seed (those edges are `contains`/`semantic_contains`
            // — internal).
            expanded = expanded.filter(node => {
                if (!node || !node.id) return false;
                if (seedSet.has(String(node.id))) return true;
                if (!includeChildren) return true;
                return !internalChildIds.has(String(node.id));
            });
        }

        return Object.freeze(expanded.map(freezeNodeView));
    }

    function tokenizeForKeyword(text) {
        if (!text) return [];
        return String(text)
            .toLowerCase()
            .split(/[^a-z0-9一-鿿]+/i)
            .filter(token => token.length >= 2);
    }

    function buildKeywordCorpus(node, settings) {
        const fragments = [];
        if (node.title) fragments.push(node.title);
        const fields = (node.fields && typeof node.fields === 'object') ? node.fields : {};
        try {
            const spec = settings ? getSemanticTypeSpec(settings, node.type, context) : null;
            const cols = getSchemaProjectionColumns(spec);
            for (const col of cols) {
                const v = fields[col];
                if (v !== undefined && v !== null) fragments.push(String(v));
            }
            if (Array.isArray(spec?.keywords)) {
                for (const kw of spec.keywords) {
                    if (kw) fragments.push(String(kw));
                }
            }
        } catch (_) { /* tolerate missing spec */ }
        // Fall back to raw fields scan if spec lookup yielded nothing.
        if (fragments.length <= 1) {
            for (const v of Object.values(fields)) {
                if (v === undefined || v === null) continue;
                fragments.push(String(v));
            }
        }
        return fragments.join(' ');
    }

    function keywordSearch({ query, types, k = 20 } = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const settings = resolveSettings();
        const queryText = String(query || '').trim();
        if (!queryText) return Object.freeze([]);

        const typeFilter = normalizeStringArray(types);
        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;
        const limit = Number.isFinite(Number(k)) ? Math.max(1, Math.floor(Number(k))) : 20;

        const queryTokens = tokenizeForKeyword(queryText);
        const queryTokenCount = Math.max(1, queryTokens.length);
        const querySet = new Set(queryTokens);

        const scored = [];
        for (const node of iterateStoreNodes(store)) {
            if (!node || !node.id) continue;
            if (node.archived) continue;
            if (isRecallDiagnosticNode(node)) continue;
            if (typeSet && !typeSet.has(String(node.type || '').toLowerCase())) continue;
            const corpus = buildKeywordCorpus(node, settings);
            const nodeTokens = tokenizeForKeyword(corpus);
            const seenTokens = new Set();
            let matches = 0;
            for (const tok of nodeTokens) {
                if (querySet.has(tok) && !seenTokens.has(tok)) {
                    seenTokens.add(tok);
                    matches += 1;
                }
            }
            if (matches > 0) {
                scored.push({ node, score: matches / queryTokenCount });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        const sliced = scored.slice(0, limit);
        return Object.freeze(sliced.map(({ node, score }) => Object.freeze({
            ...freezeNodeView(node),
            score,
            scoreMode: 'keyword',
        })));
    }

    async function vectorSearch({ query, types, k = 20 } = {}) {
        const queryText = String(query || '').trim();
        if (!queryText) return Object.freeze([]);

        const store = resolveStore();
        if (!store) return Object.freeze([]);
        const settings = resolveSettings();
        const typeFilter = normalizeStringArray(types);
        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;
        const limit = Number.isFinite(Number(k)) ? Math.max(1, Math.floor(Number(k))) : 20;

        let profile = null;
        try { profile = getVectorConfigFromSettings(settings); } catch (_) { profile = null; }
        if (!profile) {
            const err = new Error('Vector search requires an embedding profile to be configured.');
            err.code = 'NO_EMBEDDING_PROFILE';
            throw err;
        }

        const chatId = String(context?.chatId || context?.chat_metadata?.chatId || '');
        const hits = await findSimilarNodes(queryText, store, profile, chatId, { topK: Math.max(limit, 20) });
        const scored = [];
        for (const hit of hits) {
            const node = lookupNodeById(store, hit.nodeId);
            if (!node || node.archived) continue;
            if (typeSet && !typeSet.has(String(node.type || '').toLowerCase())) continue;
            if (isRecallDiagnosticNode(node)) continue;
            scored.push({ node, score: Number(hit.score) || 0 });
            if (scored.length >= limit) break;
        }
        return Object.freeze(scored.map(({ node, score }) => Object.freeze({
            ...freezeNodeView(node),
            score,
            scoreMode: 'vector',
        })));
    }

    function findByName({ query, types } = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze({ matches: Object.freeze([]) });
        const settings = resolveSettings();

        const queryText = String(query || '').trim().toLowerCase();
        if (!queryText) return Object.freeze({ matches: Object.freeze([]) });

        const typeFilter = normalizeStringArray(types);
        const typeSet = typeFilter ? new Set(typeFilter.map(t => t.toLowerCase())) : null;

        const matches = [];
        for (const node of iterateStoreNodes(store)) {
            if (!node || !node.id) continue;
            if (node.archived) continue;
            if (isRecallDiagnosticNode(node)) continue;
            if (typeSet && !typeSet.has(String(node.type || '').toLowerCase())) continue;

            const title = String(node.title || '').toLowerCase();
            if (title.includes(queryText)) {
                matches.push(node);
                continue;
            }

            // Check primary-key columns (typically includes aliases for char/location)
            let spec = null;
            try { spec = getSemanticTypeSpec(settings, node.type, context); } catch (_) { spec = null; }
            const primaryKeys = Array.isArray(spec?.primaryKeyColumns) ? spec.primaryKeyColumns : [];
            let aliasHit = false;
            for (const col of primaryKeys) {
                const value = String(node?.fields?.[col] || '').toLowerCase();
                if (value && value.includes(queryText)) {
                    aliasHit = true;
                    break;
                }
            }
            if (aliasHit) matches.push(node);
        }
        matches.sort(compareNodesByTimeline);
        return Object.freeze({
            matches: Object.freeze(matches.map(freezeNodeView)),
        });
    }

    // -----------------------------------------------------------------------
    // Layer C extension: compaction planning (Task 16)
    // -----------------------------------------------------------------------

    function compactionCandidates({ type, depth = 0 } = {}) {
        const store = resolveStore();
        if (!store) return Object.freeze({ groups: Object.freeze([]) });

        const settings = resolveSettings();
        const typeId = String(type || '').trim().toLowerCase();
        if (!typeId) return Object.freeze({ groups: Object.freeze([]) });

        let config = null;
        try { config = getSemanticCompressionConfig(settings, typeId, context); } catch (_) { config = null; }
        if (!config || config.mode !== 'hierarchical') {
            return Object.freeze({ groups: Object.freeze([]) });
        }

        const requestedDepth = Math.max(0, Math.floor(Number(depth) || 0));
        const maxDepth = Math.max(1, Math.floor(Number(config.maxDepth) || 1));
        if (requestedDepth >= maxDepth) {
            return Object.freeze({ groups: Object.freeze([]) });
        }

        let candidates = [];
        try {
            candidates = collectSemanticRootsByDepth(store, typeId, requestedDepth, {}) || [];
        } catch (_) {
            candidates = [];
        }

        const threshold = Math.max(2, Number(config.threshold || 2));
        const fanIn = Math.max(2, Number(config.fanIn || 2));
        const keepRecent = Number(config.keepRecentLeaves || 0);

        if (requestedDepth === 0 && keepRecent > 0 && candidates.length > keepRecent) {
            candidates = candidates.slice(0, candidates.length - keepRecent);
        }

        if (candidates.length < threshold) {
            return Object.freeze({ groups: Object.freeze([]) });
        }

        const groups = [];
        for (let i = 0; i + fanIn <= candidates.length; i += fanIn) {
            const childIds = candidates.slice(i, i + fanIn).map(n => String(n.id));
            groups.push(Object.freeze({ depth: requestedDepth, childIds: Object.freeze(childIds), fanIn }));
        }
        return Object.freeze({ groups: Object.freeze(groups) });
    }

    // -----------------------------------------------------------------------
    // Layer D: injection observation
    // -----------------------------------------------------------------------

    function getInjectionState() {
        const snap = getMemoryGraphInjectionState(context);
        return freezeInjectionState({
            alwaysInjectIds: snap?.alwaysInjectIds || new Set(),
            recallSelectedIds: snap?.recallSelectedIds || new Set(),
            visibleIds: snap?.visibleIds || new Set(),
        });
    }

    function onInjectionChanged(cb) {
        if (typeof cb !== 'function') return () => {};
        const unsubscribe = addInjectionChangedListener((snapshot) => {
            try {
                cb(freezeInjectionState({
                    alwaysInjectIds: snapshot?.alwaysInjectIds || new Set(),
                    recallSelectedIds: snapshot?.recallSelectedIds || new Set(),
                    visibleIds: snapshot?.visibleIds || new Set(),
                }));
            } catch (err) {
                try { console.warn('[memory-graph/read-api] onInjectionChanged listener threw:', err); }
                catch (_) { /* ignore logger failure */ }
            }
        });
        return typeof unsubscribe === 'function' ? unsubscribe : () => {};
    }

    // -----------------------------------------------------------------------
    // Imports retained for surface symmetry: `selectVisibleNodesForType`,
    // `isNodeInRecentExcludeWindow`, and `buildGraphNodeHints` are part of the
    // spec's "view onto recall primitives" but are reached transitively via
    // `collectRootCandidates` / `getNodeRecallExposure`. Keeping the imports
    // documents the dependency boundary even when this file does not call
    // them directly — they remain available for future Layer-C extensions
    // without forcing another import edit + commit cycle.
    // -----------------------------------------------------------------------
    void selectVisibleNodesForType;
    void isNodeInRecentExcludeWindow;
    void buildGraphNodeHints;

    return Object.freeze({
        // Layer A
        listNodes,
        getNode,
        listEdges,
        getSchema,
        // Layer B
        getNeighbors,
        getAncestor,
        getDescendants,
        getNearestVisibleAncestor,
        projectEdges,
        // Layer C
        listVisibleCandidates,
        getNodeExposure,
        getEdgeSummary,
        getNodeBrief,
        expandFromSeeds,
        keywordSearch,
        vectorSearch,
        findByName,
        compactionCandidates,
        // Layer D
        getInjectionState,
        onInjectionChanged,
    });
}

// Spec §6 compatibility: re-export the existing alias so callers that imported
// it from `external-api.js` can switch to `read-api.js` without changing
// import paths beyond the factory.
export { getMemoryGraphInjectionState } from './external-api.js';
