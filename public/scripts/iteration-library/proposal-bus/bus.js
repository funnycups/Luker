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
 * re-render off a single source of truth. onCommitted (optional) fires
 * once per successful forward commit — after an approve's disk write
 * lands — so popups can observe "an edit actually hit disk this session"
 * without inspecting entry state.
 *
 * Payload model: each entry stores the RFC 6902 inverse patch
 * `compare(after, before)` for its turn, plus the forward patch
 * `compare(before, after)` so a pending entry restored from a serialized
 * session (where the in-memory `_pendingAfter` snapshot is absent) can
 * still be approved. Live read/write is routed
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

function makeEntry({ id, kind, target, inverse, forward, after, sourceCallId, meta }) {
    return {
        id,
        kind,
        target,
        inverse,
        forward,
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
import {
    encodeInverse,
    decodeBackward,
    deriveForward,
    applyOps,
    PatchConflictError,
    readJsonPointer,
    expectationPaths,
    captureDriftExpectations as captureExpectations,
} from '../storage/patch-codec.js';
import { resolveTarget } from '../storage/target-registry.js';
import { STATE_ERROR_REASONS, CONFLICT_CODES } from '../../lib/state-errors.js';

export function createBus(opts = {}) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    const onCommitted = typeof opts.onCommitted === 'function' ? opts.onCommitted : null;

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

    // Rollback writes `decodeBackward(current, inverse)`. An entry whose
    // kind opts out (`inverseAvailable: false`) or whose inverse is empty
    // has nothing to undo; writing would re-run a replaying target such
    // as skill-registry.
    function isReversibleEntry(entry) {
        const handler = kinds.get(entry?.kind);
        if (handler && handler.inverseAvailable === false) return false;
        return Array.isArray(entry?.inverse) && entry.inverse.length > 0;
    }

    function resolveTargetSafe(target) {
        return resolveTarget(target);
    }

    function checkExpectations(expectations, current, ctx) {
        for (const expected of expectations) {
            const value = readJsonPointer(current, expected.path);
            if (expected.exists !== (value !== undefined) || !deepEqual(expected.value, value)) {
                throw new PatchConflictError({
                    ...ctx, opIndex: -1, jsonPath: expected.path,
                    reason: 'external modification on patched path',
                });
            }
        }
    }

    function legacyExpectations(entry, current, ctx, rollback) {
        const ops = rollback ? entry.inverse : entry.forward;
        if (!Array.isArray(ops)) throw notRestorableError();
        // Legacy patches do not record array lengths or insertion boundaries.
        // Refuse them rather than interpreting external elements as originals.
        const allOps = Array.isArray(entry.forward)
            ? [...entry.inverse, ...entry.forward]
            : ops;
        if (expectationPaths(ops, current).some((path) => Array.isArray(readJsonPointer(current, path)))
            || allOps.some((op) => Array.isArray(op.value))) {
            throw notRestorableError();
        }
        if (!Array.isArray(entry.forward)) {
            if (!rollback) throw notRestorableError();
            // Pre-branch committed entries carry `inverse` without `forward` or
            // `driftExpectations`. Non-array inverse patches can still safely
            // roll back via `decodeBackward`, which validates path existence.
            return [];
        }
        const expected = rollback
            ? applyOps(applyOps(current, entry.inverse, ctx), entry.forward, ctx)
            : applyOps(applyOps(current, entry.forward, ctx), entry.inverse, ctx);
        return captureExpectations(ops, expected);
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
        const forward = deriveForward(before, after);
        seq += 1;
        const entry = makeEntry({
            id: makeId(kind, seq),
            kind,
            target,
            inverse,
            forward,
            after,
            sourceCallId,
            meta,
        });
        entry.driftExpectations = {
            before: captureExpectations(forward, before),
            after: captureExpectations(inverse, after),
        };
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
     * Return the set of `sourceCallId` values currently attached to
     * `pending` entries, PLUS the entries' own ids so callers can
     * decide whether the drain gate should close. The studios use this
     * to answer "given a batch of just-drained outcomes, does any
     * assistant message still have un-decided pending cards from the
     * SAME turn?" — the answer needs a mapping from tool-call id (which
     * outcomes carry as `sourceCallId` through the entry) back to the
     * owning assistant message, which only the studio's session can
     * resolve. See `drainBusOutcomes` in each studio for the gate.
     *
     * Returns `Array<{id, sourceCallId}>` so the caller can build any
     * indexing shape it needs without re-exposing the entry array.
     */
    function listPending() {
        const out = [];
        for (const e of entries) {
            if (e.status !== 'pending') continue;
            out.push({ id: String(e.id), sourceCallId: String(e.sourceCallId || '') });
        }
        return out;
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
        const codecCtx = { targetType: target.type, targetName: target.name || null };
        for (const entry of candidates) {
            try {
                state = applyEntryForward(entry, state, codecCtx);
            } catch (err) {
                // A legacy entry with no forward patch cannot be approved
                // either; leave it out of the chain instead of locking it.
                if (err?.conflictCode === CONFLICT_CODES.NOT_RESTORABLE) continue;
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
            // sourceCallId lets the studio drain resolve the owning
            // assistant message (via its messageResolver) so it can gate
            // the "next round fires only when the batch is settled"
            // decision on assistant-message boundaries, not just on the
            // outcome entry id. Without it the gate can't tell which
            // still-pending entries share a turn with the just-drained
            // ones. The drain-outcomes-message formatter ignores the
            // extra field so the agent-facing message shape is unchanged.
            sourceCallId: String(entry.sourceCallId || ''),
            ...extra,
        });
    }

    function inferReasonFromError(err) {
        if (err && typeof err === 'object') {
            if (typeof err.reason === 'string' && err.reason in STATE_ERROR_REASONS) {
                return { reason: err.reason, hint: String(err.hint || err.message || '').slice(0, 120) };
            }
            if (err instanceof PatchConflictError) {
                return { reason: STATE_ERROR_REASONS.CONFLICT, hint: String(err.hint || err.message || 'patch conflict').slice(0, 120) };
            }
            if (err.name === 'AbortError') {
                return { reason: STATE_ERROR_REASONS.TRANSPORT_ERROR, hint: `fetch aborted: ${String(err.message || 'aborted').slice(0, 100)}` };
            }
            if (typeof err.status === 'number' && err.status >= 400) {
                return { reason: STATE_ERROR_REASONS.HTTP_ERROR, hint: `HTTP ${err.status}: ${String(err.statusText || err.message || '').slice(0, 80)}` };
            }
        }
        return {
            reason: STATE_ERROR_REASONS.CONFLICT,
            hint: String(err?.message || err || 'unknown failure').slice(0, 120),
        };
    }

    function parkConflict(entry, err, { recordOutcome = true, emitChange = true } = {}) {
        const inferred = inferReasonFromError(err);
        const code = typeof err?.conflictCode === 'string' ? { code: err.conflictCode } : {};
        entry.status = 'conflict';
        entry.decidedAt = Date.now();
        entry.conflictError = err instanceof PatchConflictError
            ? { targetType: err.targetType, targetName: err.targetName, jsonPath: err.jsonPath, reason: inferred.reason, hint: inferred.hint }
            : { reason: inferred.reason, hint: inferred.hint, ...code };
        if (recordOutcome) {
            enqueueOutcome(entry, { error: inferred.hint, reason: inferred.reason, hint: inferred.hint });
        }
        if (emitChange) {
            onChange();
        }
        return { ok: false, status: 'conflict', error: inferred.hint, reason: inferred.reason, hint: inferred.hint };
    }

    function notRestorableError() {
        const err = new Error('proposal saved by an older version cannot be applied after a reload');
        err.reason = STATE_ERROR_REASONS.REPLAY_BROKEN;
        err.hint = err.message;
        err.conflictCode = CONFLICT_CODES.NOT_RESTORABLE;
        return err;
    }

    /**
     * Resolve the forward patch to re-apply and the propose-time
     * before-state to drift-check it against.
     *
     * In-session entries hold `_pendingAfter`: the before-state is the
     * inverse applied to it. Restored entries carry only the persisted
     * `forward` + `inverse` pair. Persisted expectations preserve array
     * boundaries. Legacy object patches can recover touched values, but
     * ambiguous array patches are refused. Entries
     * with neither (sessions saved before `forward` was persisted) cannot
     * be rebuilt unless their inverse is empty, in which case forward is
     * empty too.
     */
    function resolveApprovePlan(entry, current, ctx) {
        if (entry._pendingAfter !== undefined) {
            const proposeBefore = applyOps(entry._pendingAfter, entry.inverse, ctx);
            return { proposeBefore, forward: deriveForward(proposeBefore, entry._pendingAfter) };
        }
        let forward = null;
        if (Array.isArray(entry.forward)) forward = entry.forward;
        else if (Array.isArray(entry.inverse) && entry.inverse.length === 0) forward = [];
        if (!forward) throw notRestorableError();
        const proposeBefore = applyOps(applyOps(current, forward, ctx), entry.inverse, ctx);
        return { proposeBefore, forward };
    }

    /**
     * Re-apply an entry's forward turn onto `current`. Re-applying the
     * forward ops preserves path-disjoint external edits because
     * fast-json-patch only touches the paths it visits. Path-overlap
     * conflict: if a path the forward turn writes has been mutated since
     * propose, `replace` would silently overwrite the foreign value, so
     * each touched path is checked against the propose-time before first.
     *
     * @throws {PatchConflictError} on drift or an op that no longer applies.
     */
    function applyEntryForward(entry, current, ctx) {
        if (entry.driftExpectations?.before) {
            if (!Array.isArray(entry.forward)) throw notRestorableError();
            checkExpectations(entry.driftExpectations.before, current, ctx);
            return applyOps(current, entry.forward, ctx);
        }
        const { proposeBefore, forward } = resolveApprovePlan(entry, current, ctx);
        if (entry._pendingAfter === undefined && forward.length) {
            checkExpectations(legacyExpectations(entry, current, ctx, false), current, ctx);
            return applyOps(current, forward, ctx);
        }
        for (const op of forward) {
            if (!op || typeof op.path !== 'string') continue;
            if (!deepEqual(readJsonPointer(proposeBefore, op.path), readJsonPointer(current, op.path))) {
                throw new PatchConflictError({
                    targetType: ctx.targetType,
                    targetName: ctx.targetName,
                    opIndex: -1,
                    jsonPath: op.path,
                    reason: 'external modification on patched path',
                });
            }
        }
        return applyOps(current, forward, ctx);
    }

    async function approve(id, _ctx) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'pending' && entry.status !== 'conflict') {
            return { ok: false, status: entry.status };
        }
        // Resolve inside the try: a hydrated entry whose target type has no
        // registered handler (legacy session, popup not mounted) parks as a
        // conflict instead of throwing out of approve.
        let handler;
        let current;
        try {
            handler = resolveTargetSafe(entry.target);
            current = await handler.read(entry.target);
        } catch (err) {
            return parkConflict(entry, err);
        }
        const codecCtx = {
            targetType: entry.target.type,
            targetName: entry.target.name || null,
        };
        let nextLive;
        try {
            nextLive = applyEntryForward(entry, current, codecCtx);
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
        // A restored entry has no in-memory after-state; the written state
        // matches the propose-time after on every patched path, which is
        // what the rollback drift check reads.
        if (entry._pendingAfter === undefined) entry._pendingAfter = nextLive;
        // Forward-commit notification. Fires only here (never on
        // rollback / reject), with a shallow copy so the hook cannot
        // mutate bus state. A throwing hook must not break the commit
        // contract — the write already landed.
        if (onCommitted) {
            try {
                onCommitted({ ...entry });
            } catch (err) {
                console.error('[ProposalBus] onCommitted hook threw:', err);
            }
        }
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

    // Conflict-state escape hatch. A conflict entry has already had its
    // outcome enqueued; force-discard transitions it to 'rolledBack' so
    // the card collapses out of the actionable buttons. We do NOT write
    // to ST live — that's the whole point of "discard anyway": the user
    // has decided the bus's drift detection was right and they don't
    // want this turn applied at all.
    function forceDiscard(id) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'conflict') return { ok: false, status: entry.status };
        entry.status = 'rolledBack';
        entry.rolledBackAt = Date.now();
        // Outcome already enqueued at parkConflict time; do not duplicate.
        delete entry._pendingAfter;
        onChange();
        return { ok: true, status: 'rolledBack' };
    }

    // Conflict-state escape hatch. Surfaces the entry's raw inverse
    // patch + target so the user (or a popup-level listener) can copy
    // it for support / manual reconciliation. Dispatches a
    // `bus:export-record` event with the payload; popups that want a
    // dialog can listen on the bus's events target. We never auto-copy
    // to clipboard from the bus core (no DOM dependency).
    function exportRecord(id) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        const detail = {
            entryId: entry.id,
            kind: entry.kind,
            target: entry.target,
            inverse: Array.isArray(entry.inverse) ? entry.inverse.slice() : [],
            status: entry.status,
            conflictError: entry.conflictError ?? null,
        };
        events.dispatchEvent(new CustomEvent('bus:export-record', { detail }));
        return { ok: true, detail };
    }

    async function rollbackEntry(id, _ctx, { recordOutcome = true, emitChange = true } = {}) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, status: 'unknown' };
        if (entry.status !== 'committed') {
            return { ok: false, status: entry.status };
        }
        if (!isReversibleEntry(entry)) {
            return { ok: false, status: entry.status, reason: 'not_reversible' };
        }
        let handler;
        let current;
        try {
            handler = resolveTargetSafe(entry.target);
            current = await handler.read(entry.target);
        } catch (err) {
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error: err } }));
            return parkConflict(entry, err, { recordOutcome, emitChange });
        }
        try {
            const ctx = { targetType: entry.target.type, targetName: entry.target.name || null };
            const expectations = entry.driftExpectations?.after
                ?? (entry._pendingAfter !== undefined ? captureExpectations(entry.inverse, entry._pendingAfter)
                    : legacyExpectations(entry, current, ctx, true));
            checkExpectations(expectations, current, ctx);
        } catch (err) {
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error: err } }));
            return parkConflict(entry, err, { recordOutcome, emitChange });
        }
        let previous;
        try {
            previous = decodeBackward(current, entry.inverse, {
                targetType: entry.target.type,
                targetName: entry.target.name || null,
            });
        } catch (err) {
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error: err } }));
            return parkConflict(entry, err, { recordOutcome, emitChange });
        }
        try {
            await handler.write(entry.target, previous);
        } catch (err) {
            events.dispatchEvent(new CustomEvent('bus:rollback-failed', { detail: { entryId: id, error: err } }));
            return parkConflict(entry, err, { recordOutcome, emitChange });
        }
        entry.status = 'rolledBack';
        entry.rolledBackAt = Date.now();
        delete entry._pendingAfter;
        if (recordOutcome) {
            enqueueOutcome(entry);
        }
        if (emitChange) {
            onChange();
        }
        return { ok: true, status: 'rolledBack' };
    }

    async function rollback(id, ctx) {
        return rollbackEntry(id, ctx, { recordOutcome: true, emitChange: true });
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
            .filter((e) => e.status === 'committed' && isReversibleEntry(e) && callIds.has(String(e.sourceCallId || '')))
            .sort((a, b) => (b.committedAt || 0) - (a.committedAt || 0) || entries.indexOf(b) - entries.indexOf(a));
        const results = [];
        for (const e of committed) {
            const r = await rollback(e.id, ctx);
            results.push({ id: e.id, ...r });
        }
        return { results };
    }

    /**
     * Roll back every committed entry whose sourceCallId belongs to ANY of
     * the supplied messages. Used by `regenerateFromMessage` to undo the
     * disk effects of assistant turns about to be truncated from the chat.
     *
     * Walks the union message list, gathers committed reversible entries, sorts by
     * committedAt desc so dependent later commits unwind before earlier
     * ones, then rollbacks in sequence. Stops at the first failure so the
     * caller can surface "regenerate aborted — these commits could not be
     * unwound" rather than partially-rewinding into an inconsistent state.
     *
     * Returns `{results, ok, failedAt}`: `ok` is true iff every rollback
     * succeeded; `failedAt` carries the failing entry id (and its result)
     * when not ok so the caller can compose a precise toast.
     */
    async function rollbackAllInMessages(messages, ctx) {
        const callIds = new Set();
        for (const m of Array.isArray(messages) ? messages : []) {
            for (const id of callIdSetFromMessage(m)) callIds.add(id);
        }
        if (callIds.size === 0) {
            return { results: [], ok: true, failedAt: null };
        }
        const committed = entries
            .filter((e) => e.status === 'committed' && isReversibleEntry(e) && callIds.has(String(e.sourceCallId || '')))
            .sort((a, b) => (b.committedAt || 0) - (a.committedAt || 0) || entries.indexOf(b) - entries.indexOf(a));
        const results = [];
        for (const e of committed) {
            // Discarded turns are about to be truncated from history: suppress
            // outcome-queue entries and mid-rewind onChange renders so an async
            // drain cannot hijack the imminent re-send. On failure, emit one
            // onChange so the caller's preserved history renders the conflict.
            const r = await rollbackEntry(e.id, ctx, { recordOutcome: false, emitChange: false });
            results.push({ id: e.id, target: e.target, ...r });
            if (!r.ok) {
                onChange();
                return { results, ok: false, failedAt: { id: e.id, target: e.target, ...r } };
            }
        }
        return { results, ok: true, failedAt: null };
    }

    /** Discard owned entries without change notifications or follow-up outcomes. */
    function discardEntries(ids) {
        const selected = new Set(ids);
        let rejected = 0;
        for (const entry of entries) {
            if ((entry.status === 'pending' || entry.status === 'conflict') && selected.has(entry.id)) {
                entry.status = 'rejected';
                entry.decidedAt = Date.now();
                entry.conflictError = null;
                rejected += 1;
            }
        }
        let prunedOutcomes = 0;
        for (let i = outcomeQueue.length - 1; i >= 0; i--) {
            if (selected.has(outcomeQueue[i].id)) {
                outcomeQueue.splice(i, 1);
                prunedOutcomes += 1;
            }
        }
        return { rejected, prunedOutcomes };
    }

    /**
     * Inspect (without mutating) whether `rollbackAllInMessages` for the
     * given message range would have any committed entries to undo. Used
     * to short-circuit the regenerate path when nothing needs rolling
     * back — keeps the no-edits common case from emitting a "rolled back
     * 0 commits" toast.
     */
    function countCommittedInMessages(messages) {
        const callIds = new Set();
        for (const m of Array.isArray(messages) ? messages : []) {
            for (const id of callIdSetFromMessage(m)) callIds.add(id);
        }
        if (callIds.size === 0) return 0;
        return entries.filter((e) => e.status === 'committed' && isReversibleEntry(e) && callIds.has(String(e.sourceCallId || ''))).length;
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
            if (!kinds.has(e.kind)) continue;
            // Conflicts are not user-actionable here: they don't accept
            // approve / reject from the bulk path either, and counting
            // them would surface "Approve all pending (3)" buttons that
            // commit nothing on click. Pending is the only count this row
            // can act on.
            if (e.status === 'pending') pending++;
            else if (e.status === 'committed' && isReversibleEntry(e)) committed++;
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
        listPending,
        getCurrentPendingState,
        approve,
        reject,
        reset,
        rollback,
        forceDiscard,
        exportRecord,
        approveAllPendingInTurn,
        rejectAllPendingInTurn,
        rollbackAllInTurn,
        rollbackAllInMessages,
        discardEntries,
        countCommittedInMessages,
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
        // Shallow copies in proposal order; studios iterate them for
        // auto-approve, drain bookkeeping and turn-level state.
        listEntries: () => entries.map((e) => ({ ...e })),
    };
    return returnedApi;
}
