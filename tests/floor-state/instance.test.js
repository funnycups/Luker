/**
 * Integration tests for the FloorState instance layer with mocked deps.
 *
 * The instance layer uses createFloorStateWithDeps so tests can substitute
 * an in-memory chat-state store, a synthetic eventSource, and a mutable
 * chat array, then assert how the instance reacts to chat events.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    createFloorStateWithDeps,
} from '../../public/scripts/floor-state.js';

// --- minimal in-memory mocks ---

function makeStore() {
    // Targets are partitioned: each target gets its own namespace map. The
    // empty-key partition stands in for "current chat" (calls without an
    // explicit options.target). This lets tests exercise cross-target ops
    // (e.g. branch inheritance) without leaking state across chats.
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
        async deleteChatState(ns, options) {
            const k = String(ns ?? '').trim().toLowerCase();
            const part = partitionFor(options?.target);
            part.delete(k);
            return true;
        },
        // Backwards-compatible alias for tests that pre-seed / inspect the
        // default-target partition directly.
        get _raw() { return partitionFor(undefined); },
        _rawFor(target) { return partitionFor(target); },
    };
}

function makeEventSource() {
    const listeners = new Map();
    // Floor-state no longer self-subscribes — production driver is core
    // calling `settleXxx(...)` from `floor-state.js`. The test mock mirrors
    // that contract: each test binds its instance via `_bindInstance(fs)`,
    // and emit drives the bound instances on the relevant structural events
    // BEFORE running the listeners registered with `.on()`.
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

function makeDeps(chatRef) {
    const store = makeStore();
    const eventSource = makeEventSource();
    return {
        store,
        eventSource,
        deps: {
            getChatState: store.getChatState.bind(store),
            patchChatState: store.patchChatState.bind(store),
            updateChatState: store.updateChatState.bind(store),
            deleteChatState: store.deleteChatState.bind(store),
            buildObjectPatchOperationsAsync,
            eventSource,
            event_types,
            getChat: () => chatRef.value,
        },
    };
}

// helper: msg with swipe_id (and optional swipes for completeness)
function msg(swipe_id = 0) {
    return { swipe_id, mes: 'x' };
}

// allow microtasks queued by emit handlers to flush
async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

// --- tests ---

describe('createFloorStateWithDeps — basic operations', () => {
    test('throws when namespace is empty', () => {
        const chatRef = { value: [] };
        const { deps } = makeDeps(chatRef);
        expect(() => createFloorStateWithDeps({ namespace: '' }, deps)).toThrow(/namespace/);
        expect(() => createFloorStateWithDeps({}, deps)).toThrow(/namespace/);
    });

    test('throws when namespace ends with reserved log suffix', () => {
        const chatRef = { value: [] };
        const { deps } = makeDeps(chatRef);
        expect(() => createFloorStateWithDeps({ namespace: 'foo__floor_log' }, deps))
            .toThrow(/__floor_log/);
    });

    test('lowercases and trims namespace', () => {
        const chatRef = { value: [] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: '  Memory-Graph  ' }, deps);
        expect(fs.namespace).toBe('memory-graph');
    });

    test('patch appends a commit to the log (single-write semantics)', async () => {
        const chatRef = { value: [msg(0)] }; // one floor
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const ok = await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(ok).toBe(true);

        // Single-write: only the log is touched; data namespace is derived.
        expect(store._raw.get('foo')).toBeUndefined();
        expect(await fs.get()).toEqual({ x: 1 });

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        expect(log.commits[0]).toMatchObject({ floor: 0, swipeId: 0 });
    });

    test('patch returns true on empty operations without writing', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.patch([])).toBe(true);
        expect(store._raw.get('foo')).toBeUndefined();
        expect(store._raw.get('foo__floor_log')).toBeUndefined();
    });

    test('update applies reducer and persists diff as commit', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.update(() => ({ a: 1, b: { c: 2 } }));
        expect(await fs.get()).toEqual({ a: 1, b: { c: 2 } });

        await fs.update((current) => ({ ...current, b: { c: 99 } }));
        expect(await fs.get()).toEqual({ a: 1, b: { c: 99 } });

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(2);
        // Data namespace never written.
        expect(store._raw.get('foo')).toBeUndefined();
    });

    test('update ignores reducer returning non-object', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.update(() => null)).toBe(true);
        expect(await fs.update(() => 'string')).toBe(true);
        expect(await fs.update(() => [1, 2, 3])).toBe(true);
        expect(await fs.get()).toBeNull();
    });

    test('get returns current state or null', async () => {
        const chatRef = { value: [msg(0)] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.get()).toBeNull();
        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(await fs.get()).toEqual({ x: 1 });
    });
});

describe('event reactions', () => {
    test('CHAT_CHANGED re-replays log against current chat (cache invalidates)', async () => {
        // Build log under chat A, then switch chat to a fresh array and emit.
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(await fs.get()).toEqual({ x: 1 });

        // Simulate switching to a different chat: drop the log (empty)
        // and replace the chat array.
        store._raw.set('foo__floor_log', { version: 1, commits: [] });
        chatRef.value = [msg(0)]; // chat B has just one floor

        await eventSource.emit(event_types.CHAT_CHANGED);
        await fs.ready();

        // Empty log → get() returns null.
        expect(await fs.get()).toBeNull();
    });

    test('one-time migration backs up legacy data namespace and deletes it', async () => {
        // Legacy chats had data written to the namespace directly. The first
        // fs.get() after this refactor must capture that legacy payload as
        // a `__orphans` backup (the diff vs log replay) and remove the dead
        // data sidecar so subsequent reads route purely through log replay.
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        // Pre-seed legacy data payload + an empty log (= clean migration
        // scenario where ALL of the data payload is drift).
        store._raw.set('foo', { version: 8, opLog: [{ seq: 1, ops: [] }], legacy: true });
        store._raw.set('foo__floor_log', { version: 1, commits: [] });
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const result = await fs.get();

        // Legacy data was treated as drift since log was empty.
        expect(result).toBeNull();
        // Legacy data namespace removed.
        expect(store._raw.has('foo')).toBe(false);
        // Orphans backup captured.
        const orphans = store._raw.get('foo__orphans');
        expect(orphans).toBeTruthy();
        expect(orphans.dataPayload).toEqual({ version: 8, opLog: [{ seq: 1, ops: [] }], legacy: true });
        expect(Array.isArray(orphans.diff)).toBe(true);
        expect(orphans.diff.length).toBeGreaterThan(0);
    });

    test('MESSAGE_DELETED truncates commits at or beyond new length', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/a', value: 1 }]);
        chatRef.value.push(msg(0));
        await fs.patch([{ op: 'add', path: '/b', value: 2 }]);
        chatRef.value.push(msg(0));
        await fs.patch([{ op: 'add', path: '/c', value: 3 }]);

        // Now log has 3 commits at floors 2, 3, 4.
        expect(store._raw.get('foo__floor_log').commits).toHaveLength(3);

        // Simulate deleting from floor 3 onward; new chat length = 3.
        chatRef.value = chatRef.value.slice(0, 3);
        await eventSource.emit(event_types.MESSAGE_DELETED, 3);
        await fs.ready();

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        expect(log.commits[0].floor).toBe(2);
        expect(await fs.get()).toEqual({ a: 1 });
    });

    test('MESSAGE_DELETED to length 0 leaves an empty log and null state', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(await fs.get()).toEqual({ x: 1 });

        chatRef.value = [];
        await eventSource.emit(event_types.MESSAGE_DELETED, 0);
        await fs.ready();

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(0);
        expect(await fs.get()).toBeNull();
    });

    test('MESSAGE_SWIPED replays log under the active swipe', async () => {
        // Floor 0 with swipe 0; record a commit on swipe 0.
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/from0', value: true }]);

        // User swipes to swipe 1 and the AI generates new content there.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();

        // Swipe-1 has no commits yet; replay against swipe 1 produces an
        // empty target state (log has commits, but none survive the swipeMap).
        expect(await fs.get()).toEqual({});

        // Plugin writes a different commit on swipe 1.
        await fs.patch([{ op: 'add', path: '/from1', value: true }]);
        expect(await fs.get()).toEqual({ from1: true });

        // User swipes back to 0.
        chatRef.value[0].swipe_id = 0;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        expect(await fs.get()).toEqual({ from0: true });

        // And again to 1.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        expect(await fs.get()).toEqual({ from1: true });
    });

    test('MESSAGE_SWIPE_DELETED drops target swipe and shifts higher ones down', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        // Write on swipe 0
        await fs.patch([{ op: 'add', path: '/s0', value: 0 }]);
        // Swipe to 1, write
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        await fs.patch([{ op: 'add', path: '/s1', value: 1 }]);
        // Swipe to 2, write
        chatRef.value[0].swipe_id = 2;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        await fs.patch([{ op: 'add', path: '/s2', value: 2 }]);

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(3);

        // Delete swipe 1; the active swipe becomes 1 (was 2 before the shift).
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: 0, swipeId: 1 });
        await fs.ready();

        // Surviving commits: swipe 0 unchanged, the old swipe 2 commit is now swipe 1.
        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(2);
        const swipeIds = log.commits.map((c) => c.swipeId).sort();
        expect(swipeIds).toEqual([0, 1]);

        // Active swipe is now 1 (formerly swipe 2's content).
        expect(await fs.get()).toEqual({ s2: 2 });
    });
});

describe('ready gate', () => {
    test('ready resolves immediately when nothing is in flight', async () => {
        const chatRef = { value: [] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await expect(fs.ready()).resolves.toBeUndefined();
    });

    test('ready blocks while a structural settle is running, then resolves', async () => {
        const chatRef = { value: [msg(0)] };
        const baseDeps = makeDeps(chatRef);
        // Seed the log so handleMessageDeleted has something to truncate.
        baseDeps.store._raw.set('foo__floor_log', {
            version: 1,
            commits: [{ floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] }],
        });
        // Slow down updateChatState on log writes so we can observe pending.
        let resolveBlock;
        const blocker = new Promise((r) => { resolveBlock = r; });
        const slowUpdate = async (ns, updater, options) => {
            if (ns === 'foo__floor_log') await blocker;
            return baseDeps.deps.updateChatState(ns, updater, options);
        };
        const deps = { ...baseDeps.deps, updateChatState: slowUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        // Truncate to 0 → handleMessageDeleted writes the log (blocked).
        chatRef.value = [];
        const emitPromise = baseDeps.eventSource.emit(event_types.MESSAGE_DELETED, 0);
        await flush();
        // Now the log-write is mid-flight. ready() should pend.
        let resolved = false;
        fs.ready().then(() => { resolved = true; });
        await flush();
        expect(resolved).toBe(false);

        resolveBlock();
        await emitPromise;
        await fs.ready();
        expect(resolved).toBe(true);
    });
});

describe('destroy', () => {
    test('destroy removes the instance from the registry-driven settle path', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);

        fs.destroy();
        eventSource._unbindInstance(fs);
        // After destroy, emitting events must not mutate the log.
        const beforeLog = store._raw.get('foo__floor_log');

        chatRef.value = [];
        await eventSource.emit(event_types.MESSAGE_DELETED, 0);
        await flush();

        // Log namespace unchanged.
        expect(store._raw.get('foo__floor_log')).toEqual(beforeLog);
    });

    test('patch / update become no-ops after destroy', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        fs.destroy();

        expect(await fs.patch([{ op: 'add', path: '/x', value: 1 }])).toBe(false);
        expect(await fs.update(() => ({ x: 1 }))).toBe(false);
        expect(await fs.get()).toBeNull();
        expect(store._raw.size).toBe(0);
    });

    test('destroy({purge: true}) removes the log sidecar from disk', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(store._raw.has('foo__floor_log')).toBe(true);

        const ok = await fs.destroy({ purge: true });
        expect(ok).toBe(true);
        expect(store._raw.has('foo__floor_log')).toBe(false);
    });

    test('destroy() without purge leaves the log sidecar intact', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        await fs.destroy();
        expect(store._raw.has('foo__floor_log')).toBe(true);
    });
});

describe('reset (log replacement)', () => {
    test('reset() with non-empty commits replaces the log atomically', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        // Seed with some earlier history so we can verify it gets fully replaced.
        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(store._raw.get('foo__floor_log').commits).toHaveLength(1);

        const newCommits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 2 }] },
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/z', value: 3 }] },
        ];
        const ok = await fs.reset(newCommits);
        expect(ok).toBe(true);

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toEqual(newCommits);
        // Cache was invalidated; next get() replays the new log.
        expect(await fs.get()).toEqual({ y: 2, z: 3 });
    });

    test('reset([]) clears the log to an empty replay', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(await fs.get()).toEqual({ x: 1 });

        const ok = await fs.reset([]);
        expect(ok).toBe(true);
        expect(store._raw.get('foo__floor_log').commits).toEqual([]);
        expect(await fs.get()).toBeNull();
    });

    test('reset() rejects a batch with an out-of-range floor and leaves the log untouched', async () => {
        const chatRef = { value: [msg(0), msg(0)] }; // chat.length = 2
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        const before = JSON.stringify(store._raw.get('foo__floor_log'));

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const ok = await fs.reset([
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
                { floor: 5, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] }, // out of range
            ]);
            expect(ok).toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('out of range'));
        } finally {
            warn.mockRestore();
        }
        // Log unchanged.
        expect(JSON.stringify(store._raw.get('foo__floor_log'))).toBe(before);
    });

    test('reset() rejects malformed commits and leaves the log untouched', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await fs.reset([{ floor: -1, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] }])).toBe(false);
            expect(await fs.reset([{ floor: 0, swipeId: 0, patches: [] }])).toBe(false); // empty patches
            expect(await fs.reset([{ floor: 0, swipeId: 0 }])).toBe(false); // missing patches
        } finally {
            warn.mockRestore();
        }
        expect(store._raw.get('foo__floor_log')).toBeUndefined();
    });

    test('reset() rejects non-array input', async () => {
        const chatRef = { value: [msg(0)] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.reset(null)).toBe(false);
        expect(await fs.reset(undefined)).toBe(false);
        expect(await fs.reset({ commits: [] })).toBe(false);
    });

    test('reset() returns false after destroy', async () => {
        const chatRef = { value: [msg(0)] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.destroy();
        expect(await fs.reset([])).toBe(false);
    });

    test('patch after reset chains onto the new history', async () => {
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.reset([
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 2 }] },
        ]);
        await fs.patch([{ op: 'add', path: '/z', value: 3 }]);

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(2);
        expect(await fs.get()).toEqual({ y: 2, z: 3 });
    });
});

describe('lazy log replay', () => {
    test('get() derives state from existing log on first call', async () => {
        // Pre-seed the log as if from a prior session; data namespace empty.
        // First fs.get() must replay the log lazily.
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
                { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toEqual({ a: 1, b: 2 });
    });

    test('respects current swipe map when replaying on first get()', async () => {
        // Log has commits across two swipes of floor 0; only the active swipe
        // should appear after replay.
        const chatRef = { value: [{ swipe_id: 1, mes: 'x' }] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/from0', value: true }] },
                { floor: 0, swipeId: 1, patches: [{ op: 'add', path: '/from1', value: true }] },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toEqual({ from1: true });
    });

    test('get() returns null when log namespace is absent', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toBeNull();
        // No writes were performed by construction.
        expect(store._raw.get('foo')).toBeUndefined();
        expect(store._raw.get('foo__floor_log')).toBeUndefined();
    });

    test('get() returns null when log exists but has no commits', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', { version: 1, commits: [] });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toBeNull();
        expect(store._raw.get('foo')).toBeUndefined();
    });
});

describe('broken-log recovery via floor truncate', () => {
    test('get() truncates commits at the broken floor, backs up to __orphans, and returns the recovered state', async () => {
        // Two healthy commits on floor 0 + a stale-prev-base commit on floor 1
        // that fails RFC 6902 `test`. fs.get() must back the full log up to
        // foo__orphans (with brokenCommitIndex / brokenFloor / brokenLog),
        // rewrite the log keeping only commits whose floor < 1, and return
        // the replay of the survivors.
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
                { floor: 0, swipeId: 0, patches: [{ op: 'replace', path: '/x', value: 2 }] },
                {
                    floor: 1, swipeId: 0, patches: [
                        // Stale prev base: asserts /x === 1 but state has /x === 2 by now.
                        { op: 'test', path: '/x', value: 1 },
                        { op: 'replace', path: '/x', value: 99 },
                    ],
                },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toEqual({ x: 2 });

        const orphans = store._raw.get('foo__orphans');
        expect(orphans).toBeTruthy();
        expect(orphans.recoveredFromBrokenLog).toBe(true);
        expect(orphans.brokenCommitIndex).toBe(2);
        expect(orphans.brokenFloor).toBe(1);
        expect(typeof orphans.replayError).toBe('string');
        expect(orphans.brokenLog.commits).toHaveLength(3);

        // Log on disk now holds only the surviving commits (both on floor 0).
        const rewritten = store._raw.get('foo__floor_log');
        expect(rewritten.commits).toHaveLength(2);
        rewritten.commits.forEach((c) => expect(c.floor).toBe(0));
    });

    test('truncate by floor also drops siblings of the broken commit on the same floor', async () => {
        // Two writes targeting floor 2 (a race scenario). The first is the
        // racing-early sibling (its patches happen to compose with the prior
        // log), the second breaks on a stale `test`. Both should be discarded
        // — preserving the "early" sibling would leave half-applied garbage
        // attached to the in-flight floor.
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
                // Sibling that happens to compose (race winner that wrote n_259).
                { floor: 2, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 'sibling' }] },
                // Race loser: bases on /x === 0 but x is already 1.
                {
                    floor: 2, swipeId: 0, patches: [
                        { op: 'test', path: '/x', value: 0 },
                        { op: 'replace', path: '/x', value: 2 },
                    ],
                },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        // Only the floor-1 commit survives: the sibling on floor 2 goes too.
        expect(await fs.get()).toEqual({ x: 1 });

        const rewritten = store._raw.get('foo__floor_log');
        expect(rewritten.commits).toHaveLength(1);
        expect(rewritten.commits[0].floor).toBe(1);
    });

    test('returns null when the broken floor is 0 and nothing else survives', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
                {
                    floor: 0, swipeId: 0, patches: [
                        { op: 'test', path: '/x', value: 999 },
                        { op: 'replace', path: '/x', value: 2 },
                    ],
                },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toBeNull();

        const rewritten = store._raw.get('foo__floor_log');
        expect(rewritten.commits).toHaveLength(0);
    });

    test('subsequent get() calls hit the rewritten log without re-recovering', async () => {
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', {
            version: 1,
            commits: [
                { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
                {
                    floor: 1, swipeId: 0, patches: [
                        { op: 'test', path: '/x', value: 999 },
                        { op: 'replace', path: '/x', value: 2 },
                    ],
                },
            ],
        });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(await fs.get()).toEqual({ x: 1 });
        const firstOrphan = store._raw.get('foo__orphans');
        expect(firstOrphan).toBeTruthy();

        // Mutate the orphans entry; if a second get() re-ran recovery it
        // would overwrite this back to the original shape.
        store._raw.set('foo__orphans', { ...firstOrphan, tampered: true });
        expect(await fs.get()).toEqual({ x: 1 });
        expect(store._raw.get('foo__orphans').tampered).toBe(true);
    });
});

describe('concurrency: patch vs structural event', () => {
    test('patch + concurrent CHAT_CHANGED leaves state derived from log', async () => {
        // Stall the appendCommit write so a concurrent CHAT_CHANGED races with
        // it. Whichever ordering wins, fs.get() must match computeTargetState
        // applied to the final log — i.e. the committed mutation must show up.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);

        let releaseAppend;
        let appendIntercepted = false;
        const block = new Promise((r) => { releaseAppend = r; });
        const slowUpdate = async (ns, updater, options) => {
            if (ns === 'foo__floor_log' && !appendIntercepted) {
                appendIntercepted = true;
                await block;
            }
            return base.deps.updateChatState(ns, updater, options);
        };
        const deps = { ...base.deps, updateChatState: slowUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        const patchPromise = fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        await flush();
        const emitPromise = base.eventSource.emit(event_types.CHAT_CHANGED);
        await flush();

        releaseAppend();
        await Promise.all([patchPromise, emitPromise]);
        await fs.ready();

        const log = base.store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        expect(await fs.get()).toEqual({ x: 1 });
    });

    test('ready() waits for both an in-flight patch and a concurrent event', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);

        let releaseAppend;
        let appendIntercepted = false;
        const block = new Promise((r) => { releaseAppend = r; });
        const slowUpdate = async (ns, updater, options) => {
            if (ns === 'foo__floor_log' && !appendIntercepted) {
                appendIntercepted = true;
                await block;
            }
            return base.deps.updateChatState(ns, updater, options);
        };
        const deps = { ...base.deps, updateChatState: slowUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        const patchPromise = fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        await flush();
        const emitPromise = base.eventSource.emit(event_types.CHAT_CHANGED);
        await flush();

        let readyResolved = false;
        const readyPromise = fs.ready().then(() => { readyResolved = true; });
        await flush();
        expect(readyResolved).toBe(false);

        releaseAppend();
        await Promise.all([patchPromise, emitPromise, readyPromise]);
        expect(readyResolved).toBe(true);
    });

    test('patch returns false when appendCommit fails; state stays at pre-patch', async () => {
        // Single-write semantics: if the only write (log append) fails, there
        // is no half-state to recover from. fs.get() must still return the
        // pre-patch value derived from the unchanged log.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        // Seed with a known committed state.
        await (async () => {
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, base.deps);
            await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
            expect(await fs.get()).toEqual({ x: 1 });
        })();

        const failingUpdate = async (ns, updater, options) => {
            if (ns === 'foo__floor_log') {
                return { ok: false, state: null, updated: false };
            }
            return base.deps.updateChatState(ns, updater, options);
        };
        const deps = { ...base.deps, updateChatState: failingUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const ok = await fs.patch([{ op: 'add', path: '/y', value: 2 }]);
        expect(ok).toBe(false);
        expect(await fs.get()).toEqual({ x: 1 });
    });
});

describe('branch inheritance via CHAT_BRANCH_CREATED', () => {
    const SOURCE = { is_group: false, avatar_url: 'char.png', file_name: 'chat-A' };
    const TARGET = { is_group: false, avatar_url: 'char.png', file_name: 'chat-A - Branch #1' };

    function seedSourceLog(store, commits) {
        store._rawFor(SOURCE).set('foo__floor_log', { version: 1, commits });
    }

    test('truncates source commits at the branch point and writes to target sidecar', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] },
            { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/c', value: 3 }] },
            { floor: 4, swipeId: 0, patches: [{ op: 'add', path: '/d', value: 4 }] },
        ]);

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        // Branch from floor 2 → new chat length = 3, surviving commits floors 0..2.
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 2,
            branchName: 'chat-A - Branch #1',
            assistantMessageCount: 1,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        const branchLog = store._rawFor(TARGET).get('foo__floor_log');
        expect(branchLog.commits).toHaveLength(2);
        expect(branchLog.commits.map((c) => c.floor)).toEqual([0, 1]);
        // Source log untouched.
        expect(store._rawFor(SOURCE).get('foo__floor_log').commits).toHaveLength(4);
    });

    test('branch inheritance + opening the branch produces correct replay state', async () => {
        // Full end-to-end: seed source, branch, "open" the new chat (swap chatRef
        // to the truncated content + spawn a target-scoped instance), and assert
        // fs.get() on the target reflects only the surviving commits.
        const chatRef = { value: [msg(0), msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
            { floor: 2, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] },
            { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/c', value: 3 }] },
        ]);

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 2,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        // Caller flow: openChat(branch) swaps chat to the truncated content.
        chatRef.value = [msg(0), msg(0), msg(0)];
        const branchDeps = {
            ...deps,
            getChatState: (ns, options) => deps.getChatState(ns, { ...options, target: options?.target ?? TARGET }),
            patchChatState: (ns, ops, options) => deps.patchChatState(ns, ops, { ...options, target: options?.target ?? TARGET }),
            updateChatState: (ns, updater, options) => deps.updateChatState(ns, updater, { ...options, target: options?.target ?? TARGET }),
            deleteChatState: (ns, options) => deps.deleteChatState(ns, { ...options, target: options?.target ?? TARGET }),
        };
        const branchFs = createFloorStateWithDeps({ namespace: 'foo' }, branchDeps);
        await branchFs.ready();

        expect(await branchFs.get()).toEqual({ a: 1, b: 2 });
    });

    test('does nothing when source log is empty / absent', async () => {
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 1,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        // No log was created on the target — nothing to inherit means we
        // don't write an empty stub either.
        expect(store._rawFor(TARGET).get('foo__floor_log')).toBeUndefined();
    });

    test('drops everything when branching at floor before any commit', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
            { floor: 2, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] },
        ]);

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        // Branch at floor 0 — new chat has only floor 0, all commits at floor>=1 die.
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 0,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        // No survivors → no log written to target (avoid storing an empty stub).
        expect(store._rawFor(TARGET).get('foo__floor_log')).toBeUndefined();
    });

    test('ignores malformed payloads', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
        ]);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        // Missing fields — handler must bail without touching the target sidecar.
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, undefined);
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, { mesId: 0 });
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, { sourceTarget: SOURCE, targetTarget: TARGET });
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: -1, sourceTarget: SOURCE, targetTarget: TARGET,
        });
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 1.5, sourceTarget: SOURCE, targetTarget: TARGET,
        });
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 0, sourceTarget: 'oops', targetTarget: TARGET,
        });

        expect(store._rawFor(TARGET).get('foo__floor_log')).toBeUndefined();
    });

    test('does not affect current-chat state during branching', async () => {
        // Sanity: emitting CHAT_BRANCH_CREATED must not touch the default-target
        // partition (i.e. the chat the user is currently on).
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
        ]);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();
        const beforeDefault = JSON.stringify([...store._raw.entries()]);

        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 1,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        // Default partition unchanged.
        expect(JSON.stringify([...store._raw.entries()])).toBe(beforeDefault);
        // Target partition has the inherited log.
        expect(store._rawFor(TARGET).get('foo__floor_log').commits).toHaveLength(1);
    });

    test('destroy detaches the CHAT_BRANCH_CREATED listener', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        seedSourceLog(store, [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
        ]);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        fs.destroy();
        await eventSource.emit(event_types.CHAT_BRANCH_CREATED, {
            mesId: 0,
            sourceTarget: SOURCE,
            targetTarget: TARGET,
        });

        expect(store._rawFor(TARGET).get('foo__floor_log')).toBeUndefined();
    });
});

describe('explicit floor tagging', () => {
    test('patch with { floor } pins the commit to a non-tail floor', async () => {
        // Three messages; tail is floor 2 with swipe 0. Plugin attaches
        // state to floor 1 (e.g. memory extension's lag pattern).
        const chatRef = { value: [msg(0), msg(2), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        const ok = await fs.patch(
            [{ op: 'add', path: '/x', value: 1 }],
            { floor: 1 },
        );
        expect(ok).toBe(true);

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        // swipeId picked up from chat[1].swipe_id (= 2), not the tail's swipe.
        expect(log.commits[0]).toMatchObject({ floor: 1, swipeId: 2 });
        expect(await fs.get()).toEqual({ x: 1 });
    });

    test('patch with { floor, swipeId } honors both', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await fs.patch(
            [{ op: 'add', path: '/x', value: 1 }],
            { floor: 0, swipeId: 5 },
        );

        const log = store._raw.get('foo__floor_log');
        expect(log.commits[0]).toMatchObject({ floor: 0, swipeId: 5 });
    });

    test('patch with no options keeps inferring from chat tail', async () => {
        const chatRef = { value: [msg(0), msg(2)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);

        const log = store._raw.get('foo__floor_log');
        // Tail = floor 1, swipe 2.
        expect(log.commits[0]).toMatchObject({ floor: 1, swipeId: 2 });
    });

    test('patch rejects out-of-range floor and writes nothing', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
            await fs.ready();

            const ok = await fs.patch(
                [{ op: 'add', path: '/x', value: 1 }],
                { floor: 5 },
            );
            expect(ok).toBe(false);
            expect(await fs.get()).toBeNull();
            expect(store._raw.get('foo__floor_log')).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('invalid floor/swipeId override'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('patch rejects negative floor', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
            await fs.ready();
            expect(await fs.patch([{ op: 'add', path: '/x', value: 1 }], { floor: -1 })).toBe(false);
            expect(store._raw.get('foo__floor_log')).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
    });

    test('patch rejects negative swipeId on a valid floor', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
            await fs.ready();
            expect(await fs.patch(
                [{ op: 'add', path: '/x', value: 1 }],
                { floor: 0, swipeId: -1 },
            )).toBe(false);
            expect(store._raw.get('foo__floor_log')).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
    });

    test('update forwards the override to the underlying patch', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await fs.update(
            (current) => ({ ...current, level: (current?.level ?? 0) + 1 }),
            { floor: 1 },
        );

        const log = store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        expect(log.commits[0]).toMatchObject({ floor: 1, swipeId: 0 });
        expect(await fs.get()).toEqual({ level: 1 });
    });

    test('explicit floor commit survives MESSAGE_DELETED that spares it', async () => {
        // Tag a commit on floor 0 while there are 3 floors; deleting tail
        // (length=1) keeps floor 0 → commit stays.
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await fs.patch([{ op: 'add', path: '/x', value: 1 }], { floor: 0 });
        chatRef.value = chatRef.value.slice(0, 1);
        await eventSource.emit(event_types.MESSAGE_DELETED, 1);
        await fs.ready();

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(1);
        expect(await fs.get()).toEqual({ x: 1 });
    });

    test('explicit floor commit dropped by MESSAGE_DELETED that removes its floor', async () => {
        const chatRef = { value: [msg(0), msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        await fs.patch([{ op: 'add', path: '/x', value: 1 }], { floor: 2 });
        chatRef.value = chatRef.value.slice(0, 2);
        await eventSource.emit(event_types.MESSAGE_DELETED, 2);
        await fs.ready();

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(0);
        expect(await fs.get()).toBeNull();
    });
});

describe('multi-instance isolation', () => {
    test('two instances on different namespaces do not interfere', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);

        const a = createFloorStateWithDeps({ namespace: 'plugin-a' }, deps);
        const b = createFloorStateWithDeps({ namespace: 'plugin-b' }, deps);

        await a.patch([{ op: 'add', path: '/foo', value: 'A' }]);
        await b.patch([{ op: 'add', path: '/foo', value: 'B' }]);

        expect(await a.get()).toEqual({ foo: 'A' });
        expect(await b.get()).toEqual({ foo: 'B' });
        expect(store._raw.get('plugin-a__floor_log').commits).toHaveLength(1);
        expect(store._raw.get('plugin-b__floor_log').commits).toHaveLength(1);

        // Swipe — both instances react independently.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await a.ready();
        await b.ready();

        expect(await a.get()).toEqual({});
        expect(await b.get()).toEqual({});
    });
});

describe('error tolerance', () => {
    test('patch returns false when commit log append fails (no state change)', async () => {
        // Single-write semantics: a failed log append leaves the entire system
        // untouched. No half-state to recover from. get() reflects the
        // pre-patch log.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                updateChatState: async (ns, updater, options) => {
                    if (ns === 'foo__floor_log') return { ok: false, state: null, updated: false };
                    return base.deps.updateChatState(ns, updater, options);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            const ok = await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
            expect(ok).toBe(false);
            expect(await fs.get()).toBeNull();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('appendCommit failed'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('handleMessageDeleted catches errors from readLog and still releases ready gate', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // Make the very first read fail; this short-circuits the handler.
            const deps = {
                ...base.deps,
                getChatState: async (ns) => {
                    if (ns === 'foo__floor_log') throw new Error('read boom');
                    return base.deps.getChatState(ns);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            await base.eventSource.emit(event_types.MESSAGE_DELETED, 0);
            // ready() must resolve even after the error path.
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('truncate failed'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('handleSwipeDeleted ignores malformed payloads without entering the gate', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, base.deps);

        // ready stays resolved before and after — the early bail returns immediately.
        await fs.ready();
        await base.eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, undefined);
        await base.eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: 'oops' });
        await base.eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: 0, swipeId: 'oops' });
        // No log entry was created.
        expect(base.store._raw.get('foo__floor_log')).toBeUndefined();
    });

    test('handleSwipeDeleted catches errors and releases ready gate', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                getChatState: async (ns) => {
                    if (ns === 'foo__floor_log') throw new Error('read boom');
                    return base.deps.getChatState(ns);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            await base.eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: 0, swipeId: 0 });
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('swipe-delete failed'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('writeLog returns false on store failure (covered indirectly via truncate)', async () => {
        const chatRef = { value: [msg(0), msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, base.deps);
            // Seed a commit so truncate has something to remove.
            await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
            chatRef.value.push(msg(0));
            await fs.patch([{ op: 'add', path: '/y', value: 2 }]);

            // Replace updateChatState to fail when writing the log during truncate.
            base.deps.updateChatState = async (ns, updater) => {
                if (ns === 'foo__floor_log') return { ok: false, state: null, updated: false };
                // fall through with a fresh closure capturing the original store
                const k = ns.toLowerCase();
                const current = base.store._raw.get(k) ?? null;
                const next = await updater(current == null ? null : structuredClone(current));
                if (next === null || next === undefined) base.store._raw.delete(k);
                else base.store._raw.set(k, structuredClone(next));
                return { ok: true, state: base.store._raw.get(k) ?? null, updated: true };
            };

            chatRef.value = chatRef.value.slice(0, 1);
            await base.eventSource.emit(event_types.MESSAGE_DELETED, 1);
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('writeLog failed'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('update bails when reducer is not a function', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.update(null)).toBe(false);
        expect(await fs.update('not a function')).toBe(false);
        expect(await fs.update(42)).toBe(false);
        expect(store._raw.size).toBe(0);
    });

    test('update propagates reducer exceptions to caller', async () => {
        const chatRef = { value: [msg(0)] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await expect(fs.update(() => { throw new Error('reducer boom'); }))
            .rejects.toThrow('reducer boom');
    });
});
