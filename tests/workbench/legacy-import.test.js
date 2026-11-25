// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import {
    readLegacySessions,
    normalizeLegacySession,
    importLegacySessionsOnce,
    cleanupLegacyGlobalSettingsSessions,
    hasLegacyGlobalSettingsSessions,
    hasLegacySettingsSessions,
} from '../../public/scripts/workbench/model/legacy-import.js';
import { SESSIONS_NAMESPACE, SESSIONS_INDEX_VERSION, sessionBodyNamespace } from '../../public/scripts/workbench/model/sessions.js';

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
        saveSettings: jest.fn(async (_delay, opts) => {
            opts?.onSaved?.();
        }),
        saveSettingsDebounced: jest.fn(),
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        characterId: 0,
        getCurrentChatId: () => 'chat1.jsonl',
        getGlobalState: jest.fn(async (ns) => ({ ok: true, state: clone(wbGlobal.get(ns) ?? null) })),
        updateGlobalState: jest.fn(async (ns, updater) => runUpdate(wbGlobal, ns, updater)),
        getCharacterState: jest.fn(async (avatar, ns) => {
            if (ns === SESSIONS_NAMESPACE || ns.startsWith('workbench_session_')) {
                return { ok: true, state: clone(wbChar.get(`${avatar}::${ns}`) ?? null) };
            }
            const key = `${avatar}::${ns}`;
            if (failingReads.has(key)) throw new Error('Sidecar read exploded');
            if (!(key in characterStates)) return { ok: true, state: null };
            return { ok: true, state: clone(characterStates[key]) };
        }),
        updateCharacterState: jest.fn(async (avatar, ns, updater) => runUpdate(wbChar, `${avatar}::${ns}`, updater)),
        getChatState: jest.fn(async (ns, opts = {}) => {
            if (ns === SESSIONS_NAMESPACE || ns.startsWith('workbench_session_')) {
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
                    if (ns === SESSIONS_NAMESPACE || ns.startsWith('workbench_session_')) {
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
    test('preserves an unopened legacy conversation with its saved title', () => {
        expect(normalizeLegacySession({
            id: 's-unopened',
            title: 'Lantern watch notes',
            createdAt: 1000,
            updatedAt: 2000,
            pendingCount: 0,
            messages: [],
        }, { targetId: 'card', scope: 'character', scopeName: 'Lantern keeper' })).toEqual({
            id: 'legacy_card_s-unopened',
            legacyId: 's-unopened',
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            scopeName: 'Lantern keeper',
            title: 'Lantern watch notes',
            createdAt: 1000,
            updatedAt: 2000,
            pendingCount: 0,
            messages: [],
            turns: [],
            importedFromLegacy: true,
        });
    });

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
        expect(charState.version).toBe(SESSIONS_INDEX_VERSION);
        expect(charState.legacyImported.card).toBeTruthy();
        expect(charState.sessions.some(s => s.id === 'existing_wb')).toBe(true);
        const importedSummary = charState.sessions.find(s => s.legacyId === 's1');
        expect(importedSummary).toBeTruthy();
        expect(importedSummary.turns).toBeUndefined();
        expect(importedSummary.messages).toBeUndefined();

        const importedBody = wbChar.get(`alice.png::${sessionBodyNamespace(importedCard.id)}`);
        expect(importedBody).toBeTruthy();
        expect(importedBody.turns).toHaveLength(2);
        expect(importedBody.messages).toHaveLength(2);

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

    test('rejects invalid or failed legacy reads without overwriting workbench history', async () => {
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

        await expect(importLegacySessionsOnce({
            ctx,
            targetId: 'memory',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        })).rejects.toThrow(/memory_graph_schema_iter_history/);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions.map(s => s.id)).toEqual(['keep_me']);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).legacyImported).toBeUndefined();

        await expect(importLegacySessionsOnce({
            ctx,
            targetId: 'orch',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
        })).rejects.toThrow(/bad2/);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).sessions.map(s => s.id)).toEqual(['keep_me']);
        expect(wbChar.get(`alice.png::${SESSIONS_NAMESPACE}`).legacyImported).toBeUndefined();

        await expect(readLegacySessions({ ctx, targetId: 'preset', scope: 'preset', target: presetRef }))
            .rejects.toThrow(/completion_preset_assistant_session.*bad json/);
        await expect(importLegacySessionsOnce({
            ctx,
            targetId: 'preset',
            scope: 'preset',
            scopeOpts: { scope: 'preset', target: presetRef },
        })).rejects.toThrow(/completion_preset_assistant_session.*bad json/);

        expect(normalizeLegacySession(null, { targetId: 'card', scope: 'character' })).toBeNull();
        expect(normalizeLegacySession({ id: 'x', messages: [] }, { targetId: 'card', scope: 'character' }))
            .toMatchObject({ legacyId: 'x', messages: [], turns: [] });
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

        // 2) orchestrator mode-nested global bucket — migrated to GlobalState AND pruned after confirmed settings save
        const orchRes = await importLegacySessionsOnce({
            ctx,
            targetId: 'orch',
            scope: 'global',
            scopeOpts: { scope: 'global' },
        });
        expect(wbGlobal.get(SESSIONS_NAMESPACE).sessions.map(s => s.title).sort()).toEqual(['Orch loop', 'Orch spec']);
        expect(wbGlobal.get(SESSIONS_NAMESPACE).legacyImported.orch).toBeTruthy();
        expect(ctx.extensionSettings.orchestrator.iter_studio_global_sessions).toBeUndefined();
        expect(ctx.saveSettings).toHaveBeenCalled();
        for (const s of orchRes.imported) {
            expect(wbGlobal.get(sessionBodyNamespace(s.id))?.turns).toHaveLength(1);
        }

        // 2b) unconfirmed settings save rolls back pruning and surfaces storage-error
        const unconfirmed = makeMockCtx({
            extensionSettings: {
                orchestrator: {
                    iter_studio_global_sessions: {
                        spec: { o1: { id: 'o1', title: 'Orch spec', messages: [{ role: 'user', content: 'Tune spec' }] } },
                    },
                },
            },
        });
        unconfirmed.ctx.saveSettings = jest.fn(async () => {});
        await expect(importLegacySessionsOnce({
            ctx: unconfirmed.ctx,
            targetId: 'orch',
            scope: 'global',
            scopeOpts: { scope: 'global' },
        })).rejects.toMatchObject({ code: 'storage-error' });
        expect(unconfirmed.wbGlobal.get(SESSIONS_NAMESPACE).legacyImported.orch).toBeTruthy();
        expect(unconfirmed.ctx.extensionSettings.orchestrator.iter_studio_global_sessions).toEqual({
            spec: { o1: { id: 'o1', title: 'Orch spec', messages: [{ role: 'user', content: 'Tune spec' }] } },
        });

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

    test('cleanupLegacyGlobalSettingsSessions skips all I/O when absent, migrates and purges legacy global buckets when present, and purges already-imported leftovers', async () => {
        // 1) No legacy keys -> zero GlobalState I/O
        const cleanMock = makeMockCtx({ extensionSettings: { memory_graph: {}, orchestrator: {} } });
        const noop = await cleanupLegacyGlobalSettingsSessions(cleanMock.ctx);
        expect(noop.cleaned).toEqual([]);
        expect(cleanMock.ctx.getGlobalState).not.toHaveBeenCalled();
        expect(cleanMock.ctx.saveSettings).not.toHaveBeenCalled();

        // 2) Legacy memory_graph global bucket present + orchestrator already marked imported from an earlier version -> both purged from settings
        const dirtyMock = makeMockCtx({
            extensionSettings: {
                memory_graph: {
                    schema_iter_global_sessions: {
                        m1: { id: 'm1', title: 'MG Global', messages: [{ role: 'user', content: 'Tune schema' }] },
                    },
                },
                orchestrator: {
                    iter_studio_global_sessions: {
                        spec: { o1: { id: 'o1', title: 'Already Imported', messages: [{ role: 'user', content: 'Old' }] } },
                    },
                },
            },
        });
        dirtyMock.wbGlobal.set(SESSIONS_NAMESPACE, {
            version: SESSIONS_INDEX_VERSION,
            sessions: [],
            legacyImported: { orch: 1700000000000 },
        });

        const cleanedRes = await cleanupLegacyGlobalSettingsSessions(dirtyMock.ctx);
        expect(cleanedRes.cleaned.sort()).toEqual(['memory', 'orch']);
        expect(dirtyMock.ctx.extensionSettings.memory_graph.schema_iter_global_sessions).toBeUndefined();
        expect(dirtyMock.ctx.extensionSettings.orchestrator.iter_studio_global_sessions).toBeUndefined();
        expect(dirtyMock.ctx.saveSettings).toHaveBeenCalled();
        expect(dirtyMock.wbGlobal.get(SESSIONS_NAMESPACE).sessions.map(s => s.id)).toEqual(['legacy_memory_m1']);
        expect(dirtyMock.wbGlobal.get(sessionBodyNamespace('legacy_memory_m1'))?.turns).toHaveLength(1);
    });

    test('imports unmigrated LEGACY_SETTINGS before pruning even when legacyImported was already set, and ignores character-only iterStudioV2 in global check', async () => {
        const charOnlyMock = makeMockCtx({
            extensionSettings: {
                orchestrator: {
                    iterStudioV2: {
                        spec: {
                            character_alice: { s1: { id: 's1', title: 'Char only', messages: [{ role: 'user', content: 'hi' }] } },
                        },
                    },
                },
            },
        });
        expect(hasLegacyGlobalSettingsSessions(charOnlyMock.ctx, 'orch')).toBe(false);

        const unmigratedMock = makeMockCtx({
            extensionSettings: {
                orchestrator: {
                    iterStudioV2: {
                        spec: {
                            global: { g1: { id: 'g1', title: 'Global v2', messages: [{ role: 'user', content: 'migrate me' }] } },
                        },
                    },
                },
            },
        });
        unmigratedMock.wbGlobal.set(SESSIONS_NAMESPACE, {
            version: SESSIONS_INDEX_VERSION,
            sessions: [],
            legacyImported: { orch: 1700000000000 },
        });
        expect(hasLegacyGlobalSettingsSessions(unmigratedMock.ctx, 'orch')).toBe(true);

        const res = await importLegacySessionsOnce({
            ctx: unmigratedMock.ctx,
            targetId: 'orch',
            scope: 'global',
            scopeOpts: { scope: 'global' },
            scopeName: 'Global',
        });
        expect(res.imported.map(s => s.id)).toEqual(['legacy_orch_g1']);
        expect(unmigratedMock.wbGlobal.get(SESSIONS_NAMESPACE).sessions.map(s => s.id)).toEqual(['legacy_orch_g1']);
        expect(unmigratedMock.ctx.extensionSettings.orchestrator.iterStudioV2).toBeUndefined();
    });

    test('hasLegacySettingsSessions detects character-scoped unified_cea_editor_sessions and iterStudioV2 per avatar without false positives on other characters', () => {
        const { ctx } = makeMockCtx({
            extensionSettings: {
                character_editor_assistant: {
                    unified_cea_editor_sessions: {
                        'char_alice.png': {
                            s1: { id: 's1', title: 'Alice CEA', messages: [{ role: 'user', content: 'hi' }] },
                        },
                    },
                },
                orchestrator: {
                    iterStudioV2: {
                        spec: {
                            'character_alice.png': {
                                o1: { id: 'o1', title: 'Alice Orch', messages: [{ role: 'user', content: 'hi' }] },
                            },
                        },
                    },
                },
            },
        });

        expect(hasLegacySettingsSessions(ctx, 'card', 'character', 'alice.png')).toBe(true);
        expect(hasLegacySettingsSessions(ctx, 'card', 'character', 'bob.png')).toBe(false);
        expect(hasLegacySettingsSessions(ctx, 'orch', 'character', 'alice.png')).toBe(true);
        expect(hasLegacySettingsSessions(ctx, 'orch', 'character', 'bob.png')).toBe(false);
        expect(hasLegacySettingsSessions(ctx, 'orch', 'global')).toBe(false);
    });

    test('importLegacySessionsOnce resets added across CAS 409 retries when another writer completes the import first', async () => {
        const { ctx, wbChar } = makeMockCtx({
            characterStates: {
                'alice.png::character_editor_assistant_iter_sessions': {
                    sessions: {
                        s1: { id: 's1', title: 'Race session', messages: [{ role: 'user', content: 'hello' }] },
                    },
                },
            },
        });

        const baseUpdate = ctx.updateCharacterState.getMockImplementation();
        let indexAttempt = 0;
        ctx.updateCharacterState = jest.fn(async (avatar, ns, updater) => {
            if (ns !== SESSIONS_NAMESPACE) {
                return baseUpdate(avatar, ns, updater);
            }
            // Simulate a 409 retry: attempt 1 computes fresh additions against empty state,
            // then a concurrent writer completes the import before attempt 2 runs.
            indexAttempt += 1;
            const firstDraft = await updater({});
            expect(firstDraft?.sessions?.map(s => s.id)).toEqual(['legacy_card_s1']);

            const concurrentState = {
                version: SESSIONS_INDEX_VERSION,
                sessions: firstDraft.sessions,
                legacyImported: { card: 1700000000001 },
                legacyImportedSettings: { card: 1700000000001 },
            };
            wbChar.set(`${avatar}::${ns}`, concurrentState);
            const secondDraft = await updater(JSON.parse(JSON.stringify(concurrentState)));
            expect(secondDraft).toBeNull();
            return { ok: true, state: concurrentState, updated: false };
        });

        const res = await importLegacySessionsOnce({
            ctx,
            targetId: 'card',
            scope: 'character',
            scopeOpts: { scope: 'character', avatar: 'alice.png' },
            scopeName: 'Alice',
        });

        expect(indexAttempt).toBe(1);
        expect(res.imported).toEqual([]);
        expect(res.alreadyImported).toBe(true);
    });

    test('legacy settings scope checks and reads stay strictly scoped to targets that own each scope bucket', async () => {
        for (const memBucket of [{}, { s1: { id: 's1', title: 'Global schema', messages: [{ role: 'user', content: 'hi' }] } }, 'corrupt']) {
            const { ctx } = makeMockCtx({
                extensionSettings: {
                    memory_graph: { iterStudioV2Schema: memBucket },
                },
            });
            expect(hasLegacySettingsSessions(ctx, 'memory', 'character', 'alice.png')).toBe(false);
            expect(hasLegacySettingsSessions(ctx, 'memory', 'global')).toBe(true);
            expect(hasLegacyGlobalSettingsSessions(ctx, 'memory')).toBe(true);

            const charImport = await importLegacySessionsOnce({
                ctx,
                targetId: 'memory',
                scope: 'character',
                scopeOpts: { scope: 'character', avatar: 'alice.png' },
                scopeName: 'Alice',
            });
            expect(charImport.imported).toEqual([]);
            expect(ctx.extensionSettings.memory_graph.iterStudioV2Schema).toEqual(memBucket);
        }

        for (const cardBucket of [
            {},
            { 'char_alice.png': { c1: { id: 'c1', title: 'Alice card', messages: [{ role: 'user', content: 'hi' }] } } },
            'corrupt',
        ]) {
            const { ctx } = makeMockCtx({
                extensionSettings: {
                    character_editor_assistant: { unified_cea_editor_sessions: cardBucket },
                },
            });
            expect(hasLegacyGlobalSettingsSessions(ctx, 'card')).toBe(false);
            expect(hasLegacySettingsSessions(ctx, 'card', 'global')).toBe(false);
            expect(hasLegacySettingsSessions(ctx, 'card', 'character', 'alice.png')).toBe(true);

            const globalImport = await importLegacySessionsOnce({
                ctx,
                targetId: 'card',
                scope: 'global',
                scopeOpts: { scope: 'global' },
                scopeName: 'Global',
            });
            expect(globalImport.imported).toEqual([]);
            expect(ctx.extensionSettings.character_editor_assistant.unified_cea_editor_sessions).toEqual(cardBucket);
        }

        const { ctx: presetCtx } = makeMockCtx({
            extensionSettings: {
                character_editor_assistant: { unified_cea_editor_sessions: {} },
                memory_graph: { iterStudioV2Schema: {} },
            },
        });
        expect(hasLegacyGlobalSettingsSessions(presetCtx, 'preset')).toBe(false);
        expect(hasLegacySettingsSessions(presetCtx, 'preset', 'global')).toBe(false);
        expect(hasLegacySettingsSessions(presetCtx, 'preset', 'character', 'alice.png')).toBe(false);
    });
});
