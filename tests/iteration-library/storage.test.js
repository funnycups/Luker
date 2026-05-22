import { describe, test, expect, jest } from '@jest/globals';
import { createExtensionSettingsSessionStorage } from '../../public/scripts/iteration-library/storage.js';

function makeFakeBacking() {
    const bucket = {};
    const persist = jest.fn();
    return {
        bucket,
        persist,
        storage: createExtensionSettingsSessionStorage({
            getBucket: () => bucket,
            persistSettings: persist,
        }),
    };
}

describe('iteration-library/storage — createExtensionSettingsSessionStorage', () => {
    test('throws on missing getBucket / persistSettings', () => {
        expect(() => createExtensionSettingsSessionStorage({})).toThrow(TypeError);
        expect(() => createExtensionSettingsSessionStorage({ getBucket: () => ({}) })).toThrow(TypeError);
        expect(() => createExtensionSettingsSessionStorage({ persistSettings: () => {} })).toThrow(TypeError);
    });

    test('listSessions filters non-session entries and sorts by updatedAt desc', async () => {
        const { bucket, storage } = makeFakeBacking();
        bucket['a'] = { id: 'a', title: 'A', updatedAt: 100 };
        bucket['b'] = { id: 'b', title: 'B', updatedAt: 300 };
        bucket['c'] = { id: 'c', updatedAt: 200 };       // title falls back to id
        bucket['_meta'] = { not: 'a session' };          // filtered (no id)
        bucket['malformed'] = null;                      // filtered
        const sessions = await storage.listSessions('any');
        expect(sessions.map(s => s.id)).toEqual(['b', 'c', 'a']);
        expect(sessions[1]).toEqual({ id: 'c', title: 'c', updatedAt: 200 });
    });

    test('saveSession stores a structured clone, not the original reference', async () => {
        const { bucket, storage, persist } = makeFakeBacking();
        const session = { id: 'x', title: 't', body: { nested: 1 } };
        await storage.saveSession('any', session);
        expect(bucket['x']).toEqual(session);
        expect(bucket['x']).not.toBe(session);
        expect(bucket['x'].body).not.toBe(session.body);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    test('saveSession ignores sessions without an id', async () => {
        const { bucket, storage, persist } = makeFakeBacking();
        await storage.saveSession('any', { title: 'no id' });
        expect(Object.keys(bucket)).toEqual([]);
        expect(persist).not.toHaveBeenCalled();
    });

    test('loadSession returns a clone, mutations do not leak back', async () => {
        const { bucket, storage } = makeFakeBacking();
        bucket['x'] = { id: 'x', body: { a: 1 } };
        const loaded = await storage.loadSession('any', 'x');
        loaded.body.a = 999;
        expect(bucket['x'].body.a).toBe(1);
    });

    test('deleteSession removes the entry and persists', async () => {
        const { bucket, storage, persist } = makeFakeBacking();
        bucket['x'] = { id: 'x' };
        bucket['y'] = { id: 'y' };
        await storage.deleteSession('any', 'x');
        expect(Object.keys(bucket).sort()).toEqual(['y']);
        expect(persist).toHaveBeenCalledTimes(1);
    });
});
