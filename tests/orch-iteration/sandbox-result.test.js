// tests/orch-iteration/sandbox-result.test.js
//
// Unit coverage for `interpretSandboxOutcome`, the decision helper that
// lives between `normalizeToolCallToEditInline` (orchestrator iter-studio
// sandbox runner) and the iter-studio editToolResults push site.
//
// Background bug:
//   The sandbox runner used to throw away the executor's return value and
//   only diff the before/after working profile. Any tool call that the
//   executor rejected without mutating workingProfile (e.g.
//   `luker_orch_patch_loop_system_prompt` with an oldString anchor that
//   isn't present in the current system prompt) was indistinguishable
//   from a genuine "already matches" outcome. The iter-studio then
//   reported a misleading "likely already matches" noop instead of the
//   real `{ok:false, error:'not_found', detail:'...'}` envelope the
//   executor had produced, so the AI thought it had already succeeded
//   and never retried with a corrected anchor.
//
// This file pins the decision contract so that:
//   - genuine no-mutation calls with NO executor failure still emit
//     a benign "noop" outcome (current AI hint);
//   - calls whose executor returned `{ok:false, ...}` propagate the
//     full executor payload as a failure outcome so the iter-studio
//     can surface error / detail back to the model.

import { describe, test, expect } from '@jest/globals';
import {
    interpretSandboxOutcome,
    buildEditCallReply,
} from '../../public/scripts/extensions/orchestrator/iter-studio/sandbox-result.js';

const sampleProfile = Object.freeze({
    system_prompt: 'You are a careful planner.\nFollow the user.',
    apiPresetName: '',
    promptPresetName: '',
    max_rounds: 0,
    wall_clock_budget_ms: 0,
    tools: { finalize: true },
});

function freshProfile() {
    return JSON.parse(JSON.stringify(sampleProfile));
}

describe('interpretSandboxOutcome — orchestrator iter-studio sandbox decision', () => {
    test('emits an edits outcome when before differs from after', () => {
        const before = freshProfile();
        const after = freshProfile();
        after.system_prompt = 'You are a careful planner.\nFollow the user closely.';
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_1',
                content: JSON.stringify({
                    ok: true,
                    changed: true,
                    action: 'Loop system prompt patched.',
                }),
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('edits');
    });

    test('emits a failure outcome carrying the executor envelope when the executor reported ok:false', () => {
        // This is the original bug scenario: an anchor-based patch tool
        // whose oldString isn't present in the current system prompt.
        // The executor returns ok:false WITHOUT mutating workingProfile,
        // so before === after.
        const before = freshProfile();
        const after = freshProfile();
        const failurePayload = {
            ok: false,
            error: 'not_found',
            detail: 'oldString not present in the current text',
            action: 'Loop system-prompt patch failed: not_found.',
        };
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_anchor_miss',
                content: JSON.stringify(failurePayload),
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('failure');
        // The full payload must be exposed so the caller can serialize it
        // into the role:'tool' reply the runner replays next round.
        expect(outcome.content).toMatchObject({
            ok: false,
            error: 'not_found',
            detail: 'oldString not present in the current text',
        });
    });

    test('parses executor content even when it is already an object (no JSON layer)', () => {
        // The orchestrator's pushToolResult serializes to a string, but
        // some sibling executors leave the payload as an object. The
        // helper must accept both so the decision is uniform.
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_x',
                content: {
                    ok: false,
                    error: 'multiple_matches',
                    detail: 'oldString is not unique in the current text.',
                },
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('failure');
        expect(outcome.content.error).toBe('multiple_matches');
    });

    test('emits the generic noop outcome when before equals after AND executor reported ok:true', () => {
        // True "already matches" case: the executor accepted the call,
        // but the patch produced no profile change (e.g. set_field
        // overwriting with the same value). The misleading "likely
        // already matches" hint is *correct* in this case.
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_noop',
                content: JSON.stringify({
                    ok: true,
                    changed: false,
                    action: 'Loop profile patch produced no changes.',
                }),
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('noop');
    });

    test('emits noop when the executor produced no toolResults entry (defensive default)', () => {
        // Some unknown tool that the executor silently ignored. The
        // safest interpretation is still "no change happened" — but it
        // should NOT misrepresent that as a known anchor failure.
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = { toolResults: [] };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('noop');
    });

    test('emits failure outcome when before equals after AND any of multiple executor results reported ok:false', () => {
        // Belt-and-braces: even if a future executor pushes several tool
        // results, the helper treats any ok:false among them as a
        // failure signal (matches the iter-studio contract that one tool
        // call's outcome is one toolResult, but tolerates batched
        // executors).
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = {
            toolResults: [
                { tool_call_id: 'a', content: JSON.stringify({ ok: true, changed: false }) },
                {
                    tool_call_id: 'b',
                    content: JSON.stringify({ ok: false, error: 'invalid_args', detail: 'oldString missing' }),
                },
            ],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('failure');
        expect(outcome.content.error).toBe('invalid_args');
    });

    test('exposes the executor envelope reason on failure outcome when present', () => {
        // Newer executors carry a state-error reason
        // (VALIDATION_TARGET / CONFLICT / HTTP_ERROR / TRANSPORT_ERROR /…)
        // alongside the legacy `error` field. The helper surfaces it on
        // the outcome so downstream classifiers can route on the enum
        // rather than re-parsing `failure.error`.
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_reason',
                content: JSON.stringify({
                    ok: false,
                    reason: 'VALIDATION_TARGET',
                    error: 'not_found',
                    detail: 'anchor missing',
                }),
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('failure');
        expect(outcome.reason).toBe('VALIDATION_TARGET');
        expect(outcome.content.error).toBe('not_found');
    });

    test('failure outcome reason is null when the executor envelope omits it (backwards compat)', () => {
        // Older executors that emit only `{ok:false, error, detail}`
        // must still land on a failure outcome — the helper just leaves
        // `reason` as null instead of inventing one. The verbatim
        // payload is forwarded so downstream still sees the legacy
        // shape unchanged.
        const before = freshProfile();
        const after = freshProfile();
        const executorResult = {
            toolResults: [{
                tool_call_id: 'call_legacy',
                content: JSON.stringify({
                    ok: false,
                    error: 'not_found',
                    detail: 'oldString missing',
                }),
            }],
        };
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        expect(outcome.kind).toBe('failure');
        expect(outcome.reason).toBeNull();
        expect(outcome.content.error).toBe('not_found');
    });
});

describe('buildEditCallReply — outcome → iter-studio per-call push shape', () => {
    test('edits outcome → no toolResult, edits forwarded, chain advanced to the last edit\'s newValue', () => {
        const newProfile = { system_prompt: 'next', tools: { finalize: true } };
        const outcome = {
            kind: 'edits',
            edits: [{
                op: 'set',
                path: '',
                oldValue: { system_prompt: 'prev' },
                newValue: newProfile,
            }],
        };
        const reply = buildEditCallReply({ outcome, callId: 'call_1' });
        expect(reply.edits).toEqual(outcome.edits);
        expect(reply.toolResult).toBeNull();
        // The next edit-tool call in this round must see the post-mutation
        // profile as its baseline. Without chain advance, two consecutive
        // edit tools would each diff against the original profile and
        // the second would clobber the first's mutations.
        expect(reply.chainAdvanceTo).toBe(newProfile);
    });

    test('failure outcome → toolResult forwards the executor envelope verbatim, NOT the generic noop prose', () => {
        // This is the regression that the original bug surfaced: when the
        // executor reported `{ok:false, error:'not_found', detail:'...'}`
        // the iter-studio used to push a hardcoded "likely already
        // matches" message and discarded the executor's actual error.
        // The next round's model never learned that its anchor missed,
        // so it gave up instead of retrying with a corrected anchor.
        const executorEnvelope = {
            ok: false,
            error: 'not_found',
            detail: 'oldString not present in the current text',
            action: 'Loop system-prompt patch failed: not_found.',
        };
        const reply = buildEditCallReply({
            outcome: { kind: 'failure', content: executorEnvelope },
            callId: 'call_anchor_miss',
        });
        expect(reply.edits).toEqual([]);
        // The envelope fields are forwarded verbatim; the branch fills in
        // `reason` / `hint` from the fallback chain so downstream
        // classifiers always see a routable enum value and an actionable
        // hint, even when the executor only emitted the legacy
        // `{ok:false, error, detail}` shape.
        expect(reply.toolResult.tool_call_id).toBe('call_anchor_miss');
        expect(reply.toolResult.status).toBe('fail');
        expect(reply.toolResult.content).toMatchObject(executorEnvelope);
        // The chain does NOT advance: the failed call left the working
        // profile untouched, so subsequent edit tools in this round must
        // still see `chainedBefore` as their baseline.
        expect(reply.chainAdvanceTo).toBeUndefined();
        // The forwarded content must contain the actual error code — NOT
        // the misleading "likely already matches" hint.
        expect(reply.toolResult.content.error).toBe('not_found');
        expect(JSON.stringify(reply.toolResult.content)).not.toMatch(/likely/);
    });

    test('throw outcome → toolResult carries the executor exception in a TRANSPORT_ERROR envelope', () => {
        // Sandbox executor blew up before the call could complete. The
        // envelope shape (ok:false, reason, hint) matches the failure
        // and noop branches so the next round's role:'tool' reply is
        // uniform; the `error` field preserves the exception message for
        // anything that inspected the raw text.
        const reply = buildEditCallReply({
            outcome: { kind: 'throw', error: new Error('boom') },
            callId: 'call_throw',
        });
        expect(reply.edits).toEqual([]);
        expect(reply.toolResult.tool_call_id).toBe('call_throw');
        expect(reply.toolResult.status).toBe('fail');
        expect(reply.toolResult.content.ok).toBe(false);
        expect(reply.toolResult.content.reason).toBe('TRANSPORT_ERROR');
        expect(reply.toolResult.content.error).toBe('boom');
        expect(reply.toolResult.content.hint).toBeDefined();
        expect(reply.chainAdvanceTo).toBeUndefined();
    });

    test('throw outcome with a non-Error value still serializes safely', () => {
        const reply = buildEditCallReply({
            outcome: { kind: 'throw', error: 'string-error' },
            callId: 'call_throw_str',
        });
        expect(reply.toolResult.content.ok).toBe(false);
        expect(reply.toolResult.content.reason).toBe('TRANSPORT_ERROR');
        expect(reply.toolResult.content.error).toBe('string-error');
    });

    test('throw outcome with null error falls back to a generic message', () => {
        const reply = buildEditCallReply({
            outcome: { kind: 'throw', error: null },
            callId: 'call_throw_null',
        });
        expect(reply.toolResult.content.ok).toBe(false);
        expect(reply.toolResult.content.reason).toBe('TRANSPORT_ERROR');
        expect(reply.toolResult.content.error).toBe('sandbox executor failed');
    });

    test('noop outcome → toolResult uses a VALIDATION_TARGET envelope (no "likely", no "status:noop")', () => {
        // The genuine "already matches" branch — emitted as a
        // VALIDATION_TARGET envelope so downstream classifiers see the
        // same `{ok:false, reason, hint}` shape they see for failure and
        // throw branches. The historical `{status:'noop', message:'…
        // likely already matches…'}` shape was both inconsistent with
        // the envelope and carried weasel-word wording the
        // noop→error contract fix tightened out.
        const reply = buildEditCallReply({
            outcome: { kind: 'noop' },
            callId: 'call_noop',
        });
        expect(reply.edits).toEqual([]);
        expect(reply.toolResult.tool_call_id).toBe('call_noop');
        expect(reply.toolResult.status).toBe('fail');
        expect(reply.toolResult.content.ok).toBe(false);
        expect(reply.toolResult.content.reason).toBe('VALIDATION_TARGET');
        // The historical "likely already matches" wording was the bug
        // signature — drift guard so we don't accidentally reintroduce
        // it; also guard against the obsolete `status:'noop'` field.
        expect(reply.toolResult.content.hint).toMatch(/already matches/);
        expect(reply.toolResult.content.hint).not.toMatch(/likely/);
        expect(reply.toolResult.content.status).toBeUndefined();
        expect(reply.toolResult.content.message).toBeUndefined();
        expect(reply.chainAdvanceTo).toBeUndefined();
    });

    test('edits outcome with empty edits array falls through to noop (defensive)', () => {
        // A malformed `{kind:'edits', edits:[]}` should be treated as a
        // noop, not a silent success. Without this guard the iter-studio
        // would push zero edits AND zero toolResults — the round's
        // assistant message would carry no per-call feedback and the
        // next round would have no clue what happened.
        const reply = buildEditCallReply({
            outcome: { kind: 'edits', edits: [] },
            callId: 'call_empty_edits',
        });
        expect(reply.edits).toEqual([]);
        expect(reply.toolResult?.content?.ok).toBe(false);
        expect(reply.toolResult?.content?.reason).toBe('VALIDATION_TARGET');
    });
});
