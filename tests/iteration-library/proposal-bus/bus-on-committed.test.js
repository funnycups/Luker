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

describe('ProposalBus — onCommitted hook', () => {
    test('fires once with the committed entry after a successful approve', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const onCommitted = jest.fn();
        const bus = createBus({ onCommitted });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        expect(onCommitted).not.toHaveBeenCalled();

        const result = await bus.approve(id);
        expect(result).toEqual({ ok: true, status: 'committed' });
        expect(onCommitted).toHaveBeenCalledTimes(1);
        const entry = onCommitted.mock.calls[0][0];
        expect(entry.id).toBe(id);
        expect(entry.status).toBe('committed');
        expect(handler._get()).toEqual({ a: 2 });
    });

    test('does not fire when approve parks a conflict (write fails)', async () => {
        const handler = {
            read: async () => ({ a: 1 }),
            write: jest.fn(async () => { throw new Error('boom'); }),
            describe: () => 't',
        };
        registerTarget('preset', handler);
        const onCommitted = jest.fn();
        const bus = createBus({ onCommitted });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });

        const result = await bus.approve(id);
        expect(result.ok).toBe(false);
        expect(onCommitted).not.toHaveBeenCalled();
    });

    test('does not fire on reject or pending rollback attempts', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const onCommitted = jest.fn();
        const bus = createBus({ onCommitted });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });

        bus.reject(id);
        expect(onCommitted).not.toHaveBeenCalled();
        const rollback = await bus.rollback(id);
        expect(rollback.ok).toBe(false);
        expect(onCommitted).not.toHaveBeenCalled();
    });

    test('fires on the auto-approve commit path', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const onCommitted = jest.fn();
        const bus = createBus({ onCommitted });
        bus.registerKind('k', { targetType: 'preset' });
        bus.setAutoApprove(true);
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await new Promise((r) => setImmediate(r));

        expect(bus._testOnly_entries().find((e) => e.id === id).status).toBe('committed');
        expect(onCommitted).toHaveBeenCalledTimes(1);
    });

    test('a throwing hook does not break the commit contract', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const onCommitted = jest.fn(() => { throw new Error('hook boom'); });
        const bus = createBus({ onCommitted });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });

        const result = await bus.approve(id);
        expect(result).toEqual({ ok: true, status: 'committed' });
        expect(handler._get()).toEqual({ a: 2 });
        expect(bus._testOnly_entries().find((e) => e.id === id).status).toBe('committed');
    });
});
