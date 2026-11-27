// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Concurrency ceiling for foreground bulk resource reads (split settings/card
 * fields, named documents, world info batches). Keeps simultaneous fetch()
 * calls well below Chromium's per-origin in-flight resource queue ceiling
 * (`net::ERR_INSUFFICIENT_RESOURCES`) while preserving HTTP/2 multiplexing.
 */
export const BULK_RESOURCE_READ_CONCURRENCY = 64;

/**
 * Concurrency ceiling for low-priority background cache warm-up (such as
 * preloading non-selected presets after APP_READY). Stays strictly below the
 * 6-connection-per-origin HTTP/1.1 browser limit so at least 4 connections
 * remain free for foreground UI, chat, and generation requests.
 */
export const BACKGROUND_PRELOAD_CONCURRENCY = 2;

function createAbortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Map an array through an async task with a bounded worker pool, preserving
 * input order. When `abortOnError` is true (default), the first failure aborts
 * the internal AbortController so queued items never start and in-flight
 * siblings can cancel immediately.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number, signal: AbortSignal) => Promise<R>} mapper
 * @param {{ signal?: AbortSignal, abortOnError?: boolean }} [options]
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, concurrency, mapper, { signal, abortOnError = true } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
        if (signal?.aborted) {
            throw createAbortError();
        }
        return [];
    }

    if (signal?.aborted) {
        throw createAbortError();
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), items.length));
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;

    const runWorker = async () => {
        while (nextIndex < items.length) {
            if (abortOnError && firstError) {
                return;
            }
            if (controller.signal.aborted) {
                throw createAbortError();
            }
            const currentIndex = nextIndex++;
            try {
                results[currentIndex] = await mapper(items[currentIndex], currentIndex, controller.signal);
            } catch (error) {
                if (abortOnError) {
                    if (!firstError) {
                        firstError = error;
                        controller.abort();
                    }
                    throw firstError;
                }
                throw error;
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: workerCount }, runWorker));
        if (controller.signal.aborted) {
            throw createAbortError();
        }
        return results;
    } finally {
        signal?.removeEventListener('abort', onExternalAbort);
    }
}
