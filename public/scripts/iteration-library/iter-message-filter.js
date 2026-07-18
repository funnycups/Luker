// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure predicate + drain-summary tag constant for iter-studio
 * persisted-message replay. Shared across iter-studios (orchestrator,
 * memory-graph schema, …) so their `buildTaskMessages` implementations
 * apply the same rebuild-time filter without importing each other.
 *
 * `buildTaskMessages` filters `state.session.messages` through
 * `isReplayableIterationMessage` before rebuilding the conversation
 * sent to the runner. Post-approval drain summaries (pushed by each
 * studio's equivalent of orchestrator's `drainBusOutcomes`) tag their
 * message with `kind: DRAIN_SUMMARY_KIND` so the filter distinguishes
 * them from the pre-refactor "AUTO CONTINUE\n..." user-role filler
 * that used to sit between assistant tool-call rounds (also
 * `auto:true`, but no `kind`).
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
