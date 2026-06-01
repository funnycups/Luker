/**
 * @file Side-effect macro scanner
 *
 * Recognizes chat-local side-effect variable macros embedded in message text:
 *   {{setvar::name::value}}
 *   {{addvar::name::value}}
 *   {{incvar::name}}
 *   {{decvar::name}}
 *   {{deletevar::name}}
 *   {{pushvar::name::value}}
 *   {{popvar::name}}
 *
 * Keys may be dotted to address nested paths inside an object/array root
 * (e.g. `{{setvar::roster.alice.hp::50}}` ⇒ key=`roster`, path=`alice.hp`).
 * Scanner returns the root and the dotted remainder separately; downstream
 * consumers reassemble or interpret the path.
 *
 * This is a pure module — no DOM, no globals, no SillyTavern dependencies.
 * Scans must be deterministic and idempotent: a string with no recognized
 * macros must yield zero matches.
 *
 * Global variable macros ({{setglobalvar}} etc.) are intentionally excluded
 * from the whitelist — global variables live outside chat metadata and are
 * not tracked by the op-log system.
 */

/**
 * @typedef {Object} MacroMatch
 * @property {'setvar'|'addvar'|'incvar'|'decvar'|'deletevar'|'pushvar'|'popvar'|'subvar'} op
 *   `subvar` is an internal scanner-only op produced by shorthand syntax
 *   (`{{.x=v}}`, `{{.x++}}`, `{{.x||=v}}`, etc.). The extractor normalizes
 *   it into one of the seven canonical VarOps before recording, so apply /
 *   rebuilder / panel never see `subvar`. The `shorthand` field distinguishes
 *   the specific operator.
 * @property {string} key - Top-level variable name (root)
 * @property {string} [path] - Dotted remainder of the key; empty / absent when flat
 * @property {string} [rawValue] - Unresolved value template (for setvar/addvar/pushvar/subvar)
 * @property {'='|'+='|'-='|'++'|'--'|'||='|'??='} [shorthand]
 *   Only present when this match originated from variable shorthand syntax.
 *   The scanner does NOT recognize comparison or logical-read operators
 *   (`==`, `!=`, `<`, `<=`, `>`, `>=`, `||`, `??`) — those are pure reads
 *   with no side effect and live in the resolver / main macro engine.
 * @property {number} start - Inclusive start index in source text
 * @property {number} end - Exclusive end index in source text
 * @property {string} literal - The exact substring that matched
 */

/**
 * Shorthand operators that mutate state. Order matters: longer prefixes
 * must come first so `||=` is tested before `||`-style false positives,
 * and `++` before any future single-char operator.
 */
const SHORTHAND_OPS = /** @type {const} */ (['||=', '??=', '++', '--', '+=', '-=', '=']);

/**
 * Valid shorthand variable identifier: starts with a letter, ends with a
 * word character. Mirrors `MACRO_VARIABLE_SHORTHAND_PATTERN` in the main
 * macro lexer so shapes the engine accepts as a shorthand are recognized
 * here too. Anchored — full-string match.
 */
const SHORTHAND_IDENT_RE = /^[a-zA-Z](?:[\w\-]*[\w])?$/;

/**
 * Scans text for the next side-effect macro starting at or after `cursor`.
 * Returns null when no further matches exist.
 *
 * The scanner is balance-aware: macro values may themselves contain `{{...}}`
 * subexpressions (nested macros). Naive regex would split on the first
 * `}}`, breaking nested cases. We walk character by character, tracking
 * nesting depth, and accept the closing `}}` only at depth zero.
 *
 * @param {string} text
 * @param {number} [cursor=0]
 * @returns {MacroMatch | null}
 */
export function findNextSideEffectMacro(text, cursor = 0) {
    if (typeof text !== 'string') return null;

    const len = text.length;
    let i = Math.max(0, cursor | 0);

    while (i < len - 3) {
        // Look for `{{<op>`
        const openIdx = text.indexOf('{{', i);
        if (openIdx < 0 || openIdx >= len - 3) return null;

        // Honor the `\{{...}}` escape: when the opener is preceded by an odd
        // number of backslashes, treat it as literal text and skip past it.
        // (Even backslash counts mean those backslashes are themselves escapes
        // for literal `\` characters and the `{{` is unescaped.)
        let backslashes = 0;
        let scan = openIdx - 1;
        while (scan >= 0 && text[scan] === '\\') {
            backslashes++;
            scan--;
        }
        if (backslashes % 2 === 1) {
            i = openIdx + 2;
            continue;
        }

        const afterOpen = openIdx + 2;

        // Try variable-shorthand side-effect form first: `{{.NAME OP VALUE?}}`.
        // Only the `.` (local) prefix is in scope — `$` writes are global and
        // not tracked, mirroring the `setglobalvar` exclusion above.
        const shorthand = parseShorthandBody(text, openIdx, afterOpen);
        if (shorthand) return shorthand;

        const opInfo = matchOpHead(text, afterOpen);
        if (!opInfo) {
            // Not one of our ops — skip this `{{` and keep scanning
            i = afterOpen;
            continue;
        }

        const { op, headEnd } = opInfo;
        const parsed = parseMacroBody(text, openIdx, headEnd, op);
        if (parsed) return parsed;

        // Malformed body — skip past the `{{` and try again
        i = afterOpen;
    }

    return null;
}

/**
 * Scans the entire text and returns every recognized side-effect macro in
 * order of appearance. Internally just iterates `findNextSideEffectMacro`.
 *
 * @param {string} text
 * @returns {MacroMatch[]}
 */
export function scanAllSideEffectMacros(text) {
    /** @type {MacroMatch[]} */
    const out = [];
    let cursor = 0;
    while (true) {
        const match = findNextSideEffectMacro(text, cursor);
        if (!match) break;
        out.push(match);
        cursor = match.end;
    }
    return out;
}

/**
 * Removes every recognized side-effect macro from text, leaving the rest
 * untouched. The returned string is what the user will see / what gets
 * sent to the model.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSideEffectMacros(text) {
    if (typeof text !== 'string') return text;
    const matches = scanAllSideEffectMacros(text);
    if (matches.length === 0) return text;

    let out = '';
    let cursor = 0;
    for (const m of matches) {
        out += text.slice(cursor, m.start);
        cursor = m.end;
    }
    out += text.slice(cursor);
    return out;
}

/**
 * Try to parse a variable-shorthand side-effect macro starting at `openIdx`.
 *
 * Recognized forms (operator-bearing only — pure reads like `{{.x}}` are
 * left to the resolver):
 *   {{.NAME = VALUE}}     → subvar/=
 *   {{.NAME += VALUE}}    → subvar/+=
 *   {{.NAME -= VALUE}}    → subvar/-=
 *   {{.NAME ++}}          → subvar/++
 *   {{.NAME --}}          → subvar/--
 *   {{.NAME ||= VALUE}}   → subvar/||=
 *   {{.NAME ??= VALUE}}   → subvar/??=
 *
 * Identifier may be dotted (`{{.roster.alice.hp = 50}}`); the leading dot
 * is the shorthand prefix, NOT a path separator. Anything after the second
 * `.` becomes the path. Whitespace around the operator is allowed (the
 * main macro lexer also allows it).
 *
 * Returns `null` when the body is not a recognized shorthand write; callers
 * fall through to `matchOpHead` for the conventional `{{setvar::...}}` path.
 *
 * @param {string} text
 * @param {number} openIdx Position of the `{{` opener
 * @param {number} bodyStart Position immediately after `{{`
 * @returns {MacroMatch | null}
 */
function parseShorthandBody(text, openIdx, bodyStart) {
    const len = text.length;
    let i = bodyStart;

    // Optional whitespace before the prefix
    while (i < len && isWs(text[i])) i++;
    if (i >= len || text[i] !== '.') return null;
    i++;

    // Identifier (with optional dotted path). Stop at whitespace or operator/close.
    const identStart = i;
    while (i < len) {
        const c = text[i];
        if (isWs(c)) break;
        if (c === '}' || c === '{') break;
        if (isShorthandOpStart(text, i)) break;
        i++;
    }
    const rawIdent = text.slice(identStart, i);
    if (rawIdent.length === 0) return null;
    const { root, path } = splitKey(rawIdent);
    if (!SHORTHAND_IDENT_RE.test(root)) return null;
    // Path segments must each look like an identifier too — guards against
    // mistaking arbitrary `.something.` text for a shorthand expression.
    if (path) {
        for (const seg of path.split('.')) {
            if (!SHORTHAND_IDENT_RE.test(seg)) return null;
        }
    }

    // Optional whitespace before the operator
    while (i < len && isWs(text[i])) i++;
    if (i >= len) return null;

    const opAt = i;
    let shorthand = null;
    for (const candidate of SHORTHAND_OPS) {
        if (text.startsWith(candidate, opAt)) {
            shorthand = candidate;
            break;
        }
    }
    if (!shorthand) return null;
    // Bare `=` must not absorb the first char of comparison ops like `==`
    // and `!=` — those are pure reads and live outside the op-log. `+=`/`-=`/
    // `||=`/`??=` already encode the trailing `=`, so this guard is `=`-only.
    if (shorthand === '=' && text[opAt + 1] === '=') return null;
    i = opAt + shorthand.length;

    // ++/-- take no value; consume optional whitespace and expect `}}`.
    if (shorthand === '++' || shorthand === '--') {
        while (i < len && isWs(text[i])) i++;
        if (text[i] !== '}' || text[i + 1] !== '}') return null;
        const end = i + 2;
        return path
            ? { op: 'subvar', shorthand, key: root, path, start: openIdx, end, literal: text.slice(openIdx, end) }
            : { op: 'subvar', shorthand, key: root, start: openIdx, end, literal: text.slice(openIdx, end) };
    }

    // Value-bearing operators: capture everything until the macro's closing
    // `}}`, accounting for nested `{{...}}` so embedded display macros
    // survive verbatim. JSON-trailing-run rule applies here too.
    const valueStart = i;
    let depth = 0;
    while (i < len) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth++;
            i += 2;
            continue;
        }
        if (text[i] === '}' && text[i + 1] === '}') {
            if (depth === 0) {
                if (text[i + 2] === '}') {
                    i += 1;
                    continue;
                }
                const rawValue = text.slice(valueStart, i).trim();
                const end = i + 2;
                const base = { op: 'subvar', shorthand, key: root, rawValue, start: openIdx, end, literal: text.slice(openIdx, end) };
                return path ? { ...base, path } : base;
            }
            depth--;
            i += 2;
            continue;
        }
        i++;
    }
    return null;
}

/**
 * Does a shorthand operator start at `text[i]`? Used to terminate identifier
 * scanning. Tests the longest candidate first; a single `=` not preceded by
 * a recognized lead-in is still a valid shorthand op start.
 *
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isShorthandOpStart(text, i) {
    for (const op of SHORTHAND_OPS) {
        if (text.startsWith(op, i)) return true;
    }
    return false;
}

/** @param {string} c */
function isWs(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * Match the op name immediately after a `{{`. Returns the canonical op name
 * and the index of the character following it, or null if no whitelisted
 * op is found.
 *
 * @param {string} text
 * @param {number} from
 * @returns {{ op: MacroMatch['op'], headEnd: number } | null}
 */
function matchOpHead(text, from) {
    // Length-descending to avoid 'setvar' matching 'set' (and 'pushvar' before any future 'push').
    const ops = /** @type {const} */ (['deletevar', 'pushvar', 'popvar', 'setvar', 'addvar', 'incvar', 'decvar']);
    for (const op of ops) {
        const end = from + op.length;
        if (end > text.length) continue;
        if (text.slice(from, end).toLowerCase() !== op) continue;
        const next = text.slice(end, end + 2);
        if (next === '::') return { op, headEnd: end + 2 };
    }
    return null;
}

/**
 * Parse the body of a macro from its `::` separator forward, tracking nested
 * `{{...}}` so we accept the correct closing `}}`. Builds a MacroMatch.
 *
 * @param {string} text
 * @param {number} openIdx Position of the leading `{{`
 * @param {number} bodyStart Position immediately after `op::`
 * @param {MacroMatch['op']} op
 * @returns {MacroMatch | null}
 */
function parseMacroBody(text, openIdx, bodyStart, op) {
    const len = text.length;
    let depth = 0;
    let i = bodyStart;

    while (i < len) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth++;
            i += 2;
            continue;
        }
        if (text[i] === '}' && text[i + 1] === '}') {
            if (depth === 0) {
                // Trailing-run disambiguation: if the next character is
                // still `}`, the value ended in a literal `}` (typically
                // the close of a JSON object/array passed as the macro
                // value) and the macro close is the LAST `}}` in the run.
                // Without this rule, `{{setvar::a::{"x":1}}}` would parse
                // body as `a::{"x":1`, lopping off the JSON close.
                if (text[i + 2] === '}') {
                    i += 1;
                    continue;
                }
                // Found terminating `}}`
                const body = text.slice(bodyStart, i);
                const macro = buildMacro(op, body, openIdx, i + 2, text.slice(openIdx, i + 2));
                return macro;
            }
            depth--;
            i += 2;
            continue;
        }
        i++;
    }

    // Unterminated body — treat as malformed and skip
    return null;
}

/**
 * Splits the macro body into (key, rawValue) according to op shape, then
 * constructs the final match record.
 *
 * Shapes:
 *   setvar::name::value        — key + value
 *   addvar::name::value        — key + value
 *   pushvar::name::value       — key + value (value optional)
 *   pushvar::name              — key only (value defaults to undefined)
 *   incvar::name               — key only
 *   decvar::name               — key only
 *   deletevar::name            — key only
 *   popvar::name               — key only
 *
 * The literal `key` may itself be dotted (e.g. `roster.alice.hp`). We split
 * on the first `.` and surface `{ key: <root>, path: <remainder> }`. The
 * `path` field is omitted entirely when the key is flat — keeping the match
 * record clean for the common case.
 *
 * @param {MacroMatch['op']} op
 * @param {string} body
 * @param {number} start
 * @param {number} end
 * @param {string} literal
 * @returns {MacroMatch | null}
 */
function buildMacro(op, body, start, end, literal) {
    if (op === 'setvar' || op === 'addvar' || op === 'pushvar') {
        const sep = findTopLevelSeparator(body);
        if (sep < 0) {
            // pushvar with no value is legal — fall through to key-only shape.
            // setvar/addvar without a value are malformed and skipped.
            if (op === 'pushvar') {
                const rawKey = body.trim();
                if (!rawKey) return null;
                const { root, path } = splitKey(rawKey);
                return path
                    ? { op, key: root, path, start, end, literal }
                    : { op, key: root, start, end, literal };
            }
            return null;
        }
        const rawKey = body.slice(0, sep).trim();
        const rawValue = body.slice(sep + 2);
        if (!rawKey) return null;
        const { root, path } = splitKey(rawKey);
        return path
            ? { op, key: root, path, rawValue, start, end, literal }
            : { op, key: root, rawValue, start, end, literal };
    }
    // incvar / decvar / deletevar / popvar
    const rawKey = body.trim();
    if (!rawKey) return null;
    const { root, path } = splitKey(rawKey);
    return path
        ? { op, key: root, path, start, end, literal }
        : { op, key: root, start, end, literal };
}

/**
 * Splits a dotted key into (root, path). Returns `{ root: key, path: '' }`
 * when the key is flat (no `.`).
 *
 * @param {string} key
 * @returns {{ root: string, path: string }}
 */
function splitKey(key) {
    const dot = key.indexOf('.');
    if (dot < 0) return { root: key, path: '' };
    return { root: key.slice(0, dot), path: key.slice(dot + 1) };
}

/**
 * Find the first `::` in `body` that is not nested inside `{{...}}`. Returns
 * the index of the first `:` of the separator, or -1 if no top-level
 * separator exists.
 *
 * @param {string} body
 * @returns {number}
 */
function findTopLevelSeparator(body) {
    const len = body.length;
    let depth = 0;
    let i = 0;
    while (i < len) {
        if (body[i] === '{' && body[i + 1] === '{') {
            depth++;
            i += 2;
            continue;
        }
        if (body[i] === '}' && body[i + 1] === '}') {
            depth = Math.max(0, depth - 1);
            i += 2;
            continue;
        }
        if (depth === 0 && body[i] === ':' && body[i + 1] === ':') {
            return i;
        }
        i++;
    }
    return -1;
}
