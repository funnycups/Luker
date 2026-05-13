/**
 * AI orchestration-profile builder for the orchestrator.
 *
 * "AI build" is the editor flow that asks an LLM to produce a complete
 * orchestration profile (spec + presetPatch) from a character card. The
 * LLM is bound to three tools — `luker_orch_append_stage`,
 * `luker_orch_upsert_preset`, `luker_orch_finalize_profile` — that
 * together let it stream a profile incrementally and then explicitly
 * finalize.
 *
 * Module layout:
 *
 *   - `validateAiBuildTemplateVariables(spec, presetPatch)` — pure
 *     validator that scans every node template and preset template for
 *     unsupported `{{var}}` references and throws a single descriptive
 *     error if any are found.
 *   - `sanitizeProfileForAiPrompt(profile)` — projects a `{ spec, presets }`
 *     pair down to the AI-visible shape (templates normalized, preset
 *     fields collapsed). Used to feed the *current* global profile back
 *     into the AI as `globalOrchestrationSpec` / `globalPresets`.
 *   - `buildAiProfileFromToolCalls(toolCalls)` — folds the tool-call
 *     stream into `{ orchestrationSpec, presetPatch, finalizeCalled,
 *     hasStageUpdate }`. Caller decides what to do when `finalizeCalled`
 *     or `hasStageUpdate` are false.
 *   - `buildAiOrchestrationProfile(context, settings, ...)` — the entry
 *     point. Composes the system + user prompts, issues the tool-call
 *     request with `toolCallRetryMax` semantic retries, runs the call
 *     stream through `buildAiProfileFromToolCalls`, validates with
 *     `validateAiBuildTemplateVariables`, and returns the parsed profile.
 *     Caller (main.js) is responsible for projecting it into the editor
 *     state and persisting.
 *
 * No UI-state mutation, no editor reads. The caller wires status updates
 * in via `onStatusUpdate` so this module stays UI-free.
 */

import { isAbortError } from './abort-utils.js';
import { getRecentMessages } from './anchors.js';
import {
    AI_VISIBLE_TEMPLATE_VARS,
    ALLOWED_TEMPLATE_VARS,
    ORCH_AI_QUALITY_AXES,
    ORCH_NODE_TYPE_REVIEW,
    ORCH_NODE_TYPE_WORKER,
    ORCH_REVIEW_FEEDBACK_FIELD,
    REQUIRED_AI_BUILD_NODE_IDS,
    getCriticPromptReminderLines,
    getCriticReviewNodeContractShape,
    getDefaultAiSuggestSystemPrompt,
} from './defaults.js';
import {
    buildAgentApiRoutingPromptData,
    buildAgentPromptPresetRoutingPromptData,
    getPresetApiPresetName,
    getPresetPromptPresetName,
    resolveOrchestrationRuntimeWorldInfo,
    sanitizeConnectionProfileName,
    sanitizePromptPresetName,
} from './agent-resolution.js';
import { sanitizePresetMap } from './editable-spec.js';
import { i18n } from './i18n.js';
import { buildAiSuggestInputXml } from './output-formatting.js';
import {
    normalizeNodeSpec,
    normalizeNodeType,
    sanitizeSpec,
} from './spec-schema.js';
import {
    getUnsupportedTemplateVariables,
    normalizeTemplateForAiPrompt,
    normalizeTemplateForRuntime,
} from './template-vars.js';
import { requestToolCallsWithRetry } from './tool-calling.js';
import { normalizeWorldInfoResolverMessages } from './world-info.js';

const MODULE_NAME = 'orchestrator';

export function validateAiBuildTemplateVariables(spec, presetPatch) {
    const errors = [];
    const safeSpec = sanitizeSpec(spec);
    const safePatch = (presetPatch && typeof presetPatch === 'object') ? presetPatch : {};

    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    for (const stage of stages) {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        for (const rawNode of nodes) {
            const node = normalizeNodeSpec(rawNode);
            if (typeof node.userPromptTemplate !== 'string' || !node.userPromptTemplate.trim()) {
                continue;
            }
            const unsupported = getUnsupportedTemplateVariables(node.userPromptTemplate);
            if (unsupported.length > 0) {
                errors.push(`Node '${node.id}': ${unsupported.join(', ')}`);
            }
        }
    }

    for (const [presetId, preset] of Object.entries(safePatch)) {
        const template = String(preset?.userPromptTemplate || '');
        if (!template.trim()) {
            continue;
        }
        const unsupported = getUnsupportedTemplateVariables(template);
        if (unsupported.length > 0) {
            errors.push(`Preset '${presetId}': ${unsupported.join(', ')}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `Unsupported template variables found. Allowed: ${ALLOWED_TEMPLATE_VARS.join(', ')}. ` +
            `Invalid usage -> ${errors.join(' | ')}`,
        );
    }
}

export function sanitizeProfileForAiPrompt(profile = null) {
    const safeSpec = sanitizeSpec(profile?.spec);
    const safePresets = sanitizePresetMap(profile?.presets);
    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    const sanitizedStages = stages.map((stage) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const sanitizedNodes = nodes.map((rawNode) => {
            if (typeof rawNode === 'string') {
                return rawNode;
            }
            const node = normalizeNodeSpec(rawNode);
            const nextNode = {
                id: String(node?.id || '').trim(),
                preset: String(node?.preset || node?.id || '').trim(),
                type: normalizeNodeType(node?.type),
            };
            const template = String(node?.userPromptTemplate || '');
            if (template.trim()) {
                nextNode.userPromptTemplate = normalizeTemplateForAiPrompt(template);
            }
            return nextNode.id ? nextNode : null;
        }).filter(Boolean);
        return {
            id: String(stage?.id || '').trim(),
            mode: String(stage?.mode || '').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: sanitizedNodes,
        };
    });

    const sanitizedPresets = {};
    for (const [presetId, preset] of Object.entries(safePresets || {})) {
        sanitizedPresets[presetId] = {
            systemPrompt: String(preset?.systemPrompt || '').trim(),
            userPromptTemplate: normalizeTemplateForAiPrompt(String(preset?.userPromptTemplate || '').trim()),
            apiPresetName: getPresetApiPresetName(preset),
            promptPresetName: getPresetPromptPresetName(preset),
        };
    }

    return {
        spec: { stages: sanitizedStages },
        presets: sanitizedPresets,
    };
}

export function buildAiProfileFromToolCalls(toolCalls) {
    const draftStages = [];
    const draftPresets = {};
    let finalizeCalled = false;
    let hasStageUpdate = false;

    const upsertStage = (rawStage) => {
        if (!rawStage || typeof rawStage !== 'object') {
            return;
        }
        const stageId = String(rawStage.id || '').trim();
        if (!stageId) {
            return;
        }
        const mode = String(rawStage.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(rawStage.nodes) ? rawStage.nodes : [];
        const normalizedNodes = nodes
            .map((rawNode) => {
                const node = normalizeNodeSpec(rawNode);
                if (!node?.id) {
                    return null;
                }
                const nextNode = {
                    id: String(node.id || '').trim(),
                    preset: String(node.preset || node.id || '').trim(),
                    type: normalizeNodeType(node.type),
                };
                const template = String(node.userPromptTemplate || '');
                if (template.trim()) {
                    nextNode.userPromptTemplate = normalizeTemplateForRuntime(template);
                }
                return nextNode.id ? nextNode : null;
            })
            .filter(node => Boolean(node?.id));
        if (normalizedNodes.length === 0) {
            return;
        }
        const nextStage = { id: stageId, mode, nodes: normalizedNodes };
        const existingIndex = draftStages.findIndex(stage => String(stage.id || '') === stageId);
        if (existingIndex >= 0) {
            draftStages[existingIndex] = nextStage;
        } else {
            draftStages.push(nextStage);
        }
        hasStageUpdate = true;
    };

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const fnName = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        if (!fnName) {
            continue;
        }
        if (fnName === 'luker_orch_append_stage') {
            upsertStage({
                id: args.stage_id,
                mode: args.mode,
                nodes: args.nodes,
            });
            continue;
        }
        if (fnName === 'luker_orch_upsert_preset') {
            const presetId = String(args.preset_id || '').trim();
            if (!presetId) {
                continue;
            }
            const nextPreset = {
                ...(draftPresets[presetId] || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
            };
            if (Object.prototype.hasOwnProperty.call(args, 'apiPresetName')) {
                nextPreset.apiPresetName = sanitizeConnectionProfileName(args.apiPresetName);
            }
            if (Object.prototype.hasOwnProperty.call(args, 'promptPresetName')) {
                nextPreset.promptPresetName = sanitizePromptPresetName(args.promptPresetName);
            }
            draftPresets[presetId] = nextPreset;
            continue;
        }
        if (fnName === 'luker_orch_finalize_profile') {
            finalizeCalled = true;
        }
    }

    const presetPatch = {};
    for (const [presetId, preset] of Object.entries(draftPresets)) {
        if (!preset || typeof preset !== 'object') {
            continue;
        }
        const nextPreset = {
            systemPrompt: String(preset.systemPrompt || '').trim(),
            userPromptTemplate: String(preset.userPromptTemplate || '').trim(),
        };
        if (Object.prototype.hasOwnProperty.call(preset, 'apiPresetName')) {
            nextPreset.apiPresetName = sanitizeConnectionProfileName(preset.apiPresetName);
        }
        if (Object.prototype.hasOwnProperty.call(preset, 'promptPresetName')) {
            nextPreset.promptPresetName = sanitizePromptPresetName(preset.promptPresetName);
        }
        presetPatch[presetId] = nextPreset;
    }

    return {
        orchestrationSpec: sanitizeSpec({ stages: draftStages }),
        presetPatch,
        finalizeCalled,
        hasStageUpdate,
    };
}

function buildAiOrchestrationSystemPrompt(settings) {
    const suggestSystemPromptBase = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    return [
        suggestSystemPromptBase,
        'Hard output rule: follow each node prompt\'s explicit thought policy.',
        'Reasoning-heavy node prompts should explicitly require one <thought>...</thought> before tool calls.',
        'Do not add extra narrative/body text outside the required output contract.',
        'Runtime hard contract (must follow): return COMPLETE tool calls in one response; never return only one tool call.',
        'At minimum include luker_orch_append_stage and luker_orch_finalize_profile in the same response.',
        'luker_orch_finalize_profile must be last.',
        `Must include dedicated required node ids: ${REQUIRED_AI_BUILD_NODE_IDS.join(', ')}.`,
        'Prefer the recommended blueprint unless strong card-specific reasons require deviation.',
        'Do not generate long identity-roleplay blocks for node prompts; keep them process-focused and operational.',
        'Treat the orchestration as hierarchical layers. Critic scope is local to the directly adjacent previous worker layer.',
        'Per-agent API routing is optional via preset field apiPresetName.',
        'Leave apiPresetName empty unless the user explicitly asks for per-agent provider/model routing differences.',
        'Empty apiPresetName means runtime falls back to the global orchestration API preset.',
        'If you set apiPresetName, use only a profile name from available_connection_profiles.',
        'Per-agent chat completion preset routing is optional via preset field promptPresetName.',
        'Leave promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing differences.',
        'Empty promptPresetName means runtime falls back to the global orchestration chat completion preset.',
        'If you set promptPresetName, use only a preset name from available_chat_completion_presets.',
        `Runtime prepends previous orchestration result and approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` before node template text; do not add placeholders for that context.`,
        'If you use a critic/reviewer, model it as a review node that approves or requests rerun only for node ids in the directly adjacent previous worker layer.',
        'If grounding, reasoning, or other layers each need audit, add separate critics after those layers instead of deferring all review to one final critic.',
        'Never create consecutive review-only stages or back-to-back critics with no worker layer between them.',
        ...getCriticPromptReminderLines(),
        `Review nodes do not emit synthesis. Downstream stages continue from passthrough worker outputs plus approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
        'Spec nodes optionally accept a `tools` block enabling loop-mode tools (chat/lorebook/memory/note/search) for that node — leave it unset by default. Only set tools when the user explicitly asks for tool-using behavior at a node, in which case the runtime will switch that node into a multi-round tool loop terminated by its node-output tool.',
        'When deviating, explicitly optimize for this character card while preserving hard gates and final function-call text contract.',
    ].join('\n');
}

function buildAiOrchestrationUserPrompt(context, settings, characterCard, overrideGoal, aiVisibleGlobalProfile) {
    return buildAiSuggestInputXml({
        character: characterCard,
        overrideGoal: String(overrideGoal || ''),
        runtimeContextGuarantees: {
            preset_assembly_is_applied: true,
            character_card_context_is_available: true,
            world_info_context_is_available: true,
            recent_messages_are_available: true,
            reminder: 'Do not duplicate static card data in every node; use behavior-focused checks.',
        },
        injectionContract: {
            injected_stage: 'only_last_stage',
            expected_last_stage_mode: 'serial_single_synthesizer_preferred',
            expected_guidance_format: 'function_call_text_direct_injection',
            no_json_or_markup_in_final_output: true,
        },
        agentApiRouting: buildAgentApiRoutingPromptData(settings),
        agentPromptPresetRouting: buildAgentPromptPresetRoutingPromptData(context, settings),
        mandatoryQualityAxes: ORCH_AI_QUALITY_AXES,
        qualityGateContract: {
            continuity: 'No timeline/scene continuity break.',
            causality: 'Actions and consequences must be causally coherent.',
            anti_ooc: 'Prevent role/persona drift and voice collapse.',
            lorebook_compliance: 'Respect active lorebook/world-info constraints as hard writing limits.',
            anti_datafication: 'Reject numeric/data-like roleplay prose and require natural narrative language.',
            anti_report_tone: 'Reject detached report/broadcast cadence; require in-scene vivid narration.',
            anti_overinterpretation: 'Avoid inflated/extreme interpretations without evidence.',
            realism: 'Behavior should remain human-believable and situationally plausible.',
            world_autonomy: 'World events should not always orbit the user.',
        },
        recommendedBlueprint: {
            stages: [
                { id: 'distill', mode: 'serial', nodes: ['distiller'] },
                { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
                { id: 'grounding_review', mode: 'serial', nodes: [{ id: 'grounding_critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
                { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
                { id: 'reason_review', mode: 'serial', nodes: [{ id: 'reason_critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
                { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
            ],
            role_contracts: {
                distiller: 'Produce compact evidence-grounded state snapshot.',
                lorebook_reader: 'Extract only active lorebook/world-info hard constraints relevant to this turn.',
                anti_data_guard: 'Enforce anti-data hard gates (no quantification/report tone/pseudo-analysis) and produce rewrite-safe guidance.',
                planner: 'Produce causally coherent next-step plan with explicit sequencing, evidence use, branching discipline, and clear stop conditions.',
                critic: `Audit only the directly adjacent previous worker layer against an explicit hardcoded checklist. Restate all audited-layer hard constraints and pass/fail checks inside the critic prompt itself because the critic does not see upstream worker prompt text at runtime. Then either approve or request rerun of specific node ids from that layer only. Always include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`. Do not emit synthesis.`,
                recall_relevance: 'Pick recalled facts that matter for this turn.',
                synthesizer: `Merge the approved worker outputs and approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` into one draft-ready final guidance.`,
            },
            layering_policy: {
                strict_hierarchy: true,
                critic_visibility_scope: 'Only the immediately previous worker layer.',
                critic_rerun_scope: 'Only node ids from the directly adjacent previous worker layer.',
                multi_critic_allowed: true,
                place_critic_after_each_audited_layer: true,
                no_adjacent_critics: true,
            },
            last_stage_rule: 'Prefer single synthesizer node as final stage output.',
            innovation_policy: {
                baseline_first: true,
                allow_stage_refactor: true,
                allow_node_role_innovation: true,
                must_preserve_hard_gates: true,
                must_preserve_review_passthrough: true,
                must_preserve_final_plain_text_contract: true,
                card_specific_optimization_required: true,
            },
        },
        antiPatterns: {
            no_fixed_identity_roleplay: true,
            no_long_persona_copy_paste: true,
            no_redundant_character_bio_per_node: true,
            no_data_metric_style_wording: true,
            no_json_blob_in_summary: true,
            no_single_tool_call_partial_output: true,
        },
        globalOrchestrationSpec: aiVisibleGlobalProfile.spec,
        globalPresets: aiVisibleGlobalProfile.presets,
        toolProtocol: {
            review_node_contract: {
                type_field: `Set node.type to "${ORCH_NODE_TYPE_REVIEW}" for review nodes. Omit or use "${ORCH_NODE_TYPE_WORKER}" for normal worker nodes.`,
                runtime_behavior: `Treat review nodes as auditing only the directly adjacent previous worker layer. They may request rerun only for specific node ids from that adjacent layer, and must emit mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`. Approved feedback is auto-injected into later nodes; rerun feedback is auto-injected into the targeted rerun nodes.`,
                topology_rule: 'Prefer a dedicated serial review stage immediately after the worker stage being audited. If multiple layers need audits, add multiple review stages. Do not place review nodes in the final stage or back-to-back with another review stage.',
                ...getCriticReviewNodeContractShape(),
            },
            append_stage: {
                function: 'luker_orch_append_stage',
                shape: {
                    stage_id: 'string',
                    mode: 'serial|parallel',
                    nodes: [{ id: 'string', preset: 'string', type: 'optional worker|review', userPromptTemplate: 'optional string' }],
                },
            },
            upsert_preset: {
                function: 'luker_orch_upsert_preset',
                shape: {
                    preset_id: 'string',
                    systemPrompt: 'string',
                    userPromptTemplate: `Use only: ${AI_VISIBLE_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}`,
                    apiPresetName: 'optional string; use only a name from available_connection_profiles; leave empty unless user explicitly asks',
                    promptPresetName: 'optional string; use only a name from available_chat_completion_presets; leave empty unless user explicitly asks',
                },
                placeholder_policy: {
                    general: 'Template should consume dynamic runtime context via placeholders where needed.',
                    distiller_like: 'Prefer {{recent_chat}} + {{last_user}}.',
                    reasoning_like: 'Prefer {{distiller}} and/or {{previous_outputs}}.',
                    auto_injected_context: 'Previous orchestration result is prepended automatically before template text.',
                    synthesizer_like: 'Prefer {{distiller}} + {{previous_outputs}}, then synthesize with auto-injected orchestration result context.',
                },
            },
            finalize: {
                function: 'luker_orch_finalize_profile',
                shape: { summary: 'optional string' },
            },
        },
    });
}

function buildAiOrchestrationToolSet() {
    return [
        {
            type: 'function',
            function: {
                name: 'luker_orch_append_stage',
                description: 'Append or replace one orchestration stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        mode: { type: 'string', enum: ['serial', 'parallel'] },
                        nodes: {
                            type: 'array',
                            items: {
                                anyOf: [
                                    { type: 'string' },
                                    {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string' },
                                            preset: { type: 'string' },
                                            type: { type: 'string', enum: [ORCH_NODE_TYPE_WORKER, ORCH_NODE_TYPE_REVIEW] },
                                            userPromptTemplate: { type: 'string' },
                                        },
                                        required: ['id', 'preset'],
                                        additionalProperties: false,
                                    },
                                ],
                            },
                        },
                    },
                    required: ['stage_id', 'mode', 'nodes'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_upsert_preset',
                description: 'Define or update one node preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests per-agent routing.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                        systemPrompt: { type: 'string' },
                        userPromptTemplate: { type: 'string' },
                        apiPresetName: { type: 'string' },
                        promptPresetName: { type: 'string' },
                    },
                    required: ['preset_id', 'systemPrompt', 'userPromptTemplate'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_profile',
                description: 'Finalize the incremental profile construction. Optionally include a concise summary.',
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
}

export async function buildAiOrchestrationProfile(context, settings, {
    characterCard,
    currentSpec,
    currentPresets,
    overrideGoal = '',
    abortSignal = null,
} = {}) {
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt({
        spec: currentSpec,
        presets: currentPresets,
    });
    const suggestSystemPrompt = buildAiOrchestrationSystemPrompt(settings);
    const suggestUserPrompt = buildAiOrchestrationUserPrompt(context, settings, characterCard, overrideGoal, aiVisibleGlobalProfile);

    const apiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const llmPresetName = String(settings.aiSuggestPresetName || '').trim();
    const worldInfoMessages = normalizeWorldInfoResolverMessages(
        getRecentMessages(Array.isArray(context?.chat) ? context.chat : [], settings.maxRecentMessages),
    );
    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages,
        runtimeWorldInfo: null,
        forceWorldInfoResimulate: false,
        worldInfoType: 'quiet',
        abortSignal,
    });

    const tools = buildAiOrchestrationToolSet();
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));

    const semanticRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    let parsed = null;
    let lastBuildError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        const reminderText = attempt > 0
            ? [
                `Previous attempt failed: ${String(lastBuildError?.message || 'incomplete tool calls')}`,
                'Return COMPLETE tool calls in one response (not one call).',
                'MUST include luker_orch_append_stage and luker_orch_finalize_profile, with finalize as the last call.',
                `MUST include dedicated nodes: ${REQUIRED_AI_BUILD_NODE_IDS.join(', ')}.`,
            ].join(' ')
            : '';
        const taskMessages = [
            { role: 'system', content: suggestSystemPrompt },
            { role: 'user', content: suggestUserPrompt },
            ...(reminderText ? [{ role: 'user', content: reminderText }] : []),
        ];
        let toolCalls = [];
        try {
            toolCalls = await requestToolCallsWithRetry(context, settings, {
                taskMessages,
                runtimeWorldInfo,
                apiPresetName,
                llmPresetName,
                tools,
                allowedNames,
                retriesOverride: 0,
                abortSignal,
                applyAgentTimeout: false,
            });
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastBuildError = error instanceof Error ? error : new Error(String(error || 'unknown error'));
            if (attempt >= semanticRetries) {
                throw lastBuildError;
            }
            console.warn(`[${MODULE_NAME}] AI orchestration build request failed. Retrying semantic pass (${attempt + 1}/${semanticRetries})...`, error);
            continue;
        }
        if (!Array.isArray(toolCalls) || toolCalls.length < 2) {
            lastBuildError = new Error(i18n('AI build must return multiple tool calls in one response.'));
            continue;
        }
        const callNames = toolCalls.map(call => String(call?.name || '').trim()).filter(Boolean);
        if (!callNames.includes('luker_orch_append_stage')) {
            lastBuildError = new Error(i18n('AI build did not provide any stage tool calls.'));
            continue;
        }
        if (callNames[callNames.length - 1] !== 'luker_orch_finalize_profile') {
            lastBuildError = new Error(i18n('AI build did not call finalize explicitly.'));
            continue;
        }
        const candidate = buildAiProfileFromToolCalls(toolCalls);
        if (!candidate || typeof candidate !== 'object') {
            lastBuildError = new Error(i18n('Function output is invalid.'));
            continue;
        }
        if (!candidate.hasStageUpdate) {
            lastBuildError = new Error(i18n('AI build did not provide any stage tool calls.'));
            continue;
        }
        if (!candidate.finalizeCalled) {
            lastBuildError = new Error(i18n('AI build did not call finalize explicitly.'));
            continue;
        }
        parsed = candidate;
        lastBuildError = null;
        break;
    }
    if (!parsed) {
        throw lastBuildError || new Error(i18n('Function output is invalid.'));
    }

    validateAiBuildTemplateVariables(parsed.orchestrationSpec, parsed.presetPatch);
    return parsed;
}
