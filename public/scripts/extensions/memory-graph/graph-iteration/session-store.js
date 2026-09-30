// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Graph-iteration session store — per-chat, alongside the graph itself.
 *
 * Why `context.getChatState/updateChatState` instead of character sidecars
 * (schema studio) or settings buckets: the graph's ownership is the CHAT,
 * so its revision sessions are per-chat too. The chat-state API already
 * gives us per-chat namespaced JSON storage with envelope errors.
 *
 * Cross-reload pending recovery: the bus strips `_pendingAfter` on
 * serialize, and without it an approve after a popup reopen throws
 * "Invalid JSON Patch replace path". `save()` callers persist the tail
 * after-state via `session.pendingTailAfter`; `restorePendingChain()`
 * replays each pending entry's inverse backwards to rebuild every
 * `_pendingAfter` before `bus.hydrate()`.
 */

import { applyOps } from '../../../iteration-library/storage/patch-codec.js';

export const MG_GRAPH_ITER_NAMESPACE = 'memory_graph__graph_iter';

const STORE_VERSION = 1;

export function makeMessageId() {
    return `mgg_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMessageShape(m, fallbackAt = Date.now()) {
    if (!m || typeof m !== 'object') return m;
    const out = {
        id: typeof m.id === 'string' && m.id ? m.id : makeMessageId(),
        role: String(m.role || 'user'),
        content: String(m.content ?? ''),
        at: typeof m.at === 'number' ? m.at : Number(fallbackAt) || Date.now(),
    };
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) out.toolCalls = m.toolCalls;
    if (Array.isArray(m.toolResults) && m.toolResults.length > 0) out.toolResults = m.toolResults;
    if (typeof m.reasoning === 'string' && m.reasoning) out.reasoning = m.reasoning;
    if (Array.isArray(m.reasoningBlocks) && m.reasoningBlocks.length > 0) out.reasoningBlocks = m.reasoningBlocks;
    if (Array.isArray(m.reasoningDetails) && m.reasoningDetails.length > 0) out.reasoningDetails = m.reasoningDetails;
    if (typeof m.appliedAt === 'number') out.appliedAt = m.appliedAt;
    if (m.appliedTarget) out.appliedTarget = String(m.appliedTarget);
    if (typeof m.rolledBackAt === 'number') out.rolledBackAt = m.rolledBackAt;
    if (m.auto) out.auto = true;
    return out;
}

export function restorePendingChain(entries, tailAfter) {
    const out = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...(entry || {}) }));
    const pending = out.filter((entry) => entry.status === 'pending');
    if (pending.length === 0) return { entries: out, ok: true, error: null };
    if (tailAfter === undefined || tailAfter === null || typeof tailAfter !== 'object') {
        return failPendingChain(out, 'pending proposals exist but the tail snapshot is missing; reload once more to retry');
    }
    let after = tailAfter;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i];
        if (!Array.isArray(entry.inverse)) {
            return failPendingChain(out, 'pending proposal has no inverse patch');
        }
        entry._pendingAfter = after;
        try {
            after = applyOps(after, entry.inverse, {
                targetType: String(entry?.target?.type || 'memory-graph'),
                targetName: entry?.target?.name || null,
            });
        } catch (err) {
            return failPendingChain(out, `could not rebuild the pending chain: ${err?.message || err}`);
        }
    }
    return { entries: out, ok: true, error: null };
}

function failPendingChain(entries, hint) {
    const message = String(hint || 'pending chain could not be rebuilt');
    for (const entry of entries) {
        if (entry.status !== 'pending') continue;
        entry.status = 'conflict';
        entry.conflictError = { reason: 'CONFLICT', hint: message };
        entry._pendingAfter = undefined;
    }
    return { entries, ok: false, error: message };
}

function normalizeBucket(raw) {
    if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
        return {
            version: STORE_VERSION,
            currentSessionId: String(raw.currentSessionId || ''),
            sessions: { ...raw.sessions },
        };
    }
    return { version: STORE_VERSION, currentSessionId: '', sessions: {} };
}

export function createMgGraphSessionStore({ context, getTarget }) {
    if (!context || typeof context.getChatState !== 'function' || typeof context.updateChatState !== 'function') {
        throw new TypeError('createMgGraphSessionStore: context with getChatState + updateChatState is required');
    }
    if (typeof getTarget !== 'function') {
        throw new TypeError('createMgGraphSessionStore: getTarget must be a function');
    }

    function options(extra = {}) {
        const target = getTarget();
        return target ? { target, ...extra } : { ...extra };
    }

    async function read() {
        const result = await context.getChatState(MG_GRAPH_ITER_NAMESPACE, options());
        if (!result?.ok) {
            console.warn(`[memory-graph graph-iteration] session read failed (reason=${result?.reason}, hint=${result?.hint})`);
            return normalizeBucket(null);
        }
        return normalizeBucket(result.state);
    }

    async function mutate(action, fn) {
        const result = await context.updateChatState(MG_GRAPH_ITER_NAMESPACE, (current) => {
            const bucket = normalizeBucket(current);
            fn(bucket);
            return bucket;
        }, options({ maxOperations: 16000 }));
        // The chat-state envelope reports transport / validation failures as
        // {ok:false}; ignoring it would silently drop the write and the
        // session would vanish on reload. Warn for the console trail, then
        // throw so callers decide how to surface it.
        if (!result?.ok) {
            console.warn(`[memory-graph graph-iteration] session ${action} failed (reason=${result?.reason}, hint=${result?.hint})`);
            throw new Error(`session ${action} failed: ${result?.reason} — ${result?.hint}`);
        }
        return result;
    }

    function metaOf(session) {
        return {
            id: String(session.id),
            title: String(session.title || session.id),
            updatedAt: Number(session.updatedAt || 0),
        };
    }

    async function list() {
        const bucket = await read();
        return Object.values(bucket.sessions).map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function load(id) {
        const bucket = await read();
        const session = bucket.sessions[String(id || '')];
        if (!session || typeof session !== 'object') return null;
        return JSON.parse(JSON.stringify(session));
    }

    async function save(session) {
        const id = String(session?.id || '').trim();
        if (!id) throw new Error('createMgGraphSessionStore.save: session.id is required');
        const snapshot = JSON.parse(JSON.stringify(session));
        delete snapshot._transient;
        await mutate('save', (bucket) => {
            bucket.sessions[id] = snapshot;
            bucket.currentSessionId = id;
        });
    }

    async function deleteSession(id) {
        const key = String(id || '');
        await mutate('delete', (bucket) => {
            delete bucket.sessions[key];
            if (bucket.currentSessionId === key) bucket.currentSessionId = '';
        });
    }

    async function getCurrentSessionId() {
        const bucket = await read();
        return String(bucket.currentSessionId || '');
    }

    return { list, load, save, delete: deleteSession, getCurrentSessionId };
}
