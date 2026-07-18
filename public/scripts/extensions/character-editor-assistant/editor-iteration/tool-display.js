/**
 * Unified CEA editor tool-display map — feeds `renderToolCallChip`'s
 * `opts.toolDisplay`. Keys are the tool names the model produces in this
 * adapter (the 6 `cea_*` edit verbs, the 6 short-name read tools, and
 * the 2 `luker_cea_editor_*` control tools); values are
 * `{ icon, label, type, summarize?(args, result, i18n) }`.
 *
 * Three `type`s drive the shared chip renderer:
 *   - `'edit'`    → applied to state.live via applyPendingEdits
 *   - `'read'`    → produces a tool_result for the next round
 *   - `'control'` → steers the auto-continue loop (not user-visible state)
 *
 * Both `label` and the templates inside `summarize` are the English
 * source strings. `renderToolCallChip` threads the popup's runtime
 * `i18n` translator into both — into `label` via a direct lookup and
 * into `summarize` via the third callback argument — so this file
 * declares the i18n keys, never the localized text.
 *
 * Drift is enforced against tools.js (`CONTROL_TOOL_NAMES`, the read-tool
 * predicate, and the character-iteration edit-tool defs) in
 * `tests/cea-editor-unified/tools.test.js`.
 */

// Popups thread their `tf` (template + values → translated+substituted)
// formatter through here as `i18n`. Calling `tf(template)` with no values
// eats the `${0}` placeholder, so we pass `values` through and only fall
// back to manual substitution if the result still has unfilled markers
// (which happens when the caller supplied a plain lookup, or i18n missed
// the key entirely).
function fmt(i18n, template, ...values) {
    if (typeof i18n !== 'function') {
        return String(template).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
    }
    const translated = i18n(template, ...values);
    const base = (typeof translated === 'string' && translated.length > 0) ? translated : String(template);
    if (!/\$\{\d+\}/.test(base)) return base;
    return base.replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

export const CEA_EDITOR_TOOL_DISPLAY = {
    // ----- Edit (character card) -------------------------------------------
    cea_set_card_field: {
        icon: '✏️',
        label: 'Set card field',
        type: 'edit',
        summarize: (a) => a?.field || '',
    },
    cea_str_replace_card_field: {
        icon: '🔄',
        label: 'Replace text in card field',
        type: 'edit',
        summarize: (a) => a?.field || '',
    },

    // ----- Edit (lorebook) -------------------------------------------------
    cea_add_lorebook_entry: {
        icon: '➕',
        label: 'Add lorebook entry',
        type: 'edit',
        summarize: (a) => a?.entry?.comment || (a?.entry?.uid != null ? `#${a.entry.uid}` : ''),
    },
    cea_update_lorebook_entry: {
        icon: '✏️',
        label: 'Update lorebook entry',
        type: 'edit',
        summarize: (a) => (a?.uid != null ? `#${a.uid}` : ''),
    },
    cea_str_replace_lorebook_entry_field: {
        icon: '🔄',
        label: 'Replace text in lorebook entry',
        type: 'edit',
        summarize: (a) => {
            const uid = a?.uid != null ? `#${a.uid}` : '';
            const field = a?.field ? String(a.field) : '';
            return [uid, field].filter(Boolean).join(' ');
        },
    },
    cea_remove_lorebook_entry: {
        icon: '🗑️',
        label: 'Remove lorebook entry',
        type: 'edit',
        summarize: (a) => (a?.uid != null ? `#${a.uid}` : ''),
    },
    cea_set_lorebook_metadata: {
        icon: '⚙️',
        label: 'Set lorebook metadata',
        type: 'edit',
        summarize: (a) => a?.key || '',
    },

    // ----- Read ------------------------------------------------------------
    cea_read_card_fields: {
        icon: '📖',
        label: 'Read card fields',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                // Count concretely-returned fields (everything under the
                // result object minus the `missing_fields` bookkeeping
                // key). Uses the shared `${0} fields` template so the
                // chip stays terse.
                const keys = Object.keys(r).filter(k => k !== 'missing_fields');
                return fmt(i18n, '${0} fields', keys.length);
            }
            const fields = Array.isArray(a?.fields) ? a.fields : [];
            return fields.length ? fields.join(', ') : '';
        },
    },
    lorebook_query: {
        icon: '🔍',
        label: 'Search lorebook',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const total = Number.isFinite(r.total_hits)
                    ? Number(r.total_hits)
                    : (Array.isArray(r.entries) ? r.entries.length : 0);
                return fmt(i18n, '${0} hits', total);
            }
            const book = a?.book_name ? String(a.book_name) : '';
            const text = a?.text ? String(a.text) : (a?.query ? String(a.query) : '');
            return [book, text].filter(Boolean).join(' ');
        },
    },
    lorebook_list: {
        icon: '📋',
        label: 'List lorebook entries',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.entries) ? r.entries.length : Number(r.count || 0);
                return fmt(i18n, '${0} entries', count);
            }
            return a?.book_name ? String(a.book_name) : '';
        },
    },
    lorebook_get: {
        icon: '📖',
        label: 'Read lorebook entries',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.entries) ? r.entries.length : 1;
                return fmt(i18n, '${0} entries', count);
            }
            const uids = Array.isArray(a?.uids) ? a.uids.join(',') : '';
            const book = a?.book_name ? String(a.book_name) : '';
            return [book, uids].filter(Boolean).join(' ');
        },
    },
    world_book_list: {
        icon: '📚',
        label: 'List world books',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.books) ? r.books.length : Number(r.count || 0);
                return fmt(i18n, '${0} books', count);
            }
            return '';
        },
    },
    web_search: {
        icon: '🌐',
        label: 'Web search',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.results) ? r.results.length : Number(r.count || 0);
                return fmt(i18n, '${0} results', count);
            }
            return a?.query ? String(a.query) : '';
        },
    },
    simulate_prompt: {
        icon: '🧪',
        label: 'Simulate prompt',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const len = Number(
                    r.assembled_length
                    ?? (typeof r.simulated_text === 'string' ? r.simulated_text.length : 0),
                );
                return fmt(i18n, '${0} chars', len);
            }
            return '';
        },
    },

    // CEA editor has no control tools; the auto-continue loop is program-
    // driven by tool-call presence.
};
