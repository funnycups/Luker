// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared `ctx` introspection + Luker-docs lookup executors used by every
 * iter-studio (CardApp Studio AI chat, orchestrator iter-studio, etc.).
 *
 * Each export is a pure async executor; callers pick their own tool name
 * + JSON-Schema definition and dispatch through their own runner. Lifting
 * keeps a single source of truth — when the ctx surface or the docs
 * endpoint changes, one fix is enough.
 *
 * Why no schema lives here: each iter-studio's tool-name conventions
 * differ (`luker_context_describe` vs `luker_ctx_describe`) and the
 * system prompts that name them are already baked in. We export the
 * behavior, not the binding.
 *
 * IMPORTANT: every `Luker.getContext()` call must be deferred to runtime
 * (inside the exported async functions). This module is transitively
 * imported during the orchestrator extension's boot, which happens
 * BEFORE `Luker` is assigned on `window`. A module-top `Luker.getContext()`
 * here will throw `ReferenceError: Luker is not defined` and brick the
 * whole app boot — symptom is a stuck `#preloader` and "Failed to
 * initialize Luker application" in the console.
 */

// Defer every `Luker.getContext()` lookup to call time — see header note.
function getCtx() {
    return Luker.getContext();
}
function getHeaders() {
    return getCtx().getRequestHeaders();
}

/**
 * Enumerate top-level properties of the live SillyTavern/Luker context.
 *
 * @param {object} [opts]
 * @param {string} [opts.filter] Case-insensitive substring on the key.
 * @returns {Promise<{ok: boolean, count?: number, keys?: Array<{key:string,type:string}>, error?: string}>}
 */
export async function listCtxKeys({ filter = '' } = {}) {
    const needle = String(filter || '').toLowerCase();
    let lukerCtx;
    try {
        lukerCtx = getCtx();
    } catch (e) {
        return { ok: false, error: `getContext() failed: ${e?.message || e}` };
    }
    const result = [];
    for (const key of Object.keys(lukerCtx).sort()) {
        if (needle && !key.toLowerCase().includes(needle)) continue;
        const v = lukerCtx[key];
        let type = typeof v;
        if (v === null) type = 'null';
        else if (Array.isArray(v)) type = 'array';
        result.push({ key, type });
    }
    return { ok: true, count: result.length, keys: result };
}

/**
 * Describe one ctx property by dot-path. Returns type / arity / preview
 * for functions, sub-key listing for objects, value for scalars.
 *
 * @param {object} opts
 * @param {string} opts.path Dot path, e.g. "generate" or "presets.state.patch".
 * @returns {Promise<object>}
 */
export async function describeCtxPath({ path }) {
    const target = String(path || '').trim();
    if (!target) return { ok: false, error: 'path is required' };
    const segments = target.split('.').map(s => s.trim()).filter(Boolean);
    let value;
    try {
        value = getCtx();
    } catch (e) {
        return { ok: false, error: `getContext() failed: ${e?.message || e}` };
    }
    let walked = '';
    for (const seg of segments) {
        if (value == null) {
            return { ok: false, error: `Path "${walked}" is null/undefined; cannot descend into "${seg}"` };
        }
        if (!(seg in value)) {
            return { ok: false, error: `Property "${seg}" not found at path "${walked || 'root'}"` };
        }
        value = value[seg];
        walked = walked ? `${walked}.${seg}` : seg;
    }
    const out = { ok: true, path: target };
    if (value === null) {
        out.type = 'null';
    } else if (Array.isArray(value)) {
        out.type = 'array';
        out.length = value.length;
    } else if (typeof value === 'function') {
        out.type = 'function';
        out.parameterCount = value.length;
        out.functionName = value.name || '';
        try {
            const src = String(value).replace(/\s+/g, ' ');
            out.sourcePreview = src.length > 280 ? src.slice(0, 277) + '...' : src;
        } catch { out.sourcePreview = ''; }
    } else if (typeof value === 'object') {
        out.type = 'object';
        const subKeys = Object.keys(value);
        out.subKeyCount = subKeys.length;
        out.subKeys = subKeys.slice(0, 60).map(k => {
            const v = value[k];
            let t = typeof v;
            if (v === null) t = 'null';
            else if (Array.isArray(v)) t = 'array';
            return { key: k, type: t };
        });
        if (subKeys.length > 60) {
            out.note = `${subKeys.length - 60} more keys not shown; descend further with a more specific path`;
        }
    } else {
        out.type = typeof value;
        try { out.value = JSON.stringify(value); } catch { out.value = String(value); }
    }
    return out;
}

/**
 * List Luker doc markdown files served by the existing `/api/docs/list`
 * endpoint (see src/endpoints/docs.js). zh-CN/zh-TW translations are
 * hidden by default because their content matches English line-for-line.
 *
 * @param {object} [opts]
 * @param {string} [opts.filter] Case-insensitive substring on the path.
 * @param {boolean} [opts.includeTranslations] Include zh-CN/zh-TW. Default false.
 * @param {typeof fetch} [opts.fetchImpl] Override for tests.
 * @returns {Promise<object>}
 */
export async function listLukerDocs({ filter = '', includeTranslations = false, fetchImpl = null } = {}) {
    const f = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    const needle = String(filter || '').toLowerCase();
    try {
        const resp = await f('/api/docs/list', { headers: getHeaders() });
        if (!resp.ok) return { ok: false, error: `Doc list endpoint returned ${resp.status}` };
        const data = await resp.json();
        const all = Array.isArray(data?.files) ? data.files : [];
        const isTranslation = (p) => /^(zh-CN|zh-TW)\//i.test(String(p || ''));
        const baseSet = includeTranslations ? all : all.filter(f => !isTranslation(f.path));
        const files = needle
            ? baseSet.filter(f => String(f.path || '').toLowerCase().includes(needle))
            : baseSet;
        return {
            ok: true,
            count: files.length,
            totalCount: all.length,
            hiddenTranslations: includeTranslations ? 0 : all.filter(f => isTranslation(f.path)).length,
            files,
        };
    } catch (e) {
        return { ok: false, error: `Failed to list docs: ${e?.message || e}` };
    }
}

/**
 * Read one Luker doc markdown file via the `/api/docs/file` endpoint.
 *
 * @param {object} opts
 * @param {string} opts.path Doc path relative to docs/, e.g.
 *        "development/extension-api/chat-and-state.md".
 * @param {typeof fetch} [opts.fetchImpl] Override for tests.
 * @returns {Promise<object>}
 */
export async function readLukerDoc({ path, fetchImpl = null }) {
    const f = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    const docPath = String(path || '').trim();
    if (!docPath) return { ok: false, error: 'path is required' };
    try {
        const url = `/api/docs/file?path=${encodeURIComponent(docPath)}`;
        const resp = await f(url, { headers: getHeaders() });
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json())?.error || ''; } catch { /* ignore */ }
            return { ok: false, error: `Doc fetch failed (${resp.status})${detail ? ': ' + detail : ''}` };
        }
        const data = await resp.json();
        return { ok: true, path: data?.path || docPath, size: data?.size || 0, content: String(data?.content || '') };
    } catch (e) {
        return { ok: false, error: `Failed to read doc: ${e?.message || e}` };
    }
}
