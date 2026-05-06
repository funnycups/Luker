/**
 * Search-tools ↔ FloorState binding tests.
 *
 * Mirrors the test layout of `tests/orchestrator/persistence.test.js`:
 * a hand-rolled chat-state store + event source that wires through
 * `createFloorStateWithDeps`, plus a `context` shim that the binding
 * uses to obtain the floor-state instance and read / delete legacy
 * sidecars.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    createFloorStateWithDeps,
} from '../../public/scripts/floor-state.js';
import {
    commitAnchorSnapshot,
    constants as bindingConstants,
    loadAnchorMap,
    loadMetaSidecar,
    migrateLegacyAnchorsIfNeeded,
    persistFallbackManagedEntries,
    pickLatestValidSnapshot,
    resetFloorStateInstanceForTesting,
} from '../../public/scripts/extensions/search-tools/persistence.js';
import { buildLastUserAnchorFromMessages } from '../../public/scripts/extensions/search-tools/anchors.js';

// --- mocks (shape mirrors tests/orchestrator/persistence.test.js) ---

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
    };
}

function makeEventSource() {
    const listeners = new Map();
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
        getChatState: fsDeps.getChatState,
        patchChatState: fsDeps.patchChatState,
        updateChatState: fsDeps.updateChatState,
        deleteChatState: async (ns) => {
            const k = String(ns ?? '').trim().toLowerCase();
            return store._raw.delete(k);
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

function userMsg(text, { swipe_id = 0 } = {}) {
    return { is_user: true, is_system: false, mes: String(text), swipe_id };
}
function asstMsg(text, { swipe_id = 0, swipes = null } = {}) {
    const message = { is_user: false, is_system: false, mes: String(text), swipe_id };
    if (swipes) message.swipes = swipes.slice();
    return message;
}

/**
 * Build the search-tools-style anchor (1-based playableFloor, hash) at the
 * given chat index. Wraps `buildLastUserAnchorFromMessages` against a chat
 * slice so we can target arbitrary user turns (the helper itself only ever
 * picks the latest user turn).
 */
function buildAnchorAt(messages, chatIndex) {
    if (!messages[chatIndex]?.is_user) return null;
    const slice = messages.slice(0, chatIndex + 1);
    return buildLastUserAnchorFromMessages(slice);
}

function makeSnapshot(anchor, overrides = {}) {
    return {
        anchorHash: anchor.hash,
        updatedAt: '2026-01-01T00:00:00.000Z',
        summary: 'agent ran',
        mutationCount: 1,
        managedEntryCount: 0,
        bookName: '__SEARCH_TOOLS__',
        managedEntries: [],
        ...overrides,
    };
}

async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    resetFloorStateInstanceForTesting();
});

// --- commit semantics ---

describe('commitAnchorSnapshot', () => {
    test('writes a single floor-state commit at the anchored user message and lands the snapshot under its playable floor key', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);
        expect(anchor).toMatchObject({ playableFloor: 1, floor: 1 });

        const snapshot = makeSnapshot(anchor, { summary: 'first run' });
        const ok = await commitAnchorSnapshot(context, anchor, snapshot);
        expect(ok).toBe(true);

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({
            anchorHash: anchor.hash,
            summary: 'first run',
        });
    });

    test('rejects anchors with missing playableFloor', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        expect(await commitAnchorSnapshot(context, { playableFloor: 0, hash: 'x' }, makeSnapshot({ hash: 'x' }))).toBe(false);
    });

    test('rejects when the anchor playable floor maps to no user message', async () => {
        // Only an assistant message present — playableFloor 1 is the assistant,
        // not a user turn, so the commit must refuse.
        const chatRef = { value: [asstMsg('not user')] };
        const { context } = makeContext(chatRef);
        const anchor = { floor: 1, playableFloor: 1, hash: 'h' };
        const ok = await commitAnchorSnapshot(context, anchor, makeSnapshot({ hash: 'h' }));
        expect(ok).toBe(false);
        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('rejects null / non-object snapshots', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);
        expect(await commitAnchorSnapshot(context, anchor, null)).toBe(false);
        expect(await commitAnchorSnapshot(context, anchor, 'not-an-object')).toBe(false);
    });

    test('a second commit at the same anchor replaces the snapshot', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);

        await commitAnchorSnapshot(context, anchor, makeSnapshot(anchor, { summary: 'first' }));
        await commitAnchorSnapshot(context, anchor, makeSnapshot(anchor, { summary: 'second' }));

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({ summary: 'second' });
    });
});

// --- pickLatestValidSnapshot ---

describe('pickLatestValidSnapshot', () => {
    test('returns the highest-floor entry whose anchor message text still matches', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { context } = makeContext(chatRef);
        const a1 = buildAnchorAt(chatRef.value, 0);
        const a2 = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, a1, makeSnapshot(a1, { summary: 'first' }));
        await commitAnchorSnapshot(context, a2, makeSnapshot(a2, { summary: 'second' }));

        const map = await loadAnchorMap(context);
        const pick = pickLatestValidSnapshot(context, map);
        expect(pick?.playableFloor).toBe(3);
        expect(pick?.snapshot.summary).toBe('second');
    });

    test('skips entries whose anchorHash no longer matches the live message text', async () => {
        const chatRef = { value: [userMsg('original'), asstMsg('a1'), userMsg('u2')] };
        const { context } = makeContext(chatRef);
        const anchorOne = buildAnchorAt(chatRef.value, 0);
        const anchorTwo = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, anchorOne, makeSnapshot(anchorOne, { summary: 'first' }));
        await commitAnchorSnapshot(context, anchorTwo, makeSnapshot(anchorTwo, { summary: 'second' }));

        // Edit the second user message — its hash no longer matches the stored snapshot.
        chatRef.value[2] = userMsg('edited');
        const map = await loadAnchorMap(context);
        const pick = pickLatestValidSnapshot(context, map);
        expect(pick?.playableFloor).toBe(1);
        expect(pick?.snapshot.summary).toBe('first');
    });

    test('returns null when no entries match', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const pick = pickLatestValidSnapshot(context, {});
        expect(pick).toBeNull();
    });

    test('skips entries whose anchored slot is now a non-user message', async () => {
        const chatRef = { value: [userMsg('orig'), asstMsg('a1')] };
        const { context } = makeContext(chatRef);
        const anchor = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchor, makeSnapshot(anchor));

        // Replace the user message with an assistant message at the same floor —
        // a degenerate state, but the validity check should still refuse.
        chatRef.value[0] = asstMsg('hijacked');
        const map = await loadAnchorMap(context);
        expect(pickLatestValidSnapshot(context, map)).toBeNull();
    });
});

// --- structural events through floor-state ---

describe('floor-state events on search-tools commits', () => {
    test('MESSAGE_DELETED truncating past the anchored user message drops its snapshot', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        const anchorOne = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchorOne, makeSnapshot(anchorOne, { summary: 'first' }));
        const anchorTwo = buildAnchorAt(chatRef.value, 2);
        await commitAnchorSnapshot(context, anchorTwo, makeSnapshot(anchorTwo, { summary: 'second' }));

        let map = await loadAnchorMap(context);
        expect(Object.keys(map).map(Number).sort()).toEqual([1, 3]);

        // Delete the second user + its assistant; new chat length = 2.
        chatRef.value = chatRef.value.slice(0, 2);
        await eventSource.emit(event_types.MESSAGE_DELETED, chatRef.value.length, {});
        await flush();

        map = await loadAnchorMap(context);
        expect(Object.keys(map).map(Number).sort()).toEqual([1]);
        expect(map[1]).toMatchObject({ summary: 'first' });
    });

    test('MESSAGE_SWIPED on the anchored user message filters the commit out', async () => {
        const chatRef = {
            value: [
                userMsg('u1', { swipe_id: 0 }),
                asstMsg('a1'),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        const anchor = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchor, makeSnapshot(anchor, { summary: 'v0' }));
        expect((await loadAnchorMap(context))[1]).toMatchObject({ summary: 'v0' });

        chatRef.value[0] = userMsg('u1-alt', { swipe_id: 1 });
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await flush();

        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('MESSAGE_SWIPED on a non-anchored message keeps the commit intact', async () => {
        const chatRef = {
            value: [
                userMsg('u1', { swipe_id: 0 }),
                asstMsg('a1', { swipe_id: 0 }),
            ],
        };
        const { eventSource, context } = makeContext(chatRef);

        const anchor = buildAnchorAt(chatRef.value, 0);
        await commitAnchorSnapshot(context, anchor, makeSnapshot(anchor));

        chatRef.value[1] = asstMsg('a1-alt', { swipe_id: 1 });
        await eventSource.emit(event_types.MESSAGE_SWIPED, 1);
        await flush();

        const map = await loadAnchorMap(context);
        expect(map[1]).toMatchObject({ anchorHash: anchor.hash });
    });
});

// --- meta sidecar ---

describe('persistFallbackManagedEntries / loadMetaSidecar', () => {
    test('round-trips a managed-entries array through the meta sidecar', async () => {
        const chatRef = { value: [] };
        const { context } = makeContext(chatRef);
        const entries = [
            { entryId: 'e1', title: 'title', keywords: [], content: 'body', alwaysInject: false },
        ];
        await persistFallbackManagedEntries(context, entries);
        const meta = await loadMetaSidecar(context);
        expect(meta.fallbackManagedEntries).toEqual(entries);
    });

    test('a fresh chat reads the empty defaults', async () => {
        const chatRef = { value: [] };
        const { context } = makeContext(chatRef);
        const meta = await loadMetaSidecar(context);
        expect(meta).toEqual({ schemaVersion: 0, fallbackManagedEntries: [] });
    });

    test('writing fallback entries does not clobber an existing schemaVersion stamp', async () => {
        const chatRef = { value: [] };
        const { context, store } = makeContext(chatRef);
        store._raw.set(bindingConstants.META_NAMESPACE, {
            schemaVersion: bindingConstants.SCHEMA_VERSION,
            fallbackManagedEntries: [],
        });
        await persistFallbackManagedEntries(context, [{ entryId: 'e', content: 'x' }]);
        const meta = await loadMetaSidecar(context);
        expect(meta.schemaVersion).toBe(bindingConstants.SCHEMA_VERSION);
        expect(meta.fallbackManagedEntries).toHaveLength(1);
    });
});

// --- legacy migration ---

describe('migrateLegacyAnchorsIfNeeded', () => {
    test('migrates an index + per-anchor sidecars into floor-state commits and deletes legacy data', async () => {
        const chatRef = {
            value: [
                userMsg('u1'), asstMsg('a1'),
                userMsg('u2'), asstMsg('a2'),
            ],
        };
        const { store, context } = makeContext(chatRef);

        const a1 = buildAnchorAt(chatRef.value, 0);
        const a2 = buildAnchorAt(chatRef.value, 2);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 3,
            anchors: [a1.playableFloor, a2.playableFloor],
            managedEntries: [],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`, {
            anchorHash: a1.hash,
            summary: 'legacy first',
            managedEntries: [],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a2.playableFloor}`, {
            anchorHash: a2.hash,
            summary: 'legacy second',
            managedEntries: [],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result).toMatchObject({ migrated: true, committed: 2 });

        // Legacy namespaces gone.
        expect(store._raw.has(bindingConstants.LEGACY_INDEX_NAMESPACE)).toBe(false);
        expect(store._raw.has(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`)).toBe(false);
        expect(store._raw.has(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a2.playableFloor}`)).toBe(false);

        // Schema marker stamped in the meta sidecar.
        const meta = await loadMetaSidecar(context);
        expect(meta.schemaVersion).toBe(bindingConstants.SCHEMA_VERSION);

        // Both snapshots reachable through the floor-state instance.
        const map = await loadAnchorMap(context);
        expect(map[a1.playableFloor]).toMatchObject({ summary: 'legacy first' });
        expect(map[a2.playableFloor]).toMatchObject({ summary: 'legacy second' });
    });

    test('a second call after migration is a no-op', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);
        const a1 = buildAnchorAt(chatRef.value, 0);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 3,
            anchors: [a1.playableFloor],
            managedEntries: [],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}${a1.playableFloor}`, {
            anchorHash: a1.hash,
            summary: 'cap',
            managedEntries: [],
        });
        const first = await migrateLegacyAnchorsIfNeeded(context);
        expect(first.migrated).toBe(true);
        const second = await migrateLegacyAnchorsIfNeeded(context);
        expect(second.migrated).toBe(false);
        expect(second.reason).toBe('already-migrated');
    });

    test('stamps the schema version on a fresh chat with no legacy data', async () => {
        const chatRef = { value: [userMsg('hi')] };
        const { context } = makeContext(chatRef);
        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(false);
        expect(result.reason).toBe('no-legacy-data');
        const meta = await loadMetaSidecar(context);
        expect(meta.schemaVersion).toBe(bindingConstants.SCHEMA_VERSION);
    });

    test('drops legacy anchors whose user message no longer exists in the chat', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 3,
            // playableFloor 99 has no corresponding message in the current chat.
            anchors: [99],
            managedEntries: [],
        });
        store._raw.set(`${bindingConstants.LEGACY_ANCHOR_NAMESPACE_PREFIX}99`, {
            anchorHash: 'stale',
            summary: 'stale cap',
            managedEntries: [],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(true);
        expect(result.committed).toBe(0);
        const map = await loadAnchorMap(context);
        expect(map).toEqual({});
    });

    test('promotes a legacy `snapshot` field into a floor-state commit', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        const a1 = buildAnchorAt(chatRef.value, 0);
        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 1,
            anchors: [],
            managedEntries: [],
            snapshot: {
                anchorPlayableFloor: a1.playableFloor,
                anchorHash: a1.hash,
                summary: 'pre-anchor-list',
                managedEntries: [],
            },
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(true);
        const map = await loadAnchorMap(context);
        expect(map[a1.playableFloor]).toMatchObject({ summary: 'pre-anchor-list' });
    });

    test('lifts legacy fallback managedEntries into the meta sidecar', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 3,
            anchors: [],
            managedEntries: [
                { entryId: 'e1', title: 't', keywords: [], content: 'body', alwaysInject: false },
            ],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result).toMatchObject({ migrated: true, fallbackManagedEntryCount: 1 });
        const meta = await loadMetaSidecar(context);
        expect(meta.fallbackManagedEntries).toHaveLength(1);
        expect(meta.schemaVersion).toBe(bindingConstants.SCHEMA_VERSION);
    });

    test('a v3 envelope carrying neither anchors nor managedEntries nor an inline snapshot is treated as no legacy data', async () => {
        const chatRef = { value: [userMsg('u1')] };
        const { store, context } = makeContext(chatRef);

        store._raw.set(bindingConstants.LEGACY_INDEX_NAMESPACE, {
            version: 3,
            anchors: [],
            managedEntries: [],
        });

        const result = await migrateLegacyAnchorsIfNeeded(context);
        expect(result.migrated).toBe(false);
        expect(result.reason).toBe('no-legacy-data');
    });
});
