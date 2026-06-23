// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Decision helper for the orchestrator iter-studio's sandbox runner.
 *
 * `normalizeToolCallToEditInline` (studio.js) clones the working profile,
 * routes an AI tool call through `executeAiIterationToolCalls`, and then
 * has to decide what to push into the round's `editToolResults`:
 *
 *   1. before !== after                  → emit a coarse set('', after) edit
 *   2. before === after AND executor
 *      reported ok:false                 → forward the executor's payload
 *                                          so the next round's role:'tool'
 *                                          reply carries the real error
 *                                          (anchor not_found / invalid_args
 *                                          / multiple_matches / …)
 *   3. before === after AND executor was
 *      silent or reported ok:true        → benign noop (the "target state
 *                                          likely already matches" hint
 *                                          is honest in this branch)
 *
 * The historical bug was treating case 2 as case 3 — the iter-studio
 * surfaced a misleading "likely already matches" prose to the model
 * instead of the executor's actual `not_found` / `multiple_matches`
 * error, so the AI thought it had succeeded and never retried with a
 * corrected anchor.
 *
 * This function is the pure decision step; the call site supplies the
 * `before` / `after` snapshots it already has, plus the executor's
 * return value. Tested directly in tests/orch-iteration/sandbox-result.test.js.
 */

function snapshotsEqual(before, after) {
    try {
        return JSON.stringify(after) === JSON.stringify(before);
    } catch {
        return false;
    }
}

function parseExecutorContent(content) {
    if (content == null) return null;
    if (typeof content === 'object') return content;
    if (typeof content !== 'string') return null;
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Find the first toolResult entry whose parsed content reports ok:false.
 * Returns the parsed object, or null when none of the toolResults claim
 * failure (or there are no toolResults).
 */
function findExecutorFailure(executorResult) {
    const list = Array.isArray(executorResult?.toolResults)
        ? executorResult.toolResults
        : [];
    for (const entry of list) {
        const parsed = parseExecutorContent(entry?.content);
        if (parsed && parsed.ok === false) {
            return parsed;
        }
    }
    return null;
}

/**
 * @param {object} params
 * @param {*} params.before        the pre-call sandbox snapshot
 * @param {*} params.after         the post-call working profile
 * @param {{toolResults?: Array<{tool_call_id?: string, content?: any}>}|null|undefined} params.executorResult
 *        whatever `executeAiIterationToolCalls` returned for this single
 *        tool call. May be null/undefined when the executor threw.
 * @returns {{kind: 'edits'} | {kind: 'failure', content: object} | {kind: 'noop'}}
 */
export function interpretSandboxOutcome({ before, after, executorResult }) {
    if (!snapshotsEqual(before, after)) {
        return { kind: 'edits' };
    }
    const failure = findExecutorFailure(executorResult);
    if (failure) {
        return { kind: 'failure', content: failure };
    }
    return { kind: 'noop' };
}

/**
 * Map a `normalizeToolCallToEditInline` outcome into the per-call updates
 * the iter-studio's edit-tool loop needs to push:
 *
 *   - `edits`           — append to the round's pendingEdits list
 *   - `toolResult`      — append to the round's editToolResults list (the
 *                          OpenAI-protocol `role: 'tool'` reply replayed
 *                          on the next runIterationTurn)
 *   - `chainAdvanceTo`  — when present, becomes the next call's
 *                          `chainedBefore` baseline (so multiple edit
 *                          tools in the same round see each other's
 *                          mutations). Only emitted when the outcome
 *                          produced a real edit; failure / noop leave
 *                          the chain at `chainedBefore`.
 *
 * Outcome shapes accepted (mirrors `normalizeToolCallToEditInline`'s
 * return contract):
 *
 *   { kind: 'edits', edits: [{ op, path, oldValue, newValue }] }
 *   { kind: 'failure', content: <executor's `{ok:false,...}` envelope> }
 *   { kind: 'throw', error: Error }
 *   { kind: 'noop' }
 *
 * The noop message is the only place where "already matches" prose is
 * honest — every other outcome forwards a structured failure so the AI
 * sees the real cause (anchor not_found / multiple_matches / invalid_args
 * / sandbox executor throw) instead of the misleading hint the original
 * code used to push for every non-edit outcome.
 *
 * Tested in tests/orch-iteration/sandbox-result.test.js together with
 * `interpretSandboxOutcome` so the studio.js call site is a pure
 * compose of two helpers we can pin.
 *
 * @param {object} params
 * @param {{kind: string, edits?: Array<object>, content?: object, error?: any}} params.outcome
 * @param {string} params.callId — the tool_call_id the result must key under
 * @returns {{edits: Array<object>, toolResult: object|null, chainAdvanceTo: any}}
 */
export function buildEditCallReply({ outcome, callId }) {
    if (outcome?.kind === 'edits' && Array.isArray(outcome.edits) && outcome.edits.length > 0) {
        return {
            edits: outcome.edits,
            toolResult: null,
            chainAdvanceTo: outcome.edits[outcome.edits.length - 1]?.newValue,
        };
    }
    if (outcome?.kind === 'failure') {
        return {
            edits: [],
            toolResult: {
                tool_call_id: callId,
                content: outcome.content,
                status: 'fail',
            },
            chainAdvanceTo: undefined,
        };
    }
    if (outcome?.kind === 'throw') {
        return {
            edits: [],
            toolResult: {
                tool_call_id: callId,
                content: { error: String(outcome.error?.message || outcome.error || 'sandbox executor failed') },
                status: 'fail',
            },
            chainAdvanceTo: undefined,
        };
    }
    // Genuine noop: executor accepted the call but the working profile
    // did not change (e.g. set_field overwriting with the same value).
    // The "already matches" hint is honest in this branch only.
    return {
        edits: [],
        toolResult: {
            tool_call_id: callId,
            content: {
                status: 'noop',
                message: 'No edits produced. The target profile state already matches what you requested; an earlier round may have already applied this change. Re-read the live profile before retrying — do not re-issue the same call. If you genuinely intended a different result, verify args (path / mode / value).',
            },
            status: 'fail',
        },
        chainAdvanceTo: undefined,
    };
}
