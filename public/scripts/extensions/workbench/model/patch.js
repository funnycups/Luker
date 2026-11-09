// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one rule every Workbench write and undo follows. Data is cut into units
// (see units.js), each carrying `fields`, a flat record of field -> value.
//   plan    what changed between the proposal baseline and the proposal
//   merge   lay the plan on freshly read data; a field someone else changed
//           makes its whole unit a conflict
//   undo    the same merge with the written fields reversed
// Reading, applying and saving are supplied by the caller.

import { i18n, i18nFormat } from '../i18n.js';
import { SourceError } from './errors.js';

const canon = (value) => JSON.stringify(value ?? null, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
export const same = (a, b) => canon(a) === canon(b);
export const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** @typedef {{ field: string, before: any, after: any }} FieldChange */
/** @typedef {{ key: string, kind: 'add'|'remove'|'change', changes: FieldChange[] }} Op */

/** Names of the fields that differ between two records. */
export function differingFields(a, b) {
    return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(name => !same(a?.[name], b?.[name]));
}

/**
 * The field changes in the accepted units.
 * @returns {Op[]}
 */
export function fieldPlan(baseUnits, nextUnits, keys) {
    const ops = [];
    for (const key of keys) {
        const before = baseUnits.get(key)?.fields;
        const after = nextUnits.get(key)?.fields;
        if (!before && !after) continue;
        const changes = differingFields(before, after).map(field => ({ field, before: clone(before?.[field]), after: clone(after?.[field]) }));
        if (before && after && !changes.length) continue;
        ops.push({ key, kind: !before ? 'add' : !after ? 'remove' : 'change', changes });
    }
    return ops;
}

/**
 * Sorts a plan against current data.
 * @returns {{ write: Op[], already: Op[], skipped: { key: string, reason: string }[] }}
 */
export function mergeOps(currentUnits, ops) {
    const write = [];
    const already = [];
    const skipped = [];
    const conflict = (op) => skipped.push({ key: op.key, reason: 'changed-elsewhere' });
    for (const op of ops) {
        const now = currentUnits.get(op.key)?.fields;
        if (op.kind === 'add' || op.kind === 'remove') {
            const expected = Object.fromEntries(op.changes.map(c => [c.field, op.kind === 'add' ? c.after : c.before]));
            if (op.kind === 'add' && now) { if (same(now, expected)) already.push(op); else conflict(op); continue; }
            if (op.kind === 'remove' && !now) { already.push(op); continue; }
            if (op.kind === 'remove' && !same(now, expected)) { conflict(op); continue; }
            write.push(op);
            continue;
        }
        if (!now) { conflict(op); continue; }
        if (op.changes.some(c => !same(now[c.field], c.before) && !same(now[c.field], c.after))) { conflict(op); continue; }
        const pending = op.changes.filter(c => !same(now[c.field], c.after));
        if (pending.length) write.push({ ...op, changes: pending });
        else already.push(op);
    }
    return { write, already, skipped };
}

const REVERSE_KIND = { add: 'remove', remove: 'add', change: 'change' };

/** The plan that takes back exactly what `ops` wrote. */
export const reverseOps = (ops) => [...ops].reverse().map(op => ({ key: op.key, kind: REVERSE_KIND[op.kind], changes: op.changes.map(c => ({ field: c.field, before: c.after, after: c.before })) }));

export const conflictsLeftAlone = (count) => new SourceError('conflict', i18nFormat('${0} places were changed after this edit and were left alone; everything else was undone.', count));

/**
 * Merges a plan onto freshly read data and saves it.
 * `read` throws or returns null when the target cannot be read; nothing is
 * written then. `write(next, { undoing })` throws when the save fails.
 * @param {{ read: () => Promise<any>, units: (data: any) => Map, apply: (data: any, ops: Op[]) => any, write: (next: any, info: { undoing: boolean }) => Promise<void> }} io
 * @param {Op[]} ops
 */
export async function writeFields({ read, units, apply, write }, ops) {
    const readOrStop = async () => {
        const data = await read();
        if (data === null || data === undefined) throw new SourceError('read-failed', i18n('The saved data could not be read, so nothing was changed'));
        return data;
    };
    const current = await readOrStop();
    const merged = mergeOps(units(current), ops);
    if (merged.write.length) await write(apply(current, merged.write), { undoing: false });
    return {
        applied: [...merged.write, ...merged.already].map(op => op.key),
        skipped: merged.skipped,
        written: merged.write,
        /** Reverses what was written; resolves to the number of conflicts. */
        async revert() {
            if (!merged.write.length) return 0;
            const now = await readOrStop();
            const back = mergeOps(units(now), reverseOps(merged.write));
            if (back.write.length) await write(apply(now, back.write), { undoing: true });
            return back.skipped.length;
        },
    };
}

/** Throws when a whole batch conflicted, so the page reports no success. */
export function requireApplied({ applied, skipped }) {
    if (!applied.length && skipped.length) throw new SourceError('conflict', i18nFormat('${0} changes conflict with edits made elsewhere, so nothing was saved. Reopen the chat.', skipped.length));
}

/** writeFields for a single target: the shape adapters hand back to the page. */
export async function commitFields(io, ops) {
    const result = await writeFields(io, ops);
    requireApplied(result);
    return {
        applied: result.applied,
        skipped: result.skipped,
        failure: '',
        async undo() {
            const conflicts = await result.revert();
            if (conflicts) throw conflictsLeftAlone(conflicts);
        },
    };
}

/**
 * Saves settings and reports whether the save really happened: Luker's
 * saveSettings catches its own failures, and fires this event only on success.
 */
export async function saveSettingsChecked(ctx) {
    let saved = false;
    const type = ctx.eventTypes.SETTINGS_UPDATED;
    const handler = () => { saved = true; };
    ctx.eventSource.on(type, handler);
    try {
        await ctx.saveSettings();
    } finally {
        ctx.eventSource.removeListener(type, handler);
    }
    if (!saved) throw new SourceError('write-failed', i18n('Failed to save the settings'));
}
