// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies multi-target apply & grouping across character card fields and
// multiple bound lorebooks (`BookA`, `BookB`) via `createCardTarget().commit`
// and `commitCardAndBooks` + `commitCharacterOperations` / `commitLorebookOperations`.

import { describe, expect, jest, test } from '@jest/globals';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';
import { cardEditsFor } from '../../public/scripts/workbench/model/adapters.js';

function makeEnv({ books = {}, character = {} } = {}) {
    const storedBooks = JSON.parse(JSON.stringify(books));
    const char = {
        avatar: 'alice.png',
        name: 'Alice',
        description: 'old',
        data: {
            name: 'Alice',
            description: 'old',
            extensions: { world: Object.keys(storedBooks)[0] || '' },
            ...character,
        },
        ...character,
    };
    const updateCharacterDataSpy = jest.fn(async (_chid, patch) => {
        if (typeof patch.description === 'string') char.description = patch.description;
        if (patch.data && typeof patch.data === 'object') {
            Object.assign(char.data, patch.data);
        }
    });
    const saveWorldInfoSpy = jest.fn(async (name, data) => {
        storedBooks[name] = JSON.parse(JSON.stringify(data));
    });
    const ctx = {
        characterId: 0,
        characters: [char],
        updateCharacterData: updateCharacterDataSpy,
        writeExtensionField: jest.fn(async () => {}),
        readWorldInfoDocument: async (name) => (storedBooks[name] ? JSON.parse(JSON.stringify(storedBooks[name])) : null),
        loadWorldInfo: async (name) => (storedBooks[name] ? JSON.parse(JSON.stringify(storedBooks[name])) : null),
        saveWorldInfo: saveWorldInfoSpy,
        worldInfoCache: new Map(),
        getCharaAuxWorlds: () => Object.keys(storedBooks).slice(1),
        chatWorldInfo: { getNames: () => [] },
    };
    return { ctx, storedBooks, char, updateCharacterDataSpy, saveWorldInfoSpy };
}

describe('CEA card target multi-target apply', () => {
    test('groups edits by character and per-lorebook and commits each target', async () => {
        const { ctx, storedBooks, updateCharacterDataSpy, saveWorldInfoSpy } = makeEnv({
            books: {
                BookA: { entries: { 0: { uid: 0, content: 'a' } } },
                BookB: { entries: { 0: { uid: 0, content: 'b' } } },
            },
        });
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const ai = JSON.parse(JSON.stringify(loaded.live));
        ai.character.description = 'new';
        ai.lorebooks.BookA.entries[0].content = 'a2';
        ai.lorebooks.BookB.entries[0].content = 'b2';

        const keys = ['card:description', 'wi:BookA:0', 'wi:BookB:0'];
        const handle = await card.commit(loaded.target, loaded.live, card.rebuild(loaded.live, ai, keys), keys);

        expect(handle.applied).toEqual(keys);
        expect(updateCharacterDataSpy).toHaveBeenCalledTimes(1);
        expect(saveWorldInfoSpy).toHaveBeenCalledTimes(2);
        expect(saveWorldInfoSpy.mock.calls.map(c => c[0]).sort()).toEqual(['BookA', 'BookB']);
        expect(storedBooks.BookA.entries[0].content).toBe('a2');
        expect(storedBooks.BookB.entries[0].content).toBe('b2');
    });

    test('handles character-only batch (no lorebook save invoked)', async () => {
        const { ctx, updateCharacterDataSpy, saveWorldInfoSpy } = makeEnv({
            books: { BookA: { entries: { 0: { uid: 0, content: 'a' } } } },
        });
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const ai = JSON.parse(JSON.stringify(loaded.live));
        ai.character.description = 'new';

        const handle = await card.commit(loaded.target, loaded.live, card.rebuild(loaded.live, ai, ['card:description']), ['card:description']);
        expect(handle.applied).toEqual(['card:description']);
        expect(updateCharacterDataSpy).toHaveBeenCalledTimes(1);
        expect(saveWorldInfoSpy).not.toHaveBeenCalled();
    });

    test('handles lorebook-only batch (no character commit invoked)', async () => {
        const { ctx, storedBooks, updateCharacterDataSpy, saveWorldInfoSpy } = makeEnv({
            books: { BookX: { entries: { 0: { uid: 0, content: 'old' } } } },
        });
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const ai = JSON.parse(JSON.stringify(loaded.live));
        ai.lorebooks.BookX.entries[0].content = 'new';

        const handle = await card.commit(loaded.target, loaded.live, card.rebuild(loaded.live, ai, ['wi:BookX:0']), ['wi:BookX:0']);
        expect(handle.applied).toEqual(['wi:BookX:0']);
        expect(updateCharacterDataSpy).not.toHaveBeenCalled();
        expect(saveWorldInfoSpy).toHaveBeenCalledTimes(1);
        expect(storedBooks.BookX.entries[0].content).toBe('new');
    });

    test('no-op when key list is empty', () => {
        const base = { character: { description: 'old' }, lorebooks: {} };
        const batch = cardEditsFor(base, base, []);
        expect(batch.cardEdits).toEqual([]);
        expect(batch.bookOps).toEqual({});
    });
});
