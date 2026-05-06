/**
 * Memory-graph ↔ FloorState adapter tests.
 *
 * Covers the adapter functions in
 * public/scripts/extensions/memory-graph/persistence.js, plus
 * scenarios that exercise the adapter together with FloorState's structural
 * event handling. The full memory-graph extension wiring (event handlers,
 * cache invalidation) is integration-tested at the harness level — these
 * unit tests focus on the contract that survives a session restart: the
 * floor-state log + meta sidecar shape, and the migration that produces
 * them from the legacy `opLog` schema.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    createFloorStateWithDeps,
} from '../../public/scripts/floor-state.js';
import {
    getFloorFromAssistantSeq,
    commitGraphEntry,
    loadMetaFields,
    persistMetaFields,
    migrateLegacyMemoryGraphState,
    resetFloorStateInstanceForTesting,
    constants as adapterConstants,
} from '../../public/scripts/extensions/memory-graph/persistence.js';

// --- mocks (shape mirrors tests/floor-state/instance.test.js) ---

function makeStore() {
    const partitions = new Map();
    function targetKey(target) {
        if (!target || typeof target !== 'object') return '';
        if (target.is_group) return `g:${String(target.id ?? '')}`;
        return `c:${String(target.avatar_url ?? '')}/${String(target.file_name ?? '')}`;
    }
    function partitionFor(target) {
        const key = targetKey(target);
        if (!partitions.has(key)) partitions.set(key, new Map());
        return partitions.get(key);
    }
    return {
        async getChatState(ns, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const v = part.get(k);
            return v == null ? null : structuredClone(v);
        },
        async patchChatState(ns, ops, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const current = part.get(k) ?? {};
            const { applyPatch } = await import('../../public/scripts/util/fast-json-patch.js');
            const next = structuredClone(current);
            applyPatch(next, ops, false, true);
            part.set(k, next);
            return true;
        },
        async updateChatState(ns, updater, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            const current = part.get(k) ?? null;
            const next = await updater(current == null ? null : structuredClone(current));
            if (next === null || next === undefined) {
                part.delete(k);
            } else {
                part.set(k, structuredClone(next));
            }
            return { ok: true, state: part.get(k) ?? null, updated: true };
        },
        get _raw() { return partitionFor(undefined); },
        _rawFor(target) { return partitionFor(target); },
    };
}

function makeEventSource() {
    const listeners = new Map();
    // Floor-state no longer self-subscribes to the global event bus —
    // production driver is core calling `settleXxx(...)` from
    // `floor-state.js`. The test mock mirrors that contract: instances
    // bind via `_bindInstance(fs)` (auto-bind happens in
    // createFloorStateWithDeps when this mock is on `deps.eventSource`),
    // and emit drives the bound instances on the relevant structural
    // events BEFORE running listeners registered with `.on()`.
    const boundInstances = new Set();
    return {
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeListener(name, fn) {
            listeners.get(name)?.delete(fn);
        },
        async emit(name, ...args) {
            for (const inst of boundInstances) {
                switch (name) {
                    case event_types.MESSAGE_DELETED:
                        await inst.__handleMessageDeleted(args[0]);
                        break;
                    case event_types.MESSAGE_SWIPED:
                        await inst.__handleMessageSwiped();
                        break;
                    case event_types.MESSAGE_SWIPE_DELETED:
                        await inst.__handleSwipeDeleted(args[0]);
                        break;
                    case event_types.CHAT_CHANGED:
                        await inst.__handleChatChanged();
                        break;
                    case event_types.CHAT_BRANCH_CREATED:
                        await inst.__handleBranchCreated(args[0]);
                        break;
                }
            }
            const set = listeners.get(name);
            if (!set) return;
            for (const fn of Array.from(set)) {
                await fn(...args);
            }
        },
        _bindInstance(inst) {
            boundInstances.add(inst);
        },
        _unbindInstance(inst) {
            boundInstances.delete(inst);
        },
    };
}

const event_types = {
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    CHAT_BRANCH_CREATED: 'chat_branch_created',
};

async function buildObjectPatchOperationsAsync(prev, next) {
    const { compare } = await import('../../public/scripts/util/fast-json-patch.js');
    return compare(prev ?? {}, next ?? {});
}

function makeContext(chatRef) {
    const store = makeStore();
    const eventSource = makeEventSource();
    const fsDeps = {
        getChatState: store.getChatState.bind(store),
        patchChatState: store.patchChatState.bind(store),
        updateChatState: store.updateChatState.bind(store),
        buildObjectPatchOperationsAsync,
        eventSource,
        event_types,
        getChat: () => chatRef.value,
    };
    let createdInstance = null;
    const context = {
        chat: chatRef.value, // initial — adapter callers re-read via `context.chat`
        getChatState: fsDeps.getChatState,
        patchChatState: fsDeps.patchChatState,
        updateChatState: fsDeps.updateChatState,
        deleteChatState: async (ns, options) => {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = store._rawFor(options?.target);
            return part.delete(k);
        },
        buildObjectPatchOperationsAsync,
        async createFloorState({ namespace }) {
            createdInstance = createFloorStateWithDeps({ namespace }, fsDeps);
            return createdInstance;
        },
    };
    Object.defineProperty(context, 'chat', {
        get() { return chatRef.value; },
    });
    return { store, eventSource, context, getInstance: () => createdInstance };
}

function isExtractableAssistantMessage(message) {
    if (!message || message.is_system || message.is_user) return false;
    return Boolean(typeof message.mes === 'string' ? message.mes.trim() : message.mes);
}

/**
 * Memory-graph's reducer simplified for tests. Mirrors the shape of
 * applyMemoryLogEntryToStore in main.js: handles upsert_node /
 * delete_node / upsert_edge / delete_edge and bumps the seq watermarks.
 */
function applyMemoryLogEntryToStore(store, entry) {
    if (!store || !entry || !Array.isArray(entry.ops)) return;
    if (!store.nodes || typeof store.nodes !== 'object') store.nodes = {};
    if (!Array.isArray(store.edges)) store.edges = [];
    const edgeKey = (e) => `${String(e.from || '')}\0${String(e.type || '')}\0${String(e.to || '')}`;
    for (const op of entry.ops) {
        const type = String(op?.type || '').trim().toLowerCase();
        if (type === 'upsert_node' && op.node?.id) {
            store.nodes[op.node.id] = structuredClone(op.node);
            const seq = Number(op.node.seqTo || 0);
            if (Number.isFinite(seq)) {
                store.seqCounter = Math.max(Number(store.seqCounter || 0), seq);
            }
        } else if (type === 'delete_node' && op.nodeId) {
            delete store.nodes[op.nodeId];
            store.edges = store.edges.filter((e) => e.from !== op.nodeId && e.to !== op.nodeId);
        } else if (type === 'upsert_edge' && op.edge?.from && op.edge?.to) {
            const k = edgeKey(op.edge);
            if (!store.edges.some((e) => edgeKey(e) === k)) {
                store.edges.push(structuredClone(op.edge));
            }
        } else if (type === 'delete_edge' && op.edge) {
            const k = edgeKey(op.edge);
            store.edges = store.edges.filter((e) => edgeKey(e) !== k);
        }
    }
    const seq = Math.max(0, Math.floor(Number(entry.seq || 0)));
    if (seq > 0) {
        store.appliedSeqTo = Math.max(Number(store.appliedSeqTo || 0), seq);
        store.loggedSeqTo = Math.max(Number(store.loggedSeqTo || 0), seq);
        store.seqCounter = Math.max(Number(store.seqCounter || 0), seq);
    }
}

function assistantMsg({ swipe_id = 0, mes = 'hello', is_user = false } = {}) {
    return { swipe_id, mes, is_user, is_system: false };
}

async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    resetFloorStateInstanceForTesting();
});

// --- helpers exported by adapter ---

describe('getFloorFromAssistantSeq', () => {
    test('finds the chat index of the Nth extractable assistant message', () => {
        const chat = [
            assistantMsg({ mes: 'a' }),                 // assistant 1 → idx 0
            { is_user: true, mes: 'u' },
            assistantMsg({ mes: 'b' }),                 // assistant 2 → idx 2
            { is_system: true, mes: 's' },
            assistantMsg({ mes: 'c' }),                 // assistant 3 → idx 4
        ];
        expect(getFloorFromAssistantSeq(chat, 1, isExtractableAssistantMessage)).toBe(0);
        expect(getFloorFromAssistantSeq(chat, 2, isExtractableAssistantMessage)).toBe(2);
        expect(getFloorFromAssistantSeq(chat, 3, isExtractableAssistantMessage)).toBe(4);
    });

    test('returns null when the requested assistant seq does not exist', () => {
        const chat = [assistantMsg(), assistantMsg()];
        expect(getFloorFromAssistantSeq(chat, 5, isExtractableAssistantMessage)).toBeNull();
        expect(getFloorFromAssistantSeq(chat, 0, isExtractableAssistantMessage)).toBeNull();
        expect(getFloorFromAssistantSeq(chat, -1, isExtractableAssistantMessage)).toBeNull();
    });

    test('handles non-array chat by returning null', () => {
        expect(getFloorFromAssistantSeq(null, 1, isExtractableAssistantMessage)).toBeNull();
        expect(getFloorFromAssistantSeq(undefined, 1, isExtractableAssistantMessage)).toBeNull();
    });
});

// --- meta sidecar ---

describe('persistMetaFields / loadMetaFields', () => {
    test('writes and reads the meta sidecar at the META_NAMESPACE', async () => {
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);
        const meta = { schemaVersion: 2, sourceMessageCount: 7, lastRecallTrace: [{ step: 'init' }], lastRecallProjection: null };
        await persistMetaFields(context, meta);
        const loaded = await loadMetaFields(context);
        expect(loaded).toEqual(meta);
        // also visible in the raw store under the META namespace
        expect(store._raw.get(adapterConstants.META_NAMESPACE)).toEqual(meta);
    });

    test('returns null when no meta has been written yet', async () => {
        const chatRef = { value: [assistantMsg()] };
        const { context } = makeContext(chatRef);
        expect(await loadMetaFields(context)).toBeNull();
    });
});

// --- commit semantics ---

describe('commitGraphEntry', () => {
    test('writes one floor-state commit at the resolved floor for a given assistant seq', async () => {
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        const entry = { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] };
        const payload = await commitGraphEntry(context, entry, 0, applyMemoryLogEntryToStore);
        expect(payload).not.toBeNull();
        expect(payload.nodes['n_1']).toMatchObject({ id: 'n_1' });
        expect(payload.coveredAssistantSeq).toBe(1);

        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits).toHaveLength(1);
        expect(log.commits[0]).toMatchObject({ floor: 0, swipeId: 0 });
    });

    test('coveredAssistantSeq is monotonic across successive commits', async () => {
        const chatRef = { value: [assistantMsg(), assistantMsg(), assistantMsg()] };
        const { context } = makeContext(chatRef);

        await commitGraphEntry(
            context,
            { seq: 3, ops: [{ type: 'upsert_node', node: { id: 'n_3', type: 'event', seqTo: 3 } }] },
            2,
            applyMemoryLogEntryToStore,
        );
        // Commit an out-of-order entry at a smaller seq — coveredAssistantSeq must not regress.
        const after = await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] },
            0,
            applyMemoryLogEntryToStore,
        );
        expect(after.coveredAssistantSeq).toBe(3);
        expect(Object.keys(after.nodes).sort()).toEqual(['n_1', 'n_3']);
    });

    test('rejects entries with empty ops or invalid floor', async () => {
        const chatRef = { value: [assistantMsg()] };
        const { context } = makeContext(chatRef);
        expect(await commitGraphEntry(context, { seq: 1, ops: [] }, 0, applyMemoryLogEntryToStore)).toBeNull();
        expect(await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1' } }] },
            -1,
            applyMemoryLogEntryToStore,
        )).toBeNull();
    });
});

// --- structural event reactions on top of adapter commits ---

describe('floor-state events on adapter commits', () => {
    test('MESSAGE_DELETED truncates commits at deleted floor', async () => {
        const chatRef = { value: [assistantMsg(), assistantMsg(), assistantMsg()] };
        const { store, eventSource, context, getInstance } = makeContext(chatRef);

        for (let i = 0; i < 3; i++) {
            await commitGraphEntry(
                context,
                { seq: i + 1, ops: [{ type: 'upsert_node', node: { id: `n_${i + 1}`, type: 'event', seqTo: i + 1 } }] },
                i,
                applyMemoryLogEntryToStore,
            );
        }
        expect(store._raw.get(adapterConstants.LOG_NAMESPACE).commits).toHaveLength(3);

        // Drop the last assistant turn (chat shrinks to 2). Commit at floor 2 dies.
        chatRef.value = chatRef.value.slice(0, 2);
        await eventSource.emit(event_types.MESSAGE_DELETED, 2);
        const fs = getInstance();
        await fs.ready();

        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits.map((c) => c.floor)).toEqual([0, 1]);
        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(data.nodes).sort()).toEqual(['n_1', 'n_2']);
        expect(data.coveredAssistantSeq).toBe(2);
    });

    test('MESSAGE_SWIPED hides commits whose swipeId no longer matches', async () => {
        const chatRef = { value: [assistantMsg(), assistantMsg({ swipe_id: 0 })] };
        const { store, eventSource, context, getInstance } = makeContext(chatRef);

        // Commit on swipe 0 of floor 1.
        await commitGraphEntry(
            context,
            { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_swipe0', type: 'event', seqTo: 2 } }] },
            1,
            applyMemoryLogEntryToStore,
        );
        const fs = getInstance();
        expect(Object.keys(store._raw.get(adapterConstants.MODULE_NAME).nodes)).toContain('n_swipe0');

        // User regenerates → new swipe → swipe_id flips to 1.
        chatRef.value[1].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 1);
        await fs.ready();

        // Floor 1 swipe 1 has no commits, so the data namespace is reset to
        // the empty object — floor-state's rematerialize starts from {} and
        // applies nothing when no commit survives the swipeMap filter.
        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(data ?? {}).toEqual({});

        // Now the new swipe extracts something — commit on swipe 1.
        await commitGraphEntry(
            context,
            { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_swipe1', type: 'event', seqTo: 2 } }] },
            1,
            applyMemoryLogEntryToStore,
        );
        expect(Object.keys(store._raw.get(adapterConstants.MODULE_NAME).nodes)).toContain('n_swipe1');

        // Switch back to swipe 0 — n_swipe0 should reappear, n_swipe1 vanish.
        chatRef.value[1].swipe_id = 0;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 1);
        await fs.ready();
        const dataBack = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(dataBack.nodes)).toEqual(['n_swipe0']);
    });

    test('MESSAGE_SWIPE_DELETED drops the deleted swipe and shifts higher swipes down', async () => {
        const chatRef = { value: [assistantMsg({ swipe_id: 0 })] };
        const { store, eventSource, context, getInstance } = makeContext(chatRef);
        const fs = getInstance() || (await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 's0', type: 'event', seqTo: 1 } }] },
            0,
            applyMemoryLogEntryToStore,
        ), getInstance());

        // Commits on swipes 0, 1, 2 of floor 0.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 's1', type: 'event', seqTo: 1 } }] },
            0,
            applyMemoryLogEntryToStore,
        );

        chatRef.value[0].swipe_id = 2;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 's2', type: 'event', seqTo: 1 } }] },
            0,
            applyMemoryLogEntryToStore,
        );

        // Delete swipe 1; active becomes the former swipe 2 (now renumbered to 1).
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: 0, swipeId: 1 });
        await fs.ready();

        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(data.nodes).sort()).toEqual(['s2']);
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits.map((c) => c.swipeId).sort()).toEqual([0, 1]);
    });

    test('CHAT_BRANCH_CREATED inherits the truncated commit log on the target sidecar', async () => {
        const SOURCE = { is_group: false, avatar_url: 'a.png', file_name: 'src' };
        const TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'src - Branch #1' };
        const chatRef = { value: [assistantMsg(), assistantMsg(), assistantMsg()] };
        const { store, eventSource, context, getInstance } = makeContext(chatRef);

        // Pre-seed source commits.
        store._rawFor(SOURCE).set(adapterConstants.LOG_NAMESPACE, {
            version: adapterConstants.FLOOR_STATE_LOG_VERSION,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/marker', value: 'a' }] },
                { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/marker2', value: 'b' }] },
                { floor: 2, swipeId: 0, patches: [{ op: 'add', path: '/marker3', value: 'c' }] },
            ],
        });

        // Mount fs so its branch handler picks up the event.
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();
        // Note: makeContext caches via getInstance(); spawning above is independent.
        void getInstance;

        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 1,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        const branchLog = store._rawFor(TARGET).get(adapterConstants.LOG_NAMESPACE);
        expect(branchLog.commits.map((c) => c.floor)).toEqual([0, 1]);
    });
});

// --- migration ---

describe('migrateLegacyMemoryGraphState', () => {
    test('per-entry: produces one floor-state commit per legacy opLog entry', async () => {
        const chatRef = {
            value: [
                assistantMsg({ mes: 'a' }),
                assistantMsg({ mes: 'b' }),
                assistantMsg({ mes: 'c' }),
            ],
        };
        const { store, context } = makeContext(chatRef);

        // Seed legacy v1 schema: opLog inside main namespace, no __meta.
        const legacyState = {
            version: 8,
            coveredSeqTo: 3,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_2', type: 'event', seqTo: 2 } }] },
                { seq: 3, ops: [{ type: 'upsert_node', node: { id: 'n_3', type: 'event', seqTo: 3 } }] },
            ],
            sourceMessageCount: 3,
            lastRecallTrace: [{ step: 'historic' }],
            lastRecallProjection: { at: 100, blocks: { corePacket: 'old', focusPacket: '' } },
        };
        store._raw.set(adapterConstants.MODULE_NAME, legacyState);

        const result = await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(result.migrated).toBe(true);

        // Log: one commit per entry at the corresponding floor.
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits).toHaveLength(3);
        expect(log.commits.map((c) => c.floor)).toEqual([0, 1, 2]);

        // Main namespace: replay yields full graph payload.
        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(data.nodes).sort()).toEqual(['n_1', 'n_2', 'n_3']);
        expect(data.coveredAssistantSeq).toBe(3);

        // Meta: schemaVersion 2 + non-floor fields hoisted out.
        const meta = store._raw.get(adapterConstants.META_NAMESPACE);
        expect(meta).toMatchObject({
            schemaVersion: 2,
            sourceMessageCount: 3,
            lastRecallTrace: [{ step: 'historic' }],
            lastRecallProjection: { at: 100, blocks: expect.any(Object) },
        });
    });

    test('idempotent: running migration twice is a no-op the second time', async () => {
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_2', type: 'event', seqTo: 2 } }] },
            ],
            sourceMessageCount: 2,
        });

        const first = await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(first.migrated).toBe(true);
        const logBefore = JSON.stringify(store._raw.get(adapterConstants.LOG_NAMESPACE));
        const dataBefore = JSON.stringify(store._raw.get(adapterConstants.MODULE_NAME));
        const metaBefore = JSON.stringify(store._raw.get(adapterConstants.META_NAMESPACE));

        const second = await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(second.migrated).toBe(false);
        expect(JSON.stringify(store._raw.get(adapterConstants.LOG_NAMESPACE))).toBe(logBefore);
        expect(JSON.stringify(store._raw.get(adapterConstants.MODULE_NAME))).toBe(dataBefore);
        expect(JSON.stringify(store._raw.get(adapterConstants.META_NAMESPACE))).toBe(metaBefore);
    });

    test('fresh install: only stamps schemaVersion when there is no legacy opLog', async () => {
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        const result = await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(result.migrated).toBe(false);

        const meta = store._raw.get(adapterConstants.META_NAMESPACE);
        expect(meta).toEqual({ schemaVersion: 2 });
        expect(store._raw.get(adapterConstants.LOG_NAMESPACE)).toBeUndefined();
        expect(store._raw.get(adapterConstants.MODULE_NAME)).toBeUndefined();
    });

    test('post-migration tail-floor delete only drops that floor\'s commit', async () => {
        // Reproduces the reason the migration emits PER-ENTRY commits rather
        // than one commit lumped at the tail floor: deleting the tail must
        // not wipe earlier-floor graph data.
        const chatRef = {
            value: [assistantMsg(), assistantMsg(), assistantMsg()],
        };
        const { store, eventSource, context } = makeContext(chatRef);

        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_2', type: 'event', seqTo: 2 } }] },
                { seq: 3, ops: [{ type: 'upsert_node', node: { id: 'n_3', type: 'event', seqTo: 3 } }] },
            ],
        });
        await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );

        // Mount the floor-state instance so it can react to MESSAGE_DELETED.
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();

        chatRef.value = chatRef.value.slice(0, 2);
        await eventSource.emit(event_types.MESSAGE_DELETED, 2);
        await fs.ready();

        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits.map((c) => c.floor)).toEqual([0, 1]);
        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(data.nodes).sort()).toEqual(['n_1', 'n_2']);
    });

    test('skips opLog entries whose seq has no corresponding chat floor', async () => {
        // Edge case: legacy chat had 5 floors, current chat has 2. Migration
        // drops the un-anchorable commits without crashing.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_2', type: 'event', seqTo: 2 } }] },
                { seq: 5, ops: [{ type: 'upsert_node', node: { id: 'n_5', type: 'event', seqTo: 5 } }] },
            ],
        });

        await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits.map((c) => c.floor)).toEqual([0, 1]);
    });
});

// --- bug repro: regenerate must not be locked at swipe_cache_hit ---

describe('regenerate bug repro', () => {
    test('after MESSAGE_SWIPED on regenerate, the new swipe sees an empty graph and accepts a new commit', async () => {
        // The legacy bug: clicking "regenerate" on the last assistant message
        // tripped the swipe-tail-cache path which pinned coveredSeqTo and
        // silently skipped extraction with reason `swipe_cache_hit`. Under
        // the floor-state migration there is no swipe-tail cache; commits
        // are simply filtered by (floor, swipeId), so the new swipe starts
        // empty and a follow-up commit lands without any "already up to
        // date" short-circuit.
        const chatRef = { value: [assistantMsg(), assistantMsg({ swipe_id: 0 })] };
        const { store, eventSource, context, getInstance } = makeContext(chatRef);

        // Initial extraction commits a node on swipe 0 of the tail.
        await commitGraphEntry(
            context,
            { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_first', type: 'event', seqTo: 2 } }] },
            1,
            applyMemoryLogEntryToStore,
        );
        const fs = getInstance();
        expect((await fs.get()).nodes['n_first']).toBeDefined();
        const coveredBefore = (await fs.get()).coveredAssistantSeq;
        expect(coveredBefore).toBe(2);

        // User regenerates the tail message — swipe_id flips, MESSAGE_SWIPED fires.
        chatRef.value[1].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 1);
        await fs.ready();

        // The new swipe has no commits, so the materialized graph is the
        // bare empty object (no "swipe_cache_hit" sticky tail). With no
        // commits the data namespace reverts to {}; the legacy code would
        // have left coveredSeqTo pinned at 2 here, blocking re-extraction.
        const afterSwipe = (await fs.get()) ?? {};
        expect(afterSwipe.nodes ?? {}).toEqual({});
        expect(afterSwipe.coveredAssistantSeq ?? 0).toBe(0);

        // Extract on the new swipe — this is the path that the legacy bug
        // silently skipped.
        await commitGraphEntry(
            context,
            { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_regen', type: 'event', seqTo: 2 } }] },
            1,
            applyMemoryLogEntryToStore,
        );
        const final = await fs.get();
        expect(Object.keys(final.nodes)).toEqual(['n_regen']);
        expect(final.coveredAssistantSeq).toBe(2);
    });
});

// --- main.js integration: handler sequencing ---
//
// The migration flow in main.js depends on a specific ordering of
// CHAT_CHANGED listeners: memory-graph's migration handler must fire
// BEFORE floor-state's rematerialize handler. Otherwise fs's handler
// reads an empty `__floor_log` (legacy chats don't have one yet), writes
// data namespace = `{}`, and clobbers the legacy `opLog` payload that the
// migration was about to translate. These tests document and lock in the
// expected ordering so a future refactor that swaps registration order
// fails loudly instead of silently losing user data.

describe('main.js sequencing: initial mount migration before fs', () => {
    test('legacy data survives when migration runs before fs mount', async () => {
        // This is the order main.js implements in jQuery init: migrate the
        // current chat target, THEN call createFloorState. The instance's
        // initial rematerialize then reads the migrated log and idempotently
        // re-applies it against the chat array.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);
        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_legacy', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_legacy_2', type: 'event', seqTo: 2 } }] },
            ],
            sourceMessageCount: 2,
            lastRecallTrace: [{ step: 'pre-migration' }],
        });

        await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();

        const data = await fs.get();
        expect(Object.keys(data.nodes).sort()).toEqual(['n_legacy', 'n_legacy_2']);
        expect(data.coveredAssistantSeq).toBe(2);
        const meta = store._raw.get(adapterConstants.META_NAMESPACE);
        expect(meta).toMatchObject({
            schemaVersion: 2,
            sourceMessageCount: 2,
            lastRecallTrace: [{ step: 'pre-migration' }],
        });
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits).toHaveLength(2);
    });

    test('legacy data is LOST if fs mounts before migration (regression guard for ordering)', async () => {
        // Negative case documenting why ordering matters. fs's initial
        // rematerialize reads its empty log and writes `{}` to the data
        // namespace, clobbering the legacy `opLog`. Migration then sees an
        // empty main namespace and only stamps schemaVersion. The graph is
        // permanently gone — and there is no surfaced error.
        //
        // If this test ever turns green AS-IS (i.e. the regression no
        // longer happens), great — but it would mean someone changed
        // floor-state's initial rematerialize to skip the data write when
        // the log is empty, and that change deserves explicit
        // re-evaluation of this entire ordering invariant.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);
        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_legacy', type: 'event', seqTo: 1 } }] },
            ],
        });

        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();
        // floor-state's initial rematerialize sees empty log + non-empty chat,
        // skips the data write because commits.length === 0 (instance.test.js
        // covers this directly). Legacy data in main namespace is therefore
        // PRESERVED because fs's `if (log.commits.length === 0) return;`
        // shortcuts before the data-namespace write.
        expect(store._raw.get(adapterConstants.MODULE_NAME).opLog).toBeDefined();

        // Migration now runs and finds the legacy opLog intact.
        const result = await migrateLegacyMemoryGraphState(
            context,
            undefined,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        // The reason ordering still matters: in production, MOST cases
        // surviving fs's initial rematerialize unscathed depend on this
        // floor-state shortcut. If the shortcut were removed (e.g.
        // floor-state started writing `{}` even on empty log), legacy data
        // would be lost. So sequencing migrate-first remains the
        // defensive contract.
        expect(result.migrated).toBe(true);
    });
});

describe('main.js sequencing: CHAT_CHANGED migration handler runs before fs handler', () => {
    test('migration handler registered first preserves legacy data on chat switch', async () => {
        // The mock event source emits to listeners in registration order.
        // If memory-graph's migration handler is subscribed BEFORE fs is
        // mounted (which is when fs's CHAT_CHANGED handler subscribes),
        // emitting CHAT_CHANGED runs migration first, then fs's
        // rematerialize sees the migrated log.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, eventSource, context } = makeContext(chatRef);

        // Phase 1: subscribe migration handler before fs mounts.
        eventSource.on(event_types.CHAT_CHANGED, async () => {
            await migrateLegacyMemoryGraphState(
                context,
                undefined,
                isExtractableAssistantMessage,
                applyMemoryLogEntryToStore,
            );
        });
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();

        // Phase 2: simulate the user switching to a chat that has legacy
        // data. The chat-state mock conflates "current chat" with "no
        // explicit target", so we just write into the default partition.
        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_switched', type: 'event', seqTo: 1 } }] },
            ],
        });
        chatRef.value = [assistantMsg()];

        await eventSource.emit(event_types.CHAT_CHANGED);
        await fs.ready();

        // Migration ran first → wrote the new log + meta. fs's handler
        // ran second → rematerialized from the new log, idempotently
        // overwrote the data namespace with the same content the migration
        // produced.
        const data = await fs.get();
        expect(Object.keys(data.nodes)).toEqual(['n_switched']);
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits).toHaveLength(1);
        const meta = store._raw.get(adapterConstants.META_NAMESPACE);
        expect(meta.schemaVersion).toBe(2);
    });

    test('reversed order (fs first, migration second) is now non-destructive thanks to defensive shortcut', async () => {
        // History: with fs's CHAT_CHANGED handler registered before our
        // migration handler, fs used to run first, read the empty
        // `__floor_log` (legacy chat hasn't been migrated yet), and overwrite
        // the data namespace with `{}` — losing the legacy `opLog` payload
        // before migration could read it.
        //
        // After the defensive fix in floor-state.rematerialize() (skip when
        // the log namespace was never written), the destruction no longer
        // happens. fs now leaves the legacy data alone; migration runs second
        // and translates the opLog cleanly. Ordering still matters for
        // correctness in pathological cases (a writeLog from a concurrent
        // path could materialize an empty log before migration runs), but
        // the simple legacy-load case is now safe in either order.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, eventSource, context } = makeContext(chatRef);

        // Phase 1: mount fs FIRST (subscribes fs's CHAT_CHANGED handler).
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();
        // Phase 2: subscribe migration handler SECOND.
        eventSource.on(event_types.CHAT_CHANGED, async () => {
            await migrateLegacyMemoryGraphState(
                context,
                undefined,
                isExtractableAssistantMessage,
                applyMemoryLogEntryToStore,
            );
        });

        // Phase 3: simulate switching to a chat with legacy data.
        store._raw.set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_switched', type: 'event', seqTo: 1 } }] },
            ],
        });

        await eventSource.emit(event_types.CHAT_CHANGED);
        await fs.ready();

        // fs ran first BUT defensively skipped (log never written). Then
        // migration ran second on the intact legacy opLog and translated it
        // cleanly into the v2 layout.
        const data = store._raw.get(adapterConstants.MODULE_NAME);
        expect(Object.keys(data.nodes).sort()).toEqual(['n_switched']);
        const log = store._raw.get(adapterConstants.LOG_NAMESPACE);
        expect(log.commits).toHaveLength(1);
        expect(store._raw.get(adapterConstants.META_NAMESPACE).schemaVersion).toBe(2);
    });
});

// --- main.js integration: cleanup ---

describe('main.js sequencing: deleteMemoryStoreByTarget cleans all three sidecars', () => {
    test('removes data, log, and meta namespaces at the target', async () => {
        // Mirrors deleteMemoryStoreByTarget in main.js. Used by the "Reset
        // memory graph" UI action — important to leave no orphan v2 data
        // behind, otherwise next-load would resurrect stale state.
        const TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'chat-X' };
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        store._rawFor(TARGET).set(adapterConstants.MODULE_NAME, {
            nodes: { n: { id: 'n', type: 'event' } },
            edges: [],
            coveredAssistantSeq: 1,
        });
        store._rawFor(TARGET).set(adapterConstants.LOG_NAMESPACE, {
            version: adapterConstants.FLOOR_STATE_LOG_VERSION,
            commits: [{ floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] }],
        });
        store._rawFor(TARGET).set(adapterConstants.META_NAMESPACE, {
            schemaVersion: adapterConstants.SCHEMA_VERSION,
            sourceMessageCount: 5,
            lastRecallTrace: [{ step: 'before-reset' }],
        });

        // Replicate deleteMemoryStoreByTarget's three deleteChatState calls.
        await context.deleteChatState(adapterConstants.MODULE_NAME, { target: TARGET });
        await context.deleteChatState(adapterConstants.LOG_NAMESPACE, { target: TARGET });
        await context.deleteChatState(adapterConstants.META_NAMESPACE, { target: TARGET });

        expect(store._rawFor(TARGET).get(adapterConstants.MODULE_NAME)).toBeUndefined();
        expect(store._rawFor(TARGET).get(adapterConstants.LOG_NAMESPACE)).toBeUndefined();
        expect(store._rawFor(TARGET).get(adapterConstants.META_NAMESPACE)).toBeUndefined();
    });

    test('a partial delete (only main namespace) leaves orphan log + meta — documents the bug we fixed', async () => {
        // Pre-migration deleteMemoryStoreByTarget only removed the main
        // namespace; the v2 fix added log + meta deletes alongside. This
        // test pins that contract: if you only remove the main namespace,
        // ensureMemoryStoreLoaded would still find the orphan v2 sidecars
        // and reconstruct stale state on the next read, which is the
        // failure mode the fix prevents.
        const TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'chat-Y' };
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        store._rawFor(TARGET).set(adapterConstants.MODULE_NAME, { nodes: { n: { id: 'n' } } });
        store._rawFor(TARGET).set(adapterConstants.LOG_NAMESPACE, {
            version: 1,
            commits: [{ floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/nodes/n', value: { id: 'n' } }] }],
        });
        store._rawFor(TARGET).set(adapterConstants.META_NAMESPACE, { schemaVersion: 2 });

        // Partial delete (the buggy behaviour).
        await context.deleteChatState(adapterConstants.MODULE_NAME, { target: TARGET });

        // Orphan log + meta would lead loadMemoryStoreByTarget to read meta
        // (v2 stamped), see no main namespace, fall through to v2 path
        // anyway, and then floor-state's next mount/rematerialize for that
        // target would reconstruct the graph from the surviving log
        // commits — undeleting the user's reset.
        expect(store._rawFor(TARGET).get(adapterConstants.LOG_NAMESPACE)).toBeDefined();
        expect(store._rawFor(TARGET).get(adapterConstants.META_NAMESPACE)).toBeDefined();
    });
});

// --- main.js integration: legacy-target fallback ---

describe('main.js sequencing: legacy-target fallback in ensureMemoryStoreLoaded', () => {
    test('migration runs on a non-default target so legacy data can be copied to the new target', async () => {
        // ensureMemoryStoreLoaded's flow when the current target is empty
        // and a legacy-named target has data: run migration on the legacy
        // target first (so its layout is normalized to v2), load it, then
        // copy + delete. This test exercises the "run migration on a
        // legacy target" step.
        const OLD_TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'old-naming' };
        const NEW_TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'new-naming' };
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        // Pre-seed legacy v1 layout at OLD_TARGET.
        store._rawFor(OLD_TARGET).set(adapterConstants.MODULE_NAME, {
            version: 8,
            opLog: [
                { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'old_a', type: 'event', seqTo: 1 } }] },
                { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'old_b', type: 'event', seqTo: 2 } }] },
            ],
            sourceMessageCount: 2,
            lastRecallTrace: [{ step: 'legacy-naming-era' }],
        });

        // Run migration on OLD_TARGET specifically.
        const result = await migrateLegacyMemoryGraphState(
            context,
            OLD_TARGET,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(result.migrated).toBe(true);

        // OLD_TARGET should now be in v2 layout.
        const oldLog = store._rawFor(OLD_TARGET).get(adapterConstants.LOG_NAMESPACE);
        expect(oldLog.commits).toHaveLength(2);
        const oldData = store._rawFor(OLD_TARGET).get(adapterConstants.MODULE_NAME);
        expect(Object.keys(oldData.nodes).sort()).toEqual(['old_a', 'old_b']);
        const oldMeta = store._rawFor(OLD_TARGET).get(adapterConstants.META_NAMESPACE);
        expect(oldMeta.schemaVersion).toBe(2);
        expect(oldMeta.lastRecallTrace).toEqual([{ step: 'legacy-naming-era' }]);

        // NEW_TARGET is still untouched at this point.
        expect(store._rawFor(NEW_TARGET).get(adapterConstants.MODULE_NAME)).toBeUndefined();
        expect(store._rawFor(NEW_TARGET).get(adapterConstants.LOG_NAMESPACE)).toBeUndefined();
        expect(store._rawFor(NEW_TARGET).get(adapterConstants.META_NAMESPACE)).toBeUndefined();
    });

    test('migration on already-v2 legacy target is a no-op (the fallback path safely retries)', async () => {
        // ensureMemoryStoreLoaded calls migrate on every legacy candidate
        // it visits. If a candidate already has v2 sidecars (from a prior
        // partial migration), the second migrate must be cheap and
        // non-destructive.
        const OLD_TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'old-naming' };
        const chatRef = { value: [assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        // Pre-seed v2 layout at OLD_TARGET (as if migration already ran).
        store._rawFor(OLD_TARGET).set(adapterConstants.MODULE_NAME, {
            nodes: { keep: { id: 'keep', type: 'event' } },
            edges: [],
            coveredAssistantSeq: 1,
            appliedSeqTo: 1,
            loggedSeqTo: 1,
            seqCounter: 1,
            nodeSeq: 0,
        });
        store._rawFor(OLD_TARGET).set(adapterConstants.LOG_NAMESPACE, {
            version: 1,
            commits: [{ floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/nodes/keep', value: { id: 'keep' } }] }],
        });
        store._rawFor(OLD_TARGET).set(adapterConstants.META_NAMESPACE, { schemaVersion: 2 });

        const before = JSON.stringify([...store._rawFor(OLD_TARGET).entries()]);
        const result = await migrateLegacyMemoryGraphState(
            context,
            OLD_TARGET,
            isExtractableAssistantMessage,
            applyMemoryLogEntryToStore,
        );
        expect(result.migrated).toBe(false);
        // No mutation.
        expect(JSON.stringify([...store._rawFor(OLD_TARGET).entries()])).toBe(before);
    });
});

// --- main.js sanity: meta-only persist doesn't touch graph payload ---

describe('main.js sequencing: meta-only persist stays in its lane', () => {
    test('writing meta does not touch the data namespace or floor-state log', async () => {
        // Replicates persistMemoryStoreByChatKey's contract: it writes
        // ONLY to META_NAMESPACE. If a future refactor accidentally
        // routed metadata writes through fs.update, the floor-state log
        // would grow unbounded with metadata-only commits and rematerialize
        // would replay metadata patches that don't belong in graph
        // payload.
        const chatRef = { value: [assistantMsg(), assistantMsg()] };
        const { store, context } = makeContext(chatRef);

        // Prime fs with one graph commit.
        await commitGraphEntry(
            context,
            { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'graph_only', type: 'event', seqTo: 1 } }] },
            0,
            applyMemoryLogEntryToStore,
        );
        const dataBefore = JSON.stringify(store._raw.get(adapterConstants.MODULE_NAME));
        const logBefore = JSON.stringify(store._raw.get(adapterConstants.LOG_NAMESPACE));

        await persistMetaFields(context, {
            schemaVersion: 2,
            sourceMessageCount: 2,
            lastRecallTrace: [{ step: 'recall-1' }],
            lastRecallProjection: { at: 100, blocks: { corePacket: '...' } },
        });

        // Data + log unchanged.
        expect(JSON.stringify(store._raw.get(adapterConstants.MODULE_NAME))).toBe(dataBefore);
        expect(JSON.stringify(store._raw.get(adapterConstants.LOG_NAMESPACE))).toBe(logBefore);
        // Meta has the new content.
        const meta = store._raw.get(adapterConstants.META_NAMESPACE);
        expect(meta.lastRecallTrace).toEqual([{ step: 'recall-1' }]);
        expect(meta.lastRecallProjection).toEqual({ at: 100, blocks: { corePacket: '...' } });
    });
});

// --- main.js sanity: branch inheritance with floor-state already in charge ---

describe('main.js sequencing: branch inheritance', () => {
    test('floor-state copies the source log and memory-graph seeds branch __meta', async () => {
        // The full flow as main.js implements it: floor-state's
        // CHAT_BRANCH_CREATED handler copies the truncated log to the
        // target sidecar, then memory-graph's inheritMemoryStoreForBranch
        // writes a fresh __meta with reset recall trace + the new branch's
        // assistantMessageCount. The two together produce a chat target
        // ready to be opened: opening it triggers CHAT_CHANGED which
        // rematerializes the data namespace from the inherited log.
        const SOURCE = { is_group: false, avatar_url: 'a.png', file_name: 'src' };
        const TARGET = { is_group: false, avatar_url: 'a.png', file_name: 'src - Branch #1' };
        const chatRef = { value: [assistantMsg(), assistantMsg(), assistantMsg(), assistantMsg()] };
        const { store, eventSource, context } = makeContext(chatRef);

        // Pre-seed source v2 sidecars: log has 3 commits, meta has recall
        // history that should NOT be inherited (branch starts fresh).
        store._rawFor(SOURCE).set(adapterConstants.LOG_NAMESPACE, {
            version: adapterConstants.FLOOR_STATE_LOG_VERSION,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/marker0', value: 0 }] },
                { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/marker1', value: 1 }] },
                { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/marker3', value: 3 }] },
            ],
        });
        store._rawFor(SOURCE).set(adapterConstants.META_NAMESPACE, {
            schemaVersion: 2,
            sourceMessageCount: 3,
            lastRecallTrace: [{ step: 'on-source-chat' }],
            lastRecallProjection: { at: 200, blocks: {} },
        });

        // Mount fs (which subscribes the floor-state CHAT_BRANCH_CREATED handler).
        const fs = await context.createFloorState({ namespace: adapterConstants.MODULE_NAME });
        await fs.ready();

        // Replicate inheritMemoryStoreForBranch's meta seeding alongside the
        // event emit, mirroring main.js's CHAT_BRANCH_CREATED handler chain.
        const branchPayload = {
            mesId: 1,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
            assistantMessageCount: 1,
        };
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, branchPayload);
        // Memory-graph's inheritMemoryStoreForBranch logic: write fresh meta
        // for the branch chat with reset recall + new sourceMessageCount.
        await context.updateChatState(
            adapterConstants.META_NAMESPACE,
            () => ({
                schemaVersion: 2,
                sourceMessageCount: branchPayload.assistantMessageCount,
                lastRecallTrace: [],
                lastRecallProjection: null,
            }),
            { target: TARGET, maxOperations: 16000 },
        );

        // Floor-state copied the truncated log to TARGET (commits at floor < mesId+1 = 2).
        const branchLog = store._rawFor(TARGET).get(adapterConstants.LOG_NAMESPACE);
        expect(branchLog.commits.map((c) => c.floor)).toEqual([0, 1]);

        // Memory-graph wrote fresh meta to TARGET — recall state RESET.
        const branchMeta = store._rawFor(TARGET).get(adapterConstants.META_NAMESPACE);
        expect(branchMeta).toEqual({
            schemaVersion: 2,
            sourceMessageCount: 1,
            lastRecallTrace: [],
            lastRecallProjection: null,
        });

        // Source untouched.
        expect(store._rawFor(SOURCE).get(adapterConstants.LOG_NAMESPACE).commits).toHaveLength(3);
        expect(store._rawFor(SOURCE).get(adapterConstants.META_NAMESPACE).lastRecallTrace).toEqual([{ step: 'on-source-chat' }]);
    });
});
