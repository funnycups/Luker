// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Pins the read-first replay filter used by studio.js's
// `buildTaskMessages`. After the 2026-07-18 edit tool_call/tool_result
// round-trip refactor, iter-studio never emits `auto:true` user
// messages — edit outcomes flow through in-place `role:'tool'` result
// envelopes keyed by tool_call_id. But sessions persisted before that
// refactor still carry two flavours of legacy auto:true user filler:
// (a) `AUTO CONTINUE\n...` filler between assistant tool-call rounds,
// (b) `[User reviewed N proposal(s): ...]` drain summaries tagged
// `kind:'drain_summary'`. Both must be dropped on rebuild so a resumed
// pre-refactor session doesn't replay dead filler to the LLM.
//
// Structural assertions only — never grep the AUTO CONTINUE prose (that
// would violate the no-prompt-body-regex constraint).
//
// The predicate lives in its own module (iteration-library/iter-message-filter.js)
// so it can be tested without dragging studio.js's DOM / ST-context import
// graph into jest, and so all four iter-studios can share it without
// creating plugin-to-plugin imports.

import { describe, test, expect } from '@jest/globals';
import { isReplayableIterationMessage } from '../../public/scripts/iteration-library/iter-message-filter.js';

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

    test('legacy drain-summary user message (auto:true, kind:drain_summary) → DROP', () => {
        // Pre-tool-call-round-trip-refactor drain summaries used to be
        // pushed by drainBusOutcomes. Now iter-studio uses in-place
        // role:'tool' result updates instead; the summary channel is
        // retired. Legacy sessions may still carry these on disk; they
        // are dropped so the LLM only sees the resolved tool_result
        // envelopes going forward.
        expect(isReplayableIterationMessage({
            role: 'user',
            auto: true,
            kind: 'drain_summary',
            content: '[User reviewed 2 proposal(s): ...]',
        })).toBe(false);
    });

    test('any auto:true user message regardless of kind → DROP', () => {
        // Post-refactor: no legit auto:true user messages exist. Any
        // tag (drain_summary / arbitrary future kinds / no kind at all)
        // is treated identically and dropped.
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
        // The filter only drops legacy fillers on `role === 'user'`.
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
        // 1 legacy AUTO CONTINUE filler, 1 legacy drain_summary. Expected
        // replay set: [normal-user, assistant] — 2 items.
        const persisted = [
            { role: 'user', content: 'iterate on my prompt' },
            { role: 'assistant', content: 'reading fields...' },
            { role: 'user', auto: true, content: 'AUTO CONTINUE\n\n<simulation_results>(none)</simulation_results>' },
            { role: 'user', auto: true, kind: 'drain_summary', content: '[User reviewed 1 proposal(s): ...]' },
        ];
        const replayed = persisted.filter(isReplayableIterationMessage);
        expect(replayed).toHaveLength(2);
        // Structural identity: both auto:true entries are gone.
        expect(replayed[0]).toBe(persisted[0]);
        expect(replayed[1]).toBe(persisted[1]);
        // Explicit: no auto:true user message survives.
        expect(replayed.find((m) => m.role === 'user' && m.auto === true)).toBeUndefined();
    });
});
