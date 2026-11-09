import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { listAgents, agentFields, getField, setField, replaceInField, diffProfiles, applyChanges, mergeChanges, invertChanges, validateField } from '../../../public/scripts/extensions/orchestrator/lens/model/edit.js';
import { agentStats } from '../../../public/scripts/extensions/orchestrator/lens/model/stats.js';
import { executeTools, runTurn, newSession, buildTaskMessages, systemPrompt, runSteps, diagnoseMessage, toolCallText, markEdits } from '../../../public/scripts/extensions/orchestrator/lens/model/ai.js';
import { buildRunView } from '../../../public/scripts/extensions/orchestrator/lens/model/run.js';
import { createRecorder, createMemoryStorage } from '../../../public/scripts/extensions/orchestrator/lens/model/recorder.js';
import { createMockRunStore } from './_mocks/mock-store.js';
import { PROFILES, scriptFor, playScript, createClock } from './_mocks/mock-data.js';
import { createDrafts } from '../../../public/scripts/extensions/orchestrator/lens/model/drafts.js';
import { statsEvidence, statsMessage } from '../../../public/scripts/extensions/orchestrator/lens/model/ai.js';

test('fields per mode', () => {
    expect(listAgents('spec', PROFILES.spec)).toEqual(['distiller', 'lorebook_reader', 'anti_data_guard', 'planner', 'recall_relevance', 'critic', 'synthesizer']);
    expect(agentFields('spec', PROFILES.spec, 'planner')).toEqual(['system', 'task', 'api', 'preset']);
    expect(agentFields('single', PROFILES.single, 'single_agent')).toEqual(['system', 'task']);
    expect(agentFields('loop', PROFILES.loop, 'loop_agent')).toEqual(['system', 'api', 'preset']);
    expect(agentFields('director', PROFILES.director, 'main')).toEqual(['system', 'api', 'preset']);
    expect(agentFields('director', PROFILES.director, 'chat_scout')).toEqual(['description', 'system', 'api', 'preset']);
    expect(listAgents('agenda', PROFILES.agenda)[0]).toEqual('agenda_planner');
    expect(getField('spec', PROFILES.spec, 'planner', 'api')).toBe('Claude Sonnet');
    expect(getField('loop', PROFILES.loop, 'loop_agent', 'system').startsWith('You are a single-agent')).toBe(true);
});

test('setField does not mutate and diff/apply round-trips', () => {
    const before = PROFILES.director;
    const after = setField('director', before, 'voice_critic', 'system', 'new voice');
    expect(getField('director', before, 'voice_critic', 'system')).not.toBe('new voice');
    const changes = diffProfiles('director', before, after);
    expect(changes.map(c => c.id)).toEqual(['voice_critic.system']);
    const applied = applyChanges('director', before, changes);
    expect(getField('director', applied, 'voice_critic', 'system')).toBe('new voice');
    const undone = applyChanges('director', applied, invertChanges(changes));
    expect(diffProfiles('director', before, undone)).toEqual([]);
});

test('replaceInField needs one exact match', () => {
    const p = PROFILES.spec;
    const next = replaceInField('spec', p, 'critic', 'system', 'hard-gate critic', 'strict critic');
    expect(getField('spec', next, 'critic', 'system')).toMatch(/strict critic/);
    expect(() => replaceInField('spec', p, 'critic', 'system', 'nope', 'x')).toThrow(/没有找到/);
    const twice = setField('spec', p, 'critic', 'system', 'a b a');
    expect(() => replaceInField('spec', twice, 'critic', 'system', 'a', 'c')).toThrow(/不止一次/);
});

test('mergeChanges keeps edits made elsewhere and flags conflicts', () => {
    const base = PROFILES.spec;
    const mine = diffProfiles('spec', base, setField('spec', base, 'planner', 'system', 'mine'));
    // Elsewhere: someone changed another agent and the same field.
    const elsewhere = setField('spec', setField('spec', base, 'distiller', 'system', 'native'), 'planner', 'system', 'theirs');
    const clean = mergeChanges('spec', setField('spec', base, 'distiller', 'system', 'native'), mine);
    expect(clean.conflicts.length).toBe(0);
    expect(getField('spec', clean.profile, 'distiller', 'system')).toBe('native');
    expect(getField('spec', clean.profile, 'planner', 'system')).toBe('mine');
    const clash = mergeChanges('spec', elsewhere, mine);
    expect(clash.conflicts.length).toBe(1);
    expect(clash.conflicts[0].current).toBe('theirs');
});

test('director sub-agents need a system prompt', () => {
    expect(validateField('director', 'chat_scout', 'system', '  ')).toBeTruthy();
    expect(validateField('director', 'main', 'system', '')).toBe('');
});

test('AI tools run against a working copy', () => {
    const { profile, results } = executeTools([
        { id: 'a', name: 'olens_read_agent', args: { agent_id: 'critic' } },
        { id: 'b', name: 'olens_replace_text', args: { agent_id: 'critic', field: 'system', old_text: 'hard-gate critic', new_text: 'gentle critic' } },
        { id: 'c', name: 'olens_set_field', args: { agent_id: 'critic', field: 'api', value: 'Nope' } },
        { id: 'd', name: 'olens_set_field', args: { agent_id: 'ghost', field: 'system', value: 'x' } },
    ], { mode: 'spec', profile: PROFILES.spec, options: { connections: ['Claude Opus'], presets: [] } });
    expect(results[0].ok).toBe(true);
    expect(results[0].result.system).toBeTruthy();
    expect(results[1].ok).toBe(true);
    expect(results[2].ok).toBe(false);
    expect(results[2].result.error).toMatch(/Claude Opus/);
    expect(results[3].ok).toBe(false);
    expect(getField('spec', profile, 'critic', 'system')).toMatch(/gentle critic/);
    expect(getField('spec', PROFILES.spec, 'critic', 'system')).toMatch(/hard-gate/);
    expect(toolCallText({ name: 'olens_replace_text', args: { agent_id: 'critic', field: 'system' } })).toBe('修改「审稿」的角色设定');
});

test('runTurn loops while the model calls tools and replays results', async () => {
    const seen = [];
    const replies = [
        { assistantText: '', toolCalls: [{ id: 't1', name: 'olens_set_field', args: { agent_id: 'planner', field: 'task', value: 'T' } }] },
        { assistantText: '改好了。', toolCalls: [] },
    ];
    const request = async ({ messages }) => { seen.push(messages); return replies.shift(); };
    const session = newSession();
    session.messages.push({ id: 'u', role: 'user', content: '改一下' });
    const out = await runTurn(request, session, { mode: 'spec', profile: PROFILES.spec, system: () => 'sys', tools: [] });
    expect(out.rounds).toBe(2);
    expect(getField('spec', out.profile, 'planner', 'task')).toBe('T');
    expect(session.messages.length).toBe(3);
    const second = seen[1];
    expect(second.at(-1).role).toBe('tool');
    expect(second.at(-2).tool_calls[0].function.name).toBe('olens_set_field');
    markEdits(session.messages, [session.messages[1].id], { status: 'rolled_back' });
    expect(buildTaskMessages('s', session.messages).find(m => m.role === 'tool').content).toBe('{"status":"rolled_back"}');
});

function recorded(mode, opts = {}) {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store, 'orchestrator');
    playScript(store, scriptFor(mode, opts), { speed: Infinity, clock });
    return recorder.history();
}

test('diagnosis prompt carries steps, final text and the profile', () => {
    const [raw] = recorded('spec', { rerun: true });
    const view = buildRunView(raw);
    const steps = runSteps(view);
    expect(steps.length >= 6).toBeTruthy();
    expect(steps[0].short).toMatch(/^1\. distiller（场景提炼）/);
    const msg = diagnoseMessage({ view, steps, focusStep: 2, complaint: '语气太冷' });
    expect(msg).toMatch(/第 2 步/);
    expect(msg).toMatch(/语气太冷/);
    expect(msg).toMatch(/要诊断的这一步的完整过程/);
    const sys = systemPrompt({ mode: 'spec', profile: PROFILES.spec, diagnose: true });
    expect(sys).toMatch(/诊断/);
    expect(sys).toMatch(/critic（审稿）/);
    const read = executeTools([{ id: 'x', name: 'olens_read_step', args: { step: 1 } }], { mode: 'spec', profile: PROFILES.spec, steps });
    expect(read.results[0].result).toMatch(/distiller/);
});

test('agent stats over history', () => {
    const runs = [...recorded('spec'), ...recorded('spec', { rerun: true })];
    const stats = agentStats(runs);
    expect(stats.runs).toBe(2);
    const planner = stats.agents.find(a => a.agentId === 'planner');
    expect(planner.runs).toBe(2);
    expect(planner.steps >= 3).toBeTruthy();
    expect(stats.agents.every(a => a.avg >= 0 && a.share <= 1)).toBeTruthy();
    expect(Math.abs(stats.agents.reduce((s, a) => s + a.share, 0) - 1) < 1e-9).toBeTruthy();
    expect(agentStats(runs, { source: 'search' }).runs).toBe(0);
});


test('drafts survive a reload that changed other fields, and drop saved ones', () => {
    const d = createDrafts();
    const target = { mode: 'spec', scope: 'global', presetId: 'default' };
    d.setBase(target, PROFILES.spec);
    d.set('critic', 'system', 'X');
    expect(d.count()).toBe(1);
    // Native editor saved another agent meanwhile.
    d.setBase(target, setField('spec', PROFILES.spec, 'planner', 'system', 'native'));
    expect(d.count()).toBe(1);
    expect(getField('spec', d.profile(), 'planner', 'system')).toBe('native');
    expect(getField('spec', d.profile(), 'critic', 'system')).toBe('X');
    // Our change got saved: the reload carries it, the draft is clean.
    d.setBase(target, setField('spec', PROFILES.spec, 'critic', 'system', 'X'));
    expect(d.count()).toBe(0);
    // Changes for another preset are kept, not applied.
    d.set('critic', 'task', 'T');
    d.setBase({ ...target, presetId: 'other' }, PROFILES.spec);
    expect(d.isCurrent({ ...target, presetId: 'other' })).toBe(false);
    expect(d.count()).toBe(1);
    const snap = d.applyMany([{ agentId: 'critic', field: 'system', after: 'Y' }]);
    expect(d.count()).toBe(2);
    d.restore(snap);
    expect(d.count()).toBe(1);
});


test('stats diagnosis: evidence picks failures and slow/fast steps, message carries the table', () => {
    const raws = [...recorded('spec'), ...recorded('spec', { rerun: true }), ...recorded('spec')];
    // Make one planner step fail.
    const failing = JSON.parse(JSON.stringify(raws[0]));
    const round = failing.rounds.find(r => r.sections.some(s => s.id === 'node-planner'));
    const sec = round.sections.find(s => s.id === 'node-planner');
    sec.status = 'failed';
    sec.meta = { ...(sec.meta || {}), err: '429 Too Many Requests' };
    const runs = [failing, ...raws.slice(1)];
    const stats = agentStats(runs);
    const views = runs.map(r => buildRunView(r));
    const ev = statsEvidence(stats, views);
    expect(ev.length >= 2).toBeTruthy();
    expect(ev[0].agentId).toBe('planner');
    expect(ev[0].label).toBe('出错');
    expect(ev[0].full).toMatch(/429/);
    expect(ev.some(e => e.label === '最慢的一次')).toBeTruthy();
    const one = statsEvidence(stats, views, { focus: 'critic' });
    expect(one.length && one.every(e => e.agentId === 'critic')).toBeTruthy();
    const msg = statsMessage({ stats, evidence: ev, mode: 'spec' });
    expect(msg).toMatch(/最近 3 次「流水线」运行/);
    expect(msg).toMatch(/planner（剧情规划）.*出错 1/);
    expect(msg).toMatch(/429/);
    expect(msg).toMatch(/E1\. planner/);
    expect(systemPrompt({ mode: 'spec', profile: PROFILES.spec, diagnose: 'stats' })).toMatch(/统计诊断/);
    // olens_read_step reads evidence by number.
    const read = executeTools([{ id: 'x', name: 'olens_read_step', args: { step: 1 } }], { mode: 'spec', profile: PROFILES.spec, steps: ev });
    expect(read.results[0].result).toMatch(/E1\. planner/);
});
