import { describe, test, expect } from '@jest/globals';
import { v5Raw } from '../../../../public/scripts/extensions/memory-graph/migrations/shapes/v5-raw.js';
import { v8Oplog } from '../../../../public/scripts/extensions/memory-graph/migrations/shapes/v8-oplog.js';
import {
    buildMemoryLogOpsFromStore,
    getStoreCoveredSeqTo,
} from '../../../../public/scripts/extensions/memory-graph/persistence.js';

const ctx = { buildMemoryLogOpsFromStore, getStoreCoveredSeqTo };

describe('v5-raw shape', () => {
    test('detect: matches when data has nodes but no opLog and meta not stamped', () => {
        expect(v5Raw.detect({
            data: { version: 5, nodes: { n_1: { id: 'n_1', type: 'event', level: 'semantic', seqTo: 1, fields: {} } }, edges: [] },
            meta: null,
            log: null,
        })).toBe(true);
    });

    test('detect: rejects when data has opLog (let v8-oplog handle)', () => {
        expect(v5Raw.detect({
            data: { nodes: { n_1: {} }, opLog: [] },
            meta: null,
            log: null,
        })).toBe(false);
    });

    test('detect: rejects when meta.schemaVersion >= 2 (already migrated)', () => {
        expect(v5Raw.detect({
            data: { nodes: { n_1: {} } },
            meta: { schemaVersion: 2 },
            log: null,
        })).toBe(false);
    });

    test('detect: rejects on empty / no nodes / no edges', () => {
        expect(v5Raw.detect({ data: null, meta: null, log: null })).toBe(false);
        expect(v5Raw.detect({ data: {}, meta: null, log: null })).toBe(false);
        expect(v5Raw.detect({ data: { nodes: {}, edges: [] }, meta: null, log: null })).toBe(false);
    });

    test('migrate: wraps raw store into a single opLog entry that v8-oplog can consume', async () => {
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
                lastRecallTrace: [{ step: 'historic' }],
                lastRecallProjection: null,
            },
            meta: null,
            log: null,
        };
        const out = await v5Raw.migrate(input, ctx);
        expect(Array.isArray(out.data.opLog)).toBe(true);
        expect(out.data.opLog).toHaveLength(1);
        expect(out.data.opLog[0].seq).toBe(1);
        expect(out.data.opLog[0].ops.some(op => op.type === 'upsert_node' && op.node.id === 'n_1')).toBe(true);
        // input.data 上的 lastRecallTrace 等保留,等 v8-oplog 提取
        expect(out.data.lastRecallTrace).toEqual([{ step: 'historic' }]);
        expect(out.data.sourceMessageCount).toBe(1);
        // v8-oplog detect 现在应该 true
        expect(v8Oplog.detect(out)).toBe(true);
    });

    test('migrate: empty raw store still produces output v8-oplog can detect', async () => {
        const input = {
            data: { version: 5, nodes: {}, edges: [], nodeSeq: 0, seqCounter: 0, appliedSeqTo: 0, loggedSeqTo: 0 },
            meta: null,
            log: null,
        };
        const out = await v5Raw.migrate(input, ctx);
        expect(Array.isArray(out.data.opLog)).toBe(true);
        expect(out.data.opLog).toEqual([]);
        expect(v8Oplog.detect(out)).toBe(true);
    });
});
