// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unsaved agent edits (by hand or applied from the AI). Kept as a change
// list against the stored profile, not as a whole copy, so a reload of the
// stored profile (something else saved) keeps both: the
// draft = stored profile + our changes. Pure: no DOM.

import { applyChanges, canHold, diffProfiles, getField, PROFILE } from './edit.js';

const keyOf = (agentId, field) => `${agentId}.${field}`;
export const targetKey = (t) => (t ? [t.mode, t.scope, t.presetId, t.scope === 'character' ? t.avatar : '', t.scope === 'chat' ? t.chatKey : ''].join('|') : '');

export function createDrafts() {
    const slots = new Map(); // targetKey → { target, base, changes: Map<key, change> }
    let currentKey = '';
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());

    const current = () => (currentKey ? slots.get(currentKey) || null : null);

    function ensureSlot(t, profile = null) {
        const k = targetKey(t);
        let slot = slots.get(k);
        if (!slot) {
            slot = { target: t, base: profile, changes: new Map() };
            slots.set(k, slot);
        } else {
            slot.target = t;
            if (profile !== null) slot.base = profile;
        }
        return slot;
    }

    function putIn(slot, agentId, field, value, by) {
        const key = keyOf(agentId, field);
        const before = slot.changes.get(key)?.before ?? getField(slot.target.mode, slot.base, agentId, field);
        if (String(value) === before) slot.changes.delete(key);
        else slot.changes.set(key, { id: key, agentId, field, before, after: String(value), by });
    }

    function pruneEmptyNonCurrent() {
        for (const [k, slot] of [...slots]) {
            if (k !== currentKey && slot.changes.size === 0) slots.delete(k);
        }
    }

    return {
        /** New stored profile from a reload. Each target keeps its own unsaved changes. */
        setBase(nextTarget, profile) {
            if (!nextTarget) {
                currentKey = '';
                pruneEmptyNonCurrent();
                emit();
                return;
            }
            const k = targetKey(nextTarget);
            currentKey = k;
            const slot = ensureSlot(nextTarget, profile);
            // Drop changes the stored profile already has (saved, or made the same elsewhere).
            const withSlots = applyChanges(slot.target.mode, slot.base, [...slot.changes.values()].filter(c => c.agentId === PROFILE));
            for (const [key, c] of [...slot.changes]) {
                if (!canHold(slot.target.mode, withSlots, c.agentId, c.field)) { slot.changes.delete(key); continue; }
                const now = getField(slot.target.mode, slot.base, c.agentId, c.field);
                if (now === c.after) slot.changes.delete(key);
            }
            pruneEmptyNonCurrent();
            emit();
        },
        target: () => current()?.target || null,
        isCurrent: (t) => Boolean(currentKey) && targetKey(t) === currentKey,
        /** Stored profile with the unsaved changes on top. */
        profile() {
            const slot = current();
            if (!slot) return null;
            return slot.changes.size ? applyChanges(slot.target.mode, slot.base, [...slot.changes.values()]) : slot.base;
        },
        base: () => current()?.base ?? null,
        get(agentId, field) {
            const slot = current();
            if (!slot) return '';
            const c = slot.changes.get(keyOf(agentId, field));
            return c ? c.after : getField(slot.target.mode, this.profile(), agentId, field);
        },
        changeFor: (agentId, field) => current()?.changes.get(keyOf(agentId, field)) || null,
        set(agentId, field, value, { by = 'hand' } = {}) {
            const slot = current();
            if (!slot) return;
            putIn(slot, agentId, field, value, by);
            emit();
        },
        /** Makes the draft equal `next` (a whole profile from a structural operation). */
        setProfile(next, { by = 'hand' } = {}) {
            const slot = current();
            if (!slot) return;
            const previous = new Map(slot.changes);
            slot.changes.clear();
            for (const c of diffProfiles(slot.target.mode, slot.base, next)) {
                const key = keyOf(c.agentId, c.field);
                const prior = previous.get(key);
                slot.changes.set(key, { ...c, before: prior?.before ?? c.before, by: prior?.by || by });
            }
            emit();
        },
        /** Several changes at once ({agentId, field, after}). Returns a snapshot to undo with restore(). */
        applyMany(list, { by = 'ai' } = {}) {
            const slot = current();
            const snap = this.snapshot();
            if (!slot) return snap;
            for (const c of list) putIn(slot, c.agentId, c.field, c.after, by);
            emit();
            return snap;
        },
        /** Clears only changes matching the saved payload, preserving later edits made while saving. */
        acknowledgeSaved(savedTarget, savedChanges = []) {
            const k = targetKey(savedTarget);
            const slot = k ? slots.get(k) : null;
            if (!slot) return;
            for (const saved of savedChanges) {
                const key = saved.id || keyOf(saved.agentId, saved.field);
                const existing = slot.changes.get(key);
                if (!existing) continue;
                if (existing.after === saved.after) {
                    slot.changes.delete(key);
                } else {
                    slot.changes.set(key, { ...existing, before: saved.after });
                }
            }
            pruneEmptyNonCurrent();
            emit();
        },
        list: () => [...(current()?.changes.values() || [])],
        count: () => current()?.changes.size || 0,
        foreignCount() {
            let total = 0;
            for (const [k, slot] of slots) {
                if (k !== currentKey) total += slot.changes.size;
            }
            return total;
        },
        totalCount() {
            return this.count() + this.foreignCount();
        },
        touched: () => new Set([...(current()?.changes.values() || [])].filter(c => c.by === 'hand').map(c => c.id)),
        snapshot: () => [...(current()?.changes.entries() || [])].map(([k, v]) => [k, { ...v }]),
        restore(snap) {
            const slot = current();
            if (!slot) return;
            slot.changes.clear();
            for (const [k, v] of snap || []) slot.changes.set(k, { ...v });
            emit();
        },
        discard() {
            const slot = current();
            if (!slot) return;
            slot.changes.clear();
            emit();
        },
        discardTarget(t) {
            const k = targetKey(t);
            const slot = k ? slots.get(k) : null;
            if (!slot) return;
            slot.changes.clear();
            pruneEmptyNonCurrent();
            emit();
        },
        discardForeign() {
            for (const k of [...slots.keys()]) {
                if (k !== currentKey) slots.delete(k);
            }
            emit();
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
