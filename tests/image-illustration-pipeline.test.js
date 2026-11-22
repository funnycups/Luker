/**
 * @jest-environment jsdom
 */
import { expect, test, beforeAll } from '@jest/globals';
import {
    messageFingerprint, getLastAssistantMessage, buildJobKey, createIllustrationPipeline,
} from '../public/scripts/extensions/stable-diffusion/illustration/pipeline.js';
import { createImageActivity } from '../public/scripts/extensions/stable-diffusion/activity.js';
import { getFailedIllustrationRecords } from '../public/scripts/extensions/stable-diffusion/illustration/records.js';
import { createRecorder, createMemoryStorage, createDock } from '../public/scripts/run-panel/index.js';
import { createRunView } from '../public/scripts/extensions/stable-diffusion/lens/views/run-view.js';

// The jsdom environment used by this suite predates the platform clone helper
// the illustration modules call; the values cloned here are plain data.
globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));

beforeAll(() => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    }
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = id => clearTimeout(id);
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = value => String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, ch => `\\${ch}`);
    }
});

const SETTINGS = {
    enabled: true,
    autoGenerate: true,
    currentPresetId: 'p',
    presets: [{ id: 'p', illustrationPrompt: 'TASK', llm: { apiPresetName: '', llmPresetName: '' } }],
    contextMessageCount: 0,
    maxConcurrentGenerations: 1,
    minGenerationInterval: 0,
    imageDisplayWidth: 100,
};

function makeMessage(extra = {}) {
    return {
        name: 'Seraphina',
        is_user: false,
        is_system: false,
        mes: 'alpha <img src="/user/images/old.png" data-illustration-id="old"> beta',
        send_date: 1,
        original_avatar: 'a.png',
        swipe_id: 0,
        swipes: ['alpha <img src="/user/images/old.png" data-illustration-id="old"> beta'],
        swipe_info: [{ extra: {} }],
        ...extra,
    };
}

function makeHarness({ message, generate, confirmReplace, activityJob, generateTaskResult, notifyError } = {}) {
    const chat = [message];
    const toasts = [];
    const errors = [];
    const calls = {
        generateTask: 0,
        taskArgs: [],
        generateOptions: [],
        confirmReplace: 0,
        activityJobs: [],
        messageChanges: [],
    };
    const pipeline = createIllustrationPipeline({
        context: {
            chat,
            chatId: 'chat-1',
            generateTask: async taskArgs => {
                calls.generateTask += 1;
                calls.taskArgs.push(taskArgs);
                return generateTaskResult ?? {
                    toolCalls: [{
                        name: 'add_image_prompt',
                        args: {
                            prompt: 'new prompt',
                            insert_after: 'alpha',
                            insert_before: 'beta',
                            loras: [{ name: 'a.safetensors', weight: 0.8 }],
                        },
                    }],
                };
            },
        },
        imageService: {
            configure() {},
            getAvailableLoras: async () => ({ names: ['a.safetensors'], includeWeight: true }),
            generate: async (prompt, options) => {
                calls.generateOptions.push(options);
                return generate(prompt, options);
            },
        },
        settings: SETTINGS,
        hooks: {
            toast: text => toasts.push(text),
            notifyError: message => {
                errors.push(String(message));
                if (typeof notifyError === 'function') {
                    notifyError(message);
                }
            },
            t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (values[index] ?? ''), ''),
            saveChat: async () => {},
            updateMessageBlock: () => {},
            ensureSwipes: () => {},
            getChatId: () => 'chat-1',
            getChat: () => chat,
            notifyMessageChanged: messageId => calls.messageChanges.push(messageId),
            beginActivityJob: activityJob
                ? options => {
                    calls.activityJobs.push(options);
                    return activityJob;
                }
                : undefined,
            confirmReplace: confirmReplace
                ? async () => {
                    calls.confirmReplace += 1;
                    return confirmReplace();
                }
                : undefined,
        },
    });
    return { pipeline, chat, toasts, errors, calls };
}

function makeFakeActivityJob() {
    const calls = { sections: [], updates: [], errors: [], finished: [] };
    return {
        calls,
        addSection(key, { kind, title, body = '', meta = null } = {}) {
            calls.sections.push({ key, kind, title, body, meta });
            return key;
        },
        updateSection(key, { status, meta } = {}) {
            calls.updates.push({ key, status, meta });
        },
        setError(message) {
            calls.errors.push(message);
        },
        setRetry() {},
        finish(status) {
            calls.finished.push(status);
        },
    };
}

test('message fingerprint changes with text and send date', () => {
    const base = { send_date: 1, original_avatar: 'a.png', mes: 'hello' };
    expect(messageFingerprint(base)).toBe(messageFingerprint({ ...base }));
    expect(messageFingerprint(base)).not.toBe(messageFingerprint({ ...base, mes: 'hello!' }));
    expect(messageFingerprint(base)).not.toBe(messageFingerprint({ ...base, send_date: 2 }));
});

test('finds the last assistant message and skips user/system', () => {
    const chat = [
        { mes: 'user', is_user: true },
        { mes: 'assistant', name: 'A' },
        { mes: 'system', is_system: true },
    ];
    expect(getLastAssistantMessage(chat)).toEqual({ message: chat[1], index: 1 });
    expect(getLastAssistantMessage([{ mes: 'user', is_user: true }])).toBeNull();
});

test('builds stable job keys', () => {
    expect(buildJobKey({ chatId: 'c', messageId: 2, swipeId: 1 })).toBe('c:2:1');
});

test('manual run confirms, then replaces existing illustrations', async () => {
    const message = makeMessage({
        extra: {
            illustrations: [{
                id: 'old', prompt: 'old', imageUrl: '/user/images/old.png', status: 'ready',
                parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
            }],
        },
    });
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
        confirmReplace: () => true,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.confirmReplace).toBe(1);
    expect(message.mes).not.toContain('data-illustration-id="old"');
    expect(message.mes).toContain('/user/images/new.png');
    expect(message.extra.illustrations).toHaveLength(1);
    expect(message.extra.illustrations[0].prompt).toBe('new prompt');
    expect(message.swipes[0]).toBe(message.mes);
    expect(calls.messageChanges).toEqual([0, 0]);
});

test('manual run leaves everything untouched when the replace prompt is declined', async () => {
    const message = makeMessage({
        extra: {
            illustrations: [{
                id: 'old', prompt: 'old', imageUrl: '/user/images/old.png', status: 'ready',
                parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
            }],
        },
    });
    const before = { mes: message.mes, records: message.extra.illustrations };
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
        confirmReplace: () => false,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.confirmReplace).toBe(1);
    expect(calls.generateTask).toBe(0);
    expect(message.mes).toBe(before.mes);
    expect(message.extra.illustrations).toBe(before.records);
});

test('illustration jobs open activity rounds before the prompt request and report prompts plus images', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const activityJob = makeFakeActivityJob();
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
        activityJob,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.activityJobs).toHaveLength(1);
    expect(calls.activityJobs[0]).toMatchObject({ kind: 'illustration', messageIndex: 0 });
    expect(typeof calls.activityJobs[0].abort).toBe('function');
    expect(activityJob.calls.sections).toEqual([
        { key: 'prompt-0', kind: 'prompt', title: 'Prompt 1', body: 'new prompt', meta: null },
        { key: 'image-0', kind: 'image', title: 'Image 1', body: '', meta: null },
    ]);
    expect(activityJob.calls.updates).toEqual([
        { key: 'prompt-0', status: 'done', meta: undefined },
        { key: 'image-0', status: 'done', meta: { imageUrl: '/user/images/new.png' } },
    ]);
    expect(activityJob.calls.finished).toEqual(['done']);
    expect(calls.messageChanges).toEqual([0]);
});

test('failed illustration images keep the round open with an error section', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const activityJob = makeFakeActivityJob();
    const { pipeline, errors } = makeHarness({
        message,
        generate: async () => { throw new Error('upstream refused'); },
        activityJob,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(activityJob.calls.updates).toEqual([
        { key: 'prompt-0', status: 'done', meta: undefined },
        { key: 'image-0', status: 'failed', meta: undefined },
        { key: 'error-0', status: 'failed', meta: undefined },
    ]);
    expect(activityJob.calls.sections).toContainEqual({
        key: 'error-0', kind: 'error', title: 'Error 1', body: 'upstream refused', meta: null,
    });
    expect(activityJob.calls.finished).toEqual(['failed']);
    expect(errors).toEqual(['Image generation failed for 1 prompt(s). upstream refused']);
});

test('rejected prompts fail the round and surface the rejection reason', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const activityJob = makeFakeActivityJob();
    const { pipeline, calls, errors } = makeHarness({
        message,
        generate: async () => {
            throw new Error('image generation must not run');
        },
        activityJob,
        generateTaskResult: {
            toolCalls: [{
                name: 'add_image_prompt',
                args: { prompt: 'new prompt', insert_after: 'missing-after', insert_before: 'missing-before' },
            }],
            assistantText: '',
            finishReason: 'stop',
        },
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.generateTask).toBe(1);
    expect(message.mes).toBe('alpha beta');
    expect(activityJob.calls.sections).toEqual([]);
    expect(activityJob.calls.finished).toEqual(['failed']);
    expect(activityJob.calls.errors).toHaveLength(1);
    expect(activityJob.calls.errors[0]).toContain('No image prompts could be used: quoted text not found ×1.');
    expect(activityJob.calls.errors[0]).toContain('Rejected calls:');
    expect(activityJob.calls.errors[0]).toContain('new prompt');
    expect(errors).toEqual([
        'Illustration failed: No image prompts could be used: quoted text not found ×1.',
    ]);
});

test('a text-only model reply fails the round instead of finishing quietly', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const activityJob = makeFakeActivityJob();
    const { pipeline, errors } = makeHarness({
        message,
        generate: async () => {
            throw new Error('image generation must not run');
        },
        activityJob,
        generateTaskResult: {
            toolCalls: [],
            assistantText: 'I cannot illustrate this.',
            finishReason: 'stop',
        },
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(activityJob.calls.finished).toEqual(['failed']);
    expect(activityJob.calls.errors[0]).toContain('The model replied with text but did not call add_image_prompt.');
    expect(errors).toEqual([
        'Illustration failed: The model replied with text but did not call add_image_prompt.',
    ]);
});

test('the prompt tool offers the LoRA catalog state reported by the image service', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.taskArgs).toHaveLength(1);
    const [tool] = calls.taskArgs[0].tools;
    expect(tool.function.name).toBe('add_image_prompt');
    const loras = tool.function.parameters.properties.loras;
    expect(loras.items.properties.name.enum).toEqual(['a.safetensors']);
    expect(loras.items.properties).toHaveProperty('weight');
});

test('the LoRA selection reaches image generation and the stored record', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.generateOptions).toEqual([{
        characterName: 'Seraphina',
        signal: expect.anything(),
        loras: [{ name: 'a.safetensors', weight: 0.8 }],
    }]);
    expect(message.extra.illustrations[0].loras).toEqual([{ name: 'a.safetensors', weight: 0.8 }]);
});

test('a failed image keeps the LoRA selection on its record', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const { pipeline } = makeHarness({
        message,
        generate: async () => {
            throw new Error('upstream refused');
        },
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(message.extra.illustrations).toBeUndefined();
    expect(getFailedIllustrationRecords(message)[0]).toMatchObject({
        status: 'failed',
        loras: [{ name: 'a.safetensors', weight: 0.8 }],
    });
});

test('a prompt naming an unavailable LoRA fails the round with the helper message', async () => {
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const activityJob = makeFakeActivityJob();
    const { pipeline, errors } = makeHarness({
        message,
        generate: async () => {
            throw new Error('image generation must not run');
        },
        activityJob,
        generateTaskResult: {
            toolCalls: [{
                name: 'add_image_prompt',
                args: {
                    prompt: 'new prompt',
                    insert_after: 'alpha',
                    insert_before: 'beta',
                    loras: [{ name: 'b.safetensors' }],
                },
            }],
        },
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(activityJob.calls.finished).toEqual(['failed']);
    expect(errors).toEqual([
        'Illustration failed: No image prompts could be used: unknown LoRA \'b.safetensors\' ×1.',
    ]);
});

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitForUiFlush() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 90));
}

test('marks completed images and failures in run panel, dock, and workbench run view while remaining images are still generating', async () => {
    const message = makeMessage({
        mes: 'alpha beta gamma delta',
        swipes: ['alpha beta gamma delta'],
    });
    const deferreds = [createDeferred(), createDeferred(), createDeferred()];
    let startedCount = 0;

    const activity = createImageActivity({ translate: text => String(text), getChatKey: () => 'chat-1' });
    const recorder = createRecorder({ storage: createMemoryStorage() });
    recorder.attach(activity.store, 'sd');
    const dock = createDock({ recorder });
    const runView = createRunView({
        getContext: () => ({ runPanel: { getRunRecorder: () => recorder } }),
    });
    document.body.appendChild(runView.el);
    runView.show();

    try {
        const chat = [message];
        const pipeline = createIllustrationPipeline({
            context: {
                chat,
                chatId: 'chat-1',
                generateTask: async () => ({
                    toolCalls: [
                        { name: 'add_image_prompt', args: { prompt: 'first scene', insert_after: 'alpha', insert_before: 'beta' } },
                        { name: 'add_image_prompt', args: { prompt: 'second scene', insert_after: 'beta', insert_before: 'gamma' } },
                        { name: 'add_image_prompt', args: { prompt: 'third scene', insert_after: 'gamma', insert_before: 'delta' } },
                    ],
                }),
            },
            imageService: {
                configure() {},
                getAvailableLoras: async () => ({ names: [], includeWeight: false }),
                generate: (_prompt, options) => {
                    const idx = startedCount;
                    startedCount += 1;
                    options?.signal?.addEventListener('abort', () => {
                        const err = new Error('Aborted');
                        err.name = 'AbortError';
                        deferreds[idx].reject(err);
                    }, { once: true });
                    return deferreds[idx].promise;
                },
            },
            settings: SETTINGS,
            hooks: {
                toast: () => {},
                notifyError: () => {},
                t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat-1',
                getChat: () => chat,
                notifyMessageChanged: () => {},
                beginActivityJob: options => activity.beginJob(options),
            },
        });

        const runPromise = pipeline.runForMessage({ messageId: 0, source: 'manual' });
        await waitForUiFlush();
        expect(startedCount).toBe(3);

        activity.openPanel();
        dock.open();
        document.querySelector('.rp-dock-agent-head')?.click();

        // Prompt sections are already complete while all 3 images are still generating
        const initialRound = activity.store.getCurrentRun().rounds[0];
        expect(initialRound.sections.filter(s => s.kind === 'prompt').map(s => s.status)).toEqual(['done', 'done', 'done']);
        expect(initialRound.sections.filter(s => s.kind === 'image').map(s => s.status)).toEqual(['running', 'running', 'running']);

        // Complete ONLY the first image while #2 and #3 remain in flight
        deferreds[0].resolve('/user/images/scene-1.png');
        await waitForUiFlush();

        const midRound = activity.store.getCurrentRun().rounds[0];
        expect(activity.store.getCurrentRun().status).toBe('running');
        expect(midRound.status).toBe('running');
        expect(midRound.sections.find(s => s.id.endsWith('-image-0'))).toMatchObject({
            status: 'done',
            meta: { imageUrl: '/user/images/scene-1.png' },
        });
        expect(midRound.sections.find(s => s.id.endsWith('-image-1'))).toMatchObject({
            status: 'running',
            meta: null,
        });

        // 1) SD Run Panel (#luker-sd-run-panel) already displays scene-1.png while image-1 stays running
        const sdImg0 = document.querySelector('#luker-sd-run-panel [data-section-id="image-job-1-image-0"]');
        const sdImg1 = document.querySelector('#luker-sd-run-panel [data-section-id="image-job-1-image-1"]');
        expect(sdImg0?.dataset.status).toBe('done');
        expect(sdImg0?.querySelector('img.section-image')?.getAttribute('src')).toBe('/user/images/scene-1.png');
        expect(sdImg1?.dataset.status).toBe('running');
        expect(sdImg1?.querySelector('img.section-image')).toBeNull();

        // 2) Workbench Run Traces view already displays scene-1.png while Image 2 stays running
        expect(runView.el.querySelector('img[src="/user/images/scene-1.png"]')).not.toBeNull();
        expect(runView.el.textContent).toContain('Image 1 · Complete');
        expect(runView.el.textContent).toContain('Image 2 · Running');

        // 3) Shared Floating Run Dock (.rp-dock) already displays scene-1.png while Image 2 stays running
        expect(document.querySelector('.rp-dock img.rp-step-image[src="/user/images/scene-1.png"]')).not.toBeNull();

        // Fail the second image while #3 is still generating
        deferreds[1].reject(new Error('backend busy'));
        await waitForUiFlush();

        const afterFailRound = activity.store.getCurrentRun().rounds[0];
        expect(afterFailRound.sections.find(s => s.id.endsWith('-image-1'))?.status).toBe('failed');
        expect(afterFailRound.sections.find(s => s.id.endsWith('-error-1'))).toMatchObject({
            status: 'failed',
            body: 'backend busy',
        });
        expect(afterFailRound.sections.find(s => s.id.endsWith('-image-2'))?.status).toBe('running');
        expect(runView.el.textContent).toContain('backend busy');

        // Finish the third image
        deferreds[2].resolve('/user/images/scene-3.png');
        await runPromise;
        await waitForUiFlush();

        expect(runView.el.querySelector('img[src="/user/images/scene-1.png"]')).not.toBeNull();
        expect(runView.el.querySelector('img[src="/user/images/scene-3.png"]')).not.toBeNull();
        expect(message.extra.illustrations.map(r => r.status)).toEqual(['ready', 'ready']);
        expect(getFailedIllustrationRecords(message).map(r => r.status)).toEqual(['failed']);
    } finally {
        runView.destroy();
        runView.el.remove();
        dock.destroy();
        recorder.detach();
        activity.destroy();
    }
});

test('preserves already-generated partial images in run trace when aborted mid-batch', async () => {
    const message = makeMessage({
        mes: 'alpha beta gamma',
        swipes: ['alpha beta gamma'],
    });
    const deferreds = [createDeferred(), createDeferred()];
    let startedCount = 0;

    const activity = createImageActivity({ translate: text => String(text), getChatKey: () => 'chat-1' });
    const recorder = createRecorder({ storage: createMemoryStorage() });
    recorder.attach(activity.store, 'sd');

    try {
        const chat = [message];
        const pipeline = createIllustrationPipeline({
            context: {
                chat,
                chatId: 'chat-1',
                generateTask: async () => ({
                    toolCalls: [
                        { name: 'add_image_prompt', args: { prompt: 'first scene', insert_after: 'alpha', insert_before: 'beta' } },
                        { name: 'add_image_prompt', args: { prompt: 'second scene', insert_after: 'beta', insert_before: 'gamma' } },
                    ],
                }),
            },
            imageService: {
                configure() {},
                getAvailableLoras: async () => ({ names: [], includeWeight: false }),
                generate: (_prompt, options) => {
                    const idx = startedCount;
                    startedCount += 1;
                    options?.signal?.addEventListener('abort', () => {
                        const err = new Error('Aborted');
                        err.name = 'AbortError';
                        deferreds[idx].reject(err);
                    }, { once: true });
                    return deferreds[idx].promise;
                },
            },
            settings: SETTINGS,
            hooks: {
                toast: () => {},
                notifyError: () => {},
                t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat-1',
                getChat: () => chat,
                notifyMessageChanged: () => {},
                beginActivityJob: options => activity.beginJob(options),
            },
        });

        const runPromise = pipeline.runForMessage({ messageId: 0, source: 'manual' });
        await waitForUiFlush();

        deferreds[0].resolve('/user/images/kept.png');
        await waitForUiFlush();

        pipeline.cancelForMessage(0);
        await runPromise;
        await waitForUiFlush();

        const archived = recorder.history()[0];
        expect(archived).toBeDefined();
        expect(archived.status).toBe('aborted');
        const sections = archived.rounds[0].sections;
        expect(sections.find(s => s.id.endsWith('-image-0'))).toMatchObject({
            status: 'done',
            meta: { imageUrl: '/user/images/kept.png' },
        });
        expect(sections.find(s => s.id.endsWith('-image-1'))).toMatchObject({
            status: 'aborted',
            meta: null,
        });
    } finally {
        recorder.detach();
        activity.destroy();
    }
});

test('keepsFormalPipelineSideEffects: chat switch aborts before mutating chat or saving', async () => {
    let activeChatId = 'chat-1';
    const message = makeMessage({ mes: 'alpha beta', swipes: ['alpha beta'] });
    const chat = [message];
    let savedCount = 0;
    let updatedBlocks = 0;
    const activityJob = makeFakeActivityJob();
    const pipeline = createIllustrationPipeline({
        context: {
            chat,
            chatId: 'chat-1',
            generateTask: async () => {
                // Switch chat while model request is in flight.
                activeChatId = 'chat-2';
                return {
                    toolCalls: [{
                        name: 'add_image_prompt',
                        args: { prompt: 'new prompt', insert_after: 'alpha', insert_before: 'beta' },
                    }],
                };
            },
        },
        imageService: {
            configure() {},
            getAvailableLoras: async () => ({ names: [], includeWeight: false }),
            generate: async () => {
                throw new Error('must not generate image after chat switch');
            },
        },
        settings: SETTINGS,
        hooks: {
            toast: () => {},
            notifyError: err => { throw new Error(`Unexpected error on abort: ${err}`); },
            t: (strings, ...values) => strings.reduce((out, str, index) => out + str + (values[index] ?? ''), ''),
            saveChat: async () => { savedCount += 1; },
            updateMessageBlock: () => { updatedBlocks += 1; },
            ensureSwipes: () => {},
            getChatId: () => activeChatId,
            getChat: () => chat,
            beginActivityJob: () => activityJob,
        },
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(savedCount).toBe(0);
    expect(updatedBlocks).toBe(0);
    expect(message.mes).toBe('alpha beta');
    expect(activityJob.calls.finished).toEqual(['aborted']);
});
