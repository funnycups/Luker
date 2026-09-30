/**
 * Unit tests for graph-iteration/session-store.js.
 *
 * Pins the cross-reload pending recovery: `bus.serialize()` strips
 * `_pendingAfter`, so a hydrated session used to fail every approve with
 * "Invalid JSON Patch replace path". The store persists the tail
 * after-state and rebuilds each entry's `_pendingAfter` by replaying the
 * inverse patches backwards.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { createBus } from '../../public/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget } from '../../public/scripts/iteration-library/storage/target-registry.js';

let MG_GRAPH_ITER_NAMESPACE;
let makeMessageId;
let normalizeMessageShape;
let restorePendingChain;
let createMgGraphSessionStore;

beforeAll(async () => {
    const mod = await import(
        '../../public/scripts/extensions/memory-graph/graph-iteration/session-store.js'
    );
    MG_GRAPH_ITER_NAMESPACE = mod.MG_GRAPH_ITER_NAMESPACE;
    makeMessageId = mod.makeMessageId;
    normalizeMessageShape = mod.normalizeMessageShape;
    restorePendingChain = mod.restorePendingChain;
    createMgGraphSessionStore = mod.createMgGraphSessionStore;
});

function makeChatStateContext({ readFailure = null, writeFailure = null } = {}) {
    const buckets = new Map();
    return {
        buckets,
        async getChatState(ns, opts = {}) {
            if (readFailure) return { ok: false, ...readFailure };
            const key = `${ns}|${JSON.stringify(opts.target || null)}`;
            return { ok: true, state: buckets.has(key) ? buckets.get(key) : null };
        },
        async updateChatState(ns, updater, opts = {}) {
            if (writeFailure) return { ok: false, ...writeFailure };
            const key = `${ns}|${JSON.stringify(opts.target || null)}`;
            const next = updater(buckets.get(key) ?? null);
            buckets.set(key, next);
            return { ok: true, state: next };
        },
    };
}

describe('createMgGraphSessionStore', () => {
    test('saves/loads/lists/deletes sessions in the per-chat namespace', async () => {
        const context = makeChatStateContext();
        const store = createMgGraphSessionStore({ context, getTarget: () => ({ is_group: false, avatar_url: 'a.png', file_name: 'chat1' }) });
        expect(MG_GRAPH_ITER_NAMESPACE).toBe('memory_graph__graph_iter');

        await store.save({ id: 's1', title: 'first', updatedAt: 2, messages: [{ id: makeMessageId(), role: 'user', content: 'hi', at: 1 }] });
        await store.save({ id: 's2', title: 'second', updatedAt: 5, messages: [] });

        expect(await store.getCurrentSessionId()).toBe('s2');
        expect((await store.list()).map((m) => m.id)).toEqual(['s2', 's1']);

        const loaded = await store.load('s1');
        expect(loaded.title).toBe('first');
        loaded.title = 'mutated';
        expect((await store.load('s1')).title).toBe('first');

        await store.delete('s2');
        expect((await store.list()).map((m) => m.id)).toEqual(['s1']);
        expect(await store.getCurrentSessionId()).toBe('');
    });

    test('load returns null for unknown ids', async () => {
        const context = makeChatStateContext();
        const store = createMgGraphSessionStore({ context, getTarget: () => null });
        expect(await store.load('ghost')).toBeNull();
    });

    test('read failures degrade to an empty bucket instead of throwing', async () => {
        const context = makeChatStateContext({ readFailure: { reason: 'HTTP_ERROR', hint: 'read down' } });
        const store = createMgGraphSessionStore({ context, getTarget: () => null });
        expect(await store.list()).toEqual([]);
        expect(await store.getCurrentSessionId()).toBe('');
        expect(await store.load('s1')).toBeNull();
    });

    test('save rejects when the chat-state write fails, carrying the reason', async () => {
        const context = makeChatStateContext({ writeFailure: { reason: 'HTTP_ERROR', hint: 'x' } });
        const store = createMgGraphSessionStore({ context, getTarget: () => null });
        await expect(store.save({ id: 's1', title: 'first', updatedAt: 1, messages: [] }))
            .rejects.toThrow(/session save failed: HTTP_ERROR/);
    });

    test('delete rejects when the chat-state write fails, carrying the reason', async () => {
        const context = makeChatStateContext({ writeFailure: { reason: 'HTTP_ERROR', hint: 'x' } });
        const store = createMgGraphSessionStore({ context, getTarget: () => null });
        await expect(store.delete('s1')).rejects.toThrow(/session delete failed: HTTP_ERROR/);
    });
});

describe('normalizeMessageShape', () => {
    test('keeps protocol fields needed for tool replay', () => {
        const shape = normalizeMessageShape({
            role: 'assistant', content: 'x', at: 3,
            toolCalls: [{ id: 'c1', name: 'mg_graph_list_nodes', args: {} }],
            toolResults: [{ tool_call_id: 'c1', content: { ok: true }, status: 'ok' }],
            reasoning: 'r',
        });
        expect(shape.toolCalls).toHaveLength(1);
        expect(shape.toolResults).toHaveLength(1);
        expect(shape.reasoning).toBe('r');
        expect(shape.id).toBeTruthy();
    });
});

describe('restorePendingChain', () => {
    function makeTestBus() {
        const state = { live: { v: 0 } };
        registerTarget('mg-graph-it-test-target', {
            read: async () => state.live,
            write: async (_target, next) => { state.live = next; },
            describe: () => 'test-target',
        });
        const bus = createBus({});
        bus.registerKind('mg-graph-it-test-kind', { kind: 'mg-graph-it-test-kind', targetType: 'mg-graph-it-test-target' });
        return { bus, state, target: { type: 'mg-graph-it-test-target', name: 'chat' } };
    }

    test('rebuilds the chain so a rehydrated bus can approve every entry', async () => {
        const { bus, state, target } = makeTestBus();
        await bus.propose({ kind: 'mg-graph-it-test-kind', target, before: { v: 0 }, after: { v: 1 }, sourceCallId: 'c1' });
        await bus.propose({ kind: 'mg-graph-it-test-kind', target, before: { v: 1 }, after: { v: 2 }, sourceCallId: 'c2' });

        const serialized = bus.serialize();
        expect(serialized.entries[0]._pendingAfter).toBeUndefined();
        const tailAfter = await bus.getCurrentPendingState('mg-graph-it-test-kind', target);
        expect(tailAfter).toEqual({ v: 2 });

        const restored = restorePendingChain(serialized.entries, tailAfter);
        expect(restored.ok).toBe(true);
        const bus2 = createBus({});
        bus2.registerKind('mg-graph-it-test-kind', { kind: 'mg-graph-it-test-kind', targetType: 'mg-graph-it-test-target' });
        bus2.hydrate({ version: 3, entries: restored.entries, outcomeQueue: [] });
        expect(await bus2.getCurrentPendingState('mg-graph-it-test-kind', target)).toEqual({ v: 2 });

        const first = await bus2.approve(restored.entries[0].id);
        expect(first).toMatchObject({ ok: true, status: 'committed' });
        expect(state.live).toEqual({ v: 1 });
        const second = await bus2.approve(restored.entries[1].id);
        expect(second).toMatchObject({ ok: true, status: 'committed' });
        expect(state.live).toEqual({ v: 2 });
    });

    test('the regression it fixes: hydrating raw serialized entries cannot approve', async () => {
        const { bus, target } = makeTestBus();
        await bus.propose({ kind: 'mg-graph-it-test-kind', target, before: { v: 0 }, after: { v: 1 }, sourceCallId: 'c1' });
        const serialized = bus.serialize();
        const bus2 = createBus({});
        bus2.registerKind('mg-graph-it-test-kind', { kind: 'mg-graph-it-test-kind', targetType: 'mg-graph-it-test-target' });
        bus2.hydrate(serialized);
        const res = await bus2.approve(serialized.entries[0].id);
        expect(res.status).toBe('conflict');
    });

    test('missing tail snapshot parks the chain as conflict instead of failing later', async () => {
        const { bus, target } = makeTestBus();
        await bus.propose({ kind: 'mg-graph-it-test-kind', target, before: { v: 0 }, after: { v: 1 }, sourceCallId: 'c1' });
        const serialized = bus.serialize();
        const restored = restorePendingChain(serialized.entries, null);
        expect(restored.ok).toBe(false);
        expect(restored.entries[0].status).toBe('conflict');
        expect(restored.entries[0].conflictError.reason).toBe('CONFLICT');
    });
});
