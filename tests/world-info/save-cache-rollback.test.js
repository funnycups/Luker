// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { StructuredCloneMap } from '../../public/scripts/util/StructuredCloneMap.js';
import { createWorldInfoPersistenceCoordinator } from '../../public/scripts/lib/world-info-cache-coordinator.js';

describe('world-info-cache-coordinator saveWorldInfo cache rollback and delete fencing', () => {
    let origFetch;
    let worldInfoCache;
    let coordinator;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        worldInfoCache = new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: true });
        coordinator = createWorldInfoPersistenceCoordinator({
            worldInfoCache,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            buildObjectPatchOperationsAsync: async () => [{ op: 'replace', path: '/entries', value: {} }],
            readWorldInfoDocument: async () => null,
            debounce: (fn) => {
                const wrapped = (...args) => fn(...args);
                wrapped.cancel = () => {};
                return wrapped;
            },
            cancelDebounce: () => {},
            debounceTimeoutMs: 10,
        });
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    const saveWorldInfo = (...args) => coordinator.saveWorldInfo(...args);
    const loadWorldInfo = (...args) => coordinator.loadWorldInfo(...args);
    const deleteWorldInfo = async (name, opts) => (await coordinator.deleteWorldInfoRecord(name, opts)).deleted;

    test('restores previous worldInfoCache entry when immediate save fails (HTTP 500)', async () => {
        const previous = { entries: { 0: { uid: 0, content: 'persisted' } } };
        worldInfoCache.set('BookA', previous);

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

        const unpersisted = { entries: { 0: { uid: 0, content: 'poisoned' } } };
        await expect(saveWorldInfo('BookA', unpersisted, true)).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookA')).toEqual(previous);
    });

    test('evicts worldInfoCache entry when immediate save fails for an uncached book', async () => {
        globalThis.fetch = jest.fn(async () => {
            throw new TypeError('network down');
        });

        await expect(saveWorldInfo('UncachedBook', { entries: { 1: { uid: 1, content: 'draft' } } }, true))
            .rejects.toThrow('network down');

        expect(worldInfoCache.has('UncachedBook')).toBe(false);
    });

    test('does not clobber a newer successful save when an earlier save fails', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
                return { ok: false, status: 500 };
            }
            return { ok: true, status: 200 };
        });

        worldInfoCache.set('BookRace', { entries: { 0: { uid: 0, content: 'v0' } } });

        const firstSave = saveWorldInfo('BookRace', { entries: { 0: { uid: 0, content: 'v1-fails' } } }, true);
        const secondSave = saveWorldInfo('BookRace', { entries: { 0: { uid: 0, content: 'v2-wins' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await secondSave;

        expect(worldInfoCache.get('BookRace')).toEqual({ entries: { 0: { uid: 0, content: 'v2-wins' } } });
    });

    test('restores persisted v0 (never unpersisted v1) when two overlapping saves both fail', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
            }
            return { ok: false, status: 500 };
        });

        const v0 = { entries: { 0: { uid: 0, content: 'v0-persisted' } } };
        worldInfoCache.set('BookOverlap', v0);

        const firstSave = saveWorldInfo('BookOverlap', { entries: { 0: { uid: 0, content: 'v1-unpersisted' } } }, true);
        const secondSave = saveWorldInfo('BookOverlap', { entries: { 0: { uid: 0, content: 'v2-unpersisted' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookOverlap')).toEqual(v0);
    });

    test('evicts cache entry (never leaves unpersisted v1) when two overlapping saves both fail for an uncached book', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
            }
            return { ok: false, status: 500 };
        });

        const firstSave = saveWorldInfo('BookUncachedOverlap', { entries: { 0: { uid: 0, content: 'v1-unpersisted' } } }, true);
        const secondSave = saveWorldInfo('BookUncachedOverlap', { entries: { 0: { uid: 0, content: 'v2-unpersisted' } } }, true);

        releaseFirst();
        await expect(firstSave).rejects.toThrow(/Failed to save world info: 500/);
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.has('BookUncachedOverlap')).toBe(false);
    });

    test('updates rollback baseline after a save succeeds so a later failure rolls back to the last persisted state', async () => {
        const v0 = { entries: { 0: { uid: 0, content: 'v0' } } };
        const v1 = { entries: { 0: { uid: 0, content: 'v1-persisted' } } };
        worldInfoCache.set('BookAfterSuccess', v0);

        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
        await saveWorldInfo('BookAfterSuccess', v1, true);
        expect(worldInfoCache.get('BookAfterSuccess')).toEqual(v1);

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
        await expect(saveWorldInfo('BookAfterSuccess', { entries: { 0: { uid: 0, content: 'v2-fails' } } }, true))
            .rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookAfterSuccess')).toEqual(v1);
    });

    test('restores unmutated persisted state when caller mutates previously cached object in place before a failed save', async () => {
        const book = { entries: { 0: { uid: 0, content: 'persisted-clean' } } };
        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
        await saveWorldInfo('BookInPlace', book, true);

        book.entries[0].content = 'poisoned-in-place';
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
        await expect(saveWorldInfo('BookInPlace', book, true)).rejects.toThrow(/Failed to save world info: 500/);

        expect(worldInfoCache.get('BookInPlace')).toEqual({
            entries: { 0: { uid: 0, content: 'persisted-clean' } },
        });
    });

    test('does not poison worldInfoSnapshotCache when loadWorldInfo reads an unpersisted queued save', async () => {
        let releaseBlocker;
        const blockerGate = new Promise((res) => { releaseBlocker = res; });
        const savedRequests = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            savedRequests.push({ url, body });
            if (body.name === 'BlockerBook') {
                await blockerGate;
            }
            return { ok: true, status: 200 };
        });

        const blockerSave = saveWorldInfo('BlockerBook', { entries: { 0: { uid: 0, content: 'block' } } }, true);
        const queuedNewBook = { entries: { 1: { uid: 1, content: 'must-persist' } } };
        const newBookSave = saveWorldInfo('QueuedNewBook', queuedNewBook, true);

        const loaded = await loadWorldInfo('QueuedNewBook');
        expect(loaded).toEqual(queuedNewBook);

        releaseBlocker();
        await blockerSave;
        await newBookSave;

        const persistedNewBook = savedRequests.find((req) => req.body.name === 'QueuedNewBook');
        expect(persistedNewBook).toBeDefined();
        expect(persistedNewBook.url).toBe('/api/worldinfo/edit');
        expect(persistedNewBook.body.data).toEqual(queuedNewBook);
    });

    test('does not regress newer optimistic cache write when an earlier overlapping save succeeds, and rolls back to that persisted save if the newer save fails', async () => {
        let releaseFirst;
        const firstGate = new Promise((res) => { releaseFirst = res; });
        let releaseSecond;
        const secondGate = new Promise((res) => { releaseSecond = res; });
        let callIndex = 0;

        globalThis.fetch = jest.fn(async () => {
            callIndex += 1;
            if (callIndex === 1) {
                await firstGate;
                return { ok: true, status: 200 };
            }
            await secondGate;
            return { ok: false, status: 500 };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'v1-persisted' } } };
        const v2 = { entries: { 0: { uid: 0, content: 'v2-fails' } } };
        const firstSave = saveWorldInfo('BookOverlapKeepNewer', v1, true);
        const secondSave = saveWorldInfo('BookOverlapKeepNewer', v2, true);

        releaseFirst();
        await firstSave;
        expect(worldInfoCache.get('BookOverlapKeepNewer')).toEqual(v2);

        releaseSecond();
        await expect(secondSave).rejects.toThrow(/Failed to save world info: 500/);
        expect(worldInfoCache.get('BookOverlapKeepNewer')).toEqual(v1);
    });

    test('in-flight save completing after deleteWorldInfo does not re-seed snapshot cache and block recreating with identical content', async () => {
        let releaseInitialSave;
        const initialSaveGate = new Promise((res) => { releaseInitialSave = res; });
        const editCalls = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editCalls.push(body);
                if (editCalls.length === 1) {
                    await initialSaveGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'recreated-content' } } };
        const initialSave = saveWorldInfo('BookDeletedMidSave', v1, true);
        await deleteWorldInfo('BookDeletedMidSave');

        releaseInitialSave();
        await initialSave;

        await saveWorldInfo('BookDeletedMidSave', v1, true);
        expect(editCalls).toHaveLength(2);
        expect(editCalls[1]).toEqual({ name: 'BookDeletedMidSave', data: v1 });
    });

    test('pre-delete in-flight save does not poison snapshot cache or rollback baseline when a post-delete recreate queues before it settles', async () => {
        let releaseInitialSave;
        const initialSaveGate = new Promise((res) => { releaseInitialSave = res; });
        const editCalls = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editCalls.push(body);
                if (editCalls.length === 1) {
                    await initialSaveGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const v1 = { entries: { 0: { uid: 0, content: 'undo-same-content' } } };
        const initialSave = saveWorldInfo('BookDeletedBeforeRecreate', v1, true);
        await deleteWorldInfo('BookDeletedBeforeRecreate');

        const recreateSave = saveWorldInfo('BookDeletedBeforeRecreate', v1, true);
        releaseInitialSave();
        await Promise.all([initialSave, recreateSave]);

        expect(editCalls).toHaveLength(2);
        expect(editCalls[1]).toEqual({ name: 'BookDeletedBeforeRecreate', data: v1 });

        let releasePreDelete2;
        const preDelete2Gate = new Promise((res) => { releasePreDelete2 = res; });
        let editCount2 = 0;
        globalThis.fetch = jest.fn(async (url) => {
            if (url === '/api/worldinfo/edit') {
                editCount2 += 1;
                if (editCount2 === 1) {
                    await preDelete2Gate;
                    return { ok: true, status: 200 };
                }
                return { ok: false, status: 500 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const preSave2 = saveWorldInfo('BookDeletedFailRecreate', v1, true);
        await deleteWorldInfo('BookDeletedFailRecreate');
        const failedRecreate = saveWorldInfo('BookDeletedFailRecreate', { entries: { 0: { uid: 0, content: 'v2-fails' } } }, true);
        releasePreDelete2();
        await preSave2;
        await expect(failedRecreate).rejects.toThrow(/Failed to save world info: 500/);
        expect(worldInfoCache.has('BookDeletedFailRecreate')).toBe(false);
    });

    test('queued pre-delete save on worldInfoSaveChain aborts without calling /api/worldinfo/edit after deleteWorldInfo', async () => {
        let releaseBlocker;
        const blockerGate = new Promise((res) => { releaseBlocker = res; });
        const editNames = [];

        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/worldinfo/edit') {
                editNames.push(body.name);
                if (body.name === 'QueueBlockerBook') {
                    await blockerGate;
                }
                return { ok: true, status: 200 };
            }
            if (url === '/api/worldinfo/delete') {
                return { ok: true, status: 200 };
            }
            return { ok: true, status: 200, json: async () => ({ world_names: [] }) };
        });

        const blocker = saveWorldInfo('QueueBlockerBook', { entries: { 0: { uid: 0, content: 'hold' } } }, true);
        const queuedPreDelete = saveWorldInfo('BookDeletedWhileQueued', { entries: { 0: { uid: 0, content: 'stale' } } }, true);

        await deleteWorldInfo('BookDeletedWhileQueued');
        releaseBlocker();
        await Promise.all([blocker, queuedPreDelete]);

        expect(editNames).toEqual(['QueueBlockerBook']);
        expect(worldInfoCache.has('BookDeletedWhileQueued')).toBe(false);
    });

    test('loadWorldInfoBatch bounds concurrency and resolves single-book waiters independently of slow siblings', async () => {
        let releaseSlow;
        const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
        let inFlight = 0;
        let maxInFlight = 0;
        const readCalls = [];

        const batchCache = new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: true });
        const batchCoordinator = createWorldInfoPersistenceCoordinator({
            worldInfoCache: batchCache,
            readWorldInfoDocument: async (name) => {
                readCalls.push(name);
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    if (name === 'SlowBook') {
                        await slowGate;
                    } else {
                        await new Promise((resolve) => setTimeout(resolve, 1));
                    }
                    return { entries: { 0: { uid: 0, content: name } } };
                } finally {
                    inFlight -= 1;
                }
            },
            debounce: (fn) => fn,
        });

        const batchPromise = batchCoordinator.loadWorldInfoBatch(['FastBook', 'SlowBook']);
        const singleFastPromise = batchCoordinator.loadWorldInfo('FastBook');

        const fastResult = await singleFastPromise;
        expect(fastResult).toEqual({ entries: { 0: { uid: 0, content: 'FastBook' } } });
        expect(readCalls.filter((name) => name === 'FastBook')).toHaveLength(1);

        releaseSlow();
        const batchResult = await batchPromise;
        expect(batchResult.get('SlowBook')).toEqual({ entries: { 0: { uid: 0, content: 'SlowBook' } } });

        const manyNames = Array.from({ length: 80 }, (_, index) => `BulkBook_${index}`);
        inFlight = 0;
        maxInFlight = 0;
        const manyResults = await batchCoordinator.loadWorldInfoBatch(manyNames);
        expect(manyResults.size).toBe(80);
        expect(maxInFlight).toBeGreaterThan(1);
        expect(maxInFlight).toBeLessThanOrEqual(64);
    });
});
