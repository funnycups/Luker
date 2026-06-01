/**
 * @file Variable-shorthand → canonical VarOp normalization
 *
 * The scanner returns `subvar` matches for shorthand writes like
 * `{{.x = v}}` or `{{.x ??= 5}}`. apply.js / rebuilder / panel only know
 * the seven canonical VarOps, so this module translates each shorthand
 * into either a canonical op or `null` (the write is a runtime no-op
 * given current state — e.g. `??=` against an already-set variable).
 *
 * The translation is deterministic given (match, state) and runs in the
 * extractor between resolve and applyOp, so a chain like
 *   {{.a = 1}} {{.b ||= {{.a}}}}
 * sees b's `||=` resolved against a=1 from the prior op.
 *
 * Pure module — no DOM, no globals.
 */

/**
 * @typedef {import('./apply.js').VarOp} VarOp
 * @typedef {import('./scanner.js').MacroMatch} MacroMatch
 */

/**
 * Match ST's `isFalseBoolean` for `||=` falsiness without dragging the
 * front-end utils chain into this pure module. Kept in sync — if the source
 * adds a new truthy/falsy literal, mirror it here.
 *
 * @param {string} arg
 * @returns {boolean}
 */
function isFalseBooleanLiteral(arg) {
    return ['off', 'false', '0'].includes(arg?.trim?.()?.toLowerCase?.());
}

/**
 * Normalize a scanner shorthand match into a canonical VarOp, or `null`
 * if the shorthand evaluates to a no-op given current state.
 *
 * @param {MacroMatch} match Must have `op: 'subvar'` and a `shorthand` field
 * @param {Record<string, any>} state Current `chat_metadata.variables`
 * @param {(raw: string) => string} resolveValue Display-macro resolver for the rawValue template
 * @returns {VarOp | null}
 */
export function normalizeShorthandMatch(match, state, resolveValue) {
    if (!match || match.op !== 'subvar') return null;
    const key = match.key;
    const path = typeof match.path === 'string' && match.path.length > 0 ? match.path : undefined;
    const shorthand = match.shorthand;

    switch (shorthand) {
        case '++':
            return buildOp('incvar', key, path);
        case '--':
            return buildOp('decvar', key, path);
        case '=': {
            const value = resolveValue(match.rawValue ?? '');
            return buildOp('setvar', key, path, value);
        }
        case '+=': {
            const value = resolveValue(match.rawValue ?? '');
            return buildOp('addvar', key, path, value);
        }
        case '-=': {
            const raw = resolveValue(match.rawValue ?? '');
            const num = Number(raw);
            // ST's `sub` operator is numeric-only; non-numeric values warn
            // and skip the write — mirror that by producing no op.
            if (Number.isNaN(num)) return null;
            return buildOp('addvar', key, path, String(-num));
        }
        case '||=': {
            const current = readCurrent(state, key, path);
            if (!isFalsyForShorthand(current)) return null;
            const value = resolveValue(match.rawValue ?? '');
            return buildOp('setvar', key, path, value);
        }
        case '??=': {
            const current = readCurrent(state, key, path);
            if (current !== undefined) return null;
            const value = resolveValue(match.rawValue ?? '');
            return buildOp('setvar', key, path, value);
        }
        default:
            return null;
    }
}

/**
 * Construct a VarOp, attaching path/value only when present so test
 * fixtures continue to match `{ op, key }` shape for flat reads.
 *
 * @param {VarOp['op']} op
 * @param {string} key
 * @param {string} [path]
 * @param {string} [value]
 * @returns {VarOp}
 */
function buildOp(op, key, path, value) {
    /** @type {VarOp} */
    const out = { op, key };
    if (path) out.path = path;
    if (value !== undefined) out.value = value;
    return out;
}

/**
 * Read the current value at (key, path) in state. Returns undefined when
 * the path doesn't exist, the root isn't a JSON-encoded container, or
 * an intermediate segment is missing.
 *
 * @param {Record<string, any>} state
 * @param {string} key
 * @param {string | undefined} path
 * @returns {any}
 */
function readCurrent(state, key, path) {
    if (!state || typeof state !== 'object') return undefined;
    const root = state[key];
    if (!path) return root;
    let container;
    if (typeof root === 'string') {
        try {
            container = JSON.parse(root);
        } catch {
            return undefined;
        }
    } else if (root && typeof root === 'object') {
        container = root;
    } else {
        return undefined;
    }
    return navigatePath(container, path);
}

/**
 * Walk `container` down the dotted `path`, returning the leaf or undefined.
 * Numeric path segments index into arrays; non-numeric index into objects.
 *
 * @param {any} container
 * @param {string} path
 * @returns {any}
 */
function navigatePath(container, path) {
    const segs = path.split('.');
    let node = container;
    for (const seg of segs) {
        if (node === null || node === undefined) return undefined;
        if (typeof node !== 'object') return undefined;
        if (Array.isArray(node)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
            node = node[idx];
        } else {
            if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
            node = node[seg];
        }
    }
    return node;
}

/**
 * Falsiness for `||=`. Matches the engine's `isFalsy` used in variable
 * shorthand evaluation: empty string, '0', 'false', 'off' (case-insensitive),
 * plus standard JS falsy values (null, undefined, 0, false, NaN).
 *
 * @param {any} value
 * @returns {boolean}
 */
function isFalsyForShorthand(value) {
    if (value === null || value === undefined) return true;
    if (value === false || value === 0) return true;
    if (typeof value === 'number' && Number.isNaN(value)) return true;
    if (typeof value === 'string') {
        if (value.length === 0) return true;
        return isFalseBooleanLiteral(value);
    }
    return false;
}
