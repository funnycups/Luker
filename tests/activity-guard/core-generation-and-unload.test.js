import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createBeforeUnloadCoordinator } from '../../public/scripts/lib/before-unload-coordinator.js';
import { createChatTransitionCoordinator } from '../../public/scripts/lib/chat-transition-coordinator.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[c]));
}

describe('core generation leases, beforeunload coordinator, and chat-switch confirmation', () => {
    let registry;
    let isSendPress;
    let streamingProcessor;
    let isGroupGenerating;
    let editedMessageId;
    let sendTextareaVal;
    let isChatSaving;
    let hasPendingChatSaveTimeout;
    let cancelTtsPlay;
    let flushTokenCacheSave;
    let flushItemizedPromptsSave;
    let saveChatConditional;
    let stopGeneration;
    let confirmPopup;
    let beforeUnload;
    let transition;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        isSendPress = false;
        streamingProcessor = null;
        isGroupGenerating = false;
        editedMessageId = undefined;
        sendTextareaVal = '';
        isChatSaving = false;
        hasPendingChatSaveTimeout = false;
        cancelTtsPlay = jest.fn();
        flushTokenCacheSave = jest.fn();
        flushItemizedPromptsSave = jest.fn();
        saveChatConditional = jest.fn(() => {
            hasPendingChatSaveTimeout = false;
        });
        stopGeneration = jest.fn();
        confirmPopup = jest.fn(async () => 1);

        const isGenerationActive = () => isSendPress || Boolean(streamingProcessor) || isGroupGenerating;
        const hasActiveMessageEdit = () => (typeof editedMessageId === 'number' || (typeof editedMessageId === 'string' && editedMessageId.trim() !== ''))
            && Number.isFinite(Number(editedMessageId))
            && Number(editedMessageId) >= 0;

        beforeUnload = createBeforeUnloadCoordinator({
            hasUnloadGuard: () => registry.hasUnloadGuard(),
            isGenerationActive,
            hasActiveMessageEdit,
            getSendTextareaValue: () => sendTextareaVal,
            isChatSaving: () => isChatSaving,
            hasPendingChatSaveTimeout: () => hasPendingChatSaveTimeout,
            cancelTtsPlay,
            getStreamingProcessor: () => streamingProcessor,
            isStreamingRecoverable: (proc) => Boolean(proc?.recoverable),
            flushTokenCacheSave,
            flushItemizedPromptsSave,
            saveChatConditional,
        });

        transition = createChatTransitionCoordinator({
            isGenerating: isGenerationActive,
            hasActiveMessageEdit,
            getStreamingProcessor: () => streamingProcessor,
            clearStreamingProcessorIfSame: (proc) => {
                if (streamingProcessor === proc) {
                    streamingProcessor = null;
                }
            },
            stopGeneration,
            confirmPopup,
            escapeHtml,
            t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
            translate: (s) => String(s ?? ''),
            negativePopupResult: 0,
            activityGuard: registry,
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('runWithGenerationLease skips lease for dryRun, acquires core:generation for normal, and hooks stopGeneration via onCancel', async () => {
        let dryRunActivities = null;
        await transition.runWithGenerationLease({ type: 'normal', dryRun: true, abortController: new AbortController() }, async () => {
            dryRunActivities = registry.getActiveActivities();
        });
        expect(dryRunActivities).toEqual([]);

        const gate = deferred();
        const controller = new AbortController();
        let activeDuringNormal = null;
        const genPromise = transition.runWithGenerationLease({ type: 'normal', dryRun: false, abortController: controller }, async () => {
            activeDuringNormal = registry.getActiveActivities();
            return await gate.promise;
        });

        expect(activeDuringNormal).toHaveLength(1);
        expect(activeDuringNormal[0]).toMatchObject({
            source: 'core:generation',
            label: expect.stringMatching(/\S/),
            scope: 'chat',
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
        });
        expect(registry.hasActiveSource('core:generation')).toBe(true);
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);

        registry.cancelChatSwitchActivities();
        expect(stopGeneration).toHaveBeenCalledTimes(1);

        gate.reject(new Error('Server unreachable'));
        await expect(genPromise).rejects.toThrow('Server unreachable');
        expect(registry.getActiveActivities()).toEqual([]);
        expect(registry.hasUnloadGuard()).toBe(false);
    });

    test('runWithGenerationLease acquires core:generation-quiet for quiet generation and releases on exit', async () => {
        let observed = null;
        await transition.runWithGenerationLease({ type: 'quiet', dryRun: false, abortController: new AbortController() }, async () => {
            observed = registry.getActiveActivities();
        });
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            source: 'core:generation-quiet',
            label: expect.stringMatching(/\S/),
            scope: 'chat',
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
        });
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('shouldWarnBeforeUnload unifies activity guard, active generation, edits, draft input, and pending saves', () => {
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(false);

        const releaseNoUnload = registry.acquireActivityLease({ source: 'test:no-unload', guardUnload: false });
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(false);
        releaseNoUnload();

        const releaseUnload = registry.acquireActivityLease({ source: 'test:unload', guardUnload: true });
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);
        releaseUnload();
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(false);

        isSendPress = true;
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);
        isSendPress = false;

        editedMessageId = 2;
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);
        editedMessageId = undefined;

        sendTextareaVal = '   \n  ';
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(false);
        sendTextareaVal = 'unsent reply';
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);
        sendTextareaVal = '';

        expect(beforeUnload.shouldWarnBeforeUnload(true)).toBe(true);
        expect(beforeUnload.shouldWarnBeforeUnload(false)).toBe(false);
    });

    test('handleBeforeUnload flushes caches, preserves recoverable streams, captures debouncePending before saveChatConditional, and never runs onCancel', () => {
        const onCancelSpy = jest.fn();
        const release = registry.acquireActivityLease({
            source: 'test:unload-task',
            scope: 'chat',
            guardUnload: true,
            onCancel: onCancelSpy,
        });

        const recoverableStop = jest.fn();
        streamingProcessor = { recoverable: true, onStopStreaming: recoverableStop };

        try {
            const leaseEvent = { preventDefault: jest.fn(), returnValue: undefined };
            beforeUnload.handleBeforeUnload(leaseEvent);

            expect(cancelTtsPlay).toHaveBeenCalledTimes(1);
            expect(recoverableStop).not.toHaveBeenCalled();
            expect(flushTokenCacheSave).toHaveBeenCalledTimes(1);
            expect(flushItemizedPromptsSave).toHaveBeenCalledTimes(1);
            expect(leaseEvent.preventDefault).toHaveBeenCalledTimes(1);
            expect(leaseEvent.returnValue).toBe('');
            expect(onCancelSpy).not.toHaveBeenCalled();
        } finally {
            streamingProcessor = null;
            release();
        }

        const nonRecoverableStop = jest.fn();
        streamingProcessor = { recoverable: false, onStopStreaming: nonRecoverableStop };
        beforeUnload.handleBeforeUnload({ preventDefault: jest.fn(), returnValue: undefined });
        expect(nonRecoverableStop).toHaveBeenCalledTimes(1);
        streamingProcessor = null;

        hasPendingChatSaveTimeout = true;
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(true);

        const debounceEvent = { preventDefault: jest.fn(), returnValue: undefined };
        beforeUnload.handleBeforeUnload(debounceEvent);
        expect(saveChatConditional).toHaveBeenCalledTimes(1);
        expect(debounceEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(debounceEvent.returnValue).toBe('');
        expect(beforeUnload.shouldWarnBeforeUnload()).toBe(false);

        const idleEvent = { preventDefault: jest.fn(), returnValue: undefined };
        beforeUnload.handleBeforeUnload(idleEvent);
        expect(idleEvent.preventDefault).not.toHaveBeenCalled();
        expect(idleEvent.returnValue).toBeUndefined();
    });

    test('confirmChatSwitchGuard escapes labels, includes generation fallback and unsaved edit, and handles cancel/confirm/re-entrancy/skipConfirmation', async () => {
        await expect(transition.confirmChatSwitchGuard()).resolves.toBe(true);
        expect(confirmPopup).not.toHaveBeenCalled();

        const onCancelSpy = jest.fn();
        const release = registry.acquireActivityLease({
            source: 'test:xss-label',
            label: '<script>alert(1)</script>',
            scope: 'chat',
            onCancel: onCancelSpy,
        });

        try {
            isSendPress = true;
            editedMessageId = 0;

            const epochBeforeCancel = transition.getChatTransitionEpoch();
            const pendingPopup = deferred();
            confirmPopup.mockImplementationOnce(() => pendingPopup.promise);

            const firstCall = transition.confirmChatSwitchGuard();
            const reentrantCall = transition.confirmChatSwitchGuard();

            await expect(reentrantCall).resolves.toBe(false);
            expect(confirmPopup).toHaveBeenCalledTimes(1);

            const [title, html, opts] = confirmPopup.mock.calls[0];
            expect(typeof title).toBe('string');
            expect(title.length).toBeGreaterThan(0);
            expect(html).toContain('<li>&lt;script&gt;alert(1)&lt;/script&gt;</li>');
            expect(html).not.toContain('<script>');
            expect((html.match(/<li>/g) || []).length).toBe(3);
            expect(opts).toMatchObject({
                okButton: expect.any(String),
                cancelButton: expect.any(String),
                defaultResult: 0,
            });
            expect(opts.okButton.length).toBeGreaterThan(0);
            expect(opts.cancelButton.length).toBeGreaterThan(0);

            pendingPopup.resolve(0);
            await expect(firstCall).resolves.toBe(false);
            expect(transition.getChatTransitionEpoch()).toBe(epochBeforeCancel);
            expect(onCancelSpy).not.toHaveBeenCalled();

            confirmPopup.mockResolvedValueOnce(1);
            await expect(transition.confirmChatSwitchGuard()).resolves.toBe(true);
            expect(transition.getChatTransitionEpoch()).toBe(epochBeforeCancel + 1);
            expect(stopGeneration).toHaveBeenCalledTimes(1);
            expect(onCancelSpy).toHaveBeenCalledTimes(1);

            confirmPopup.mockClear();
            onCancelSpy.mockClear();
            const epochBeforeSkip = transition.getChatTransitionEpoch();
            await expect(transition.confirmChatSwitchGuard({ skipConfirmation: true })).resolves.toBe(true);
            expect(confirmPopup).not.toHaveBeenCalled();
            expect(transition.getChatTransitionEpoch()).toBe(epochBeforeSkip + 1);
            expect(onCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
    });

    test('confirmChatSwitchGuard renders fallback list item and runs onCancel for unnamed guardChatSwitch lease', async () => {
        const onCancelSpy = jest.fn();
        const release = registry.acquireActivityLease({
            source: 'plugin:unnamed',
            scope: 'chat',
            label: '',
            onCancel: onCancelSpy,
        });

        try {
            confirmPopup.mockResolvedValueOnce(0);
            await expect(transition.confirmChatSwitchGuard()).resolves.toBe(false);
            expect(confirmPopup).toHaveBeenCalledTimes(1);
            expect(confirmPopup.mock.calls[0][1]).toMatch(/<li>[^<]+<\/li>/);
            expect(onCancelSpy).not.toHaveBeenCalled();

            confirmPopup.mockResolvedValueOnce(1);
            await expect(transition.confirmChatSwitchGuard()).resolves.toBe(true);
            expect(onCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
    });

    test('epoch helpers and transition state advance monotonically and track active transitions', () => {
        const start = transition.getChatTransitionEpoch();
        expect(transition.isChatTransitionInProgress()).toBe(false);
        expect(transition.bumpChatTransitionEpoch()).toBe(start + 1);
        expect(transition.getChatTransitionEpoch()).toBe(start + 1);

        transition.beginChatTransition();
        expect(transition.isChatTransitionInProgress()).toBe(true);
        expect(transition.getChatTransitionEpoch()).toBe(start + 2);

        transition.endChatTransition();
        expect(transition.isChatTransitionInProgress()).toBe(false);
    });
});
