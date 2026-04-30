/**
 * @file Side-effect macro extractor
 *
 * Given a message object (anything with `.mes` and optional `.extra.var_ops`)
 * and a SillyTavern-flavored env, this module:
 *
 *   1. Walks the message's `mes` text in source order.
 *   2. For each recognized side-effect macro:
 *      a. Resolves any nested display macros in its value template against
 *         the *current* `chat_metadata.variables` (already updated by
 *         previously-extracted ops in this same message).
 *      b. Applies the op to `chat_metadata.variables` (forward apply).
 *      c. Pushes a structured op record onto `message.extra.var_ops`.
 *   3. Returns the message text with all recognized literals removed.
 *
 * Sequential resolve+apply is essential: the chain
 *   {{setvar::a::1}} {{setvar::b::{{getvar::a}}}}
 * must produce a=1, b=1. We achieve this by interleaving the three steps
 * above, never batching.
 *
 * The function is dependency-injected: callers pass in a `state` object
 * (chat_metadata.variables) and an `env` for display-macro resolution. This
 * keeps the module testable without ST globals.
 */

import { scanAllSideEffectMacros } from './scanner.js';
import { resolveDisplayMacros } from './resolver.js';
import { applyOp } from './apply.js';

/**
 * @typedef {import('./apply.js').VarOp} VarOp
 * @typedef {import('./resolver.js').ResolveEnv} ResolveEnv
 */

/**
 * @typedef {Object} ExtractResult
 * @property {string} mes - The text after macro literals are stripped
 * @property {VarOp[]} ops - Ops in source order, with values fully resolved
 */

/**
 * Extract side-effect macros from `text`, applying them to `state` and
 * returning the cleaned text plus the structured ops.
 *
 * Pure with respect to inputs *except* `state`, which is mutated by `applyOp`.
 * Callers are expected to pass `chat_metadata.variables`.
 *
 * @param {string} text
 * @param {Record<string, any>} state
 * @param {() => ResolveEnv} envFactory - Called fresh for each macro resolve so
 *   {{getvar}} in a value template sees prior ops' effects. Lazy because most
 *   messages have zero macros and we shouldn't pay env construction cost.
 * @returns {ExtractResult}
 */
export function extractFromText(text, state, envFactory) {
    if (typeof text !== 'string' || text.length === 0) {
        return { mes: text ?? '', ops: [] };
    }

    const matches = scanAllSideEffectMacros(text);
    if (matches.length === 0) {
        return { mes: text, ops: [] };
    }

    /** @type {VarOp[]} */
    const ops = [];
    let cursor = 0;
    let stripped = '';

    for (const m of matches) {
        // Append text between previous cut and this macro
        stripped += text.slice(cursor, m.start);
        cursor = m.end;

        // Build the op, resolving the value template if applicable. Resolve
        // happens *after* prior ops in this message have been applied to
        // state (because we're iterating in order and applyOp below mutates
        // state synchronously).
        let value;
        if (m.op === 'setvar' || m.op === 'addvar') {
            value = resolveDisplayMacros(m.rawValue ?? '', envFactory ? envFactory() : {});
        }

        /** @type {VarOp} */
        const op = (m.op === 'setvar' || m.op === 'addvar')
            ? { op: m.op, key: m.key, value }
            : { op: m.op, key: m.key };

        applyOp(state, op);
        ops.push(op);
    }

    stripped += text.slice(cursor);
    return { mes: stripped, ops };
}

/**
 * Extract side-effect macros from a message object's `mes`, mutating both
 * `message.mes` and `message.extra.var_ops`. Forward-applies each op to
 * `state` in the same order the macros appear.
 *
 * @param {{ mes?: string, extra?: any }} message
 * @param {Record<string, any>} state
 * @param {() => ResolveEnv} envFactory
 * @returns {VarOp[]} The ops that were just appended (may be empty)
 */
export function extractFromMessage(message, state, envFactory) {
    if (!message || typeof message.mes !== 'string') return [];

    const { mes, ops } = extractFromText(message.mes, state, envFactory);
    if (ops.length === 0) return [];

    message.mes = mes;
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.var_ops)) {
        message.extra.var_ops = [];
    }
    message.extra.var_ops.push(...ops);
    return ops;
}
