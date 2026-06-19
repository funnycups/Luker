import { describe, test, expect, jest } from '@jest/globals';
import { createUnifiedCeaEditorSessionStore, CEA_SIDECAR_NAMESPACE, makeMessageId, normalizeMessageShape } from '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-store.js';

function makeCtx({ initialSidecar = null } = {}) {
    const sidecars = {};
    if (initialSidecar) sidecars[`alice.png:${CEA_SIDECAR_NAMESPACE}`] = initialSidecar;
    return {
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
        _sidecars: sidecars,
    };
}

describe('createUnifiedCeaEditorSessionStore — per-character sidecar backend', () => {
    test('save writes a sessions map keyed by id into the sidecar', async () => {
        const ctx = makeCtx();
        const store = createUnifiedCeaEditorSessionStore({ avatar: 'alice.png', context: ctx });
        await store.save({ id: 's1', title: 'Alpha', updatedAt: 1 });
        const written = ctx._sidecars[`alice.png:${CEA_SIDECAR_NAMESPACE}`];
        expect(written.sessions.s1.id).toBe('s1');
    });

    test('list returns metas sorted by updatedAt desc', async () => {
        const ctx = makeCtx({
            initialSidecar: { version: 1, sessions: {
                's1': { id: 's1', title: 'Old', updatedAt: 1 },
                's2': { id: 's2', title: 'New', updatedAt: 5 },
            } },
        });
        const store = createUnifiedCeaEditorSessionStore({ avatar: 'alice.png', context: ctx });
        const metas = await store.list();
        expect(metas).toEqual([
            { id: 's2', title: 'New', updatedAt: 5 },
            { id: 's1', title: 'Old', updatedAt: 1 },
        ]);
    });

    test('load returns null when sidecar is empty', async () => {
        const ctx = makeCtx();
        const store = createUnifiedCeaEditorSessionStore({ avatar: 'alice.png', context: ctx });
        expect(await store.load('missing')).toBeNull();
    });

    test('delete and remove are aliases — both strip the id from sessions and rewrite', async () => {
        const ctx = makeCtx({
            initialSidecar: { version: 1, sessions: { 's1': { id: 's1', updatedAt: 1 } } },
        });
        const store = createUnifiedCeaEditorSessionStore({ avatar: 'alice.png', context: ctx });
        await store.remove('s1');
        expect(ctx._sidecars[`alice.png:${CEA_SIDECAR_NAMESPACE}`].sessions.s1).toBeUndefined();
    });

    test('throws when avatar is missing', () => {
        expect(() => createUnifiedCeaEditorSessionStore({ context: makeCtx() })).toThrow(/avatar is required/);
    });

    test('throws when context lacks getCharacterState/updateCharacterState', () => {
        expect(() => createUnifiedCeaEditorSessionStore({ avatar: 'a.png', context: {} }))
            .toThrow(/getCharacterState/);
    });
});

describe('CEA unified editor — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^cea_msg_/);
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

    test('drops empty arrays (toolCalls/toolResults/edits stay undefined)', () => {
        const n = normalizeMessageShape({ id: 'a', role: 'user', content: '', toolCalls: [], toolResults: [], edits: [] }, 1);
        expect(n.toolCalls).toBeUndefined();
        expect(n.toolResults).toBeUndefined();
        expect(n.edits).toBeUndefined();
    });

    test('preserves toolCalls/toolResults/edits/appliedAt/appliedTarget/rolledBackAt/auto when present', () => {
        const n = normalizeMessageShape({
            id: 'a', role: 'assistant', content: 'ok', at: 100,
            toolCalls: [{ id: 'c1', name: 'lorebook_query', args: { book_name: 'a', query: 'x' } }],
            toolResults: [{ tool_call_id: 'c1', content: { hits: 0 } }],
            edits: [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b', target: { kind: 'character' } }],
            appliedAt: 200, appliedTarget: 'character',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toHaveLength(1);
        expect(n.toolCalls[0].id).toBe('c1');
        expect(n.toolResults).toHaveLength(1);
        expect(n.toolResults[0].tool_call_id).toBe('c1');
        expect(n.edits).toHaveLength(1);
        expect(n.edits[0].target.kind).toBe('character');
        expect(n.appliedAt).toBe(200);
        expect(n.appliedTarget).toBe('character');
        expect(n.rolledBackAt).toBe(300);
        expect(n.auto).toBe(true);
    });

    test('returns input unchanged for non-object', () => {
        expect(normalizeMessageShape(null)).toBeNull();
        expect(normalizeMessageShape(undefined)).toBeUndefined();
    });
});

describe('CEA unified editor — makeMessageId', () => {
    test('produces unique cea_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^cea_msg_/);
        expect(b).toMatch(/^cea_msg_/);
        expect(a).not.toBe(b);
    });
});
