import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createCharacterIterationSessionStore } from '../../public/scripts/extensions/character-editor-assistant/character-iteration/session-store.js';

describe('CEA Character — session store', () => {
    let settings;
    let persistSettings;
    let store;

    beforeEach(() => {
        settings = {};
        persistSettings = jest.fn();
        store = createCharacterIterationSessionStore({
            getSettings: () => settings,
            persistSettings,
            avatar: 'alice.png',
        });
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
        expect(persistSettings).toHaveBeenCalled();
    });

    test('save isolates by structured clone (mutating original does not affect store)', async () => {
        const sess = { id: 'a', title: 'one', messages: [], updatedAt: 1 };
        await store.save(sess);
        sess.title = 'mutated';
        const loaded = await store.load('a');
        expect(loaded.title).toBe('one');
    });

    test('load returns null for unknown id', async () => {
        const loaded = await store.load('missing');
        expect(loaded).toBeNull();
    });

    test('delete removes the entry and persists', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        const list = await store.list();
        expect(list).toEqual([]);
        expect(persistSettings).toHaveBeenCalledTimes(2);
    });

    test('different avatars get separate buckets', async () => {
        const storeB = createCharacterIterationSessionStore({
            getSettings: () => settings,
            persistSettings,
            avatar: 'bob.png',
        });
        await store.save({ id: 'x', title: 'a', messages: [], updatedAt: 1 });
        await storeB.save({ id: 'x', title: 'b', messages: [], updatedAt: 1 });
        expect((await store.list())[0].title).toBe('a');
        expect((await storeB.list())[0].title).toBe('b');
    });

    test('clearObsolete strips pre-v2 keys', async () => {
        settings.lorebookSyncHistory = { foo: 1 };
        settings.popupSessions = { bar: 2 };
        await store.clearObsolete();
        expect(settings.lorebookSyncHistory).toBeUndefined();
        expect(settings.popupSessions).toBeUndefined();
        expect(persistSettings).toHaveBeenCalled();
    });
});
