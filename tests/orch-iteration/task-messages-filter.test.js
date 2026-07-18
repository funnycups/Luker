// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Pins the pre-refactor-safe replay filter used by studio.js's
// `buildTaskMessages`. Under the read-first refactor the iter-studio no
// longer emits a synthetic `AUTO CONTINUE\n...` user message between
// assistant tool-call rounds — the loop is program-driven by tool-call
// presence. But sessions persisted before the refactor still carry
// those `{role:'user', auto:true, content:'AUTO CONTINUE\n...'}` filler
// messages in settings, and replaying them would (a) mislead the LLM
// and (b) break the pure tool-call loop contract for anyone resuming a
// pre-refactor session.
//
// The filter (isReplayableIterationMessage) drops legacy fillers via
// the (auto === true && kind !== DRAIN_SUMMARY_KIND) check, while
// keeping the legitimate drain-outcomes summaries pushed by
// drainBusOutcomes (tagged `kind: 'drain_summary'`).
//
// Structural assertions only — never grep the AUTO CONTINUE prose (that
// would violate the no-prompt-body-regex constraint).
//
// The predicate lives in its own module (iter-message-filter.js) so it
// can be tested without dragging studio.js's DOM / ST-context import
// graph into jest.

import { describe, test, expect } from '@jest/globals';
import {
    isReplayableIterationMessage,
    DRAIN_SUMMARY_KIND,
} from '../../public/scripts/extensions/orchestrator/iter-studio/iter-message-filter.js';

describe('isReplayableIterationMessage — read-first replay filter', () => {
    test('regular user message → replay', () => {
        expect(isReplayableIterationMessage({ role: 'user', content: 'hello' })).toBe(true);
    });

    test('regular assistant message → replay', () => {
        expect(isReplayableIterationMessage({ role: 'assistant', content: 'hi' })).toBe(true);
    });

    test('legacy AUTO CONTINUE filler (auto:true, no kind) → DROP', () => {
        // Pre-refactor shape: no `kind` tag, `auto:true`, filler content.
        expect(isReplayableIterationMessage({
            role: 'user',
            auto: true,
            content: 'AUTO CONTINUE\n\nfiller body',
        })).toBe(false);
    });

    test('drain_summary user message (auto:true, kind:drain_summary) → replay', () => {
        // drainBusOutcomes tags its post-approval summary so it replays
        // even though it's `auto:true`.
        expect(isReplayableIterationMessage({
            role: 'user',
            auto: true,
            kind: DRAIN_SUMMARY_KIND,
            content: '[User reviewed 2 proposal(s): ...]',
        })).toBe(true);
    });

    test('legacy filler with a foreign kind tag → still DROP', () => {
        // Forward-compat: any auto:true user message that isn't
        // specifically drain_summary is dropped.
        expect(isReplayableIterationMessage({
            role: 'user',
            auto: true,
            kind: 'some_other_kind',
            content: 'filler',
        })).toBe(false);
    });

    test('system-role message → DROP (only user/assistant replay)', () => {
        expect(isReplayableIterationMessage({ role: 'system', content: 'you are …' })).toBe(false);
    });

    test('tool-role message → DROP', () => {
        expect(isReplayableIterationMessage({ role: 'tool', content: '{}' })).toBe(false);
    });

    test('assistant with auto:true → replay (auto only gates user role)', () => {
        // The filter only drops legacy AUTO CONTINUE on `role === 'user'`.
        // Assistant messages are never gated by `auto`.
        expect(isReplayableIterationMessage({ role: 'assistant', auto: true, content: 'x' })).toBe(true);
    });

    test('null / missing role → DROP (defensive)', () => {
        expect(isReplayableIterationMessage(null)).toBe(false);
        expect(isReplayableIterationMessage({})).toBe(false);
        expect(isReplayableIterationMessage({ content: 'x' })).toBe(false);
    });

    test('end-to-end shape: mixed history filters to correct set (count-based assertion, no prose grep)', () => {
        // Realistic pre-refactor session mix: 1 normal user, 1 assistant,
        // 1 legacy AUTO CONTINUE filler, 1 drain_summary. Expected
        // replay set: [normal-user, assistant, drain_summary] — 3 items.
        const persisted = [
            { role: 'user', content: 'iterate on my prompt' },
            { role: 'assistant', content: 'reading fields...' },
            { role: 'user', auto: true, content: 'AUTO CONTINUE\n\n<simulation_results>(none)</simulation_results>' },
            { role: 'user', auto: true, kind: DRAIN_SUMMARY_KIND, content: '[User reviewed 1 proposal(s): ...]' },
        ];
        const replayed = persisted.filter(isReplayableIterationMessage);
        expect(replayed).toHaveLength(3);
        // Structural identity: the AUTO CONTINUE entry (index 2) is gone,
        // the drain_summary entry (index 3) survives.
        expect(replayed[0]).toBe(persisted[0]);
        expect(replayed[1]).toBe(persisted[1]);
        expect(replayed[2]).toBe(persisted[3]);
        // Explicit: legacy filler NOT in output.
        expect(replayed.find((m) => m.auto === true && m.kind !== DRAIN_SUMMARY_KIND)).toBeUndefined();
    });

    test('DRAIN_SUMMARY_KIND constant stable identity (contract with drainBusOutcomes push site)', () => {
        // Guard: if this constant drifts, the drain-summary tag on the
        // studio.js push site (drainBusOutcomes) and this filter must
        // move together. String value is not part of the runtime API
        // (only ever compared internally), but keeping it stable makes
        // debugging via dumped settings.json easier.
        expect(DRAIN_SUMMARY_KIND).toBe('drain_summary');
    });
});
