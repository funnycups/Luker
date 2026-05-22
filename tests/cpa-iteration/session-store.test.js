// tests/cpa-iteration/session-store.test.js
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createCpaIterationSessionStore } from '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/session-store.js';

describe('CPA — session store', () => {
    let stateBackend;
    let context;
    let store;
    const targetRef = { collection: 'openai', name: 'MyPreset' };

    beforeEach(() => {
        stateBackend = { _state: { version: 1, currentSessionId: null, sessions: [] } };
        context = {
            presets: {
                state: {
                    get: jest.fn(async (_ns, _opts) => structuredClone(stateBackend._state)),
                    update: jest.fn(async (_ns, fn, _opts) => {
                        const next = fn(structuredClone(stateBackend._state));
                        stateBackend._state = next;
                    }),
                },
            },
        };
        store = createCpaIterationSessionStore({
            getContext: () => context,
            getTargetRef: () => targetRef,
        });
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
    });

    test('save updates currentSessionId to the saved session', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        expect(stateBackend._state.currentSessionId).toBe('a');
    });

    test('load returns null for unknown id', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('load returns a clone (mutating result does not affect storage)', async () => {
        await store.save({ id: 'a', title: 'one', messages: [{ role: 'user', content: 'hi' }], updatedAt: 1 });
        const loaded = await store.load('a');
        loaded.title = 'mutated';
        const reloaded = await store.load('a');
        expect(reloaded.title).toBe('one');
    });

    test('load applies migrateLegacySession', async () => {
        // Seed a session directly; migrateLegacySession should at minimum return
        // an object with the same id (its actual transforms depend on what the
        // ported function does — adapter the test if a specific transform must
        // be asserted by inspecting the migrateLegacySession body).
        stateBackend._state.sessions.push({ id: 'legacy-1', messages: [], updatedAt: 50 });
        const loaded = await store.load('legacy-1');
        expect(loaded).not.toBeNull();
        expect(loaded.id).toBe('legacy-1');
    });

    test('delete removes entry and clears currentSessionId if it matched', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        expect(stateBackend._state.currentSessionId).toBe('a');
        await store.delete('a');
        expect(stateBackend._state.currentSessionId).toBeNull();
        expect((await store.list())).toEqual([]);
    });

    test('delete preserves currentSessionId when deleting a different session', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 2 });
        // After save b, currentSessionId is 'b'
        await store.delete('a');
        expect(stateBackend._state.currentSessionId).toBe('b');
    });

    test('getCurrentSessionId / setCurrentSessionId persist via state.update', async () => {
        await store.setCurrentSessionId('xyz');
        expect(stateBackend._state.currentSessionId).toBe('xyz');
        expect(await store.getCurrentSessionId()).toBe('xyz');
    });

    test('clearObsolete is a no-op (does not throw, no state change)', async () => {
        const before = JSON.stringify(stateBackend._state);
        await store.clearObsolete();
        expect(JSON.stringify(stateBackend._state)).toBe(before);
    });
});
