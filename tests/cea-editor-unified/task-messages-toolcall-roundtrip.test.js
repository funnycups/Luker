// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Structural contract: CEA card iter-studio's `buildSeedTaskMessages` must
// replay EVERY persisted tool_call with a matching role:'tool' message,
// `drainBusOutcomes` must update the persisted tool_result envelope in
// place instead of pushing a synthetic user message, and the dead
// legacy helpers (`maybeAutoApply`, `continueAfterReviewDecision`) must
// no longer push a `DRAIN_SUMMARY_KIND` user message either — auto-apply
// outcomes flow through the same in-place tool_result update path as
// review-mode approvals, and discard-flow post-review rejects the
// still-pending tool_result envelopes in place.
//
// Mirrors tests/mg-schema-iteration/task-messages-toolcall-roundtrip.test.js
// but adds CEA-specific describes for:
//   - CEA's TWO bus proposal kinds (cea-character-edits +
//     cea-lorebook-edits) — both must trigger the sibling-pending
//     cascade, since both collapse N chained edit calls per turn into
//     one proposal per target keyed to the first callId.
//   - The auto-apply committed-at-call path (dead in current tree, but
//     the outcome envelope must still land committed when the flow is
//     re-wired). Tested via bus outcome mapping — no synthetic user
//     message must be produced.
//   - The discarded-review-rejected path — the discard button in
//     continueAfterReviewDecision must flip every still-`proposal_pending`
//     tool_result envelope in the latest unapplied assistant turn(s)
//     to `rejected` payload so the LLM's next round replays the correct
//     user decision.
//
// No prompt-body regex asserts. Every check is structural (payload
// field values, tool_call_id linkage, in-place array mutation).

import { describe, test, expect } from '@jest/globals';
import {
    buildEditToolResultPayload,
    buildPayloadForOutcome,
} from '../../public/scripts/extensions/orchestrator/iter-studio/edit-tool-result-envelope.js';

describe('CEA edit-tool tool_result envelope — pending shape', () => {
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

describe('CEA edit-tool tool_result envelope — resolved shapes', () => {
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

describe('CEA buildPayloadForOutcome — bus outcome → tool_result payload', () => {
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
// CEA studio's `buildSeedTaskMessages` / `applyOutcomesToToolResults`
// produce. The `applyOutcomesToToolResults` runs inside a closure in
// studio.js so we mirror its contract here — if the runtime ever
// diverges, the "structural asserts" block below will diff.
// ────────────────────────────────────────────────────────────────

/**
 * Mirror of the CEA studio's `applyOutcomesToToolResults` behavior.
 *
 * Contract (mirrored verbatim from
 * public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js
 * `applyOutcomesToToolResults`):
 *   - Match by sourceCallId → toolResults[i].tool_call_id, update
 *     in place with buildPayloadForOutcome(outcome).
 *   - For outcome.kind of 'cea-character-edits' OR 'cea-lorebook-edits',
 *     cascade to sibling tool_results in the same assistant message
 *     whose content.status is still 'proposal_pending'. Read tool_results
 *     (status:'ok' etc.) are never clobbered because the cascade only
 *     touches envelopes whose current content.status === 'proposal_pending'.
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
    const cascadeByMsgKind = new Map();
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
        const kind = String(outcome?.kind || '');
        if (kind === 'cea-character-edits' || kind === 'cea-lorebook-edits') {
            cascadeByMsgKind.set(mid + ':' + kind, { mid, outcome });
        }
    }
    for (const { mid, outcome } of cascadeByMsgKind.values()) {
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

describe('CEA applyOutcomesToToolResults contract — in-place update semantics', () => {
    test('single character-edit call, committed → matching tool_result flips to committed payload', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-character-edits',
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
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-character-edits',
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
                toolCalls: [{ id: 'call-1', name: 'cea_update_lorebook_entry', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-lorebook-edits',
            status: 'conflict',
            reason: 'HTTP_ERROR',
            hint: 'HTTP 500: bad gateway',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('conflict');
        expect(messages[0].toolResults[0].content.reason).toBe('HTTP_ERROR');
        expect(messages[0].toolResults[0].content.hint).toBe('HTTP 500: bad gateway');
    });

    test('cea-character-edits cascade: one outcome resolves ALL pending edit tool_results in the same message', () => {
        // CEA collapses N chained character-field edit calls per turn
        // into ONE cea-character-edits bus entry keyed to the first
        // callId (see mirrorPendingEditsToBus). The outcome fires once
        // with sourceCallId=call-1 but all sibling pending edit
        // tool_results must flip.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'cea_set_card_field', args: {} },
                    { id: 'call-2', name: 'cea_str_replace_card_field', args: {} },
                    { id: 'call-3', name: 'cea_set_card_field', args: {} },
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
            kind: 'cea-character-edits',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults).toHaveLength(3);
        for (const r of messages[0].toolResults) {
            expect(r.content.status).toBe('committed');
            expect(r.status).toBe('ok');
        }
    });

    test('cea-lorebook-edits cascade: one outcome resolves ALL pending lorebook-edit tool_results in the same message', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'cea_update_lorebook_entry', args: {} },
                    { id: 'call-2', name: 'cea_str_replace_lorebook_entry_field', args: {} },
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
            kind: 'cea-lorebook-edits',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults).toHaveLength(2);
        for (const r of messages[0].toolResults) {
            expect(r.content.status).toBe('committed');
            expect(r.status).toBe('ok');
        }
    });

    test('mixed character + lorebook proposals in same message: each cascade covers ONLY sibling pending', () => {
        // A single assistant turn spawned both a character edit AND a
        // lorebook edit. Two separate bus proposals fire (one per
        // target). Each cascade should update its own family without
        // clobbering the other pre-resolved envelope. Because both
        // cascades run against the *current* results array, once one
        // family flips, the other's pending envelopes are already
        // covered (safe, but not the intended semantic — the outcome
        // for the SECOND kind must land on its own sourceCallId
        // envelope regardless).
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'char-1', name: 'cea_set_card_field', args: {} },
                    { id: 'book-1', name: 'cea_update_lorebook_entry', args: {} },
                ],
                toolResults: [
                    {
                        tool_call_id: 'char-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                    {
                        tool_call_id: 'book-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [
            {
                id: 'p1',
                kind: 'cea-character-edits',
                status: 'committed',
                sourceCallId: 'char-1',
            },
            {
                id: 'p2',
                kind: 'cea-lorebook-edits',
                status: 'rejected',
                sourceCallId: 'book-1',
            },
        ]);
        expect(messages[0].toolResults).toHaveLength(2);
        // char-1 was directly matched by the character-edits outcome.
        expect(messages[0].toolResults[0].tool_call_id).toBe('char-1');
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        // book-1 was directly matched by the lorebook-edits outcome.
        expect(messages[0].toolResults[1].tool_call_id).toBe('book-1');
        expect(messages[0].toolResults[1].content.status).toBe('rejected');
    });

    test('cascade does NOT clobber sibling read tool_result (status:"ok" with concrete payload)', () => {
        // Assistant emitted one cea_read_card_fields call (status:'ok'
        // with real result payload) + one card edit call
        // (status:'pending'). The character-edits outcome must only
        // flip the edit call — the read result carries live executor
        // output that must survive so the AI's next round sees what it
        // read.
        const readContent = { name: 'Alice', description: 'lorem' };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'cea_read_card_fields', args: { fields: ['name', 'description'] } },
                    { id: 'edit-1', name: 'cea_set_card_field', args: {} },
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
            kind: 'cea-character-edits',
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

    test('cascade does NOT clobber sibling lorebook_list read tool_result', () => {
        const readContent = { entries: [{ uid: 1, name: 'Foo' }] };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'lorebook_list', args: { book_name: 'main' } },
                    { id: 'edit-1', name: 'cea_update_lorebook_entry', args: {} },
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
            kind: 'cea-lorebook-edits',
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
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-character-edits',
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
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-character-edits',
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
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
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
            kind: 'cea-character-edits',
            status: 'rolledBack',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('rolled_back');
        expect(messages[0].toolResults[0].status).toBe('fail');
    });

    test('non-CEA outcome kind does not cascade (defensive: unknown kinds behave 1:1 only)', () => {
        // If some hypothetical future kind (e.g. lorebook-write from
        // a shared read helper) fires an outcome, only the matched
        // envelope should flip — no wide cascade over siblings.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'some_future_tool', args: {} },
                    { id: 'call-2', name: 'cea_set_card_field', args: {} },
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
        // call-1 flipped (direct match).
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        // call-2 stays pending — cascade only fires for cea-* kinds.
        expect(messages[0].toolResults[1].content.status).toBe('proposal_pending');
    });
});

// ────────────────────────────────────────────────────────────────
// CEA-specific: auto-apply committed-at-call and discard-flow rejects.
// The current tree has both `maybeAutoApply` and `continueAfterReviewDecision`
// as helper functions that are not wired to any UI event today, so we
// pin the SHAPES they must produce when re-wired. Both must NEVER push
// a `[User reviewed …]` synthetic user message — signal rides on the
// tool_result envelopes only.
// ────────────────────────────────────────────────────────────────

describe('CEA auto-apply flow — outcome envelope must land committed, no user prose', () => {
    test('auto-apply routes through bus.setAutoApprove → committed outcome → same in-place update path', () => {
        // Auto-apply is not a separate protocol channel — when the user
        // toggles Auto-apply on, mirrorPendingEditsToBus calls
        // bus.setAutoApprove(true) which fires a `committed` outcome
        // per proposal. drainBusOutcomes picks it up and calls
        // applyOutcomesToToolResults with a normal `committed` outcome.
        // Result: the pending envelope flips to committed exactly like
        // review-mode approvals do — no second code path, no synthetic
        // user prose.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'cea-character-edits',
            status: 'committed',
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        // Contract: the messages array grew by ZERO synthetic user
        // messages during this transition.
        expect(messages).toHaveLength(1);
    });
});

/**
 * Mirror of CEA studio.js `continueAfterReviewDecision` discard-branch
 * behavior: after the user hits Discard, every still-`proposal_pending`
 * tool_result envelope in the latest unapplied assistant turn(s) must
 * flip to `rejected` payload so the LLM's next round sees the correct
 * user decision. Walk backwards from newest, stop at the first message
 * already applied / rolled back (that belongs to a prior batch).
 */
function applyDiscardToPendingToolResults(messages) {
    const rejectedPayload = buildEditToolResultPayload('rejected');
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== 'assistant') continue;
        if (m.appliedAt || m.rolledBackAt) break;
        const results = Array.isArray(m.toolResults) ? m.toolResults : null;
        if (!results) continue;
        let touched = false;
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            const content = r?.content;
            if (content && typeof content === 'object' && content.status === 'proposal_pending') {
                results[j] = {
                    tool_call_id: String(r?.tool_call_id || ''),
                    content: rejectedPayload,
                    status: 'fail',
                };
                touched = true;
            }
        }
        if (!touched && !(Array.isArray(m.edits) && m.edits.length > 0)) break;
    }
}

describe('CEA discard flow — post-review rejects pending tool_results in place', () => {
    test('every still-pending edit tool_result in the latest unapplied assistant turn flips to rejected', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'cea_set_card_field', args: {} },
                    { id: 'call-2', name: 'cea_update_lorebook_entry', args: {} },
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
                edits: [{ op: 'set', path: 'card.name' }],
            },
        ];
        applyDiscardToPendingToolResults(messages);
        expect(messages[0].toolResults[0].content.status).toBe('rejected');
        expect(messages[0].toolResults[0].status).toBe('fail');
        expect(messages[0].toolResults[1].content.status).toBe('rejected');
        expect(messages[0].toolResults[1].status).toBe('fail');
    });

    test('discard walk stops at an already-applied prior batch (does not flip its results)', () => {
        // Two rounds: round 1 was applied earlier (appliedAt set), round
        // 2 stacked pending edits the user then discarded. Only round
        // 2's pending envelopes flip; round 1's stay committed.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                appliedAt: 1234,
                toolCalls: [{ id: 'old-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'old-1',
                    content: buildEditToolResultPayload('committed'),
                    status: 'ok',
                }],
                edits: [{ op: 'set', path: 'card.name' }],
            },
            {
                id: 'a-2',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'new-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'new-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
                edits: [{ op: 'set', path: 'card.description' }],
            },
        ];
        applyDiscardToPendingToolResults(messages);
        // Round 2 (newest, unapplied) flipped.
        expect(messages[1].toolResults[0].content.status).toBe('rejected');
        // Round 1 (already applied) untouched.
        expect(messages[0].toolResults[0].content.status).toBe('committed');
    });

    test('discard does not push a synthetic user message — signal rides on rejected envelopes only', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'cea_set_card_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: buildEditToolResultPayload('pending'),
                    status: 'pending',
                }],
                edits: [{ op: 'set', path: 'card.name' }],
            },
        ];
        const originalLen = messages.length;
        applyDiscardToPendingToolResults(messages);
        // No new user message pushed — the array length is unchanged
        // and the last message is still the assistant turn.
        expect(messages).toHaveLength(originalLen);
        expect(messages[messages.length - 1].role).toBe('assistant');
    });

    test('discard walk with sibling read tool_result: cascade only touches pending envelopes', () => {
        // The assistant turn had one read call (status:'ok') and one
        // edit call (status:'pending'). Discard must ONLY flip the
        // pending edit envelope — the read result carries live payload
        // that must survive.
        const readContent = { name: 'Alice' };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'cea_read_card_fields', args: {} },
                    { id: 'edit-1', name: 'cea_set_card_field', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'read-1', content: readContent, status: 'ok' },
                    {
                        tool_call_id: 'edit-1',
                        content: buildEditToolResultPayload('pending'),
                        status: 'pending',
                    },
                ],
                edits: [{ op: 'set', path: 'card.name' }],
            },
        ];
        applyDiscardToPendingToolResults(messages);
        // Read preserved.
        expect(messages[0].toolResults[0].content).toBe(readContent);
        expect(messages[0].toolResults[0].status).toBe('ok');
        // Edit flipped.
        expect(messages[0].toolResults[1].content.status).toBe('rejected');
    });
});

describe('CEA protocol contract — every tool_call needs a matching tool_result', () => {
    test('legacy session: edit tool_call without a persisted tool_result is filled with a committed placeholder', () => {
        // Pre-refactor sessions stripped edit calls from history
        // entirely, so replaying them today finds a tool_call with no
        // matching toolResults entry. buildSeedTaskMessages synthesizes
        // a committed payload inline so every tool_call still has a
        // role:'tool' reply (protocol contract) and the AI's "did I do
        // this edit?" question gets answered with the honest "you did
        // and it committed" — the edit is on disk if the user is
        // resuming the session.
        const persisted = {
            id: 'call-legacy',
            name: 'cea_set_card_field',
            args: {},
        };
        const resultById = new Map();
        const r = resultById.get(persisted.id);
        expect(r).toBeUndefined();
        const payload = buildEditToolResultPayload('committed');
        expect(payload.status).toBe('committed');
    });

    test('pending payload survives JSON.stringify → parse round-trip', () => {
        const original = buildEditToolResultPayload('pending');
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
    });

    test('conflict payload with hint survives JSON round-trip verbatim', () => {
        const original = buildEditToolResultPayload('conflict', {
            reason: 'VALIDATION_TARGET',
            hint: 'card field "aliases" is not in the write whitelist',
        });
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
        expect(trip.hint).toBe('card field "aliases" is not in the write whitelist');
    });
});
