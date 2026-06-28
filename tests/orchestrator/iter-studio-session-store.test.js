import { describe, test, expect, jest } from '@jest/globals';
import { createOrchestratorIterationSessionStore, makeMessageId, normalizeMessageShape, ORCH_SIDECAR_NAMESPACE, ORCH_GLOBAL_BUCKET_KEY } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

function makeStubs({ avatar = 'alice.png', getCharacterState, updateCharacterState } = {}) {
    const sidecarReads = [];
    const sidecarWrites = [];
    const settingsRoot = {};
    let storedSidecar = null;
    const defaultGet = async (a, ns) => {
        sidecarReads.push({ a, ns });
        return { ok: true, state: storedSidecar };
    };
    const get = getCharacterState || defaultGet;
    const stubs = {
        mode: 'director',
        getOrchestratorSettingsRoot: () => settingsRoot,
        persistSettings: jest.fn(),
        persistSettingsImmediate: jest.fn(async () => {}),
        computeScope: () => avatar ? `character_${avatar}` : 'global',
        ctx: {
            getCharacterState: get,
            updateCharacterState: updateCharacterState || (async (a, ns, updater) => {
                const envelope = await get(a, ns);
                const current = envelope && envelope.ok ? envelope.state : null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                storedSidecar = next;
                sidecarWrites.push({ a, ns, data: next });
                return { ok: true, state: next, updated: true };
            }),
        },
        sidecarReads,
        sidecarWrites,
        settingsRoot,
    };
    return stubs;
}

describe('createOrchestratorIterationSessionStore — per-character sessions go to the sidecar', () => {
    test('save() under character scope writes through ctx.updateCharacterState, not into the settings root', async () => {
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
            getCharacterState: async () => ({ ok: true, state: sidecar }),
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
            getCharacterState: async () => ({ ok: true, state: structuredClone(sidecar) }),
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

    test('save() under character scope throws when underlying envelope reports failure', async () => {
        const stubs = makeStubs({
            updateCharacterState: jest.fn(async () => ({ ok: false, reason: 'CONFLICT', hint: 'HTTP 409 after 1 retry' })),
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await expect(store.save({ id: 's-fail', title: 'x', updatedAt: 1, mode: 'director' }))
            .rejects.toThrow(/save failed \(CONFLICT\): HTTP 409 after 1 retry/);
    });

    test('saveFlush() under character scope throws when underlying envelope reports failure', async () => {
        const stubs = makeStubs({
            updateCharacterState: jest.fn(async () => ({ ok: false, reason: 'HTTP_ERROR', hint: 'HTTP 500' })),
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await expect(store.saveFlush({ id: 's-fail', title: 'x', updatedAt: 1, mode: 'director' }))
            .rejects.toThrow(/saveFlush failed \(HTTP_ERROR\): HTTP 500/);
    });

    test('delete() under character scope throws when underlying envelope reports failure', async () => {
        const stubs = makeStubs({
            updateCharacterState: jest.fn(async () => ({ ok: false, reason: 'HTTP_ERROR', hint: 'HTTP 500' })),
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await expect(store.delete('s-fail')).rejects.toThrow(/delete failed \(HTTP_ERROR\): HTTP 500/);
    });

    test('list() under character scope treats envelope read failure as empty (does not throw)', async () => {
        const stubs = makeStubs({
            getCharacterState: async () => ({ ok: false, reason: 'TRANSPORT_ERROR', hint: 'network down' }),
        });
        const store = createOrchestratorIterationSessionStore({
            mode: 'director',
            getOrchestratorSettingsRoot: stubs.getOrchestratorSettingsRoot,
            persistSettings: stubs.persistSettings,
            persistSettingsImmediate: stubs.persistSettingsImmediate,
            computeScope: stubs.computeScope,
            ctx: stubs.ctx,
        });
        await expect(store.list()).resolves.toEqual([]);
    });
});

describe('Orchestrator iter-studio — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^orch_msg_/);
        expect(normalized.at).toBe(5000);
        expect(normalized.role).toBe('user');
        expect(normalized.content).toBe('old');
    });

    test('preserves an existing id', () => {
        const m = { id: 'existing_id', role: 'assistant', content: 'hi', at: 1234 };
        const n = normalizeMessageShape(m, 9000);
        expect(n.id).toBe('existing_id');
        expect(n.at).toBe(1234);
    });

    test('falls back to fallbackAt when at is missing', () => {
        const n = normalizeMessageShape({ role: 'user', content: 'x' }, 7777);
        expect(n.at).toBe(7777);
    });

    test('drops empty arrays (toolCalls/edits stay undefined)', () => {
        const n = normalizeMessageShape({ id: 'a', role: 'user', content: '', toolCalls: [], edits: [] }, 1);
        expect(n.toolCalls).toBeUndefined();
        expect(n.edits).toBeUndefined();
    });

    test('preserves toolCalls/edits/appliedAt/appliedTarget/auto when present', () => {
        const n = normalizeMessageShape({
            id: 'a', role: 'assistant', content: 'ok', at: 100,
            toolCalls: [{ name: 'orch_set_stage_field' }],
            edits: [{ op: 'set', path: '', oldValue: {}, newValue: {} }],
            appliedAt: 200, appliedTarget: 'character',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toEqual([{ name: 'orch_set_stage_field' }]);
        expect(n.edits).toEqual([{ op: 'set', path: '', oldValue: {}, newValue: {} }]);
        expect(n.appliedAt).toBe(200);
        expect(n.appliedTarget).toBe('character');
        expect(n.rolledBackAt).toBe(300);
        expect(n.auto).toBe(true);
    });

    test('returns input unchanged for non-object', () => {
        expect(normalizeMessageShape(null)).toBeNull();
        expect(normalizeMessageShape(undefined)).toBeUndefined();
    });
});

describe('Orchestrator iter-studio — makeMessageId', () => {
    test('produces unique orch_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^orch_msg_/);
        expect(b).toMatch(/^orch_msg_/);
        expect(a).not.toBe(b);
    });
});
