// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Change history: everything the workbench wrote to Luker, newest first. Undo
// functions live only in memory (they close over Luker state); entries from
// earlier page loads keep their text but can no longer be undone here.
// Persisted list: 'workbench.history.v1' (60 entries) in the storage the caller
// passes, which is scoped to the signed-in account.

import { i18n } from '../i18n.js';

const KEY = 'workbench.history.v1';
const MAX = 60;

export function createHistory(storage = null) {
    const undos = new Map();
    const listeners = new Set();
    let list = [];
    try {
        const v = JSON.parse(storage?.getItem(KEY) || '[]');
        list = Array.isArray(v) ? v : [];
    } catch { list = []; }
    const save = () => {
        try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* full */ }
        for (const fn of listeners) fn();
    };
    return {
        list: () => list.slice(),
        /**
         * @param {{ ws, title, lines?: string[], from?: string, scope?: string, undo?: () => Promise<void> }} entry
         */
        record({ undo, ...entry }) {
            const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
            list = [{ id, at: Date.now(), lines: [], from: i18n('AI chat'), undone: false, ...entry }, ...list].slice(0, MAX);
            if (typeof undo === 'function') undos.set(id, undo);
            save();
            return id;
        },
        canUndo: (id) => undos.has(id) && !list.find(e => e.id === id)?.undone,
        async undo(id) {
            const fn = undos.get(id);
            if (!fn) throw new Error(i18n('This change was made in an earlier session and can no longer be undone here'));
            await fn();
            undos.delete(id);
            list = list.map(e => (e.id === id ? { ...e, undone: true, undoneAt: Date.now() } : e));
            save();
        },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
}
