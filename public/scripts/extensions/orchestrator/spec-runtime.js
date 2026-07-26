/**
 * Spec execution-mode runtime for the orchestrator.
 *
 * Spec mode runs a `{ stages: [{ id, mode, nodes }] }` graph stage by
 * stage. Each stage executes its nodes either in `serial` (default) or
 * `parallel`. Each node is one of:
 *
 *   - **worker** — issues the `luker_orch_node_output` tool call (or
 *     `luker_orch_final_guidance` for the final stage). Worker nodes
 *     iterate up to `getNodeIterationMaxRounds(settings)` rounds before
 *     erroring out.
 *   - **review** — issues either `luker_orch_review_approve` (with
 *     mandatory feedback) or `luker_orch_review_rerun` (with target node
 *     ids and feedback). On rerun the runtime replays from the earliest
 *     targeted stage forward up to `getReviewRerunMaxRounds(settings)`
 *     reruns total per orchestration.
 *
 * Module layout:
 *
 *   - Tool-set + contract builders:
 *     `buildNodeToolSet`, `buildNodeIterationContractText`.
 *   - Output-shape helpers:
 *     `createStageOutputSnapshot` projects a stage to the persisted
 *     `{ id, mode, nodes: [{ node, output }] }` snapshot shape.
 *   - Review-graph helpers:
 *     `collectPriorNodeEntries`, `resolveReviewTargetEntries`,
 *     `extractReviewDecision`.
 *   - Node drivers:
 *     `runWorkerNode` issues the worker tool-call loop;
 *     `runReviewNode` issues the review tool-call loop and triggers
 *     `replayStagesToReview` on rerun.
 *   - Stage driver:
 *     `executeStage` honors stage mode (serial / parallel), seeds and
 *     filters nodes during replay, and returns the per-stage worker
 *     output map plus the inherited previous-node-outputs map.
 *   - Entry point:
 *     `runSpecOrchestration` walks all stages and returns the same
 *     `{ stageOutputs, previousNodeOutputs, runtimeTrace, reviewRerunCount }`
 *     envelope agenda mode produces.
 */

const extension_settings = Luker.getContext().extensionSettings;
import { isAbortSignalLike, throwIfAborted } from './abort-utils.js';
import { canonicalStringifyArgs } from './canonical-stringify.js';
import { extractLastUserMessage, getRecentMessages } from './anchors.js';
import { computeDepthsFromEnd, regexChatMessageForAgent } from '../../lib/chat-regex.js';
import { createFirstChunkBarrier } from './dispatch-barrier.js';
import {
    AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
    ORCH_NODE_TYPE_REVIEW,
    ORCH_REVIEW_FEEDBACK_FIELD,
    ORCH_REVIEW_TOOL_APPROVE,
    ORCH_REVIEW_TOOL_RERUN,
} from './defaults.js';
import {
    resolveOrchestrationAgentApiPresetName,
    resolveOrchestrationAgentPromptPresetName,
    resolveOrchestrationRuntimeWorldInfo,
} from './agent-resolution.js';
import { sanitizeIdentifierToken } from './editable-spec.js';
import {
    buildDistillerOutputMarkdown,
    buildNodeOutputMapFromStageOutputs,
    buildPreviousOutputsMarkdown,
    buildStageWorkerOutputMap,
    mergeNodeOutputMaps,
    toReadableYamlText,
} from './output-formatting.js';
import { buildAutoInjectedNodePromptPrelude, buildReviewRuntimeContextText, getRuntimeApprovedReviewFeedbackEntries, trimRuntimeApprovedReviewFeedbackEntries, upsertRuntimeApprovedReviewFeedbackEntry } from './review-feedback.js';
import {
    appendRound, appendToSection, ensureSection,
    finishRun, setRoundStatus, setSectionStatus, startRun, addTokenUsage,
} from './run-state/store.js';
import { i18n, i18nFormat } from './i18n.js';
import { getChatKey, getPreviousOrchestrationCapsuleText } from './snapshot-cache.js';
import {
    getNodeIterationMaxRounds,
    getReviewRerunMaxRounds,
    getStageRuntimeMode,
    isReviewNodeSpec,
    normalizeNodeSpec,
    normalizeNodeType,
    sanitizeSpec,
} from './spec-schema.js';
import {
    normalizeTemplateForRuntime,
    renderTemplate,
} from './template-vars.js';
import {
    appendStandardToolRoundMessages,
    requestToolCallsWithRetry,
    serializeToolResultContent,
    makeRuntimeToolCallId,
} from './tool-calling.js';
import { buildRuntimeWorldInfoFromPayload } from './world-info.js';
import {
    hasAnyToolEnabled,
    resolveAgentToolFlags,
} from './persistence.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
    resolveToolSource,
} from './loop-tools.js';
import { attachToolContext, attachNotesFloorState, isStructuredToolError } from './loop-runtime.js';
import { loadOpenNotesBlock } from './open-notes-injection.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';

// Skill-resolution helpers are loaded lazily (script.js → lib.js dep makes
// eager import unfriendly to Node tests). Same pattern as director / loop
// runtimes.
let _skillResolutionPromise = null;
async function loadSkillResolution() {
    if (!_skillResolutionPromise) {
        _skillResolutionPromise = import('./skill-resolution.js');
    }
    return _skillResolutionPromise;
}

const MODULE_NAME = 'orchestrator';

// Inline trace helpers. Replaces the deleted runtime-trace.js module so
// the existing trace data structure (consumed by the simulation-payload
// adapter and the legacy runtime-trace popup) is still produced by the
// runner. Run-panel state lives in run-state/store.js and is written in
// parallel via startRun / appendRound / appendToSection.

function buildRuntimeSlotKey(stageIndex, nodeIndex, nodeId = '') {
    return [Number(stageIndex), Number(nodeIndex), String(nodeId || '').trim()].join(':');
}

function cloneTraceValue(value) {
    if (typeof value === 'string') return String(value);
    if (value && typeof value === 'object') return structuredClone(value);
    return value;
}

function serializeTraceValue(value) {
    if (typeof value === 'string') return String(value || '');
    if (value && typeof value === 'object') return toReadableYamlText(value, '{}');
    if (value == null) return '';
    return String(value);
}

function truncateTracePreview(value, maxChars = 240) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

function sanitizeTraceConversation(conversation) {
    if (!conversation || typeof conversation !== 'object') return null;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return { messages: messages.map(m => structuredClone(m)) };
}

function buildRuntimeStageLayout(stages = []) {
    return (Array.isArray(stages) ? stages : []).map((stage, stageIndex) => ({
        stageIndex,
        id: String(stage?.id || `stage_${stageIndex + 1}`),
        mode: getStageRuntimeMode(stage),
        nodes: (Array.isArray(stage?.nodes) ? stage.nodes : []).map((rawNode, nodeIndex) => {
            const nodeSpec = normalizeNodeSpec(rawNode);
            return {
                stageIndex,
                nodeIndex,
                slotKey: buildRuntimeSlotKey(stageIndex, nodeIndex, nodeSpec.id),
                id: String(nodeSpec?.id || ''),
                preset: String(nodeSpec?.preset || ''),
                type: normalizeNodeType(nodeSpec?.type),
            };
        }).filter(node => node.id),
    }));
}

function createRuntimeTrace(context, payload, stages = []) {
    const now = new Date().toISOString();
    const trace = {
        runId: `orch_runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatKey: String(getChatKey(context) || ''),
        status: 'running',
        startedAt: now,
        updatedAt: now,
        finishedAt: '',
        generationType: String(payload?.type || '').trim().toLowerCase(),
        targetLayer: 0,
        note: '',
        capsuleText: '',
        error: '',
        mode: '',
        stages: buildRuntimeStageLayout(stages),
        attempts: [],
        events: [],
        nextEventSeq: 1,
        nextAttemptId: 1,
        reviewRerunCount: 0,
    };
    recordRuntimeEvent(trace, 'run_started', {
        status: trace.status,
        generationType: trace.generationType,
        targetLayer: trace.targetLayer,
        note: trace.note,
    });
    return trace;
}

function recordRuntimeEvent(trace, type, details = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const event = {
        seq: Number(trace.nextEventSeq || 1),
        at: new Date().toISOString(),
        type: String(type || 'event'),
        ...(details && typeof details === 'object' ? structuredClone(details) : {}),
    };
    trace.nextEventSeq = event.seq + 1;
    trace.updatedAt = event.at;
    trace.events.push(event);
    return event;
}

function finalizeRuntimeTrace(trace, status, details = {}) {
    if (!trace || typeof trace !== 'object') return;
    const normalizedStatus = String(status || trace.status || 'completed');
    trace.status = normalizedStatus;
    trace.updatedAt = new Date().toISOString();
    trace.finishedAt = normalizedStatus === 'running' ? '' : trace.updatedAt;
    if (Object.prototype.hasOwnProperty.call(details || {}, 'capsuleText')) trace.capsuleText = String(details?.capsuleText || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'note')) trace.note = String(details?.note || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'error')) trace.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'reviewRerunCount')) {
        trace.reviewRerunCount = Math.max(0, Math.floor(Number(details?.reviewRerunCount) || 0));
    }
    recordRuntimeEvent(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
        reviewRerunCount: Number(trace.reviewRerunCount || 0),
    });
}

function beginRuntimeStage(trace, stage, stageIndex, options = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const stageState = {
        stageIndex: Number(stageIndex || 0),
        stageId: String(stage?.id || `stage_${Number(stageIndex || 0) + 1}`),
        mode: getStageRuntimeMode(stage),
        replay: Boolean(options?.replay),
        partial: Number.isInteger(options?.stopBeforeNodeIndex),
        stopBeforeNodeIndex: Number.isInteger(options?.stopBeforeNodeIndex) ? Number(options.stopBeforeNodeIndex) : null,
        startedAt: new Date().toISOString(),
    };
    recordRuntimeEvent(trace, 'stage_started', stageState);
    return stageState;
}

function finishRuntimeStage(trace, stageState, details = {}) {
    if (!trace || typeof trace !== 'object' || !stageState || typeof stageState !== 'object') return;
    recordRuntimeEvent(trace, 'stage_finished', {
        stageIndex: Number(stageState.stageIndex || 0),
        stageId: String(stageState.stageId || ''),
        mode: String(stageState.mode || 'serial'),
        replay: Boolean(stageState.replay),
        partial: Boolean(stageState.partial),
        stopBeforeNodeIndex: Number.isInteger(stageState.stopBeforeNodeIndex) ? stageState.stopBeforeNodeIndex : null,
        status: String(details?.status || 'completed'),
        error: String(details?.error || ''),
        stageOutput: cloneTraceValue(details?.stageOutput),
    });
}

function beginRuntimeNodeAttempt(trace, meta = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const attempt = {
        attemptId: `attempt_${Number(trace.nextAttemptId || 1)}`,
        sequence: Number(trace.nextEventSeq || 1),
        stageIndex: Number(meta?.stageIndex || 0),
        stageId: String(meta?.stageId || ''),
        nodeIndex: Number(meta?.nodeIndex || 0),
        nodeId: String(meta?.nodeId || ''),
        preset: String(meta?.preset || ''),
        nodeType: normalizeNodeType(meta?.nodeType),
        slotKey: String(meta?.slotKey || buildRuntimeSlotKey(meta?.stageIndex, meta?.nodeIndex, meta?.nodeId)),
        runKind: String(meta?.runKind || 'worker'),
        round: Math.max(1, Math.floor(Number(meta?.round) || 1)),
        startedAt: new Date().toISOString(),
        endedAt: '',
        status: 'running',
        rerunReason: String(meta?.rerunReason || ''),
        output: null,
        outputText: '',
        previewText: '',
        action: '',
        targetNodeIds: [],
        reason: '',
        replayResult: null,
        error: '',
        conversation: null,
    };
    trace.nextAttemptId = Number(trace.nextAttemptId || 1) + 1;
    trace.attempts.push(attempt);
    recordRuntimeEvent(trace, 'node_started', {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        rerunReason: attempt.rerunReason,
    });
    return attempt;
}

function finishRuntimeNodeAttempt(trace, attempt, details = {}) {
    if (!trace || typeof trace !== 'object' || !attempt || typeof attempt !== 'object') return;
    attempt.endedAt = new Date().toISOString();
    attempt.status = String(details?.status || attempt.status || 'completed');
    attempt.action = String(details?.action || attempt.action || '');
    attempt.reason = String(details?.reason || attempt.reason || '');
    attempt.rerunReason = String(
        Object.prototype.hasOwnProperty.call(details || {}, 'rerunReason')
            ? details?.rerunReason
            : attempt.rerunReason,
    ) || '';
    attempt.targetNodeIds = Array.isArray(details?.targetNodeIds)
        ? details.targetNodeIds.map(item => String(item || '').trim()).filter(Boolean)
        : (Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds : []);
    attempt.replayResult = Object.prototype.hasOwnProperty.call(details || {}, 'replayResult')
        ? cloneTraceValue(details?.replayResult)
        : attempt.replayResult;
    attempt.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'output')) {
        attempt.output = cloneTraceValue(details?.output);
        attempt.outputText = serializeTraceValue(details?.output);
        attempt.previewText = truncateTracePreview(attempt.outputText);
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'conversation')) {
        attempt.conversation = sanitizeTraceConversation(details?.conversation);
    }
    const eventType = attempt.nodeType === 'review' ? 'review_finished' : 'node_finished';
    recordRuntimeEvent(trace, eventType, {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        status: attempt.status,
        action: attempt.action,
        reason: attempt.reason,
        rerunReason: attempt.rerunReason,
        targetNodeIds: Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds.slice() : [],
        previewText: attempt.previewText,
        error: attempt.error,
        replayResult: cloneTraceValue(attempt.replayResult),
    });
}


export function buildNodeToolSet(nodeSpec, { isFinalStage = false } = {}) {
    if (isReviewNodeSpec(nodeSpec)) {
        return [
            {
                type: 'function',
                function: {
                    name: ORCH_REVIEW_TOOL_APPROVE,
                    description: `Approve prior worker outputs and provide mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\` for downstream runtime injection.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            [ORCH_REVIEW_FEEDBACK_FIELD]: { type: 'string' },
                            reason: { type: 'string' },
                        },
                        required: [ORCH_REVIEW_FEEDBACK_FIELD],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: ORCH_REVIEW_TOOL_RERUN,
                    description: `Request rerun for specific previously executed worker node ids and include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            target_node_ids: {
                                type: 'array',
                                items: { type: 'string' },
                                minItems: 1,
                            },
                            [ORCH_REVIEW_FEEDBACK_FIELD]: { type: 'string' },
                            reason: { type: 'string' },
                        },
                        required: ['target_node_ids', ORCH_REVIEW_FEEDBACK_FIELD],
                        additionalProperties: false,
                    },
                },
            },
        ];
    }

    return [isFinalStage
        ? {
            type: 'function',
            function: {
                name: 'luker_orch_final_guidance',
                description: 'Final orchestration guidance to inject into generation context.',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                    },
                    required: ['text'],
                    additionalProperties: false,
                },
            },
        }
        : {
            type: 'function',
            function: {
                name: 'luker_orch_node_output',
                description: 'Orchestrator node output with concise structured guidance.',
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                        xml_guidance: { type: 'string' },
                        directives: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                        risks: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    additionalProperties: true,
                },
            },
        }];
}

export function buildNodeIterationContractText(nodeSpec, { isFinalStage = false } = {}) {
    if (isReviewNodeSpec(nodeSpec)) {
        return [
            '## node_iteration_contract',
            `- If prior worker outputs are acceptable, call ${ORCH_REVIEW_TOOL_APPROVE} exactly once with mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
            `- If specific prior worker nodes must be recomputed, call ${ORCH_REVIEW_TOOL_RERUN} exactly once with target_node_ids and mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
            `- \`${ORCH_REVIEW_FEEDBACK_FIELD}\` should contain concise audit conclusions, preserved constraints, and concrete downstream refinement guidance.`,
            '- Do not emit rewritten final synthesis of your own.',
        ].join('\n');
    }

    const outputName = isFinalStage ? 'luker_orch_final_guidance' : 'luker_orch_node_output';
    return [
        '## node_iteration_contract',
        `- When the node result is ready, call ${outputName} exactly once.`,
        '- Do not output plain prose outside function-call payload.',
    ].join('\n');
}

export function createStageOutputSnapshot(stage, stageWorkerOutputs = new Map()) {
    const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : [])
        .map(rawNode => normalizeNodeSpec(rawNode))
        .filter(nodeSpec => !isReviewNodeSpec(nodeSpec))
        .map((nodeSpec) => {
            if (!stageWorkerOutputs.has(nodeSpec.id)) {
                return null;
            }
            return {
                node: nodeSpec.id,
                output: stageWorkerOutputs.get(nodeSpec.id),
            };
        })
        .filter(Boolean);

    return {
        id: String(stage?.id || ''),
        mode: getStageRuntimeMode(stage),
        nodes,
    };
}

export function collectPriorNodeEntries(stages, currentStageIndex, currentNodeIndex) {
    const entries = [];
    for (let stageIndex = 0; stageIndex <= currentStageIndex; stageIndex++) {
        const stage = stages[stageIndex];
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const stopIndex = stageIndex === currentStageIndex ? currentNodeIndex : nodes.length;
        for (let nodeIndex = 0; nodeIndex < stopIndex; nodeIndex++) {
            const nodeSpec = normalizeNodeSpec(nodes[nodeIndex]);
            if (!nodeSpec.id) {
                continue;
            }
            entries.push({
                stageIndex,
                stageId: String(stage?.id || `stage_${stageIndex + 1}`),
                nodeIndex,
                nodeId: nodeSpec.id,
                preset: nodeSpec.preset,
                type: normalizeNodeType(nodeSpec.type),
            });
        }
    }
    return entries;
}

export function resolveReviewTargetEntries(stages, currentStageIndex, currentNodeIndex, targetNodeIds) {
    const priorEntries = collectPriorNodeEntries(stages, currentStageIndex, currentNodeIndex)
        .filter(entry => entry.type !== ORCH_NODE_TYPE_REVIEW);
    const counts = new Map();
    for (const entry of priorEntries) {
        counts.set(entry.nodeId, Number(counts.get(entry.nodeId) || 0) + 1);
    }
    const index = new Map(priorEntries.map(entry => [entry.nodeId, entry]));
    const resolved = [];
    for (const rawTarget of Array.isArray(targetNodeIds) ? targetNodeIds : []) {
        const targetNodeId = sanitizeIdentifierToken(rawTarget, '');
        if (!targetNodeId) {
            continue;
        }
        if (Number(counts.get(targetNodeId) || 0) > 1) {
            throw new Error(`Review rerun target '${targetNodeId}' is ambiguous. Node ids must be unique among prior worker nodes.`);
        }
        const entry = index.get(targetNodeId);
        if (!entry) {
            throw new Error(`Review rerun target '${targetNodeId}' is not a valid prior worker node.`);
        }
        if (!resolved.some(item => item.nodeId === entry.nodeId)) {
            resolved.push(entry);
        }
    }
    if (resolved.length === 0) {
        throw new Error('Review rerun requested without valid target_node_ids.');
    }
    return resolved;
}

export function extractReviewDecision(toolCalls = [], nodeId = '') {
    let approveCall = null;
    let rerunCall = null;
    const readReviewFeedback = (args = {}) => String(
        args?.[ORCH_REVIEW_FEEDBACK_FIELD]
        || args?.reason
        || '',
    ).trim();

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (name === ORCH_REVIEW_TOOL_APPROVE && !approveCall) {
            approveCall = call;
        }
        if (name === ORCH_REVIEW_TOOL_RERUN && !rerunCall) {
            rerunCall = call;
        }
    }

    if (approveCall && rerunCall) {
        throw new Error(`Review node '${nodeId}' returned both approve and rerun.`);
    }

    if (rerunCall) {
        const rawTargets = Array.isArray(rerunCall?.args?.target_node_ids) ? rerunCall.args.target_node_ids : [];
        const targetNodeIds = [...new Set(rawTargets.map(item => sanitizeIdentifierToken(item, '')).filter(Boolean))];
        if (targetNodeIds.length === 0) {
            throw new Error(`Review node '${nodeId}' requested rerun without target_node_ids.`);
        }
        const reviewFeedback = readReviewFeedback(rerunCall?.args);
        if (!reviewFeedback) {
            throw new Error(`Review node '${nodeId}' requested rerun without ${ORCH_REVIEW_FEEDBACK_FIELD}.`);
        }
        return {
            action: 'rerun',
            targetNodeIds,
            reason: reviewFeedback,
        };
    }

    if (approveCall) {
        const reviewFeedback = readReviewFeedback(approveCall?.args);
        if (!reviewFeedback) {
            throw new Error(`Review node '${nodeId}' approved without ${ORCH_REVIEW_FEEDBACK_FIELD}.`);
        }
        return {
            action: 'approve',
            reason: reviewFeedback,
        };
    }

    throw new Error(`Review node '${nodeId}' did not return a review decision tool call.`);
}

/**
 * Build the `{{recent_chat}}` / `{{last_user}}` template values for a
 * node run. Both go through prompt-scoped regex scripts so orchestrator
 * agents see the same rewritten text the main model would (see
 * `chat-regex.js` for rationale). `depth` is computed against the full
 * `messages` array so `minDepth` / `maxDepth` filters behave the same
 * way they do in Generate().
 *
 * @param {Array} messages full chat array
 * @param {number} maxRecent how many assistant turns to include
 * @returns {{ recentChatText: string, lastUserText: string }}
 */
function buildRecentChatAndLastUser(messages, maxRecent) {
    const source = Array.isArray(messages) ? messages : [];
    const depths = computeDepthsFromEnd(source);
    const indexOf = new Map();
    for (let i = 0; i < source.length; i += 1) {
        indexOf.set(source[i], i);
    }
    const recentChatText = getRecentMessages(source, maxRecent)
        .map(message => {
            const idx = indexOf.get(message);
            const depth = typeof idx === 'number' ? depths[idx] : undefined;
            const rewrittenMes = regexChatMessageForAgent(message, depth);
            const speaker = message?.is_user ? 'User' : (message?.name || 'Assistant');
            return `${speaker}: ${rewrittenMes}`;
        })
        .join('\n');
    const { index: lastUserIndex, message: lastUser } = extractLastUserMessage(source);
    const lastUserText = lastUserIndex >= 0
        ? regexChatMessageForAgent(lastUser, depths[lastUserIndex])
        : '';
    return { recentChatText, lastUserText };
}

export async function runWorkerNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal = null, options = {}) {
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    const isFinalStage = Boolean(options?.isFinalStage);
    const trace = options?.runtime?.trace;
    const traceAttempt = beginRuntimeNodeAttempt(trace, {
        stageIndex: Number(options?.stageIndex || 0),
        stageId: String(options?.stageId || ''),
        nodeIndex: Number(options?.nodeIndex || 0),
        nodeId: nodeSpec?.id,
        preset: nodeSpec?.preset || preset?.id || nodeSpec?.id,
        nodeType: nodeSpec?.type,
        runKind: 'worker',
        rerunReason: String(options?.rerunReason || ''),
    });
    const settings = extension_settings[MODULE_NAME];
    const { recentChatText: recent, lastUserText } = buildRecentChatAndLastUser(messages, settings.maxRecentMessages);
    const previousOutputs = buildPreviousOutputsMarkdown(previousNodeOutputs);
    const distillerOutput = buildDistillerOutputMarkdown(previousNodeOutputs);
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const approvedReviewFeedbackEntries = getRuntimeApprovedReviewFeedbackEntries(options?.runtime);
    const hasRerunReason = Object.prototype.hasOwnProperty.call(options || {}, 'rerunReason');
    const autoInjectedPrelude = buildAutoInjectedNodePromptPrelude({
        previousOrchestration,
        approvedReviewFeedbackEntries,
        rerunReason: hasRerunReason ? String(options?.rerunReason ?? '') : undefined,
    });

    const runtimeTemplate = normalizeTemplateForRuntime(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '');
    const baseUserPrompt = renderTemplate(runtimeTemplate, {
        recent_chat: recent,
        last_user: lastUserText,
        previous_outputs: previousOutputs,
        distiller: distillerOutput,
        previous_snapshot: '',
        previous_orchestration: AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
    });

    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset)?.name || '';
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, preset)?.name || '';
    const outputToolSchemas = buildNodeToolSet(nodeSpec, { isFinalStage });

    // Tool-cascade resolution: node.tools overrides profile default, which
    // overrides built-in null. Spec mode's built-in default is "no loop
    // tools" — current behavior — so the multi-round path activates only
    // when the user explicitly opts in via per-node `tools` or via the
    // profile-root `defaultTools`.
    const resolvedToolFlags = resolveAgentToolFlags(
        nodeSpec?.tools,
        options?.defaultTools || null,
        null,
    );
    const enableLoopTools = hasAnyToolEnabled(resolvedToolFlags);
    const customToolRegistry = options?.runtime?.customToolRegistry || null;
    const loopToolSchemas = enableLoopTools
        ? getEnabledToolSchemas({ tools: resolvedToolFlags }, customToolRegistry)
            .filter(s => String(s?.function?.name || '') !== 'finalize')
        : [];
    const tools = enableLoopTools
        ? [...loopToolSchemas, ...outputToolSchemas]
        : outputToolSchemas;
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const maxRounds = getNodeIterationMaxRounds(settings);
    const outputToolName = isFinalStage ? 'luker_orch_final_guidance' : 'luker_orch_node_output';
    const runtimeToolMessages = [];
    let lastRound = 0;

    // Trace conversation log. Aliased onto the trace attempt at finalize
    // so the simulation-payload adapter (and any legacy trace viewer)
    // can render the per-attempt message thread.
    // We push system once, then each round's user prompt + assistant
    // response (with any tool_calls) + tool result messages. Aliased
    // rather than cloned so callers reading mid-run see live state.
    const conversation = { messages: [] };
    const systemTextForTrace = String(preset.systemPrompt || '').trim();
    if (systemTextForTrace) {
        conversation.messages.push({ role: 'system', content: systemTextForTrace });
    }

    // The loop tools (chat/lorebook/memory/note/search) need a per-run
    // dispatch context with the floor-state adapter, memory store and
    // activated-entry set attached. Build it once at node start so each
    // round's `executeLoopTool` calls share the same handle.
    const toolContext = enableLoopTools
        ? await attachToolContext(context, payload)
        : null;
    if (toolContext && customToolRegistry) {
        toolContext.__customToolRegistry = customToolRegistry;
    }

    // Resolve skills visible to this worker node. Mode-level default
    // lives on `runtime.spec.skills`; per-node `skills` (when set on
    // `nodeSpec`) layers via the `+` inheritance idiom. The resolver
    // dynamic-imports to keep test environments lib.js-free.
    let visibleSkillsForNode = [];
    let nodeSystemSuffix = '';
    try {
        const skillRes = await loadSkillResolution();
        visibleSkillsForNode = await skillRes.resolveAgentVisibleSkills({
            modeProfile: options?.runtime?.spec || {},
            agentConfig: nodeSpec,
            runtimeContext: skillRes.buildSkillRuntimeContext(
                context,
                preset,
                { mode: 'spec', name: String(options?.runtime?.activeOrchPresetName || '').trim() },
            ),
        });
        nodeSystemSuffix = skillRes.buildAvailableSkillsBlock(visibleSkillsForNode);
    } catch (e) {
        console.warn('[orchestrator-spec] worker skill resolution failed:', e?.message || e);
    }
    if (toolContext) toolContext.__visibleSkillsForAgent = visibleSkillsForNode;

    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages: messages,
        runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
        forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
        worldInfoType: String(payload?.type || 'quiet'),
        abortSignal,
    });

    try {
        for (let round = 1; round <= maxRounds; round++) {
            lastRound = round;
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const iterationPrompt = [
                autoInjectedPrelude,
                baseUserPrompt,
                buildNodeIterationContractText(nodeSpec, { isFinalStage }),
            ].filter(Boolean).join('\n\n');

            const systemText = String(preset.systemPrompt || '').trim();
            // System prefix is kept stable (preset.systemPrompt + skills
            // catalog): both are node-attempt-level constants that don't
            // change across rounds of the same node. Volatile per-round
            // context (Open Notes) is inlined into the trailing user
            // `iterationPrompt` so the system prefix stays byte-identical
            // and upstream prompt cache holds — pushing a trailing user
            // `<runtime_state>` message instead would violate the
            // consecutive-user-role constraint (iterationPrompt is
            // already user role and some providers reject that).
            const systemForRound = systemText && nodeSystemSuffix
                ? systemText + '\n\n' + nodeSystemSuffix
                : (systemText || nodeSystemSuffix);
            const openNotesBlockForNode = await loadOpenNotesBlock(options?.runtime?.contextForNotes);
            const iterationPromptWithNotes = openNotesBlockForNode
                ? iterationPrompt + '\n\n' + openNotesBlockForNode
                : iterationPrompt;
            const taskMessages = [
                ...(systemForRound ? [{ role: 'system', content: systemForRound }] : []),
                ...runtimeToolMessages,
                { role: 'user', content: iterationPromptWithNotes },
            ];
            conversation.messages.push({ role: 'user', content: iterationPromptWithNotes, _round: round });

            const detailed = await requestToolCallsWithRetry(context, settings, {
                taskMessages,
                runtimeWorldInfo,
                apiPresetName,
                llmPresetName,
                tools,
                allowedNames,
                abortSignal,
                includeAssistantText: true,
                allowNoToolCalls: false,
                // Fire the cache-warmup barrier signal only on round 1
                // — subsequent rounds of this same worker node don't
                // race sibling worker nodes for the same cache slot
                // (siblings warmed it on their own round 1 or moved
                // past it). See dispatch-barrier.js and the
                // Promise.all(nodes.map(...)) parallel-stage fan-out
                // in runStage for the caller side.
                onFirstChunk: round === 1 && typeof options?.onFirstChunk === 'function'
                    ? options.onFirstChunk
                    : null,
                onUsage: options?.runtime?.runId
                    ? (usage) => {
                        try { addTokenUsage({ runId: options.runtime.runId, usage }); } catch (_) { /* store may have been cleared */ }
                    }
                    : null,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const calls = Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [];
            if (calls.length === 0) {
                throw new Error(`Node '${nodeSpec.id}' did not return tool calls.`);
            }

            let finalizedOutput = null;
            const loopToolCalls = [];
            for (const call of calls) {
                const name = String(call?.name || '').trim();
                if (!name) {
                    continue;
                }
                if (name === outputToolName && finalizedOutput === null) {
                    finalizedOutput = call?.args && typeof call.args === 'object' ? call.args : {};
                    continue;
                }
                if (enableLoopTools) {
                    loopToolCalls.push(call);
                }
            }

            if (finalizedOutput !== null) {
                // Record the terminal assistant turn carrying the output
                // tool call so the trace popup can see what was emitted.
                conversation.messages.push({
                    role: 'assistant',
                    content: String(detailed?.assistantText || ''),
                    reasoning: String(detailed?.reasoning || ''),
                    tool_calls: calls
                        .filter(c => String(c?.name || '').trim() === outputToolName)
                        .map(c => ({ id: c?.id || '', name: String(c?.name || ''), args: c?.args || {} })),
                    _round: round,
                });
                if (isFinalStage) {
                    const finalText = String(finalizedOutput?.text ?? '');
                    if (!finalText.trim()) {
                        throw new Error(`Node '${nodeSpec.id}' returned empty final guidance text.`);
                    }
                    finishRuntimeNodeAttempt(trace, traceAttempt, {
                        status: 'completed',
                        output: finalText,
                        conversation,
                    });
                    return finalText;
                }
                if (finalizedOutput && typeof finalizedOutput === 'object') {
                    finishRuntimeNodeAttempt(trace, traceAttempt, {
                        status: 'completed',
                        output: finalizedOutput,
                        conversation,
                    });
                    return finalizedOutput;
                }
                throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
            }

            // No output tool this round. If loop tools were used, dispatch
            // them and feed results back so the agent can continue in the
            // next round. Otherwise the model failed to satisfy the
            // contract — bail out.
            if (enableLoopTools && loopToolCalls.length > 0) {
                const assistantToolCallEntries = loopToolCalls.map(tc => {
                    const normalizedName = String(tc?.name || '').replace(/\./g, '_');
                    return {
                        id: String(tc?.id || makeRuntimeToolCallId()),
                        type: 'function',
                        function: {
                            name: normalizedName,
                            arguments: canonicalStringifyArgs(tc?.args),
                        },
                        source: resolveToolSource(normalizedName, toolContext),
                    };
                });
                runtimeToolMessages.push({
                    role: 'assistant',
                    content: String(detailed?.assistantText || ''),
                    ...(Array.isArray(detailed?.reasoningBlocks) && detailed.reasoningBlocks.length > 0 ? { reasoning_blocks: detailed.reasoningBlocks } : {}),
                    ...(Array.isArray(detailed?.reasoningDetails) && detailed.reasoningDetails.length > 0 ? { reasoning_details: detailed.reasoningDetails } : {}),
                    ...(detailed?.reasoning ? { reasoning: String(detailed.reasoning) } : {}),
                    tool_calls: assistantToolCallEntries,
                });
                conversation.messages.push({
                    role: 'assistant',
                    content: String(detailed?.assistantText || ''),
                    reasoning: String(detailed?.reasoning || ''),
                    tool_calls: loopToolCalls.map((tc, i) => ({
                        id: assistantToolCallEntries[i].id,
                        name: String(tc?.name || ''),
                        args: tc?.args || {},
                        source: assistantToolCallEntries[i].source,
                    })),
                    _round: round,
                });
                for (let i = 0; i < loopToolCalls.length; i += 1) {
                    const tc = loopToolCalls[i];
                    const callId = assistantToolCallEntries[i].id;
                    let toolResult;
                    try {
                        toolResult = await executeLoopTool(
                            String(tc?.name || ''),
                            tc?.args && typeof tc.args === 'object' ? tc.args : {},
                            toolContext,
                        );
                        // Post-execute abort check: surface user abort
                        // immediately instead of waiting for the next
                        // round boundary. Not gated pre-execute because
                        // tool side-effects already committed in this
                        // round belong to the completed round.
                        throwIfAborted(abortSignal, 'Orchestration aborted.');
                        toolResult = {
                            ok: true,
                            data: toolResult,
                        };
                    } catch (toolError) {
                        if (isStructuredToolError(toolError)) {
                            toolResult = {
                                ok: false,
                                error: String(toolError.message || ''),
                                code: String(toolError.code || 'TOOL_ERROR'),
                                hint: String(toolError.hint || ''),
                            };
                        } else {
                            throw toolError;
                        }
                    }
                    const serialized = serializeToolResultContent(toolResult);
                    runtimeToolMessages.push({
                        role: 'tool',
                        tool_call_id: callId,
                        content: serialized,
                    });
                    conversation.messages.push({
                        role: 'tool',
                        tool_call_id: callId,
                        name: String(tc?.name || ''),
                        content: serialized,
                        _round: round,
                    });
                }
                continue;
            }

            throw new Error(`Node '${nodeSpec.id}' did not return the required output tool '${outputToolName}'.`);
        }

        throw new Error(`Node '${nodeSpec.id}' exceeded max iteration rounds (${maxRounds}) without ${outputToolName}.`);
    } catch (error) {
        finishRuntimeNodeAttempt(trace, traceAttempt, {
            status: 'failed',
            error: String(error?.message || error),
            rerunReason: String(options?.rerunReason || ''),
            round: lastRound,
            conversation,
        });
        throw error;
    }
}

export async function replayStagesToReview(context, payload, messages, profile, runtime, {
    currentStageIndex,
    currentNodeIndex,
    targetEntries,
    currentStageWorkerOutputs,
    rerunReason = '',
}, abortSignal = null) {
    const stages = Array.isArray(runtime?.stages) ? runtime.stages : [];
    const earliestStageIndex = Math.min(...targetEntries.map(entry => entry.stageIndex));
    const existingStageOutputs = Array.isArray(runtime?.stageOutputs) ? runtime.stageOutputs.slice() : [];
    recordRuntimeEvent(runtime?.trace, 'replay_started', {
        currentStageIndex: Number(currentStageIndex || 0),
        currentNodeIndex: Number(currentNodeIndex || 0),
        restartStageId: String(stages[earliestStageIndex]?.id || ''),
        targetNodeIds: targetEntries.map(entry => entry.nodeId),
        rerunReason: String(rerunReason || ''),
    });
    const rerunTargetsByStage = new Map();
    const rerunReasonsByStage = new Map();
    for (const entry of targetEntries) {
        if (!rerunTargetsByStage.has(entry.stageIndex)) {
            rerunTargetsByStage.set(entry.stageIndex, new Set());
        }
        rerunTargetsByStage.get(entry.stageIndex).add(entry.nodeId);
        if (!rerunReasonsByStage.has(entry.stageIndex)) {
            rerunReasonsByStage.set(entry.stageIndex, new Map());
        }
        rerunReasonsByStage.get(entry.stageIndex).set(entry.nodeId, String(rerunReason || ''));
    }

    trimRuntimeApprovedReviewFeedbackEntries(runtime, earliestStageIndex);
    runtime.stageOutputs = existingStageOutputs.slice(0, earliestStageIndex);
    let previousNodeOutputs = buildNodeOutputMapFromStageOutputs(runtime.stageOutputs);

    for (let stageIndex = earliestStageIndex; stageIndex < currentStageIndex; stageIndex++) {
        const stageResult = await executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal, {
            replay: true,
            rerunNodeIds: stageIndex === earliestStageIndex
                ? (rerunTargetsByStage.get(stageIndex) || null)
                : null,
            rerunReasonByNodeId: stageIndex === earliestStageIndex
                ? (rerunReasonsByStage.get(stageIndex) || null)
                : null,
            seedStageWorkerOutputs: stageIndex === earliestStageIndex
                ? buildStageWorkerOutputMap(existingStageOutputs[stageIndex])
                : null,
        });
        previousNodeOutputs = mergeNodeOutputMaps(stageResult.previousNodeOutputs, stageResult.stageWorkerOutputs);
        runtime.stageOutputs.push(createStageOutputSnapshot(stages[stageIndex], stageResult.stageWorkerOutputs));
    }

    const currentStagePrefix = await executeStage(context, payload, messages, profile, runtime, currentStageIndex, previousNodeOutputs, abortSignal, {
        replay: true,
        stopBeforeNodeIndex: currentNodeIndex,
        rerunNodeIds: earliestStageIndex === currentStageIndex
            ? (rerunTargetsByStage.get(currentStageIndex) || null)
            : null,
        rerunReasonByNodeId: earliestStageIndex === currentStageIndex
            ? (rerunReasonsByStage.get(currentStageIndex) || null)
            : null,
        seedStageWorkerOutputs: earliestStageIndex === currentStageIndex
            ? mergeNodeOutputMaps(currentStageWorkerOutputs instanceof Map ? currentStageWorkerOutputs : new Map())
            : null,
    });

    const replayResult = {
        rerun_round: Number(runtime.reviewRerunCount || 0),
        rerun_remaining: Math.max(getReviewRerunMaxRounds() - Number(runtime.reviewRerunCount || 0), 0),
        restart_stage_id: String(stages[earliestStageIndex]?.id || ''),
        target_node_ids: targetEntries.map(entry => entry.nodeId),
    };
    recordRuntimeEvent(runtime?.trace, 'replay_finished', replayResult);

    return {
        previousNodeOutputs: currentStagePrefix.previousNodeOutputs,
        currentStageWorkerOutputs: currentStagePrefix.stageWorkerOutputs,
        result: replayResult,
    };
}

export async function runReviewNode(context, payload, profile, nodeSpec, preset, messages, previousNodeOutputs, currentStageWorkerOutputs, abortSignal = null, options = {}) {
    // Review nodes intentionally skip the `<available_skills>` catalog block
    // and the `__visibleSkillsForAgent` dispatch hint: they audit the
    // preceding worker's output via specialized review tools
    // (`luker_orch_review_approve`, `luker_orch_review_rerun`) and shouldn't
    // be distracted by general skill content. Workers consult skills; review
    // nodes consult workers' outputs.
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    if (Boolean(options?.isFinalStage)) {
        throw new Error(`Review node '${nodeSpec.id}' cannot be used in the final stage.`);
    }

    const settings = extension_settings[MODULE_NAME];
    const maxReruns = getReviewRerunMaxRounds(settings);
    const maxRounds = Math.max(1, getNodeIterationMaxRounds(settings) + maxReruns + 1);
    const { recentChatText: recent, lastUserText } = buildRecentChatAndLastUser(messages, settings.maxRecentMessages);
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const runtimeTemplate = normalizeTemplateForRuntime(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '');
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset)?.name || '';
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, preset)?.name || '';
    const tools = buildNodeToolSet(nodeSpec);
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const runtimeToolMessages = [];
    let currentPreviousNodeOutputs = mergeNodeOutputMaps(previousNodeOutputs);
    let currentStageOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);

    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages: messages,
        runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
        forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
        worldInfoType: String(payload?.type || 'quiet'),
        abortSignal,
    });

    for (let round = 1; round <= maxRounds; round++) {
        const trace = options?.runtime?.trace;
        const traceAttempt = beginRuntimeNodeAttempt(trace, {
            stageIndex: Number(options?.stageIndex || 0),
            stageId: String(options?.stageId || ''),
            nodeIndex: Number(options?.nodeIndex || 0),
            nodeId: nodeSpec?.id,
            preset: nodeSpec?.preset || preset?.id || nodeSpec?.id,
            nodeType: nodeSpec?.type,
            runKind: 'review',
            round,
        });
        // Per-attempt conversation log for the trace popup. Review attempts
        // are single-round inside this loop body, so the log just captures
        // system + user + assistant-with-tool-call.
        const conversation = { messages: [] };
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const availableOutputs = mergeNodeOutputMaps(currentPreviousNodeOutputs, currentStageOutputs);
            const priorEntries = collectPriorNodeEntries(options?.runtime?.stages || [], Number(options?.stageIndex || 0), Number(options?.nodeIndex || 0));
            const autoInjectedPrelude = buildAutoInjectedNodePromptPrelude({
                previousOrchestration,
                approvedReviewFeedbackEntries: getRuntimeApprovedReviewFeedbackEntries(options?.runtime),
            });
            const baseUserPrompt = renderTemplate(runtimeTemplate, {
                recent_chat: recent,
                last_user: lastUserText,
                previous_outputs: buildPreviousOutputsMarkdown(availableOutputs),
                distiller: buildDistillerOutputMarkdown(availableOutputs),
                previous_snapshot: '',
                previous_orchestration: AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
            });
            const iterationPrompt = [
                autoInjectedPrelude,
                baseUserPrompt,
                buildReviewRuntimeContextText({
                    currentNodeId: nodeSpec.id,
                    priorEntries,
                    rerunUsed: Number(options?.runtime?.reviewRerunCount || 0),
                    rerunMax: maxReruns,
                }),
                buildNodeIterationContractText(nodeSpec),
            ].filter(Boolean).join('\n\n');

            const systemText = String(preset.systemPrompt || '').trim();
            // Persistent Open Notes surfaced to review nodes too. Review
            // agents don't produce prose but they DO reason about plot
            // continuity — knowing which threads are open helps them
            // catch missed-payoff regressions. Inlined at the tail of
            // the trailing user `iterationPrompt` so the system prefix
            // stays byte-identical across rounds when notes flip mid-
            // run (upstream prompt cache holds). A trailing user
            // `<runtime_state>` message would violate the consecutive-
            // user-role constraint (iterationPrompt is already user
            // role and some providers reject that).
            const openNotesBlockForNode = await loadOpenNotesBlock(options?.runtime?.contextForNotes);
            const iterationPromptWithNotes = openNotesBlockForNode
                ? iterationPrompt + '\n\n' + openNotesBlockForNode
                : iterationPrompt;
            const taskMessages = [
                ...(systemText ? [{ role: 'system', content: systemText }] : []),
                ...runtimeToolMessages,
                { role: 'user', content: iterationPromptWithNotes },
            ];
            if (systemText) conversation.messages.push({ role: 'system', content: systemText });
            // Carry forward any prior runtimeToolMessages from earlier
            // review rounds (e.g. previous rerun → assistant turn).
            for (const carried of runtimeToolMessages) {
                conversation.messages.push({ ...carried });
            }
            conversation.messages.push({ role: 'user', content: iterationPromptWithNotes, _round: round });
            const detailed = await requestToolCallsWithRetry(context, settings, {
                taskMessages,
                runtimeWorldInfo,
                apiPresetName,
                llmPresetName,
                tools,
                allowedNames,
                abortSignal,
                includeAssistantText: true,
                allowNoToolCalls: false,
                onUsage: options?.runtime?.runId
                    ? (usage) => {
                        try { addTokenUsage({ runId: options.runtime.runId, usage }); } catch (_) { /* store may have been cleared */ }
                    }
                    : null,
            });
            const decision = extractReviewDecision(detailed?.toolCalls || [], nodeSpec.id);
            // Record the assistant turn with the review decision tool call.
            conversation.messages.push({
                role: 'assistant',
                content: String(detailed?.assistantText || ''),
                reasoning: String(detailed?.reasoning || ''),
                tool_calls: (Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [])
                    .map(c => ({ id: c?.id || '', name: String(c?.name || ''), args: c?.args || {} })),
                _round: round,
            });
            if (decision.action === 'approve') {
                upsertRuntimeApprovedReviewFeedbackEntry(options?.runtime, {
                    stageIndex: Number(options?.stageIndex || 0),
                    stageId: String(options?.stageId || ''),
                    nodeIndex: Number(options?.nodeIndex || 0),
                    nodeId: String(nodeSpec?.id || ''),
                    feedback: String(decision.reason || ''),
                });
                finishRuntimeNodeAttempt(trace, traceAttempt, {
                    status: 'completed',
                    action: 'approve',
                    reason: String(decision.reason || ''),
                    conversation,
                });
                return {
                    previousNodeOutputs: currentPreviousNodeOutputs,
                    currentStageWorkerOutputs: currentStageOutputs,
                };
            }

            if (Number(options?.runtime?.reviewRerunCount || 0) >= maxReruns) {
                throw new Error(`Review rerun limit reached (${maxReruns}).`);
            }

            const targetEntries = resolveReviewTargetEntries(
                options?.runtime?.stages || [],
                Number(options?.stageIndex || 0),
                Number(options?.nodeIndex || 0),
                decision.targetNodeIds,
            );
            options.runtime.reviewRerunCount = Number(options.runtime.reviewRerunCount || 0) + 1;
            if (trace && typeof trace === 'object') {
                trace.reviewRerunCount = Number(options.runtime.reviewRerunCount || 0);
            }
            const replay = await replayStagesToReview(context, payload, messages, profile, options.runtime, {
                currentStageIndex: Number(options?.stageIndex || 0),
                currentNodeIndex: Number(options?.nodeIndex || 0),
                targetEntries,
                currentStageWorkerOutputs: currentStageOutputs,
                rerunReason: decision.reason,
            }, abortSignal);
            currentPreviousNodeOutputs = replay.previousNodeOutputs;
            currentStageOutputs = replay.currentStageWorkerOutputs;
            finishRuntimeNodeAttempt(trace, traceAttempt, {
                status: 'completed',
                action: 'rerun',
                reason: String(decision.reason || ''),
                targetNodeIds: targetEntries.map(entry => entry.nodeId),
                replayResult: replay.result,
                conversation,
            });
            appendStandardToolRoundMessages(runtimeToolMessages, [{
                name: ORCH_REVIEW_TOOL_RERUN,
                args: {
                    target_node_ids: targetEntries.map(entry => entry.nodeId),
                    [ORCH_REVIEW_FEEDBACK_FIELD]: decision.reason,
                },
                result: replay.result,
            }], detailed?.assistantText || '', {
                reasoning: String(detailed?.reasoning || ''),
                reasoningBlocks: Array.isArray(detailed?.reasoningBlocks) && detailed.reasoningBlocks.length > 0
                    ? detailed.reasoningBlocks
                    : null,
                reasoningDetails: Array.isArray(detailed?.reasoningDetails) && detailed.reasoningDetails.length > 0
                    ? detailed.reasoningDetails
                    : null,
            });
        } catch (error) {
            finishRuntimeNodeAttempt(trace, traceAttempt, {
                status: 'failed',
                error: String(error?.message || error),
                conversation,
            });
            throw error;
        }
    }

    throw new Error(`Review node '${nodeSpec.id}' exceeded max rounds (${maxRounds}).`);
}

export async function executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal = null, options = {}) {
    const stage = runtime?.stages?.[stageIndex];
    const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : []).map(rawNode => normalizeNodeSpec(rawNode));
    const stopBeforeNodeIndex = Number.isInteger(options?.stopBeforeNodeIndex)
        ? Math.max(0, Math.min(nodes.length, Number(options.stopBeforeNodeIndex)))
        : null;
    const stageId = String(stage?.id || `stage_${Number(stageIndex || 0) + 1}`);
    const seedStageWorkerOutputs = options?.seedStageWorkerOutputs instanceof Map
        ? mergeNodeOutputMaps(options.seedStageWorkerOutputs)
        : new Map();
    const rerunNodeIds = options?.rerunNodeIds instanceof Set
        ? new Set([...options.rerunNodeIds].map(nodeId => sanitizeIdentifierToken(nodeId, '')).filter(Boolean))
        : null;
    let rerunReasonByNodeId = null;
    if (options?.rerunReasonByNodeId instanceof Map) {
        rerunReasonByNodeId = new Map();
        for (const [nodeId, reason] of options.rerunReasonByNodeId.entries()) {
            const sanitizedNodeId = sanitizeIdentifierToken(nodeId, '');
            if (!sanitizedNodeId) {
                continue;
            }
            rerunReasonByNodeId.set(sanitizedNodeId, String(reason || ''));
        }
    }
    const shouldRunWorkerNode = (nodeId) => !(rerunNodeIds instanceof Set) || rerunNodeIds.has(nodeId);
    const resolveRerunReasonForNode = (nodeId) => {
        if (!(rerunReasonByNodeId instanceof Map)) {
            return undefined;
        }
        const key = sanitizeIdentifierToken(nodeId, '');
        if (!key || !rerunReasonByNodeId.has(key)) {
            return undefined;
        }
        return String(rerunReasonByNodeId.get(key) || '');
    };
    const effectiveMode = getStageRuntimeMode(stage);
    const isFullStage = stopBeforeNodeIndex === null;
    const isFinalStage = isFullStage && stageIndex === Number(runtime?.stages?.length || 0) - 1;
    const traceStageState = beginRuntimeStage(runtime?.trace, stage, stageIndex, {
        replay: Boolean(options?.replay || options?.rerunNodeIds instanceof Set || options?.seedStageWorkerOutputs instanceof Map),
        stopBeforeNodeIndex,
    });
    let traceStageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);

    // Run-panel: each stage maps to a round. Replays / partial executes get
    // a suffixed id so the panel doesn't collide on `stage-<id>`.
    const panelRoundId = options?.replay || options?.rerunNodeIds instanceof Set
        ? `stage-${stageId}-replay-${Number(runtime?.reviewRerunCount || 0)}`
        : `stage-${stageId}`;
    const panelRunId = runtime?.runId || null;
    if (panelRunId) {
        try {
            appendRound({ runId: panelRunId, round: { id: panelRoundId, label: i18nFormat('Stage: ${0}', stageId) } });
        } catch (_) { /* run may have been cleared */ }
    }

    try {
        if (effectiveMode === 'parallel' && isFullStage) {
            const stageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);
            // Cache-warmup barrier scoped to this parallel stage — same
            // rationale as director sub-agent fan-out (see
            // dispatch-barrier.js): nodes that share the same resolved
            // connection profile serialize their upstream first-chunk
            // moment so the second/third sibling sees a warmed prompt
            // cache instead of racing a cold cache-write. Scope is
            // per-stage (not per-run) because different stages are
            // sequential and cache-warmth naturally carries across from
            // the previous stage's write; barrier only helps within
            // the concurrent Promise.all fan-out here.
            const stageBarrier = createFirstChunkBarrier();
            const outputs = await Promise.all(nodes
                .map((nodeSpec, nodeIndex) => ({ nodeSpec, nodeIndex }))
                .filter(({ nodeSpec }) => shouldRunWorkerNode(nodeSpec.id) || !stageWorkerOutputs.has(nodeSpec.id))
                .map(async ({ nodeSpec, nodeIndex }) => {
                    if (isReviewNodeSpec(nodeSpec)) {
                        throw new Error(`Review node '${nodeSpec.id}' cannot run in a parallel execution stage.`);
                    }
                    const sectionId = panelRunId
                        ? ensureSection({ runId: panelRunId, roundId: panelRoundId, section: { id: `node-${nodeSpec.id}`, kind: 'text', title: i18n('Text') } })
                        : null;
                    // Resolve this node's connection profile as barrier
                    // grouping key. Falsy → barrier opt-out (see
                    // dispatch-barrier.js). We also skip barrier when
                    // the preset isn't streaming, because a
                    // non-streaming lead can't fire an early
                    // first-chunk signal — followers would only unblock
                    // when the lead's whole response finishes, which
                    // is worse than the pre-barrier baseline.
                    const nodePreset = profile.presets[nodeSpec.preset] || {};
                    const resolvedLlmPresetName = resolveOrchestrationAgentPromptPresetName(extension_settings[MODULE_NAME], nodePreset)?.name || '';
                    const resolvedApiPresetName = resolveOrchestrationAgentApiPresetName(extension_settings[MODULE_NAME], nodePreset)?.name || '';
                    const streamEnabledForBarrier = typeof context?.isStreamingPresetEnabled === 'function'
                        && context.isStreamingPresetEnabled(resolvedLlmPresetName);
                    const barrierKey = streamEnabledForBarrier ? resolvedApiPresetName : '';
                    const barrierSlot = stageBarrier.acquire(barrierKey);
                    try {
                        if (barrierSlot.role === 'follower') {
                            // wait cannot reject by contract
                            try { await barrierSlot.wait; } catch { /* unreachable */ }
                            throwIfAborted(abortSignal, 'Orchestration aborted.');
                        }
                        const result = await runWorkerNode(context, payload, nodeSpec, nodePreset, messages, previousNodeOutputs, abortSignal, {
                            isFinalStage,
                            rerunReason: resolveRerunReasonForNode(nodeSpec.id),
                            stageIndex,
                            stageId,
                            nodeIndex,
                            runtime,
                            defaultTools: runtime?.specDefaultTools || null,
                            onFirstChunk: barrierSlot.role === 'lead' ? barrierSlot.signalFirstChunk : null,
                        });
                        if (panelRunId && sectionId) {
                            try {
                                appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId, delta: serializeTraceValue(result) });
                                setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId, status: 'done' });
                            } catch (_) { /* run may have been cleared */ }
                        }
                        return [nodeSpec.id, result];
                    } catch (err) {
                        if (panelRunId && sectionId) {
                            try {
                                setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId, status: 'failed', meta: { err: String(err?.message || err) } });
                            } catch (_) { /* run may have been cleared */ }
                        }
                        throw err;
                    } finally {
                        // Fail-open release: even if runWorkerNode threw
                        // or aborted before firing signalFirstChunk,
                        // followers must not hang. release() resolves
                        // any still-waiting followers by contract.
                        try { barrierSlot.release(); } catch { /* barrier release must never throw */ }
                    }
                }));
            for (const [nodeId, output] of outputs) {
                stageWorkerOutputs.set(nodeId, output);
            }
            traceStageWorkerOutputs = mergeNodeOutputMaps(stageWorkerOutputs);
            finishRuntimeStage(runtime?.trace, traceStageState, {
                status: 'completed',
                stageOutput: createStageOutputSnapshot(stage, stageWorkerOutputs),
            });
            if (panelRunId) {
                try {
                    setRoundStatus({ runId: panelRunId, roundId: panelRoundId, status: 'done' });
                } catch (_) { /* run may have been cleared */ }
            }
            return {
                previousNodeOutputs: mergeNodeOutputMaps(previousNodeOutputs),
                stageWorkerOutputs,
            };
        }

        let currentPreviousNodeOutputs = mergeNodeOutputMaps(previousNodeOutputs);
        let currentStageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);
        const limit = stopBeforeNodeIndex === null ? nodes.length : stopBeforeNodeIndex;

        for (let nodeIndex = 0; nodeIndex < limit; nodeIndex++) {
            const nodeSpec = nodes[nodeIndex];
            const preset = profile.presets[nodeSpec.preset] || {};
            if (isReviewNodeSpec(nodeSpec)) {
                const reviewSectionId = panelRunId
                    ? ensureSection({ runId: panelRunId, roundId: panelRoundId, section: { id: `node-${nodeSpec.id}`, kind: 'note', title: i18n('Note') } })
                    : null;
                try {
                    const reviewResult = await runReviewNode(
                        context,
                        payload,
                        profile,
                        nodeSpec,
                        preset,
                        messages,
                        currentPreviousNodeOutputs,
                        currentStageWorkerOutputs,
                        abortSignal,
                        {
                            isFinalStage,
                            stageIndex,
                            stageId,
                            nodeIndex,
                            runtime,
                        },
                    );
                    if (panelRunId && reviewSectionId) {
                        try {
                            setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: reviewSectionId, status: 'done' });
                        } catch (_) { /* run may have been cleared */ }
                    }
                    currentPreviousNodeOutputs = reviewResult.previousNodeOutputs;
                    currentStageWorkerOutputs = reviewResult.currentStageWorkerOutputs;
                    traceStageWorkerOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);
                    continue;
                } catch (err) {
                    if (panelRunId && reviewSectionId) {
                        try {
                            setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: reviewSectionId, status: 'failed', meta: { err: String(err?.message || err) } });
                        } catch (_) { /* run may have been cleared */ }
                    }
                    throw err;
                }
            }

            if (!shouldRunWorkerNode(nodeSpec.id) && currentStageWorkerOutputs.has(nodeSpec.id)) {
                continue;
            }
            const sectionId = panelRunId
                ? ensureSection({ runId: panelRunId, roundId: panelRoundId, section: { id: `node-${nodeSpec.id}`, kind: 'text', title: i18n('Text') } })
                : null;
            try {
                const output = await runWorkerNode(context, payload, nodeSpec, preset, messages, currentPreviousNodeOutputs, abortSignal, {
                    isFinalStage,
                    rerunReason: resolveRerunReasonForNode(nodeSpec.id),
                    stageIndex,
                    stageId,
                    nodeIndex,
                    runtime,
                    defaultTools: runtime?.specDefaultTools || null,
                });
                if (panelRunId && sectionId) {
                    try {
                        appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId, delta: serializeTraceValue(output) });
                        setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId, status: 'done' });
                    } catch (_) { /* run may have been cleared */ }
                }
                currentStageWorkerOutputs.set(nodeSpec.id, output);
                traceStageWorkerOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);
                throwIfAborted(abortSignal, 'Orchestration aborted.');
            } catch (err) {
                if (panelRunId && sectionId) {
                    try {
                        setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId, status: 'failed', meta: { err: String(err?.message || err) } });
                    } catch (_) { /* run may have been cleared */ }
                }
                throw err;
            }
        }

        finishRuntimeStage(runtime?.trace, traceStageState, {
            status: 'completed',
            stageOutput: createStageOutputSnapshot(stage, currentStageWorkerOutputs),
        });
        if (panelRunId) {
            try {
                setRoundStatus({ runId: panelRunId, roundId: panelRoundId, status: 'done' });
            } catch (_) { /* run may have been cleared */ }
        }
        return {
            previousNodeOutputs: currentPreviousNodeOutputs,
            stageWorkerOutputs: currentStageWorkerOutputs,
        };
    } catch (error) {
        finishRuntimeStage(runtime?.trace, traceStageState, {
            status: 'failed',
            error: String(error?.message || error),
            stageOutput: createStageOutputSnapshot(stage, traceStageWorkerOutputs),
        });
        if (panelRunId) {
            try {
                setRoundStatus({ runId: panelRunId, roundId: panelRoundId, status: 'failed' });
            } catch (_) { /* run may have been cleared */ }
        }
        throw error;
    }
}

export async function runSpecOrchestration(context, payload, messages, profile, deps = {}) {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const trace = createRuntimeTrace(context, payload, stages);
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    const chatKey = String(trace.chatKey || '');
    const runId = startRun({
        mode: 'spec',
        chatKey,
        abortFn: () => { try { Luker.getContext().stopGeneration(); } catch (_) { /* best-effort */ } },
        // Fast-unwind hook installed by the top-level orchestration
        // dispatch in main.js. When present, the run panel's Stop
        // button prefers it over `abortFn` so the cancel takes the
        // clean 'user_stopped' branch (Promise.race short-circuit +
        // cancelled-event emission) instead of waiting for the LLM
        // sender to reject and the runtime catch block to reach
        // `finishRun`. Undefined for iter-studio simulations and any
        // future direct-runtime invocations — those still get raw
        // `abortFn` semantics.
        stopFn: typeof payload?.__lukerResolveStopRequest === 'function'
            ? payload.__lukerResolveStopRequest
            : null,
        quiet: Boolean(payload?.__lukerSimulate),
    });
    // Notes adapter overlay — same shape loop-runtime / director mount.
    // Threaded into runtime.contextForNotes so every worker node injects
    // the `## Open Notes` block into its task messages regardless of
    // whether the node has loop tools enabled. Prototype-chain overlay
    // keeps live ST APIs (createFloorState factory, etc.) reachable.
    // Best-effort: mount failure degrades to no Open Notes block, never
    // aborts orchestration.
    const contextForNotes = await (async () => {
        const notesCtx = Object.create(context);
        try { await attachNotesFloorState(notesCtx); } catch (_) { /* best-effort */ }
        return notesCtx;
    })();
    const runtime = {
        stages,
        stageOutputs: [],
        reviewRerunCount: 0,
        approvedReviewFeedbackEntries: [],
        trace,
        // Bound to the run-panel store run so each node attempt can
        // append its round/section under the right run id.
        runId,
        // Profile-root tool defaults applied to every node whose own
        // `tools` is null. Node-level override still takes precedence in
        // the resolver inside runWorkerNode.
        specDefaultTools: spec.defaultTools || null,
        // Carries the sanitized spec for downstream skill resolution.
        // Worker nodes read `runtime.spec.skills` for the mode-level
        // visibility default; each node's own `skills` (when set) layers
        // on top via the `+` inheritance idiom.
        spec,
        // Layer-3 custom tools live on the profile root (not the spec).
        // Built once per orchestration and threaded into every node via
        // `runtime.customToolRegistry`. runWorkerNode forwards it to
        // both getEnabledToolSchemas and the per-call executeLoopTool ctx.
        customToolRegistry: buildPerRunCustomToolRegistry(profile, trace, recordRuntimeEvent),
        // Active orch-preset name captured at main.js runOrchestration
        // entry. runWorkerNode threads it to buildSkillRuntimeContext so
        // orch-preset scope filtering activates for spec worker nodes.
        // Per-node `preset` at runWorkerNode is the per-NODE preset from
        // profile.presets[nodeSpec.preset] — not the top-level orch preset.
        activeOrchPresetName: String(deps?.activeOrchPresetName || '').trim(),
        // Prototype-chain overlay with the persistent notes floor-state
        // adapter mounted on it. Worker nodes read this to inject the
        // `## Open Notes` block into their task messages so every spec
        // agent sees the same plot-author threads the loop / director
        // main agent sees. Visibility is universal; mutation still
        // requires `tools.note` on the per-node preset.
        contextForNotes,
    };
    let previousNodeOutputs = new Map();
    throwIfAborted(abortSignal, 'Orchestration aborted.');

    try {
        for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const stage = stages[stageIndex];
            const stageResult = await executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal);
            previousNodeOutputs = mergeNodeOutputMaps(stageResult.previousNodeOutputs, stageResult.stageWorkerOutputs);
            runtime.stageOutputs.push(createStageOutputSnapshot(stage, stageResult.stageWorkerOutputs));
        }

        // Spec mode's final guidance lives in the last stage's `text` node
        // output; pull it via the snapshot for finishRun.
        const lastStageSnapshot = runtime.stageOutputs[runtime.stageOutputs.length - 1];
        const finalText = String(lastStageSnapshot?.nodes?.[0]?.output?.text ?? lastStageSnapshot?.nodes?.[0]?.output ?? '');
        finalizeRuntimeTrace(trace, 'completed', {
            capsuleText: finalText,
            reviewRerunCount: runtime.reviewRerunCount,
        });
        try {
            finishRun({ runId, status: 'committed', finalText });
        } catch (_) { /* run may already be cleared */ }

        return { stageOutputs: runtime.stageOutputs, previousNodeOutputs, runtimeTrace: runtime.trace, reviewRerunCount: runtime.reviewRerunCount };
    } catch (error) {
        finalizeRuntimeTrace(trace, 'failed', { error: String(error?.message || error) });
        try {
            finishRun({ runId, status: 'error', error: String(error?.message || error) });
        } catch (_) { /* run may already be cleared */ }
        throw error;
    }
}
