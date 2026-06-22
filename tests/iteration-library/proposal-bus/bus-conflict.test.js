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
        _set: (next) => { s = JSON.parse(JSON.stringify(next)); },
    };
}

describe('ProposalBus — conflict detection (patch-based)', () => {
    test('path-overlap drift flips status to conflict and skips write', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        // External mutation on the touched path.
        await handler.write({ type: 'preset' }, { a: 99 });
        handler.write.mockClear();
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(handler.write).not.toHaveBeenCalled();
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictError).toMatchObject({
            targetType: 'preset',
            jsonPath: '/a',
        });
    });

    test('conflict entry does NOT count as outstanding (write was dropped, AI notified via outcome)', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await handler.write({ type: 'preset' }, { a: 99 });
        await bus.approve(id);
        // The auto-continue loop checks hasOutstanding to decide whether
        // to fire another round. Treating conflicts as outstanding
        // strands the loop indefinitely because the user has no useful
        // action — the conflict outcome is already in the queue.
        expect(bus.hasOutstanding()).toBe(false);
    });

    test('write-throw flips status to conflict and records error', async () => {
        const handler = {
            read: async () => ({ a: 1 }),
            write: jest.fn(async () => { throw new Error('network broke'); }),
            describe: () => 't',
        };
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(out.error).toContain('network broke');
        const entry = bus._testOnly_entries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictError.reason).toContain('network broke');
    });

    test('read-throw also goes to conflict', async () => {
        const handler = {
            read: async () => { throw new Error('disk gone'); },
            write: jest.fn(),
            describe: () => 't',
        };
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        const out = await bus.approve(id);
        expect(out.ok).toBe(false);
        expect(out.status).toBe('conflict');
        expect(out.error).toContain('disk gone');
    });

    test('re-approving a conflict entry retries and can succeed once disk converges', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        // Drift first
        await handler.write({ type: 'preset' }, { a: 99 });
        let out = await bus.approve(id);
        expect(out.status).toBe('conflict');
        // Converge live back to the propose-time before, then retry
        await handler.write({ type: 'preset' }, { a: 1 });
        out = await bus.approve(id);
        expect(out.status).toBe('committed');
    });
});
