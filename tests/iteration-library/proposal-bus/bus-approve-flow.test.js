import { jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

function liveHandler(initial) {
    let s = JSON.parse(JSON.stringify(initial));
    return {
        read: jest.fn(async () => JSON.parse(JSON.stringify(s))),
        write: jest.fn(async (_meta, next) => { s = JSON.parse(JSON.stringify(next)); }),
        describe: () => 'thing',
        _get: () => s,
    };
}

describe('bus.approve (patch-based commit)', () => {
    test('approve writes the after-state to the target handler', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const out = await bus.approve(id);
        expect(out.ok).toBe(true);
        expect(out.status).toBe('committed');
        expect(h.write).toHaveBeenCalledWith({ type: 'preset' }, { a: 2 });
        expect(h._get()).toEqual({ a: 2 });
    });

    test('approve when ST live has drifted on a patched path → conflict, no write', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        // External mutation on the touched path before approve.
        await h.write({ type: 'preset' }, { a: 99 });
        h.write.mockClear();
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(h.write).not.toHaveBeenCalled();
    });

    test('approve when ST live has drifted on an UNRELATED path → still succeeds', async () => {
        const h = liveHandler({ a: 1, b: 'untouched' });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' },
            before: { a: 1, b: 'untouched' },
            after:  { a: 2, b: 'untouched' },
        });
        await h.write({ type: 'preset' }, { a: 1, b: 'changed externally' });
        h.write.mockClear();
        const out = await bus.approve(id);
        expect(out.ok).toBe(true);
        // The unrelated external change is preserved.
        expect(h._get()).toEqual({ a: 2, b: 'changed externally' });
    });

    test('already-committed entry returns previous status', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('committed');
    });
});
