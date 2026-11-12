// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Change history: everything the workbench wrote to Luker, newest first. Undo
// functions live only in memory (they close over Luker state); entries from
// earlier page loads keep their text but can no longer be undone here.
// Persisted list: 'workbench.history.v1' in the storage the caller passes,
// which is scoped to the signed-in account.

import { i18n } from '../i18n.js';

const KEY = 'workbench.history.v1';

function isQuotaError(err) {
    return Boolean(
        err?.name === 'QuotaExceededError'
        || err?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || err?.code === 22
        || err?.code === 1014
        || /quota/i.test(String(err?.message || '')),
    );
}

/**
 * @param {{ getItem: Function, setItem: Function, removeItem?: Function } | null} [storage]
 * @param {{ onError?: (error: { type: string, message: string, cause?: unknown }) => void }} [options]
 */
export function createHistory(storage = null, { onError = null } = {}) {
    const undos = new Map();
    const listeners = new Set();
    let list = [];
    let storageError = null;

    function reportError(type, cause) {
        const message = type === 'parse'
            ? i18n('Change history could not be loaded (stored data is corrupted). Existing data was preserved.')
            : type === 'quota'
                ? i18n('Change history could not be saved (storage quota exceeded).')
                : i18n('Change history could not be saved.');
        storageError = { type, message, cause };
        console.error('[workbench/history]', message, cause);
        globalThis.toastr?.error?.(message);
        try { onError?.(storageError); } catch (err) { console.error('[workbench/history] onError failed', err); }
    }

    const raw = storage?.getItem?.(KEY);
    if (raw != null && raw !== '') {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                reportError('parse', new TypeError('Change history JSON is not an array'));
            } else {
                list = parsed;
            }
        } catch (err) {
            reportError('parse', err);
        }
    }

    const notify = () => {
        for (const fn of [...listeners]) {
            try { fn(); } catch (err) { console.error('[workbench/history] listener failed', err); }
        }
    };

    const save = () => {
        if (storageError?.type === 'parse') {
            reportError('parse', storageError.cause);
            notify();
            return false;
        }
        try {
            storage?.setItem?.(KEY, JSON.stringify(list));
            if (storageError?.type === 'quota' || storageError?.type === 'storage') {
                storageError = null;
            }
            notify();
            return true;
        } catch (err) {
            reportError(isQuotaError(err) ? 'quota' : 'storage', err);
            notify();
            return false;
        }
    };

    return {
        list: () => list.slice(),
        getStorageError: () => storageError,
        /**
         * @param {{ ws, title, lines?: string[], from?: string, scope?: string, undo?: () => Promise<void> }} entry
         */
        record({ undo, ...entry }) {
            const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
            list = [{ id, at: Date.now(), lines: [], from: i18n('AI chat'), undone: false, ...entry }, ...list];
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
