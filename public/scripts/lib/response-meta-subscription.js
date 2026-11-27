// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure coordinators for Luker response-metadata subscriptions across streaming
 * backends (`kai-settings`, `nai-settings`, `textgen-settings`) and epoch- /
 * token-guarded generation trackers (`openai.js`, `script.js`).
 */

/**
 * Subscribe to Luker response metadata for a streaming request and emit header
 * metadata when the response generation id matches the expected job id.
 *
 * Call `armAbortCleanup()` once the response is confirmed OK so `!response.ok`
 * errors and synchronous `onLukerMetaDisposer` disposal never attach an
 * unnecessary abort listener.
 *
 * @param {object} params
 * @param {Response} params.response
 * @param {string} [params.expectedGenerationId='']
 * @param {AbortSignal | null} [params.signal=null]
 * @param {(response: Response, listener: (meta: any) => void) => () => void} params.onLukerResponseMeta
 * @param {(update: { generationId?: string, persisted?: boolean }) => void} [params.onLukerMeta]
 * @param {(dispose: () => void) => void} [params.onLukerMetaDisposer]
 * @returns {{ cleanup: () => void, armAbortCleanup: () => void, hasSubscription: () => boolean }}
 */
export function attachStreamingResponseMeta({
    response,
    expectedGenerationId = '',
    signal = null,
    onLukerResponseMeta,
    onLukerMeta = null,
    onLukerMetaDisposer = null,
}) {
    const expectedId = typeof expectedGenerationId === 'string' ? expectedGenerationId : '';
    const generationId = response.headers.get('x-luker-generation-id') || '';
    const hasMismatchedGenerationIdHeader = Boolean(
        expectedId && generationId && generationId !== expectedId,
    );
    let trackedGenerationId = expectedId || generationId;

    if (!hasMismatchedGenerationIdHeader && generationId && typeof onLukerMeta === 'function') {
        onLukerMeta({ generationId });
    }
    const persistedHeader = response.headers.get('x-luker-server-persisted');
    if (!hasMismatchedGenerationIdHeader && (persistedHeader === '0' || persistedHeader === '1') && typeof onLukerMeta === 'function') {
        onLukerMeta({ persisted: persistedHeader === '1' });
    }

    let disposeLukerMeta = null;
    const cleanup = () => {
        signal?.removeEventListener?.('abort', cleanup);
        if (!disposeLukerMeta) return;
        const dispose = disposeLukerMeta;
        disposeLukerMeta = null;
        dispose();
    };

    if (!hasMismatchedGenerationIdHeader && typeof onLukerMeta === 'function') {
        disposeLukerMeta = onLukerResponseMeta(response, (meta) => {
            const metaGenerationId = typeof meta?.generation_id === 'string' ? meta.generation_id : '';
            if (metaGenerationId && trackedGenerationId && metaGenerationId !== trackedGenerationId) {
                return;
            }
            if (metaGenerationId && !trackedGenerationId) {
                trackedGenerationId = metaGenerationId;
            }
            if (metaGenerationId) {
                onLukerMeta({ generationId: metaGenerationId });
            }
            if (typeof meta?.persisted === 'boolean') {
                onLukerMeta({ persisted: meta.persisted });
            }
        });
        if (typeof onLukerMetaDisposer === 'function') {
            onLukerMetaDisposer(cleanup);
        }
    }

    const armAbortCleanup = () => {
        if (!signal || !disposeLukerMeta) return;
        if (signal.aborted) {
            cleanup();
        } else {
            signal.addEventListener('abort', cleanup, { once: true });
        }
    };

    return {
        cleanup,
        armAbortCleanup,
        hasSubscription: () => Boolean(disposeLukerMeta),
    };
}

/**
 * Create an epoch-guarded response-metadata tracker that tracks the latest
 * generation id and server-persistence flag for a single API family while
 * guaranteeing prior listeners and abort handlers are disposed when a newer
 * generation starts or the active API changes.
 *
 * @param {object} deps
 * @param {(response: Response, listener: (meta: any) => void) => () => void} deps.onLukerResponseMeta
 * @param {(eventName: string, payload: Record<string, any>) => void} [deps.onLog]
 */
export function createGenerationMetaTracker({ onLukerResponseMeta, onLog = null }) {
    let epoch = 0;
    let lastGenerationId = '';
    let lastReplyPersistedByServer = false;
    let activeDisposer = null;

    function setActiveDisposer(dispose) {
        const previous = activeDisposer;
        activeDisposer = typeof dispose === 'function' ? dispose : null;
        if (previous && previous !== dispose) {
            previous();
        }
    }

    function disposeActive() {
        setActiveDisposer(null);
    }

    function beginGeneration({ generationId = '' } = {}) {
        epoch += 1;
        disposeActive();
        lastGenerationId = typeof generationId === 'string' ? generationId : '';
        lastReplyPersistedByServer = false;
        return epoch;
    }

    function setGenerationId(generationId) {
        if (typeof generationId === 'string' && generationId) {
            lastGenerationId = generationId;
        }
    }

    function applyMeta({ generationId = '', persisted = undefined } = {}) {
        if (typeof generationId === 'string' && generationId) {
            lastGenerationId = generationId;
        }
        if (typeof persisted === 'boolean') {
            lastReplyPersistedByServer = persisted;
        }
    }

    /**
     * Attach header + out-of-band response metadata tracking for a response.
     * Always returns an idempotent `cleanup` callback.
     */
    function attachResponse({
        response,
        expectedEpoch = epoch,
        expectedGenerationId = '',
        signal = null,
        shouldTrack = true,
        isApiActive = () => true,
        metaEventName = 'response_meta',
    }) {
        if (!response || !shouldTrack || !isApiActive() || expectedEpoch !== epoch) {
            return { cleanup: () => {}, attached: false };
        }

        const headerGenerationId = response.headers.get('x-luker-generation-id') || '';
        const persistedHeader = response.headers.get('x-luker-server-persisted');
        const hasMismatchedGenerationIdHeader = Boolean(
            headerGenerationId && expectedGenerationId && headerGenerationId !== expectedGenerationId,
        );
        if (hasMismatchedGenerationIdHeader) {
            return { cleanup: () => {}, attached: false };
        }

        let trackedGenerationId = expectedGenerationId || headerGenerationId;
        const persisted = persistedHeader === '1' ? true : persistedHeader === '0' ? false : undefined;
        if (headerGenerationId && (!trackedGenerationId || headerGenerationId === trackedGenerationId)) {
            trackedGenerationId = headerGenerationId;
            lastGenerationId = headerGenerationId;
        }
        if (typeof persisted === 'boolean') {
            lastReplyPersistedByServer = persisted;
        }
        if (onLog && (headerGenerationId || typeof persisted === 'boolean')) {
            onLog('response_header_meta', {
                ...(headerGenerationId ? { generation_id: headerGenerationId } : {}),
                ...(typeof persisted === 'boolean' ? { persisted } : {}),
            });
        }

        disposeActive();

        let disposed = false;
        let rawDispose = null;
        const cleanup = () => {
            if (disposed) return;
            disposed = true;
            signal?.removeEventListener?.('abort', cleanup);
            if (activeDisposer === cleanup) {
                activeDisposer = null;
            }
            const fn = rawDispose;
            rawDispose = null;
            fn?.();
        };

        rawDispose = onLukerResponseMeta(response, (meta) => {
            if (expectedEpoch !== epoch || !isApiActive()) {
                return;
            }
            const metaGenerationId = typeof meta?.generation_id === 'string' ? meta.generation_id : '';
            if (trackedGenerationId && lastGenerationId && lastGenerationId !== trackedGenerationId) {
                return;
            }
            if (metaGenerationId && trackedGenerationId && metaGenerationId !== trackedGenerationId) {
                return;
            }
            if (metaGenerationId && !trackedGenerationId) {
                trackedGenerationId = metaGenerationId;
            }
            const logPayload = {};
            if (metaGenerationId) {
                lastGenerationId = metaGenerationId;
                logPayload.generation_id = metaGenerationId;
            }
            if (typeof meta?.persisted === 'boolean') {
                lastReplyPersistedByServer = meta.persisted;
                logPayload.persisted = meta.persisted;
            }
            if (onLog && Object.keys(logPayload).length > 0) {
                onLog(metaEventName, logPayload);
            }
        });

        setActiveDisposer(cleanup);

        if (signal && !disposed) {
            if (signal.aborted) {
                cleanup();
            } else {
                signal.addEventListener('abort', cleanup, { once: true });
            }
        }

        return { cleanup, attached: true };
    }

    return {
        beginGeneration,
        setGenerationId,
        applyMeta,
        attachResponse,
        setActiveDisposer,
        disposeActive,
        getEpoch: () => epoch,
        getLastGenerationId: () => lastGenerationId,
        isLastReplyPersisted: () => lastReplyPersistedByServer,
    };
}
