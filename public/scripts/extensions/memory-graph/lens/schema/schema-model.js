// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the visual memory-structure editor. memory-graph stores a
// node type with the same column names repeated across tableColumns /
// requiredColumns / embeddingColumns / primaryKeyColumns / columnHints; the
// editor works on "one row per record item" drafts and converts back.
// Every field the editor does not expose (extraction / compression rules,
// numbers, keywords …) is carried through untouched.

import { i18n, i18nFormat, listSeparator, builtinTypeLabel, hasFieldLabel, fieldLabel, humanizeKey, isChineseLocale } from '../i18n.js';

const DEFAULT_ENGLISH_LABELS = {
    event: 'Event',
    character_sheet: 'Character Sheet',
    location_state: 'Location State',
    thread: 'Thread',
    rule_constraint: 'Rule Constraint',
};
const IDENTITY_CANDIDATES = ['title', 'name', 'aliases'];
const LOCKED_COLUMNS = { event: ['summary'] };
const UNDELETABLE_TYPES = new Set(['event']);
const CJK = /[\u3400-\u9fff]/;

let uidCounter = 0;
const uid = (prefix) => `${prefix}${++uidCounter}`;

const list = (value) => (Array.isArray(value) ? value.map(v => String(v ?? '').trim()).filter(Boolean) : []);
const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

/** Display name of a node type; Chinese locales replace memory-graph's English defaults. */
export function typeDisplayName(spec) {
    const id = String(spec?.id || spec?.type || '');
    const label = String(spec?.label || '').trim();
    if (!isChineseLocale() && label && label !== id) return label;
    const builtin = builtinTypeLabel(id);
    if (!label || label === id || label === DEFAULT_ENGLISH_LABELS[id]) return builtin || label || i18n('Unnamed type');
    const template = label.match(/^Custom Type (\d+)$/i);
    if (template) return i18nFormat('Custom type ${0}', template[1]);
    return label;
}

/**
 * Short name for a column: user label > built-in translation. Chinese locales
 * then try the head of a Chinese hint (and never show the raw key); other
 * locales fall back to a readable form of the key.
 */
export function columnDisplayName(typeId, key, hint, storedLabels) {
    const stored = storedLabels?.[typeId]?.[key];
    if (stored) return stored;
    if (hasFieldLabel(key)) return fieldLabel(key);
    if (!isChineseLocale()) return humanizeKey(key);
    const text = String(hint || '').trim();
    const head = text.split(/[，,。．.；;：:（(\n|]/)[0].trim();
    if (head && CJK.test(head) && head.length <= 12) return head;
    const cjkHead = (text.match(/^[^A-Za-z]*?([\u3400-\u9fff][\u3400-\u9fff·／/、]{1,9})/) || [])[1];
    if (cjkHead) return cjkHead.replace(/[、／/]+$/, '');
    return UNNAMED;
}

export const UNNAMED = i18n('Unnamed item');
export const isUnnamed = (label) => !label || label === UNNAMED;

/** Labels for every type/column, for the read views. */
export function buildLabelMaps(schemaTypes, storedLabels) {
    const types = {};
    const columns = {};
    for (const spec of Array.isArray(schemaTypes) ? schemaTypes : []) {
        const id = String(spec?.id || spec?.type || '');
        if (!id) continue;
        types[id] = typeDisplayName(spec);
        const hints = spec.columnHints || {};
        columns[id] = {};
        for (const key of list(spec.tableColumns)) columns[id][key] = columnDisplayName(id, key, hints[key], storedLabels);
    }
    return { types, columns };
}

/**
 * @param {object} spec memory-graph type spec
 * @param {object} storedLabels user column labels { typeId: { key: label } }
 * @param {object|null} defaultSpec the Luker default spec for this type id, if any.
 *   Hints/intro equal to the default are hidden (they are long English
 *   instructions) and kept as-is unless the user writes their own.
 */
export function toDraft(spec, storedLabels = {}, defaultSpec = null) {
    const raw = clone(spec || {});
    const id = String(raw.id || '');
    const hints = raw.columnHints && typeof raw.columnHints === 'object' ? raw.columnHints : {};
    const defaultHints = defaultSpec?.columnHints || {};
    const required = new Set(list(raw.requiredColumns));
    const locked = new Set(LOCKED_COLUMNS[id] || []);
    const originalIntro = String(raw.extractHint || '');
    const usesDefaultIntro = Boolean(originalIntro) && originalIntro === String(defaultSpec?.extractHint || '');
    return {
        uid: uid('t'),
        id,
        isNew: false,
        deletable: !UNDELETABLE_TYPES.has(id),
        name: typeDisplayName(raw),
        intro: usesDefaultIntro ? '' : originalIntro,
        originalIntro,
        usesDefaultIntro,
        alwaysInject: Boolean(raw.alwaysInject),
        latestOnly: Boolean(raw.latestOnly),
        compression: String(raw.compression?.mode || 'none') === 'hierarchical',
        columns: list(raw.tableColumns).map(key => {
            const originalHint = String(hints[key] || '');
            const usesDefaultHint = Boolean(originalHint) && originalHint === String(defaultHints[key] || '');
            return {
                uid: uid('c'),
                key,
                // Unnamed items open with an empty name box (placeholder asks for one).
                label: isUnnamed(columnDisplayName(id, key, originalHint, storedLabels)) ? '' : columnDisplayName(id, key, originalHint, storedLabels),
                hint: usesDefaultHint ? '' : originalHint,
                originalHint,
                usesDefaultHint,
                required: required.has(key) || locked.has(key),
                locked: locked.has(key),
                isNew: false,
            };
        }),
        raw,
    };
}

export function toDrafts(types, storedLabels = {}, defaults = []) {
    const byId = new Map((defaults || []).map(d => [String(d.id || ''), d]));
    return (types || []).map(spec => toDraft(spec, storedLabels, byId.get(String(spec?.id || '')) || null));
}

export function nextColumnKey(draft) {
    const used = new Set(draft.columns.map(c => c.key));
    let n = 1;
    while (used.has(`custom_${n}`)) n++;
    return `custom_${n}`;
}

export function newColumn(draft, label = '') {
    return { uid: uid('c'), key: nextColumnKey(draft), label, hint: '', originalHint: '', usesDefaultHint: false, required: false, locked: false, isNew: true };
}

export function newTypeDraft(existingDrafts) {
    const used = new Set(existingDrafts.map(d => d.id));
    let n = 1;
    while (used.has(`custom_${n}`)) n++;
    const id = `custom_${n}`;
    const raw = {
        id,
        label: '',
        tableName: `custom_table_${n}`,
        tableColumns: ['title'],
        level: 'semantic',
        extractHint: '',
        extractionInstructions: '',
        extractEveryN: 1,
        keywords: [],
        columnHints: { title: i18n('Name') },
        requiredColumns: ['title'],
        forceUpdate: false,
        editable: true,
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['title'],
        compression: { mode: 'none', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0, summarizeInstruction: '' },
    };
    const draft = toDraft(raw);
    draft.isNew = true;
    draft.name = '';
    draft.columns[0].label = i18n('Name');
    draft.columns[0].hint = '';
    return draft;
}

/** Converts a draft back into a memory-graph type spec (unexposed fields kept). */
export function fromDraft(draft) {
    const raw = clone(draft.raw || {});
    const keys = draft.columns.map(c => c.key);
    const keySet = new Set(keys);
    const originalKeys = new Set(list(raw.tableColumns));
    raw.id = draft.id;
    raw.label = draft.name.trim();
    raw.extractHint = draft.intro.trim() || (draft.usesDefaultIntro ? draft.originalIntro : '');
    raw.tableColumns = keys;
    raw.columnHints = Object.fromEntries(draft.columns
        .map(c => [c.key, c.hint.trim() || (c.usesDefaultHint ? c.originalHint : '') || c.label.trim()])
        .filter(([, value]) => value));
    raw.requiredColumns = draft.columns.filter(c => c.required || c.locked).map(c => c.key);

    const previousSearch = Array.isArray(raw.embeddingColumns) ? list(raw.embeddingColumns).filter(k => keySet.has(k)) : null;
    raw.embeddingColumns = previousSearch
        ? [...previousSearch, ...keys.filter(k => !originalKeys.has(k) && !previousSearch.includes(k))]
        : keys.slice();

    raw.alwaysInject = Boolean(draft.alwaysInject);
    raw.latestOnly = Boolean(draft.latestOnly);
    let identity = list(raw.primaryKeyColumns).filter(k => keySet.has(k));
    if (raw.latestOnly && !identity.length) {
        identity = IDENTITY_CANDIDATES.filter(k => keySet.has(k));
        if (!identity.length && keys.length) identity = [keys[0]];
    }
    raw.primaryKeyColumns = identity;
    raw.compression = { ...(raw.compression || {}), mode: draft.compression ? 'hierarchical' : 'none' };
    return raw;
}

/** Column labels that differ from what would be derived automatically. */
export function labelsFromDrafts(drafts) {
    const out = {};
    for (const draft of drafts) {
        for (const column of draft.columns) {
            const label = column.label.trim();
            if (!label) continue;
            const storedHint = column.hint.trim() || (column.usesDefaultHint ? column.originalHint : '') || label;
            const auto = columnDisplayName(draft.id, column.key, storedHint, {});
            if (label !== auto) (out[draft.id] ||= {})[column.key] = label;
        }
    }
    return out;
}

export function validateDrafts(drafts) {
    const errors = [];
    if (!drafts.length) errors.push({ uid: '', message: i18n('At least one memory type is required') });
    for (const draft of drafts) {
        const typeName = draft.name.trim();
        if (!typeName) errors.push({ uid: draft.uid, field: 'name', message: i18n('A memory type has no name') });
        if (!draft.columns.length) errors.push({ uid: draft.uid, message: i18nFormat('"${0}" needs at least one record item', typeName || i18n('Unnamed')) });
        const seen = new Set();
        for (const column of draft.columns) {
            const label = column.label.trim();
            // Existing items whose name couldn't be derived may stay unnamed; new ones need a name.
            if (!label && column.isNew) errors.push({ uid: draft.uid, column: column.uid, message: i18nFormat('"${0}" has a record item without a name', typeName || i18n('Unnamed')) });
            else if (!label) continue;
            else if (seen.has(label)) errors.push({ uid: draft.uid, column: column.uid, message: i18nFormat('"${0}" has two items both named "${1}"', typeName || i18n('Unnamed'), label) });
            seen.add(label);
        }
    }
    return errors;
}

const FLAG_TEXT = {
    alwaysInject: [i18n('Turn on "Always visible to the AI"'), i18n('Turn off "Always visible to the AI"')],
    latestOnly: [i18n('Turn on "Keep only the latest per name"'), i18n('Turn off "Keep only the latest per name"')],
    compression: [i18n('Turn on "Merge into summaries automatically"'), i18n('Turn off "Merge into summaries automatically"')],
};

/**
 * Human-readable change list.
 * @returns {{ name: string, kind: 'added'|'removed'|'changed', lines: string[] }[]}
 */
export function describeChanges(beforeDrafts, afterDrafts, nodeCounts = new Map()) {
    const before = new Map(beforeDrafts.map(d => [d.id, d]));
    const after = new Map(afterDrafts.map(d => [d.id, d]));
    const out = [];
    for (const draft of afterDrafts) {
        const prev = before.get(draft.id);
        if (!prev) {
            out.push({ name: draft.name.trim(), kind: 'added', lines: [i18nFormat('New type with ${0} record items', draft.columns.length)] });
            continue;
        }
        const lines = [];
        if (prev.name.trim() !== draft.name.trim()) lines.push(i18nFormat('Renamed to "${0}"', draft.name.trim()));
        if (prev.intro.trim() !== draft.intro.trim()) lines.push(i18n('Introduction changed'));
        const prevCols = new Map(prev.columns.map(c => [c.key, c]));
        const nextCols = new Map(draft.columns.map(c => [c.key, c]));
        const added = draft.columns.filter(c => !prevCols.has(c.key));
        const removed = prev.columns.filter(c => !nextCols.has(c.key));
        const named = (c) => c.label.trim() || UNNAMED;
        if (added.length) lines.push(i18nFormat('Added ${0} items: ${1}', added.length, added.map(named).join(listSeparator())));
        if (removed.length) lines.push(i18nFormat('Removed ${0} items: ${1} (existing content stays stored but is no longer shown or recorded)', removed.length, removed.map(named).join(listSeparator())));
        let renamed = 0;
        let hinted = 0;
        let requiredChanged = 0;
        for (const column of draft.columns) {
            const old = prevCols.get(column.key);
            if (!old) continue;
            if (old.label.trim() !== column.label.trim()) renamed++;
            if (old.hint.trim() !== column.hint.trim()) hinted++;
            if (Boolean(old.required) !== Boolean(column.required)) requiredChanged++;
        }
        if (renamed) lines.push(i18nFormat('${0} items renamed', renamed));
        if (hinted) lines.push(i18nFormat('${0} item descriptions changed', hinted));
        if (requiredChanged) lines.push(i18nFormat('${0} items changed "Must be filled in"', requiredChanged));
        const kept = draft.columns.filter(c => prevCols.has(c.key)).map(c => c.key).join('|');
        const keptBefore = prev.columns.filter(c => nextCols.has(c.key)).map(c => c.key).join('|');
        if (kept !== keptBefore) lines.push(i18n('Record items reordered'));
        for (const flag of Object.keys(FLAG_TEXT)) {
            if (Boolean(prev[flag]) !== Boolean(draft[flag])) lines.push(FLAG_TEXT[flag][draft[flag] ? 0 : 1]);
        }
        if (lines.length) out.push({ name: prev.name.trim(), kind: 'changed', lines });
    }
    for (const prev of beforeDrafts) {
        if (after.has(prev.id)) continue;
        const count = nodeCounts.get(prev.id) || 0;
        out.push({ name: prev.name.trim(), kind: 'removed', lines: [count ? i18nFormat('Delete this type (the current chat has ${0}; they stay stored but are no longer shown or recorded)', count) : i18n('Delete this type')] });
    }
    const keptOrder = (drafts) => drafts.filter(d => before.has(d.id) && after.has(d.id)).map(d => d.id).join('|');
    if (keptOrder(afterDrafts) !== keptOrder(beforeDrafts)) {
        out.push({ name: i18n('Type order'), kind: 'changed', lines: [i18n('Memory types reordered')] });
    }
    return out;
}

export function draftsEqual(a, b) {
    return JSON.stringify(a.map(fromDraft)) === JSON.stringify(b.map(fromDraft))
        && JSON.stringify(labelsFromDrafts(a)) === JSON.stringify(labelsFromDrafts(b));
}

export function cloneDrafts(drafts) {
    return drafts.map(d => ({ ...d, raw: clone(d.raw), columns: d.columns.map(c => ({ ...c })) }));
}
