// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The change list works the same for all four workbenches: each adapter
// cuts its working copy into "units" (a memory type, a preset entry, a card
// field, one agent's field …) with a readable text form. A change is a unit
// whose text differs between the saved copy and the AI's copy; the user
// accepts changes one by one, and the adapter rebuilds the object from the
// accepted units. Pure: no DOM.

import { i18nFormat } from '../i18n.js';
import { differingFields } from './patch.js';

/**
 * @typedef {{ key: string, label: string, group?: string, text: string, raw?: any, fields?: object, hidden?: object }} Unit
 * @typedef {{ key: string, kind: 'add'|'remove'|'change', label: string, group: string, before: string, after: string, sig: string }} Change
 */

const hash = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
};

// Field changes the unit's text cannot show are listed under it, so nothing
// is written that the user did not see.
const withHidden = (text, hidden, names) => [text, ...names.map(name => `· ${name}: ${JSON.stringify(hidden?.[name] ?? null)}`)].filter(Boolean).join('\n');

function change(kind, unit, group, before, after) {
    return { key: unit.key, kind, label: unit.label, group, before, after, sig: hash(`${kind}\0${before}\0${after}`) };
}

/** @param {Map<string, Unit>} before  @param {Map<string, Unit>} after */
export function diffUnits(before, after) {
    const out = [];
    for (const [key, unit] of after) {
        const prev = before.get(key);
        if (!prev) { out.push(change('add', unit, unit.group || '', '', unit.text)); continue; }
        const names = differingFields(prev.hidden, unit.hidden);
        if (prev.text !== unit.text || names.length) out.push(change('change', unit, unit.group || prev.group || '', withHidden(prev.text, prev.hidden, names), withHidden(unit.text, unit.hidden, names)));
    }
    for (const [key, unit] of before) {
        if (!after.has(key)) out.push(change('remove', unit, unit.group || '', unit.text, ''));
    }
    return out;
}

/**
 * Line diff (LCS) for the before/after view; returns rows of
 * { type: 'same'|'del'|'add', text }. Long unchanged runs are folded.
 */
export function lineDiff(a, b, { context = 2 } = {}) {
    const x = String(a || '').split('\n');
    const y = String(b || '').split('\n');
    if (x.length * y.length > 250000) {
        return [...x.map(text => ({ type: 'del', text })), ...y.map(text => ({ type: 'add', text }))];
    }
    const m = x.length;
    const n = y.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (x[i] === y[j]) { rows.push({ type: 'same', text: x[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ type: 'del', text: x[i++] });
        else rows.push({ type: 'add', text: y[j++] });
    }
    while (i < m) rows.push({ type: 'del', text: x[i++] });
    while (j < n) rows.push({ type: 'add', text: y[j++] });
    // Fold long unchanged stretches.
    const keep = rows.map((r, k) => r.type !== 'same' || rows.slice(Math.max(0, k - context), k + context + 1).some(o => o.type !== 'same'));
    const out = [];
    let skipped = 0;
    rows.forEach((r, k) => {
        if (keep[k]) {
            if (skipped) { out.push({ type: 'fold', text: i18nFormat('…… ${0} unchanged lines', skipped) }); skipped = 0; }
            out.push(r);
        } else skipped++;
    });
    if (skipped) out.push({ type: 'fold', text: i18nFormat('…… ${0} unchanged lines', skipped) });
    return out;
}

/** Within one changed line: common prefix / suffix, for highlighting. */
export function inlineMarks(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    let p = 0;
    while (p < s.length && p < t.length && s[p] === t[p]) p++;
    let q = 0;
    while (q < s.length - p && q < t.length - p && s[s.length - 1 - q] === t[t.length - 1 - q]) q++;
    return { prefix: p, suffix: q };
}

/** Whether the draft still produces exactly what the user approved for these keys. */
export function approvalMatches(shown, current, keys) {
    const now = new Map(current.map(c => [c.key, c]));
    return (shown || []).filter(c => keys.includes(c.key)).every((c) => {
        const cur = now.get(c.key);
        if (!cur || cur.kind !== c.kind) return false;
        // Stored changes may be shortened to fit the session cap; the signature covers the full text.
        return c.sig && cur.sig ? c.sig === cur.sig : cur.before === c.before && cur.after === c.after;
    });
}

export function changeSummary(changes) {
    const add = changes.filter(c => c.kind === 'add').length;
    const del = changes.filter(c => c.kind === 'remove').length;
    const mod = changes.length - add - del;
    return [mod ? i18nFormat('${0} edited', mod) : '', add ? i18nFormat('${0} added', add) : '', del ? i18nFormat('${0} removed', del) : ''].filter(Boolean).join(' · ');
}
