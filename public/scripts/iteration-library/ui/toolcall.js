/**
 * Render one tool call as a CardApp-Studio-style one-liner with optional
 * `<details>` expansion that shows friendly per-arg breakdown (not raw JSON).
 *
 * @param {{ id?: string, name: string, args?: object }} call
 * @param {Object} [opts]
 * @param {Object} [opts.toolDisplay]  Map tool name → { icon, label, type, summarize?(args, result, i18n) }.
 *                                     Falls back to { icon: '🔧', label: name, type: 'edit' }.
 *                                     `label` is the English source string (also the i18n key);
 *                                     the renderer applies `opts.i18n` at chip-render time, so
 *                                     toolDisplay modules should NOT pre-translate.
 *                                     `summarize` receives the runtime `opts.i18n` as a 3rd
 *                                     argument so it can localize templates like "Returned ${0} values".
 * @param {Object|null} [opts.result]  Tool result (for read tools). When present,
 *                                     the chip adds a `<details>` result block.
 * @param {string} [opts.status]       'ok' | 'fail' | 'pending' | '' — drives leading status icon.
 * @param {Function} [opts.i18n]       i18n function `(template, ...args) => string`.
 * @returns {string} HTML
 */
export function renderToolCallChip(call, opts = {}) {
    const name = String(call?.name || '');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const toolDisplay = (opts.toolDisplay && opts.toolDisplay[name]) || null;
    const icon = toolDisplay?.icon || '🔧';
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const labelKey = toolDisplay?.label || name || i18n('(tool)');
    const type = toolDisplay?.type || 'edit';
    const status = String(opts.status || '');
    // Label was authored in English as the i18n key; translate at render
    // time so a single chip-render handles both en + zh users without
    // requiring tool-display modules to know about the popup's translator.
    const label = i18n(labelKey);

    const statusIcon = ({
        ok: '✅',
        fail: '❌',
        pending: '⏳',
    })[status] || '';

    const summaryText = (() => {
        if (typeof toolDisplay?.summarize === 'function') {
            try { return String(toolDisplay.summarize(args, opts.result, i18n) ?? ''); } catch { /* fall through */ }
        }
        return truncatedKvSummary(args, 60);
    })();

    const detailsHtml = renderArgsDetails(args, i18n);
    // Allow `null` to flow through to the result renderer — read tools that
    // legitimately return null (e.g. "no rows found") still deserve a result
    // block. `renderResultDetails` handles `null` explicitly at the
    // primitive-vs-object branch.
    const resultHtml = (opts.result !== undefined)
        ? renderResultDetails(opts.result, i18n)
        : '';

    // Flat (newline-separated, no indent) layout keeps individual HTML lines
    // short (< 120 chars) and the summary <div>'s inner content compact, which
    // matters both for the screenshot-bug regression tests and for grep-ability
    // when inspecting the rendered DOM.
    const summaryParts = [];
    if (statusIcon) summaryParts.push(`<span class="luker_lib_toolcall_status">${statusIcon}</span>`);
    summaryParts.push(`<span class="luker_lib_toolcall_icon">${escapeHtml(icon)}</span>`);
    summaryParts.push(`<span class="luker_lib_toolcall_label">${escapeHtml(label)}</span>`);
    if (summaryText) summaryParts.push(`<span class="luker_lib_toolcall_summary_text">${escapeHtml(summaryText)}</span>`);

    const lines = [
        `<div class="luker_lib_toolcall luker_lib_toolcall_${escapeHtmlAttr(type)}">`,
        `<div class="luker_lib_toolcall_summary">`,
        ...summaryParts,
        `</div>`,
    ];
    if (detailsHtml) lines.push(detailsHtml);
    if (resultHtml) lines.push(resultHtml);
    lines.push(`</div>`);
    return lines.join('\n');
}

function truncatedKvSummary(args, max) {
    const keys = Object.keys(args || {});
    if (keys.length === 0) return '';
    const pairs = [];
    let totalLen = 0;
    for (const k of keys) {
        const v = args[k];
        const sv = typeof v === 'string' ? `"${v}"` : (v && typeof v === 'object' ? '{…}' : String(v));
        const pair = `${k}: ${sv.length > 20 ? sv.slice(0, 17) + '…' : sv}`;
        if (totalLen + pair.length > max) {
            if (pairs.length === 0) {
                // Always show at least one pair (truncated) so the chip has content.
                pairs.push(pair.slice(0, Math.max(1, max - 1)) + '…');
            } else {
                pairs.push(`… (${keys.length - pairs.length} more)`);
            }
            break;
        }
        pairs.push(pair);
        totalLen += pair.length + 2;
    }
    return pairs.join(', ');
}

function renderFieldRows(obj) {
    const keys = Object.keys(obj || {});
    if (keys.length === 0) return '';
    const rowLines = [];
    for (const k of keys) {
        const v = obj[k];
        const valueHtml = renderArgValue(v);
        rowLines.push(`<div class="luker_lib_toolcall_arg_row">`);
        rowLines.push(`<label class="luker_lib_toolcall_arg_key">${escapeHtml(k)}</label>`);
        rowLines.push(`<div class="luker_lib_toolcall_arg_value">`);
        rowLines.push(valueHtml);
        rowLines.push(`</div>`);
        rowLines.push(`</div>`);
    }
    return rowLines.join('\n');
}

function renderArgsDetails(args, i18n) {
    const rows = renderFieldRows(args);
    if (!rows) return '';
    return [
        `<details class="luker_lib_toolcall_details">`,
        `<summary>${escapeHtml(i18n('Arguments'))}</summary>`,
        `<div class="luker_lib_toolcall_arg_rows">`,
        rows,
        `</div>`,
        `</details>`,
    ].join('\n');
}

function renderArgValue(v) {
    if (typeof v === 'string') {
        if (v.length > 120) {
            return `<pre class="luker_lib_toolcall_long_value">${escapeHtml(v)}</pre>`;
        }
        return `<span class="luker_lib_toolcall_short_value">${escapeHtml(v)}</span>`;
    }
    if (v && typeof v === 'object') {
        const inner = Array.isArray(v)
            ? `[ ${v.slice(0, 3).map(formatScalar).join(', ')}${v.length > 3 ? `, … (${v.length - 3} more)` : ''} ]`
            : `{ ${Object.keys(v).slice(0, 3).map(k => `${k}: ${formatScalar(v[k])}`).join(', ')}${Object.keys(v).length > 3 ? `, … (${Object.keys(v).length - 3} more)` : ''} }`;
        return `<code class="luker_lib_toolcall_obj_value">${escapeHtml(inner)}</code>`;
    }
    return `<span class="luker_lib_toolcall_scalar_value">${escapeHtml(String(v))}</span>`;
}

function formatScalar(v) {
    if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 17)}…"` : `"${v}"`;
    if (v && typeof v === 'object') return '{…}';
    return String(v);
}

function renderResultDetails(result, i18n) {
    const isPlainObject = result !== null
        && typeof result === 'object'
        && !Array.isArray(result);
    const keyCount = isPlainObject ? Object.keys(result).length : 0;
    // Open heuristic:
    //   - primitives (string/number/boolean) → open (one short scalar is fine to show)
    //   - non-empty array with ≤5 items → open
    //   - non-empty plain object with ≤5 keys → open
    //   - empty object/array, null, or larger blobs → closed
    const open = (() => {
        if (result == null) return false;
        if (typeof result !== 'object') return true;
        if (Array.isArray(result)) return result.length > 0 && result.length <= 5;
        return keyCount > 0 && keyCount <= 5;
    })();
    const bodyHtml = (isPlainObject && keyCount > 0)
        ? `<div class="luker_lib_toolcall_arg_rows">\n${renderFieldRows(result)}\n</div>`
        : renderArgValue(result);
    return [
        `<details class="luker_lib_toolcall_result"${open ? ' open' : ''}>`,
        `<summary>${escapeHtml(i18n('Result'))}</summary>`,
        `<div class="luker_lib_toolcall_result_body">`,
        bodyHtml,
        `</div>`,
        `</details>`,
    ].join('\n');
}

function escapeHtml(s) {
    // Text-content escape only. We intentionally leave `"` and `'` alone so
    // the truncated KV summary can render `a: "short"` verbatim. Attribute
    // positions use `escapeHtmlAttr` below.
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Wider escape for attribute interpolation (also escapes `"` and `'`) so
// any user-controlled string that ends up in an HTML attribute position
// can't break out of the attribute. The only such position in this file
// is the `type` enum, but using the helper deliberately documents the
// intent and stays safe if the interpolation surface grows.
function escapeHtmlAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[c]));
}
