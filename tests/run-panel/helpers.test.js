// tests/run-panel/helpers.test.js
import { createRunStore } from '../../public/scripts/run-panel/store.js';
import { withRound, withStreamingSection } from '../../public/scripts/run-panel/helpers.js';

describe('run-panel helpers', () => {
    test('withRound finalizes a synchronous round to done', () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'x' });
        const out = withRound(store, runId, { id: 'r1', label: 'R1' }, () => 42);
        expect(out).toBe(42);
        expect(store.getCurrentRun().rounds[0].status).toBe('done');
    });

    test('withRound finalizes an async round to done', async () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'x' });
        const out = await withRound(store, runId, { id: 'r1', label: 'R1' }, async () => 7);
        expect(out).toBe(7);
        expect(store.getCurrentRun().rounds[0].status).toBe('done');
    });

    test('withRound marks a rejected async round failed and rethrows', async () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'x' });
        await expect(
            withRound(store, runId, { id: 'r1', label: 'R1' }, async () => { throw new Error('boom'); }),
        ).rejects.toThrow('boom');
        expect(store.getCurrentRun().rounds[0].status).toBe('failed');
    });

    test('withStreamingSection appends bytes and finalizes the section', async () => {
        const store = createRunStore();
        const runId = store.startRun({ mode: 'x' });
        const roundId = store.appendRound({ runId, round: { id: 'r1', label: 'R1' } });
        await withStreamingSection(store, runId, roundId, { id: 's1', kind: 'text', title: 'S1' }, async (append) => {
            append('abc');
        });
        const section = store.getCurrentRun().rounds[0].sections[0];
        expect(section.body).toBe('abc');
        expect(section.status).toBe('done');
    });
});
