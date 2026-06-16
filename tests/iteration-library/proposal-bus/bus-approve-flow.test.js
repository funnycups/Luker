import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler(overrides = {}) {
    return {
        fingerprint: jest.fn(async (snap) => `fp:${JSON.stringify(snap ?? null)}`),
        readCurrent: jest.fn(async () => ({ snapshot: null, fingerprint: 'fp:null' })),
        commit: jest.fn(async () => {}),
        inverse: jest.fn(() => null),
        renderDiffCard: jest.fn(() => ''),
        label: jest.fn(() => ''),
        icon: jest.fn(() => ''),
        target: jest.fn(() => ''),
        ...overrides,
    };
}

describe('ProposalBus — approve flow', () => {
    test('approve runs readCurrent then commit when fingerprints match', async () => {
        const handler = makeHandler({
            readCurrent: jest.fn(async () => ({ snapshot: { v: 1 }, fingerprint: 'fp:{"v":1}' })),
            commit: jest.fn(async () => {}),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: { do: 'x' }, snapshot: { v: 1 } });

        const out = await bus.approve(id, { user: 'alice' });
        expect(out.ok).toBe(true);
        expect(out.status).toBe('committed');
        expect(handler.readCurrent).toHaveBeenCalledWith({ do: 'x' }, { user: 'alice' });
        expect(handler.commit).toHaveBeenCalledWith({ do: 'x' }, { user: 'alice' });

        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
        expect(typeof entry.committedAt).toBe('number');
        expect(typeof entry.decidedAt).toBe('number');
        expect(entry.conflictInfo).toBe(null);
    });

    test('approve on unknown id returns ok:false', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        const out = await bus.approve('nope_1_xxx');
        expect(out.ok).toBe(false);
        expect(out.status).toBe('unknown');
    });

    test('approve on non-pending entry is a no-op error', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('committed');
    });

    test('approved entry no longer counts as outstanding', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        expect(bus.hasOutstanding()).toBe(true);
        await bus.approve(id);
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('approve enqueues a committed outcome', async () => {
        const handler = makeHandler({ target: jest.fn(() => 'target/foo') });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        const outcomes = bus.drainOutcomes();
        expect(outcomes).toEqual([{
            id,
            kind: 'k',
            status: 'committed',
            target: 'target/foo',
        }]);
        expect(bus.drainOutcomes()).toEqual([]);
    });

    test('approve fires onChange', async () => {
        const onChange = jest.fn();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        onChange.mockClear();
        await bus.approve(id);
        expect(onChange).toHaveBeenCalled();
    });
});
