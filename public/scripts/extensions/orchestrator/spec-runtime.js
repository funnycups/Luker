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

import { extension_settings } from '../../extensions.js';
import { isAbortSignalLike, throwIfAborted } from './abort-utils.js';
import { extractLastUserMessage, getRecentMessages } from './anchors.js';
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
} from './output-formatting.js';
import {
    buildAutoInjectedNodePromptPrelude,
    buildReviewRuntimeContextText,
    getRuntimeApprovedReviewFeedbackEntries,
    trimRuntimeApprovedReviewFeedbackEntries,
    upsertRuntimeApprovedReviewFeedbackEntry,
} from './review-feedback.js';
import {
    beginOrchestrationRuntimeNodeAttempt,
    beginOrchestrationRuntimeStage,
    createOrchestrationRuntimeTrace,
    finishOrchestrationRuntimeNodeAttempt,
    finishOrchestrationRuntimeStage,
    recordOrchestrationRuntimeEvent,
} from './runtime-trace.js';
import { getPreviousOrchestrationCapsuleText } from './snapshot-cache.js';
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
import { attachToolContext, isStructuredToolError } from './loop-runtime.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';

const MODULE_NAME = 'orchestrator';

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

export async function runWorkerNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal = null, options = {}) {
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    const isFinalStage = Boolean(options?.isFinalStage);
    const trace = options?.runtime?.trace;
    const traceAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
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
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
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
        last_user: String(lastUser?.mes || ''),
        previous_outputs: previousOutputs,
        distiller: distillerOutput,
        previous_snapshot: '',
        previous_orchestration: AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
    });

    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset);
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, preset);
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
    // so the runtime-trace popup can render the per-attempt message thread.
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
                '## node_iteration_round',
                `${round}/${maxRounds}`,
            ].filter(Boolean).join('\n\n');

            const systemText = String(preset.systemPrompt || '').trim();
            const taskMessages = [
                ...(systemText ? [{ role: 'system', content: systemText }] : []),
                ...runtimeToolMessages,
                { role: 'user', content: iterationPrompt },
            ];
            conversation.messages.push({ role: 'user', content: iterationPrompt, _round: round });

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
                    finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
                        status: 'completed',
                        output: finalText,
                        conversation,
                    });
                    return finalText;
                }
                if (finalizedOutput && typeof finalizedOutput === 'object') {
                    finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
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
                            arguments: JSON.stringify(tc?.args && typeof tc.args === 'object' ? tc.args : {}),
                        },
                        source: resolveToolSource(normalizedName, toolContext),
                    };
                });
                runtimeToolMessages.push({
                    role: 'assistant',
                    content: String(detailed?.assistantText || ''),
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
        finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
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
    recordOrchestrationRuntimeEvent(runtime?.trace, 'replay_started', {
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
    recordOrchestrationRuntimeEvent(runtime?.trace, 'replay_finished', replayResult);

    return {
        previousNodeOutputs: currentStagePrefix.previousNodeOutputs,
        currentStageWorkerOutputs: currentStagePrefix.stageWorkerOutputs,
        result: replayResult,
    };
}

export async function runReviewNode(context, payload, profile, nodeSpec, preset, messages, previousNodeOutputs, currentStageWorkerOutputs, abortSignal = null, options = {}) {
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    if (Boolean(options?.isFinalStage)) {
        throw new Error(`Review node '${nodeSpec.id}' cannot be used in the final stage.`);
    }

    const settings = extension_settings[MODULE_NAME];
    const maxReruns = getReviewRerunMaxRounds(settings);
    const maxRounds = Math.max(1, getNodeIterationMaxRounds(settings) + maxReruns + 1);
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const runtimeTemplate = normalizeTemplateForRuntime(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '');
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset);
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, preset);
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
        const traceAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
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
                last_user: String(lastUser?.mes || ''),
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
                '## node_iteration_round',
                `${round}/${maxRounds}`,
            ].filter(Boolean).join('\n\n');

            const systemText = String(preset.systemPrompt || '').trim();
            const taskMessages = [
                ...(systemText ? [{ role: 'system', content: systemText }] : []),
                ...runtimeToolMessages,
                { role: 'user', content: iterationPrompt },
            ];
            if (systemText) conversation.messages.push({ role: 'system', content: systemText });
            // Carry forward any prior runtimeToolMessages from earlier
            // review rounds (e.g. previous rerun → assistant turn).
            for (const carried of runtimeToolMessages) {
                conversation.messages.push({ ...carried });
            }
            conversation.messages.push({ role: 'user', content: iterationPrompt, _round: round });
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
                finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
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
            finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
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
            }], detailed?.assistantText || '');
        } catch (error) {
            finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
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
    const traceStageState = beginOrchestrationRuntimeStage(runtime?.trace, stage, stageIndex, {
        replay: Boolean(options?.replay || options?.rerunNodeIds instanceof Set || options?.seedStageWorkerOutputs instanceof Map),
        stopBeforeNodeIndex,
    });
    let traceStageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);

    try {
        if (effectiveMode === 'parallel' && isFullStage) {
            const stageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);
            const outputs = await Promise.all(nodes
                .map((nodeSpec, nodeIndex) => ({ nodeSpec, nodeIndex }))
                .filter(({ nodeSpec }) => shouldRunWorkerNode(nodeSpec.id) || !stageWorkerOutputs.has(nodeSpec.id))
                .map(async ({ nodeSpec, nodeIndex }) => {
                    if (isReviewNodeSpec(nodeSpec)) {
                        throw new Error(`Review node '${nodeSpec.id}' cannot run in a parallel execution stage.`);
                    }
                    return [
                        nodeSpec.id,
                        await runWorkerNode(context, payload, nodeSpec, profile.presets[nodeSpec.preset] || {}, messages, previousNodeOutputs, abortSignal, {
                            isFinalStage,
                            rerunReason: resolveRerunReasonForNode(nodeSpec.id),
                            stageIndex,
                            stageId,
                            nodeIndex,
                            runtime,
                            defaultTools: runtime?.specDefaultTools || null,
                        }),
                    ];
                }));
            for (const [nodeId, output] of outputs) {
                stageWorkerOutputs.set(nodeId, output);
            }
            traceStageWorkerOutputs = mergeNodeOutputMaps(stageWorkerOutputs);
            finishOrchestrationRuntimeStage(runtime?.trace, traceStageState, {
                status: 'completed',
                stageOutput: createStageOutputSnapshot(stage, stageWorkerOutputs),
            });
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
                currentPreviousNodeOutputs = reviewResult.previousNodeOutputs;
                currentStageWorkerOutputs = reviewResult.currentStageWorkerOutputs;
                traceStageWorkerOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);
                continue;
            }

            if (!shouldRunWorkerNode(nodeSpec.id) && currentStageWorkerOutputs.has(nodeSpec.id)) {
                continue;
            }
            const output = await runWorkerNode(context, payload, nodeSpec, preset, messages, currentPreviousNodeOutputs, abortSignal, {
                isFinalStage,
                rerunReason: resolveRerunReasonForNode(nodeSpec.id),
                stageIndex,
                stageId,
                nodeIndex,
                runtime,
                defaultTools: runtime?.specDefaultTools || null,
            });
            currentStageWorkerOutputs.set(nodeSpec.id, output);
            traceStageWorkerOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);
            throwIfAborted(abortSignal, 'Orchestration aborted.');
        }

        finishOrchestrationRuntimeStage(runtime?.trace, traceStageState, {
            status: 'completed',
            stageOutput: createStageOutputSnapshot(stage, currentStageWorkerOutputs),
        });
        return {
            previousNodeOutputs: currentPreviousNodeOutputs,
            stageWorkerOutputs: currentStageWorkerOutputs,
        };
    } catch (error) {
        finishOrchestrationRuntimeStage(runtime?.trace, traceStageState, {
            status: 'failed',
            error: String(error?.message || error),
            stageOutput: createStageOutputSnapshot(stage, traceStageWorkerOutputs),
        });
        throw error;
    }
}

export async function runSpecOrchestration(context, payload, messages, profile) {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const trace = createOrchestrationRuntimeTrace(context, payload, stages);
    const runtime = {
        stages,
        stageOutputs: [],
        reviewRerunCount: 0,
        approvedReviewFeedbackEntries: [],
        trace,
        // Profile-root tool defaults applied to every node whose own
        // `tools` is null. Node-level override still takes precedence in
        // the resolver inside runWorkerNode.
        specDefaultTools: spec.defaultTools || null,
        // Layer-3 custom tools live on the profile root (not the spec).
        // Built once per orchestration and threaded into every node via
        // `runtime.customToolRegistry`. runWorkerNode forwards it to
        // both getEnabledToolSchemas and the per-call executeLoopTool ctx.
        customToolRegistry: buildPerRunCustomToolRegistry(profile, trace, recordOrchestrationRuntimeEvent),
    };
    let previousNodeOutputs = new Map();
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    throwIfAborted(abortSignal, 'Orchestration aborted.');

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const stage = stages[stageIndex];
        const stageResult = await executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal);
        previousNodeOutputs = mergeNodeOutputMaps(stageResult.previousNodeOutputs, stageResult.stageWorkerOutputs);
        runtime.stageOutputs.push(createStageOutputSnapshot(stage, stageResult.stageWorkerOutputs));
    }

    return { stageOutputs: runtime.stageOutputs, previousNodeOutputs, runtimeTrace: runtime.trace, reviewRerunCount: runtime.reviewRerunCount };
}
