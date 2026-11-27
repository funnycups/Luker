/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createCaptionController } from '../../public/scripts/extensions/caption/caption-controller.js';

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

describe('Caption controller activity guard leases', () => {
    let registry;
    let activeGuardApi;
    let currentChat;
    let doCaptionRequestImpl;
    let controller;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        activeGuardApi = makeActivityGuardApi(registry);
        currentChat = [];
        doCaptionRequestImpl = async () => ({ caption: 'A scenic sunset.' });

        const context = {
            name1: 'User',
            name2: 'Char',
            get chat() {
                return currentChat;
            },
            get activityGuard() {
                return activeGuardApi;
            },
        };

        controller = createCaptionController({
            getSettings: () => ({ source: 'multimodal', template: '[{{caption}}]' }),
            getContext: () => context,
            isTrueBoolean: (v) => v === true || v === 'true',
            ensureImageFormatSupported: async (f) => f,
            getBase64Async: async () => 'data:image/png;base64,AAAA',
            getFileExtension: () => 'png',
            saveBase64AsFile: async () => '/user/images/out.png',
            isVideoCaptioningAvailable: () => false,
            doCaptionRequest: (...args) => doCaptionRequestImpl(...args),
            wrapCaptionTemplate: async (caption) => `[${caption}]`,
            sendCaptionedMessage: async () => {},
            setSpinnerIcon: () => {},
            setImageIcon: () => {},
            MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
            t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
            getDocument: () => document,
            getToastr: () => ({ error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() }),
            fetchImpl: async () => ({ blob: async () => new Blob(['img'], { type: 'image/png' }) }),
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('captionExistingMessage acquires single caption:run chat lease and releases', async () => {
        const captionStarted = deferred();
        const captionGate = deferred();
        doCaptionRequestImpl = jest.fn(() => {
            captionStarted.resolve();
            return captionGate.promise;
        });

        const message = {
            mes: '',
            extra: {
                media: [{ url: '/user/images/pic.png', type: 'image', source: 'upload', captioned: false }],
            },
        };

        const runPromise = controller.captionExistingMessage(message, 0);
        await captionStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        captionGate.resolve({ caption: 'A sunlit garden.' });
        await runPromise;

        expect(message.mes).toBe('[A sunlit garden.]');
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('captionCommandCallback acquires caption:run only during active mesId/onchange captioning and never while file picker waits', async () => {
        currentChat = [{ mes: 'no url', extra: { media: [{ type: 'audio', url: '/a.mp3' }] } }];
        await expect(controller.captionCommandCallback({ mesId: 0, quiet: 'true' }, 'Describe')).resolves.toBe('');
        expect(registry.getActiveActivities()).toEqual([]);

        const captionStarted = deferred();
        const captionGate = deferred();
        doCaptionRequestImpl = jest.fn(() => {
            captionStarted.resolve();
            return captionGate.promise;
        });

        currentChat = [{
            mes: 'hi',
            extra: {
                media: [{ url: '/user/images/msg.png', type: 'image', source: 'upload' }],
            },
        }];

        const cmdPromise = controller.captionCommandCallback({ mesId: 0, quiet: 'true' }, 'Describe');
        await captionStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
            }),
        ]);

        captionGate.resolve({ caption: 'Mountain peak.' });
        await expect(cmdPromise).resolves.toBe('Mountain peak.');
        expect(registry.getActiveActivities()).toEqual([]);

        const origCreateElement = document.createElement.bind(document);
        let createdInput = null;
        let activeWhilePickerOpen = null;
        const createSpy = jest.spyOn(document, 'createElement').mockImplementation((tag) => {
            const el = origCreateElement(tag);
            if (tag === 'input') {
                createdInput = el;
                el.click = () => {
                    activeWhilePickerOpen = registry.getActiveActivities();
                };
            }
            return el;
        });

        try {
            const pickerCancelPromise = controller.captionCommandCallback({ quiet: 'true' }, '');
            expect(createdInput).not.toBeNull();
            expect(activeWhilePickerOpen).toEqual([]);
            expect(registry.getActiveActivities()).toEqual([]);
            createdInput.oncancel();
            await expect(pickerCancelPromise).resolves.toBe('');
            expect(registry.getActiveActivities()).toEqual([]);

            const pickerStarted = deferred();
            const pickerGate = deferred();
            doCaptionRequestImpl = jest.fn(() => {
                pickerStarted.resolve();
                return pickerGate.promise;
            });

            const pickerChangePromise = controller.captionCommandCallback({ quiet: 'true' }, 'Describe');
            expect(registry.getActiveActivities()).toEqual([]);

            const file = new File(['img-bytes'], 'picked.png', { type: 'image/png' });
            Object.defineProperty(createdInput, 'files', { value: [file], configurable: true });
            createdInput.onchange({ target: createdInput });

            await pickerStarted.promise;
            expect(registry.getActiveActivities()).toEqual([
                expect.objectContaining({
                    source: 'caption:run',
                    label: expect.stringMatching(/\S/),
                    scope: 'chat',
                }),
            ]);

            pickerGate.resolve({ caption: 'Picked sunset.' });
            await expect(pickerChangePromise).resolves.toBe('Picked sunset.');
            expect(registry.getActiveActivities()).toEqual([]);

            const errStarted = deferred();
            const errGate = deferred();
            doCaptionRequestImpl = jest.fn(() => {
                errStarted.resolve();
                return errGate.promise;
            });
            const pickerErrPromise = controller.captionCommandCallback({ quiet: 'true' }, 'Describe');
            Object.defineProperty(createdInput, 'files', { value: [file], configurable: true });
            createdInput.onchange({ target: createdInput });
            await errStarted.promise;
            expect(registry.getActiveActivities()).toHaveLength(1);

            errGate.reject(new Error('caption boom'));
            await expect(pickerErrPromise).resolves.toBe('');
            expect(registry.getActiveActivities()).toEqual([]);

            const throwErrPromise = controller.captionCommandCallback({ quiet: 'true' }, 'Describe');
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            try {
                createdInput.onchange(null);
                await expect(throwErrPromise).resolves.toBe('');
                expect(registry.getActiveActivities()).toEqual([]);
                expect(errSpy).toHaveBeenCalledTimes(1);
            } finally {
                errSpy.mockRestore();
            }
        } finally {
            createSpy.mockRestore();
        }
    });

    test('wand-menu file change handler acquires caption:run chat lease and releases on completion and error', async () => {
        const imgInput = document.createElement('input');
        imgInput.type = 'file';
        const file = new File(['img-bytes'], 'photo.png', { type: 'image/png' });
        Object.defineProperty(imgInput, 'files', { value: [file], configurable: true });

        const started = deferred();
        const gate = deferred();
        doCaptionRequestImpl = jest.fn(() => {
            started.resolve();
            return gate.promise;
        });

        const promise = controller.handleWandFileChange({ target: imgInput });
        await started.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
            }),
        ]);

        gate.resolve({ caption: 'Wand photo.' });
        await expect(promise).resolves.toBe('Wand photo.');
        expect(registry.getActiveActivities()).toEqual([]);

        activeGuardApi = null;
        doCaptionRequestImpl = jest.fn(async () => ({ caption: 'No guard ok.' }));
        await expect(controller.handleWandFileChange({ target: imgInput })).resolves.toBe('No guard ok.');
    });
});
