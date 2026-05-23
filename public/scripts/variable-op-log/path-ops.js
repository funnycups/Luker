/**
 * @file Path helpers for structured variable ops.
 *
 * Pure module — no DOM, no globals, no SillyTavern imports. Operates on
 * plain `state` objects of the same shape as `chat_metadata.variables`
 * (top-level values are strings; structured data lives JSON-stringified).
 *
 * `applyPathOp` is the dispatch entry; the other exports are unit-testable
 * primitives that compose into it.
 */

/**
 * Split a possibly-dotted variable name into its top-level root and the
 * remaining dotted path. The root is always the trackedKeys-friendly key
 * stored in `chat_metadata.variables`; the path navigates inside the
 * parsed structured value.
 *
 * @param {string} name
 * @returns {{ root: string, path: string }}
 */
export function splitRootAndPath(name) {
    if (typeof name !== 'string' || name.length === 0) {
        return { root: '', path: '' };
    }
    const dot = name.indexOf('.');
    if (dot < 0) return { root: name, path: '' };
    return { root: name.slice(0, dot), path: name.slice(dot + 1) };
}

/**
 * Best-effort JSON parse. Only object/array results are returned parsed —
 * primitives (number, boolean, null) are kept as their original string so
 * round-tripping through `JSON.stringify` produces the same wire form.
 * Non-string inputs are returned untouched.
 *
 * The number case is intentional: leaf writes through path ops should
 * land as numbers when the value template was `'50'`, matching the
 * existing read-side number coercion.
 *
 * @param {any} raw
 * @returns {any}
 */
export function tryParseValue(raw) {
    if (typeof raw !== 'string') return raw;
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && (typeof parsed === 'object')) return parsed;
        if (typeof parsed === 'number') return parsed;
        return raw;
    } catch {
        return raw;
    }
}

/**
 * Set `value` at `path` inside `container`, creating intermediate objects
 * or arrays as needed. Arrays are auto-created when the next segment is
 * pure-numeric, otherwise objects. Existing scalar intermediates are
 * overwritten with a fresh container — design choice from the spec
 * ("auto-build, lodash.set semantics").
 *
 * @param {object|array} container
 * @param {string} path
 * @param {any} value
 */
export function lodashSetPath(container, path, value) {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return;
    let node = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        const next = segs[i + 1];
        const wantArray = segIsArrayIndex(next);
        const child = node[seg];
        if (child === undefined || child === null || typeof child !== 'object') {
            node[seg] = wantArray ? [] : {};
        }
        node = node[seg];
    }
    node[segs[segs.length - 1]] = value;
}

/**
 * Delete the value at `path` inside `container`. For array parents, splices
 * the element out. Returns true when something was actually removed.
 *
 * @param {object|array} container
 * @param {string} path
 * @returns {boolean}
 */
export function lodashDeletePath(container, path) {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return false;
    let node = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        const child = node[seg];
        if (child === undefined || child === null || typeof child !== 'object') {
            return false;
        }
        node = child;
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(node)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return false;
        node.splice(idx, 1);
        return true;
    }
    if (!Object.prototype.hasOwnProperty.call(node, last)) return false;
    delete node[last];
    return true;
}

/**
 * Push `value` onto the array at `path` inside `container`, creating
 * the array (and any intermediates) if missing. Refuses if the leaf
 * exists and isn't an array. Returns whether the push happened.
 *
 * @param {object|Array<any>} container
 * @param {string} path
 * @param {any} value
 * @returns {boolean}
 */
export function pushAtPath(container, path, value) {
    const nav = navigateToParent(container, path);
    if (!nav) return false;
    const { parent, lastSeg } = nav;
    const existing = parent[lastSeg];
    if (existing === undefined || existing === null) {
        parent[lastSeg] = [value];
        return true;
    }
    if (!Array.isArray(existing)) return false;
    existing.push(value);
    return true;
}

/**
 * Pop the last element off the array at `path` inside `container`. Returns
 * the popped value, or undefined when the target is missing / not an array /
 * empty.
 *
 * @param {object|Array<any>} container
 * @param {string} path
 * @returns {any}
 */
export function popAtPath(container, path) {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return undefined;
    let node = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const child = node[segs[i]];
        if (child === undefined || child === null || typeof child !== 'object') return undefined;
        node = child;
    }
    const last = segs[segs.length - 1];
    const arr = node[last];
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    return arr.pop();
}

/**
 * @typedef {import('./apply.js').VarOp} VarOp
 */

/**
 * Apply a path-flavored op to `state`. Encapsulates the parse/mutate/
 * stringify cycle. Never throws; warns on user-visible failures.
 *
 * @param {Record<string,any>} state
 * @param {VarOp} op
 * @returns {any} The new top-level value at `state[op.key]`, or undefined.
 */
export function applyPathOp(state, op) {
    if (!state || typeof state !== 'object') return undefined;
    if (!op || typeof op.key !== 'string' || !op.key) return undefined;

    const path = typeof op.path === 'string' ? op.path : '';
    const segs = parsePathSegments(path);
    const firstSeg = segs[0];

    switch (op.op) {
        case 'setvar': {
            if (segs.length === 0) {
                // Empty op.path → defensive flat fallback (caller should have
                // routed to apply.js's flat branch, but we tolerate the call).
                // Non-empty op.path that parsed to zero segments means every
                // segment was forbidden — that's a no-op, not a flat write.
                if (path.length === 0) {
                    state[op.key] = op.value ?? '';
                    return state[op.key];
                }
                console.warn('[variable-op-log] setvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            lodashSetPath(root, path, tryParseValue(op.value));
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'deletevar': {
            if (segs.length === 0) {
                if (path.length === 0) {
                    // Flat deletevar — no path supplied
                    delete state[op.key];
                    return undefined;
                }
                // Path supplied but every segment was forbidden — no-op
                console.warn('[variable-op-log] deletevar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root, exists } = getOrInitRoot(state, op.key, firstSeg, op);
            if (!exists) {
                // Nothing to delete from — no-op without creating state.
                return undefined;
            }
            const ok = lodashDeletePath(root, path);
            if (!ok) {
                console.warn('[variable-op-log] deletevar path not found', op);
                return state[op.key];
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'pushvar': {
            if (segs.length === 0 && path.length > 0) {
                console.warn('[variable-op-log] pushvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            const value = tryParseValue(op.value);
            if (segs.length === 0) {
                if (!Array.isArray(root)) {
                    console.warn('[variable-op-log] pushvar root is not array', op);
                    return state[op.key];
                }
                root.push(value);
            } else {
                const ok = pushAtPath(root, path, value);
                if (!ok) {
                    console.warn('[variable-op-log] pushvar target is not array', op);
                    return state[op.key];
                }
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'popvar': {
            if (segs.length === 0 && path.length > 0) {
                console.warn('[variable-op-log] popvar path rejected (forbidden segments)', op);
                return state[op.key];
            }
            const { root, exists } = getOrInitRoot(state, op.key, firstSeg, op);
            if (!exists) {
                // Nothing to pop from — no-op without creating state.
                return undefined;
            }
            if (segs.length === 0) {
                if (!Array.isArray(root)) {
                    console.warn('[variable-op-log] popvar root is not array', op);
                    return state[op.key];
                }
                root.pop();
            } else {
                popAtPath(root, path);
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        case 'incvar':
        case 'decvar': {
            // No path / forbidden-only path → no-op. Pathless inc/dec belongs
            // to apply.js's flat branch.
            if (segs.length === 0) return undefined;
            const delta = op.op === 'incvar' ? 1 : -1;
            const { root } = getOrInitRoot(state, op.key, firstSeg, op);
            const parentSegs = segs.slice(0, -1);
            const leafKey = segs[segs.length - 1];
            let node = root;
            for (const seg of parentSegs) {
                const next = node[seg];
                if (next === undefined || next === null || typeof next !== 'object') {
                    node[seg] = {};
                }
                node = node[seg];
            }
            const current = node[leafKey];
            const numericCurrent = Number(current);
            if (current === undefined || current === null || current === '' || Number.isNaN(numericCurrent)) {
                if (current === undefined || current === null || current === '') {
                    node[leafKey] = delta;
                } else {
                    // Non-numeric current + numeric delta → string concat
                    // (mirrors flat addToVariable semantics).
                    node[leafKey] = String(current) + String(delta);
                }
            } else {
                node[leafKey] = numericCurrent + delta;
            }
            state[op.key] = JSON.stringify(root);
            return state[op.key];
        }
        default:
            return undefined;
    }
}

// ----- internals ---------------------------------------------------------

/**
 * Decide what root container `state[key]` should be when we start applying
 * a path op. Returns `{ root, exists }` where `root` is a fresh-or-parsed
 * container and `exists` indicates whether the top-level key was already
 * present.
 *
 * Container type rules:
 *   - For pushvar/popvar with no path: array.
 *   - For all other path ops: array if the first path segment is numeric,
 *     otherwise object.
 *   - If `state[key]` already parses as object/array, use that as-is.
 *   - Otherwise (scalar string, missing) build a fresh container of the
 *     correct shape. Note: only the SET/PUSH paths actually persist this
 *     fresh container; DELETE/POP early-return on `exists === false`.
 *
 * @param {Record<string,any>} state
 * @param {string} key
 * @param {string} firstSeg
 * @param {VarOp} op
 * @returns {{ root: object|Array<any>, exists: boolean }}
 */
function getOrInitRoot(state, key, firstSeg, op) {
    const raw = state[key];
    const isPushPopNoPath = (op.op === 'pushvar' || op.op === 'popvar') && (!op.path || op.path.length === 0);
    const wantArrayShape = isPushPopNoPath || (firstSeg !== undefined && segIsArrayIndex(firstSeg));

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object') {
                return { root: parsed, exists: true };
            }
        } catch {
            // fall through
        }
    } else if (raw !== null && typeof raw === 'object') {
        return { root: raw, exists: true };
    }

    return { root: wantArrayShape ? [] : {}, exists: false };
}

/**
 * Segments that must never appear in a path — writing through them would
 * mutate `Object.prototype` (prototype pollution). Paths can originate from
 * AI-generated `{{setvar::__proto__.x::y}}` macros, so this is a real
 * attack surface; lodash blocks these and so do we.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a dotted path into segments. Numeric-only segments are kept as
 * strings — callers decide whether to treat them as array indices based on
 * the parent container type at walk time.
 *
 * Empty segments (from `a..b` or leading/trailing dots) are silently
 * dropped. Any segment named `__proto__`, `constructor`, or `prototype`
 * causes the entire path to be rejected (returns `[]`) so the caller
 * becomes a safe no-op — prevents prototype-pollution writes from
 * untrusted AI-generated paths.
 *
 * @param {string} path
 * @returns {string[]}
 */
function parsePathSegments(path) {
    if (typeof path !== 'string' || path.length === 0) return [];
    const out = [];
    for (const seg of path.split('.')) {
        if (seg.length === 0) continue;
        if (FORBIDDEN_SEGMENTS.has(seg)) return [];
        out.push(seg);
    }
    return out;
}

/** @param {string} seg */
function segIsArrayIndex(seg) {
    return /^\d+$/.test(seg);
}

/**
 * Walk to the parent of the last path segment, creating intermediate
 * objects/arrays as needed. Returns `{ parent, lastSeg }` or `null` when
 * the walk hits a scalar intermediate (in which case the caller should
 * leave state alone).
 *
 * @param {object|Array<any>} container
 * @param {string} path
 * @returns {{ parent: object|Array<any>, lastSeg: string } | null}
 */
function navigateToParent(container, path) {
    const segs = parsePathSegments(path);
    if (segs.length === 0) return null;
    let node = container;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        const next = segs[i + 1];
        const wantArray = segIsArrayIndex(next);
        const child = node[seg];
        if (child === undefined || child === null) {
            node[seg] = wantArray ? [] : {};
        } else if (typeof child !== 'object') {
            return null;
        }
        node = node[seg];
    }
    return { parent: node, lastSeg: segs[segs.length - 1] };
}
