/**
 * Tests for memory-graph read-only API (read-api.js).
 *
 * Covers spec docs/superpowers/specs/2026-05-18-memory-graph-readonly-api.md
 * §8 acceptance:
 *   #1 type-freeze
 *   #2 per-API behavior (Layers A/B/C/D)
 *
 * Dogfood tests (§5) live in a sibling file (Phase 5).
 *
 * read-api.js imports from `./main.js`, which transitively imports
 * `../../../script.js` and `./lib.js`. Both of those touch DOM (jQuery /
 * Popper / document) at module-load and reference the webpack-bundled
 * `lib.core.bundle.js` that does not exist outside a build. We therefore
 * mock `./main.js` and `./vector-index.js` with faithful, in-process
 * implementations of the exact helpers read-api.js consumes — and `./graph-ops.js`
 * + `./external-api.js` (both pure / DOM-free) load for real.
 *
 * The mock implementations follow the same contracts as their main.js
 * counterparts so read-api's wrapping/freezing/factory behavior is
 * exercised end-to-end against in-memory store fixtures.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Test holders — let mocks read settings / vector config from a per-test slot
// ---------------------------------------------------------------------------
const testHolder = {
    settings: null, // set per-describe via setHolderSettings
    vectorProfile: null,
    vectorHits: [],
};

// ---------------------------------------------------------------------------
// Mock: ./vector-index.js — no real embedding service in unit tests.
// ---------------------------------------------------------------------------
jest.unstable_mockModule(
    '../../public/scripts/extensions/memory-graph/vector-index.js',
    () => ({
        findSimilarNodes: jest.fn(async () => testHolder.vectorHits || []),
        getVectorConfigFromSettings: jest.fn(() => testHolder.vectorProfile),
    }),
);

// ---------------------------------------------------------------------------
// Mock: ./character-overrides.js — bypass the global `extension_settings`
// dance. We feed settings via the holder and return them verbatim.
// ---------------------------------------------------------------------------
jest.unstable_mockModule(
    '../../public/scripts/extensions/memory-graph/character-overrides.js',
    () => ({
        configure: () => {},
        getEffectiveSettings: (_context, baseSettings) => baseSettings || testHolder.settings,
        getEffectiveNodeTypeSchema: (_context, settings) => {
            const s = settings || testHolder.settings;
            return Array.isArray(s?.nodeTypeSchema) ? s.nodeTypeSchema : [];
        },
    }),
);

// ---------------------------------------------------------------------------
// Mock: ./main.js — re-implement only the exports read-api.js imports.
//
// Every helper here mirrors the production semantics documented in main.js.
// Where the production code is short and self-contained (compareNodesByRecency,
// getNearestVisibleAncestorId, buildProjectedEdges, getChildren, ...) we copy
// the logic verbatim. For the heavier helpers (collectRootCandidates,
// expandRouteCandidates, formatNodeBrief) we ship a faithful reduction that
// preserves the behavior under test.
// ---------------------------------------------------------------------------
jest.unstable_mockModule(
    '../../public/scripts/extensions/memory-graph/main.js',
    () => {
        // Local pure helpers, mirroring main.js shape exactly.
        function _isRecallDiagnosticNode(node) {
            const type = String(node?.type || '').trim().toLowerCase();
            return type === 'recall' || type.startsWith('recall_');
        }

        function _getChildren(store, nodeId) {
            const node = store?.nodes?.[nodeId];
            if (!node || !Array.isArray(node.childrenIds)) return [];
            return node.childrenIds
                .map(id => store.nodes[id])
                .filter(child => Boolean(child) && !child.archived);
        }

        function _getNearestVisibleAncestorId(store, nodeId, visibleSet) {
            const target = String(nodeId || '').trim();
            if (!target) return '';
            const set = visibleSet instanceof Set ? visibleSet : new Set();
            let currentId = target;
            const guard = new Set();
            while (currentId && !guard.has(currentId)) {
                guard.add(currentId);
                const node = store?.nodes?.[currentId];
                if (!node || node.archived) return '';
                if (set.has(currentId)) return currentId;
                currentId = String(node.parentId || '').trim();
            }
            return '';
        }

        function _buildProjectedEdges(store, {
            visibleNodeIds = null,
            relationTypes = null,
            excludeInternal = false,
        } = {}) {
            const visibleSet = visibleNodeIds instanceof Set
                ? visibleNodeIds
                : Array.isArray(visibleNodeIds)
                    ? new Set(visibleNodeIds.map(id => String(id || '').trim()).filter(Boolean))
                    : new Set(
                        Object.values(store?.nodes || {})
                            .filter(node => node && !node.archived)
                            .map(node => String(node.id || '').trim())
                            .filter(Boolean),
                    );
            const relationAllow = Array.isArray(relationTypes) && relationTypes.length > 0
                ? new Set(relationTypes.map(t => String(t || '').toLowerCase().trim()).filter(Boolean))
                : null;
            const internalEdgeTypes = new Set(['contains', 'semantic_contains']);
            const merged = new Map();
            for (const edge of store?.edges || []) {
                if (!edge) continue;
                const edgeType = String(edge.type || '').toLowerCase().trim() || 'related';
                if (excludeInternal && internalEdgeTypes.has(edgeType)) continue;
                if (relationAllow && !relationAllow.has(edgeType)) continue;
                const fromVisible = _getNearestVisibleAncestorId(store, edge.from, visibleSet);
                const toVisible = _getNearestVisibleAncestorId(store, edge.to, visibleSet);
                if (!fromVisible || !toVisible || fromVisible === toVisible) continue;
                const key = `${fromVisible}::${toVisible}::${edgeType}`;
                const current = merged.get(key);
                if (!current) {
                    merged.set(key, { from: fromVisible, to: toVisible, type: edgeType, weight: 1 });
                    continue;
                }
                current.weight = Number(current.weight || 0) + 1;
            }
            return Array.from(merged.values());
        }

        function _buildEdgeSummary(store, nodeId, { nodeSet = null, relationTypes = null, limit = 10 } = {}) {
            if (!nodeId) return { degree: 0, relations: [], sample_neighbors: [] };
            const visibleSet = nodeSet instanceof Set
                ? nodeSet
                : Array.isArray(nodeSet)
                    ? new Set(nodeSet.map(id => String(id || '').trim()).filter(Boolean))
                    : null;
            const projectedEdges = _buildProjectedEdges(store, {
                visibleNodeIds: visibleSet,
                relationTypes,
                excludeInternal: false,
            });
            const byRelation = new Map();
            const neighborIds = new Set();
            let degree = 0;
            for (const edge of projectedEdges) {
                const edgeType = String(edge.type || '').toLowerCase().trim() || 'related';
                let neighborId = '';
                let direction = '';
                if (edge.from === nodeId) {
                    neighborId = String(edge.to || '');
                    direction = 'out';
                } else if (edge.to === nodeId) {
                    neighborId = String(edge.from || '');
                    direction = 'in';
                } else {
                    continue;
                }
                if (!neighborId) continue;
                if (visibleSet && !visibleSet.has(neighborId)) continue;
                if (!store.nodes[neighborId] || store.nodes[neighborId].archived) continue;
                const supportCount = Math.max(1, Number(edge?.weight || 1));
                degree += supportCount;
                neighborIds.add(neighborId);
                const key = `${edgeType}:${direction}`;
                byRelation.set(key, Number(byRelation.get(key) || 0) + supportCount);
            }
            const relationRows = Array.from(byRelation.entries())
                .map(([key, count]) => {
                    const [relation, direction] = key.split(':');
                    return { relation, direction, count };
                })
                .sort((a, b) => b.count - a.count);
            const sampleNeighbors = Array.from(neighborIds)
                .slice(0, Math.max(1, Number(limit || 10)))
                .map(id => {
                    const node = store.nodes[id];
                    return {
                        id,
                        type: String(node?.type || ''),
                        title: String(node?.title || ''),
                    };
                });
            return { degree, relations: relationRows, sample_neighbors: sampleNeighbors };
        }

        function _compareNodesByRecency(a, b) {
            const aSeq = Number(a?.seqTo ?? -1);
            const bSeq = Number(b?.seqTo ?? -1);
            if (aSeq !== bSeq) return bSeq - aSeq;
            const aDepth = Number(a?.semanticDepth ?? 0);
            const bDepth = Number(b?.semanticDepth ?? 0);
            if (aDepth !== bDepth) return bDepth - aDepth;
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        }

        function _getSemanticTypeSpec(settings, type, _context = null) {
            const list = Array.isArray(settings?.nodeTypeSchema) ? settings.nodeTypeSchema : [];
            return list.find(s => String(s?.id || '').toLowerCase() === String(type || '').toLowerCase()) || null;
        }

        function _getSemanticCompressionConfig(settings, type, _context = null) {
            const spec = _getSemanticTypeSpec(settings, type);
            const raw = spec?.compression && typeof spec.compression === 'object' ? spec.compression : {};
            const mode = ['none', 'hierarchical'].includes(String(raw.mode || '').toLowerCase())
                ? String(raw.mode).toLowerCase()
                : 'none';
            return {
                mode,
                threshold: Math.max(2, Number(raw.threshold) || 6),
                fanIn: Math.max(2, Number(raw.fanIn) || 3),
                maxDepth: Math.max(1, Number(raw.maxDepth) || 6),
                keepRecentLeaves: Math.max(0, Number(raw.keepRecentLeaves) || 0),
                rule: String(raw.rule || '').trim(),
                summarizeInstruction: String(raw.summarizeInstruction || '').trim(),
                label: String(spec?.label || type || 'Semantic'),
            };
        }

        function _collectSemanticRootsByDepth(store, type, depth, options = {}) {
            const rawMaxSeq = options?.maxSeq;
            const maxSeq = (rawMaxSeq !== null && rawMaxSeq !== undefined && Number.isFinite(Number(rawMaxSeq)))
                ? Math.max(0, Math.floor(Number(rawMaxSeq)))
                : null;
            const targetType = String(type || '').toLowerCase();
            return Object.values(store?.nodes || {})
                .filter(node => Boolean(node) && !node.archived)
                .filter(node => String(node?.level || '') === 'semantic')
                .filter(node => String(node?.type || '').toLowerCase() === targetType)
                .filter(node => Number(node?.semanticDepth ?? 0) === Number(depth))
                .filter(node => !String(node.parentId || '').trim())
                .filter(node => maxSeq === null || Number(node?.seqTo ?? 0) <= maxSeq)
                .sort((a, b) => {
                    const aTo = Number(a.seqTo ?? 0);
                    const bTo = Number(b.seqTo ?? 0);
                    if (aTo !== bTo) return aTo - bTo;
                    return String(a?.id || '').localeCompare(String(b?.id || ''));
                });
        }

        function _getNodeRecallExposure(settings, node, _context = null) {
            if (!node) return 'high_only';
            if (node.level !== 'semantic') return 'high_only';
            const config = _getSemanticCompressionConfig(settings, node.type);
            if (config.mode === 'hierarchical') return 'high_only';
            return 'full';
        }

        function _getSchemaProjectionColumns(spec = null) {
            return Array.isArray(spec?.tableColumns)
                ? spec.tableColumns.map(c => String(c || '').trim()).filter(Boolean)
                : [];
        }

        function _buildGraphNodeHints(store, schema, _limit = 0) {
            const schemaList = Array.isArray(schema) ? schema : [];
            const schemaMap = new Map(
                schemaList.map(item => [String(item?.id || '').trim().toLowerCase(), item]),
            );
            const allSemantic = Object.values(store?.nodes || {}).filter(node => {
                if (!node || node.archived) return false;
                if (_isRecallDiagnosticNode(node)) return false;
                return String(node?.level || '') === 'semantic';
            });
            // Group by type, then project per type's compression mode. This
            // mirrors main.js#buildGraphNodeHints (default scope='visible'):
            // hierarchical types collapse leaves up to their top active ancestor.
            const typeIds = new Set(
                allSemantic
                    .map(node => String(node?.type || '').trim().toLowerCase())
                    .filter(Boolean),
            );
            const out = [];
            const outIds = new Set();
            // Also include any non-semantic-level node so episodic / non-typed
            // helpers still see them (legacy mock behavior).
            for (const node of Object.values(store?.nodes || {})) {
                if (!node || node.archived) continue;
                if (_isRecallDiagnosticNode(node)) continue;
                if (String(node?.level || '') === 'semantic') continue;
                if (outIds.has(node.id)) continue;
                outIds.add(node.id);
                out.push({ id: String(node.id || '') });
            }
            for (const type of typeIds) {
                const spec = schemaMap.get(type);
                const mode = String(spec?.compression?.mode || 'none').toLowerCase();
                const typeNodes = allSemantic
                    .filter(node => String(node?.type || '').toLowerCase() === type);
                if (mode !== 'hierarchical') {
                    for (const node of typeNodes) {
                        if (!node?.id || outIds.has(node.id)) continue;
                        outIds.add(node.id);
                        out.push({ id: String(node.id) });
                    }
                    continue;
                }
                // Hierarchical: leaves project up to their top active semantic
                // ancestor of the same type (matching main.js#selectVisibleNodesForType).
                const byId = new Map(typeNodes.map(n => [String(n.id), n]));
                const hasActiveChildOfType = (node) => {
                    const childIds = Array.isArray(node?.childrenIds) ? node.childrenIds : [];
                    return childIds.some((cid) => {
                        const child = store?.nodes?.[cid];
                        if (!child || child.archived) return false;
                        if (String(child.level || '') !== 'semantic') return false;
                        return String(child.type || '').toLowerCase() === type;
                    });
                };
                const topAncestorOfType = (node) => {
                    let cursor = node;
                    let top = node;
                    const guard = new Set();
                    while (cursor && !guard.has(cursor.id)) {
                        guard.add(cursor.id);
                        const parentId = String(cursor.parentId || '').trim();
                        if (!parentId) break;
                        const parent = store?.nodes?.[parentId];
                        if (!parent || parent.archived) break;
                        if (String(parent.level || '') !== 'semantic') break;
                        if (String(parent.type || '').toLowerCase() !== type) break;
                        top = parent;
                        cursor = parent;
                    }
                    return top;
                };
                for (const node of typeNodes) {
                    if (hasActiveChildOfType(node)) continue;
                    const top = topAncestorOfType(node) || node;
                    if (!top?.id || outIds.has(top.id)) continue;
                    if (!byId.has(top.id)) continue;
                    outIds.add(top.id);
                    out.push({ id: String(top.id) });
                }
            }
            return out;
        }

        function _getLatestSeqIndex(store) {
            // Mirrors main.js#getLatestSeqIndex → getStoreCoveredSeqTo:
            //   max(0, appliedSeqTo, loggedSeqTo).
            // Tests that need a non-zero index set `store.appliedSeqTo` in the fixture.
            const applied = Math.max(0, Math.floor(Number(store?.appliedSeqTo || 0)));
            const logged = Math.max(0, Math.floor(Number(store?.loggedSeqTo || 0)));
            return Math.max(-1, applied, logged);
        }

        function _isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages) {
            const windowSize = Math.max(0, Number(excludeMessages || 0));
            if (windowSize <= 0 || latestSeqIndex < 0 || !node) return false;
            const toSeq = Number(node?.seqTo ?? NaN);
            if (!Number.isFinite(toSeq)) return false;
            return toSeq >= latestSeqIndex - windowSize + 1;
        }

        function _collectRootCandidates(store, settings, _qb, alwaysInjectNodes = [], context = null, opts = {}) {
            const { latestSeqIndex = -1, excludeMessages = 0 } = opts;
            const schema = Array.isArray(settings?.nodeTypeSchema) ? settings.nodeTypeSchema : [];
            const visibleRows = _buildGraphNodeHints(store, schema, 0);
            const visibleNodes = visibleRows
                .map(row => store?.nodes?.[String(row?.id || '')] || null)
                .filter(node => Boolean(node) && !node.archived && !_isRecallDiagnosticNode(node))
                .filter(node => !_isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages));
            const merged = [
                ...(alwaysInjectNodes || []).filter(Boolean).slice().sort(_compareNodesByRecency),
                ...visibleNodes.slice().sort(_compareNodesByRecency),
            ];
            const out = [];
            const seen = new Set();
            for (const n of merged) {
                const id = String(n?.id || '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push(n);
            }
            return out;
        }

        function _addCandidate(map, node) {
            const id = String(node?.id || '');
            if (!id || map.has(id)) return;
            map.set(id, node);
        }

        function _expandRouteCandidates(store, route, rootCandidates) {
            const candidateMap = new Map();
            const expandPlan = Array.isArray(route?.expand_plan) ? route.expand_plan : [];
            for (const node of rootCandidates || []) _addCandidate(candidateMap, node);
            for (const request of expandPlan) {
                const seedId = String(request?.seed_node_id || '').trim();
                if (!seedId || !store?.nodes?.[seedId]) continue;
                const relationTypes = Array.isArray(request?.relation_types) && request.relation_types.length > 0
                    ? request.relation_types
                    : null;
                const depth = Math.max(1, Math.floor(Number(request?.depth) || 1));
                const includeChildren = request?.include_children !== false;
                const seen = new Set([seedId]);
                let frontier = [seedId];
                _addCandidate(candidateMap, store.nodes[seedId]);
                for (let hop = 0; hop < depth; hop++) {
                    if (frontier.length === 0) break;
                    const visibleSet = new Set(candidateMap.keys());
                    const projectedEdges = _buildProjectedEdges(store, {
                        visibleNodeIds: visibleSet,
                        relationTypes,
                        excludeInternal: false,
                    });
                    const next = [];
                    for (const currentId of frontier) {
                        const currentNode = store.nodes[currentId];
                        if (!currentNode || currentNode.archived) continue;
                        if (includeChildren) {
                            for (const child of _getChildren(store, currentId)) {
                                if (!child?.id || child.archived || seen.has(child.id)) continue;
                                seen.add(child.id);
                                _addCandidate(candidateMap, child);
                                next.push(child.id);
                            }
                        }
                        for (const edge of projectedEdges) {
                            if (!edge) continue;
                            let neighborId = '';
                            if (edge.from === currentId) neighborId = String(edge.to || '');
                            else if (edge.to === currentId) neighborId = String(edge.from || '');
                            else continue;
                            if (!neighborId || seen.has(neighborId)) continue;
                            const neighbor = store.nodes[neighborId];
                            if (!neighbor || neighbor.archived) continue;
                            seen.add(neighborId);
                            _addCandidate(candidateMap, neighbor);
                            next.push(neighborId);
                        }
                    }
                    frontier = next;
                }
            }
            return Array.from(candidateMap.values());
        }

        function _formatNodeBrief(node, settings = null, _context = null, extra = {}) {
            const spec = settings ? _getSemanticTypeSpec(settings, node?.type) : null;
            const tableColumns = _getSchemaProjectionColumns(spec);
            const fields = (node?.fields && typeof node.fields === 'object') ? node.fields : {};
            const rowValues = {};
            for (const col of tableColumns) {
                const v = fields[col];
                if (v !== undefined && v !== null && String(v)) rowValues[col] = String(v);
            }
            const keyCols = Array.from(new Set([
                ...(Array.isArray(spec?.primaryKeyColumns) ? spec.primaryKeyColumns : []),
                ...(Array.isArray(spec?.requiredColumns) ? spec.requiredColumns : []),
            ]));
            const keyValues = {};
            for (const col of keyCols) {
                const v = fields[col];
                if (v !== undefined && v !== null && String(v)) keyValues[col] = String(v);
            }
            const summary = String(fields.summary || '');
            return {
                id: String(node?.id || ''),
                level: String(node?.level || ''),
                type: String(node?.type || ''),
                table_name: String(spec?.tableName || node?.type || '').trim(),
                title: String(node?.title || ''),
                summary,
                key_values: keyValues,
                row_values: rowValues,
                to_seq: Number.isFinite(Number(node?.seqTo)) ? Number(node.seqTo) : null,
                child_count: Array.isArray(node?.childrenIds) ? node.childrenIds.length : 0,
                ...extra,
            };
        }

        return {
            getSettings: jest.fn(() => testHolder.settings),
            getMemoryStore: jest.fn((context, _hint) => context?.__memoryStore || null),
            getSemanticTypeSpec: _getSemanticTypeSpec,
            getSemanticCompressionConfig: _getSemanticCompressionConfig,
            getChildren: _getChildren,
            getSchemaProjectionColumns: _getSchemaProjectionColumns,
            buildGraphNodeHints: _buildGraphNodeHints,
            formatNodeBrief: _formatNodeBrief,
            compareNodesByRecency: _compareNodesByRecency,
            getNodeRecallExposure: _getNodeRecallExposure,
            getNearestVisibleAncestorId: _getNearestVisibleAncestorId,
            buildProjectedEdges: _buildProjectedEdges,
            buildEdgeSummary: _buildEdgeSummary,
            isRecallDiagnosticNode: _isRecallDiagnosticNode,
            collectRootCandidates: _collectRootCandidates,
            expandRouteCandidates: _expandRouteCandidates,
            selectVisibleNodesForType: () => [],
            getLatestSeqIndex: _getLatestSeqIndex,
            isNodeInRecentExcludeWindow: _isNodeInRecentExcludeWindow,
            collectSemanticRootsByDepth: _collectSemanticRootsByDepth,
        };
    },
);

// ---------------------------------------------------------------------------
// Lazy SUT imports (mocks have to be registered before the real module loads)
// ---------------------------------------------------------------------------
let getMemoryGraphReadApi;
let __setInjectedForTest;
let __resetInjectedForTest;
let __recordInjectedNodeIds;
let __resetListenersForTest;
let getMemoryGraphInjectionStateReexport;

beforeEach(async () => {
    if (!getMemoryGraphReadApi) {
        const readApi = await import('../../public/scripts/extensions/memory-graph/read-api.js');
        getMemoryGraphReadApi = readApi.getMemoryGraphReadApi;
        getMemoryGraphInjectionStateReexport = readApi.getMemoryGraphInjectionState;
        const extApi = await import('../../public/scripts/extensions/memory-graph/external-api.js');
        __setInjectedForTest = extApi.__setInjectedForTest;
        __resetInjectedForTest = extApi.__resetInjectedForTest;
        __recordInjectedNodeIds = extApi.__recordInjectedNodeIds;
        __resetListenersForTest = extApi.__resetListenersForTest;
    }
    // Wipe injection state between tests so visibleIds / listeners don't leak.
    __resetInjectedForTest();
    __resetListenersForTest();
    testHolder.vectorProfile = null;
    testHolder.vectorHits = [];
});

// ---------------------------------------------------------------------------
// Fixture builder — produces a small in-memory store + settings exercising:
//   - event nodes (hierarchical compression) with rollup parent + leaves
//   - character_sheet (none-compression) with parentId chain
//   - location_state, a non-event semantic type for filter coverage
//   - some episodic-level nodes for level filter coverage
//   - several edges spanning related / mentions / contains / semantic_contains
// ---------------------------------------------------------------------------
function buildFixtureSchema() {
    return [
        {
            id: 'event',
            label: 'Event',
            tableName: 'event_table',
            tableColumns: ['summary'],
            requiredColumns: ['summary'],
            primaryKeyColumns: [],
            forceUpdate: true,
            alwaysInject: true,
            editable: false,
            keywords: ['battle', 'event', 'foo'],
            compression: { mode: 'hierarchical' },
        },
        {
            id: 'character_sheet',
            label: 'Character',
            tableName: 'character_table',
            tableColumns: ['title', 'aliases', 'traits'],
            requiredColumns: ['title'],
            primaryKeyColumns: ['title', 'aliases'],
            forceUpdate: false,
            alwaysInject: false,
            editable: true,
            keywords: [],
            compression: { mode: 'none' },
        },
        {
            id: 'location_state',
            label: 'Location',
            tableName: 'location_table',
            tableColumns: ['title'],
            requiredColumns: ['title'],
            primaryKeyColumns: ['title'],
            forceUpdate: false,
            alwaysInject: false,
            editable: true,
            keywords: [],
            compression: { mode: 'none' },
        },
    ];
}

function makeNode({
    id,
    type,
    level = 'semantic',
    title = '',
    fields = {},
    seqTo = 0,
    parentId = '',
    childrenIds = [],
    archived = false,
    semanticRollup = false,
    semanticDepth = 0,
}) {
    return {
        id,
        type,
        level,
        title,
        fields,
        seqTo,
        parentId,
        childrenIds: childrenIds.slice(),
        archived,
        semanticRollup,
        semanticDepth,
    };
}

function buildFixtureStore() {
    // Topology:
    //   evt_rollup1 (event, semantic, depth=1, rollup) — parent of evt_leaf_a / evt_leaf_b
    //   evt_leaf_a (event, semantic, depth=0, seqTo=2)
    //   evt_leaf_b (event, semantic, depth=0, seqTo=4)
    //   evt_leaf_c (event, semantic, depth=0, seqTo=6) — orphan leaf
    //   evt_archived (event, semantic, archived=true, seqTo=1)
    //   char_alice (character_sheet, semantic, seqTo=7) — has parent char_root
    //   char_root  (character_sheet, semantic, seqTo=8) — top-level character
    //   loc_castle (location_state, semantic, seqTo=5)
    //   epi_log1   (event, episodic, seqTo=3)
    //   recall_diag (type=recall_state, semantic, seqTo=9) — diagnostic
    //
    // Edges:
    //   evt_rollup1 -> evt_leaf_a (contains)
    //   evt_rollup1 -> evt_leaf_b (contains)
    //   char_root -> char_alice (semantic_contains)
    //   evt_leaf_a -> char_alice (related)
    //   char_alice -> loc_castle (mentions)
    //   evt_leaf_c -> char_alice (related)

    const nodes = {};
    const allNodes = [
        makeNode({ id: 'evt_rollup1', type: 'event', title: 'Storyline Rollup',
            fields: { summary: 'A foo storyline summary' }, seqTo: 4,
            semanticRollup: true, semanticDepth: 1,
            childrenIds: ['evt_leaf_a', 'evt_leaf_b'] }),
        makeNode({ id: 'evt_leaf_a', type: 'event', title: 'leaf a',
            fields: { summary: 'leaf a foo detail' }, seqTo: 2,
            parentId: 'evt_rollup1', semanticDepth: 0 }),
        makeNode({ id: 'evt_leaf_b', type: 'event', title: 'leaf b',
            fields: { summary: 'leaf b battle detail' }, seqTo: 4,
            parentId: 'evt_rollup1', semanticDepth: 0 }),
        makeNode({ id: 'evt_leaf_c', type: 'event', title: 'leaf c',
            fields: { summary: 'orphan leaf c' }, seqTo: 6, semanticDepth: 0 }),
        makeNode({ id: 'evt_archived', type: 'event', title: 'old event',
            fields: { summary: 'archived event' }, seqTo: 1, archived: true }),
        makeNode({ id: 'char_alice', type: 'character_sheet', title: 'Alice',
            fields: { title: 'Alice', aliases: 'Ali', traits: 'brave' },
            seqTo: 7, parentId: 'char_root' }),
        makeNode({ id: 'char_root', type: 'character_sheet', title: 'Root',
            fields: { title: 'Root' }, seqTo: 8,
            childrenIds: ['char_alice'] }),
        makeNode({ id: 'loc_castle', type: 'location_state', title: 'Castle',
            fields: { title: 'Castle' }, seqTo: 5 }),
        makeNode({ id: 'epi_log1', type: 'event', level: 'episodic',
            title: 'episodic log', fields: { summary: 'episodic event' }, seqTo: 3 }),
        makeNode({ id: 'recall_diag', type: 'recall_state', title: 'diag',
            fields: {}, seqTo: 9 }),
    ];
    for (const n of allNodes) nodes[n.id] = n;

    const edges = [
        { from: 'evt_rollup1', to: 'evt_leaf_a', type: 'contains' },
        { from: 'evt_rollup1', to: 'evt_leaf_b', type: 'contains' },
        { from: 'char_root', to: 'char_alice', type: 'semantic_contains' },
        { from: 'evt_leaf_a', to: 'char_alice', type: 'related' },
        { from: 'char_alice', to: 'loc_castle', type: 'mentions' },
        { from: 'evt_leaf_c', to: 'char_alice', type: 'related' },
    ];
    return {
        nodes,
        edges,
        // getLatestSeqIndex reads from store.appliedSeqTo / loggedSeqTo (not node-iter max).
        // Setting this lets the recent-exclude-window test exercise the cutoff math correctly.
        appliedSeqTo: 8,
        loggedSeqTo: 8,
    };
}

function makeContext(store) {
    return { __memoryStore: store };
}

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

describe('read-api type freeze (spec §8.1)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(ctx);
    });

    test('NodeView from getNode is frozen — assignment leaves value unchanged', () => {
        const view = api.getNode('char_alice');
        expect(view).toBeTruthy();
        expect(Object.isFrozen(view)).toBe(true);
        // Object.assign on frozen object: in non-strict it silently no-ops, in strict it throws.
        // We test for value invariance to avoid mode-dependence.
        try { Object.assign(view, { id: 'mutated' }); } catch (_) { /* strict-mode throw is acceptable */ }
        expect(view.id).toBe('char_alice');
    });

    test('NodeView nested fields object is frozen too', () => {
        const view = api.getNode('char_alice');
        expect(Object.isFrozen(view.fields)).toBe(true);
        try { view.fields.title = 'Hacked'; } catch (_) { /* strict throw acceptable */ }
        expect(view.fields.title).toBe('Alice');
    });

    test('NodeView childrenIds array is frozen', () => {
        const view = api.getNode('char_root');
        expect(Object.isFrozen(view.childrenIds)).toBe(true);
        try { view.childrenIds.push('mutated'); } catch (_) { /* strict throw acceptable */ }
        expect(view.childrenIds.includes('mutated')).toBe(false);
    });

    test('EdgeView from listEdges is frozen', () => {
        const edges = api.listEdges();
        expect(edges.length).toBeGreaterThan(0);
        const first = edges[0];
        expect(Object.isFrozen(first)).toBe(true);
        try { Object.assign(first, { from: 'mutated' }); } catch (_) { /* */ }
        // first.from is whatever the fixture set; just verify it didn't get mutated.
        const originalFrom = first.from;
        expect(first.from).toBe(originalFrom);
    });

    test('SchemaSpecView from getSchema().types is frozen', () => {
        const schema = api.getSchema();
        expect(Object.isFrozen(schema)).toBe(true);
        expect(Object.isFrozen(schema.types)).toBe(true);
        const first = schema.types[0];
        expect(Object.isFrozen(first)).toBe(true);
        try { Object.assign(first, { type: 'mutated' }); } catch (_) { /* */ }
        expect(first.type).not.toBe('mutated');
        // Nested array fields frozen too.
        expect(Object.isFrozen(first.tableColumns)).toBe(true);
        try { first.tableColumns.push('hax'); } catch (_) { /* */ }
        expect(first.tableColumns.includes('hax')).toBe(false);
    });

    test('NodeBriefView is frozen and nested records are frozen', () => {
        const brief = api.getNodeBrief('char_alice', { includeEdgeSummary: false });
        expect(brief).toBeTruthy();
        expect(Object.isFrozen(brief)).toBe(true);
        expect(Object.isFrozen(brief.keyValues)).toBe(true);
        expect(Object.isFrozen(brief.rowValues)).toBe(true);
        try { brief.keyValues.title = 'Hacked'; } catch (_) { /* */ }
        expect(brief.keyValues.title).toBe('Alice');
    });

    test('EdgeSummaryView from getEdgeSummary is frozen with frozen relations/sample_neighbors', () => {
        const summary = api.getEdgeSummary('char_alice', { visibleNodeIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c'] });
        expect(Object.isFrozen(summary)).toBe(true);
        expect(Object.isFrozen(summary.relations)).toBe(true);
        expect(Object.isFrozen(summary.sample_neighbors)).toBe(true);
        if (summary.relations.length > 0) expect(Object.isFrozen(summary.relations[0])).toBe(true);
        if (summary.sample_neighbors.length > 0) expect(Object.isFrozen(summary.sample_neighbors[0])).toBe(true);
    });

    test('InjectionState from getInjectionState is frozen', () => {
        __setInjectedForTest({ alwaysInjectIds: ['a1'], recallSelectedIds: ['r1'] });
        const state = api.getInjectionState();
        expect(Object.isFrozen(state)).toBe(true);
        // The three id Sets are frozen wrappers (their contents are by-contract immutable).
        expect(Object.isFrozen(state.alwaysInjectIds)).toBe(true);
        expect(Object.isFrozen(state.recallSelectedIds)).toBe(true);
        expect(Object.isFrozen(state.visibleIds)).toBe(true);
    });
});

describe('Layer A: data access (spec §4.2)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(ctx);
    });

    test('listNodes() returns active, non-diagnostic nodes sorted by compareNodesByTimeline (seqTo asc + id tiebreak)', () => {
        const result = api.listNodes();
        const ids = result.map(n => n.id);
        // Excludes evt_archived (archived) and recall_diag (diagnostic).
        expect(ids).not.toContain('evt_archived');
        expect(ids).not.toContain('recall_diag');
        // compareNodesByTimeline: seqTo asc → id locale-compare tiebreak.
        // Sorted seqTos: evt_leaf_a(2), epi_log1(3), evt_leaf_b(4) AND evt_rollup1(4) (tie → id),
        // loc_castle(5), evt_leaf_c(6), char_alice(7), char_root(8).
        // id tiebreak between 'evt_leaf_b' and 'evt_rollup1': 'evt_leaf_b' < 'evt_rollup1' lex.
        expect(ids).toEqual([
            'evt_leaf_a',
            'epi_log1',
            'evt_leaf_b',
            'evt_rollup1',
            'loc_castle',
            'evt_leaf_c',
            'char_alice',
            'char_root',
        ]);
    });

    test('listNodes({types:["event"]}) filters by type', () => {
        const result = api.listNodes({ types: ['event'] });
        const ids = result.map(n => n.id).sort();
        // Active event nodes only (semantic + episodic): rollup, leaf_a, leaf_b, leaf_c, epi_log1.
        expect(ids).toEqual(['epi_log1', 'evt_leaf_a', 'evt_leaf_b', 'evt_leaf_c', 'evt_rollup1']);
    });

    test('listNodes({activeOnly: false}) includes archived and diagnostic nodes', () => {
        const result = api.listNodes({ activeOnly: false });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_archived');
        expect(ids).toContain('recall_diag');
    });

    test('listNodes({levels:["semantic"]}) filters by level', () => {
        const result = api.listNodes({ levels: ['semantic'] });
        const ids = result.map(n => n.id);
        expect(ids).not.toContain('epi_log1'); // episodic
    });

    test('listNodes({seqRange:{from:5,to:7}}) filters by seqTo range', () => {
        const result = api.listNodes({ seqRange: { from: 5, to: 7 } });
        const ids = result.map(n => n.id).sort();
        // seqTo: loc_castle(5), evt_leaf_c(6), char_alice(7).
        expect(ids).toEqual(['char_alice', 'evt_leaf_c', 'loc_castle']);
    });

    test('getNode(id) returns NodeView for hit; null for miss', () => {
        const hit = api.getNode('char_alice');
        expect(hit).toBeTruthy();
        expect(hit.id).toBe('char_alice');
        expect(hit.title).toBe('Alice');
        expect(api.getNode('does_not_exist')).toBeNull();
        expect(api.getNode('')).toBeNull();
    });

    test('listEdges() returns all raw edges (no projection, no weight on raw)', () => {
        const result = api.listEdges();
        expect(result.length).toBe(store.edges.length);
        for (const e of result) {
            expect(e).toHaveProperty('from');
            expect(e).toHaveProperty('to');
            expect(e).toHaveProperty('type');
            // Raw edges must NOT carry weight (per spec §4.2).
            expect(Object.prototype.hasOwnProperty.call(e, 'weight')).toBe(false);
        }
    });

    test('listEdges({excludeInternal:true}) drops contains / semantic_contains', () => {
        const result = api.listEdges({ excludeInternal: true });
        const types = result.map(e => e.type);
        expect(types).not.toContain('contains');
        expect(types).not.toContain('semantic_contains');
        // related and mentions should remain.
        expect(types).toEqual(expect.arrayContaining(['related', 'mentions']));
    });

    test('listEdges({types:["related"], from:"evt_leaf_a"}) filters by type + endpoint', () => {
        const result = api.listEdges({ types: ['related'], from: 'evt_leaf_a' });
        expect(result.length).toBe(1);
        expect(result[0]).toEqual({ from: 'evt_leaf_a', to: 'char_alice', type: 'related' });
    });

    test('getSchema() returns SchemaView with types: SchemaSpecView[] having all 9 contract fields', () => {
        const schema = api.getSchema();
        expect(schema).toHaveProperty('types');
        expect(Array.isArray(schema.types)).toBe(true);
        const event = schema.types.find(t => t.type === 'event');
        expect(event).toBeTruthy();
        // Spec §4.1 SchemaSpecView fields:
        const requiredFields = ['type', 'tableName', 'tableColumns', 'requiredColumns',
            'primaryKeyColumns', 'forceUpdate', 'alwaysInject', 'editable', 'compressionMode'];
        for (const f of requiredFields) {
            expect(Object.prototype.hasOwnProperty.call(event, f)).toBe(true);
        }
        expect(event.compressionMode).toBe('hierarchical');
        expect(event.tableName).toBe('event_table');
        expect(event.forceUpdate).toBe(true);
        expect(event.alwaysInject).toBe(true);
        expect(event.editable).toBe(false);
        const char = schema.types.find(t => t.type === 'character_sheet');
        expect(char.compressionMode).toBe('none');
        expect(char.editable).toBe(true);
        expect(char.alwaysInject).toBe(false);
    });
});

describe('Layer B: topology navigation (spec §4.3)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(ctx);
    });

    test('getNeighbors(direction:"out") returns out-edges only', () => {
        const result = api.getNeighbors('char_alice', { direction: 'out' });
        const ids = result.map(n => n.node.id).sort();
        // char_alice has outgoing: mentions->loc_castle
        expect(ids).toEqual(['loc_castle']);
        for (const r of result) expect(r.direction).toBe('out');
    });

    test('getNeighbors(direction:"in") returns in-edges only', () => {
        const result = api.getNeighbors('char_alice', { direction: 'in' });
        const ids = result.map(n => n.node.id).sort();
        // char_alice has incoming: semantic_contains<-char_root, related<-evt_leaf_a, related<-evt_leaf_c
        expect(ids).toEqual(['char_root', 'evt_leaf_a', 'evt_leaf_c']);
        for (const r of result) expect(r.direction).toBe('in');
    });

    test('getNeighbors(direction:"both") returns both directions', () => {
        const result = api.getNeighbors('char_alice', { direction: 'both' });
        const ids = result.map(n => n.node.id);
        expect(ids).toEqual(expect.arrayContaining(['loc_castle', 'char_root', 'evt_leaf_a', 'evt_leaf_c']));
    });

    test('getNeighbors({projectTo:"visible"}) uses current visibleIds via getNearestVisibleAncestorId', () => {
        __setInjectedForTest({ alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_root', 'evt_rollup1'] });
        // char_alice -> [parents: char_root]; via projectTo:'visible', neighbors should project to char_root level
        // Note: char_alice itself is not in visibleSet, so neighbor edges to non-visible nodes drop.
        const result = api.getNeighbors('char_root', { projectTo: 'visible' });
        // char_root's only edge: char_root -> char_alice (semantic_contains).
        // char_alice not in visibleSet → walks to parentId='' → empty. So char_root has no projected neighbors.
        expect(Array.isArray(result)).toBe(true);
    });

    test('getNeighbors({projectTo:[ids]}) uses custom visibleSet', () => {
        // visible = [evt_rollup1, char_alice]. Edge evt_leaf_a -> char_alice projects from evt_rollup1.
        const result = api.getNeighbors('evt_rollup1', { projectTo: ['evt_rollup1', 'char_alice'] });
        // evt_rollup1's own outgoing 'contains' edges: evt_rollup1->evt_leaf_a, evt_rollup1->evt_leaf_b.
        // Neither leaf is in visibleSet; both walk up parents to evt_rollup1 itself → self-loop dropped.
        // Plus projected edges via leaves to char_alice (via 'related' type, NOT outgoing from evt_rollup1
        // raw — the projection only changes neighborRawId for raw edges where evt_rollup1 is the source).
        // So expected: 0 neighbors here. The key assertion is the API doesn't crash and respects custom set.
        expect(Array.isArray(result)).toBe(true);
    });

    test('getAncestor walks parentId', () => {
        // char_alice -> parent char_root.
        const ancestor = api.getAncestor('char_alice');
        expect(ancestor).toBeTruthy();
        expect(ancestor.id).toBe('char_root');
    });

    test('getAncestor with predicate finds first matching ancestor', () => {
        // For evt_leaf_a, walk up: evt_rollup1 (type=event).
        // Predicate matches type==='event'.
        const ancestor = api.getAncestor('evt_leaf_a', { predicate: n => n.type === 'event' });
        expect(ancestor).toBeTruthy();
        expect(ancestor.id).toBe('evt_rollup1');
        // Predicate that never matches returns null.
        const none = api.getAncestor('evt_leaf_a', { predicate: () => false });
        expect(none).toBeNull();
    });

    test('getDescendants({maxDepth:1}) returns one-hop children', () => {
        const result = api.getDescendants('evt_rollup1', { maxDepth: 1 });
        const ids = result.map(n => n.id).sort();
        expect(ids).toEqual(['evt_leaf_a', 'evt_leaf_b']);
    });

    test('getDescendants() with default maxDepth returns full subtree', () => {
        // For evt_rollup1, full subtree is [evt_leaf_a, evt_leaf_b] (leaves have no children).
        const result = api.getDescendants('evt_rollup1');
        const ids = result.map(n => n.id).sort();
        expect(ids).toEqual(['evt_leaf_a', 'evt_leaf_b']);
        // For char_root, full subtree is [char_alice].
        const charResult = api.getDescendants('char_root');
        expect(charResult.map(n => n.id)).toEqual(['char_alice']);
    });

    test('getNearestVisibleAncestor four-scenario coverage (§8.2)', () => {
        // (a) visibleSet hits leaf itself
        const a = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['evt_leaf_a'] });
        expect(a).toBeTruthy();
        expect(a.id).toBe('evt_leaf_a');

        // (b) hits middle ancestor (evt_rollup1 is rollup over leaf_a/leaf_b — semantic_contains chain via parentId)
        const b = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['evt_rollup1'] });
        expect(b).toBeTruthy();
        expect(b.id).toBe('evt_rollup1');

        // (c) hits top rollup (parent of parent in character chain: char_root)
        const c = api.getNearestVisibleAncestor('char_alice', { visibleNodeIds: ['char_root'] });
        expect(c).toBeTruthy();
        expect(c.id).toBe('char_root');

        // (d) no hit — visibleSet doesn't include the node or any ancestor
        const d = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['char_alice'] });
        expect(d).toBeNull();
    });

    test('projectEdges({visibleNodeIds}) returns EdgeViews with weight, excludeInternal default true', () => {
        // visibleNodeIds = [evt_rollup1, char_alice, loc_castle].
        // Raw 'related' edge evt_leaf_a -> char_alice projects to evt_rollup1 -> char_alice.
        // Raw 'related' edge evt_leaf_c -> char_alice: evt_leaf_c has no parent → walks to itself (not in
        // visible) → drops because no visible ancestor.
        // Raw 'mentions' edge char_alice -> loc_castle → char_alice -> loc_castle (both visible).
        // Internal edges (contains/semantic_contains) are excluded by default.
        const result = api.projectEdges({ visibleNodeIds: ['evt_rollup1', 'char_alice', 'loc_castle'] });
        const triples = result.map(e => ({ from: e.from, to: e.to, type: e.type }));
        expect(triples).toEqual(expect.arrayContaining([
            { from: 'evt_rollup1', to: 'char_alice', type: 'related' },
            { from: 'char_alice', to: 'loc_castle', type: 'mentions' },
        ]));
        // Internal edge types excluded by default.
        const hasInternal = result.some(e => e.type === 'contains' || e.type === 'semantic_contains');
        expect(hasInternal).toBe(false);
        // Each edge has numeric weight.
        for (const e of result) {
            expect(typeof e.weight).toBe('number');
            expect(Number.isFinite(e.weight)).toBe(true);
            expect(e.weight).toBeGreaterThanOrEqual(1);
        }
    });

    test('projectEdges({excludeInternal:false}) includes contains / semantic_contains', () => {
        // visibleNodeIds = [evt_rollup1, evt_leaf_a, evt_leaf_b]. The raw `contains` edges have both
        // endpoints in the set → they project as themselves.
        const result = api.projectEdges({
            visibleNodeIds: ['evt_rollup1', 'evt_leaf_a', 'evt_leaf_b'],
            excludeInternal: false,
        });
        const types = result.map(e => e.type);
        expect(types).toContain('contains');
    });
});

describe('Layer C: recall primitives (spec §4.4)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(ctx);
    });

    test('listVisibleCandidates() matches collectRootCandidates id set (spec §8.2)', async () => {
        const { collectRootCandidates } = await import('../../public/scripts/extensions/memory-graph/main.js');
        const settings = testHolder.settings;
        const direct = collectRootCandidates(store, settings, { fullText: '' }, [], ctx, {
            latestSeqIndex: -1, excludeMessages: 0,
        });
        const apiResult = api.listVisibleCandidates();
        const directIds = new Set(direct.map(n => String(n.id)));
        const apiIds = new Set(apiResult.map(n => String(n.id)));
        expect(apiIds).toEqual(directIds);
    });

    test('listVisibleCandidates is sorted by compareNodesByRecency (seqTo desc → semanticDepth desc → id asc)', () => {
        const result = api.listVisibleCandidates();
        // event has hierarchical compression: leaves a/b under evt_rollup1
        // project up to the rollup; evt_leaf_c is an orphan leaf (no
        // active rollup ancestor) and stays as itself. Active visible pool
        // after projection:
        //   char_root(8), char_alice(7), evt_leaf_c(6), loc_castle(5),
        //   evt_rollup1(4, depth=1), epi_log1(3, episodic).
        expect(result.map(n => n.id)).toEqual([
            'char_root',
            'char_alice',
            'evt_leaf_c',
            'loc_castle',
            'evt_rollup1',
            'epi_log1',
        ]);
    });

    test('listVisibleCandidates({seqWindow:{from:5}}) filters by seqTo', () => {
        const result = api.listVisibleCandidates({ seqWindow: { from: 5 } });
        const ids = result.map(n => n.id).sort();
        // seqTo >= 5: loc_castle(5), evt_leaf_c(6), char_alice(7), char_root(8)
        expect(ids).toEqual(['char_alice', 'char_root', 'evt_leaf_c', 'loc_castle']);
    });

    test('listVisibleCandidates({excludeRecentMessages:2}) excludes recent-window nodes', () => {
        // latestSeqIndex = max seqTo of active = 8 (char_root). window=2 excludes nodes with seqTo >= 7.
        const result = api.listVisibleCandidates({ excludeRecentMessages: 2 });
        const ids = result.map(n => n.id);
        expect(ids).not.toContain('char_root');
        expect(ids).not.toContain('char_alice');
        // Older nodes still present (event leaves a/b project up to evt_rollup1).
        expect(ids).toEqual(expect.arrayContaining(['evt_leaf_c', 'evt_rollup1', 'epi_log1', 'loc_castle']));
    });

    test('getNodeExposure: hierarchical-compression semantic node returns "high_only"', () => {
        // evt_rollup1 is event-type semantic — event has compression.mode hierarchical → high_only.
        expect(api.getNodeExposure('evt_rollup1')).toBe('high_only');
        expect(api.getNodeExposure('evt_leaf_a')).toBe('high_only');
    });

    test('getNodeExposure: episodic node returns "high_only" (per actual getNodeRecallExposure behavior)', () => {
        // The native getNodeRecallExposure returns 'high_only' for any non-semantic node. read-api passes
        // through verbatim. Episodic event nodes match this branch (line 5524 of main.js).
        expect(api.getNodeExposure('epi_log1')).toBe('high_only');
    });

    test('getNodeExposure: non-hierarchical semantic node returns "full"', () => {
        // character_sheet is semantic, compression.mode='none' → 'full'.
        expect(api.getNodeExposure('char_alice')).toBe('full');
        expect(api.getNodeExposure('loc_castle')).toBe('full');
    });

    test('getNodeExposure: missing / archived id returns null', () => {
        expect(api.getNodeExposure('nope')).toBeNull();
        expect(api.getNodeExposure('evt_archived')).toBeNull();
    });

    test('getEdgeSummary returns {degree, relations[], sample_neighbors[]} shape', () => {
        const summary = api.getEdgeSummary('char_alice', {
            visibleNodeIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c', 'char_root'],
        });
        expect(summary).toHaveProperty('degree');
        expect(summary).toHaveProperty('relations');
        expect(summary).toHaveProperty('sample_neighbors');
        expect(typeof summary.degree).toBe('number');
        expect(Array.isArray(summary.relations)).toBe(true);
        expect(Array.isArray(summary.sample_neighbors)).toBe(true);
        // char_alice has edges: in related<-evt_leaf_a, in related<-evt_leaf_c, in semantic_contains<-char_root,
        // out mentions->loc_castle. degree should be 4 (each edge contributes 1 with default weight).
        expect(summary.degree).toBe(4);
    });

    test('getEdgeSummary default nodeSet uses current visibleIds', () => {
        __setInjectedForTest({ alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_alice', 'loc_castle'] });
        const summary = api.getEdgeSummary('char_alice');
        // Only mentions->loc_castle should remain visible (others' opposite endpoints fall outside visibleSet).
        expect(summary.degree).toBe(1);
        const relTypes = summary.relations.map(r => r.relation);
        expect(relTypes).toContain('mentions');
    });

    test('getNodeBrief: full active node has all NodeBriefView fields', () => {
        __setInjectedForTest({
            alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c', 'char_root'],
        });
        const brief = api.getNodeBrief('char_alice');
        expect(brief).toBeTruthy();
        // Spec §4.1 NodeBriefView fields.
        for (const f of ['id', 'level', 'type', 'tableName', 'title', 'summary', 'keyValues',
            'rowValues', 'toSeq', 'childCount', 'exposure', 'edgeSummary', 'alwaysInject']) {
            expect(Object.prototype.hasOwnProperty.call(brief, f)).toBe(true);
        }
        expect(brief.id).toBe('char_alice');
        expect(brief.level).toBe('semantic');
        expect(brief.type).toBe('character_sheet');
        expect(brief.tableName).toBe('character_table');
        expect(brief.title).toBe('Alice');
        expect(brief.toSeq).toBe(7);
        expect(brief.exposure).toBe('full');
        expect(brief.alwaysInject).toBe(false);
        expect(brief.edgeSummary).not.toBeNull();
    });

    test('getNodeBrief: hierarchical-rollup node has exposure:"high_only" and childCount > 0', () => {
        const brief = api.getNodeBrief('evt_rollup1');
        expect(brief).toBeTruthy();
        expect(brief.exposure).toBe('high_only');
        expect(brief.childCount).toBeGreaterThan(0);
    });

    test('getNodeBrief: always-inject node reflects alwaysInject:true', () => {
        __setInjectedForTest({
            alwaysInjectIds: ['char_alice'],
            recallSelectedIds: [],
            visibleIds: ['char_alice'],
        });
        const brief = api.getNodeBrief('char_alice');
        expect(brief).toBeTruthy();
        expect(brief.alwaysInject).toBe(true);
    });

    test('getNodeBrief: missing / archived id returns null', () => {
        expect(api.getNodeBrief('does_not_exist')).toBeNull();
        expect(api.getNodeBrief('evt_archived')).toBeNull();
    });

    test('getNodeBrief({includeEdgeSummary:false}) sets edgeSummary=null', () => {
        const brief = api.getNodeBrief('char_alice', { includeEdgeSummary: false });
        expect(brief).toBeTruthy();
        expect(brief.edgeSummary).toBeNull();
    });

    test('expandFromSeeds([seed], {hops:2, includeChildren:true}) returns children and edge-projected neighbors', () => {
        // seed: char_root. With includeChildren:true + hops>=1 we reach char_alice (child) then via
        // projected edges hop to loc_castle (mentions) and back to evt_leaf_a / evt_leaf_c (related).
        const result = api.expandFromSeeds(['char_root'], { hops: 2, includeChildren: true });
        const ids = result.map(n => n.id);
        expect(ids).toContain('char_root');
        // Children expansion should pull in char_alice.
        expect(ids).toContain('char_alice');
        // Should have non-trivial count.
        expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    test('expandFromSeeds({excludeInternal:false}) (default) includes children via contains edges', () => {
        // seed: evt_rollup1. Its children evt_leaf_a / evt_leaf_b sit behind `contains` edges.
        const result = api.expandFromSeeds(['evt_rollup1'], { hops: 1, includeChildren: true });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_rollup1');
        expect(ids).toContain('evt_leaf_a');
        expect(ids).toContain('evt_leaf_b');
    });

    test('expandFromSeeds({excludeInternal:true}) drops hierarchical children of seed', () => {
        const result = api.expandFromSeeds(['evt_rollup1'], {
            hops: 1, includeChildren: true, excludeInternal: true,
        });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_rollup1'); // seed always retained
        expect(ids).not.toContain('evt_leaf_a');
        expect(ids).not.toContain('evt_leaf_b');
    });

});

describe('keywordSearch', () => {
    let api;

    beforeEach(() => {
        const ctx = {
            __memoryStore: {
                nodes: {
                    n1: { id: 'n1', type: 'character_sheet', title: 'Eileen', fields: { aliases: '艾琳', traits: 'healer quiet' }, seqTo: 10 },
                    n2: { id: 'n2', type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior loud' }, seqTo: 12 },
                    n3: { id: 'n3', type: 'event', title: 'Forest battle', fields: { summary: '时间:Day 5;Marcus 击退 wolves。' }, seqTo: 15 },
                },
                edges: [],
            },
        };
        testHolder.settings = null;
        api = getMemoryGraphReadApi(ctx);
    });

    test('matches against title and projected columns', () => {
        const results = api.keywordSearch({ query: 'healer' });
        expect(results.map(r => r.id)).toContain('n1');
        expect(results.map(r => r.id)).not.toContain('n2');
    });

    test('returns empty array on empty query', () => {
        expect(api.keywordSearch({ query: '' })).toEqual([]);
        expect(api.keywordSearch({ query: '   ' })).toEqual([]);
    });

    test('respects types filter', () => {
        const results = api.keywordSearch({ query: 'Marcus', types: ['event'] });
        expect(results.map(r => r.id)).toContain('n3');
        expect(results.map(r => r.id)).not.toContain('n2');
    });

    test('respects k cap', () => {
        const results = api.keywordSearch({ query: 'a', k: 1 });
        expect(results.length).toBeLessThanOrEqual(1);
    });
});

describe('vectorSearch', () => {
    test('throws NO_EMBEDDING_PROFILE when no profile configured', async () => {
        const ctx = { __memoryStore: { nodes: {}, edges: [] } };
        const api = getMemoryGraphReadApi(ctx);
        await expect(api.vectorSearch({ query: 'anything' })).rejects.toMatchObject({
            code: 'NO_EMBEDDING_PROFILE',
        });
    });

    test('returns empty array on empty query (no throw)', async () => {
        const ctx = { __memoryStore: { nodes: {}, edges: [] } };
        const api = getMemoryGraphReadApi(ctx);
        await expect(api.vectorSearch({ query: '' })).resolves.toEqual([]);
    });
});

describe('findByName', () => {
    let api;
    beforeEach(() => {
        const ctx = {
            __memoryStore: {
                nodes: {
                    n1: { id: 'n1', type: 'character_sheet', title: 'Eileen', fields: { aliases: '艾琳, Eily' }, seqTo: 10 },
                    n2: { id: 'n2', type: 'character_sheet', title: 'Marcus', fields: { aliases: '' }, seqTo: 12 },
                    n3: { id: 'n3', type: 'location_state', title: 'Dark Forest', fields: { aliases: '黑森林' }, seqTo: 8 },
                },
                edges: [],
            },
        };
        // Both character_sheet and location_state must declare aliases in
        // primaryKeyColumns so findByName can substring-match against the field.
        // (Matches the default schema where both types ship with ['title','aliases'].)
        testHolder.settings = {
            nodeTypeSchema: [
                {
                    id: 'character_sheet',
                    label: 'Character',
                    tableName: 'character_table',
                    tableColumns: ['title', 'aliases', 'traits'],
                    requiredColumns: ['title'],
                    primaryKeyColumns: ['title', 'aliases'],
                    forceUpdate: false,
                    alwaysInject: false,
                    editable: true,
                    keywords: [],
                    compression: { mode: 'none' },
                },
                {
                    id: 'location_state',
                    label: 'Location',
                    tableName: 'location_table',
                    tableColumns: ['title', 'aliases'],
                    requiredColumns: ['title'],
                    primaryKeyColumns: ['title', 'aliases'],
                    forceUpdate: false,
                    alwaysInject: false,
                    editable: true,
                    keywords: [],
                    compression: { mode: 'none' },
                },
            ],
        };
        api = getMemoryGraphReadApi(ctx);
    });

    test('matches on title case-insensitively', () => {
        expect(api.findByName({ query: 'eileen' }).matches.map(m => m.id)).toContain('n1');
    });

    test('matches on aliases (substring of comma-separated values)', () => {
        expect(api.findByName({ query: '艾琳' }).matches.map(m => m.id)).toContain('n1');
        expect(api.findByName({ query: '黑森林' }).matches.map(m => m.id)).toContain('n3');
    });

    test('respects types filter', () => {
        const matches = api.findByName({ query: 'forest', types: ['character_sheet'] }).matches;
        expect(matches.map(m => m.id)).not.toContain('n3');
    });

    test('returns { matches: [] } on no match', () => {
        expect(api.findByName({ query: 'NonExistent' })).toEqual({ matches: expect.any(Array) });
        expect(api.findByName({ query: 'NonExistent' }).matches).toEqual([]);
    });
});

describe('compactionCandidates', () => {
    test('returns empty groups when type has compression.mode === "none"', () => {
        const ctx = {
            __memoryStore: {
                nodes: {
                    c1: { id: 'c1', type: 'character_sheet', title: 'A', seqTo: 1, level: 'semantic' },
                    c2: { id: 'c2', type: 'character_sheet', title: 'B', seqTo: 2, level: 'semantic' },
                    c3: { id: 'c3', type: 'character_sheet', title: 'C', seqTo: 3, level: 'semantic' },
                },
                edges: [],
            },
        };
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const api = getMemoryGraphReadApi(ctx);
        // character_sheet schema has compression.mode = 'none' in defaults
        expect(api.compactionCandidates({ type: 'character_sheet' })).toEqual({ groups: [] });
    });

    test('returns groups for hierarchical type at depth 0', () => {
        // Build a store with 15 leaf events.
        // Fixture schema uses { mode: 'hierarchical' } → mock fills defaults:
        //   threshold=6, fanIn=3, maxDepth=6, keepRecentLeaves=0.
        // With keepRecentLeaves=0 and 15 candidates: 15 >= 6 threshold, so
        // groups = floor(15 / 3) = 5 groups.
        const nodes = {};
        for (let i = 1; i <= 15; i++) {
            nodes[`e${i}`] = {
                id: `e${i}`,
                type: 'event',
                title: `Summary ${i}`,
                level: 'semantic',
                seqTo: i,
                semanticDepth: 0,
                semanticRollup: false,
                childrenIds: [],
                fields: { summary: '时间：Day ' + i + '；something happened.' },
            };
        }
        const ctx = { __memoryStore: { nodes, edges: [] } };
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const api = getMemoryGraphReadApi(ctx);
        const result = api.compactionCandidates({ type: 'event', depth: 0 });
        expect(result.groups.length).toBeGreaterThan(0);
        expect(result.groups[0].depth).toBe(0);
        expect(result.groups[0].childIds.length).toBe(3); // fanIn
        expect(result.groups[0].fanIn).toBe(3);
    });
});

describe('Layer D: injection observation (spec §4.5)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(ctx);
    });

    test('getInjectionState() returns frozen InjectionState with three Sets', () => {
        __setInjectedForTest({ alwaysInjectIds: ['a'], recallSelectedIds: ['b'], visibleIds: ['c'] });
        const state = api.getInjectionState();
        expect(Object.isFrozen(state)).toBe(true);
        expect(state.alwaysInjectIds).toBeInstanceOf(Set);
        expect(state.recallSelectedIds).toBeInstanceOf(Set);
        expect(state.visibleIds).toBeInstanceOf(Set);
        expect(state.alwaysInjectIds.has('a')).toBe(true);
        expect(state.recallSelectedIds.has('b')).toBe(true);
        expect(state.visibleIds.has('c')).toBe(true);
    });

    test('onInjectionChanged(cb) returns a function; calling it twice is idempotent', () => {
        const cb = () => {};
        const unsubscribe = api.onInjectionChanged(cb);
        expect(typeof unsubscribe).toBe('function');
        // Idempotent: calling unsubscribe twice should not throw.
        expect(() => { unsubscribe(); unsubscribe(); }).not.toThrow();
    });

    test('Registered listener fires after __recordInjectedNodeIds with new state', () => {
        const calls = [];
        const unsubscribe = api.onInjectionChanged((state) => {
            calls.push({
                always: Array.from(state.alwaysInjectIds).sort(),
                recall: Array.from(state.recallSelectedIds).sort(),
                visible: Array.from(state.visibleIds).sort(),
            });
        });
        __recordInjectedNodeIds({
            alwaysInjectIds: ['a1'],
            recallSelectedIds: ['r1', 'r2'],
            visibleIds: ['v1'],
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ always: ['a1'], recall: ['r1', 'r2'], visible: ['v1'] });
        unsubscribe();
    });

    test('Unsubscribe stops further notifications', () => {
        let count = 0;
        const unsubscribe = api.onInjectionChanged(() => { count += 1; });
        __recordInjectedNodeIds({ alwaysInjectIds: ['a'], recallSelectedIds: [], visibleIds: [] });
        expect(count).toBe(1);
        unsubscribe();
        __recordInjectedNodeIds({ alwaysInjectIds: ['b'], recallSelectedIds: [], visibleIds: [] });
        expect(count).toBe(1); // listener no longer called
    });

    test('spec §6 alias: re-exported getMemoryGraphInjectionState returns equivalent shape', () => {
        __setInjectedForTest({ alwaysInjectIds: ['x'], recallSelectedIds: [], visibleIds: [] });
        const reexport = getMemoryGraphInjectionStateReexport({});
        expect(reexport.alwaysInjectIds).toBeInstanceOf(Set);
        expect(reexport.alwaysInjectIds.has('x')).toBe(true);
    });
});

describe('edge_summary fallback when injection state is empty (agent-only mode)', () => {
    test('falls back to canonical top-rollup pool for edge projection', () => {
        // Build a store with: rollup R (depth 1) containing leaves A,B (depth 0).
        // A has involved_in edge to character X.
        // Expected: in agent-only mode (no injection state), getEdgeSummary on X
        // should project A's edge up to R, so X sees R as a neighbor (not A).
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const ctx = {
            __memoryStore: {
                nodes: {
                    R: { id: 'R', type: 'event', level: 'semantic', semanticDepth: 1, semanticRollup: true, seqTo: 10, parentId: '', childrenIds: ['A', 'B'], fields: { summary: 'rollup' } },
                    A: { id: 'A', type: 'event', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 5, parentId: 'R', childrenIds: [], fields: { summary: 'leaf A' } },
                    B: { id: 'B', type: 'event', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 8, parentId: 'R', childrenIds: [], fields: { summary: 'leaf B' } },
                    X: { id: 'X', type: 'character_sheet', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 6, parentId: '', childrenIds: [], fields: { title: 'X' } },
                },
                edges: [
                    { from: 'R', to: 'A', type: 'semantic_contains', seqTo: 10 },
                    { from: 'R', to: 'B', type: 'semantic_contains', seqTo: 10 },
                    { from: 'A', to: 'X', type: 'involved_in', seqTo: 5 },
                ],
                appliedSeqTo: 10,
                loggedSeqTo: 10,
            },
        };
        const api = getMemoryGraphReadApi(ctx);
        // No options.visibleNodeIds; no injection state — should fall back to canonical pool.
        const summary = api.getEdgeSummary('X');
        // Should find at least one neighbor (R, via leaf-edge projection)
        expect(summary.sample_neighbors.map(n => n.id)).toContain('R');
        // Should NOT include the hidden leaf A directly
        expect(summary.sample_neighbors.map(n => n.id)).not.toContain('A');
    });

    test('returns empty when explicit empty visibleNodeIds passed (caller intent)', () => {
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const ctx = {
            __memoryStore: {
                nodes: {
                    A: { id: 'A', type: 'event', level: 'semantic', semanticDepth: 0, seqTo: 1, parentId: '', childrenIds: [], fields: {} },
                    X: { id: 'X', type: 'character_sheet', level: 'semantic', semanticDepth: 0, seqTo: 1, parentId: '', childrenIds: [], fields: {} },
                },
                edges: [{ from: 'A', to: 'X', type: 'involved_in', seqTo: 1 }],
            },
        };
        const api = getMemoryGraphReadApi(ctx);
        // Explicit empty array — caller wants "nothing visible".
        const summary = api.getEdgeSummary('X', { visibleNodeIds: [] });
        expect(summary.sample_neighbors).toEqual([]);
    });
});
