// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// CEA editor has no popup-side control tools — the multi-round loop is
// program-driven by tool-call presence (any tool call -> next round, none ->
// stop). `isCeaEditorControlCall` returns false for every name, and legacy
// continue/finalize tool calls do not mutate draft state.

import { describe, expect, test } from '@jest/globals';
import { isCeaEditorControlCall } from '../../public/scripts/workbench/targets/card-tools.js';
import { runIterateTurn } from '../../public/scripts/workbench/model/iterate.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';

describe('CEA editor — no control tools / legacy continue-finalize fallthrough', () => {
    test('isCeaEditorControlCall returns false for legacy continue/finalize names', () => {
        expect(isCeaEditorControlCall({ name: 'luker_cea_editor_continue_iteration' })).toBe(false);
        expect(isCeaEditorControlCall({ name: 'luker_cea_editor_finalize_iteration' })).toBe(false);
        expect(isCeaEditorControlCall({ name: 'cea_set_card_field' })).toBe(false);
    });

    test('real edit succeeds while legacy control tool names do not mutate live state', async () => {
        const ctx = {
            characterId: 0,
            characters: [{
                avatar: 'a.png',
                name: 'Alice',
                description: 'old',
                data: { name: 'Alice', description: 'old', extensions: {} },
            }],
            loadWorldInfo: async () => null,
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'update description' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: 'fallback path',
                        calls: [
                            { id: 'e1', name: 'cea_set_card_field', args: { field: 'description', value: 'updated' } },
                            { id: 'k1', name: 'luker_cea_editor_continue_iteration', args: {} },
                            { id: 'f1', name: 'luker_cea_editor_finalize_iteration', args: { summary: 'done' } },
                        ],
                    };
                }
                return { text: 'done', calls: [] };
            },
        });

        expect(result.live.character.description).toBe('updated');
        expect(result.edits.map(e => e.name)).toContain('cea_set_card_field');
        expect(result.toolCalls.map(c => c.name)).toEqual([
            'cea_set_card_field',
            'luker_cea_editor_continue_iteration',
            'luker_cea_editor_finalize_iteration',
        ]);
    });
});
