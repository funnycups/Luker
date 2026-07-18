// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure predicate for iter-studio persisted-message replay. Shared across
 * iter-studios (orchestrator, memory-graph schema, CEA, CPA) so their
 * `buildTaskMessages` implementations apply the same rebuild-time filter
 * without importing each other.
 *
 * `buildTaskMessages` filters `state.session.messages` through
 * `isReplayableIterationMessage` before rebuilding the conversation sent
 * to the runner.
 *
 * Contract:
 *   - `role === 'user'` or `role === 'assistant'`  → replay-candidate
 *   - `role === 'user'` && `auto === true`         → DROP (legacy AUTO
 *       CONTINUE fillers and legacy `[User reviewed …]` drain summaries)
 *   - anything else (system / tool / null / …)     → DROP
 *
 * After the 2026-07-18 edit-tool round-trip refactor, edit outcomes flow
 * through in-place `role:'tool'` result updates keyed by tool_call_id
 * rather than a synthetic user-role summary. No auto:true user message
 * is ever emitted by iter-studio in new sessions; the drop rule remains
 * to keep legacy sessions (with pre-refactor AUTO CONTINUE fillers or
 * drain-summary tags) clean when they resume.
 */

export function isReplayableIterationMessage(m) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') return false;
    if (role === 'user' && m?.auto === true) return false;
    return true;
}
