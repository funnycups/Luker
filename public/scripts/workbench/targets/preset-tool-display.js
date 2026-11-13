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

export const CPA_TOOL_DISPLAY = {
    preset_set_field: { icon: '✏️', label: 'Set preset field',         type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_replace: { icon: '🔄', label: 'Replace field text',       type: 'edit',  summarize: (a) => `${a?.path || ''}${a?.replaceAll ? ' (all)' : ''}` },
    preset_str_insert: { icon: '➕', label: 'Insert into field',        type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_delete: { icon: '🗑️', label: 'Delete inside field',      type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_replace_in_prompt: { icon: '🔄', label: 'Replace text in prompt',   type: 'edit',  summarize: (a) => `${a?.identifier || ''}${a?.replaceAll ? ' (all)' : ''}` },
    preset_str_insert_in_prompt: { icon: '➕', label: 'Insert text in prompt',    type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_str_delete_in_prompt: { icon: '🗑️', label: 'Delete text in prompt',    type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_list_insert: { icon: '📋', label: 'List insert',              type: 'edit',  summarize: (a) => `${a?.path || ''} @ ${a?.anchor?.after != null ? 'after ' + a.anchor.after : (a?.anchor?.before != null ? 'before ' + a.anchor.before : '?')}` },
    preset_list_remove: { icon: '📋', label: 'List remove',              type: 'edit',  summarize: (a) => `${a?.path || ''} @ ${a?.index != null ? a.index : '?'}` },
    preset_list_move: { icon: '📋', label: 'List move',                type: 'edit',  summarize: (a) => `${a?.path || ''}: ${a?.from_index != null ? a.from_index : '?'} → ${a?.to_index != null ? a.to_index : '?'}` },
    preset_upsert_prompt_entry: { icon: '✏️', label: 'Set prompt entry',         type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_upsert_prompt_order_item: { icon: '📋', label: 'Adjust prompt order',      type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_remove_prompt_entry: { icon: '🗑️', label: 'Remove prompt entry',      type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_remove_prompt_order_item: { icon: '🗑️', label: 'Remove prompt order item', type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_copy_from_reference: { icon: '📥', label: 'Copy from reference',      type: 'edit',  summarize: (a) => a?.path || '' },

    preset_read_live_fields: { icon: '📖', label: 'Read preset fields',       type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r
                ? fmt(i18n, 'Returned ${0} values', Object.keys(r || {}).length)
                : fmt(i18n, '${0} paths', (a?.paths || []).length)) },
    preset_read_reference_fields: { icon: '📖', label: 'Read reference fields',    type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r
                ? fmt(i18n, 'Returned ${0} values', Object.keys(r || {}).length)
                : fmt(i18n, '${0} paths', (a?.paths || []).length)) },
    preset_diff_reference: { icon: '🔍', label: 'Diff against reference',   type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r?.differing_paths != null
                ? fmt(i18n, '${0} fields differ', r.differing_paths.length || 0)
                : '') },
    preset_simulate: { icon: '🧪', label: 'Simulate prompt assembly', type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r?.assembled_length != null
                ? fmt(i18n, 'Assembled ${0} chars', r.assembled_length)
                : '') },

    preset_clone_to_new: {
        icon: '📋',
        label: 'Clone to new preset',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object' && r.error) return `❌ ${String(r.error).slice(0, 50)}`;
            if (r && typeof r === 'object' && r.new_name) {
                return fmt(i18n, 'Cloned to ${0}', String(r.new_name));
            }
            return String(a?.new_name || '');
        },
    },

    skill_list_visible: {
        icon: '📚',
        label: 'List skills',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object' && r.error) return `❌ ${String(r.error).slice(0, 40)}`;
            if (r && Array.isArray(r.inventory)) return fmt(i18n, '${0} skills', r.inventory.length);
            return a?.agentId ? String(a.agentId) : '';
        },
    },
    skill_inspect: {
        icon: '🔎',
        label: 'Inspect skill',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object' && r.error) return `❌ ${String(r.error).slice(0, 40)}`;
            if (r && Array.isArray(r.fileTree)) return fmt(i18n, '${0} files', r.fileTree.length);
            return a?.name ? String(a.name) : '';
        },
    },
    skill_read_content: {
        icon: '📖',
        label: 'Read skill file',
        type: 'read',
        summarize: (a) => {
            const name = a?.name ? String(a.name) : '';
            const path = a?.path ? String(a.path) : 'SKILL.md';
            return name ? `${name} / ${path}` : path;
        },
    },
    skill_search_content: {
        icon: '🔍',
        label: 'Search skill',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object' && r.error) return `❌ ${String(r.error).slice(0, 40)}`;
            if (r && Array.isArray(r.hits)) return fmt(i18n, '${0} hits', r.hits.length);
            const name = a?.name ? String(a.name) : '';
            const query = a?.query ? String(a.query).slice(0, 30) : '';
            return [name, query].filter(Boolean).join(' ');
        },
    },
    skill_create: {
        icon: '🆕',
        label: 'Create skill',
        type: 'write',
        summarize: (a) => a?.name ? String(a.name) : '',
    },
    skill_update_content: {
        icon: '✏️',
        label: 'Overwrite skill file',
        type: 'write',
        summarize: (a) => {
            const name = a?.name ? String(a.name) : '';
            const path = a?.path ? String(a.path) : 'SKILL.md';
            return name ? `${name} / ${path}` : path;
        },
    },
    skill_edit_content: {
        icon: '🩹',
        label: 'Patch skill file',
        type: 'write',
        summarize: (a) => {
            const name = a?.name ? String(a.name) : '';
            const path = a?.path ? String(a.path) : 'SKILL.md';
            return name ? `${name} / ${path}` : path;
        },
    },
    skill_update_frontmatter: {
        icon: '🏷️',
        label: 'Update skill frontmatter',
        type: 'write',
        summarize: (a) => a?.name ? String(a.name) : '',
    },
    skill_rename: {
        icon: '🔤',
        label: 'Rename skill',
        type: 'write',
        summarize: (a) => {
            const from = a?.fromName ? String(a.fromName) : '';
            const to = a?.toName ? String(a.toName) : '';
            return from && to ? `${from} → ${to}` : (to || from);
        },
    },
    skill_change_scope: {
        icon: '📦',
        label: 'Move skill scope',
        type: 'write',
        summarize: (a) => {
            const name = a?.name ? String(a.name) : '';
            const from = a?.fromScope?.kind ? String(a.fromScope.kind) : '';
            const to = a?.toScope?.kind ? String(a.toScope.kind) : '';
            return from && to ? `${name} ${from} → ${to}` : name;
        },
    },
    skill_delete: {
        icon: '🗑️',
        label: 'Delete skill',
        type: 'write',
        summarize: (a) => a?.name ? String(a.name) : '',
    },
    skill_extract_from_text: {
        icon: '✂️',
        label: 'Extract skill from text',
        type: 'write',
        summarize: (a) => {
            const name = a?.suggestedName ? String(a.suggestedName) : '';
            const len = typeof a?.sourceText === 'string' ? a.sourceText.length : 0;
            return name && len ? `${name} (${len} chars)` : name;
        },
    },
};
