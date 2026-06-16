import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler(overrides = {}) {
    return {
        fingerprint: async (s) => `fp:${JSON.stringify(s ?? null)}`,
        readCurrent: async () => ({ snapshot: null, fingerprint: 'fp:null' }),
        commit: async () => {},
        inverse: jest.fn((op, snap) => ({ inverseOf: op, restore: snap })),
        renderDiffCard: () => '',
        label: () => '',
        icon: () => '',
        target: () => 't',
        ...overrides,
    };
}

describe('ProposalBus — rollback', () => {
    test('rollback on committed entry calls handler.inverse then commit', async () => {
        const commit = jest.fn(async () => {});
        const inverse = jest.fn((op, snap) => ({ undo: true, was: snap }));
        const handler = makeHandler({
            commit,
            inverse,
            readCurrent: jest.fn(async () => ({ snapshot: { v: 1 }, fingerprint: 'fp:{"v":1}' })),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: { do: 'x' }, snapshot: { v: 1 } });
        await bus.approve(id);
        commit.mockClear();

        const out = await bus.rollback(id, { ctx: true });
        expect(out.ok).toBe(true);
        expect(out.status).toBe('rolledBack');
        expect(inverse).toHaveBeenCalledWith({ do: 'x' }, { v: 1 }, { ctx: true });
        expect(commit).toHaveBeenCalledWith({ undo: true, was: { v: 1 } }, { ctx: true });

        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('rolledBack');
        expect(typeof entry.rolledBackAt).toBe('number');
    });

    test('rollback on non-committed entry returns ok:false', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('pending');
    });

    test('rollback returns ok:false when handler.inverse returns null', async () => {
        const handler = makeHandler({ inverse: () => null });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('committed');
    });

    test('rollback enqueues a rolledBack outcome', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        bus.drainOutcomes();
        await bus.rollback(id);
        const outcomes = bus.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].status).toBe('rolledBack');
    });

    test('rolledBack entry does not count as outstanding', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        await bus.rollback(id);
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('rollback failure (commit throws) leaves entry in committed and reports error', async () => {
        let callCount = 0;
        const commit = jest.fn(async () => {
            callCount++;
            if (callCount === 2) throw new Error('rollback write failed');
        });
        const handler = makeHandler({ commit });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.error).toContain('rollback write failed');
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
    });
});
