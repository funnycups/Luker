// The patch-storage spec promised two user-facing escape hatches on
// conflict-state cards: "Discard this step anyway" and "Export change
// details". Before this fix, render-card.js rendered both buttons but
// the event-router silently ignored them and the bus exposed no
// matching methods — so clicks went into the void.
//
// This file pins:
//   - bus.forceDiscard(id) transitions a conflict entry to rolledBack
//     without writing to ST live (the user has decided the drift is
//     real and the turn should not be applied).
//   - bus.exportRecord(id) dispatches `bus:export-record` with the raw
//     inverse patch + target so popups can surface a copy dialog.
//   - The event-router dispatches both data-proposal-action values to
//     the new bus methods.
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

async function parkInConflict(bus, target = { type: 'preset' }) {
    // Propose, then mutate the live state externally on the touched
    // path so approve fails the path-overlap drift check.
    const { id } = await bus.propose({
        kind: 'k', target, before: { a: 1 }, after: { a: 2 },
    });
    return id;
}

function fakeClick({ action, proposalId } = {}) {
    const target = {
        getAttribute: jest.fn((k) => {
            if (k === 'data-proposal-action') return action ?? null;
            if (k === 'data-proposal-id') return proposalId ?? null;
            return null;
        }),
        closest: jest.fn(function (sel) {
            if (sel === '[data-proposal-action]' && action) return this;
            return null;
        }),
    };
    return {
        target,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
    };
}

describe('ProposalBus — forceDiscard', () => {
    test('transitions a conflict entry to rolledBack without writing to ST live', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const id = await parkInConflict(bus);
        // External mutation drives the approve into conflict status.
        await handler.write({ type: 'preset' }, { a: 99 });
        handler.write.mockClear();
        await bus.approve(id);
        const before = bus._testOnly_entries().find((e) => e.id === id);
        expect(before.status).toBe('conflict');

        const result = bus.forceDiscard(id);
        expect(result).toEqual({ ok: true, status: 'rolledBack' });

        const after = bus._testOnly_entries().find((e) => e.id === id);
        expect(after.status).toBe('rolledBack');
        expect(after.rolledBackAt).toEqual(expect.any(Number));
        // The whole point of force-discard: do NOT write to ST. The user
        // has decided the drift is real and the turn should not apply.
        expect(handler.write).not.toHaveBeenCalled();
    });

    test('rejects an entry that is not in conflict status', () => {
        const bus = createBus();
        expect(bus.forceDiscard('nope')).toEqual({ ok: false, status: 'unknown' });
    });

    test('fires onChange so the popup re-renders the card out of conflict chrome', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const onChange = jest.fn();
        const bus = createBus({ onChange });
        bus.registerKind('k', { targetType: 'preset' });
        const id = await parkInConflict(bus);
        await handler.write({ type: 'preset' }, { a: 99 });
        await bus.approve(id);
        onChange.mockClear();
        bus.forceDiscard(id);
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe('ProposalBus — exportRecord', () => {
    test('dispatches bus:export-record with entryId, target, and inverse patch', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const id = await parkInConflict(bus);
        await handler.write({ type: 'preset' }, { a: 99 });
        await bus.approve(id);

        const events = [];
        bus.events.addEventListener('bus:export-record', (e) => events.push(e.detail));

        const result = bus.exportRecord(id);
        expect(result.ok).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            entryId: id,
            kind: 'k',
            target: { type: 'preset' },
            inverse: expect.any(Array),
            status: 'conflict',
            conflictError: expect.objectContaining({ jsonPath: '/a' }),
        });
        // Inverse is a defensive copy so consumers can't mutate the
        // stored entry by chaining .push / .splice on the detail.
        expect(events[0].inverse).not.toBe(handler.read.mock.results[0]);
    });

    test('returns ok:false when the entry id is unknown', () => {
        const bus = createBus();
        expect(bus.exportRecord('does-not-exist')).toEqual({ ok: false, status: 'unknown' });
    });
});

describe('ProposalBus — event router wires conflict-state buttons', () => {
    test('force-discard click routes to bus.forceDiscard and consumes event', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const id = await parkInConflict(bus);
        await handler.write({ type: 'preset' }, { a: 99 });
        await bus.approve(id);

        const evt = fakeClick({ action: 'force-discard', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        expect(evt.preventDefault).toHaveBeenCalled();
        expect(bus._testOnly_entries().find((e) => e.id === id).status).toBe('rolledBack');
    });

    test('export-record click routes to bus.exportRecord and dispatches the event', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        const id = await parkInConflict(bus);
        await handler.write({ type: 'preset' }, { a: 99 });
        await bus.approve(id);

        const events = [];
        bus.events.addEventListener('bus:export-record', (e) => events.push(e.detail));

        const evt = fakeClick({ action: 'export-record', proposalId: id });
        const consumed = await bus.handleClick(evt);
        expect(consumed).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0].entryId).toBe(id);
    });
});
