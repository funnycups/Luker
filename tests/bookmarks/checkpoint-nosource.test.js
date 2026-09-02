// Degenerate scenario: the character carries no current chat file (e.g.
// right after import), so no source sidecar exists. The checkpoint itself
// must still save; the settle/emit pair must NOT fire.

import '@jest/globals';
import { loadBookmarks, settleSpy, emitSpy, saveChatSpy, saveConditionalSpy } from './_mocks/checkpoint-module-stack.js';

let bookmarks;
beforeAll(async () => {
    bookmarks = await loadBookmarks({
        characters: [{ avatar: 'chara.png', chat: '', name: 'Ari' }],
        chat: [{ name: 'Ari', is_user: false, is_system: false }],
        this_chid: 0,
        chat_metadata: {},
    });
});

test('checkpoint without a resolvable source target still saves, but skips the event', async () => {
    const name = await bookmarks.createNewBookmark(0, { forceName: 'Ckpt C' });
    expect(name).toBe('Ckpt C');
    expect(saveChatSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(saveConditionalSpy).toHaveBeenCalledTimes(1);
});
