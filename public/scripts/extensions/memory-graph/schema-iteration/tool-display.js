// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * MG schema tool-display map — feeds renderToolCallChip's `opts.toolDisplay`.
 * Keys are the MG schema tool names registered in tools.js (edit + control)
 * plus the popup-owned `mg_schema_read_fields` read tool; values are
 * { icon, label, type, summarize?(args, result, i18n) }.
 *
 * Both `label` and the templates inside `summarize` are the English source
 * strings. `renderToolCallChip` threads the popup's runtime `i18n` translator
 * into both (label via a direct lookup, summarize via the third argument)
 * so this file declares the i18n keys, never the localized text.
 */

export const MG_SCHEMA_TOOL_DISPLAY = {
    mg_schema_set_node_type:      { icon: '✏️', label: 'Set node type',       type: 'edit', summarize: (a) => a?.node_type?.id || '' },
    mg_schema_remove_node_type:   { icon: '🗑️', label: 'Remove node type',    type: 'edit', summarize: (a) => a?.id || '' },
    mg_schema_reorder_node_types: { icon: '🔀', label: 'Reorder node types',  type: 'edit', summarize: (a) => `${(a?.ids || []).length}` },

    mg_schema_read_fields: {
        icon: '🔍',
        label: 'Read schema fields',
        type: 'read',
        summarize: (a) => {
            const paths = Array.isArray(a?.paths) ? a.paths : [];
            if (paths.length === 0) return '';
            if (paths.length <= 3) return paths.join(', ');
            return `${paths.slice(0, 3).join(', ')} +${paths.length - 3}`;
        },
    },

    luker_mg_schema_reset_live_to_blank:   { icon: '♻️', label: 'Reset schema to blank',     type: 'control' },
    luker_mg_schema_reset_live_to_global:  { icon: '⬇️', label: 'Reset schema to global',    type: 'control' },
};
