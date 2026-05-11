/**
 * IterationStudio — render helpers.
 *
 * All renderers return HTML strings (the shell does jQuery .html() updates).
 * Chrome strings ("Conversation", "Refresh", etc.) come from the shell's
 * own i18n table; adapter-specific bits (tool descriptions, working-profile
 * preview) are delegated to adapter methods.
 */

import { escapeHtml } from '../utils.js';
import { renderProfileDeltaHtml } from './delta.js';
import { i18n, i18nFormat } from './i18n.js';

function describeToolCalls(adapter, toolCalls = []) {
    return (Array.isArray(toolCalls) ? toolCalls : [])
        .map(call => String(call?.name || call?.function?.name || ''))
        .filter(Boolean)
        .map(name => adapter.describeTool?.(name) || name);
}

function renderMessageDiff(adapter, session, message, popupId) {
    if (typeof adapter.renderMessageDiff === 'function') {
        try {
            return adapter.renderMessageDiff(session, message, popupId) || '';
        } catch (error) {
            console.warn('[iteration-studio] adapter.renderMessageDiff threw', error);
        }
    }
    if (!message?.profileDelta) {
        return '';
    }
    const beforeProfile = message?.profileSnapshotBefore || session?.baseWorkingProfile;
    if (!beforeProfile) {
        return '';
    }
    return renderProfileDeltaHtml(adapter, message.profileDelta, beforeProfile, {
        beforeLabel: i18n('Before'),
        afterLabel: i18n('After'),
        missingLabel: i18n('(missing)'),
    });
}

function canControl(message, kind) {
    if (!message || message?.role !== 'assistant') {
        return false;
    }
    if (kind === 'refresh') {
        return !message.auto && (message.toolState === 'completed' || !message.toolState);
    }
    if (kind === 'rollback') {
        return message.toolState === 'completed' && Boolean(message.profileSnapshotAfter);
    }
    return false;
}

function renderAssistantToolTurn(adapter, session, message, messageIndex, popupId) {
    const summary = String(message?.toolSummary || '').trim();
    const summaryLine = summary
        ? `<div class="luker-studio-msg-summary">${escapeHtml(summary)}</div>`
        : '';
    const stateClass = message?.toolState === 'rejected'
        ? 'is-rejected'
        : (message?.toolState === 'pending' ? 'is-pending' : 'is-completed');
    // Show diff for pending (projected) and completed states; hide for rejected.
    const showDiff = Boolean(message?.profileDelta) && message?.toolState !== 'rejected';
    const diffHtml = showDiff ? renderMessageDiff(adapter, session, message, popupId) : '';
    const diffBlock = diffHtml
        ? `<details class="luker-studio-msg-diff luker-studio-diff" open><summary>${escapeHtml(i18n('Profile changes'))}</summary>${diffHtml}</details>`
        : '';
    const toolNames = describeToolCalls(adapter, message?.tool_calls || message?.pendingToolCalls || []);
    const toolNamesLine = toolNames.length > 0
        ? `<div class="luker-studio-msg-tools">${escapeHtml(i18nFormat('Tools: ${0}', toolNames.join(', ')))}</div>`
        : '';
    const refreshable = canControl(message, 'refresh');
    const rollbackable = canControl(message, 'rollback');
    const controls = (refreshable || rollbackable)
        ? `<div class="luker-studio-msg-controls">
            ${refreshable ? `<div class="menu_button menu_button_small" data-iter-action="refresh-message" data-iter-message-index="${messageIndex}">${escapeHtml(i18n('Refresh'))}</div>` : ''}
            ${rollbackable ? `<div class="menu_button menu_button_small" data-iter-action="rollback-message" data-iter-message-index="${messageIndex}">${escapeHtml(i18n('Rollback to here'))}</div>` : ''}
        </div>`
        : '';
    const autoBadge = message?.auto
        ? `<span class="luker-studio-msg-badge">${escapeHtml(i18n('auto'))}</span>`
        : '';
    const body = String(message?.content || '').trim();
    return `
<div class="luker-studio-msg luker-studio-msg-assistant ${stateClass}">
    <div class="luker-studio-msg-role">${escapeHtml(i18n('Assistant'))} ${autoBadge}</div>
    ${body ? `<div class="luker-studio-msg-body">${escapeHtml(body)}</div>` : ''}
    ${toolNamesLine}
    ${summaryLine}
    ${diffBlock}
    ${controls}
</div>`;
}

function renderUserMessage(message) {
    const body = String(message?.content || '').trim();
    return `
<div class="luker-studio-msg luker-studio-msg-user">
    <div class="luker-studio-msg-role">${escapeHtml(i18n('User'))}</div>
    <div class="luker-studio-msg-body">${escapeHtml(body)}</div>
</div>`;
}

function renderSystemMessage(message) {
    const body = String(message?.content || '').trim();
    return `
<div class="luker-studio-msg luker-studio-msg-system">
    <div class="luker-studio-msg-role">${escapeHtml(i18n('System'))}</div>
    <div class="luker-studio-msg-body">${escapeHtml(body)}</div>
</div>`;
}

export function renderConversation(adapter, session, popupId, { loading = false, loadingText = '' } = {}) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const messageHtml = messages.map((message, index) => {
        const role = String(message?.role || '').trim().toLowerCase();
        if (role === 'user') return renderUserMessage(message);
        if (role === 'system') return renderSystemMessage(message);
        const hasTools = (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
            || (Array.isArray(message?.pendingToolCalls) && message.pendingToolCalls.length > 0)
            || message?.toolState;
        if (hasTools) {
            return renderAssistantToolTurn(adapter, session, message, index, popupId);
        }
        const body = String(message?.content || '').trim();
        return `
<div class="luker-studio-msg luker-studio-msg-assistant">
    <div class="luker-studio-msg-role">${escapeHtml(i18n('Assistant'))}</div>
    <div class="luker-studio-msg-body">${escapeHtml(body)}</div>
</div>`;
    }).join('');

    const loadingHtml = loading
        ? `<div class="luker-studio-msg luker-studio-msg-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(loadingText || i18n('AI iteration is running...'))}</div>`
        : '';
    return messageHtml + loadingHtml;
}

export function renderPendingApproval(adapter, session, popupId) {
    const pending = session?.pendingApproval;
    if (!pending) {
        return '';
    }
    const toolNames = describeToolCalls(adapter, pending.toolCalls || []);
    const toolNameLine = toolNames.length > 0
        ? `<div class="luker-studio-pending-tools">${escapeHtml(i18nFormat('Proposed tools: ${0}', toolNames.join(', ')))}</div>`
        : '';
    const assistantText = String(pending.assistantText || '').trim();
    return `
<div class="luker-studio-pending">
    <div class="luker-studio-pending-title">${escapeHtml(i18n('Changes proposed by AI'))}</div>
    ${assistantText ? `<div class="luker-studio-pending-body">${escapeHtml(assistantText)}</div>` : ''}
    ${toolNameLine}
    <div class="luker-studio-pending-buttons">
        <div id="${popupId}_approve" class="menu_button" data-iter-action="approve">${escapeHtml(i18n('Approve & Apply'))}</div>
        <div id="${popupId}_reject" class="menu_button" data-iter-action="reject">${escapeHtml(i18n('Reject'))}</div>
    </div>
</div>`;
}

function summarizeHistorySession(session) {
    const firstUser = (Array.isArray(session?.messages) ? session.messages : [])
        .find(item => String(item?.role || '').toLowerCase() === 'user');
    const summary = String(firstUser?.content || '').trim()
        || String(session?.sourceName || '').trim()
        || i18n('(empty session)');
    return summary.length > 72 ? `${summary.slice(0, 72).trim()}...` : summary;
}

export function renderHistory(historyState, activeSessionId) {
    const sessions = Array.isArray(historyState?.sessions) ? historyState.sessions : [];
    if (sessions.length === 0) {
        return `<div class="luker-studio-history-empty">${escapeHtml(i18n('No saved sessions yet.'))}</div>`;
    }
    return sessions.slice().reverse().map((session) => {
        const id = String(session?.id || '');
        const isActive = id === String(activeSessionId || '');
        const summary = summarizeHistorySession(session);
        const scopeLabel = session?.sourceScope === 'character'
            ? i18nFormat('Character: ${0}', String(session?.sourceName || ''))
            : i18n('Global');
        return `
<div class="luker-studio-history-item${isActive ? ' is-active' : ''}" data-iter-action="load-session" data-iter-session-id="${escapeHtml(id)}">
    <div class="luker-studio-history-summary">${escapeHtml(summary)}</div>
    <div class="luker-studio-history-meta">${escapeHtml(scopeLabel)}</div>
    <div class="menu_button menu_button_small luker-studio-history-delete" data-iter-action="delete-session" data-iter-session-id="${escapeHtml(id)}">${escapeHtml(i18n('Delete'))}</div>
</div>`;
    }).join('');
}
