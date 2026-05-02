import { describe, test, expect } from '@jest/globals';
import { runMigrationPipeline } from '../../../public/scripts/extensions/memory-graph/migrations/index.js';
import { v2FloorState } from '../../../public/scripts/extensions/memory-graph/migrations/shapes/v2-floor-state.js';

describe('runMigrationPipeline driver basics', () => {
    test('returns input unchanged when registry has no matching detect', async () => {
        const input = { data: null, meta: null, log: null };
        const ctx = makeMinimalCtx();
        const result = await runMigrationPipeline(input, ctx);
        expect(result.changed).toBe(false);
        expect(result.migrations).toEqual([]);
        expect(result.data).toBeNull();
        expect(result.meta).toBeNull();
        expect(result.log).toBeNull();
    });
});

function makeMinimalCtx() {
    return {
        chat: [],
        isExtractableAssistantMessage: () => false,
        applyMemoryLogEntryToStore: () => {},
        buildObjectPatchOperationsAsync: async () => [],
        FLOOR_STATE_LOG_VERSION: 1,
        SCHEMA_VERSION: 2,
    };
}

describe('runMigrationPipeline with v2-floor-state', () => {
    test('returns terminal v2 input as changed=false, migrations=[]', async () => {
        const input = {
            data: { nodes: {}, edges: [] },
            meta: { schemaVersion: 2 },
            log: { version: 1, commits: [] },
        };
        const result = await runMigrationPipeline(input, makeMinimalCtx());
        expect(result.changed).toBe(false);
        expect(result.migrations).toEqual([]);
        expect(result.data).toEqual(input.data);
    });
});

describe('runMigrationPipeline v8 → v2 chain', () => {
    test('v8 input goes through v8-oplog then terminates at v2-floor-state', async () => {
        const chat = [{ swipe_id: 0, mes: 'a', is_user: false, is_system: false }];
        const input = {
            data: {
                version: 8,
                opLog: [
                    { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', level: 'semantic', seqTo: 1, fields: {} } }] },
                ],
                sourceMessageCount: 1,
                lastRecallTrace: [],
                lastRecallProjection: null,
            },
            meta: null,
            log: null,
        };
        const ctx = await makeRichCtx(chat);
        const result = await runMigrationPipeline(input, ctx);
        expect(result.migrations).toEqual(['v8-oplog']);
        expect(result.changed).toBe(true);
        expect(result.meta.schemaVersion).toBe(2);
        expect(result.log.commits).toHaveLength(1);
        expect(Object.keys(result.data.nodes)).toEqual(['n_1']);
    });
});

async function makeRichCtx(chat) {
    const { compare } = await import('../../../public/scripts/util/fast-json-patch.js');
    const { applyMemoryLogEntryToStore, getFloorFromAssistantSeq, buildMemoryLogOpsFromStore, getStoreCoveredSeqTo } = await import('../../../public/scripts/extensions/memory-graph/persistence.js');
    return {
        chat,
        isExtractableAssistantMessage: (m) => Boolean(m && !m.is_user && !m.is_system && m.mes),
        applyMemoryLogEntryToStore,
        getFloorFromAssistantSeq,
        buildMemoryLogOpsFromStore,
        getStoreCoveredSeqTo,
        buildObjectPatchOperationsAsync: async (prev, next) => compare(prev ?? {}, next ?? {}),
        FLOOR_STATE_LOG_VERSION: 1,
        SCHEMA_VERSION: 2,
    };
}

describe('runMigrationPipeline v5 → v8 → v2 chain', () => {
    test('v5 raw input goes through both translators to v2', async () => {
        const chat = [{ swipe_id: 0, mes: 'a', is_user: false, is_system: false }];
        const input = {
            data: {
                version: 5,
                nodes: {
                    n_1: { id: 'n_1', type: 'event', level: 'semantic', seqTo: 1, fields: {}, parentId: '', childrenIds: [], semanticDepth: 0, semanticRollup: false, archived: false, title: 'a' },
                },
                edges: [],
                nodeSeq: 1,
                seqCounter: 1,
                appliedSeqTo: 1,
                loggedSeqTo: 1,
                sourceMessageCount: 1,
                lastRecallTrace: [{ step: 'pre-v8' }],
                lastRecallProjection: null,
            },
            meta: null,
            log: null,
        };
        const ctx = await makeRichCtx(chat);
        const result = await runMigrationPipeline(input, ctx);
        expect(result.migrations).toEqual(['v5-raw', 'v8-oplog']);
        expect(result.changed).toBe(true);
        expect(result.meta.schemaVersion).toBe(2);
        expect(result.meta.sourceMessageCount).toBe(1);
        expect(result.meta.lastRecallTrace).toEqual([{ step: 'pre-v8' }]);
        expect(Object.keys(result.data.nodes)).toEqual(['n_1']);
        expect(result.log.commits).toHaveLength(1);
    });
});

describe('runMigrationPipeline robustness', () => {
    test('throws when shape registry has a self-cycle exceeding MAX_HOPS', async () => {
        const cycleShapes = [{
            id: 'cycle',
            detect: () => true,
            migrate: async (input) => input,
            nextId: 'cycle',
        }];
        const ctx = await makeRichCtx([]);
        await expect(
            runMigrationPipeline({ data: { foo: 1 }, meta: null, log: null }, ctx, cycleShapes)
        ).rejects.toThrow(/MAX_HOPS/);
    });

    test('migrate throw is caught: returns input unchanged with <id>:error in migrations', async () => {
        const brokenShapes = [{
            id: 'broken',
            detect: () => true,
            migrate: async () => { throw new Error('synthetic test failure'); },
            nextId: 'next',
        }];
        const ctx = await makeRichCtx([]);
        const input = { data: { foo: 1 }, meta: null, log: null };
        const result = await runMigrationPipeline(input, ctx, brokenShapes);
        expect(result.changed).toBe(false);
        expect(result.migrations).toEqual(['broken:error']);
        expect(result.data).toEqual({ foo: 1 });
    });
});
