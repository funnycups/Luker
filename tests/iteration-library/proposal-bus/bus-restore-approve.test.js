import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';
import { STATE_ERROR_REASONS, CONFLICT_CODES } from '/scripts/lib/state-errors.js';
import { STR, conflictSummaryKey } from '/scripts/iteration-library/ui/strings.js';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let root;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'bus-codec-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

beforeEach(() => clearRegistry());

function liveHandler(initial) {
    const file = join(root, 'document.json');
    fs.writeFileSync(file, JSON.stringify(initial));
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
        read: jest.fn(async () => read()),
        write: jest.fn(async (_meta, next) => { await fs.promises.writeFile(file, JSON.stringify(next)); }),
        describe: () => 't',
        _get: read,
        _set: next => fs.writeFileSync(file, JSON.stringify(next)),
    };
}

const TARGET = { type: 'preset', name: 'P' };

function newBus() {
    const bus = createBus();
    bus.registerKind('k', { targetType: 'preset' });
    return bus;
}

// Simulates a reload: the serialized blob goes through JSON (as every
// studio persists it) and is hydrated into a fresh bus instance.
function reload(bus) {
    const blob = JSON.parse(JSON.stringify(bus.serialize()));
    const next = newBus();
    next.hydrate(blob);
    return next;
}

describe('ProposalBus — approving proposals restored from a serialized session', () => {
    test('approve after reload writes the proposed state', async () => {
        const before = { a: 1, b: { c: 2 }, list: ['x', 'y', 'z'] };
        const after = { a: 1, b: { c: 3 }, d: 4, list: ['x', 'z'] };
        const handler = liveHandler(before);
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before, after });

        const restored = reload(bus);
        const out = await restored.approve(id);

        expect(out).toMatchObject({ ok: true, status: 'committed' });
        expect(handler._get()).toEqual(after);
    });

    test('approve after reload keeps external edits on untouched paths', async () => {
        const before = { a: 1, b: { c: 2 } };
        const after = { a: 1, b: { c: 3 } };
        const handler = liveHandler(before);
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before, after });

        const restored = reload(bus);
        handler._set({ a: 9, b: { c: 2 } });
        const out = await restored.approve(id);

        expect(out.ok).toBe(true);
        expect(handler._get()).toEqual({ a: 9, b: { c: 3 } });
    });

    test('drift on a patched path after reload parks a conflict without writing', async () => {
        const before = { a: 1, b: { c: 2 } };
        const after = { a: 1, b: { c: 3 } };
        const handler = liveHandler(before);
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before, after });

        const restored = reload(bus);
        handler._set({ a: 1, b: { c: 7 } });
        handler.write.mockClear();
        const out = await restored.approve(id);

        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.CONFLICT });
        expect(handler.write).not.toHaveBeenCalled();
        expect(handler._get()).toEqual({ a: 1, b: { c: 7 } });
        const entry = restored.listEntries().find((e) => e.id === id);
        expect(entry.conflictError).toMatchObject({ jsonPath: '/b/c' });
    });

    test('an added key that already exists after reload parks a conflict', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before: { a: 1 }, after: { a: 1, d: 4 } });

        const restored = reload(bus);
        handler._set({ a: 1, d: 5 });
        handler.write.mockClear();
        const out = await restored.approve(id);

        expect(out.status).toBe('conflict');
        expect(handler.write).not.toHaveBeenCalled();
    });

    test('legacy entry without a forward patch parks as not restorable', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        bus.hydrate({
            version: 3,
            entries: [{
                id: 'k_1_legacy', kind: 'k', target: TARGET,
                inverse: [{ op: 'replace', path: '/a', value: 1 }],
                status: 'pending', sourceCallId: 'c1', meta: null, createdAt: 1,
                decidedAt: null, committedAt: null, rolledBackAt: null, conflictError: null,
            }],
            outcomeQueue: [],
        });
        const out = await bus.approve('k_1_legacy');

        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.REPLAY_BROKEN });
        expect(handler.write).not.toHaveBeenCalled();
        const entry = bus.listEntries()[0];
        expect(entry.conflictError).toMatchObject({
            reason: STATE_ERROR_REASONS.REPLAY_BROKEN,
            code: CONFLICT_CODES.NOT_RESTORABLE,
        });
        expect(conflictSummaryKey(entry.conflictError, 'preset')).toBe(STR.notRestorable_generic);
        const outcome = bus.drainOutcomes()[0];
        expect(outcome).toMatchObject({ id: 'k_1_legacy', status: 'conflict', reason: STATE_ERROR_REASONS.REPLAY_BROKEN });
    });

    test('drift conflicts keep the per-target card summary', () => {
        expect(conflictSummaryKey({ reason: STATE_ERROR_REASONS.CONFLICT }, 'preset')).toBe(STR.rollbackFail_preset);
        expect(conflictSummaryKey({ reason: STATE_ERROR_REASONS.REPLAY_BROKEN }, 'lorebook')).toBe(STR.rollbackFail_lorebook);
    });

    test('legacy entry with an empty inverse still commits a write', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        bus.hydrate({
            version: 3,
            entries: [{
                id: 'k_1_empty', kind: 'k', target: TARGET, inverse: [],
                status: 'pending', sourceCallId: 'c1', meta: null, createdAt: 1,
                decidedAt: null, committedAt: null, rolledBackAt: null, conflictError: null,
            }],
            outcomeQueue: [],
        });
        const out = await bus.approve('k_1_empty');

        expect(out.ok).toBe(true);
        expect(handler.write).toHaveBeenCalledTimes(1);
        expect(handler._get()).toEqual({ a: 1 });
    });

    test('a committed entry restored again still rolls back', async () => {
        const before = { a: 1, b: { c: 2 } };
        const after = { a: 1, b: { c: 3 } };
        const handler = liveHandler(before);
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before, after });
        const restored = reload(bus);
        await restored.approve(id);

        const restoredAgain = reload(restored);
        const out = await restoredAgain.rollback(id);

        expect(out).toMatchObject({ ok: true, status: 'rolledBack' });
        expect(handler._get()).toEqual(before);
    });

    test('rollback right after a restored approve checks drift against the committed state', async () => {
        const before = { a: 1 };
        const after = { a: 2 };
        const handler = liveHandler(before);
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before, after });
        const restored = reload(bus);
        await restored.approve(id);

        handler._set({ a: 5 });
        handler.write.mockClear();
        const out = await restored.rollback(id);

        expect(out.status).toBe('conflict');
        expect(handler.write).not.toHaveBeenCalled();
    });

    test('serialized entries carry a forward patch and no snapshot', async () => {
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = newBus();
        await bus.propose({ kind: 'k', target: TARGET, before: { a: 1 }, after: { a: 2 } });
        const [entry] = bus.serialize().entries;
        expect(entry.forward).toEqual([{ op: 'replace', path: '/a', value: 2 }]);
        expect(entry).not.toHaveProperty('_pendingAfter');
    });

    test('a restored pending entry feeds the pending chain for the next proposal', async () => {
        const handler = liveHandler({ a: 1, b: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        const first = await bus.propose({ kind: 'k', target: TARGET, before: { a: 1, b: 1 }, after: { a: 2, b: 1 } });

        const restored = reload(bus);
        const spy = jest.fn();
        restored.events.addEventListener('bus:chain-broken', spy);
        const chained = await restored.getCurrentPendingState('k', TARGET);
        expect(chained).toEqual({ a: 2, b: 1 });
        const second = await restored.propose({ kind: 'k', target: TARGET, before: chained, after: { a: 3, b: 1 } });

        expect(await restored.approve(first.id)).toMatchObject({ ok: true, status: 'committed' });
        expect(await restored.approve(second.id)).toMatchObject({ ok: true, status: 'committed' });
        expect(handler._get()).toEqual({ a: 3, b: 1 });
        expect(spy).not.toHaveBeenCalled();
    });

    test('drift under a restored pending entry breaks the chain at that entry', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        await bus.propose({ kind: 'k', target: TARGET, before: { a: 1 }, after: { a: 2 } });

        const restored = reload(bus);
        handler._set({ a: 7 });
        const spy = jest.fn();
        restored.events.addEventListener('bus:chain-broken', spy);
        expect(await restored.getCurrentPendingState('k', TARGET)).toEqual({ a: 7 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('a legacy pending entry without a forward patch is left out of the chain', async () => {
        const handler = liveHandler({ a: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        bus.hydrate({
            version: 3,
            entries: [{
                id: 'k_1_legacy', kind: 'k', target: TARGET,
                inverse: [{ op: 'replace', path: '/a', value: 1 }],
                status: 'pending', sourceCallId: 'c1', meta: null, createdAt: 1,
                decidedAt: null, committedAt: null, rolledBackAt: null, conflictError: null,
            }],
            outcomeQueue: [],
        });
        const spy = jest.fn();
        bus.events.addEventListener('bus:chain-broken', spy);
        expect(await bus.getCurrentPendingState('k', TARGET)).toEqual({ a: 1 });
        expect(spy).not.toHaveBeenCalled();
    });

    test('re-applying forward on a path removed after reload parks a conflict', async () => {
        const handler = liveHandler({ a: 1, b: 1 });
        registerTarget('preset', handler);
        const bus = newBus();
        const { id } = await bus.propose({ kind: 'k', target: TARGET, before: { a: 1, b: 1 }, after: { a: 2, b: 1 } });

        const restored = reload(bus);
        handler._set({ b: 1 });
        handler.write.mockClear();
        const out = await restored.approve(id);

        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.CONFLICT });
        expect(handler.write).not.toHaveBeenCalled();
        const entry = restored.listEntries().find((e) => e.id === id);
        expect(entry.conflictError).toMatchObject({ jsonPath: '/a' });
        expect(handler._get()).toEqual({ b: 1 });
    });
});
