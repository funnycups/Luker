/**
 * IterationStudio — session + history state + adapter helpers.
 *
 * Pure-ish module: no DOM, no jQuery, no popup. Owns the canonical Session
 * shape and the persistence convenience layer that most adapters reach for.
 *
 * Loosely follows the orchestrator's existing `normalizeAiIterationStored*`
 * patterns but treats `workingProfile` as opaque — only the adapter knows
 * how to clone it.
 */

import { extension_settings, getContext } from '../extensions.js';
import { saveSettingsDebounced } from '../../script.js';
import {
    buildExecutionToolCalls,
    findAiIterationMessageById,
    makeAiIterationMessageId,
    normalizePersistentToolCalls,
    normalizePersistentToolResults,
} from '../extensions/orchestrator/tool-calling.js';

const HISTORY_STATE_VERSION = 3;

export function makeSessionId() {
    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createEmptyHistoryState() {
    return { version: HISTORY_STATE_VERSION, sessions: [] };
}

function normalizeSessionMessage(adapter, rawMessage) {
    const role = String(rawMessage?.role || 'assistant').trim().toLowerCase();
    const message = {
        id: String(rawMessage?.id || '').trim() || makeAiIterationMessageId(`${adapter.id}_msg`),
        role: role === 'user' ? 'user' : 'assistant',
        content: String(rawMessage?.content || ''),
        auto: Boolean(rawMessage?.auto),
        at: Number(rawMessage?.at || Date.now()),
    };

    if (message.role !== 'assistant') {
        return message;
    }

    const toolCalls = normalizePersistentToolCalls(rawMessage);
    const toolResults = normalizePersistentToolResults(rawMessage, toolCalls);
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }
    if (toolResults.length > 0) {
        message.tool_results = toolResults;
    }
    if (rawMessage?.toolSummary) {
        message.toolSummary = String(rawMessage.toolSummary || '');
    }
    if (rawMessage?.toolState) {
        message.toolState = String(rawMessage.toolState || '');
    }
    if (Array.isArray(rawMessage?.pendingToolCalls)) {
        message.pendingToolCalls = buildExecutionToolCalls(rawMessage.pendingToolCalls);
    }
    if (Array.isArray(rawMessage?.executionToolCalls)) {
        message.executionToolCalls = buildExecutionToolCalls(rawMessage.executionToolCalls);
    }
    if (rawMessage?.profileSnapshotBefore && typeof rawMessage.profileSnapshotBefore === 'object') {
        message.profileSnapshotBefore = adapter.cloneWorkingProfile(rawMessage.profileSnapshotBefore);
    }
    if (rawMessage?.profileSnapshotAfter && typeof rawMessage.profileSnapshotAfter === 'object') {
        message.profileSnapshotAfter = adapter.cloneWorkingProfile(rawMessage.profileSnapshotAfter);
    }
    if (rawMessage?.profileDelta && typeof rawMessage.profileDelta === 'object') {
        message.profileDelta = structuredClone(rawMessage.profileDelta);
    }
    if (rawMessage?.reverseProfileDelta && typeof rawMessage.reverseProfileDelta === 'object') {
        message.reverseProfileDelta = structuredClone(rawMessage.reverseProfileDelta);
    }
    if (rawMessage?.lastSimulationAfter && typeof rawMessage.lastSimulationAfter === 'object') {
        message.lastSimulationAfter = structuredClone(rawMessage.lastSimulationAfter);
    }
    return message;
}

export function ensureBaseWorkingProfile(adapter, session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    if (!session.baseWorkingProfile || typeof session.baseWorkingProfile !== 'object') {
        session.baseWorkingProfile = adapter.cloneWorkingProfile(session.workingProfile);
    }
}

export function restoreSessionStateFromMessages(adapter, session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    ensureBaseWorkingProfile(adapter, session);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const snapshotMessage = [...messages]
        .reverse()
        .find(item => item?.profileSnapshotAfter && typeof item.profileSnapshotAfter === 'object');
    session.workingProfile = adapter.cloneWorkingProfile(
        snapshotMessage?.profileSnapshotAfter || session.baseWorkingProfile,
    );
    session.lastSimulation = snapshotMessage?.lastSimulationAfter
        ? structuredClone(snapshotMessage.lastSimulationAfter)
        : null;

    const pendingMessage = [...messages]
        .reverse()
        .find(item => item?.toolState === 'pending' && (
            Array.isArray(item?.tool_calls) || Array.isArray(item?.pendingToolCalls)
        ));
    if (!pendingMessage) {
        session.pendingApproval = null;
        return;
    }
    const fallbackApproval = Array.isArray(pendingMessage?.pendingToolCalls)
        ? pendingMessage.pendingToolCalls
        : buildExecutionToolCalls(pendingMessage?.tool_calls || []);
    const fallbackExecution = Array.isArray(pendingMessage?.executionToolCalls)
        ? pendingMessage.executionToolCalls
        : fallbackApproval;
    session.pendingApproval = {
        messageId: String(pendingMessage.id || ''),
        assistantText: String(pendingMessage.content || ''),
        toolCalls: structuredClone(fallbackApproval),
        executionToolCalls: structuredClone(fallbackExecution),
        createdAt: Number(pendingMessage.at || Date.now()),
    };
}

export function normalizeStoredSession(adapter, rawSession) {
    const baseWorkingProfile = adapter.cloneWorkingProfile(
        rawSession?.baseWorkingProfile ?? rawSession?.workingProfile ?? adapter.getInitialProfile(getContext(), {}),
    );
    const session = {
        id: String(rawSession?.id || '').trim() || makeSessionId(),
        mode: String(rawSession?.mode || adapter.mode || '').trim() || adapter.mode,
        chatKey: String(rawSession?.chatKey || '').trim(),
        sourceScope: String(rawSession?.sourceScope || '').trim() === 'character' ? 'character' : 'global',
        sourceAvatar: String(rawSession?.sourceAvatar || '').trim(),
        sourceName: String(rawSession?.sourceName || '').trim(),
        revision: Math.max(1, Math.floor(Number(rawSession?.revision) || 1)),
        createdAt: Number(rawSession?.createdAt || Date.now()),
        updatedAt: Number(rawSession?.updatedAt || rawSession?.createdAt || Date.now()),
        workingProfile: adapter.cloneWorkingProfile(rawSession?.workingProfile ?? baseWorkingProfile),
        baseWorkingProfile,
        messages: (Array.isArray(rawSession?.messages) ? rawSession.messages : [])
            .map(item => normalizeSessionMessage(adapter, item)),
        lastSimulation: rawSession?.lastSimulation && typeof rawSession.lastSimulation === 'object'
            ? structuredClone(rawSession.lastSimulation)
            : null,
        pendingApproval: null,
    };
    restoreSessionStateFromMessages(adapter, session);
    return session;
}

export function replaceSessionInPlace(targetSession, sourceSession, adapter) {
    if (!targetSession || typeof targetSession !== 'object') {
        return sourceSession;
    }
    const normalized = normalizeStoredSession(adapter, sourceSession);
    for (const key of Object.keys(targetSession)) {
        delete targetSession[key];
    }
    Object.assign(targetSession, normalized);
    return targetSession;
}

function normalizeHistoryState(adapter, rawState, historyLimit) {
    if (Number(rawState?.version || 0) !== HISTORY_STATE_VERSION) {
        return createEmptyHistoryState();
    }
    const sessions = (Array.isArray(rawState?.sessions) ? rawState.sessions : [])
        .map(session => normalizeStoredSession(adapter, session))
        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    return {
        version: HISTORY_STATE_VERSION,
        sessions: sessions.slice(-Math.max(1, Math.floor(Number(historyLimit) || 24))),
    };
}

export function upsertHistorySession(adapter, historyState, session, { historyLimit = 24 } = {}) {
    const normalizedState = normalizeHistoryState(adapter, historyState, historyLimit);
    const normalizedSession = normalizeStoredSession(adapter, session);
    const nextSessions = normalizedState.sessions
        .filter(item => String(item?.id || '') !== String(normalizedSession.id || ''));
    nextSessions.push(normalizedSession);
    nextSessions.sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    normalizedState.sessions = nextSessions.slice(-Math.max(1, Math.floor(Number(historyLimit) || 24)));
    return normalizedState;
}

export function deleteHistorySession(adapter, historyState, sessionId, { historyLimit = 24 } = {}) {
    const normalizedState = normalizeHistoryState(adapter, historyState, historyLimit);
    const targetId = String(sessionId || '').trim();
    normalizedState.sessions = normalizedState.sessions.filter(item => String(item?.id || '') !== targetId);
    return normalizedState;
}

function filterByMode(sessions, modeFilter) {
    if (!modeFilter) {
        return sessions;
    }
    const target = String(modeFilter || '').trim();
    return sessions.filter(item => String(item?.mode || '').trim() === target);
}

export function findHistorySession(historyState, sessionId, modeFilter = null) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return filterByMode(Array.isArray(historyState?.sessions) ? historyState.sessions : [], modeFilter)
        .find(item => String(item?.id || '') === targetId) || null;
}

export function findLatestHistorySession(historyState, modeFilter = null) {
    const sessions = filterByMode(Array.isArray(historyState?.sessions) ? historyState.sessions : [], modeFilter);
    return sessions.length > 0 ? sessions[sessions.length - 1] : null;
}

/**
 * Standard settings-backed history store. Adapters that want the conventional
 * "global goes to extension_settings, character goes to character state"
 * pattern can spread the returned object into their adapter definition:
 *
 *     ...createSettingsBackedHistoryStore({
 *         moduleName: 'memory_graph',
 *         globalSettingsKey: 'schemaIterationHistory',
 *         characterStateNamespace: 'mg_schema_iteration_history',
 *     })
 *
 * `modeFilter` lets multiple adapters share one underlying store but each
 * adapter only sees sessions matching its own `mode` (orchestrator's three
 * adapters use this so existing history doesn't have to be migrated).
 */
export function createSettingsBackedHistoryStore({
    moduleName,
    globalSettingsKey,
    characterStateNamespace,
    historyLimit = 24,
    modeFilter = null,
} = {}) {
    if (!moduleName || !globalSettingsKey || !characterStateNamespace) {
        throw new Error('createSettingsBackedHistoryStore: moduleName, globalSettingsKey, characterStateNamespace are required.');
    }

    return {
        async loadHistoryState(context, scope, avatar) {
            if (scope === 'character' && String(avatar || '').trim()) {
                const raw = typeof context?.getCharacterState === 'function'
                    ? await context.getCharacterState(avatar, characterStateNamespace)
                    : null;
                const state = normalizeHistoryState(this, raw || createEmptyHistoryState(), historyLimit);
                state.sessions = filterByMode(state.sessions, modeFilter);
                return state;
            }
            if (!extension_settings[moduleName]) {
                extension_settings[moduleName] = {};
            }
            const raw = extension_settings[moduleName][globalSettingsKey];
            const state = normalizeHistoryState(this, raw, historyLimit);
            state.sessions = filterByMode(state.sessions, modeFilter);
            return state;
        },
        async persistHistoryState(context, state, scope, avatar) {
            if (scope === 'character' && String(avatar || '').trim()) {
                if (typeof context?.setCharacterState !== 'function') {
                    return;
                }
                if (!modeFilter) {
                    await context.setCharacterState(avatar, characterStateNamespace,
                        normalizeHistoryState(this, state, historyLimit));
                    return;
                }
                // mode-shared bucket: merge with sessions from other modes so we
                // don't trample sibling adapters that share storage.
                const fullRaw = await context.getCharacterState(avatar, characterStateNamespace);
                const full = normalizeHistoryState(this, fullRaw || createEmptyHistoryState(), historyLimit);
                const other = full.sessions.filter(item => String(item?.mode || '').trim() !== String(modeFilter).trim());
                const merged = filterByMode(state.sessions, modeFilter);
                const next = {
                    version: HISTORY_STATE_VERSION,
                    sessions: [...other, ...merged]
                        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))
                        .slice(-Math.max(1, Math.floor(Number(historyLimit) || 24))),
                };
                await context.setCharacterState(avatar, characterStateNamespace, next);
                return;
            }
            if (!extension_settings[moduleName]) {
                extension_settings[moduleName] = {};
            }
            if (!modeFilter) {
                extension_settings[moduleName][globalSettingsKey] = normalizeHistoryState(this, state, historyLimit);
            } else {
                const fullRaw = extension_settings[moduleName][globalSettingsKey];
                const full = normalizeHistoryState(this, fullRaw || createEmptyHistoryState(), historyLimit);
                const other = full.sessions.filter(item => String(item?.mode || '').trim() !== String(modeFilter).trim());
                const merged = filterByMode(state.sessions, modeFilter);
                extension_settings[moduleName][globalSettingsKey] = {
                    version: HISTORY_STATE_VERSION,
                    sessions: [...other, ...merged]
                        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))
                        .slice(-Math.max(1, Math.floor(Number(historyLimit) || 24))),
                };
            }
            saveSettingsDebounced();
        },
    };
}

/**
 * Fill in optional ProfileAdapter defaults so authors only write what they
 * care about. The returned object is the same shape — caller can spread or
 * extend it freely.
 */
export function defineAdapter(spec = {}) {
    const required = [
        'id', 'title', 'mode', 'i18n', 'i18nFormat',
        'getInitialProfile', 'cloneWorkingProfile',
        'loadHistoryState', 'persistHistoryState', 'getDefaultScope',
        'buildSystemPrompt', 'buildUserPrompt',
        'buildEditableToolSet', 'executeEditableToolCall',
        'renderWorkingProfile',
    ];
    const missing = required.filter(key => spec[key] === undefined || spec[key] === null);
    if (missing.length > 0) {
        throw new Error(`defineAdapter: missing required fields: ${missing.join(', ')}`);
    }

    return {
        i18nFormat: (key, ...args) => spec.i18n(key).replace(/\$\{(\d+)\}/g, (_, idx) => String(args[Number(idx)] ?? '')),
        getGlobalBaselineProfile: () => null,
        describeTool: (name) => String(name || ''),
        ensureStyles: () => {},
        handleAction: () => {},
        ...spec,
    };
}

// ---- generic message helpers (mode-agnostic) ----------------------------

export function trimSessionMessages(session) {
    if (!session || !Array.isArray(session.messages)) {
        if (session) {
            session.messages = [];
        }
    }
}

export function findPreviousUserMessageIndex(messages, startIndex) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = Math.min(startIndex - 1, list.length - 1); i >= 0; i -= 1) {
        if (String(list[i]?.role || '').trim().toLowerCase() === 'user') {
            return i;
        }
    }
    return -1;
}

export function getRollbackStartIndex(messages, messageIndex) {
    const list = Array.isArray(messages) ? messages : [];
    const index = Number.isInteger(messageIndex) ? messageIndex : -1;
    if (index < 0 || index >= list.length) {
        return -1;
    }
    let removeFrom = index;
    const previous = removeFrom > 0 ? list[removeFrom - 1] : null;
    if (String(list[removeFrom]?.role || '').trim().toLowerCase() === 'assistant'
        && String(previous?.role || '').trim().toLowerCase() === 'user') {
        removeFrom -= 1;
    }
    return removeFrom;
}

export function canRefreshAssistantMessage(session, messageIndex) {
    const list = Array.isArray(session?.messages) ? session.messages : [];
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= list.length) {
        return false;
    }
    const message = list[messageIndex];
    if (String(message?.role || '').toLowerCase() !== 'assistant') {
        return false;
    }
    if (message?.auto) {
        return false;
    }
    return findPreviousUserMessageIndex(list, messageIndex) >= 0;
}

export function canRollbackAssistantMessage(session, messageIndex) {
    const list = Array.isArray(session?.messages) ? session.messages : [];
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= list.length) {
        return false;
    }
    const message = list[messageIndex];
    if (String(message?.role || '').toLowerCase() !== 'assistant') {
        return false;
    }
    if (message?.toolState !== 'completed') {
        return false;
    }
    return Boolean(message?.profileDelta && message?.profileSnapshotAfter);
}

export { findAiIterationMessageById as findMessageById };

// ---- studio-level preferences ----------------------------------------------

const STUDIO_PREFS_KEY = 'iterationStudio';

function getStudioPrefsRoot() {
    if (!extension_settings[STUDIO_PREFS_KEY] || typeof extension_settings[STUDIO_PREFS_KEY] !== 'object') {
        extension_settings[STUDIO_PREFS_KEY] = {};
    }
    if (!extension_settings[STUDIO_PREFS_KEY].autoApply || typeof extension_settings[STUDIO_PREFS_KEY].autoApply !== 'object') {
        extension_settings[STUDIO_PREFS_KEY].autoApply = {};
    }
    return extension_settings[STUDIO_PREFS_KEY];
}

/**
 * Per-adapter auto-apply preference. When true, the studio skips the
 * manual Approve step for editable tool calls — they execute immediately
 * just like control tools do. Storage is keyed by adapter.id so each
 * studio remembers its own preference independently.
 */
export function getAutoApplyForAdapter(adapterId) {
    return Boolean(getStudioPrefsRoot().autoApply[String(adapterId || '').trim()]);
}

export function setAutoApplyForAdapter(adapterId, value) {
    const id = String(adapterId || '').trim();
    if (!id) return;
    const root = getStudioPrefsRoot();
    if (value) {
        root.autoApply[id] = true;
    } else {
        delete root.autoApply[id];
    }
    saveSettingsDebounced();
}
