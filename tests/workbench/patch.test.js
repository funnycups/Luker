import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { commitFields, fieldPlan, saveSettingsChecked } from '../../public/scripts/extensions/workbench/model/patch.js';
import { applyMemoryOps, applyPresetOps, cardUnits, memoryUnits, orchUnits, applyOrchOps, presetUnits, presetRebuild } from '../../public/scripts/extensions/workbench/model/adapters.js';
import { approvalMatches, diffUnits } from '../../public/scripts/extensions/workbench/model/units.js';
import { createHistory } from '../../public/scripts/extensions/workbench/model/history.js';
import { createMemoryStorage } from '../../public/scripts/extensions/orchestrator/lens/model/recorder.js';

const presetBase = () => ({
    temperature: 0.5,
    top_p: 1,
    prompts: [{ identifier: 'A', name: 'A', content: 'a' }, { identifier: 'B', name: 'B', content: 'b' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'A', enabled: true }, { identifier: 'B', enabled: true }] }],
});

function presetIo(stored) {
    return { read: async () => structuredClone(stored.body), units: presetUnits, apply: applyPresetOps, write: async (body) => { stored.body = body; } };
}

test('finding 6: approving only the order leaves the entry switch alone', () => {
    const ai = presetBase();
    ai.prompt_order[0].order = [{ identifier: 'B', enabled: false }, { identifier: 'A', enabled: true }];
    const changes = diffUnits(presetUnits(presetBase()), presetUnits(ai));
    assert.deepEqual(changes.map(c => c.key).sort(), ['order', 'prompt:B']);
    const next = presetRebuild(presetBase(), ai, ['order']);
    assert.deepEqual(next.prompt_order[0].order, [{ identifier: 'B', enabled: true }, { identifier: 'A', enabled: true }]);
});

test('finding 7: one approved parameter keeps a parallel edit of another', async () => {
    const base = presetBase();
    const ai = { ...presetBase(), temperature: 0.8 };
    const stored = { body: { ...presetBase(), top_p: 0.6 } };
    const handle = await commitFields(presetIo(stored), fieldPlan(presetUnits(base), presetUnits(ai), ['settings']));
    assert.equal(stored.body.temperature, 0.8);
    assert.equal(stored.body.top_p, 0.6);
    await handle.undo();
    assert.equal(stored.body.temperature, 0.5);
    assert.equal(stored.body.top_p, 0.6);
});

test('finding 8: a change only in a hidden field can be approved', () => {
    const base = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a', order: 5 } } } } };
    const ai = { lorebooks: { 书: { entries: { 1: { uid: 1, content: 'a', order: 99 } } } } };
    const [change] = diffUnits(cardUnits(base), cardUnits(ai));
    assert.equal(change.key, 'wi:书:1');
    assert.match(change.before, /order: 5/);
    assert.match(change.after, /order: 99/);
});

test('finding 9: two drafts from one schema both survive', async () => {
    const base = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const stored = { body: structuredClone(base) };
    const io = { read: async () => structuredClone(stored.body), units: memoryUnits, apply: applyMemoryOps, write: async (next) => { stored.body = next; } };
    const one = [{ id: 'a', label: 'A1' }, base[1]];
    const two = [base[0], { id: 'b', label: 'B2' }];
    await commitFields(io, fieldPlan(memoryUnits(base), memoryUnits(one), ['a']));
    await commitFields(io, fieldPlan(memoryUnits(base), memoryUnits(two), ['b']));
    assert.deepEqual(stored.body.map(s => s.label), ['A1', 'B2']);
});

test('finding 14: undoing one agent edit keeps a later edit of another', async () => {
    const live = (a, b) => ({ mode: 'spec', profile: { spec: { stages: [{ id: 's', mode: 'serial', nodes: ['x', 'y'] }] }, presets: { x: { systemPrompt: a }, y: { systemPrompt: b } } } });
    const stored = { body: live('old', 'y0') };
    const io = { read: async () => structuredClone(stored.body), units: (v) => orchUnits(v), apply: applyOrchOps, write: async (next) => { stored.body = next; } };
    const handle = await commitFields(io, fieldPlan(orchUnits(live('old', 'y0')), orchUnits(live('new', 'y0')), ['x/system']));
    stored.body.profile.presets.y.systemPrompt = 'y1';
    await handle.undo();
    assert.equal(stored.body.profile.presets.x.systemPrompt, 'old');
    assert.equal(stored.body.profile.presets.y.systemPrompt, 'y1');
});

test('a field changed elsewhere since the proposal is a conflict', async () => {
    const stored = { body: { ...presetBase(), temperature: 0.7 } };
    const ops = fieldPlan(presetUnits(presetBase()), presetUnits({ ...presetBase(), temperature: 0.8 }), ['settings']);
    await assert.rejects(commitFields(presetIo(stored), ops), { code: 'conflict' });
    assert.equal(stored.body.temperature, 0.7);
});

test('finding 17: a missing target or failed save leaves undo failing', async () => {
    const base = presetBase();
    const ai = { ...presetBase(), temperature: 0.8 };
    const stored = { body: structuredClone(base) };
    const io = presetIo(stored);
    const handle = await commitFields(io, fieldPlan(presetUnits(base), presetUnits(ai), ['settings']));
    const history = createHistory(createMemoryStorage());
    const id = history.record({ ws: 'preset', title: 't', undo: handle.undo });
    const body = stored.body;
    stored.body = null;
    await assert.rejects(history.undo(id));
    assert.equal(history.list()[0].undone, false);
    assert.ok(history.canUndo(id));
    stored.body = body;
    await history.undo(id);
    assert.equal(history.list()[0].undone, true);
});

test('settings saves are confirmed by Luker\'s success event only', async () => {
    const listeners = new Set();
    const ctx = { eventTypes: { SETTINGS_UPDATED: 'x' }, eventSource: { on: (_, h) => listeners.add(h), removeListener: (_, h) => listeners.delete(h) }, saveSettings: async () => {} };
    await assert.rejects(saveSettingsChecked(ctx), { code: 'write-failed' });
    ctx.saveSettings = async () => { for (const h of listeners) h(); };
    await saveSettingsChecked(ctx);
    assert.equal(listeners.size, 0);
});

test('approval compares the full proposal even when the stored text was shortened', () => {
    const [full] = diffUnits(cardUnits({ character: { description: 'a'.repeat(50) } }), cardUnits({ character: { description: 'b'.repeat(50) } }));
    const stored = [{ ...full, after: 'b' }];
    assert.ok(approvalMatches(stored, [full], [full.key]));
    assert.ok(!approvalMatches(stored, [{ ...full, sig: 'other' }], [full.key]));
});
