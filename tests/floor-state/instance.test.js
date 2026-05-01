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
    const data = new Map();
    return {
        async getChatState(ns) {
            const k = String(ns ?? '').trim().toLowerCase();
            const v = data.get(k);
            return v == null ? null : structuredClone(v);
        },
        async patchChatState(ns, ops) {
            const k = String(ns ?? '').trim().toLowerCase();
            const current = data.get(k) ?? {};
            const { applyPatch } = await import('../../public/scripts/util/fast-json-patch.js');
            const next = structuredClone(current);
            applyPatch(next, ops, false, true);
            data.set(k, next);
            return true;
        },
        async updateChatState(ns, updater) {
            const k = String(ns ?? '').trim().toLowerCase();
            const current = data.get(k) ?? null;
            const next = await updater(current == null ? null : structuredClone(current));
            if (next === null || next === undefined) {
                data.delete(k);
            } else {
                data.set(k, structuredClone(next));
            }
            return { ok: true, state: data.get(k) ?? null, updated: true };
        },
        _raw: data,
    };
}

function makeEventSource() {
    const listeners = new Map();
    return {
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeListener(name, fn) {
            listeners.get(name)?.delete(fn);
        },
        async emit(name, ...args) {
            const set = listeners.get(name);
            if (!set) return;
            for (const fn of Array.from(set)) {
                await fn(...args);
            }
        },
    };
}

const event_types = {
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
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

    test('patch writes to data namespace and appends a commit', async () => {
        const chatRef = { value: [msg(0)] }; // one floor
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const ok = await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(ok).toBe(true);

        expect(store._raw.get('foo')).toEqual({ x: 1 });

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
        expect(store._raw.get('foo')).toEqual({ a: 1, b: { c: 2 } });

        await fs.update((current) => ({ ...current, b: { c: 99 } }));
        expect(store._raw.get('foo')).toEqual({ a: 1, b: { c: 99 } });

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(2);
    });

    test('update ignores reducer returning non-object', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        expect(await fs.update(() => null)).toBe(true);
        expect(await fs.update(() => 'string')).toBe(true);
        expect(await fs.update(() => [1, 2, 3])).toBe(true);
        expect(store._raw.get('foo')).toBeUndefined();
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
    test('CHAT_CHANGED rematerializes from log against current chat', async () => {
        // Build log under chat A, then switch chat to a fresh array and emit.
        const chatRef = { value: [msg(0), msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(store._raw.get('foo')).toEqual({ x: 1 });

        // Simulate switching to a different chat by replacing the array
        // and the underlying log+data being whatever they were.
        // For chat B, pretend log is empty (fresh chat).
        store._raw.delete('foo__floor_log');
        chatRef.value = [msg(0)]; // chat B has just one floor

        await eventSource.emit(event_types.CHAT_CHANGED);
        await fs.ready();

        // Empty log → data namespace must be reset to {}.
        expect(store._raw.get('foo')).toEqual({});
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
        expect(store._raw.get('foo')).toEqual({ a: 1 });
    });

    test('MESSAGE_DELETED to length 0 clears data namespace to {}', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        expect(store._raw.get('foo')).toEqual({ x: 1 });

        chatRef.value = [];
        await eventSource.emit(event_types.MESSAGE_DELETED, 0);
        await fs.ready();

        expect(store._raw.get('foo__floor_log').commits).toHaveLength(0);
        expect(store._raw.get('foo')).toEqual({});
    });

    test('MESSAGE_SWIPED switches data namespace to active swipe state', async () => {
        // Floor 0 with swipe 0; record a commit on swipe 0.
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/from0', value: true }]);

        // User swipes to swipe 1 and the AI generates new content there.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();

        // Swipe-1 has no commits yet; rematerialized state must be empty.
        expect(store._raw.get('foo')).toEqual({});

        // Plugin writes a different commit on swipe 1.
        await fs.patch([{ op: 'add', path: '/from1', value: true }]);
        expect(store._raw.get('foo')).toEqual({ from1: true });

        // User swipes back to 0.
        chatRef.value[0].swipe_id = 0;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        expect(store._raw.get('foo')).toEqual({ from0: true });

        // And again to 1.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await fs.ready();
        expect(store._raw.get('foo')).toEqual({ from1: true });
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
        expect(store._raw.get('foo')).toEqual({ s2: 2 });
    });
});

describe('ready gate', () => {
    test('ready resolves immediately when nothing is in flight', async () => {
        const chatRef = { value: [] };
        const { deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await expect(fs.ready()).resolves.toBeUndefined();
    });

    test('ready blocks while a rematerialize is running, then resolves', async () => {
        const chatRef = { value: [msg(0)] };
        const baseDeps = makeDeps(chatRef);
        // Wrap updateChatState to add a small delay so we can observe pending state.
        let resolveBlock;
        const blocker = new Promise((r) => { resolveBlock = r; });
        const slowUpdate = async (ns, updater) => {
            // Only block writes to the data namespace (rematerialize).
            if (ns === 'foo') await blocker;
            return baseDeps.deps.updateChatState(ns, updater);
        };
        const deps = { ...baseDeps.deps, updateChatState: slowUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        const emitPromise = baseDeps.eventSource.emit(event_types.CHAT_CHANGED);
        await flush();
        // Now rematerialize is mid-flight. ready() should pend.
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
    test('destroy detaches event listeners', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, eventSource, deps } = makeDeps(chatRef);
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

        await fs.patch([{ op: 'add', path: '/x', value: 1 }]);

        fs.destroy();
        // After destroy, emitting events must not write anything.
        const beforeFoo = store._raw.get('foo');
        const beforeLog = store._raw.get('foo__floor_log');

        chatRef.value = [];
        await eventSource.emit(event_types.MESSAGE_DELETED, 0);
        await flush();

        // No further writes happened.
        expect(store._raw.get('foo')).toEqual(beforeFoo);
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
});

describe('initial rematerialize', () => {
    test('replays existing log so data namespace reflects log on creation', async () => {
        // Pre-seed the log as if from a prior session; data namespace empty.
        // After construction + ready(), data must reflect the log replay.
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

        expect(store._raw.get('foo')).toEqual({ a: 1, b: 2 });
    });

    test('respects current swipe map when replaying on creation', async () => {
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

        expect(store._raw.get('foo')).toEqual({ from1: true });
    });

    test('skips initial write when log namespace is absent', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(store._raw.get('foo')).toBeUndefined();
        expect(store._raw.get('foo__floor_log')).toBeUndefined();
    });

    test('skips initial write when log exists but has no commits', async () => {
        const chatRef = { value: [msg(0)] };
        const { store, deps } = makeDeps(chatRef);
        store._raw.set('foo__floor_log', { version: 1, commits: [] });

        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        expect(store._raw.get('foo')).toBeUndefined();
    });

    test('init failure is swallowed and instance stays usable', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        // Pre-seed a log so init actually attempts to replay.
        base.store._raw.set('foo__floor_log', {
            version: 1,
            commits: [{ floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] }],
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                updateChatState: async (ns, updater) => {
                    if (ns === 'foo') throw new Error('init boom');
                    return base.deps.updateChatState(ns, updater);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('initial rematerialize failed'),
                expect.anything(),
            );
            // Instance is still alive — patch / get keep working.
            expect(typeof fs.patch).toBe('function');
        } finally {
            warn.mockRestore();
        }
    });
});

describe('concurrency: patch vs rematerialize', () => {
    test('patch + concurrent CHAT_CHANGED leaves data in sync with log', async () => {
        // Stall the appendCommit write so a concurrent CHAT_CHANGED rematerialize
        // races with it. Whichever ordering wins, the final state must match
        // computeTargetState(log) — i.e. the new commit must be reflected in
        // the data namespace.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        await base.deps.updateChatState; // touch to keep referenced

        let releaseAppend;
        let appendIntercepted = false;
        const block = new Promise((r) => { releaseAppend = r; });
        const slowUpdate = async (ns, updater) => {
            if (ns === 'foo__floor_log' && !appendIntercepted) {
                appendIntercepted = true;
                await block;
            }
            return base.deps.updateChatState(ns, updater);
        };
        const deps = { ...base.deps, updateChatState: slowUpdate };
        const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);
        await fs.ready();

        const patchPromise = fs.patch([{ op: 'add', path: '/x', value: 1 }]);
        await flush();
        // CHAT_CHANGED races: handler reads the log before or after the commit lands.
        const emitPromise = base.eventSource.emit(event_types.CHAT_CHANGED);
        await flush();

        releaseAppend();
        await Promise.all([patchPromise, emitPromise]);
        await fs.ready();

        const log = base.store._raw.get('foo__floor_log');
        expect(log.commits).toHaveLength(1);
        expect(base.store._raw.get('foo')).toEqual({ x: 1 });
    });

    test('ready() waits for both an in-flight patch and a concurrent event', async () => {
        // Counted ready gate: the gate must stay pending until BOTH the patch
        // and the concurrent rematerialize end, not just whichever finishes first.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);

        let releaseAppend;
        let appendIntercepted = false;
        const block = new Promise((r) => { releaseAppend = r; });
        const slowUpdate = async (ns, updater) => {
            if (ns === 'foo__floor_log' && !appendIntercepted) {
                appendIntercepted = true;
                await block;
            }
            return base.deps.updateChatState(ns, updater);
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
        // Both patch and the handler are still in flight — gate must be pending.
        expect(readyResolved).toBe(false);

        releaseAppend();
        await Promise.all([patchPromise, emitPromise, readyPromise]);
        expect(readyResolved).toBe(true);
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

        expect(store._raw.get('plugin-a')).toEqual({ foo: 'A' });
        expect(store._raw.get('plugin-b')).toEqual({ foo: 'B' });
        expect(store._raw.get('plugin-a__floor_log').commits).toHaveLength(1);
        expect(store._raw.get('plugin-b__floor_log').commits).toHaveLength(1);

        // Swipe — both instances react independently.
        chatRef.value[0].swipe_id = 1;
        await eventSource.emit(event_types.MESSAGE_SWIPED, 0);
        await a.ready();
        await b.ready();

        expect(store._raw.get('plugin-a')).toEqual({});
        expect(store._raw.get('plugin-b')).toEqual({});
    });
});

describe('error tolerance', () => {
    test('patch reconciles via rematerialize when patchChatState fails', async () => {
        // Commit-first order: appendCommit lands successfully, then the
        // data-namespace write fails. patch recovers by replaying the log
        // (which now includes the new commit) so the data namespace catches up.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                patchChatState: async () => false,
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            const ok = await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
            expect(ok).toBe(true);
            expect(base.store._raw.get('foo__floor_log').commits).toHaveLength(1);
            expect(base.store._raw.get('foo')).toEqual({ x: 1 });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('reconciling from log'),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('patch returns false when commit log append fails (no data write)', async () => {
        // Commit-first order means a failed appendCommit short-circuits patch
        // before any data-namespace write — neither side observes the operation.
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                updateChatState: async (ns, updater) => {
                    if (ns === 'foo__floor_log') return { ok: false, state: null, updated: false };
                    return base.deps.updateChatState(ns, updater);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            const ok = await fs.patch([{ op: 'add', path: '/x', value: 1 }]);
            expect(ok).toBe(false);
            expect(base.store._raw.get('foo')).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('appendCommit failed'),
                expect.anything(),
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('rematerialize swallows store errors and warns', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // Throw when writing the data namespace during rematerialize.
            const deps = {
                ...base.deps,
                updateChatState: async (ns, updater) => {
                    if (ns === 'foo') throw new Error('boom');
                    return base.deps.updateChatState(ns, updater);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            // Trigger CHAT_CHANGED so rematerialize runs and hits the throw.
            await base.eventSource.emit(event_types.CHAT_CHANGED);
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('rematerialize failed'),
                expect.anything(),
            );
            // The instance survived and stays usable.
            expect(typeof fs.patch).toBe('function');
        } finally {
            warn.mockRestore();
        }
    });

    test('rematerialize warns when updateChatState reports ok=false', async () => {
        const chatRef = { value: [msg(0)] };
        const base = makeDeps(chatRef);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const deps = {
                ...base.deps,
                updateChatState: async (ns, updater) => {
                    if (ns === 'foo') return { ok: false, state: null, updated: false };
                    return base.deps.updateChatState(ns, updater);
                },
            };
            const fs = createFloorStateWithDeps({ namespace: 'foo' }, deps);

            await base.eventSource.emit(event_types.CHAT_CHANGED);
            await fs.ready();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('rematerialize write failed'),
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
