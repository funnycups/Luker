// SPDX-License-Identifier: AGPL-3.0-or-later
// Chunked upload client for backup ZIP restore. The file is split into
// offset-keyed chunks (PUT application/octet-stream) so each request stays
// below reverse-proxy body limits, failed chunks retry with backoff, and a
// chunk is halved when a proxy answers 413.

export const RESTORE_UPLOAD_BASE_URL = '/api/users/restore-backup/uploads';
// 8 MiB stays below the body limits most reverse proxies are configured
// with; stricter setups are handled by the 413 halving below.
export const RESTORE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
// Halving floor: below this the per-request overhead dominates, and a proxy
// limit that small is a misconfiguration the operator must fix.
export const RESTORE_UPLOAD_MIN_CHUNK_SIZE = 256 * 1024;
export const RESTORE_UPLOAD_MAX_RETRIES = 3;
export const RESTORE_UPLOAD_RETRY_DELAYS_MS = [1000, 2000, 4000];

export class RestoreUploadError extends Error {
    /**
     * @param {string} message
     * @param {{uploadId?: string|null, uploadedBytes?: number, cause?: unknown}} [options]
     */
    constructor(message, { uploadId = null, uploadedBytes = 0, cause = null } = {}) {
        super(message);
        this.name = 'RestoreUploadError';
        this.uploadId = uploadId;
        this.uploadedBytes = uploadedBytes;
        this.cause = cause;
    }
}

function sleep(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

/**
 * Production transport: one XHR per chunk so upload progress is observable.
 * Resolves with `{ ok, status }` for any HTTP status; rejects on network errors.
 */
export function defaultSendChunk({ url, offset, blob, headers, signal, onProgress }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${url}/${offset}`);
        for (const [name, value] of Object.entries(headers || {})) {
            // The chunk body must be sent as application/octet-stream; a
            // caller-provided JSON content type would otherwise be combined
            // by XHR into "application/json, application/octet-stream".
            if (name.toLowerCase() === 'content-type') continue;
            if (value !== undefined && value !== null) {
                xhr.setRequestHeader(name, String(value));
            }
        }
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (typeof onProgress === 'function' && xhr.upload) {
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    onProgress({ loaded: event.loaded, total: event.total });
                }
            });
        }
        const onAbort = () => { try { xhr.abort(); } catch { /* already done */ } };
        signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        xhr.addEventListener('load', () => {
            cleanup();
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
        });
        xhr.addEventListener('error', () => { cleanup(); reject(new Error('Network error during chunk upload')); });
        xhr.addEventListener('abort', () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); });
        xhr.send(blob);
    });
}

async function defaultCreateSession({ file, handle, headers, signal }) {
    const response = await fetch(RESTORE_UPLOAD_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ handle, fileName: file.name, size: file.size }),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new RestoreUploadError(`Failed to start upload (${response.status}): ${text}`);
    }
    const data = await response.json();
    if (!data?.uploadId) {
        throw new RestoreUploadError('Upload init returned no id');
    }
    return data.uploadId;
}

/**
 * Upload `file` chunk by chunk. Retries each chunk up to `maxRetries` with
 * backoff; a 413 halves the chunk (down to `minChunkSize`) and resets the
 * retry budget for the new size. A 404 means the server lost the session
 * (restart wipes _uploads) and triggers one automatic restart from byte 0.
 *
 * @returns {Promise<{uploadId: string, uploadedBytes: number}>}
 */
export async function uploadFileInChunks(file, {
    handle,
    headers = {},
    onProgress = null,
    onRetry = null,
    resume = null,
    sendChunk = defaultSendChunk,
    createSession = defaultCreateSession,
    signal = null,
    chunkSize = RESTORE_UPLOAD_CHUNK_SIZE,
    minChunkSize = RESTORE_UPLOAD_MIN_CHUNK_SIZE,
    maxRetries = RESTORE_UPLOAD_MAX_RETRIES,
    retryDelaysMs = RESTORE_UPLOAD_RETRY_DELAYS_MS,
} = {}) {
    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    let uploadId = resume?.uploadId || null;
    let cursor = resume?.uploadedBytes || 0;
    let sessionRestarts = 0;
    let currentChunkSize = chunkSize;

    if (!uploadId) {
        uploadId = await createSession({ file, handle, headers, signal });
    }

    const emitProgress = (chunkLoaded = 0) => {
        if (typeof onProgress !== 'function') return;
        onProgress({ loaded: Math.min(cursor + chunkLoaded, file.size), total: file.size });
    };
    emitProgress();

    while (cursor < file.size) {
        let length = Math.min(currentChunkSize, file.size - cursor);
        let attempt = 0;
        for (;;) {
            const blob = file.slice(cursor, cursor + length);
            try {
                const result = await sendChunk({
                    url: `${RESTORE_UPLOAD_BASE_URL}/${uploadId}/chunks`,
                    offset: cursor,
                    blob,
                    headers,
                    signal,
                    onProgress: ({ loaded }) => emitProgress(loaded),
                });
                if (result?.status === 413) {
                    if (length > minChunkSize) {
                        const halved = Math.max(minChunkSize, Math.floor(length / 2));
                        if (typeof onRetry === 'function') {
                            onRetry({ reason: 'payload_too_large', offset: cursor, previousLength: length, nextLength: halved });
                        }
                        length = halved;
                        currentChunkSize = halved;
                        attempt = 0;
                        continue;
                    }
                    throw new RestoreUploadError(
                        `Upload rejected: a chunk of ${length} bytes is too large for this server or proxy.`,
                        { uploadId, uploadedBytes: cursor },
                    );
                }
                if (result?.status === 404) {
                    sessionRestarts += 1;
                    if (sessionRestarts > 1) {
                        throw new RestoreUploadError('Upload session was lost repeatedly.', { uploadId, uploadedBytes: cursor });
                    }
                    uploadId = await createSession({ file, handle, headers, signal });
                    cursor = 0;
                    length = Math.min(currentChunkSize, file.size);
                    attempt = 0;
                    emitProgress();
                    break;
                }
                if (!result?.ok) {
                    throw new Error(`Chunk upload failed with status ${result?.status}`);
                }
                cursor += length;
                emitProgress();
                break;
            } catch (err) {
                if (err?.name === 'AbortError') {
                    throw err;
                }
                if (err instanceof RestoreUploadError) {
                    throw err;
                }
                attempt += 1;
                if (attempt > maxRetries) {
                    throw new RestoreUploadError(
                        `Failed to upload backup after ${maxRetries} retries: ${err?.message || err}`,
                        { uploadId, uploadedBytes: cursor, cause: err },
                    );
                }
                if (typeof onRetry === 'function') {
                    onRetry({ reason: 'error', offset: cursor, attempt, maxRetries, error: err });
                }
                const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
                await sleep(delay, signal);
            }
        }
    }

    return { uploadId, uploadedBytes: cursor };
}

/**
 * Ask the server to assemble the uploaded chunks. Consumes the NDJSON
 * progress stream ({type:'progress',phase:'assemble'}) when present. banned-words-allow
 */
export async function finalizeRestoreUpload(uploadId, { headers = {}, onProgress = null, signal = null } = {}) {
    const response = await fetch(`${RESTORE_UPLOAD_BASE_URL}/${uploadId}/finalize`, {
        method: 'POST',
        headers: { ...headers, 'Accept': 'application/x-ndjson' },
        body: '{}',
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new RestoreUploadError(`Failed to assemble upload (${response.status}): ${text}`, { uploadId });
    }
    const contentType = String(response.headers.get('content-type') || '');
    if (!contentType.includes('application/x-ndjson') || !response.body) {
        return await response.json();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let streamError = null;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let payload;
            try { payload = JSON.parse(line); } catch { continue; }
            if (payload.type === 'progress') {
                if (typeof onProgress === 'function') onProgress(payload);
            } else if (payload.type === 'result') {
                result = payload;
            } else if (payload.type === 'error') {
                streamError = String(payload.error || 'Upload assembly failed');
            }
        }
    }
    if (streamError) {
        throw new RestoreUploadError(streamError, { uploadId });
    }
    if (!result) {
        throw new RestoreUploadError('Upload assembly ended without a result', { uploadId });
    }
    return { size: result.size };
}

/** Best-effort cleanup for a cancelled upload; 404 (already gone) is fine. */
export function abortRestoreUpload(uploadId, { headers = {} } = {}) {
    if (!uploadId) return Promise.resolve();
    return fetch(`${RESTORE_UPLOAD_BASE_URL}/${uploadId}`, { method: 'DELETE', headers }).catch(() => {});
}
