// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation storage for Ask and AI iteration (per-account storage).
// A session: { id, kind: 'ask'|'iterate', ws?, scope?, target?, title,
// createdAt, updatedAt, turns: [...] }. Pure apart from the injected storage.

import { i18n } from '../i18n.js';

const KEY = 'workbench.sessions.v1';
export const MAX_SESSIONS = 40;
const MAX_TURN_TEXT = 20000;
// Sessions travel with every settings save, so the list has to stay small.
const MAX_STORED_CHARS = 1_000_000;

const parseList = (raw) => {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
};

/** Oldest sessions go first until the list fits the storage ceiling. */
function fitToCeiling(list) {
    let kept = list;
    let text = JSON.stringify(kept);
    while (text.length > MAX_STORED_CHARS && kept.length > 1) {
        const oldest = kept.reduce((low, s) => (s.updatedAt < low.updatedAt ? s : low));
        kept = kept.filter(s => s !== oldest);
        text = JSON.stringify(kept);
    }
    return { text, kept };
}

/**
 * Moves sessions from the browser-wide localStorage key into this account.
 * The account copy lives in memory until settings reach the server, so the
 * browser copy is removed only once `persist` reports a save.
 * @param {{ account: Storage, legacy: Storage, persist: (onSaved: () => void) => void }} io
 */
export function migrateLegacySessions({ account, legacy, persist }) {
    const raw = legacy?.getItem(KEY);
    if (raw === null || raw === undefined) return;
    const old = parseList(raw);
    if (!old) return;
    const own = parseList(account.getItem(KEY)) || [];
    const known = new Set(own.map(s => s.id));
    const merged = [...own, ...old.filter(s => !known.has(s.id))].sort((a, b) => b.updatedAt - a.updatedAt);
    account.setItem(KEY, fitToCeiling(merged).text);
    persist(() => legacy.removeItem(KEY));
}

export function createSessionStore(storage) {
    let lastRaw = null;
    let lastList = [];
    // Always from storage, so a stale copy can never overwrite newer sessions.
    const read = () => {
        const raw = storage?.getItem(KEY) ?? null;
        if (raw !== lastRaw) {
            lastRaw = raw;
            lastList = parseList(raw) || [];
        }
        return lastList;
    };
    const write = (list) => {
        const { text, kept } = fitToCeiling(list);
        storage?.setItem(KEY, text);
        lastRaw = text;
        lastList = kept;
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
            write([s, ...read()].slice(0, MAX_SESSIONS));
            return s;
        },
        update(id, patch) {
            const list = [...read()];
            const i = list.findIndex(s => s.id === id);
            if (i < 0) return null;
            const next = { ...list[i], ...patch, updatedAt: Date.now() };
            if (patch.turns) next.turns = patch.turns.map(trimTurn);
            list[i] = next;
            write(list);
            return next;
        },
        remove(id) {
            write(read().filter(s => s.id !== id));
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
