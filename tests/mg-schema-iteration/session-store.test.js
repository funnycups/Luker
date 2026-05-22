// tests/mg-schema-iteration/session-store.test.js
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createMgSchemaSessionStore } from '../../public/scripts/extensions/memory-graph/schema-iteration/session-store.js';
import { SESSIONS_BUCKET_KEY } from '../../public/scripts/extensions/memory-graph/schema-iteration/tools.js';

describe('MG Schema — session store', () => {
    let mgRoot;
    let persistSettings;
    let store;

    beforeEach(() => {
        mgRoot = {};
        persistSettings = jest.fn();
        store = createMgSchemaSessionStore({
            getMgSettingsRoot: () => mgRoot,
            persistSettings,
        });
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('save creates the SESSIONS_BUCKET_KEY bucket lazily', async () => {
        expect(mgRoot[SESSIONS_BUCKET_KEY]).toBeUndefined();
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        expect(typeof mgRoot[SESSIONS_BUCKET_KEY]).toBe('object');
    });

    test('save isolates by structured clone', async () => {
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
