/**
 * @file Pure op application
 *
 * applyOp(state, op) mutates `state` (a plain object representing
 * `chat_metadata.variables`) according to the op. This module is the only
 * place where op semantics are encoded, so the same logic is used by:
 *
 *   • the extractor (forward-applying newly extracted ops)
 *   • the rebuilder (full replay over surviving ops)
 *   • the operation panel (preview / commit user edits)
 *
 * No globals, no DOM, no SillyTavern dependencies — just a function on plain
 * objects. Numeric coercion mirrors ST's `addLocalVariable` / `setLocalVariable`
 * behavior so users see consistent results whether the op was authored by
 * AI, by hand, or replayed.
 */

import { applyPathOp } from './path-ops.js';

/**
 * @typedef {Object} VarOp
 * @property {'setvar'|'addvar'|'incvar'|'decvar'|'deletevar'|'pushvar'|'popvar'} op
 * @property {string} key - Top-level variable name (root)
 * @property {string} [path] - Optional dotted path inside a structured value
 * @property {string} [value] - For setvar/addvar/pushvar, the resolved literal value
 */

/**
 * Apply a single op to the given state. Mutates `state` in place and returns
 * the new value of `state[op.key]` (or `undefined` for deletevar).
 *
 * The implementation mirrors SillyTavern's variable arithmetic:
 *   • `setvar` writes the literal value
 *   • `addvar` numerically increments when both sides are numeric, otherwise
 *      string-concatenates onto the existing value (or array-pushes when the
 *      stored value parses to an array)
 *   • `incvar` ≡ addvar(+1)
 *   • `decvar` ≡ addvar(-1)
 *   • `deletevar` removes the key entirely
 *
 * @param {Record<string, any>} state
 * @param {VarOp} op
 * @returns {any}
 */
export function applyOp(state, op) {
    if (!state || typeof state !== 'object') return undefined;
    if (!op || typeof op !== 'object' || typeof op.key !== 'string' || !op.key) return undefined;

    const hasPath = typeof op.path === 'string' && op.path.length > 0;
    const isArrayOp = op.op === 'pushvar' || op.op === 'popvar';
    const pathFlavored = (op.op === 'setvar' || op.op === 'deletevar' || op.op === 'incvar' || op.op === 'decvar') && hasPath;

    if (isArrayOp || pathFlavored) {
        return applyPathOp(state, op);
    }

    switch (op.op) {
        case 'setvar':
            state[op.key] = op.value ?? '';
            return state[op.key];

        case 'addvar':
            return addToVariable(state, op.key, op.value ?? '');

        case 'incvar':
            return addToVariable(state, op.key, 1);

        case 'decvar':
            return addToVariable(state, op.key, -1);

        case 'deletevar':
            delete state[op.key];
            return undefined;

        default:
            return undefined;
    }
}

/**
 * Apply an ordered list of ops in sequence, mutating `state`. Returns
 * `state` for convenience.
 *
 * @param {Record<string, any>} state
 * @param {Iterable<VarOp>} ops
 * @returns {Record<string, any>}
 */
export function applyAll(state, ops) {
    if (!state) return state;
    if (!ops) return state;
    for (const op of ops) applyOp(state, op);
    return state;
}

// ----- internals ---------------------------------------------------------

/**
 * Add or concatenate `delta` to `state[key]`, mirroring ST's addLocalVariable
 * semantics.
 *
 * @param {Record<string, any>} state
 * @param {string} key
 * @param {string | number} delta
 * @returns {any}
 */
function addToVariable(state, key, delta) {
    const current = state[key];

    // Array push (when stored value parses as a JSON array)
    if (typeof current === 'string') {
        try {
            const parsed = JSON.parse(current);
            if (Array.isArray(parsed)) {
                parsed.push(delta);
                state[key] = JSON.stringify(parsed);
                return parsed;
            }
        } catch {
            // not JSON — fall through
        }
    }

    const numericDelta = Number(delta);
    const numericCurrent = Number(current);

    if (isNaN(numericDelta) || isNaN(numericCurrent) || current === undefined || current === null || current === '') {
        // String concat path (matches ST's String(currentValue || '') + value)
        const stringValue = String(current ?? '') + (delta ?? '');
        state[key] = stringValue;
        return stringValue;
    }

    const next = numericCurrent + numericDelta;
    if (isNaN(next)) {
        return '';
    }
    state[key] = next;
    return next;
}
