import { describe, test, expect } from '@jest/globals';
import { addEdge, removeEdge } from '../../public/scripts/extensions/memory-graph/graph-ops.js';

describe('link_delete op semantics via removeEdge', () => {
    test('bidirectional delete removes both directions', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'partner_of');
        addEdge(store, 'b', 'a', 'partner_of');
        const removed = removeEdge(store, 'a', 'b', 'partner_of');
        expect(removed).toBe(2);
        expect(store.edges).toEqual([]);
    });

    test('directed delete preserves opposite direction', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'mentor_of');
        addEdge(store, 'b', 'a', 'mentor_of');
        removeEdge(store, 'a', 'b', 'mentor_of', { direction: 'outgoing' });
        expect(store.edges).toEqual([{ from: 'b', to: 'a', type: 'mentor_of' }]);
    });
});
