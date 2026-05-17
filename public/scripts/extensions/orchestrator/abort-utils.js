/**
 * Abort signal helpers for the orchestrator runtime.
 *
 * Pure utilities: no I/O, no module state, no `extension_settings`. The
 * orchestrator runs many concurrent tool-call attempts (one per node ×
 * retries), each of which needs to honor a caller-provided abort signal
 * and the global "stop" button. `linkAbortSignals` combines those triggers
 * into a single signal so each attempt aborts cleanly when any of them
 * fires.
 *
 * `isNoToolCallExtractionError` lives here because tool-call retry
 * logic uses the same error-shape inspection idiom as abort detection.
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

export function isNoToolCallExtractionError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) {
        return false;
    }
    return message.includes('did not return any tool call')
        || message.includes('none matched expected function names')
        || message.includes('returned empty text response')
        || message.includes('did not contain parseable function calls json');
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

