// tests/memory-graph/schema-iteration-session-store.test.js
//
// Backend coverage for the scope-aware MG schema-iteration session store:
//   - global scope → extension_settings.memory_graph.schema_iter_global_sessions
//   - character scope → sidecar under MG_SIDECAR_NAMESPACE on the avatar
//
// Also round-trips the new message schema fields (id / at / toolCalls / edits /
// appliedAt / appliedTarget / rolledBackAt / auto + top-level pendingEdits)
// through the store, and covers makeMessageId / normalizeMessageShape directly
// so legacy message migration is verified without spinning up the popup's
// browser deps.

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    createMgSchemaSessionStore,
    makeMessageId,
    normalizeMessageShape,
    MG_SIDECAR_NAMESPACE,
    MG_GLOBAL_BUCKET_KEY,
} from '../../public/scripts/extensions/memory-graph/schema-iteration/session-store.js';

function makeStubs({ scope = 'global', avatar = null, initialSidecar = null } = {}) {
    const sidecars = {};
    if (initialSidecar && avatar) sidecars[`${avatar}:${MG_SIDECAR_NAMESPACE}`] = initialSidecar;
    const settingsRoot = {};
    return {
        getMgSettingsRoot: () => settingsRoot,
        persistSettings: jest.fn(),
        computeScope: () => scope === 'character' && avatar ? `character_${avatar}` : 'global',
        ctx: {
            getCharacterState: jest.fn(async (a, ns) => sidecars[`${a}:${ns}`] || null),
            updateCharacterState: jest.fn(async (a, ns, updater) => {
                const current = sidecars[`${a}:${ns}`] || null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                sidecars[`${a}:${ns}`] = next;
                return { ok: true, state: next, updated: true };
            }),
        },
        sidecars,
        settingsRoot,
    };
}

describe('createMgSchemaSessionStore — global scope uses settings, character scope uses sidecar', () => {
    test('global scope save writes into extension_settings.memory_graph.schema_iter_global_sessions', async () => {
        const stubs = makeStubs({ scope: 'global' });
        const store = createMgSchemaSessionStore(stubs);
        await store.save({ id: 's1', title: 'Global', updatedAt: 1 });
        expect(stubs.settingsRoot[MG_GLOBAL_BUCKET_KEY].s1.id).toBe('s1');
        expect(stubs.persistSettings).toHaveBeenCalled();
        expect(stubs.ctx.updateCharacterState).not.toHaveBeenCalled();
    });

    test('character scope save writes to the sidecar', async () => {
        const stubs = makeStubs({ scope: 'character', avatar: 'alice.png' });
        const store = createMgSchemaSessionStore(stubs);
        await store.save({ id: 's2', title: 'Per-char', updatedAt: 2 });
        expect(stubs.sidecars[`alice.png:${MG_SIDECAR_NAMESPACE}`].sessions.s2.id).toBe('s2');
        expect(stubs.settingsRoot[MG_GLOBAL_BUCKET_KEY]).toBeUndefined();
    });

    test('list under character scope reads only sidecar contents', async () => {
        const initial = { version: 1, sessions: { 'sa': { id: 'sa', title: 'A', updatedAt: 1 } } };
        const stubs = makeStubs({ scope: 'character', avatar: 'alice.png', initialSidecar: initial });
        const store = createMgSchemaSessionStore(stubs);
        const metas = await store.list();
        expect(metas).toEqual([{ id: 'sa', title: 'A', updatedAt: 1 }]);
    });

    test('list under global scope ignores the sidecar', async () => {
        const stubs = makeStubs({ scope: 'global' });
        stubs.settingsRoot[MG_GLOBAL_BUCKET_KEY] = { 'g1': { id: 'g1', title: 'Global', updatedAt: 5 } };
        const store = createMgSchemaSessionStore(stubs);
        const metas = await store.list();
        expect(metas).toEqual([{ id: 'g1', title: 'Global', updatedAt: 5 }]);
        expect(stubs.ctx.getCharacterState).not.toHaveBeenCalled();
    });

    test('delete under character scope strips the id from the sidecar map', async () => {
        const initial = { version: 1, sessions: { 's1': { id: 's1', updatedAt: 1 } } };
        const stubs = makeStubs({ scope: 'character', avatar: 'alice.png', initialSidecar: initial });
        const store = createMgSchemaSessionStore(stubs);
        await store.delete('s1');
        expect(stubs.sidecars[`alice.png:${MG_SIDECAR_NAMESPACE}`].sessions.s1).toBeUndefined();
    });

    test('clearObsolete is still a no-op', async () => {
        const stubs = makeStubs({ scope: 'global' });
        const store = createMgSchemaSessionStore(stubs);
        await expect(store.clearObsolete()).resolves.toBeUndefined();
    });
});

describe('MG schema — session store basic round-trip', () => {
    let stubs;
    let store;

    beforeEach(() => {
        stubs = makeStubs({ scope: 'global' });
        store = createMgSchemaSessionStore(stubs);
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
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

    test('delete removes the entry', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect((await store.list())).toEqual([]);
    });

    test('clearObsolete is a no-op (does not throw, no state change)', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        const before = JSON.stringify(stubs.settingsRoot[MG_GLOBAL_BUCKET_KEY]);
        await store.clearObsolete();
        expect(JSON.stringify(stubs.settingsRoot[MG_GLOBAL_BUCKET_KEY])).toBe(before);
    });
});

describe('MG schema session — new message schema persistence', () => {
    let stubs;
    let store;

    beforeEach(() => {
        stubs = makeStubs({ scope: 'global' });
        store = createMgSchemaSessionStore(stubs);
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
                { id: 'm1', role: 'user', content: 'Add a "Library" location', at: 100 },
                {
                    id: 'm2', role: 'assistant', content: 'Added.', at: 200,
                    toolCalls: [{ name: 'mg_schema_set_node_type', args: { node_type: { id: 'library' } } }],
                    edits: [{ op: 'set', path: '', oldValue: [], newValue: [{ id: 'library' }] }],
                    appliedAt: 300,
                    appliedTarget: 'schema',
                    rolledBackAt: null,
                },
                { id: 'm3', role: 'user', content: 'Continue', at: 400, auto: true },
            ],
            pendingEdits: [{ op: 'set', path: '', oldValue: [], newValue: [{ id: 'library' }, { id: 'event' }] }],
        };
        await store.save(session);
        const loaded = await store.load('rt-1');
        expect(loaded).not.toBeNull();
        expect(loaded.messages).toHaveLength(3);
        // Message 1: minimal shape preserved as-is.
        expect(loaded.messages[0]).toEqual(session.messages[0]);
        // Message 2: assistant turn with full tool/edit trail.
        expect(loaded.messages[1].toolCalls).toEqual(session.messages[1].toolCalls);
        expect(loaded.messages[1].edits).toEqual(session.messages[1].edits);
        expect(loaded.messages[1].appliedAt).toBe(300);
        expect(loaded.messages[1].appliedTarget).toBe('schema');
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
                toolCalls: [{ name: 'mg_schema_set_node_type', args: { node_type: { id: 'x' } } }],
                edits: [{ op: 'set', path: '', oldValue: [], newValue: [{ id: 'x' }] }],
                appliedAt: 200, appliedTarget: 'schema', rolledBackAt: 500,
            }],
        };
        await store.save(session);
        const loaded = await store.load('rb-1');
        expect(loaded.messages[0].rolledBackAt).toBe(500);
    });
});

describe('MG schema — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^mg_msg_/);
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
            toolCalls: [{ name: 'mg_schema_set_node_type' }],
            edits: [{ op: 'set', path: '', oldValue: [], newValue: [{ id: 'x' }] }],
            appliedAt: 200, appliedTarget: 'schema',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toEqual([{ name: 'mg_schema_set_node_type' }]);
        expect(n.edits).toEqual([{ op: 'set', path: '', oldValue: [], newValue: [{ id: 'x' }] }]);
        expect(n.appliedAt).toBe(200);
        expect(n.appliedTarget).toBe('schema');
        expect(n.rolledBackAt).toBe(300);
        expect(n.auto).toBe(true);
    });

    test('returns input unchanged for non-object', () => {
        expect(normalizeMessageShape(null)).toBeNull();
        expect(normalizeMessageShape(undefined)).toBeUndefined();
    });
});

describe('MG schema — makeMessageId', () => {
    test('produces unique mg_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^mg_msg_/);
        expect(b).toMatch(/^mg_msg_/);
        expect(a).not.toBe(b);
    });
});
