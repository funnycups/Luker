/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';

globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class MockPopup {
    constructor(content) {
        this.content = content;
        this.el = null;
    }
    show() {
        this.el = document.createElement('div');
        this.el.className = 'mock-popup';
        this.el.innerHTML = String(this.content || '');
        document.body.appendChild(this.el);
    }
    async complete() {
        this.el?.remove();
        this.el = null;
        return 1;
    }
}

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: MockPopup,
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    callGenericPopup: jest.fn(async () => 'edited prompt'),
}));

jest.unstable_mockModule('../../public/scripts/chats.js', () => ({
    deleteMediaFromServer: jest.fn(async () => true),
}));

let createIllustrationPipeline;
let initIllustrationActions;
let createImageService;
let GenerationQueue;
let createStudioView;

function installDomJquery() {
    function wrap(elements) {
        const list = elements.filter(Boolean);
        return {
            length: list.length,
            0: list[0],
            on(eventName, selectorOrHandler, maybeHandler) {
                const isDelegated = typeof selectorOrHandler === 'string';
                const handler = isDelegated ? maybeHandler : selectorOrHandler;
                for (const el of list) {
                    el.addEventListener(eventName, event => {
                        if (!isDelegated) {
                            handler.call(el, event);
                            return;
                        }
                        const matched = event.target?.closest?.(selectorOrHandler);
                        if (matched && el.contains(matched)) {
                            handler.call(matched, event);
                        }
                    });
                }
                return this;
            },
            find(selector) {
                const found = [];
                for (const el of list) {
                    found.push(...el.querySelectorAll(selector));
                }
                return wrap(found);
            },
            attr(name) {
                return list[0]?.getAttribute?.(name) ?? undefined;
            },
            prop(name) {
                return list[0]?.[name];
            },
        };
    }
    const jq = selectorOrEl => {
        if (typeof selectorOrEl === 'string') {
            return wrap([...document.querySelectorAll(selectorOrEl)]);
        }
        if (selectorOrEl instanceof Element || selectorOrEl === document) {
            return wrap([selectorOrEl]);
        }
        return wrap([]);
    };
    globalThis.$ = jq;
    globalThis.jQuery = jq;
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

function tTag(strings, ...values) {
    return strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), '');
}

let registry;

beforeAll(async () => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = v => String(v).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, c => `\\${c}`);
    }
    installDomJquery();

    ({ createIllustrationPipeline } = await import('../../public/scripts/extensions/stable-diffusion/illustration/pipeline.js'));
    ({ initIllustrationActions } = await import('../../public/scripts/extensions/stable-diffusion/illustration/actions.js'));
    ({ createImageService } = await import('../../public/scripts/extensions/stable-diffusion/illustration/image-service.js'));
    ({ GenerationQueue } = await import('../../public/scripts/extensions/stable-diffusion/illustration/queue.js'));
    ({ createStudioView } = await import('../../public/scripts/extensions/stable-diffusion/lens/views/studio-view.js'));
});

beforeEach(() => {
    document.body.innerHTML = '';
    registry = createActivityGuardRegistry();
});

afterEach(() => {
    const leftover = registry.getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('Auto Illustration & Studio activity guard leases', () => {
    const SETTINGS = {
        enabled: true,
        autoGenerate: true,
        currentPresetId: 'p',
        presets: [{ id: 'p', illustrationPrompt: 'TASK', studioPrompt: 'STUDIO', llm: { apiPresetName: '', llmPresetName: '' } }],
        contextMessageCount: 0,
        maxConcurrentGenerations: 1,
        minGenerationInterval: 0,
        imageDisplayWidth: 100,
    };

    test('pipeline.runForMessage holds sd:illustration chat lease through saveChat, suppresses inner sd:image lease, and aborts cleanly on cancel', async () => {
        const promptGate = deferred();
        const saveGate = deferred();
        const bridgeGenerateCalls = [];
        const notifyErrors = [];

        const message = {
            name: 'Iris',
            is_user: false,
            is_system: false,
            mes: 'alpha beta',
            send_date: 1,
            original_avatar: 'iris.png',
            swipe_id: 0,
            swipes: ['alpha beta'],
            swipe_info: [{ extra: {} }],
        };
        const chat = [message];
        const context = {
            chat,
            chatId: 'chat-ill-1',
            activityGuard: makeActivityGuardApi(registry),
            generateTask: jest.fn(async () => promptGate.promise),
        };

        const bridge = {
            getAvailableLoras: async () => ({ names: [], includeWeight: false }),
            getCapabilities: async () => null,
            generateImage: jest.fn(async (_prompt, opts) => {
                bridgeGenerateCalls.push(opts);
                // Emulate SD bridge behavior: if skipActivityLease is NOT true, acquire sd:image.
                if (!opts?.skipActivityLease) {
                    const release = context.activityGuard.acquire({
                        source: 'sd:image',
                        label: 'Image generation',
                        scope: opts?.attribution === 'none' ? 'global' : 'chat',
                    });
                    try {
                        return '/user/images/ill_1.png';
                    } finally {
                        release();
                    }
                }
                return '/user/images/ill_1.png';
            }),
        };
        const queue = new GenerationQueue({ maxConcurrent: 1, minInterval: 0 });
        const imageService = createImageService({ bridge, queue, context });

        const pipeline = createIllustrationPipeline({
            context,
            imageService,
            settings: SETTINGS,
            hooks: {
                toast: () => {},
                notifyError: (msg) => notifyErrors.push(String(msg)),
                t: tTag,
                saveChat: async () => saveGate.promise,
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat-ill-1',
                getChat: () => chat,
            },
        });

        const runPromise = pipeline.runForMessage({ messageId: 0, source: 'manual' });
        await new Promise(r => setTimeout(r, 20));

        expect(registry.hasChatSwitchGuard()).toBe(true);
        expect(registry.getChatSwitchBlockingLabels()).toEqual(['Illustration generation']);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:illustration',
                label: 'Illustration generation',
                scope: 'chat',
            }),
        ]);

        promptGate.resolve({
            toolCalls: [{
                name: 'add_image_prompt',
                args: { prompt: 'harbor dusk', insert_after: 'alpha', insert_before: 'beta' },
            }],
        });
        await new Promise(r => setTimeout(r, 20));

        // Still holding sd:illustration while saveChat is pending!
        expect(bridgeGenerateCalls).toHaveLength(1);
        expect(bridgeGenerateCalls[0].skipActivityLease).toBe(true);
        expect(registry.getChatSwitchBlockingLabels()).toEqual(['Illustration generation']);

        saveGate.resolve();
        await runPromise;

        expect(registry.getActiveActivities()).toEqual([]);
        expect(notifyErrors).toEqual([]);

        // Now verify abort via onCancel during image generation!
        const imageGate = deferred();
        let seenSignal = null;
        bridge.generateImage.mockImplementationOnce(async (_prompt, opts) => {
            seenSignal = opts?.signal;
            opts?.signal?.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                imageGate.reject(err);
            }, { once: true });
            return imageGate.promise;
        });

        const message2 = {
            name: 'Iris',
            is_user: false,
            is_system: false,
            mes: 'gamma delta',
            send_date: 2,
            original_avatar: 'iris.png',
            swipe_id: 0,
            swipes: ['gamma delta'],
            swipe_info: [{ extra: {} }],
        };
        chat.push(message2);
        context.generateTask.mockResolvedValueOnce({
            toolCalls: [{
                name: 'add_image_prompt',
                args: { prompt: 'storm pier', insert_after: 'gamma', insert_before: 'delta' },
            }],
        });

        const abortRun = pipeline.runForMessage({ messageId: 1, source: 'manual' });
        await new Promise(r => setTimeout(r, 20));
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'sd:illustration', scope: 'chat' }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(seenSignal?.aborted).toBe(true);
        await abortRun;

        expect(registry.getActiveActivities()).toEqual([]);
        expect(notifyErrors).toEqual([]);
        expect(message2.mes).toBe('gamma delta');
    });

    test('actions.runGeneration holds sd:illustration chat lease through saveChat and aborts cleanly on cancel', async () => {
        const imageGate = deferred();
        const saveGate = deferred();
        const notifyErrors = [];
        let seenBridgeOptions = null;

        const record = {
            id: 'ill_orig',
            prompt: 'lantern pier',
            negativePrompt: '',
            aspectRatio: '',
            references: [],
            characterPrompts: [],
            locked: false,
            imageUrl: '/user/images/orig.png',
            status: 'ready',
            anchorAfter: 'alpha',
            anchorBefore: 'beta',
            loras: [],
        };
        const message = {
            name: 'Iris',
            is_user: false,
            mes: 'alpha <img src="/user/images/orig.png" data-illustration-id="ill_orig"> beta',
            swipe_id: 0,
            swipes: ['alpha <img src="/user/images/orig.png" data-illustration-id="ill_orig"> beta'],
            swipe_info: [{ extra: { illustrations: [record] } }],
            extra: { illustrations: [record] },
        };
        const chatEl = document.createElement('div');
        chatEl.id = 'chat';
        chatEl.innerHTML = '<div class="mes" mesid="0"><div class="mes_text"><img data-illustration-id="ill_orig" src="/user/images/orig.png"></div></div>';
        document.body.appendChild(chatEl);

        const context = {
            chat: [message],
            chatId: 'chat-actions-1',
            activityGuard: makeActivityGuardApi(registry),
            updateMessageBlock: jest.fn(),
            saveChat: jest.fn(async () => saveGate.promise),
            eventTypes: {},
            eventSource: { emit: async () => {} },
        };

        const bridge = {
            getAvailableLoras: async () => ({ names: [], includeWeight: false }),
            getCapabilities: async () => ({ supportsSourceImage: false }),
            generateImage: jest.fn(async (_prompt, opts) => {
                seenBridgeOptions = opts;
                opts?.signal?.addEventListener('abort', () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    imageGate.reject(err);
                }, { once: true });
                return imageGate.promise;
            }),
        };
        const queue = new GenerationQueue({ maxConcurrent: 1, minInterval: 0 });
        const imageService = createImageService({ bridge, queue, context });

        const actions = initIllustrationActions({
            context,
            pipeline: { cancelForMessage: () => {} },
            imageService,
            settings: SETTINGS,
            ensureSwipes: () => {},
            toast: () => {},
            notifyError: (msg) => notifyErrors.push(String(msg)),
            t: tTag,
        });

        await actions.handleClick(document.querySelector('[data-illustration-id="ill_orig"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        expect(seenBridgeOptions?.skipActivityLease).toBe(true);
        expect(registry.getChatSwitchBlockingLabels()).toEqual(['Illustration generation']);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:illustration',
                label: 'Illustration generation',
                scope: 'chat',
            }),
        ]);

        // Finish image gen; lease remains held until saveChat settles
        imageGate.resolve('/user/images/regen.png');
        await new Promise(r => setTimeout(r, 20));
        expect(registry.getActiveActivities()).toHaveLength(1);

        saveGate.resolve();
        await new Promise(r => setTimeout(r, 20));
        expect(registry.getActiveActivities()).toEqual([]);
        expect(notifyErrors).toEqual([]);

        // Second run: cancel mid-flight via activityGuard
        const imageGate2 = deferred();
        let signal2 = null;
        bridge.generateImage.mockImplementationOnce(async (_prompt, opts) => {
            signal2 = opts?.signal;
            opts?.signal?.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                imageGate2.reject(err);
            }, { once: true });
            return imageGate2.promise;
        });

        await actions.handleClick(document.querySelector('[data-illustration-id]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));
        expect(registry.getActiveActivities()).toHaveLength(1);

        registry.cancelChatSwitchActivities();
        expect(signal2?.aborted).toBe(true);
        await new Promise(r => setTimeout(r, 20));
        expect(registry.getActiveActivities()).toEqual([]);
        expect(notifyErrors).toEqual([]);
    });

    test('studio-view runTurn and regenerateGalleryImage hold global sd:studio lease without blocking chat switches', async () => {
        const namespaces = new Map();
        const llmGate = deferred();
        const genCalls = [];

        const ctx = {
            chatId: 'chat-studio-1',
            name1: 'User',
            extensionSettings: { sd: { illustration: structuredClone(SETTINGS) } },
            activityGuard: makeActivityGuardApi(registry),
            imageGeneration: {
                isAvailable: () => true,
                getCapabilities: async () => ({
                    supportsSourceImage: true,
                    supportsCharacterReference: false,
                    characterReferenceEnabled: false,
                    availableLoras: { names: [], includeWeight: false },
                }),
                generate: jest.fn(async (req) => {
                    genCalls.push(req);
                    return { imagePath: `/user/images/_studio/s_${genCalls.length}.png` };
                }),
            },
            generateTask: jest.fn(async () => llmGate.promise),
            getGlobalState: async (ns) => ({ ok: true, state: namespaces.get(ns) || {} }),
            updateGlobalState: async (ns, updater) => {
                const next = await updater(namespaces.get(ns) || {});
                if (next) namespaces.set(ns, next);
                return { ok: true, state: next };
            },
        };
        globalThis.Luker = { getContext: () => ({ translate: s => String(s ?? ''), ...ctx }) };

        const view = createStudioView({
            getContext: () => ctx,
            toast: () => {},
        });
        document.body.appendChild(view.el);
        view.show();
        await new Promise(r => setTimeout(r, 20));

        const input = view.el.querySelector('[data-sd-role="studio-input"]');
        input.value = 'Paint an astrolabe';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        view.el.querySelector('[data-sd-role="studio-send"]').click();
        await new Promise(r => setTimeout(r, 20));

        expect(registry.hasChatSwitchGuard()).toBe(false);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:studio',
                label: 'Image Studio',
                scope: 'global',
                guardChatSwitch: false,
                guardUnload: true,
                keepAlive: true,
            }),
        ]);

        llmGate.resolve({
            toolCalls: [{ id: 'tc_1', name: 'generate_image', args: { prompt: 'brass astrolabe' } }],
            assistantText: '',
        });
        await new Promise(r => setTimeout(r, 30));

        expect(genCalls).toHaveLength(1);
        expect(genCalls[0]).toMatchObject({
            prompt: 'brass astrolabe',
            attribution: 'none',
            skipActivityLease: true,
        });
        expect(registry.getActiveActivities()).toEqual([]);

        // Test regenerateGalleryImage also holds global sd:studio lease
        const regenGate = deferred();
        ctx.imageGeneration.generate.mockImplementationOnce(async (req) => {
            genCalls.push(req);
            return regenGate.promise;
        });

        view.el.querySelector('[data-studio-action="regenerate"]').click();
        await new Promise(r => setTimeout(r, 20));

        expect(registry.hasChatSwitchGuard()).toBe(false);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'sd:studio',
                label: 'Image Studio',
                scope: 'global',
            }),
        ]);

        regenGate.resolve({ imagePath: '/user/images/_studio/s_regen.png' });
        await new Promise(r => setTimeout(r, 20));
        expect(genCalls[1]).toMatchObject({
            attribution: 'none',
            skipActivityLease: true,
        });
        expect(registry.getActiveActivities()).toEqual([]);
    });
});
