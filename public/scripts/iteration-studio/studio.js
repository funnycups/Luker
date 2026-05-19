/**
 * IterationStudio — main popup orchestrator.
 *
 * `open(adapter, context, settings, root)` opens the popup, loads/creates
 * the session, wires every event handler, and blocks until the popup is
 * dismissed.
 *
 * Everything mode-specific routes through the adapter. The shell only
 * knows about message/session/history shapes and the LLM round-trip flow.
 */

import { POPUP_TYPE, Popup } from '../popup.js';
import { isAbortError } from '../extensions/orchestrator/abort-utils.js';
import {
    buildRejectedToolResults,
} from '../extensions/orchestrator/tool-calling.js';

import { i18n, i18nFormat } from './i18n.js';
import { buildIterationStudioPopupHtml } from './template.js';
import { bindZoomOverlayHandlers } from './zoom-overlay.js';
import {
    canRefreshAssistantMessage,
    canRollbackAssistantMessage,
    createEmptyHistoryState,
    deleteHistorySession,
    findHistorySession,
    findLatestHistorySession,
    findMessageById,
    getAutoApplyForAdapter,
    getRollbackStartIndex,
    findPreviousUserMessageIndex,
    makeSessionId,
    replaceSessionInPlace,
    restoreSessionStateFromMessages,
    setAutoApplyForAdapter,
    trimSessionMessages,
    upsertHistorySession,
} from './session.js';
import {
    renderConversation,
    renderHistory,
    renderPendingApproval,
} from './render.js';
import {
    applyApprovedToolCalls,
    buildAutoContinuePrompt,
    runIterationTurn,
} from './runner.js';
import { buildProfileDelta } from './delta.js';

let activeAbortController = null;

function isProfileEqual(adapter, before, after) {
    if (!before || !after) return false;
    try {
        const { delta } = buildProfileDelta(adapter, before, after);
        return !delta;
    } catch (error) {
        console.warn('[iteration-studio] Failed to compare profiles', error);
        return false;
    }
}

function createEmptySession(adapter, context, settings) {
    const initial = adapter.getInitialProfile(context, settings) || {};
    const scope = adapter.getDefaultScope(context);
    const avatar = scope === 'character'
        ? String(context?.characters?.[context?.characterId]?.avatar || '').trim()
        : '';
    const sourceName = scope === 'character'
        ? String(context?.characters?.[context?.characterId]?.name || avatar || i18n('(No character card)'))
        : i18n('Global profile');
    const cloned = adapter.cloneWorkingProfile(initial);
    return {
        id: makeSessionId(),
        mode: adapter.mode,
        chatKey: String(context?.chatId || '').trim(),
        sourceScope: scope,
        sourceAvatar: avatar,
        sourceName,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workingProfile: cloned,
        baseWorkingProfile: adapter.cloneWorkingProfile(cloned),
        messages: [],
        lastSimulation: null,
        pendingApproval: null,
    };
}

export async function openIterationStudio(adapter, context, settings, root) {
    if (typeof adapter?.ensureStyles === 'function') {
        try { adapter.ensureStyles(adapter.popupClassName || ''); } catch { /* ignore */ }
    }
    const scope = adapter.getDefaultScope(context);
    const activeAvatar = scope === 'character'
        ? String(context?.characters?.[context?.characterId]?.avatar || '').trim()
        : '';
    let historyState = createEmptyHistoryState();
    try {
        historyState = await adapter.loadHistoryState(context, scope, activeAvatar);
    } catch (error) {
        console.warn(`[iteration-studio:${adapter.id}] Failed to load history`, error);
    }

    let session = createEmptySession(adapter, context, settings);
    const latest = findLatestHistorySession(historyState, adapter.mode);
    // Auto-restore latest only when its base still matches the current editor.
    // External edits between sessions invalidate the stored base — its diffs
    // and apply targets would point at a stale profile. Drifted sessions stay
    // in the history list so the user can still load them manually.
    const canResumeLatest = latest
        ? isProfileEqual(adapter, latest.baseWorkingProfile, session.baseWorkingProfile)
        : false;
    if (canResumeLatest) {
        replaceSessionInPlace(session, latest, adapter);
    } else {
        historyState = upsertHistorySession(adapter, historyState, session);
        try {
            await adapter.persistHistoryState(context, historyState, scope, activeAvatar);
        } catch (error) {
            console.warn(`[iteration-studio:${adapter.id}] Failed to persist initial history`, error);
        }
    }

    const popupId = `luker_iter_studio_${adapter.id}_${Date.now()}`;
    const namespace = `.iterStudio_${popupId}`;
    const selector = `#${popupId}`;
    const popupHtml = buildIterationStudioPopupHtml({
        popupId,
        session,
        adapter,
        opts: { enableSessionHistory: true },
    });

    let isRunning = false;
    let autoApply = getAutoApplyForAdapter(adapter.id);
    let zoomUnbind = null;

    const persist = async () => {
        try {
            session.updatedAt = Date.now();
            historyState = upsertHistorySession(adapter, historyState, session);
            await adapter.persistHistoryState(context, historyState, scope, activeAvatar);
        } catch (error) {
            console.warn(`[iteration-studio:${adapter.id}] Failed to persist history`, error);
        }
    };

    const rerender = () => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) return;
        popupRoot.find(`#${popupId}_sub`).text(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')));
        popupRoot.find(`#${popupId}_conversation`).html(renderConversation(adapter, session, popupId, {
            loading: isRunning,
            loadingText: i18n('AI iteration is running...'),
        }));
        popupRoot.find(`#${popupId}_pending`).html(renderPendingApproval(adapter, session, popupId));
        popupRoot.find(`#${popupId}_profile`).html(adapter.renderWorkingProfile(session, {
            profileOverride: null,
            previewPending: Boolean(session?.pendingApproval),
        }));
        popupRoot.find(`#${popupId}_history`).html(renderHistory(historyState, session?.id));
    };

    const setStatus = (text) => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) return;
        popupRoot.find(`#${popupId}_status`).text(String(text || ''));
    };

    const resetCurrentSession = async () => {
        const next = createEmptySession(adapter, context, settings);
        replaceSessionInPlace(session, next, adapter);
        await persist();
        rerender();
    };

    const loadSessionById = async (sessionId) => {
        const stored = findHistorySession(historyState, sessionId, adapter.mode);
        if (!stored) return false;
        replaceSessionInPlace(session, stored, adapter);
        await persist();
        rerender();
        return true;
    };

    const deleteSessionById = async (sessionId) => {
        const stored = findHistorySession(historyState, sessionId, adapter.mode);
        if (!stored) return false;
        historyState = deleteHistorySession(adapter, historyState, sessionId);
        try {
            await adapter.persistHistoryState(context, historyState, scope, activeAvatar);
        } catch (error) {
            console.warn(`[iteration-studio:${adapter.id}] Failed to delete session`, error);
        }
        if (String(session?.id || '') === String(sessionId).trim()) {
            const fallback = findLatestHistorySession(historyState, adapter.mode)
                || createEmptySession(adapter, context, settings);
            replaceSessionInPlace(session, fallback, adapter);
            await persist();
        }
        rerender();
        return true;
    };

    const maybeRunAutoContinue = async (executionResult, controller, source = 'approved') => {
        if (!executionResult || typeof executionResult !== 'object') {
            return false;
        }
        if (executionResult.finalized) {
            setStatus(source === 'approved'
                ? i18n('Changes approved and applied.')
                : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        if (executionResult.continueRequested) {
            setStatus(i18n('Running auto-continue...'));
            const autoPrompt = buildAutoContinuePrompt(adapter, executionResult);
            const followUp = await runIterationTurn(adapter, context, settings, session, autoPrompt, controller.signal, {
                auto: true,
                appendUserMessage: false,
                autoApply,
            });
            await persist();
            setStatus(followUp?.pending ? i18n('AI suggested changes are waiting for approval.') : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        return false;
    };

    const runVisibleTurn = async (text, { appendUserMessage = true, loadingText = '' } = {}) => {
        const safeText = String(text || '').trim();
        if (!safeText) return false;
        if (activeAbortController && !activeAbortController.signal.aborted) {
            return false;
        }
        const controller = new AbortController();
        activeAbortController = controller;
        if (appendUserMessage) {
            session.messages.push({ role: 'user', content: safeText, auto: false, at: Date.now() });
            trimSessionMessages(session);
            jQuery(selector).find(`#${popupId}_input`).val('');
            await persist();
        }
        isRunning = true;
        rerender();
        setStatus(loadingText || i18n('AI iteration is running...'));
        try {
            const result = await runIterationTurn(adapter, context, settings, session, safeText, controller.signal, { appendUserMessage: false, autoApply });
            await persist();
            if (result?.pending) {
                setStatus(i18n('AI suggested changes are waiting for approval.'));
            } else if (result?.autoApplied) {
                const handled = await maybeRunAutoContinue(result.executionResult, controller, 'auto');
                if (!handled) {
                    setStatus(i18n('AI iteration updated.'));
                }
            } else {
                setStatus(i18n('AI iteration updated.'));
            }
            rerender();
            return true;
        } catch (error) {
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
            return false;
        } finally {
            if (activeAbortController === controller) {
                activeAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    };

    const popup = new Popup(popupHtml, POPUP_TYPE.TEXT, '', {
        okButton: i18n('Close'),
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            const popupRoot = jQuery(selector);
            popupRoot.find('[data-iter-toggle="auto-apply"]').prop('checked', autoApply);
            rerender();
            zoomUnbind = bindZoomOverlayHandlers(selector, `.iterStudioZoom_${popupId}`);
        },
        onClose: () => {
            activeAbortController?.abort?.();
            zoomUnbind?.();
            zoomUnbind = null;
        },
    });

    jQuery(document).off(namespace);
    jQuery(document).on(`change${namespace}`, `${selector} [data-iter-toggle="auto-apply"]`, function () {
        autoApply = Boolean(jQuery(this).prop('checked'));
        setAutoApplyForAdapter(adapter.id, autoApply);
        setStatus(autoApply ? i18n('Auto-apply enabled.') : i18n('Auto-apply disabled.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="send"]`, async function () {
        const popupRoot = jQuery(selector);
        const input = popupRoot.find(`#${popupId}_input`);
        const text = String(input.val() || '').trim();
        if (!text) return;
        await runVisibleTurn(text, { appendUserMessage: true });
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="stop"]`, function () {
        if (activeAbortController && !activeAbortController.signal.aborted) {
            activeAbortController.abort();
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="clear"]`, async function () {
        await resetCurrentSession();
        setStatus(i18n('Iteration session reset.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="new-session"]`, async function () {
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        await resetCurrentSession();
        setStatus(i18n('New session created.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="load-session"]`, async function () {
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        const sessionId = String(this.getAttribute('data-iter-session-id') || '').trim();
        if (!sessionId) return;
        const loaded = await loadSessionById(sessionId);
        if (loaded) setStatus(i18n('Session loaded.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="delete-session"]`, async function (event) {
        event.stopPropagation();
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        const sessionId = String(this.getAttribute('data-iter-session-id') || '').trim();
        if (!sessionId) return;
        if (!window.confirm(i18n('Delete this saved session?'))) return;
        try {
            await deleteSessionById(sessionId);
            setStatus(i18n('Session deleted.'));
        } catch (error) {
            setStatus(i18nFormat('Delete session failed: ${0}', String(error?.message || error)));
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="approve"]`, async function () {
        const pending = session?.pendingApproval;
        if (!pending) return;
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        const controller = new AbortController();
        activeAbortController = controller;
        isRunning = true;
        rerender();
        const pendingSnapshot = {
            messageId: String(pending.messageId || ''),
            assistantText: String(pending.assistantText || ''),
            toolCalls: structuredClone(Array.isArray(pending.toolCalls) ? pending.toolCalls : []),
            executionToolCalls: structuredClone(Array.isArray(pending.executionToolCalls) ? pending.executionToolCalls : []),
            createdAt: Number(pending.createdAt || Date.now()),
        };
        session.pendingApproval = null;
        rerender();
        setStatus(i18n('Applying approved changes...'));
        try {
            const executionCalls = pendingSnapshot.executionToolCalls.length > 0
                ? pendingSnapshot.executionToolCalls
                : pendingSnapshot.toolCalls;
            const result = await applyApprovedToolCalls(adapter, context, session, executionCalls, controller.signal);
            const targetMessage = findMessageById(session.messages, pendingSnapshot.messageId);
            if (targetMessage) {
                const completedDiff = buildProfileDelta(adapter, targetMessage?.profileSnapshotBefore || session.baseWorkingProfile, session.workingProfile);
                targetMessage.tool_results = Array.isArray(result?.toolResults) ? result.toolResults : [];
                targetMessage.toolSummary = (result?.actions || []).join('\n') || i18n('AI iteration updated.');
                targetMessage.toolState = 'completed';
                targetMessage.profileSnapshotBefore = completedDiff.beforeProfile;
                targetMessage.profileDelta = completedDiff.delta;
                targetMessage.reverseProfileDelta = completedDiff.reverseDelta;
                targetMessage.profileSnapshotAfter = adapter.cloneWorkingProfile(session.workingProfile);
                targetMessage.lastSimulationAfter = session?.lastSimulation ? structuredClone(session.lastSimulation) : null;
            }
            trimSessionMessages(session);
            await persist();
            const handled = await maybeRunAutoContinue(result, controller, 'approved');
            if (!handled) {
                setStatus(i18n('Changes approved and applied. Waiting for your next instruction.'));
                rerender();
            }
        } catch (error) {
            if (!session.pendingApproval) {
                session.pendingApproval = pendingSnapshot;
                rerender();
            }
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
        } finally {
            if (activeAbortController === controller) {
                activeAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="reject"]`, function () {
        const pending = session?.pendingApproval;
        if (!pending) return;
        session.pendingApproval = null;
        const targetMessage = findMessageById(session.messages, pending?.messageId);
        if (targetMessage) {
            targetMessage.tool_results = buildRejectedToolResults(pending?.executionToolCalls || pending?.toolCalls || [], i18n('Changes rejected.'));
            targetMessage.toolSummary = i18n('Changes rejected.');
            targetMessage.toolState = 'rejected';
        }
        trimSessionMessages(session);
        void persist();
        setStatus(i18n('Changes rejected.'));
        rerender();
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="refresh-message"]`, async function () {
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        const messageIndex = parseInt(this.getAttribute('data-iter-message-index') || '-1', 10);
        if (!canRefreshAssistantMessage(session, messageIndex)) return;
        const userIndex = findPreviousUserMessageIndex(session.messages, messageIndex);
        if (userIndex < 0) return;
        const userText = String(session.messages[userIndex]?.content || '').trim();
        session.messages.splice(messageIndex);
        restoreSessionStateFromMessages(adapter, session);
        await persist();
        rerender();
        setStatus(i18n('Regenerating message...'));
        await runVisibleTurn(userText, { appendUserMessage: false, loadingText: i18n('Regenerating message...') });
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-action="rollback-message"]`, async function () {
        if (activeAbortController && !activeAbortController.signal.aborted) return;
        const messageIndex = parseInt(this.getAttribute('data-iter-message-index') || '-1', 10);
        if (!canRollbackAssistantMessage(session, messageIndex)) return;
        const removeFrom = getRollbackStartIndex(session.messages, messageIndex);
        if (!Number.isInteger(removeFrom) || removeFrom < 0) return;
        session.messages.splice(removeFrom);
        restoreSessionStateFromMessages(adapter, session);
        await persist();
        rerender();
        setStatus(i18n('Rolled back to selected round.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} [data-iter-custom-action]`, async function () {
        const actionId = String(this.getAttribute('data-iter-custom-action') || '').trim();
        if (!actionId) return;
        try {
            await adapter.handleAction?.(actionId, {
                session,
                context,
                settings,
                root,
                popupId,
                popupSelector: selector,
            });
        } catch (error) {
            setStatus(i18nFormat('Apply failed: ${0}', String(error?.message || error)));
        }
        rerender();
    });

    try {
        await popup.show();
    } finally {
        jQuery(document).off(namespace);
    }
}
