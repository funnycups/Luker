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
// One long conversation may not push out the others.
export const MAX_SESSION_CHARS = 200_000;

const parseList = (raw) => {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
};

const cut = (text, max) => (typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text);

const fitTurn = (turn, max = MAX_TURN_TEXT) => {
    const t = { ...turn };
    for (const k of ['text', 'answer', 'error']) if (k in t) t[k] = cut(t[k], max);
    if (Array.isArray(t.changes)) t.changes = t.changes.map(c => ({ ...c, before: cut(c.before, max), after: cut(c.after, max) }));
    return t;
};

const fitMessage = (message) => {
    const m = { ...message };
    if (typeof m.content === 'string') m.content = cut(m.content, MAX_TURN_TEXT);
    // Arguments must stay valid JSON when replayed to the model.
    if (Array.isArray(m.tool_calls)) m.tool_calls = m.tool_calls.map(c => (String(c?.function?.arguments || '').length > MAX_TURN_TEXT ? { ...c, function: { ...c.function, arguments: '{}' } } : c));
    return m;
};

const sizeOf = (value) => JSON.stringify(value).length;

/** Keeps one session under its budget: oldest model history, then oldest turns, then long text. */
export function fitSession(session) {
    const s = { ...session };
    if (Array.isArray(s.turns)) s.turns = s.turns.map(t => fitTurn(t));
    if (Array.isArray(s.messages)) s.messages = s.messages.map(fitMessage);
    while (Array.isArray(s.messages) && s.messages.length && sizeOf(s) > MAX_SESSION_CHARS) {
        // Answer again cuts back to an index in this list.
        s.messages = s.messages.slice(1);
        if (Array.isArray(s.turns)) s.turns = s.turns.map(t => (Number.isInteger(t.msgKeep) ? { ...t, msgKeep: Math.max(0, t.msgKeep - 1) } : t));
    }
    while (Array.isArray(s.turns) && s.turns.length > 2 && sizeOf(s) > MAX_SESSION_CHARS) s.turns = s.turns.slice(1);
    for (let max = MAX_TURN_TEXT / 2; Array.isArray(s.turns) && sizeOf(s) > MAX_SESSION_CHARS && max >= 16; max = Math.floor(max / 2)) s.turns = s.turns.map(t => fitTurn(t, max));
    if (Array.isArray(s.turns) && sizeOf(s) > MAX_SESSION_CHARS) s.turns = s.turns.map(t => ({ ...t, changes: [] }));
    return s;
}

/** Oldest sessions go first until the list fits the storage ceiling. */
function fitToCeiling(list) {
    let kept = list;
    let text = JSON.stringify(kept);
    if (text.length > MAX_STORED_CHARS) {
        kept = kept.map(fitSession);
        text = JSON.stringify(kept);
    }
    while (text.length > MAX_STORED_CHARS && kept.length > 1) {
        const oldest = kept.reduce((low, s) => (s.updatedAt < low.updatedAt ? s : low));
        kept = kept.filter(s => s !== oldest);
        text = JSON.stringify(kept);
    }
    return { text, kept };
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
    return {
        list: (kind = null) => read().filter(s => !kind || s.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt),
        get: (id) => read().find(s => s.id === id) || null,
        create(fields) {
            const now = Date.now();
            const s = fitSession({ id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', createdAt: now, updatedAt: now, turns: [], ...fields });
            write([s, ...read()].slice(0, MAX_SESSIONS));
            return s;
        },
        update(id, patch) {
            const list = [...read()];
            const i = list.findIndex(s => s.id === id);
            if (i < 0) return null;
            const next = fitSession({ ...list[i], ...patch, updatedAt: Date.now() });
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
