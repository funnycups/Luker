// SPDX-License-Identifier: AGPL-3.0-or-later
//
// State-backed conversation storage for Ask and AI iteration.
// Routed by scope across Luker's Global / Character / Preset / Chat State APIs.
// Preserves full turn text, reasoning, tool arguments, and results with zero
// truncation or eviction caps.

import { i18n } from '../i18n.js';
import { SourceError } from './errors.js';

export const SESSIONS_NAMESPACE = 'workbench_sessions';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function normalizeSessions(state) {
    return Array.isArray(state?.sessions) ? state.sessions : [];
}

function assertOk(res, op) {
    if (!res || res.ok !== true) {
        const detail = res?.hint || res?.reason || `Session ${op} failed`;
        throw new SourceError('storage-error', String(detail));
    }
}

function resolveAdapter(ctx, scopeOpts = {}) {
    if (!ctx) {
        throw new SourceError('unavailable', 'Luker context is unavailable');
    }
    const scope = String(scopeOpts?.scope || 'global').trim().toLowerCase();

    if (scope === 'global') {
        if (typeof ctx.getGlobalState !== 'function' || typeof ctx.updateGlobalState !== 'function') {
            throw new SourceError('unsupported', 'Global state API is unavailable');
        }
        return {
            key: 'global',
            read: () => ctx.getGlobalState(SESSIONS_NAMESPACE),
            update: (updater) => ctx.updateGlobalState(SESSIONS_NAMESPACE, updater),
        };
    }

    if (scope === 'character') {
        const avatar = String(scopeOpts?.avatar || ctx.characters?.[ctx.characterId]?.avatar || '').trim();
        if (!avatar) {
            throw new SourceError('validation', i18n('No character card selected'));
        }
        if (typeof ctx.getCharacterState !== 'function' || typeof ctx.updateCharacterState !== 'function') {
            throw new SourceError('unsupported', 'Character state API is unavailable');
        }
        return {
            key: `character:${avatar}`,
            read: () => ctx.getCharacterState(avatar, SESSIONS_NAMESPACE),
            update: (updater) => ctx.updateCharacterState(avatar, SESSIONS_NAMESPACE, updater),
        };
    }

    if (scope === 'preset') {
        if (typeof ctx.presets?.state?.get !== 'function' || typeof ctx.presets?.state?.update !== 'function') {
            throw new SourceError('unsupported', 'Preset state API is unavailable');
        }
        const target = scopeOpts?.target ?? null;
        const collection = scopeOpts?.collection ?? 'openai';
        const stateOpts = target ? { target } : { collection };
        return {
            key: `preset:${JSON.stringify(target || collection)}`,
            read: () => ctx.presets.state.get(SESSIONS_NAMESPACE, stateOpts),
            update: (updater) => ctx.presets.state.update(SESSIONS_NAMESPACE, updater, stateOpts),
        };
    }

    if (scope === 'chat') {
        if (typeof ctx.getChatState !== 'function' || typeof ctx.updateChatState !== 'function') {
            throw new SourceError('unsupported', 'Chat state API is unavailable');
        }
        const target = scopeOpts?.target ?? null;
        const stateOpts = target ? { target } : {};
        return {
            key: `chat:${target ? JSON.stringify(target) : String(ctx.getCurrentChatId?.() || 'active')}`,
            read: () => ctx.getChatState(SESSIONS_NAMESPACE, stateOpts),
            update: (updater) => ctx.updateChatState(SESSIONS_NAMESPACE, updater, stateOpts),
        };
    }

    throw new SourceError('validation', `Unknown session scope: ${scope}`);
}

/**
 * State-backed session store.
 * @param {object | (() => object)} ctxOrProvider
 */
export function createSessionStore(ctxOrProvider = null) {
    const idToScope = new Map();

    const getCtx = () => (typeof ctxOrProvider === 'function'
        ? ctxOrProvider()
        : (ctxOrProvider || globalThis.Luker?.getContext?.() || globalThis.lukerContext || null));

    const rememberScopes = (scopeOpts, sessions) => {
        for (const s of sessions) {
            if (s?.id) idToScope.set(s.id, clone(scopeOpts));
        }
    };

    return {
        async list(kind = null, scopeOpts = {}) {
            const adapter = resolveAdapter(getCtx(), scopeOpts);
            const res = await adapter.read();
            assertOk(res, 'read');
            const sessions = normalizeSessions(res.state);
            rememberScopes(scopeOpts, sessions);
            return sessions
                .filter(s => !kind || s.kind === kind)
                .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
                .map(clone);
        },

        async get(id, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            const res = await adapter.read();
            assertOk(res, 'read');
            const sessions = normalizeSessions(res.state);
            rememberScopes(effectiveScope, sessions);
            const found = sessions.find(s => s.id === id);
            return found ? clone(found) : null;
        },

        async create(fields, scopeOpts = {}) {
            const adapter = resolveAdapter(getCtx(), scopeOpts);
            const now = Date.now();
            const session = {
                id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                title: '',
                createdAt: now,
                updatedAt: now,
                turns: [],
                ...clone(fields),
            };
            const res = await adapter.update((current) => {
                const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
                return { ...base, sessions: [session, ...normalizeSessions(base)] };
            });
            assertOk(res, 'create');
            rememberScopes(scopeOpts, normalizeSessions(res.state));
            idToScope.set(session.id, clone(scopeOpts));
            return clone(session);
        },

        async update(id, patch, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            let updatedSession = null;
            const res = await adapter.update((current) => {
                const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
                const list = normalizeSessions(base);
                const idx = list.findIndex(s => s.id === id);
                if (idx < 0) return null;
                updatedSession = { ...list[idx], ...clone(patch), updatedAt: Date.now() };
                const nextList = list.slice();
                nextList[idx] = updatedSession;
                return { ...base, sessions: nextList };
            });
            assertOk(res, 'update');
            if (!updatedSession) return null;
            rememberScopes(effectiveScope, normalizeSessions(res.state));
            idToScope.set(id, clone(effectiveScope));
            return clone(updatedSession);
        },

        async remove(id, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            const res = await adapter.update((current) => {
                const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
                const list = normalizeSessions(base);
                const nextList = list.filter(s => s.id !== id);
                if (nextList.length === list.length) return null;
                return { ...base, sessions: nextList };
            });
            assertOk(res, 'remove');
            if (res.state) {
                rememberScopes(effectiveScope, normalizeSessions(res.state));
            }
            idToScope.delete(id);
        },
    };
}

/** Today / Earlier grouping for the session list. */
export function groupSessions(list, now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const today = list.filter(s => s.updatedAt >= start.getTime());
    const older = list.filter(s => s.updatedAt < start.getTime());
    return [
        today.length ? { label: i18n('Today'), items: today } : null,
        older.length ? { label: i18n('Earlier'), items: older } : null,
    ].filter(Boolean);
}

/** Session title from the first question. */
export function titleFrom(text) {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > 28 ? `${one.slice(0, 27)}…` : one || i18n('New conversation');
}
