// tests/orchestrator/run-state-helpers.test.js
import { jest } from '@jest/globals';

globalThis.Luker = globalThis.Luker || {
    getContext: () => ({ addLocaleData: () => {}, translate: (s) => s }),
};

const store = await import('../../public/scripts/extensions/orchestrator/run-state/store.js');
const { withRound, withStreamingSection } = await import('../../public/scripts/extensions/orchestrator/run-state/helpers.js');

describe('helpers — withRound', () => {
    beforeEach(() => store.clearCurrentRun());

    test('marks round done on success', () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        const result = withRound(store, runId, { id: 'main-1', label: 'r1' }, () => 42);
        expect(result).toBe(42);
        expect(store.getCurrentRun().rounds[0].status).toBe('done');
    });

    test('marks round failed on throw and rethrows', () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        expect(() => withRound(store, runId, { id: 'main-1', label: 'r1' }, () => {
            throw new Error('boom');
        })).toThrow('boom');
        expect(store.getCurrentRun().rounds[0].status).toBe('failed');
    });

    test('passes roundId to the callback', () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        let received;
        withRound(store, runId, { id: 'main-1', label: 'r1' }, (rid) => { received = rid; });
        expect(received).toBe('main-1');
    });
});

describe('helpers — withStreamingSection', () => {
    beforeEach(() => store.clearCurrentRun());

    test('async fn: marks section done on success, returns value', async () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        store.appendRound({ runId, round: { id: 'main-1', label: 'r1' } });
        const result = await withStreamingSection(
            store, runId, 'main-1',
            { id: 'r-1', kind: 'reasoning', title: 'r' },
            async (append) => {
                append('hello'); append(' world');
                return 'done';
            },
        );
        expect(result).toBe('done');
        const s = store.getCurrentRun().rounds[0].sections[0];
        expect(s.body).toBe('hello world');
        expect(s.status).toBe('done');
    });

    test('async fn: marks section failed on throw and rethrows', async () => {
        const runId = store.startRun({ mode: 'director', chatKey: 'c' });
        store.appendRound({ runId, round: { id: 'main-1', label: 'r1' } });
        await expect(withStreamingSection(
            store, runId, 'main-1',
            { id: 'r-1', kind: 'reasoning', title: 'r' },
            async () => { throw new Error('boom'); },
        )).rejects.toThrow('boom');
        expect(store.getCurrentRun().rounds[0].sections[0].status).toBe('failed');
    });
});
