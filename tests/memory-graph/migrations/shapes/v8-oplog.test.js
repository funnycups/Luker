import { describe, test, expect } from '@jest/globals';
import { compare } from '../../../../public/scripts/util/fast-json-patch.js';
import { v8Oplog } from '../../../../public/scripts/extensions/memory-graph/migrations/shapes/v8-oplog.js';
import { applyMemoryLogEntryToStore, getFloorFromAssistantSeq } from '../../../../public/scripts/extensions/memory-graph/persistence.js';

function isExtractableAssistantMessage(message) {
    if (!message || message.is_system || message.is_user) return false;
    return Boolean(typeof message.mes === 'string' ? message.mes.trim() : message.mes);
}

function assistantMsg({ swipe_id = 0, mes = 'hi' } = {}) {
    return { swipe_id, mes, is_user: false, is_system: false };
}

function makeCtx(chat) {
    return {
        chat,
        isExtractableAssistantMessage,
        applyMemoryLogEntryToStore,
        getFloorFromAssistantSeq,
        buildObjectPatchOperationsAsync: async (prev, next) => compare(prev ?? {}, next ?? {}),
        FLOOR_STATE_LOG_VERSION: 1,
        SCHEMA_VERSION: 2,
    };
}

describe('v8-oplog shape', () => {
    test('detect matches when data.opLog is array', () => {
        expect(v8Oplog.detect({ data: { opLog: [] }, meta: null, log: null })).toBe(true);
        expect(v8Oplog.detect({ data: { nodes: {} }, meta: null, log: null })).toBe(false);
        expect(v8Oplog.detect({ data: null, meta: null, log: null })).toBe(false);
    });

    test('migrate produces one commit per opLog entry with correct floor + swipeId', async () => {
        const chat = [assistantMsg(), assistantMsg(), assistantMsg()];
        const input = {
            data: {
                version: 8,
                opLog: [
                    { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', level: 'semantic', seqTo: 1, fields: {} } }] },
                    { seq: 2, ops: [{ type: 'upsert_node', node: { id: 'n_2', type: 'event', level: 'semantic', seqTo: 2, fields: {} } }] },
                ],
                sourceMessageCount: 2,
                lastRecallTrace: [{ step: 'historic' }],
                lastRecallProjection: { at: 100, blocks: { corePacket: 'p' } },
                swipeTailCache: { 0: { swipeId: 0 } },  // dropped
            },
            meta: null,
            log: null,
        };

        const out = await v8Oplog.migrate(input, makeCtx(chat));

        expect(out.log.version).toBe(1);
        expect(out.log.commits).toHaveLength(2);
        expect(out.log.commits[0]).toMatchObject({ floor: 0, swipeId: 0 });
        expect(out.log.commits[1]).toMatchObject({ floor: 1, swipeId: 0 });

        // Snapshot semantics: each commit is a diff from {} (empty), so it adds the full /nodes
        // map. commit[0] has just n_1, but commit[1] must include BOTH n_1 AND n_2 — a regression
        // to incremental diffs would shrink commit[1]'s /nodes to only n_2.
        const nodesFromCommit = (commit) => {
            const addNodes = commit.patches.find(p => p.op === 'add' && p.path === '/nodes');
            return addNodes ? Object.keys(addNodes.value).sort() : [];
        };
        expect(nodesFromCommit(out.log.commits[0])).toEqual(['n_1']);
        expect(nodesFromCommit(out.log.commits[1])).toEqual(['n_1', 'n_2']);

        expect(Object.keys(out.data.nodes).sort()).toEqual(['n_1', 'n_2']);
        expect(out.data.coveredAssistantSeq).toBe(2);

        expect(out.meta).toEqual({
            schemaVersion: 2,
            sourceMessageCount: 2,
            lastRecallTrace: [{ step: 'historic' }],
            lastRecallProjection: { at: 100, blocks: { corePacket: 'p' } },
        });
        expect(out.data.swipeTailCache).toBeUndefined();
        expect(out.data.opLog).toBeUndefined();
    });

    test('migrate skips entries whose seq has no corresponding chat floor', async () => {
        const chat = [assistantMsg(), assistantMsg()];
        const input = {
            data: {
                opLog: [
                    { seq: 1, ops: [{ type: 'upsert_node', node: { id: 'n_1', type: 'event', level: 'semantic', seqTo: 1, fields: {} } }] },
                    { seq: 5, ops: [{ type: 'upsert_node', node: { id: 'n_5', type: 'event', level: 'semantic', seqTo: 5, fields: {} } }] },
                ],
            },
            meta: null,
            log: null,
        };
        const out = await v8Oplog.migrate(input, makeCtx(chat));
        expect(out.log.commits).toHaveLength(1);
        expect(out.log.commits[0].floor).toBe(0);
        expect(Object.keys(out.data.nodes)).toEqual(['n_1']);
    });

    test('migrate yields empty log when input has empty opLog', async () => {
        const chat = [];
        const out = await v8Oplog.migrate(
            { data: { opLog: [] }, meta: null, log: null },
            makeCtx(chat),
        );
        expect(out.log.commits).toEqual([]);
        expect(out.meta.schemaVersion).toBe(2);
        expect(out.data.nodes).toEqual({});
    });
});
