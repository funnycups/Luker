/**
 * Browser-side JS API for the skills REST endpoints.
 *
 * Exposed on `getContext().skills` (st-context.js) and mirrored on CardApp's
 * `ctx.skills`. All path/name validation is handled server-side; this module
 * is a thin transport wrapper.
 *
 * Scope shapes:
 *   { kind: 'global' }
 *   { kind: 'preset', apiId: string, name: string }
 *   { kind: 'character', characterFile: string }
 *   'all' — only valid for list()
 */

import { getRequestHeaders } from '../../script.js';

/**
 * Wrap fetch + JSON handling. Throws an Error whose `.status` and `.body`
 * mirror the server's error response so call sites can branch on them.
 *
 * Headers come from `getRequestHeaders()` so the CSRF token (Luker enables
 * `csrfSyncProtection` globally in server-main.js) is always present on
 * writes; callers may override or add headers via `options.headers`.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<*>} parsed JSON body, or null for 204 responses
 */
async function jsonFetch(url, options = {}) {
    const res = await fetch(url, {
        headers: { ...getRequestHeaders(), ...(options.headers || {}) },
        ...options,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        let body;
        try { body = JSON.parse(text); } catch { body = { error: text }; }
        const err = new Error(body.error || `${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    if (res.status === 204) return null;
    return res.json();
}

/**
 * Encode a scope (or the literal 'all') into the URL fragment used by the
 * REST router. Express's path matching auto-decodes `%2F` back to `/`, so
 * we pre-encode each scope segment individually.
 *
 * @param {object|string} scope
 * @returns {string}
 */
function scopeToUrl(scope) {
    if (scope === 'all' || !scope) return 'all';
    if (scope.kind === 'global') return 'global';
    if (scope.kind === 'preset') {
        return `preset/${encodeURIComponent(scope.apiId)}/${encodeURIComponent(scope.name)}`;
    }
    if (scope.kind === 'character') {
        return `character/${encodeURIComponent(scope.characterFile)}`;
    }
    throw new Error(`invalid scope kind: ${scope.kind}`);
}

export const skillsApi = {
    // ==================== Inventory ====================

    /**
     * List skills.
     * @param {{scope?: object|'all'}} [opts]
     * @returns {Promise<Array>}
     */
    list(opts = {}) {
        const scopeParam = scopeToUrl(opts.scope || 'all');
        return jsonFetch(`/api/skills?scope=${encodeURIComponent(scopeParam)}`);
    },

    /**
     * Get a single skill entry by name (within a scope, or anywhere).
     * @param {string} name
     * @param {object|'all'} [scope]
     * @returns {Promise<object|null>}
     */
    async get(name, scope) {
        const list = await this.list({ scope });
        return list.find((e) => e.name === name) || null;
    },

    // ==================== Read content ====================

    /**
     * Read a file inside a skill. `path` defaults to SKILL.md server-side.
     * @param {{scope: object, name: string, path?: string, offset?: number, limit?: number}} opts
     */
    readFile(opts) {
        const params = new URLSearchParams();
        if (opts.path) params.set('path', opts.path);
        if (Number.isInteger(opts.offset)) params.set('offset', String(opts.offset));
        if (Number.isInteger(opts.limit)) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file${qs ? '?' + qs : ''}`,
        );
    },

    /**
     * List metadata (path/size/isBinary) for every file inside a skill.
     * SKILL.md is sorted to the top; the rest follow localeCompare order.
     * @param {{scope: object, name: string}} opts
     * @returns {Promise<{files: Array<{path: string, size: number, isBinary: boolean}>}>}
     */
    listFiles(opts) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/files`,
        );
    },

    /**
     * Substring search inside a skill's files.
     * @param {{scope: object, name: string, query: string, path?: string, limit?: number, contextLines?: number}} opts
     */
    search(opts) {
        const params = new URLSearchParams({ q: opts.query });
        if (opts.path) params.set('path', opts.path);
        if (Number.isInteger(opts.limit)) params.set('limit', String(opts.limit));
        if (Number.isInteger(opts.contextLines)) params.set('context_lines', String(opts.contextLines));
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/search?${params}`,
        );
    },

    // ==================== Write ====================

    /**
     * Replace an entire file inside a skill.
     * @param {{scope: object, name: string, path: string, content: string, expectedSha256?: string}} opts
     */
    writeFile(opts) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/write`,
            { method: 'POST', body: JSON.stringify(opts) },
        );
    },

    /**
     * In-place string replacement.
     * @param {{scope: object, name: string, path: string, oldString: string, newString: string, replaceAll?: boolean}} opts
     */
    editFile(opts) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/edit`,
            { method: 'POST', body: JSON.stringify(opts) },
        );
    },

    /**
     * Delete a single file inside a skill. SKILL.md cannot be deleted via
     * this route — use `delete(scope, name)` to remove the whole skill.
     * @param {{scope: object, name: string, path: string}} opts
     */
    deleteFile(opts) {
        const params = new URLSearchParams({ path: String(opts.path || '') });
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file?${params}`,
            { method: 'DELETE' },
        );
    },

    // ==================== Management ====================

    /**
     * Install (or replace, depending on conflictStrategy) a skill.
     * @param {{scope: object, payload: object, conflictStrategy?: string}} opts
     */
    install(opts) {
        return jsonFetch(`/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}`, {
            method: 'POST',
            body: JSON.stringify({ payload: opts.payload, conflictStrategy: opts.conflictStrategy }),
        });
    },

    /**
     * Delete a skill.
     * @param {object} scope
     * @param {string} name
     */
    delete(scope, name) {
        return jsonFetch(`/api/skills/${encodeURIComponent(scopeToUrl(scope))}/${encodeURIComponent(name)}`, {
            method: 'DELETE',
        });
    },

    /**
     * Rename a skill within its current scope.
     * @param {object} scope
     * @param {string} oldName
     * @param {string} newName
     */
    rename(scope, oldName, newName) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(scope))}/${encodeURIComponent(oldName)}/rename`,
            { method: 'POST', body: JSON.stringify({ toName: newName }) },
        );
    },

    /**
     * Move a skill to a different scope.
     * @param {string} name
     * @param {object} fromScope
     * @param {object} toScope
     */
    moveScope(name, fromScope, toScope) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(fromScope))}/${encodeURIComponent(name)}/move-scope`,
            { method: 'POST', body: JSON.stringify({ toScope }) },
        );
    },

    /**
     * Re-import bundled skills shipped with the server.
     */
    importBundled() {
        return jsonFetch('/api/skills/import-bundled', { method: 'POST' });
    },

    /**
     * Import a skill from a URL pointing to a zipped bundle.
     * @param {{url: string, targetScope: object}} opts
     */
    importFromUrl(opts) {
        return jsonFetch('/api/skills/import-from-url', {
            method: 'POST',
            body: JSON.stringify(opts),
        });
    },

    // ==================== Transport ====================

    /**
     * Pack one or more skills into an embed payload suitable for sticking
     * into a character card or preset.
     * @param {{scope: object, names: string[], mode?: string}} opts
     */
    packForEmbed(opts) {
        return jsonFetch('/api/skills/pack-for-embed', {
            method: 'POST',
            body: JSON.stringify(opts),
        });
    },

    /**
     * Preview the conflict/replace outcome of extracting an embed payload.
     * @param {{payload: object, targetScope: object}} opts
     */
    previewExtractEmbed(opts) {
        return jsonFetch('/api/skills/extract-embed/preview', {
            method: 'POST',
            body: JSON.stringify(opts),
        });
    },

    /**
     * Execute extraction of an embed payload using the supplied conflict
     * resolutions.
     * @param {{payload: object, targetScope: object, conflictStrategies?: object}} opts
     */
    executeExtractEmbed(opts) {
        return jsonFetch('/api/skills/extract-embed/execute', {
            method: 'POST',
            body: JSON.stringify(opts),
        });
    },
};
