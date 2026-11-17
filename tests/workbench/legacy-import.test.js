// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import {
    readLegacySessions,
    normalizeLegacySession,
    importLegacySessionsOnce,
} from '../../public/scripts/workbench/model/legacy-import.js';
import { SESSIONS_NAMESPACE } from '../../public/scripts/workbench/model/sessions.js';

function makeMockCtx({
    characterStates = {},
    chatStates = {},
    presetStates = {},
    extensionSettings = {},
    failingReads = new Set(),
} = {}) {
    const wbChar = new Map();
    const wbChat = new Map();
    const wbPreset = new Map();
    const wbGlobal = new Map();
    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

    const runUpdate = async (map, key, updater) => {
        const cur = map.get(key) ?? null;
        const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? clone(cur) : {};
        const next = await updater(base);
        if (next == null) return { ok: true, state: base, updated: false };
        map.set(key, clone(next));
        return { ok: true, state: clone(next), updated: true };
    };

    const ctx = {
        extensionSettings: clone(extensionSettings),
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        characterId: 0,
        getCurrentChatId: () => 'chat1.jsonl',
        getGlobalState: jest.fn(async (ns) => ({ ok: true, state: clone(wbGlobal.get(ns) ?? null) })),
        updateGlobalState: jest.fn(async (ns, updater) => runUpdate(wbGlobal, ns, updater)),
        getCharacterState: jest.fn(async (avatar, ns) => {
            if (ns === SESSIONS_NAMESPACE) {
                return { ok: true, state: clone(wbChar.get(`${avatar}::${ns}`) ?? null) };
            }
            const key = `${avatar}::${ns}`;
            if (failingReads.has(key)) throw new Error('Sidecar read exploded');
            if (!(key in characterStates)) return { ok: true, state: null };
            return { ok: true, state: clone(characterStates[key]) };
        }),
        updateCharacterState: jest.fn(async (avatar, ns, updater) => runUpdate(wbChar, `${avatar}::${ns}`, updater)),
        getChatState: jest.fn(async (ns, opts = {}) => {
            if (ns === SESSIONS_NAMESPACE) {
                const k = `${JSON.stringify(opts?.target ?? 'active')}::${ns}`;
                return { ok: true, state: clone(wbChat.get(k) ?? null) };
            }
            const k = `${JSON.stringify(opts?.target ?? 'active')}::${ns}`;
            if (failingReads.has(k)) return { ok: false, state: null, reason: 'http_error', hint: '500' };
            return { ok: true, state: clone(chatStates[k] ?? null) };
        }),
        updateChatState: jest.fn(async (ns, updater, opts = {}) => {
            const k = `${JSON.stringify(opts?.target ?? 'active')}::${ns}`;
            return runUpdate(wbChat, k, updater);
        }),
        presets: {
            state: {
                get: jest.fn(async (ns, opts = {}) => {
                    if (ns === SESSIONS_NAMESPACE) {
                        const k = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                        return { ok: true, state: clone(wbPreset.get(k) ?? null) };
                    }
                    const k = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                    if (failingReads.has(k)) return { ok: false, state: null, reason: 'corrupt', hint: 'bad json' };
                    return { ok: true, state: clone(presetStates[k] ?? null) };
                }),
                update: jest.fn(async (ns, updater, opts = {}) => {
                    const k = `${JSON.stringify(opts?.target ?? 'selected')}::${ns}`;
                    return runUpdate(wbPreset, k, updater);
                }),
            },
        },
    };

    return { ctx, wbChar, wbChat, wbPreset, wbGlobal };
}

describe('workbench legacy iter-studio import', () => {
    test('reads legacy messages (role, content, toolCalls, reasoning) from character, chat, and preset sidecars once and marks import flag', async () => {
        const chatTarget = { is_group: false, avatar_url: 'alice.png', file_name: 'chat1.jsonl' };
        const presetRef = { collection: 'openai', name: 'MyPreset' };

        const { ctx, wbChar, wbChat, wbPreset } = makeMockCtx({
            characterStates: {
                'alice.png::character_editor_assistant_iter_sessions': {
                    version: 1,
                    sessions: {
                        s1: {
                            id: 's1',
                            title: 'Refine Alice card',
                            updatedAt: 1700000100000,
                            proposalBus: { version: 3, entries: [{ id: 'stale_p1' }] },
                            pendingApproval: [{ op: 'set', path: 'description' }],
                            messages: [
                                { id: 'm1', role: 'user', content: 'Make description tighter', at: 1000 },
                                { id: 'm_auto', role: 'user', auto: true, content: 'AUTO CONTINUE' },
                                { id: 'm_tool', role: 'tool', tool_call_id: 'tc1', content: '{"ok":true}' },
                                {
                                    id: 'm2',
                                    role: 'assistant',
                                    content: 'Tightened description.',
                                    reasoning: 'Removed redundant backstory lines.',
                                    toolCalls: [{ id: 'tc1', name: 'cea_edit_card', args: { field: 'description' } }],
                                    edits: [{ op: 'set', path: 'description' }],
                                    at: 2000,
                                },
                            ],
                        },
                    },
                },
            },
            chatStates: {
                [`${JSON.stringify(chatTarget)}::memory_graph__graph_iter`]: {
                    version: 1,
                    currentSessionId: 'g1',
                    sessions: {
                        g1: {
                            id: 'g1',
                            title: 'Fix missing edge',
                            updatedAt: 1700000200000,
                            pendingTailAfter: { nodes: {} },
                            messages: [
                                { role: 'user', content: 'Add relation between A and B' },
                                { role: 'assistant', content: 'Proposed edge.', reasoning: 'Checked floor 4.', toolCalls: [{ id: 'tc_g', name: 'mg_graph_propose' }] },
                            ],
                        },
                    },
                },
            },
            presetStates: {
                [`${JSON.stringify(presetRef)}::completion_preset_assistant_session`]: {
                    version: 1,
                    sessions: [
                        {
                            id: 'p1',
                            title: 'Trim style prompt',
                            updatedAt: 1700000300000,
                            surfaceState: { sessionMode: 'general' },
                            messages: [
                                { role: 'user', content: 'Trim verbosity' },
                                { role: 'assistant', content: 'Trimmed.', reasoning: 'Found duplicate rule.' },
                            ],
                        },
                    ],
                },
            },
        });

        // Pre-populate an existing workbench session in character state to ensure it is NOT overwritten
        await ctx.updateCharacterState('alice.png', SESSIONS_NAMESPACE, () => ({
            sessions: [{ id: 'existing_wb', kind: 'iterate', ws: 'card', scope: 'character', title: 'Existing WB', updatedAt: 9999999999999, turns: [] }],
        }));

        // 1) Character sidecar import
        const charRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'card',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
            scopeName: 'Alice',
        });
        expect(charRes.alreadyImported).toBe(false);
        expect(charRes.imported).toHaveLength(1);
        const importedCard = charRes.imported[0];
        expect(importedCard.title).toBe('Refine Alice card');
        expect(importedCard.messages).toEqual([
            { id: 'm1', role: 'user', content: 'Make description tighter', at: 1000 },
            {
                id: 'm2',
                role: 'assistant',
                content: 'Tightened description.',
                reasoning: 'Removed redundant backstory lines.',
                toolCalls: [{ id: 'tc1', name: 'cea_edit_card', args: { field: 'description' } }],
                at: 2000,
            },
        ]);
        expect(importedCard.proposalBus).toBeUndefined();
        expect(importedCard.pendingApproval).toBeUndefined();
        expect(importedCard.messages[1].edits).toBeUndefined();

        const charState = wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`);
        expect(charState.legacyImported.card).toBeTruthy();
        expect(charState.sessions.some(s => s.id === 'existing_wb')).toBe(true);
        expect(charState.sessions.some(s => s.legacyId === 's1')).toBe(true);

        // Second call is skipped (does not re-read legacy sidecar)
        ctx.getCharacterState.mockClear();
        const charRes2 = await importLegacySessionsOnce({
            ctx,
            targetId: 'card',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        });
        expect(charRes2.alreadyImported).toBe(true);
        expect(charRes2.imported).toEqual([]);
        expect(ctx.getCharacterState).toHaveBeenCalledTimes(1);
        expect(ctx.getCharacterState).toHaveBeenCalledWith('alice.png', SESSIONS_NAMESPACE);

        // 2) Chat sidecar import
        const chatRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'graph',
            scope: 'chat',
            scopeOpts: { scope: 'chat', target: chatTarget },
        });
        expect(chatRes.imported).toHaveLength(1);
        expect(chatRes.imported[0].messages[1]).toMatchObject({
            role: 'assistant',
            content: 'Proposed edge.',
            reasoning: 'Checked floor 4.',
            toolCalls: [{ id: 'tc_g', name: 'mg_graph_propose' }],
        });
        expect(wbChat.get(`${JSON.stringify(chatTarget)}::${SESSIONS_NAMESPACE}`).legacyImported.graph).toBeTruthy();

        // 3) Preset sidecar import
        const presetRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'preset',
            scope: 'preset',
            scopeOpts: { scope: 'preset', target: presetRef },
        });
        expect(presetRes.imported).toHaveLength(1);
        expect(presetRes.imported[0].messages[1].reasoning).toBe('Found duplicate rule.');
        expect(wbPreset.get(`${JSON.stringify(presetRef)}::${SESSIONS_NAMESPACE}`).legacyImported.preset).toBeTruthy();
    });

    test('ignores corrupt, throwing, or missing legacy blobs gracefully without overwriting workbench state', async () => {
        const presetRef = { collection: 'openai', name: 'BrokenPreset' };
        const { ctx, wbChar } = makeMockCtx({
            characterStates: {
                'alice.png::memory_graph_schema_iter_history': 'not-an-object-corrupt-blob',
                'alice.png::orchestrator_iter_studio_history': {
                    sessions: {
                        bad1: null,
                        bad2: { id: 'bad2', messages: 'not-an-array' },
                        empty: { id: 'empty', messages: [{ role: 'tool', content: 'orphan' }] },
                    },
                },
            },
            failingReads: new Set([
                `${JSON.stringify(presetRef)}::completion_preset_assistant_session`,
            ]),
        });

        await ctx.updateCharacterState('alice.png', SESSIONS_NAMESPACE, () => ({
            sessions: [{ id: 'keep_me', kind: 'iterate', ws: 'memory', scope: 'character', title: 'Keep', updatedAt: 123, turns: [] }],
        }));

        const r1 = await importLegacySessionsOnce({
            ctx,
            targetId: 'memory',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        });
        expect(r1.imported).toEqual([]);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions.map(s => s.id)).toEqual(['keep_me']);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).legacyImported.memory).toBeTruthy();

        const r2 = await importLegacySessionsOnce({
            ctx,
            targetId: 'orch',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        });
        expect(r2.imported).toEqual([]);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions.map(s => s.id)).toEqual(['keep_me']);

        // Missing or failing preset sidecar warns and does not throw
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const rawPreset = await readLegacySessions({ ctx, targetId: 'preset', scope: 'preset', target: presetRef });
        expect(rawPreset).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockClear();
        const r3 = await importLegacySessionsOnce({
            ctx,
            targetId: 'preset',
            scope: 'preset',
            scopeOpts: { scope: 'preset', target: presetRef },
        });
        expect(r3.imported).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();

        // normalizeLegacySession ignores stale blobs and null inputs
        expect(normalizeLegacySession(null, { targetId: 'card', scope: 'character' })).toBeNull();
        expect(normalizeLegacySession({ id: 'x', messages: [] }, { targetId: 'card', scope: 'character' })).toBeNull();
    });

    test('supports memory_graph targetId, orchestrator mode-nested global bucket, cross-target same legacyId, and surfaces workbench_sessions errors', async () => {
        const chatTarget = { is_group: false, avatar_url: 'alice.png', file_name: 'chat1.jsonl' };
        const { ctx, wbChar, wbChat, wbGlobal } = makeMockCtx({
            characterStates: {
                'alice.png::character_editor_assistant_iter_sessions': {
                    sessions: { s1: { id: 's1', title: 'Card s1', messages: [{ role: 'user', content: 'Card q' }] } },
                },
                'alice.png::memory_graph_schema_iter_history': {
                    sessions: { s1: { id: 's1', title: 'Memory s1', messages: [{ role: 'user', content: 'Memory q' }] } },
                },
            },
            chatStates: {
                [`${JSON.stringify(chatTarget)}::memory_graph__graph_iter`]: {
                    sessions: { mg1: { id: 'mg1', title: 'Graph chat', messages: [{ role: 'user', content: 'Fix node' }] } },
                },
            },
            extensionSettings: {
                orchestrator: {
                    iter_studio_global_sessions: {
                        spec: { o1: { id: 'o1', title: 'Orch spec', messages: [{ role: 'user', content: 'Tune spec' }] } },
                        loop: { o2: { id: 'o2', title: 'Orch loop', messages: [{ role: 'user', content: 'Tune loop' }] } },
                    },
                },
            },
        });

        // 1) memory_graph alias in chat scope
        const mgRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'memory_graph',
            scope: 'chat',
            scopeOpts: { scope: 'chat', target: chatTarget },
        });
        expect(mgRes.imported).toHaveLength(1);
        expect(mgRes.imported[0].title).toBe('Graph chat');
        expect(wbChat.get(`${JSON.stringify(chatTarget)}::${SESSIONS_NAMESPACE}`).legacyImported.memory_graph).toBeTruthy();

        // 2) orchestrator mode-nested global bucket
        const orchRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'orch',
            scope: 'global',
            scopeOpts: { scope: 'global' },
        });
        expect(orchRes.imported.map(s => s.title).sort()).toEqual(['Orch loop', 'Orch spec']);
        expect(wbGlobal.get(SESSIONS_NAMESPACE).legacyImported.orch).toBeTruthy();

        // 3) same legacyId 's1' in both card and memory under same character scope does NOT collide
        const cardRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'card',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        });
        const memRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'memory',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        });
        expect(cardRes.imported).toHaveLength(1);
        expect(memRes.imported).toHaveLength(1);
        const charSessions = wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions;
        expect(charSessions.map(s => s.title).sort()).toEqual(['Card s1', 'Memory s1']);

        // 4) workbench_sessions read/update failure surfaces error instead of silently swallowing
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        ctx.getGlobalState.mockResolvedValueOnce({ ok: false, state: null, reason: 'http_error', hint: 'WB store down' });
        await expect(importLegacySessionsOnce({
            ctx,
            targetId: 'memory',
            scope: 'global',
            scopeOpts: { scope: 'global' },
        })).rejects.toThrow(/WB store down/);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('deduplicates identical legacy sessions across multiple sidecars for the same target within one batch', async () => {
        const { ctx, wbChar } = makeMockCtx({
            characterStates: {
                'alice.png::character_editor_assistant_iter_sessions': {
                    sessions: {
                        dup_s1: { id: 'dup_s1', title: 'First copy', updatedAt: 100, messages: [{ role: 'user', content: 'Q1' }] },
                    },
                },
                'alice.png::character_editor_assistant_sessions': {
                    sessions: {
                        dup_s1: { id: 'dup_s1', title: 'Duplicate copy', updatedAt: 200, messages: [{ role: 'user', content: 'Q1 dup' }] },
                        uniq_s2: { id: 'uniq_s2', title: 'Second unique', updatedAt: 300, messages: [{ role: 'user', content: 'Q2' }] },
                    },
                },
            },
        });

        const res = await importLegacySessionsOnce({
            ctx,
            targetId: 'card',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
            scopeName: 'Alice',
        });

        expect(res.imported).toHaveLength(2);
        expect(res.imported.map(s => s.id)).toEqual(['legacy_card_dup_s1', 'legacy_card_uniq_s2']);
        const storedIds = wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions.map(s => s.id);
        expect(storedIds).toEqual(['legacy_card_dup_s1', 'legacy_card_uniq_s2']);
    });
});
