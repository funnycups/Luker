import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler() {
    return {
        fingerprint: async (s) => `fp:${JSON.stringify(s ?? null)}`,
        readCurrent: async (op) => ({ snapshot: op?.snapshot ?? null, fingerprint: `fp:${JSON.stringify(op?.snapshot ?? null)}` }),
        commit: jest.fn(async () => {}),
        inverse: jest.fn((op, snap) => ({ undo: op, was: snap })),
        renderDiffCard: () => '',
        label: () => '',
        icon: () => '',
        target: () => '',
    };
}

async function seedTurn(bus, msgId, n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
        const { id } = await bus.propose({
            kind: 'k',
            sourceCallId: `call_${msgId}_${i}`,
            op: { i, snapshot: { i } },
            snapshot: { i },
        });
        ids.push(id);
    }
    return ids;
}

function buildMessage(msgId, n) {
    return {
        id: msgId,
        toolCalls: Array.from({ length: n }, (_, i) => ({ id: `call_${msgId}_${i}` })),
    };
}

describe('ProposalBus — turn-scoped actions', () => {
    test('approveAllPendingInTurn commits every pending entry belonging to the message', async () => {
        const handler = makeHandler();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        await seedTurn(bus, 'm1', 3);
        const msg = buildMessage('m1', 3);
        const out = await bus.approveAllPendingInTurn(msg);
        expect(out.results).toHaveLength(3);
        expect(out.results.every((r) => r.ok && r.status === 'committed')).toBe(true);
        expect(handler.commit).toHaveBeenCalledTimes(3);
    });

    test('approveAllPendingInTurn skips entries from other messages', async () => {
        const handler = makeHandler();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        await seedTurn(bus, 'm1', 2);
        await seedTurn(bus, 'm2', 2);
        const out = await bus.approveAllPendingInTurn(buildMessage('m1', 2));
        expect(out.results).toHaveLength(2);
        expect(handler.commit).toHaveBeenCalledTimes(2);
    });

    test('rejectAllPendingInTurn flips matching pending entries to rejected', async () => {
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', makeHandler());
        await seedTurn(bus, 'm1', 3);
        const out = bus.rejectAllPendingInTurn(buildMessage('m1', 3));
        expect(out.count).toBe(3);
        const stillPending = bus._testOnly_entries().filter((e) => e.status === 'pending');
        expect(stillPending).toHaveLength(0);
    });

    test('rollbackAllInTurn walks committed entries in reverse commit order', async () => {
        const inverseCalls = [];
        const commitInvocations = [];
        const handler = {
            ...makeHandler(),
            commit: jest.fn(async (op) => { commitInvocations.push(op); }),
            inverse: jest.fn((op) => { inverseCalls.push(op); return { inverseOf: op }; }),
        };
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange: () => {} });
        bus.registerKind('k', handler);
        const ids = await seedTurn(bus, 'm1', 3);
        // sequence approve in order; bus stamps committedAt
        await bus.approve(ids[0]); await new Promise((r) => setTimeout(r, 2));
        await bus.approve(ids[1]); await new Promise((r) => setTimeout(r, 2));
        await bus.approve(ids[2]); await new Promise((r) => setTimeout(r, 2));
        commitInvocations.length = 0;
        await bus.rollbackAllInTurn(buildMessage('m1', 3));
        expect(commitInvocations.map((o) => o.inverseOf.i)).toEqual([2, 1, 0]);
    });
});
