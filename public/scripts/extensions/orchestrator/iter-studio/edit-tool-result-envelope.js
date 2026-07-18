// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Canonical tool_result payload shapes for iter-studio EDIT tool_calls
 * that go through the ProposalBus (sandbox-diff → popup → user review).
 *
 * The orchestrator iter-studio persists a `pending` payload at edit-call
 * emission time so every tool_call has a matching role:'tool' message
 * in the LLM's protocol view. `drainBusOutcomes` updates the same
 * payload in place once the user acts on the proposal — committed /
 * rejected / conflict / rolled_back per the outcome.status.
 *
 * Pinned shapes (drift-tested in
 * tests/orch-iteration/task-messages-toolcall-roundtrip.test.js):
 *   pending      → {status:'proposal_pending', message:'…'}
 *   committed    → {status:'committed', message:'…'}
 *   rejected     → {status:'rejected', message:'…'}
 *   conflict     → {status:'conflict', reason, message, hint?}
 *   rolled_back  → {status:'rolled_back', message:'…'}
 *
 * The `conflict.reason` mirrors the STATE_ERROR_REASONS enum the bus
 * infers from the executor error (VALIDATION_ARGS / VALIDATION_TARGET
 * / VALIDATION_COMMIT / INSTANCE_DESTROYED / CONFLICT / HTTP_ERROR /
 * TRANSPORT_ERROR / LOG_WRITE_FAILED). The message text varies by
 * reason so the AI gets a stable, action-coded next-step guidance
 * without prose-grepping.
 *
 * No arbitrary size caps — the `hint` field is forwarded verbatim
 * from the bus outcome. See [[feedback_no_arbitrary_max_limits]].
 */

const CONFLICT_MESSAGE_BY_REASON = {
    VALIDATION_ARGS: 'Validation failed — args rejected by the tool contract. Do not retry with the same args.',
    VALIDATION_TARGET: 'Target not found (may have been renamed/deleted). Re-read the live state and adjust the target.',
    VALIDATION_COMMIT: 'Payload rejected by commit-time validation. Adjust the payload.',
    INSTANCE_DESTROYED: 'Target instance was destroyed. Cannot re-issue.',
    CONFLICT: 'Skipped — target was modified after this edit was captured. The write was NOT applied. Re-read the current state and re-issue if still needed.',
    HTTP_ERROR: 'Server/network error. Safe to retry the same edit.',
    TRANSPORT_ERROR: 'Server/network error. Safe to retry the same edit.',
    LOG_WRITE_FAILED: 'Persistence error. The edit may or may not have applied; re-read state to verify.',
};

const DEFAULT_CONFLICT_MESSAGE = CONFLICT_MESSAGE_BY_REASON.CONFLICT;

/**
 * Build the tool_result payload for an edit-tool call.
 *
 * @param {'pending'|'committed'|'rejected'|'conflict'|'rolled_back'} status
 * @param {{reason?: string, hint?: string}} [opts]
 * @returns {object} JSON-serializable payload for the tool_result content
 */
export function buildEditToolResultPayload(status, opts = {}) {
    if (status === 'pending' || status === 'proposal_pending') {
        return {
            status: 'proposal_pending',
            message: 'Edit proposed as a sandbox diff. Awaiting user review in the popup. The iter-studio pauses the auto-continue loop until the user approves, rejects, or conflicts. This result will update in place to the resolved status once the user acts.',
        };
    }
    if (status === 'committed') {
        return {
            status: 'committed',
            message: 'User approved this edit. The change has been applied to the live state.',
        };
    }
    if (status === 'rejected') {
        return {
            status: 'rejected',
            message: 'User rejected this edit. The live state is unchanged. Adjust your approach — propose a different edit or respond with plain text and no tool calls when finished.',
        };
    }
    if (status === 'conflict') {
        const reason = typeof opts.reason === 'string' && opts.reason
            ? opts.reason
            : 'CONFLICT';
        const message = CONFLICT_MESSAGE_BY_REASON[reason] || DEFAULT_CONFLICT_MESSAGE;
        const out = {
            status: 'conflict',
            reason,
            message,
        };
        if (typeof opts.hint === 'string' && opts.hint) {
            out.hint = opts.hint;
        }
        return out;
    }
    if (status === 'rolled_back' || status === 'rolledBack') {
        return {
            status: 'rolled_back',
            message: 'User rolled back this edit. The live state has been reverted to before this edit was applied.',
        };
    }
    // Defensive fallback — unknown status collapses to pending so the
    // protocol contract (every tool_call has a matching tool_result)
    // stays intact. Callers should not hit this path.
    return {
        status: 'proposal_pending',
        message: 'Edit proposal in an unknown state; awaiting user action.',
    };
}

/**
 * Map a ProposalBus outcome.status ('committed' | 'rejected' | 'conflict'
 * | 'rolledBack') to the canonical edit-tool tool_result payload.
 *
 * @param {{status: string, reason?: string, hint?: string}} outcome
 * @returns {object}
 */
export function buildPayloadForOutcome(outcome) {
    const status = String(outcome?.status || '');
    if (status === 'committed') return buildEditToolResultPayload('committed');
    if (status === 'rejected') return buildEditToolResultPayload('rejected');
    if (status === 'rolledBack' || status === 'rolled_back') {
        return buildEditToolResultPayload('rolled_back');
    }
    if (status === 'conflict') {
        return buildEditToolResultPayload('conflict', {
            reason: outcome?.reason,
            hint: outcome?.hint,
        });
    }
    // Unknown outcome status → keep as pending. Should not happen in
    // practice; the bus only enqueues the 4 statuses above.
    return buildEditToolResultPayload('pending');
}
