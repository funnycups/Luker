// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Regression tests for CEA editor iteration fixes:
//   - CEA-2: Prior turn toolCalls + toolResults replay cleanly (both in
//            legacy-import normalization and in multi-round runIterateTurn).
//   - CEA-4: Multi-round edits commit together cleanly via cardTarget.commit
//            without losing earlier-round deltas.
//   - CEA-7: Transient empty sessions are skipped by the session store gate.

import { describe, expect, jest, test } from '@jest/globals';
import { normalizeLegacyMessage } from '../../public/scripts/workbench/model/legacy-import.js';
import { runIterateTurn } from '../../public/scripts/workbench/model/iterate.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';
import { createUnifiedCeaEditorSessionStore } from '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-store.js';

describe('CEA-2: prior turn tool history replay', () => {
    test('normalizeLegacyMessage preserves toolCalls + merged toolResults and strips auto-continue fillers', () => {
        const userMsg = normalizeLegacyMessage({ role: 'user', content: 'list the books' });
        expect(userMsg).toMatchObject({ role: 'user', content: 'list the books' });

        const filler = normalizeLegacyMessage({ role: 'user', content: 'AUTO', auto: true });
        expect(filler).toBeNull();

        const assistant = normalizeLegacyMessage({
            role: 'assistant',
            content: 'reading…',
            toolCalls: [
                { id: 'r1', name: 'world_book_list', args: {} },
                { id: 'r2', name: 'lorebook_query', args: { book_name: 'A', text: 'x' } },
            ],
            toolResults: [
                { tool_call_id: 'r1', content: { books: ['A', 'B'] } },
                { tool_call_id: 'r2', content: { matches: [1, 2] } },
            ],
        });
        expect(assistant.role).toBe('assistant');
        expect(assistant.toolCalls).toHaveLength(2);
        expect(assistant.toolCalls[0].result).toEqual({ books: ['A', 'B'] });
        expect(assistant.toolCalls[1].result).toEqual({ matches: [1, 2] });
    });

    test('runIterateTurn threads tool_calls + tool_results into subsequent rounds', async () => {
        const ctx = {
            characterId: 0,
            characters: [{
                avatar: 'a.png',
                name: 'Alice',
                description: 'old',
                data: { name: 'Alice', description: 'old', extensions: { world: 'BookA' } },
            }],
            loadWorldInfo: async (n) => (n === 'BookA' ? { entries: { 0: { uid: 0, content: 'entry text' } } } : null),
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);

        let seenInRound2 = null;
        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'read then edit' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async (msgs) => {
                round++;
                if (round === 1) {
                    return { text: 'reading', calls: [{ id: 'r1', name: 'world_book_list', args: {} }] };
                }
                if (round === 2) {
                    seenInRound2 = structuredClone(msgs);
                    return { text: 'done', calls: [] };
                }
                return { text: '', calls: [] };
            },
        });

        expect(seenInRound2.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true);
        expect(seenInRound2.some(m => m.role === 'tool' && m.tool_call_id === 'r1')).toBe(true);
        expect(result.toolCalls[0].result).toBeTruthy();
    });
});

describe('CEA-4: multi-round card edits commit together cleanly', () => {
    test('commits edits accumulated across multiple rounds via cardTarget.commit', async () => {
        const char = {
            avatar: 'a.png',
            name: 'X',
            description: 'a',
            data: { name: 'X', description: 'a', scenario: 'P', extensions: {} },
        };
        const updateSpy = jest.fn(async (_chid, patch) => {
            if (typeof patch.name === 'string') char.name = patch.name;
            if (typeof patch.description === 'string') char.description = patch.description;
            if (patch.data) Object.assign(char.data, patch.data);
        });
        const ctx = {
            characterId: 0,
            characters: [char],
            updateCharacterData: updateSpy,
            writeExtensionField: jest.fn(async () => {}),
            loadWorldInfo: async () => null,
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'update fields' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async () => {
                round++;
                if (round === 1) {
                    return { text: '', calls: [{ id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'b' } }] };
                }
                if (round === 2) {
                    return { text: '', calls: [{ id: 'e2', name: 'cea_set_card_field', args: { field: 'name', value: 'Y' } }] };
                }
                return { text: 'done', calls: [] };
            },
        });

        const keys = ['card:description', 'card:name'];
        const handle = await card.commit(loaded.target, loaded.live, card.rebuild(loaded.live, turnRes.live, keys), keys);
        expect(handle.applied).toEqual(keys);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(char.description).toBe('b');
        expect(char.name).toBe('Y');
    });
});

describe('CEA-7: session store skips transient empty sessions', () => {
    function makeStoreEnv() {
        const sidecars = {};
        const fakeCtx = {
            getCharacterState: async (a, ns) => {
                const state = sidecars[`${a}:${ns}`];
                return state ? { ok: true, state } : { ok: true, state: null };
            },
            updateCharacterState: async (a, ns, updater) => {
                const current = sidecars[`${a}:${ns}`] || null;
                const next = await updater(
                    current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {},
                    { attempt: 0, avatar: a, namespace: ns },
                );
                if (next == null) return { ok: true, state: current, updated: false };
                sidecars[`${a}:${ns}`] = next;
                return { ok: true, state: next, updated: true };
            },
        };
        return createUnifiedCeaEditorSessionStore({ context: fakeCtx, avatar: 'a.png' });
    }

    async function persistGated(store, session, pendingEdits) {
        if (
            session._transient
            && (!Array.isArray(session.messages) || session.messages.length === 0)
            && (!Array.isArray(pendingEdits) || pendingEdits.length === 0)
        ) {
            return;
        }
        if (session._transient) delete session._transient;
        await store.save(session);
    }

    test('createNewSession-style transient session does not write to the store via the wrapper', async () => {
        const store = makeStoreEnv();
        await persistGated(store, {
            id: 'sess_transient',
            title: '',
            avatar: 'a.png',
            messages: [],
            pendingEdits: [],
            surfaceState: {},
            _transient: true,
        }, []);
        expect(await store.list()).toEqual([]);
    });

    test('once messages exist the gate falls through and the session persists', async () => {
        const store = makeStoreEnv();
        await persistGated(store, {
            id: 'sess_real',
            title: '',
            avatar: 'a.png',
            messages: [{ id: 'm1', role: 'user', content: 'hi' }],
            pendingEdits: [],
            surfaceState: {},
            _transient: true,
        }, []);
        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('sess_real');
    });

    test('clear-history flow: list -> delete all -> new transient session -> no phantom row', async () => {
        const store = makeStoreEnv();
        await store.save({ id: 's1', title: 'one', avatar: 'a.png', messages: [{ id: 'm1', role: 'user', content: 'a' }], surfaceState: {} });
        await store.save({ id: 's2', title: 'two', avatar: 'a.png', messages: [{ id: 'm2', role: 'user', content: 'b' }], surfaceState: {} });

        for (const item of await store.list()) {
            await store.remove(item.id);
        }
        await persistGated(store, {
            id: 's_fresh',
            title: '',
            avatar: 'a.png',
            messages: [],
            pendingEdits: [],
            surfaceState: {},
            _transient: true,
        }, []);
        expect(await store.list()).toEqual([]);
    });
});
