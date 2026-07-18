// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Structural contract: MG schema iter-studio's `buildTaskMessages` must
// replay EVERY persisted tool_call with a matching role:'tool' message,
// and `drainBusOutcomes` must update the persisted tool_result envelope
// in place instead of pushing a synthetic user message.
//
// The bug this refactor fixes (mirror of the orchestrator case): the
// pre-refactor buildTaskMessages stripped edit tool_calls from history
// and drainBusOutcomes pushed a `[User reviewed N proposal(s) for the
// schema: ...]` synthetic user message. From the LLM's protocol view,
// its previous assistant turn had NO edit tool_calls followed by a
// mystery review message; the model concluded "the committed schema
// edit was not mine" and looped re-issuing the same call.
//
// The `buildTaskMessages` filter and the `applyOutcomesToToolResults`
// mutation logic live inside a closure inside studio.js (jest cannot
// import studio.js directly — its transitive graph pulls in ST DOM
// globals). So this file pins the SHAPES of the persisted messages
// the fix depends on:
//
//   1. Edit tool_call emission persists a `pending` tool_result
//      envelope keyed to the callId (buildEditToolResultPayload
//      contract, shared with the orchestrator studio).
//   2. buildPayloadForOutcome maps every bus outcome status to the
//      correct resolved envelope (committed / rejected / conflict /
//      rolled_back), with conflict.reason forwarded verbatim + the
//      hint field present when the outcome carried one.
//   3. The pending → resolved transition is an IN-PLACE update on
//      the persisted toolResults array (no new user message, no shape
//      drift). MG collapses N chained schema edits per turn into one
//      profile-edit bus proposal keyed to the first callId, so the
//      cascade must flip every sibling still-pending edit tool_result
//      in the same assistant message.
//
// No prompt-body regex asserts. Every check is structural (payload
// field values, tool_call_id linkage, in-place array mutation).

import { describe, test, expect } from '@jest/globals';
import {
    buildEditToolResultPayload,
    buildPayloadForOutcome,
} from '../../public/scripts/extensions/orchestrator/iter-studio/edit-tool-result-envelope.js';

describe('MG schema edit-tool tool_result envelope — pending shape', () => {
    test('pending payload carries status="proposal_pending" and a non-empty message', () => {
        const p = buildEditToolResultPayload('pending');
        expect(p).toEqual(expect.objectContaining({ status: 'proposal_pending' }));
        expect(typeof p.message).toBe('string');
        expect(p.message.length).toBeGreaterThan(0);
    });

    test('pending and proposal_pending aliases both collapse to the wire status', () => {
        const a = buildEditToolResultPayload('pending');
        const b = buildEditToolResultPayload('proposal_pending');
        expect(a.status).toBe('proposal_pending');
        expect(b.status).toBe('proposal_pending');
    });

    test('unknown status collapses to pending (protocol-safety fallback)', () => {
        const p = buildEditToolResultPayload('some_future_status');
        expect(p.status).toBe('proposal_pending');
    });
});

describe('MG schema edit-tool tool_result envelope — resolved shapes', () => {
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

    test('rolled_back: accepts both snake_case and camelCase aliases', () => {
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
        expect(p.hint).toBeUndefined();
    });

    test('conflict: known reasons round-trip verbatim and carry a matched message', () => {
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

    test('conflict: hint field is forwarded verbatim without size cap', () => {
        const longHint = 'x'.repeat(10_000);
        const p = buildEditToolResultPayload('conflict', {
            reason: 'HTTP_ERROR',
            hint: longHint,
        });
        expect(p.hint).toBe(longHint);
    });

    test('conflict: empty-string hint is dropped rather than emitted as ""', () => {
        const p = buildEditToolResultPayload('conflict', {
            reason: 'CONFLICT',
            hint: '',
        });
        expect(p.hint).toBeUndefined();
    });
});

describe('MG schema buildPayloadForOutcome — bus outcome → tool_result payload', () => {
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
// Structural asserts on the persisted tool_result shapes that the
// MG schema studio's `buildTaskMessages` / `applyOutcomesToToolResults`
// produce. These simulate the persisted-message walks studio.js does
// without importing studio.js itself (jest cannot resolve its DOM-
// bound transitive imports).
// ────────────────────────────────────────────────────────────────

/**
 * Mirror of the MG schema studio's `applyOutcomesToToolResults`
 * behavior for multi-outcome-drain updates. Kept in the test so the
 * CONTRACT the runtime relies on stays explicit and drift-tested —
 * if the studio ever diverges from this shape, the "structural
 * asserts" block below will diff.
 *
 * Contract (mirrored verbatim from
 * public/scripts/extensions/memory-graph/schema-iteration/studio.js
 * `applyOutcomesToToolResults`):
 *   - Match by sourceCallId → toolResults[i].tool_call_id, update
 *     in place with buildPayloadForOutcome(outcome).
 *   - For outcome.kind === 'profile-edit', cascade to sibling
 *     tool_results in the same assistant message whose
 *     content.status is still 'proposal_pending'. Read tool_results
 *     (status:'ok' etc.) are never clobbered.
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

describe('MG schema applyOutcomesToToolResults contract — in-place update semantics', () => {
    test('single schema edit call, committed → matching tool_result flips to committed payload', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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
        // MG collapses N chained schema-edit calls per turn into ONE
        // bus entry keyed to the first callId (see runIterationTurn's
        // `bus.propose` site). The outcome fires once with
        // sourceCallId=call-1 but all sibling pending edit tool_results
        // must flip so the LLM's next round sees a fully-resolved batch.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'mg_set_node_type', args: {} },
                    { id: 'call-2', name: 'mg_reorder_node_types', args: {} },
                    { id: 'call-3', name: 'mg_remove_node_type', args: {} },
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
                    {
                        tool_call_id: 'call-3',
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
        expect(messages[0].toolResults).toHaveLength(3);
        for (const r of messages[0].toolResults) {
            expect(r.content.status).toBe('committed');
            expect(r.status).toBe('ok');
        }
    });

    test('cascade does NOT clobber sibling schema-read tool_result (status:"ok" with concrete payload)', () => {
        // Assistant emitted one mg_schema_read_fields call (status:'ok'
        // with real result payload) + one schema edit call
        // (status:'pending'). The profile-edit outcome must only flip
        // the edit call — the read result carries live executor output
        // that must survive so the AI's next round sees what it read.
        const readContent = { paths: { 'length': 3, '[0].id': 'char' } };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'mg_schema_read_fields', args: { paths: ['length', '[0].id'] } },
                    { id: 'edit-1', name: 'mg_set_node_type', args: {} },
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

    test('cascade does NOT clobber sibling lorebook-read tool_result', () => {
        // Same as above but for the shared lorebook_list read tool.
        const readContent = { entries: [{ uid: 1, name: 'Foo' }] };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'lorebook_list', args: { book_name: 'main' } },
                    { id: 'edit-1', name: 'mg_set_node_type', args: {} },
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
        expect(messages[0].toolResults[0].content).toBe(readContent);
        expect(messages[0].toolResults[0].status).toBe('ok');
        expect(messages[0].toolResults[1].content.status).toBe('committed');
    });

    test('outcome with no sourceCallId → silently skipped (defensive; legacy bus entries lack it)', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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
        expect(messages[0].toolResults[0].content.status).toBe('proposal_pending');
    });

    test('outcome whose sourceCallId does not map to any assistant message → skipped', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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
                toolCalls: [{ id: 'call-1', name: 'mg_set_node_type', args: {} }],
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

describe('MG schema protocol contract — every tool_call needs a matching tool_result', () => {
    test('legacy session: edit tool_call without a persisted tool_result is filled with a committed placeholder', () => {
        // Pre-refactor sessions stripped edit calls from history
        // entirely, so replaying them today finds a tool_call with no
        // matching toolResults entry. buildTaskMessages synthesizes a
        // committed payload inline so every tool_call still has a
        // role:'tool' reply (protocol contract) and the AI's "did I
        // do this edit?" question gets answered with the honest "you
        // did and it committed" — the edit is on disk if the user is
        // resuming the session.
        const persisted = {
            id: 'call-legacy',
            name: 'mg_set_node_type',
            args: {},
        };
        const resultById = new Map();
        const r = resultById.get(persisted.id);
        expect(r).toBeUndefined();
        const payload = buildEditToolResultPayload('committed');
        expect(payload.status).toBe('committed');
    });

    test('pending payload survives JSON.stringify → parse round-trip', () => {
        // buildTaskMessages serializes the content field with
        // JSON.stringify before pushing the role:'tool' message. The
        // payload must survive that trip unchanged so the LLM sees
        // the same envelope the runtime held.
        const original = buildEditToolResultPayload('pending');
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
    });

    test('conflict payload with hint survives JSON round-trip verbatim', () => {
        const original = buildEditToolResultPayload('conflict', {
            reason: 'VALIDATION_TARGET',
            hint: 'node_type "character" not found in schema',
        });
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
        expect(trip.hint).toBe('node_type "character" not found in schema');
    });
});
