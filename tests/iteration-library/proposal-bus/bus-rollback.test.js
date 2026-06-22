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

describe('bus.rollback (patch-based)', () => {
    test('rollback applies inverse patch to live', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        expect(h._get()).toEqual({ a: 2 });
        const out = await bus.rollback(id);
        expect(out.ok).toBe(true);
        expect(out.status).toBe('rolledBack');
        expect(h._get()).toEqual({ a: 1 });
    });

    test('rollback on unrelated external change: succeeds and preserves the change', async () => {
        const h = liveHandler({ a: 1, b: 'orig' });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' },
            before: { a: 1, b: 'orig' }, after: { a: 2, b: 'orig' },
        });
        await bus.approve(id);
        // External edit on a path not touched by the turn:
        await h.write({ type: 'preset' }, { a: 2, b: 'externally-edited' });
        const out = await bus.rollback(id);
        expect(out.ok).toBe(true);
        expect(h._get()).toEqual({ a: 1, b: 'externally-edited' });
    });

    test('rollback when patched path was externally mutated → conflict + event', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        await h.write({ type: 'preset' }, { a: 99 });
        const eventSpy = jest.fn();
        bus.events.addEventListener('bus:rollback-failed', eventSpy);
        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(eventSpy).toHaveBeenCalledTimes(1);
        const evt = eventSpy.mock.calls[0][0];
        expect(evt.detail.entryId).toBe(id);
        expect(evt.detail.error.targetType).toBe('preset');
        expect(evt.detail.error.jsonPath).toBe('/a');
    });

    test('rollback on pending entry → no-op (status unchanged)', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const out = await bus.rollback(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('pending');
    });
});
