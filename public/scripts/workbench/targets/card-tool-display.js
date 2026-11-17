// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

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
                const keys = Object.keys(r).filter((k) => k !== 'missing_fields');
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
};
