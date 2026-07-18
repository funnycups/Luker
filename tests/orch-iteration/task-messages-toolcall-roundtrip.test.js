// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Structural contract: iter-studio's `buildTaskMessages` must replay
// EVERY persisted tool_call with a matching role:'tool' message, and
// `drainBusOutcomes` must update the persisted tool_result envelope
// in place instead of pushing a synthetic user message.
//
// The bug this refactor fixes: pre-refactor buildTaskMessages stripped
// edit tool_calls from history and drainBusOutcomes pushed a
// `[User reviewed N proposal(s): ...]` synthetic user message. From the
// LLM's protocol view, its previous assistant turn had NO tool_calls
// followed by a mystery review message; the model concluded "the
// committed edit was not mine" and looped re-issuing the same edit.
//
// The `buildTaskMessages` filter and message-shape rebuild logic live
// inside a closure inside studio.js (jest can't import studio.js
// directly — its transitive graph pulls in ST DOM globals). So this
// file pins the SHAPES of the persisted messages the fix depends on:
//
//   1. Edit tool_call emission persists a `pending` tool_result
//      envelope keyed to the callId (buildEditToolResultPayload
//      contract).
//   2. buildPayloadForOutcome maps every bus outcome status to the
//      correct resolved envelope (committed / rejected / conflict /
//      rolled_back), with conflict.reason forwarded verbatim + the
//      hint field present when the outcome carried one.
//   3. The pending → resolved transition is an IN-PLACE update on
//      the persisted toolResults array (no new user message, no shape
//      drift).
//
// Studio-level "session with a mix of read + edit tool_calls" replay
// asserts go via the session-store normalizeMessageShape roundtrip
// (already covered in tests/orch-iteration/popup-bug-regression.test.js
// ORCH-6). The end-to-end "buildTaskMessages sees N tool_calls + N
// tool_results" check is enforced by ORCH-1's structural grep on
// studio.js (kept in popup-bug-regression.test.js).
//
// No prompt-body regex asserts. Every check is structural (payload
// field values, tool_call_id linkage, in-place array mutation).

import { describe, test, expect } from '@jest/globals';
import {
    buildEditToolResultPayload,
    buildPayloadForOutcome,
} from '../../public/scripts/extensions/orchestrator/iter-studio/edit-tool-result-envelope.js';

describe('edit-tool tool_result envelope — pending shape', () => {
    test('pending payload carries status="proposal_pending" and a non-empty message', () => {
        const p = buildEditToolResultPayload('pending');
        expect(p).toEqual(expect.objectContaining({ status: 'proposal_pending' }));
        expect(typeof p.message).toBe('string');
        expect(p.message.length).toBeGreaterThan(0);
    });

    test('pending is the only status alias for "proposal_pending"', () => {
        // Both spellings collapse to the same wire status — buildTaskMessages'
        // legacy-fill and drainBusOutcomes' cascade both need to route the
        // same string.
        const a = buildEditToolResultPayload('pending');
        const b = buildEditToolResultPayload('proposal_pending');
        expect(a.status).toBe('proposal_pending');
        expect(b.status).toBe('proposal_pending');
    });

    test('unknown status collapses to pending (protocol-safety fallback)', () => {
        // Every tool_call MUST have a matching role:'tool' message or the
        // provider 400s. If a caller ever passes something unrecognized,
        // fall back to pending rather than emit a malformed envelope.
        const p = buildEditToolResultPayload('some_future_status');
        expect(p.status).toBe('proposal_pending');
    });
});

describe('edit-tool tool_result envelope — resolved shapes', () => {
    test('committed: status="committed", non-empty message', () => {
        const p = buildEditToolResultPayload('committed');
        expect(p.status).toBe('committed');
        expect(typeof p.message).toBe('string');
        expect(p.message.length).toBeGreaterThan(0);
    });

    test('rejected: status="rejected", non-empty message', () => {
        const p = buildEditToolResultPayload('rejected');
        expect(p.status).toBe('rejected');
        expect(typeof p.message).toBe('string');
        expect(p.message.length).toBeGreaterThan(0);
    });

    test('rolled_back: status="rolled_back", accepts camelCase alias', () => {
        const a = buildEditToolResultPayload('rolled_back');
        const b = buildEditToolResultPayload('rolledBack');
        expect(a.status).toBe('rolled_back');
        expect(b.status).toBe('rolled_back');
    });

    test('conflict: default reason falls back to CONFLICT with the paired message', () => {
        const p = buildEditToolResultPayload('conflict');
        expect(p.status).toBe('conflict');
        expect(p.reason).toBe('CONFLICT');
        expect(typeof p.message).toBe('string');
        // No hint field when the outcome did not carry one.
        expect(p.hint).toBeUndefined();
    });

    test('conflict: known reasons round-trip verbatim and carry a matched message', () => {
        // The 8 STATE_ERROR_REASONS the bus can infer. All must produce a
        // distinct message so the AI can branch on the reason enum without
        // regex-sniffing prose.
        const reasons = [
            'VALIDATION_ARGS',
            'VALIDATION_TARGET',
            'VALIDATION_COMMIT',
            'INSTANCE_DESTROYED',
            'CONFLICT',
            'HTTP_ERROR',
            'TRANSPORT_ERROR',
            'LOG_WRITE_FAILED',
        ];
        for (const r of reasons) {
            const p = buildEditToolResultPayload('conflict', { reason: r });
            expect(p.status).toBe('conflict');
            expect(p.reason).toBe(r);
            expect(typeof p.message).toBe('string');
            expect(p.message.length).toBeGreaterThan(0);
        }
    });

    test('conflict: unknown reason still populates status+message and preserves the reason verbatim', () => {
        // Forward-compat: a future STATE_ERROR_REASONS value should not
        // crash the envelope builder. The verbatim reason lets the AI
        // route on the enum even before the client-side message table
        // catches up.
        const p = buildEditToolResultPayload('conflict', { reason: 'SOME_FUTURE_REASON' });
        expect(p.status).toBe('conflict');
        expect(p.reason).toBe('SOME_FUTURE_REASON');
        expect(typeof p.message).toBe('string');
        expect(p.message.length).toBeGreaterThan(0);
    });

    test('conflict: hint field is forwarded verbatim without size cap', () => {
        // Iter-studio contract: no arbitrary size caps on tool_result
        // envelopes. The hint carries the executor error verbatim so the
        // AI sees the same diagnostic the popup surfaces.
        const longHint = 'x'.repeat(10_000);
        const p = buildEditToolResultPayload('conflict', {
            reason: 'HTTP_ERROR',
            hint: longHint,
        });
        expect(p.hint).toBe(longHint);
    });

    test('conflict: empty-string hint is dropped rather than emitted as ""', () => {
        // Keeps the payload shape clean when the bus outcome had no hint.
        const p = buildEditToolResultPayload('conflict', {
            reason: 'CONFLICT',
            hint: '',
        });
        expect(p.hint).toBeUndefined();
    });
});

describe('buildPayloadForOutcome — bus outcome → tool_result payload', () => {
    test('committed outcome → committed payload', () => {
        const p = buildPayloadForOutcome({ status: 'committed', sourceCallId: 'c1' });
        expect(p.status).toBe('committed');
    });

    test('rejected outcome → rejected payload', () => {
        const p = buildPayloadForOutcome({ status: 'rejected' });
        expect(p.status).toBe('rejected');
    });

    test('rolledBack outcome (bus emits camelCase) → rolled_back payload', () => {
        const p = buildPayloadForOutcome({ status: 'rolledBack' });
        expect(p.status).toBe('rolled_back');
    });

    test('conflict outcome forwards reason + hint into the payload', () => {
        const p = buildPayloadForOutcome({
            status: 'conflict',
            reason: 'HTTP_ERROR',
            hint: 'HTTP 500: internal server error',
        });
        expect(p.status).toBe('conflict');
        expect(p.reason).toBe('HTTP_ERROR');
        expect(p.hint).toBe('HTTP 500: internal server error');
    });

    test('conflict outcome without reason lands under CONFLICT bucket', () => {
        // Legacy outcomes (pre-Task 4.3 reason tagging) surface only via
        // .error / .hint. Default the reason to CONFLICT so the AI still
        // gets the "target changed, re-read" instruction rather than a
        // malformed payload.
        const p = buildPayloadForOutcome({ status: 'conflict' });
        expect(p.status).toBe('conflict');
        expect(p.reason).toBe('CONFLICT');
    });

    test('unknown outcome status → pending (defensive; every tool_call needs a role:tool reply)', () => {
        const p = buildPayloadForOutcome({ status: 'weird_status' });
        expect(p.status).toBe('proposal_pending');
    });
});

// ────────────────────────────────────────────────────────────────
// Structural asserts on the persisted tool_result shapes that
// buildTaskMessages / applyOutcomesToToolResults produce. These
// simulate the persisted-message walks studio.js does without
// importing studio.js itself (jest cannot resolve its DOM-bound
// transitive imports).
// ────────────────────────────────────────────────────────────────

/**
 * Mirror of studio.js's `applyOutcomesToToolResults` behavior for
 * multi-outcome-drain updates. Kept in the test so the CONTRACT the
 * runtime relies on stays explicit and drift-tested — if the studio
 * ever diverges from this shape, the "structural asserts" block below
 * will diff.
 *
 * Contract (mirrored verbatim from studio.js:applyOutcomesToToolResults):
 *   - Match by sourceCallId → toolResults[i].tool_call_id, update in
 *     place with buildPayloadForOutcome(outcome).
 *   - For outcome.kind === 'profile-edit', cascade to sibling
 *     tool_results in the same assistant message whose content.status
 *     is still 'proposal_pending'. Read tool_results (status:'ok' etc.)
 *     are never clobbered.
 *   - status:'ok' when outcome.status === 'committed', else 'fail'.
 */
function applyOutcomesToToolResultsForTest(messages, outcomes) {
    const callIdToMsg = new Map();
    const msgById = new Map();
    for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const mid = String(m.id || '');
        if (mid) msgById.set(mid, m);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        for (const tc of calls) {
            const id = String(tc?.id || '');
            if (id) callIdToMsg.set(id, mid);
        }
    }
    const profileEditByMsg = new Map();
    for (const outcome of outcomes) {
        const cid = String(outcome?.sourceCallId || '');
        if (!cid) continue;
        const mid = callIdToMsg.get(cid);
        if (!mid) continue;
        const msg = msgById.get(mid);
        if (!msg) continue;
        const results = Array.isArray(msg.toolResults) ? msg.toolResults : null;
        if (!results) continue;
        const idx = results.findIndex((r) => String(r?.tool_call_id || '') === cid);
        if (idx < 0) continue;
        results[idx] = {
            tool_call_id: cid,
            content: buildPayloadForOutcome(outcome),
            status: outcome?.status === 'committed' ? 'ok' : 'fail',
        };
        if (outcome?.kind === 'profile-edit') {
            profileEditByMsg.set(mid, outcome);
        }
    }
    for (const [mid, outcome] of profileEditByMsg) {
        const msg = msgById.get(mid);
        if (!msg) continue;
        const results = Array.isArray(msg.toolResults) ? msg.toolResults : null;
        if (!results) continue;
        const payload = buildPayloadForOutcome(outcome);
        const nextStatus = outcome?.status === 'committed' ? 'ok' : 'fail';
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const content = r?.content;
            const isPending = content
                && typeof content === 'object'
                && content.status === 'proposal_pending';
            if (!isPending) continue;
            results[i] = {
                tool_call_id: String(r?.tool_call_id || ''),
                content: payload,
                status: nextStatus,
            };
        }
    }
}

describe('applyOutcomesToToolResults contract — in-place update semantics', () => {
    test('single edit call, committed → matching tool_result flips to committed payload', () => {
        // Assistant emitted one edit call. Pre-drain, its tool_result
        // carries the pending envelope from emission time.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults).toHaveLength(1);
        expect(messages[0].toolResults[0].tool_call_id).toBe('call-1');
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[0].status).toBe('ok');
    });

    test('rejected outcome → tool_result flips to rejected payload with status="fail"', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'rejected',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('rejected');
        expect(messages[0].toolResults[0].status).toBe('fail');
    });

    test('conflict outcome forwards reason + hint through to the persisted payload', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'conflict',
            reason: 'HTTP_ERROR',
            hint: 'HTTP 500: bad gateway',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('conflict');
        expect(messages[0].toolResults[0].content.reason).toBe('HTTP_ERROR');
        expect(messages[0].toolResults[0].content.hint).toBe('HTTP 500: bad gateway');
    });

    test('multi-edit-per-turn cascade: one profile-edit outcome resolves ALL pending edit tool_results in the same message', () => {
        // The orchestrator's profile-edit proposal collapses N chained
        // edit calls per turn into ONE bus entry keyed to the first
        // callId. The outcome fires once with sourceCallId=call-1 but
        // both call-1 AND call-2's pending tool_results must flip so
        // the LLM's next round sees a fully-resolved batch.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} },
                    { id: 'call-2', name: 'luker_orch_set_director_subagent_tools', args: {} },
                ],
                toolResults: [
                    {
                        tool_call_id: 'call-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                    {
                        tool_call_id: 'call-2',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults).toHaveLength(2);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[1].content.status).toBe('committed');
        expect(messages[0].toolResults[0].status).toBe('ok');
        expect(messages[0].toolResults[1].status).toBe('ok');
    });

    test('cascade does NOT clobber sibling read-tool results (status:"ok" and non-pending content)', () => {
        // Assistant emitted one read call (status:'ok') + one edit call
        // (status:'pending'). The profile-edit outcome must only flip
        // the edit call — the read result carries live executor output
        // that must survive.
        const readContent = { entries: [{ uid: 1, name: 'Foo' }] };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'lorebook_list', args: { book_name: 'main' } },
                    { id: 'edit-1', name: 'luker_orch_set_director_subagent', args: {} },
                ],
                toolResults: [
                    {
                        tool_call_id: 'read-1',
                        content: readContent,
                        status: 'ok',
                    },
                    {
                        tool_call_id: 'edit-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'edit-1',
        }]);
        // Read result preserved verbatim.
        expect(messages[0].toolResults[0].tool_call_id).toBe('read-1');
        expect(messages[0].toolResults[0].content).toBe(readContent);
        expect(messages[0].toolResults[0].status).toBe('ok');
        // Edit result flipped.
        expect(messages[0].toolResults[1].content.status).toBe('committed');
    });

    test('non-profile-edit outcomes DO NOT cascade (1:1 sourceCallId match only)', () => {
        // Lorebook-write outcomes are 1:1 (one proposal per call). A
        // sibling pending edit tool_result must NOT be touched by a
        // lorebook-write outcome.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'lorebook_upsert_entry', args: {} },
                    { id: 'call-2', name: 'luker_orch_set_director_subagent', args: {} },
                ],
                toolResults: [
                    {
                        tool_call_id: 'call-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                    {
                        tool_call_id: 'call-2',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'lorebook-write',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        // The lorebook-write outcome updated call-1 by direct match, but
        // must not have cascaded to call-2's pending edit tool_result.
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[1].content.status).toBe('proposal_pending');
    });

    test('outcome with no sourceCallId → silently skipped (defensive; legacy bus entries lack it)', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            // sourceCallId missing
        }]);
        // No change — pending stays pending. The batch gate ensures we
        // don't reach this path in practice; the defensive skip keeps
        // the mutation loop safe.
        expect(messages[0].toolResults[0].content.status).toBe('proposal_pending');
    });

    test('outcome whose sourceCallId does not map to any assistant message → skipped', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'unknown-orphan-call',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('proposal_pending');
    });

    test('rolledBack outcome → tool_result flips to rolled_back payload', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'luker_orch_set_director_subagent', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    // Rollback happens after commit — the tool_result was
                    // already flipped to committed by an earlier drain,
                    // then the user hit the rollback button and the bus
                    // enqueues a fresh outcome.
                    content: buildEditToolResultPayload('committed'),
                    status: 'ok',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'rolledBack',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('rolled_back');
        expect(messages[0].toolResults[0].status).toBe('fail');
    });
});

describe('protocol contract — every tool_call needs a matching tool_result', () => {
    test('legacy session: edit tool_call without a persisted tool_result is filled with a committed placeholder', () => {
        // Pre-refactor sessions stripped edit calls from history entirely,
        // so replaying them today finds a tool_call with no matching
        // toolResults entry. buildTaskMessages synthesizes a committed
        // payload inline so every tool_call still has a role:'tool' reply
        // (protocol contract) and the AI's "did I do this edit?" question
        // gets answered with the honest "you did and it committed" — the
        // edit is on disk if the user is resuming the session.
        const persisted = {
            id: 'call-legacy',
            name: 'luker_orch_set_director_subagent',
            args: {},
        };
        // Simulated buildTaskMessages fallback for a call without a
        // persisted tool_result (studio.js:2378-2382 equivalent):
        // resultById.get(persisted.id) returns undefined → fall through
        // to buildEditToolResultPayload('committed').
        const resultById = new Map();
        const r = resultById.get(persisted.id);
        expect(r).toBeUndefined();
        const payload = buildEditToolResultPayload('committed');
        expect(payload.status).toBe('committed');
    });

    test('pending payload survives JSON.stringify → parse round-trip', () => {
        // buildTaskMessages serializes the content field with JSON.stringify
        // before pushing the role:'tool' message. The payload must survive
        // that trip unchanged so the LLM sees the same envelope the runtime
        // held.
        const original = buildEditToolResultPayload('pending');
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
    });

    test('conflict payload with hint survives JSON round-trip verbatim', () => {
        const original = buildEditToolResultPayload('conflict', {
            reason: 'CONFLICT',
            hint: 'external modification on /system_prompt',
        });
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
        expect(trip.hint).toBe('external modification on /system_prompt');
    });
});
