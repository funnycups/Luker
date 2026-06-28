// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Regression: pin the agent-facing wording of `buildDrainOutcomesMessage`,
// the pure formatter extracted from the closure-private `drainBusOutcomes`
// in `public/scripts/extensions/orchestrator/iter-studio/studio.js`.
//
// The synthetic user message it produces is the SOLE channel the iter-studio
// uses to tell the LLM what happened to each proposal it tried to commit.
// Task 8.3 (`18bad499b`) replaced the flat "Skipped — target had been
// changed..." conflict section with a reason-grouped layout (one header per
// distinct `conflict.reason`), so the agent can branch its retry policy on
// the closed-enum reason instead of regex-sniffing English prose. The
// concerns section of the 8.3 report flagged "no unit test pins the new
// format" — this file is that safety net.
//
// What we lock down (per task brief):
//   1. ≥ 3 distinct conflict reasons each get their own section header.
//   2. The count rendered in the header matches the group size
//      (Skipped/Server/Targets headers all carry `(N)`).
//   3. Per-line entries prefer `o.hint` over the legacy `o.error`.
//   4. Outcomes that predate Task 4.3 (only `error`, no `reason`) fall
//      back into the legacy CONFLICT bucket via `o.reason || 'CONFLICT'`.
//
// The runtime `drainBusOutcomes` (studio.js) calls this helper directly, so
// pinning the helper's output IS pinning what the agent sees.

import { describe, test, expect } from '@jest/globals';
import { buildDrainOutcomesMessage } from '../../public/scripts/extensions/orchestrator/iter-studio/drain-outcomes-message.js';

// Pass-through tf: substitutes ${0}, ${1}, ... so we can assert the
// post-substitution wording without depending on ST's i18n module being
// loaded under jest. studio.js's `tf` falls back to the same shape when
// no locale catalog is loaded, so this matches the production "English
// source-of-truth" path.
function passthroughTf(key, ...args) {
    return String(key ?? '').replace(/\$\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ''));
}

function build(outcomes) {
    return buildDrainOutcomesMessage(outcomes, { tf: passthroughTf });
}

describe('buildDrainOutcomesMessage — reason-grouped conflict sections', () => {
    test('returns null when no outcomes carry a known status (early-return parity)', () => {
        expect(buildDrainOutcomesMessage([], { tf: passthroughTf })).toBeNull();
        // Outcomes with statuses outside the 4 known buckets are ignored,
        // matching the runtime's filter pipeline.
        expect(buildDrainOutcomesMessage(
            [{ id: 'x', kind: 'k', status: 'unknown', target: 't' }],
            { tf: passthroughTf },
        )).toBeNull();
    });

    test('mixed-reason batch (CONFLICT + HTTP_ERROR + VALIDATION_TARGET) emits one header per distinct reason', () => {
        const outcomes = [
            // Two CONFLICT entries — should land under the legacy
            // long-form "Skipped — target had been changed..." header.
            {
                id: 'p1', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
                reason: 'CONFLICT', hint: 'external modification on /system_prompt',
                error: 'external modification on /system_prompt',
            },
            {
                id: 'p2', kind: 'profile-edit', status: 'conflict', target: 'spec-profile',
                reason: 'CONFLICT', hint: 'external modification on /tools/finalize',
                error: 'external modification on /tools/finalize',
            },
            // One HTTP_ERROR — should land under "Server errors (1):".
            {
                id: 'p3', kind: 'lorebook-write', status: 'conflict', target: 'world: nation',
                reason: 'HTTP_ERROR', hint: 'HTTP 500: Internal Server Error',
                error: 'HTTP 500: Internal Server Error',
            },
            // One VALIDATION_TARGET — should land under "Targets missing (1):".
            {
                id: 'p4', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
                reason: 'VALIDATION_TARGET', hint: 'target preset "ghost" not found',
                error: 'target preset "ghost" not found',
            },
        ];
        const msg = build(outcomes);
        expect(msg).not.toBeNull();

        // Opener carries the total count across all 4 outcomes.
        expect(msg).toMatch(/^\[User reviewed 4 proposal\(s\):/);

        // Each distinct reason gets its OWN section header. The
        // CONFLICT bucket uses the long-form legacy wording (never
        // routed through tf — pinned verbatim in the helper) with the
        // group size `(2)`.
        expect(msg).toMatch(/Skipped — target had been changed since you captured the diff, so the write was NOT applied \(2\)\. If still needed, re-read the current state and re-issue:/);
        // HTTP_ERROR uses the tf-routed "Server errors (N):" header.
        expect(msg).toMatch(/^Server errors \(1\):$/m);
        // VALIDATION_TARGET uses the tf-routed "Targets missing (N):" header.
        expect(msg).toMatch(/^Targets missing \(1\):$/m);

        // Closing line carries the agent-facing continue/stop contract.
        expect(msg).toMatch(/Continue with the next step if more changes are needed; respond with plain text and no tool calls when done\.\]$/);
    });

    test('per-conflict line prefers `hint` over the legacy `error` field', () => {
        const msg = build([{
            id: 'p1', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
            reason: 'HTTP_ERROR',
            hint: 'short action-coded hint',
            error: 'verbose stack-trace style error that the agent does not need',
        }]);
        // The per-line entry must carry the hint and NOT the legacy
        // error message. This is the whole point of Task 4.3's hint
        // field — the agent gets the short, action-coded version.
        expect(msg).toContain('short action-coded hint');
        expect(msg).not.toContain('verbose stack-trace style error');
        // Per-line shape: two-space indent + dash + kind + (target) + em-dash + detail.
        expect(msg).toMatch(/^ {2}- profile-edit \(loop-profile\) — short action-coded hint$/m);
    });

    test('falls back to `error` when `hint` is missing (pre-Task 4.3 legacy outcome shape)', () => {
        // Outcomes emitted before the reason+hint fields existed only had
        // `.error`. The helper must still surface the message via the
        // legacy field so historical replays don't lose information.
        const msg = build([{
            id: 'p_legacy', kind: 'lorebook-write', status: 'conflict', target: 'world: nation',
            // No `reason` → falls into CONFLICT bucket (covered in
            // the next test). No `hint` → fmt() falls through to error.
            error: 'legacy error string',
        }]);
        expect(msg).toContain('legacy error string');
        expect(msg).toMatch(/^ {2}- lorebook-write \(world: nation\) — legacy error string$/m);
    });

    test('outcomes with only `.error` (no `.reason`) fall into the legacy CONFLICT bucket via `o.reason || \'CONFLICT\'`', () => {
        // Mix: one untagged legacy outcome + one HTTP_ERROR. Must produce
        // TWO conflict headers — the legacy long-form CONFLICT header
        // (count 1) AND the "Server errors (1):" header.
        const outcomes = [
            {
                id: 'p_legacy', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
                error: 'untagged legacy failure',
                // intentionally no `reason`, no `hint`
            },
            {
                id: 'p_http', kind: 'profile-edit', status: 'conflict', target: 'spec-profile',
                reason: 'HTTP_ERROR',
                hint: 'HTTP 503: bad gateway',
            },
        ];
        const msg = build(outcomes);
        // Legacy CONFLICT header — count is 1 because only the untagged
        // outcome landed in the bucket; HTTP_ERROR did NOT bleed in.
        expect(msg).toMatch(/Skipped — target had been changed since you captured the diff, so the write was NOT applied \(1\)/);
        // Server errors header — count is 1, the HTTP_ERROR outcome.
        expect(msg).toMatch(/^Server errors \(1\):$/m);
        // The legacy outcome's error string is rendered as its per-line
        // entry (proves the bucketing actually happened, not just the
        // header).
        expect(msg).toContain('untagged legacy failure');
        // Total in the opener reflects both outcomes.
        expect(msg).toMatch(/^\[User reviewed 2 proposal\(s\):/);
    });

    test('committed / rejected / rolledBack sections render alongside conflict groups with their own counts', () => {
        // Drift coverage: the conflict-grouping refactor must not have
        // disturbed the success-side sections. They keep their flat
        // "Committed (N):" / "Rejected (N):" / "Rolled back (N):"
        // shape (no reason grouping — none of those statuses carry a
        // state-error reason).
        const outcomes = [
            { id: 'c1', kind: 'profile-edit', status: 'committed', target: 'loop-profile' },
            { id: 'c2', kind: 'profile-edit', status: 'committed', target: 'spec-profile' },
            { id: 'r1', kind: 'lorebook-write', status: 'rejected', target: 'world: nation' },
            { id: 'rb1', kind: 'profile-edit', status: 'rolledBack', target: 'agenda-profile' },
            {
                id: 'cf1', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
                reason: 'TRANSPORT_ERROR', hint: 'fetch aborted: timeout',
            },
        ];
        const msg = build(outcomes);
        expect(msg).toMatch(/^\[User reviewed 5 proposal\(s\):/);
        expect(msg).toMatch(/^Committed \(2\):$/m);
        expect(msg).toMatch(/^Rejected \(1\):$/m);
        expect(msg).toMatch(/^Network errors \(1\):$/m);
        expect(msg).toMatch(/^Rolled back \(1\):$/m);
    });

    test('unknown reasons (forward-compat) fall into the "Other errors (N):" tf-routed fallback', () => {
        // Defensive: a future STATE_ERROR_REASONS value that lands in
        // bus.js before the iter-studio header map catches up should
        // surface under a generic header rather than silently dropping.
        // bus.js's inferReasonFromError today maps unknowns to CONFLICT,
        // so the only way this fallback fires is via a brand-new reason
        // emitted by a forward version of the bus — pinning it here
        // documents the contract.
        const msg = build([{
            id: 'p_future', kind: 'profile-edit', status: 'conflict', target: 'loop-profile',
            reason: 'SOME_FUTURE_REASON', hint: 'forward-compat hint',
        }]);
        expect(msg).toMatch(/^Other errors \(1\):$/m);
        expect(msg).toContain('forward-compat hint');
    });
});
