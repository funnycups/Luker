// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure formatter for the synthetic user message that `drainBusOutcomes`
 * (in `studio.js`) injects into the iter-studio chat after a batch of
 * proposal-bus outcomes settles. Extracted from the closure-private
 * `drainBusOutcomes` so the agent-facing message shape can be unit
 * tested without standing up the full popup + bus + session machinery.
 *
 * Inputs
 * ------
 *   outcomes — the array returned by `bus.drainOutcomes()`. Each entry:
 *     { id, kind, status, target, error?, reason?, hint? }
 *     where `status` is one of: 'committed' | 'rejected' | 'conflict' |
 *     'rolledBack'. Conflict outcomes additionally carry a closed-enum
 *     `reason` (STATE_ERROR_REASONS) and a short `hint`; outcomes
 *     emitted before Task 4.3 reason tagging lack `reason` and fall back
 *     to the legacy 'CONFLICT' bucket via `o.reason || 'CONFLICT'`.
 *
 *   opts.tf — i18nFormat callback `(key, ...args) => string`. The
 *     helper falls back to a literal-key formatter when not provided so
 *     test harnesses don't need to wire ST's i18n module.
 *
 * Output
 * ------
 *   The joined message string ready to push as `auto: true` user
 *   message content, OR `null` when there are no outcomes worth
 *   surfacing (matches the early-return in the runtime).
 *
 * Message shape (drift-tested in
 * tests/orch-iteration/drain-outcomes-message.test.js):
 *   [User reviewed N proposal(s):
 *   Committed (n): ...
 *   Rejected (n): ...
 *   <one reason-grouped header per distinct conflict.reason>: ...
 *   Rolled back (n): ...
 *   Continue with the next step ...]
 */

function fmtLine(o) {
    // Prefer the new `hint` field (added in Task 4.3 alongside the
    // reason enum) so the agent sees the short, action-coded message;
    // fall back to the legacy `error` string for outcomes emitted
    // before reason tagging landed.
    const detail = o.hint || o.error;
    return `  - ${o.kind}${o.target ? ` (${o.target})` : ''}${detail ? ` — ${detail}` : ''}`;
}

function defaultTf(key, ...args) {
    return String(key ?? '').replace(/\$\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ''));
}

export function buildDrainOutcomesMessage(outcomes, opts = {}) {
    const tf = typeof opts.tf === 'function' ? opts.tf : defaultTf;
    const list = Array.isArray(outcomes) ? outcomes : [];
    const committed = list.filter((o) => o && o.status === 'committed');
    const rejected = list.filter((o) => o && o.status === 'rejected');
    const conflicts = list.filter((o) => o && o.status === 'conflict');
    const rolledBack = list.filter((o) => o && o.status === 'rolledBack');
    if (!committed.length && !rejected.length && !conflicts.length && !rolledBack.length) return null;

    const lines = [];
    const total = committed.length + rejected.length + conflicts.length + rolledBack.length;
    lines.push(`[User reviewed ${total} proposal(s):`);

    if (committed.length) {
        lines.push(`Committed (${committed.length}):`);
        for (const o of committed) lines.push(fmtLine(o));
    }
    if (rejected.length) {
        lines.push(`Rejected (${rejected.length}):`);
        for (const o of rejected) lines.push(fmtLine(o));
    }
    if (conflicts.length) {
        // Group conflicts by their state-error reason and emit a stable,
        // reason-specific header per group so the agent gets a
        // structured retry decision tree instead of a flat "skipped,
        // re-read state" list. The legacy `CONFLICT` header (and the
        // conflicts whose outcome predates reason tagging — those fall
        // back to CONFLICT via the inferReasonFromError default in
        // proposal-bus) keeps the original re-read instruction.
        const byReason = new Map();
        for (const o of conflicts) {
            const reason = o.reason || 'CONFLICT';
            if (!byReason.has(reason)) byReason.set(reason, []);
            byReason.get(reason).push(o);
        }
        const reasonHeaders = {
            VALIDATION_ARGS: (n) => tf('Validation errors (${0}):', n),
            VALIDATION_TARGET: (n) => tf('Targets missing (${0}):', n),
            VALIDATION_COMMIT: (n) => tf('Payload rejected (${0}):', n),
            INSTANCE_DESTROYED: (n) => tf('State destroyed (${0}):', n),
            CONFLICT: (n) => `Skipped — target had been changed since you captured the diff, so the write was NOT applied (${n}). If still needed, re-read the current state and re-issue:`,
            HTTP_ERROR: (n) => tf('Server errors (${0}):', n),
            TRANSPORT_ERROR: (n) => tf('Network errors (${0}):', n),
            LOG_WRITE_FAILED: (n) => tf('Persistence errors (${0}):', n),
        };
        for (const [reason, group] of byReason) {
            const header = reasonHeaders[reason] || ((n) => tf('Other errors (${0}):', n));
            lines.push(header(group.length));
            for (const o of group) lines.push(fmtLine(o));
        }
    }
    if (rolledBack.length) {
        lines.push(`Rolled back (${rolledBack.length}):`);
        for (const o of rolledBack) lines.push(fmtLine(o));
    }
    lines.push('Continue with the next step if more changes are needed; respond with plain text and no tool calls when done.]');

    return lines.join('\n');
}
