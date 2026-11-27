// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { attachStreamingResponseMeta } from '../public/scripts/lib/response-meta-subscription.js';

const metaListeners = new WeakMap();
const disposedListeners = [];

function emitMeta(response, meta) {
    const set = metaListeners.get(response);
    if (!set) return;
    for (const fn of [...set]) fn({ ...meta });
}

function listenerCount(response) {
    return metaListeners.get(response)?.size ?? 0;
}

const onLukerResponseMetaStub = jest.fn((response, listener) => {
    if (!metaListeners.has(response)) metaListeners.set(response, new Set());
    const set = metaListeners.get(response);
    set.add(listener);
    return () => {
        if (set.delete(listener)) {
            disposedListeners.push({ response, listener });
        }
    };
});

function makeResponse({ headers = {} } = {}) {
    return {
        headers: {
            get: (name) => headers[String(name).toLowerCase()] ?? null,
        },
    };
}

beforeEach(() => {
    onLukerResponseMetaStub.mockClear();
    disposedListeners.length = 0;
});

describe('attachStreamingResponseMeta disposal and generationId guard', () => {
    test('ignores stale meta with mismatched generation_id and disposes listener after cleanup', () => {
        const resp = makeResponse({ headers: { 'x-luker-generation-id': 'gen-1' } });
        const received = [];
        const onLukerMeta = jest.fn((m) => received.push(m));
        const controller = new AbortController();

        const sub = attachStreamingResponseMeta({
            response: resp,
            expectedGenerationId: 'gen-1',
            signal: controller.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta,
        });
        sub.armAbortCleanup();

        expect(listenerCount(resp)).toBe(1);
        expect(received).toContainEqual({ generationId: 'gen-1' });

        // Stale generation_id is ignored
        emitMeta(resp, { generation_id: 'gen-stale', persisted: true });
        expect(received.filter(m => m.generationId === 'gen-stale')).toEqual([]);
        expect(received.filter(m => m.persisted === true)).toEqual([]);

        // Matching generation_id is forwarded
        emitMeta(resp, { generation_id: 'gen-1', persisted: true });
        expect(received).toContainEqual({ persisted: true });

        // Cleanup disposes listener and suppresses late emissions
        sub.cleanup();
        expect(listenerCount(resp)).toBe(0);
        onLukerMeta.mockClear();
        emitMeta(resp, { generation_id: 'gen-1', persisted: false });
        expect(onLukerMeta).not.toHaveBeenCalled();
    });

    test('disposes listener immediately on cleanup before armAbortCleanup and on signal abort once armed', () => {
        // Simulates !response.ok path: cleanup runs before armAbortCleanup
        const errResp = makeResponse({ headers: { 'x-luker-generation-id': 'gen-err' } });
        const errAc = new AbortController();
        const errAddSpy = jest.spyOn(errAc.signal, 'addEventListener');
        const errSub = attachStreamingResponseMeta({
            response: errResp,
            expectedGenerationId: 'gen-err',
            signal: errAc.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta: jest.fn(),
        });
        expect(listenerCount(errResp)).toBe(1);
        errSub.cleanup();
        errSub.armAbortCleanup();
        expect(listenerCount(errResp)).toBe(0);
        expect(errAddSpy).not.toHaveBeenCalled();

        // Armed abort listener disposes on signal abort
        const abortResp = makeResponse();
        const ac = new AbortController();
        const abortSub = attachStreamingResponseMeta({
            response: abortResp,
            expectedGenerationId: 'gen-abort',
            signal: ac.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta: jest.fn(),
        });
        abortSub.armAbortCleanup();
        expect(listenerCount(abortResp)).toBe(1);
        ac.abort();
        expect(listenerCount(abortResp)).toBe(0);
    });

    test('ignores mismatched x-luker-generation-id header without overwriting persisted state or subscribing', () => {
        const resp = makeResponse({
            headers: {
                'x-luker-generation-id': 'gen-other',
                'x-luker-server-persisted': '1',
            },
        });
        const onLukerMeta = jest.fn();
        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');

        const sub = attachStreamingResponseMeta({
            response: resp,
            expectedGenerationId: 'gen-1',
            signal: ac.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta,
        });
        sub.armAbortCleanup();

        expect(onLukerMeta).not.toHaveBeenCalled();
        expect(onLukerResponseMetaStub).not.toHaveBeenCalled();
        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).not.toHaveBeenCalled();
    });

    test('cleans up response meta and signal abort listeners when setup fails after arming', () => {
        const resp = makeResponse({ headers: { 'x-luker-generation-id': 'gen-setup-err' } });
        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');
        const removeSpy = jest.spyOn(ac.signal, 'removeEventListener');

        const sub = attachStreamingResponseMeta({
            response: resp,
            expectedGenerationId: 'gen-setup-err',
            signal: ac.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta: jest.fn(),
        });
        sub.armAbortCleanup();
        sub.cleanup();

        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const registeredHandler = addSpy.mock.calls[0][1];
        expect(removeSpy).toHaveBeenCalledWith('abort', registeredHandler);
    });

    test('does not attach signal abort listener when onLukerMeta is omitted or synchronously disposed via onLukerMetaDisposer', () => {
        const respNoMeta = makeResponse();
        const acNoMeta = new AbortController();
        const addNoMetaSpy = jest.spyOn(acNoMeta.signal, 'addEventListener');

        const noMetaSub = attachStreamingResponseMeta({
            response: respNoMeta,
            expectedGenerationId: 'gen-nometa',
            signal: acNoMeta.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
        });
        noMetaSub.armAbortCleanup();
        expect(addNoMetaSpy).not.toHaveBeenCalled();
        expect(listenerCount(respNoMeta)).toBe(0);

        const respSyncDispose = makeResponse({ headers: { 'x-luker-generation-id': 'gen-sync-dispose' } });
        const acSyncDispose = new AbortController();
        const addSyncDisposeSpy = jest.spyOn(acSyncDispose.signal, 'addEventListener');

        const syncSub = attachStreamingResponseMeta({
            response: respSyncDispose,
            expectedGenerationId: 'gen-sync-dispose',
            signal: acSyncDispose.signal,
            onLukerResponseMeta: onLukerResponseMetaStub,
            onLukerMeta: jest.fn(),
            onLukerMetaDisposer: (dispose) => { dispose(); },
        });
        syncSub.armAbortCleanup();
        expect(listenerCount(respSyncDispose)).toBe(0);
        expect(addSyncDisposeSpy).not.toHaveBeenCalled();
    });
});
