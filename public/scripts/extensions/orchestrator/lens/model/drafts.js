// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unsaved agent edits (by hand or applied from the AI). Kept as a change
// list against the stored profile, not as a whole copy, so a reload of the
// stored profile (native editor saved something else) keeps both: the
// draft = stored profile + our changes. Pure: no DOM.

import { applyChanges, getField, agentFields } from './edit.js';

const keyOf = (agentId, field) => `${agentId}.${field}`;
export const targetKey = (t) => (t ? [t.mode, t.scope, t.presetId, t.scope === 'character' ? t.avatar : '', t.scope === 'chat' ? t.chatKey : ''].join('|') : '');

export function createDrafts() {
    let target = null;
    let base = null; // stored profile for `target`
    const changes = new Map(); // key → { id, agentId, field, before, after, by: 'hand'|'ai' }
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());

    function put(agentId, field, value, by) {
        const key = keyOf(agentId, field);
        const before = getField(target.mode, base, agentId, field);
        if (String(value) === before) changes.delete(key);
        else changes.set(key, { id: key, agentId, field, before, after: String(value), by });
    }

    return {
        /** New stored profile from a reload. Changes for another target are kept (see isCurrent). */
        setBase(nextTarget, profile) {
            if (!changes.size || targetKey(nextTarget) === targetKey(target)) {
                target = nextTarget;
                base = profile;
                // Drop changes the stored profile already has (saved, or made the same elsewhere).
                for (const [key, c] of [...changes]) {
                    if (!agentFields(target.mode, base, c.agentId).includes(c.field)) { changes.delete(key); continue; }
                    const now = getField(target.mode, base, c.agentId, c.field);
                    if (now === c.after) changes.delete(key);
                    else c.before = now;
                }
                emit();
            }
        },
        target: () => target,
        isCurrent: (t) => targetKey(t) === targetKey(target),
        /** Stored profile with the unsaved changes on top. */
        profile: () => (target && changes.size ? applyChanges(target.mode, base, [...changes.values()]) : base),
        base: () => base,
        get(agentId, field) {
            const c = changes.get(keyOf(agentId, field));
            return c ? c.after : getField(target?.mode, base, agentId, field);
        },
        changeFor: (agentId, field) => changes.get(keyOf(agentId, field)) || null,
        set(agentId, field, value, { by = 'hand' } = {}) {
            if (!target) return;
            put(agentId, field, value, by);
            emit();
        },
        /** Several changes at once ({agentId, field, after}). Returns a snapshot to undo with restore(). */
        applyMany(list, { by = 'ai' } = {}) {
            const snap = this.snapshot();
            for (const c of list) put(c.agentId, c.field, c.after, by);
            emit();
            return snap;
        },
        list: () => [...changes.values()],
        count: () => changes.size,
        touched: () => new Set([...changes.values()].filter(c => c.by === 'hand').map(c => c.id)),
        snapshot: () => [...changes.entries()].map(([k, v]) => [k, { ...v }]),
        restore(snap) {
            changes.clear();
            for (const [k, v] of snap || []) changes.set(k, { ...v });
            emit();
        },
        discard() {
            changes.clear();
            emit();
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
