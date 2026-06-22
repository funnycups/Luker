import { jest } from '@jest/globals';
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

describe('bus.getCurrentPendingState', () => {
    test('returns live verbatim when no pending entries', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const out = await bus.getCurrentPendingState('k', { type: 'preset' });
        expect(out).toEqual({ a: 1 });
    });

    test('applies multiple pending entries in order', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 } });
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: { a: 2 }, after: { a: 3 } });
        const out = await bus.getCurrentPendingState('k', { type: 'preset' });
        expect(out).toEqual({ a: 3 });
    });

    test('ignores entries of a different kind or target', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        registerTarget('schema', liveHandler({ b: 1 }));
        const bus = createBus();
        bus.registerKind('k1', { targetType: 'preset' });
        bus.registerKind('k2', { targetType: 'schema' });
        await bus.propose({ kind: 'k1', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 } });
        await bus.propose({ kind: 'k2', target: { type: 'schema' }, before: { b: 1 }, after: { b: 9 } });
        expect(await bus.getCurrentPendingState('k1', { type: 'preset' })).toEqual({ a: 2 });
        expect(await bus.getCurrentPendingState('k2', { type: 'schema' })).toEqual({ b: 9 });
    });

    test('emits bus:chain-broken and returns last-good state on patch failure', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 } });
        // Externally mutate the live so the pending chain becomes inconsistent.
        await handler.write({ type: 'preset' }, { a: 99 });
        const spy = jest.fn();
        bus.events.addEventListener('bus:chain-broken', spy);
        const out = await bus.getCurrentPendingState('k', { type: 'preset' });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(out).toEqual({ a: 99 });   // last-good = live, 0 patches applied
    });
});
