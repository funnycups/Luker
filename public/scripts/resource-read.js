/**
 * Browser-side transport for account-scoped, revalidated resource GETs.
 *
 * In-flight requests are shared by URL. Each caller still receives its own
 * result and can cancel without affecting other live callers. No response is
 * persisted here: the browser HTTP cache owns storage and revalidation.
 */

const inFlight = new Map();
const generations = new Map();
const FIELD_READ_CONCURRENCY = 64;
let bootstrapPromise = null;

function resourceError(code, resource, detail, extra = {}) {
    const error = new Error(detail || code);
    error.code = code;
    error.resource = resource;
    if (detail) {
        error.detail = detail;
    }
    Object.assign(error, extra);
    return error;
}

function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
}

function entryFor(url) {
    const existing = inFlight.get(url);
    if (existing && !existing.controller.signal.aborted) {
        return existing;
    }
    const controller = new AbortController();
    const entry = {
        controller,
        refs: 0,
        settled: false,
        promise: null,
    };
    entry.promise = fetchTextWithSignal(url, controller.signal)
        .finally(() => {
            entry.settled = true;
            if (inFlight.get(url) === entry) {
                inFlight.delete(url);
            }
        });
    entry.promise.catch(() => {});
    inFlight.set(url, entry);
    return entry;
}

async function fetchTextWithSignal(url, signal) {
    const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'default',
        headers: { Accept: 'application/json' },
        signal,
    });
    if (!response.ok) {
        throw resourceError('http_error', url, `Resource request failed with ${response.status} ${response.statusText}.`, {
            status: response.status,
        });
    }
    return {
        text: await response.text(),
        etag: response.headers.get('etag') || '',
        contentType: response.headers.get('content-type') || '',
    };
}

function subscribe(entry, signal) {
    entry.refs += 1;
    let released = false;
    const release = () => {
        if (released) {
            return;
        }
        released = true;
        entry.refs -= 1;
        if (entry.refs === 0 && !entry.settled) {
            entry.controller.abort();
        }
    };
    entry.promise.then(release, release);

    if (!signal) {
        return entry.promise;
    }
    if (signal.aborted) {
        release();
        return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            release();
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Reads the shared text representation. The returned object is fresh per call
 * and safe for the caller to keep.
 */
export async function readResourceText(url, { signal } = {}) {
    const key = String(url);
    const entry = entryFor(key);
    const generation = generations.get(key) || 0;
    const result = await subscribe(entry, signal);
    if ((generations.get(key) || 0) !== generation) {
        throw abortError();
    }
    return { ...result };
}

export async function readResourceJson(url, { signal } = {}) {
    const { text, etag, contentType } = await readResourceText(url, { signal });
    try {
        return { value: JSON.parse(text), etag, contentType };
    } catch {
        throw resourceError('invalid_resource', url, 'Resource body is not valid JSON.');
    }
}

/**
 * Fetches the field directory, then fields with bounded concurrency, verifying each
 * field's validator against the directory before returning any values.
 */
export async function assembleResourceFields({ directoryUrl, fieldUrl, signal }) {
    const directory = await readResourceJson(directoryUrl, { signal });
    const fields = Array.isArray(directory.value?.fields) ? directory.value.fields : null;
    if (!fields) {
        throw resourceError('invalid_resource', directoryUrl, 'Field directory has no fields array.');
    }

    const values = new Map();
    const readField = async (field) => {
        if (typeof field?.path !== 'string' || typeof field?.etag !== 'string') {
            throw resourceError('invalid_resource', directoryUrl, 'Field directory entry is invalid.');
        }
        const url = fieldUrl(field.path);
        let fieldResult;
        try {
            fieldResult = await readResourceText(url, { signal });
        } catch (error) {
            if (error?.status === 404) {
                throw resourceError('read_conflict', url, 'Field disappeared after the directory was read.', {
                    path: field.path,
                    expected: field.etag,
                    actual: null,
                });
            }
            throw error;
        }
        if (fieldResult.etag !== field.etag) {
            throw resourceError('read_conflict', url, 'Field validator does not match the directory.', {
                path: field.path,
                expected: field.etag,
                actual: fieldResult.etag,
            });
        }
        try {
            values.set(field.path, JSON.parse(fieldResult.text));
        } catch {
            throw resourceError('invalid_resource', url, 'Field body is not valid JSON.');
        }
    };

    let nextField = 0;
    let failed = false;
    const readNextFields = async () => {
        while (!failed && nextField < fields.length) {
            try {
                if (signal?.aborted) throw abortError();
                await readField(fields[nextField++]);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(FIELD_READ_CONCURRENCY, fields.length) }, readNextFields));

    return { directory: directory.value, values };
}

export async function loadResourceBootstrap({ signal, url = '/api/bootstrap/metadata' } = {}) {
    if (!bootstrapPromise) {
        bootstrapPromise = fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        }).then(async (response) => {
            if (!response.ok) {
                throw resourceError('http_error', url, `Bootstrap metadata failed with ${response.status}.`, {
                    status: response.status,
                });
            }
            const value = await response.json();
            if (!value || typeof value.account !== 'string' || !value.account) {
                throw resourceError('invalid_resource', url, 'Bootstrap metadata has no account.');
            }
            return value;
        }).catch((error) => {
            bootstrapPromise = null;
            throw error;
        });
    }
    if (!signal) {
        return bootstrapPromise;
    }
    if (signal.aborted) {
        throw abortError();
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        bootstrapPromise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

export async function resourceQuery(extra = {}) {
    const { account } = await loadResourceBootstrap();
    const params = new URLSearchParams({ account, ...extra });
    return params.toString();
}

export function invalidateResourceReads(urls = []) {
    for (const url of urls) {
        const key = String(url);
        generations.set(key, (generations.get(key) || 0) + 1);
        const entry = inFlight.get(key);
        if (entry) {
            entry.controller.abort();
            inFlight.delete(key);
        }
    }
}

export function invalidateResourceReadsByPrefix(prefix = '') {
    const keyPrefix = String(prefix);
    if (!keyPrefix) {
        return;
    }
    const urls = new Set([
        ...inFlight.keys(),
        ...generations.keys(),
    ]);
    for (const url of urls) {
        if (url.startsWith(keyPrefix)) {
            invalidateResourceReads([url]);
        }
    }
}

export function resetResourceReads() {
    for (const entry of inFlight.values()) {
        entry.controller.abort();
    }
    inFlight.clear();
    generations.clear();
    bootstrapPromise = null;
}
