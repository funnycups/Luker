import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { diffUnits, pickUnits, lineDiff, changeSummary } from '../../public/scripts/extensions/workbench/model/units.js';
import { memoryUnits, memoryRebuild, presetUnits, presetRebuild, cardUnits, cardEditsFor, cardRebuild, orchUnits, orchRebuild } from '../../public/scripts/extensions/workbench/model/adapters.js';
import { runIterateTurn, decisionNote, trimMessages } from '../../public/scripts/extensions/workbench/model/iterate.js';

const schema = [
    { id: 'event', label: '事件', tableColumns: ['summary'], columnHints: { summary: '经过' } },
    { id: 'item', label: '物品', tableColumns: ['title'], columnHints: { title: '名称' } },
];

test('memory: diff, accept one, rebuild keeps order', () => {
    const ai = [{ ...schema[0], label: '大事' }, schema[1], { id: 'quest', label: '任务', tableColumns: ['title'] }];
    const changes = diffUnits(memoryUnits(schema), memoryUnits(ai));
    assert.deepEqual(changes.map(c => `${c.kind}:${c.key}`), ['change:event', 'add:quest']);
    const next = memoryRebuild(pickUnits(memoryUnits(schema), memoryUnits(ai), ['quest']));
    assert.deepEqual(next.map(s => s.id), ['event', 'item', 'quest']);
    assert.equal(next[0].label, '事件');
    const removed = memoryRebuild(pickUnits(memoryUnits(schema), memoryUnits([schema[0]]), ['item']));
    assert.deepEqual(removed.map(s => s.id), ['event']);
    assert.equal(changeSummary(changes), '改 1 处 · 新增 1');
});

test('preset: entry text change and toggle, accept only one', () => {
    const base = {
        temperature: 1,
        prompts: [{ identifier: 'main', name: '主提示', content: 'A' }, { identifier: 'style', name: '文风', content: '亲切' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }] }],
    };
    const ai = JSON.parse(JSON.stringify(base));
    ai.prompts[1].content = '克制';
    ai.prompt_order[0].order[0].enabled = false;
    ai.temperature = 0.8;
    const changes = diffUnits(presetUnits(base), presetUnits(ai));
    assert.deepEqual(changes.map(c => c.key).sort(), ['prompt:main', 'prompt:style', 'settings']);
    const next = presetRebuild(base, ai, ['prompt:style']);
    assert.equal(next.prompts[1].content, '克制');
    assert.equal(next.prompt_order[0].order[0].enabled, true);
    assert.equal(next.temperature, 1);
});

test('card: field + lorebook edits as iteration-library ops', () => {
    const base = { character: { description: '温柔' }, lorebooks: { 雾港: { entries: { 1: { uid: 1, key: ['港口'], content: '旧' }, 2: { uid: 2, key: ['灯塔'], content: 'x' } } } } };
    const ai = { character: { description: '克制' }, lorebooks: { 雾港: { entries: { 1: { uid: 1, key: ['港口'], content: '新' }, 3: { uid: 3, key: ['码头'], content: 'y' } } } } };
    const keys = diffUnits(cardUnits(base), cardUnits(ai)).map(c => c.key).sort();
    assert.deepEqual(keys, ['card:description', 'wi:雾港:1', 'wi:雾港:2', 'wi:雾港:3']);
    const { cardEdits, bookEdits } = cardEditsFor(base, ai, keys);
    assert.deepEqual(cardEdits, [{ op: 'set', path: 'description', oldValue: '温柔', newValue: '克制' }]);
    assert.deepEqual(bookEdits.雾港.map(e => e.op).sort(), ['lorebook_entry_add', 'lorebook_entry_remove', 'lorebook_entry_update']);
    const upd = bookEdits.雾港.find(e => e.op === 'lorebook_entry_update');
    assert.deepEqual(upd.patch, { content: '新' });
    const rebuilt = cardRebuild(base, ai, ['wi:雾港:2']);
    assert.ok(!rebuilt.lorebooks.雾港.entries[2]);
    assert.equal(rebuilt.character.description, '温柔');
});

test('orch: field units and partial rebuild', () => {
    const base = { mode: 'loop', profile: { system_prompt: 'old' } };
    const ai = { mode: 'loop', profile: { system_prompt: 'new' } };
    const changes = diffUnits(orchUnits(base), orchUnits(ai));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].key, 'loop_agent/system');
    assert.equal(orchRebuild(base, ai, ['loop_agent/system']).profile.system_prompt, 'new');
    assert.equal(orchRebuild(base, ai, []).profile.system_prompt, 'old');
});

test('turn loop: read, edit, then text ends it', async () => {
    const script = [
        { text: '', calls: [{ id: 'r', name: 'read', args: {} }, { id: 'e', name: 'edit', args: { v: 2 } }] },
        { text: '改好了', calls: [] },
    ];
    const out = await runIterateTurn({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
        live: { v: 1 },
        tools: [],
        isRead: (n) => n === 'read',
        runRead: async (_c, live) => live,
        runEdit: async (c) => ({ v: c.args.v }),
        request: async () => script.shift(),
    });
    assert.deepEqual(out.live, { v: 2 });
    assert.equal(out.text, '改好了');
    assert.equal(out.edits.length, 1);
    const tool = out.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    assert.equal(tool[1].status, 'pending_review');
});

test('turn loop reports errors and noops back to the model', async () => {
    const out = await runIterateTurn({
        messages: [], live: 1, tools: [], isRead: () => false,
        runEdit: async (c) => { if (c.args.bad) throw new Error('not found'); return 1; },
        runRead: async () => null,
        request: (() => { let n = 0; return async () => (n++ ? { text: 'ok', calls: [] } : { text: '', calls: [{ id: 'a', name: 'x', args: { bad: true } }, { id: 'b', name: 'x', args: {} }] }); })(),
    });
    assert.equal(out.failed.length, 1);
    const tool = out.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    assert.equal(tool[0].error, 'not found');
    assert.equal(tool[1].status, 'noop');
});

test('helpers', () => {
    assert.match(decisionNote({ applied: ['描述'], discarded: ['性格'] }), /没要：性格/);
    assert.equal(decisionNote({}), '');
    const rows = lineDiff('a\nb\nc', 'a\nB\nc');
    assert.deepEqual(rows.map(r => r.type), ['same', 'del', 'add', 'same']);
    const msgs = [{ role: 'system', content: 's' }, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(10000) }))];
    const trimmed = trimMessages(msgs, 30000);
    assert.equal(trimmed[0].role, 'system');
    assert.ok(trimmed.length < msgs.length);
});
