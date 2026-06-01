/**
 * @file Display-only macro resolver
 *
 * When extracting a side-effect macro, the value template may itself contain
 * nested macros — e.g. {{setvar::log::user is {{user}} at {{time}}}}.
 * Those nested macros are *display-only* (read state, render text) and must
 * be resolved into their literal values before the op is recorded.
 *
 * We can't simply call SillyTavern's `substituteParams` here, because that
 * function also executes side-effect macros (the very ones we just extracted).
 * Calling it would either double-apply the AI's writes or scramble nesting.
 *
 * This module provides `resolveDisplayMacros(text, env)` — a restricted
 * substitution that:
 *   1. Resolves recognized display macros from a caller-provided env.
 *   2. Leaves side-effect macros untouched (they're not for us to execute).
 *   3. Leaves unrecognized macros untouched (forward compatibility).
 *
 * The env object is supplied by the caller (extractor) so this module stays
 * a pure function — no global reads, fully testable.
 */

/**
 * @typedef {Object} ResolveEnv
 * @property {string} [user] - Current persona name
 * @property {string} [char] - Current character name
 * @property {() => string} [time] - Returns current time string at call site
 * @property {() => string} [date] - Returns current date string at call site
 * @property {(name: string) => string} [getvar] - Resolves a local variable
 * @property {(name: string) => string} [getglobalvar] - Resolves a global variable
 * @property {() => string} [lastMessage] - Most recent message text (excluding current)
 * @property {() => string} [lastUserMessage]
 * @property {() => string} [lastCharMessage]
 * @property {() => string} [random] - A random number, fresh per call
 * @property {Record<string, string | (() => string)>} [extra] - Additional named macros
 */

/**
 * The canonical set of side-effect macro op names. Used by the resolver to
 * intentionally skip them.
 */
const SIDE_EFFECT_OPS = new Set([
    'setvar', 'addvar', 'incvar', 'decvar', 'deletevar',
    'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'deleteglobalvar',
]);

/**
 * Resolves display-only macros in `text` using values from `env`.
 *
 * Macros are walked depth-first: nested macros inside a macro argument are
 * resolved before the outer macro is evaluated. This matches SillyTavern's
 * inside-out semantics for `{{setvar::a::{{getvar::b}}}}` style nesting.
 *
 * Resolution rules:
 *   • {{user}} → env.user
 *   • {{char}} → env.char
 *   • {{time}} → env.time()
 *   • {{date}} → env.date()
 *   • {{random}} → env.random()
 *   • {{getvar::name}} → env.getvar(name)
 *   • {{getglobalvar::name}} → env.getglobalvar(name)
 *   • {{lastMessage}} → env.lastMessage()
 *   • {{lastUserMessage}} → env.lastUserMessage()
 *   • {{lastCharMessage}} → env.lastCharMessage()
 *   • side-effect ops → left as literal (never executed)
 *   • anything else → looked up in env.extra; left as literal if absent
 *
 * @param {string} text
 * @param {ResolveEnv} [env]
 * @returns {string}
 */
export function resolveDisplayMacros(text, env = {}) {
    if (typeof text !== 'string' || text.length === 0) return text ?? '';
    return resolveRange(text, 0, text.length, env);
}

// ----- internals ---------------------------------------------------------

/**
 * Resolve all macros within text[start..end). Recurses into nested macros.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {ResolveEnv} env
 * @returns {string}
 */
function resolveRange(text, start, end, env) {
    let out = '';
    let i = start;

    while (i < end) {
        if (text[i] === '{' && text[i + 1] === '{' && i + 1 < end) {
            const closeIdx = findMatchingClose(text, i, end);
            if (closeIdx < 0) {
                // Unterminated `{{` — emit the rest verbatim and stop scanning macros
                out += text.slice(i, end);
                break;
            }
            const innerStart = i + 2;
            const innerEnd = closeIdx;
            const resolvedInner = resolveRange(text, innerStart, innerEnd, env);
            out += renderMacro(resolvedInner, text.slice(i, closeIdx + 2), env);
            i = closeIdx + 2;
            continue;
        }
        out += text[i];
        i++;
    }
    return out;
}

/**
 * Locate the `}}` that closes the `{{` at `openIdx`, accounting for nested
 * `{{...}}`. Returns the index of the closing `}` of `}}`, i.e. the position
 * such that `text.slice(openIdx, closeIdx + 2)` is the full macro literal.
 * Returns -1 if no matching close exists within `end`.
 *
 * @param {string} text
 * @param {number} openIdx
 * @param {number} end
 * @returns {number}
 */
function findMatchingClose(text, openIdx, end) {
    let depth = 1;
    let i = openIdx + 2;
    while (i < end - 1) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth++;
            i += 2;
            continue;
        }
        if (text[i] === '}' && text[i + 1] === '}') {
            depth--;
            if (depth === 0) return i;
            i += 2;
            continue;
        }
        i++;
    }
    return -1;
}

/**
 * Render a single macro given its already-resolved inner text. If the macro
 * is unknown or a side-effect op, returns the original literal so callers
 * downstream see the verbatim macro.
 *
 * @param {string} inner Inner text with all nested macros already resolved
 * @param {string} originalLiteral Original `{{...}}` literal from source
 * @param {ResolveEnv} env
 * @returns {string}
 */
function renderMacro(inner, originalLiteral, env) {
    const trimmed = inner.trim();
    if (trimmed.length === 0) return originalLiteral;

    // Variable shorthand reads: `{{.name}}` and `{{$name}}` (with optional
    // dotted path) translate to getvar / getglobalvar. Operator-bearing
    // shorthand (`{{.x = 1}}`, `{{.x++}}`, etc.) is a write and is left
    // verbatim — execution belongs to the extractor / main macro engine.
    const shorthand = matchShorthandRead(trimmed);
    if (shorthand) {
        const fn = shorthand.scope === 'local' ? env.getvar : env.getglobalvar;
        return callWithKey(fn, shorthand.name);
    }

    // Split on first `::` (top-level not needed, inner is already resolved)
    const sepIdx = trimmed.indexOf('::');
    const head = (sepIdx < 0 ? trimmed : trimmed.slice(0, sepIdx)).trim().toLowerCase();
    const tail = sepIdx < 0 ? '' : trimmed.slice(sepIdx + 2);

    if (SIDE_EFFECT_OPS.has(head)) {
        // Don't execute side-effect macros — leave verbatim
        return originalLiteral;
    }

    switch (head) {
        case 'user':
            return stringify(env.user);
        case 'char':
            return stringify(env.char);
        case 'time':
            return callIfFn(env.time);
        case 'date':
            return callIfFn(env.date);
        case 'random':
            return callIfFn(env.random);
        case 'lastmessage':
            return callIfFn(env.lastMessage);
        case 'lastusermessage':
            return callIfFn(env.lastUserMessage);
        case 'lastcharmessage':
            return callIfFn(env.lastCharMessage);
        case 'getvar':
            return callWithKey(env.getvar, tail);
        case 'getglobalvar':
            return callWithKey(env.getglobalvar, tail);
        default: {
            const fromExtra = env.extra?.[head];
            if (fromExtra === undefined) return originalLiteral;
            return typeof fromExtra === 'function' ? stringify(fromExtra()) : stringify(fromExtra);
        }
    }
}

/**
 * Variable shorthand identifier (with optional dotted path). Anchored full
 * match. Mirrors `MACRO_VARIABLE_SHORTHAND_PATTERN` from the main lexer —
 * each segment must start with a letter and end with a word char.
 */
const SHORTHAND_READ_RE = /^([.$])([a-zA-Z](?:[\w\-]*[\w])?(?:\.[a-zA-Z](?:[\w\-]*[\w])?)*)$/;

/**
 * Tests whether `inner` (already trimmed) is a pure variable-shorthand read
 * with no operator. Returns the scope and full identifier (root + path), or
 * null when this is not a read.
 *
 * The full identifier — including dotted path — is handed to env.getvar /
 * env.getglobalvar; the resolver does not parse paths itself. ST's getvar
 * already understands dotted addressing.
 *
 * @param {string} inner
 * @returns {{ scope: 'local' | 'global', name: string } | null}
 */
function matchShorthandRead(inner) {
    const m = SHORTHAND_READ_RE.exec(inner);
    if (!m) return null;
    return { scope: m[1] === '.' ? 'local' : 'global', name: m[2] };
}

/**
 * @param {((name: string) => string) | undefined} fn
 * @param {string} key
 */
function callWithKey(fn, key) {
    if (typeof fn !== 'function') return '';
    try {
        return stringify(fn(key.trim()));
    } catch {
        return '';
    }
}

/** @param {(() => string) | undefined} fn */
function callIfFn(fn) {
    if (typeof fn !== 'function') return '';
    try {
        return stringify(fn());
    } catch {
        return '';
    }
}

/** @param {unknown} v */
function stringify(v) {
    if (v === null || v === undefined) return '';
    return String(v);
}
