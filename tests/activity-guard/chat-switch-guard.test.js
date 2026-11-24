import { describe, test, expect, jest } from '@jest/globals';
import {
    buildChatSwitchBlockingReasons,
    createActivityGuardRegistry,
    createChatSwitchConfirmRunner,
} from '../../public/scripts/activity-guard.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('activity-guard chat-switch confirmation coordinator', () => {
    test('buildChatSwitchBlockingReasons collects, deduplicates, and adds generation/edit reasons', () => {
        expect(buildChatSwitchBlockingReasons()).toEqual([]);

        expect(buildChatSwitchBlockingReasons({
            activityLabels: ['  Memory graph update  ', '', 'Memory graph update', 'Image generation'],
            isGenerating: true,
            hasGenerationLease: false,
            generationFallbackLabel: 'Message generation',
            hasUnsavedEdit: true,
            unsavedEditLabel: 'Unsaved message edit',
        })).toEqual([
            'Memory graph update',
            'Image generation',
            'Message generation',
            'Unsaved message edit',
        ]);

        // When a core generation lease is already registered, do not duplicate fallback label.
        expect(buildChatSwitchBlockingReasons({
            activityLabels: ['Message generation'],
            isGenerating: true,
            hasGenerationLease: true,
            generationFallbackLabel: 'Message generation',
            hasUnsavedEdit: false,
        })).toEqual(['Message generation']);

        // Fallback still deduplicates if activityLabels somehow already matches it.
        expect(buildChatSwitchBlockingReasons({
            activityLabels: ['Message generation'],
            isGenerating: true,
            hasGenerationLease: false,
            generationFallbackLabel: 'Message generation',
        })).toEqual(['Message generation']);

        // Unnamed chat-switch activity uses activityFallbackLabel only when no activity label was collected.
        expect(buildChatSwitchBlockingReasons({
            activityLabels: ['', '   '],
            hasChatSwitchActivity: true,
            activityFallbackLabel: 'Background task',
        })).toEqual(['Background task']);

        expect(buildChatSwitchBlockingReasons({
            activityLabels: ['Memory graph update'],
            hasChatSwitchActivity: true,
            activityFallbackLabel: 'Background task',
        })).toEqual(['Memory graph update']);
    });

    test('unnamed scope=chat lease still triggers confirmation and runs onCancel on confirm', async () => {
        const registry = createActivityGuardRegistry();
        const pluginCancelSpy = jest.fn();
        const releaseUnnamed = registry.acquireActivityLease({
            source: 'plugin:unnamed-chat',
            scope: 'chat',
            label: '   ',
            onCancel: pluginCancelSpy,
        });

        const confirmDialog = jest.fn(async () => false);
        const onEpochBump = jest.fn();
        const onStopGeneration = jest.fn();
        const onCancelActivities = jest.fn(() => {
            registry.cancelChatSwitchActivities();
        });

        try {
            const run = createChatSwitchConfirmRunner({
                getBlockingReasons: () => buildChatSwitchBlockingReasons({
                    activityLabels: registry.getChatSwitchBlockingLabels(),
                    hasChatSwitchActivity: registry.hasChatSwitchGuard(),
                    activityFallbackLabel: 'Background task',
                }),
                isGenerating: () => false,
                confirmDialog,
                onEpochBump,
                onStopGeneration,
                onCancelActivities,
            });

            await expect(run()).resolves.toBe(false);
            expect(confirmDialog).toHaveBeenCalledWith(['Background task']);
            expect(pluginCancelSpy).not.toHaveBeenCalled();

            confirmDialog.mockResolvedValueOnce(true);
            await expect(run()).resolves.toBe(true);
            expect(onEpochBump).toHaveBeenCalledTimes(1);
            expect(pluginCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            releaseUnnamed();
        }
    });

    test('returns true immediately without opening dialog when no blocking reasons exist', async () => {
        const confirmDialog = jest.fn(async () => false);
        const onEpochBump = jest.fn();
        const onStopGeneration = jest.fn();
        const onCancelActivities = jest.fn();

        const run = createChatSwitchConfirmRunner({
            getBlockingReasons: () => [],
            isGenerating: () => false,
            confirmDialog,
            onEpochBump,
            onStopGeneration,
            onCancelActivities,
        });

        await expect(run()).resolves.toBe(true);
        await expect(run({ skipConfirmation: true })).resolves.toBe(true);

        expect(confirmDialog).not.toHaveBeenCalled();
        expect(onEpochBump).not.toHaveBeenCalled();
        expect(onStopGeneration).not.toHaveBeenCalled();
        expect(onCancelActivities).not.toHaveBeenCalled();
    });

    test('re-entrant second call while dialog is pending returns false without opening a second dialog', async () => {
        const gate = deferred();
        const confirmDialog = jest.fn(() => gate.promise);
        const onEpochBump = jest.fn();
        const onStopGeneration = jest.fn();
        const onCancelActivities = jest.fn();

        const run = createChatSwitchConfirmRunner({
            getBlockingReasons: () => ['Memory graph update'],
            isGenerating: () => false,
            confirmDialog,
            onEpochBump,
            onStopGeneration,
            onCancelActivities,
        });

        const firstCall = run();
        const secondCall = run();

        await expect(secondCall).resolves.toBe(false);
        expect(confirmDialog).toHaveBeenCalledTimes(1);

        gate.resolve(true);
        await expect(firstCall).resolves.toBe(true);
        expect(onEpochBump).toHaveBeenCalledTimes(1);
        expect(onCancelActivities).toHaveBeenCalledTimes(1);
        expect(onStopGeneration).not.toHaveBeenCalled();

        // After settling, a subsequent call can prompt again.
        await expect(run()).resolves.toBe(true);
        expect(confirmDialog).toHaveBeenCalledTimes(2);
    });

    test('resets re-entrancy lock if confirmDialog rejects', async () => {
        const confirmDialog = jest.fn()
            .mockRejectedValueOnce(new Error('dialog failure'))
            .mockResolvedValueOnce(true);
        const onEpochBump = jest.fn();
        const onStopGeneration = jest.fn();
        const onCancelActivities = jest.fn();

        const run = createChatSwitchConfirmRunner({
            getBlockingReasons: () => ['Image generation'],
            isGenerating: () => false,
            confirmDialog,
            onEpochBump,
            onStopGeneration,
            onCancelActivities,
        });

        await expect(run()).rejects.toThrow('dialog failure');
        await expect(run()).resolves.toBe(true);
        expect(onEpochBump).toHaveBeenCalledTimes(1);
        expect(onCancelActivities).toHaveBeenCalledTimes(1);
    });

    test('cancel returns false and invokes neither onEpochBump, onStopGeneration, nor cancelChatSwitchActivities', async () => {
        const confirmDialog = jest.fn(async () => false);
        const onEpochBump = jest.fn();
        const onStopGeneration = jest.fn();
        const onCancelActivities = jest.fn();

        const run = createChatSwitchConfirmRunner({
            getBlockingReasons: () => ['Message generation', 'Memory graph update'],
            isGenerating: () => true,
            confirmDialog,
            onEpochBump,
            onStopGeneration,
            onCancelActivities,
        });

        await expect(run()).resolves.toBe(false);
        expect(confirmDialog).toHaveBeenCalledWith(['Message generation', 'Memory graph update']);
        expect(onEpochBump).not.toHaveBeenCalled();
        expect(onStopGeneration).not.toHaveBeenCalled();
        expect(onCancelActivities).not.toHaveBeenCalled();
    });

    test('confirm invokes onEpochBump, onStopGeneration (when generating), and cancelChatSwitchActivities in order', async () => {
        const callOrder = [];
        const confirmDialog = jest.fn(async () => {
            callOrder.push('dialog');
            return true;
        });
        const onEpochBump = jest.fn(() => callOrder.push('epoch'));
        const onStopGeneration = jest.fn(() => callOrder.push('stop'));
        const onCancelActivities = jest.fn(() => callOrder.push('cancel'));

        const run = createChatSwitchConfirmRunner({
            getBlockingReasons: () => ['Message generation'],
            isGenerating: () => true,
            confirmDialog,
            onEpochBump,
            onStopGeneration,
            onCancelActivities,
        });

        await expect(run()).resolves.toBe(true);
        expect(callOrder).toEqual(['dialog', 'epoch', 'stop', 'cancel']);
    });

    test('skipConfirmation skips dialog but still runs onEpochBump, onStopGeneration, and cancelChatSwitchActivities when blocking reasons exist', async () => {
        const registry = createActivityGuardRegistry();
        const pluginCancelSpy = jest.fn();
        const releaseChat = registry.acquireActivityLease({
            source: 'memory-graph:update',
            label: 'Memory graph update',
            scope: 'chat',
            onCancel: pluginCancelSpy,
        });
        const releaseAmbient = registry.acquireActivityLease({
            source: 'core:generate-raw',
            label: 'Background AI request',
            scope: 'global',
            ambient: true,
        });

        const callOrder = [];
        const confirmDialog = jest.fn(async () => false);
        const onEpochBump = jest.fn(() => callOrder.push('epoch'));
        const onStopGeneration = jest.fn(() => callOrder.push('stop'));
        const onCancelActivities = jest.fn(() => {
            callOrder.push('cancel');
            registry.cancelChatSwitchActivities();
        });

        try {
            const run = createChatSwitchConfirmRunner({
                getBlockingReasons: () => buildChatSwitchBlockingReasons({
                    activityLabels: registry.getChatSwitchBlockingLabels(),
                    isGenerating: true,
                    hasGenerationLease: registry.hasActiveSource('core:generation'),
                    generationFallbackLabel: 'Message generation',
                }),
                isGenerating: () => true,
                confirmDialog,
                onEpochBump,
                onStopGeneration,
                onCancelActivities,
            });

            await expect(run({ skipConfirmation: true })).resolves.toBe(true);
            expect(confirmDialog).not.toHaveBeenCalled();
            expect(callOrder).toEqual(['epoch', 'stop', 'cancel']);
            expect(pluginCancelSpy).toHaveBeenCalledTimes(1);
        } finally {
            releaseChat();
            releaseAmbient();
        }
    });
});
