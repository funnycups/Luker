// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation storage for Ask and AI iteration (localStorage, per browser).
// A session: { id, kind: 'ask'|'iterate', ws?, scope?, target?, title,
// createdAt, updatedAt, turns: [...] }. Pure apart from the injected storage.

import { i18n } from '../i18n.js';

const KEY = 'workbench.sessions.v1';
export const MAX_SESSIONS = 40;
const MAX_TURN_TEXT = 20000;

export function createSessionStore(storage = globalThis.localStorage) {
    let cache = null;
    const read = () => {
        if (cache) return cache;
        try {
            const v = JSON.parse(storage?.getItem(KEY) || '[]');
            cache = Array.isArray(v) ? v : [];
        } catch {
            cache = [];
        }
        return cache;
    };
    const write = () => {
        try {
            storage?.setItem(KEY, JSON.stringify(cache));
        } catch {
            // Quota: drop the oldest half and retry once.
            cache = cache.slice(0, Math.ceil(cache.length / 2));
            try { storage?.setItem(KEY, JSON.stringify(cache)); } catch { /* give up */ }
        }
    };
    const trimTurn = (turn) => {
        const t = { ...turn };
        for (const k of ['text', 'answer']) if (typeof t[k] === 'string' && t[k].length > MAX_TURN_TEXT) t[k] = `${t[k].slice(0, MAX_TURN_TEXT)}…`;
        return t;
    };
    return {
        list: (kind = null) => read().filter(s => !kind || s.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt),
        get: (id) => read().find(s => s.id === id) || null,
        create(fields) {
            const now = Date.now();
            const s = { id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', createdAt: now, updatedAt: now, turns: [], ...fields };
            cache = [s, ...read()].slice(0, MAX_SESSIONS);
            write();
            return s;
        },
        update(id, patch) {
            const list = read();
            const i = list.findIndex(s => s.id === id);
            if (i < 0) return null;
            const next = { ...list[i], ...patch, updatedAt: Date.now() };
            if (patch.turns) next.turns = patch.turns.map(trimTurn);
            list[i] = next;
            write();
            return next;
        },
        remove(id) {
            cache = read().filter(s => s.id !== id);
            write();
        },
    };
}

/** Today / Earlier grouping for the session list. */
export function groupSessions(list, now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const today = list.filter(s => s.updatedAt >= start.getTime());
    const older = list.filter(s => s.updatedAt < start.getTime());
    return [today.length ? { label: i18n('Today'), items: today } : null, older.length ? { label: i18n('Earlier'), items: older } : null].filter(Boolean);
}

/** Session title from the first question. */
export function titleFrom(text) {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > 28 ? `${one.slice(0, 27)}…` : one || i18n('New conversation');
}
