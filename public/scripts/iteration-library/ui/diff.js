import * as textDiff from '../text-diff.js';
import { decodeBackward } from '../storage/patch-codec.js';
import { resolveTarget } from '../storage/target-registry.js';

/**
 * Render a diff card.
 *
 * Two input shapes are accepted:
 *
 *   1. Legacy edit-list: `renderDiffCard(edits, opts)` where `edits` is an
 *      array of `{op, path, oldValue, newValue, ...}` objects. Used by
 *      adapters that still feed the per-tool edit shape (CPA / CEA tool
 *      output, MG schema array splits, orch lorebook body renderer).
 *
 *   2. Bus-entry shape: `renderDiffCard(entry, opts)` where `entry` is an
 *      object with `{target, inverse}`. Used by the new patch-storage
 *      proposal cards. The renderer fetches `live` via the target
 *      registry, reconstructs the propose-time `before` via
 *      decodeBackward(live, inverse), and synthesizes a single
 *      whole-state `set` edit to feed the legacy leaf walker. When the
 *      inverse cannot be replayed against `live` (target drift /
 *      registry miss), falls back to a raw record card so the user
 *      still sees that the entry exists.
 *
 * @param {Array|Object} input  Either an edits array or a bus entry.
 * @param {Object} opts
 * @param {Object}   [opts.fieldLabels]   Map field path → friendly label.
 * @param {boolean}  [opts.includeRawArgs] Embed a folded raw-args details below each card.
 * @param {Object}   [opts.live]           Pre-edit snapshot. When provided, str_replace /
 *                                         str_insert / str_delete resolve `edit.path` against
 *                                         this object. Pending edits should pass the studio's
 *                                         live state here. Already-applied history edits should
 *                                         leave this unset so the renderer falls back to the
 *                                         focused find→replace card.
 * @param {Function} [opts.i18n]
 * @param {Function} [opts.translate]      Alternate name for the translator (entry path uses this).
 * @returns {string|Promise<string>} HTML. Returns a Promise when the entry
 *                                       path is taken (target.read is async);
 *                                       array path stays synchronous.
 */
export function renderDiffCard(input, opts = {}) {
    if (Array.isArray(input)) {
        if (input.length === 0) return '';
        return input.map(edit => renderOneEdit(edit, opts)).join('');
    }
    if (input && typeof input === 'object' && input.target && Array.isArray(input.inverse)) {
        return renderEntryDiffCard(input, opts);
    }
    return '';
}

async function renderEntryDiffCard(entry, opts) {
    const translator = typeof opts?.translate === 'function'
        ? opts.translate
        : (typeof opts?.i18n === 'function' ? opts.i18n : (s) => String(s ?? ''));
    let handler;
    try {
        handler = resolveTarget(entry.target);
    } catch (err) {
        // UnknownTargetError or anything else: fall back to raw record. We
        // collapse both arms because the rendered output is identical;
        // the discriminator is purely informational.
        return renderRawRecord(entry, { ...opts, translate: translator });
    }
    let live;
    try {
        live = await handler.read(entry.target);
    } catch {
        return renderRawRecord(entry, { ...opts, translate: translator });
    }
    let before;
    try {
        before = decodeBackward(live, entry.inverse, {
            targetType: entry.target.type,
            targetName: entry.target.name || null,
        });
    } catch (err) {
        // Inverse-patch failure means storage + live state can no longer
        // reconstruct the propose-time before-snapshot — a genuine
        // data-integrity signal worth surfacing in devtools even though
        // the UI falls back to raw-record gracefully.
        // eslint-disable-next-line no-console
        console.warn('[iter-lib diff] decodeBackward failed for entry', entry?.id, err);
        return renderRawRecord(entry, { ...opts, translate: translator });
    }
    const after = live;
    const synthEdit = { op: 'set', path: '', oldValue: before, newValue: after };
    return renderOneEdit(synthEdit, { ...opts, i18n: typeof opts?.i18n === 'function' ? opts.i18n : translator });
}

function renderRawRecord(entry, opts) {
    const t = typeof opts?.translate === 'function'
        ? opts.translate
        : (typeof opts?.i18n === 'function' ? opts.i18n : (s) => String(s ?? ''));
    const json = JSON.stringify(entry?.inverse ?? null, null, 2);
    const safeJson = escapeHtml(json);
    const label = escapeHtml(t('View raw record'));
    return `<div class="iter-diff-raw luker_lib_diff_card">
        <pre>${safeJson}</pre>
        <button data-action="view-raw-record">${label}</button>
    </div>`;
}

function renderOneEdit(edit, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    if (!edit || typeof edit !== 'object') return '';
    if (edit.op === 'set') {
        return renderSetEdit(edit, opts);
    }
    // Text-edit ops produced by the cpa / cea str tools. When the caller
    // passes `opts.live`, we resolve the field's pre-edit value, virtually
    // apply the op locally, and render a single sub-card with the full
    // before/after — so the user sees the whole field with the change in
    // context (the surrounding paragraphs of a prompt, not just the
    // anchor + inserted snippet). When `opts.live` is missing or the path
    // doesn't resolve to a string, we fall back to today's focused
    // find→replace card so historical / malformed edits still render
    // something useful.
    if (edit.op === 'str_replace') {
        const ctx = previewStrOpAgainstLive(edit, opts.live);
        if (ctx) return renderSubCard(ctx.path, ctx.before, ctx.after, opts);
        return renderSubCard(String(edit.path || ''), String(edit.find ?? ''), String(edit.replace ?? ''), opts);
    }
    if (edit.op === 'str_insert') {
        const ctx = previewStrOpAgainstLive(edit, opts.live);
        if (ctx) return renderSubCard(ctx.path, ctx.before, ctx.after, opts);
        // Fallback: no live snapshot. Render as "<nothing> → <inserted
        // text>" — the anchor (after_text / before / after / index) is
        // intentionally omitted because without the live value we can't
        // place it accurately. `insert_text` is CPA's field name; fall
        // back to `text` / `value` for any future emitter using the
        // bare name.
        return renderSubCard(String(edit.path || ''), '', String(edit.insert_text ?? edit.text ?? edit.value ?? ''), opts);
    }
    if (edit.op === 'str_delete') {
        const ctx = previewStrOpAgainstLive(edit, opts.live);
        if (ctx) return renderSubCard(ctx.path, ctx.before, ctx.after, opts);
        return renderSubCard(String(edit.path || ''), String(edit.find ?? ''), '', opts);
    }
    // List ops produced by CPA's preset_list_* tools. Each surfaces an
    // anchor / index / from-to that helps the user place the change.
    if (edit.op === 'list_insert') {
        return renderListInsertCard(edit, opts);
    }
    if (edit.op === 'list_remove') {
        return renderListRemoveCard(edit, opts);
    }
    if (edit.op === 'list_move') {
        return renderListMoveCard(edit, opts);
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

/**
 * Translate-and-fill a templated string. Calls `i18n(template, ...values)`
 * first so multi-arg formatter functions (orchestrator's `tf`, CEA's
 * `i18nFormat`) do their own substitution; then runs a defensive
 * `${N}` → values[N] pass so single-arg `t(template) → translation`
 * functions and plain identity functions still come out filled.
 *
 * Without this, the new list-op renderers (renderListMoveCard / Insert /
 * Remove) would surface literal `Insert into ${0}` strings whenever the
 * caller passed a non-formatter i18n implementation.
 */
function fmt(i18n, template, ...values) {
    const translated = typeof i18n === 'function' ? String(i18n(template, ...values) ?? '') : String(template ?? '');
    return translated.replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

/**
 * "Empty" sentinel for diff comparison. We consider all of these
 * equivalent and skip rendering when both sides are empty:
 *
 *   - undefined / null
 *   - empty string
 *   - empty array []
 *   - empty plain object {}
 *
 * Without this, a tool call that "sets" `apiPresetName: ''` over
 * `undefined` produces a "(+0 bytes)" card with an empty diff (pure
 * noise). Same goes for an inserted sub-agent whose default-blank fields
 * never had a value before — every blank-to-blank field would render its
 * own empty card.
 *
 * Strings of pure whitespace are NOT treated as empty (the difference
 * between '' and '\n\n' can be meaningful in prompt authoring), but
 * `null` vs `undefined` and either-vs-`''` are all collapsed.
 */
function isEmptyish(v) {
    if (v === undefined || v === null || v === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
    return false;
}

function renderSubCard(path, oldValue, newValue, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    // Empty ↔ empty: never render. Catches default-blank insertions
    // (undefined → ''), no-op sets, blank-to-null normalization, etc.
    if (isEmptyish(oldValue) && isEmptyish(newValue)) return '';

    const oldIsObject = oldValue && typeof oldValue === 'object';
    const newIsObject = newValue && typeof newValue === 'object';
    const oldIsArray = Array.isArray(oldValue);
    const newIsArray = Array.isArray(newValue);

    // Object / array values: never JSON-dump them into the text diff. Walk
    // the structure and emit one sub-card per changed leaf so the user
    // sees the actual field-level change with the right tool-tip path.
    //
    // Covers both sides-object as well as insert (one side empty) and
    // delete (other side empty), with the same 50-leaf cap renderSetEdit
    // already uses to keep giant objects from exploding the view.
    const oneSideObj = oldIsObject || newIsObject;
    const otherSideEmptyOrObj = (oldIsObject || isEmptyish(oldValue))
        && (newIsObject || isEmptyish(newValue));
    if (oneSideObj && otherSideEmptyOrObj && oldIsArray === newIsArray) {
        // For arrays with stable ids, defer to renderArrayByIdDiff (per-item
        // sub-cards by id) so reorders / inserts / updates show their
        // identifier rather than collapsing to a JSON dump.
        if (oldIsArray || newIsArray) {
            const oldArr = oldIsArray ? oldValue : [];
            const newArr = newIsArray ? newValue : [];
            if (arraysHaveStableIds(oldArr, newArr)) {
                return renderArrayByIdDiff(oldArr, newArr, { ...opts });
            }
            // Fall through to the walkDiff path for arrays without stable
            // ids — better than JSON dump even if the leaf path is `[0].x`.
        }
        const oldObj = oldIsObject ? oldValue : {};
        const newObj = newIsObject ? newValue : {};
        const changed = new Set();
        walkDiff('', oldObj, newObj, changed);
        const composePath = (leaf) => path
            ? (leaf ? `${path}.${leaf}` : path)
            : leaf;
        // Drop leaves that are empty ↔ empty in disguise (undefined → '',
        // null → 0-length array, etc.). walkDiff uses `===` so it can't
        // collapse these itself.
        const meaningful = [...changed].filter((leafPath) => {
            const a = getByPath(oldObj, leafPath);
            const b = getByPath(newObj, leafPath);
            return !(isEmptyish(a) && isEmptyish(b));
        });
        if (meaningful.length === 0) return '';
        if (meaningful.length <= 50) {
            return meaningful.map((leafPath) => renderSubCard(
                composePath(leafPath),
                getByPath(oldObj, leafPath),
                getByPath(newObj, leafPath),
                opts,
            )).join('');
        }
        // Fall through to text-diff when there are too many leaves to
        // render individually — better one big card than 200 small ones.
    }

    const beforeText = stringifyValue(oldValue);
    const afterText = stringifyValue(newValue);
    if (beforeText === afterText) return '';
    const isWholeObject = path === '';
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
            <span class="luker_lib_diff_delta">${escapeHtml(fmt(i18n, '(${0}${1} bytes)', sign, bytesDelta))}</span>
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

/**
 * Virtually apply a str_replace / str_insert / str_delete edit against the
 * caller-supplied pre-edit snapshot and return { path, before, after } for
 * the renderer. Mirrors the apply semantics of the engine ops in
 * `public/scripts/lib/edits/ops/str-*.js` — kept inline so the renderer
 * never imports the engine (UI / engine are otherwise decoupled).
 *
 * Returns null when:
 *   - `live` is not a plain object (caller didn't pass a snapshot)
 *   - `edit.path` resolves to a non-string value (drift / wrong path)
 *   - the anchor isn't present in the live string (anchor_missing — would
 *     surface as a conflict at apply time; in the renderer we fall back to
 *     the focused find→replace card so the user still sees the AI's intent)
 *
 * Known limitation: each edit is virtual-applied independently against the
 * SAME `live` snapshot. If a single round emits two str-ops on the same
 * `edit.path` (e.g. two str_inserts into one prompt), the second one's
 * anchor may not be present in pre-edit live — it would only exist after
 * the first edit is applied. The engine handles this correctly at apply
 * time by threading live forward; the renderer doesn't, because each
 * `renderOneEdit` call is independent and unaware of sibling edits. In
 * that case the second card falls back to the focused find→replace
 * preview, which is still useful (shows what's getting inserted) — just
 * without the full surrounding context. Multi-edit-on-same-path within a
 * round is rare; the tool-side uniqueness check (`assertStrOpUniqueness`)
 * also tends to push the model toward one edit per anchor.
 *
 * Null callers fall back to the focused renderSubCard path.
 */
function previewStrOpAgainstLive(edit, live) {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return null;
    const path = String(edit?.path || '');
    if (!path) return null;
    const current = getByPath(live, path);
    if (typeof current !== 'string') return null;
    if (edit.op === 'str_replace') {
        const find = String(edit.find ?? '');
        if (!find || current.indexOf(find) < 0) return null;
        // Mirror engine semantics: replaceAll. `expected_count` is enforced
        // at apply time as a conflict, not here — the renderer's job is to
        // show what *would* happen if apply succeeds.
        const replace = String(edit.replace ?? '');
        const next = current.split(find).join(replace);
        return { path, before: current, after: next };
    }
    if (edit.op === 'str_insert') {
        const insertText = String(edit.insert_text ?? edit.text ?? edit.value ?? '');
        const anchor = String(edit.after_text ?? '');
        if (anchor) {
            const idx = current.indexOf(anchor);
            if (idx < 0) return null;
            const insertAt = idx + anchor.length;
            const next = current.slice(0, insertAt) + insertText + current.slice(insertAt);
            return { path, before: current, after: next };
        }
        // No anchor: treat as append. This keeps the renderer useful for
        // future emitters that insert at end-of-field without an anchor.
        return { path, before: current, after: current + insertText };
    }
    if (edit.op === 'str_delete') {
        const find = String(edit.find ?? '');
        if (!find || current.indexOf(find) < 0) return null;
        const next = current.split(find).join('');
        return { path, before: current, after: next };
    }
    return null;
}

/**
 * Best-effort one-line label for a list item — pick the field most users
 * would recognize. Falls back to a JSON-ish preview (truncated) so the
 * label is always non-empty, but we never dump a full multi-line object.
 *
 * Common item shapes:
 *   - CPA prompts[]: { identifier, name, role, content, ... } → name
 *   - prompt_order[*].order[]: { identifier, enabled } → identifier
 *   - generic { id, name, ... } → name
 *   - anything else with .label / .title / .key → that
 *   - scalars → the value itself, truncated
 */
function summarizeListItem(item) {
    if (item == null) return '(empty)';
    if (typeof item !== 'object') {
        const s = String(item);
        return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    }
    const candidate = item.name ?? item.title ?? item.label ?? item.identifier ?? item.id ?? item.key;
    if (candidate != null && candidate !== '') {
        const s = String(candidate);
        return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    }
    try {
        const s = JSON.stringify(item);
        return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    } catch {
        return '(object)';
    }
}

/**
 * Render a one-line context strip showing a window around an index in a
 * list: `… [n-1] foo · [n] BAR · [n+1] baz …`. The targeted index is
 * highlighted via a CSS class so the user can see exactly where the change
 * lands without us having to dump the whole list.
 *
 * @param {Array} list   The list to sample (`opts.live` slot for the path).
 * @param {number} index The targeted index. `-1` if we don't know.
 * @param {string} highlightCls CSS class applied to the targeted [n] chip.
 * @param {number} window Items on each side of `index` to include.
 */
function renderListContextStrip(list, index, highlightCls, window = 2) {
    if (!Array.isArray(list) || list.length === 0) return '';
    const safeIdx = Number.isInteger(index) ? Math.max(-1, Math.min(list.length - 1, index)) : -1;
    if (safeIdx < 0) {
        // No anchor → show first few entries so the user at least knows the
        // shape of the list.
        const head = list.slice(0, Math.max(1, window * 2 + 1));
        const dots = list.length > head.length ? ' …' : '';
        return `<div class="luker_lib_diff_list_strip">${head.map((it, i) =>
            `<span class="luker_lib_diff_list_strip_item"><span class="luker_lib_diff_list_strip_idx">[${i}]</span> ${escapeHtml(summarizeListItem(it))}</span>`,
        ).join('<span class="luker_lib_diff_list_strip_sep">·</span>')}${dots}</div>`;
    }
    const start = Math.max(0, safeIdx - window);
    const end = Math.min(list.length, safeIdx + window + 1);
    const leadDots = start > 0 ? '… ' : '';
    const trailDots = end < list.length ? ' …' : '';
    const chips = [];
    for (let i = start; i < end; i++) {
        const cls = i === safeIdx ? `luker_lib_diff_list_strip_item ${highlightCls}` : 'luker_lib_diff_list_strip_item';
        chips.push(`<span class="${cls}"><span class="luker_lib_diff_list_strip_idx">[${i}]</span> ${escapeHtml(summarizeListItem(list[i]))}</span>`);
    }
    return `<div class="luker_lib_diff_list_strip">${leadDots}${chips.join('<span class="luker_lib_diff_list_strip_sep">·</span>')}${trailDots}</div>`;
}

/**
 * Resolve a list at `path` from the live snapshot, if any. Used by the
 * list_* renderers to show neighborhood context strips.
 */
function resolveLiveList(path, opts) {
    if (!opts || opts.live == null || typeof opts.live !== 'object') return null;
    const v = getByPath(opts.live, String(path || ''));
    return Array.isArray(v) ? v : null;
}

function renderListMoveCard(edit, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const path = String(edit.path || '');
    const fromIdx = Number.isInteger(edit.from_index) ? edit.from_index : -1;
    const toIdx = Number.isInteger(edit.to_index) ? edit.to_index : -1;
    const itemLabel = edit.expected_value != null
        ? summarizeListItem(edit.expected_value)
        : '';
    const headerMain = fmt(i18n, 'Reorder ${0}', path || '(root)');
    const headerDetail = itemLabel
        ? fmt(i18n, '"${0}": [${1}] → [${2}]', itemLabel, String(fromIdx >= 0 ? fromIdx : '?'), String(toIdx >= 0 ? toIdx : '?'))
        : fmt(i18n, '[${0}] → [${1}]', String(fromIdx >= 0 ? fromIdx : '?'), String(toIdx >= 0 ? toIdx : '?'));
    const liveList = resolveLiveList(path, opts);
    const beforeStrip = liveList
        ? `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('Before'))}</div>${renderListContextStrip(liveList, fromIdx, 'luker_lib_diff_list_strip_move_src')}`
        : '';
    // Simulate the move locally for the "after" preview so the user sees
    // the new neighbors. Pure on the snapshot — we never mutate live.
    let afterStrip = '';
    if (liveList && fromIdx >= 0 && toIdx >= 0 && fromIdx < liveList.length) {
        const next = liveList.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        afterStrip = `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('After'))}</div>${renderListContextStrip(next, toIdx, 'luker_lib_diff_list_strip_move_dst')}`;
    }
    return `<div class="luker_lib_diff_card luker_lib_diff_card_list_op" data-luker-lib-diff-zoom="${escapeHtmlAttr(path)}">
        <div class="luker_lib_diff_header">
            <span class="luker_lib_diff_op">${escapeHtml(headerMain)}</span>
            <span class="luker_lib_diff_delta">${escapeHtml(headerDetail)}</span>
        </div>
        ${beforeStrip}
        ${afterStrip}
    </div>`;
}

function renderListInsertCard(edit, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const path = String(edit.path || '');
    const anchor = edit.anchor && typeof edit.anchor === 'object' ? edit.anchor : {};
    const itemLabel = edit.value != null ? summarizeListItem(edit.value) : '';
    const anchorText = (anchor.after != null)
        ? fmt(i18n, 'after ${0}', summarizeListItem(anchor.after))
        : (anchor.before != null ? fmt(i18n, 'before ${0}', summarizeListItem(anchor.before)) : i18n('at end'));
    const headerMain = fmt(i18n, 'Insert into ${0}', path || '(root)');
    const headerDetail = itemLabel
        ? fmt(i18n, '+ "${0}" (${1})', itemLabel, anchorText)
        : fmt(i18n, '+ (${0})', anchorText);
    // Show the neighborhood the insertion lands in. Anchor's index isn't
    // directly given for insert (it's `after`/`before` identifiers), so we
    // skip the live strip when we can't pinpoint the slot — the after
    // strip below (with the inserted item highlighted) is the actionable
    // preview anyway.
    const liveList = resolveLiveList(path, opts);
    let beforeStrip = '';
    let afterStrip = '';
    if (liveList) {
        // Try to map anchor.identifier-style anchors to an index by
        // matching summarizeListItem(item) === summarizeListItem(anchor.*).
        // Best-effort — falls back to "show head" when no match.
        const anchorKey = anchor.after != null ? anchor.after : (anchor.before != null ? anchor.before : null);
        let anchorIdx = -1;
        if (anchorKey != null) {
            const anchorLabel = summarizeListItem(anchorKey);
            anchorIdx = liveList.findIndex((it) => summarizeListItem(it) === anchorLabel);
        }
        beforeStrip = `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('Before'))}</div>${renderListContextStrip(liveList, anchorIdx, 'luker_lib_diff_list_strip_anchor')}`;
        // Simulate the insert for the after strip.
        const insertAt = anchorIdx >= 0
            ? (anchor.after != null ? anchorIdx + 1 : anchorIdx)
            : liveList.length;
        const next = liveList.slice();
        next.splice(insertAt, 0, edit.value);
        afterStrip = `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('After'))}</div>${renderListContextStrip(next, insertAt, 'luker_lib_diff_list_strip_add')}`;
    }
    return `<div class="luker_lib_diff_card luker_lib_diff_card_list_op" data-luker-lib-diff-zoom="${escapeHtmlAttr(path)}">
        <div class="luker_lib_diff_header">
            <span class="luker_lib_diff_op">${escapeHtml(headerMain)}</span>
            <span class="luker_lib_diff_delta">${escapeHtml(headerDetail)}</span>
        </div>
        ${beforeStrip}
        ${afterStrip}
    </div>`;
}

function renderListRemoveCard(edit, opts) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const path = String(edit.path || '');
    const removedAt = Number.isInteger(edit.index) ? edit.index : -1;
    const itemLabel = edit.expected_value != null ? summarizeListItem(edit.expected_value) : '';
    const headerMain = fmt(i18n, 'Remove from ${0}', path || '(root)');
    const headerDetail = itemLabel
        ? fmt(i18n, '− "${0}" (at [${1}])', itemLabel, String(removedAt >= 0 ? removedAt : '?'))
        : fmt(i18n, '− at [${0}]', String(removedAt >= 0 ? removedAt : '?'));
    const liveList = resolveLiveList(path, opts);
    let beforeStrip = '';
    let afterStrip = '';
    if (liveList) {
        beforeStrip = `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('Before'))}</div>${renderListContextStrip(liveList, removedAt, 'luker_lib_diff_list_strip_del')}`;
        if (removedAt >= 0 && removedAt < liveList.length) {
            const next = liveList.slice();
            next.splice(removedAt, 1);
            // Show the resulting neighborhood, highlighting the new occupant
            // of the removed slot (or the prior slot when removing the tail).
            const focusIdx = Math.min(removedAt, next.length - 1);
            afterStrip = `<div class="luker_lib_diff_list_strip_label">${escapeHtml(i18n('After'))}</div>${renderListContextStrip(next, focusIdx, 'luker_lib_diff_list_strip_anchor')}`;
        }
    }
    return `<div class="luker_lib_diff_card luker_lib_diff_card_list_op" data-luker-lib-diff-zoom="${escapeHtmlAttr(path)}">
        <div class="luker_lib_diff_header">
            <span class="luker_lib_diff_op">${escapeHtml(headerMain)}</span>
            <span class="luker_lib_diff_delta">${escapeHtml(headerDetail)}</span>
        </div>
        ${beforeStrip}
        ${afterStrip}
    </div>`;
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
