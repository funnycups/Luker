import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { bookForWrite, commitCardAndBooks, orchCharacterRecord, writeCharacterProfile, ceaHelperSource } from '../../public/scripts/extensions/workbench/model/commit.js';
import { cardEditsFor } from '../../public/scripts/extensions/workbench/model/adapters.js';

const base = { character: { description: '旧', personality: '旧' }, lorebooks: { 书: { entries: { 1: { uid: 1, content: '旧' } } } } };
const ai = { character: { description: '新', personality: '新' }, lorebooks: { 书: { entries: { 1: { uid: 1, content: '新' } } } } };
const KEYS = ['card:description', 'card:personality', 'wi:书:1'];

test('partial card save reports which fields persisted and undoes only those', async () => {
    const batch = cardEditsFor(base, ai, ['card:description', 'card:personality']);
    const calls = [];
    const conflicted = batch.cardEdits[1];
    const out = await commitCardAndBooks(batch, {
        commitCard: async (edits) => {
            calls.push(edits);
            return calls.length === 1 ? { persisted: true, conflicts: [{ edit: conflicted, reason: 'value_drifted' }], alreadyDone: [] } : { persisted: true, conflicts: [] };
        },
    });
    assert.deepEqual(out.applied, ['card:description']);
    assert.deepEqual(out.skipped, [{ key: 'card:personality', reason: 'value_drifted' }]);
    await out.undo();
    assert.deepEqual(calls[1], [{ op: 'set', path: 'description', oldValue: '新', newValue: '旧' }]);
});

test('a card value only found in memory is not reported as saved', async () => {
    const batch = cardEditsFor(base, ai, ['card:description']);
    await assert.rejects(commitCardAndBooks(batch, { commitCard: async (edits) => ({ persisted: false, conflicts: [], alreadyDone: edits }) }), { code: 'conflict' });
});

test('a failed world book write after a saved card stays undoable', async () => {
    const out = await commitCardAndBooks(cardEditsFor(base, ai, KEYS), {
        commitCard: async () => ({ persisted: true, conflicts: [], alreadyDone: [] }),
        readBook: async () => structuredClone(base.lorebooks.书),
        saveBook: async () => { throw new Error('disk full'); },
    });
    assert.deepEqual(out.applied, ['card:description', 'card:personality']);
    assert.deepEqual(out.skipped.map(s => s.key), ['wi:书:1']);
    assert.equal(out.failure, 'disk full');
    await out.undo();
});

test('nothing persisted throws instead of reporting success', async () => {
    const batch = cardEditsFor(base, ai, ['card:description']);
    await assert.rejects(commitCardAndBooks(batch, { commitCard: async (edits) => ({ persisted: false, conflicts: edits.map(edit => ({ edit, reason: 'value_drifted' })) }) }), { code: 'conflict' });
});

function bookIo(stored) {
    const saves = [];
    return {
        saves,
        readBook: async () => structuredClone(stored.book),
        saveBook: async (_, data) => { saves.push(data); stored.book = data; },
    };
}

test('undoing one world book edit keeps later edits to other entries', async () => {
    const stored = { book: { entries: { 1: { uid: 1, content: '旧' }, 2: { uid: 2, content: '原' } } } };
    const out = await commitCardAndBooks(cardEditsFor(base, ai, ['wi:书:1']), bookIo(stored));
    stored.book.entries[2].content = '用户后来改的';
    await out.undo();
    assert.equal(stored.book.entries[1].content, '旧');
    assert.equal(stored.book.entries[2].content, '用户后来改的');
});

test('undo reports an entry that changed since and leaves it', async () => {
    const stored = { book: { entries: { 1: { uid: 1, content: '旧' } } } };
    const out = await commitCardAndBooks(cardEditsFor(base, ai, ['wi:书:1']), bookIo(stored));
    stored.book.entries[1].content = '后来改的';
    await assert.rejects(out.undo(), { code: 'conflict' });
    assert.equal(stored.book.entries[1].content, '后来改的');
});

const removal = () => cardEditsFor({ lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } } }, { lorebooks: { 书: { entries: { 2: { uid: 2, content: 'b' } } } } }, ['wi:书:1']);

test('a null read stops a world book undo and writes nothing', async () => {
    const stored = { book: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } };
    const io = bookIo(stored);
    const out = await commitCardAndBooks(removal(), io);
    assert.equal(io.saves.length, 1);
    await assert.rejects(commitCardAndBooks(removal(), { ...io, readBook: async () => null }), { code: 'read-failed' });
    io.readBook = async () => null;
    await assert.rejects(out.undo(), { code: 'read-failed' });
    assert.equal(io.saves.length, 1);
});

test('an empty read is not permission to replace a book that had other entries', async () => {
    const stored = { book: { entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } } } };
    const io = bookIo(stored);
    const out = await commitCardAndBooks(removal(), io);
    stored.book = { entries: {} };
    await assert.rejects(out.undo(), { code: 'book-empty' });
    assert.equal(io.saves.length, 1);
    await assert.rejects(commitCardAndBooks(removal(), bookIo({ book: { entries: {} } })), { code: 'book-empty' });
});

test('an entry whose book emptied out is restored only when it was alone', async () => {
    const batch = cardEditsFor({ lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a' } } } } }, { lorebooks: { 书: { entries: {} } } }, ['wi:书:1']);
    const stored = { book: { entries: { 1: { uid: 1, content: 'a' } } } };
    const out = await commitCardAndBooks(batch, bookIo(stored));
    assert.deepEqual(stored.book.entries, {});
    await out.undo();
    assert.equal(stored.book.entries[1].content, 'a');
});

test('a world book change is written field by field', async () => {
    const before = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a', order: 5 } } } } };
    const after = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'b', order: 99 } } } } };
    const stored = { book: { entries: { 1: { uid: 1, content: 'a', order: 5, sticky: 3 } } } };
    await commitCardAndBooks(cardEditsFor(before, after, ['wi:书:1']), bookIo(stored));
    assert.deepEqual(stored.book.entries[1], { uid: 1, content: 'b', order: 99, sticky: 3 });
});

test('a failed save is not retried as already done, and failed undo can be retried', async () => {
    const before = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a' } } } } };
    const after = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'b' } } } } };
    const stored = { book: { entries: { 1: { uid: 1, content: 'a' } } } };
    const io = bookIo(stored);
    let fail = true;
    const saveBook = async (name, data) => { if (fail) throw new Error('offline'); await io.saveBook(name, data); };
    await assert.rejects(commitCardAndBooks(cardEditsFor(before, after, ['wi:书:1']), { ...io, saveBook }), /offline/);
    assert.equal(stored.book.entries[1].content, 'a');
    fail = false;
    const out = await commitCardAndBooks(cardEditsFor(before, after, ['wi:书:1']), { ...io, saveBook });
    assert.deepEqual(out.applied, ['wi:书:1']);
    assert.equal(stored.book.entries[1].content, 'b');
    fail = true;
    await assert.rejects(out.undo(), /offline/);
    assert.equal(stored.book.entries[1].content, 'b');
    fail = false;
    await out.undo();
    assert.equal(stored.book.entries[1].content, 'a');
});

test('reading for a write refuses a cached entry the server does not have', () => {
    const persisted = { entries: { 1: { content: 'a' }, 2: { content: 'b' } } };
    const cached = { entries: { 1: { content: 'unsaved' }, 2: { content: 'b' } } };
    assert.throws(() => bookForWrite(persisted, cached, ['1'], '书'), { code: 'unsaved' });
    assert.equal(bookForWrite(persisted, cached, ['2'], '书'), cached);
    assert.equal(bookForWrite(persisted, null, ['1'], '书'), persisted);
});

test('orchestrator undo targets the recorded card', () => {
    const characters = [{ avatar: 'b.png', data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'B' } } } } } } }, { avatar: 'a.png', data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'A' } } } } } } }];
    assert.equal(orchCharacterRecord(characters, { avatar: 'a.png', mode: 'spec', presetId: 'p' }).index, 1);
    assert.equal(orchCharacterRecord(characters, { avatar: 'gone.png', mode: 'spec', presetId: 'p' }), null);
    assert.equal(orchCharacterRecord(characters, { avatar: 'a.png', mode: 'spec', presetId: 'missing' }), null);
});

test('a failed character write throws', async () => {
    const ctx = { characters: [{ data: { extensions: { orchestrator: { presetLibraries: { spec: { p: { name: 'A' } } } } } } }], getExtensionApi: () => ({ persistOrchestratorCharacterExtension: async () => false }) };
    await assert.rejects(writeCharacterProfile(ctx, { mode: 'spec', presetId: 'p' }, 0, {}), { code: 'write-failed' });
});

test('character assistant helpers prefer the published API and report absence', async () => {
    const published = { buildCharacterEditorHelperApis: () => [] };
    assert.equal(await ceaHelperSource({ getExtensionApi: () => published }, async () => assert.fail('not needed')), published);
    const main = { buildCharacterEditorHelperApis: () => [] };
    assert.equal(await ceaHelperSource({ getExtensionApi: () => undefined }, async () => main), main);
    await assert.rejects(ceaHelperSource({ getExtensionApi: () => undefined }, async () => { throw new Error('missing'); }), { code: 'no-extension' });
});
