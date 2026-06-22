import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

function liveHandler(initial) {
    let s = JSON.parse(JSON.stringify(initial));
    return {
        read: async () => JSON.parse(JSON.stringify(s)),
        write: async (_meta, next) => { s = JSON.parse(JSON.stringify(next)); },
        describe: () => 't',
    };
}

describe('ProposalBus — reject + reset', () => {
    test('reject flips pending to rejected and stamps decidedAt', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        bus.reject(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('rejected');
        expect(typeof entry.decidedAt).toBe('number');
    });

    test('reject enqueues a rejected outcome', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        bus.reject(id);
        const outcomes = bus.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].status).toBe('rejected');
    });

    test('rejected entry does NOT count as outstanding', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        bus.reject(id);
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('reset flips rejected back to pending and clears decidedAt', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        bus.reject(id);
        bus.reset(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('pending');
        expect(entry.decidedAt).toBe(null);
    });

    test('reset on committed entry is a no-op', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        bus.reset(id);
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('committed');
    });

    test('reject on unknown id is silent', () => {
        const bus = createBus();
        expect(() => bus.reject('nope')).not.toThrow();
    });
});
