import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler() {
    return {
        fingerprint: async (s) => `fp:${JSON.stringify(s ?? null)}`,
        readCurrent: async () => ({ snapshot: null, fingerprint: 'fp:null' }),
        commit: async () => {},
        inverse: () => null,
        renderDiffCard: () => '',
        label: () => '',
        icon: () => '',
        target: () => 't',
    };
}

describe('ProposalBus — reject + reset', () => {
    test('reject flips pending to rejected and stamps decidedAt', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        bus.reject(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('rejected');
        expect(typeof entry.decidedAt).toBe('number');
    });

    test('reject enqueues a rejected outcome', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        bus.reject(id);
        const outcomes = bus.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].status).toBe('rejected');
    });

    test('rejected entry does NOT count as outstanding', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        bus.reject(id);
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('reset flips rejected back to pending and clears decidedAt', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        bus.reject(id);
        bus.reset(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('pending');
        expect(entry.decidedAt).toBe(null);
    });

    test('reset on committed entry is a no-op', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        bus.reset(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
    });

    test('reject on unknown id is silent', () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        expect(() => bus.reject('nope')).not.toThrow();
    });
});
