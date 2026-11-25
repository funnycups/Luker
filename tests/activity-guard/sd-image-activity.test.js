// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let registry = createActivityGuardRegistry();
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

const emittedEvents = [];
const toastrErrors = [];
const extensionSettingsMock = {
    sd: {
        source: 'pollinations',
        model: 'flux',
        width: 512,
        height: 512,
        seed: -1,
        pollinations_enhance: false,
        prompt_prefix: '',
        negative_prefix: '',
        style: 'None',
        styles: [],
        character_prompts: {},
        character_negative_prompts: {},
        comfy_type: 'standard',
        reference_settings: {},
    },
};

const eventTypes = {
    IMAGE_GENERATION_STARTED: 'image_generation_started',
    IMAGE_GENERATION_ENDED: 'image_generation_ended',
    SD_PROMPT_PROCESSING: 'sd_prompt_processing',
    FORCE_SET_BACKGROUND: 'force_set_background',
    CHAT_CHANGED: 'chat_id_changed',
    IMAGE_SWIPED: 'image_swiped',
    SECRET_WRITTEN: 'secret_written',
    SECRET_DELETED: 'secret_deleted',
    SECRET_ROTATED: 'secret_rotated',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
};

const eventSourceMock = {
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(async (event, ...args) => {
        emittedEvents.push({ event, args });
    }),
};

const contextMock = {
    chatId: 'chat-sd-1',
    characterId: 0,
    characters: [{ name: 'Iris', avatar: 'iris.png' }],
    groupId: null,
    groups: [],
    connectionProfiles: { list: () => [] },
    get activityGuard() {
        return makeActivityGuardApi(registry);
    },
};

globalThis.toastr = {
    info: () => null,
    success: () => null,
    warning: () => null,
    error: (msg) => { toastrErrors.push(String(msg || '')); return null; },
    clear: () => {},
};

let sdIndex;

beforeAll(async () => {
    const noop = () => {};
    jest.unstable_mockModule('../../public/script.js', () => ({
        animation_duration: 0,
        appendMediaToMessage: noop,
        event_types: eventTypes,
        eventSource: eventSourceMock,
        formatCharacterAvatar: () => '',
        generateQuietPrompt: async () => 'quiet',
        getCharacterAvatar: () => '',
        getCharacterDescription: () => '',
        getCharacterScenario: () => '',
        getCurrentChatId: () => contextMock.chatId,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getUserAvatar: () => '',
        saveSettingsDebounced: noop,
        substituteParams: (s) => String(s ?? ''),
        substituteParamsExtended: (s) => String(s ?? ''),
        systemUserName: 'System',
        this_chid: 0,
        user_avatar: 'user.png',
    }));
    jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettingsMock,
        getContext: () => contextMock,
        renderExtensionTemplateAsync: async () => '',
        writeExtensionField: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
        selected_group: null,
    }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
        debounce: (fn) => fn,
        deepMerge: (a, b) => ({ ...a, ...b }),
        delay: async () => {},
        getBase64Async: async () => '',
        getCharaFilename: () => 'iris',
        initScrollHeight: noop,
        isFalseBoolean: (v) => v === false || v === 'false',
        isTrueBoolean: (v) => v === true || v === 'true',
        resetScrollHeight: noop,
        saveBase64AsFile: async (_data, subdir, filename, format) => `/user/images/${subdir || 'out'}/${filename}.${format || 'png'}`,
        stringFormat: (s) => String(s ?? ''),
    }));
    jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
        getMessageTimeStamp: () => '2026-11-24',
        humanizedDateTime: () => '20261124-000000',
    }));
    jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
        SECRET_KEYS: {},
        secret_state: {},
    }));
    jest.unstable_mockModule('../../public/scripts/nai-settings.js', () => ({
        getNovelAnlas: () => 0,
        getNovelUnlimitedImageGeneration: () => false,
        loadNovelSubscriptionData: async () => {},
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
        getMultimodalCaption: async () => '',
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: { addCommandObject: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
        SlashCommand: { fromProps: (x) => x },
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: { fromProps: (x) => x },
        SlashCommandNamedArgument: { fromProps: (x) => x },
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
        SlashCommandEnumValue: class {},
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
        commonEnumProviders: { characters: () => [] },
    }));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        callGenericPopup: async () => 1,
        Popup: class {},
        POPUP_TYPE: {},
    }));
    jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({
        ToolManager: { registerFunctionTool: noop, unregisterFunctionTool: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/macros/macro-system.js', () => ({
        macros: { register: noop },
        MacroCategory: { PROMPTS: 'prompts' },
    }));
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
        translate: (s) => String(s ?? ''),
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-retry.js', () => ({
        withProfileRetry: async (fn) => fn(),
    }));
    jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
        oai_settings: {},
    }));
    jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
        power_user: { experimental_macro_engine: true },
    }));
    jest.unstable_mockModule('../../public/scripts/macros.js', () => ({
        MacrosParser: { registerMacro: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/stable-diffusion/illustration/index.js', () => ({
        initIllustration: async () => {},
    }));
    jest.unstable_mockModule('../../public/scripts/extensions/stable-diffusion/activity.js', () => ({
        initImageActivity: noop,
        beginImageActivityJob: () => ({ setPrompt: noop, setImage: noop, setError: noop, setRetry: noop, finish: noop }),
        openImageActivityPanel: noop,
    }));

    sdIndex = await import('../../public/scripts/extensions/stable-diffusion/index.js');
});

describe('stable-diffusion activity guard leases', () => {
    const origFetch = globalThis.fetch;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        emittedEvents.length = 0;
        toastrErrors.length = 0;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('createImageGenerationService().generate acquires chat sd:image lease, keeps STARTED/ENDED events, and aborts on cancel', async () => {
        const fetchGate = deferred();
        let capturedSignal = null;
        globalThis.fetch = jest.fn((_url, init) => {
            capturedSignal = init?.signal;
            capturedSignal?.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                fetchGate.reject(err);
            }, { once: true });
            return fetchGate.promise;
        });

        const service = sdIndex.createImageGenerationService();
        const promise = service.generate({ prompt: 'a brass lantern in rain' });
        await new Promise(r => setTimeout(r, 20));

        expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);
        expect(registry.hasChatSwitchGuard()).toBe(true);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:image',
                label: 'Image generation',
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
            eventTypes.IMAGE_GENERATION_STARTED,
            eventTypes.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('createImageGenerationService().generate uses global scope when attribution is none', async () => {
        const fetchGate = deferred();
        globalThis.fetch = jest.fn(() => fetchGate.promise);

        const service = sdIndex.createImageGenerationService();
        const promise = service.generate({ prompt: 'a studio portrait', attribution: 'none' });
        await new Promise(r => setTimeout(r, 20));

        expect(registry.hasChatSwitchGuard()).toBe(false);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:image',
                label: 'Image generation',
                scope: 'global',
                guardChatSwitch: false,
            }),
        ]);

        fetchGate.resolve({
            ok: true,
            json: async () => ({ format: 'png', image: 'base64data' }),
        });
        const res = await promise;
        expect(res.imagePath).toContain('.png');
        expect(emittedEvents.map(e => e.event)).toEqual([
            eventTypes.IMAGE_GENERATION_STARTED,
            eventTypes.IMAGE_GENERATION_ENDED,
        ]);
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('skipActivityLease suppresses activity lease while still emitting STARTED/ENDED events on both service and bridge', async () => {
        const fetchGate = deferred();
        globalThis.fetch = jest.fn(() => fetchGate.promise);

        const service = sdIndex.createImageGenerationService();
        const servicePromise = service.generate({ prompt: 'illustrated scene', skipActivityLease: true });
        await new Promise(r => setTimeout(r, 20));

        expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);
        expect(registry.getActiveActivities()).toEqual([]);

        fetchGate.resolve({
            ok: true,
            json: async () => ({ format: 'png', image: 'base64data' }),
        });
        await servicePromise;
        expect(emittedEvents.map(e => e.event)).toEqual([
            eventTypes.IMAGE_GENERATION_STARTED,
            eventTypes.IMAGE_GENERATION_ENDED,
        ]);

        emittedEvents.length = 0;
        const bridgeGate = deferred();
        globalThis.fetch = jest.fn(() => bridgeGate.promise);
        const bridge = sdIndex.createIllustrationBridge();
        const bridgePromise = bridge.generateImage('illustrated scene 2', { skipActivityLease: true });
        await new Promise(r => setTimeout(r, 20));

        expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);
        expect(registry.getActiveActivities()).toEqual([]);

        bridgeGate.resolve({
            ok: true,
            json: async () => ({ format: 'png', image: 'base64data' }),
        });
        await bridgePromise;
        expect(emittedEvents.map(e => e.event)).toEqual([
            eventTypes.IMAGE_GENERATION_STARTED,
            eventTypes.IMAGE_GENERATION_ENDED,
        ]);
    });

    test('createIllustrationBridge().generateImage defaults to chat scope and respects attribution none', async () => {
        const gate1 = deferred();
        globalThis.fetch = jest.fn(() => gate1.promise);

        const bridge = sdIndex.createIllustrationBridge();
        const p1 = bridge.generateImage('harbor mist');
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'chat', guardChatSwitch: true }),
        ]);

        gate1.resolve({ ok: true, json: async () => ({ format: 'png', image: 'abc' }) });
        await p1;
        expect(registry.getActiveActivities()).toEqual([]);

        const gate2 = deferred();
        globalThis.fetch = jest.fn(() => gate2.promise);
        const p2 = bridge.generateImage('studio lamp', { attribution: 'none' });
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'global', guardChatSwitch: false }),
        ]);

        gate2.resolve({ ok: true, json: async () => ({ format: 'png', image: 'abc' }) });
        await p2;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('startGenerationTracking / endGenerationTracking / endGenerationTrackingEarly handle controller and null leases without leaking', () => {
        const controller = new AbortController();
        sdIndex._startGenerationTrackingForTest(controller);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:image', scope: 'chat' }),
        ]);
        expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);

        sdIndex._endGenerationTrackingEarlyForTest(controller);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);

        sdIndex._endGenerationTrackingForTest(controller);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(emittedEvents.map(e => e.event)).toEqual([
            eventTypes.IMAGE_GENERATION_STARTED,
            eventTypes.IMAGE_GENERATION_ENDED,
        ]);

        emittedEvents.length = 0;
        sdIndex._startGenerationTrackingForTest(null);
        sdIndex._startGenerationTrackingForTest(null);
        expect(registry.getActiveActivities()).toHaveLength(2);
        sdIndex._endGenerationTrackingForTest(null);
        expect(registry.getActiveActivities()).toHaveLength(1);
        sdIndex._endGenerationTrackingForTest(null);
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('generateMediaSwipe tracks IMAGE_GENERATION_STARTED/ENDED, acquires chat sd:image lease, and aborts on cancel', async () => {
        const origDoc = globalThis.document;
        globalThis.document = { getElementById: () => null };
        try {
            const fetchGate = deferred();
            let capturedSignal = null;
            globalThis.fetch = jest.fn((_url, init) => {
                capturedSignal = init?.signal;
                capturedSignal?.addEventListener('abort', () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    fetchGate.reject(err);
                }, { once: true });
                return fetchGate.promise;
            });

            const onStart = jest.fn();
            const onComplete = jest.fn();
            const abortController = new AbortController();
            const promise = sdIndex._generateMediaSwipeForTest(
                { title: 'a brass compass', negative: '', width: 512, height: 512 },
                { extra: {} },
                onStart,
                onComplete,
                abortController,
            );

            await new Promise(r => setTimeout(r, 20));
            expect(onStart).toHaveBeenCalledTimes(1);
            expect(emittedEvents.map(e => e.event)).toEqual([eventTypes.IMAGE_GENERATION_STARTED]);
            expect(registry.getActiveActivities()).toEqual([
                expect.objectContaining({
                    source: 'sd:image',
                    label: 'Image generation',
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
                eventTypes.IMAGE_GENERATION_STARTED,
                eventTypes.IMAGE_GENERATION_ENDED,
            ]);
            expect(registry.getActiveActivities()).toEqual([]);

            // Success path also releases lease and emits ENDED cleanly.
            emittedEvents.length = 0;
            globalThis.fetch = jest.fn(async () => ({
                ok: true,
                json: async () => ({ format: 'png', image: 'base64data' }),
            }));
            const swipeResult = await sdIndex._generateMediaSwipeForTest(
                { title: 'a brass compass', negative: '' },
                { extra: {} },
                jest.fn(),
                jest.fn(),
                new AbortController(),
            );
            expect(swipeResult?.url).toContain('.png');
            expect(emittedEvents.map(e => e.event)).toEqual([
                eventTypes.IMAGE_GENERATION_STARTED,
                eventTypes.IMAGE_GENERATION_ENDED,
            ]);
            expect(registry.getActiveActivities()).toEqual([]);
        } finally {
            globalThis.document = origDoc;
        }
    });
});
