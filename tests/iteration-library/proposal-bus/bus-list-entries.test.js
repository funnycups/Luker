import { describe, test, expect, beforeEach } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { clearRegistry, registerTarget } from '/scripts/iteration-library/storage/target-registry.js';

const store = { tide: { bell: 'second' } };

beforeEach(() => {
    clearRegistry();
    store.tide = { bell: 'second' };
    registerTarget('tide-log', {
        read: async () => structuredClone(store.tide),
        write: async (_t, next) => { store.tide = structuredClone(next); },
        describe: () => 'tide-log',
    });
});

function makeBus() {
    const bus = createBus();
    bus.registerKind('profile-edit', { kind: 'profile-edit', targetType: 'tide-log' });
    return bus;
}

describe('bus.listEntries', () => {
    test('lists every entry with its status in proposal order', async () => {
        const bus = makeBus();
        const a = await bus.propose({ kind: 'profile-edit', target: { type: 'tide-log' }, before: { bell: 'second' }, after: { bell: 'third' }, sourceCallId: 'c1' });
        const b = await bus.propose({ kind: 'profile-edit', target: { type: 'tide-log' }, before: { bell: 'second' }, after: { bell: 'ebb' }, sourceCallId: 'c2' });
        await bus.approve(a.id);
        expect(bus.listEntries().map((e) => [e.id, e.sourceCallId, e.status])).toEqual([
            [a.id, 'c1', 'committed'],
            [b.id, 'c2', 'pending'],
        ]);
    });

    test('returned entries are copies', async () => {
        const bus = makeBus();
        const { id } = await bus.propose({ kind: 'profile-edit', target: { type: 'tide-log' }, before: { bell: 'second' }, after: { bell: 'third' }, sourceCallId: 'c1' });
        bus.listEntries()[0].status = 'rejected';
        expect(bus.listEntries().find((e) => e.id === id).status).toBe('pending');
    });
});
