// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Drives `createMgSchemaSessionStore` through both backends product code
// actually routes to — `extension_settings.memory_graph` (the `global` scope
// path keyed by `MG_GLOBAL_BUCKET_KEY`) and the character sidecar at
// `MG_SIDECAR_NAMESPACE` (the `character_<avatar>` path). Persistence runs
// through real `structuredClone`; no module-level mocks. `ctx.getCharacterState`
// / `ctx.updateCharacterState` are in-memory implementations of the real
// SillyTavern contracts.

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    createMgSchemaSessionStore,
    MG_GLOBAL_BUCKET_KEY,
    MG_SIDECAR_NAMESPACE,
} from '../../public/scripts/extensions/memory-graph/schema-iteration/session-store.js';

function makeSidecarCtx() {
    const sidecars = Object.create(null);
    return {
        getCharacterState: jest.fn(async (avatar, ns) => {
            const key = `${avatar}::${ns}`;
            return sidecars[key] ? structuredClone(sidecars[key]) : null;
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

describe('MG Schema — session store (global scope, settings-backed)', () => {
    let mgRoot, persistSettings, ctx, store;

    beforeEach(() => {
        mgRoot = {};
        persistSettings = jest.fn();
        ctx = makeSidecarCtx();
        store = createMgSchemaSessionStore({
            getMgSettingsRoot: () => mgRoot,
            persistSettings,
            computeScope: () => 'global',
            ctx,
        });
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('save creates the MG_GLOBAL_BUCKET_KEY bucket lazily', async () => {
        expect(mgRoot[MG_GLOBAL_BUCKET_KEY]).toBeUndefined();
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        expect(typeof mgRoot[MG_GLOBAL_BUCKET_KEY]).toBe('object');
        expect(mgRoot[MG_GLOBAL_BUCKET_KEY].a.id).toBe('a');
        expect(mgRoot[MG_GLOBAL_BUCKET_KEY].a.version).toBe(3);
    });

    test('save isolates via structuredClone — caller mutation does not leak', async () => {
        const sess = { id: 'a', title: 'one', messages: [], updatedAt: 1 };
        await store.save(sess);
        sess.title = 'mutated';
        const loaded = await store.load('a');
        expect(loaded.title).toBe('one');
    });

    test('load returns null for unknown id', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('delete removes the entry and persists', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect(await store.list()).toEqual([]);
        expect(persistSettings).toHaveBeenCalledTimes(2);
    });

    test('clearObsolete is a no-op', async () => {
        const before = JSON.stringify(mgRoot);
        await store.clearObsolete();
        expect(JSON.stringify(mgRoot)).toBe(before);
    });
});

describe('MG Schema — session store (character scope, sidecar-backed)', () => {
    let mgRoot, persistSettings, ctx, store;

    beforeEach(() => {
        mgRoot = {};
        persistSettings = jest.fn();
        ctx = makeSidecarCtx();
        store = createMgSchemaSessionStore({
            getMgSettingsRoot: () => mgRoot,
            persistSettings,
            computeScope: () => 'character_alice.png',
            ctx,
        });
    });

    test('save writes to the sidecar under MG_SIDECAR_NAMESPACE', async () => {
        await store.save({ id: 's1', title: 'one', messages: [], updatedAt: 10 });
        expect(ctx.updateCharacterState).toHaveBeenCalled();
        const stored = ctx._sidecars[`alice.png::${MG_SIDECAR_NAMESPACE}`];
        expect(stored).toBeTruthy();
        expect(stored.sessions.s1.id).toBe('s1');
        expect(stored.sessions.s1.version).toBe(3);
    });

    test('two character scopes go to two different sidecars', async () => {
        const storeBob = createMgSchemaSessionStore({
            getMgSettingsRoot: () => mgRoot,
            persistSettings,
            computeScope: () => 'character_bob.png',
            ctx,
        });
        await store.save({ id: 'x', title: 'alice schema', messages: [], updatedAt: 1 });
        await storeBob.save({ id: 'x', title: 'bob schema', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('alice schema');
        expect((await storeBob.list())[0].title).toBe('bob schema');
    });

    test('load returns null when the sidecar has nothing for the avatar', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('delete strips the entry from the sidecar payload', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect(await store.list()).toEqual([]);
    });

    test('save round-trips structured-clone isolated payload via the sidecar', async () => {
        const session = { id: 'r', title: 'round', messages: [], updatedAt: 50 };
        await store.save(session);
        session.title = 'mutated locally';
        const loaded = await store.load('r');
        expect(loaded?.title).toBe('round');
    });
});
