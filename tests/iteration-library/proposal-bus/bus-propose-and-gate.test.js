import { jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

function makeHandler(initialState) {
    let state = JSON.parse(JSON.stringify(initialState));
    return {
        read: jest.fn(async () => JSON.parse(JSON.stringify(state))),
        write: jest.fn(async (_meta, next) => { state = JSON.parse(JSON.stringify(next)); }),
        describe: () => 'thing',
        _get: () => state,
    };
}

beforeEach(() => clearRegistry());

describe('bus.propose (patch-based)', () => {
    test('registerKind rejects duplicate kind', () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        expect(() => bus.registerKind('k', { targetType: 'preset' })).toThrow(/already registered/);
    });

    test('propose with identical before/after produces empty inverse but still records entry', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler({ x: 1 }));
        const out = await bus.propose({
            kind: 'k',
            target: { type: 'preset' },
            before: { x: 1 },
            after: { x: 1 },
        });
        expect(typeof out.id).toBe('string');
        const entries = bus._testOnly_entries();
        expect(entries).toHaveLength(1);
        expect(entries[0].inverse).toEqual([]);
        expect(entries[0].target).toEqual({ type: 'preset' });
        expect(entries[0]).not.toHaveProperty('snapshot');
        expect(entries[0]).not.toHaveProperty('op');
        expect(entries[0]).not.toHaveProperty('fingerprint');
    });

    test('propose with real change stores inverse patch', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler({ a: 1 }));
        await bus.propose({
            kind: 'k',
            target: { type: 'preset' },
            before: { a: 1 },
            after: { a: 2 },
        });
        const entries = bus._testOnly_entries();
        expect(entries[0].inverse).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
    });

    test('propose fires onChange exactly once', async () => {
        const onChange = jest.fn();
        const bus = createBus({ onChange });
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler({ a: 1 }));
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 } });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('hasOutstanding gates on pending entries', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler({}));
        expect(bus.hasOutstanding()).toBe(false);
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: {}, after: { a: 1 } });
        expect(bus.hasOutstanding()).toBe(true);
    });

    test('propose throws when target type is unknown to the registry', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        await expect(bus.propose({
            kind: 'k', target: { type: 'unknown' }, before: {}, after: {},
        })).rejects.toThrow(/unknown target/i);
    });
});
