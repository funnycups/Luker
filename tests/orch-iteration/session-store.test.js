// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Drives `createOrchestratorIterationSessionStore` through both backends the
// product code actually routes to — `extension_settings.orchestrator` (the
// `global` scope path) and the character sidecar (the `character_<avatar>`
// path). Persistence runs through real `JSON.parse(JSON.stringify(...))`
// clones; no fake clone helpers, no module-level mocks. The `persistSettings`
// thunk and the sidecar-storage helpers `ctx.getCharacterState` /
// `ctx.updateCharacterState` are inline in-memory implementations of the
// real ST contracts, used as test storage instead of touching disk.

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createOrchestratorIterationSessionStore } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

function makeSidecarCtx() {
    const sidecars = Object.create(null);
    return {
        getCharacterState: jest.fn(async (avatar, ns) => {
            const key = `${avatar}::${ns}`;
            return sidecars[key]
                ? { ok: true, state: structuredClone(sidecars[key]) }
                : { ok: true, state: null };
        }),
        updateCharacterState: jest.fn(async (avatar, ns, updater) => {
            const key = `${avatar}::${ns}`;
            const before = sidecars[key] ? structuredClone(sidecars[key]) : null;
            const next = await updater(before, { attempt: 0, avatar, namespace: ns });
            if (next == null) return { ok: true, state: before, updated: false };
            sidecars[key] = structuredClone(next);
            return { ok: true, state: structuredClone(next), updated: true };
        }),
        _sidecars: sidecars,
    };
}

describe('Orchestrator — session store (global scope, settings-backed)', () => {
    let root, persistSettings, ctx, store;

    beforeEach(() => {
        root = {};
        persistSettings = jest.fn();
        ctx = makeSidecarCtx();
        store = createOrchestratorIterationSessionStore({
            mode: 'loop',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => 'global',
            ctx,
        });
    });

    test('save then list returns metadata sorted desc by updatedAt', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('different modes get separate buckets in the same settings root', async () => {
        const storeAgenda = createOrchestratorIterationSessionStore({
            mode: 'agenda',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => 'global',
            ctx,
        });
        await store.save({ id: 'x', title: 'loop one', messages: [], updatedAt: 1 });
        await storeAgenda.save({ id: 'x', title: 'agenda one', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('loop one');
        expect((await storeAgenda.list())[0].title).toBe('agenda one');
    });

    test('load returns null for unknown id', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('delete removes entry', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect(await store.list()).toEqual([]);
    });

    test('clearObsolete strips global_iteration_history if present', async () => {
        root.global_iteration_history = { stale: true };
        await store.clearObsolete();
        expect(root.global_iteration_history).toBeUndefined();
        expect(persistSettings).toHaveBeenCalled();
    });
});

describe('Orchestrator — session store (character scope, sidecar-backed)', () => {
    let root, persistSettings, ctx, store;

    beforeEach(() => {
        root = {};
        persistSettings = jest.fn();
        ctx = makeSidecarCtx();
        store = createOrchestratorIterationSessionStore({
            mode: 'loop',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => 'character_alice.png',
            ctx,
        });
    });

    test('save writes to the sidecar (real ctx.updateCharacterState contract)', async () => {
        await store.save({ id: 's1', title: 'sidecar one', messages: [], updatedAt: 10 });
        expect(ctx.updateCharacterState).toHaveBeenCalled();
        const stored = ctx._sidecars['alice.png::orchestrator_iter_studio_history'];
        expect(stored).toBeTruthy();
        expect(stored.sessions.s1.id).toBe('s1');
        expect(stored.sessions.s1.version).toBe(3);
    });

    test('list filters sidecar sessions by mode field', async () => {
        const storeAgenda = createOrchestratorIterationSessionStore({
            mode: 'agenda',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => 'character_alice.png',
            ctx,
        });
        await store.save({ id: 'L', title: 'loop one', mode: 'loop', messages: [], updatedAt: 1 });
        await storeAgenda.save({ id: 'A', title: 'agenda one', mode: 'agenda', messages: [], updatedAt: 2 });
        expect((await store.list()).map(m => m.id)).toEqual(['L']);
        expect((await storeAgenda.list()).map(m => m.id)).toEqual(['A']);
    });

    test('two character scopes go to two different sidecars', async () => {
        const storeBob = createOrchestratorIterationSessionStore({
            mode: 'loop',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => 'character_bob.png',
            ctx,
        });
        await store.save({ id: 'x', title: 'alice loop', messages: [], updatedAt: 1 });
        await storeBob.save({ id: 'x', title: 'bob loop', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('alice loop');
        expect((await storeBob.list())[0].title).toBe('bob loop');
    });

    test('load returns null when the sidecar has nothing for the avatar', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('delete strips the entry from the sidecar payload', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect(await store.list()).toEqual([]);
        const stored = ctx._sidecars['alice.png::orchestrator_iter_studio_history'];
        if (stored && stored.sessions) {
            expect(stored.sessions.a).toBeUndefined();
        }
    });

    test('save round-trips structured-clone isolated payload via the sidecar', async () => {
        const session = { id: 'r', title: 'round', messages: [], updatedAt: 50 };
        await store.save(session);
        session.title = 'mutated locally';
        const loaded = await store.load('r');
        expect(loaded?.title).toBe('round');
    });
});
