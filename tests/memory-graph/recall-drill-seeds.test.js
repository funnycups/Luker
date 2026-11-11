import { beforeAll, describe, expect, test } from '@jest/globals';
import './_mocks/main-module-stack.js';

/**
 * Route-stage candidate pool contract.
 *
 * Always-inject nodes are injected at rollup granularity by the persistent
 * projection. The route LLM still has to see the always-inject rollups that
 * have active children so it can drill them and pull the more specific
 * descendants into the next pass. Nodes without active children stay out of
 * the pool: they are already injected and have nothing to drill.
 */
describe('buildRecallRouteCandidatePool', () => {
    let buildRecallRouteCandidatePool;

    beforeAll(async () => {
        const mainMod = await import('../../public/scripts/extensions/memory-graph/main.js');
        buildRecallRouteCandidatePool = mainMod.buildRecallRouteCandidatePool;
    });

    function makeStore() {
        return {
            nodes: {
                rollup: { id: 'rollup', type: 'event', childrenIds: ['leaf_a', 'leaf_b'], archived: false },
                leaf_a: { id: 'leaf_a', type: 'event', childrenIds: [], archived: false },
                leaf_b: { id: 'leaf_b', type: 'event', childrenIds: [], archived: false },
                archived_child_rollup: { id: 'archived_child_rollup', type: 'event', childrenIds: ['gone'], archived: false },
                gone: { id: 'gone', type: 'event', childrenIds: [], archived: true },
                injected_leaf: { id: 'injected_leaf', type: 'event', childrenIds: [], archived: false },
                selectable: { id: 'selectable', type: 'character_sheet', childrenIds: [], archived: false },
            },
        };
    }

    const store = makeStore();

    test('keeps selectable candidates in order', () => {
        const pool = buildRecallRouteCandidatePool(
            [store.nodes.selectable],
            new Set(),
            store,
        );
        expect(pool.map(node => node.id)).toEqual(['selectable']);
    });

    test('re-admits an always-inject rollup that has active children', () => {
        const pool = buildRecallRouteCandidatePool(
            [store.nodes.rollup],
            new Set(['rollup']),
            store,
        );
        expect(pool.map(node => node.id)).toEqual(['rollup']);
    });

    test('drops an always-inject node without active children', () => {
        const pool = buildRecallRouteCandidatePool(
            [store.nodes.injected_leaf],
            new Set(['injected_leaf']),
            store,
        );
        expect(pool).toEqual([]);
    });

    test('drops an always-inject rollup whose children are all archived', () => {
        const pool = buildRecallRouteCandidatePool(
            [store.nodes.archived_child_rollup],
            new Set(['archived_child_rollup']),
            store,
        );
        expect(pool).toEqual([]);
    });

    test('deduplicates repeated node ids', () => {
        const pool = buildRecallRouteCandidatePool(
            [store.nodes.selectable, store.nodes.selectable],
            new Set(),
            store,
        );
        expect(pool.map(node => node.id)).toEqual(['selectable']);
    });
});
