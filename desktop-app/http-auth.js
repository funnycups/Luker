// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fs from 'node:fs';
import path from 'node:path';

export function httpAuthKey(host, port, realm) {
    return `${String(host || '').trim().toLowerCase()}:${Number(port) || 0}:${String(realm || '').trim()}`;
}

export function sameCredentials(a, b) {
    if (!a || !b) {
        return a === b;
    }
    return a.username === b.username && a.password === b.password;
}

/**
 * Decides how to answer an authentication challenge. Stored credentials are
 * reused until the server rejects them; a rejection clears the store and opens
 * the dialog prefilled with the rejected pair. Mirrors the Android, iOS and
 * HarmonyOS shells.
 */
export function decideHttpAuth(stored, lastAttempted) {
    if (stored && !sameCredentials(stored, lastAttempted)) {
        return {
            useStored: true,
            clearStored: false,
            credentials: stored,
            prefill: null,
        };
    }
    return {
        useStored: false,
        clearStored: Boolean(stored && sameCredentials(stored, lastAttempted)),
        credentials: null,
        prefill: lastAttempted || stored || null,
    };
}

/**
 * Stores HTTP authentication credentials per endpoint and realm as a JSON file
 * next to the app data. A rejected credential is removed before the dialog
 * reappears, so a stored pair is only reused while the server accepts it.
 */
export class HttpAuthStore {
    constructor(filePath) {
        this.filePath = filePath;
    }

    load(host, port, realm) {
        const entry = this.readAll()[httpAuthKey(host, port, realm)];
        if (!entry || typeof entry.username !== 'string') {
            return null;
        }
        return {
            username: entry.username,
            password: typeof entry.password === 'string' ? entry.password : '',
        };
    }

    save(host, port, realm, credentials) {
        const data = this.readAll();
        data[httpAuthKey(host, port, realm)] = {
            username: credentials.username,
            password: credentials.password,
        };
        this.writeAll(data);
    }

    clear(host, port, realm) {
        const data = this.readAll();
        const key = httpAuthKey(host, port, realm);
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            return;
        }
        delete data[key];
        this.writeAll(data);
    }

    readAll() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`HTTP authentication store is not a JSON object: ${this.filePath}`);
        }
        return parsed;
    }

    writeAll(data) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
}

/**
 * Serializes Electron's login events into one credential dialog at a time.
 * `prompt(request)` resolves to `{ username, password }`, or to null when the
 * user cancels. Callbacks must be invoked exactly once per challenge.
 */
export function createHttpAuthController({ store, prompt, log = console }) {
    const recent = new Map();
    const queue = [];
    let dialogOpen = false;

    function handle(authInfo, callback, parent = null) {
        const host = String(authInfo?.host || '').trim();
        const realm = String(authInfo?.realm || '').trim();
        const port = Number(authInfo?.port) || 0;
        if (!host) {
            callback();
            return;
        }
        const key = httpAuthKey(host, port, realm);
        let stored = null;
        try {
            stored = store.load(host, port, realm);
        } catch (error) {
            log.error('[LukerHttpAuth] could not read stored credentials', error);
        }
        const decision = decideHttpAuth(stored, recent.get(key) || null);
        if (decision.useStored) {
            recent.set(key, decision.credentials);
            callback(decision.credentials.username, decision.credentials.password);
            return;
        }
        if (decision.clearStored) {
            try {
                store.clear(host, port, realm);
            } catch (error) {
                log.error('[LukerHttpAuth] could not clear rejected credentials', error);
            }
        }
        queue.push({
            key,
            host,
            port,
            realm,
            prefill: decision.prefill,
            parent,
            callback,
        });
        void showNext();
    }

    async function showNext() {
        if (dialogOpen || queue.length === 0) {
            return;
        }
        dialogOpen = true;
        const pending = queue.shift();
        let result = null;
        try {
            result = await prompt({
                host: pending.host,
                port: pending.port,
                realm: pending.realm,
                prefill: pending.prefill,
                parent: pending.parent,
            });
        } catch (error) {
            log.error('[LukerHttpAuth] credential dialog failed', error);
        }
        dialogOpen = false;
        if (!result) {
            pending.callback();
            while (queue.length > 0) {
                queue.shift().callback();
            }
            return;
        }
        const credentials = {
            username: String(result.username ?? ''),
            password: String(result.password ?? ''),
        };
        try {
            store.save(pending.host, pending.port, pending.realm, credentials);
        } catch (error) {
            log.error('[LukerHttpAuth] could not save credentials', error);
        }
        recent.set(pending.key, credentials);
        pending.callback(credentials.username, credentials.password);
        for (let index = queue.length - 1; index >= 0; index--) {
            if (queue[index].key === pending.key) {
                const item = queue.splice(index, 1)[0];
                item.callback(credentials.username, credentials.password);
            }
        }
        void showNext();
    }

    function resetAttempts() {
        recent.clear();
    }

    return { handle, resetAttempts };
}
