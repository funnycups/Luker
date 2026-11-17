// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Order-independent platform registry for Workbench workspaces, iterate targets,
// Ask providers, Suggest rule providers, and deferred/live open() routing.
// Safe to import before DOM ready or APP_READY (used directly by st-context.js).

import { saveSettingsChecked } from './model/patch.js';

export { saveSettingsChecked };

function cloneDescriptorObject(obj, overrides = {}) {
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    for (const [key, value] of Object.entries(overrides)) {
        descriptors[key] = { value, writable: true, enumerable: true, configurable: true };
    }
    return Object.defineProperties({}, descriptors);
}

function sortEntries(entries) {
    return [...entries]
        .sort((a, b) => {
            const ao = Number.isFinite(Number(a.def.order)) ? Number(a.def.order) : 0;
            const bo = Number.isFinite(Number(b.def.order)) ? Number(b.def.order) : 0;
            if (ao !== bo) return ao - bo;
            return a.seq - b.seq;
        })
        .map(entry => cloneDescriptorObject(entry.def));
}

export function isWorkspaceEnabled(ws) {
    if (!ws) return false;
    if (typeof ws.isEnabled === 'function') {
        try {
            return Boolean(ws.isEnabled());
        } catch (err) {
            console.error('[workbench/registry] isEnabled check failed for', ws.id, err);
            return false;
        }
    }
    return ws.isEnabled !== false;
}

export function createWorkbenchRegistry() {
    const workspaces = new Map();
    const iterateTargets = new Map();
    const askProviders = new Map();
    const suggestRuleProviders = new Map();
    const listeners = new Set();
    let seq = 0;
    let openHandler = null;
    let pendingOpen = null;

    function notify() {
        for (const fn of [...listeners]) {
            try {
                fn();
            } catch (err) {
                console.error('[workbench/registry] subscriber failed', err);
            }
        }
    }

    function registerInMap(map, def, kind) {
        if (!def || typeof def !== 'object') {
            throw new Error(`workbench.${kind}: definition object is required`);
        }
        const id = String(def.id ?? '').trim();
        if (!id) {
            throw new Error(`workbench.${kind}: non-empty "id" is required`);
        }
        const token = Symbol(id);
        const existing = map.get(id);
        map.set(id, {
            token,
            seq: existing ? existing.seq : ++seq,
            def: cloneDescriptorObject(def, { id }),
        });
        notify();
        return () => {
            if (map.get(id)?.token !== token) return;
            map.delete(id);
            notify();
        };
    }

    function registerWorkspace(workspaceDef) {
        if (workspaceDef && workspaceDef.mount !== undefined && typeof workspaceDef.mount !== 'function') {
            throw new Error('workbench.registerWorkspace: "mount" must be a function');
        }
        return registerInMap(workspaces, workspaceDef, 'registerWorkspace');
    }

    function registerIterateTarget(targetDef) {
        return registerInMap(iterateTargets, targetDef, 'registerIterateTarget');
    }

    function registerAskProvider(providerDef) {
        return registerInMap(askProviders, providerDef, 'registerAskProvider');
    }

    function registerSuggestRuleProvider(providerDef) {
        return registerInMap(suggestRuleProviders, providerDef, 'registerSuggestRuleProvider');
    }

    function getWorkspaces({ enabledOnly = false } = {}) {
        const list = sortEntries(workspaces.values());
        return enabledOnly ? list.filter(isWorkspaceEnabled) : list;
    }

    function getIterateTargets() {
        return sortEntries(iterateTargets.values());
    }

    function getAskProviders() {
        return sortEntries(askProviders.values());
    }

    function getSuggestRuleProviders() {
        return sortEntries(suggestRuleProviders.values());
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') {
            throw new Error('workbench.subscribe: listener must be a function');
        }
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function open(opts = {}) {
        const normalized = opts && typeof opts === 'object' ? { ...opts } : {};
        if (typeof openHandler === 'function') {
            pendingOpen = null;
            return Promise.resolve(openHandler(normalized));
        }
        return new Promise((resolve, reject) => {
            if (!pendingOpen) {
                pendingOpen = { opts: normalized, waiters: [] };
            } else {
                pendingOpen.opts = normalized;
            }
            pendingOpen.waiters.push({ resolve, reject });
        });
    }

    function setOpenHandler(fn) {
        openHandler = typeof fn === 'function' ? fn : null;
        if (openHandler && pendingOpen) {
            const queued = pendingOpen;
            pendingOpen = null;
            Promise.resolve(openHandler(queued.opts)).then(
                (result) => {
                    for (const w of queued.waiters) w.resolve(result);
                },
                (err) => {
                    for (const w of queued.waiters) w.reject(err);
                },
            );
        }
    }

    function reset() {
        workspaces.clear();
        iterateTargets.clear();
        askProviders.clear();
        suggestRuleProviders.clear();
        listeners.clear();
        openHandler = null;
        pendingOpen = null;
    }

    return {
        registerWorkspace,
        registerIterateTarget,
        registerAskProvider,
        registerSuggestRuleProvider,
        open,
        setOpenHandler,
        saveSettingsChecked,
        getWorkspaces,
        getIterateTargets,
        getAskProviders,
        getSuggestRuleProviders,
        subscribe,
        notify,
        reset,
    };
}

export const defaultRegistry = createWorkbenchRegistry();

export const registerWorkspace = (...args) => defaultRegistry.registerWorkspace(...args);
export const registerIterateTarget = (...args) => defaultRegistry.registerIterateTarget(...args);
export const registerAskProvider = (...args) => defaultRegistry.registerAskProvider(...args);
export const registerSuggestRuleProvider = (...args) => defaultRegistry.registerSuggestRuleProvider(...args);
export const open = (...args) => defaultRegistry.open(...args);
export const setOpenHandler = (...args) => defaultRegistry.setOpenHandler(...args);
export const getWorkspaces = (...args) => defaultRegistry.getWorkspaces(...args);
export const getIterateTargets = (...args) => defaultRegistry.getIterateTargets(...args);
export const getAskProviders = (...args) => defaultRegistry.getAskProviders(...args);
export const getSuggestRuleProviders = (...args) => defaultRegistry.getSuggestRuleProviders(...args);
export const subscribe = (...args) => defaultRegistry.subscribe(...args);
export const notify = (...args) => defaultRegistry.notify(...args);
export const resetRegistry = () => defaultRegistry.reset();
