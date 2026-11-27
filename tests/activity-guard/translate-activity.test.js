// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createTranslateController } from '../../public/scripts/extensions/translate/translate-controller.js';

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

describe('Translate controller activity guard leases', () => {
    let registry;
    let activeGuardApi;
    let currentChat;
    let settings;
    let textareaValue;
    let saveChatMock;
    let updateMessageBlockMock;
    let updateReasoningUIMock;
    let fetchImpl;
    let controller;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        activeGuardApi = makeActivityGuardApi(registry);
        currentChat = [];
        settings = {
            target_language: 'zh-CN',
            internal_language: 'en',
            provider: 'google',
            auto_mode: 'both',
            deepl_endpoint: 'free',
        };
        textareaValue = '';
        saveChatMock = jest.fn(async () => {});
        updateMessageBlockMock = jest.fn();
        updateReasoningUIMock = jest.fn();
        fetchImpl = jest.fn(async () => ({ ok: true, text: async () => '' }));

        const context = {
            get chat() {
                return currentChat;
            },
            saveChat: (...args) => saveChatMock(...args),
            get activityGuard() {
                return activeGuardApi;
            },
        };

        const jq = (selector) => {
            if (selector === '#send_textarea') {
                return {
                    val(next) {
                        if (next !== undefined) {
                            textareaValue = String(next);
                            return;
                        }
                        return textareaValue;
                    },
                };
            }
            return { text: () => '' };
        };

        controller = createTranslateController({
            getSettings: () => settings,
            getContext: () => context,
            getRequestHeaders: () => ({}),
            getSecretState: () => ({}),
            substituteParams: (s) => String(s ?? ''),
            updateMessageBlock: (...args) => updateMessageBlockMock(...args),
            updateReasoningUI: (...args) => updateReasoningUIMock(...args),
            splitRecursive: (text) => [String(text ?? '')],
            t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
            getJQuery: () => jq,
            getToastr: () => ({ error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() }),
            fetchImpl: (...args) => fetchImpl(...args),
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('wraps incoming message and reasoning translation with translate:run chat lease', async () => {
        const reasoningStarted = deferred();
        const reasoningGate = deferred();
        const messageStarted = deferred();
        const messageGate = deferred();
        let fetchCount = 0;

        fetchImpl = jest.fn(() => {
            fetchCount += 1;
            if (fetchCount === 1) {
                reasoningStarted.resolve();
                return reasoningGate.promise;
            }
            messageStarted.resolve();
            return messageGate.promise;
        });

        currentChat = [{ name: 'Alice', is_user: false, mes: 'Hello', extra: { reasoning: 'Thinking' } }];
        const incomingPromise = controller.handleIncomingMessage(0);

        await reasoningStarted.promise;
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'translate:run',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        reasoningGate.resolve({ ok: true, text: async () => '思考中' });
        await messageStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'translate:run', label: expect.stringMatching(/\S/), scope: 'chat' }),
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
        fetchImpl = jest.fn(() => {
            outgoingStarted.resolve();
            return outgoingGate.promise;
        });

        currentChat = [{ name: 'User', is_user: true, mes: '你好', extra: {} }];
        const outPromise = controller.handleOutgoingMessage(0);
        await outgoingStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'translate:run', scope: 'chat' }),
        ]);

        outgoingGate.resolve({ ok: true, text: async () => 'Hello' });
        await outPromise;
        expect(currentChat[0].mes).toBe('Hello');
        expect(registry.getActiveActivities()).toEqual([]);

        const impStarted = deferred();
        const impGate = deferred();
        fetchImpl = jest.fn(() => {
            impStarted.resolve();
            return impGate.promise;
        });
        textareaValue = 'I am here';
        const impPromise = controller.handleImpersonateReady();
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
        fetchImpl = jest.fn(() => {
            editStarted.resolve();
            return editGate.promise;
        });

        currentChat = [{ name: 'Alice', is_user: false, mes: 'Edited text', extra: { reasoning: 'Edited thought' } }];

        controller.handleMessageEdited(0);
        const editPromise = controller.handleMessageUpdate(0);
        await editStarted.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0]).toMatchObject({
            source: 'translate:run',
            label: expect.stringMatching(/\S/),
            scope: 'chat',
        });

        editGate.resolve({ ok: true, text: async () => '编辑后的文本' });
        await editPromise;
        expect(registry.getActiveActivities()).toEqual([]);

        const rStarted = deferred();
        const rGate = deferred();
        fetchImpl = jest.fn(() => {
            rStarted.resolve();
            return rGate.promise;
        });

        const rPromise = controller.handleMessageReasoningEdit(0);
        await rStarted.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0]).toMatchObject({
            source: 'translate:run',
            label: expect.stringMatching(/\S/),
            scope: 'chat',
        });

        rGate.resolve({ ok: true, text: async () => '编辑后的思考' });
        await rPromise;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('direct translate does not acquire translate:run and null activityGuard works', async () => {
        fetchImpl = jest.fn(async () => ({ ok: true, text: async () => 'Direct ok' }));
        const translated = await controller.translate('Direct', 'en', 'google');
        expect(translated).toBe('Direct ok');
        expect(registry.getActiveActivities()).toEqual([]);

        activeGuardApi = null;
        currentChat = [{ name: 'User', is_user: true, mes: 'Hi', extra: {} }];
        await controller.handleOutgoingMessage(0);
        expect(currentChat[0].mes).toBe('Direct ok');
    });

    test('no-op MESSAGE_UPDATED and MESSAGE_REASONING_EDITED events acquire ZERO leases and fire ZERO subscribeActivityGuard notifications', async () => {
        const listener = jest.fn();
        const unsub = registry.subscribeActivityGuard(listener);
        try {
            settings.auto_mode = 'none';
            currentChat = [{ name: 'Alice', is_user: false, mes: 'Plain message', extra: { reasoning: 'Thought' } }];

            await controller.handleMessageUpdate(0);
            controller.handleMessageEdited(0);
            await controller.handleMessageUpdate(0);
            await controller.handleMessageReasoningEdit(0);

            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();
            expect(registry.getActiveActivities()).toEqual([]);

            settings.auto_mode = 'both';
            currentChat = [{ name: 'Alice', is_user: false, mes: 'Hello', extra: { display_text: '你好' } }];
            await controller.handleMessageUpdate(0);
            expect(updateMessageBlockMock).toHaveBeenCalledTimes(1);
            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();

            settings.auto_mode = 'inputs';
            controller.handleMessageEdited(0);
            await controller.handleMessageUpdate(0);
            await controller.handleMessageReasoningEdit(0);
            expect(listener).not.toHaveBeenCalled();
            expect(saveChatMock).not.toHaveBeenCalled();
        } finally {
            unsub();
        }
    });
});
