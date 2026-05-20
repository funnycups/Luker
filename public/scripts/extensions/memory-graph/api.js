// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory-graph Layer-1 session API. Single entry point — `openSession(context)` —
// resolves the chat-scoped runtime store via floor-state, wraps the read + write
// factories around it, and returns a frozen flat method bag.
//
// This is the surface third-party extensions and the orchestrator consume:
//
//   import { getExtensionApi } from '../../extensions.js';
//   const memoryApi = getExtensionApi('memory-graph');
//   const session = await memoryApi?.openSession?.(context);
//   if (session) {
//       const candidates = session.listVisibleCandidates({ types: ['character_sheet'] });
//       const { id } = session.createNode({ type: 'event', title: '...', fields: {} });
//   }
//
// Lifetime: the session captures the store snapshot at openSession time. Chat
// switches require a fresh openSession call.

import { registerExtensionApi } from '../../extensions.js';
import {
    getFloorStateInstance,
    loadMetaFields,
    buildRuntimeStoreFromGraphPayloadAndMeta,
} from './persistence.js';
import { getMemoryGraphReadApi } from './read-api.js';
import { getMemoryGraphWriteApi } from './write-api.js';

async function loadCurrentChatStore(context) {
    if (!context || typeof context.createFloorState !== 'function') {
        return null;
    }
    let payload = null;
    let meta = null;
    try {
        const fs = await getFloorStateInstance(context);
        await fs.ready();
        payload = await fs.get();
    } catch (err) {
        console.warn('[memory-graph] openSession: floor-state unavailable', err);
        return null;
    }
    try {
        meta = await loadMetaFields(context);
    } catch (err) {
        console.warn('[memory-graph] openSession: meta sidecar read failed; continuing without meta', err);
        meta = null;
    }
    return buildRuntimeStoreFromGraphPayloadAndMeta(payload, meta);
}

export async function openSession(context) {
    const store = await loadCurrentChatStore(context);
    if (!store) return null;
    const read = getMemoryGraphReadApi(store, context);
    const write = getMemoryGraphWriteApi(store, context);
    // Curated surface for the agent / third-party consumer. The 16 methods
    // below are the recall + write hot path. Lower-level read accessors
    // (listNodes, getNode, listEdges, getNeighbors, projectEdges, injection
    // listeners …) stay on `getMemoryGraphReadApi(store, context)` for
    // callers that need them — openSession deliberately doesn't proxy them
    // to keep the LLM-facing surface small.
    return Object.freeze({
        // Read
        listVisibleCandidates: (opts) => read.listVisibleCandidates(opts),
        getEdgeSummary: (id, opts) => read.getEdgeSummary(id, opts),
        getNodeBrief: (id, opts) => read.getNodeBrief(id, opts),
        expandFromSeeds: (ids, opts) => read.expandFromSeeds(ids, opts),
        getSchema: () => read.getSchema(),
        keywordSearch: (opts) => read.keywordSearch(opts),
        vectorSearch: (opts) => read.vectorSearch(opts),
        findByName: (opts) => read.findByName(opts),
        compactionCandidates: (opts) => read.compactionCandidates(opts),
        // Write
        createNode: (op) => write.createNode(op),
        editNode: (op) => write.editNode(op),
        deleteNode: (op) => write.deleteNode(op),
        upsertLinks: (op) => write.upsertLinks(op),
        deleteLinks: (op) => write.deleteLinks(op),
        compactNodes: (op) => write.compactNodes(op),
        applyExtractionBatch: (input) => write.applyExtractionBatch(input),
    });
}

registerExtensionApi('memory-graph', { openSession });
