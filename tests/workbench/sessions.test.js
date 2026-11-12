// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { createSessionStore, groupSessions, titleFrom, SESSIONS_NAMESPACE } from '../../public/scripts/workbench/model/sessions.js';

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
        getCharacterState: jest.fn(async (avatar, ns) => ({ ok: true, state: clone(store.character.get(`${avatar}::${ns}`) ?? null) })),
        updateCharacterState: jest.fn(async (avatar, ns, updater) => runUpdate(store.character, `${avatar}::${ns}`, updater)),
        getChatState: jest.fn(async (ns, opts = {}) => {
            const targetKey = opts?.target ? JSON.stringify(opts.target) : 'active';
            return { ok: true, state: clone(store.chat.get(`${targetKey}::${ns}`) ?? null) };
        }),
        updateChatState: jest.fn(async (ns, updater, opts = {}) => {
            const targetKey = opts?.target ? JSON.stringify(opts.target) : 'active';
            return runUpdate(store.chat, `${targetKey}::${ns}`, updater);
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
            },
        },
    };

    return { ctx, store };
}

describe('workbench state-backed session store', () => {
    test('routes each scope to its dedicated State API and never touches accountStorage or extensionSettings', async () => {
        const { ctx } = makeMockStateContext();
        const sessions = createSessionStore(ctx);

        const g = await sessions.create({ kind: 'ask', title: 'Global Q' }, { scope: 'global' });
        const c = await sessions.create({ kind: 'iterate', title: 'Char Iter' }, { scope: 'character', avatar: 'alice.png' });
        const p = await sessions.create({ kind: 'iterate', title: 'Preset Iter' }, { scope: 'preset', target: { collection: 'openai', name: 'MyPreset' } });
        const ch = await sessions.create({ kind: 'ask', title: 'Chat Q' }, { scope: 'chat', target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } });

        expect(ctx.updateGlobalState).toHaveBeenCalledWith(SESSIONS_NAMESPACE, expect.any(Function));
        expect(ctx.updateCharacterState).toHaveBeenCalledWith('alice.png', SESSIONS_NAMESPACE, expect.any(Function));
        expect(ctx.presets.state.update).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.any(Function),
            expect.objectContaining({ target: { collection: 'openai', name: 'MyPreset' } }),
        );
        expect(ctx.updateChatState).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.any(Function),
            expect.objectContaining({ target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } }),
        );

        expect((await sessions.list(null, { scope: 'global' })).map(s => s.id)).toEqual([g.id]);
        expect((await sessions.list(null, { scope: 'character', avatar: 'alice.png' })).map(s => s.id)).toEqual([c.id]);
        expect((await sessions.list(null, { scope: 'preset', target: { collection: 'openai', name: 'MyPreset' } })).map(s => s.id)).toEqual([p.id]);
        expect((await sessions.list(null, { scope: 'chat', target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } })).map(s => s.id)).toEqual([ch.id]);

        expect(ctx.getGlobalState).toHaveBeenCalledWith(SESSIONS_NAMESPACE);
        expect(ctx.getCharacterState).toHaveBeenCalledWith('alice.png', SESSIONS_NAMESPACE);
        expect(ctx.presets.state.get).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.objectContaining({ target: { collection: 'openai', name: 'MyPreset' } }),
        );
        expect(ctx.getChatState).toHaveBeenCalledWith(
            SESSIONS_NAMESPACE,
            expect.objectContaining({ target: { avatar_url: 'alice.png', file_name: 'chat1.jsonl' } }),
        );

        expect(ctx.accountStorage.getItem).not.toHaveBeenCalled();
        expect(ctx.accountStorage.setItem).not.toHaveBeenCalled();
        expect(ctx.extensionSettings).toEqual({});
    });

    test('preserves 300 KB turn and tool call payloads verbatim with zero truncation or eviction', async () => {
        const { ctx } = makeMockStateContext();
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

        const reloaded = await sessions.get(created.id, { scope: 'chat' });
        expect(reloaded.turns[1].answer.length).toBe(300 * 1024);
        expect(reloaded.messages[1].content.length).toBe(300 * 1024);
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

    test('supports remove and Today / Earlier grouping + titleFrom helpers', async () => {
        const { ctx } = makeMockStateContext();
        const sessions = createSessionStore(ctx);
        const a = await sessions.create({ kind: 'ask', title: 'First' }, { scope: 'global' });
        const b = await sessions.create({ kind: 'ask', title: 'Second' }, { scope: 'global' });

        await sessions.remove(a.id, { scope: 'global' });
        expect((await sessions.list('ask', { scope: 'global' })).map(s => s.id)).toEqual([b.id]);

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
});
