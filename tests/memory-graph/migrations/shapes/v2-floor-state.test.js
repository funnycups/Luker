import { describe, test, expect } from '@jest/globals';
import { v2FloorState } from '../../../../public/scripts/extensions/memory-graph/migrations/shapes/v2-floor-state.js';

describe('v2-floor-state shape', () => {
    test('id is v2-floor-state and migrate is null (terminal)', () => {
        expect(v2FloorState.id).toBe('v2-floor-state');
        expect(v2FloorState.migrate).toBeNull();
        expect(v2FloorState.nextId).toBeNull();
    });

    test('detect returns true when meta.schemaVersion >= 2 and data has no opLog', () => {
        const input = {
            data: { nodes: { n_1: {} }, edges: [] },
            meta: { schemaVersion: 2 },
            log: { version: 1, commits: [] },
        };
        expect(v2FloorState.detect(input)).toBe(true);
    });

    test('detect returns true when log has commits and data has no opLog', () => {
        const input = {
            data: { nodes: {} },
            meta: null,
            log: { version: 1, commits: [{ floor: 0, swipeId: 0, patches: [] }] },
        };
        expect(v2FloorState.detect(input)).toBe(true);
    });

    test('detect returns false when data still has opLog (interrupted migration)', () => {
        const input = {
            data: { opLog: [], nodes: {} },
            meta: { schemaVersion: 2 },
            log: null,
        };
        expect(v2FloorState.detect(input)).toBe(false);
    });

    test('detect returns false on empty/null inputs', () => {
        expect(v2FloorState.detect({ data: null, meta: null, log: null })).toBe(false);
        expect(v2FloorState.detect({ data: {}, meta: null, log: null })).toBe(false);
    });
});
