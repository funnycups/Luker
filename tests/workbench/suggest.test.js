import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { runRules, similarity, RULES } from '../../public/scripts/extensions/workbench/model/suggest.js';

const ids = (list) => list.map(s => s.id);

test('quiet snapshot gives no suggestions', () => {
    assert.deepEqual(runRules({}), []);
    assert.deepEqual(runRules({ memory: { core: 900, coreHistory: [800, 900, 1000, 850, 950], events: 30, unmerged: 10, maxSeqDistance: 100, floors: 400 }, budget: { max: 64000 } }), []);
});

test('memory rules fire with their numbers', () => {
    const snap = {
        memory: { core: 7600, coreHistory: [3000, 3300, 3400, 3200, 3100], events: 212, unmerged: 164, compression: true, threshold: 200, maxSeqDistance: 0, floors: 412 },
        budget: { total: 32700, max: 64000 },
    };
    const out = runRules(snap);
    assert.deepEqual(ids(out), ['memory.coreHigh', 'memory.unmerged', 'memory.horizon']);
    assert.match(out[0].why, /2\.4 倍/);
    assert.match(out[1].why, /164 条/);
    assert.equal(out[2].actions[0].kind, 'setHorizon');
});

test('core share of the context window alone is enough', () => {
    const out = runRules({ memory: { core: 15000, coreHistory: [] }, budget: { max: 64000 } });
    assert.deepEqual(ids(out), ['memory.coreHigh']);
    assert.match(out[0].text, /23%/);
});

test('orchestrator errors and slowness', () => {
    const run = (err, slowMs) => ({ at: 1, durationMs: 10000, agents: [{ id: 'a', label: '剧情顾问', durationMs: slowMs, error: err ? '429' : '' }, { id: 'b', label: '文风', durationMs: 1000 }] });
    const out = runRules({ orch: { runs: [run(true, 7000), run(false, 6000), run(true, 8000)] } });
    assert.deepEqual(ids(out), ['orch.errors', 'orch.slow']);
    assert.match(out[0].text, /剧情顾问」最近 3 次有 2 次出错/);
    assert.match(out[1].why, /70%/);
});

test('disabled and dismissed rules stay quiet until numbers change', () => {
    const snap = { memory: { core: 1, maxSeqDistance: 0, floors: 300 } };
    assert.deepEqual(ids(runRules(snap)), ['memory.horizon']);
    assert.deepEqual(ids(runRules(snap, { enabled: { 'memory.horizon': false } })), []);
    assert.deepEqual(ids(runRules(snap, { dismissed: { 'memory.horizon': 'on' } })), []);
    const unmerged = (n) => ({ memory: { unmerged: n, events: n } });
    assert.deepEqual(ids(runRules(unmerged(100), { dismissed: { 'memory.unmerged': '5' } })), []);
    assert.deepEqual(ids(runRules(unmerged(160), { dismissed: { 'memory.unmerged': '5' } })), ['memory.unmerged']);
});

test('preset duplicates are off by default; pending card first', () => {
    const text = '请用细腻的笔触描写场景，注意人物的神态和动作，不要使用网络流行语。';
    const snap = {
        preset: { name: 'p', prompts: [{ id: 1, name: '文风', text, enabled: true }, { id: 2, name: '文风2', text: `${text}保持简洁。`, enabled: true }] },
        card: { pending: 3, sessionTitle: '更克制', sessionId: 's1' },
        memory: { maxSeqDistance: 0, floors: 300 },
    };
    assert.deepEqual(ids(runRules(snap)), ['card.pending', 'memory.horizon']);
    assert.deepEqual(ids(runRules(snap, { enabled: { 'preset.dup': true } })), ['card.pending', 'memory.horizon', 'preset.dup']);
    assert.ok(similarity(text, text) > 0.99);
    assert.ok(similarity(text, '完全不同的一段话，讲的是别的事情。') < 0.3);
    assert.equal(RULES.length, 7);
});
