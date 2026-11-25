// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, jest, test, beforeEach } from '@jest/globals';

globalThis.toastr = {
    error: jest.fn(),
    warning: jest.fn(),
    success: jest.fn(),
    info: jest.fn(),
};

const deleteWorldBookSpy = jest.fn(async () => true);
const rebindSpy = jest.fn(async () => {});
const loadWorldInfoMock = jest.fn(async () => ({ entries: {} }));

const sharedCtx = {
    characters: [],
    characterId: 0,
    getWorldInfoNames: () => ['OldBook'],
    loadWorldInfo: loadWorldInfoMock,
    rebindPreviousPrimaryBook: rebindSpy,
    deleteWorldBook: deleteWorldBookSpy,
    importEmbeddedBookForCharacter: null,
};

globalThis.Luker = { getContext: () => sharedCtx };

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    createScopedI18n: () => ({ i18n: (s) => String(s ?? ''), i18nFormat: (s, ...args) => args.reduce((acc, v, i) => acc.replace(`\${${i}}`, String(v)), String(s ?? '')) }),
}));

const { buildPostReplaceMergeAction } = await import('../../public/scripts/extensions/character-editor-assistant/post-replace/merge-action.js');

function makeNextChar() {
    return {
        avatar: 'a.png',
        name: 'Alice',
        data: {
            extensions: { world: 'NewBook' },
            character_book: { name: 'NewBook', entries: [{ keys: ['k'], content: 'c' }] },
        },
    };
}

describe('post-replace merge-action rollback covers seed & lorebook resolution throws', () => {
    beforeEach(() => {
        deleteWorldBookSpy.mockClear().mockResolvedValue(true);
        rebindSpy.mockClear().mockResolvedValue(undefined);
        loadWorldInfoMock.mockReset().mockResolvedValue({ entries: {} });
        globalThis.toastr.error.mockClear();
        globalThis.toastr.warning.mockClear();
        globalThis.toastr.success.mockClear();
    });

    test('rolls back newly imported world book when buildPostReplaceSeedMessage throws (loadWorldInfo fails)', async () => {
        const nextChar = makeNextChar();
        const ownership = { isCurrent: () => true, world: { version: 'v-seed-fail' } };
        sharedCtx.characters = [nextChar];
        sharedCtx.importEmbeddedBookForCharacter = jest.fn(async () => ({
            imported: true,
            bound: true,
            bookName: 'NewBook',
            ownership,
        }));
        loadWorldInfoMock.mockRejectedValueOnce(new Error('seed world load failed'));

        const openSpy = jest.fn(async () => true);
        const action = buildPostReplaceMergeAction({ openCharacterEditorPopup: openSpy });

        await expect(action.run({
            characterId: 0,
            character: nextChar,
            previousCharacter: { avatar: 'a.png', name: 'Alice', data: { extensions: { world: 'OldBook' } } },
            previousLorebookSnapshot: { bookName: 'OldBook', entries: {} },
        })).rejects.toThrow('seed world load failed');

        expect(openSpy).not.toHaveBeenCalled();
        expect(rebindSpy).toHaveBeenCalledWith(0, 'OldBook', nextChar, { ownership });
        expect(deleteWorldBookSpy).toHaveBeenCalledWith('NewBook', { expectedVersion: 'v-seed-fail', onlyIfUnbound: true });
    });

    test('rolls back newly imported world book when resolvePostReplaceNextLorebookData throws', async () => {
        const nextChar = makeNextChar();
        const ownership = { isCurrent: () => true, world: { version: 'v-next-fail' } };
        sharedCtx.characters = [nextChar];
        sharedCtx.importEmbeddedBookForCharacter = jest.fn(async () => ({
            imported: true,
            bound: true,
            bookName: 'NewBook',
            ownership,
        }));
        // First call succeeds inside buildPostReplaceSeedMessage; second call throws inside resolvePostReplaceNextLorebookData
        loadWorldInfoMock
            .mockResolvedValueOnce({ entries: {} })
            .mockRejectedValueOnce(new Error('next lorebook load failed'));

        const openSpy = jest.fn(async () => true);
        const action = buildPostReplaceMergeAction({ openCharacterEditorPopup: openSpy });

        await expect(action.run({
            characterId: 0,
            character: nextChar,
            previousCharacter: { avatar: 'a.png', name: 'Alice', data: { extensions: { world: 'OldBook' } } },
            previousLorebookSnapshot: { bookName: 'OldBook', entries: {} },
        })).rejects.toThrow('next lorebook load failed');

        expect(openSpy).not.toHaveBeenCalled();
        expect(rebindSpy).toHaveBeenCalledWith(0, 'OldBook', nextChar, { ownership });
        expect(deleteWorldBookSpy).toHaveBeenCalledWith('NewBook', { expectedVersion: 'v-next-fail', onlyIfUnbound: true });
    });
});
