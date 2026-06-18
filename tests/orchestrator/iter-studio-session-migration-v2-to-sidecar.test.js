import { describe, test, expect, jest } from '@jest/globals';
import { migrateOrchSessionsV2ToSidecar, MIGRATION_FLAG_KEY } from '../../public/scripts/extensions/orchestrator/iter-studio/session-migration-v2-to-sidecar.js';
import { ORCH_SIDECAR_NAMESPACE, ORCH_GLOBAL_BUCKET_KEY } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

describe('migrateOrchSessionsV2ToSidecar', () => {
    test('moves character-scoped sessions out of iterStudioV2 and into per-character sidecars', async () => {
        const settingsRoot = {
            iterStudioV2: {
                director: {
                    'character_alice.png': {
                        's1': { id: 's1', title: 'Alice run', updatedAt: 1, mode: 'director' },
                    },
                    'character_bob.png': {
                        's2': { id: 's2', title: 'Bob run', updatedAt: 2, mode: 'director' },
                    },
                    'global': {
                        's3': { id: 's3', title: 'Global', updatedAt: 3, mode: 'director' },
                    },
                },
            },
        };
        const sidecars = {};
        const ctx = {
            getCharacterState: jest.fn(async (a, ns) => sidecars[`${a}:${ns}`] || null),
            setCharacterState: jest.fn(async (a, ns, data) => { sidecars[`${a}:${ns}`] = data; }),
            characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }],
        };
        const persistSettings = jest.fn();

        const result = await migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings });

        expect(result.migrated).toBe(2);
        expect(result.skipped).toBe(0);
        expect(result.globalMoved).toBe(1);
        expect(sidecars[`alice.png:${ORCH_SIDECAR_NAMESPACE}`].sessions.s1.id).toBe('s1');
        expect(sidecars[`bob.png:${ORCH_SIDECAR_NAMESPACE}`].sessions.s2.id).toBe('s2');
        expect(settingsRoot[ORCH_GLOBAL_BUCKET_KEY].director.s3.id).toBe('s3');
        expect(settingsRoot.iterStudioV2).toBeUndefined();
        expect(settingsRoot[MIGRATION_FLAG_KEY]).toBe(true);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('is idempotent — second run is a no-op once the flag is set', async () => {
        const settingsRoot = { [MIGRATION_FLAG_KEY]: true };
        const ctx = {
            getCharacterState: jest.fn(),
            setCharacterState: jest.fn(),
            characters: [],
        };
        const result = await migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });
        expect(result.skipped).toBe(0);
        expect(result.migrated).toBe(0);
        expect(ctx.setCharacterState).not.toHaveBeenCalled();
    });

    test('skips and warns when a target avatar is not in the character list (no destructive write)', async () => {
        const settingsRoot = {
            iterStudioV2: {
                director: {
                    'character_ghost.png': {
                        's1': { id: 's1', updatedAt: 1, mode: 'director' },
                    },
                },
            },
        };
        const ctx = {
            getCharacterState: jest.fn(),
            setCharacterState: jest.fn(),
            characters: [{ avatar: 'alice.png' }],
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });

        expect(result.skipped).toBe(1);
        expect(result.migrated).toBe(0);
        expect(ctx.setCharacterState).not.toHaveBeenCalled();
        expect(settingsRoot.iterStudioV2.director['character_ghost.png'].s1).toBeDefined();
        warnSpy.mockRestore();
    });

    test('preserves V2 entries whose sidecar write throws (no data loss on failure)', async () => {
        const settingsRoot = {
            iterStudioV2: {
                director: {
                    'character_alice.png': {
                        's1': { id: 's1', updatedAt: 1, mode: 'director' },
                    },
                },
            },
        };
        const ctx = {
            getCharacterState: jest.fn(async () => null),
            setCharacterState: jest.fn(async () => { throw new Error('disk full'); }),
            characters: [{ avatar: 'alice.png' }],
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });

        expect(result.skipped).toBe(1);
        expect(result.migrated).toBe(0);
        expect(settingsRoot.iterStudioV2.director['character_alice.png'].s1).toBeDefined();
        warnSpy.mockRestore();
    });

    test('merges into existing sidecar payload (does NOT clobber pre-existing entries)', async () => {
        const settingsRoot = {
            iterStudioV2: {
                director: {
                    'character_alice.png': { 'new1': { id: 'new1', updatedAt: 10, mode: 'director' } },
                },
            },
        };
        const sidecars = {
            [`alice.png:${ORCH_SIDECAR_NAMESPACE}`]: {
                version: 1,
                sessions: { 'old1': { id: 'old1', title: 'Prior partial migration', updatedAt: 0 } },
            },
        };
        const ctx = {
            getCharacterState: jest.fn(async (a, ns) => sidecars[`${a}:${ns}`] || null),
            setCharacterState: jest.fn(async (a, ns, data) => { sidecars[`${a}:${ns}`] = data; }),
            characters: [{ avatar: 'alice.png' }],
        };
        await migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });

        expect(sidecars[`alice.png:${ORCH_SIDECAR_NAMESPACE}`].sessions.new1.id).toBe('new1');
        expect(sidecars[`alice.png:${ORCH_SIDECAR_NAMESPACE}`].sessions.old1.id).toBe('old1');
        expect(sidecars[`alice.png:${ORCH_SIDECAR_NAMESPACE}`].version).toBe(1);
    });
});
