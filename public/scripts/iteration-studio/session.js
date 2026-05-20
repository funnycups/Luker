/**
 * IterationStudio — session helpers (IDE-shape).
 *
 * Owns the canonical in-memory Session shape and sanitization. Storage
 * is adapter-owned; this module produces in-memory objects only.
 *
 * Compared to the pre-SP-1 shape, drops:
 *   - workingProfile / baseWorkingProfile (no longer carried; adapter.live() is authority)
 *   - revision (use updatedAt for ordering)
 *   - chatKey (replaced by adapter.sessionScope())
 *   - lastSimulation (adapters that need simulate keep it in surfaceState)
 *   - profileSnapshotBefore/After / profileDelta / reverseProfileDelta on messages
 *
 * Adds:
 *   - surfaceState (adapter-owned opaque blob)
 *   - appliedEdits / rolledBack on messages (op-typed edits this turn wrote to live)
 *   - proposedEdits on PendingApproval (pre-conflict-resolution Edit[] for projection rendering)
 */

import {
    buildExecutionToolCalls,
    makeAiIterationMessageId,
    normalizePersistentToolCalls,
    normalizePersistentToolResults,
} from '../extensions/orchestrator/tool-calling.js';

const HISTORY_STATE_VERSION = 4;

export function makeSessionId() {
    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createEmptyHistoryState() {
    return { version: HISTORY_STATE_VERSION, sessions: [] };
}

export function createEmptySession(adapter, context) {
    const scope = adapter.sessionScope(context) || 'global';
    const avatar = scope.startsWith('character_')
        ? scope.slice('character_'.length)
        : '';
    const sourceName = avatar
        ? String(context?.characters?.find?.(c => c.avatar === avatar)?.name || avatar)
        : 'Global';
    const now = Date.now();
    return {
        id: makeSessionId(),
        mode: adapter.mode,
        sourceScope: scope,
        sourceAvatar: avatar,
        sourceName,
        createdAt: now,
        updatedAt: now,
        messages: [],
        pendingApproval: null,
    };
}

export function sanitizeSessionMessage(rawMessage) {
    const role = String(rawMessage?.role || 'assistant').trim().toLowerCase();
    const message = {
        id: String(rawMessage?.id || '').trim() || makeAiIterationMessageId('iter_msg'),
        role: role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant',
        content: String(rawMessage?.content || ''),
        auto: Boolean(rawMessage?.auto),
        at: Number(rawMessage?.at || Date.now()),
    };
    if (message.role !== 'assistant') {
        return message;
    }
    const toolCalls = normalizePersistentToolCalls(rawMessage);
    const toolResults = normalizePersistentToolResults(rawMessage, toolCalls);
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (toolResults.length > 0) message.tool_results = toolResults;
    if (rawMessage?.toolSummary) message.toolSummary = String(rawMessage.toolSummary);
    if (rawMessage?.toolState) message.toolState = String(rawMessage.toolState);
    if (Array.isArray(rawMessage?.pendingToolCalls)) {
        message.pendingToolCalls = buildExecutionToolCalls(rawMessage.pendingToolCalls);
    }
    if (Array.isArray(rawMessage?.executionToolCalls)) {
        message.executionToolCalls = buildExecutionToolCalls(rawMessage.executionToolCalls);
    }
    if (Array.isArray(rawMessage?.appliedEdits)) {
        message.appliedEdits = rawMessage.appliedEdits.map(e => ({ ...e }));
    }
    if (rawMessage?.rolledBack === true) {
        message.rolledBack = true;
    }
    return message;
}

export function sanitizeSession(rawSession, adapter) {
    if (!rawSession || typeof rawSession !== 'object') return null;
    const messages = Array.isArray(rawSession.messages)
        ? rawSession.messages.map(sanitizeSessionMessage)
        : [];
    const session = {
        id: String(rawSession.id || makeSessionId()),
        mode: String(rawSession.mode || adapter.mode),
        sourceScope: String(rawSession.sourceScope || 'global'),
        sourceAvatar: String(rawSession.sourceAvatar || ''),
        sourceName: String(rawSession.sourceName || ''),
        createdAt: Number(rawSession.createdAt || Date.now()),
        updatedAt: Number(rawSession.updatedAt || Date.now()),
        messages,
        pendingApproval: sanitizePendingApproval(rawSession.pendingApproval),
    };
    if (rawSession.surfaceState !== undefined) {
        session.surfaceState = rawSession.surfaceState;
    }
    return session;
}

export function sanitizePendingApproval(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        messageId: String(raw.messageId || ''),
        assistantText: String(raw.assistantText || ''),
        toolCalls: Array.isArray(raw.toolCalls) ? buildExecutionToolCalls(raw.toolCalls) : [],
        executionToolCalls: Array.isArray(raw.executionToolCalls)
            ? buildExecutionToolCalls(raw.executionToolCalls)
            : [],
        proposedEdits: Array.isArray(raw.proposedEdits)
            ? raw.proposedEdits.map(e => ({ ...e }))
            : [],
        createdAt: Number(raw.createdAt || Date.now()),
    };
}

export function trimSessionMessages(session, maxMessages = 200) {
    if (!session || !Array.isArray(session.messages)) return;
    if (session.messages.length > maxMessages) {
        session.messages.splice(0, session.messages.length - maxMessages);
    }
}

export function findMessageById(session, id) {
    if (!session || !Array.isArray(session.messages) || !id) return null;
    return session.messages.find(m => String(m?.id || '') === String(id)) || null;
}

export function defineAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') {
        throw new Error('defineAdapter: adapter must be an object');
    }
    const required = ['id', 'title', 'mode', 'layout', 'live', 'commit', 'sessionScope',
                      'listSessions', 'loadSession', 'saveSession', 'deleteSession',
                      'buildToolCatalog', 'normalizeToolCallToEdit',
                      'buildSystemPrompt', 'buildUserPrompt',
                      'renderMessageCard', 'renderHistoryItem'];
    for (const key of required) {
        if (adapter[key] === undefined) {
            throw new Error(`defineAdapter: missing required field "${key}"`);
        }
    }
    if (adapter.layout !== 'popup' && adapter.layout !== 'split') {
        throw new Error(`defineAdapter: layout must be "popup" or "split" (got "${adapter.layout}")`);
    }
    if (adapter.layout === 'split' && typeof adapter.renderPreviewPane !== 'function') {
        throw new Error('defineAdapter: layout="split" requires renderPreviewPane');
    }
    return adapter;
}
