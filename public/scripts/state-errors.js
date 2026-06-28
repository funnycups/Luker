/**
 * Closed enum of state-API failure reasons.
 *
 * Each value pairs a failure origin (where it fires) with a consumer
 * recovery action (what the caller should do). Consumers switch on this
 * enum, so a new value silently added would mask a new failure mode —
 * extend deliberately and update every downstream switch when you do.
 */

export const STATE_ERROR_REASONS = Object.freeze({
    VALIDATION_ARGS: 'VALIDATION_ARGS',
    VALIDATION_TARGET: 'VALIDATION_TARGET',
    VALIDATION_COMMIT: 'VALIDATION_COMMIT',
    INSTANCE_DESTROYED: 'INSTANCE_DESTROYED',
    CONFLICT: 'CONFLICT',
    HTTP_ERROR: 'HTTP_ERROR',
    TRANSPORT_ERROR: 'TRANSPORT_ERROR',
    REPLAY_BROKEN: 'REPLAY_BROKEN',
    LOG_WRITE_FAILED: 'LOG_WRITE_FAILED',
});

export const STATE_HINT_MAX_LENGTH = 120;

export function isValidReason(reason) {
    return typeof reason === 'string'
        && Object.prototype.hasOwnProperty.call(STATE_ERROR_REASONS, reason);
}

export function makeStateError(reason, hint) {
    if (!isValidReason(reason)) {
        throw new Error(`makeStateError: unknown reason "${reason}"`);
    }
    const safeHint = String(hint == null ? '' : hint).slice(0, STATE_HINT_MAX_LENGTH);
    return { ok: false, reason, hint: safeHint };
}

export function makeStateOk(extras = {}) {
    return { ok: true, ...extras };
}
