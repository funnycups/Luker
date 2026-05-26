import * as textDiff from '../text-diff.js';

/**
 * @param {Array} edits  Array of { op, path, oldValue, newValue, ... }
 * @param {Object} opts
 * @param {Object}   [opts.fieldLabels]   Map field path → friendly label.
 * @param {boolean}  [opts.includeRawArgs] Embed a folded raw-args details below each card.
 * @param {Function} opts.i18n
 * @returns {string} HTML
 */
export function renderDiffCard(edits, opts = {}) {
    if (!Array.isArray(edits) || edits.length === 0) return '';
    return edits.map(edit => renderOneEdit(edit, opts)).join('');
}

function renderOneEdit(edit, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    if (!edit || typeof edit !== 'object') return '';
    if (edit.op === 'set') {
        return renderSetEdit(edit, opts);
    }
    // Text-edit ops produced by the cpa / cea str tools. The args carry
    // `find` + `replace` (or `text` + `position` for inserts); rendering them
    // as a focused before/after card keeps the diff surface uniform with the
    // `set` path.
    if (edit.op === 'str_replace') {
        return renderSubCard(String(edit.path || ''), String(edit.find ?? ''), String(edit.replace ?? ''), opts);
    }
    if (edit.op === 'str_insert') {
        // Insert renders as "<nothing> → <inserted text>". The actual
        // anchor (before / after a substring, or at an index) is in
        // edit.before / edit.after / edit.index — we don't try to show
        // the surrounding context here because the live snapshot at
        // render time may have moved on. `insert_text` is CPA's field
        // name (preset_str_insert); fall back to `text` / `value` for
        // any future emitter that uses the bare name.
        return renderSubCard(String(edit.path || ''), '', String(edit.insert_text ?? edit.text ?? edit.value ?? ''), opts);
    }
    if (edit.op === 'str_delete') {
        return renderSubCard(String(edit.path || ''), String(edit.find ?? ''), '', opts);
    }
    // List ops produced by CPA's preset_list_* tools. Each surfaces an
    // anchor / index / from-to that helps the user place the change.
    if (edit.op === 'list_insert') {
        const anchor = edit.anchor && typeof edit.anchor === 'object' ? edit.anchor : {};
        const anchorLabel = (anchor.after != null)
            ? `@after ${anchor.after}`
            : (anchor.before != null ? `@before ${anchor.before}` : '@end');
        const path = `${String(edit.path || '')}[+] ${anchorLabel}`;
        return renderSubCard(path, undefined, edit.value, opts);
    }
    if (edit.op === 'list_remove') {
        const path = `${String(edit.path || '')}[${edit.index ?? '?'}]`;
        return renderSubCard(path, edit.expected_value, undefined, opts);
    }
    if (edit.op === 'list_move') {
        const path = String(edit.path || '');
        const fromIdx = edit.from_index ?? '?';
        const toIdx = edit.to_index ?? '?';
        const header = `Reorder ${path}: [${fromIdx}] → [${toIdx}]`;
        const previewText = stringifyValue(edit.expected_value);
        return `<div class="luker_lib_diff_card" data-luker-lib-diff-zoom="${escapeHtmlAttr(path)}">
            <div class="luker_lib_diff_header">
                <span class="luker_lib_diff_op">${escapeHtml(header)}</span>
            </div>
            ${previewText ? `<pre class="luker_lib_diff_list_preview">${escapeHtml(previewText)}</pre>` : ''}
        </div>`;
    }
    // Lorebook entry add/remove/update — show entry uid + the new/old
    // payload as a focused card.
    if (edit.op === 'lorebook_entry_add') {
        const uid = edit.entry?.uid ?? edit.uid;
        const path = `entries.${uid ?? '?'}`;
        return renderSubCard(path, undefined, edit.entry, opts);
    }
    if (edit.op === 'lorebook_entry_remove') {
        const path = `entries.${edit.uid ?? '?'}`;
        return renderSubCard(path, edit.entry, undefined, opts);
    }
    if (edit.op === 'lorebook_entry_update') {
        // Patch + before maps are parallel objects; render per-field
        // sub-cards so the user sees exactly which fields the AI is
        // editing on that entry.
        const uid = edit.uid;
        const patch = edit.patch || {};
        const before = edit.before || {};
        const keys = Object.keys(patch);
        if (keys.length === 0) return '';
        return keys.map((k) => {
            const path = `entries.${uid ?? '?'}.${k}`;
            return renderSubCard(path, before[k], patch[k], opts);
        }).join('');
    }
    return `<div class="luker_lib_diff_card">
        <span class="luker_lib_diff_op">${escapeHtml(String(edit.op || i18n('(unknown op)')))}</span>
        ${edit.path ? `<span class="luker_lib_diff_path">${escapeHtml(String(edit.path))}</span>` : ''}
    </div>`;
}

function arraysHaveStableIds(a, b) {
    const hasId = (arr) => Array.isArray(arr) && arr.length > 0
        && arr.every(item => item && typeof item === 'object' && !Array.isArray(item) && item.id != null);
    return hasId(a) && hasId(b);
}

/**
 * Render a `set` edit as one or more sub-cards. Goal: never dump a whole
 * JSON object as text-diff — for object-valued targets (whether at root,
 * at a leaf path, or at an array index path like `subAgents.8`) emit one
 * sub-card per changed leaf so the user sees the actual field-level
 * change instead of a JSON blob.
 *
 *   - both sides objects → walkDiff → per-leaf sub-cards
 *   - both sides arrays with stable `id` → renderArrayByIdDiff
 *   - new value is object, old missing (insert) → walk leaves of new vs {}
 *   - old value is object, new missing (delete) → walk leaves of old vs {}
 *   - scalars / mixed types → single renderSubCard at edit.path
 *
 * Cap at 50 leaves so a giant object still falls back to one card instead
 * of exploding the view — but allows inserts of a few sub-objects (e.g.
 * adding a sub-agent with several fields) to render per field.
 */
function renderSetEdit(edit, opts) {
    const basePath = String(edit.path || '');
    const oldV = edit.oldValue;
    const newV = edit.newValue;
    const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const isArr = (v) => Array.isArray(v);
    const composePath = (leaf) => basePath
        ? (leaf ? `${basePath}.${leaf}` : basePath)
        : leaf;

    if (isArr(oldV) && isArr(newV)) {
        if (arraysHaveStableIds(oldV, newV)) {
            return renderArrayByIdDiff(oldV, newV, opts);
        }
        return renderSubCard(basePath, oldV, newV, opts);
    }

    if (isPlainObj(oldV) && isPlainObj(newV)) {
        const changed = new Set();
        walkDiff('', oldV, newV, changed);
        if (changed.size > 0 && changed.size <= 50) {
            return [...changed].map(leafPath => renderSubCard(
                composePath(leafPath),
                getByPath(oldV, leafPath),
                getByPath(newV, leafPath),
                opts,
            )).join('');
        }
        return renderSubCard(basePath, oldV, newV, opts);
    }

    if (isPlainObj(newV) && (oldV === undefined || oldV === null)) {
        // Insert: walk newV's leaves and render each as "(empty) → leaf value"
        const changed = new Set();
        walkDiff('', {}, newV, changed);
        if (changed.size > 0 && changed.size <= 50) {
            return [...changed].map(leafPath => renderSubCard(
                composePath(leafPath),
                undefined,
                getByPath(newV, leafPath),
                opts,
            )).join('');
        }
        return renderSubCard(basePath, oldV, newV, opts);
    }

    if (isPlainObj(oldV) && (newV === undefined || newV === null)) {
        // Delete: mirror of insert
        const changed = new Set();
        walkDiff('', oldV, {}, changed);
        if (changed.size > 0 && changed.size <= 50) {
            return [...changed].map(leafPath => renderSubCard(
                composePath(leafPath),
                getByPath(oldV, leafPath),
                undefined,
                opts,
            )).join('');
        }
        return renderSubCard(basePath, oldV, newV, opts);
    }

    return renderSubCard(basePath, oldV, newV, opts);
}

function renderArrayByIdDiff(oldArr, newArr, opts) {
    const byIdOld = new Map();
    for (const item of oldArr) byIdOld.set(String(item.id), item);
    const byIdNew = new Map();
    for (const item of newArr) byIdNew.set(String(item.id), item);
    const allIds = new Set([...byIdOld.keys(), ...byIdNew.keys()]);
    const cards = [];
    for (const id of allIds) {
        const before = byIdOld.get(id);
        const after = byIdNew.get(id);
        if (deepEqual(before, after)) continue;
        cards.push(renderSubCard(id, before, after, opts));
    }
    return cards.join('');
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function renderSubCard(path, oldValue, newValue, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const isWholeObject = path === '';
    const beforeText = stringifyValue(oldValue);
    const afterText = stringifyValue(newValue);
    // Hide no-op leaves. `walkDiff` reaches per-leaf using `===`, which counts
    // `undefined !== ''` as a change — so inserting a new sub-agent with
    // default-empty `apiPresetName` (undefined → '') produces a "(+0 bytes)"
    // header with an empty inline diff that's pure noise. Suppressing here
    // also catches AI tool calls that set a field to its existing value.
    if (beforeText === afterText) return '';
    const beforeBytes = beforeText.length;
    const afterBytes = afterText.length;
    const bytesDelta = afterBytes - beforeBytes;
    const sign = bytesDelta >= 0 ? '+' : '';
    const labelMap = opts.fieldLabels || {};
    const friendly = labelMap[path] || humanizePath(path, i18n);
    const fileLabel = isWholeObject ? i18n('working profile') : friendly;
    const headerLabel = isWholeObject ? i18n('Profile updated') : `${i18n('Field updated')}: ${friendly}`;
    const libDiffHtml = textDiff.renderInlineTextDiffHtml(beforeText, afterText, {
        fileLabel,
        i18n,
    });
    // Header element uses `luker_lib_diff_header` (NOT `_card_header`) so that
    // `(html.match(/luker_lib_diff_card/g) || []).length` counts one match per
    // card, not one match for the card + one for its header.
    return `<div class="luker_lib_diff_card" data-luker-lib-diff-zoom="${escapeHtmlAttr(path)}">
        <div class="luker_lib_diff_header">
            <span class="luker_lib_diff_op">${escapeHtml(headerLabel)}</span>
            <span class="luker_lib_diff_delta">${escapeHtml(i18n('(${0}${1} bytes)', sign, bytesDelta))}</span>
        </div>
        ${libDiffHtml}
    </div>`;
}

function stringifyValue(v) {
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function humanizePath(path, i18n) {
    if (!path) return typeof i18n === 'function' ? i18n('(root)') : '(root)';
    return String(path).replace(/_/g, ' ');
}

function walkDiff(prefix, a, b, out, seen, depth) {
    const seenSet = seen instanceof WeakSet ? seen : new WeakSet();
    const currentDepth = typeof depth === 'number' ? depth : 0;
    // Guard against cyclic inputs (a or b in their own descendants) and
    // pathological depth blowups. The 50-level cap matches what plain JSON
    // edit payloads from CPA / MG could reasonably produce; deeper inputs
    // collapse to a leaf at the current prefix so the renderer still
    // surfaces *something* rather than throwing.
    if (currentDepth > 50) {
        out.add(prefix || '(root)');
        return;
    }
    if (a === b) return;
    // Insert/delete of an object subtree (one side null/undefined, the
    // other a plain non-array object) — descend with an empty placeholder
    // on the missing side so every leaf of the inserted/deleted object
    // becomes its own changed path. Without this, an inserted
    // `subAgents[8] = { id, description, systemPrompt, ... }` collapses to
    // a single leaf whose value is the whole object, and renderSubCard
    // dumps a raw JSON blob.
    const aIsObj = a != null && typeof a === 'object' && !Array.isArray(a);
    const bIsObj = b != null && typeof b === 'object' && !Array.isArray(b);
    if (aIsObj && (b === null || b === undefined)) {
        walkDiff(prefix, a, {}, out, seenSet, currentDepth + 1);
        return;
    }
    if (bIsObj && (a === null || a === undefined)) {
        walkDiff(prefix, {}, b, out, seenSet, currentDepth + 1);
        return;
    }
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
        out.add(prefix || '(root)');
        return;
    }
    if (seenSet.has(a) || seenSet.has(b)) {
        out.add(prefix || '(root)');
        return;
    }
    seenSet.add(a);
    seenSet.add(b);
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const childPrefix = prefix ? `${prefix}.${k}` : k;
        const av = a[k], bv = b[k];
        if (av === bv) continue;
        if (av && bv && typeof av === 'object' && typeof bv === 'object' && Array.isArray(av) === Array.isArray(bv)) {
            walkDiff(childPrefix, av, bv, out, seenSet, currentDepth + 1);
        } else if (
            (av != null && typeof av === 'object' && !Array.isArray(av) && (bv === null || bv === undefined))
            || (bv != null && typeof bv === 'object' && !Array.isArray(bv) && (av === null || av === undefined))
        ) {
            // Same insert/delete-subtree case as above, but at a child path.
            walkDiff(childPrefix, av, bv, out, seenSet, currentDepth + 1);
        } else {
            out.add(childPrefix);
        }
    }
}

function getByPath(obj, path) {
    if (!path) return obj;
    // Split `a.b[0].c[1]` into ['a', 'b', '0', 'c', '1']. The regex captures
    // bracketed indexes and `.split` interleaves them with the dotted
    // segments; filter(Boolean) drops the empty pieces the split produces
    // around each match.
    const segments = String(path).split(/\.|\[(\d+)\]/).filter(Boolean);
    let cur = obj;
    for (const seg of segments) {
        if (cur == null) return undefined;
        cur = cur[seg];
    }
    return cur;
}

function escapeHtml(s) {
    // Same narrowing as toolcall.js / message.js: only & < > escaped.
    // Text-content positions only; never used in attribute interpolation
    // outside controlled enums.
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeHtmlAttr(s) {
    // Wider escape that also handles `"` and `'` so we can safely
    // interpolate user-controlled paths into attribute positions
    // (e.g. data-luker-lib-diff-zoom="${path}").
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[c]));
}
