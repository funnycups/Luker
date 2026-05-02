/**
 * Review-feedback runtime helpers for the orchestrator.
 *
 * Review nodes can produce two kinds of feedback that the runtime needs
 * to surface back to other nodes:
 *
 *   1. Approved review feedback — when a review node returns
 *      `luker_orch_review_approve`, the feedback string is captured per
 *      (stageIndex, nodeIndex, nodeId) and accumulates across the run
 *      under `runtime.approvedReviewFeedbackEntries`. Subsequent worker
 *      / review nodes see those entries in their auto-injected prelude
 *      so the run develops a stable consensus.
 *   2. Current rerun feedback — when a review node returns
 *      `luker_orch_review_rerun`, the feedback string is forwarded to
 *      the targeted worker(s) on the next attempt as
 *      `current_rerun_review_feedback`.
 *
 * `buildAutoInjectedNodePromptPrelude` composes the prior-orchestration
 * capsule (when present) with the review-feedback section into a single
 * markdown block that runtime callers prepend to the user prompt.
 *
 * `buildReviewRuntimeContextText` is the review-side companion: it
 * surfaces the prior execution order plus the rerun budget so the review
 * node knows which worker ids it can target and how many reruns remain.
 *
 * Pure functions only. State (the `runtime` object holding
 * `approvedReviewFeedbackEntries`) is owned by the orchestration runtime
 * — these helpers just normalize / read / mutate that array.
 */

import { ORCH_NODE_TYPE_REVIEW } from './defaults.js';
import { toReadableYamlText } from './output-formatting.js';

export function normalizeApprovedReviewFeedbackEntry(entry = {}) {
    const feedback = String(entry?.feedback || '').trim();
    const nodeId = String(entry?.nodeId || '').trim();
    if (!feedback || !nodeId) {
        return null;
    }
    return {
        stageIndex: Math.max(0, Math.floor(Number(entry?.stageIndex) || 0)),
        stageId: String(entry?.stageId || '').trim(),
        nodeIndex: Math.max(0, Math.floor(Number(entry?.nodeIndex) || 0)),
        nodeId,
        feedback,
    };
}

export function getRuntimeApprovedReviewFeedbackEntries(runtime = null) {
    if (!Array.isArray(runtime?.approvedReviewFeedbackEntries)) {
        return [];
    }
    return runtime.approvedReviewFeedbackEntries
        .map(entry => normalizeApprovedReviewFeedbackEntry(entry))
        .filter(Boolean)
        .sort((left, right) => (
            Number(left.stageIndex || 0) - Number(right.stageIndex || 0)
            || Number(left.nodeIndex || 0) - Number(right.nodeIndex || 0)
            || String(left.nodeId || '').localeCompare(String(right.nodeId || ''))
        ));
}

export function upsertRuntimeApprovedReviewFeedbackEntry(runtime = null, entry = {}) {
    if (!runtime || typeof runtime !== 'object') {
        return;
    }
    const normalized = normalizeApprovedReviewFeedbackEntry(entry);
    if (!normalized) {
        return;
    }
    if (!Array.isArray(runtime.approvedReviewFeedbackEntries)) {
        runtime.approvedReviewFeedbackEntries = [];
    }
    const index = runtime.approvedReviewFeedbackEntries.findIndex(item => (
        Number(item?.stageIndex || 0) === normalized.stageIndex
        && Number(item?.nodeIndex || 0) === normalized.nodeIndex
        && String(item?.nodeId || '') === normalized.nodeId
    ));
    if (index >= 0) {
        runtime.approvedReviewFeedbackEntries[index] = normalized;
    } else {
        runtime.approvedReviewFeedbackEntries.push(normalized);
    }
}

export function trimRuntimeApprovedReviewFeedbackEntries(runtime = null, keepBeforeStageIndex = 0) {
    if (!runtime || typeof runtime !== 'object' || !Array.isArray(runtime.approvedReviewFeedbackEntries)) {
        return;
    }
    const safeStageIndex = Math.max(0, Math.floor(Number(keepBeforeStageIndex) || 0));
    runtime.approvedReviewFeedbackEntries = runtime.approvedReviewFeedbackEntries
        .map(entry => normalizeApprovedReviewFeedbackEntry(entry))
        .filter(entry => entry && entry.stageIndex < safeStageIndex);
}

export function buildReviewFeedbackPrelude({
    approvedReviewFeedbackEntries = [],
    rerunReason = undefined,
} = {}) {
    const approved = (Array.isArray(approvedReviewFeedbackEntries) ? approvedReviewFeedbackEntries : [])
        .map(entry => normalizeApprovedReviewFeedbackEntry(entry))
        .filter(Boolean)
        .map((entry) => ({
            stage_id: String(entry.stageId || ''),
            review_node_id: String(entry.nodeId || ''),
            feedback: String(entry.feedback || ''),
        }));
    const payload = {};
    if (approved.length > 0) {
        payload.approved_review_feedback = approved;
    }
    if (rerunReason !== undefined) {
        const text = String(rerunReason || '').trim();
        payload.current_rerun_review_feedback = text || '(no review feedback provided by review node)';
    }
    if (Object.keys(payload).length === 0) {
        return '';
    }
    return [
        '## auto_injected_review_feedback',
        '```yaml',
        toReadableYamlText(payload, '{}'),
        '```',
    ].join('\n');
}

export function buildAutoInjectedNodePromptPrelude({
    previousOrchestration = '',
    approvedReviewFeedbackEntries = [],
    rerunReason = undefined,
} = {}) {
    const orchestrationText = String(previousOrchestration || '').trim();
    const sections = [];
    if (orchestrationText) {
        sections.push([
            '## auto_injected_previous_orchestration_capsule',
            '```text',
            orchestrationText,
            '```',
        ].join('\n'));
    }
    const reviewFeedbackPrelude = buildReviewFeedbackPrelude({
        approvedReviewFeedbackEntries,
        rerunReason,
    });
    if (reviewFeedbackPrelude) {
        sections.push(reviewFeedbackPrelude);
    }
    return sections.join('\n\n');
}

export function buildReviewRuntimeContextText({
    currentNodeId = '',
    priorEntries = [],
    rerunUsed = 0,
    rerunMax = 0,
} = {}) {
    const priorExecutionOrder = priorEntries.map((entry) => ({
        stage_id: entry.stageId,
        node_id: entry.nodeId,
        preset: entry.preset,
        type: entry.type,
    }));
    const rerunCandidates = priorEntries
        .filter(entry => entry.type !== ORCH_NODE_TYPE_REVIEW)
        .map(entry => entry.nodeId);
    return [
        '## review_runtime_context',
        '```yaml',
        toReadableYamlText({
            current_review_node: String(currentNodeId || ''),
            rerun_budget: {
                used: Number(rerunUsed || 0),
                remaining: Math.max(Number(rerunMax || 0) - Number(rerunUsed || 0), 0),
                max: Number(rerunMax || 0),
            },
            prior_execution_order: priorExecutionOrder,
            rerun_candidates: rerunCandidates,
        }, '{}'),
        '```',
    ].join('\n');
}
