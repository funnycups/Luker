import { describe, test, expect } from '@jest/globals';
import { addEdge, removeEdge } from '../../public/scripts/extensions/memory-graph/graph-ops.js';

function makeStore() {
    return { nodes: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }, edges: [] };
}

describe('removeEdge', () => {
    test('removes the exact (from, to, type) edge with default direction=bidirectional', () => {
        const store = makeStore();
        addEdge(store, 'a', 'b', 'partner_of');
        addEdge(store, 'b', 'a', 'partner_of');
        addEdge(store, 'a', 'b', 'deceiving');
        removeEdge(store, 'a', 'b', 'partner_of');
        expect(store.edges).toEqual([{ from: 'a', to: 'b', type: 'deceiving' }]);
    });

    test('direction outgoing removes only from→to with matching type', () => {
        const store = makeStore();
        addEdge(store, 'a', 'b', 'mentor_of');
        addEdge(store, 'b', 'a', 'mentor_of');
        removeEdge(store, 'a', 'b', 'mentor_of', { direction: 'outgoing' });
        expect(store.edges).toEqual([{ from: 'b', to: 'a', type: 'mentor_of' }]);
    });

    test('no-op when edge does not exist', () => {
        const store = makeStore();
        addEdge(store, 'a', 'b', 'related');
        removeEdge(store, 'a', 'c', 'related');
        expect(store.edges).toHaveLength(1);
    });

    test('returns the count of edges removed', () => {
        const store = makeStore();
        addEdge(store, 'a', 'b', 'partner_of');
        addEdge(store, 'b', 'a', 'partner_of');
        const removed = removeEdge(store, 'a', 'b', 'partner_of');
        expect(removed).toBe(2);
    });
});
