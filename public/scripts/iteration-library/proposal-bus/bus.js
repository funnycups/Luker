// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * ProposalBus core. Owns the entry store, status state machine, gate
 * predicate, outcome queue, and persistence wire-up. UI rendering and
 * event routing live in sibling modules and are wired into the same
 * bus instance via the public factory in index.js.
 *
 * Per-popup lifecycle: one bus per popup mount. Kinds register up front;
 * propose / approve / reject / rollback are the only public mutation
 * entry points. onChange fires after every mutation so the popup can
 * re-render off a single source of truth.
 *
 * Payload model: each entry stores the RFC 6902 inverse patch
 * `compare(after, before)` for its turn. Live read/write is routed
 * through the target-registry handler (target.type → {read, write,
 * describe}); the bus never touches popup-specific persistence.
 *
 * Drift detection is path-overlap based: at approve/rollback time the
 * current value at every path the patch touches must match the
 * propose-time before (for approve) or commit-time after (for
 * rollback). Mismatch parks the entry in status='conflict' and emits
 * `bus:rollback-failed` for rollback; the user resolves manually
 * (re-approving rolls the drift check again).
 */

function makeId(kindId, seq) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${kindId}_${seq}_${rand}`;
}

function makeEntry({ id, kind, target, inverse, after, sourceCallId, meta }) {
    return {
        id,
        kind,
        target,
        inverse,
        _pendingAfter: after,
        sourceCallId: sourceCallId == null ? null : String(sourceCallId),
        status: 'pending',
        meta: meta ?? null,
        createdAt: Date.now(),
        decidedAt: null,
        committedAt: null,
        rolledBackAt: null,
        conflictError: null,
    };
}

import { renderProposalCard } from './render-card.js';
import { renderTurnActions } from './render-turn.js';
import { dispatch as dispatchProposalClick } from './event-router.js';
import { encodeInverse, decodeBackward, deriveForward, applyOps, PatchConflictError } from '../storage/patch-codec.js';
import { resolveTarget } from '../storage/target-registry.js';

export function createBus(opts = {}) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    const kinds = new Map();           // kindId -> handler
    const entries = [];                // ordered, append-only within a session
    const outcomeQueue = [];           // drained by bus.drainOutcomes
    const events = new EventTarget();
    let seq = 0;

    function getHandler(kindId) {
        const h = kinds.get(kindId);
        if (!h) throw new Error(`ProposalBus: unknown kind '${kindId}'`);
        return h;
    }

    function registerKind(kindId, handler) {
        if (kinds.has(kindId)) {
            throw new Error(`ProposalBus: kind '${kindId}' already registered`);
        }
        kinds.set(kindId, handler || {});
    }

    function resolveTargetSafe(target) {
        return resolveTarget(target);
    }

    // RFC 6901 reader; returns undefined on a missing/invalid path so the caller can use
    // deepEqual to distinguish "key absent in both sides" from "value differs"
    function readJsonPointer(doc, pointer) {
        if (pointer === '') return doc;
        if (typeof pointer !== 'string' || pointer.charCodeAt(0) !== 47) return undefined;
        const parts = pointer.slice(1).split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
        let node = doc;
        for (const seg of parts) {
            if (node === null || node === undefined) return undefined;
            if (Array.isArray(node)) {
                if (!/^(0|[1-9][0-9]*)$/.test(seg)) return undefined;
                node = node[Number(seg)];
            } else if (typeof node === 'object') {
                if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
                node = node[seg];
            } else {
                return undefined;
            }
        }
        return node;
    }

    function deepEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || a === undefined || b === undefined) return a === b;
        if (typeof a !== typeof b) return false;
        if (typeof a !== 'object') return false;
        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
            return true;
        }
        if (Array.isArray(b)) return false;
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k])) return false;
        }
        return true;
    }

    async function propose({ kind, target, before, after, sourceCallId = null, meta = null } = {}) {
        const handler = getHandler(kind);
        // Throws UnknownTargetError if not registered; surface early.
        resolveTargetSafe(target);
        if (handler.targetType && target?.type !== handler.targetType) {
            throw new Error(`ProposalBus: kind '${kind}' expects target.type='${handler.targetType}', got '${target?.type}'`);
        }
        const inverse = encodeInverse(before, after);
        seq += 1;
        const entry = makeEntry({
            id: makeId(kind, seq),
            kind,
            target,
            inverse,
            after,
            sourceCallId,
            meta,
        });
        entries.push(entry);
        onChange();
        return { id: entry.id, target };
    }

    function hasOutstanding() {
        // Conflicts are NOT outstanding: a conflict means the bus already
        // tried to commit, found drift, and emitted an outcome for the AI
        // to react to. Blocking the auto-continue loop on conflict would
        // strand the user in front of a card whose only honest resolution
        // is "the disk changed under us, retry from scratch" — the AI
        // sees the conflict in the next round's outcome message and
        // decides whether to re-propose. Pending entries (still awaiting
        // first approve / reject) are the only true gate.
        for (const e of entries) {
            if (e.status === 'pending') return true;
        }
        return false;
    }

    /**
     * Look up the most recent pending entry of `kind` and return its
     * propose-time `after` state. Used by replace-mode kinds when the
     * popup needs to chain proposals before any approve: the next
     * propose() should record the state the live system will be in
     * AFTER prior pending entries commit, not the current live state.
     *
     * Returns { found: false } when no pending entry of this kind exists
     * (fresh session or all prior approved/rejected) so callers can
     * distinguish "use state.live" from "use undefined as before".
     */
    function getLastPendingNewValue(kind) {
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.kind !== kind) continue;
            if (e.status !== 'pending') continue;
            if (!Object.prototype.hasOwnProperty.call(e, '_pendingAfter')) continue;
            return { found: true, newValue: e._pendingAfter };
        }
        return { found: false, newValue: undefined };
    }

    function deepTargetMatch(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        if (a.type !== b.type) return false;
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) if (a[k] !== b[k]) return false;
        return true;
    }

    async function getCurrentPendingState(kind, target) {
        const handler = resolveTargetSafe(target);
        let state = await handler.read(target);
        const candidates = entries.filter((e) =>
            e.status === 'pending' && e.kind === kind && deepTargetMatch(e.target, target));
        for (const entry of candidates) {
            if (entry._pendingAfter === undefined) continue;
            try {
                const proposeBefore = applyOps(entry._pendingAfter, entry.inverse, {
                    targetType: target.type, targetName: target.name || null,
                });
                const forward = deriveForward(proposeBefore, entry._pendingAfter);
                for (const op of forward) {
                    if (!op || typeof op.path !== 'string') continue;
                    if (!deepEqual(readJsonPointer(proposeBefore, op.path), readJsonPointer(state, op.path))) {
                        const err = new PatchConflictError({
                            targetType: target.type,
                            targetName: target.name || null,
                            opIndex: -1,
                            jsonPath: op.path,
                            reason: 'external modification on patched path',
                        });
                        events.dispatchEvent(new CustomEvent('bus:chain-broken', { detail: { kind, target, error: err } }));
                        return state;
                    }
                }
                state = applyOps(state, forward, {
                    targetType: target.type, targetName: target.name || null,
                });
            } catch (err) {
                events.dispatchEvent(new CustomEvent('bus:chain-broken', { detail: { kind, target, error: err } }));
                return state;
            }
        }
        return state;
    }

    function findEntry(id) {
        return entries.find((e) => e.id === id) || null;
    }

    function enqueueOutcome(entry, extra = {}) {
        let target = '';
        try {
            const th = resolveTargetSafe(entry.target);
            target = th && typeof th.describe === 'function' ? th.describe(entry.target) : '';
        } catch {
            target = entry.target && typeof entry.target === 'object'
                ? String(entry.target.name || entry.target.type || '')
                : '';
        }
        outcomeQueue.push({
            id: entry.id,
            kind: entry.kind,
            status: entry.status,
            target: String(target ?? ''),
            ...extra,
        });
    }

    function parkConflict(entry, err) {
        entry.status = 'conflict';
        entry.decidedAt = Date.now();
        entry.conflictError = err instanceof PatchConflictError
            ? { targetType: err.targetType, targetName: err.targetName, jsonPath: err.jsonPath, reason: err.reason }
            : { reason: String(err?.message || err || 'unknown') };
        enqueueOutcome(entry, { error: entry.conflictError.reason });
        onChange();
        return { ok: false, status: 'conflict', error: entry.conflictError.reason };
    }

    async function approve(id, _ctx) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'pending' && entry.status !== 'conflict') {
            return { ok: false, status: entry.status };
        }
        const handler = resolveTargetSafe(entry.target);
        let current;
        try {
            current = await handler.read(entry.target);
        } catch (err) {
            return parkConflict(entry, err);
        }
        let nextLive;
        try {
            // Reconstruct the propose-time before-state: apply the stored
            // inverse to the propose-time after to invert it back.
            const proposeBefore = applyOps(entry._pendingAfter, entry.inverse, {
                targetType: entry.target.type,
                targetName: entry.target.name || null,
            });
            // Derive the original forward turn (the ops the AI/user wrote at
            // propose time). Re-applying this set to `current` preserves
            // path-disjoint external edits because fast-json-patch only
            // touches the paths it visits.
            const forward = deriveForward(proposeBefore, entry._pendingAfter);
            // Path-overlap conflict: if a path the forward turn writes has
            // been mutated externally since propose, fast-json-patch's
            // replace would silently overwrite the foreign value. Pre-check
            // each touched path against the propose-time before to catch this.
            for (const op of forward) {
                if (!deepEqual(readJsonPointer(proposeBefore, op.path), readJsonPointer(current, op.path))) {
                    throw new PatchConflictError({
                        targetType: entry.target.type,
                        targetName: entry.target.name || null,
                        opIndex: -1,
                        jsonPath: op.path,
                        reason: 'external modification on patched path',
                    });
                }
            }
            nextLive = applyOps(current, forward, {
                targetType: entry.target.type,
                targetName: entry.target.name || null,
            });
        } catch (err) {
            return parkConflict(entry, err);
        }
        try {
            await handler.write(entry.target, nextLive);
        } catch (err) {
            return parkConflict(entry, err);
        }
        entry.status = 'committed';
        entry.decidedAt = Date.now();
        entry.committedAt = Date.now();
        entry.conflictError = null;
        // Keep _pendingAfter on the committed entry so rollback can pre-check
        // path-overlap drift against it. It is still stripped at serialize.
        enqueueOutcome(entry);
        onChange();
        return { ok: true, status: 'committed' };
    }

    function drainOutcomes() {
        // No onChange here: a drain is a pure read of the queue, the
        // visible entry state is unchanged, and the popup's onChange
        // handler is the iter-studio render pump. Emitting on every drain
        // produced a hot render loop whenever the auto-continue scheduler
        // flushed outcomes between LLM rounds. Entries already emit
        // onChange when they ENTER the queue (approve/reject/rollback);
        // a separate emit on drain is redundant.
        return outcomeQueue.splice(0, outcomeQueue.length);
    }

    function reject(id) {
        const entry = findEntry(id);
        if (!entry) return;
        if (entry.status !== 'pending' && entry.status !== 'conflict') return;
        entry.status = 'rejected';
        entry.decidedAt = Date.now();
        entry.conflictError = null;
        enqueueOutcome(entry);
        onChange();
    }

    function reset(id) {
        const entry = findEntry(id);
        if (!entry) return;
        if (entry.status !== 'rejected') return;
        entry.status = 'pending';
        entry.decidedAt = null;
        onChange();
    }

    function wrapConflict(err, target) {
        if (err instanceof PatchConflictError) return err;
        return new PatchConflictError({
            targetType: target?.type || 'unknown',
            targetName: target?.name || null,
            opIndex: -1,
            jsonPath: '',
            reason: String(err?.message || err || 'unknown'),
        });
    }

    async function rollback(id, _ctx) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'committed') {
            return { ok: false, status: entry.status };
        }
        const handler = resolveTargetSafe(entry.target);
        let current;
        try {
            current = await handler.read(entry.target);
        } catch (err) {
            const error = wrapConflict(err, entry.target);
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error } }));
            return { ok: false, status: 'conflict', error: error.reason };
        }
        // Path-overlap drift guard: when we still have the propose-time after
        // in memory (in-session committed entry), the current value at each
        // path the inverse touches must match — otherwise an external mutation
        // happened on a path we are about to overwrite.
        if (entry._pendingAfter !== undefined && Array.isArray(entry.inverse)) {
            for (const op of entry.inverse) {
                if (!op || typeof op.path !== 'string') continue;
                if (!deepEqual(readJsonPointer(entry._pendingAfter, op.path), readJsonPointer(current, op.path))) {
                    const error = new PatchConflictError({
                        targetType: entry.target.type,
                        targetName: entry.target.name || null,
                        opIndex: -1,
                        jsonPath: op.path,
                        reason: 'external modification on patched path',
                    });
                    events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error } }));
                    entry.status = 'conflict';
                    entry.conflictError = {
                        targetType: error.targetType,
                        targetName: error.targetName,
                        jsonPath: error.jsonPath,
                        reason: error.reason,
                    };
                    enqueueOutcome(entry, { error: error.reason });
                    onChange();
                    return { ok: false, status: 'conflict', error: error.reason };
                }
            }
        }
        let previous;
        try {
            previous = decodeBackward(current, entry.inverse, {
                targetType: entry.target.type,
                targetName: entry.target.name || null,
            });
        } catch (err) {
            const error = wrapConflict(err, entry.target);
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error } }));
            return { ok: false, status: 'conflict', error: error.reason };
        }
        try {
            await handler.write(entry.target, previous);
        } catch (err) {
            const error = wrapConflict(err, entry.target);
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error } }));
            return { ok: false, status: 'conflict', error: error.reason };
        }
        entry.status = 'rolledBack';
        entry.rolledBackAt = Date.now();
        delete entry._pendingAfter;
        enqueueOutcome(entry);
        onChange();
        return { ok: true, status: 'rolledBack' };
    }

    function callIdSetFromMessage(message) {
        const out = new Set();
        const tcs = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
        for (const tc of tcs) {
            const id = String(tc?.id || '');
            if (id) out.add(id);
        }
        return out;
    }

    async function approveAllPendingInTurn(message, ctx) {
        const callIds = callIdSetFromMessage(message);
        const targets = entries.filter((e) => e.status === 'pending' && callIds.has(String(e.sourceCallId || '')));
        const results = [];
        for (const e of targets) {
            const r = await approve(e.id, ctx);
            results.push({ id: e.id, ...r });
        }
        return { results };
    }

    function rejectAllPendingInTurn(message) {
        const callIds = callIdSetFromMessage(message);
        const targets = entries.filter((e) => e.status === 'pending' && callIds.has(String(e.sourceCallId || '')));
        for (const e of targets) reject(e.id);
        return { count: targets.length };
    }

    async function rollbackAllInTurn(message, ctx) {
        const callIds = callIdSetFromMessage(message);
        const committed = entries
            .filter((e) => e.status === 'committed' && callIds.has(String(e.sourceCallId || '')))
            .sort((a, b) => (b.committedAt || 0) - (a.committedAt || 0));
        const results = [];
        for (const e of committed) {
            const r = await rollback(e.id, ctx);
            results.push({ id: e.id, ...r });
        }
        return { results };
    }

    function serialize() {
        return {
            version: 3,
            entries: entries.map((e) => {
                const { _pendingAfter, ...rest } = e;
                return { ...rest };
            }),
            outcomeQueue: outcomeQueue.map((o) => ({ ...o })),
        };
    }

    function hydrate(data) {
        entries.length = 0;
        outcomeQueue.length = 0;
        seq = 0;
        if (!data || typeof data !== 'object' || data.version !== 3) {
            onChange();
            return;
        }
        if (Array.isArray(data.entries)) {
            for (const e of data.entries) {
                entries.push({ ...e });
                const parts = String(e.id || '').split('_');
                const n = Number(parts[1]);
                if (Number.isFinite(n) && n > seq) seq = n;
            }
        }
        if (Array.isArray(data.outcomeQueue)) {
            for (const o of data.outcomeQueue) outcomeQueue.push({ ...o });
        }
        onChange();
    }

    let autoApprove = false;
    const autoApprovePending = new Set();
    let autoApproveScheduled = false;

    function setAutoApprove(enabled) {
        autoApprove = Boolean(enabled);
    }

    function isAutoApprove() {
        return autoApprove;
    }

    function scheduleAutoApprove(id) {
        autoApprovePending.add(id);
        if (autoApproveScheduled) return;
        autoApproveScheduled = true;
        queueMicrotask(async () => {
            autoApproveScheduled = false;
            const batch = Array.from(autoApprovePending);
            autoApprovePending.clear();
            for (const eid of batch) {
                const entry = findEntry(eid);
                if (!entry || entry.status !== 'pending') continue;
                await approve(eid);
            }
        });
    }

    function renderCardsForMessage(messageId) {
        let callIds;
        if (typeof messageId === 'string') {
            callIds = new Set([messageId]);
        } else {
            callIds = callIdSetFromMessage(messageId);
        }
        const parts = [];
        for (const e of entries) {
            const id = String(e.sourceCallId || '');
            if (!callIds.has(id)) continue;
            const handler = kinds.get(e.kind);
            if (!handler) continue;
            parts.push(renderProposalCard(e, handler, { i18n }));
        }
        return parts.join('');
    }

    function renderTurnActions_(message) {
        const callIds = typeof message === 'string'
            ? new Set([message])
            : callIdSetFromMessage(message);
        let pending = 0;
        let committed = 0;
        for (const e of entries) {
            if (!callIds.has(String(e.sourceCallId || ''))) continue;
            // Conflicts are not user-actionable here: they don't accept
            // approve / reject from the bulk path either, and counting
            // them would surface "Approve all pending (3)" buttons that
            // commit nothing on click. Pending is the only count this row
            // can act on.
            if (e.status === 'pending') pending++;
            else if (e.status === 'committed') {
                const handler = kinds.get(e.kind);
                if (handler && handler.inverseAvailable !== false) committed++;
            }
        }
        const msgId = typeof message === 'string' ? message : String(message?.id || '');
        return renderTurnActions({ pendingCount: pending, committedCount: committed, messageId: msgId, i18n });
    }

    let messageResolver = null;
    function setMessageResolver(fn) {
        messageResolver = typeof fn === 'function' ? fn : null;
    }
    async function handleClick(event) {
        return dispatchProposalClick(event, returnedApi, messageResolver);
    }

    const returnedApi = {
        registerKind,
        propose: async (input) => {
            const out = await propose(input);
            if (autoApprove) scheduleAutoApprove(out.id);
            return out;
        },
        hasOutstanding,
        getLastPendingNewValue,
        getCurrentPendingState,
        approve,
        reject,
        reset,
        rollback,
        approveAllPendingInTurn,
        rejectAllPendingInTurn,
        rollbackAllInTurn,
        serialize,
        hydrate,
        drainOutcomes,
        setAutoApprove,
        isAutoApprove,
        renderCardsForMessage,
        renderTurnActions: renderTurnActions_,
        handleClick,
        setMessageResolver,
        events,
        _testOnly_entries: () => entries.map((e) => ({ ...e })),
        _testOnly_outcomeQueue: () => outcomeQueue.slice(),
        _kinds: kinds,
        _entries: entries,
        _outcomeQueue: outcomeQueue,
        _emitChange: onChange,
        _i18n: i18n,
    };
    return returnedApi;
}
