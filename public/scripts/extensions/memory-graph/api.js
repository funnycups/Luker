// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory-graph Layer-1 session API. Single entry point — `openSession(context)` —
// resolves the chat-scoped runtime store via floor-state, wraps the read + write
// factories around it, and returns a frozen flat method bag.
//
// This is the surface third-party extensions and the orchestrator consume:
//
//   const memoryApi = Luker.getContext().getExtensionApi('memory-graph');
//   const session = await memoryApi?.openSession?.(context);
//   if (session) {
//       const candidates = session.listVisibleCandidates({ types: ['character_sheet'] });
//       const { id } = await session.createNode({ type: 'event', title: '...', fields: {} });
//   }
//
// Lifetime: the session shares the same runtime store the rest of memory-graph
// uses — `ensureMemoryStoreLoaded` either returns the cached active store or
// loads it on first access and caches it. Writes mutate that shared store and
// flush through `commitSessionMutation` so the change is visible to recall /
// UI / persistence immediately. Chat switches invalidate the cached store
// (handled by memory-graph's own CHAT_CHANGED listener), so callers should
// open a fresh session per chat.

const registerExtensionApi = Luker.getContext().registerExtensionApi;
import {
    getCurrentlyInjectedNodeIds,
    addInjectionChangedListener,
} from './external-api.js';
import {
    ensureMemoryStoreLoaded,
    resolveChatKeyForSession,
    commitSessionMutation,
    getMemoryStore,
    findEventNodeForSeq,
    resolveEventCardData,
    addStoreCommitListener,
    findAffectedAssistantSeqFromMessageIndex,
} from './main.js';
import { getMemoryGraphReadApi } from './read-api.js';
import { getMemoryGraphWriteApi } from './write-api.js';
import {
    getSchemaScopeInfo,
    getAdvancedScopeInfo,
    persistCharacterSchemaOverride,
    removeCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
    removeCharacterAdvancedOverride,
} from './character-overrides.js';

export async function openSession(context) {
    if (!context || typeof context !== 'object') return null;
    let chatKey;
    let store;
    try {
        chatKey = resolveChatKeyForSession(context);
        if (!chatKey) return null;
        store = await ensureMemoryStoreLoaded(context);
    } catch (err) {
        console.warn('[memory-graph] openSession: failed to resolve runtime store', err);
        return null;
    }
    if (!store) return null;
    const read = getMemoryGraphReadApi(store, context);
    let beforeStore = structuredClone(store);
    const write = getMemoryGraphWriteApi(store, context, {
        onCommit: async (currentStore) => {
            await commitSessionMutation(context, chatKey, beforeStore, currentStore);
            beforeStore = structuredClone(currentStore);
        },
    });
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
        // Write — each method awaits its `onCommit` flush, so callers that
        // `await session.X(...)` are guaranteed the change is persisted by
        // the time the promise resolves.
        createNode: (op) => write.createNode(op),
        editNode: (op) => write.editNode(op),
        deleteNode: (op) => write.deleteNode(op),
        upsertLinks: (op) => write.upsertLinks(op),
        deleteLinks: (op) => write.deleteLinks(op),
        compactNodes: (op) => write.compactNodes(op),
        applyExtractionBatch: (input) => write.applyExtractionBatch(input),
    });
}

registerExtensionApi('memory-graph', {
    openSession,
    // Per-character override accessors (character-overrides.js).
    getSchemaScopeInfo,
    getAdvancedScopeInfo,
    persistCharacterSchemaOverride,
    removeCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
    removeCharacterAdvancedOverride,
    // Inline card / event data API — consumed by 酒馆助手 and third-party frontends.
    onStoreCommit: (cb) => addStoreCommitListener(cb),
    getCardDataForSeq: (context, seq) => {
        const store = getMemoryStore(context);
        if (!store) return null;
        const eventNode = findEventNodeForSeq(store, Number(seq));
        return eventNode ? resolveEventCardData(store, eventNode) : null;
    },
    // Injection observation — fires when recall pipeline settles on injected nodes.
    // Callback receives { alwaysInjectIds: Set, recallSelectedIds: Set, visibleIds: Set }.
    // Returns an unsubscribe function.
    onInjectionChanged: (cb) => addInjectionChangedListener(cb),
    // Snapshot of what's currently injected for a given context.
    getCurrentInjection: (context) => getCurrentlyInjectedNodeIds(context),
    // Resolve node objects from the store by their ids. Returns an array in
    // the same order as the input ids (null entries for missing nodes).
    getNodesByIds: (context, ids) => {
        const store = getMemoryStore(context);
        if (!store || !Array.isArray(ids)) return [];
        return ids.map(id => store.nodes[String(id)] ?? null);
    },
    // Resolve the assistant seq number for a given chat message index.
    // seq is 1-based count of extractable assistant messages up to and including msgIndex.
    getSeqForMessageIndex: (context, messageIndex) =>
        findAffectedAssistantSeqFromMessageIndex(context, messageIndex),
});
