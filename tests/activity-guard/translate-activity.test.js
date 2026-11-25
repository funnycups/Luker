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
let extensionSettingsMock;
const eventHandlers = new Map();
const saveChatMock = jest.fn(async () => {});
const updateMessageBlockMock = jest.fn();
const updateReasoningUIMock = jest.fn();
let textareaValue = '';

beforeAll(async () => {
    const noop = () => {};
    extensionSettingsMock = {
        translate: {
            target_language: 'zh-CN',
            internal_language: 'en',
            provider: 'google',
            auto_mode: 'both',
            deepl_endpoint: 'free',
        },
    };

    const jqChain = new Proxy(function () {}, {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'length') return 0;
            return () => jqChain;
        },
        apply() { return jqChain; },
    });
    globalThis.jQuery = Object.assign((selector) => {
        if (selector === '#send_textarea') {
            return {
                val: (next) => {
                    if (next !== undefined) {
                        textareaValue = String(next);
                        return;
                    }
                    return textareaValue;
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

    const registerHandler = (evt, fn) => {
        if (!eventHandlers.has(evt)) eventHandlers.set(evt, []);
        eventHandlers.get(evt).push(fn);
    };

    const eventSourceMock = {
        on: registerHandler,
        makeFirst: registerHandler,
    };

    const contextMock = {
        get chat() {
            return currentChat;
        },
        saveChat: saveChatMock,
        get activityGuard() {
            return activeGuardApi;
        },
    };

    jest.unstable_mockModule('../../public/script.js', () => ({
        eventSource: eventSourceMock,
        event_types: {
            SECRET_WRITTEN: 'secret_written',
            SECRET_DELETED: 'secret_deleted',
            SECRET_ROTATED: 'secret_rotated',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            MESSAGE_SWIPED: 'message_swiped',
            IMPERSONATE_READY: 'impersonate_ready',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
            MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
            CHAT_CHANGED: 'chat_id_changed',
        },
        getRequestHeaders: () => ({}),
        reloadCurrentChat: async () => {},
        saveSettingsDebounced: noop,
        substituteParams: (s) => String(s ?? ''),
        updateMessageBlock: updateMessageBlockMock,
    }));

    jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettingsMock,
        getContext: () => contextMock,
        renderExtensionTemplateAsync: async () => '',
    }));

    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        POPUP_TYPE: { CONFIRM: 2 },
        callGenericPopup: async () => true,
    }));

    jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
        updateReasoningUI: updateReasoningUIMock,
    }));

    jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
        secret_state: {},
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
        SlashCommand: { fromProps: (x) => x },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: Object.assign(class {}, { fromProps: (x) => x }),
        SlashCommandNamedArgument: Object.assign(class {}, { fromProps: (x) => x }),
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
        enumIcons: { server: 'server' },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
        enumTypes: { name: 'name' },
        SlashCommandEnumValue: class {},
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: { addCommandObject: noop },
    }));

    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        splitRecursive: (text) => [String(text ?? '')],
    }));

    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
    }));

    const translateMod = await import('../../public/scripts/extensions/translate/index.js');
    await translateMod.init();
});

beforeEach(() => {
    registry = createActivityGuardRegistry();
    activeGuardApi = makeActivityGuardApi(registry);
    extensionSettingsMock.translate.auto_mode = 'both';
    currentChat = [];
    textareaValue = '';
    saveChatMock.mockReset().mockResolvedValue(undefined);
    updateMessageBlockMock.mockReset();
    updateReasoningUIMock.mockReset();
});

afterEach(() => {
    const leftover = registry.getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('Translate extension activity guard leases', () => {
    test('wraps incoming message and reasoning translation with translate:run chat lease', async () => {
        const reasoningStarted = deferred();
        const reasoningGate = deferred();
        const messageStarted = deferred();
        const messageGate = deferred();
        let fetchCount = 0;

        globalThis.fetch = jest.fn(() => {
            fetchCount += 1;
            if (fetchCount === 1) {
                reasoningStarted.resolve();
                return reasoningGate.promise;
            }
            messageStarted.resolve();
            return messageGate.promise;
        });

        currentChat = [{ name: 'Alice', is_user: false, mes: 'Hello', extra: { reasoning: 'Thinking' } }];
        const incomingPromise = eventHandlers.get('character_message_rendered')[0](0);

        await reasoningStarted.promise;
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'translate:run',
                label: 'Message translation',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        reasoningGate.resolve({ ok: true, text: async () => '思考中' });
        await messageStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'translate:run', label: 'Message translation', scope: 'chat' }),
        ]);

        messageGate.resolve({ ok: true, text: async () => '你好' });
        await incomingPromise;

        expect(currentChat[0].extra.reasoning_display_text).toBe('思考中');
        expect(currentChat[0].extra.display_text).toBe('你好');
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('wraps outgoing message and impersonate translation with translate:run chat lease', async () => {
        const outgoingStarted = deferred();
        const outgoingGate = deferred();
        globalThis.fetch = jest.fn(() => {
            outgoingStarted.resolve();
            return outgoingGate.promise;
        });

        currentChat = [{ name: 'User', is_user: true, mes: '你好', extra: {} }];
        const outPromise = eventHandlers.get('user_message_rendered')[0](0);
        await outgoingStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'translate:run', scope: 'chat' }),
        ]);

        outgoingGate.resolve({ ok: true, text: async () => 'Hello' });
        await outPromise;
        expect(currentChat[0].mes).toBe('Hello');
        expect(registry.getActiveActivities()).toEqual([]);

        // Impersonate ready
        const impStarted = deferred();
        const impGate = deferred();
        globalThis.fetch = jest.fn(() => {
            impStarted.resolve();
            return impGate.promise;
        });
        textareaValue = 'I am here';
        const impPromise = eventHandlers.get('impersonate_ready')[0]();
        await impStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'translate:run', scope: 'chat' }),
        ]);

        impGate.resolve({ ok: true, text: async () => '我在这里' });
        await impPromise;
        expect(textareaValue).toBe('我在这里');
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('wraps message edit and reasoning edit without double-acquiring nested leases', async () => {
        const editStarted = deferred();
        const editGate = deferred();
        globalThis.fetch = jest.fn(() => {
            editStarted.resolve();
            return editGate.promise;
        });

        currentChat = [{ name: 'Alice', is_user: false, mes: 'Edited text', extra: { reasoning: 'Edited thought' } }];

        eventHandlers.get('message_edited')[0](0);
        const editPromise = eventHandlers.get('message_updated')[0](0);
        await editStarted.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0]).toMatchObject({
            source: 'translate:run',
            label: 'Message translation',
            scope: 'chat',
        });

        editGate.resolve({ ok: true, text: async () => '编辑后的文本' });
        await editPromise;
        expect(registry.getActiveActivities()).toEqual([]);

        // Reasoning edit
        const rStarted = deferred();
        const rGate = deferred();
        globalThis.fetch = jest.fn(() => {
            rStarted.resolve();
            return rGate.promise;
        });

        const rPromise = eventHandlers.get('message_reasoning_edited')[0](0);
        await rStarted.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0]).toMatchObject({
            source: 'translate:run',
            label: 'Message translation',
            scope: 'chat',
        });

        rGate.resolve({ ok: true, text: async () => '编辑后的思考' });
        await rPromise;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('direct globalThis.translate does not acquire translate:run and null activityGuard works', async () => {
        globalThis.fetch = jest.fn(async () => ({ ok: true, text: async () => 'Direct ok' }));
        const translated = await globalThis.translate('Direct', 'en', 'google');
        expect(translated).toBe('Direct ok');
        expect(registry.getActiveActivities()).toEqual([]);

        activeGuardApi = null;
        currentChat = [{ name: 'User', is_user: true, mes: 'Hi', extra: {} }];
        await eventHandlers.get('user_message_rendered')[0](0);
        expect(currentChat[0].mes).toBe('Direct ok');
    });

    test('no-op MESSAGE_UPDATED and MESSAGE_REASONING_EDITED events acquire ZERO leases and fire ZERO subscribeActivityGuard notifications', async () => {
        const listener = jest.fn();
        const unsub = registry.subscribeActivityGuard(listener);
        try {
            // 1. auto_mode === 'none' on MESSAGE_UPDATED (without edit) and edited without display_text
            extensionSettingsMock.translate.auto_mode = 'none';
            currentChat = [{ name: 'Alice', is_user: false, mes: 'Plain message', extra: { reasoning: 'Thought' } }];

            await eventHandlers.get('message_updated')[0](0);
            eventHandlers.get('message_edited')[0](0);
            await eventHandlers.get('message_updated')[0](0);
            await eventHandlers.get('message_reasoning_edited')[0](0);

            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();
            expect(registry.getActiveActivities()).toEqual([]);

            // 2. auto_mode === 'both' on non-edited MESSAGE_UPDATED with display_text refreshes block synchronously without a lease
            extensionSettingsMock.translate.auto_mode = 'both';
            currentChat = [{ name: 'Alice', is_user: false, mes: 'Hello', extra: { display_text: '你好' } }];
            await eventHandlers.get('message_updated')[0](0);
            expect(updateMessageBlockMock).toHaveBeenCalledTimes(1);
            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();

            // 3. auto_mode === 'inputs' on edited assistant message acquires ZERO leases
            extensionSettingsMock.translate.auto_mode = 'inputs';
            eventHandlers.get('message_edited')[0](0);
            await eventHandlers.get('message_updated')[0](0);
            await eventHandlers.get('message_reasoning_edited')[0](0);
            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();
        } finally {
            unsub();
        }
    });
});
