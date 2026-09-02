// Solo scenario of checkpoint creation:
//
// A checkpoint chat is a new file truncated at mesId, copied from the current
// chat — the same structural transition a branch makes. Chat-state sidecars
// (floor-state commit logs, memory-graph stores) do NOT follow the chat file
// automatically, so the host must replay the branch settle/emit pair:
// settleBranchCreated(payload) BEFORE emitting CHAT_BRANCH_CREATED.
//
// Downstream handler behavior (log truncation, meta seeding) is covered by
// tests/floor-state/instance.test.js and tests/memory-graph/adapter.test.js.

import '@jest/globals';
import { loadBookmarks, calls, settleSpy, emitSpy, saveChatSpy, saveConditionalSpy } from './_mocks/checkpoint-module-stack.js';

let bookmarks;
beforeAll(async () => {
    bookmarks = await loadBookmarks({
        chat: [
            { name: 'Ari', is_user: false, is_system: false },
            { name: 'You', is_user: true, is_system: false },
            { name: 'Ari', is_user: false, is_system: false },
        ],
        characters: [{ avatar: 'chara.png', chat: 'chat-main', name: 'Ari' }],
        this_chid: 0,
        chat_metadata: {},
    });
});

test('solo checkpoint settles floor-state and emits CHAT_BRANCH_CREATED', async () => {
    const name = await bookmarks.createNewBookmark(1, { forceName: 'Ckpt A' });
    expect(name).toBe('Ckpt A');

    // Snapshot file saved to the checkpoint chat, parent recorded.
    expect(saveChatSpy).toHaveBeenCalledTimes(1);
    expect(saveChatSpy.mock.calls[0][0]).toMatchObject({
        chatName: 'Ckpt A',
        withMetadata: { main_chat: 'chat-main' },
        mesId: 1,
    });
    // Main chat persists the bookmark link afterwards.
    expect(saveConditionalSpy).toHaveBeenCalledTimes(1);

    // Same payload contract as createBranch: source = current chat file,
    // target = new checkpoint file, truncation floor = mesId.
    const expectedPayload = {
        mesId: 1,
        branchName: 'Ckpt A',
        // messages 0..1: one assistant + one user.
        assistantMessageCount: 1,
        sourceTarget: { is_group: false, avatar_url: 'chara.png', file_name: 'chat-main' },
        targetTarget: { is_group: false, avatar_url: 'chara.png', file_name: 'Ckpt A' },
    };
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy.mock.calls[0][0]).toEqual(expectedPayload);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][0]).toBe('chat_branch_created');
    expect(emitSpy.mock.calls[0][1]).toEqual(expectedPayload);

    // Contract from docs: sidecars settle BEFORE the event fans out.
    const order = calls.map(([label]) => label);
    expect(order).toEqual(['saveChat', 'settle', 'emit', 'saveConditional']);
});
