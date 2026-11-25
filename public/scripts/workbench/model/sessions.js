// SPDX-License-Identifier: AGPL-3.0-or-later
//
// State-backed conversation storage for Ask and AI iteration.
// Routed by scope across Luker's Global / Character / Preset / Chat State APIs.
//
// Layout (v2):
//   - Index (`workbench_sessions`): lightweight metadata only (id, kind, ws,
//     scope, scopeName, title, createdAt, updatedAt, pendingCount, etc.) plus
//     `legacyImported`. Listing sessions reads only this compact index.
//   - Body (`workbench_session_<id>`): full conversation record preserving
//     complete turns, messages, reasoning, tool arguments, and results with
//     zero truncation or eviction caps. Loaded lazily on `get(id)`.
//
// Existing v1 inline `workbench_sessions` documents are migrated lazily on
// first read: every session body is written and verified before the index is
// shrunk, ensuring zero data loss on partial failure.

import { i18n } from '../i18n.js';
import { SourceError } from './errors.js';

export const SESSIONS_NAMESPACE = 'workbench_sessions';
export const SESSIONS_INDEX_VERSION = 2;
export const SESSION_BODY_PREFIX = 'workbench_session_';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessions(state) {
    return Array.isArray(state?.sessions) ? state.sessions : [];
}

function assertOk(res, op) {
    if (!res || res.ok !== true) {
        const detail = res?.hint || res?.reason || `Session ${op} failed`;
        throw new SourceError('storage-error', String(detail));
    }
}

function hashPair(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

/**
 * Deterministic, lowercase, collision-safe state namespace for one session body.
 * Fits within both the 96-char character/chat/preset namespace cap and the
 * 128-byte global state key cap across all storage engines.
 */
export function sessionBodyNamespace(id) {
    const raw = String(id || '').trim();
    if (!raw) {
        throw new SourceError('validation', 'Session id is required');
    }
    if (/^[a-z0-9_-]{1,48}$/.test(raw)) {
        return `${SESSION_BODY_PREFIX}${raw}`;
    }
    const prefix = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24) || 's';
    return `${SESSION_BODY_PREFIX}${prefix}_${hashPair(raw)}`;
}

/** Number of pending changes in the latest AI turn, or precomputed index count. */
export function computePendingCount(session) {
    if (Array.isArray(session?.turns)) {
        const last = [...session.turns].reverse().find(t => t?.role === 'ai' && t.changes?.length);
        return last && last.state === 'pending' ? last.changes.length : 0;
    }
    const n = Number(session?.pendingCount);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether a session entry inside the index still carries inline body payloads (v1 layout). */
export function isInlineSession(session) {
    return isPlainObject(session) && ('turns' in session || 'messages' in session || 'note' in session);
}

/** Projects a full session record down to its lightweight index summary. */
export function toSessionSummary(session) {
    const entry = {
        id: String(session?.id || ''),
        kind: session?.kind ?? 'iterate',
        title: String(session?.title ?? ''),
        createdAt: Number(session?.createdAt) || 0,
        updatedAt: Number(session?.updatedAt) || 0,
        pendingCount: computePendingCount(session),
    };
    if (session?.ws !== undefined && session.ws !== '') entry.ws = session.ws;
    if (session?.scope !== undefined && session.scope !== '') entry.scope = session.scope;
    if (session?.scopeName !== undefined && session.scopeName !== '') entry.scopeName = session.scopeName;
    if (session?.targetId !== undefined && session.targetId !== '') entry.targetId = session.targetId;
    if (session?.forkedFrom !== undefined && session.forkedFrom !== '') entry.forkedFrom = session.forkedFrom;
    if (session?.legacyId !== undefined && session.legacyId !== '') entry.legacyId = session.legacyId;
    if (session?.importedFromLegacy) entry.importedFromLegacy = true;
    return entry;
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
            read: (ns = SESSIONS_NAMESPACE) => ctx.getGlobalState(ns),
            update: (ns, updater) => ctx.updateGlobalState(ns, updater),
            del: (ns) => (typeof ctx.deleteGlobalState === 'function'
                ? ctx.deleteGlobalState(ns)
                : Promise.resolve({ ok: true })),
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
            read: (ns = SESSIONS_NAMESPACE) => ctx.getCharacterState(avatar, ns),
            update: (ns, updater) => ctx.updateCharacterState(avatar, ns, updater),
            del: (ns) => (typeof ctx.deleteCharacterState === 'function'
                ? ctx.deleteCharacterState(avatar, ns)
                : Promise.resolve({ ok: true })),
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
            read: (ns = SESSIONS_NAMESPACE) => ctx.presets.state.get(ns, stateOpts),
            update: (ns, updater) => ctx.presets.state.update(ns, updater, stateOpts),
            del: (ns) => (typeof ctx.presets?.state?.delete === 'function'
                ? ctx.presets.state.delete(ns, stateOpts)
                : Promise.resolve({ ok: true })),
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
            read: (ns = SESSIONS_NAMESPACE) => ctx.getChatState(ns, stateOpts),
            update: (ns, updater) => ctx.updateChatState(ns, updater, stateOpts),
            del: (ns) => (typeof ctx.deleteChatState === 'function'
                ? ctx.deleteChatState(ns, stateOpts)
                : Promise.resolve({ ok: true })),
        };
    }

    throw new SourceError('validation', `Unknown session scope: ${scope}`);
}

/**
 * State-backed session store with split lightweight index + lazy per-session bodies.
 * @param {object | (() => object)} ctxOrProvider
 */
export function createSessionStore(ctxOrProvider = null) {
    const idToScope = new Map();
    const pendingMigrations = new Map();

    const getCtx = () => (typeof ctxOrProvider === 'function'
        ? ctxOrProvider()
        : (ctxOrProvider || globalThis.Luker?.getContext?.() || globalThis.lukerContext || null));

    const rememberScopes = (scopeOpts, sessions) => {
        for (const s of sessions) {
            if (s?.id) idToScope.set(s.id, clone(scopeOpts));
        }
    };

    /**
     * Splits legacy v1 inline sessions out of the index into per-session body
     * namespaces. Every body write must succeed before the index is rewritten,
     * so a transient write failure never drops inline data.
     */
    async function migrateInlineSessions(adapter, rawState) {
        const inline = normalizeSessions(rawState).filter(s => s?.id && isInlineSession(s));
        if (!inline.length) return rawState;

        if (pendingMigrations.has(adapter.key)) {
            return pendingMigrations.get(adapter.key);
        }

        const run = (async () => {
            for (const session of inline) {
                const bodyNs = sessionBodyNamespace(session.id);
                const full = {
                    ...clone(session),
                    pendingCount: computePendingCount(session),
                };
                const bodyRes = await adapter.update(bodyNs, (existing) => {
                    if (isPlainObject(existing) && existing.id === session.id && Array.isArray(existing.turns)) {
                        return null;
                    }
                    return full;
                });
                assertOk(bodyRes, 'migrate-body');
            }

            const idxRes = await adapter.update(SESSIONS_NAMESPACE, (current) => {
                const base = isPlainObject(current) ? current : {};
                const list = normalizeSessions(base);
                if (!list.some(isInlineSession) && base.version === SESSIONS_INDEX_VERSION) {
                    return null;
                }
                return {
                    ...base,
                    version: SESSIONS_INDEX_VERSION,
                    sessions: list.map(toSessionSummary),
                };
            });
            assertOk(idxRes, 'migrate-index');
            return idxRes.state ?? rawState;
        })().finally(() => {
            pendingMigrations.delete(adapter.key);
        });

        pendingMigrations.set(adapter.key, run);
        return run;
    }

    async function readIndexState(adapter) {
        const res = await adapter.read(SESSIONS_NAMESPACE);
        assertOk(res, 'read');
        let state = isPlainObject(res.state) ? res.state : {};
        if (normalizeSessions(state).some(isInlineSession)) {
            state = await migrateInlineSessions(adapter, state);
        }
        return state;
    }

    async function listWithMeta(kind = null, scopeOpts = {}) {
        const adapter = resolveAdapter(getCtx(), scopeOpts);
        const state = await readIndexState(adapter);
        const all = normalizeSessions(state);
        rememberScopes(scopeOpts, all);
        const sessions = all
            .filter(s => !kind || s.kind === kind)
            .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
            .map(s => (isInlineSession(s) ? toSessionSummary(s) : clone(s)));
        return {
            sessions,
            legacyImported: isPlainObject(state.legacyImported) ? clone(state.legacyImported) : {},
            state: clone(state),
        };
    }

    return {
        listWithMeta,

        async list(kind = null, scopeOpts = {}) {
            const { sessions } = await listWithMeta(kind, scopeOpts);
            return sessions;
        },

        async get(id, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            const bodyNs = sessionBodyNamespace(id);
            const bodyRes = await adapter.read(bodyNs);
            assertOk(bodyRes, 'read');
            if (isPlainObject(bodyRes.state) && (bodyRes.state.id === id || Array.isArray(bodyRes.state.turns))) {
                idToScope.set(id, clone(effectiveScope));
                return clone(bodyRes.state);
            }

            // Fallback for unmigrated v1 inline sessions before list() has run.
            const idxRes = await adapter.read(SESSIONS_NAMESPACE);
            assertOk(idxRes, 'read');
            const list = normalizeSessions(idxRes.state);
            rememberScopes(effectiveScope, list);
            const found = list.find(s => s?.id === id);
            if (!found) return null;
            if (isInlineSession(found)) {
                try {
                    await migrateInlineSessions(adapter, idxRes.state);
                } catch (err) {
                    console.warn('[workbench/sessions] lazy v1->v2 split deferred:', err);
                }
                return clone(found);
            }
            return null;
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
            session.pendingCount = computePendingCount(session);
            const summary = toSessionSummary(session);
            const bodyNs = sessionBodyNamespace(session.id);

            const bodyRes = await adapter.update(bodyNs, () => session);
            assertOk(bodyRes, 'create');

            try {
                const idxRes = await adapter.update(SESSIONS_NAMESPACE, (current) => {
                    const base = isPlainObject(current) ? current : {};
                    return {
                        ...base,
                        version: SESSIONS_INDEX_VERSION,
                        sessions: [summary, ...normalizeSessions(base)],
                    };
                });
                assertOk(idxRes, 'create');
                rememberScopes(scopeOpts, normalizeSessions(idxRes.state));
            } catch (err) {
                await adapter.del(bodyNs).catch(() => {});
                throw err;
            }
            idToScope.set(session.id, clone(scopeOpts));
            return clone(session);
        },

        async update(id, patch, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            const bodyNs = sessionBodyNamespace(id);

            let currentBody = null;
            const bodyRes = await adapter.read(bodyNs);
            assertOk(bodyRes, 'read');
            if (isPlainObject(bodyRes.state) && (bodyRes.state.id === id || Array.isArray(bodyRes.state.turns))) {
                currentBody = bodyRes.state;
            } else {
                const idxRead = await adapter.read(SESSIONS_NAMESPACE);
                assertOk(idxRead, 'read');
                const inlineHit = normalizeSessions(idxRead.state).find(s => s?.id === id && isInlineSession(s));
                if (inlineHit) currentBody = inlineHit;
            }
            if (!currentBody) return null;

            const updatedSession = {
                ...clone(currentBody),
                ...clone(patch),
                updatedAt: Date.now(),
            };
            updatedSession.pendingCount = computePendingCount(updatedSession);
            const summary = toSessionSummary(updatedSession);

            let foundInIndex = false;
            const writeBodyRes = await adapter.update(bodyNs, () => updatedSession);
            assertOk(writeBodyRes, 'update');

            const idxRes = await adapter.update(SESSIONS_NAMESPACE, (current) => {
                const base = isPlainObject(current) ? current : {};
                const list = normalizeSessions(base);
                const idx = list.findIndex(s => s?.id === id);
                if (idx < 0) return null;
                foundInIndex = true;
                const nextList = list.slice();
                nextList[idx] = summary;
                return {
                    ...base,
                    version: SESSIONS_INDEX_VERSION,
                    sessions: nextList,
                };
            });
            assertOk(idxRes, 'update');
            if (!foundInIndex) {
                // Session was deleted concurrently; remove orphaned body instead of resurrecting it.
                await adapter.del(bodyNs).catch(() => {});
                idToScope.delete(id);
                return null;
            }
            rememberScopes(effectiveScope, normalizeSessions(idxRes.state));
            idToScope.set(id, clone(effectiveScope));
            return clone(updatedSession);
        },

        async remove(id, scopeOpts = null) {
            const effectiveScope = scopeOpts || idToScope.get(id) || { scope: 'global' };
            const adapter = resolveAdapter(getCtx(), effectiveScope);
            const res = await adapter.update(SESSIONS_NAMESPACE, (current) => {
                const base = isPlainObject(current) ? current : {};
                const list = normalizeSessions(base);
                const nextList = list.filter(s => s?.id !== id);
                if (nextList.length === list.length) return null;
                return { ...base, sessions: nextList };
            });
            assertOk(res, 'remove');
            if (res.state) {
                rememberScopes(effectiveScope, normalizeSessions(res.state));
            }
            const delRes = await adapter.del(sessionBodyNamespace(id));
            assertOk(delRes, 'remove');
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
