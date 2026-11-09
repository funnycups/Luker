import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { commitCardAndBooks, revertBookEntries, orchCharacterRecord, writeCharacterProfile, ceaHelperSource } from '../../public/scripts/extensions/workbench/model/commit.js';
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

test('a failed world book write after a saved card stays undoable', async () => {
    const out = await commitCardAndBooks(cardEditsFor(base, ai, KEYS), {
        commitCard: async () => ({ persisted: true, conflicts: [], alreadyDone: [] }),
        readBook: async () => structuredClone(base.lorebooks.书),
        commitBook: async () => { throw new Error('disk full'); },
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

test('undoing one world book edit keeps later edits to other entries', async () => {
    let saved = null;
    const stored = { entries: { 1: { uid: 1, content: '旧' }, 2: { uid: 2, content: '原' } } };
    const batch = cardEditsFor(base, ai, ['wi:书:1']);
    const out = await commitCardAndBooks(batch, {
        readBook: async () => structuredClone(stored),
        commitBook: async () => { stored.entries[1].content = '新'; return { persisted: true, conflicts: [], alreadyDone: [] }; },
        saveBook: async (_, data) => { saved = data; },
    });
    stored.entries[2].content = '用户后来改的';
    await out.undo();
    assert.equal(saved.entries[1].content, '旧');
    assert.equal(saved.entries[2].content, '用户后来改的');
});

test('revert flags an entry that changed since and leaves it', () => {
    const records = [{ uid: 1, before: { content: 'a' }, after: { content: 'b' } }, { uid: 2, before: null, after: { content: 'n' } }];
    const res = revertBookEntries({ entries: { 1: { content: 'edited later' }, 2: { content: 'n' } } }, records);
    assert.deepEqual(res.conflicts, [1]);
    assert.equal(res.book.entries[1].content, 'edited later');
    assert.ok(!(2 in res.book.entries));
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
