/**
 * Tests for memory-graph external-api.
 *
 * Covers the read-only query surface exposed to other extensions
 * (orchestrator loop mode and similar): currently injected node id sets,
 * lexical search, recent-node browsing, and node-by-id with neighbors.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    getCurrentlyInjectedNodeIds,
    __recordInjectedNodeIds,
    __setInjectedForTest,
    __resetInjectedForTest,
    searchNodesLexical,
    listRecentNodes,
    getNodeById,
} from '../../public/scripts/extensions/memory-graph/external-api.js';

describe('getCurrentlyInjectedNodeIds', () => {
    beforeEach(() => {
        __resetInjectedForTest();
    });

    test('returns empty sets when no injection has happened', () => {
        const result = getCurrentlyInjectedNodeIds({});
        expect(result.alwaysInjectIds).toBeInstanceOf(Set);
        expect(result.recallSelectedIds).toBeInstanceOf(Set);
        expect(result.alwaysInjectIds.size).toBe(0);
        expect(result.recallSelectedIds.size).toBe(0);
    });

    test('returns the recorded alwaysInject and recall sets', () => {
        __setInjectedForTest({
            alwaysInjectIds: new Set(['a1', 'a2']),
            recallSelectedIds: new Set(['r1']),
        });
        const result = getCurrentlyInjectedNodeIds({});
        expect(Array.from(result.alwaysInjectIds).sort()).toEqual(['a1', 'a2']);
        expect(Array.from(result.recallSelectedIds)).toEqual(['r1']);
    });

    test('returned sets are defensive copies (mutating result does not change state)', () => {
        __setInjectedForTest({
            alwaysInjectIds: new Set(['a1']),
            recallSelectedIds: new Set(['r1']),
        });
        const r1 = getCurrentlyInjectedNodeIds({});
        r1.alwaysInjectIds.add('mutated');
        r1.recallSelectedIds.add('mutated');
        const r2 = getCurrentlyInjectedNodeIds({});
        expect(r2.alwaysInjectIds.has('mutated')).toBe(false);
        expect(r2.recallSelectedIds.has('mutated')).toBe(false);
    });

    test('__recordInjectedNodeIds accepts iterables and missing fields', () => {
        __recordInjectedNodeIds({ alwaysInjectIds: ['a1', 'a2'], recallSelectedIds: ['r1'] });
        const r = getCurrentlyInjectedNodeIds({});
        expect(Array.from(r.alwaysInjectIds).sort()).toEqual(['a1', 'a2']);

        __recordInjectedNodeIds({}); // both missing -> empty sets
        const r2 = getCurrentlyInjectedNodeIds({});
        expect(r2.alwaysInjectIds.size).toBe(0);
        expect(r2.recallSelectedIds.size).toBe(0);
    });
});

// Test fixture using the same node shape memory-graph stores: title +
// fields.{title,name,summary,state,...}, plus seqTo for timeline ordering and
// archived for soft-delete filtering. `store.nodes` is a plain object map
// keyed by id (matching the v8-oplog migration shape that memory-graph uses
// in production).
function makeFakeStore({ nodes = {}, edges = [] } = {}) {
    return { nodes, edges };
}

function makeNode({ id, title = '', fields = {}, seqTo, archived = false, type = 'semantic' }) {
    return { id, title, fields, seqTo, archived, type, level: 'semantic' };
}

describe('searchNodesLexical', () => {
    const store = makeFakeStore({
        nodes: {
            n1: makeNode({ id: 'n1', title: 'Alice', fields: { summary: 'Alice loves autumn leaves.' }, seqTo: 1 }),
            n2: makeNode({ id: 'n2', title: 'Bob', fields: { summary: 'Bob hates rain.' }, seqTo: 2 }),
            n3: makeNode({ id: 'n3', title: 'Cold', fields: { summary: 'autumn is cold' }, seqTo: 3 }),
            n4: makeNode({ id: 'n4', title: 'Archived', fields: { summary: 'autumn archived' }, seqTo: 4, archived: true }),
        },
    });

    test('returns nodes whose title or fields match query (case-insensitive substring)', () => {
        const r = searchNodesLexical(store, 'AUTUMN', { limit: 5 });
        const ids = r.nodes.map(n => n.id).sort();
        expect(ids).toEqual(['n1', 'n3']);
    });

    test('skips archived nodes', () => {
        const r = searchNodesLexical(store, 'autumn', { limit: 10 });
        expect(r.nodes.map(n => n.id)).not.toContain('n4');
    });

    test('respects excludeIds (Set or iterable)', () => {
        const r = searchNodesLexical(store, 'autumn', { limit: 5, excludeIds: new Set(['n3']) });
        expect(r.nodes.map(n => n.id)).toEqual(['n1']);

        const r2 = searchNodesLexical(store, 'autumn', { limit: 5, excludeIds: ['n1'] });
        expect(r2.nodes.map(n => n.id)).toEqual(['n3']);
    });

    test('respects limit', () => {
        const r = searchNodesLexical(store, 'autumn', { limit: 1 });
        expect(r.nodes).toHaveLength(1);
    });

    test('preview is truncated to <= 300 chars', () => {
        const longStore = makeFakeStore({
            nodes: {
                nx: makeNode({ id: 'nx', title: 'longy', fields: { summary: 'autumn '.repeat(100) }, seqTo: 1 }),
            },
        });
        const r = searchNodesLexical(longStore, 'autumn', { limit: 1 });
        expect(r.nodes[0].preview.length).toBeLessThanOrEqual(300);
    });

    test('returns empty for empty/whitespace query', () => {
        expect(searchNodesLexical(store, '').nodes).toEqual([]);
        expect(searchNodesLexical(store, '   ').nodes).toEqual([]);
    });

    test('returns empty when store is null/undefined', () => {
        expect(searchNodesLexical(null, 'x').nodes).toEqual([]);
        expect(searchNodesLexical(undefined, 'x').nodes).toEqual([]);
        expect(searchNodesLexical({}, 'x').nodes).toEqual([]);
    });

    test('matches against secondary fields too (state, traits, constraint)', () => {
        const s = makeFakeStore({
            nodes: {
                a: makeNode({ id: 'a', fields: { state: 'guarded mood' }, seqTo: 1 }),
                b: makeNode({ id: 'b', fields: { traits: 'guarded' }, seqTo: 2 }),
                c: makeNode({ id: 'c', fields: { constraint: 'no guarded actions' }, seqTo: 3 }),
            },
        });
        const r = searchNodesLexical(s, 'guarded', { limit: 5 });
        expect(r.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
    });

    test('time field is the node seqTo', () => {
        const r = searchNodesLexical(store, 'autumn', { limit: 5 });
        const n3 = r.nodes.find(n => n.id === 'n3');
        expect(n3.time).toBe(3);
    });
});

describe('listRecentNodes', () => {
    const store = makeFakeStore({
        nodes: {
            n1: makeNode({ id: 'n1', title: 't1', seqTo: 10 }),
            n2: makeNode({ id: 'n2', title: 't2', seqTo: 30 }),
            n3: makeNode({ id: 'n3', title: 't3', seqTo: 20 }),
            n4: makeNode({ id: 'n4', title: 'archived', seqTo: 40, archived: true }),
        },
    });

    test('returns nodes in seqTo-descending order', () => {
        const r = listRecentNodes(store, { limit: 10 });
        expect(r.nodes.map(n => n.id)).toEqual(['n2', 'n3', 'n1']);
    });

    test('skips archived nodes', () => {
        const r = listRecentNodes(store, { limit: 10 });
        expect(r.nodes.map(n => n.id)).not.toContain('n4');
    });

    test('respects limit', () => {
        const r = listRecentNodes(store, { limit: 2 });
        expect(r.nodes.map(n => n.id)).toEqual(['n2', 'n3']);
    });

    test('respects excludeIds', () => {
        const r = listRecentNodes(store, { limit: 10, excludeIds: new Set(['n2']) });
        expect(r.nodes.map(n => n.id)).toEqual(['n3', 'n1']);
    });

    test('returns empty when store is empty', () => {
        expect(listRecentNodes(null).nodes).toEqual([]);
        expect(listRecentNodes({}).nodes).toEqual([]);
        expect(listRecentNodes({ nodes: {} }).nodes).toEqual([]);
    });

    test('default limit is 10', () => {
        const big = {};
        for (let i = 0; i < 25; i++) {
            big[`n${i}`] = makeNode({ id: `n${i}`, seqTo: i });
        }
        const r = listRecentNodes(makeFakeStore({ nodes: big }));
        expect(r.nodes).toHaveLength(10);
    });
});

describe('getNodeById', () => {
    const store = makeFakeStore({
        nodes: {
            n1: makeNode({ id: 'n1', title: 'hello' }),
            n2: makeNode({ id: 'n2', title: 'world' }),
            n3: makeNode({ id: 'n3', title: 'standalone' }),
        },
        edges: [
            { from: 'n1', to: 'n2', type: 'related', relation: 'sees' },
            { from: 'n2', to: 'n1', type: 'mentions' },
        ],
    });

    test('returns the node when id exists', () => {
        const r = getNodeById(store, 'n1', { includeNeighbors: false });
        expect(r.node.id).toBe('n1');
        expect(r.neighbors).toEqual([]);
    });

    test('returns null when id missing', () => {
        expect(getNodeById(store, 'nope')).toBeNull();
        expect(getNodeById(store, '')).toBeNull();
        expect(getNodeById(store, '   ')).toBeNull();
    });

    test('returns null when store is null/undefined', () => {
        expect(getNodeById(null, 'n1')).toBeNull();
        expect(getNodeById(undefined, 'n1')).toBeNull();
        expect(getNodeById({}, 'n1')).toBeNull();
    });

    test('default includes neighbors with edge metadata', () => {
        const r = getNodeById(store, 'n1');
        expect(r.node.id).toBe('n1');
        // n1 has outgoing edge (n1 -> n2) and incoming edge (n2 -> n1).
        // Both should surface as neighbors with the right edgeType + relation.
        const sortedByType = r.neighbors.slice().sort((a, b) =>
            String(a.edgeType).localeCompare(String(b.edgeType)),
        );
        expect(sortedByType).toEqual([
            { id: 'n2', edgeType: 'mentions', relation: undefined },
            { id: 'n2', edgeType: 'related', relation: 'sees' },
        ]);
    });

    test('node without edges returns empty neighbors array', () => {
        const r = getNodeById(store, 'n3');
        expect(r.node.id).toBe('n3');
        expect(r.neighbors).toEqual([]);
    });

    test('works when store.nodes is a Map (defensive)', () => {
        const mapStore = {
            nodes: new Map([
                ['m1', makeNode({ id: 'm1', title: 'in a map' })],
            ]),
            edges: [],
        };
        const r = getNodeById(mapStore, 'm1', { includeNeighbors: false });
        expect(r.node.id).toBe('m1');
    });
});
