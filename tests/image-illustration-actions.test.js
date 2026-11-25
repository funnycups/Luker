/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';

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

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: MockPopup,
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    callGenericPopup: jest.fn(async () => 'edited prompt'),
}));

jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    deleteMediaFromServer: jest.fn(async () => true),
}));

let initIllustrationActions;
let createImageService;
let GenerationQueue;
let buildImageTag;
let createIllustrationRecord;
let appendIllustrationRecords;
let createImageActivity;

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

function tTag(strings, ...values) {
    return strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), '');
}

beforeAll(async () => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = v => String(v).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, c => `\\${c}`);
    }
    installDomJquery();
    ({ createImageActivity } = await import('../public/scripts/extensions/stable-diffusion/activity.js'));
    ({ initIllustrationActions } = await import('../public/scripts/extensions/stable-diffusion/illustration/actions.js'));
    ({ createImageService } = await import('../public/scripts/extensions/stable-diffusion/illustration/image-service.js'));
    ({ GenerationQueue } = await import('../public/scripts/extensions/stable-diffusion/illustration/queue.js'));
    ({ buildImageTag } = await import('../public/scripts/extensions/stable-diffusion/illustration/message.js'));
    ({ createIllustrationRecord, appendIllustrationRecords } = await import('../public/scripts/extensions/stable-diffusion/illustration/records.js'));
});

const activitiesToCleanup = [];

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    while (activitiesToCleanup.length > 0) {
        activitiesToCleanup.pop().destroy();
    }
});

function buildTwoImageFixture({ maxConcurrent = 2, supportsSourceImage = false } = {}) {
    const recA = createIllustrationRecord({
        id: 'ill_A',
        prompt: 'harbor lantern at dusk',
        imageUrl: '/user/images/a1.png',
        anchorAfter: 'First',
        anchorBefore: 'Second',
    });
    const recB = createIllustrationRecord({
        id: 'ill_B',
        prompt: 'moonlit pier in fog',
        imageUrl: '/user/images/b1.png',
        anchorAfter: 'Second',
        anchorBefore: 'Third',
    });
    const tagA = buildImageTag({ id: recA.id, imageUrl: recA.imageUrl, prompt: recA.prompt, width: 100 });
    const tagB = buildImageTag({ id: recB.id, imageUrl: recB.imageUrl, prompt: recB.prompt, width: 100 });
    const mes = `First ${tagA} Second ${tagB} Third`;
    const message = {
        name: 'Narrator',
        is_user: false,
        is_system: false,
        send_date: 1,
        original_avatar: 'n.png',
        mes,
        swipe_id: 0,
        swipes: [mes],
        swipe_info: [{ extra: { illustrations: [recA, recB] } }],
        extra: { illustrations: [recA, recB] },
    };

    const chatEl = document.createElement('div');
    chatEl.id = 'chat';
    chatEl.innerHTML = `<div class="mes" mesid="0"><div class="mes_text">${mes}</div></div>`;
    document.body.appendChild(chatEl);

    const context = {
        chatId: 'chat-actions-fix',
        chat: [message],
        extensionSettings: { sd: { img2img_enabled: supportsSourceImage } },
        updateMessageBlock: jest.fn((id, msg) => {
            const textEl = chatEl.querySelector(`.mes[mesid="${id}"] .mes_text`);
            if (textEl) textEl.innerHTML = msg.mes;
        }),
        saveChat: jest.fn(async () => {}),
        eventSource: { emit: jest.fn(async () => {}) },
        eventTypes: { MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
    };

    const calls = [];
    const getCapabilitiesAsync = jest.fn(async () => {
        throw new Error('Async getCapabilities must not be called on click');
    });
    const getCapabilitiesSnapshot = jest.fn(() => ({
        supportsCharacterReference: false,
        supportsStyleReference: false,
        supportsSourceImage,
    }));

    const bridge = {
        getAvailableLoras: async () => ({ names: [], includeWeight: false }),
        getCapabilities: getCapabilitiesAsync,
        getCapabilitiesSnapshot,
        generateImage: jest.fn((prompt, opts) => {
            const gate = deferred();
            const call = { prompt, opts, gate, aborted: false };
            calls.push(call);
            opts?.signal?.addEventListener('abort', () => {
                call.aborted = true;
                const err = new Error('Aborted');
                err.name = 'AbortError';
                gate.reject(err);
            }, { once: true });
            return gate.promise;
        }),
    };

    const queue = new GenerationQueue({ maxConcurrent, minInterval: 0 });
    const imageService = createImageService({ bridge, queue, context });
    const activity = createImageActivity({ translate: text => String(text), getChatKey: () => 'chat-actions-fix' });
    activitiesToCleanup.push(activity);
    const notifyErrors = [];
    const toasts = [];
    const actions = initIllustrationActions({
        context,
        pipeline: { cancelForMessage: jest.fn() },
        imageService,
        settings: { imageDisplayWidth: 100 },
        ensureSwipes: () => {},
        toast: (msg, type) => toasts.push({ msg, type }),
        notifyError: msg => notifyErrors.push(String(msg)),
        beginActivityJob: options => activity.beginJob(options),
        t: tTag,
    });

    return {
        message,
        chatEl,
        context,
        bridge,
        imageService,
        activity,
        actions,
        calls,
        notifyErrors,
        toasts,
        getCapabilitiesAsync,
        getCapabilitiesSnapshot,
        pillEl: () => document.getElementById('luker-sd-run-panel-pill'),
    };
}

describe('Illustration action popup, activity pill progress, and concurrent regeneration', () => {
    test('clicking an illustration opens the popup synchronously from local capabilities without calling async getCapabilities', () => {
        const fx = buildTwoImageFixture({ supportsSourceImage: true });
        const imgA = fx.chatEl.querySelector('[data-illustration-id="ill_A"]');

        // Must show synchronously in the same turn, before any microtask resolves.
        const shown = fx.actions.handleClick(imgA);
        expect(shown).toBe(true);
        expect(document.getElementById('sd_illustration_actions')).not.toBeNull();
        expect(document.getElementById('sd_illustration_action_edit_from_image')).not.toBeNull();
        expect(fx.getCapabilitiesSnapshot).toHaveBeenCalledTimes(1);
        expect(fx.getCapabilitiesAsync).not.toHaveBeenCalled();
    });

    test('regenerating an illustration drives the real image activity pill and run panel through prompt, image, retry, and completion', async () => {
        const fx = buildTwoImageFixture();
        const imgA = fx.chatEl.querySelector('[data-illustration-id="ill_A"]');

        fx.actions.handleClick(imgA);
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        expect(fx.calls).toHaveLength(1);
        const pill = fx.pillEl();
        expect(pill).not.toBeNull();
        expect(pill.hidden).toBe(false);
        expect(pill.querySelector('.activity-pill-label').textContent).toBe('Generating image');
        expect(pill.dataset.tone).toBe('running');

        const runningRun = fx.activity.store.getCurrentRun();
        expect(runningRun.rounds).toHaveLength(1);
        expect(runningRun.rounds[0].label).toBe('Message #1');
        expect(runningRun.rounds[0].sections.map(s => [s.kind, s.status])).toEqual([
            ['prompt', 'done'],
            ['image', 'running'],
        ]);

        // Retry callback updates the real capsule text
        fx.calls[0].opts.onRetry?.(1, 3);
        expect(pill.querySelector('.activity-pill-label').textContent).toBe('Retrying · 1/3');
        expect(pill.dataset.tone).toBe('attention');

        fx.calls[0].gate.resolve('/user/images/a2.png');
        await new Promise(r => setTimeout(r, 20));

        const finishedRun = fx.activity.store.getCurrentRun();
        expect(finishedRun.status).toBe('committed');
        expect(finishedRun.rounds[0].status).toBe('done');
        const imgSection = finishedRun.rounds[0].sections.find(s => s.kind === 'image');
        expect(imgSection.status).toBe('done');
        expect(imgSection.meta).toEqual({ imageUrl: '/user/images/a2.png' });
        expect(pill.hidden).toBe(true);
        expect(fx.notifyErrors).toEqual([]);
    });

    test('stopping from the activity panel aborts active and queued regenerations cleanly without error notifications', async () => {
        const fx = buildTwoImageFixture({ maxConcurrent: 1 });
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_B"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        const pill = fx.pillEl();
        expect(pill).not.toBeNull();
        expect(pill.hidden).toBe(false);
        expect(pill.querySelector('.activity-pill-label').textContent).toBe('Generating image · 2');

        fx.activity.abortAll();
        await new Promise(r => setTimeout(r, 20));

        expect(fx.calls).toHaveLength(1);
        expect(fx.calls[0].aborted).toBe(true);
        expect(fx.activity.store.getCurrentRun().status).toBe('aborted');
        expect(pill.hidden).toBe(true);
        expect(fx.notifyErrors).toEqual([]);
    });

    test('regenerating a second image in the same message does not interrupt the first and both write back cleanly', async () => {
        const fx = buildTwoImageFixture({ maxConcurrent: 2 });

        // Start regenerating ill_A
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        // Start regenerating ill_B in the SAME message while ill_A is still running
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_B"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        expect(fx.calls).toHaveLength(2);
        expect(fx.calls[0].aborted).toBe(false);
        expect(fx.calls[1].aborted).toBe(false);
        const pill = fx.pillEl();
        expect(pill.hidden).toBe(false);
        expect(pill.querySelector('.activity-pill-label').textContent).toBe('Generating image · 2');

        // Finish ill_A first, then ill_B
        fx.calls[0].gate.resolve('/user/images/a2.png');
        await new Promise(r => setTimeout(r, 20));

        expect(fx.message.mes).toContain('src="/user/images/a2.png"');
        expect(fx.message.mes).toContain('data-illustration-id="ill_B"');
        expect(pill.hidden).toBe(false);
        expect(pill.querySelector('.activity-pill-label').textContent).toBe('Generating image');

        fx.calls[1].gate.resolve('/user/images/b2.png');
        await new Promise(r => setTimeout(r, 20));

        expect(fx.message.mes).toContain('src="/user/images/a2.png"');
        expect(fx.message.mes).toContain('src="/user/images/b2.png"');
        expect(fx.message.mes).not.toContain('data-illustration-id="ill_A"');
        expect(fx.message.mes).not.toContain('data-illustration-id="ill_B"');
        expect(fx.message.extra.illustrations).toHaveLength(4);
        expect(fx.message.swipes[0]).toBe(fx.message.mes);
        expect(fx.notifyErrors).toEqual([]);
        expect(fx.activity.store.getCurrentRun().status).toBe('committed');
        expect(pill.hidden).toBe(true);
    });

    test('re-regenerating the same illustration cancels only its own older run without interrupting sibling images', async () => {
        const fx = buildTwoImageFixture({ maxConcurrent: 3 });

        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_B"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        // Re-trigger ill_A again
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        expect(fx.calls).toHaveLength(3);
        expect(fx.calls[0].aborted).toBe(true);
        expect(fx.calls[1].aborted).toBe(false);
        expect(fx.calls[2].aborted).toBe(false);

        fx.calls[1].gate.resolve('/user/images/b2.png');
        fx.calls[2].gate.resolve('/user/images/a3.png');
        await new Promise(r => setTimeout(r, 20));

        expect(fx.message.mes).toContain('src="/user/images/a3.png"');
        expect(fx.message.mes).toContain('src="/user/images/b2.png"');
        expect(fx.notifyErrors).toEqual([]);
    });

    test('deleting one illustration while two are regenerating cancels only the deleted one', async () => {
        const fx = buildTwoImageFixture({ maxConcurrent: 2 });

        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_B"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        // Delete ill_A while both are regenerating
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_delete').click();
        await new Promise(r => setTimeout(r, 20));
        document.getElementById('sd_illustration_delete_confirm').click();
        await new Promise(r => setTimeout(r, 20));

        expect(fx.calls[0].aborted).toBe(true);
        expect(fx.calls[1].aborted).toBe(false);

        fx.calls[1].gate.resolve('/user/images/b2.png');
        await new Promise(r => setTimeout(r, 20));

        expect(fx.message.mes).toContain('src="/user/images/b2.png"');
        expect(fx.message.mes).not.toContain('data-illustration-id="ill_A"');
        expect(fx.notifyErrors).toEqual([]);
    });

    test('manual text edits during regeneration still discard stale generated images and record error in activity', async () => {
        const fx = buildTwoImageFixture();
        fx.actions.handleClick(fx.chatEl.querySelector('[data-illustration-id="ill_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        fx.message.mes = fx.message.mes.replace('First', 'Edited');
        fx.calls[0].gate.resolve('/user/images/stale.png');
        await new Promise(r => setTimeout(r, 20));

        expect(fx.message.mes).not.toContain('/user/images/stale.png');
        expect(fx.notifyErrors).toHaveLength(1);
        expect(fx.notifyErrors[0]).toContain('Message changed');
        expect(fx.activity.store.getCurrentRun().status).toBe('error');
    });

    test('concurrent retries of failed badges on CJK text without spaces both write back cleanly', async () => {
        const failedA = createIllustrationRecord({
            id: 'fail_A',
            prompt: 'scene A',
            status: 'failed',
            error: 'timeout',
            anchorAfter: '你好',
            anchorBefore: '世界',
        });
        const failedB = createIllustrationRecord({
            id: 'fail_B',
            prompt: 'scene B',
            status: 'failed',
            error: 'timeout',
            anchorAfter: '世界',
            anchorBefore: '再见',
        });
        const message = {
            name: 'Narrator',
            is_user: false,
            is_system: false,
            send_date: 2,
            original_avatar: 'n.png',
            mes: '你好世界再见',
            swipe_id: 0,
            swipes: ['你好世界再见'],
            swipe_info: [{ extra: {} }],
            extra: {},
        };
        appendIllustrationRecords(message, [failedA, failedB]);

        const chatEl = document.createElement('div');
        chatEl.id = 'chat';
        chatEl.innerHTML = '<div class="mes" mesid="0"><div class="mes_text"><span data-illustration-id="fail_A">A</span><span data-illustration-id="fail_B">B</span></div></div>';
        document.body.appendChild(chatEl);

        const calls = [];
        const notifyErrors = [];
        const context = {
            chatId: 'chat-cjk',
            chat: [message],
            updateMessageBlock: jest.fn(),
            saveChat: jest.fn(async () => {}),
            eventSource: { emit: jest.fn(async () => {}) },
            eventTypes: { MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
        };
        const bridge = {
            getAvailableLoras: async () => ({ names: [], includeWeight: false }),
            getCapabilitiesSnapshot: () => ({ supportsSourceImage: false }),
            generateImage: jest.fn((prompt, opts) => {
                const gate = deferred();
                calls.push({ prompt, opts, gate });
                return gate.promise;
            }),
        };
        const imageService = createImageService({
            bridge,
            queue: new GenerationQueue({ maxConcurrent: 2, minInterval: 0 }),
            context,
        });
        const actions = initIllustrationActions({
            context,
            pipeline: { cancelForMessage: jest.fn() },
            imageService,
            settings: { imageDisplayWidth: 100 },
            ensureSwipes: () => {},
            toast: () => {},
            notifyError: msg => notifyErrors.push(String(msg)),
            t: tTag,
        });

        actions.handleClick(chatEl.querySelector('[data-illustration-id="fail_A"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        actions.handleClick(chatEl.querySelector('[data-illustration-id="fail_B"]'));
        document.getElementById('sd_illustration_action_regenerate').click();
        await new Promise(r => setTimeout(r, 20));

        expect(calls).toHaveLength(2);
        calls[0].gate.resolve('/user/images/cjk_a.png');
        await new Promise(r => setTimeout(r, 20));
        calls[1].gate.resolve('/user/images/cjk_b.png');
        await new Promise(r => setTimeout(r, 20));

        expect(notifyErrors).toEqual([]);
        expect(message.mes).toContain('/user/images/cjk_a.png');
        expect(message.mes).toContain('/user/images/cjk_b.png');
        expect(message.extra.illustrations).toHaveLength(2);
    });
});
