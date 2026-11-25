// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import {
    createSessionStore,
    groupSessions,
    titleFrom,
    SESSIONS_NAMESPACE,
    SESSIONS_INDEX_VERSION,
    sessionBodyNamespace,
} from '../../public/scripts/workbench/model/sessions.js';

function makeMockStateContext() {
    const store = {
        global: new Map(),
        character: new Map(),
        preset: new Map(),
        chat: new Map(),
    };

    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

    const runUpdate = async (map, key, updater) => {
        const cur = map.get(key) ?? null;
        const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? clone(cur) : {};
        const next = await updater(base);
        if (next == null) return { ok: true, state: base, updated: false };
        if (typeof next !== 'object' || Array.isArray(next)) {
            return { ok: false, reason: 'validation_args', hint: 'updater must return a plain object' };
        }
        map.set(key, clone(next));
        return { ok: true, state: clone(next), updated: true };
    };

    const runDelete = async (map, key) => {
        map.delete(key);
        return { ok: true };
    };

    const ctx = {
        accountStorage: {
            getItem: jest.fn(() => { throw new Error('accountStorage must not be called'); }),
            setItem: jest.fn(() => { throw new Error('accountStorage must not be called'); }),
        },
        extensionSettings: {},
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        characterId: 0,
        getCurrentChatId: () => 'chat-1',
        getGlobalState: jest.fn(async (ns) => ({ ok: true, state: clone(store.global.get(ns) ?? null) })),
        updateGlobalState: jest.fn(async (ns, updater) => runUpdate(store.global, ns, updater)),
        deleteGlobalState: jest.fn(async (ns) => runDelete(store.global, ns)),
        getCharacterState: jest.fn(async (avatar, ns) => ({ ok: true, state: clone(store.character.get(`${avatar}::${ns}`) ?? null) })),
        updateCharacterState: jest.fn(async (avatar, ns, updater) => runUpdate(store.character, `${avatar}::${ns}`, updater)),
        deleteCharacterState: jest.fn(async (avatar, ns) => runDelete(store.character, `${avatar}::${ns}`)),
        getChatState: jest.fn(async (ns, opts = {}) => {
            const targetKey = opts?.target ? JSON.stringify(opts.target) : 'active';
            return { ok: true, state: clone(store.chat.get(`${targetKey}::${ns}`) ?? null) };
        }),
        updateChatState: jest.fn(async (ns, updater, opts = {}) => {
            const targetKey = opts?.target ? JSON.stringify(opts.target) : 'active';
            return runUpdate(store.chat, `${targetKey}::${ns}`, updater);
        }),
        deleteChatState: jest.fn(async (ns, opts = {}) => {
            const targetKey = opts?.target ? JSON.stringify(opts.target) : 'active';
            return runDelete(store.chat, `${targetKey}::${ns}`);
        }),
        presets: {
            state: {
                get: jest.fn(async (ns, opts = {}) => {
                    const key = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                    return { ok: true, state: clone(store.preset.get(key) ?? null) };
                }),
                update: jest.fn(async (ns, updater, opts = {}) => {
                    const key = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                    return runUpdate(store.preset, key, updater);
                }),
                delete: jest.fn(async (ns, opts = {}) => {
                    const key = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                    return runDelete(store.preset, key);
                }),
            },
        },
    };

    return { ctx, store };
}

describe('workbench state-backed session store', () => {
    test('routes each scope to its dedicated State API, splits index from per-session bodies, and never touches accountStorage or extensionSettings', async () => {
        const { ctx, store } = makeMockStateContext();
        const sessions = createSessionStore(ctx);

        const g = await sessions.create({ kind: 'ask', title: 'Global Q' }, { scope: 'global' });
        const c = await sessions.create({ kind: 'iterate', ws: 'card', title: 'Char Iter' }, { scope: 'character', avatar: 'alice.png' });
        const p = await sessions.create({ kind: 'iterate', ws: 'preset', title: 'Preset Iter' }, { scope: 'preset', target: { collection: 'openai', name: 'MyPreset' } });
        const ch = await sessions.create({ kind: 'ask', title: 'Chat Q' }, { scope: 'chat', target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } });

        expect(ctx.updateGlobalState).toHaveBeenCalledWith(sessionBodyNamespace(g.id), expect.any(Function));
        expect(ctx.updateGlobalState).toHaveBeenCalledWith(SESSIONS_NAMESPACE, expect.any(Function));
        expect(ctx.updateCharacterState).toHaveBeenCalledWith('alice.png', sessionBodyNamespace(c.id), expect.any(Function));
        expect(ctx.updateCharacterState).toHaveBeenCalledWith('alice.png', SESSIONS_NAMESPACE, expect.any(Function));
        expect(ctx.presets.state.update).toHaveBeenCalledWith(
            sessionBodyNamespace(p.id),
            expect.any(Function),
            expect.objectContaining({ target: { collection: 'openai', name: 'MyPreset' } }),
        );
        expect(ctx.presets.state.update).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.any(Function),
            expect.objectContaining({ target: { collection: 'openai', name: 'MyPreset' } }),
        );
        expect(ctx.updateChatState).toHaveBeenCalledWith(
            sessionBodyNamespace(ch.id),
            expect.any(Function),
            expect.objectContaining({ target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } }),
        );
        expect(ctx.updateChatState).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.any(Function),
            expect.objectContaining({ target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } }),
        );

        // Index holds only lightweight summaries (no turns/messages)
        const globalIndex = store.global.get(SESSIONS_NAMESPACE);
        expect(globalIndex.version).toBe(SESSIONS_INDEX_VERSION);
        expect(globalIndex.sessions).toHaveLength(1);
        expect(globalIndex.sessions[0].turns).toBeUndefined();
        expect(globalIndex.sessions[0].messages).toBeUndefined();
        expect(store.global.get(sessionBodyNamespace(g.id)).turns).toEqual([]);

        // list() reads ONLY the index namespace, never per-session bodies
        ctx.getGlobalState.mockClear();
        ctx.getCharacterState.mockClear();
        ctx.presets.state.get.mockClear();
        ctx.getChatState.mockClear();

        expect((await sessions.list(null, { scope: 'global' })).map(s => s.id)).toEqual([g.id]);
        expect((await sessions.list(null, { scope: 'character', avatar: 'alice.png' })).map(s => s.id)).toEqual([c.id]);
        expect((await sessions.list(null, { scope: 'preset', target: { collection: 'openai', name: 'MyPreset' } })).map(s => s.id)).toEqual([p.id]);
        expect((await sessions.list(null, { scope: 'chat', target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } })).map(s => s.id)).toEqual([ch.id]);

        expect(ctx.getGlobalState).toHaveBeenCalledTimes(1);
        expect(ctx.getGlobalState).toHaveBeenCalledWith(SESSIONS_NAMESPACE);
        expect(ctx.getCharacterState).toHaveBeenCalledTimes(1);
        expect(ctx.getCharacterState).toHaveBeenCalledWith('alice.png', SESSIONS_NAMESPACE);
        expect(ctx.presets.state.get).toHaveBeenCalledTimes(1);
        expect(ctx.presets.state.get).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.objectContaining({ target: { collection: 'openai', name: 'MyPreset' } }),
        );
        expect(ctx.getChatState).toHaveBeenCalledTimes(1);
        expect(ctx.getChatState).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.objectContaining({ target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } }),
        );

        // get() reads ONLY the target session's body namespace without touching the index
        ctx.getGlobalState.mockClear();
        const loadedG = await sessions.get(g.id, { scope: 'global' });
        expect(loadedG.id).toBe(g.id);
        expect(loadedG.turns).toEqual([]);
        expect(ctx.getGlobalState).toHaveBeenCalledTimes(1);
        expect(ctx.getGlobalState).toHaveBeenCalledWith(sessionBodyNamespace(g.id));

        expect(ctx.accountStorage.getItem).not.toHaveBeenCalled();
        expect(ctx.accountStorage.setItem).not.toHaveBeenCalled();
        expect(ctx.extensionSettings).toEqual({});
    });

    test('preserves 300 KB turn and tool call payloads verbatim in body namespace while keeping index tiny', async () => {
        const { ctx, store } = makeMockStateContext();
        const sessions = createSessionStore(ctx);

        const payload300k = 'Z'.repeat(300 * 1024);
        const reasoning100k = 'R'.repeat(100 * 1024);
        const created = await sessions.create({ kind: 'ask', title: 'Huge payload' }, { scope: 'chat' });

        const updated = await sessions.update(created.id, {
            turns: [
                { role: 'user', text: 'Inspect everything', at: 1 },
                {
                    role: 'ai',
                    answer: payload300k,
                    reasoning: reasoning100k,
                    reads: [{ name: 'wb_read_chat', args: { query: payload300k }, result: payload300k, chars: payload300k.length }],
                    changes: [{ key: 'k1', kind: 'change', label: 'Temp' }],
                    state: 'pending',
                    at: 2,
                },
            ],
            messages: [
                {
                    role: 'assistant',
                    content: reasoning100k,
                    tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'wb_read_chat', arguments: JSON.stringify({ note: payload300k }) } }],
                },
                { role: 'tool', tool_call_id: 'tc1', content: payload300k },
            ],
        }, { scope: 'chat' });

        expect(updated.turns[1].answer).toBe(payload300k);
        expect(updated.turns[1].reasoning).toBe(reasoning100k);
        expect(updated.turns[1].reads[0].result).toBe(payload300k);
        expect(updated.messages[0].tool_calls[0].function.arguments).toBe(JSON.stringify({ note: payload300k }));
        expect(updated.messages[1].content).toBe(payload300k);

        // Index entry remains compact and precomputes pendingCount
        const indexDoc = store.chat.get(`active::${SESSIONS_NAMESPACE}`);
        expect(JSON.stringify(indexDoc).length).toBeLessThan(1024);
        expect(indexDoc.sessions[0].pendingCount).toBe(1);
        expect(indexDoc.sessions[0].turns).toBeUndefined();
        expect(indexDoc.sessions[0].messages).toBeUndefined();

        const reloaded = await sessions.get(created.id, { scope: 'chat' });
        expect(reloaded.turns[1].answer.length).toBe(300 * 1024);
        expect(reloaded.messages[1].content.length).toBe(300 * 1024);
    });

    test('lazily splits legacy v1 inline workbench_sessions into per-session bodies without losing data on partial write failure', async () => {
        const { ctx, store } = makeMockStateContext();
        const sessions = createSessionStore(ctx);

        const bigText = 'M'.repeat(50_000);
        store.global.set(SESSIONS_NAMESPACE, {
            sessions: [
                {
                    id: 'legacy_v1_a',
                    kind: 'iterate',
                    ws: 'orch',
                    scope: 'global',
                    title: 'Old Session A',
                    createdAt: 100,
                    updatedAt: 200,
                    turns: [
                        { role: 'user', text: 'Optimize', at: 100 },
                        { role: 'ai', text: bigText, changes: [{ key: 'c1' }, { key: 'c2' }], state: 'pending', at: 200 },
                    ],
                    messages: [{ role: 'user', content: 'Optimize' }, { role: 'assistant', content: bigText }],
                },
            ],
            legacyImported: { orch: 12345 },
        });

        // 1) If body write fails, v1 inline index must NOT be shrunk (zero data loss)
        ctx.updateGlobalState.mockResolvedValueOnce({ ok: false, reason: 'http_error', hint: 'Disk full' });
        await expect(sessions.list('iterate', { scope: 'global' })).rejects.toThrow(/Disk full/);
        const untouchedIndex = store.global.get(SESSIONS_NAMESPACE);
        expect(untouchedIndex.sessions[0].turns).toHaveLength(2);
        expect(store.global.has(sessionBodyNamespace('legacy_v1_a'))).toBe(false);

        // 2) Next list() succeeds: writes body first, then shrinks index while keeping legacyImported & pendingCount
        const listed = await sessions.list('iterate', { scope: 'global' });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            id: 'legacy_v1_a',
            title: 'Old Session A',
            pendingCount: 2,
        });
        expect(listed[0].turns).toBeUndefined();
        expect(listed[0].messages).toBeUndefined();

        const migratedIndex = store.global.get(SESSIONS_NAMESPACE);
        expect(migratedIndex.version).toBe(SESSIONS_INDEX_VERSION);
        expect(migratedIndex.legacyImported).toEqual({ orch: 12345 });
        expect(migratedIndex.sessions[0].turns).toBeUndefined();

        const migratedBody = await sessions.get('legacy_v1_a', { scope: 'global' });
        expect(migratedBody.turns[1].text).toBe(bigText);
        expect(migratedBody.messages[1].content).toBe(bigText);
    });

    test('surfaces state read and write envelope failures without swallowing errors', async () => {
        const { ctx } = makeMockStateContext();
        const sessions = createSessionStore(ctx);

        ctx.getGlobalState.mockResolvedValueOnce({ ok: false, state: null, reason: 'http_error', hint: 'HTTP 500' });
        await expect(sessions.list('ask', { scope: 'global' })).rejects.toThrow(/HTTP 500/);

        ctx.updateCharacterState.mockResolvedValueOnce({ ok: false, reason: 'conflict', hint: 'Concurrent write conflict' });
        await expect(sessions.create({ kind: 'iterate', title: 'Test' }, { scope: 'character', avatar: 'alice.png' }))
            .rejects.toThrow(/Concurrent write conflict/);
    });

    test('remove deletes both index entry and body namespace, and concurrent update does not resurrect deleted session', async () => {
        const { ctx, store } = makeMockStateContext();
        const sessions = createSessionStore(ctx);
        const a = await sessions.create({ kind: 'ask', title: 'First' }, { scope: 'global' });
        const b = await sessions.create({ kind: 'ask', title: 'Second' }, { scope: 'global' });

        expect(store.global.has(sessionBodyNamespace(a.id))).toBe(true);
        await sessions.remove(a.id, { scope: 'global' });

        expect((await sessions.list('ask', { scope: 'global' })).map(s => s.id)).toEqual([b.id]);
        expect(store.global.has(sessionBodyNamespace(a.id))).toBe(false);
        expect(ctx.deleteGlobalState).toHaveBeenCalledWith(sessionBodyNamespace(a.id));
        expect(await sessions.get(a.id, { scope: 'global' })).toBeNull();

        // Updating a deleted session returns null and leaves no orphan body
        expect(await sessions.update(a.id, { title: 'Zombie' }, { scope: 'global' })).toBeNull();
        expect(store.global.has(sessionBodyNamespace(a.id))).toBe(false);

        const now = new Date('2026-11-13T15:00:00Z').getTime();
        const groups = groupSessions([
            { id: '1', updatedAt: now - 1000 },
            { id: '2', updatedAt: now - 3 * 86400_000 },
        ], now);
        expect(groups).toHaveLength(2);
        expect(groups[0].items.map(s => s.id)).toEqual(['1']);
        expect(groups[1].items.map(s => s.id)).toEqual(['2']);
        expect(titleFrom('   Hello   world   ')).toBe('Hello world');
        expect(titleFrom('')).toBe('New conversation');
    });

    test('sessionBodyNamespace produces safe lowercase collision-free keys for long and non-ASCII ids', () => {
        const normal = sessionBodyNamespace('legacy_preset_legacy-s1');
        expect(normal).toBe('workbench_session_legacy_preset_legacy-s1');
        expect(normal.length).toBeLessThanOrEqual(96);

        const longA = sessionBodyNamespace(`Legacy Session #1 ${'x'.repeat(120)}_A`);
        const longB = sessionBodyNamespace(`Legacy Session #1 ${'x'.repeat(120)}_B`);
        expect(longA).not.toBe(longB);
        expect(longA).toMatch(/^[a-z0-9_-]+$/);
        expect(longA.length).toBeLessThanOrEqual(96);
    });
});
