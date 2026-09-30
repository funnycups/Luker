// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Canonical graph document — the ProposalBus surface for graph mutations.
 *
 * The runtime store is not bus-friendly: it carries counters/volatile fields
 * AND its `edges` array identity is positional (indexes drift when
 * extraction adds or removes edges), so an RFC6902 patch over array indexes
 * would conflict constantly. This module projects the store onto a
 * deterministic keyed document:
 *
 *   nodes -> keyed by node id                   (stable under extraction)
 *   links -> keyed by `from\u241Ftype\u241Fto`  (stable under reordering)
 *
 * Only persist-surviving node fields are included (the normalize whitelist);
 * `floorRange` / `supersededBy` / edge `seqTo` are stripped on every save
 * anyway, so including them would manufacture false drift. Counters and
 * volatile runtime fields live outside the document and are re-derived by
 * `normalizeStoreForRuntime` on write-back.
 *
 * Determinism (sorted node ids, no undefined values, fixed field order)
 * keeps the RFC6902 compare byte-stable for unchanged data — fewer false
 * conflicts and cache-friendly payloads.
 */

import { normalizeStoreForRuntime } from '../persistence.js';

const NODE_FIELD_WHITELIST = [
    'id',
    'type',
    'level',
    'title',
    'seqTo',
    'fields',
    'semanticDepth',
    'semanticRollup',
    'childrenIds',
    'parentId',
    'archived',
];

export const LINK_KEY_SEPARATOR = '\u241F';

export function linkKey(from, type, to) {
    return `${String(from)}${LINK_KEY_SEPARATOR}${String(type)}${LINK_KEY_SEPARATOR}${String(to)}`;
}

function pickNode(node) {
    const out = {};
    for (const field of NODE_FIELD_WHITELIST) {
        if (node[field] !== undefined) out[field] = node[field];
    }
    return out;
}

export function canonicalFromStore(store) {
    const normalized = normalizeStoreForRuntime(store);
    const nodes = {};
    for (const id of Object.keys(normalized.nodes).sort()) {
        nodes[id] = pickNode(normalized.nodes[id]);
    }
    const links = {};
    for (const edge of normalized.edges) {
        if (!edge || !edge.from || !edge.to || !edge.type) continue;
        links[linkKey(edge.from, edge.type, edge.to)] = {
            from: String(edge.from),
            to: String(edge.to),
            type: String(edge.type),
        };
    }
    return { nodes, links };
}

export function applyCanonicalToStore(doc, liveStore) {
    const base = normalizeStoreForRuntime(liveStore);
    const nodes = {};
    for (const [id, node] of Object.entries(doc?.nodes || {})) {
        if (!id || !node || typeof node !== 'object') continue;
        nodes[id] = { ...node, id };
    }
    const edges = [];
    for (const edge of Object.values(doc?.links || {})) {
        if (!edge?.from || !edge?.to || !edge?.type) continue;
        edges.push({ from: String(edge.from), to: String(edge.to), type: String(edge.type) });
    }
    return normalizeStoreForRuntime({ ...base, nodes, edges });
}

export function docsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function docsTouchNodes(a, b) {
    return JSON.stringify(a?.nodes || null) !== JSON.stringify(b?.nodes || null);
}
