import { describe, test, expect, jest, beforeEach } from '@jest/globals';
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

describe('ProposalBus — auto-approve', () => {
    test('default is off', () => {
        const bus = createBus();
        expect(bus.isAutoApprove()).toBe(false);
    });

    test('setAutoApprove(true) flips state and isAutoApprove reports it', () => {
        const bus = createBus();
        bus.setAutoApprove(true);
        expect(bus.isAutoApprove()).toBe(true);
    });

    test('with auto-approve on, propose schedules commit and entry ends committed', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        bus.setAutoApprove(true);
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await new Promise((r) => setImmediate(r));
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
        expect(handler.write).toHaveBeenCalledTimes(1);
    });

    test('auto-approve commit failure leaves entry in conflict (visible, but not blocking the loop)', async () => {
        // Force commit-time failure by throwing from write.
        const handler = {
            read: async () => ({ a: 1 }),
            write: jest.fn(async () => { throw new Error('boom'); }),
            describe: () => 't',
        };
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        bus.setAutoApprove(true);
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await new Promise((r) => setImmediate(r));
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        // hasOutstanding excludes conflicts so the AI loop continues —
        // the conflict outcome is in the queue for drainOutcomes to
        // report so the AI can decide whether to retry.
        expect(bus.hasOutstanding()).toBe(false);
    });
});
