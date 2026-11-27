// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    createSettingsSaveCoordinator,
    persistFirstRunCompletion,
} from '../public/scripts/lib/settings-save-coordinator.js';
import { createGenerationMetaTracker } from '../public/scripts/lib/response-meta-subscription.js';

describe('firstRun onboarding persistence rollback guards', () => {
    let origFetch;
    let firstRun;
    let settingsReady;
    let listeners;
    let coordinator;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        firstRun = true;
        settingsReady = true;
        listeners = [];
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        coordinator = createSettingsSaveCoordinator({
            isSettingsReady: () => settingsReady,
            buildSettingsPayload: () => ({ firstRun, main_api: 'openai' }),
            emitSettingsUpdated: async (payload) => {
                for (const fn of [...listeners]) {
                    await fn(payload);
                }
            },
        });
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    test('does NOT reset firstRun=true when saveSettings returns status: deferred (not_ready)', async () => {
        settingsReady = false;
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));

        const deferredOutcome = await persistFirstRunCompletion({
            setFirstRun: (v) => { firstRun = v; },
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, opts),
        });
        expect(deferredOutcome).toEqual({ ok: false, status: 'deferred', reason: 'not_ready' });
        expect(firstRun).toBe(false);

        // Once settingsReady flips true, subsequent save persists firstRun: false (NOT rolled back to true)
        settingsReady = true;
        const outcome = await coordinator.saveSettings(0, { directSave: true });
        expect(outcome.ok).toBe(true);
        expect(outcome.payload.firstRun).toBe(false);
    });

    test('does NOT reset firstRun=true when a post-save SETTINGS_UPDATED listener throws', async () => {
        const throwingListener = jest.fn(() => {
            throw new Error('listener exploded after save');
        });
        listeners.push(throwingListener);

        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));

        await persistFirstRunCompletion({
            setFirstRun: (v) => { firstRun = v; },
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, opts),
        });

        expect(throwingListener).toHaveBeenCalled();
        expect(firstRun).toBe(false);

        listeners.length = 0;
        const followUp = await coordinator.saveSettings(0, { directSave: true });
        expect(followUp.ok).toBe(true);
        expect(followUp.payload.firstRun).toBe(false);
    });

    test('DOES reset firstRun=true when /api/settings/save actually fails', async () => {
        const failedSaveBodies = [];
        globalThis.fetch = jest.fn(async (url, init) => {
            if (url === '/api/settings/save') failedSaveBodies.push(JSON.parse(init.body));
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => ({}),
            };
        });

        await persistFirstRunCompletion({
            setFirstRun: (v) => { firstRun = v; },
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, opts),
        });

        expect(failedSaveBodies).toHaveLength(1);
        expect(failedSaveBodies[0].firstRun).toBe(false);
        expect(firstRun).toBe(true);

        // Switch fetch back to ok and verify firstRun was rolled back to true
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
        }));
        const followUp = await coordinator.saveSettings(0, { directSave: true });
        expect(followUp.ok).toBe(true);
        expect(followUp.payload.firstRun).toBe(true);
    });
});

describe('non-OpenAI generation onLukerResponseMeta guards & disposal', () => {
    const metaListeners = new WeakMap();
    const onLukerResponseMetaStub = jest.fn((response, listener) => {
        if (!metaListeners.has(response)) metaListeners.set(response, new Set());
        const set = metaListeners.get(response);
        set.add(listener);
        return () => { set.delete(listener); };
    });

    beforeEach(() => {
        onLukerResponseMetaStub.mockClear();
    });

    test('disposes listener after response finishes and ignores stale generationId or mismatched live main_api', () => {
        let liveApi = 'kobold';
        const tracker = createGenerationMetaTracker({ onLukerResponseMeta: onLukerResponseMetaStub });
        const epoch = tracker.beginGeneration();

        const resp1 = {
            headers: { get: (k) => (String(k).toLowerCase() === 'x-luker-generation-id' ? 'gen-1' : null) },
        };
        const { cleanup } = tracker.attachResponse({
            response: resp1,
            expectedEpoch: epoch,
            expectedGenerationId: 'gen-1',
            signal: new AbortController().signal,
            isApiActive: () => liveApi === 'kobold',
        });

        expect(metaListeners.get(resp1)?.size).toBe(1);
        expect(tracker.getLastGenerationId()).toBe('gen-1');

        // Stale mismatched generation_id on resp1 must be ignored
        for (const fn of [...metaListeners.get(resp1)]) {
            fn({ generation_id: 'gen-stale', persisted: true });
        }
        expect(tracker.getLastGenerationId()).toBe('gen-1');
        expect(tracker.isLastReplyPersisted()).toBe(false);

        // Switching live main_api to openai makes resp1's listener ignore subsequent meta
        liveApi = 'openai';
        for (const fn of [...metaListeners.get(resp1)]) {
            fn({ generation_id: 'gen-1', persisted: true });
        }
        expect(tracker.isLastReplyPersisted()).toBe(false);

        // Finishing response disposes the listener
        cleanup();
        expect(metaListeners.get(resp1)?.size).toBe(0);
    });

    test('starting a second generation disposes the first listener and invalidates its epoch', () => {
        const tracker = createGenerationMetaTracker({ onLukerResponseMeta: onLukerResponseMetaStub });
        const epoch1 = tracker.beginGeneration();
        const resp1 = { headers: { get: () => null } };
        tracker.attachResponse({
            response: resp1,
            expectedEpoch: epoch1,
            expectedGenerationId: '',
            signal: new AbortController().signal,
            isApiActive: () => true,
        });
        expect(metaListeners.get(resp1)?.size).toBe(1);
        const listener1 = [...metaListeners.get(resp1)][0];

        // Second generation starts and finishes -> disposes listener1 and advances epoch
        const epoch2 = tracker.beginGeneration();
        const resp2 = {
            headers: { get: (k) => (String(k).toLowerCase() === 'x-luker-generation-id' ? 'gen-2' : null) },
        };
        const { cleanup: cleanup2 } = tracker.attachResponse({
            response: resp2,
            expectedEpoch: epoch2,
            expectedGenerationId: 'gen-2',
            signal: new AbortController().signal,
            isApiActive: () => true,
        });
        expect(metaListeners.get(resp1)?.size).toBe(0);
        cleanup2();
        expect(metaListeners.get(resp2)?.size).toBe(0);
        expect(tracker.getLastGenerationId()).toBe('gen-2');

        // Even if listener1 is invoked late directly, stale epoch guard drops it
        listener1({ generation_id: 'gen-1-late', persisted: false });
        expect(tracker.getLastGenerationId()).toBe('gen-2');
    });
});
