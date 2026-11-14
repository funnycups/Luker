// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Item-level changes between two memory-graph type lists, in plain words,
// and a way to apply any chosen subset of them. Used by the AI assistant and
// the improve-this-type flow so the user reviews *what* changed (an item added, a
// hint rewritten, a switch flipped), never JSON.
//
// A change carries enough to be applied on its own onto the current drafts'
// specs: { id, typeId, kind, ... }. Column keys never change, so changes to
// different items commute.

import { typeDisplayName, columnDisplayName, UNNAMED } from '../schema/schema-model.js';
import { i18n, i18nFormat } from '../i18n.js';

const quoted = (name) => i18nFormat('"${0}"', name);

const FLAGS = {
    alwaysInject: i18n('Always visible to the AI'),
    latestOnly: i18n('Keep only the latest per name'),
    compression: i18n('Merge into summaries automatically'),
};

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const list = (v) => (Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : []);
const flagValue = (spec, flag) => (flag === 'compression' ? String(spec?.compression?.mode || 'none') === 'hierarchical' : Boolean(spec?.[flag]));
const hintOf = (spec, key) => String(spec?.columnHints?.[key] || '').trim();
const colName = (spec, key, labels) => columnDisplayName(spec.id, key, hintOf(spec, key), labels) || UNNAMED;

/**
 * @param {object[]} before type specs
 * @param {object[]} after type specs
 * @param {object} labels user column labels { typeId: { key: label } } (after state)
 * @returns {object[]} changes, grouped by type in `after` order, removed types last
 */
export function diffSchemas(before, after, labels = {}) {
    const prev = new Map((before || []).map(s => [String(s.id), s]));
    const next = new Map((after || []).map(s => [String(s.id), s]));
    const out = [];
    let n = 0;
    const push = (change) => out.push({ id: `c${++n}`, ...change });

    for (const spec of after || []) {
        const typeId = String(spec.id);
        const old = prev.get(typeId);
        const typeName = typeDisplayName(spec);
        if (!old) {
            const cols = list(spec.tableColumns);
            push({
                typeId, typeName, kind: 'addType', spec: clone(spec),
                text: i18nFormat('New type "${0}"', typeName),
                target: quoted(typeName),
                detail: cols.map(k => hintOf(spec, k) ? i18nFormat('${0}: ${1}', colName(spec, k, labels), hintOf(spec, k)) : colName(spec, k, labels)),
            });
            continue;
        }
        if (typeDisplayName(old) !== typeName) {
            push({ typeId, typeName, kind: 'renameType', label: spec.label, text: i18nFormat('Type "${0}" renamed to "${1}"', typeDisplayName(old), typeName) });
        }
        if (String(old.extractHint || '').trim() !== String(spec.extractHint || '').trim()) {
            push({ typeId, typeName, kind: 'intro', value: String(spec.extractHint || ''), text: i18nFormat('Type description of "${0}" changed', typeName), before: String(old.extractHint || ''), after: String(spec.extractHint || '') });
        }
        const oldCols = list(old.tableColumns);
        const newCols = list(spec.tableColumns);
        const oldSet = new Set(oldCols);
        const newSet = new Set(newCols);
        for (const key of newCols) {
            const name = colName(spec, key, labels);
            if (!oldSet.has(key)) {
                push({
                    typeId, typeName, kind: 'addColumn', key, index: newCols.indexOf(key),
                    hint: hintOf(spec, key), required: list(spec.requiredColumns).includes(key),
                    text: i18nFormat('New record item "${0}"', name), target: quoted(name), after: hintOf(spec, key),
                });
                continue;
            }
            // A name derived from the hint changes with it; only report explicit renames.
            const oldName = colName(old, key, labels);
            const explicit = Boolean(labels?.[typeId]?.[key]);
            if (oldName !== name && (explicit || hintOf(old, key) === hintOf(spec, key))) {
                push({ typeId, typeName, kind: 'renameColumn', key, label: name, text: i18nFormat('"${0}" renamed to "${1}"', oldName, name) });
            }
            if (hintOf(old, key) !== hintOf(spec, key)) {
                push({ typeId, typeName, kind: 'hint', key, value: hintOf(spec, key), text: i18nFormat('Prompt of "${0}" changed', name), before: hintOf(old, key), after: hintOf(spec, key) });
            }
            const wasReq = list(old.requiredColumns).includes(key);
            const isReq = list(spec.requiredColumns).includes(key);
            if (wasReq !== isReq) push({ typeId, typeName, kind: 'required', key, value: isReq, text: i18nFormat(isReq ? '"${0}" is now required' : '"${0}" is now optional', name) });
        }
        for (const key of oldCols) {
            if (!newSet.has(key)) push({ typeId, typeName, kind: 'removeColumn', key, text: i18nFormat('Remove record item "${0}"', colName(old, key, labels)), target: quoted(colName(old, key, labels)) });
        }
        const keptOld = oldCols.filter(k => newSet.has(k)).join('|');
        const keptNew = newCols.filter(k => oldSet.has(k)).join('|');
        if (keptOld !== keptNew) push({ typeId, typeName, kind: 'order', order: newCols, text: i18nFormat('Record items of "${0}" reordered', typeName) });
        for (const flag of Object.keys(FLAGS)) {
            const a = flagValue(old, flag);
            const b = flagValue(spec, flag);
            if (a !== b) push({ typeId, typeName, kind: 'flag', flag, value: b, text: i18nFormat(b ? '"${0}" turned on "${1}"' : '"${0}" turned off "${1}"', typeName, FLAGS[flag]) });
        }
    }
    for (const spec of before || []) {
        if (!next.has(String(spec.id))) {
            push({ typeId: String(spec.id), typeName: typeDisplayName(spec), kind: 'removeType', text: i18nFormat('Delete type "${0}"', typeDisplayName(spec)), target: quoted(typeDisplayName(spec)) });
        }
    }
    const order = (specs) => (specs || []).map(s => String(s.id)).filter(id => prev.has(id) && next.has(id)).join('|');
    if (order(before) !== order(after)) push({ typeId: '', typeName: '', kind: 'typeOrder', order: (after || []).map(s => String(s.id)), text: i18n('Memory types reordered') });
    return out;
}

/**
 * Applies chosen changes onto `specs` (a copy is returned).
 * @returns {{ specs: object[], labels: object }} labels: column renames to store
 */
export function applyChanges(specs, changes) {
    const out = clone(specs || []);
    const labels = {};
    const byId = () => new Map(out.map(s => [String(s.id), s]));
    for (const change of changes) {
        const map = byId();
        const spec = map.get(change.typeId);
        switch (change.kind) {
            case 'addType':
                if (!map.has(change.typeId)) out.push(clone(change.spec));
                break;
            case 'removeType': {
                const i = out.findIndex(s => String(s.id) === change.typeId);
                if (i >= 0) out.splice(i, 1);
                break;
            }
            case 'typeOrder':
                out.sort((a, b) => indexIn(change.order, a.id) - indexIn(change.order, b.id));
                break;
            default:
                if (spec) applyToSpec(spec, change, labels);
        }
    }
    return { specs: out, labels };
}

function indexIn(order, id) {
    const i = order.indexOf(String(id));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function applyToSpec(spec, change, labels) {
    spec.tableColumns = list(spec.tableColumns);
    spec.columnHints = { ...(spec.columnHints || {}) };
    spec.requiredColumns = list(spec.requiredColumns);
    switch (change.kind) {
        case 'renameType': spec.label = change.label; break;
        case 'intro': spec.extractHint = change.value; break;
        case 'addColumn':
            if (!spec.tableColumns.includes(change.key)) {
                spec.tableColumns.splice(Math.min(change.index ?? spec.tableColumns.length, spec.tableColumns.length), 0, change.key);
                if (Array.isArray(spec.embeddingColumns) && !spec.embeddingColumns.includes(change.key)) spec.embeddingColumns.push(change.key);
            }
            if (change.hint) spec.columnHints[change.key] = change.hint;
            if (change.required && !spec.requiredColumns.includes(change.key)) spec.requiredColumns.push(change.key);
            break;
        case 'removeColumn':
            spec.tableColumns = spec.tableColumns.filter(k => k !== change.key);
            spec.requiredColumns = spec.requiredColumns.filter(k => k !== change.key);
            delete spec.columnHints[change.key];
            break;
        case 'renameColumn': (labels[spec.id] ||= {})[change.key] = change.label; break;
        case 'hint':
            if (change.value) spec.columnHints[change.key] = change.value;
            else delete spec.columnHints[change.key];
            break;
        case 'required':
            spec.requiredColumns = change.value
                ? [...new Set([...spec.requiredColumns, change.key])]
                : spec.requiredColumns.filter(k => k !== change.key);
            break;
        case 'order':
            spec.tableColumns.sort((a, b) => indexIn(change.order, a) - indexIn(change.order, b));
            break;
        case 'flag':
            if (change.flag === 'compression') spec.compression = { ...(spec.compression || {}), mode: change.value ? 'hierarchical' : 'none' };
            else spec[change.flag] = Boolean(change.value);
            break;
        default: break;
    }
}

/** Key that identifies what a change touches, for staleness checks. */
export function changeTarget(change) {
    if (change.kind === 'typeOrder') return 'types';
    if (change.key) return `${change.typeId}:${change.key}`;
    return `${change.typeId}:${change.kind === 'flag' ? change.flag : change.kind}`;
}

/** Marks for the editor: { typeId: { count, columns: { key: 'added'|'changed' } } } */
export function changeMarks(changes) {
    const marks = {};
    for (const change of changes) {
        if (!change.typeId) continue;
        const m = (marks[change.typeId] ||= { count: 0, columns: {}, added: false });
        m.count++;
        if (change.kind === 'addType') m.added = true;
        if (change.key) m.columns[change.key] = change.kind === 'addColumn' ? 'added' : (m.columns[change.key] || 'changed');
    }
    return marks;
}
