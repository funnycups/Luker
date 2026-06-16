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

    test('approve records afterFingerprint from a post-commit readCurrent', async () => {
        let readCount = 0;
        const readCurrent = jest.fn(async () => {
            readCount++;
            return readCount === 1
                ? { snapshot: { v: 1 }, fingerprint: 'fp:before' }   // approve drift check
                : { snapshot: { v: 2 }, fingerprint: 'fp:after' };    // post-commit snapshot
        });
        const handler = makeHandler({
            fingerprint: async () => 'fp:before',
            readCurrent,
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: { v: 1 } });
        await bus.approve(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.afterFingerprint).toBe('fp:after');
        expect(readCurrent).toHaveBeenCalledTimes(2);
    });

    test('rollback parks the entry in conflict when current state drifted from afterFingerprint', async () => {
        let readCount = 0;
        const readCurrent = jest.fn(async () => {
            readCount++;
            // approve drift check, post-commit snapshot, rollback drift check
            if (readCount === 1) return { snapshot: { v: 1 }, fingerprint: 'fp:before' };
            if (readCount === 2) return { snapshot: { v: 2 }, fingerprint: 'fp:after' };
            return { snapshot: { v: 9 }, fingerprint: 'fp:external' };
        });
        const inverse = jest.fn(() => ({ undo: true }));
        const commit = jest.fn(async () => {});
        const handler = makeHandler({
            fingerprint: async () => 'fp:before',
            readCurrent,
            commit,
            inverse,
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: { v: 1 } });
        await bus.approve(id);
        commit.mockClear();

        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(commit).not.toHaveBeenCalled();

        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictInfo).toMatchObject({
            expectedFingerprint: 'fp:after',
            actualFingerprint: 'fp:external',
            actualSnapshot: { v: 9 },
        });
    });

    test('rollback parks the entry in conflict when post-commit readCurrent throws', async () => {
        let readCount = 0;
        const readCurrent = jest.fn(async () => {
            readCount++;
            if (readCount === 1) return { snapshot: null, fingerprint: 'fp:before' };
            if (readCount === 2) return { snapshot: null, fingerprint: 'fp:after' };
            throw new Error('disk gone');
        });
        const inverse = jest.fn(() => ({ undo: true }));
        const commit = jest.fn(async () => {});
        const handler = makeHandler({
            fingerprint: async () => 'fp:before',
            readCurrent,
            commit,
            inverse,
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        commit.mockClear();

        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(out.error).toContain('disk gone');
        expect(commit).not.toHaveBeenCalled();
    });

    test('rollback proceeds without a drift check when afterFingerprint is null (legacy hydrated entry)', async () => {
        const commit = jest.fn(async () => {});
        const inverse = jest.fn(() => ({ undo: true }));
        const readCurrent = jest.fn(async () => ({ snapshot: null, fingerprint: 'fp:null' }));
        const handler = makeHandler({ commit, inverse, readCurrent });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);

        // Simulate a v2 snapshot taken before afterFingerprint existed: one
        // committed entry with no afterFingerprint field, hydrated into a
        // fresh bus.
        bus.hydrate({
            version: 2,
            entries: [{
                id: 'k_1_legacy',
                kind: 'k',
                sourceCallId: null,
                status: 'committed',
                op: { do: 'x' },
                snapshot: null,
                fingerprint: 'fp:null',
                meta: null,
                createdAt: 1,
                decidedAt: 2,
                committedAt: 2,
                rolledBackAt: null,
                conflictInfo: null,
            }],
            outcomeQueue: [],
        });
        readCurrent.mockClear();

        const out = await bus.rollback('k_1_legacy');
        expect(out.ok).toBe(true);
        expect(out.status).toBe('rolledBack');
        expect(readCurrent).not.toHaveBeenCalled();
        expect(commit).toHaveBeenCalledWith({ undo: true }, undefined);
    });
});
