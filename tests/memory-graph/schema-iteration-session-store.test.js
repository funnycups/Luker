// tests/memory-graph/schema-iteration-session-store.test.js
//
// Round-trips the new message schema fields (id / at / toolCalls / edits /
// appliedAt / appliedTarget / rolledBackAt / auto + top-level pendingEdits)
// through the MG schema-iteration session store. Also covers
// makeMessageId and normalizeMessageShape directly so legacy message
// migration is verified without spinning up the popup's browser deps.

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    createMgSchemaSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from '../../public/scripts/extensions/memory-graph/schema-iteration/session-store.js';
import { SESSIONS_BUCKET_KEY } from '../../public/scripts/extensions/memory-graph/schema-iteration/tools.js';

describe('MG schema — session store basic round-trip', () => {
    let settingsRoot;
    let store;

    beforeEach(() => {
        settingsRoot = {};
        store = createMgSchemaSessionStore({
            getMgSettingsRoot: () => settingsRoot,
            persistSettings: () => { /* no-op for tests */ },
        });
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
        const before = JSON.stringify(settingsRoot[SESSIONS_BUCKET_KEY]);
        await store.clearObsolete();
        expect(JSON.stringify(settingsRoot[SESSIONS_BUCKET_KEY])).toBe(before);
    });
});

describe('MG schema session — new message schema persistence', () => {
    let settingsRoot;
    let store;

    beforeEach(() => {
        settingsRoot = {};
        store = createMgSchemaSessionStore({
            getMgSettingsRoot: () => settingsRoot,
            persistSettings: () => { /* no-op */ },
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
