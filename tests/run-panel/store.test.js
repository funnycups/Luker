// tests/run-panel/store.test.js
import { createRunStore } from '../../public/scripts/run-panel/store.js';
import * as evt from '../../public/scripts/run-panel/events.js';

describe('createRunStore — factory isolation', () => {
    test('two stores do not share run state', () => {
        const a = createRunStore();
        const b = createRunStore();
        const runA = a.startRun({ mode: 'a' });
        const runB = b.startRun({ mode: 'b' });
        expect(a.getCurrentRun().runId).toBe(runA);
        expect(b.getCurrentRun().runId).toBe(runB);
        expect(a.getCurrentRun().mode).toBe('a');
        expect(b.getCurrentRun().mode).toBe('b');
    });

    test('a running run in one store does not block another store', () => {
        const a = createRunStore();
        const b = createRunStore();
        a.startRun({ mode: 'a' });
        expect(() => b.startRun({ mode: 'b' })).not.toThrow();
    });

    test('a store still rejects a second running run on itself', () => {
        const a = createRunStore();
        a.startRun({ mode: 'a' });
        expect(() => a.startRun({ mode: 'a2' })).toThrow(/already in progress/i);
    });
});

describe('createRunStore — lifecycle', () => {
    let store;
    beforeEach(() => { store = createRunStore(); });

    test('startRun creates a run with the documented shape', () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        const run = store.getCurrentRun();
        expect(run.runId).toBe(runId);
        expect(run.mode).toBe('director');
        expect(run.chatKey).toBe('c');
        expect(run.status).toBe('running');
        expect(run.rounds).toEqual([]);
        expect(run.finalText).toBeNull();
        expect(run.error).toBeNull();
        expect(run.tokensSpent).toBeNull();
        expect(run.cost).toBeNull();
        expect(run.stopFn).toBeNull();
        expect(run.quiet).toBe(false);
    });

    test('clearCurrentRun emits RUN_CLEARED carrying the runId', () => {
        const events = [];
        store.subscribe((e) => events.push(e));
        const runId = store.startRun({ mode: 'director' });
        store.clearCurrentRun();
        expect(events[events.length - 1]).toEqual({ type: evt.RUN_CLEARED, runId });
        expect(store.getCurrentRun()).toBeNull();
    });

    test('clearCurrentRun with no run emits nothing', () => {
        const events = [];
        store.subscribe((e) => events.push(e));
        store.clearCurrentRun();
        expect(events).toHaveLength(0);
    });
});

describe('createRunStore — rounds and sections', () => {
    let store;
    let runId;
    beforeEach(() => {
        store = createRunStore();
        runId = store.startRun({ mode: 'loop' });
        store.appendRound({ runId, round: { id: 'round-1', label: 'Round 1' } });
        store.ensureSection({ runId, roundId: 'round-1', section: { id: 'text', kind: 'text', title: 'Text' } });
    });

    test('appendToSection accumulates body', () => {
        store.appendToSection({ runId, roundId: 'round-1', sectionId: 'text', delta: 'hello ' });
        store.appendToSection({ runId, roundId: 'round-1', sectionId: 'text', delta: 'world' });
        const s = store.getCurrentRun().rounds[0].sections[0];
        expect(s.body).toBe('hello world');
    });

    test('SECTION_STATUS event carries meta', () => {
        const events = [];
        store.subscribe((e) => events.push(e));
        store.setSectionStatus({ runId, roundId: 'round-1', sectionId: 'text', status: 'done', meta: { ok: true } });
        const last = events[events.length - 1];
        expect(last).toMatchObject({
            type: evt.SECTION_STATUS, runId, roundId: 'round-1',
            sectionId: 'text', status: 'done', meta: { ok: true },
        });
    });

    test('runId mismatch throws', () => {
        expect(() => store.appendRound({ runId: 'bogus', round: { id: 'r2', label: 'r2' } }))
            .toThrow(/runId mismatch/i);
    });
});

describe('createRunStore — finish and tokens', () => {
    test('finishRun sets terminal state', () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'loop' });
        store.finishRun({ runId, status: 'committed', finalText: 'out' });
        const run = store.getCurrentRun();
        expect(run.status).toBe('committed');
        expect(run.finalText).toBe('out');
        expect(typeof run.endedAt).toBe('number');
    });

    test('addTokenUsage folds camelCase usage', () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'loop' });
        store.addTokenUsage({ runId, usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } });
        store.addTokenUsage({ runId, usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 } });
        expect(store.getCurrentRun().tokensSpent).toEqual({ prompt: 150, completion: 50, total: 200 });
    });
});
