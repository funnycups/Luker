import { describe, test, expect, jest } from '@jest/globals';
import { migrateMgSchemaSessionsV2ToSidecar, MG_MIGRATION_FLAG_KEY } from '../../public/scripts/extensions/memory-graph/schema-iteration/session-migration-v2-to-sidecar.js';
import { MG_GLOBAL_BUCKET_KEY } from '../../public/scripts/extensions/memory-graph/schema-iteration/session-store.js';

describe('migrateMgSchemaSessionsV2ToSidecar', () => {
    test('flat V2 sessions go into the global bucket (MG never had per-char scope in V2)', async () => {
        const settingsRoot = {
            iterStudioV2Schema: {
                's1': { id: 's1', title: 'Global', updatedAt: 1 },
                's2': { id: 's2', title: 'Another', updatedAt: 2 },
            },
        };
        const ctx = { getCharacterState: jest.fn(), setCharacterState: jest.fn(), characters: [] };
        const persistSettings = jest.fn();

        const result = await migrateMgSchemaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings });

        expect(result.globalMoved).toBe(2);
        expect(result.migrated).toBe(0);
        expect(settingsRoot[MG_GLOBAL_BUCKET_KEY].s1.id).toBe('s1');
        expect(settingsRoot[MG_GLOBAL_BUCKET_KEY].s2.id).toBe('s2');
        expect(settingsRoot.iterStudioV2Schema).toBeUndefined();
        expect(settingsRoot[MG_MIGRATION_FLAG_KEY]).toBe(true);
    });

    test('is idempotent', async () => {
        const settingsRoot = { [MG_MIGRATION_FLAG_KEY]: true };
        const ctx = { getCharacterState: jest.fn(), setCharacterState: jest.fn(), characters: [] };
        const result = await migrateMgSchemaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });
        expect(result.globalMoved).toBe(0);
    });

    test('empty V2 bucket still sets the flag and returns zeros', async () => {
        const settingsRoot = {};
        const ctx = { getCharacterState: jest.fn(), setCharacterState: jest.fn(), characters: [] };
        const persistSettings = jest.fn();
        const result = await migrateMgSchemaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings });
        expect(result.globalMoved).toBe(0);
        expect(settingsRoot[MG_MIGRATION_FLAG_KEY]).toBe(true);
        expect(persistSettings).toHaveBeenCalled();
    });
});
