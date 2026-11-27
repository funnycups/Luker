/**
 * Browser-side JS API factory for the skills REST endpoints.
 *
 * Exposed on `getContext().skills` (st-context.js) and mirrored on CardApp's
 * `ctx.skills`. All path/name validation is handled server-side; this module
 * is a thin transport wrapper parameterized by `getRequestHeaders` so unit
 * tests can exercise the real client against an Express router without
 * pulling in browser-only boot modules.
 *
 * Scope shapes:
 *   { kind: 'global' }
 *   { kind: 'preset', name: string }
 *   { kind: 'orch-preset', mode: 'spec'|'agenda'|'loop'|'director', name: string }
 *   { kind: 'character', characterFile: string }
 *   'all' — only valid for list()
 */

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
 * @param {object|string} scope
 * @returns {string}
 */
function scopeToUrl(scope) {
    if (scope === 'all' || !scope) return 'all';
    if (scope.kind === 'global') return 'global';
    if (scope.kind === 'preset') {
        return `preset/${scope.name}`;
    }
    if (scope.kind === 'orch-preset') {
        return `orch-preset/${scope.mode}/${scope.name}`;
    }
    if (scope.kind === 'character') {
        return `character/${scope.characterFile}`;
    }
    throw new Error(`invalid scope kind: ${scope.kind}`);
}

/**
 * @param {{ getRequestHeaders: () => Record<string, string> }} deps
 */
export function createSkillsApi({ getRequestHeaders }) {
    /**
     * Wrap fetch + JSON handling. Throws an Error whose `.status` and `.body`
     * mirror the server's error response so call sites can branch on them.
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

    return {
        // ==================== Inventory ====================

        list(opts = {}) {
            const scopeParam = scopeToUrl(opts.scope || 'all');
            return jsonFetch(`/api/skills?scope=${encodeURIComponent(scopeParam)}`);
        },

        async get(name, scope) {
            const list = await this.list({ scope });
            return list.find((e) => e.name === name) || null;
        },

        // ==================== Read content ====================

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

        listFiles(opts) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/files`,
            );
        },

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

        writeFile(opts) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/write`,
                { method: 'POST', body: JSON.stringify(opts) },
            );
        },

        editFile(opts) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/edit`,
                { method: 'POST', body: JSON.stringify(opts) },
            );
        },

        deleteFile(opts) {
            const params = new URLSearchParams({ path: String(opts.path || '') });
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file?${params}`,
                { method: 'DELETE' },
            );
        },

        renameFile(opts) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}/${encodeURIComponent(opts.name)}/file/rename`,
                { method: 'POST', body: JSON.stringify(opts) },
            );
        },

        // ==================== Management ====================

        install(opts) {
            return jsonFetch(`/api/skills/${encodeURIComponent(scopeToUrl(opts.scope))}`, {
                method: 'POST',
                body: JSON.stringify({ payload: opts.payload, conflictStrategy: opts.conflictStrategy }),
            });
        },

        delete(scope, name, opts = {}) {
            const qs = opts.expectedInstalledHash
                ? `?${new URLSearchParams({ expectedInstalledHash: opts.expectedInstalledHash })}`
                : '';
            return jsonFetch(`/api/skills/${encodeURIComponent(scopeToUrl(scope))}/${encodeURIComponent(name)}${qs}`, {
                method: 'DELETE',
            });
        },

        rename(scope, oldName, newName) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(scope))}/${encodeURIComponent(oldName)}/rename`,
                { method: 'POST', body: JSON.stringify({ toName: newName }) },
            );
        },

        moveScope(name, fromScope, toScope) {
            return jsonFetch(
                `/api/skills/${encodeURIComponent(scopeToUrl(fromScope))}/${encodeURIComponent(name)}/move-scope`,
                { method: 'POST', body: JSON.stringify({ toScope }) },
            );
        },

        deleteScope(scope) {
            return jsonFetch(`/api/skills/${encodeURIComponent(scopeToUrl(scope))}`, {
                method: 'DELETE',
            });
        },

        renameScope(scope, newName) {
            return jsonFetch('/api/skills/rename-scope', {
                method: 'POST',
                body: JSON.stringify({ scope, newName }),
            });
        },

        copyScope(fromScope, toScope) {
            return jsonFetch('/api/skills/copy-scope', {
                method: 'POST',
                body: JSON.stringify({ fromScope, toScope }),
            });
        },

        importBundled() {
            return jsonFetch('/api/skills/import-bundled', { method: 'POST' });
        },

        listBundledManifest() {
            return jsonFetch('/api/skills/bundled-manifest');
        },

        importFromUrl(opts) {
            return jsonFetch('/api/skills/import-from-url', {
                method: 'POST',
                body: JSON.stringify(opts),
            });
        },

        // ==================== Transport ====================

        packForEmbed(opts) {
            return jsonFetch('/api/skills/pack-for-embed', {
                method: 'POST',
                body: JSON.stringify(opts),
            });
        },

        previewExtractEmbed(opts) {
            return jsonFetch('/api/skills/extract-embed/preview', {
                method: 'POST',
                body: JSON.stringify(opts),
            });
        },

        executeExtractEmbed(opts) {
            return jsonFetch('/api/skills/extract-embed/execute', {
                method: 'POST',
                body: JSON.stringify(opts),
            });
        },
    };
}
