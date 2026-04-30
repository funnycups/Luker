/**
 * @file Side-effect macro scanner
 *
 * Recognizes chat-local side-effect variable macros embedded in message text:
 *   {{setvar::name::value}}
 *   {{addvar::name::value}}
 *   {{incvar::name}}
 *   {{decvar::name}}
 *   {{deletevar::name}}
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
 * @property {'setvar'|'addvar'|'incvar'|'decvar'|'deletevar'} op
 * @property {string} key
 * @property {string} [rawValue] - Unresolved value template (for setvar/addvar)
 * @property {number} start - Inclusive start index in source text
 * @property {number} end - Exclusive end index in source text
 * @property {string} literal - The exact substring that matched
 */

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

        const afterOpen = openIdx + 2;
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

// ----- internals ---------------------------------------------------------

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
    // Try in length-descending order to avoid 'setvar' matching 'set'
    const ops = /** @type {const} */ (['deletevar', 'setvar', 'addvar', 'incvar', 'decvar']);
    for (const op of ops) {
        const end = from + op.length;
        if (end > text.length) continue;
        if (text.slice(from, end).toLowerCase() !== op) continue;
        // Op name must be followed by '::' (setvar/addvar/deletevar) or '::' / '}}' (incvar/decvar)
        // Actually all five accept '::' followed by at least one segment, except
        // incvar/decvar/deletevar which take just '::name' or 'name'.
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
 *   incvar::name               — key only
 *   decvar::name               — key only
 *   deletevar::name            — key only
 *
 * @param {MacroMatch['op']} op
 * @param {string} body
 * @param {number} start
 * @param {number} end
 * @param {string} literal
 * @returns {MacroMatch | null}
 */
function buildMacro(op, body, start, end, literal) {
    if (op === 'setvar' || op === 'addvar') {
        const sep = findTopLevelSeparator(body);
        if (sep < 0) return null;
        const key = body.slice(0, sep).trim();
        const rawValue = body.slice(sep + 2);
        if (!key) return null;
        return { op, key, rawValue, start, end, literal };
    }
    // incvar / decvar / deletevar
    const key = body.trim();
    if (!key) return null;
    return { op, key, start, end, literal };
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
