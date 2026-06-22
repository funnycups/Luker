// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Regression: ProposalBus.drainOutcomes() used to fire onChange() after
// splicing the outcome queue. The queue drain is a *read* operation —
// nothing about the visible entry state changes — and the popup's
// onChange handler is the iter-studio `scheduleBusRender` pump. Every
// surplus emit triggered a full re-render of the popup, including the
// inline text-diff loop (which reads layout via window.innerWidth and
// then writes innerHTML, producing forced reflow). Under the orchestrator
// auto-continue loop a single user turn could fan out hundreds of bus
// mutations → hundreds of redundant renders → main-thread starvation
// while the LLM was still streaming.

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
    };
}

describe('ProposalBus — drainOutcomes is render-neutral', () => {
    test('drainOutcomes does NOT fire onChange when there are queued outcomes', async () => {
        const onChange = jest.fn();
        registerTarget('preset', liveHandler({ a: 1 }));
        const bus = createBus({ onChange });
        bus.registerKind('k', { targetType: 'preset' });
        const { id } = await bus.propose({
            kind: 'k', target: { type: 'preset' }, before: { a: 1 }, after: { a: 2 },
        });
        await bus.approve(id);
        // The approve emit is fine; what we lock down is that a subsequent
        // drain — which doesn't change any visible state — must not emit.
        onChange.mockClear();
        const out = bus.drainOutcomes();
        expect(out.length).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('drainOutcomes does NOT fire onChange when the queue is empty', () => {
        const onChange = jest.fn();
        const bus = createBus({ onChange });
        const out = bus.drainOutcomes();
        expect(out).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });
});
