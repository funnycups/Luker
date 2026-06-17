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
// while the LLM was still streaming. Documented in trace
// Trace-20260617T154806: 1,079 render() calls in 106s, 60% of CPU.
//
// The bus must only fire onChange when entry state actually changes
// (propose / approve / reject / reset / rollback / hydrate). drainOutcomes
// is a pure read of the outcome queue; the renderer can compute "are there
// pending entries left?" from the entries themselves.

import { describe, test, expect, jest } from '@jest/globals';
import { createProposalBus } from '../../../public/scripts/iteration-library/proposal-bus/index.js';

function makeHandler(overrides = {}) {
    return {
        fingerprint: jest.fn(async (snap) => `fp:${JSON.stringify(snap ?? null)}`),
        readCurrent: jest.fn(async () => ({ snapshot: null, fingerprint: 'fp:null' })),
        commit: jest.fn(async () => {}),
        inverse: jest.fn(() => null),
        renderDiffCard: jest.fn(() => ''),
        label: jest.fn(() => ''),
        icon: jest.fn(() => ''),
        target: jest.fn(() => ''),
        ...overrides,
    };
}

describe('ProposalBus — drainOutcomes is render-neutral', () => {
    test('drainOutcomes does NOT fire onChange when there are queued outcomes', async () => {
        const onChange = jest.fn();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange });
        bus.registerKind('k', makeHandler());
        const { id } = await bus.propose({ kind: 'k', op: {}, snapshot: null });
        await bus.approve(id);
        // The approve emit is fine; what we lock down is that a subsequent
        // *drain* — which doesn't change any visible state — must not
        // emit. The popup's re-render is wired to onChange, and a render
        // is wasted whenever it fires without a state change.
        onChange.mockClear();
        const out = bus.drainOutcomes();
        expect(out.length).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('drainOutcomes does NOT fire onChange when the queue is empty', () => {
        const onChange = jest.fn();
        const bus = createProposalBus({ mode: 't', i18n: (s) => s, onChange });
        // Nothing in the queue — but the old behaviour still fired onChange
        // unconditionally, so popups got a redundant render every time the
        // scheduler called drain after a microtask flush.
        const out = bus.drainOutcomes();
        expect(out).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });
});
