/**
 * Pure primitives for the memory-graph module.
 *
 * - Zero side effects, zero DOM, zero ST imports.
 * - Sits at the bottom of the dependency graph; everything else may import
 *   from here, and this file imports nothing from the module.
 * - Holds level enums, semantic constants, and the text-normalization
 *   helpers used pervasively when sanitizing user / LLM strings before they
 *   enter the store.
 */

export const LEVEL = {
    SEMANTIC: 'semantic',
};

/**
 * Collapse all runs of whitespace into a single ASCII space and trim.
 * Applied to every short string entering the graph (titles, types,
 * relation labels, refs, etc.) so equality comparisons stay stable across
 * pasted content with stray tabs / NBSPs.
 *
 * @param {*} text
 * @returns {string}
 */
export function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Preserve newlines but normalize `\r\n` → `\n` and NBSP → space, then
 * trim outer whitespace. Used for multi-line fields (summaries,
 * descriptions) where intra-paragraph structure must survive.
 *
 * @param {*} text
 * @returns {string}
 */
export function normalizeMultilineText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u00A0/g, ' ')
        .trim();
}

/**
 * Ensure `node.fields` is a plain object, repairing the node in place when
 * it is missing / null / an array. Returns the (now guaranteed) fields
 * object so callers can mutate it directly.
 *
 * @param {object|null|undefined} node
 * @returns {object}
 */
export function ensureNodeFieldsObject(node) {
    if (!node || typeof node !== 'object') {
        return {};
    }
    if (!node.fields || typeof node.fields !== 'object' || Array.isArray(node.fields)) {
        node.fields = {};
    }
    return node.fields;
}

/**
 * Returns true when an assistant chat message has actual content worth
 * extracting. Filters out user messages and empty assistant turns. Used
 * everywhere we walk `chat[]` to map between playable floors and assistant-
 * seq indices.
 *
 * Deliberately ignores `is_system`. That flag is flipped by `/hide` (which
 * the community uses to hide a message from the prompt without losing its
 * memory), so treating it as an extractability predicate would shift the
 * seq coordinate system on every hide/unhide and drift stored node seqs.
 *
 * @param {{is_user?: boolean, mes?: string}|null|undefined} message
 * @returns {boolean}
 */
export function isExtractableAssistantMessage(message) {
    if (!message || message.is_user) {
        return false;
    }
    const raw = message.mes;
    if (typeof raw !== 'string' || raw.length === 0) return false;
    // Why not normalizeText: that runs `/\s+/g` over the full message body
    // and allocates a collapsed copy just to test "any non-whitespace char?".
    // trim() exits without allocating when leading/trailing chars aren't
    // whitespace, and is semantically equivalent for this truthiness check.
    return raw.trim().length > 0;
}
