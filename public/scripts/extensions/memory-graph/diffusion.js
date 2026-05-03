// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// PEDSA (Parallel Energy-Decay Spreading Activation) graph diffusion engine.
// Algorithm translated from PeroCore/TriviumDB (Apache-2.0) Rust implementation
// by YoKONCy (https://github.com/YoKONCy/PEDSA, https://github.com/YoKONCy/TriviumDB).
//
// Core formula: E_{t+1}(j) = sum_{i in N(j)} E_t(i) * W_ij * D_decay * degreePenalty * refractoryDamping
//
// Features:
// - Energy propagation with configurable decay
// - Entity-aware Ebbinghaus decay (RP-friendly: decays by entity activity, not global floor distance)
// - Lateral inhibition (Top-K pruning per step)
// - Inverse inhibition (high in-degree node penalty)
// - Refractory period (hot-node cooldown to prevent energy collapse)
// - Personalized PageRank (PPR) teleport
// - Dual-layer adjacency: semantic edges + temporal adjacency edges

const EDGE_CONDUCTANCE = {
 involved_in: 0.9,
 occurred_at: 0.7,
 updates: 0.8,
 advances: 0.6,
 related: 0.5,
 mentions: 0.4,
 evidence: 0.3,
};

const TYPE_HALF_LIFE = {
 event: 50,
 character_sheet: 200,
 location_state: 100,
 rule_constraint: Infinity,
};

const DEFAULT_OPTIONS = Object.freeze({
 maxSteps: 2,
 decayFactor: 0.6,
 topK: 100,
 minEnergy: 0.01,
 maxEnergy: 2.0,
 minEnergyClamp: -2.0,
 teleportAlpha: 0.0,
 refractoryDamping: 0.15,
 refractoryTopN: 15,
 temporalEdgeDecayScale: 10,
 temporalEdgeMaxStrength: 0.5,
 temporalEdgeMinStrength: 0.05,
 reverseEdgeAttenuation: 0.7,
 enableEntityAwareDecay: true,
 enableRefractoryPeriod: true,
 enableInverseDegreeInhibition: true,
 inverseDegreeExponent: 0.55,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNeighbor(map, nodeId, neighbor) {
 let list = map.get(nodeId);
 if (!list) {
 list = [];
 map.set(nodeId, list);
 }
 list.push(neighbor);
}

function clampEnergy(energy, opts) {
 return Math.max(opts.minEnergyClamp, Math.min(opts.maxEnergy, energy));
}

function computeInDegreeMap(adjacencyMap) {
 const inDegree = new Map();
 for (const neighbors of adjacencyMap.values()) {
 for (const neighbor of neighbors) {
 inDegree.set(neighbor.targetId, (inDegree.get(neighbor.targetId) || 0) + 1);
 }
 }
 return inDegree;
}

// ---------------------------------------------------------------------------
// Adjacency map construction
// ---------------------------------------------------------------------------

/**
 * Build a dual-layer adjacency map from the graph store.
 *
 * Layer 1: Semantic edges from store.edges.
 * Layer 2: Temporal adjacency edges between nodes close in seqTo (computed, not stored).
 *
 * @param {object} store - The memory graph store ({nodes, edges}).
 * @param {object} [opts] - Options forwarded from diffusion config.
 * @returns {Map<string, Array<{targetId: string, strength: number, edgeType: string, layer: string}>>}
 */
export function buildAdjacencyMap(store, opts = {}) {
 const options = { ...DEFAULT_OPTIONS, ...opts };
 const map = new Map();
 const nodes = store.nodes || {};
 const edges = Array.isArray(store.edges) ? store.edges : [];

 for (const edge of edges) {
 const from = String(edge.from || '').trim();
 const to = String(edge.to || '').trim();
 if (!from || !to || from === to) continue;
 if (!nodes[from] || !nodes[to]) continue;

 const relationType = String(edge.type || 'related').trim().toLowerCase();
 const conductance = EDGE_CONDUCTANCE[relationType] ?? 0.4;

 addNeighbor(map, from, {
 targetId: to,
 strength: conductance,
 edgeType: relationType,
 layer: 'semantic',
 });
 addNeighbor(map, to, {
 targetId: from,
 strength: conductance * options.reverseEdgeAttenuation,
 edgeType: relationType,
 layer: 'semantic',
 });
 }

 const sortedNodes = Object.values(nodes)
 .filter(n => !n.archived && Number.isFinite(n.seqTo) && n.seqTo > 0)
 .sort((a, b) => a.seqTo - b.seqTo);

 for (let i = 0; i < sortedNodes.length - 1; i++) {
 const current = sortedNodes[i];
 const next = sortedNodes[i + 1];
 const seqGap = next.seqTo - current.seqTo;
 const strength = Math.exp(-seqGap / options.temporalEdgeDecayScale)
 * options.temporalEdgeMaxStrength;

 if (strength < options.temporalEdgeMinStrength) continue;

 addNeighbor(map, current.id, {
 targetId: next.id,
 strength,
 edgeType: 'temporal_adjacent',
 layer: 'temporal',
 });
 addNeighbor(map, next.id, {
 targetId: current.id,
 strength,
 edgeType: 'temporal_adjacent',
 layer: 'temporal',
 });
 }

 return map;
}

// ---------------------------------------------------------------------------
// Entity type detection (schema-driven, not hardcoded)
// ---------------------------------------------------------------------------

/**
 * Determine if a node type is an "entity type" based on schema.
 * Entity types have a `name` field and use latestOnly upsert.
 * Falls back to checking character_sheet/location_state if no schema provided.
 *
 * @param {string} nodeType
 * @param {Array} [schema]
 * @returns {boolean}
 */
export function isEntityType(nodeType, schema) {
 if (Array.isArray(schema)) {
 const typeSpec = schema.find(s => String(s?.id || '').toLowerCase() === String(nodeType || '').toLowerCase());
 if (typeSpec) {
 return Array.isArray(typeSpec.tableColumns)
 && typeSpec.tableColumns.includes('name')
 && typeSpec.latestOnly === true;
 }
 }
 // Fallback for when schema is not available
 const type = String(nodeType || '').toLowerCase();
 return type === 'character_sheet' || type === 'location_state';
}

// ---------------------------------------------------------------------------
// Entity-aware Ebbinghaus decay with pre-computed cache
// ---------------------------------------------------------------------------

/**
 * Pre-compute entity relationship caches for efficient decay calculation.
 * Call once before propagateActivation, not per-node per-step.
 *
 * @param {object} store
 * @param {Array} [schema]
 * @returns {{nodeToEntityIds: Map<string, Set<string>>, entityLatestSeq: Map<string, number>}}
 */
export function buildEntityDecayCache(store, schema) {
 const nodes = store.nodes || {};
 const edges = Array.isArray(store.edges) ? store.edges : [];

 // Identify entity node IDs
 const entityNodeIds = new Set();
 for (const node of Object.values(nodes)) {
 if (!node.archived && isEntityType(node.type, schema)) {
 entityNodeIds.add(node.id);
 }
 }

 // Build node → linked entity IDs mapping
 const nodeToEntityIds = new Map();
 for (const edge of edges) {
 const from = String(edge.from || '').trim();
 const to = String(edge.to || '').trim();
 if (!from || !to || from === to) continue;

 if (entityNodeIds.has(to)) {
 if (!nodeToEntityIds.has(from)) nodeToEntityIds.set(from, new Set());
 nodeToEntityIds.get(from).add(to);
 }
 if (entityNodeIds.has(from)) {
 if (!nodeToEntityIds.has(to)) nodeToEntityIds.set(to, new Set());
 nodeToEntityIds.get(to).add(from);
 }
 }

 // Build entity → latest seq mapping
 const entityLatestSeq = new Map();
 for (const entityId of entityNodeIds) {
 let latest = Math.max(0, Number(nodes[entityId]?.seqTo) || 0);
 // Check all nodes linked to this entity for their seqTo
 for (const edge of edges) {
 const from = String(edge.from || '').trim();
 const to = String(edge.to || '').trim();
 let linkedId = null;
 if (from === entityId) linkedId = to;
 else if (to === entityId) linkedId = from;
 if (!linkedId || !nodes[linkedId]) continue;
 const seq = Math.max(0, Number(nodes[linkedId].seqTo) || 0);
 if (seq > latest) latest = seq;
 }
 entityLatestSeq.set(entityId, latest);
 }

 return { nodeToEntityIds, entityLatestSeq };
}

function computeEntityAwareDecayCached(node, currentSeq, entityCache) {
 const halfLife = TYPE_HALF_LIFE[node.type] ?? 50;
 if (!Number.isFinite(halfLife)) return 1.0;

 const nodeSeq = Math.max(0, Number(node.seqTo) || 0);
 if (nodeSeq <= 0) return 1.0;

 const linkedEntityIds = entityCache.nodeToEntityIds.get(node.id);
 let latestActivity = nodeSeq;

 if (linkedEntityIds) {
 for (const entityId of linkedEntityIds) {
 const entityLatest = entityCache.entityLatestSeq.get(entityId) || 0;
 if (entityLatest > latestActivity) latestActivity = entityLatest;
 }
 }

 const effectiveDistance = Math.max(0, currentSeq - latestActivity);
 return Math.exp(-0.693 * effectiveDistance / halfLife);
}

// ---------------------------------------------------------------------------
// PEDSA propagation
// ---------------------------------------------------------------------------

/**
 * Run PEDSA spreading activation on the graph.
 *
 * @param {Map} adjacencyMap - From buildAdjacencyMap.
 * @param {Array<{id: string, energy: number}>} seedNodes - Initial seeds with energy.
 * @param {object} store - The memory graph store (for node lookups and decay).
 * @param {number} currentSeq - Current assistant floor sequence number.
 * @param {object} [opts] - Override diffusion options.
 * @returns {Map<string, number>} nodeId to final energy (positive = activated).
 */
export function propagateActivation(adjacencyMap, seedNodes, store, currentSeq, opts = {}) {
 const options = { ...DEFAULT_OPTIONS, ...opts };
 const nodes = store.nodes || {};

 // Pre-compute entity decay cache once (O(edges)), not per-node per-step
 const entityCache = options.enableEntityAwareDecay && Number.isFinite(currentSeq) && currentSeq > 0
 ? buildEntityDecayCache(store, options.schema)
 : null;

 let currentEnergy = new Map();
 const initialEnergy = new Map();
 const refractorySet = new Set();

 for (const seed of seedNodes || []) {
 if (!seed?.id) continue;
 const clamped = clampEnergy(Number(seed.energy) || 0, options);
 if (Math.abs(clamped) < options.minEnergy) continue;
 const existing = currentEnergy.get(seed.id) || 0;
 const next = clampEnergy(existing + clamped, options);
 currentEnergy.set(seed.id, next);
 initialEnergy.set(seed.id, next);
 }

 const result = new Map(currentEnergy);

 const inDegreeMap = options.enableInverseDegreeInhibition
 ? computeInDegreeMap(adjacencyMap)
 : null;

 for (let step = 0; step < options.maxSteps; step++) {
 const nextEnergy = new Map();

 for (const [nodeId, energy] of currentEnergy) {
 const neighbors = adjacencyMap.get(nodeId);
 if (!neighbors?.length) continue;

 let degreePenalty = 1.0;
 if (inDegreeMap) {
 const inDeg = inDegreeMap.get(nodeId) || 1;
 degreePenalty = Math.pow(Math.max(1, inDeg), -options.inverseDegreeExponent);
 }

 const refractoryMul = (options.enableRefractoryPeriod && refractorySet.has(nodeId))
 ? options.refractoryDamping
 : 1.0;

 for (const neighbor of neighbors) {
 if (!neighbor?.targetId) continue;
 const propagated = energy
 * (Number(neighbor.strength) || 0)
 * options.decayFactor
 * degreePenalty
 * refractoryMul
 * (1 - options.teleportAlpha);

 const existing = nextEnergy.get(neighbor.targetId) || 0;
 nextEnergy.set(neighbor.targetId, existing + propagated);
 }
 }

 if (entityCache) {
 for (const [nodeId, energy] of nextEnergy) {
 const node = nodes[nodeId];
 if (!node) continue;
 const decay = computeEntityAwareDecayCached(node, currentSeq, entityCache);
 const decayed = clampEnergy(energy * decay, options);
 if (Math.abs(decayed) < options.minEnergy) {
 nextEnergy.delete(nodeId);
 } else {
 nextEnergy.set(nodeId, decayed);
 }
 }
 } else {
 for (const [nodeId, energy] of nextEnergy) {
 const clamped = clampEnergy(energy, options);
 if (Math.abs(clamped) < options.minEnergy) {
 nextEnergy.delete(nodeId);
 } else {
 nextEnergy.set(nodeId, clamped);
 }
 }
 }

 if (options.teleportAlpha > 0) {
 for (const [nodeId, seedEnergy] of initialEnergy) {
 const current = nextEnergy.get(nodeId) || 0;
 const teleported = (1 - options.teleportAlpha) * current
 + options.teleportAlpha * seedEnergy;
 const clamped = clampEnergy(teleported, options);
 if (Math.abs(clamped) >= options.minEnergy) {
 nextEnergy.set(nodeId, clamped);
 }
 }
 }

 if (nextEnergy.size > options.topK) {
 const sorted = [...nextEnergy.entries()]
 .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
 nextEnergy.clear();
 for (let i = 0; i < options.topK && i < sorted.length; i++) {
 nextEnergy.set(sorted[i][0], sorted[i][1]);
 }
 }

 for (const [nodeId, energy] of nextEnergy) {
 const existing = result.get(nodeId) || 0;
 if (Math.abs(energy) > Math.abs(existing)) {
 result.set(nodeId, energy);
 }
 }

 if (options.enableRefractoryPeriod) {
 const topActive = [...nextEnergy.entries()]
 .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
 .slice(0, options.refractoryTopN);
 for (const [nodeId] of topActive) {
 refractorySet.add(nodeId);
 }
 }

 currentEnergy = nextEnergy;
 if (currentEnergy.size === 0) break;
 }

 return result;
}

/**
 * Convenience: propagate and return results sorted by energy descending.
 *
 * @param {Map} adjacencyMap
 * @param {Array<{id: string, energy: number}>} seeds
 * @param {object} store
 * @param {number} currentSeq
 * @param {object} [opts]
 * @returns {Array<{nodeId: string, energy: number}>}
 */
export function diffuseAndRank(adjacencyMap, seeds, store, currentSeq, opts = {}) {
 const energyMap = propagateActivation(adjacencyMap, seeds, store, currentSeq, opts);
 return [...energyMap.entries()]
 .filter(([, energy]) => energy > 0)
 .map(([nodeId, energy]) => ({ nodeId, energy }))
 .sort((a, b) => {
 if (b.energy !== a.energy) return b.energy - a.energy;
 return String(a.nodeId).localeCompare(String(b.nodeId));
 });
}

// ---------------------------------------------------------------------------
// Entity anchor extraction (lexical matching)
// ---------------------------------------------------------------------------

/**
 * Extract entity anchors from query text by matching against known
 * character names/aliases and location names/aliases in the graph.
 *
 * @param {string} queryText - The user's recent messages.
 * @param {object} store - The graph store.
 * @param {number} [anchorEnergy=2.0] - Energy assigned to matched anchors.
 * @returns {Array<{id: string, energy: number, matchedName: string, nodeType: string}>}
 */
export function extractEntityAnchors(queryText, store, anchorEnergy = 2.0, schema = null) {
 const anchors = [];
 if (!queryText || typeof queryText !== 'string') return anchors;

 const normalizedQuery = queryText.toLowerCase();
 const nodes = store.nodes || {};
 const matchedIds = new Set();

 for (const node of Object.values(nodes)) {
 if (node.archived) continue;
 if (!isEntityType(node.type, schema)) continue;
 if (matchedIds.has(node.id)) continue;

 const names = collectEntityNames(node);
 for (const name of names) {
 if (name.length < 2) continue;
 if (normalizedQuery.includes(name.toLowerCase())) {
 anchors.push({
 id: node.id,
 energy: anchorEnergy,
 matchedName: name,
 nodeType: node.type,
 });
 matchedIds.add(node.id);
 break;
 }
 }
 }

 return anchors;
}

function collectEntityNames(node) {
 const names = [];
 const fields = node.fields || {};

 const name = String(fields.name || '').trim();
 if (name) names.push(name);

 const aliasesRaw = fields.aliases;
 if (typeof aliasesRaw === 'string' && aliasesRaw.trim()) {
 const parts = aliasesRaw.split(/[,;\u3001\n\uff0c\uff1b]/).map(s => s.trim()).filter(Boolean);
 names.push(...parts);
 } else if (Array.isArray(aliasesRaw)) {
 for (const item of aliasesRaw) {
 const trimmed = String(item || '').trim();
 if (trimmed) names.push(trimmed);
 }
 }

 return names;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Co-occurrence boost + LTD decay
// ---------------------------------------------------------------------------

/**
 * Compute co-occurrence boost for a candidate node.
 *
 * @param {object} candidateNode - The candidate graph node.
 * @param {Set<string>} queryEntityIds - Entity IDs mentioned in the query.
 * @param {object} cooccurrenceCounts - The store's co-occurrence counts.
 * @param {object} store - The graph store (for edge lookups).
 * @param {Array} [schema] - Schema for entity type detection.
 * @returns {number} Boost value (0 if no co-occurrence).
 */
export function computeCooccurrenceBoost(candidateNode, queryEntityIds, cooccurrenceCounts, store, schema) {
 if (!cooccurrenceCounts || !queryEntityIds?.size) return 0;

 // Find entities linked to this candidate
 const edges = Array.isArray(store.edges) ? store.edges : [];
 const nodes = store.nodes || {};
 const candidateEntityIds = new Set();

 for (const edge of edges) {
 const from = String(edge.from || '').trim();
 const to = String(edge.to || '').trim();
 let linkedId = null;
 if (from === candidateNode.id) linkedId = to;
 else if (to === candidateNode.id) linkedId = from;
 if (!linkedId) continue;
 const linkedNode = nodes[linkedId];
 if (linkedNode && isEntityType(linkedNode.type, schema)) {
 candidateEntityIds.add(linkedId);
 }
 }

 // Also check if the candidate itself is an entity
 if (isEntityType(candidateNode.type, schema)) {
 candidateEntityIds.add(candidateNode.id);
 }

 let boost = 0;
 for (const candidateEntity of candidateEntityIds) {
 for (const queryEntity of queryEntityIds) {
 const key1 = `${[candidateEntity, queryEntity].sort().join('|')}`;
 const count = cooccurrenceCounts[key1] || 0;
 if (count > 0) {
 boost += Math.log(1 + count) * 0.1;
 }
 }
 }

 return boost;
}

export { DEFAULT_OPTIONS as DIFFUSION_DEFAULTS, EDGE_CONDUCTANCE, TYPE_HALF_LIFE };
