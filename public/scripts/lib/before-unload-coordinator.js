// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure coordinator for window beforeunload protection.
 * Unifies activity-guard leases, active generations, unsaved message edits,
 * unsent textarea input, and pending chat saves.
 */
export function createBeforeUnloadCoordinator({
    hasUnloadGuard,
    isGenerationActive,
    hasActiveMessageEdit,
    getSendTextareaValue,
    isChatSaving,
    hasPendingChatSaveTimeout,
    cancelTtsPlay,
    getStreamingProcessor,
    isStreamingRecoverable,
    flushTokenCacheSave,
    flushItemizedPromptsSave,
    saveChatConditional,
}) {
    /**
     * Evaluates whether leaving or reloading the page would lose active work.
     * @param {boolean} [debouncePending=false] Whether a debounced chat save was pending prior to flush
     * @returns {boolean}
     */
    function shouldWarnBeforeUnload(debouncePending = false) {
        if (hasUnloadGuard()) {
            return true;
        }
        if (isGenerationActive()) {
            return true;
        }
        if (hasActiveMessageEdit()) {
            return true;
        }
        if (String(getSendTextareaValue() ?? '').trim().length > 0) {
            return true;
        }
        if (isChatSaving() || debouncePending || hasPendingChatSaveTimeout()) {
            return true;
        }
        return false;
    }

    /**
     * Handles window beforeunload: flushes synchronous state, preserves recoverable
     * streams, and prompts only when active work or unsaved input would be lost.
     * @param {BeforeUnloadEvent} e
     */
    function handleBeforeUnload(e) {
        cancelTtsPlay();
        const streamingProcessor = getStreamingProcessor();
        const isRecoverableGeneration = Boolean(streamingProcessor) && isStreamingRecoverable(streamingProcessor);
        if (streamingProcessor && !isRecoverableGeneration) {
            console.log('Page reloaded. Aborting streaming...');
            streamingProcessor.onStopStreaming();
        }

        // Fire-and-forget: flush queues an IDB transaction synchronously,
        // commit happens off-main-thread before the page tears down.
        try { flushTokenCacheSave(); } catch { /* best-effort */ }
        try { flushItemizedPromptsSave(); } catch { /* best-effort */ }

        // If a debounced chat save is pending, capture that before calling
        // saveChatConditional() (which synchronously cancels chatSaveTimeout) and
        // dispatch the fetch immediately with `keepalive: true`.
        const debouncePending = hasPendingChatSaveTimeout();
        if (debouncePending) {
            try { saveChatConditional(); } catch { /* best-effort */ }
        }

        if (!shouldWarnBeforeUnload(debouncePending)) {
            return;
        }

        e?.preventDefault?.();
        if (e) {
            e.returnValue = '';
        }
    }

    return {
        shouldWarnBeforeUnload,
        handleBeforeUnload,
    };
}
