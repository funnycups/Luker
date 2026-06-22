import { jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

function liveHandler(initial) {
    let s = JSON.parse(JSON.stringify(initial));
    return {
        read: jest.fn(async () => JSON.parse(JSON.stringify(s))),
        write: jest.fn(async (_meta, next) => { s = JSON.parse(JSON.stringify(next)); }),
        describe: () => 't',
        _get: () => s,
    };
}

function buildMessage(msgId, n) {
    return {
        id: msgId,
        toolCalls: Array.from({ length: n }, (_, i) => ({ id: `call_${msgId}_${i}` })),
    };
}

async function seedChainedTurn(bus, msgId, n) {
    // Propose n entries whose `before` chains to the prior `after`, the
    // same shape iter-studio popups produce: live stays at the original
    // state, the bus tracks the projected chain via _pendingAfter.
    const ids = [];
    for (let i = 0; i < n; i++) {
        const before = i === 0 ? { v: 0 } : { v: i };
        const after = { v: i + 1 };
        const { id } = await bus.propose({
            kind: 'k',
            target: { type: 'preset' },
            sourceCallId: `call_${msgId}_${i}`,
            before,
            after,
        });
        ids.push(id);
    }
    return ids;
}

describe('ProposalBus — turn-scoped actions (patch-based)', () => {
    test('approveAllPendingInTurn commits every pending entry belonging to the message', async () => {
        const handler = liveHandler({ v: 0 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await seedChainedTurn(bus, 'm1', 3);
        const out = await bus.approveAllPendingInTurn(buildMessage('m1', 3));
        expect(out.results).toHaveLength(3);
        expect(out.results.every((r) => r.ok && r.status === 'committed')).toBe(true);
        expect(handler.write).toHaveBeenCalledTimes(3);
        expect(handler._get()).toEqual({ v: 3 });
    });

    test('approveAllPendingInTurn skips entries from other messages', async () => {
        const handler = liveHandler({ v: 0 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        // m1 chain
        await bus.propose({ kind: 'k', target: { type: 'preset' }, sourceCallId: 'call_m1_0', before: { v: 0 }, after: { v: 1 } });
        await bus.propose({ kind: 'k', target: { type: 'preset' }, sourceCallId: 'call_m1_1', before: { v: 1 }, after: { v: 2 } });
        // m2 (different sourceCallId)
        await bus.propose({ kind: 'k', target: { type: 'preset' }, sourceCallId: 'call_m2_0', before: { v: 2 }, after: { v: 9 } });
        handler.write.mockClear();
        const out = await bus.approveAllPendingInTurn(buildMessage('m1', 2));
        expect(out.results).toHaveLength(2);
        expect(handler.write).toHaveBeenCalledTimes(2);
        expect(handler._get()).toEqual({ v: 2 });
    });

    test('rejectAllPendingInTurn flips matching pending entries to rejected', async () => {
        const handler = liveHandler({ v: 0 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await seedChainedTurn(bus, 'm1', 3);
        const out = bus.rejectAllPendingInTurn(buildMessage('m1', 3));
        expect(out.count).toBe(3);
        const stillPending = bus._testOnly_entries().filter((e) => e.status === 'pending');
        expect(stillPending).toHaveLength(0);
    });

    test('rollbackAllInTurn walks committed entries in reverse commit order', async () => {
        const handler = liveHandler({ v: 0 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        // Propose then immediately approve three entries.
        for (let i = 0; i < 3; i++) {
            const { id } = await bus.propose({
                kind: 'k', target: { type: 'preset' },
                sourceCallId: `call_m1_${i}`,
                before: { v: i }, after: { v: i + 1 },
            });
            await bus.approve(id);
            await new Promise((r) => setTimeout(r, 2));
        }
        expect(handler._get()).toEqual({ v: 3 });
        const out = await bus.rollbackAllInTurn(buildMessage('m1', 3));
        expect(out.results).toHaveLength(3);
        // Rollbacks reverse the chain back to the first entry's `before`
        expect(handler._get()).toEqual({ v: 0 });
    });
});
