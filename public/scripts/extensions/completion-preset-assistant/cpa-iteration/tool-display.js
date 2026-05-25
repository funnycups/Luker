/**
 * CPA tool-display map — feeds renderToolCallChip's `opts.toolDisplay`.
 * Keys are the CPA tool names registered in tools.js; values are
 * { icon, label, type, summarize?(args, result, i18n) }.
 *
 * Read-type tools' summarize functions should produce a one-line result
 * digest (e.g. `Returned 3 values`) so the user sees what the AI saw
 * without expanding the result block.
 *
 * Both `label` and the string templates inside `summarize` are the
 * English source strings. `renderToolCallChip` threads the popup's
 * runtime `i18n` translator into both — into `label` via a direct
 * lookup and into `summarize` via the third callback argument — so this
 * file declares the i18n keys, never the localized text.
 *
 * Templates use `${0}`, `${1}`, ... placeholders; the popup's i18n
 * function applies the substitution.
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

export const CPA_TOOL_DISPLAY = {
    preset_set_field:                    { icon: '✏️', label: 'Set preset field',         type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_replace:                  { icon: '🔄', label: 'Replace field text',       type: 'edit',  summarize: (a) => `${a?.path || ''}${a?.expected_count != null ? ` (×${a.expected_count})` : ''}` },
    preset_str_insert:                   { icon: '➕', label: 'Insert into field',        type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_delete:                   { icon: '🗑️', label: 'Delete inside field',      type: 'edit',  summarize: (a) => a?.path || '' },
    preset_str_replace_in_prompt:        { icon: '🔄', label: 'Replace text in prompt',   type: 'edit',  summarize: (a) => `${a?.identifier || ''}${a?.expected_count != null ? ` (×${a.expected_count})` : ''}` },
    preset_str_insert_in_prompt:         { icon: '➕', label: 'Insert text in prompt',    type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_str_delete_in_prompt:         { icon: '🗑️', label: 'Delete text in prompt',    type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_list_insert:                  { icon: '📋', label: 'List insert',              type: 'edit',  summarize: (a) => `${a?.path || ''} @ ${a?.anchor?.after != null ? 'after ' + a.anchor.after : (a?.anchor?.before != null ? 'before ' + a.anchor.before : '?')}` },
    preset_list_remove:                  { icon: '📋', label: 'List remove',              type: 'edit',  summarize: (a) => `${a?.path || ''} @ ${a?.index != null ? a.index : '?'}` },
    preset_list_move:                    { icon: '📋', label: 'List move',                type: 'edit',  summarize: (a) => `${a?.path || ''}: ${a?.from_index != null ? a.from_index : '?'} → ${a?.to_index != null ? a.to_index : '?'}` },
    preset_upsert_prompt_entry:          { icon: '✏️', label: 'Set prompt entry',         type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_upsert_prompt_order_item:     { icon: '📋', label: 'Adjust prompt order',      type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_remove_prompt_entry:          { icon: '🗑️', label: 'Remove prompt entry',      type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_remove_prompt_order_item:     { icon: '🗑️', label: 'Remove prompt order item', type: 'edit',  summarize: (a) => a?.identifier || '' },
    preset_copy_from_reference:          { icon: '📥', label: 'Copy from reference',      type: 'edit',  summarize: (a) => a?.path || '' },

    preset_read_live_fields:             { icon: '📖', label: 'Read preset fields',       type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r
                ? fmt(i18n, 'Returned ${0} values', Object.keys(r || {}).length)
                : fmt(i18n, '${0} paths', (a?.paths || []).length)) },
    preset_read_reference_fields:        { icon: '📖', label: 'Read reference fields',    type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r
                ? fmt(i18n, 'Returned ${0} values', Object.keys(r || {}).length)
                : fmt(i18n, '${0} paths', (a?.paths || []).length)) },
    preset_diff_reference:               { icon: '🔍', label: 'Diff against reference',   type: 'read',
        summarize: (a, r, i18n) => r?.error != null
            ? `❌ ${String(r.error).slice(0, 40)}`
            : (r?.differing_paths != null
                ? fmt(i18n, '${0} fields differ', r.differing_paths.length || 0)
                : '') },
    preset_simulate:                     { icon: '🧪', label: 'Simulate prompt assembly', type: 'read',
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
};
