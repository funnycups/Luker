/**
 * IterationStudio — one-shot storage wipe (SP-1 migration).
 *
 * Calls adapter.clearObsoleteSessions(scope) once per adapter on first
 * open after upgrade. Records a flag in localStorage so the wipe doesn't
 * repeat. In environments without localStorage (e.g. Node tests) the
 * flag is held in memory and reset via __resetWipeFlagsForTest.
 */

import { i18n } from './i18n.js';

const FLAG_PREFIX = 'luker-iter-studio-shell-wiped-v2::';
const memoryFlags = new Set();

function hasLocalStorage() {
    try { return typeof window !== 'undefined' && !!window.localStorage; } catch { return false; }
}

function getFlag(key) {
    if (hasLocalStorage()) {
        try { return window.localStorage.getItem(key); } catch { /* ignore */ }
    }
    return memoryFlags.has(key) ? '1' : null;
}

function setFlag(key) {
    if (hasLocalStorage()) {
        try { window.localStorage.setItem(key, '1'); return; } catch { /* ignore */ }
    }
    memoryFlags.add(key);
}

export async function ensureStorageWipeOnce(adapter) {
    if (!adapter || !adapter.id) return;
    const key = FLAG_PREFIX + String(adapter.id);
    if (getFlag(key)) return;
    if (typeof adapter.clearObsoleteSessions === 'function') {
        try {
            const scope = typeof adapter.sessionScope === 'function' ? adapter.sessionScope() : 'global';
            await adapter.clearObsoleteSessions(scope);
            if (typeof toastr !== 'undefined' && toastr?.info) {
                toastr.info(i18n('Iteration Studio session format updated; previous sessions cleared.'));
            }
        } catch (e) {
            console.warn(`[iter-studio:${adapter.id}] clearObsoleteSessions failed`, e);
        }
    }
    setFlag(key);
}

export function __resetWipeFlagsForTest() {
    memoryFlags.clear();
    if (hasLocalStorage()) {
        try {
            const ls = window.localStorage;
            const keys = [];
            for (let i = 0; i < ls.length; i += 1) {
                const k = ls.key(i);
                if (k && k.startsWith(FLAG_PREFIX)) keys.push(k);
            }
            keys.forEach(k => ls.removeItem(k));
        } catch { /* ignore */ }
    }
}
