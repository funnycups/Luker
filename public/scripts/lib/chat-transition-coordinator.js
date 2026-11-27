// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    buildChatSwitchBlockingReasons,
    cancelChatSwitchActivities,
    createChatSwitchConfirmRunner,
    getChatSwitchBlockingLabels,
    hasActiveSource,
    hasChatSwitchGuard,
    resolveRequestActivityLeaseOptions,
    withActivityLease,
} from '../activity-guard.js';

/**
 * Pure coordinator for chat transition epochs, chat-switch confirmation dialogs,
 * core generation lease lifecycles, and generateRaw activity lease wrapping.
 */
export function createChatTransitionCoordinator({
    isGenerating,
    hasActiveMessageEdit,
    getStreamingProcessor,
    clearStreamingProcessorIfSame,
    stopGeneration,
    confirmPopup,
    escapeHtml,
    t,
    translate,
    negativePopupResult = 0,
    activityGuard = {
        getChatSwitchBlockingLabels,
        hasChatSwitchGuard,
        hasActiveSource,
        cancelChatSwitchActivities,
        withActivityLease,
    },
}) {
    let chatTransitionInProgress = false;
    let chatTransitionEpoch = 0;

    function getChatTransitionEpoch() {
        return chatTransitionEpoch;
    }

    function bumpChatTransitionEpoch() {
        chatTransitionEpoch += 1;
        return chatTransitionEpoch;
    }

    function beginChatTransition() {
        chatTransitionInProgress = true;
        bumpChatTransitionEpoch();
    }

    function endChatTransition() {
        chatTransitionInProgress = false;
    }

    function isChatTransitionInProgress() {
        return chatTransitionInProgress;
    }

    const runChatSwitchConfirm = createChatSwitchConfirmRunner({
        getBlockingReasons: () => buildChatSwitchBlockingReasons({
            activityLabels: activityGuard.getChatSwitchBlockingLabels(),
            hasChatSwitchActivity: activityGuard.hasChatSwitchGuard(),
            activityFallbackLabel: t`Background task`,
            isGenerating: isGenerating(),
            hasGenerationLease: activityGuard.hasActiveSource('core:generation') || activityGuard.hasActiveSource('core:group-generation'),
            generationFallbackLabel: t`Message generation`,
            hasUnsavedEdit: hasActiveMessageEdit(),
            unsavedEditLabel: t`Unsaved message edit`,
        }),
        isGenerating,
        confirmDialog: async (reasons) => {
            const listHtml = reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('');
            const html = `<p>${escapeHtml(t`Switching chats will interrupt the following in-progress work:`)}</p><ul>${listHtml}</ul>`;
            const result = await confirmPopup(t`Tasks still in progress`, html, {
                okButton: t`Switch anyway`,
                cancelButton: t`Cancel`,
                defaultResult: negativePopupResult,
            });
            return Boolean(result);
        },
        onEpochBump: () => {
            bumpChatTransitionEpoch();
        },
        onStopGeneration: () => {
            const proc = getStreamingProcessor();
            stopGeneration();
            clearStreamingProcessorIfSame(proc);
        },
        onCancelActivities: () => {
            activityGuard.cancelChatSwitchActivities();
            const proc = getStreamingProcessor();
            if (proc?.abortController?.signal?.aborted) {
                clearStreamingProcessorIfSame(proc);
            }
        },
    });

    async function confirmChatSwitchGuard({ skipConfirmation = false } = {}) {
        return await runChatSwitchConfirm({ skipConfirmation });
    }

    /**
     * Executes a core generation task with the appropriate `core:generation` /
     * `core:generation-quiet` activity lease (bypassing leases for `dryRun`).
     */
    async function runWithGenerationLease({ type, dryRun = false, abortController }, fn) {
        if (dryRun) {
            return await fn();
        }
        return await activityGuard.withActivityLease({
            source: type === 'quiet' ? 'core:generation-quiet' : 'core:generation',
            label: type === 'quiet' ? t`Background generation` : t`Message generation`,
            scope: 'chat',
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
            onCancel: () => {
                if (!abortController?.signal?.aborted) {
                    stopGeneration();
                }
            },
        }, fn);
    }

    /**
     * Executes a generateRawData request with its resolved `core:generate-raw`
     * ambient lease (or no lease when `activity === false`).
     */
    async function runWithGenerateRawLease(activity, fn) {
        const leaseOptions = resolveRequestActivityLeaseOptions(activity, 'core:generate-raw', {
            defaultLabel: translate('Background AI request'),
        });
        return leaseOptions ? await activityGuard.withActivityLease(leaseOptions, fn) : await fn();
    }

    return {
        getChatTransitionEpoch,
        bumpChatTransitionEpoch,
        beginChatTransition,
        endChatTransition,
        isChatTransitionInProgress,
        confirmChatSwitchGuard,
        runWithGenerationLease,
        runWithGenerateRawLease,
    };
}
