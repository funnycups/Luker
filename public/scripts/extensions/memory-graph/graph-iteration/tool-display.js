// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * MG graph-iteration tool-display map — feeds renderToolCallChip's
 * `opts.toolDisplay`. Keys are the 14 tool names registered in tools.js;
 * values are { icon, label, type, summarize?(args, result, i18n) }.
 *
 * `label` and the `summarize` templates are English source strings. The
 * shared renderer threads the popup's runtime translator into both, so this
 * file declares i18n keys, never localized text.
 */

export const MG_GRAPH_TOOL_DISPLAY = {
    mg_graph_read_fields: {
        icon: '🔍',
        label: 'Read graph fields',
        type: 'read',
        summarize: (a) => {
            const paths = Array.isArray(a?.paths) ? a.paths : [];
            if (paths.length === 0) return '';
            if (paths.length <= 3) return paths.join(', ');
            return `${paths.slice(0, 3).join(', ')} +${paths.length - 3}`;
        },
    },
    mg_graph_list_nodes: { icon: '📋', label: 'List nodes',        type: 'read', summarize: (a) => Array.isArray(a?.types) ? a.types.join(', ') : '' },
    mg_graph_search_nodes: { icon: '🔎', label: 'Search nodes',      type: 'read', summarize: (a) => String(a?.query || '') },
    mg_graph_node_detail: { icon: '📄', label: 'Node detail',       type: 'read', summarize: (a) => String(a?.node_id || '') },
    mg_graph_neighbors: { icon: '🕸️', label: 'Expand neighbors',  type: 'read', summarize: (a) => [a?.node_id, a?.hops ? `hops=${a.hops}` : ''].filter(Boolean).join(' ') },
    mg_graph_schema: { icon: '📐', label: 'Read schema',       type: 'read' },
    mg_graph_read_chat: { icon: '💬', label: 'Read chat',         type: 'read', summarize: (a) => `${a?.from_assistant_seq ?? '?'}–${a?.to_assistant_seq ?? '?'}` },

    mg_graph_create_node: { icon: '➕', label: 'Create node',       type: 'edit', summarize: (a) => [a?.type, a?.title].filter(Boolean).join(': ') },
    mg_graph_edit_node: { icon: '✏️', label: 'Edit node',         type: 'edit', summarize: (a) => String(a?.node_id || '') },
    mg_graph_delete_node: { icon: '🗑️', label: 'Delete node',       type: 'edit', summarize: (a) => `${a?.node_id || ''}${a?.recursive ? ' (recursive)' : ''}` },
    mg_graph_merge_nodes: { icon: '🔀', label: 'Merge nodes',       type: 'edit', summarize: (a) => `${(a?.loser_ids || []).length} → ${a?.survivor_id || ''}` },
    mg_graph_upsert_links: { icon: '🔗', label: 'Upsert links',      type: 'edit', summarize: (a) => `${a?.source_node_id || ''} ×${(a?.links || []).length}` },
    mg_graph_edit_link: { icon: '↔️', label: 'Edit link',         type: 'edit', summarize: (a) => `${a?.source_node_id || ''}→${a?.target_node_id || ''} ${a?.relation || ''}→${a?.new_relation || ''}` },
    mg_graph_delete_link: { icon: '✂️', label: 'Delete link',       type: 'edit', summarize: (a) => `${a?.source_node_id || ''}→${a?.target_node_id || ''} ${a?.relation || ''}` },
};
