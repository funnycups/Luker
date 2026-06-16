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
 * Drift detection is git-style: handler.fingerprint(snapshot) at propose
 * time -> handler.readCurrent(op, ctx) at approve time -> if the
 * fingerprints don't match, the bus parks the entry in status='conflict'
 * and refuses to commit. User resolves manually by re-approving (which
 * re-reads current state for a fresh snapshot/fingerprint) or rejecting.
 *
 * The same check fires on rollback: after a successful commit the bus
 * records `afterFingerprint` (the state immediately after our write); a
 * later rollback re-reads current state and refuses to apply the inverse
 * if anything has changed in the meantime, so we never silently overwrite
 * a concurrent edit while undoing our own. Entries hydrated from older
 * sessions that predate `afterFingerprint` fall back to the previous
 * unchecked rollback path.
 */

function makeId(kindId, seq) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${kindId}_${seq}_${rand}`;
}

import { renderProposalCard } from './render-card.js';
import { renderTurnActions } from './render-turn.js';
import { dispatch as dispatchProposalClick } from './event-router.js';

export function createBus(opts = {}) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    const kinds = new Map();           // kindId -> handler
    const entries = [];                // ordered, append-only within a session
    const outcomeQueue = [];           // drained by bus.drainOutcomes
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
        kinds.set(kindId, handler);
    }

    async function propose({ kind, sourceCallId = null, op, snapshot, meta = null } = {}) {
        const handler = getHandler(kind);
        const fingerprint = await handler.fingerprint(snapshot);
        seq += 1;
        const entry = {
            id: makeId(kind, seq),
            kind,
            sourceCallId: sourceCallId == null ? null : String(sourceCallId),
            status: 'pending',
            op,
            snapshot,
            fingerprint,
            afterFingerprint: null,
            meta: meta ?? null,
            createdAt: Date.now(),
            decidedAt: null,
            committedAt: null,
            rolledBackAt: null,
            conflictInfo: null,
        };
        entries.push(entry);
        onChange();
        return { id: entry.id, fingerprint };
    }

    function hasOutstanding() {
        for (const e of entries) {
            if (e.status === 'pending' || e.status === 'conflict') return true;
        }
        return false;
    }

    function findEntry(id) {
        return entries.find((e) => e.id === id) || null;
    }

    function enqueueOutcome(entry, extra = {}) {
        const handler = kinds.get(entry.kind);
        const target = handler ? handler.target(entry) : '';
        outcomeQueue.push({
            id: entry.id,
            kind: entry.kind,
            status: entry.status,
            target: String(target ?? ''),
            ...extra,
        });
    }

    async function approve(id, ctx) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'pending' && entry.status !== 'conflict') {
            return { ok: false, status: entry.status };
        }
        const handler = getHandler(entry.kind);
        let current;
        try {
            current = await handler.readCurrent(entry.op, ctx);
        } catch (err) {
            const msg = String(err?.message || err || 'readCurrent failed');
            entry.status = 'conflict';
            entry.decidedAt = Date.now();
            entry.conflictInfo = {
                expectedFingerprint: entry.fingerprint,
                actualFingerprint: null,
                actualSnapshot: null,
                error: msg,
                at: Date.now(),
            };
            enqueueOutcome(entry, { error: msg });
            onChange();
            return { ok: false, status: 'conflict', error: msg };
        }
        if (String(current.fingerprint) !== String(entry.fingerprint)) {
            entry.status = 'conflict';
            entry.decidedAt = Date.now();
            entry.conflictInfo = {
                expectedFingerprint: entry.fingerprint,
                actualFingerprint: String(current.fingerprint),
                actualSnapshot: current.snapshot,
                at: Date.now(),
            };
            enqueueOutcome(entry);
            onChange();
            return { ok: false, status: 'conflict' };
        }
        try {
            await handler.commit(entry.op, ctx);
        } catch (err) {
            const msg = String(err?.message || err || 'commit failed');
            entry.status = 'conflict';
            entry.decidedAt = Date.now();
            entry.conflictInfo = {
                expectedFingerprint: entry.fingerprint,
                actualFingerprint: String(current.fingerprint),
                actualSnapshot: current.snapshot,
                error: msg,
                at: Date.now(),
            };
            enqueueOutcome(entry, { error: msg });
            onChange();
            return { ok: false, status: 'conflict', error: msg };
        }
        entry.status = 'committed';
        entry.decidedAt = Date.now();
        entry.committedAt = Date.now();
        entry.conflictInfo = null;
        try {
            const post = await handler.readCurrent(entry.op, ctx);
            entry.afterFingerprint = String(post.fingerprint);
        } catch {
            // Best-effort: a post-commit read failure leaves afterFingerprint
            // null, which makes rollback() fall back to its unchecked behaviour
            // for this entry (same as pre-existing hydrated entries).
            entry.afterFingerprint = null;
        }
        enqueueOutcome(entry);
        onChange();
        return { ok: true, status: 'committed' };
    }

    function drainOutcomes() {
        const out = outcomeQueue.splice(0, outcomeQueue.length);
        onChange();
        return out;
    }

    function reject(id) {
        const entry = findEntry(id);
        if (!entry) return;
        if (entry.status !== 'pending' && entry.status !== 'conflict') return;
        entry.status = 'rejected';
        entry.decidedAt = Date.now();
        entry.conflictInfo = null;
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

    async function rollback(id, ctx) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'committed') {
            return { ok: false, status: entry.status };
        }
        const handler = getHandler(entry.kind);
        const inverseOp = handler.inverse(entry.op, entry.snapshot, ctx);
        if (!inverseOp) {
            return { ok: false, status: entry.status };
        }
        // Only check drift against the post-commit fingerprint when we
        // actually recorded one. Entries committed before this field
        // existed (or whose post-commit readCurrent failed) hydrate with
        // afterFingerprint=null; for those we keep the legacy unchecked
        // rollback path rather than blocking every old entry.
        if (entry.afterFingerprint != null) {
            let current;
            try {
                current = await handler.readCurrent(entry.op, ctx);
            } catch (err) {
                const msg = String(err?.message || err || 'readCurrent failed');
                entry.status = 'conflict';
                entry.conflictInfo = {
                    expectedFingerprint: entry.afterFingerprint,
                    actualFingerprint: null,
                    actualSnapshot: null,
                    error: msg,
                    at: Date.now(),
                };
                enqueueOutcome(entry, { error: msg });
                onChange();
                return { ok: false, status: 'conflict', error: msg };
            }
            if (String(current.fingerprint) !== String(entry.afterFingerprint)) {
                entry.status = 'conflict';
                entry.conflictInfo = {
                    expectedFingerprint: entry.afterFingerprint,
                    actualFingerprint: String(current.fingerprint),
                    actualSnapshot: current.snapshot,
                    at: Date.now(),
                };
                enqueueOutcome(entry);
                onChange();
                return { ok: false, status: 'conflict' };
            }
        }
        try {
            await handler.commit(inverseOp, ctx);
        } catch (err) {
            const msg = String(err?.message || err || 'rollback commit failed');
            return { ok: false, status: 'committed', error: msg };
        }
        entry.status = 'rolledBack';
        entry.rolledBackAt = Date.now();
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
            version: 2,
            entries: entries.map((e) => ({ ...e })),
            outcomeQueue: outcomeQueue.map((o) => ({ ...o })),
        };
    }

    function hydrate(data) {
        if (!data || typeof data !== 'object') {
            onChange();
            return;
        }
        entries.length = 0;
        outcomeQueue.length = 0;
        seq = 0;
        if (data.version !== 2) {
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
            if (e.status === 'pending' || e.status === 'conflict') pending++;
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
