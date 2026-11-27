// SPDX-License-Identifier: AGPL-3.0-or-later

import { BULK_RESOURCE_READ_CONCURRENCY, mapWithConcurrency } from '../util/concurrent-map.js';

/**
 * Pure persistence and cache-rollback coordinator for World Info books,
 * extracted from `public/scripts/world-info.js`.
 *
 * Manages:
 *   - Optimistic `worldInfoCache` writes with rollback baselines on failed save
 *   - Persisted-baseline `worldInfoSnapshotCache` isolation from unpersisted writes
 *   - Request deduplication and generation invalidation (`loadWorldInfoBatch`)
 *   - Serialized save chain + debounced save coalescing
 *   - Delete-epoch fencing so pre-delete in-flight or queued saves never
 *     re-seed snapshot caches or recreate deleted books
 */

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneAsJsonWire(value) {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function normalizeWorldInfoSaveOptions(options = null) {
    return {
        refreshEditor: options?.refreshEditor === true,
        onSaved: options?.onSaved,
    };
}

/**
 * @param {object} deps
 * @param {Map<string, object>} deps.worldInfoCache
 * @param {(name: string) => string} [deps.resolveWorldInfoName]
 * @param {() => Record<string, string>} deps.getRequestHeaders
 * @param {(previous: object, next: object, opts?: object) => Promise<Array>} deps.buildObjectPatchOperationsAsync
 * @param {(name: string) => Promise<object|null>} deps.readWorldInfoDocument
 * @param {(fn: Function, wait: number) => Function} deps.debounce
 * @param {(fn: Function) => void} deps.cancelDebounce
 * @param {number} deps.debounceTimeoutMs
 * @param {(name: string, payload: object) => Promise<void>} [deps.onWorldInfoUpdated]
 * @param {() => void} [deps.onInvalidateSearch]
 * @param {(name: string) => Promise<void>} [deps.onRefreshEditor]
 * @param {(name: string, error: Error) => void} [deps.onLoadError]
 */
export function createWorldInfoPersistenceCoordinator({
    worldInfoCache,
    resolveWorldInfoName = (name) => String(name || '').trim(),
    getRequestHeaders = () => ({ 'Content-Type': 'application/json' }),
    buildObjectPatchOperationsAsync = async () => [],
    readWorldInfoDocument = async () => null,
    debounce,
    cancelDebounce = () => {},
    debounceTimeoutMs = 10,
    onWorldInfoUpdated = async () => {},
    onInvalidateSearch = () => {},
    onRefreshEditor = async () => {},
    onLoadError = () => {},
}) {
    const worldInfoSnapshotCache = new Map();
    const worldInfoRequestCache = new Map();
    const worldInfoRequestGeneration = new Map();
    const pendingWorldInfoSaves = new Map();
    const worldInfoCacheWriteTokens = new Map();
    const worldInfoCacheRollbackBaselines = new Map();
    const worldInfoDeleteEpochs = new Map();
    let worldInfoSaveChain = Promise.resolve();

    function rememberWorldInfoSnapshot(name, data) {
        const key = String(name || '').trim();
        if (!key) {
            return;
        }
        if (!isPlainObject(data)) {
            worldInfoSnapshotCache.delete(key);
            return;
        }
        const snapshot = cloneAsJsonWire(data);
        if (isPlainObject(snapshot)) {
            worldInfoSnapshotCache.set(key, snapshot);
        } else {
            worldInfoSnapshotCache.delete(key);
        }
    }

    function getWorldInfoSnapshot(name) {
        const key = String(name || '').trim();
        if (!key) {
            return null;
        }
        const snapshot = worldInfoSnapshotCache.get(key);
        return isPlainObject(snapshot) ? cloneAsJsonWire(snapshot) : null;
    }

    function getWorldInfoRequestGeneration(name) {
        const key = String(name || '').trim();
        if (!key) {
            return 0;
        }
        return Math.max(0, Number(worldInfoRequestGeneration.get(key) || 0));
    }

    function invalidateWorldInfoRequestCache(names = []) {
        for (const rawName of Array.isArray(names) ? names : [names]) {
            const name = String(rawName || '').trim();
            if (!name) continue;
            worldInfoRequestGeneration.set(name, getWorldInfoRequestGeneration(name) + 1);
            worldInfoRequestCache.delete(name);
        }
    }

    function cacheWorldInfoData(name, data, { invalidateSearch = false } = {}) {
        const key = String(name || '').trim();
        if (!key) {
            return;
        }
        worldInfoCacheWriteTokens.set(key, {});
        worldInfoCacheRollbackBaselines.delete(key);
        worldInfoCache.set(key, data);
        rememberWorldInfoSnapshot(key, data);
        if (invalidateSearch) {
            onInvalidateSearch();
        }
    }

    function restoreWorldInfoCacheIfOwned(normalizedName, cacheWriteToken) {
        if (worldInfoCacheWriteTokens.get(normalizedName) !== cacheWriteToken) {
            return;
        }
        worldInfoCacheWriteTokens.delete(normalizedName);
        const baseline = worldInfoCacheRollbackBaselines.get(normalizedName);
        worldInfoCacheRollbackBaselines.delete(normalizedName);
        if (!baseline) {
            return;
        }
        if (baseline.hadCached) {
            worldInfoCache.set(normalizedName, baseline.previousCached);
        } else {
            worldInfoCache.delete(normalizedName);
        }
        if (baseline.hadSnapshot) {
            worldInfoSnapshotCache.set(normalizedName, baseline.previousSnapshot);
        } else {
            worldInfoSnapshotCache.delete(normalizedName);
        }
    }

    async function saveWorldInfoInternal(name, data, options = {}, cacheWriteToken = null) {
        const isDeletedSinceStart = () => Boolean(cacheWriteToken)
            && (worldInfoDeleteEpochs.get(name) || 0) !== cacheWriteToken.deleteEpoch;
        if (isDeletedSinceStart()) {
            return;
        }

        let saved = false;
        invalidateWorldInfoRequestCache([name]);
        const payload = cloneAsJsonWire(data);
        const previousSnapshot = getWorldInfoSnapshot(name);
        const canPatch = isPlainObject(previousSnapshot) && isPlainObject(payload);
        const normalizedOptions = normalizeWorldInfoSaveOptions(options);

        if (canPatch && !normalizedOptions.onSaved) {
            const operations = await buildObjectPatchOperationsAsync(previousSnapshot, payload, { maxOperations: 16000 });
            if (isDeletedSinceStart()) {
                return;
            }
            if (operations.length === 0) {
                saved = true;
            } else {
                const patchResult = await fetch('/api/worldinfo/patch', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name, operations }),
                });
                saved = patchResult.ok;
            }
        }

        if (isDeletedSinceStart()) {
            onInvalidateSearch();
            return;
        }

        if (!saved) {
            const fullSaveResult = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name, data: payload }),
            });
            if (!fullSaveResult.ok) {
                throw new Error(`Failed to save world info: ${fullSaveResult.status}`);
            }
            normalizedOptions.onSaved?.(fullSaveResult);
        }

        if (isDeletedSinceStart()) {
            onInvalidateSearch();
            return;
        }

        const isLatestOwner = !cacheWriteToken || worldInfoCacheWriteTokens.get(name) === cacheWriteToken;
        if (isLatestOwner) {
            cacheWorldInfoData(name, payload, { invalidateSearch: true });
        } else if (worldInfoCacheWriteTokens.has(name)) {
            rememberWorldInfoSnapshot(name, payload);
            if (worldInfoCacheRollbackBaselines.has(name)) {
                const persistedCopy = cloneAsJsonWire(payload);
                worldInfoCacheRollbackBaselines.set(name, {
                    hadCached: true,
                    previousCached: persistedCopy,
                    hadSnapshot: true,
                    previousSnapshot: cloneAsJsonWire(payload),
                });
            }
            onInvalidateSearch();
        } else {
            onInvalidateSearch();
        }
        await onWorldInfoUpdated(name, payload);

        if (normalizedOptions.refreshEditor) {
            await onRefreshEditor(name);
        }
    }

    const saveWorldDebounced = debounce(async () => {
        const names = [...pendingWorldInfoSaves.keys()];
        await Promise.allSettled(names.map(async (name) => {
            const entry = pendingWorldInfoSaves.get(name);
            if (!entry) {
                return;
            }
            pendingWorldInfoSaves.delete(name);
            try {
                await _save(name, entry.data, entry.options, entry.cacheWriteToken);
            } catch (error) {
                restoreWorldInfoCacheIfOwned(name, entry.cacheWriteToken);
                console.error(`[WI] Failed to save "${name}"`, error);
            }
        }));
    }, debounceTimeoutMs);

    async function _save(name, data, options = {}, cacheWriteToken = null) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) {
            return;
        }

        const normalizedOptions = normalizeWorldInfoSaveOptions(options);

        pendingWorldInfoSaves.delete(normalizedName);
        if (pendingWorldInfoSaves.size === 0) {
            cancelDebounce(saveWorldDebounced);
        }

        const run = () => saveWorldInfoInternal(normalizedName, data, normalizedOptions, cacheWriteToken);
        const result = worldInfoSaveChain.then(run);
        worldInfoSaveChain = result.catch(() => {});
        return result;
    }

    async function saveWorldInfo(name, data, immediately = false, options = {}) {
        if (!name || !data) {
            return;
        }

        const normalizedName = String(name).trim();
        if (!normalizedName) {
            return;
        }

        invalidateWorldInfoRequestCache([normalizedName]);

        if (!worldInfoCacheRollbackBaselines.has(normalizedName)) {
            const hadCached = worldInfoCache.has(normalizedName);
            const previousCached = hadCached ? worldInfoCache.get(normalizedName) : undefined;
            const hadSnapshot = worldInfoSnapshotCache.has(normalizedName);
            const previousSnapshot = hadSnapshot ? worldInfoSnapshotCache.get(normalizedName) : undefined;
            worldInfoCacheRollbackBaselines.set(normalizedName, {
                hadCached,
                previousCached,
                hadSnapshot,
                previousSnapshot,
            });
        }
        const cacheWriteToken = { deleteEpoch: worldInfoDeleteEpochs.get(normalizedName) || 0 };
        worldInfoCacheWriteTokens.set(normalizedName, cacheWriteToken);

        worldInfoCache.set(normalizedName, data);
        const normalizedOptions = normalizeWorldInfoSaveOptions(options);

        if (immediately) {
            try {
                return await _save(normalizedName, data, normalizedOptions, cacheWriteToken);
            } catch (error) {
                restoreWorldInfoCacheIfOwned(normalizedName, cacheWriteToken);
                throw error;
            }
        }

        pendingWorldInfoSaves.delete(normalizedName);
        pendingWorldInfoSaves.set(normalizedName, { data, options: normalizedOptions, cacheWriteToken });
        saveWorldDebounced();
    }

    async function loadWorldInfoBatch(names) {
        const uniqueNames = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean))];
        const results = new Map();
        const awaitedRequests = [];
        const pendingNames = [];

        for (const name of uniqueNames) {
            if (worldInfoCache.has(name)) {
                const cached = worldInfoCache.get(name);
                if (!worldInfoSnapshotCache.has(name) && !worldInfoCacheRollbackBaselines.has(name)) {
                    rememberWorldInfoSnapshot(name, cached);
                }
                results.set(name, cached);
                continue;
            }

            if (worldInfoRequestCache.has(name)) {
                awaitedRequests.push(worldInfoRequestCache.get(name).then((data) => {
                    results.set(name, data && isPlainObject(data) ? cloneAsJsonWire(data) : data);
                }));
                continue;
            }

            pendingNames.push(name);
        }

        if (pendingNames.length) {
            const requestGenerationByName = new Map(
                pendingNames.map((name) => [name, getWorldInfoRequestGeneration(name)]),
            );
            const deferredByName = new Map();
            for (const name of pendingNames) {
                let resolve;
                let reject;
                const promise = new Promise((res, rej) => {
                    resolve = res;
                    reject = rej;
                });
                promise.catch(() => {});
                deferredByName.set(name, { promise, resolve, reject, settled: false });
                worldInfoRequestCache.set(name, promise);
            }

            const batchResults = new Map();
            let batchError = null;
            try {
                await mapWithConcurrency(pendingNames, BULK_RESOURCE_READ_CONCURRENCY, async (name) => {
                    const deferred = deferredByName.get(name);
                    let data = null;
                    try {
                        try {
                            data = await readWorldInfoDocument(name);
                        } catch (error) {
                            if (error?.code === 'http_error' && error.status === 404) {
                                data = { entries: {} };
                            } else {
                                console.warn(`Failed to load World Info ${name}`, error);
                                onLoadError(name, error);
                            }
                        }
                        if (data && requestGenerationByName.get(name) === getWorldInfoRequestGeneration(name)) {
                            cacheWorldInfoData(name, data);
                            data = cloneAsJsonWire(data);
                        }
                        batchResults.set(name, data);
                        if (worldInfoRequestCache.get(name) === deferred.promise) {
                            worldInfoRequestCache.delete(name);
                        }
                        deferred.settled = true;
                        deferred.resolve(data);
                    } catch (error) {
                        if (worldInfoRequestCache.get(name) === deferred.promise) {
                            worldInfoRequestCache.delete(name);
                        }
                        deferred.settled = true;
                        deferred.reject(error);
                        throw error;
                    }
                }, { abortOnError: false });

                for (const name of pendingNames) {
                    results.set(name, batchResults.get(name) ?? null);
                }
            } catch (error) {
                batchError = error;
                throw error;
            } finally {
                for (const [name, deferred] of deferredByName) {
                    if (worldInfoRequestCache.get(name) === deferred.promise) {
                        worldInfoRequestCache.delete(name);
                    }
                    if (!deferred.settled) {
                        deferred.settled = true;
                        if (batchError) {
                            deferred.reject(batchError);
                        } else {
                            deferred.resolve(null);
                        }
                    }
                }
            }
        }

        if (awaitedRequests.length) {
            await Promise.all(awaitedRequests);
        }

        return results;
    }

    async function loadWorldInfo(name) {
        const resolvedName = resolveWorldInfoName(name);
        if (!resolvedName) {
            return;
        }

        const results = await loadWorldInfoBatch([resolvedName]);
        return results.get(resolvedName) ?? null;
    }

    function recordWorldInfoDeleted(resolvedWorldInfoName) {
        pendingWorldInfoSaves.delete(resolvedWorldInfoName);
        if (pendingWorldInfoSaves.size === 0) {
            cancelDebounce(saveWorldDebounced);
        }

        if (worldInfoCache.has(resolvedWorldInfoName)) {
            worldInfoCache.delete(resolvedWorldInfoName);
        }
        worldInfoDeleteEpochs.set(resolvedWorldInfoName, (worldInfoDeleteEpochs.get(resolvedWorldInfoName) || 0) + 1);
        worldInfoCacheWriteTokens.delete(resolvedWorldInfoName);
        worldInfoCacheRollbackBaselines.delete(resolvedWorldInfoName);
        worldInfoSnapshotCache.delete(resolvedWorldInfoName);
        onInvalidateSearch();
    }

    async function deleteWorldInfoRecord(worldInfoName, { expectedVersion, onlyIfUnbound } = {}) {
        const resolvedWorldInfoName = resolveWorldInfoName(worldInfoName);
        if (!resolvedWorldInfoName) {
            return { deleted: false, resolvedName: '' };
        }
        invalidateWorldInfoRequestCache([resolvedWorldInfoName]);

        let response;
        try {
            response = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: resolvedWorldInfoName, expectedVersion, onlyIfUnbound }),
            });
        } catch (error) {
            error.resourceState = 'unknown';
            throw error;
        }

        if (!response.ok && (expectedVersion !== undefined || onlyIfUnbound === true)) {
            let failure = {};
            try {
                const parsed = await response.json();
                if (parsed && typeof parsed === 'object') failure = parsed;
            } catch {
                failure = {};
            }
            const code = failure.code || response.statusText || 'error';
            throw Object.assign(new Error(`World book '${resolvedWorldInfoName}' deletion was not acknowledged: HTTP ${response.status} ${code}`), failure);
        }
        if (!response.ok) {
            return { deleted: false, resolvedName: resolvedWorldInfoName };
        }

        recordWorldInfoDeleted(resolvedWorldInfoName);
        return { deleted: true, resolvedName: resolvedWorldInfoName };
    }

    return {
        loadWorldInfoBatch,
        loadWorldInfo,
        saveWorldInfo,
        cacheWorldInfoData,
        rememberWorldInfoSnapshot,
        getWorldInfoSnapshot,
        getWorldInfoRequestGeneration,
        invalidateWorldInfoRequestCache,
        recordWorldInfoDeleted,
        deleteWorldInfoRecord,
        saveWorldDebounced,
    };
}
