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
    addStoreCommitListener,
    removeStoreCommitListener,
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

// ────────────────────────────────────────────────────────────────────────────
// Lookup helpers used by the registered API methods below. Each opens a
// short-lived read-api factory against the freshly-loaded runtime store, so
// returned views are deep-frozen via the same path `openSession` already uses.
// ────────────────────────────────────────────────────────────────────────────

async function withReadApi(context) {
    if (!context || typeof context !== 'object') return null;
    let store;
    try {
        store = await ensureMemoryStoreLoaded(context);
    } catch (err) {
        console.warn('[memory-graph] lookup: failed to load runtime store', err);
        return null;
    }
    if (!store) return null;
    return getMemoryGraphReadApi(store, context);
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

    // ── Lookup API ──────────────────────────────────────────────────────
    // Frozen NodeView / EdgeView returns — same shape and freeze contract as
    // openSession()'s read surface. Each call opens a fresh short-lived read
    // factory; callers that issue many lookups in a row should batch through
    // openSession() instead to share one factory.

    /**
     * Resolve a single node by id. Returns `NodeView | null`.
     */
    getNodeById: async (context, id) => {
        if (id === null || id === undefined) return null;
        const api = await withReadApi(context);
        return api ? api.getNode(String(id).trim()) : null;
    },

    /**
     * Resolve multiple nodes by id. Returns `Array<NodeView | null>` in the
     * same order as the input ids (null entries for missing / invalid ids).
     */
    getNodesByIds: async (context, ids) => {
        if (!Array.isArray(ids)) return [];
        const api = await withReadApi(context);
        if (!api) return [];
        return ids.map(id => {
            if (id === null || id === undefined) return null;
            const key = String(id).trim();
            return key ? api.getNode(key) : null;
        });
    },

    /**
     * Find the non-archived `event` node whose floor/seq range covers `seq`.
     * When multiple ranges overlap on `seq`, prefers the node with the highest
     * seqTo (most recent). Returns `NodeView | null`.
     */
    findEventBySeq: async (context, seq) => {
        const target = Number(seq);
        if (!Number.isFinite(target)) return null;
        const api = await withReadApi(context);
        if (!api) return null;
        return pickEventCoveringSeq(api.listNodes({ types: ['event'] }), target);
    },

    /**
     * Same lookup as `findEventBySeq`, plus the location_state linked via
     * `occurred_at` and the character_sheet nodes linked via `involved_in`.
     * Returns `{ event: NodeView, location: NodeView|null, characters: NodeView[] } | null`.
     * `characters` is in edge-insertion order with duplicates dropped.
     */
    findEventBundleBySeq: async (context, seq) => {
        const target = Number(seq);
        if (!Number.isFinite(target)) return null;
        const api = await withReadApi(context);
        if (!api) return null;
        const event = pickEventCoveringSeq(api.listNodes({ types: ['event'] }), target);
        if (!event) return null;
        const outgoing = api.listEdges({ from: event.id, types: ['occurred_at', 'involved_in'] });

        let location = null;
        const characters = [];
        const seen = new Set();
        for (const edge of outgoing) {
            if (!location && edge.type === 'occurred_at') {
                const node = api.getNode(edge.to);
                if (node && node.type === 'location_state') location = node;
            } else if (edge.type === 'involved_in') {
                const node = api.getNode(edge.to);
                if (node && node.type === 'character_sheet' && !seen.has(node.id)) {
                    seen.add(node.id);
                    characters.push(node);
                }
            }
        }
        return Object.freeze({ event, location, characters: Object.freeze(characters) });
    },

    /**
     * Translate a chat message index into the 1-based count of extractable
     * assistant messages up to and including that index. Returns
     * `number | null` (null = no extractable assistant message at/before idx).
     */
    getAssistantSeqForMessageIndex: (context, messageIndex) => {
        if (!context || typeof context !== 'object') return null;
        const idx = Number(messageIndex);
        if (!Number.isFinite(idx)) return null;
        return findAffectedAssistantSeqFromMessageIndex(context, idx);
    },

    /**
     * Defensive copy of the current main-flow injection state. See
     * `InjectionState` in the Type Reference. Returns `null` for invalid
     * context.
     */
    getCurrentInjection: (context) => {
        if (!context || typeof context !== 'object') return null;
        return getCurrentlyInjectedNodeIds(context);
    },

    /**
     * Frozen snapshot of the last recall projection — the actual `corePacket`
     * and `focusPacket` text that memory-graph injected into the main chat's
     * prompt during the previous recall pass. Same data the "View Last
     * Injection" UI button visualises.
     *
     * Returns `null` when:
     *   - `context` is invalid
     *   - the runtime store cannot be loaded
     *   - no recall has run for this chat yet
     *
     * The returned object is a defensive frozen copy — callers cannot leak
     * mutations back into the live store.
     */
    getLastRecallProjection: async (context) => {
        if (!context || typeof context !== 'object') return null;
        let store;
        try {
            store = await ensureMemoryStoreLoaded(context);
        } catch (err) {
            console.warn('[memory-graph] getLastRecallProjection: failed to load runtime store', err);
            return null;
        }
        if (!store || !store.lastRecallProjection) return null;
        const { at, blocks } = store.lastRecallProjection;
        return Object.freeze({
            at,
            blocks: Object.freeze({
                corePacket: blocks?.corePacket ?? '',
                focusPacket: blocks?.focusPacket ?? '',
            }),
        });
    },

    // ── Change subscriptions ────────────────────────────────────────────

    /**
     * Subscribe to store-commit notifications. The callback receives a frozen
     * `{ chatKey }` signal — re-query through the Lookup API for fresh data,
     * the store reference is not exposed. Returns an idempotent unsubscribe.
     */
    onStoreCommit: (cb) => addStoreCommitListener(cb),
    /** Symmetric remove for `onStoreCommit`. Returns `boolean`. */
    offStoreCommit: (cb) => removeStoreCommitListener(cb),

    /**
     * Subscribe to main-flow injection-decision changes. The callback receives
     * a frozen `InjectionState` snapshot. Returns an idempotent unsubscribe.
     */
    onInjectionChanged: (cb) => addInjectionChangedListener(cb),
});

function pickEventCoveringSeq(events, target) {
    let best = null;
    let bestSeqTo = -Infinity;
    for (const n of events) {
        if (!n || n.type !== 'event' || n.archived) continue;
        let covers = false;
        if (n.floorRange
            && typeof n.floorRange.start === 'number' && typeof n.floorRange.end === 'number') {
            covers = target >= n.floorRange.start && target <= n.floorRange.end;
        } else if (Number.isFinite(Number(n.seqTo))) {
            covers = target === Number(n.seqTo);
        }
        if (!covers) continue;
        const nodeSeqTo = Number.isFinite(Number(n.seqTo)) ? Number(n.seqTo)
            : (n.floorRange ? Number(n.floorRange.end) : -Infinity);
        if (nodeSeqTo > bestSeqTo) {
            best = n;
            bestSeqTo = nodeSeqTo;
        }
    }
    return best;
}
