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
        target: () => '',
    };
}

describe('ProposalBus — serialize / hydrate', () => {
    test('serialize returns version 2 envelope with entries + outcomeQueue', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        await bus.propose({ kind: 'k', sourceCallId: 'c1', op: { x: 1 }, snapshot: { v: 1 } });
        const data = bus.serialize();
        expect(data.version).toBe(2);
        expect(data.entries).toHaveLength(1);
        expect(data.entries[0]).toMatchObject({
            kind: 'k',
            sourceCallId: 'c1',
            status: 'pending',
            op: { x: 1 },
            snapshot: { v: 1 },
        });
        expect(Array.isArray(data.outcomeQueue)).toBe(true);
    });

    test('hydrate restores entries verbatim', async () => {
        const seed = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        seed.registerKind('k', makeHandler());
        await seed.propose({ kind: 'k', op: { x: 1 }, snapshot: null });
        await seed.propose({ kind: 'k', op: { x: 2 }, snapshot: null });
        const data = seed.serialize();

        const fresh = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        fresh.registerKind('k', makeHandler());
        fresh.hydrate(data);
        expect(fresh._testOnly_entries()).toHaveLength(2);
        expect(fresh.hasOutstanding()).toBe(true);
    });

    test('hydrate accepts version: undefined (treated as empty)', () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        bus.hydrate({});
        expect(bus._testOnly_entries()).toHaveLength(0);
    });

    test('hydrate accepts null and is a no-op', () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.hydrate(null);
        expect(bus._testOnly_entries()).toHaveLength(0);
    });

    test('hydrate fires onChange exactly once', () => {
        const onChange = jest.fn();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange });
        bus.registerKind('k', makeHandler());
        bus.hydrate({ version: 2, entries: [], outcomeQueue: [] });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('hydrate preserves seq so next propose id does not collide', async () => {
        const data = {
            version: 2,
            entries: [{
                id: 'k_5_aaaaaa',
                kind: 'k',
                sourceCallId: null,
                status: 'pending',
                op: {}, snapshot: null, fingerprint: 'fp:null', meta: null,
                createdAt: 1, decidedAt: null, committedAt: null, rolledBackAt: null,
                conflictInfo: null,
            }],
            outcomeQueue: [],
        };
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        bus.hydrate(data);
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        const seq = Number(id.split('_')[1]);
        expect(seq).toBeGreaterThan(5);
    });
});
