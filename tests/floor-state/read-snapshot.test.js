// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { readFloorStateSnapshot } from '../../public/scripts/floor-state.js';
import { STATE_ERROR_REASONS } from '../../public/scripts/state-errors.js';

function makeReadOnlyDeps({
    chatId = 'chat-1',
    chat = [{ swipe_id: 0 }, { swipe_id: 1 }],
    storeData = {},
} = {}) {
    const store = new Map(Object.entries(storeData).map(([k, v]) => [k.toLowerCase(), structuredClone(v)]));
    const getChatState = jest.fn(async (ns) => {
        const key = String(ns || '').trim().toLowerCase();
        return { ok: true, state: store.has(key) ? structuredClone(store.get(key)) : null };
    });
    const updateChatState = jest.fn(async () => {
        throw new Error('readFloorStateSnapshot must never call updateChatState');
    });
    const deleteChatState = jest.fn(async () => {
        throw new Error('readFloorStateSnapshot must never call deleteChatState');
    });
    const patchChatState = jest.fn(async () => {
        throw new Error('readFloorStateSnapshot must never call patchChatState');
    });
    return {
        deps: {
            getChatState,
            updateChatState,
            deleteChatState,
            patchChatState,
            getChat: () => chat,
            getCurrentChatId: () => chatId,
        },
        spies: { getChatState, updateChatState, deleteChatState, patchChatState },
    };
}

describe('readFloorStateSnapshot', () => {
    test('replays floor commit log in memory according to active chat swipes without triggering writes', async () => {
        const { deps, spies } = makeReadOnlyDeps({
            chatId: 'chat-alpha',
            chat: [{ swipe_id: 0 }, { swipe_id: 1 }],
            storeData: {
                luker_orch_loop_notes__floor_log: {
                    version: 1,
                    commits: [
                        {
                            floor: 0,
                            swipeId: 0,
                            patches: [{ op: 'add', path: '/entries', value: [{ id: 'n1', status: 'open', text: 'floor 0 note' }] }],
                        },
                        {
                            floor: 1,
                            swipeId: 0,
                            patches: [{ op: 'add', path: '/entries/-', value: { id: 'n2-stale', status: 'open', text: 'inactive swipe 0' } }],
                        },
                        {
                            floor: 1,
                            swipeId: 1,
                            patches: [{ op: 'add', path: '/entries/-', value: { id: 'n2-active', status: 'closed', text: 'active swipe 1', closure_reason: 'done' } }],
                        },
                    ],
                },
            },
        });

        const res = await readFloorStateSnapshot({ namespace: 'luker_orch_loop_notes' }, deps);
        expect(res.ok).toBe(true);
        expect(res.state).toEqual({
            entries: [
                { id: 'n1', status: 'open', text: 'floor 0 note' },
                { id: 'n2-active', status: 'closed', text: 'active swipe 1', closure_reason: 'done' },
            ],
        });
        expect(spies.getChatState).toHaveBeenCalledTimes(1);
        expect(spies.getChatState).toHaveBeenCalledWith('luker_orch_loop_notes__floor_log');
        expect(spies.updateChatState).not.toHaveBeenCalled();
        expect(spies.deleteChatState).not.toHaveBeenCalled();
        expect(spies.patchChatState).not.toHaveBeenCalled();
    });

    test('returns NO_CHAT immediately when there is no active chat', async () => {
        const { deps, spies } = makeReadOnlyDeps({ chatId: '', chat: [] });

        const res = await readFloorStateSnapshot({ namespace: 'luker_orch_loop_notes' }, deps);
        expect(res).toEqual({ ok: false, state: null, reason: 'NO_CHAT' });
        expect(spies.getChatState).not.toHaveBeenCalled();
        expect(spies.updateChatState).not.toHaveBeenCalled();
        expect(spies.deleteChatState).not.toHaveBeenCalled();
    });

    test('falls back to legacy unmigrated namespace when floor log is empty without migrating or writing', async () => {
        const { deps, spies } = makeReadOnlyDeps({
            chatId: 'chat-legacy',
            chat: [{ swipe_id: 0 }],
            storeData: {
                luker_orch_loop_notes: {
                    entries: ['bare legacy note', { id: 'old-1', status: 'open', text: 'legacy object note' }],
                },
            },
        });

        const res = await readFloorStateSnapshot({ namespace: 'luker_orch_loop_notes' }, deps);
        expect(res.ok).toBe(true);
        expect(res.state).toEqual({
            entries: ['bare legacy note', { id: 'old-1', status: 'open', text: 'legacy object note' }],
        });
        expect(spies.getChatState).toHaveBeenNthCalledWith(1, 'luker_orch_loop_notes__floor_log');
        expect(spies.getChatState).toHaveBeenNthCalledWith(2, 'luker_orch_loop_notes');
        expect(spies.updateChatState).not.toHaveBeenCalled();
        expect(spies.deleteChatState).not.toHaveBeenCalled();
        expect(spies.patchChatState).not.toHaveBeenCalled();
    });

    test('returns REPLAY_BROKEN on corrupt log patch without truncating or writing orphans', async () => {
        const { deps, spies } = makeReadOnlyDeps({
            chatId: 'chat-broken',
            chat: [{ swipe_id: 0 }],
            storeData: {
                luker_orch_loop_notes__floor_log: {
                    version: 1,
                    commits: [
                        {
                            floor: 0,
                            swipeId: 0,
                            patches: [{ op: 'replace', path: '/nonexistent/deep/key', value: 'boom' }],
                        },
                    ],
                },
            },
        });

        const res = await readFloorStateSnapshot({ namespace: 'luker_orch_loop_notes' }, deps);
        expect(res.ok).toBe(false);
        expect(res.state).toBeNull();
        expect(res.reason).toBe(STATE_ERROR_REASONS.REPLAY_BROKEN);
        expect(spies.updateChatState).not.toHaveBeenCalled();
        expect(spies.deleteChatState).not.toHaveBeenCalled();
        expect(spies.patchChatState).not.toHaveBeenCalled();
    });

    test('rejects empty namespace or namespace ending with __floor_log', async () => {
        const { deps, spies } = makeReadOnlyDeps();

        const emptyRes = await readFloorStateSnapshot({ namespace: '' }, deps);
        expect(emptyRes.ok).toBe(false);
        expect(emptyRes.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);

        const suffixRes = await readFloorStateSnapshot({ namespace: 'notes__floor_log' }, deps);
        expect(suffixRes.ok).toBe(false);
        expect(suffixRes.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);

        expect(spies.getChatState).not.toHaveBeenCalled();
    });
});
