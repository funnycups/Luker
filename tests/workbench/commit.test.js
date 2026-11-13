// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { bookForWrite, commitCardAndBooks, orchCharacterRecord, writeCharacterProfile } from '../../public/scripts/workbench/model/commit.js';
import { cardEditsFor, worldUnits } from '../../public/scripts/workbench/model/adapters.js';
import { diffUnits } from '../../public/scripts/workbench/model/units.js';

const base = {
    character: { description: 'old', personality: 'old' },
    lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'old' } } } },
};
const ai = {
    character: { description: 'new', personality: 'new' },
    lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'new' } } } },
};
const KEYS = ['card:description', 'card:personality', 'wi:BookA:1'];

function bookIo(stored) {
    const saves = [];
    return {
        saves,
        readBook: async () => structuredClone(stored.book),
        saveBook: async (_, data) => {
            saves.push(data);
            stored.book = data;
        },
    };
}

describe('workbench model/commit', () => {
    test('partial card save reports which fields persisted and undoes only those', async () => {
        const batch = cardEditsFor(base, ai, ['card:description', 'card:personality']);
        const calls = [];
        const conflicted = batch.cardEdits[1];
        const out = await commitCardAndBooks(batch, {
            commitCard: async (edits) => {
                calls.push(edits);
                return calls.length === 1
                    ? { persisted: true, conflicts: [{ edit: conflicted, reason: 'value_drifted' }], alreadyDone: [] }
                    : { persisted: true, conflicts: [] };
            },
        });
        expect(out.applied).toEqual(['card:description']);
        expect(out.skipped).toEqual([{ key: 'card:personality', reason: 'value_drifted' }]);
        await out.undo();
        expect(calls[1]).toEqual([{ op: 'set', path: 'description', oldValue: 'new', newValue: 'old' }]);
    });

    test('a card value only found in memory is not reported as saved', async () => {
        const batch = cardEditsFor(base, ai, ['card:description']);
        await expect(commitCardAndBooks(batch, {
            commitCard: async (edits) => ({ persisted: false, conflicts: [], alreadyDone: edits }),
        })).rejects.toMatchObject({ code: 'conflict' });
    });

    test('a failed world book write after a saved card stays undoable', async () => {
        const out = await commitCardAndBooks(cardEditsFor(base, ai, KEYS), {
            commitCard: async () => ({ persisted: true, conflicts: [], alreadyDone: [] }),
            readBook: async () => structuredClone(base.lorebooks.BookA),
            saveBook: async () => { throw new Error('disk full'); },
        });
        expect(out.applied).toEqual(['card:description', 'card:personality']);
        expect(out.skipped.map((s) => s.key)).toEqual(['wi:BookA:1']);
        expect(out.failure).toBe('disk full');
        await out.undo();
    });

    test('nothing persisted throws instead of reporting success', async () => {
        const batch = cardEditsFor(base, ai, ['card:description']);
        await expect(commitCardAndBooks(batch, {
            commitCard: async (edits) => ({
                persisted: false,
                conflicts: edits.map((edit) => ({ edit, reason: 'value_drifted' })),
            }),
        })).rejects.toMatchObject({ code: 'conflict' });
    });

    test('undoing one world book edit keeps later edits to other entries', async () => {
        const stored = { book: { entries: { 1: { uid: 1, content: 'old' }, 2: { uid: 2, content: 'orig' } } } };
        const out = await commitCardAndBooks(cardEditsFor(base, ai, ['wi:BookA:1']), bookIo(stored));
        stored.book.entries[2].content = 'user edited later';
        await out.undo();
        expect(stored.book.entries[1].content).toBe('old');
        expect(stored.book.entries[2].content).toBe('user edited later');
    });

    test('undo reports an entry that changed since and leaves it', async () => {
        const stored = { book: { entries: { 1: { uid: 1, content: 'old' } } } };
        const out = await commitCardAndBooks(cardEditsFor(base, ai, ['wi:BookA:1']), bookIo(stored));
        stored.book.entries[1].content = 'edited externally';
        await expect(out.undo()).rejects.toMatchObject({ code: 'conflict' });
        expect(stored.book.entries[1].content).toBe('edited externally');
    });

    const removal = () => cardEditsFor(
        { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } } },
        { lorebooks: { BookA: { entries: { 2: { uid: 2, content: 'b' } } } } },
        ['wi:BookA:1'],
    );

    test('a null read stops a world book undo and writes nothing', async () => {
        const stored = { book: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } };
        const io = bookIo(stored);
        const out = await commitCardAndBooks(removal(), io);
        expect(io.saves).toHaveLength(1);
        await expect(commitCardAndBooks(removal(), { ...io, readBook: async () => null })).rejects.toMatchObject({ code: 'read-failed' });
        io.readBook = async () => null;
        await expect(out.undo()).rejects.toMatchObject({ code: 'read-failed' });
        expect(io.saves).toHaveLength(1);
    });

    test('an empty read is not permission to replace a book that had other entries', async () => {
        const stored = { book: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } };
        const io = bookIo(stored);
        const out = await commitCardAndBooks(removal(), io);
        stored.book = { entries: {} };
        await expect(out.undo()).rejects.toMatchObject({ code: 'book-empty' });
        expect(io.saves).toHaveLength(1);
        await expect(commitCardAndBooks(removal(), bookIo({ book: { entries: {} } }))).rejects.toMatchObject({ code: 'book-empty' });
    });

    test('an entry whose book emptied out is restored only when it was alone', async () => {
        const batch = cardEditsFor(
            { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'a' } } } } },
            { lorebooks: { BookA: { entries: {} } } },
            ['wi:BookA:1'],
        );
        const stored = { book: { entries: { 1: { uid: 1, content: 'a' } } } };
        const out = await commitCardAndBooks(batch, bookIo(stored));
        expect(stored.book.entries).toEqual({});
        await out.undo();
        expect(stored.book.entries[1].content).toBe('a');
    });

    test('a world book change is written field by field', async () => {
        const before = { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'a', order: 5 } } } } };
        const after = { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'b', order: 99 } } } } };
        const stored = { book: { entries: { 1: { uid: 1, content: 'a', order: 5, sticky: 3 } } } };
        await commitCardAndBooks(cardEditsFor(before, after, ['wi:BookA:1']), bookIo(stored));
        expect(stored.book.entries[1]).toEqual({ uid: 1, content: 'b', order: 99, sticky: 3 });
    });

    test('a failed save is not retried as already done, and failed undo can be retried', async () => {
        const before = { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'a' } } } } };
        const after = { lorebooks: { BookA: { entries: { 1: { uid: 1, content: 'b' } } } } };
        const stored = { book: { entries: { 1: { uid: 1, content: 'a' } } } };
        const io = bookIo(stored);
        let fail = true;
        const saveBook = async (name, data) => {
            if (fail) throw new Error('offline');
            await io.saveBook(name, data);
        };
        await expect(commitCardAndBooks(cardEditsFor(before, after, ['wi:BookA:1']), { ...io, saveBook })).rejects.toThrow(/offline/);
        expect(stored.book.entries[1].content).toBe('a');
        fail = false;
        const out = await commitCardAndBooks(cardEditsFor(before, after, ['wi:BookA:1']), { ...io, saveBook });
        expect(out.applied).toEqual(['wi:BookA:1']);
        expect(stored.book.entries[1].content).toBe('b');
        fail = true;
        await expect(out.undo()).rejects.toThrow(/offline/);
        expect(stored.book.entries[1].content).toBe('b');
        fail = false;
        await out.undo();
        expect(stored.book.entries[1].content).toBe('a');
    });

    test('reading for a write refuses a cached entry the server does not have', () => {
        const persisted = { entries: { 1: { content: 'a' }, 2: { content: 'b' } } };
        const cached = { entries: { 1: { content: 'unsaved' }, 2: { content: 'b' } } };
        expect(() => bookForWrite(persisted, cached, 'BookA')).toThrow(/unsaved/i);
        expect(() => bookForWrite(persisted, { ...persisted, scan_depth: 2 }, 'BookA')).toThrow(/unsaved/i);
        expect(bookForWrite(persisted, null, 'BookA')).toBe(persisted);
    });

    test('orchestrator undo targets the recorded card', () => {
        const characters = [
            { avatar: 'b.png', data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'B' } } } } } } },
            { avatar: 'a.png', data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'A' } } } } } } },
        ];
        expect(orchCharacterRecord(characters, { avatar: 'a.png', mode: 'spec', presetId: 'p' }).index).toBe(1);
        expect(orchCharacterRecord(characters, { avatar: 'gone.png', mode: 'spec', presetId: 'p' })).toBeNull();
        expect(orchCharacterRecord(characters, { avatar: 'a.png', mode: 'spec', presetId: 'missing' })).toBeNull();
    });

    test('a failed character write throws', async () => {
        const ctx = {
            characters: [{ data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'A' } } } } } } }],
            getExtensionApi: () => ({ persistOrchestratorCharacterExtension: async () => false }),
        };
        await expect(writeCharacterProfile(ctx, { mode: 'spec', presetId: 'p' }, 0, {})).rejects.toMatchObject({ code: 'write-failed' });
    });

    test('an added entry previews and round-trips hidden and null fields', async () => {
        const empty = { lorebooks: { book: { entries: {} } } };
        const entry = { uid: 7, content: 'text', order: 3, group: null };
        const next = { lorebooks: { book: { entries: { 7: entry } } } };
        const [change] = diffUnits(worldUnits(empty), worldUnits(next));
        expect(change.after).toMatch(/order: 3/);
        const stored = { book: empty.lorebooks.book };
        const result = await commitCardAndBooks(cardEditsFor(empty, next, [change.key]), bookIo(stored));
        expect(stored.book.entries[7]).toEqual(entry);
        await result.undo();
        expect(stored.book.entries).toEqual({});
    });

    test('undo rejects an inverse confirmed only by the runtime cache', async () => {
        let saving = true;
        const result = await commitCardAndBooks(cardEditsFor(base, ai, ['card:description']), {
            commitCard: async (edits) => (saving ? { persisted: true } : { persisted: false, alreadyDone: edits }),
        });
        saving = false;
        await expect(result.undo()).rejects.toMatchObject({ code: 'conflict' });
    });
});
