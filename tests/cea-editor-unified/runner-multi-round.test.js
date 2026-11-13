// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies CEA card target multi-round read+edit flow through `runIterateTurn`
// (`workbench/model/iterate.js`) + `createCardTarget` (`workbench/targets/card.js`):
//   - read tool -> tool_result threaded back -> edit tool -> plain text exit
//   - auto-continues past >10 rounds with no hidden round cap
//   - aborting mid-loop exits cleanly without running further rounds

import { describe, expect, test } from '@jest/globals';
import { runIterateTurn } from '../../public/scripts/workbench/model/iterate.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';

function makeCardEnv() {
    const books = {
        BookA: { entries: { 0: { uid: 0, content: 'old lore', comment: 'first', key: ['alpha'] } }, meta: {} },
    };
    const ctx = {
        characterId: 0,
        characters: [{
            avatar: 'a.png',
            name: 'Alice',
            description: 'old',
            data: { name: 'Alice', description: 'old', extensions: { world: 'BookA' } },
        }],
        loadWorldInfo: async (name) => (books[name] ? structuredClone(books[name]) : null),
        saveWorldInfo: async () => {},
        getCharaAuxWorlds: () => [],
        chatWorldInfo: { getNames: () => [] },
    };
    return { ctx, card: createCardTarget({ getContext: () => ctx }) };
}

describe('CEA card target multi-round read+edit flow', () => {
    test('runs read tool -> tool_result -> edit tool -> exits on plain text', async () => {
        const { ctx, card } = makeCardEnv();
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);

        let round = 0;
        const capturedMessages = [];
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'update BookA entry 0' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async (msgs) => {
                capturedMessages.push(structuredClone(msgs));
                round++;
                if (round === 1) {
                    return {
                        text: 'reading…',
                        calls: [{ id: 'r1', name: 'lorebook_query', args: { book_name: 'BookA', text: 'alpha' } }],
                    };
                }
                if (round === 2) {
                    return {
                        text: 'editing…',
                        calls: [{ id: 'e1', name: 'cea_update_lorebook_entry', args: { book_name: 'BookA', uid: 0, patch: { content: 'new lore' } } }],
                    };
                }
                return { text: 'all done', calls: [] };
            },
        });

        expect(round).toBe(3);
        expect(result.reads).toHaveLength(1);
        expect(result.edits).toHaveLength(1);
        expect(result.live.lorebooks.BookA.entries[0].content).toBe('new lore');
        expect(result.text).toBe('all done');
        // Round 2 saw the role:tool result from round 1's lorebook_query.
        expect(capturedMessages[1].some(m => m.role === 'tool' && m.tool_call_id === 'r1')).toBe(true);
    });

    test('auto-continues past 10 rounds when the model keeps emitting tool calls', async () => {
        const { ctx, card } = makeCardEnv();
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'go' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async () => {
                round++;
                if (round <= 15) {
                    return {
                        text: `read round ${round}`,
                        calls: [{ id: `r${round}`, name: 'lorebook_list', args: { book_name: 'BookA' } }],
                    };
                }
                return { text: 'all done', calls: [] };
            },
        });

        expect(round).toBe(16);
        expect(result.reads).toHaveLength(15);
        expect(result.text).toBe('all done');
    });

    test('aborting mid-loop exits cleanly without running further rounds', async () => {
        const { ctx, card } = makeCardEnv();
        const loaded = await card.load('character', ctx);
        const tools = await card.tools(loaded.live, 'character', ctx);
        const ac = new AbortController();

        let round = 0;
        await expect(runIterateTurn({
            messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'go' }],
            live: loaded.live,
            tools,
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async () => {
                round++;
                if (round === 1) {
                    ac.abort();
                    return {
                        text: 'first',
                        calls: [{ id: 'r1', name: 'lorebook_list', args: { book_name: 'BookA' } }],
                    };
                }
                return { text: 'should not run', calls: [] };
            },
            signal: ac.signal,
        })).rejects.toThrow(/Stopped/);

        expect(round).toBe(1);
    });
});
