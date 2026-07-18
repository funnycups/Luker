// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure predicate + drain-summary tag constant for the orchestrator
 * iter-studio's persisted message replay. Extracted from studio.js so
 * it can be unit-tested without dragging studio.js's DOM / ST-context
 * import graph into jest (studio.js reads `Luker.getContext()` at
 * module-load and its transitive deps hit `document.addEventListener`).
 *
 * `buildTaskMessages` (studio.js) filters `state.session.messages`
 * through `isReplayableIterationMessage` before rebuilding the
 * conversation sent to the runner. `drainBusOutcomes` (studio.js) tags
 * its post-approval outcomes summary with `kind: DRAIN_SUMMARY_KIND` so
 * the filter distinguishes it from the pre-refactor "AUTO CONTINUE\n..."
 * user-role filler that used to sit between assistant tool-call rounds
 * (also `auto:true`, but no `kind`).
 *
 * Contract:
 *   - `role === 'user'` or `role === 'assistant'`     → replay-candidate
 *   - `role === 'user'` && `auto === true` &&
 *     `kind !== DRAIN_SUMMARY_KIND`                   → DROP
 *   - anything else (system / tool / null / …)         → DROP
 *
 * The read-first loop is program-driven by tool-call presence (any tool
 * call → next round, none → stop), so no synthetic user message is
 * needed between rounds. Replaying a legacy AUTO CONTINUE filler would
 * (a) mislead the model with obsolete `<simulation_results>(none)`
 * scaffolding and (b) violate the pure tool-call loop contract.
 */

export const DRAIN_SUMMARY_KIND = 'drain_summary';

export function isReplayableIterationMessage(m) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') return false;
    if (role === 'user' && m?.auto === true && m?.kind !== DRAIN_SUMMARY_KIND) return false;
    return true;
}
