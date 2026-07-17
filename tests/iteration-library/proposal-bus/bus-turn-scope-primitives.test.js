// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Unit tests for the bus-side primitives the studios' drain-gate
// consumes: `listPending()` + outcomes carrying `sourceCallId`.
//
// The gate itself lives in each studio's drainBusOutcomes and joins
// bus data with the studio's session.messages to compute the owning
// assistant message — the true "batch boundary" is per-assistant-
// message, not per-tool-call. See
// tests/e2e/regression/118-iter-studio-batch-approval-gate.e2e.js
// for the black-box behavior under real DOM + rAF + LLM.
//
// hasPendingSiblingsFor is retained for backwards compat but
// intentionally NOT re-covered here as a public contract; a
// deprecation JSDoc lives on it in bus.js.

import { jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';

function makeHandler(initial = {}) {
    let state = JSON.parse(JSON.stringify(initial));
    return {
        read: jest.fn(async () => JSON.parse(JSON.stringify(state))),
        write: jest.fn(async (_meta, next) => { state = JSON.parse(JSON.stringify(next)); }),
        describe: () => 'thing',
    };
}

async function proposePending(bus, sourceCallId, patch) {
    return bus.propose({
        kind: 'k',
        target: { type: 'preset' },
        before: {},
        after: patch,
        sourceCallId,
    });
}

beforeEach(() => clearRegistry());

describe('bus.listPending — exposes {id, sourceCallId} for pending entries only', () => {
    test('empty bus returns []', () => {
        const bus = createBus();
        expect(bus.listPending()).toEqual([]);
    });

    test('returns each pending entry with its id and sourceCallId', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        const a = await proposePending(bus, 'call-a', { x: 1 });
        const b = await proposePending(bus, 'call-b', { y: 1 });
        const listed = bus.listPending();
        expect(listed).toHaveLength(2);
        // Order is entry insertion order.
        expect(listed[0]).toEqual({ id: a.id, sourceCallId: 'call-a' });
        expect(listed[1]).toEqual({ id: b.id, sourceCallId: 'call-b' });
    });

    test('excludes committed / rejected / conflict / rolledBack entries', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        const a = await proposePending(bus, 'call-a', { x: 1 });
        const b = await proposePending(bus, 'call-b', { y: 1 });
        const c = await proposePending(bus, 'call-c', { z: 1 });
        await bus.approve(a.id);
        bus.reject(b.id);
        expect(bus.listPending()).toEqual([{ id: c.id, sourceCallId: 'call-c' }]);
    });

    test('missing sourceCallId is normalized to empty string', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        await bus.propose({ kind: 'k', target: { type: 'preset' }, before: {}, after: { a: 1 } });
        const listed = bus.listPending();
        expect(listed).toHaveLength(1);
        expect(listed[0].sourceCallId).toBe('');
    });
});

describe('drainOutcomes — outcomes carry sourceCallId so studios can resolve owning messages', () => {
    test('committed outcome carries the entry sourceCallId', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        const a = await proposePending(bus, 'tool-call-A', { x: 1 });
        await bus.approve(a.id);
        const drained = bus.drainOutcomes();
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
            id: a.id,
            status: 'committed',
            sourceCallId: 'tool-call-A',
        });
    });

    test('rejected outcome carries the entry sourceCallId', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        const a = await proposePending(bus, 'tool-call-B', { y: 1 });
        bus.reject(a.id);
        const drained = bus.drainOutcomes();
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
            id: a.id,
            status: 'rejected',
            sourceCallId: 'tool-call-B',
        });
    });

    test('outcome sourceCallId is empty string when entry had no sourceCallId', async () => {
        const bus = createBus();
        bus.registerKind('k', { targetType: 'preset' });
        registerTarget('preset', makeHandler());
        const a = await bus.propose({ kind: 'k', target: { type: 'preset' }, before: {}, after: { a: 1 } });
        await bus.approve(a.id);
        const drained = bus.drainOutcomes();
        expect(drained[0].sourceCallId).toBe('');
    });
});
