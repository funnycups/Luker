import { describe, test, expect } from '@jest/globals';
import { addEdge } from '../../public/scripts/extensions/memory-graph/graph-ops.js';

describe('addEdge with seqTo option', () => {
    test('stores seqTo when provided', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'partner_of', { seqTo: 42 });
        expect(store.edges).toEqual([{ from: 'a', to: 'b', type: 'partner_of', seqTo: 42 }]);
    });

    test('omits seqTo when not provided (back-compat)', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'related');
        expect(store.edges).toEqual([{ from: 'a', to: 'b', type: 'related' }]);
    });

    test('does not overwrite existing edge seqTo on re-add (idempotent)', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'partner_of', { seqTo: 5 });
        addEdge(store, 'a', 'b', 'partner_of', { seqTo: 999 });
        expect(store.edges).toEqual([{ from: 'a', to: 'b', type: 'partner_of', seqTo: 5 }]);
    });
});
