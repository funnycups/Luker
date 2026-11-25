/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
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

let registry;
let activeGuardApi = null;
let currentChat = [];
const eventHandlers = new Map();
const slashCommands = new Map();
let multimodalImpl = async () => 'A scenic sunset.';
let extensionSettingsMock;

beforeAll(async () => {
    const noop = () => {};
    extensionSettingsMock = {
        caption: {
            source: 'multimodal',
            multimodal_api: 'openai',
            multimodal_model: 'gpt-5.6-luna',
            prompt: 'Describe',
            template: '[{{caption}}]',
            auto_mode: true,
            refine_mode: false,
            prompt_ask: false,
        },
    };

    const jqChain = { length: 0 };
    for (const method of ['on', 'off', 'one', 'val', 'text', 'html', 'attr', 'prop', 'css', 'addClass', 'removeClass', 'toggleClass', 'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'find', 'closest', 'children', 'parent', 'filter', 'first', 'last', 'eq', 'each', 'trigger', 'focus', 'blur', 'click', 'data']) {
        jqChain[method] = () => jqChain;
    }
    jqChain.is = () => false;
    jqChain.hasClass = () => false;
    globalThis.jQuery = Object.assign((selector) => {
        if (selector === '#form_sheld') {
            return {
                append: (node) => {
                    if (node instanceof Element) {
                        document.body.appendChild(node);
                    }
                    return jqChain;
                },
            };
        }
        return jqChain;
    }, { __chain: jqChain });
    globalThis.$ = globalThis.jQuery;
    globalThis.toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        clear: jest.fn(),
    };

    const eventSourceMock = {
        on: (evt, fn) => {
            if (!eventHandlers.has(evt)) eventHandlers.set(evt, []);
            eventHandlers.get(evt).push(fn);
        },
        emit: async () => {},
    };

    const contextMock = {
        name1: 'User',
        name2: 'Char',
        get chat() {
            return currentChat;
        },
        addOneMessage: noop,
        saveChat: async () => {},
        scrollOnMediaLoad: noop,
        get activityGuard() {
            return activeGuardApi;
        },
    };

    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        ensureImageFormatSupported: async (f) => f,
        getBase64Async: async () => 'data:image/png;base64,AAAA',
        getFileExtension: () => 'png',
        isTrueBoolean: (v) => v === true || v === 'true',
        saveBase64AsFile: async () => '/user/images/out.png',
    }));

    jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettingsMock,
        getContext: () => contextMock,
        renderExtensionTemplateAsync: async () => '',
    }));

    jest.unstable_mockModule('../../public/script.js', () => ({
        appendMediaToMessage: noop,
        chat_metadata: {},
        eventSource: eventSourceMock,
        event_types: {
            MESSAGE_SENT: 'message_sent',
            MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
        },
        getRequestHeaders: () => ({}),
        saveChatConditional: async () => {},
        saveSettingsDebounced: noop,
        substituteParams: (str, opts) => String(str ?? '').replace(/\{\{caption\}\}/gi, opts?.dynamicMacros?.caption ?? ''),
    }));

    jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
        getMessageTimeStamp: () => 'now',
    }));

    jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
        SECRET_KEYS: {},
        secret_state: {},
    }));

    jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
        oai_settings: {},
        POLLINATIONS_ENDPOINT: {},
    }));

    jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
        getMultimodalCaption: (...args) => multimodalImpl(...args),
    }));

    jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
        textgen_types: {},
        textgenerationwebui_settings: { server_urls: {} },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: {
            addCommandObject: (cmd) => {
                slashCommands.set(cmd.name, cmd);
            },
        },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
        SlashCommand: { fromProps: (x) => x },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: class {},
        SlashCommandNamedArgument: Object.assign(class {}, { fromProps: (x) => x }),
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
        commonEnumProviders: {
            messages: () => () => [],
            messageMedia: () => () => [],
        },
    }));

    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        callGenericPopup: async () => 'Prompt',
        Popup: { show: { input: async ( _a, _b, val) => val } },
        POPUP_TYPE: { INPUT: 3 },
    }));

    jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
        debounce_timeout: { short: 0 },
        MEDIA_DISPLAY: { GALLERY: 'gallery' },
        MEDIA_SOURCE: { UPLOAD: 'upload', CAPTIONED: 'captioned' },
        MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', getFromMime: () => 'image' },
        SCROLL_BEHAVIOR: { KEEP: 'keep' },
    }));

    jest.unstable_mockModule('../../public/scripts/lib/prompt-values.js', () => ({
        initializePromptDefaults: () => false,
        requireStoredPrompt: (v) => v,
    }));

    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
    }));

    const captionMod = await import('../../public/scripts/extensions/caption/index.js');
    await captionMod.init();
});

beforeEach(() => {
    registry = createActivityGuardRegistry();
    activeGuardApi = makeActivityGuardApi(registry);
    currentChat = [];
    globalThis.fetch = jest.fn(async () => ({
        blob: async () => new Blob(['img'], { type: 'image/png' }),
    }));
});

afterEach(() => {
    const leftover = registry.getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('Caption extension activity guard leases', () => {
    test('captionExistingMessage (MESSAGE_SENT auto-caption) acquires single caption:run chat lease and releases', async () => {
        const captionStarted = deferred();
        const captionGate = deferred();
        multimodalImpl = jest.fn(() => {
            captionStarted.resolve();
            return captionGate.promise;
        });

        currentChat = [{
            mes: '',
            extra: {
                media: [{ url: '/user/images/pic.png', type: 'image', source: 'upload', captioned: false }],
            },
        }];

        const handlers = eventHandlers.get('message_sent') || [];
        expect(handlers.length).toBeGreaterThan(0);

        const runPromise = handlers[0](0);
        await captionStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: 'Image captioning',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        captionGate.resolve('A sunlit garden.');
        await runPromise;

        expect(currentChat[0].mes).toBe('[A sunlit garden.]');
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('captionCommandCallback acquires caption:run only during active mesId/onchange captioning and never while file picker waits', async () => {
        const cmd = slashCommands.get('caption');
        expect(cmd).toBeDefined();

        // Invalid mesId attachment must not acquire a lease.
        currentChat = [{ mes: 'no url', extra: { media: [{ type: 'audio', url: '/a.mp3' }] } }];
        await expect(cmd.callback({ mesId: 0, quiet: 'true' }, 'Describe')).resolves.toBe('');
        expect(registry.getActiveActivities()).toEqual([]);

        const captionStarted = deferred();
        const captionGate = deferred();
        multimodalImpl = jest.fn(() => {
            captionStarted.resolve();
            return captionGate.promise;
        });

        currentChat = [{
            mes: 'hi',
            extra: {
                media: [{ url: '/user/images/msg.png', type: 'image', source: 'upload' }],
            },
        }];

        const cmdPromise = cmd.callback({ mesId: 0, quiet: 'true' }, 'Describe');
        await captionStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: 'Image captioning',
                scope: 'chat',
            }),
        ]);

        captionGate.resolve('Mountain peak.');
        const caption = await cmdPromise;
        expect(caption).toBe('Mountain peak.');
        expect(registry.getActiveActivities()).toEqual([]);

        // File picker open/cancel holds ZERO leases (even if oncancel never fires).
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
            const pickerCancelPromise = cmd.callback({ quiet: 'true' }, '');
            expect(createdInput).not.toBeNull();
            expect(activeWhilePickerOpen).toEqual([]);
            expect(registry.getActiveActivities()).toEqual([]);
            createdInput.oncancel();
            await expect(pickerCancelPromise).resolves.toBe('');
            expect(registry.getActiveActivities()).toEqual([]);

            // File picker onchange acquires caption:run during captioning and releases on completion.
            const pickerStarted = deferred();
            const pickerGate = deferred();
            multimodalImpl = jest.fn(() => {
                pickerStarted.resolve();
                return pickerGate.promise;
            });

            const pickerChangePromise = cmd.callback({ quiet: 'true' }, 'Describe');
            expect(registry.getActiveActivities()).toEqual([]);

            const file = new File(['img-bytes'], 'picked.png', { type: 'image/png' });
            Object.defineProperty(createdInput, 'files', {
                value: [file],
                configurable: true,
            });
            createdInput.onchange({ target: createdInput });

            await pickerStarted.promise;
            expect(registry.getActiveActivities()).toEqual([
                expect.objectContaining({
                    source: 'caption:run',
                    label: 'Image captioning',
                    scope: 'chat',
                }),
            ]);

            pickerGate.resolve('Picked sunset.');
            await expect(pickerChangePromise).resolves.toBe('Picked sunset.');
            expect(registry.getActiveActivities()).toEqual([]);

            // Error inside onchange still settles promise and releases lease cleanly.
            const errStarted = deferred();
            const errGate = deferred();
            multimodalImpl = jest.fn(() => {
                errStarted.resolve();
                return errGate.promise;
            });
            const pickerErrPromise = cmd.callback({ quiet: 'true' }, 'Describe');
            Object.defineProperty(createdInput, 'files', {
                value: [file],
                configurable: true,
            });
            createdInput.onchange({ target: createdInput });
            await errStarted.promise;
            expect(registry.getActiveActivities()).toHaveLength(1);

            errGate.reject(new Error('caption boom'));
            await expect(pickerErrPromise).resolves.toBe('');
            expect(registry.getActiveActivities()).toEqual([]);

            // Unexpected throw directly inside onSelectImage still settles resolve('') and releases lease.
            const throwErrPromise = cmd.callback({ quiet: 'true' }, 'Describe');
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

    test('wand-menu #img_file change acquires caption:run chat lease and releases on completion and error', async () => {
        const imgInput = document.getElementById('img_file');
        expect(imgInput).not.toBeNull();

        const file = new File(['img-bytes'], 'photo.png', { type: 'image/png' });
        Object.defineProperty(imgInput, 'files', {
            value: [file],
            configurable: true,
        });

        const captionStarted = deferred();
        const captionGate = deferred();
        multimodalImpl = jest.fn(() => {
            captionStarted.resolve();
            return captionGate.promise;
        });

        imgInput.dispatchEvent(new Event('change'));
        await captionStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'caption:run',
                label: 'Image captioning',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        const completed = deferred();
        const unsub = registry.subscribeActivityGuard(() => {
            if (registry.getActiveActivities().length === 0) {
                unsub();
                completed.resolve();
            }
        });

        captionGate.resolve('Harbor at dawn.');
        await completed.promise;

        expect(currentChat).toHaveLength(1);
        expect(currentChat[0].mes).toBe('[Harbor at dawn.]');
        expect(registry.getActiveActivities()).toEqual([]);

        // Error path also releases the lease cleanly
        const errStarted = deferred();
        const errGate = deferred();
        multimodalImpl = jest.fn(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        imgInput.dispatchEvent(new Event('change'));
        await errStarted.promise;
        expect(registry.getActiveActivities()).toHaveLength(1);

        const errCompleted = deferred();
        const unsubErr = registry.subscribeActivityGuard(() => {
            if (registry.getActiveActivities().length === 0) {
                unsubErr();
                errCompleted.resolve();
            }
        });

        errGate.reject(new Error('caption service down'));
        await errCompleted.promise;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('tolerates null activityGuard without crashing', async () => {
        activeGuardApi = null;
        multimodalImpl = jest.fn(async () => 'Plain caption');
        currentChat = [{
            mes: '',
            extra: { media: [{ url: '/user/images/p2.png', type: 'image', source: 'upload', captioned: false }] },
        }];
        await eventHandlers.get('message_sent')[0](0);
        expect(currentChat[0].mes).toBe('[Plain caption]');
    });
});
