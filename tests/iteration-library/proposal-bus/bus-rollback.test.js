import { jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';
import { STATE_ERROR_REASONS } from '/scripts/lib/state-errors.js';

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

    test.each([
        ['VALIDATION_ARGS on read', 'read', Object.assign(new Error('bad args'), { reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'bad args' }), STATE_ERROR_REASONS.VALIDATION_ARGS],
        ['VALIDATION_TARGET on read', 'read', Object.assign(new Error('missing target'), { reason: STATE_ERROR_REASONS.VALIDATION_TARGET, hint: 'missing target' }), STATE_ERROR_REASONS.VALIDATION_TARGET],
        ['HTTP_ERROR on write', 'write', Object.assign(new Error('server error'), { status: 503, statusText: 'Service Unavailable' }), STATE_ERROR_REASONS.HTTP_ERROR],
        ['TRANSPORT_ERROR on write (AbortError)', 'write', Object.assign(new Error('network aborted'), { name: 'AbortError' }), STATE_ERROR_REASONS.TRANSPORT_ERROR],
    ])('rollback preserves non-conflict error reason: %s', async (_label, op, thrownErr, expectedReason) => {
        let state = { a: 1 };
        let failNow = false;
        registerTarget('preset', {
            read: jest.fn(async () => {
                if (failNow && op === 'read') throw thrownErr;
                return JSON.parse(JSON.stringify(state));
            }),
            write: jest.fn(async (_meta, next) => {
                if (failNow && op === 'write') throw thrownErr;
                state = JSON.parse(JSON.stringify(next));
            }),
            describe: () => 'thing',
        });
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        bus.drainOutcomes();
        failNow = true;

        const eventSpy = jest.fn();
        bus.events.addEventListener('bus:rollback-failed', eventSpy);
        const out = await bus.rollback(id);
        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: expectedReason });
        expect(bus.listEntries()[0].conflictError.reason).toBe(expectedReason);
        expect(bus.drainOutcomes()[0].reason).toBe(expectedReason);
        expect(eventSpy).toHaveBeenCalledTimes(1);
        expect(eventSpy.mock.calls[0][0].detail.error).toBe(thrownErr);
    });
});

describe('bus.rollbackAllInMessages & bus.discardEntries (turn truncation)', () => {
    test('discardEntries isolates proposals and outcomes when tool-call ids repeat', () => {
        let changes = 0;
        const bus = createBus({ onChange: () => { changes++; } });
        bus.hydrate({
            version: 3,
            entries: [
                { id: 'kept_pending', status: 'pending' },
                { id: 'dropped_pending', status: 'pending' },
                { id: 'kept_outcome', status: 'rejected' },
                { id: 'dropped_outcome', status: 'rejected' },
            ].map(entry => ({
                ...entry,
                kind: 'k',
                target: { type: 'preset' },
                sourceCallId: 'reused_call',
                forward: [{ op: 'replace', path: '/a', value: 2 }],
                inverse: [{ op: 'replace', path: '/a', value: 1 }],
            })),
            outcomeQueue: ['kept_outcome', 'dropped_outcome'].map(id => ({
                id, kind: 'k', status: 'rejected', target: 'preset', sourceCallId: 'reused_call',
            })),
        });
        const beforeDiscard = changes;

        expect(typeof bus.discardEntries).toBe('function');
        const summary = bus.discardEntries(['dropped_pending', 'dropped_outcome']);
        expect(summary).toEqual({ rejected: 1, prunedOutcomes: 1 });
        expect(bus.listEntries().find(entry => entry.id === 'kept_pending').status).toBe('pending');
        expect(bus.listEntries().find(entry => entry.id === 'dropped_pending').status).toBe('rejected');
        expect(bus.drainOutcomes().map(outcome => outcome.id)).toEqual(['kept_outcome']);
        expect(changes).toBe(beforeDiscard);
    });

    test('rollbackAllInMessages unwinds live without firing onChange or enqueueing outcomes', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const onChange = jest.fn();
        const bus = createBus({ onChange });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 }, sourceCallId: 'c1',
        });
        await bus.approve(id);
        bus.drainOutcomes();
        onChange.mockClear();

        const out = await bus.rollbackAllInMessages([{ toolCalls: [{ id: 'c1' }] }]);
        expect(out.ok).toBe(true);
        expect(h._get()).toEqual({ a: 1 });
        expect(bus.drainOutcomes()).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('rollbackAllInMessages conflict notifies onChange to render conflict without enqueueing outcome', async () => {
        const h = liveHandler({ a: 1 });
        registerTarget('preset', h);
        const onChange = jest.fn();
        const bus = createBus({ onChange });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 }, sourceCallId: 'c1',
        });
        await bus.approve(id);
        bus.drainOutcomes();
        await h.write({ type: 'preset' }, { a: 99 });
        onChange.mockClear();

        const out = await bus.rollbackAllInMessages([{ toolCalls: [{ id: 'c1' }] }]);
        expect(out.ok).toBe(false);
        expect(out.failedAt.status).toBe('conflict');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(bus.drainOutcomes()).toEqual([]);
    });
});
