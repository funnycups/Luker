/**
 * Abort signal helpers — shared infrastructure for any module that needs to
 * compose abort signals or recognize abort errors.
 *
 * Pure utilities: no I/O, no module state, no `extension_settings` reads.
 *
 * Originally extracted from the orchestrator runtime, where many concurrent
 * tool-call attempts (one per node × retries) each need to honor a caller-
 * provided abort signal and the global "stop" button. `linkAbortSignals`
 * combines those triggers into a single signal so each attempt aborts
 * cleanly when any of them fires.
 */

export function isAbortSignalLike(value) {
    return Boolean(value && typeof value === 'object' && 'aborted' in value);
}

export function isAbortError(error, abortSignal = null) {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        return true;
    }
    const name = String(error?.name || '').toLowerCase();
    if (name === 'aborterror') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('aborted') || message.includes('abort');
}

/**
 * Strict abort predicate: an error named `AbortError`, or an aborted
 * signal. Use where an error whose message merely contains "abort" must
 * still count as a failure (search-tools agent loop, MG RAG recall).
 */
export function isStrictAbortError(error, signal = null) {
    if (error?.name === 'AbortError') {
        return true;
    }
    return Boolean(signal?.aborted);
}

export function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

export function throwIfAborted(abortSignal, message = 'Operation aborted.') {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw createAbortError(message);
    }
}

export function linkAbortSignals(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    if (validSignals.length === 0) {
        return { signal: null, cleanup: () => {} };
    }
    if (validSignals.length === 1) {
        return { signal: validSignals[0], cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

/**
 * Race a promise against an abort signal: settle with the promise's
 * outcome if it finishes first, OR reject with an AbortError the moment
 * the signal aborts (whichever happens first).
 *
 * Use when a long-running `await` would otherwise hold a loop hostage
 * past the point where the user-side stop signal has fired — typically
 * for sub-agent waits, remote tool calls, or any transport that may
 * not internally honour the signal. The wrapped promise is NOT
 * cancelled; it keeps running in the background and its eventual
 * settle is ignored. The caller's only concern is unblocking.
 *
 * Falsy / non-signal input → returns the original promise unchanged
 * so callers can `await raceAbortSignal(p, maybeSignal)` without
 * pre-checking.
 */
export function raceAbortSignal(promise, signal) {
    if (!isAbortSignalLike(signal)) return promise;
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
    });
}

