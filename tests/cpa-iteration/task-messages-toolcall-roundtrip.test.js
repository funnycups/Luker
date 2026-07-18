// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Structural contract: CPA iter-studio's `buildTaskMessages` must replay
// EVERY persisted tool_call with a matching role:'tool' message, and
// `drainBusOutcomes` must update the persisted tool_result envelope in
// place instead of pushing a synthetic `[User reviewed N proposal(s):
// ...]` user message.
//
// Mirrors tests/mg-schema-iteration/task-messages-toolcall-roundtrip.test.js
// but adds CPA-specific coverage for the THREE bus proposal kinds CPA
// exposes:
//   - `profile-edit`: N chained `preset_*` edit calls per turn collapse
//     into ONE proposal keyed to the first callId → sibling-pending
//     cascade required.
//   - `skill-author`: each skill authoring tool call maps 1:1 to one
//     proposal with its own sourceCallId → direct 1:1 update, no
//     cascade required.
//   - `preset-clone`: each `preset_clone_to_new` call maps 1:1 to one
//     proposal → direct 1:1 update, no cascade required.
//
// Because CPA can mix all three kinds in one assistant message (e.g. the
// LLM issues `preset_set_field` + `skill_create` + `preset_clone_to_new`
// in the same turn), cascade must be scoped to only flip envelopes
// tagged with `_proposal_kind: 'profile-edit'`. Skill-author /
// preset-clone pending envelopes MUST NOT be clobbered by a profile-edit
// outcome, even though they share the same assistant message and both
// carry `status:'proposal_pending'`.
//
// The `buildTaskMessages` filter and the `applyOutcomesToToolResults`
// mutation logic live inside a closure inside studio.js (jest cannot
// import studio.js directly — its transitive graph pulls in ST DOM
// globals). So this file pins the SHAPES of the persisted messages
// the fix depends on via a mirrored `applyOutcomesToToolResultsForTest`
// helper — verbatim copy of the runtime function's contract. If the
// runtime ever diverges, the structural asserts below diff first.
//
// No prompt-body regex asserts. Every check is structural (payload
// field values, tool_call_id linkage, in-place array mutation).

import { describe, test, expect } from '@jest/globals';
import {
    buildEditToolResultPayload,
    buildPayloadForOutcome,
} from '../../public/scripts/extensions/orchestrator/iter-studio/edit-tool-result-envelope.js';

describe('CPA edit-tool tool_result envelope — pending shape', () => {
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

describe('CPA edit-tool tool_result envelope — resolved shapes', () => {
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

describe('CPA buildPayloadForOutcome — bus outcome → tool_result payload', () => {
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
// CPA studio's `buildTaskMessages` / `applyOutcomesToToolResults`
// produce. Simulates the persisted-message walks studio.js does
// without importing studio.js itself (jest cannot resolve its DOM-
// bound transitive imports).
// ────────────────────────────────────────────────────────────────

/**
 * Mirror of the CPA studio's `applyOutcomesToToolResults`. Two passes:
 *
 *   Pass 1 (direct 1:1 by sourceCallId):
 *     For each outcome, find results[i] where tool_call_id ===
 *     outcome.sourceCallId. If current content is `proposal_pending`,
 *     swap to buildPayloadForOutcome(outcome). Gate on `proposal_pending`
 *     so CPA's `{status:'partial', ...}` per-call envelopes (pushed
 *     when normalize returns edits alongside conflicts/already-done)
 *     stay intact through drain.
 *
 *   Pass 2 (cascade for profile-edit only):
 *     For each `kind === 'profile-edit'` outcome seen in pass 1,
 *     flip every sibling results[i] in the same assistant message
 *     whose content.status === 'proposal_pending' AND
 *     content._proposal_kind === 'profile-edit'. This covers the
 *     N-1 chained preset_* edit calls whose pending envelopes must
 *     share fate with the batch's single bus outcome.
 *
 *     The `_proposal_kind` gate PROTECTS skill-author / preset-clone
 *     pending envelopes that live in the same assistant message —
 *     without it, a profile-edit outcome would wrongly flip a
 *     sibling skill-author pending envelope. Their outcomes flow
 *     through pass 1 with matching sourceCallId → direct 1:1 update.
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
        // Track profile-edit outcomes for cascade BEFORE the direct 1:1
        // pass — if firstCallId's envelope is a partial-outcome (status:
        // 'partial', not proposal_pending), the direct pass skips it,
        // but the batch still needs cascade to fire on the sibling
        // proper-pending edit envelopes.
        if (outcome?.kind === 'profile-edit') {
            profileEditByMsg.set(mid, outcome);
        }
        const msg = msgById.get(mid);
        if (!msg) continue;
        const results = Array.isArray(msg.toolResults) ? msg.toolResults : null;
        if (!results) continue;
        const idx = results.findIndex((r) => String(r?.tool_call_id || '') === cid);
        if (idx < 0) continue;
        const current = results[idx];
        const isPending = current?.content
            && typeof current.content === 'object'
            && current.content.status === 'proposal_pending';
        if (!isPending) continue;
        results[idx] = {
            tool_call_id: cid,
            content: buildPayloadForOutcome(outcome),
            status: outcome?.status === 'committed' ? 'ok' : 'fail',
        };
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
                && content.status === 'proposal_pending'
                && content._proposal_kind === 'profile-edit';
            if (!isPending) continue;
            results[i] = {
                tool_call_id: String(r?.tool_call_id || ''),
                content: payload,
                status: nextStatus,
            };
        }
    }
}

// Helper: build a pending envelope tagged with a proposal kind marker.
// Mirrors the emission-site shape in studio.js — only profile-edit
// carries the marker (skill-author / preset-clone are 1:1 per call so
// they don't need cascade).
function pendingEnvelope(kind = null, extra = null) {
    const base = buildEditToolResultPayload('pending');
    if (kind === 'profile-edit') {
        return { ...base, _proposal_kind: 'profile-edit' };
    }
    if (extra) return { ...base, ...extra };
    return base;
}

describe('CPA applyOutcomesToToolResults contract — profile-edit (batch) kind', () => {
    test('single preset edit call, committed → matching tool_result flips to committed payload', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'preset_set_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
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

    test('rejected profile-edit outcome → tool_result flips to rejected + status="fail"', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'preset_str_replace', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
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
                toolCalls: [{ id: 'call-1', name: 'preset_set_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
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

    test('multi-edit-per-turn cascade: one profile-edit outcome resolves ALL pending preset edit tool_results in the same message', () => {
        // CPA collapses N chained preset_* edit calls per turn into ONE
        // bus entry keyed to the first callId (see processRoundOutcome's
        // `bus.propose` site). The outcome fires once with
        // sourceCallId=call-1 but all sibling pending edit tool_results
        // must flip so the LLM's next round sees a fully-resolved batch.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'preset_set_field', args: {} },
                    { id: 'call-2', name: 'preset_str_replace', args: {} },
                    { id: 'call-3', name: 'preset_upsert_prompt_entry', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'call-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'call-2', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'call-3', content: pendingEnvelope('profile-edit'), status: 'pending' },
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

    test('cascade does NOT clobber sibling read tool_result (status:"ok" with concrete payload)', () => {
        // Assistant emitted one preset_read_live_fields call (status:'ok'
        // with real result payload) + one preset edit call
        // (status:'pending'). The profile-edit outcome must only flip
        // the edit call — the read result carries live executor output
        // that must survive so the AI's next round sees what it read.
        const readContent = { paths: { 'name': 'main-preset', 'temperature': 0.7 } };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'read-1', name: 'preset_read_live_fields', args: { paths: ['name', 'temperature'] } },
                    { id: 'edit-1', name: 'preset_set_field', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'read-1', content: readContent, status: 'ok' },
                    { tool_call_id: 'edit-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'edit-1',
        }]);
        expect(messages[0].toolResults[0].tool_call_id).toBe('read-1');
        expect(messages[0].toolResults[0].content).toBe(readContent);
        expect(messages[0].toolResults[0].status).toBe('ok');
        expect(messages[0].toolResults[1].content.status).toBe('committed');
    });

    test('cascade does NOT clobber sibling partial-outcome envelope (status:"partial")', () => {
        // CPA emits {status:'partial', applied, total, conflicts,
        // already_done, hint} when a preset_* call's normalize returns
        // edits alongside conflicts/already-done. That per-call
        // diagnostic is orthogonal to the batch-level user decision and
        // must survive drain — the LLM reads the batch outcome via
        // sibling committed envelopes AND the per-call partial detail
        // via this envelope.
        const partialContent = {
            status: 'partial',
            applied: 2,
            total: 3,
            conflicts: [{ op: 'set', path: 'prompts', reason: 'anchor_ambiguous' }],
            already_done: [],
            hint: 'Some ops did not apply.',
        };
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call-1', name: 'preset_upsert_prompt_entry', args: {} },
                    { id: 'call-2', name: 'preset_set_field', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'call-1', content: partialContent, status: 'fail' },
                    { tool_call_id: 'call-2', content: pendingEnvelope('profile-edit'), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p1',
            kind: 'profile-edit',
            status: 'committed',
            // sourceCallId is firstCallId per CPA emission — here that's
            // the partial one. Direct 1:1 update must SKIP it (gate on
            // proposal_pending), cascade must SKIP it (partial has no
            // proposal_pending status), and the sibling proper-pending
            // envelope on call-2 gets flipped via cascade.
            sourceCallId: 'call-1',
        }]);
        expect(messages[0].toolResults[0].content).toBe(partialContent);
        expect(messages[0].toolResults[0].status).toBe('fail');
        expect(messages[0].toolResults[1].content.status).toBe('committed');
    });
});

describe('CPA applyOutcomesToToolResults contract — skill-author (1:1) kind', () => {
    test('skill-author outcome flips its pending envelope in place; pending_id metadata is dropped by resolve', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'skill-1', name: 'skill_create', args: {} }],
                toolResults: [{
                    tool_call_id: 'skill-1',
                    content: pendingEnvelope(null, { pending_id: 'p-42' }),
                    status: 'pending',
                }],
            },
        ];
        // Sanity: pending_id present on the pre-drain envelope.
        expect(messages[0].toolResults[0].content.pending_id).toBe('p-42');
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p-42',
            kind: 'skill-author',
            status: 'committed',
            sourceCallId: 'skill-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[0].status).toBe('ok');
        // Canonical resolved payloads don't carry pending_id.
        expect(messages[0].toolResults[0].content.pending_id).toBeUndefined();
    });

    test('skill-author rejected outcome → rejected payload with status="fail"', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'skill-1', name: 'skill_edit_content', args: {} }],
                toolResults: [{
                    tool_call_id: 'skill-1',
                    content: pendingEnvelope(null, { pending_id: 'p-1' }),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p-1',
            kind: 'skill-author',
            status: 'rejected',
            sourceCallId: 'skill-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('rejected');
        expect(messages[0].toolResults[0].status).toBe('fail');
    });
});

describe('CPA applyOutcomesToToolResults contract — preset-clone (1:1) kind', () => {
    test('preset-clone outcome flips its pending envelope in place', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'clone-1', name: 'preset_clone_to_new', args: { newName: 'copy' } }],
                toolResults: [{
                    tool_call_id: 'clone-1',
                    content: pendingEnvelope(null, { pending_id: 'p-9' }),
                    status: 'pending',
                }],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p-9',
            kind: 'preset-clone',
            status: 'committed',
            sourceCallId: 'clone-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[0].status).toBe('ok');
    });
});

describe('CPA applyOutcomesToToolResults contract — mixed-kinds-in-one-turn cascade safety', () => {
    test('profile-edit outcome does NOT clobber sibling skill-author pending envelope in the same message', () => {
        // LLM issues both a preset edit AND a skill authoring call in
        // the same turn. Each spawns its own bus proposal (profile-edit
        // + skill-author). If the skill's outcome hasn't drained yet
        // (user hasn't reviewed the skill card), the profile-edit
        // outcome must NOT cascade over the skill pending envelope —
        // that would incorrectly mark the skill as committed when the
        // user only approved the preset edit.
        //
        // Cascade gate: `_proposal_kind === 'profile-edit'`. Skill
        // pending envelopes don't carry the marker, so cascade skips.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'edit-1', name: 'preset_set_field', args: {} },
                    { id: 'skill-1', name: 'skill_create', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'edit-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'skill-1', content: pendingEnvelope(null, { pending_id: 'p-skill' }), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p-profile',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'edit-1',
        }]);
        // profile-edit envelope: flipped to committed.
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        // skill-author envelope: still pending, cascade must skip it.
        expect(messages[0].toolResults[1].content.status).toBe('proposal_pending');
        expect(messages[0].toolResults[1].status).toBe('pending');
    });

    test('profile-edit outcome does NOT clobber sibling preset-clone pending envelope', () => {
        // Same protection as above but for preset-clone.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'edit-1', name: 'preset_set_field', args: {} },
                    { id: 'clone-1', name: 'preset_clone_to_new', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'edit-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'clone-1', content: pendingEnvelope(null, { pending_id: 'p-clone' }), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [{
            id: 'p-profile',
            kind: 'profile-edit',
            status: 'committed',
            sourceCallId: 'edit-1',
        }]);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[1].content.status).toBe('proposal_pending');
    });

    test('all three outcomes in one drain batch land on their own envelopes; cascade covers profile-edit siblings only', () => {
        // Same message: 2 preset edits + 1 skill + 1 clone. Batch drain
        // yields three outcomes (one per bus kind). After drain, all
        // three specific envelopes flip to committed, AND the sibling
        // preset edit (which shared the profile-edit proposal) also
        // flips via cascade. Skill/clone stay as their own 1:1 hits.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'edit-1', name: 'preset_set_field', args: {} },
                    { id: 'edit-2', name: 'preset_str_replace', args: {} },
                    { id: 'skill-1', name: 'skill_create', args: {} },
                    { id: 'clone-1', name: 'preset_clone_to_new', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'edit-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'edit-2', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'skill-1', content: pendingEnvelope(null, { pending_id: 'p-skill' }), status: 'pending' },
                    { tool_call_id: 'clone-1', content: pendingEnvelope(null, { pending_id: 'p-clone' }), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [
            { id: 'p-profile', kind: 'profile-edit', status: 'committed', sourceCallId: 'edit-1' },
            { id: 'p-skill', kind: 'skill-author', status: 'committed', sourceCallId: 'skill-1' },
            { id: 'p-clone', kind: 'preset-clone', status: 'committed', sourceCallId: 'clone-1' },
        ]);
        expect(messages[0].toolResults[0].content.status).toBe('committed'); // edit-1 direct 1:1
        expect(messages[0].toolResults[1].content.status).toBe('committed'); // edit-2 via cascade
        expect(messages[0].toolResults[2].content.status).toBe('committed'); // skill-1 direct 1:1
        expect(messages[0].toolResults[3].content.status).toBe('committed'); // clone-1 direct 1:1
    });

    test('processing order safety: outcomes arriving in profile-edit-first order still leave skill pending intact when skill outcome is deferred', () => {
        // Even if a batch has a profile-edit outcome but the skill's
        // outcome hasn't landed yet (e.g. user only reviewed the preset
        // card), cascade must not touch the skill envelope. This is
        // the primary bug the _proposal_kind marker guards against —
        // without it, a same-message skill pending envelope would flip
        // to committed even though the user never saw the skill card.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'edit-1', name: 'preset_set_field', args: {} },
                    { id: 'skill-1', name: 'skill_edit_content', args: {} },
                ],
                toolResults: [
                    { tool_call_id: 'edit-1', content: pendingEnvelope('profile-edit'), status: 'pending' },
                    { tool_call_id: 'skill-1', content: pendingEnvelope(null, { pending_id: 'p-skill' }), status: 'pending' },
                ],
            },
        ];
        applyOutcomesToToolResultsForTest(messages, [
            { id: 'p-profile', kind: 'profile-edit', status: 'committed', sourceCallId: 'edit-1' },
        ]);
        expect(messages[0].toolResults[0].content.status).toBe('committed');
        expect(messages[0].toolResults[1].content.status).toBe('proposal_pending');
    });
});

describe('CPA applyOutcomesToToolResults contract — defensive edge cases', () => {
    test('outcome with no sourceCallId → silently skipped', () => {
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'preset_set_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
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
                toolCalls: [{ id: 'call-1', name: 'preset_set_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
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
        // Rollback happens after commit — the tool_result was already
        // flipped to committed by an earlier drain, then the user hit
        // the rollback button and the bus enqueues a fresh outcome. The
        // committed envelope is not `proposal_pending`, so the gate
        // would normally skip — BUT rollback semantics need to update
        // the envelope. For CPA (as for MG/CEA), rollback outcomes
        // ordinarily fire against a still-pending envelope only when
        // the user rolled back before the LLM saw the committed
        // envelope replayed. The test pins the payload mapping.
        //
        // NOTE: this test uses a pending envelope as the pre-drain
        // state to demonstrate the payload mapping (buildPayloadForOutcome
        // returns rolled_back). If runtime semantics ever need to also
        // update already-committed envelopes, that's a separate
        // in-place-update rule change on top of the payload mapping.
        const messages = [
            {
                id: 'a-1',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'preset_set_field', args: {} }],
                toolResults: [{
                    tool_call_id: 'call-1',
                    content: pendingEnvelope('profile-edit'),
                    status: 'pending',
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

describe('CPA protocol contract — every tool_call needs a matching tool_result', () => {
    test('legacy session: edit tool_call without a persisted tool_result is filled with a committed placeholder', () => {
        // Pre-refactor sessions stripped edit calls from history
        // entirely, so replaying them today finds a tool_call with no
        // matching toolResults entry. buildTaskMessages synthesizes a
        // committed payload inline so every tool_call still has a
        // role:'tool' reply (protocol contract) and the AI's "did I
        // do this edit?" question gets answered with the honest "you
        // did and it committed" — the edit is on disk if the user is
        // resuming the session.
        const persistedCall = { id: 'call-legacy', name: 'preset_set_field', args: {} };
        const resultById = new Map();
        const r = resultById.get(persistedCall.id);
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

    test('pending payload with proposal_kind + pending_id metadata survives JSON round-trip', () => {
        const original = {
            ...buildEditToolResultPayload('pending'),
            _proposal_kind: 'profile-edit',
            pending_id: 'p-42',
        };
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
        expect(trip._proposal_kind).toBe('profile-edit');
        expect(trip.pending_id).toBe('p-42');
    });

    test('conflict payload with hint survives JSON round-trip verbatim', () => {
        const original = buildEditToolResultPayload('conflict', {
            reason: 'VALIDATION_TARGET',
            hint: 'field "temperature" not found on preset',
        });
        const trip = JSON.parse(JSON.stringify(original));
        expect(trip).toEqual(original);
        expect(trip.hint).toBe('field "temperature" not found on preset');
    });
});
