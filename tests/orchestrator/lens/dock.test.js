import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { buildRunView } from '../../../public/scripts/extensions/orchestrator/lens/model/run.js';
import { buildFlow } from '../../../public/scripts/extensions/orchestrator/lens/model/profile.js';
import { createRecorder, createMemoryStorage } from '../../../public/scripts/extensions/orchestrator/lens/model/recorder.js';
import { describeToolCall, previewText, segmentPreview } from '../../../public/scripts/extensions/orchestrator/lens/model/describe.js';
import { buildBlocks, liveSummary, runCounts, currentBlock, blockLabel } from '../../../public/scripts/extensions/orchestrator/lens/dock/dock-model.js';
import { createMockRunStore } from './_mocks/mock-store.js';
import { PROFILES, scriptFor, searchScript, playScript, createClock } from './_mocks/mock-data.js';

function setup() {
    const clock = createClock();
    const orch = createMockRunStore({ now: clock.now });
    const search = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(orch, 'orchestrator');
    recorder.attach(search, 'search');
    return { clock, orch, search, recorder };
}

test('recorder follows two stores and tags runs with their source', () => {
    const { clock, orch, search, recorder } = setup();
    playScript(search, searchScript(), { speed: Infinity, clock });
    playScript(orch, scriptFor('loop'), { speed: Infinity, clock, stopAt: 4 });
    expect(recorder.current().source).toBe('orchestrator');
    expect(recorder.currents().map(r => r.source)).toEqual(['orchestrator', 'search']);
    expect(recorder.isRunning()).toBe(true);
    expect(recorder.history().map(r => r.source)).toEqual(['search']);
    recorder.attach(orch, 'orchestrator');
    expect(recorder.currents().length).toBe(2);
});

test('search runs become one lane of numbered rounds', () => {
    const { clock, search, recorder } = setup();
    playScript(search, searchScript(), { speed: Infinity, clock });
    const view = buildRunView(recorder.history()[0]);
    expect(view.mode).toBe('search');
    expect(view.lanes.map(l => l.agentId)).toEqual(['search_agent']);
    const blocks = buildBlocks(view);
    expect(blocks.map(b => b.title)).toEqual(['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮']);
    expect(runCounts(view).tools).toBe(3);
    const lines = segmentPreview(view.segments[0], 'search').lines.map(l => l.text);
    expect(lines).toEqual(['搜索网页「灯塔 灯油 历史 煤油」']);
});

test('spec blocks: stages in order, waiting agents and upcoming stages while running', () => {
    const { clock, orch, recorder } = setup();
    const script = scriptFor('spec');
    playScript(orch, script, { speed: Infinity, clock, stopAt: 8 }); // grounding: one node done, one still working
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const view = buildRunView(recorder.current(), Object.keys(flow.agents));
    const blocks = buildBlocks(view, flow);
    expect(blocks.map(b => b.title)).toEqual(['提炼', '定规矩', '规划', '审查', '汇总']);
    expect(blocks[0].status).toBe('done');
    expect(blocks[1].status).toBe('running');
    expect(blocks[1].parallel).toBe(true);
    expect(blocks.slice(2).every(b => b.upcoming && b.status === 'pending')).toBeTruthy();
    expect(liveSummary(view, flow)).toMatch(/^定规矩 · 2\/5$/);
});

test('spec rerun shows the replayed stage as its own block', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('spec', { rerun: true }), { speed: Infinity, clock });
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const blocks = buildBlocks(buildRunView(recorder.history()[0]), flow);
    expect(blocks.some(b => b.replay && b.title === '规划 · 重做')).toBeTruthy();
    expect(!blocks.some(b => b.upcoming)).toBeTruthy();
});

test('director blocks nest sub-agents under the main round that dispatched them', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('director'), { speed: Infinity, clock });
    const blocks = buildBlocks(buildRunView(recorder.history()[0]));
    expect(blocks.length).toBe(3);
    expect(blocks[0].segments.map(s => s.agentId)).toEqual(['main', 'chat_scout', 'memory_scout', 'epistemic_scout']);
    expect(blocks[1].segments.map(s => s.agentId)).toEqual(['main', 'voice_critic', 'continuity_critic']);
    const mainLines = segmentPreview(blocks[0].segments[0], 'director').lines.map(l => l.text);
    expect(mainLines.includes('派遣 聊天侦察')).toBeTruthy();
    expect(mainLines.includes('等待 3 位助手')).toBeTruthy();
});

test('agenda blocks group dispatches under their planner round', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('agenda'), { speed: Infinity, clock });
    const blocks = buildBlocks(buildRunView(recorder.history()[0], ['distiller', 'lorebook_reader', 'planner', 'finalizer']));
    expect(blocks.map(b => b.title)).toEqual(['第 1 轮调度', '第 2 轮调度', '第 3 轮调度', '收尾']);
    expect(blocks[0].segments.map(s => s.agentId)).toEqual(['agenda_planner', 'distiller', 'lorebook_reader']);
    expect(segmentPreview(blocks[0].segments[0], 'agenda').lines[0].text).toBe('派出 场景提炼、世界书守门');
});

test('plain-language tool descriptions', () => {
    expect(describeToolCall('luker_search_agent_visit', { url: 'https://www.example.com/a/b' }).text).toBe('打开 example.com');
    expect(describeToolCall('luker_search_agent_upsert_lorebook_entry', { title: '灯塔' }).text).toBe('写入世界书「灯塔」');
    expect(describeToolCall('apply_message_patches', '{"patches":[1,2]}').text).toBe('修改正文 2 处');
    expect(describeToolCall('chat_read_range', { from: 3, to: 9 }).text).toBe('翻看第 3–9 楼');
    expect(describeToolCall('something_new', {}).text).toBe('something new');
});

test('previewText strips yaml keys and bullets', () => {
    expect(previewText('summary: 林栖在试探\ntension: 雾正在起\n- 第三条')).toBe('林栖在试探 · 雾正在起 · 第三条');
    expect(previewText('')).toBe('');
    expect(previewText('x'.repeat(500), { tail: true }).startsWith('…')).toBeTruthy();
});

test('floating window shows only the current round, and the next one replaces it', () => {
    const { clock } = setup();
    const script = scriptFor('loop');
    const shown = [];
    for (let stop = 2; stop <= script.steps.length; stop += 1) {
        const o = createMockRunStore({ now: clock.now });
        const rec = createRecorder({ storage: createMemoryStorage(), now: clock.now });
        rec.attach(o, 'orchestrator');
        playScript(o, script, { speed: Infinity, clock, stopAt: stop });
        const blocks = buildBlocks(buildRunView(rec.current()));
        const cur = currentBlock(blocks);
        if (cur && shown[shown.length - 1] !== cur.id) shown.push(cur.id);
    }
    expect(shown.length > 1).toBeTruthy();
    expect(new Set(shown).size).toBe(shown.length);
});

test('currentBlock skips upcoming stages; blockLabel names steps and rounds', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('spec'), { speed: Infinity, clock, stopAt: 6 });
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const blocks = buildBlocks(buildRunView(recorder.current(), Object.keys(flow.agents)), flow);
    const cur = currentBlock(blocks);
    expect(cur && !cur.upcoming).toBeTruthy();
    expect(blockLabel(cur).tag).toMatch(/^第 \d+ 步$/);
    expect(blockLabel({ title: '第 2 轮' })).toEqual({ tag: '第 2 轮', title: '' });
    expect(currentBlock([])).toBe(null);
});
