// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * MG schema tool-display map — feeds renderToolCallChip's `opts.toolDisplay`.
 * Keys are the MG schema tool names registered in tools.js; values are
 * { icon, label, type, summarize?(args, result, i18n) }.
 *
 * MG schema currently has no read-type tools — every action either mutates
 * the working schema (edit) or steers the runner (control). If a future
 * milestone introduces a `mg_schema_read_*` tool, add a `summarize` here
 * that turns the result payload into a one-line digest the same way the
 * CPA map does for `preset_read_live_fields`.
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

    luker_mg_schema_reset_live_to_blank:   { icon: '♻️', label: 'Reset schema to blank',     type: 'control' },
    luker_mg_schema_reset_live_to_global:  { icon: '⬇️', label: 'Reset schema to global',    type: 'control' },
};
