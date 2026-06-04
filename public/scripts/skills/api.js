/**
 * Browser-side JS API for the skills REST endpoints.
 *
 * Exposed on `getContext().skills` (st-context.js) and mirrored on CardApp's
 * `ctx.skills`. All path/name validation is handled server-side; this module
 * is a thin transport wrapper.
 *
 * Scope shapes:
 *   { kind: 'global' }
 *   { kind: 'preset', name: string }
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
 * Build a scope URL fragment (e.g. `preset/夏瑾 双鱼座`) for skill API
 * routes. Returns the raw `kind/<name>` string with a literal `/`
 * between the kind and the inner segment.
 *
 * Callers MUST wrap this with `encodeURIComponent` when placing it
 * into either a path slot or a query string — that single outer
 * encode handles both the structural `/` (becomes `%2F`) and any
 * non-ASCII or whitespace characters in the inner name. Express
 * auto-decodes the result back to the original `kind/name` string
 * on the server.
 *
 * Earlier this helper also `encodeURIComponent`'d the inner name,
 * which double-encoded non-ASCII names: by the time Express's
 * single-pass path-param decode ran, the inner segment still looked
 * like `%E5%A4%8F%E7%91%BE`, and `assertSafe` rejected the `%`
 * characters. Letting the outer encode do all the work keeps the
 * round-trip lossless.
 *
 * @param {object|string} scope
 * @returns {string}
 */
function scopeToUrl(scope) {
    if (scope === 'all' || !scope) return 'all';
    if (scope.kind === 'global') return 'global';
    if (scope.kind === 'preset') {
        return `preset/${scope.name}`;
    }
    if (scope.kind === 'character') {
        return `character/${scope.characterFile}`;
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

    /**
     * Rename / move a file within a skill. `toPath` may include new parent
     * directories — they're created server-side. SKILL.md is excluded from
     * both ends (renaming it would orphan the manifest, overwriting via
     * rename would bypass frontmatter validation). Returns
     * `{ ok, path, sha256 }` so the editor can refresh its optimistic-lock
     * cache without an extra readFile round-trip.
     * @param {{scope: object, name: string, fromPath: string, toPath: string}} opts
     */
    renameFile(opts) {
        return jsonFetch(
            `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/rename`,
            { method: 'POST', body: JSON.stringify(opts) },
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
     * List the bundled skills shipped under default/skills/global/, each with
     * the install hash they'd produce when materialized. The "Browse bundled"
     * tab compares each entry's `installedHash` against the same field on a
     * locally-installed skill to decide install_match / install_differ /
     * not_installed without re-running the install path.
     *
     * Read-only; no CSRF needed but the wrapper sends it anyway via
     * getRequestHeaders.
     *
     * @returns {Promise<Array<{name:string, installedHash:string, fileCount:number, totalBytes:number, description:string}>>}
     */
    listBundledManifest() {
        return jsonFetch('/api/skills/bundled-manifest');
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
