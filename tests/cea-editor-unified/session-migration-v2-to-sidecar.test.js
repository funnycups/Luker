import { describe, test, expect, jest } from '@jest/globals';
import { migrateCeaSessionsV2ToSidecar, CEA_MIGRATION_FLAG_KEY } from '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-migration-v2-to-sidecar.js';
import { CEA_SIDECAR_NAMESPACE } from '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-store.js';

function makeUpdateStub(sidecars) {
    return jest.fn(async (a, ns, updater) => {
        const current = sidecars[`${a}:${ns}`] || null;
        const next = await updater(
            current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
            { attempt: 0, avatar: a, namespace: ns },
        );
        if (next == null) return { ok: true, state: current, updated: false };
        sidecars[`${a}:${ns}`] = next;
        return { ok: true, state: next, updated: true };
    });
}

describe('migrateCeaSessionsV2ToSidecar', () => {
    test('moves char_<avatar> buckets from unified_cea_editor_sessions into sidecars', async () => {
        const settingsRoot = {
            unified_cea_editor_sessions: {
                'char_alice.png': { 's1': { id: 's1', avatar: 'alice.png', updatedAt: 1 } },
                'char_bob.png': { 's2': { id: 's2', avatar: 'bob.png', updatedAt: 2 } },
            },
        };
        const sidecars = {};
        const ctx = {
            getCharacterState: jest.fn(async (a, ns) => sidecars[`${a}:${ns}`] || null),
            updateCharacterState: makeUpdateStub(sidecars),
            characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }],
        };
        const persistSettings = jest.fn();

        const result = await migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings });

        expect(result.migrated).toBe(2);
        expect(result.skipped).toBe(0);
        expect(sidecars[`alice.png:${CEA_SIDECAR_NAMESPACE}`].sessions.s1.id).toBe('s1');
        expect(sidecars[`bob.png:${CEA_SIDECAR_NAMESPACE}`].sessions.s2.id).toBe('s2');
        expect(settingsRoot.unified_cea_editor_sessions).toBeUndefined();
        expect(settingsRoot[CEA_MIGRATION_FLAG_KEY]).toBe(true);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('is idempotent — second run is a no-op', async () => {
        const settingsRoot = { [CEA_MIGRATION_FLAG_KEY]: true };
        const ctx = { getCharacterState: jest.fn(), updateCharacterState: jest.fn(), characters: [] };
        const result = await migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });
        expect(result.migrated).toBe(0);
        expect(ctx.updateCharacterState).not.toHaveBeenCalled();
    });

    test('skips when avatar not in character list, leaves the V2 entry in place', async () => {
        const settingsRoot = {
            unified_cea_editor_sessions: {
                'char_ghost.png': { 's1': { id: 's1', updatedAt: 1 } },
            },
        };
        const ctx = {
            getCharacterState: jest.fn(),
            updateCharacterState: jest.fn(),
            characters: [{ avatar: 'alice.png' }],
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });
        expect(settingsRoot.unified_cea_editor_sessions['char_ghost.png'].s1).toBeDefined();
        warnSpy.mockRestore();
    });

    test('skips non-char_ buckets entirely (defensive — CEA never had any other scope)', async () => {
        const settingsRoot = {
            unified_cea_editor_sessions: {
                'global': { 's1': { id: 's1', updatedAt: 1 } },
            },
        };
        const ctx = { getCharacterState: jest.fn(), updateCharacterState: jest.fn(), characters: [] };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings: jest.fn() });
        expect(result.skipped).toBe(1);
        expect(result.migrated).toBe(0);
        warnSpy.mockRestore();
    });

    test('drops empty char_ bucket without skipping (empty-but-orphan from a deleted character)', async () => {
        const settingsRoot = {
            unified_cea_editor_sessions: {
                'char_ghost.png': {}, // empty sessionMap, ghost avatar not in character list
            },
        };
        const ctx = {
            getCharacterState: jest.fn(),
            updateCharacterState: jest.fn(),
            characters: [{ avatar: 'alice.png' }],
        };
        const persistSettings = jest.fn();

        const result = await migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings });

        expect(result.migrated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(settingsRoot.unified_cea_editor_sessions).toBeUndefined();
        expect(settingsRoot[CEA_MIGRATION_FLAG_KEY]).toBe(true);
        expect(ctx.updateCharacterState).not.toHaveBeenCalled();
    });
});
