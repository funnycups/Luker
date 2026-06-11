// tests/orchestrator/run-state-store.test.js
import { jest } from '@jest/globals';

globalThis.SillyTavern = globalThis.SillyTavern || {
    getContext: () => ({ addLocaleData: () => {}, translate: (s) => s }),
};

const {
    startRun, getCurrentRun, clearCurrentRun,
} = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');

describe('RunStateStore — startRun / getCurrentRun', () => {
    beforeEach(() => clearCurrentRun());

    test('startRun creates a run and assigns a stable runId', () => {
        const runId = startRun({ mode: 'director', chatKey: 'chatA' });
        const state = getCurrentRun();
        expect(state).not.toBeNull();
        expect(state.runId).toBe(runId);
        expect(state.mode).toBe('director');
        expect(state.chatKey).toBe('chatA');
        expect(state.status).toBe('running');
        expect(state.rounds).toEqual([]);
        expect(state.finalText).toBeNull();
        expect(state.error).toBeNull();
        expect(state.tokensSpent).toBeNull();
        expect(state.cost).toBeNull();
        expect(typeof state.startedAt).toBe('number');
        expect(state.endedAt).toBeNull();
    });

    test('startRun throws when a running run already exists', () => {
        startRun({ mode: 'director', chatKey: 'chatA' });
        expect(() => startRun({ mode: 'loop', chatKey: 'chatA' })).toThrow(/already in progress/i);
    });

    test('startRun overwrites a finished run', () => {
        const first = startRun({ mode: 'director', chatKey: 'chatA' });
        clearCurrentRun();
        const second = startRun({ mode: 'loop', chatKey: 'chatA' });
        expect(second).not.toBe(first);
        expect(getCurrentRun().mode).toBe('loop');
    });

    test('clearCurrentRun sets state to null', () => {
        startRun({ mode: 'director', chatKey: 'chatA' });
        clearCurrentRun();
        expect(getCurrentRun()).toBeNull();
    });
});

import * as evt from '../../public/scripts/extensions/orchestrator/run-state/events.js';

describe('RunStateStore — subscribe / unsubscribe', () => {
    beforeEach(() => clearCurrentRun());

    test('subscribe receives RUN_STARTED with runId and mode', async () => {
        const { subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'director', chatKey: 'chatA' });
        expect(events).toContainEqual({ type: evt.RUN_STARTED, runId, mode: 'director' });
        unsub();
    });

    test('unsubscribe stops further events', async () => {
        const { subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        unsub();
        startRun({ mode: 'director', chatKey: 'chatA' });
        expect(events).toHaveLength(0);
    });

    test('multiple subscribers all receive events', async () => {
        const { subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const a = [];
        const b = [];
        const unsubA = subscribe((e) => a.push(e));
        const unsubB = subscribe((e) => b.push(e));
        startRun({ mode: 'director', chatKey: 'chatA' });
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        unsubA(); unsubB();
    });

    test('clearCurrentRun emits RUN_CLEARED', async () => {
        const { subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        startRun({ mode: 'director', chatKey: 'chatA' });
        clearCurrentRun();
        expect(events[events.length - 1]).toEqual({ type: evt.RUN_CLEARED });
        unsub();
    });
});

describe('RunStateStore — rounds', () => {
    beforeEach(() => clearCurrentRun());

    test('appendRound adds a round and emits ROUND_APPENDED', async () => {
        const { appendRound, subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        const roundId = appendRound({ runId, round: { id: 'main-1', label: 'Director · round 1' } });
        const state = getCurrentRun();
        expect(roundId).toBe('main-1');
        expect(state.rounds).toHaveLength(1);
        expect(state.rounds[0]).toMatchObject({
            id: 'main-1', label: 'Director · round 1', status: 'running', sections: [],
        });
        expect(typeof state.rounds[0].startedAt).toBe('number');
        expect(state.rounds[0].endedAt).toBeNull();
        const last = events[events.length - 1];
        expect(last.type).toBe('round_appended');
        expect(last).toMatchObject({ runId, roundId: 'main-1' });
        unsub();
    });

    test('setRoundStatus updates status, sets endedAt for terminal, emits ROUND_STATUS', async () => {
        const { appendRound, setRoundStatus, subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        appendRound({ runId, round: { id: 'main-1', label: 'r1' } });
        setRoundStatus({ runId, roundId: 'main-1', status: 'done' });
        const r = getCurrentRun().rounds[0];
        expect(r.status).toBe('done');
        expect(typeof r.endedAt).toBe('number');
        const last = events[events.length - 1];
        expect(last).toMatchObject({ type: 'round_status', runId, roundId: 'main-1', status: 'done' });
        unsub();
    });

    test('appendRound throws on runId mismatch', async () => {
        const { appendRound } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        startRun({ mode: 'director', chatKey: 'c' });
        expect(() => appendRound({ runId: 'bogus', round: { id: 'main-1', label: 'r1' } }))
            .toThrow(/runId mismatch/i);
    });

    test('appendRound throws on duplicate round id', async () => {
        const { appendRound } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        appendRound({ runId, round: { id: 'main-1', label: 'r1' } });
        expect(() => appendRound({ runId, round: { id: 'main-1', label: 'r1-dup' } }))
            .toThrow(/duplicate round id/i);
    });
});

describe('RunStateStore — sections', () => {
    beforeEach(() => clearCurrentRun());

    async function setup() {
        const m = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        m.appendRound({ runId, round: { id: 'main-1', label: 'r1' } });
        return { ...m, runId };
    }

    test('ensureSection creates a section with defaults and emits SECTION_ENSURED', async () => {
        const { ensureSection, subscribe, runId } = await setup();
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const sectionId = ensureSection({
            runId, roundId: 'main-1',
            section: { id: 'r-1', kind: 'reasoning', title: 'Reasoning' },
        });
        expect(sectionId).toBe('r-1');
        const s = getCurrentRun().rounds[0].sections[0];
        expect(s).toMatchObject({
            id: 'r-1', kind: 'reasoning', title: 'Reasoning',
            status: 'running', body: '', meta: null,
        });
        expect(events[events.length - 1]).toMatchObject({
            type: 'section_ensured', runId, roundId: 'main-1', sectionId: 'r-1',
        });
        unsub();
    });

    test('ensureSection is idempotent on same id', async () => {
        const { ensureSection, runId } = await setup();
        ensureSection({ runId, roundId: 'main-1', section: { id: 'r-1', kind: 'reasoning', title: 'Reasoning' } });
        ensureSection({ runId, roundId: 'main-1', section: { id: 'r-1', kind: 'reasoning', title: 'Reasoning-2' } });
        const sections = getCurrentRun().rounds[0].sections;
        expect(sections).toHaveLength(1);
        expect(sections[0].title).toBe('Reasoning');
    });

    test('appendToSection appends to body and emits SECTION_APPENDED', async () => {
        const { ensureSection, appendToSection, subscribe, runId } = await setup();
        ensureSection({ runId, roundId: 'main-1', section: { id: 'r-1', kind: 'reasoning', title: 'r' } });
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        appendToSection({ runId, roundId: 'main-1', sectionId: 'r-1', delta: 'Hello ' });
        appendToSection({ runId, roundId: 'main-1', sectionId: 'r-1', delta: 'world' });
        expect(getCurrentRun().rounds[0].sections[0].body).toBe('Hello world');
        expect(events.map(e => e.delta)).toEqual(['Hello ', 'world']);
        expect(events.every(e => e.type === 'section_appended')).toBe(true);
        unsub();
    });

    test('setSectionStatus updates status and meta, emits SECTION_STATUS', async () => {
        const { ensureSection, setSectionStatus, subscribe, runId } = await setup();
        ensureSection({ runId, roundId: 'main-1', section: { id: 't-1', kind: 'tool_call', title: 'web_search' } });
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        setSectionStatus({ runId, roundId: 'main-1', sectionId: 't-1', status: 'failed', meta: { err: 'rate-limit' } });
        const s = getCurrentRun().rounds[0].sections[0];
        expect(s.status).toBe('failed');
        expect(s.meta).toEqual({ err: 'rate-limit' });
        expect(events[events.length - 1]).toMatchObject({
            type: 'section_status', runId, roundId: 'main-1', sectionId: 't-1', status: 'failed',
        });
        unsub();
    });

    test('appendToSection throws if section does not exist', async () => {
        const { appendToSection, runId } = await setup();
        expect(() => appendToSection({ runId, roundId: 'main-1', sectionId: 'ghost', delta: 'x' }))
            .toThrow(/section .* not found/i);
    });
});

describe('RunStateStore — finish / meta', () => {
    beforeEach(() => clearCurrentRun());

    test('finishRun(committed) sets status, finalText, endedAt and emits', async () => {
        const { finishRun, subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        finishRun({ runId, status: 'committed', finalText: 'final' });
        const s = getCurrentRun();
        expect(s.status).toBe('committed');
        expect(s.finalText).toBe('final');
        expect(typeof s.endedAt).toBe('number');
        expect(events[events.length - 1]).toMatchObject({
            type: 'run_finished', runId, status: 'committed',
        });
        unsub();
    });

    test('finishRun(error) sets error and status', async () => {
        const { finishRun } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        finishRun({ runId, status: 'error', error: 'boom' });
        const s = getCurrentRun();
        expect(s.status).toBe('error');
        expect(s.error).toBe('boom');
        expect(s.finalText).toBeNull();
    });

    test('setRunMeta updates tokensSpent and cost, emits RUN_META', async () => {
        const { setRunMeta, subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'director', chatKey: 'c' });
        setRunMeta({ runId, tokensSpent: { prompt: 10, completion: 20, total: 30 }, cost: 0.001 });
        const s = getCurrentRun();
        expect(s.tokensSpent).toEqual({ prompt: 10, completion: 20, total: 30 });
        expect(s.cost).toBe(0.001);
        expect(events[events.length - 1]).toMatchObject({ type: 'run_meta', runId });
        unsub();
    });

    test('addTokenUsage folds camelCase usage into running totals and emits RUN_META', async () => {
        const { addTokenUsage, subscribe } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const events = [];
        const unsub = subscribe((e) => events.push(e));
        const runId = startRun({ mode: 'loop', chatKey: 'c' });
        addTokenUsage({ runId, usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } });
        addTokenUsage({ runId, usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 } });
        const s = getCurrentRun();
        expect(s.tokensSpent).toEqual({ prompt: 150, completion: 50, total: 200 });
        const metas = events.filter(e => e.type === 'run_meta');
        expect(metas).toHaveLength(2);
        expect(metas[0]).toMatchObject({ runId });
        unsub();
    });

    test('addTokenUsage is a no-op for null/empty usage', async () => {
        const { addTokenUsage } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const runId = startRun({ mode: 'loop', chatKey: 'c' });
        addTokenUsage({ runId, usage: null });
        addTokenUsage({ runId, usage: undefined });
        addTokenUsage({ runId, usage: {} });
        addTokenUsage({ runId, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        expect(getCurrentRun().tokensSpent).toBeNull();
    });

    test('addTokenUsage derives total from prompt+completion when totalTokens is missing', async () => {
        const { addTokenUsage } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const runId = startRun({ mode: 'loop', chatKey: 'c' });
        addTokenUsage({ runId, usage: { promptTokens: 7, completionTokens: 3 } });
        expect(getCurrentRun().tokensSpent).toEqual({ prompt: 7, completion: 3, total: 10 });
    });

    test('startRun overwrites a non-running prior run', async () => {
        const { finishRun } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
        const first = startRun({ mode: 'director', chatKey: 'c' });
        finishRun({ runId: first, status: 'committed', finalText: 'x' });
        const second = startRun({ mode: 'loop', chatKey: 'c' });
        expect(getCurrentRun().runId).toBe(second);
        expect(getCurrentRun().mode).toBe('loop');
    });
});
