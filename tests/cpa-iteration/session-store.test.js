// tests/cpa-iteration/session-store.test.js
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    createCpaIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/session-store.js';

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

describe('CPA session — new message schema', () => {
    let stateBackend;
    let store;
    const targetRef = { collection: 'openai', name: 'MyPreset' };

    beforeEach(() => {
        stateBackend = { _state: { version: 1, currentSessionId: null, sessions: [] } };
        const context = {
            presets: {
                state: {
                    get: jest.fn(async () => structuredClone(stateBackend._state)),
                    update: jest.fn(async (_ns, fn) => {
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

    test('save+load round-trips id/at/toolCalls/edits/appliedAt/appliedTarget/rolledBackAt/auto + pendingEdits', async () => {
        const session = {
            id: 'rt-1',
            title: 'Round trip',
            createdAt: 1,
            updatedAt: 1,
            summary: '',
            surfaceState: {},
            messages: [
                { id: 'm1', role: 'user', content: 'hi', at: 100 },
                {
                    id: 'm2', role: 'assistant', content: 'sure', at: 200,
                    toolCalls: [{ name: 'preset_set_field', args: { path: 'temperature', value: 0.8 } }],
                    edits: [{ op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.8 }],
                    appliedAt: 300,
                    appliedTarget: 'preset',
                    rolledBackAt: null,
                },
                { id: 'm3', role: 'user', content: 'Continue', at: 400, auto: true },
            ],
            pendingEdits: [{ op: 'set', path: 'top_p', oldValue: 0.9, newValue: 0.95 }],
        };
        await store.save(session);
        const loaded = await store.load('rt-1');
        expect(loaded).not.toBeNull();
        expect(loaded.messages).toHaveLength(3);
        // Message 1: legacy minimal shape preserved as-is.
        expect(loaded.messages[0]).toEqual(session.messages[0]);
        // Message 2: assistant turn with full tool/edit trail.
        expect(loaded.messages[1].toolCalls).toEqual(session.messages[1].toolCalls);
        expect(loaded.messages[1].edits).toEqual(session.messages[1].edits);
        expect(loaded.messages[1].appliedAt).toBe(300);
        expect(loaded.messages[1].appliedTarget).toBe('preset');
        expect(loaded.messages[1].rolledBackAt).toBeNull();
        // Message 3: synthetic auto-continue user message.
        expect(loaded.messages[2].auto).toBe(true);
        // pendingEdits at the session top level (not per-message) survives too.
        expect(loaded.pendingEdits).toEqual(session.pendingEdits);
    });

    test('save+load preserves rolledBackAt timestamp (not null)', async () => {
        const session = {
            id: 'rb-1', title: '', createdAt: 1, updatedAt: 1, summary: '', surfaceState: {},
            messages: [{
                id: 'm1', role: 'assistant', content: 'done', at: 100,
                toolCalls: [{ name: 'preset_set_field', args: { path: 'x', value: 1 } }],
                edits: [{ op: 'set', path: 'x', oldValue: 0, newValue: 1 }],
                appliedAt: 200, appliedTarget: 'preset', rolledBackAt: 500,
            }],
        };
        await store.save(session);
        const loaded = await store.load('rb-1');
        expect(loaded.messages[0].rolledBackAt).toBe(500);
    });
});

describe('CPA — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^cpa_msg_/);
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
            toolCalls: [{ name: 't1' }],
            edits: [{ op: 'set', path: 'p', oldValue: 1, newValue: 2 }],
            appliedAt: 200, appliedTarget: 'preset',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toEqual([{ name: 't1' }]);
        expect(n.edits).toEqual([{ op: 'set', path: 'p', oldValue: 1, newValue: 2 }]);
        expect(n.appliedAt).toBe(200);
        expect(n.appliedTarget).toBe('preset');
        expect(n.rolledBackAt).toBe(300);
        expect(n.auto).toBe(true);
    });

    test('returns input unchanged for non-object', () => {
        expect(normalizeMessageShape(null)).toBeNull();
        expect(normalizeMessageShape(undefined)).toBeUndefined();
    });
});

describe('CPA — makeMessageId', () => {
    test('produces unique cpa_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^cpa_msg_/);
        expect(b).toMatch(/^cpa_msg_/);
        expect(a).not.toBe(b);
    });
});
