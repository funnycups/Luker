// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createSdGenerationTracker } from '../../public/scripts/extensions/stable-diffusion/generation-tracking.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeActivityGuardApi(reg) {
    return Object.freeze({
        acquire: reg.acquireActivityLease,
        run: reg.withActivityLease,
        hasUnloadGuard: reg.hasUnloadGuard,
        hasChatSwitchGuard: reg.hasChatSwitchGuard,
        hasKeepAliveHold: reg.hasKeepAliveHold,
        list: reg.getActiveActivities,
        subscribe: reg.subscribeActivityGuard,
    });
}

const EVENT_TYPES = {
    IMAGE_GENERATION_STARTED: 'image_generation_started',
    IMAGE_GENERATION_ENDED: 'image_generation_ended',
};

describe('stable-diffusion generation tracker activity guard leases', () => {
    let registry;
    let emittedEvents;
    let toastrErrors;
    let activeGenerations;
    let generationAbortControllers;
    let trackedGenerationControllers;
    let sdSettings;
    let sendGenerationRequestImpl;
    let tracker;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        emittedEvents = [];
        toastrErrors = [];
        activeGenerations = 0;
        generationAbortControllers = [];
        trackedGenerationControllers = new Set();
        sdSettings = { width: 512, height: 512, seed: -1 };
        sendGenerationRequestImpl = async () => '/user/images/iris/out.png';

        const context = {
            chatId: 'chat-sd-1',
            characterId: 0,
            characters: [{ name: 'Iris', avatar: 'iris.png' }],
            groupId: null,
            groups: [],
            get activityGuard() {
                return makeActivityGuardApi(registry);
            },
        };

        tracker = createSdGenerationTracker({
            getContext: () => context,
            getEventSource: () => ({
                emit: (event, ...args) => {
                    emittedEvents.push({ event, args });
                },
            }),
            getEventTypes: () => EVENT_TYPES,
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            getActiveGenerations: () => activeGenerations,
            setActiveGenerations: (next) => { activeGenerations = next; },
            generationAbortControllers,
            trackedGenerationControllers,
            getSettings: () => sdSettings,
            transientSessionHeaders: () => {},
            resolveSdConnectionBinding: () => {},
            getPrompt: async (_mode, prompt) => prompt,
            sendGenerationRequest: (...args) => sendGenerationRequestImpl(...args),
            refinePrompt: async (prompt) => prompt,
            setTypeSpecificDimensions: () => ({ width: 512, height: 512 }),
            restoreOriginalDimensions: () => {},
            beginImageActivityJob: () => ({ setPrompt: () => {}, setImage: () => {}, setError: () => {}, setRetry: () => {}, finish: () => {} }),
            isVideo: () => false,
            getGenerationMode: () => ({ FREE: 'free' }),
            getInitiators: () => ({ tool: 'tool', swipe: 'swipe' }),
            MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video' },
            MEDIA_SOURCE: { GENERATED: 'generated' },
            getDocument: () => ({ getElementById: () => null }),
            getJQuery: () => () => ({ show: () => {}, hide: () => {} }),
            getToastr: () => ({
                error: (msg) => { toastrErrors.push(String(msg || '')); },
            }),
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('generateServiceImage acquires chat sd:image lease, keeps STARTED/ENDED events, and aborts on cancel', async () => {
        const gate = deferred();
        let capturedSignal = null;
        sendGenerationRequestImpl = (_mode, _prompt, _neg, _char, _cb, _init, signal, onError) => {
            capturedSignal = signal;
            signal.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                onError?.(err);
                gate.reject(err);
            }, { once: true });
            return gate.promise;
        };

        const promise = tracker.generateServiceImage({ prompt: 'a brass lantern in rain' });
        await new Promise(r => setTimeout(r, 10));

        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);
        expect(registry.hasChatSwitchGuard()).toBe(true);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:image',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardChatSwitch: true,
                guardUnload: true,
                keepAlive: true,
            }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('generateServiceImage uses global scope when attribution is none', async () => {
        const gate = deferred();
        sendGenerationRequestImpl = () => gate.promise;

        const promise = tracker.generateServiceImage({ prompt: 'a studio portrait', attribution: 'none' });
        await new Promise(r => setTimeout(r, 10));

        expect(registry.hasChatSwitchGuard()).toBe(false);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:image',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardChatSwitch: false,
            }),
        ]);

        gate.resolve('/user/images/out/studio.png');
        const res = await promise;
        expect(res.imagePath).toContain('.png');
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('skipActivityLease suppresses activity lease while still emitting STARTED/ENDED events on both service and bridge', async () => {
        const gate1 = deferred();
        sendGenerationRequestImpl = () => gate1.promise;

        const servicePromise = tracker.generateServiceImage({ prompt: 'illustrated scene', skipActivityLease: true });
        await new Promise(r => setTimeout(r, 10));

        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);
        expect(registry.getActiveActivities()).toEqual([]);

        gate1.resolve('/user/images/out/scene1.png');
        await servicePromise;
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);

        emittedEvents.length = 0;
        const gate2 = deferred();
        sendGenerationRequestImpl = () => gate2.promise;
        const bridgePromise = tracker.generateBridgeImage('illustrated scene 2', { skipActivityLease: true });
        await new Promise(r => setTimeout(r, 10));

        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);
        expect(registry.getActiveActivities()).toEqual([]);

        gate2.resolve('/user/images/out/scene2.png');
        await bridgePromise;
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);
    });

    test('generateBridgeImage defaults to chat scope and respects attribution none', async () => {
        const gate1 = deferred();
        sendGenerationRequestImpl = () => gate1.promise;

        const p1 = tracker.generateBridgeImage('harbor mist');
        await new Promise(r => setTimeout(r, 10));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'chat', guardChatSwitch: true }),
        ]);

        gate1.resolve('/user/images/out/harbor.png');
        await p1;
        expect(registry.getActiveActivities()).toEqual([]);

        const gate2 = deferred();
        sendGenerationRequestImpl = () => gate2.promise;
        const p2 = tracker.generateBridgeImage('studio lamp', { attribution: 'none' });
        await new Promise(r => setTimeout(r, 10));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'global', guardChatSwitch: false }),
        ]);

        gate2.resolve('/user/images/out/lamp.png');
        await p2;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('startGenerationTracking / endGenerationTracking / endGenerationTrackingEarly handle controller and null leases without leaking', () => {
        const controller = new AbortController();
        tracker.startGenerationTracking(controller);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'chat' }),
        ]);
        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);

        tracker.endGenerationTrackingEarly(controller);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);

        tracker.endGenerationTracking(controller);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);

        emittedEvents.length = 0;
        tracker.startGenerationTracking(null);
        tracker.startGenerationTracking(null);
        expect(registry.getActiveActivities()).toHaveLength(2);
        tracker.endGenerationTracking(null);
        expect(registry.getActiveActivities()).toHaveLength(1);
        tracker.endGenerationTracking(null);
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('generateMediaSwipe tracks IMAGE_GENERATION_STARTED/ENDED, acquires chat sd:image lease, and aborts on cancel', async () => {
        const gate = deferred();
        let capturedSignal = null;
        sendGenerationRequestImpl = (_mode, _prompt, _neg, _char, _cb, _init, signal) => {
            capturedSignal = signal;
            signal.addEventListener('abort', () => {
                gate.resolve('');
            }, { once: true });
            return gate.promise;
        };

        const onStart = jest.fn();
        const onComplete = jest.fn();
        const abortController = new AbortController();
        const promise = tracker.generateMediaSwipe(
            { title: 'a brass compass', negative: '', width: 512, height: 512 },
            { extra: {} },
            onStart,
            onComplete,
            abortController,
        );

        await new Promise(r => setTimeout(r, 10));
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(emittedEvents.map(e => e.event)).toEqual([EVENT_TYPES.IMAGE_GENERATION_STARTED]);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:image',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardChatSwitch: true,
            }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);

        await expect(promise).resolves.toBeNull();
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(toastrErrors).toEqual([]);
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);

        emittedEvents.length = 0;
        sendGenerationRequestImpl = async () => '/user/images/out/compass.png';
        const swipeResult = await tracker.generateMediaSwipe(
            { title: 'a brass compass', negative: '' },
            { extra: {} },
            jest.fn(),
            jest.fn(),
            new AbortController(),
        );
        expect(swipeResult?.url).toContain('.png');
        expect(emittedEvents.map(e => e.event)).toEqual([
            EVENT_TYPES.IMAGE_GENERATION_STARTED,
            EVENT_TYPES.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);
    });
});
