import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { parseRound, buildRunView, agentActivity, peakConcurrency, plannerDecision, toolNameOf, displayStatus, formatDuration } from '../../../public/scripts/extensions/orchestrator/lens/model/run.js';
import { createRecorder, createMemoryStorage } from '../../../public/scripts/extensions/orchestrator/lens/model/recorder.js';
import { createMockRunStore } from './_mocks/mock-store.js';
import { scriptFor, playScript, createClock } from './_mocks/mock-data.js';

function record(mode, options = {}) {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const storage = createMemoryStorage();
    const recorder = createRecorder({ storage, now: clock.now, wallNow: () => 1_700_000_000_000, getRunContext: () => ({ chatId: 'c1', floor: 3 }) });
    recorder.attach(store);
    const script = scriptFor(mode, options);
    playScript(store, script, { speed: Infinity, clock, stopAt: options.stopAt });
    return { store, recorder, storage, script };
}

test('parseRound understands every runtime id scheme', () => {
    expect(parseRound('spec', 'stage-reason-replay-1')).toEqual({ agentId: '', stageId: 'reason', replay: true, attempt: 2, perSection: true });
    expect(parseRound('agenda', 'node-agenda_planner-3').agentId).toBe('agenda_planner');
    expect(parseRound('agenda', 'node-lorebook_reader-lore-2', ['lorebook_reader'])).toEqual({ agentId: 'lorebook_reader', todo: 'lore', attempt: 2 });
    expect(parseRound('agenda', 'node-my-agent-t-1', ['my-agent']).agentId).toBe('my-agent');
    expect(parseRound('agenda', 'node-finalizer-final')).toEqual({ agentId: 'finalizer', final: true, attempt: 1 });
    expect(parseRound('loop', 'agent-4')).toEqual({ agentId: 'loop_agent', attempt: 4 });
    expect(parseRound('director', 'main-0')).toEqual({ agentId: 'main', attempt: 1 });
    expect(parseRound('director', 'sub-voice_critic-4')).toEqual({ agentId: 'voice_critic', attempt: 4 });
});

test('spec run: one segment per node, parallel nodes overlap, replay marked', () => {
    const { recorder } = record('spec', { rerun: true });
    const view = buildRunView(recorder.history()[0]);
    expect(view.status).toBe('committed');
    const lanes = Object.fromEntries(view.lanes.map(l => [l.agentId, l.segments]));
    expect(lanes.planner.length).toBe(2);
    expect(lanes.planner[1].replay).toBe(true);
    const [a] = lanes.lorebook_reader;
    const [b] = lanes.anti_data_guard;
    expect(a.start < b.end && b.start < a.end).toBeTruthy();
    expect(a.duration > 0 && a.duration < b.duration).toBeTruthy();
    expect(view.peakParallel >= 2).toBeTruthy();
    expect(view.tokens > 0).toBeTruthy();
    expect(view.finalText).toMatch(/写作指引/);
});

test('director run: sub-agents are separate lanes and overlap the main agent', () => {
    const { recorder } = record('director');
    const view = buildRunView(recorder.history()[0]);
    expect(view.lanes.map(l => l.agentId)).toEqual(['main', 'chat_scout', 'memory_scout', 'epistemic_scout', 'voice_critic', 'continuity_critic']);
    expect(view.lanes[0].segments.length).toBe(3);
    expect(view.peakParallel >= 3).toBeTruthy();
    const activity = agentActivity(view);
    expect(activity.main.runs).toBe(3);
    expect(activity.chat_scout.status).toBe('done');
});

test('a run frozen mid-way is live: running segments extend to now', () => {
    const { recorder, script } = record('director', { stopAt: 30 });
    expect(script.steps.length > 30).toBeTruthy();
    expect(recorder.isRunning()).toBe(true);
    expect(recorder.history().length).toBe(0);
    const view = buildRunView(recorder.current());
    const running = view.segments.filter(s => s.status === 'running');
    expect(running.length >= 1).toBeTruthy();
    for (const seg of running) expect(seg.end).toBe(view.duration);
    expect(agentActivity(view).main.status).toBe('running');
});

test('recorder persists finished runs, newest first, and skips quiet runs', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const storage = createMemoryStorage();
    const recorder = createRecorder({ storage, now: clock.now });
    recorder.attach(store);
    playScript(store, scriptFor('loop'), { speed: Infinity, clock });
    playScript(store, scriptFor('agenda'), { speed: Infinity, clock });
    const quiet = store.startRun({ mode: 'spec', quiet: true });
    store.finishRun({ runId: quiet, status: 'committed' });
    expect(recorder.history().map(r => r.mode)).toEqual(['agenda', 'loop']);
    const again = createRecorder({ storage, now: clock.now });
    expect(again.history().length).toBe(2);
    again.removeWhere(r => r.mode === 'loop');
    expect(again.history().map(r => r.mode)).toEqual(['agenda']);
});

test('recorder keeps the first finish when director reports twice', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store);
    const runId = store.startRun({ mode: 'director' });
    store.finishRun({ runId, status: 'aborted', error: 'user_stopped' });
    store.finishRun({ runId, status: 'completed' });
    expect(recorder.history().length).toBe(1);
    expect(recorder.history()[0].status).toBe('aborted');
});

test('stop calls the run stopFn; a stopped spec run reads as 已停止', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store);
    playScript(store, scriptFor('spec'), { speed: Infinity, clock, stopAt: 5 });
    expect(recorder.stop()).toBe(true);
    const view = buildRunView(recorder.history()[0]);
    expect(view.status).toBe('aborted');
    expect(recorder.stop()).toBe(false);
});

test('agenda planner decisions and tool names are extracted', () => {
    const { recorder } = record('agenda');
    const run = recorder.history()[0];
    const planner = run.rounds.find(r => r.id === 'node-agenda_planner-1').sections[0];
    const decision = plannerDecision(planner);
    expect(decision.dispatches.length).toBe(2);
    expect(decision.dispatches[0].agent).toBe('distiller');
    expect(decision.finalize).toBe(false);
    expect(toolNameOf({ title: 'Tool: chat_search' })).toBe('chat_search');
    expect(toolNameOf({ title: '工具：lorebook_get' })).toBe('lorebook_get');
});

test('helpers', () => {
    expect(displayStatus('error', 'Orchestration aborted.')).toBe('aborted');
    expect(displayStatus('error', 'HTTP 500')).toBe('error');
    expect(peakConcurrency([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }])).toBe(2);
    expect(formatDuration(850)).toBe('850 毫秒');
    expect(formatDuration(65000)).toBe('1 分 05 秒');
});
