import { describe, test, expect, jest } from '@jest/globals';
import { createOrchestratorIterationSessionStore, ORCH_SIDECAR_NAMESPACE, ORCH_GLOBAL_BUCKET_KEY } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

function makeStubs({ avatar = 'alice.png', getCharacterState, setCharacterState } = {}) {
    const sidecarReads = [];
    const sidecarWrites = [];
    const settingsRoot = {};
    const stubs = {
        mode: 'director',
        getOrchestratorSettingsRoot: () => settingsRoot,
        persistSettings: jest.fn(),
        persistSettingsImmediate: jest.fn(async () => {}),
        computeScope: () => avatar ? `character_${avatar}` : 'global',
        ctx: {
            getCharacterState: getCharacterState || (async (a, ns) => { sidecarReads.push({ a, ns }); return null; }),
            setCharacterState: setCharacterState || (async (a, ns, data) => { sidecarWrites.push({ a, ns, data }); }),
        },
        sidecarReads,
        sidecarWrites,
        settingsRoot,
    };
    return stubs;
}

describe('createOrchestratorIterationSessionStore — per-character sessions go to the sidecar', () => {
    test('save() under character scope writes through ctx.setCharacterState, not into the settings root', async () => {
        const stubs = makeStubs();
        const store = createOrchestratorIterationSessionStore({
            mode: stubs.mode,
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await store.save({ id: 's1', title: 'Alpha', updatedAt: 1, mode: 'director' });
        expect(stubs.sidecarWrites).toHaveLength(1);
        expect(stubs.sidecarWrites[0].a).toBe('alice.png');
        expect(stubs.sidecarWrites[0].ns).toBe(ORCH_SIDECAR_NAMESPACE);
        expect(stubs.sidecarWrites[0].data.sessions.s1.id).toBe('s1');
        expect(stubs.settingsRoot[ORCH_GLOBAL_BUCKET_KEY]).toBeUndefined();
        expect(stubs.persistSettings).not.toHaveBeenCalled();
    });

    test('list() under character scope reads from the sidecar and only surfaces sessions matching this mode', async () => {
        const sidecar = {
            version: 1,
            sessions: {
                's1': { id: 's1', title: 'Director run', updatedAt: 1, mode: 'director' },
                's2': { id: 's2', title: 'Agenda run', updatedAt: 2, mode: 'agenda' },
            },
        };
        const stubs = makeStubs({
            getCharacterState: async () => sidecar,
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        const metas = await store.list();
        expect(metas).toEqual([{ id: 's1', title: 'Director run', updatedAt: 1 }]);
    });

    test('list() under global scope reads from extension_settings.orchestrator.iter_studio_global_sessions[mode]', async () => {
        const stubs = makeStubs({ avatar: null });
        stubs.settingsRoot[ORCH_GLOBAL_BUCKET_KEY] = {
            director: {
                's3': { id: 's3', title: 'Global director', updatedAt: 3, mode: 'director' },
            },
        };
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: () => 'global',
            ctx: stubs.ctx,
        });
        const metas = await store.list();
        expect(metas).toEqual([{ id: 's3', title: 'Global director', updatedAt: 3 }]);
        expect(stubs.sidecarReads).toHaveLength(0);
    });

    test('delete() removes the session from the sidecar map and rewrites it', async () => {
        const sidecar = { version: 1, sessions: { 's1': { id: 's1', mode: 'director', updatedAt: 1 }, 's2': { id: 's2', mode: 'director', updatedAt: 2 } } };
        const stubs = makeStubs({
            getCharacterState: async () => structuredClone(sidecar),
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await store.delete('s1');
        expect(stubs.sidecarWrites).toHaveLength(1);
        expect(stubs.sidecarWrites[0].data.sessions.s1).toBeUndefined();
        expect(stubs.sidecarWrites[0].data.sessions.s2).toBeDefined();
    });

    test('saveFlush() awaits the same write path as save() (no separate immediate helper)', async () => {
        const stubs = makeStubs();
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await store.saveFlush({ id: 's4', title: 'Flush', updatedAt: 4, mode: 'director' });
        expect(stubs.sidecarWrites).toHaveLength(1);
    });

    test('clearObsolete() strips legacy v1 global key like before', async () => {
        const stubs = makeStubs();
        stubs.settingsRoot.global_iteration_history = { sessions: ['stale'] };
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await store.clearObsolete();
        expect(stubs.settingsRoot.global_iteration_history).toBeUndefined();
        expect(stubs.persistSettings).toHaveBeenCalledTimes(1);
    });
});
