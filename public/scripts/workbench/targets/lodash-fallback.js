// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resolves Luker's runtime lodash lazily when available, with a dependency-free
// pure JS fallback for unit-test contexts that omit ctx.lib.lodash.

function parsePath(path) {
    if (Array.isArray(path)) return path.map(String);
    const str = String(path ?? '');
    if (!str) return [];
    const parts = [];
    const re = /[^.[\]]+|\[(?:([^"'\]]+)|(["'])(.*?)\2)\]/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        parts.push(m[1] ?? m[3] ?? m[0]);
    }
    return parts;
}

function pathHas(obj, path) {
    if (obj == null) return false;
    const parts = parsePath(path);
    if (!parts.length) return false;
    let cur = obj;
    for (const key of parts) {
        if (cur == null || typeof cur !== 'object') return false;
        if (Array.isArray(cur)) {
            const idx = Number(key);
            if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length || !(key in cur)) return false;
            cur = cur[idx];
        } else {
            if (!Object.prototype.hasOwnProperty.call(cur, key)) return false;
            cur = cur[key];
        }
    }
    return true;
}

function pathGet(obj, path, defaultValue = undefined) {
    if (obj == null) return defaultValue;
    const parts = parsePath(path);
    if (!parts.length) return defaultValue;
    let cur = obj;
    for (const key of parts) {
        if (cur == null) return defaultValue;
        cur = cur[key];
    }
    return cur === undefined ? defaultValue : cur;
}

function pathSet(obj, path, value) {
    if (!obj || typeof obj !== 'object') return obj;
    const parts = parsePath(path);
    if (!parts.length) return obj;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const nextIsIndex = /^(0|[1-9]\d*)$/.test(parts[i + 1]);
        if (cur[key] == null || typeof cur[key] !== 'object') {
            cur[key] = nextIsIndex ? [] : {};
        }
        cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
}

function pathUnset(obj, path) {
    if (!obj || typeof obj !== 'object') return true;
    const parts = parsePath(path);
    if (!parts.length) return true;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur?.[parts[i]];
        if (cur == null || typeof cur !== 'object') return true;
    }
    delete cur[parts[parts.length - 1]];
    return true;
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a == null || b == null || typeof a !== typeof b || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
}

function cloneDeep(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneDeep);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneDeep(v);
    return out;
}

const FALLBACK_LODASH = Object.freeze({
    get: pathGet,
    has: pathHas,
    set: pathSet,
    unset: pathUnset,
    isEqual: deepEqual,
    cloneDeep,
});

function isRealLodash(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (typeof candidate.get !== 'function' || typeof candidate.has !== 'function') return false;
    try {
        return candidate.has({ a: 1 }, 'a') === true && candidate.has({}, 'a') === false;
    } catch {
        return false;
    }
}

export function resolveLodash(ctx = null) {
    const candidates = [
        ctx?.lib?.lodash,
        globalThis.Luker?.getContext?.()?.lib?.lodash,
        globalThis.lukerContext?.lib?.lodash,
        globalThis.SillyTavern?.getContext?.()?.lib?.lodash,
    ];
    for (const candidate of candidates) {
        if (isRealLodash(candidate)) return candidate;
    }
    return FALLBACK_LODASH;
}
