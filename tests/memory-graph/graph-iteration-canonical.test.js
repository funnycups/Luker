/**
 * Unit tests for graph-iteration/canonical.js — the deterministic keyed
 * document projection used as the ProposalBus target for graph mutations.
 */
import { describe, test, expect } from '@jest/globals';
import './_mocks/main-module-stack.js';

let canonicalFromStore;
let applyCanonicalToStore;
let docsEqual;
let docsTouchNodes;
let linkKey;

beforeAll(async () => {
    const mod = await import(
        '../../public/scripts/extensions/memory-graph/graph-iteration/canonical.js'
    );
    canonicalFromStore = mod.canonicalFromStore;
    applyCanonicalToStore = mod.applyCanonicalToStore;
    docsEqual = mod.docsEqual;
    docsTouchNodes = mod.docsTouchNodes;
    linkKey = mod.linkKey;
});

function makeStore() {
    return {
        nodes: {
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic', title: 'B',
                fields: { title: 'B' }, childrenIds: [], parentId: '', archived: false, seqTo: 2,
            },
            n_1: {
                id: 'n_1', type: 'event', level: 'semantic', title: 'Summary 1',
                fields: { summary: 's' }, childrenIds: [], parentId: '', archived: false, seqTo: 1,
                floorRange: { start: 1, end: 1 }, supersededBy: 'n_2',
            },
        },
        edges: [
            { from: 'n_1', to: 'n_2', type: 'related', seqTo: 1 },
            { from: 'n_2', to: 'n_1', type: 'related' },
        ],
        nodeSeq: 2,
        seqCounter: 2,
        appliedSeqTo: 2,
        loggedSeqTo: 2,
        vectorIndexState: { source: 'x', model: 'm', collectionId: 'c', nodeToHash: {}, hashToNodeId: {}, dirty: false, lastWarning: '' },
    };
}

describe('canonicalFromStore', () => {
    test('keys nodes by id in sorted order and links by the from/type/to triple', () => {
        const doc = canonicalFromStore(makeStore());
        expect(Object.keys(doc.nodes)).toEqual(['n_1', 'n_2']);
        expect(doc.links[linkKey('n_1', 'related', 'n_2')]).toEqual({ from: 'n_1', to: 'n_2', type: 'related' });
        expect(Object.keys(doc.links)).toHaveLength(2);
    });

    test('strips non-persisted node fields and edge seqTo', () => {
        const doc = canonicalFromStore(makeStore());
        expect(doc.nodes.n_1.floorRange).toBeUndefined();
        expect(doc.nodes.n_1.supersededBy).toBeUndefined();
        expect(doc.links[linkKey('n_1', 'related', 'n_2')].seqTo).toBeUndefined();
    });

    test('excludes counters and volatile fields from the document', () => {
        const serialized = JSON.stringify(canonicalFromStore(makeStore()));
        expect(serialized).not.toContain('nodeSeq');
        expect(serialized).not.toContain('seqCounter');
        expect(serialized).not.toContain('vectorIndexState');
        expect(serialized).not.toContain('lastRecallTrace');
    });
});

describe('applyCanonicalToStore', () => {
    test('round-trips to an equivalent document and re-derives counters', () => {
        const store = makeStore();
        const doc = canonicalFromStore(store);
        const next = applyCanonicalToStore(doc, store);
        expect(docsEqual(canonicalFromStore(next), doc)).toBe(true);
        expect(next.nodeSeq).toBeGreaterThanOrEqual(2);
        expect(next.seqCounter).toBeGreaterThanOrEqual(2);
    });

    test('preserves live volatile fields while replacing nodes/links', () => {
        const store = makeStore();
        const doc = canonicalFromStore(store);
        doc.nodes.n_1.fields.extra = 'added';
        const next = applyCanonicalToStore(doc, store);
        expect(next.vectorIndexState).toEqual(store.vectorIndexState);
        expect(next.nodes.n_1.fields.extra).toBe('added');
        expect(Object.keys(next.nodes)).toHaveLength(2);
    });
});

describe('docsEqual / docsTouchNodes', () => {
    test('docsEqual is true for the same content and false for a field change', () => {
        const a = canonicalFromStore(makeStore());
        const b = canonicalFromStore(makeStore());
        expect(docsEqual(a, b)).toBe(true);
        b.nodes.n_1.title = 'changed';
        expect(docsEqual(a, b)).toBe(false);
    });

    test('docsTouchNodes ignores edge-only changes', () => {
        const a = canonicalFromStore(makeStore());
        const b = JSON.parse(JSON.stringify(a));
        b.links[linkKey('n_1', 'guards', 'n_2')] = { from: 'n_1', to: 'n_2', type: 'guards' };
        expect(docsTouchNodes(a, b)).toBe(false);
        b.nodes.n_1.title = 'changed';
        expect(docsTouchNodes(a, b)).toBe(true);
    });
});
