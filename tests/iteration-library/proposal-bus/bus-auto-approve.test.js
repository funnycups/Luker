import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler(overrides = {}) {
    return {
        fingerprint: async (s) => `fp:${JSON.stringify(s ?? null)}`,
        readCurrent: async () => ({ snapshot: null, fingerprint: 'fp:null' }),
        commit: jest.fn(async () => {}),
        inverse: () => null,
        renderDiffCard: () => '',
        label: () => '',
        icon: () => '',
        target: () => '',
        ...overrides,
    };
}

describe('ProposalBus — auto-approve', () => {
    test('default is off', () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        expect(bus.isAutoApprove()).toBe(false);
    });

    test('setAutoApprove(true) flips state and isAutoApprove reports it', () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.setAutoApprove(true);
        expect(bus.isAutoApprove()).toBe(true);
    });

    test('with auto-approve on, propose schedules commit and entry ends committed', async () => {
        const handler = makeHandler();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        bus.setAutoApprove(true);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await new Promise((r) => setImmediate(r));
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
        expect(handler.commit).toHaveBeenCalledTimes(1);
    });

    test('auto-approve commit failure leaves entry in conflict (visible, but not blocking the loop)', async () => {
        const handler = makeHandler({
            commit: jest.fn(async () => { throw new Error('boom'); }),
        });
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        bus.setAutoApprove(true);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await new Promise((r) => setImmediate(r));
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        // hasOutstanding excludes conflicts so the AI loop continues —
        // the conflict outcome is in the queue for drainOutcomes to
        // report so the AI can decide whether to retry.
        expect(bus.hasOutstanding()).toBe(false);
    });
});
