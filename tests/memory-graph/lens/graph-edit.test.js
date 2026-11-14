import './_mocks/luker-zh.js';
import { test, expect, describe } from '@jest/globals';
import { createMutator, patchNode, addExactEdge, removeExactEdge, replaceExactEdge } from '../../../public/scripts/extensions/memory-graph/lens/edit/graph-edit.js';
import { dropNode } from '../../../public/scripts/extensions/memory-graph/graph-ops.js';
import { storedEdgesOf } from '../../../public/scripts/extensions/memory-graph/lens/edit/node-forms.js';

const makeStore = () => ({
    nodes: {
        a: { id: 'a', type: 'thread', title: 'A', fields: { state: 'x' }, parentId: '', childrenIds: ['b'], archived: false, level: 'semantic' },
        b: { id: 'b', type: 'thread', title: 'B', fields: {}, parentId: 'a', childrenIds: ['c'], archived: true, level: 'semantic' },
        c: { id: 'c', type: 'event', title: 'C', fields: {}, parentId: 'b', childrenIds: [], archived: false, level: 'semantic' },
        d: { id: 'd', type: 'thread', title: 'D', fields: {}, parentId: '', childrenIds: [], archived: false, level: 'semantic' },
    },
    edges: [
        { from: 'a', to: 'd', type: 'related' },
        { from: 'd', to: 'a', type: 'related' },
    ],
});

function harness(initial = makeStore()) {
    const state = { live: initial, commits: 0 };
    const mutator = createMutator({
        getLive: async () => state.live,
        commit: async (_before, after) => { state.commits += 1; state.live = after; },
    });
    return { state, mutator };
}

describe('mutate and undo', () => {
    test('one edit commits once and undo restores the previous graph', async () => {
        const { state, mutator } = harness();
        const original = structuredClone(state.live);
        const snapshot = await mutator.mutate(working => dropNode(working, 'b', true));
        expect(state.commits).toBe(1);
        expect(state.live.nodes.b).toBeUndefined();
        expect(state.live.nodes.c).toBeUndefined();
        await mutator.restore(snapshot);
        expect(state.commits).toBe(2);
        expect(state.live).toEqual(original);
    });

    test('a failed edit commits nothing and leaves the live store alone', async () => {
        const { state, mutator } = harness();
        const original = structuredClone(state.live);
        await expect(mutator.mutate(working => { working.nodes.a.title = 'changed'; throw new Error('nope'); })).rejects.toThrow('nope');
        expect(state.commits).toBe(0);
        expect(state.live).toEqual(original);
    });

    test('undo is refused after something else changed the graph', async () => {
        const { state, mutator } = harness();
        const snapshot = await mutator.mutate(working => patchNode(working, 'a', { title: 'New' }));
        state.live.nodes.a.title = 'Extraction wrote this';
        await expect(mutator.restore(snapshot)).rejects.toThrow(/无法撤销/);
        expect(state.live.nodes.a.title).toBe('Extraction wrote this');
    });

    test('undo ignores property order and preserves newer recall metadata', async () => {
        const { state, mutator } = harness();
        const snapshot = await mutator.mutate(working => patchNode(working, 'a', { title: 'Changed' }));
        state.live.nodes.a = Object.fromEntries(Object.entries(state.live.nodes.a).reverse());
        state.live.lastRecallProjection = { at: 42 };
        await mutator.restore(snapshot);
        expect(state.live.nodes.a.title).toBe('A');
        expect(state.live.lastRecallProjection).toEqual({ at: 42 });
    });

    test('no-chat surfaces as an error', async () => {
        const mutator = createMutator({ getLive: async () => null, commit: async () => {} });
        await expect(mutator.mutate(() => {})).rejects.toMatchObject({ code: 'no-chat' });
    });
});

describe('patchNode', () => {
    test('edits archived nodes and clears empty fields', () => {
        const store = makeStore();
        patchNode(store, 'b', { fields: { state: 'new' }, title: ' B2 ', archived: false, seqTo: 7, type: 'event', level: 'semantic' });
        expect(store.nodes.b).toMatchObject({ title: 'B2', archived: false, seqTo: 7, type: 'event', fields: { state: 'new' } });
        patchNode(store, 'a', { fields: { state: '' } });
        expect(store.nodes.a.fields.state).toBeUndefined();
    });

    test('moves a node to a new parent', () => {
        const store = makeStore();
        patchNode(store, 'b', { parentId: 'd' });
        expect(store.nodes.b.parentId).toBe('d');
        expect(store.nodes.a.childrenIds).not.toContain('b');
        expect(store.nodes.d.childrenIds).toContain('b');
    });

    test('clearing the parent detaches the node', () => {
        const store = makeStore();
        patchNode(store, 'b', { parentId: '' });
        expect(store.nodes.b.parentId).toBe('');
        expect(store.nodes.a.childrenIds).toEqual([]);
    });

    test('refuses a parent that would create a loop', () => {
        const store = makeStore();
        expect(() => patchNode(store, 'a', { parentId: 'c' })).toThrow(/循环/);
        expect(() => patchNode(store, 'a', { parentId: 'a' })).toThrow(/循环/);
        expect(store.nodes.a.parentId).toBe('');
    });

    test('refuses a missing parent', () => {
        expect(() => patchNode(makeStore(), 'a', { parentId: 'zzz' })).toThrow(/不存在/);
    });
});

describe('edges', () => {
    test('removing one direction keeps the reverse edge', () => {
        const store = makeStore();
        removeExactEdge(store, { from: 'a', to: 'd', type: 'related' });
        expect(store.edges).toEqual([{ from: 'd', to: 'a', type: 'related' }]);
    });

    test('removing a missing edge fails', () => {
        expect(() => removeExactEdge(makeStore(), { from: 'a', to: 'b', type: 'related' })).toThrow(/找不到/);
    });

    test('add rejects duplicates, self links and unknown nodes', () => {
        const store = makeStore();
        addExactEdge(store, { from: 'a', to: 'b', type: 'mentions' });
        expect(store.edges).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
        expect(() => addExactEdge(store, { from: 'a', to: 'b', type: 'mentions' })).toThrow(/已存在/);
        expect(() => addExactEdge(store, { from: 'a', to: 'a', type: 'mentions' })).toThrow();
        expect(() => addExactEdge(store, { from: 'a', to: 'x', type: 'mentions' })).toThrow();
    });

    test('replace changes only the chosen edge and keeps its seq', () => {
        const store = makeStore();
        store.edges[0].seqTo = 4;
        replaceExactEdge(store, { from: 'a', to: 'd', type: 'related' }, { from: 'a', to: 'b', type: 'updates' });
        expect(store.edges).toEqual([{ from: 'a', to: 'b', type: 'updates', seqTo: 4 }, { from: 'd', to: 'a', type: 'related' }]);
    });

    test('replace refuses to collide with another edge', () => {
        const store = makeStore();
        expect(() => replaceExactEdge(store, { from: 'a', to: 'd', type: 'related' }, { from: 'd', to: 'a', type: 'related' })).toThrow(/已存在/);
    });

    test('a mirrored pair lists both stored edges', () => {
        const edge = { from: 'a', to: 'd', type: 'related', mirrored: true };
        const model = { adjacency: new Map([['a', [edge]]]) };
        expect(storedEdgesOf(model, 'a')).toEqual([{ from: 'a', to: 'd', type: 'related' }, { from: 'd', to: 'a', type: 'related' }]);
    });
});
