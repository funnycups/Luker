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
        target: jest.fn(() => 'target'),
        ...overrides,
    };
}

describe('ProposalBus — conflict detection', () => {
    test('fingerprint mismatch flips status to conflict and skips commit', async () => {
        const commit = jest.fn();
        const handler = makeHandler({
            readCurrent: jest.fn(async () => ({ snapshot: { v: 99 }, fingerprint: 'fp:{"v":99}' })),
            commit,
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: { v: 1 } });

        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(commit).not.toHaveBeenCalled();

        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictInfo).toMatchObject({
            expectedFingerprint: 'fp:{"v":1}',
            actualFingerprint: 'fp:{"v":99}',
            actualSnapshot: { v: 99 },
        });
    });

    test('conflict entry does NOT count as outstanding (write was dropped, AI notified via outcome)', async () => {
        const handler = makeHandler({
            readCurrent: jest.fn(async () => ({ snapshot: { v: 99 }, fingerprint: 'fp:{"v":99}' })),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: { v: 1 } });
        await bus.approve(id);
        // The auto-continue loop checks hasOutstanding to decide whether
        // to fire another round. Treating conflicts as outstanding
        // strands the loop indefinitely because the user has no useful
        // action ('Approve' against drifted state commits a stale diff;
        // 'Reject' adds nothing the conflict outcome doesn't already
        // carry). The conflict was already enqueued as an outcome the
        // AI will see in the next drainOutcomes message.
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('commit-throw flips status to conflict and records error', async () => {
        const handler = makeHandler({
            commit: jest.fn(async () => { throw new Error('network broke'); }),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(out.error).toContain('network broke');
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictInfo.error).toContain('network broke');
    });

    test('readCurrent-throw also goes to conflict', async () => {
        const handler = makeHandler({
            readCurrent: jest.fn(async () => { throw new Error('disk gone'); }),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(out.error).toContain('disk gone');
    });

    test('re-approving a conflict entry retries and can succeed once disk converges', async () => {
        let currentFp = 'fp:{"v":99}';
        const handler = makeHandler({
            readCurrent: jest.fn(async () => ({ snapshot: null, fingerprint: currentFp })),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: { v: 1 } });
        let out = await bus.approve(id);
        expect(out.status).toBe('conflict');
        currentFp = 'fp:{"v":1}';
        out = await bus.approve(id);
        expect(out.status).toBe('committed');
    });
});
