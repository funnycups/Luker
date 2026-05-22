// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createOrchestratorIterationSessionStore } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

describe('Orchestrator — session store', () => {
    let root, persistSettings, store, scope;

    beforeEach(() => {
        root = {};
        persistSettings = jest.fn();
        scope = 'char_alice';
        store = createOrchestratorIterationSessionStore({
            mode: 'loop',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => scope,
        });
    });

    test('save then list returns metadata sorted desc by updatedAt', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
    });

    test('different modes get separate buckets', async () => {
        const storeAgenda = createOrchestratorIterationSessionStore({
            mode: 'agenda',
            getOrchestratorSettingsRoot: () => root,
            persistSettings,
            computeScope: () => scope,
        });
        await store.save({ id: 'x', title: 'loop one', messages: [], updatedAt: 1 });
        await storeAgenda.save({ id: 'x', title: 'agenda one', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('loop one');
        expect((await storeAgenda.list())[0].title).toBe('agenda one');
    });

    test('different scopes within the same mode get separate buckets', async () => {
        await store.save({ id: 'x', title: 'alice', messages: [], updatedAt: 1 });
        scope = 'char_bob';
        await store.save({ id: 'x', title: 'bob', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('bob');
        scope = 'char_alice';
        expect((await store.list())[0].title).toBe('alice');
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
