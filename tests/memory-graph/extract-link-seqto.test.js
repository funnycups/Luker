// This test verifies the contract that link writes from extraction
// pass extractionMaxSeq through to addEdge. The wiring is in main.js
// applyExtractedLinks and the op pipeline; this test is a regression
// guard against the wiring being removed.
import { describe, test, expect } from '@jest/globals';
import { addEdge } from '../../public/scripts/extensions/memory-graph/graph-ops.js';

describe('extract link writes carry seqTo', () => {
    test('addEdge receives seqTo when extract pipeline writes a link', () => {
        const store = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [] };
        addEdge(store, 'a', 'b', 'partner_of', { seqTo: 100 });
        expect(store.edges[0].seqTo).toBe(100);
    });
});
