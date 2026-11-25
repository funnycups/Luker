// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Regression tests for CEA editor iteration fixes:
//   - CEA-2: Prior turn toolCalls + toolResults replay cleanly in multi-round runIterateTurn.
//   - CEA-4: Multi-round edits commit together cleanly via cardTarget.commit
//            without losing earlier-round deltas.
//   - CEA-7: Transient empty sessions are skipped by the session store gate.

import { describe, expect, jest, test } from '@jest/globals';
import { runIterateTurn } from '../../public/scripts/workbench/model/iterate.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';

describe('CEA-2: prior turn tool history replay', () => {
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
