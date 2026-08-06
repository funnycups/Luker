// public/scripts/request-retry.js

const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_SUFFIX_TEMPLATE = ' (after %d retries)';

/**
 * Whether an HTTP status code is retriable at the network layer.
 *
 * Default retriable set: `429 ∪ [500, 600)`.
 *
 * `blacklist` (per-profile "never retry these" override) subtracts from the
 * default set: any code in the blacklist is treated as non-retriable even if
 * it would otherwise be retried. Anything outside the default retriable set
 * is already non-retriable; blacklisting non-retriable codes is a no-op.
 *
 * @param {number} status
 * @param {number[]|null|undefined} [blacklist] status codes to never retry
 * @returns {boolean}
 */
function isRetriableStatus(status, blacklist) {
    if (Array.isArray(blacklist) && blacklist.length > 0 && blacklist.includes(status)) {
        return false;
    }
    return status === 429 || (status >= 500 && status < 600);
}

function computeBackoff(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(MAX_RETRY_AFTER_MS, Math.floor(seconds * 1000));
        }
        const dateMs = Date.parse(retryAfterHeader);
        if (Number.isFinite(dateMs)) {
            return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, dateMs - Date.now()));
        }
    }
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    const jitterMul = 1 + (Math.random() - 0.5) * 0.5; // ±25%
    return Math.max(0, Math.floor(base * jitterMul));
}

function makeAbortError() {
    if (typeof DOMException === 'function') {
        return new DOMException('Aborted', 'AbortError');
    }
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 20);
}

function sleepWithAbort(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(makeAbortError());
            return;
        }
        let onAbort = null;
        const timer = setTimeout(() => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        onAbort = () => {
            clearTimeout(timer);
            reject(makeAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function syntheticErrorFromResponse(response) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    err.retryAfter = response.headers.get('Retry-After');
    return err;
}

function safeCallOnAttempt(onAttempt, attempt, error, delay) {
    if (typeof onAttempt !== 'function') return;
    try {
        onAttempt(attempt, error, delay);
    } catch (cbErr) {
        console.warn('[request-retry] onAttempt callback threw:', cbErr);
    }
}

function appendRetrySuffix(err, retries) {
    if (!err || retries <= 0) return;
    const suffix = RETRY_SUFFIX_TEMPLATE.replace('%d', String(retries));
    if (typeof err.message === 'string') {
        err.message = err.message + suffix;
    }
}

/**
 * Wrap a fetcher with HTTP-layer retry logic.
 *
 * Retries on:
 *   - thrown errors with retriable status (429, 5xx) or no status (network)
 *   - returned Response objects with retriable status
 *
 * Short-circuits (no retry, rethrow / return as-is):
 *   - AbortError
 *   - thrown error with err.skipRetry === true
 *   - thrown error with non-retriable status (4xx other than 429)
 *   - returned Response with non-retriable status
 *   - status present in `retryBlacklist` (per-profile "never retry these" override)
 *   - maxRetries <= 0
 *
 * @template T
 * @param {() => Promise<T>} fetcher
 * @param {object} [options]
 * @param {number} [options.maxRetries=0] - 0 disables retry (callers clamp 0–5).
 * @param {number[]} [options.retryBlacklist] - Status codes to never retry (subtracts from the default 429 + 5xx set).
 * @param {AbortSignal} [options.signal]
 * @param {(attempt: number, error: Error, nextDelayMs: number) => void} [options.onAttempt]
 * @param {string} [options.label]
 * @returns {Promise<T>}
 */
export async function withRetry(fetcher, options = {}) {
    const { maxRetries: rawMax, retryBlacklist, signal, onAttempt /* , label */ } = options;
    const maxRetries = (Number.isFinite(rawMax) && rawMax >= 0) ? Math.floor(rawMax) : 0;
    const blacklist = Array.isArray(retryBlacklist) ? retryBlacklist : null;

    if (signal?.aborted) throw makeAbortError();

    let lastRetriableError = null;
    let lastRetriableResponse = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let result;
        let thrownError = null;
        try {
            result = await fetcher();
        } catch (err) {
            thrownError = err;
        }

        if (!thrownError) {
            if (result instanceof Response && !result.ok && isRetriableStatus(result.status, blacklist)) {
                if (signal?.aborted) throw makeAbortError();
                if (attempt >= maxRetries) {
                    return result;
                }
                lastRetriableResponse = result;
                const delay = computeBackoff(attempt, result.headers.get('Retry-After'));
                safeCallOnAttempt(onAttempt, attempt + 1, syntheticErrorFromResponse(result), delay);
                await sleepWithAbort(delay, signal);
                continue;
            }
            return result;
        }

        // Signal-first check: some provider generators catch the aborted fetch
        // and re-throw as a plain Error (e.g. `throw new Error(text)`), which
        // strips the AbortError name. Trust the signal over the error shape so
        // a user-triggered abort never leaks into the retry path.
        if (signal?.aborted) throw makeAbortError();
        if (isAbortError(thrownError)) throw thrownError;
        if (thrownError?.skipRetry) throw thrownError;

        const status = thrownError?.status;
        const retriable = (status === undefined) || isRetriableStatus(status, blacklist);
        if (!retriable) throw thrownError;
        if (attempt >= maxRetries) {
            if (attempt > 0) appendRetrySuffix(thrownError, attempt);
            throw thrownError;
        }

        lastRetriableError = thrownError;
        const delay = computeBackoff(attempt, thrownError?.retryAfter);
        safeCallOnAttempt(onAttempt, attempt + 1, thrownError, delay);
        await sleepWithAbort(delay, signal);
    }

    if (lastRetriableResponse) return lastRetriableResponse;
    if (lastRetriableError) throw lastRetriableError;
    throw new Error('withRetry: exhausted without outcome');
}
