// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createGenerationMetaTracker } from '../public/scripts/lib/response-meta-subscription.js';
import { extractStreamingReply } from '../public/scripts/lib/openai-streaming-reply.js';

const metaListeners = new WeakMap();
const disposeCallCounts = new WeakMap();

const onLukerResponseMetaStub = jest.fn((response, listener) => {
    if (!metaListeners.has(response)) metaListeners.set(response, new Set());
    const set = metaListeners.get(response);
    set.add(listener);
    return () => {
        disposeCallCounts.set(response, (disposeCallCounts.get(response) ?? 0) + 1);
        set.delete(listener);
    };
});

function emitMeta(response, meta) {
    const set = metaListeners.get(response);
    if (!set) return;
    for (const fn of [...set]) fn({ ...meta });
}

function listenerCount(response) {
    return metaListeners.get(response)?.size ?? 0;
}

function disposeCount(response) {
    return disposeCallCounts.get(response) ?? 0;
}

function makeResponse({ headers = {} } = {}) {
    return {
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    };
}

describe('createGenerationMetaTracker disposal and stale generationId / epoch guards', () => {
    let liveMainApi;
    let tracker;

    beforeEach(() => {
        liveMainApi = 'openai';
        onLukerResponseMetaStub.mockClear();
        tracker = createGenerationMetaTracker({ onLukerResponseMeta: onLukerResponseMetaStub });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('ignores stale generation_id and disposes listener on cleanup', () => {
        const epoch = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-1');
        const resp = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        const { cleanup } = tracker.attachResponse({
            response: resp,
            expectedEpoch: epoch,
            expectedGenerationId: 'oai-gen-1',
            signal: new AbortController().signal,
            isApiActive: () => liveMainApi === 'openai',
        });

        expect(listenerCount(resp)).toBe(1);
        expect(tracker.getLastGenerationId()).toBe('oai-gen-1');
        expect(tracker.isLastReplyPersisted()).toBe(false);

        // Stale mismatched generation_id is ignored
        emitMeta(resp, { generation_id: 'oai-gen-stale', persisted: true });
        expect(tracker.isLastReplyPersisted()).toBe(false);
        expect(tracker.getLastGenerationId()).toBe('oai-gen-1');

        // Matching generation_id updates state
        emitMeta(resp, { generation_id: 'oai-gen-1', persisted: true });
        expect(tracker.isLastReplyPersisted()).toBe(true);

        cleanup();
        expect(listenerCount(resp)).toBe(0);
    });

    test('disposes previous listener on abort, on new generation (with stale-epoch rejection), and on live API switch', () => {
        // 1. Abort disposes active listener
        const e1 = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-1');
        const abortResp = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        const ac = new AbortController();
        tracker.attachResponse({
            response: abortResp,
            expectedEpoch: e1,
            expectedGenerationId: 'oai-gen-1',
            signal: ac.signal,
            isApiActive: () => liveMainApi === 'openai',
        });
        expect(listenerCount(abortResp)).toBe(1);
        ac.abort();
        expect(listenerCount(abortResp)).toBe(0);

        // 2. Starting a second generation disposes the first listener and rejects late callbacks on it
        const e2 = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-2');
        const resp1 = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-2' } });
        tracker.attachResponse({
            response: resp1,
            expectedEpoch: e2,
            expectedGenerationId: 'oai-gen-2',
            signal: new AbortController().signal,
            isApiActive: () => liveMainApi === 'openai',
        });
        expect(listenerCount(resp1)).toBe(1);
        const listener1 = [...metaListeners.get(resp1)][0];

        const e3 = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-3');
        const resp2 = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-3' } });
        const ac2 = new AbortController();
        tracker.attachResponse({
            response: resp2,
            expectedEpoch: e3,
            expectedGenerationId: 'oai-gen-3',
            signal: ac2.signal,
            isApiActive: () => liveMainApi === 'openai',
        });
        expect(listenerCount(resp1)).toBe(0);
        expect(listenerCount(resp2)).toBe(1);
        expect(tracker.getLastGenerationId()).toBe('oai-gen-3');
        expect(tracker.isLastReplyPersisted()).toBe(false);

        // Even if listener1 is invoked late directly, stale epoch guard drops it
        listener1({ generation_id: 'oai-gen-2', persisted: true });
        expect(tracker.getLastGenerationId()).toBe('oai-gen-3');
        expect(tracker.isLastReplyPersisted()).toBe(false);

        // Switching active API causes active listener to ignore subsequent meta
        liveMainApi = 'kobold';
        emitMeta(resp2, { generation_id: 'oai-gen-3', persisted: true });
        expect(tracker.isLastReplyPersisted()).toBe(false);

        ac2.abort();
        expect(listenerCount(resp2)).toBe(0);
    });

    test('ignores mismatched x-luker-generation-id header without overwriting persisted state or subscribing', () => {
        const epoch = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-1');
        const resp = makeResponse({
            headers: {
                'x-luker-generation-id': 'oai-gen-wrong',
                'x-luker-server-persisted': '1',
            },
        });
        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');

        const { attached } = tracker.attachResponse({
            response: resp,
            expectedEpoch: epoch,
            expectedGenerationId: 'oai-gen-1',
            signal: ac.signal,
            isApiActive: () => true,
        });

        expect(attached).toBe(false);
        expect(tracker.getLastGenerationId()).toBe('oai-gen-1');
        expect(tracker.isLastReplyPersisted()).toBe(false);
        expect(onLukerResponseMetaStub).not.toHaveBeenCalled();
        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).not.toHaveBeenCalled();
    });

    test('cleanup detaches signal abort listener and starting a subsequent generation detaches prior abort listener without double-disposing', () => {
        const e1 = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-1');
        const resp1 = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        const ac1 = new AbortController();
        const addSpy1 = jest.spyOn(ac1.signal, 'addEventListener');
        const removeSpy1 = jest.spyOn(ac1.signal, 'removeEventListener');

        tracker.attachResponse({
            response: resp1,
            expectedEpoch: e1,
            expectedGenerationId: 'oai-gen-1',
            signal: ac1.signal,
            isApiActive: () => true,
        });
        expect(listenerCount(resp1)).toBe(1);
        expect(addSpy1).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const registeredAbortHandler = addSpy1.mock.calls[0][1];

        const e2 = tracker.beginGeneration();
        tracker.setGenerationId('oai-gen-2');
        const resp2 = makeResponse({ headers: { 'x-luker-generation-id': 'oai-gen-2' } });
        const ac2 = new AbortController();
        tracker.attachResponse({
            response: resp2,
            expectedEpoch: e2,
            expectedGenerationId: 'oai-gen-2',
            signal: ac2.signal,
            isApiActive: () => true,
        });

        expect(listenerCount(resp1)).toBe(0);
        expect(disposeCount(resp1)).toBe(1);
        expect(removeSpy1).toHaveBeenCalledWith('abort', registeredAbortHandler);

        // Aborting signal1 afterwards must not call resp1's disposer a second time or affect resp2.
        ac1.abort();
        expect(disposeCount(resp1)).toBe(1);
        expect(listenerCount(resp2)).toBe(1);

        ac2.abort();
        expect(listenerCount(resp2)).toBe(0);
    });
});

describe('extractStreamingReply across OpenAI, Claude, Gemini, OpenRouter, and Mistral', () => {
    test('extracts streaming text and reasoning state across providers', () => {
        const oaiState = { reasoning: '' };
        expect(extractStreamingReply({ choices: [{ delta: { content: 'hello' } }] }, oaiState, { chatCompletionSource: 'openai' })).toBe('hello');

        const claudeState = { reasoning: '', reasoningBlocks: [] };
        extractStreamingReply({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'a' } }, claudeState, { chatCompletionSource: 'claude', showThoughts: true });
        extractStreamingReply({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } }, claudeState, { chatCompletionSource: 'claude', showThoughts: true });
        extractStreamingReply({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }, claudeState, { chatCompletionSource: 'claude', showThoughts: true });
        expect(extractStreamingReply({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }, claudeState, { chatCompletionSource: 'claude', showThoughts: true })).toBe('world');
        expect(claudeState.reasoning).toBe('b');
        expect(claudeState.reasoningBlocks[0]).toEqual({ type: 'thinking', thinking: 'ab', signature: 'sig-1' });

        const geminiState = { reasoning: '', images: [], signature: '' };
        expect(extractStreamingReply({
            candidates: [{ content: { parts: [{ thought: true, text: 'plan' }, { text: 'reply', thoughtSignature: 'gsig' }] } }],
        }, geminiState, { chatCompletionSource: 'makersuite', showThoughts: true })).toBe('reply');
        expect(geminiState.reasoning).toBe('plan');
        expect(geminiState.signature).toBe('gsig');

        const orState = { reasoning: '', images: [], reasoningDetails: [], toolSignatures: {} };
        expect(extractStreamingReply({
            choices: [{
                delta: {
                    content: 'ok',
                    reasoning: 'think',
                    reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'enc' }],
                },
            }],
        }, orState, { chatCompletionSource: 'openrouter', showThoughts: true })).toBe('ok');
        expect(orState.reasoning).toBe('think');
        expect(orState.toolSignatures).toEqual({ call_1: 'enc' });

        const mistralState = { reasoning: '' };
        expect(extractStreamingReply({
            choices: [{ delta: { content: [{ thinking: [{ text: 'm-think' }], text: 'm-text' }] } }],
        }, mistralState, { chatCompletionSource: 'mistralai', showThoughts: true })).toBe('m-text');
        expect(mistralState.reasoning).toBe('m-think');
    });
});
