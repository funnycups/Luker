// Group-chat scenario of checkpoint creation — see checkpoint-solo.test.js
// for why the branch settle/emit pair must be replayed on checkpoint.

import '@jest/globals';
import { loadBookmarks, calls, settleSpy, emitSpy, saveChatSpy, saveGroupSpy } from './_mocks/checkpoint-module-stack.js';

let bookmarks;
beforeAll(async () => {
    bookmarks = await loadBookmarks({
        selected_group: 7,
        groups: [{ id: 7, chat_id: 'group-chat', name: 'Party' }],
        chat: [
            { name: 'Ari', is_user: false, is_system: false },
            { name: 'Bo', is_user: false, is_system: false },
        ],
        // Characters still populated: getExistingChatNames() probes
        // characters[this_chid].avatar when no character is selected.
        characters: [{ avatar: 'x.png', chat: 'x', name: 'X' }],
        chat_metadata: {},
    });
});

test('group checkpoint emits with group chat targets', async () => {
    const name = await bookmarks.createNewBookmark(1, { forceName: 'Ckpt B' });
    expect(name).toBe('Ckpt B');

    expect(saveGroupSpy).toHaveBeenCalledTimes(1);
    expect(saveGroupSpy.mock.calls[0][0]).toBe(7);
    expect(saveGroupSpy.mock.calls[0][2]).toEqual({ main_chat: 'group-chat' });
    expect(saveChatSpy).not.toHaveBeenCalled();

    const expectedPayload = {
        mesId: 1,
        branchName: 'Ckpt B',
        assistantMessageCount: 2,
        sourceTarget: { is_group: true, id: 'group-chat' },
        targetTarget: { is_group: true, id: 'Ckpt B' },
    };
    expect(settleSpy.mock.calls[0][0]).toEqual(expectedPayload);
    expect(emitSpy.mock.calls[0][1]).toEqual(expectedPayload);

    const order = calls.map(([label]) => label);
    expect(order).toEqual(['saveGroup', 'settle', 'emit', 'saveConditional']);
});
