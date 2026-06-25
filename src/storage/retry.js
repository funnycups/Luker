const TRANSIENT_CODES = new Set([
    // mysql2
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'PROTOCOL_CONNECTION_LOST',
    // node
    'ECONNRESET',
    // postgres SQLSTATE
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '08006', // connection_failure
    '57P03', // cannot_connect_now
]);

export function isTransientError(err) {
    if (!err || typeof err !== 'object') return false;
    return TRANSIENT_CODES.has(err.code);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` on transient errors with exponential backoff (baseMs * 2^attempt).
 *
 * Logging contract (deliberate Stage 0 choice):
 * - On eventual success, the intermediate transient errors are SWALLOWED:
 *   no log line is emitted for any of the failed-then-recovered attempts.
 *   Log noise from successful retries vastly outweighs the debugging value
 *   when the operation ultimately succeeded.
 * - Final-attempt failures still throw the original error unchanged; the
 *   caller's outer `catch` is the right place to log the final throw once
 *   (see mysql-engine.js / postgres-engine.js, which call `logEngineError`
 *   only at the outermost catch).
 * - Operators wanting to track retry pressure (capacity planning under
 *   contention) should add an `onRetry(err, attempt)` callback to this
 *   signature in a future change; the existing `isRetryable` slot is the
 *   precedent for that kind of extension point.
 */
export async function withRetry(fn, { retries = 3, baseMs = 50, isRetryable = isTransientError } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt === retries || !isRetryable(err)) throw err;
            await sleep(baseMs * 2 ** attempt);
        }
    }
    throw lastErr;
}
