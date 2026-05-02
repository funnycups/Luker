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
    const { applyMemoryLogEntryToStore } = await import('../../../public/scripts/extensions/memory-graph/persistence.js');
    return {
        chat,
        isExtractableAssistantMessage: (m) => Boolean(m && !m.is_user && !m.is_system && m.mes),
        applyMemoryLogEntryToStore,
        buildObjectPatchOperationsAsync: async (prev, next) => compare(prev ?? {}, next ?? {}),
        FLOOR_STATE_LOG_VERSION: 1,
        SCHEMA_VERSION: 2,
    };
}
