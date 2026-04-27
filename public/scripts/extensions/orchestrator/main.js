// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

import { extension_prompt_roles, extension_prompt_types, getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, getCharacterState, setCharacterState } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { sendOpenAIRequest } from '../../openai.js';
import { getStringHash } from '../../utils.js';
import { wi_anchor_position, world_info_position } from '../../world-info.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import { renderObjectDiffHtml } from '../object-diff-view.js';
import {
    TOOL_PROTOCOL_STYLE,
    extractAllFunctionCalls,
    getResponseMessageContent,
    mergeUserAddendumIntoPromptMessages,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { DiffMatchPatch, yaml } from '../../../lib.js';
import { create as createDiffPatcher, reverse as reverseDiffDelta } from '../../vendor/diffpatch/index.js';
import {
    buildAiIterationPopupHtml,
    buildOrchestrationEditorPopupPanelHtml,
    buildOrchestratorSettingsHtml,
} from './ui-templates.js';

const MODULE_NAME = 'orchestrator';
const ORCH_RESULT_EVENT = 'luker.orchestrator.result';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';
const UI_BLOCK_ID = 'orchestrator_settings';
const ORCH_CHAT_STATE_NAMESPACE = 'luker_orchestrator_state';
const ORCH_CHAT_STATE_VERSION = 2;
const ORCH_CHAT_CONTENT_NAMESPACE_PREFIX = 'luker_orchestrator_anchor_';
const ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE = 'orchestrator_iteration_history';
const ORCH_GLOBAL_ITERATION_HISTORY_KEY = 'global_iteration_history';
const ORCH_CHARACTER_ITERATION_HISTORY_VERSION = 3;
const ORCH_CHARACTER_ITERATION_HISTORY_LIMIT = 24;
const ORCH_ITERATION_DIFF_TEXT_MIN_LENGTH = 80;
const DEFAULT_CAPSULE_CUSTOM_INSTRUCTION = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';
const DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT = 'You are a single-agent orchestration planner for roleplay generation. Produce concise, actionable guidance for the next reply while preserving continuity, character consistency, and world constraints. Before function-call output, provide one concise <thought>...</thought> that reflects your role-specific reasoning.';
const DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE = [
    'Recent chat:',
    '{{recent_chat}}',
    '',
    'Current user message:',
    '{{last_user}}',
    '',
    'Task:',
    '- Use the auto-injected previous orchestration result above as continuity context.',
    '- Distill the immediate narrative state and user intent.',
    '- Provide concrete directives for next reply drafting.',
    '- List key risks to avoid (OOC, continuity breaks, data-like language).',
    '',
    'Return function-call fields only.',
    'Put final injected guidance in field `text` (string).',
    'The `text` content is injected directly as-is.',
].join('\n');
const ORCH_EXECUTION_MODE_SPEC = 'spec';
const ORCH_EXECUTION_MODE_SINGLE = 'single';
const ORCH_EXECUTION_MODE_AGENDA = 'agenda';
const ORCH_EXECUTION_MODES = Object.freeze([
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_EXECUTION_MODE_SINGLE,
    ORCH_EXECUTION_MODE_AGENDA,
]);
const PORTABLE_PROFILE_FORMAT_V1 = 'luker_orchestrator_profile_v1';
const PORTABLE_PROFILE_FORMAT_V2 = 'luker_orchestrator_profile_v2';
const AGENDA_PLANNER_TOOL = 'luker_orch_planner_step';
const AGENDA_RESULT_TOOL = 'luker_orch_submit_result';
const DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT = 'You are an orchestration planner. Maintain a todo list, dispatch the minimum useful set of agents, read every returned result carefully, and stop when the final orchestration guidance is ready. Before the function call, provide one concise <thought>...</thought> that reflects current planning.';
const DEFAULT_AGENDA_PLANNER_PROMPT = [
    '# Planner Prompt',
    '',
    '## Mission',
    'Maintain a compact todo list for this turn and produce high-quality orchestration guidance with the minimum necessary work.',
    '',
    '## Strong Requirements',
    '- Preserve continuity, character consistency, active world-info constraints, and anti-OOC discipline.',
    '- Prefer compact, actionable orchestration guidance over long analysis.',
    '- Treat every agent run as evidence for planning; read complete outputs before deciding next steps.',
    '',
    '## Execution Loop',
    '- Maintain todo list state explicitly.',
    '- You may dispatch multiple independent agents in parallel when that clearly improves speed.',
    '- Every dispatch must include a concrete task brief and explicit input_run_ids.',
    '- Only add new todos when a returned result makes them justified.',
    '- When more analysis is unlikely to materially improve the final guidance, finalize.',
    '',
    '## Sequencing Guidance',
    '- Usually inspect current state and constraints before deeper branching.',
    '- Use world/lore checks before high-freedom reasoning when possible.',
    '- Use critics only when a meaningful audit is needed; do not add critique loops mechanically.',
    '- Final guidance should be written only after the todo list is effectively resolved.',
    '',
    '## Branching Guidance',
    '- Parallelize truly independent work such as per-character analysis.',
    '- Do not branch for its own sake; if one good analysis is enough, keep the plan simple.',
    '- Reuse prior agent runs whenever they already cover the need.',
    '',
    '## Output Contract',
    '- Normal planner steps should return dispatches for the next useful agent runs. Include todo_ops only when the board needs updating.',
    '- Finalization should happen only once, at the end. When you are done, return finalize with a concise reason/summary.',
    '- Do not include dispatches in the same step that includes finalize.',
].join('\n');
const TEMPLATE_PLACEHOLDER_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller'];
const AUTO_INJECTED_CONTEXT_VARS = ['previous_orchestration'];
const LEGACY_REMOVED_CONTEXT_VARS = ['previous_snapshot'];
const ALLOWED_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS, ...AUTO_INJECTED_CONTEXT_VARS, ...LEGACY_REMOVED_CONTEXT_VARS];
const AI_VISIBLE_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS];
const AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE = '(auto-injected above)';
const AUTO_INJECTED_PLACEHOLDER_AI_NOTE = '(auto-injected by runtime before this template)';
const AUTO_INJECTED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${AUTO_INJECTED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
const LEGACY_REMOVED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${LEGACY_REMOVED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const CAPSULE_INJECT_POSITION_SCHEMA_VERSION = 2;
const ORCH_NODE_TYPE_WORKER = 'worker';
const ORCH_NODE_TYPE_REVIEW = 'review';
const ORCH_REVIEW_TOOL_APPROVE = 'luker_orch_review_approve';
const ORCH_REVIEW_TOOL_RERUN = 'luker_orch_request_rerun';
const ORCH_REVIEW_FEEDBACK_FIELD = 'review_feedback';
const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);
const REQUIRED_AI_BUILD_NODE_IDS = ['lorebook_reader', 'anti_data_guard'];
const ANTI_DATA_BLOCKED_LEXICON = [
    '观察', '分析', '评估', '统计', '监测', '检测', '实验', '推测', '记录', '汇报',
    'observation', 'analyze', 'analysis', 'evaluate', 'metric', 'kpi', 'ratio', 'probability',
];
const ORCH_AI_QUALITY_AXES = {
    user_intent: 'Analyze user intent, emotional expectation, and implicit goals.',
    character_traits: 'Use character traits and card constraints without restating full biographies in every node.',
    lorebook_compliance: 'Read and obey active lorebook/world-info constraints as hard writing constraints.',
    character_independence: 'Preserve multi-character independence and avoid voice/agency collapse.',
    anti_ooc: 'Detect and prevent OOC behavior and persona drift.',
    anti_datafication: 'Treat data-like prose as a hard violation (quantification, pseudo-analytics, report-style phrasing).',
    latent_behavior: 'Infer plausible latent behavior, motivations, and next-step actions.',
    human_realism: 'Increase human-like behavior through natural uncertainty, bounded knowledge, and believable pacing.',
    world_autonomy: 'Keep the world autonomous; events should not always orbit the user.',
};
const ORCH_CRITIC_REQUIRED_GATES = Object.freeze([
    'continuity and timeline coherence',
    'causality and action-consequence coherence',
    'character/role consistency and anti-OOC drift',
    'active lorebook/world-info hard constraints',
    'anti-data/report-tone/weather-broadcast violations',
    'over-interpretation or unsupported escalation',
    'human realism and situational plausibility',
    'world autonomy and avoiding user-centric collapse',
]);
const ORCH_CRITIC_PROMPT_AUTHORING_RULE = 'The critic/review preset itself must hardcode the review checklist and decision gate. Do not assume node.type, stage position, or preset name alone will make the model audit outputs.';
const ORCH_CRITIC_CONSTRAINT_RESTATEMENT_RULE = 'Because critics do not see upstream worker prompt text at runtime, every critic/review preset must explicitly restate the audited layer\'s concrete pass/fail requirements, including worker-specific hard constraints, banned patterns, required preserved facts, and output obligations.';
const ORCH_REVIEW_LAYERING_RULE = 'Treat orchestration as explicit hierarchical layers. A critic/review node audits only the immediately preceding worker layer, not the full earlier pipeline.';
const ORCH_REVIEW_VISIBILITY_RULE = 'Critic visibility is local: do not make a critic depend on or audit non-adjacent earlier-stage nodes. If an older layer also needs review, add another critic immediately after that layer.';
const ORCH_REVIEW_RERUN_SCOPE_RULE = 'A critic may request rerun only for the minimal specific worker node ids in the directly adjacent previous layer it audits.';
const ORCH_REVIEW_MULTI_CRITIC_RULE = 'If multiple layers need review gates, insert critics after those specific layers as needed. Multiple critics are valid; do not collapse all review into one final critic.';
const ORCH_REVIEW_REDUNDANCY_RULE = 'Do not place two critic/review stages or nodes back-to-back with no worker layer between them; adjacent critics are redundant and meaningless.';
const ORCH_CRITIC_DECISION_RULE = `Approve only when every required gate passes. If any material issue exists, request rerun of the minimal specific worker node ids from the directly adjacent previous layer only. Every approve/rerun tool call must include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`. Never emit synthesis, replacement guidance, or silent approval.`;

function getCriticPromptReminderLines() {
    return [
        ORCH_CRITIC_PROMPT_AUTHORING_RULE,
        ORCH_CRITIC_CONSTRAINT_RESTATEMENT_RULE,
        ORCH_REVIEW_LAYERING_RULE,
        ORCH_REVIEW_VISIBILITY_RULE,
        ORCH_REVIEW_RERUN_SCOPE_RULE,
        ORCH_REVIEW_MULTI_CRITIC_RULE,
        ORCH_REVIEW_REDUNDANCY_RULE,
        `For every critic/review preset, explicitly hardcode these checks in prompt text: ${ORCH_CRITIC_REQUIRED_GATES.join(', ')}.`,
        ORCH_CRITIC_DECISION_RULE,
    ];
}

function getCriticReviewNodeContractShape() {
    return {
        prompt_authoring_rule: ORCH_CRITIC_PROMPT_AUTHORING_RULE,
        constraint_restatement_rule: ORCH_CRITIC_CONSTRAINT_RESTATEMENT_RULE,
        layering_rule: ORCH_REVIEW_LAYERING_RULE,
        visibility_scope: ORCH_REVIEW_VISIBILITY_RULE,
        rerun_scope: ORCH_REVIEW_RERUN_SCOPE_RULE,
        multi_critic_policy: ORCH_REVIEW_MULTI_CRITIC_RULE,
        redundancy_rule: ORCH_REVIEW_REDUNDANCY_RULE,
        required_checks: ORCH_CRITIC_REQUIRED_GATES,
        decision_rule: ORCH_CRITIC_DECISION_RULE,
        tool_payload_contract: {
            approve: {
                [ORCH_REVIEW_FEEDBACK_FIELD]: 'required string',
            },
            rerun: {
                target_node_ids: ['required string'],
                [ORCH_REVIEW_FEEDBACK_FIELD]: 'required string',
            },
        },
        feedback_runtime_behavior: `Approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` is auto-injected into later nodes. Rerun \`${ORCH_REVIEW_FEEDBACK_FIELD}\` is auto-injected into the targeted rerun nodes.`,
    };
}

function getDefaultAiSuggestSystemPrompt() {
    return [
        'You design RP multi-agent orchestration profiles for a specific character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'For each generated node preset, explicitly define whether <thought> is required based on that node\'s responsibility.',
        'Reasoning-heavy nodes (e.g. distiller/planner/critic/synthesizer) should require one concise <thought> before tool calls.',
        'Constraint-only or lookup-only nodes may keep <thought> minimal, but the policy must be explicit in prompt text.',
        'Call multiple functions in one response to build the profile incrementally.',
        'Keep stages concise, operational, and easy to run in a single request turn.',
        'Only the LAST stage outputs are injected into the final generation context.',
        'Design a clear pipeline: state distillation -> reasoning workers -> review gate -> final synthesis.',
        'Treat stages as strict hierarchical layers with local dependencies, not a flat pool of globally visible nodes.',
        'Worker nodes before the final stage should return structured tool-call fields for machine processing.',
        'Review nodes inspect only the immediately previous worker layer outputs, then either approve or request rerun of specific node ids from that directly adjacent layer.',
        `Review nodes must include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\` on both approve and rerun decisions.`,
        `Runtime preserves passthrough worker outputs and auto-injects approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` into later nodes.`,
        'If multiple layers need audit gates, place separate review stages immediately after those layers; multiple critics are allowed and often preferable to one final critic.',
        'Do not place review nodes in the final stage. Prefer a dedicated serial review stage immediately after the worker layer it audits.',
        'Do not place two review/critic stages back-to-back with no worker stage between them.',
        ...getCriticPromptReminderLines(),
        'Last-stage nodes must return function-call payload with a single field `text`.',
        'Runtime injects the `text` content directly as-is (no YAML wrapping).',
        'Do NOT hardcode any fixed narrator persona/identity/roleplay character in system prompts.',
        'Do NOT mirror long single-prompt identity blocks; focus on process quality and constraints.',
        'Runtime context guarantee: both orchestration agents and final generation already see assembled preset context, character card context, and world-info activation context.',
        'Do NOT repeat full character biography in every node prompt. Prefer compact behavior policy and decision criteria.',
        'Each node must have a distinct role, concrete output focus, and minimal overlap.',
        'Prefer practical distiller/planner/critic/synthesizer style agents and add custom presets only when necessary.',
        'Planner-like presets must not be thin "analyze and plan" prompts; give them explicit sequencing rules, evidence usage rules, branching discipline, and stop conditions.',
        'When you create a planner role, keep it self-contained and reusable as a dedicated preset rather than scattering planner logic across unrelated nodes.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        'Require explicit hard-gate checks (consistency, OOC, causality, continuity, over-interpretation) in the critic review node.',
        'Hard requirement: include one dedicated node id "lorebook_reader" to explicitly study active lorebook/world-info constraints.',
        'Hard requirement: include one dedicated node id "anti_data_guard" to explicitly block data-like writing and metric-style phrasing.',
        `For anti_data_guard, enforce blocked lexicon as hard risk: ${ANTI_DATA_BLOCKED_LEXICON.join(', ')}.`,
        'For anti_data_guard, also hard-block detached report/bulletin cadence (e.g., weather-broadcast style flat narration).',
        'For anti_data_guard, avoid genre slogans and style branding; output hard compliance checks and rewrite rules only.',
        'Those two required nodes must exist even when you innovate other stage/node designs.',
        'Require final synthesizer output to be concise, actionable, and directly usable for drafting.',
        'Flexibility policy: treat the provided blueprint as a strong baseline, not a prison.',
        'You may innovate node roles/stage topology for this specific character card if quality improves.',
        'Any innovation must keep hard-gate coverage, causal clarity, and final-output contract intact.',
        `Allowed template placeholders ONLY: ${AI_VISIBLE_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
        'Do not invent any other placeholder names.',
        'Each preset may optionally set apiPresetName to route that agent through a specific Connection Manager profile.',
        'Leave apiPresetName empty unless the user explicitly asks for per-agent model/provider routing.',
        'Empty apiPresetName means runtime falls back to the global orchestration API preset.',
        'If you set apiPresetName, use only names from available_connection_profiles.',
        'Each preset may optionally set promptPresetName to route that agent through a specific chat completion preset.',
        'Leave promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing.',
        'Empty promptPresetName means runtime falls back to the global orchestration chat completion preset.',
        'If you set promptPresetName, use only names from available_chat_completion_presets.',
        'Runtime auto-injects previous orchestration result before each node template.',
        'Do not use placeholders for auto-injected context. Encode how to use it in Task rules.',
        'Placeholder usage policy (must follow):',
        '- Every generated userPromptTemplate should include placeholders needed by that node role; avoid static templates that ignore runtime context.',
        '- Distiller/state nodes should include {{recent_chat}} and {{last_user}}.',
        '- Nodes depending on upstream reasoning should include {{distiller}} and/or {{previous_outputs}}.',
        '- Final synthesizer should generally include {{distiller}} and {{previous_outputs}}.',
        'When designing prompts, encode checks and directives, not verbose restatements of the card.',
        'Read global_orchestration_spec and global_presets as primary reference before creating card-specific overrides.',
        'Do not output thin prompts. Each node preset must contain concrete process steps, hard constraints, and output contract details.',
        'Minimum richness target per node preset: systemPrompt >= 3 concrete rule lines; userPromptTemplate includes Task block with multiple actionable bullets.',
        'Call luker_orch_append_stage one stage per call.',
        'luker_orch_append_stage arguments must be flat: stage_id, mode, nodes.',
        'Call luker_orch_upsert_preset one preset per call.',
        'Hard rule: one response must contain COMPLETE tool calls for this task. Do not stop after a single tool call.',
        'Hard rule: minimum 2 tool calls in one response, and must include luker_orch_append_stage plus luker_orch_finalize_profile.',
        'Hard rule: luker_orch_finalize_profile must be the last tool call.',
        'Call luker_orch_finalize_profile at the end.',
    ].join('\n');
}

const defaultSpec = {
    stages: [
        { id: 'distill', mode: 'serial', nodes: ['distiller'] },
        { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
        { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
        { id: 'review', mode: 'serial', nodes: [{ id: 'critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
        { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
    ],
};

const defaultPresets = {
    distiller: {
        systemPrompt: 'You are a narrative state distiller. Build a compact, evidence-grounded state snapshot for this turn. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Distill user intent, scene state, active tensions, and likely immediate direction.\n- Keep it factual and grounded in visible dialogue/actions.\n- Prefer compact high-signal state, not long prose.\n\nReturn function-call fields only. summary should be concise plain text, not JSON string.',
    },
    lorebook_reader: {
        systemPrompt: 'You are a lorebook compliance reader. Extract only active hard constraints from world-info, especially explicit banned wording/style requirements. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Identify hard constraints that must affect THIS turn (style bans, narration boundaries, role constraints, taboo rules, continuity anchors).\n- Include explicit anti-data constraints from lorebook if present: ban report/observation/analysis tone, ban metric-like phrasing.\n- Keep only high-impact constraints; avoid copying long lorebook prose.\n- Phrase outputs as executable writing directives, not summaries of lorebook documents.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    anti_data_guard: {
        systemPrompt: 'You are the anti-data hard gate for RP prose. Block report-style, observation/analysis style, metric style, and weather-broadcast style flat narration. Violations are blockers, not suggestions. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Audit for forbidden data-like patterns: numeric ranges (e.g. 3-5分钟), percentages, KPI/metrics, pseudo-scientific wording, report/bulletin cadence.\n- Audit for forbidden verb/tone families: 观察/分析/评估/统计/监测/检测/实验/推测/记录/汇报 and observation/analyze/evaluate/metric/KPI style.\n- Audit for weather-broadcast tone: detached flat reporting such as “像播报天气预报一样平静”.\n- For every violation, output concrete rewrite directives that convert it to vivid in-scene narrative language.\n- Mark unresolved violations in risks as BLOCKER.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    planner: {
        systemPrompt: 'You are a progression planner. Turn current state into a concrete, believable next-step plan. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Propose next-step progression beats with clear causality.\n- Preserve character independence and world autonomy.\n- Avoid making the world revolve around the user by default.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    critic: {
        systemPrompt: `You are a hard-gate critic.\n- Actively audit prior worker outputs against explicit review gates before approving.\n- Do not assume node type, stage placement, or preset name alone is enough; you must run the checklist.\n- You do not see upstream worker prompt texts at runtime, so this critic prompt must contain the full audit checklist and audited-layer-specific hard constraints.\n- Never emit synthesis or replacement guidance; return only review decisions.\n- Every review decision tool call must include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\` for downstream runtime use.\n- Output one concise <thought>...</thought> before your function call.`,
        userPromptTemplate: `Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- This critic prompt must be authored as a complete local audit contract. If the audited worker layer has extra hard constraints, banned patterns, preserved facts, or output obligations, restate them here explicitly because you cannot inspect other agent prompt texts at runtime.\n- Treat approval as allowed only if all required gates pass: continuity/timeline coherence, causality/action-consequence coherence, character/role consistency, anti-OOC/persona drift, active lorebook/world-info hard constraints, anti-data/report-tone/weather-broadcast violations, over-interpretation, human realism/plausibility, and world autonomy.\n- If any material issue exists, request rerun for the minimal specific earlier worker node ids responsible; do not rerun everything by default.\n- If upstream outputs are missing a required constraint/check, treat that as a review failure instead of filling the gap yourself.\n- If prior outputs are acceptable, approve immediately.\n- In both approve and rerun calls, \`${ORCH_REVIEW_FEEDBACK_FIELD}\` is mandatory and should contain concise audit conclusions, preserved constraints, and concrete downstream improvement guidance.\n- \`${ORCH_REVIEW_FEEDBACK_FIELD}\` may refine later nodes, but do not rewrite the final synthesis yourself.\n- Do not produce any rewritten guidance, summaries, or synthesis outside review tool-call fields.\n\nReturn review tool calls only.`,
    },
    recall_relevance: {
        systemPrompt: 'You are a recall relevance analyst. Decide which recalled memory cues should influence this turn. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Identify high-value recalled facts/themes likely to matter now.\n- Prioritize by immediate relevance to current turn goals.\n- Do not invent unseen facts.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    synthesizer: {
        systemPrompt: 'You are the final orchestration synthesizer. Produce the single draft-ready guidance for generation. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: `Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Merge the approved worker outputs into one coherent final guidance.\n- Also obey the auto-injected approved review feedback as a refinement layer on top of prior worker outputs.\n- Preserve lorebook hard constraints and anti-data writing policy in final directives.\n- Prioritize actionable directives and keep risk notes concise.\n- Keep output compact and directly usable for roleplay drafting.\n\nReturn function-call fields only.\nPut final injected guidance in field \`text\` (string).\nThe \`text\` content is injected directly as-is.`,
    },
};

const defaultAgendaAgents = {
    distiller: {
        systemPrompt: 'You are an agenda-mode state distiller. Read the current turn carefully, preserve visible facts, and return one complete useful result text through the required tool. Before the function call, provide one concise <thought>...</thought>.',
        userPromptTemplate: 'Task:\n- Distill the current turn into a compact but complete state read.\n- Focus on user intent, active scene state, immediate tensions, and likely near-term direction.\n- Stay grounded in visible dialogue/actions and avoid unsupported interpretation.\n- Write for the planner and downstream agents, not for the final player-facing reply.',
    },
    lorebook_reader: {
        systemPrompt: 'You are an agenda-mode lore and constraint reader. Extract only the world-info constraints that materially matter for this turn and return them as one complete useful result text through the required tool. Before the function call, provide one concise <thought>...</thought>.',
        userPromptTemplate: 'Task:\n- Read active world-info/lore context and identify the constraints that should affect this turn.\n- Prioritize hard boundaries, role restrictions, taboo rules, narration bans, and continuity anchors.\n- Keep only high-impact constraints that the planner or final writer must actually obey.\n- Phrase the result as practical writing or behavior constraints, not as lorebook summary.',
    },
    planner: {
        systemPrompt: 'You are an agenda-mode scene progression analyst. Think about believable next-step progression and return one complete useful result text through the required tool. Before the function call, provide one concise <thought>...</thought>.',
        userPromptTemplate: 'Task:\n- Analyze what progression beats or decision points matter next.\n- Preserve causality, character independence, and world autonomy.\n- Avoid making the world revolve around the user by default.\n- Prefer practical next-step orchestration guidance over broad theory.',
    },
    critic: {
        systemPrompt: 'You are an agenda-mode critic. Audit the assigned material for important problems and return one complete useful result text through the required tool. Before the function call, provide one concise <thought>...</thought>.',
        userPromptTemplate: 'Task:\n- Audit the assigned material for continuity breaks, OOC drift, missing hard constraints, anti-data or report-tone issues, and implausible causality.\n- Be concrete about what is wrong and why it matters.\n- If the material is acceptable, say so plainly.\n- Do not rewrite the final orchestration guidance yourself; return audit conclusions and corrections only.',
    },
    finalizer: {
        systemPrompt: 'You are the final orchestration writer. Read the completed agenda work and write one compact orchestration guidance text for the next reply. Before your function call, provide one concise <thought>...</thought> that reflects the final merge.',
        userPromptTemplate: 'Read the planner prompt, current todo state, and all selected prior runs. Merge the resolved work into one concise orchestration guidance text that is directly usable for drafting the next reply. Preserve active constraints and keep unresolved risks implicit unless they matter for the guidance.',
    },
};

const defaultAgendaPlanner = {
    systemPrompt: DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_AGENDA_PLANNER_PROMPT,
    apiPresetName: '',
    promptPresetName: '',
};

const defaultSettings = {
    enabled: false,
    executionMode: ORCH_EXECUTION_MODE_SPEC,
    singleAgentModeEnabled: false,
    singleAgentSystemPrompt: DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT,
    singleAgentUserPromptTemplate: DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE,
    llmNodeApiPresetName: '',
    llmNodePresetName: '',
    includeWorldInfoWithPreset: true,
    nodeIterationMaxRounds: 3,
    reviewRerunMaxRounds: 2,
    toolCallRetryMax: 2,
    agentTimeoutSeconds: 0,
    maxRecentMessages: 14,
    capsuleInjectPosition: world_info_position.atDepth,
    capsuleInjectDepth: 0,
    capsuleInjectRole: extension_prompt_roles.SYSTEM,
    capsuleCustomInstruction: DEFAULT_CAPSULE_CUSTOM_INSTRUCTION,
    orchestrationSpec: defaultSpec,
    presets: defaultPresets,
    agendaPlanner: defaultAgendaPlanner,
    agendaAgents: defaultAgendaAgents,
    agendaFinalAgentId: 'finalizer',
    agendaPlannerMaxRounds: 6,
    agendaMaxConcurrentAgents: 3,
    agendaMaxTotalRuns: 24,
    chatOverrides: {},
    aiSuggestApiPresetName: '',
    aiSuggestPresetName: '',
    aiSuggestSystemPrompt: getDefaultAiSuggestSystemPrompt(),
    rpmLimit: 0,
};

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(key, ...values) {
    return i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

function normalizeExecutionMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ORCH_EXECUTION_MODES.includes(normalized) ? normalized : ORCH_EXECUTION_MODE_SPEC;
}

function getExecutionMode(settings = extension_settings[MODULE_NAME]) {
    return normalizeExecutionMode(settings?.executionMode);
}

function normalizeCapsuleInjectPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : world_info_position.atDepth;
}

function normalizeCapsuleInjectRole(value) {
    const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
    const numeric = Number(value);
    return allowedRoles.includes(numeric) ? numeric : extension_prompt_roles.SYSTEM;
}

function migrateLegacyCapsuleInjectPosition(value) {
    switch (Number(value)) {
        case extension_prompt_types.BEFORE_PROMPT:
            return world_info_position.before;
        case extension_prompt_types.IN_PROMPT:
            return world_info_position.after;
        case extension_prompt_types.IN_CHAT:
            return world_info_position.atDepth;
        default:
            return world_info_position.atDepth;
    }
}

function normalizeWorldInfoEntries(rawEntries) {
    return Array.isArray(rawEntries)
        ? rawEntries.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

function ensureWorldInfoEntries(payload, field) {
    const entryField = `${field}Entries`;
    const entries = normalizeWorldInfoEntries(payload?.[entryField]);
    payload[entryField] = entries;
    return entries;
}

function appendUniqueWorldInfoBlock(payload, field, block) {
    const incoming = String(block || '').trim();
    if (!incoming) {
        return false;
    }

    const entries = ensureWorldInfoEntries(payload, field);
    if (entries.includes(incoming)) {
        return false;
    }

    entries.push(incoming);
    return true;
}

function appendUniqueNoteEntry(targetList, block) {
    const incoming = String(block || '').trim();
    if (!incoming || !Array.isArray(targetList)) {
        return false;
    }
    if (targetList.includes(incoming)) {
        return false;
    }
    targetList.push(incoming);
    return true;
}

function appendUniqueWorldInfoExample(payload, anchorPosition, block) {
    const incoming = String(block || '').trim();
    if (!incoming) {
        return false;
    }
    if (!Array.isArray(payload.worldInfoExamples)) {
        payload.worldInfoExamples = [];
    }
    const normalizedPosition = Number(anchorPosition) === Number(wi_anchor_position.before)
        ? wi_anchor_position.before
        : wi_anchor_position.after;
    if (payload.worldInfoExamples.some((entry) => (
        Number(entry?.position) === Number(normalizedPosition)
        && String(entry?.content || '').trim() === incoming
    ))) {
        return false;
    }
    payload.worldInfoExamples.push({
        position: normalizedPosition,
        content: incoming,
    });
    return true;
}

function injectCapsuleToPayload(payload, text, settings = extension_settings[MODULE_NAME]) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const packet = String(text || '').trim();
    if (!packet) {
        return false;
    }
    const position = normalizeCapsuleInjectPosition(settings?.capsuleInjectPosition);
    if (position === world_info_position.before) {
        return appendUniqueWorldInfoBlock(payload, 'worldInfoBefore', packet);
    }
    if (position === world_info_position.after) {
        return appendUniqueWorldInfoBlock(payload, 'worldInfoAfter', packet);
    }
    if (position === world_info_position.ANTop) {
        if (!Array.isArray(payload.anBefore)) {
            payload.anBefore = [];
        }
        return appendUniqueNoteEntry(payload.anBefore, packet);
    }
    if (position === world_info_position.ANBottom) {
        if (!Array.isArray(payload.anAfter)) {
            payload.anAfter = [];
        }
        return appendUniqueNoteEntry(payload.anAfter, packet);
    }
    if (position === world_info_position.EMTop) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.before, packet);
    }
    if (position === world_info_position.EMBottom) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.after, packet);
    }
    const depth = Math.max(0, Math.min(10000, Math.floor(Number(settings?.capsuleInjectDepth) || 0)));
    const role = normalizeCapsuleInjectRole(settings?.capsuleInjectRole);
    if (!Array.isArray(payload.worldInfoDepth)) {
        payload.worldInfoDepth = [];
    }
    let target = payload.worldInfoDepth.find((entry) => (
        Math.max(0, Math.floor(Number(entry?.depth) || 0)) === depth
        && normalizeCapsuleInjectRole(entry?.role) === role
    ));
    if (!target) {
        target = { depth, role, entries: [] };
        payload.worldInfoDepth.push(target);
    } else if (!Array.isArray(target.entries)) {
        target.entries = [];
    }
    target.role = role;
    if (target.entries.includes(packet)) {
        return false;
    }
    target.entries.push(packet);
    return true;
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Orchestrator': '多智能体编排',
        'Enabled': '启用',
        'Execution mode': '执行模式',
        'Spec workflow': 'Spec 工作流',
        'Single agent': '单 Agent',
        'Agenda planner': 'Agenda 规划器',
        'Single-agent mode': '单 Agent 简化模式',
        'Single-agent system prompt': '单 Agent 系统提示词',
        'Single-agent user prompt template': '单 Agent 用户提示词模板',
        'Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.': '单 Agent 模式已启用。复杂工作流编辑区已隐藏，运行时将使用简化单节点编排。',
        'Plain-text function-call mode': '纯文本函数调用模式',
        'LLM node API preset (Connection profile, empty = current)': 'LLM 节点 API 预设（连接配置，留空=当前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 节点提示词预设（参数+提示词，留空=当前）',
        'Include world info': '包含世界书信息',
        'Agent API preset (Connection profile, empty = global orchestration API preset)': 'Agent API 预设（连接配置，留空=使用全局编排 API 预设）',
        'Agent preset (params + prompt, empty = global orchestration preset)': 'Agent 提示词预设（参数+提示词，留空=使用全局编排提示词预设）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 预设（连接配置，留空=当前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成提示词预设（参数+提示词，留空=当前）',
        'AI build system prompt': 'AI 生成系统提示词',
        'Reset AI build prompt': '重置 AI 生成提示词',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '确认重置 AI 生成提示词为默认值？这会覆盖当前内容。',
        'Recent assistant turns for orchestration (N)': '编排阶段可见最近 N 条 Assistant 回复',
        'Node tool iteration max rounds (N)': '节点工具迭代最大轮数（N）',
        'Review rerun max rounds (N)': 'Review 重跑最大轮数（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Per-agent timeout seconds (0 = disabled)': '单 Agent 超时秒数（0=禁用）',
        'RPM limit (0 = unlimited)': 'RPM 限制（0 = 不限制）',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定义前',
        'After Character Definitions': '角色定义后',
        'Before Author\'s Note': '作者注释前',
        'After Author\'s Note': '作者注释后',
        'Before Example Messages': '示例消息前',
        'After Example Messages': '示例消息后',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（仅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（仅聊天深度位置）',
        'Custom orchestration result instruction (prepended before analysis)': '自定义编排结果指令（会放在分析结果前）',
        'e.g. Follow this guidance first, then write final reply in-character.': '例如：先遵循下列指导，再用角色语气完成最终回复。',
        'System': 'System',
        'User': 'User',
        'Assistant': 'Assistant',
        'Orchestration Guidance': '编排指导',
        'Use this guidance as high-priority planning context for the next reply.': '将这份指导作为下一条回复的高优先级规划上下文。',
        'Meta': '元信息',
        'Stage': '阶段',
        'Node': '节点',
        'Summary': '摘要',
        'Status': '状态',
        'Directives': '执行指令',
        'Risks': '风险',
        'Tags': '标签',
        'Patch Last User': '用户消息修订建议',
        'Structured Notes': '结构化补充',
        'Current card:': '当前角色卡：',
        '(No character card)': '（无角色卡）',
        '(No character selected)': '（未选择角色卡）',
        'Editing:': '当前编辑：',
        'Global profile': '全局配置',
        'AI build goal (optional)': 'AI 生成目标（可选）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：悬疑节奏、严格角色内表达',
        'Reload Current': '重载当前',
        'Export Profile': '导出编排',
        'Import Profile': '导入编排',
        'Reset Global': '重置全局',
        'Save To Global': '保存到全局',
        'Save To Character Override': '保存到角色卡覆写',
        'Global profile': '全局配置',
        'Current character override': '当前角色卡覆写',
        'Clear Character Override': '清除角色卡覆写',
        'AI Build Profile': 'AI 生成编排',
        'AI Quick Build': 'AI 快速生成',
        'Open AI Iteration Studio': '打开 AI 迭代工作台',
        'Orchestration Editor': '编排编辑器',
        'Open Orchestration Editor': '打开编排编辑器',
        'Agenda Orchestration': 'Agenda 编排',
        'Planner Prompt': 'Planner 提示词',
        'Planner system prompt': 'Planner 系统提示词',
        'Planner API preset (Connection profile, empty = global orchestration API preset)': 'Planner API 预设（连接配置，留空=使用全局编排 API 预设）',
        'Planner preset (params + prompt, empty = global orchestration preset)': 'Planner 提示词预设（参数+提示词，留空=使用全局编排提示词预设）',
        'Final Agent': '最终 Agent',
        'Planner max rounds': 'Planner 最大轮数',
        'Max concurrent agents': '最大并行 Agent 数',
        'Max total agent runs': '最大 Agent 调用总数',
        'Copy Spec Agents To Agenda': '复制 Spec Agents 到 Agenda',
        'Copied spec agents into agenda as a starting point.': '已将 Spec agents 复制到 Agenda，作为初始参考。',
        'Copy Agenda Agents To Spec': '复制 Agenda Agents 到 Spec',
        'Copied agenda agents into spec presets and rebuilt stages as a starting point.': '已将 Agenda Agents 复制到 Spec，并重建阶段作为初始参考。',
        'Agenda Agents': 'Agenda Agents',
        'View Last Run': '查看最近一轮',
        'View Runtime Trace': '查看运行态轨迹',
        'Latest Orchestration Result': '最近编排结果',
        'Anchored User Turn': '绑定用户楼层',
        'Last run state: none': '最近编排状态：无有效结果',
        'Last run state: none · stored anchors ${0}': '最近编排状态：无有效结果 · 已存锚点 ${0}',
        'Last run state: user turn ${0} · stored anchors ${1}': '最近编排状态：用户楼层 ${0} · 已存锚点 ${1}',
        'Orchestration Runtime Trace': '编排运行态轨迹',
        'Edit Result': '编辑结果',
        'Edit latest orchestration result text.': '编辑最近一轮编排结果文本。',
        'Orchestration result cannot be empty.': '编排结果不能为空。',
        'Saved latest orchestration result.': '最近一轮编排结果已保存。',
        'Failed to persist orchestration snapshot.': '编排结果写入失败。',
        'No recent orchestration result available for this chat.': '当前聊天暂无最近编排结果。',
        'Orchestration history invalidated. Rolled back to user turn ${0}.': '编排历史已失效，已回退到用户楼层 ${0}。',
        'Orchestration history invalidated. No valid stored result remains.': '编排历史已失效，当前没有可用的已存结果。',
        'No runtime orchestration trace available for this chat yet.': '当前聊天暂无可查看的运行态编排轨迹。',
        'This trace is in-memory only and clears when chat changes.': '该轨迹仅保存在内存中，切换聊天时会清空。',
        'Trace is still running. Close and reopen to refresh.': '轨迹仍在运行中；关闭后重新打开即可刷新。',
        'Flow Graph': '流程图',
        'Execution Timeline': '执行时间线',
        'Flow Events': '流程事件',
        'Latest capsule text': '最新注入文本',
        'Raw runtime trace': '原始运行态轨迹',
        'Node Attempts': '节点执行次数',
        'Review Reruns': 'Review 重跑次数',
        'Review feedback': '审查反馈',
        'Generation Type': '生成类型',
        'Target Layer': '目标层',
        'Finished At': '结束时间',
        'Attempt ${0}': '第 ${0} 次执行',
        'Rerun reason': '重跑原因',
        'Targets': '目标节点',
        'Decision': '决策',
        'Replay result': '重放结果',
        'Output': '输出',
        'Previous result': '上一次结果',
        'Current result': '当前结果',
        'Rerun diff': '重跑前后对比',
        'No events recorded.': '暂无事件记录。',
        'No node attempts recorded.': '暂无节点执行记录。',
        'Reused previous orchestration snapshot. No nodes executed.': '已复用上一轮编排快照，本次未重新执行节点。',
        'Orchestration cancelled by user before completion.': '编排在完成前被用户取消。',
        'Generation aborted before orchestration completed.': '生成在编排完成前已中止。',
        'Orchestration cancelled by user.': '编排已被用户取消。',
        'Running': '运行中',
        'Completed': '已完成',
        'Cancelled': '已取消',
        'Failed': '失败',
        'Reused': '复用',
        'Idle': '空闲',
        'Created At': '创建时间',
        'Updated At': '更新时间',
        'AI Iteration Studio': 'AI 迭代工作台',
        'Iteration source: ${0}': '当前迭代来源：${0}',
        'Conversation': '对话',
        'Pending approval': '待审批',
        'Approve changes': '批准执行',
        'Reject changes': '拒绝执行',
        'Pending changes diff': '待审批变更详情',
        'Before': '变更前',
        'After': '变更后',
        'Line diff': '逐行差异',
        'Line diff (+${0} -${1})': '逐行差异（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '关闭放大视图',
        '...(${0} more lines)': '...（还有 ${0} 行）',
        'Not set': '未设置',
        'Raw arguments': '原始参数',
        'Operation ${0}': '操作 ${0}',
        'AI suggested changes are waiting for approval.': 'AI 产出的变更正在等待审批。',
        'No editable operations were produced.': '没有产出可执行的变更。',
        'Changes approved and applied.': '已批准并执行变更。',
        'Changes approved and applied. Waiting for your next instruction.': '已批准并执行变更，等待你的下一条指令。',
        'Applying approved changes...': '正在执行已批准的变更...',
        'Running auto-continue...': '正在自动继续迭代...',
        'Changes rejected.': '已拒绝本次变更。',
        'Working profile': '当前编排',
        'Send to AI': '发送给 AI',
        'Stop': '终止',
        'Clear Session': '清空会话',
        'Apply to Global': '应用到全局',
        'Apply to Character': '应用到角色卡',
        'Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...': '输入给 AI 的需求，例如：保持紧凑节奏，并用我提供的场景做一次模拟...',
        'No messages yet. Start by telling AI what you want to optimize.': '还没有对话。先告诉 AI 你希望优化什么。',
        'Auto simulation context (folded)': '自动模拟上下文（已折叠）',
        'Long message (${0} chars)': '长消息（${0} 字符）',
        'Preview': '预览',
        'No character selected. Cannot apply to character override.': '当前未选择角色卡，无法应用到角色卡覆写。',
        'Iteration session applied to global profile.': '迭代会话已应用到全局配置。',
        'Iteration session applied to character override: ${0}.': '迭代会话已应用到角色卡覆写：${0}。',
        'AI iteration is running...': 'AI 迭代处理中...',
        'AI iteration updated.': 'AI 迭代已更新。',
        'Iteration run cancelled.': '迭代已终止。',
        'Iteration run failed: ${0}': '迭代失败：${0}',
        'Iteration session reset.': '迭代会话已重置。',
        'Regenerate': '重新生成',
        'Regenerating message...': '正在重新生成消息...',
        'Session history': '会话历史',
        'No saved sessions yet.': '还没有已保存会话。',
        'New session': '新建会话',
        'Load session': '加载会话',
        'Delete session': '删除会话',
        'Session loaded.': '会话已加载。',
        'New session created.': '已创建新会话。',
        'Session deleted.': '会话已删除。',
        'Delete this saved session?': '确认删除这条已保存会话？',
        'Current session': '当前会话',
        'Rollback round': '回退此轮',
        'Rolled back to selected round.': '已回退到所选轮次。',
        'Rollback failed: ${0}': '回退失败：${0}',
        'Delete session failed: ${0}': '删除会话失败：${0}',
        'Applied changes diff': '已应用变更详情',
        'Rejected changes diff': '已拒绝变更详情',
        'Workflow': '工作流',
        'Add Stage': '新增阶段',
        'Add Node': '新增节点',
        'Agent Presets': 'Agent 预设',
        'Add Preset': '新增预设',
        'No stages yet. Add one stage to start orchestration.': '还没有阶段。新增一个阶段开始编排。',
        'No presets yet.': '还没有预设。',
        'Node ${0}': '节点 ${0}',
        'Stage ${0}': '阶段 ${0}',
        'Then': '然后',
        'Up': '上移',
        'Down': '下移',
        'Delete': '删除',
        'Node ID': '节点 ID',
        'Preset': '预设',
        'Node Type': '节点类型',
        'Worker': '工作节点',
        'Review': '审查节点',
        'Node Prompt Template (optional)': '节点提示词模板（可选）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result and approved review feedback are auto-injected.': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}。上轮编排结果和已批准的审查反馈会自动注入。',
        'Execution': '执行方式',
        'Serial': '串行',
        'Parallel': '并行',
        'Nodes run in parallel.': '节点并行执行。',
        'Nodes run in serial order.': '节点串行执行。',
        'System Prompt': '系统提示词',
        'User Prompt Template': '用户提示词模板',
        'new_preset_id': 'new_preset_id',
        'Character Override: ${0}': '角色卡覆写：${0}',
        'Character Draft: ${0}': '角色卡草稿：${0}',
        'Global Orchestration Profile': '全局编排配置',
        'Character override (enabled)': '角色卡覆写（已启用）',
        'Character override (configured, currently disabled)': '角色卡覆写（已配置，当前禁用）',
        'Character draft (not saved yet)': '角色卡草稿（尚未保存）',
        'Global profile (no character override for current card)': '全局配置（当前角色卡无覆写）',
        'Preset ID cannot be empty.': '预设 ID 不能为空。',
        'Preset \'${0}\' already exists.': '预设 \'${0}\' 已存在。',
        'Preset \'${0}\' is still used by workflow nodes.': '预设 \'${0}\' 仍被工作流节点使用。',
        'Reloaded global profile from settings.': '已从设置重载全局配置。',
        'No character selected.': '未选择角色卡。',
        'Character orchestration override saved.': '角色卡编排覆写已保存。',
        'Global orchestration profile saved.': '全局编排配置已保存。',
        'Global orchestration profile reset to defaults.': '全局编排配置已重置为默认。',
        'Saved to global profile.': '已保存到全局配置。',
        'Select export source: OK = global profile, Cancel = character override.': '选择导出来源：确定=全局配置，取消=角色卡覆写。',
        'Select import target: OK = global profile, Cancel = character override.': '选择导入目标：确定=全局配置，取消=角色卡覆写。',
        'No character selected. Use global profile?': '当前未选择角色卡。是否改为使用全局配置？',
        'Exported global profile.': '已导出全局配置。',
        'Exported character override: ${0}.': '已导出角色卡覆写：${0}。',
        'Imported to global profile.': '已导入到全局配置。',
        'Imported to character override: ${0}.': '已导入到角色卡覆写：${0}。',
        'Imported profile does not match current execution mode.': '导入的编排文件与当前执行模式不匹配。',
        'Invalid profile file format.': '编排文件格式无效。',
        'Import failed: ${0}': '导入失败：${0}',
        'Reset global profile to defaults.': '已将全局配置重置为默认。',
        'Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.': '确认重置全局编排为默认？这会覆盖当前全局工作流和预设。',
        'Character orchestration override removed.': '角色卡编排覆写已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡编排配置。',
        'Global orchestration profile generated by AI.': 'AI 已生成全局编排配置。',
        'AI profile generation failed.': 'AI 生成配置失败。',
        'AI profile generation cancelled.': 'AI 生成配置已由用户终止。',
        'Saved to character override: ${0}.': '已保存到角色卡覆写：${0}。',
        'Removed character override for ${0}.': '已移除角色卡覆写：${0}。',
        'AI profile generated for ${0}.': '已为 ${0} 生成 AI 编排配置。',
        'Reloaded character override for ${0}.': '已重载角色卡覆写：${0}。',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(Global orchestration API preset)': '（全局编排 API 预设）',
        '(Global orchestration prompt preset)': '（全局编排提示词预设）',
        '(missing)': '（缺失）',
        'AI build did not call finalize explicitly. Parsed output was used anyway.': 'AI 构建未显式调用 finalize。已直接采用解析结果。',
        'AI build did not call finalize explicitly.': 'AI 构建未显式调用 finalize。',
        'AI build must return multiple tool calls in one response.': 'AI 构建必须在一次响应里返回多个工具调用。',
        'AI profile generation failed: ${0}': 'AI 配置生成失败：${0}',
        'Generating orchestration profile for ${0}...': '正在为 ${0} 生成编排配置...',
        'Function output is invalid.': '函数输出无效。',
        'AI build did not provide any stage tool calls.': 'AI 构建未提供任何阶段工具调用。',
        'Orchestrator running...': '编排插件运行中...',
        'Orchestrator completed.': '编排插件运行完成。',
        'Generation aborted. Skipped orchestration.': '生成已中断，已跳过编排。',
        'Orchestrator cancelled by user.': '编排插件已由用户终止。',
        'Orchestrator failed: ${0}': '编排插件运行失败：${0}',
        'Failed to persist character override.': '角色卡覆写写入失败。',
        'Stop': '终止',
    });
    addLocaleData('zh-tw', {
        'Orchestrator': '多智能體編排',
        'Enabled': '啟用',
        'Execution mode': '執行模式',
        'Spec workflow': 'Spec 工作流',
        'Single agent': '單 Agent',
        'Agenda planner': 'Agenda 規劃器',
        'Single-agent mode': '單 Agent 簡化模式',
        'Single-agent system prompt': '單 Agent 系統提示詞',
        'Single-agent user prompt template': '單 Agent 使用者提示詞模板',
        'Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.': '單 Agent 模式已啟用。複雜工作流編輯區已隱藏，執行時將使用簡化單節點編排。',
        'Plain-text function-call mode': '純文字函式呼叫模式',
        'LLM node API preset (Connection profile, empty = current)': 'LLM 節點 API 預設（連線設定，留空=目前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 節點提示詞預設（參數+提示詞，留空=目前）',
        'Include world info': '包含世界書資訊',
        'Agent API preset (Connection profile, empty = global orchestration API preset)': 'Agent API 預設（連線設定，留空=使用全域編排 API 預設）',
        'Agent preset (params + prompt, empty = global orchestration preset)': 'Agent 提示詞預設（參數+提示詞，留空=使用全域編排提示詞預設）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 預設（連線設定，留空=目前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成提示詞預設（參數+提示詞，留空=目前）',
        'AI build system prompt': 'AI 生成系統提示詞',
        'Reset AI build prompt': '重置 AI 生成提示詞',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '確認重置 AI 生成提示詞為預設值？這會覆蓋目前內容。',
        'Recent assistant turns for orchestration (N)': '編排階段可見最近 N 條 Assistant 回覆',
        'Node tool iteration max rounds (N)': '節點工具迭代最大輪數（N）',
        'Review rerun max rounds (N)': 'Review 重跑最大輪數（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具呼叫重試次數（無效/缺失時）',
        'Per-agent timeout seconds (0 = disabled)': '單 Agent 超時秒數（0=禁用）',
        'RPM limit (0 = unlimited)': 'RPM 限制（0 = 不限制）',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定義前',
        'After Character Definitions': '角色定義後',
        'Before Author\'s Note': '作者註釋前',
        'After Author\'s Note': '作者註釋後',
        'Before Example Messages': '示例訊息前',
        'After Example Messages': '示例訊息後',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（僅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（僅聊天深度位置）',
        'Custom orchestration result instruction (prepended before analysis)': '自訂編排結果指令（會放在分析結果前）',
        'e.g. Follow this guidance first, then write final reply in-character.': '例如：先遵循下列指導，再以角色語氣完成最終回覆。',
        'System': 'System',
        'User': 'User',
        'Assistant': 'Assistant',
        'Orchestration Guidance': '編排指導',
        'Use this guidance as high-priority planning context for the next reply.': '將此指導作為下一則回覆的高優先規劃上下文。',
        'Meta': '中繼資訊',
        'Stage': '階段',
        'Node': '節點',
        'Summary': '摘要',
        'Directives': '執行指令',
        'Risks': '風險',
        'Tags': '標籤',
        'Patch Last User': '使用者訊息修訂建議',
        'Structured Notes': '結構化補充',
        'Status': '狀態',
        'Current card:': '目前角色卡：',
        '(No character card)': '（無角色卡）',
        '(No character selected)': '（未選擇角色卡）',
        'Editing:': '目前編輯：',
        'Global profile': '全域設定',
        'AI build goal (optional)': 'AI 生成目標（可選）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：懸疑節奏、嚴格角色內語氣',
        'Reload Current': '重新載入目前',
        'Export Profile': '匯出編排',
        'Import Profile': '匯入編排',
        'Reset Global': '重置全域',
        'Save To Global': '儲存到全域',
        'Save To Character Override': '儲存到角色卡覆寫',
        'Current character override': '目前角色卡覆寫',
        'Clear Character Override': '清除角色卡覆寫',
        'AI Build Profile': 'AI 生成編排',
        'AI Quick Build': 'AI 快速生成',
        'Open AI Iteration Studio': '開啟 AI 迭代工作台',
        'Orchestration Editor': '編排編輯器',
        'Open Orchestration Editor': '開啟編排編輯器',
        'Agenda Orchestration': 'Agenda 編排',
        'Planner Prompt': 'Planner 提示詞',
        'Planner system prompt': 'Planner 系統提示詞',
        'Planner API preset (Connection profile, empty = global orchestration API preset)': 'Planner API 預設（連線配置，留空=使用全域編排 API 預設）',
        'Planner preset (params + prompt, empty = global orchestration preset)': 'Planner 提示詞預設（參數+提示詞，留空=使用全域編排提示詞預設）',
        'Final Agent': '最終 Agent',
        'Planner max rounds': 'Planner 最大輪數',
        'Max concurrent agents': '最大並行 Agent 數',
        'Max total agent runs': '最大 Agent 呼叫總數',
        'Copy Spec Agents To Agenda': '複製 Spec Agents 到 Agenda',
        'Copied spec agents into agenda as a starting point.': '已將 Spec agents 複製到 Agenda，作為初始參考。',
        'Copy Agenda Agents To Spec': '複製 Agenda Agents 到 Spec',
        'Copied agenda agents into spec presets and rebuilt stages as a starting point.': '已將 Agenda Agents 複製到 Spec，並重建階段作為初始參考。',
        'Agenda Agents': 'Agenda Agents',
        'View Last Run': '查看最近一輪',
        'View Runtime Trace': '查看執行態軌跡',
        'Latest Orchestration Result': '最近編排結果',
        'Anchored User Turn': '綁定使用者樓層',
        'Last run state: none': '最近編排狀態：無有效結果',
        'Last run state: none · stored anchors ${0}': '最近編排狀態：無有效結果 · 已存錨點 ${0}',
        'Last run state: user turn ${0} · stored anchors ${1}': '最近編排狀態：使用者樓層 ${0} · 已存錨點 ${1}',
        'Orchestration Runtime Trace': '編排執行態軌跡',
        'Edit Result': '編輯結果',
        'Edit latest orchestration result text.': '編輯最近一輪編排結果文本。',
        'Orchestration result cannot be empty.': '編排結果不能為空。',
        'Saved latest orchestration result.': '最近一輪編排結果已儲存。',
        'Failed to persist orchestration snapshot.': '編排結果寫入失敗。',
        'No recent orchestration result available for this chat.': '目前聊天暫無最近編排結果。',
        'Orchestration history invalidated. Rolled back to user turn ${0}.': '編排歷史已失效，已回退到使用者樓層 ${0}。',
        'Orchestration history invalidated. No valid stored result remains.': '編排歷史已失效，目前沒有可用的已存結果。',
        'No runtime orchestration trace available for this chat yet.': '目前聊天尚無可檢視的執行態編排軌跡。',
        'This trace is in-memory only and clears when chat changes.': '此軌跡僅保存在記憶體中，切換聊天時會清空。',
        'Trace is still running. Close and reopen to refresh.': '軌跡仍在執行中；關閉後重新打開即可刷新。',
        'Flow Graph': '流程圖',
        'Execution Timeline': '執行時間線',
        'Flow Events': '流程事件',
        'Latest capsule text': '最新注入文本',
        'Raw runtime trace': '原始執行態軌跡',
        'Node Attempts': '節點執行次數',
        'Review Reruns': 'Review 重跑次數',
        'Review feedback': '審查回饋',
        'Generation Type': '生成類型',
        'Target Layer': '目標層',
        'Finished At': '結束時間',
        'Attempt ${0}': '第 ${0} 次執行',
        'Rerun reason': '重跑原因',
        'Targets': '目標節點',
        'Decision': '決策',
        'Replay result': '重放結果',
        'Output': '輸出',
        'Previous result': '上一次結果',
        'Current result': '目前結果',
        'Rerun diff': '重跑前後對比',
        'No events recorded.': '暫無事件記錄。',
        'No node attempts recorded.': '暫無節點執行記錄。',
        'Reused previous orchestration snapshot. No nodes executed.': '已沿用上一輪編排快照，本次未重新執行節點。',
        'Orchestration cancelled by user before completion.': '編排在完成前被使用者取消。',
        'Generation aborted before orchestration completed.': '生成在編排完成前已中止。',
        'Orchestration cancelled by user.': '編排已被使用者取消。',
        'Running': '執行中',
        'Completed': '已完成',
        'Cancelled': '已取消',
        'Failed': '失敗',
        'Reused': '沿用',
        'Idle': '閒置',
        'Created At': '建立時間',
        'Updated At': '更新時間',
        'AI Iteration Studio': 'AI 迭代工作台',
        'Iteration source: ${0}': '目前迭代來源：${0}',
        'Conversation': '對話',
        'Pending approval': '待審批',
        'Approve changes': '批准執行',
        'Reject changes': '拒絕執行',
        'Pending changes diff': '待審批變更詳情',
        'Before': '變更前',
        'After': '變更後',
        'Line diff': '逐行差異',
        'Line diff (+${0} -${1})': '逐行差異（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '關閉放大視圖',
        '...(${0} more lines)': '...（還有 ${0} 行）',
        'Not set': '未設定',
        'Raw arguments': '原始參數',
        'Operation ${0}': '操作 ${0}',
        'AI suggested changes are waiting for approval.': 'AI 產出的變更正在等待審批。',
        'No editable operations were produced.': '沒有產出可執行的變更。',
        'Changes approved and applied.': '已批准並執行變更。',
        'Changes approved and applied. Waiting for your next instruction.': '已批准並執行變更，等待你的下一條指令。',
        'Applying approved changes...': '正在執行已批准的變更...',
        'Running auto-continue...': '正在自動繼續迭代...',
        'Changes rejected.': '已拒絕本次變更。',
        'Working profile': '目前編排',
        'Send to AI': '傳送給 AI',
        'Stop': '終止',
        'Clear Session': '清空會話',
        'Apply to Global': '套用到全域',
        'Apply to Character': '套用到角色卡',
        'Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...': '輸入給 AI 的需求，例如：保持緊湊節奏，並用我提供的場景做一次模擬...',
        'No messages yet. Start by telling AI what you want to optimize.': '尚無對話。先告訴 AI 你希望優化什麼。',
        'Auto simulation context (folded)': '自動模擬上下文（已摺疊）',
        'Long message (${0} chars)': '長訊息（${0} 字符）',
        'Preview': '預覽',
        'No character selected. Cannot apply to character override.': '目前未選擇角色卡，無法套用到角色卡覆寫。',
        'Iteration session applied to global profile.': '迭代會話已套用到全域設定。',
        'Iteration session applied to character override: ${0}.': '迭代會話已套用到角色卡覆寫：${0}。',
        'AI iteration is running...': 'AI 迭代處理中...',
        'AI iteration updated.': 'AI 迭代已更新。',
        'Iteration run cancelled.': '迭代已終止。',
        'Iteration run failed: ${0}': '迭代失敗：${0}',
        'Iteration session reset.': '迭代會話已重置。',
        'Regenerate': '重新生成',
        'Regenerating message...': '正在重新生成訊息...',
        'Session history': '會話歷史',
        'No saved sessions yet.': '還沒有已儲存會話。',
        'New session': '新增會話',
        'Load session': '載入會話',
        'Delete session': '刪除會話',
        'Session loaded.': '會話已載入。',
        'New session created.': '已建立新會話。',
        'Session deleted.': '會話已刪除。',
        'Delete this saved session?': '確認刪除這條已儲存會話？',
        'Current session': '目前會話',
        'Rollback round': '回退此輪',
        'Rolled back to selected round.': '已回退到所選輪次。',
        'Rollback failed: ${0}': '回退失敗：${0}',
        'Delete session failed: ${0}': '刪除會話失敗：${0}',
        'Applied changes diff': '已套用變更詳情',
        'Rejected changes diff': '已拒絕變更詳情',
        'Workflow': '工作流',
        'Add Stage': '新增階段',
        'Add Node': '新增節點',
        'Agent Presets': 'Agent 預設',
        'Add Preset': '新增預設',
        'No stages yet. Add one stage to start orchestration.': '尚無階段。新增一個階段開始編排。',
        'No presets yet.': '尚無預設。',
        'Node ${0}': '節點 ${0}',
        'Stage ${0}': '階段 ${0}',
        'Then': '然後',
        'Up': '上移',
        'Down': '下移',
        'Delete': '刪除',
        'Node ID': '節點 ID',
        'Preset': '預設',
        'Node Type': '節點類型',
        'Worker': '工作節點',
        'Review': '審查節點',
        'Node Prompt Template (optional)': '節點提示詞模板（可選）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result and approved review feedback are auto-injected.': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}。上輪編排結果和已批准的審查回饋會自動注入。',
        'Execution': '執行方式',
        'Serial': '串行',
        'Parallel': '並行',
        'Nodes run in parallel.': '節點並行執行。',
        'Nodes run in serial order.': '節點串行執行。',
        'System Prompt': '系統提示詞',
        'User Prompt Template': '使用者提示詞模板',
        'new_preset_id': 'new_preset_id',
        'Character Override: ${0}': '角色卡覆寫：${0}',
        'Character Draft: ${0}': '角色卡草稿：${0}',
        'Global Orchestration Profile': '全域編排設定',
        'Character override (enabled)': '角色卡覆寫（已啟用）',
        'Character override (configured, currently disabled)': '角色卡覆寫（已設定，當前停用）',
        'Character draft (not saved yet)': '角色卡草稿（尚未儲存）',
        'Global profile (no character override for current card)': '全域設定（目前角色卡無覆寫）',
        'Preset ID cannot be empty.': '預設 ID 不能為空。',
        'Preset \'${0}\' already exists.': '預設 \'${0}\' 已存在。',
        'Preset \'${0}\' is still used by workflow nodes.': '預設 \'${0}\' 仍被工作流節點使用。',
        'Reloaded global profile from settings.': '已從設定重新載入全域設定。',
        'No character selected.': '未選擇角色卡。',
        'Character orchestration override saved.': '角色卡編排覆寫已儲存。',
        'Global orchestration profile saved.': '全域編排設定已儲存。',
        'Global orchestration profile reset to defaults.': '全域編排設定已重置為預設。',
        'Saved to global profile.': '已儲存至全域設定。',
        'Select export source: OK = global profile, Cancel = character override.': '選擇匯出來源：確定=全域設定，取消=角色卡覆寫。',
        'Select import target: OK = global profile, Cancel = character override.': '選擇匯入目標：確定=全域設定，取消=角色卡覆寫。',
        'No character selected. Use global profile?': '目前未選擇角色卡。是否改為使用全域設定？',
        'Exported global profile.': '已匯出全域設定。',
        'Exported character override: ${0}.': '已匯出角色卡覆寫：${0}。',
        'Imported to global profile.': '已匯入到全域設定。',
        'Imported to character override: ${0}.': '已匯入到角色卡覆寫：${0}。',
        'Imported profile does not match current execution mode.': '匯入的編排檔案與目前執行模式不匹配。',
        'Invalid profile file format.': '編排檔案格式無效。',
        'Import failed: ${0}': '匯入失敗：${0}',
        'Reset global profile to defaults.': '已將全域設定重置為預設。',
        'Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.': '確認重置全域編排為預設？這會覆蓋目前全域工作流與預設。',
        'Character orchestration override removed.': '角色卡編排覆寫已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡編排設定。',
        'Global orchestration profile generated by AI.': 'AI 已生成全域編排設定。',
        'AI profile generation failed.': 'AI 生成設定失敗。',
        'AI profile generation cancelled.': 'AI 生成設定已由使用者終止。',
        'Saved to character override: ${0}.': '已儲存至角色卡覆寫：${0}。',
        'Removed character override for ${0}.': '已移除角色卡覆寫：${0}。',
        'AI profile generated for ${0}.': '已為 ${0} 生成 AI 編排設定。',
        'Reloaded character override for ${0}.': '已重新載入角色卡覆寫：${0}。',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(Global orchestration API preset)': '（全域編排 API 預設）',
        '(Global orchestration prompt preset)': '（全域編排提示詞預設）',
        '(missing)': '（缺失）',
        'AI build did not call finalize explicitly. Parsed output was used anyway.': 'AI 建構未明確呼叫 finalize。已直接採用解析結果。',
        'AI build did not call finalize explicitly.': 'AI 建構未明確呼叫 finalize。',
        'AI build must return multiple tool calls in one response.': 'AI 建構必須在一次回應中返回多個工具呼叫。',
        'AI profile generation failed: ${0}': 'AI 設定生成失敗：${0}',
        'Generating orchestration profile for ${0}...': '正在為 ${0} 生成編排設定...',
        'Function output is invalid.': '函式輸出無效。',
        'AI build did not provide any stage tool calls.': 'AI 建構未提供任何階段工具呼叫。',
        'Orchestrator running...': '編排插件運行中...',
        'Orchestrator completed.': '編排插件運行完成。',
        'Generation aborted. Skipped orchestration.': '生成已中斷，已跳過編排。',
        'Orchestrator cancelled by user.': '編排插件已由使用者終止。',
        'Orchestrator failed: ${0}': '編排插件運行失敗：${0}',
        'Failed to persist character override.': '角色卡覆寫寫入失敗。',
        'Stop': '終止',
    });
}

const ORCH_STYLE_ID = 'orchestrator_styles';
const uiState = {
    selectedAvatar: '',
    aiGoal: '',
    globalEditor: null,
    characterEditor: null,
    globalAgendaEditor: null,
    characterAgendaEditor: null,
    specDisplayedScope: 'global',
    agendaDisplayedScope: 'global',
    aiIterationSession: null,
    orchEditorPopupContentId: '',
};
let orchInFlight = false;
let activeRunInfoToast = null;
let activeAiBuildToast = null;
let activeAiIterationAbortController = null;
let activeOrchRunAbortController = null;
let activeAiBuildAbortController = null;
let latestOrchestrationSnapshot = null;
let latestOrchestrationHistoryIndex = null;
let latestOrchestrationRuntimeTrace = null;
let loadedChatStateKey = '';

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? cloneJsonCompatible(value) : value;
}

function cloneJsonCompatible(value) {
    if (value === undefined) {
        return undefined;
    }

    try {
        return structuredClone(value);
    } catch {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? undefined : JSON.parse(serialized);
    }
}

function normalizeNodeType(value) {
    return String(value || '').trim().toLowerCase() === ORCH_NODE_TYPE_REVIEW
        ? ORCH_NODE_TYPE_REVIEW
        : ORCH_NODE_TYPE_WORKER;
}

function sanitizeSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        return structuredClone(defaultSpec);
    }

    const stages = Array.isArray(spec.stages) ? spec.stages : [];
    const normalizedStages = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const normalizedNodes = nodes
            .map(node => {
                if (typeof node === 'string') {
                    return node.trim();
                }
                if (node && typeof node === 'object') {
                    const compact = {
                        id: String(node.id || node.node || node.preset || '').trim(),
                        preset: String(node.preset || node.id || node.node || '').trim(),
                        type: normalizeNodeType(node.type),
                        userPromptTemplate: typeof node.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
                    };
                    if (!compact.id && compact.preset) {
                        compact.id = compact.preset;
                    }
                    if (!compact.preset && compact.id) {
                        compact.preset = compact.id;
                    }
                    return compact.id ? compact : null;
                }
                return null;
            })
            .filter(Boolean);

        return {
            id: String(stage?.id || `stage_${stageIndex + 1}`),
            mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: normalizedNodes,
        };
    }).filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0);

    return {
        stages: normalizedStages.length > 0 ? normalizedStages : structuredClone(defaultSpec.stages),
    };
}

function sanitizePresetMap(presets) {
    if (!presets || typeof presets !== 'object') {
        return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(presets)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const presetId = sanitizeIdentifierToken(key, '');
        if (!presetId) {
            continue;
        }
        normalized[presetId] = createPresetDraft(value);
    }

    return normalized;
}

function mergePresetMaps(basePresets, patchPresets) {
    const base = sanitizePresetMap(basePresets);
    const patchSource = patchPresets && typeof patchPresets === 'object' ? patchPresets : {};
    const merged = { ...base };

    for (const [key, rawValue] of Object.entries(patchSource)) {
        if (!rawValue || typeof rawValue !== 'object') {
            continue;
        }
        const presetId = sanitizeIdentifierToken(key, '');
        if (!presetId) {
            continue;
        }
        merged[presetId] = createPresetDraft({
            ...(base[presetId] || {}),
            ...rawValue,
        });
    }

    return sanitizePresetMap(merged);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = cloneDefault(value);
        }
    }
    const hadLegacySingleMode = Boolean(extension_settings[MODULE_NAME].singleAgentModeEnabled);
    extension_settings[MODULE_NAME].executionMode = normalizeExecutionMode(
        extension_settings[MODULE_NAME].executionMode || (hadLegacySingleMode ? ORCH_EXECUTION_MODE_SINGLE : ORCH_EXECUTION_MODE_SPEC),
    );
    extension_settings[MODULE_NAME].singleAgentModeEnabled = extension_settings[MODULE_NAME].executionMode === ORCH_EXECUTION_MODE_SINGLE;
    extension_settings[MODULE_NAME].singleAgentSystemPrompt = String(extension_settings[MODULE_NAME].singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT);
    extension_settings[MODULE_NAME].singleAgentUserPromptTemplate = String(extension_settings[MODULE_NAME].singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE);
    extension_settings[MODULE_NAME].agendaPlanner = createAgendaPlannerDraft(
        extension_settings[MODULE_NAME].agendaPlanner || {
            userPromptTemplate: extension_settings[MODULE_NAME].agendaPlannerPrompt,
        },
    );
    extension_settings[MODULE_NAME].agendaAgents = sanitizePresetMap(extension_settings[MODULE_NAME].agendaAgents);
    if (Object.keys(extension_settings[MODULE_NAME].agendaAgents).length === 0) {
        extension_settings[MODULE_NAME].agendaAgents = sanitizePresetMap(defaultAgendaAgents);
    }
    extension_settings[MODULE_NAME].agendaFinalAgentId = sanitizeIdentifierToken(
        extension_settings[MODULE_NAME].agendaFinalAgentId,
        Object.keys(extension_settings[MODULE_NAME].agendaAgents)[0] || 'finalizer',
    );
    if (!extension_settings[MODULE_NAME].agendaAgents[extension_settings[MODULE_NAME].agendaFinalAgentId]) {
        extension_settings[MODULE_NAME].agendaFinalAgentId = Object.keys(extension_settings[MODULE_NAME].agendaAgents)[0] || 'finalizer';
    }
    extension_settings[MODULE_NAME].agendaPlannerMaxRounds = Math.max(
        1,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].agendaPlannerMaxRounds ?? 6) || 6)),
    );
    extension_settings[MODULE_NAME].agendaMaxConcurrentAgents = Math.max(
        1,
        Math.min(12, Math.floor(Number(extension_settings[MODULE_NAME].agendaMaxConcurrentAgents ?? 3) || 3)),
    );
    extension_settings[MODULE_NAME].agendaMaxTotalRuns = Math.max(
        1,
        Math.min(200, Math.floor(Number(extension_settings[MODULE_NAME].agendaMaxTotalRuns ?? 24) || 24)),
    );
    delete extension_settings[MODULE_NAME].plainTextFunctionCallMode;
    delete extension_settings[MODULE_NAME].agendaPlannerPrompt;

    extension_settings[MODULE_NAME].orchestrationSpec = sanitizeSpec(extension_settings[MODULE_NAME].orchestrationSpec);
    extension_settings[MODULE_NAME].presets = sanitizePresetMap(extension_settings[MODULE_NAME].presets);
    extension_settings[MODULE_NAME].llmNodeApiPresetName = sanitizeConnectionProfileName(extension_settings[MODULE_NAME].llmNodeApiPresetName || '');
    if (!String(extension_settings[MODULE_NAME].llmNodePresetName || '').trim()) {
        extension_settings[MODULE_NAME].llmNodePresetName = String(extension_settings[MODULE_NAME].llmNodePromptPresetName || '').trim();
    }
    extension_settings[MODULE_NAME].includeWorldInfoWithPreset = extension_settings[MODULE_NAME].includeWorldInfoWithPreset !== false;
    extension_settings[MODULE_NAME].aiSuggestApiPresetName = sanitizeConnectionProfileName(extension_settings[MODULE_NAME].aiSuggestApiPresetName || '');
    if (!String(extension_settings[MODULE_NAME].aiSuggestPresetName || '').trim()) {
        extension_settings[MODULE_NAME].aiSuggestPresetName = String(extension_settings[MODULE_NAME].aiSuggestPromptPresetName || '').trim();
    }
    // Drop legacy API selector fields. API routing now comes from connection profile only.
    delete extension_settings[MODULE_NAME].llmNodeApi;
    delete extension_settings[MODULE_NAME].aiSuggestApi;
    delete extension_settings[MODULE_NAME].llmNodeResponseLength;
    delete extension_settings[MODULE_NAME].aiSuggestResponseLength;
    delete extension_settings[MODULE_NAME].llmNodePromptPresetName;
    delete extension_settings[MODULE_NAME].aiSuggestPromptPresetName;
    delete extension_settings[MODULE_NAME].maxCapsuleChars;
    delete extension_settings[MODULE_NAME].saveTarget;
    const hasCapsuleInjectPositionSchemaVersion = Object.prototype.hasOwnProperty.call(
        extension_settings[MODULE_NAME],
        'capsuleInjectPositionSchemaVersion',
    );
    if (!hasCapsuleInjectPositionSchemaVersion) {
        extension_settings[MODULE_NAME].capsuleInjectPosition = migrateLegacyCapsuleInjectPosition(
            extension_settings[MODULE_NAME].capsuleInjectPosition,
        );
    }
    extension_settings[MODULE_NAME].capsuleInjectPosition = normalizeCapsuleInjectPosition(
        extension_settings[MODULE_NAME].capsuleInjectPosition,
    );
    extension_settings[MODULE_NAME].capsuleInjectPositionSchemaVersion = CAPSULE_INJECT_POSITION_SCHEMA_VERSION;
    extension_settings[MODULE_NAME].capsuleInjectDepth = Math.max(
        0,
        Math.min(10000, Math.floor(Number(extension_settings[MODULE_NAME].capsuleInjectDepth) || 0)),
    );
    {
        const role = Number(extension_settings[MODULE_NAME].capsuleInjectRole);
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        extension_settings[MODULE_NAME].capsuleInjectRole = allowedRoles.includes(role)
            ? role
            : extension_prompt_roles.SYSTEM;
    }
    delete extension_settings[MODULE_NAME].capsuleRenderFormat;
    extension_settings[MODULE_NAME].capsuleCustomInstruction = String(extension_settings[MODULE_NAME].capsuleCustomInstruction || '').trim();
    extension_settings[MODULE_NAME].aiSuggestSystemPrompt = String(extension_settings[MODULE_NAME].aiSuggestSystemPrompt || '').trim() || getDefaultAiSuggestSystemPrompt();
    delete extension_settings[MODULE_NAME].capsuleIncludeRawJson;
    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    extension_settings[MODULE_NAME].rpmLimit = Math.max(
        0,
        Math.floor(Number(extension_settings[MODULE_NAME].rpmLimit) || 0),
    );
    extension_settings[MODULE_NAME].nodeIterationMaxRounds = Math.max(
        1,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].nodeIterationMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].reviewRerunMaxRounds = Math.max(
        0,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].reviewRerunMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].agentTimeoutSeconds = Math.max(
        0,
        Math.min(3600, Math.floor(Number(extension_settings[MODULE_NAME].agentTimeoutSeconds) || 0)),
    );
    if (!extension_settings[MODULE_NAME].chatOverrides || typeof extension_settings[MODULE_NAME].chatOverrides !== 'object') {
        extension_settings[MODULE_NAME].chatOverrides = {};
    }
}

function clearCapsulePrompt(context) {
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        '',
        extension_prompt_types.NONE,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

function cloneOrchestrationTraceValue(value) {
    if (typeof value === 'string') {
        return String(value);
    }
    if (value && typeof value === 'object') {
        return structuredClone(value);
    }
    return value;
}

function buildOrchestrationRuntimeSlotKey(stageIndex, nodeIndex, nodeId = '') {
    return [Number(stageIndex), Number(nodeIndex), String(nodeId || '').trim()].join(':');
}

function serializeOrchestrationRuntimeValue(value) {
    if (typeof value === 'string') {
        return String(value || '');
    }
    if (value && typeof value === 'object') {
        return toReadableYamlText(value, '{}');
    }
    if (value === undefined || value === null) {
        return '';
    }
    return String(value);
}

function truncateOrchestrationRuntimePreview(value, maxChars = 240) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    return text.length > maxChars
        ? `${text.slice(0, maxChars).trimEnd()}…`
        : text;
}

function buildOrchestrationRuntimeStageLayout(stages = []) {
    return (Array.isArray(stages) ? stages : []).map((stage, stageIndex) => ({
        stageIndex,
        id: String(stage?.id || `stage_${stageIndex + 1}`),
        mode: getStageRuntimeMode(stage),
        nodes: (Array.isArray(stage?.nodes) ? stage.nodes : []).map((rawNode, nodeIndex) => {
            const nodeSpec = normalizeNodeSpec(rawNode);
            return {
                stageIndex,
                nodeIndex,
                slotKey: buildOrchestrationRuntimeSlotKey(stageIndex, nodeIndex, nodeSpec.id),
                id: String(nodeSpec?.id || ''),
                preset: String(nodeSpec?.preset || ''),
                type: normalizeNodeType(nodeSpec?.type),
            };
        }).filter(node => node.id),
    }));
}

function createOrchestrationRuntimeTrace(context, payload, stages = [], extra = {}) {
    const now = new Date().toISOString();
    const trace = {
        runId: `orch_runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatKey: String(extra?.chatKey || getChatKey(context) || ''),
        status: String(extra?.status || 'running'),
        startedAt: String(extra?.startedAt || now),
        updatedAt: String(extra?.updatedAt || now),
        finishedAt: String(extra?.finishedAt || ''),
        generationType: String(payload?.type || extra?.generationType || '').trim().toLowerCase(),
        targetLayer: Number.isFinite(Number(extra?.targetLayer))
            ? Number(extra.targetLayer)
            : getTargetAssistantLayer(payload),
        note: String(extra?.note || ''),
        capsuleText: String(extra?.capsuleText || ''),
        error: String(extra?.error || ''),
        stages: buildOrchestrationRuntimeStageLayout(stages),
        attempts: [],
        events: [],
        nextEventSeq: 1,
        nextAttemptId: 1,
        reviewRerunCount: 0,
    };
    if (!extra?.skipStartEvent) {
        recordOrchestrationRuntimeEvent(trace, 'run_started', {
            status: trace.status,
            generationType: trace.generationType,
            targetLayer: trace.targetLayer,
            note: trace.note,
        });
    }
    latestOrchestrationRuntimeTrace = trace;
    return trace;
}

function getLatestOrchestrationRuntimeTrace(context) {
    const trace = latestOrchestrationRuntimeTrace;
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const chatKey = getChatKey(context);
    if (String(trace.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    return trace;
}

function clearLatestOrchestrationRuntimeTrace(context = null) {
    if (!context) {
        latestOrchestrationRuntimeTrace = null;
        return;
    }
    const trace = latestOrchestrationRuntimeTrace;
    if (!trace || typeof trace !== 'object') {
        return;
    }
    const chatKey = getChatKey(context);
    if (!chatKey || String(trace.chatKey || '') === String(chatKey || '')) {
        latestOrchestrationRuntimeTrace = null;
    }
}

function recordOrchestrationRuntimeEvent(trace, type, details = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const event = {
        seq: Number(trace.nextEventSeq || 1),
        at: new Date().toISOString(),
        type: String(type || 'event'),
        ...structuredClone(details && typeof details === 'object' ? details : {}),
    };
    trace.nextEventSeq = event.seq + 1;
    trace.updatedAt = event.at;
    trace.events.push(event);
    return event;
}

function finalizeOrchestrationRuntimeTrace(trace, status, details = {}) {
    if (!trace || typeof trace !== 'object') {
        return;
    }
    const normalizedStatus = String(status || trace.status || 'completed');
    trace.status = normalizedStatus;
    trace.updatedAt = new Date().toISOString();
    trace.finishedAt = normalizedStatus === 'running' ? '' : trace.updatedAt;
    if (Object.prototype.hasOwnProperty.call(details || {}, 'capsuleText')) {
        trace.capsuleText = String(details?.capsuleText || '');
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'note')) {
        trace.note = String(details?.note || '');
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'error')) {
        trace.error = String(details?.error || '');
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'reviewRerunCount')) {
        trace.reviewRerunCount = Math.max(0, Math.floor(Number(details?.reviewRerunCount) || 0));
    }
    recordOrchestrationRuntimeEvent(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
        reviewRerunCount: Number(trace.reviewRerunCount || 0),
    });
}

function beginOrchestrationRuntimeStage(trace, stage, stageIndex, options = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const stageState = {
        stageIndex: Number(stageIndex || 0),
        stageId: String(stage?.id || `stage_${Number(stageIndex || 0) + 1}`),
        mode: getStageRuntimeMode(stage),
        replay: Boolean(options?.replay),
        partial: Number.isInteger(options?.stopBeforeNodeIndex),
        stopBeforeNodeIndex: Number.isInteger(options?.stopBeforeNodeIndex) ? Number(options.stopBeforeNodeIndex) : null,
        startedAt: new Date().toISOString(),
    };
    recordOrchestrationRuntimeEvent(trace, 'stage_started', stageState);
    return stageState;
}

function finishOrchestrationRuntimeStage(trace, stageState, details = {}) {
    if (!trace || typeof trace !== 'object' || !stageState || typeof stageState !== 'object') {
        return;
    }
    recordOrchestrationRuntimeEvent(trace, 'stage_finished', {
        stageIndex: Number(stageState.stageIndex || 0),
        stageId: String(stageState.stageId || ''),
        mode: String(stageState.mode || 'serial'),
        replay: Boolean(stageState.replay),
        partial: Boolean(stageState.partial),
        stopBeforeNodeIndex: Number.isInteger(stageState.stopBeforeNodeIndex) ? stageState.stopBeforeNodeIndex : null,
        status: String(details?.status || 'completed'),
        error: String(details?.error || ''),
        stageOutput: cloneOrchestrationTraceValue(details?.stageOutput),
    });
}

function beginOrchestrationRuntimeNodeAttempt(trace, meta = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const attempt = {
        attemptId: `attempt_${Number(trace.nextAttemptId || 1)}`,
        sequence: Number(trace.nextEventSeq || 1),
        stageIndex: Number(meta?.stageIndex || 0),
        stageId: String(meta?.stageId || ''),
        nodeIndex: Number(meta?.nodeIndex || 0),
        nodeId: String(meta?.nodeId || ''),
        preset: String(meta?.preset || ''),
        nodeType: normalizeNodeType(meta?.nodeType),
        slotKey: String(meta?.slotKey || buildOrchestrationRuntimeSlotKey(meta?.stageIndex, meta?.nodeIndex, meta?.nodeId)),
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
    };
    trace.nextAttemptId = Number(trace.nextAttemptId || 1) + 1;
    trace.attempts.push(attempt);
    recordOrchestrationRuntimeEvent(trace, 'node_started', {
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

function finishOrchestrationRuntimeNodeAttempt(trace, attempt, details = {}) {
    if (!trace || typeof trace !== 'object' || !attempt || typeof attempt !== 'object') {
        return;
    }
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
        ? cloneOrchestrationTraceValue(details?.replayResult)
        : attempt.replayResult;
    attempt.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'output')) {
        attempt.output = cloneOrchestrationTraceValue(details?.output);
        attempt.outputText = serializeOrchestrationRuntimeValue(details?.output);
        attempt.previewText = truncateOrchestrationRuntimePreview(attempt.outputText);
    }
    const eventType = attempt.nodeType === ORCH_NODE_TYPE_REVIEW ? 'review_finished' : 'node_finished';
    recordOrchestrationRuntimeEvent(trace, eventType, {
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
        replayResult: cloneOrchestrationTraceValue(attempt.replayResult),
    });
}

function normalizeAnchorPlayableFloor(value) {
    const normalized = Math.max(0, Math.floor(Number(value) || 0));
    return normalized > 0 ? normalized : 0;
}

function normalizeOrchestrationHistoryAnchors(rawAnchors) {
    const next = new Set();
    for (const value of Array.isArray(rawAnchors) ? rawAnchors : []) {
        const anchorPlayableFloor = normalizeAnchorPlayableFloor(value);
        if (anchorPlayableFloor > 0) {
            next.add(anchorPlayableFloor);
        }
    }
    return Array.from(next).sort((a, b) => a - b);
}

function equalNumberArrays(left, right) {
    const leftItems = Array.isArray(left) ? left : [];
    const rightItems = Array.isArray(right) ? right : [];
    if (leftItems.length !== rightItems.length) {
        return false;
    }
    for (let i = 0; i < leftItems.length; i++) {
        if (Number(leftItems[i]) !== Number(rightItems[i])) {
            return false;
        }
    }
    return true;
}

function getOrchestrationSnapshotNamespace(anchorPlayableFloor) {
    const normalized = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    if (!normalized) {
        return '';
    }
    return `${ORCH_CHAT_CONTENT_NAMESPACE_PREFIX}${normalized}`;
}

function normalizeLegacyOrchestrationSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }
    const capsuleText = String(source.capsuleText || '').trim();
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(source.anchorPlayableFloor || source.anchorFloor);
    if (!capsuleText || !anchorPlayableFloor) {
        return null;
    }
    return {
        anchorPlayableFloor,
        anchorHash: String(source.anchorHash || '').trim(),
        capsuleText,
        stageOutputs: Array.isArray(source.stageOutputs) ? structuredClone(source.stageOutputs) : [],
    };
}

function normalizeOrchestrationSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }
    const capsuleText = String(source.capsuleText || '').trim();
    if (!capsuleText) {
        return null;
    }
    return {
        anchorHash: String(source.anchorHash || '').trim(),
        capsuleText,
        stageOutputs: Array.isArray(source.stageOutputs) ? structuredClone(source.stageOutputs) : [],
    };
}

function normalizeOrchestratorChatState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        version: Number(source.version || ORCH_CHAT_STATE_VERSION),
        anchors: normalizeOrchestrationHistoryAnchors(source.anchors),
        legacySnapshot: normalizeLegacyOrchestrationSnapshot(source.snapshot),
    };
}

function setLoadedOrchestrationHistoryIndex(chatKey, anchors) {
    const normalizedChatKey = String(chatKey || '').trim();
    if (!normalizedChatKey) {
        latestOrchestrationHistoryIndex = null;
        return;
    }
    latestOrchestrationHistoryIndex = {
        chatKey: normalizedChatKey,
        anchors: normalizeOrchestrationHistoryAnchors(anchors),
    };
}

function getLoadedOrchestrationHistoryAnchors(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationHistoryIndex || typeof latestOrchestrationHistoryIndex !== 'object') {
        return [];
    }
    if (String(latestOrchestrationHistoryIndex.chatKey || '') !== String(chatKey || '')) {
        return [];
    }
    return normalizeOrchestrationHistoryAnchors(latestOrchestrationHistoryIndex.anchors);
}

function materializeOrchestrationSnapshot(chatKey, anchorPlayableFloor, snapshot) {
    const normalizedSnapshot = normalizeOrchestrationSnapshot(snapshot);
    const normalizedChatKey = String(chatKey || '').trim();
    const normalizedAnchor = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    if (!normalizedSnapshot || !normalizedChatKey || !normalizedAnchor) {
        return null;
    }
    return {
        chatKey: normalizedChatKey,
        anchorPlayableFloor: normalizedAnchor,
        anchorHash: String(normalizedSnapshot.anchorHash || '').trim(),
        capsuleText: normalizedSnapshot.capsuleText,
        stageOutputs: Array.isArray(normalizedSnapshot.stageOutputs) ? structuredClone(normalizedSnapshot.stageOutputs) : [],
    };
}

async function loadStoredOrchestrationSnapshot(context, anchorPlayableFloor) {
    const namespace = getOrchestrationSnapshotNamespace(anchorPlayableFloor);
    if (!namespace || typeof context?.getChatState !== 'function') {
        return null;
    }
    const payload = await context.getChatState(namespace, {});
    return normalizeOrchestrationSnapshot(payload);
}

async function persistStoredOrchestrationSnapshot(context, anchorPlayableFloor, snapshot) {
    const namespace = getOrchestrationSnapshotNamespace(anchorPlayableFloor);
    const normalized = normalizeOrchestrationSnapshot(snapshot);
    if (!namespace || !normalized || typeof context?.updateChatState !== 'function') {
        return false;
    }
    const result = await context.updateChatState(namespace, () => ({
        anchorHash: String(normalized.anchorHash || '').trim(),
        capsuleText: normalized.capsuleText,
        stageOutputs: Array.isArray(normalized.stageOutputs) ? structuredClone(normalized.stageOutputs) : [],
    }), { maxOperations: 2000, maxRetries: 1 });
    return Boolean(result?.ok);
}

async function deleteStoredOrchestrationSnapshot(context, anchorPlayableFloor) {
    const namespace = getOrchestrationSnapshotNamespace(anchorPlayableFloor);
    if (!namespace || typeof context?.deleteChatState !== 'function') {
        return false;
    }
    return Boolean(await context.deleteChatState(namespace, {}));
}

function getPlayableMessageAt(messages, playableFloor) {
    const source = Array.isArray(messages) ? messages : [];
    const targetPlayableFloor = normalizeAnchorPlayableFloor(playableFloor);
    if (!targetPlayableFloor) {
        return null;
    }
    let playableSeq = 0;
    for (let index = 0; index < source.length; index++) {
        const message = source[index];
        if (!message || message.is_system) {
            continue;
        }
        playableSeq += 1;
        if (playableSeq === targetPlayableFloor) {
            return { index, message };
        }
    }
    return null;
}

function isStoredOrchestrationSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages) {
    const normalizedSnapshot = normalizeOrchestrationSnapshot(snapshot);
    if (!normalizedSnapshot) {
        return false;
    }
    const target = getPlayableMessageAt(messages, anchorPlayableFloor);
    if (!target?.message || target.message.is_system || !target.message.is_user) {
        return false;
    }
    const storedHash = String(normalizedSnapshot.anchorHash || '').trim();
    if (!storedHash) {
        return false;
    }
    const currentHash = String(getStringHash(buildAnchorHashSource(messages, target.index)));
    return currentHash === storedHash;
}

async function selectLatestValidOrchestrationSnapshot(context, { persistCleanup = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        latestOrchestrationHistoryIndex = null;
        return null;
    }

    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const previousAnchors = getLoadedOrchestrationHistoryAnchors(context);
    const nextAnchors = previousAnchors.slice();
    let nextSnapshot = null;

    for (let index = nextAnchors.length - 1; index >= 0; index--) {
        const anchorPlayableFloor = nextAnchors[index];
        const snapshot = await loadStoredOrchestrationSnapshot(context, anchorPlayableFloor);
        if (!snapshot || !isStoredOrchestrationSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages)) {
            nextAnchors.splice(index, 1);
            if (persistCleanup) {
                await deleteStoredOrchestrationSnapshot(context, anchorPlayableFloor);
            }
            continue;
        }
        nextSnapshot = materializeOrchestrationSnapshot(chatKey, anchorPlayableFloor, snapshot);
        break;
    }

    setLoadedOrchestrationHistoryIndex(chatKey, nextAnchors);
    latestOrchestrationSnapshot = nextSnapshot;
    if (persistCleanup && !equalNumberArrays(previousAnchors, nextAnchors)) {
        await persistOrchestratorChatState(context);
    }
    return nextSnapshot;
}

async function loadOrchestratorChatState(context, { force = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        latestOrchestrationHistoryIndex = null;
        loadedChatStateKey = '';
        return;
    }
    if (!force && loadedChatStateKey === chatKey) {
        return;
    }

    let payload = null;
    if (typeof context?.getChatState === 'function') {
        payload = await context.getChatState(ORCH_CHAT_STATE_NAMESPACE, {});
    }
    const normalized = normalizeOrchestratorChatState(payload);
    let nextAnchors = normalized.anchors.slice();
    let migratedLegacySnapshot = false;
    if (normalized.legacySnapshot) {
        const legacyAnchor = normalizeAnchorPlayableFloor(normalized.legacySnapshot.anchorPlayableFloor);
        if (legacyAnchor) {
            await persistStoredOrchestrationSnapshot(context, legacyAnchor, normalized.legacySnapshot);
            nextAnchors = normalizeOrchestrationHistoryAnchors([...nextAnchors, legacyAnchor]);
            migratedLegacySnapshot = true;
        }
    }
    loadedChatStateKey = chatKey;
    setLoadedOrchestrationHistoryIndex(chatKey, nextAnchors);
    await selectLatestValidOrchestrationSnapshot(context, { persistCleanup: true });
    if (migratedLegacySnapshot) {
        await persistOrchestratorChatState(context);
    }
}

async function persistOrchestratorChatState(context) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        return;
    }
    loadedChatStateKey = chatKey;
    const anchors = getLoadedOrchestrationHistoryAnchors(context);
    if (anchors.length === 0 && typeof context?.deleteChatState === 'function') {
        await context.deleteChatState(ORCH_CHAT_STATE_NAMESPACE, {});
        return;
    }
    if (typeof context?.updateChatState !== 'function') {
        return;
    }
    await context.updateChatState(ORCH_CHAT_STATE_NAMESPACE, () => ({
        version: ORCH_CHAT_STATE_VERSION,
        anchors,
    }), { maxOperations: 2000, maxRetries: 1 });
}

function getLatestOrchestrationEntry(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return null;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    const injectedText = String(latestOrchestrationSnapshot.capsuleText || '').trim();
    if (!injectedText) {
        return null;
    }
    return {
        anchorPlayableFloor: normalizeAnchorPlayableFloor(latestOrchestrationSnapshot.anchorPlayableFloor),
        injectedText,
    };
}

function buildOrchestratorResultEventPayload(context, payload, status, options = {}) {
    const generationType = String(payload?.type || 'normal').trim().toLowerCase() || 'normal';
    const chatKey = String(getChatKey(context) || '');
    const includeSnapshot = Boolean(options.includeSnapshot);
    const snapshot = includeSnapshot && latestOrchestrationSnapshot && typeof latestOrchestrationSnapshot === 'object'
        ? latestOrchestrationSnapshot
        : null;
    const sameChatSnapshot = snapshot && String(snapshot.chatKey || '') === chatKey
        ? snapshot
        : null;
    const entry = sameChatSnapshot ? getLatestOrchestrationEntry(context) : null;

    return {
        module: MODULE_NAME,
        event: ORCH_RESULT_EVENT,
        status: String(status || 'unknown'),
        generationType,
        chatKey,
        at: new Date().toISOString(),
        anchorPlayableFloor: Number(entry?.anchorPlayableFloor || 0),
        anchorHash: String(sameChatSnapshot?.anchorHash || ''),
        capsuleText: String(entry?.injectedText || ''),
        stageOutputs: sameChatSnapshot && Array.isArray(sameChatSnapshot.stageOutputs)
            ? structuredClone(sameChatSnapshot.stageOutputs)
            : [],
        reviewRerunCount: Number(options.reviewRerunCount || 0),
        reason: String(options.reason || ''),
        note: String(options.note || ''),
        error: String(options.error || ''),
    };
}

async function emitOrchestratorResultEvent(context, payload, status, options = {}) {
    if (!context?.eventSource || typeof context.eventSource.emit !== 'function') {
        return;
    }
    const eventPayload = buildOrchestratorResultEventPayload(context, payload, status, options);
    try {
        await context.eventSource.emit(ORCH_RESULT_EVENT, eventPayload);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to emit result event`, error);
    }
}

function getTargetAssistantLayer(payload) {
    const type = String(payload?.type || 'normal').trim().toLowerCase();
    const messages = getCoreMessages(payload);
    const assistantCount = messages.filter(message => !message?.is_user).length;
    return (type === 'regenerate' || type === 'swipe' || type === 'continue')
        ? Math.max(assistantCount, 1)
        : Math.max(assistantCount + 1, 1);
}

async function getPreviousOrchestrationCapsuleText(context, payload) {
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, '__lukerOrchPreviousCapsuleText')) {
        return String(payload.__lukerOrchPreviousCapsuleText || '');
    }
    const chatKey = getChatKey(context);
    const currentAnchor = buildLastUserAnchor(context, getCoreMessages(payload));
    const currentAnchorPlayableFloor = normalizeAnchorPlayableFloor(currentAnchor?.playableFloor);
    if (!chatKey || !currentAnchorPlayableFloor) {
        return '';
    }

    const messages = Array.isArray(getCoreMessages(payload)) && getCoreMessages(payload).length > 0
        ? getCoreMessages(payload)
        : (Array.isArray(context?.chat) ? context.chat : []);
    const candidateAnchors = getLoadedOrchestrationHistoryAnchors(context)
        .filter(anchorPlayableFloor => anchorPlayableFloor < currentAnchorPlayableFloor)
        .sort((left, right) => right - left);

    for (const anchorPlayableFloor of candidateAnchors) {
        const snapshot = await loadStoredOrchestrationSnapshot(context, anchorPlayableFloor);
        if (!snapshot || !isStoredOrchestrationSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages)) {
            continue;
        }
        const previousCapsuleText = String(snapshot.capsuleText || '').trim();
        if (payload && typeof payload === 'object') {
            payload.__lukerOrchPreviousCapsuleText = previousCapsuleText;
        }
        return previousCapsuleText;
    }

    if (payload && typeof payload === 'object') {
        payload.__lukerOrchPreviousCapsuleText = '';
    }
    return '';
}

function formatReadableTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return i18n('Not set');
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return raw;
    }
    try {
        return parsed.toLocaleString();
    } catch {
        return raw;
    }
}

function renderLastOrchestrationResultHtml(context) {
    const entry = getLatestOrchestrationEntry(context);
    if (!entry || typeof entry !== 'object') {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No recent orchestration result available for this chat.'))}</div>`;
    }

    const anchorPlayableFloor = normalizeAnchorPlayableFloor(entry.anchorPlayableFloor);
    const injectedText = String(entry.injectedText || '').trim();

    return `
<div class="luker-studio luker_orch_last_run_popup">
    <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Anchored User Turn'))}</b><span>${escapeHtml(String(anchorPlayableFloor || 0))}</span></div>
    <pre class="luker-studio-attempt-pre">${escapeHtml(injectedText || i18n('Not set'))}</pre>
</div>`;
}

function formatOrchestrationRuntimeStatusLabel(status) {
    switch (String(status || '').trim().toLowerCase()) {
        case 'running':
            return i18n('Running');
        case 'completed':
            return i18n('Completed');
        case 'cancelled':
            return i18n('Cancelled');
        case 'failed':
            return i18n('Failed');
        case 'reused':
            return i18n('Reused');
        default:
            return i18n('Idle');
    }
}

function buildOrchestrationRuntimeTraceNodeIndex(trace) {
    const index = new Map();
    for (const attempt of Array.isArray(trace?.attempts) ? trace.attempts : []) {
        const slotKey = String(attempt?.slotKey || '');
        if (!slotKey) {
            continue;
        }
        if (!index.has(slotKey)) {
            index.set(slotKey, []);
        }
        index.get(slotKey).push(attempt);
    }
    return index;
}

function renderOrchestrationRuntimeTraceGraphHtml(trace) {
    const attemptIndex = buildOrchestrationRuntimeTraceNodeIndex(trace);
    const stages = Array.isArray(trace?.stages) ? trace.stages : [];
    if (stages.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No node attempts recorded.'))}</div>`;
    }

    return stages.map((stage, stageIndex) => {
        const stageNodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeHtml = stageNodes.map((node) => {
            const attempts = attemptIndex.get(String(node?.slotKey || '')) || [];
            const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
            const status = formatOrchestrationRuntimeStatusLabel(latestAttempt?.status || '');
            const statusKey = String(latestAttempt?.status || 'idle').trim().toLowerCase() || 'idle';
            const previewText = truncateOrchestrationRuntimePreview(String(latestAttempt?.previewText || ''), 120);
            return `
<div class="luker-studio-flow-node">
    <div class="luker-studio-flow-node-head">
        <div class="luker-studio-flow-node-title">${escapeHtml(String(node?.id || ''))}</div>
        <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(status)}</span>
    </div>
    <div class="luker-studio-flow-node-meta">${escapeHtml(String(node?.type || 'worker'))} · ${escapeHtml(String(node?.preset || node?.id || ''))}</div>
    <div class="luker-studio-flow-node-meta">${escapeHtml(i18n('Node Attempts'))}: ${escapeHtml(String(attempts.length || 0))}</div>
    ${previewText ? `<div class="luker-studio-flow-node-preview">${escapeHtml(previewText)}</div>` : ''}
</div>`;
        }).join('');
        return `
<div class="luker-studio-flow-stage">
    <div class="luker-studio-flow-stage-head">
        <div class="luker-studio-flow-stage-title">${escapeHtml(String(stage?.id || `stage_${stageIndex + 1}`))}</div>
        <div class="luker-studio-flow-stage-mode">${escapeHtml(String(stage?.mode || 'serial'))}</div>
    </div>
    <div class="luker-studio-flow-stage-nodes">${nodeHtml || `<div class="luker-studio-empty-hint">${escapeHtml(i18n('Not set'))}</div>`}</div>
</div>
${stageIndex < stages.length - 1 ? '<div class="luker-studio-flow-arrow">→</div>' : ''}`;
    }).join('');
}

function formatOrchestrationRuntimeEventSummary(event) {
    const type = String(event?.type || '');
    const stageId = String(event?.stageId || '');
    const nodeId = String(event?.nodeId || '');
    switch (type) {
        case 'run_started':
            return `Run started · ${String(event?.generationType || 'normal') || 'normal'}`;
        case 'run_finished':
            return `Run ${String(event?.status || 'completed')} · reruns=${Number(event?.reviewRerunCount || 0)}`;
        case 'replay_started':
            return `Replay started · ${String(event?.restartStageId || 'stage')} · ${Array.isArray(event?.targetNodeIds) ? event.targetNodeIds.join(', ') : ''}`.trim();
        case 'replay_finished':
            return `Replay finished · ${String(event?.restart_stage_id || 'stage')} · rerun ${Number(event?.rerun_round || 0)}`;
        case 'stage_started':
            return `${event?.replay ? 'Replay ' : ''}stage started · ${stageId || 'stage'}`;
        case 'stage_finished':
            return `${event?.replay ? 'Replay ' : ''}stage ${String(event?.status || 'completed')} · ${stageId || 'stage'}`;
        case 'node_started':
            return `${String(event?.nodeType || 'worker')} started · ${nodeId}`;
        case 'node_finished':
            return `worker ${String(event?.status || 'completed')} · ${nodeId}`;
        case 'review_finished':
            return `review ${String(event?.status || 'completed')} · ${nodeId}${event?.action ? ` · ${event.action}` : ''}`;
        default:
            return `${type || 'event'} · ${nodeId || stageId || ''}`.trim();
    }
}

function renderOrchestrationRuntimeTraceEventsHtml(trace) {
    const events = Array.isArray(trace?.events) ? trace.events : [];
    if (events.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No events recorded.'))}</div>`;
    }
    return `<div class="luker-studio-timeline">${events.map((event) => `
<div class="luker-studio-timeline-event">
    <div class="luker-studio-timeline-seq">#${escapeHtml(String(event?.seq || ''))}</div>
    <div class="luker-studio-timeline-body">
        <div class="luker-studio-timeline-text">${escapeHtml(formatOrchestrationRuntimeEventSummary(event))}</div>
        <div class="luker-studio-timeline-time">${escapeHtml(formatReadableTimestamp(event?.at))}</div>
    </div>
</div>`).join('')}</div>`;
}

function renderOrchestrationRuntimeAttemptHtml(attempt, previousOutputText = '', attemptNo = 1) {
    const statusKey = String(attempt?.status || 'idle').trim().toLowerCase() || 'idle';
    const statusLabel = formatOrchestrationRuntimeStatusLabel(attempt?.status || '');
    const outputText = String(attempt?.outputText || '');
    const hasOutputDiff = Boolean(previousOutputText && outputText && previousOutputText !== outputText);
    const metaItems = [
        `${String(attempt?.stageId || '')} · ${String(attempt?.nodeType || 'worker')}`,
        String(attempt?.preset || ''),
        i18nFormat('Attempt ${0}', attemptNo),
    ].filter(Boolean);
    if (attempt?.runKind === 'review') {
        metaItems.push(`round ${Math.max(1, Number(attempt?.round || 1))}`);
    }

    return `
<details class="luker-studio-attempt"${attemptNo > 1 || statusKey === 'running' || statusKey === 'failed' ? ' open' : ''}>
    <summary>
        <span class="luker-studio-attempt-title">${escapeHtml(String(attempt?.nodeId || ''))}</span>
        <span class="luker-studio-attempt-badges">
            <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(statusLabel)}</span>
            <span class="luker-studio-attempt-meta">#${escapeHtml(String(attempt?.sequence || ''))}</span>
        </span>
    </summary>
    <div class="luker-studio-attempt-meta">${metaItems.map(item => escapeHtml(item)).join(' · ')}</div>
    <div class="luker-studio-attempt-meta">${escapeHtml(i18n('Created At'))}: ${escapeHtml(formatReadableTimestamp(attempt?.startedAt))}</div>
    <div class="luker-studio-attempt-meta">${escapeHtml(i18n('Finished At'))}: ${escapeHtml(formatReadableTimestamp(attempt?.endedAt || ''))}</div>
    ${attempt?.rerunReason ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Review feedback'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.rerunReason || ''))}</pre>` : ''}
    ${attempt?.action ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Decision'))}</div><div class="luker-studio-attempt-meta">${escapeHtml(String(attempt.action || ''))}</div>` : ''}
    ${Array.isArray(attempt?.targetNodeIds) && attempt.targetNodeIds.length > 0 ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Targets'))}</div><div class="luker-studio-attempt-meta">${escapeHtml(attempt.targetNodeIds.join(', '))}</div>` : ''}
    ${attempt?.reason ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Review feedback'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.reason || ''))}</pre>` : ''}
    ${attempt?.replayResult ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Replay result'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(toReadableYamlText(attempt.replayResult, '{}'))}</pre>` : ''}
    ${attempt?.error ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Failed'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.error || ''))}</pre>` : ''}
    ${hasOutputDiff ? `
        <div class="luker-studio-attempt-label">${escapeHtml(i18n('Rerun diff'))}</div>
        ${renderIterationLineDiffHtml(previousOutputText, outputText, `${attempt?.nodeId || 'node'} rerun diff`)}
        <div class="luker-studio-attempt-dual">
            <div class="luker-studio-attempt-dual-col">
                <div class="luker-studio-attempt-label">${escapeHtml(i18n('Previous result'))}</div>
                <pre class="luker-studio-attempt-pre">${escapeHtml(previousOutputText)}</pre>
            </div>
            <div class="luker-studio-attempt-dual-col">
                <div class="luker-studio-attempt-label">${escapeHtml(i18n('Current result'))}</div>
                <pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>
            </div>
        </div>` : ''}
    ${outputText ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Output'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>` : ''}
</details>`;
}

function renderOrchestrationRuntimeTraceAttemptsHtml(trace) {
    const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
    if (attempts.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No node attempts recorded.'))}</div>`;
    }
    const attemptCountBySlot = new Map();
    const lastOutputBySlot = new Map();
    return `<div class="luker-studio-attempts">${attempts.map((attempt) => {
        const slotKey = String(attempt?.slotKey || '');
        const nextCount = Number(attemptCountBySlot.get(slotKey) || 0) + 1;
        attemptCountBySlot.set(slotKey, nextCount);
        const previousOutputText = lastOutputBySlot.get(slotKey) || '';
        if (String(attempt?.outputText || '')) {
            lastOutputBySlot.set(slotKey, String(attempt.outputText || ''));
        }
        return renderOrchestrationRuntimeAttemptHtml(attempt, previousOutputText, nextCount);
    }).join('')}</div>`;
}

function renderOrchestrationRuntimeTraceHtml(context) {
    const trace = getLatestOrchestrationRuntimeTrace(context);
    if (!trace || typeof trace !== 'object') {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No runtime orchestration trace available for this chat yet.'))}</div>`;
    }

    const notices = [
        i18n('This trace is in-memory only and clears when chat changes.'),
        trace.status === 'running' ? i18n('Trace is still running. Close and reopen to refresh.') : '',
        String(trace.note || ''),
    ].filter(Boolean);

    return `
<div class="luker-studio luker_orch_runtime_popup">
    <div class="luker-studio-notice">${notices.map(item => escapeHtml(String(item || ''))).join('<br />')}</div>
    <div class="luker-studio-meta-grid">
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Status'))}</b><span>${escapeHtml(formatOrchestrationRuntimeStatusLabel(trace.status))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Generation Type'))}</b><span>${escapeHtml(String(trace.generationType || 'normal'))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Target Layer'))}</b><span>${escapeHtml(String(trace.targetLayer || 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Node Attempts'))}</b><span>${escapeHtml(String(Array.isArray(trace.attempts) ? trace.attempts.length : 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Review Reruns'))}</b><span>${escapeHtml(String(trace.reviewRerunCount || 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Updated At'))}</b><span>${escapeHtml(formatReadableTimestamp(trace.updatedAt))}</span></div>
    </div>
    <div class="luker-studio-columns">
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Flow Graph'))}</div>
            <div class="luker-studio-flow">${renderOrchestrationRuntimeTraceGraphHtml(trace)}</div>
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Flow Events'))}</div>
            ${renderOrchestrationRuntimeTraceEventsHtml(trace)}
        </div>
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Execution Timeline'))}</div>
            ${renderOrchestrationRuntimeTraceAttemptsHtml(trace)}
        </div>
    </div>
    ${String(trace?.capsuleText || '').trim() ? `
        <details class="luker-studio-raw">
            <summary>${escapeHtml(i18n('Latest capsule text'))}</summary>
            <pre class="luker-studio-attempt-pre">${escapeHtml(String(trace.capsuleText || ''))}</pre>
        </details>` : ''}
    <details class="luker-studio-raw">
        <summary>${escapeHtml(i18n('Raw runtime trace'))}</summary>
        <pre class="luker-studio-attempt-pre">${escapeHtml(JSON.stringify(trace, null, 2))}</pre>
    </details>
</div>`;
}

async function openOrchestrationRuntimeTrace(context) {
    const popupId = `luker_orch_runtime_trace_${Date.now()}`;
    const selector = `#${popupId}`;
    const namespace = `.lukerOrchRuntimeTrace_${popupId}`;
    const popupHtml = `<div id="${popupId}" class="luker_orch_runtime_popup_shell">${renderOrchestrationRuntimeTraceHtml(context)}</div>`;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Orchestration Runtime Trace'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
        },
    );

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        openOrchExpandedDiff(rootElement, this);
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="close-line-diff-zoom"], ${selector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`keydown${namespace}`, function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const rootElement = document.querySelector(selector);
        const overlay = rootElement?.querySelector?.('.luker_orch_line_diff_zoom_overlay');
        if (!(overlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`pointerdown${namespace}`, `${selector} .luker_orch_line_diff_splitter`, function (event) {
        beginOrchLineDiffResize(this, event.originalEvent || event);
    });

    try {
        await popupPromise;
    } finally {
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
        jQuery(document).off(namespace);
    }
}

async function editLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context, { force: false });
    const entry = getLatestOrchestrationEntry(context);
    if (!entry || typeof entry !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    const input = await context.callGenericPopup(
        i18n('Edit latest orchestration result text.'),
        context.POPUP_TYPE.INPUT,
        String(entry.injectedText || ''),
        {
            rows: 16,
            wide: true,
            wider: true,
            large: true,
            okButton: i18n('Save'),
            cancelButton: i18n('Cancel'),
        },
    );
    if (typeof input !== 'string') {
        return false;
    }

    const nextText = String(input || '').trim();
    if (!nextText) {
        notifyError(i18n('Orchestration result cannot be empty.'));
        return false;
    }

    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    latestOrchestrationSnapshot = {
        ...latestOrchestrationSnapshot,
        capsuleText: nextText,
    };
    clearCapsulePrompt(context);
    await persistStoredOrchestrationSnapshot(context, latestOrchestrationSnapshot.anchorPlayableFloor, latestOrchestrationSnapshot);
    ensureUi();
    notifySuccess(i18n('Saved latest orchestration result.'));
    updateUiStatus(i18n('Saved latest orchestration result.'));
    return true;
}

async function openLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context, { force: false });
    const hasEntry = Boolean(getLatestOrchestrationEntry(context));
    const editButtonResult = context?.POPUP_RESULT?.CUSTOM1 ?? 2;
    const popupResult = await context.callGenericPopup(
        renderLastOrchestrationResultHtml(context),
        context.POPUP_TYPE.TEXT,
        i18n('Latest Orchestration Result'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
            customButtons: hasEntry
                ? [{ text: i18n('Edit Result'), result: editButtonResult, appendAtEnd: true }]
                : [],
        },
    );
    if (popupResult === editButtonResult) {
        const saved = await editLastOrchestrationResult(context);
        if (saved) {
            await openLastOrchestrationResult(context);
        }
    }
}

function shouldRunOrchestrationForPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    if (payload.dryRun === true) {
        return false;
    }
    const type = String(payload.type || '').trim().toLowerCase();
    if (!ORCH_ALLOWED_GENERATION_TYPES.has(type)) {
        return false;
    }
    return true;
}

function getCurrentAvatar(context) {
    return context.characters?.[context.characterId]?.avatar || '';
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    if (!avatar || !chatId) {
        return '';
    }
    return `char:${avatar}:${chatId}`;
}

function abortActiveOrchestratorRun() {
    if (activeOrchRunAbortController && !activeOrchRunAbortController.signal.aborted) {
        activeOrchRunAbortController.abort();
    }
    clearRunInfoToast();
}

function getCoreMessages(payload) {
    return Array.isArray(payload?.coreChat) ? payload.coreChat : [];
}

function getRecentMessages(messages, assistantTurns) {
    const source = Array.isArray(messages) ? messages : [];
    const targetTurns = Math.max(1, Math.floor(Number(assistantTurns) || 1));

    let matchedTurns = 0;
    let startIndex = -1;
    for (let i = source.length - 1; i >= 0; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            continue;
        }
        if (!message.is_user) {
            matchedTurns += 1;
            if (matchedTurns >= targetTurns) {
                startIndex = i;
                break;
            }
        }
    }

    if (startIndex < 0) {
        return source.slice();
    }

    // Include user message(s) immediately before the cutoff assistant turn.
    while (startIndex > 0) {
        const prev = source[startIndex - 1];
        if (!prev || prev.is_system || !prev.is_user) {
            break;
        }
        startIndex -= 1;
    }

    return source.slice(startIndex);
}

function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) {
            return { index: i, message: messages[i] };
        }
    }

    return { index: -1, message: null };
}

function buildAnchorHashSource(messages, endIndex) {
    const message = messages[endIndex];
    return String(message?.mes ?? '');
}

function buildLastUserAnchorFromMessages(messages) {
    const { index, message } = extractLastUserMessage(messages);
    if (index < 0 || !message) {
        return null;
    }
    const hashSource = buildAnchorHashSource(messages, index);
    const playableFloor = messages
        .slice(0, index + 1)
        .reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0);
    return {
        floor: index + 1,
        playableFloor,
        hash: String(getStringHash(hashSource)),
    };
}

function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }

    return buildLastUserAnchorFromMessages(payloadMessages);
}

function canReuseLatestOrchestrationSnapshot(chatKey, anchor) {
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }
    return normalizeAnchorPlayableFloor(latestOrchestrationSnapshot.anchorPlayableFloor) === normalizeAnchorPlayableFloor(anchor.playableFloor)
        && String(latestOrchestrationSnapshot.anchorHash || '') === String(anchor.hash || '');
}

async function deleteStoredOrchestrationAnchors(context, anchors) {
    const normalizedAnchors = normalizeOrchestrationHistoryAnchors(anchors);
    for (const anchorPlayableFloor of normalizedAnchors) {
        await deleteStoredOrchestrationSnapshot(context, anchorPlayableFloor);
    }
}

async function storeCompletedOrchestrationSnapshot(context, anchor, capsuleText, stageOutputs) {
    const chatKey = getChatKey(context);
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const anchorHash = String(anchor?.hash || '').trim();
    const nextCapsuleText = String(capsuleText || '').trim();
    if (!chatKey || !anchorPlayableFloor || !anchorHash || !nextCapsuleText) {
        return null;
    }

    const compactOutputs = compactStageOutputs(stageOutputs || []);
    const nextSnapshot = {
        anchorHash,
        capsuleText: nextCapsuleText,
        stageOutputs: compactOutputs,
    };
    const previousAnchors = getLoadedOrchestrationHistoryAnchors(context);
    const removedAnchors = previousAnchors.filter(existingAnchor => existingAnchor > anchorPlayableFloor);
    if (removedAnchors.length > 0) {
        await deleteStoredOrchestrationAnchors(context, removedAnchors);
    }
    const ok = await persistStoredOrchestrationSnapshot(context, anchorPlayableFloor, nextSnapshot);
    if (!ok) {
        throw new Error(i18n('Failed to persist orchestration snapshot.'));
    }
    const nextAnchors = normalizeOrchestrationHistoryAnchors([
        ...previousAnchors.filter(existingAnchor => existingAnchor <= anchorPlayableFloor),
        anchorPlayableFloor,
    ]);
    setLoadedOrchestrationHistoryIndex(chatKey, nextAnchors);
    latestOrchestrationSnapshot = materializeOrchestrationSnapshot(chatKey, anchorPlayableFloor, nextSnapshot);
    await persistOrchestratorChatState(context);
    ensureUi();
    return latestOrchestrationSnapshot;
}

function updateOrchestrationHistoryStatusAfterInvalidation(context) {
    const entry = getLatestOrchestrationEntry(context);
    if (entry?.anchorPlayableFloor) {
        updateUiStatus(i18nFormat('Orchestration history invalidated. Rolled back to user turn ${0}.', entry.anchorPlayableFloor));
        return;
    }
    updateUiStatus(i18n('Orchestration history invalidated. No valid stored result remains.'));
}

async function invalidateStoredOrchestrationAnchors(context, thresholdPlayableFloor = 0, { inclusive = true } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        latestOrchestrationHistoryIndex = null;
        clearCapsulePrompt(context);
        ensureUi();
        return false;
    }

    const currentAnchors = getLoadedOrchestrationHistoryAnchors(context);
    const normalizedThreshold = normalizeAnchorPlayableFloor(thresholdPlayableFloor);
    const removedAnchors = normalizedThreshold > 0
        ? currentAnchors.filter(anchorPlayableFloor => inclusive ? anchorPlayableFloor >= normalizedThreshold : anchorPlayableFloor > normalizedThreshold)
        : currentAnchors.slice();
    if (removedAnchors.length === 0) {
        clearCapsulePrompt(context);
        ensureUi();
        return false;
    }

    await deleteStoredOrchestrationAnchors(context, removedAnchors);
    const nextAnchors = currentAnchors.filter(anchorPlayableFloor => !removedAnchors.includes(anchorPlayableFloor));
    setLoadedOrchestrationHistoryIndex(chatKey, nextAnchors);
    await persistOrchestratorChatState(context);
    await selectLatestValidOrchestrationSnapshot(context, { persistCleanup: true });
    clearCapsulePrompt(context);
    updateOrchestrationHistoryStatusAfterInvalidation(context);
    ensureUi();
    return true;
}

function getEffectiveProfile(context) {
    const settings = extension_settings[MODULE_NAME];
    const executionMode = getExecutionMode(settings);
    if (executionMode === ORCH_EXECUTION_MODE_AGENDA) {
        const buildAgendaProfile = (source, key, draft) => {
            const profile = sanitizeAgendaWorkingProfile(draft);
            return {
                source: String(source || 'agenda'),
                key: String(key || 'agenda'),
                mode: ORCH_EXECUTION_MODE_AGENDA,
                planner: profile.planner,
                agents: profile.agents,
                finalAgentId: profile.finalAgentId,
                limits: {
                    plannerMaxRounds: profile.limits.plannerMaxRounds,
                    maxConcurrentAgents: profile.limits.maxConcurrentAgents,
                    maxTotalRuns: profile.limits.maxTotalRuns,
                },
            };
        };

        const chatKey = getChatKey(context);
        const chatOverride = settings.chatOverrides?.[chatKey];
        if (chatOverride?.agenda?.enabled) {
            return buildAgendaProfile('chat', chatKey, chatOverride.agenda);
        }

        const avatar = getCurrentAvatar(context);
        const characterAgendaOverride = getCharacterAgendaOverrideByAvatar(context, avatar);
        if (characterAgendaOverride?.enabled) {
            return buildAgendaProfile('character', avatar, characterAgendaOverride);
        }

        return buildAgendaProfile('global', 'agenda', {
            planner: settings.agendaPlanner,
            agents: settings.agendaAgents,
            finalAgentId: settings.agendaFinalAgentId,
            limits: {
                plannerMaxRounds: settings.agendaPlannerMaxRounds,
                maxConcurrentAgents: settings.agendaMaxConcurrentAgents,
                maxTotalRuns: settings.agendaMaxTotalRuns,
            },
        });
    }
    if (executionMode === ORCH_EXECUTION_MODE_SINGLE || settings.singleAgentModeEnabled) {
        return {
            source: 'single',
            key: 'single_agent',
            mode: ORCH_EXECUTION_MODE_SINGLE,
            spec: sanitizeSpec({
                stages: [{
                    id: 'single',
                    mode: 'serial',
                    nodes: [{
                        id: 'single_agent',
                        preset: 'single_agent',
                    }],
                }],
            }),
            presets: sanitizePresetMap({
                ...settings.presets,
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE),
                },
            }),
        };
    }
    const chatKey = getChatKey(context);
    const chatOverride = settings.chatOverrides?.[chatKey];
    if (chatOverride?.enabled && chatOverride?.spec) {
        const overridePresets = resolveOverridePresetMap(chatOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(chatOverride.spec, editablePresets);
        return {
            source: 'chat',
            key: chatKey,
            mode: ORCH_EXECUTION_MODE_SPEC,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
        };
    }

    const avatar = getCurrentAvatar(context);
    const characterOverride = getCharacterOverrideByAvatar(context, avatar);
    if (characterOverride?.enabled && characterOverride?.spec) {
        const overridePresets = resolveOverridePresetMap(characterOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(characterOverride.spec, editablePresets);
        return {
            source: 'character',
            key: avatar,
            mode: ORCH_EXECUTION_MODE_SPEC,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
        };
    }

    return {
        source: 'global',
        key: 'global',
        mode: ORCH_EXECUTION_MODE_SPEC,
        spec: sanitizeSpec(settings.orchestrationSpec),
        presets: sanitizePresetMap(settings.presets),
    };
}

function normalizeNodeSpec(node) {
    if (typeof node === 'string') {
        return {
            id: node,
            preset: node,
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: undefined,
        };
    }

    const id = String(node?.id || node?.node || node?.preset || '').trim();
    const preset = String(node?.preset || id).trim();
    return {
        id: id || preset,
        preset,
        type: normalizeNodeType(node?.type),
        userPromptTemplate: typeof node?.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
    };
}

function extractTemplateVariables(template) {
    const result = [];
    const text = String(template || '');
    const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        result.push(String(match[1] || '').trim());
    }
    return [...new Set(result.filter(Boolean))];
}

function getUnsupportedTemplateVariables(template) {
    const used = extractTemplateVariables(template);
    return used.filter(name => !ALLOWED_TEMPLATE_VARS.includes(name));
}

function validateAiBuildTemplateVariables(spec, presetPatch) {
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

function isAbortSignalLike(value) {
    return Boolean(value && typeof value === 'object' && 'aborted' in value);
}

function isAbortError(error, abortSignal = null) {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        return true;
    }
    const name = String(error?.name || '').toLowerCase();
    if (name === 'aborterror') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('aborted') || message.includes('abort');
}

function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(abortSignal, message = 'Operation aborted.') {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw createAbortError(message);
    }
}

function isNoToolCallExtractionError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) {
        return false;
    }
    return message.includes('did not return any tool call')
        || message.includes('none matched expected function names')
        || message.includes('returned empty text response')
        || message.includes('did not contain parseable function calls json');
}

function linkAbortSignals(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    if (validSignals.length === 0) {
        return { signal: null, cleanup: () => {} };
    }
    if (validSignals.length === 1) {
        return { signal: validSignals[0], cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

function getAgentTimeoutMs(settings) {
    const seconds = Math.max(0, Math.min(3600, Math.floor(Number(settings?.agentTimeoutSeconds) || 0)));
    return seconds > 0 ? seconds * 1000 : 0;
}

function createAttemptAbortController(baseAbortSignal = null, timeoutMs = 0) {
    const timeoutController = new AbortController();
    let didTimeout = false;
    let timeoutId = null;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
            didTimeout = true;
            if (!timeoutController.signal.aborted) {
                timeoutController.abort();
            }
        }, timeoutMs);
    }

    const linked = linkAbortSignals(baseAbortSignal, timeoutController.signal);

    return {
        signal: linked.signal,
        didTimeout: () => didTimeout,
        cleanup: () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            linked.cleanup();
        },
    };
}

const _rpmTimestamps = [];

async function waitForRpmSlot(settings, abortSignal = null) {
    const limit = Math.max(0, Math.floor(Number(settings?.rpmLimit) || 0));
    if (limit <= 0) return;
    const windowMs = 60_000;
    const pollMs = 200;
    while (true) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) return;
        const now = Date.now();
        while (_rpmTimestamps.length > 0 && _rpmTimestamps[0] <= now - windowMs) {
            _rpmTimestamps.shift();
        }
        if (_rpmTimestamps.length < limit) {
            _rpmTimestamps.push(now);
            return;
        }
        const waitUntil = _rpmTimestamps[0] + windowMs;
        const delay = Math.min(pollMs, Math.max(10, waitUntil - now));
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function requestToolCallWithRetry(settings, promptMessages, {
    functionName = '',
    functionDescription = '',
    parameters = {},
    llmPresetName = '',
    apiSettingsOverride = null,
    abortSignal = null,
    applyAgentTimeout = true,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const timeoutMs = applyAgentTimeout ? getAgentTimeoutMs(settings) : 0;
    const tools = [{
        type: 'function',
        function: {
            name: fnName,
            description: String(functionDescription || `Function output for ${fnName}`),
            parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', additionalProperties: true },
        },
    }];
    const toolChoice = {
        type: 'function',
        function: { name: fnName },
    };
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptController = createAttemptAbortController(
            isAbortSignalLike(abortSignal) ? abortSignal : null,
            timeoutMs,
        );
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const requestOptions = {
                tools,
                toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    requiredFunctionName: fnName,
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            };
            await waitForRpmSlot(settings, abortSignal);
            const responseData = await sendOpenAIRequest('quiet', promptMessages, attemptController.signal, {
                ...requestOptions,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const calls = extractAllFunctionCalls(responseData, [fnName]);
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            const matched = calls.find(call => String(call?.name || '') === fnName);
            if (!matched) {
                throw new Error(`Model returned tool call, but not '${fnName}'.`);
            }
            return matched.args;
        } catch (error) {
            const timedOut = attemptController.didTimeout();
            const sourceAborted = isAbortError(error, abortSignal);
            if (sourceAborted && !timedOut) {
                throw error;
            }
            const effectiveError = timedOut
                ? Object.assign(new Error(`Agent call '${fnName}' timed out after ${Math.floor(timeoutMs / 1000)}s.`), { name: 'TimeoutError' })
                : error;
            lastError = effectiveError;
            if (attempt >= retries) {
                throw effectiveError;
            }
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, effectiveError);
        } finally {
            attemptController.cleanup();
        }
    }

    throw lastError || new Error(`Tool call '${fnName}' failed.`);
}

async function requestToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    allowedNames = null,
    llmPresetName = '',
    apiSettingsOverride = null,
    retriesOverride = null,
    abortSignal = null,
    includeAssistantText = false,
    allowNoToolCalls = false,
    applyAgentTimeout = true,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const timeoutMs = applyAgentTimeout ? getAgentTimeoutMs(settings) : 0;
    const toolChoice = 'auto';
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptController = createAttemptAbortController(
            isAbortSignalLike(abortSignal) ? abortSignal : null,
            timeoutMs,
        );
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const requestOptions = {
                tools,
                toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            };
            await waitForRpmSlot(settings, abortSignal);
            const responseData = await sendOpenAIRequest('quiet', promptMessages, attemptController.signal, {
                ...requestOptions,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const assistantText = getResponseMessageContent(responseData);
            let calls = [];
            try {
                calls = extractAllFunctionCalls(responseData, allowedNames);
            } catch (error) {
                if (allowNoToolCalls && assistantText && isNoToolCallExtractionError(error)) {
                    if (includeAssistantText) {
                        return {
                            toolCalls: [],
                            assistantText,
                            rawAssistantText: assistantText,
                        };
                    }
                    return [];
                }
                throw error;
            }
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            if (includeAssistantText) {
                return {
                    toolCalls: calls,
                    assistantText,
                    rawAssistantText: assistantText,
                };
            }
            return calls;
        } catch (error) {
            const timedOut = attemptController.didTimeout();
            const sourceAborted = isAbortError(error, abortSignal);
            if (sourceAborted && !timedOut) {
                throw error;
            }
            const effectiveError = timedOut
                ? Object.assign(new Error(`Multi tool call request timed out after ${Math.floor(timeoutMs / 1000)}s.`), { name: 'TimeoutError' })
                : error;
            lastError = effectiveError;
            if (attempt >= retries) {
                throw effectiveError;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, effectiveError);
        } finally {
            attemptController.cleanup();
        }
    }
    throw lastError || new Error('Multi tool call request failed.');
}

function replaceAutoInjectedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(AUTO_INJECTED_PLACEHOLDER_REGEX, String(replacement || ''));
}

function replaceLegacyRemovedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(LEGACY_REMOVED_PLACEHOLDER_REGEX, String(replacement || ''));
}

function normalizeTemplateForRuntime(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

function normalizeTemplateForAiPrompt(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_AI_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

function sanitizeProfileForAiPrompt(profile = null) {
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

function normalizeApprovedReviewFeedbackEntry(entry = {}) {
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

function getRuntimeApprovedReviewFeedbackEntries(runtime = null) {
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

function upsertRuntimeApprovedReviewFeedbackEntry(runtime = null, entry = {}) {
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

function trimRuntimeApprovedReviewFeedbackEntries(runtime = null, keepBeforeStageIndex = 0) {
    if (!runtime || typeof runtime !== 'object' || !Array.isArray(runtime.approvedReviewFeedbackEntries)) {
        return;
    }
    const safeStageIndex = Math.max(0, Math.floor(Number(keepBeforeStageIndex) || 0));
    runtime.approvedReviewFeedbackEntries = runtime.approvedReviewFeedbackEntries
        .map(entry => normalizeApprovedReviewFeedbackEntry(entry))
        .filter(entry => entry && entry.stageIndex < safeStageIndex);
}

function buildReviewFeedbackPrelude({
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

function buildAutoInjectedNodePromptPrelude({
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

function renderTemplate(template, vars) {
    const safeVars = vars && typeof vars === 'object' ? vars : {};
    const replacements = {
        recent_chat: String(safeVars.recent_chat || ''),
        last_user: String(safeVars.last_user || ''),
        previous_outputs: String(safeVars.previous_outputs || ''),
        distiller: String(safeVars.distiller || ''),
        previous_snapshot: String(safeVars.previous_snapshot || ''),
        previous_orchestration: String(safeVars.previous_orchestration || ''),
    };
    let output = String(template || '');
    for (const [key, value] of Object.entries(replacements)) {
        output = output.replaceAll(`{{${key}}}`, value);
    }
    return output;
}

function toCompactJsonText(value, fallback = '{}') {
    try {
        return JSON.stringify(value);
    } catch {
        return fallback;
    }
}

function toReadableYamlText(value, fallback = '{}') {
    try {
        const normalized = value === undefined ? null : value;
        const text = yaml.stringify(normalized, { indent: 2, lineWidth: 0 });
        const trimmed = String(text || '').trim();
        return trimmed || fallback;
    } catch {
        return toCompactJsonText(value, fallback);
    }
}

function buildYamlMarkdownBlock(title, note, value) {
    const yamlText = toReadableYamlText(value);
    return [
        `## ${title}`,
        String(note || '').trim(),
        '```yaml',
        yamlText,
        '```',
    ].join('\n');
}

function buildAiSuggestInputXml({
    character = {},
    overrideGoal = '',
    runtimeContextGuarantees = {},
    injectionContract = {},
    agentApiRouting = {},
    agentPromptPresetRouting = {},
    mandatoryQualityAxes = {},
    qualityGateContract = {},
    recommendedBlueprint = {},
    antiPatterns = {},
    globalOrchestrationSpec = {},
    globalPresets = {},
    toolProtocol = {},
} = {}) {
    return [
        '# Orchestration Build Input',
        'Read all sections before calling tools. Keep edits practical and implementation-oriented.',
        buildYamlMarkdownBlock('character_profile', 'Current active character card snapshot.', character),
        buildYamlMarkdownBlock('override_goal', 'Optional user goal override for this character profile.', { override_goal: String(overrideGoal || '') }),
        buildYamlMarkdownBlock('runtime_context_guarantees', 'What runtime context is already guaranteed for both orchestration nodes and final generation.', runtimeContextGuarantees),
        buildYamlMarkdownBlock('injection_contract', 'How final orchestration outputs are injected to generation.', injectionContract),
        buildYamlMarkdownBlock('agent_api_routing', 'Optional per-agent API routing through Connection Manager profiles. Leave apiPresetName empty unless the user explicitly asks for per-agent model routing.', agentApiRouting),
        buildYamlMarkdownBlock('agent_prompt_preset_routing', 'Optional per-agent chat completion preset routing. Leave promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing.', agentPromptPresetRouting),
        buildYamlMarkdownBlock('mandatory_quality_axes', 'Quality axes that must be covered by stage/preset design.', mandatoryQualityAxes),
        buildYamlMarkdownBlock('quality_gate_contract', 'Hard quality gates the profile must explicitly enforce.', qualityGateContract),
        buildYamlMarkdownBlock('recommended_blueprint', 'Preferred orchestration blueprint when no special reason to deviate.', recommendedBlueprint),
        buildYamlMarkdownBlock('anti_patterns', 'Patterns to avoid when generating orchestration prompts.', antiPatterns),
        buildYamlMarkdownBlock('global_orchestration_spec', 'Current global orchestration spec as primary baseline. Reuse/adapt this structure before inventing new topology.', globalOrchestrationSpec),
        buildYamlMarkdownBlock('global_presets', 'Current global preset map as primary baseline. Preserve useful detail depth; do not collapse into short generic prompts.', globalPresets),
        buildYamlMarkdownBlock('prompt_richness_contract', 'Each node prompt must be concrete and non-trivial.', {
            system_prompt_contract: 'At least 3 concrete rule lines; avoid generic slogans.',
            user_template_contract: 'Must include Task block with multiple actionable bullets and clear output contract.',
            anti_lazy_rule: 'Thin one-liner prompts are invalid.',
        }),
        buildYamlMarkdownBlock('tool_protocol', 'Function-call protocol and expected argument shapes.', toolProtocol),
    ].join('\n');
}

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    for (const block of blocks) {
        appendUniqueWorldInfoBlock(payload, 'worldInfoAfter', block);
    }
    return payload;
}

async function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    historyMessages = null,
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Return concise guidance through function-call fields.';
    const userText = String(userPrompt || '').trim() || 'Use function-call fields only. Do not put JSON strings into summary.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    let resolvedRuntimeWorldInfo = includeWorldInfoWithPreset
        ? ((!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo))
            ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
            : null)
        : {};
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (includeWorldInfoWithPreset && !resolvedRuntimeWorldInfo && typeof context?.resolveWorldInfoForMessages === 'function' && resolverMessages.length > 0) {
        resolvedRuntimeWorldInfo = await context.resolveWorldInfoForMessages(resolverMessages, {
            type: String(worldInfoType || 'quiet'),
            fallbackToCurrentChat: false,
            postActivationHook: rewriteDepthWorldInfoToAfter,
        });
        throwIfAborted(abortSignal, 'Orchestration aborted.');
    }

    throwIfAborted(abortSignal, 'Orchestration aborted.');
    const normalizedHistoryMessages = Array.isArray(historyMessages)
        ? historyMessages.map(message => ({ ...message }))
        : [];
    return context.buildPresetAwarePromptMessages({
        messages: [
            ...normalizedHistoryMessages,
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard: true,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
        runtimeWorldInfo: resolvedRuntimeWorldInfo,
    });
}

function resolveOrchestrationAgentProfileResolution(context, settings, preset = null) {
    const profileName = getPresetApiPresetName(preset) || sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || '');
    return resolveChatCompletionRequestProfile({
        profileName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
}

function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBeforeEntries: normalizeWorldInfoEntries(source.worldInfoBeforeEntries),
        worldInfoAfterEntries: normalizeWorldInfoEntries(source.worldInfoAfterEntries),
        worldInfoDepth: Array.isArray(source.worldInfoDepth) ? source.worldInfoDepth : [],
        outletEntries: source.outletEntries && typeof source.outletEntries === 'object' ? source.outletEntries : {},
        worldInfoExamples: Array.isArray(source.worldInfoExamples) ? source.worldInfoExamples : [],
        anBefore: Array.isArray(source.anBefore) ? source.anBefore : [],
        anAfter: Array.isArray(source.anAfter) ? source.anAfter : [],
    };
}

function hasEffectiveRuntimeWorldInfo(runtimeWorldInfo = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (normalized.worldInfoBeforeEntries.length > 0 || normalized.worldInfoAfterEntries.length > 0) {
        return true;
    }
    if (normalized.worldInfoDepth.length > 0 || normalized.worldInfoExamples.length > 0) {
        return true;
    }
    if (normalized.anBefore.length > 0 || normalized.anAfter.length > 0) {
        return true;
    }
    return Object.keys(normalized.outletEntries).length > 0;
}

function buildRuntimeWorldInfoFromPayload(payload = null) {
    const candidate = normalizeRuntimeWorldInfo({
        worldInfoBeforeEntries: Array.isArray(payload?.worldInfoBeforeEntries) ? payload.worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(payload?.worldInfoAfterEntries) ? payload.worldInfoAfterEntries : [],
        worldInfoDepth: Array.isArray(payload?.worldInfoDepth) ? payload.worldInfoDepth : [],
        outletEntries: payload?.outletEntries && typeof payload.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    const rewritten = normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
        ...candidate,
        worldInfoDepth: Array.isArray(candidate.worldInfoDepth)
            ? candidate.worldInfoDepth.map(entry => ({
                ...entry,
                entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
            }))
            : [],
    }));
    return hasEffectiveRuntimeWorldInfo(rewritten) ? rewritten : null;
}

function getNodeIterationMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(1, Math.min(20, Math.floor(Number(source?.nodeIterationMaxRounds) || 0)));
}

function getReviewRerunMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(0, Math.min(20, Math.floor(Number(source?.reviewRerunMaxRounds) || 0)));
}

function isReviewNodeSpec(nodeSpec) {
    return normalizeNodeType(nodeSpec?.type) === ORCH_NODE_TYPE_REVIEW;
}

function getStageRuntimeMode(stage) {
    const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    return nodes.some(node => isReviewNodeSpec(normalizeNodeSpec(node))) ? 'serial' : mode;
}

function buildNodeToolSet(nodeSpec, { isFinalStage = false } = {}) {
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

function buildNodeIterationContractText(nodeSpec, { isFinalStage = false } = {}) {
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

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeAiIterationMessageId(prefix = 'orch_msg') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeToolResultContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === null || result === undefined) {
        return '';
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function createPersistentToolCallPayload(name, args = {}, id = '') {
    const toolName = String(name || '').trim();
    if (!toolName) {
        return null;
    }
    const safeArgs = args && typeof args === 'object' ? structuredClone(args) : {};
    return {
        id: String(id || '').trim() || makeRuntimeToolCallId(),
        type: 'function',
        function: {
            name: toolName,
            arguments: JSON.stringify(safeArgs),
        },
    };
}

function buildPersistentToolCallsFromRawCalls(rawCalls = []) {
    return (Array.isArray(rawCalls) ? rawCalls : [])
        .map((call) => createPersistentToolCallPayload(call?.name, call?.args, call?.id))
        .filter(Boolean);
}

function normalizePersistentToolCalls(message) {
    const output = [];
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        let args = {};
        if (call?.function?.arguments && typeof call.function.arguments === 'string') {
            try {
                const parsed = JSON.parse(call.function.arguments);
                args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                args = {};
            }
        } else if (call?.function?.arguments && typeof call.function.arguments === 'object') {
            args = call.function.arguments;
        }
        const payload = createPersistentToolCallPayload(call?.function?.name, args, call?.id);
        if (payload) {
            output.push(payload);
        }
    }
    return output;
}

function normalizePersistentToolResults(message, toolCalls = []) {
    const toolCallIds = new Set(toolCalls.map(call => String(call?.id || '').trim()).filter(Boolean));
    return (Array.isArray(message?.tool_results) ? message.tool_results : [])
        .map((item) => ({
            tool_call_id: String(item?.tool_call_id || '').trim(),
            content: String(item?.content ?? ''),
        }))
        .filter(item => item.tool_call_id && toolCallIds.has(item.tool_call_id));
}

function createPersistentToolTurnMessage({
    messageId = '',
    assistantText = '',
    toolCalls = [],
    toolResults = [],
    toolSummary = '',
    toolState = '',
    auto = false,
    at = Date.now(),
    extra = {},
} = {}) {
    const message = {
        id: String(messageId || '').trim() || makeAiIterationMessageId(),
        role: 'assistant',
        content: String(assistantText || '').trim(),
        auto: Boolean(auto),
        at: Number(at || Date.now()),
        ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const normalizedToolCalls = normalizePersistentToolCalls({ tool_calls: toolCalls });
    const normalizedToolResults = normalizePersistentToolResults({ tool_results: toolResults }, normalizedToolCalls);
    if (normalizedToolCalls.length > 0) {
        message.tool_calls = normalizedToolCalls;
    }
    if (normalizedToolResults.length > 0) {
        message.tool_results = normalizedToolResults;
    }
    if (toolSummary) {
        message.toolSummary = String(toolSummary);
    }
    if (toolState) {
        message.toolState = String(toolState);
    }
    return message;
}

function buildPersistentToolHistoryMessages(messages = []) {
    const history = [];
    for (const item of Array.isArray(messages) ? messages : []) {
        if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
            continue;
        }
        const toolCalls = normalizePersistentToolCalls(item);
        const toolResults = normalizePersistentToolResults(item, toolCalls);
        if (toolCalls.length === 0 || toolResults.length === 0) {
            continue;
        }
        history.push({
            role: 'assistant',
            content: String(item?.content || '').trim(),
            tool_calls: toolCalls,
        });
        for (const toolResult of toolResults) {
            history.push({
                role: 'tool',
                tool_call_id: toolResult.tool_call_id,
                content: toolResult.content,
            });
        }
    }
    return history;
}

function findAiIterationMessageById(messages, messageId) {
    const id = String(messageId || '').trim();
    if (!id || !Array.isArray(messages)) {
        return null;
    }
    return messages.find(item => String(item?.id || '').trim() === id) || null;
}

function buildToolCallSummary(toolCalls = []) {
    const names = (Array.isArray(toolCalls) ? toolCalls : [])
        .map(call => String(call?.function?.name || '').trim())
        .filter(Boolean);
    if (names.length === 0) {
        return '';
    }
    return `Tools: ${names.join(', ')}`;
}

function buildExecutionToolCalls(rawCalls = []) {
    return buildPersistentToolCallsFromRawCalls(rawCalls).map((call) => {
        let args = {};
        try {
            const parsed = JSON.parse(String(call?.function?.arguments || '{}'));
            args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            args = {};
        }
        return {
            id: String(call?.id || '').trim(),
            name: String(call?.function?.name || '').trim(),
            args,
        };
    }).filter(call => call.id && call.name);
}

function buildPendingToolResults(toolCalls = [], summaryText = '') {
    return buildPersistentToolCallsFromRawCalls(toolCalls).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: true,
            pending: true,
            summary: String(summaryText || 'Pending review.'),
        }),
    })).filter(item => item.tool_call_id);
}

function buildRejectedToolResults(toolCalls = [], summaryText = '') {
    return buildPersistentToolCallsFromRawCalls(toolCalls).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: false,
            rejected: true,
            summary: String(summaryText || 'Rejected by user.'),
        }),
    })).filter(item => item.tool_call_id);
}

function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        tool_calls: toolCalls.map(({ _result, ...toolCall }) => toolCall),
    });

    for (const toolCall of toolCalls) {
        targetMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResultContent(toolCall._result),
        });
    }
}

function buildPreviousOutputsMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## previous_node_outputs',
        'Outputs from completed worker nodes currently available to downstream execution.',
        '```yaml',
        toReadableYamlText(Object.fromEntries(previousNodeOutputs), '{}'),
        '```',
    ].join('\n');
}

function buildDistillerOutputMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## distiller_output',
        'Output from distiller node if available.',
        '```yaml',
        toReadableYamlText(previousNodeOutputs.get('distiller') || {}, '{}'),
        '```',
    ].join('\n');
}

function createStageOutputSnapshot(stage, stageWorkerOutputs = new Map()) {
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

function buildNodeOutputMapFromStageOutputs(stageOutputs = []) {
    const result = new Map();
    for (const stage of Array.isArray(stageOutputs) ? stageOutputs : []) {
        for (const node of Array.isArray(stage?.nodes) ? stage.nodes : []) {
            const nodeId = String(node?.node || '').trim();
            if (!nodeId) {
                continue;
            }
            result.set(nodeId, node?.output);
        }
    }
    return result;
}

function buildStageWorkerOutputMap(stageOutput = null) {
    const result = new Map();
    for (const node of Array.isArray(stageOutput?.nodes) ? stageOutput.nodes : []) {
        const nodeId = String(node?.node || '').trim();
        if (!nodeId) {
            continue;
        }
        result.set(nodeId, node?.output);
    }
    return result;
}

function mergeNodeOutputMaps(...maps) {
    const merged = new Map();
    for (const map of maps) {
        if (!(map instanceof Map)) {
            continue;
        }
        for (const [key, value] of map.entries()) {
            merged.set(key, value);
        }
    }
    return merged;
}

function collectPriorNodeEntries(stages, currentStageIndex, currentNodeIndex) {
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

function resolveReviewTargetEntries(stages, currentStageIndex, currentNodeIndex, targetNodeIds) {
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

function buildReviewRuntimeContextText({
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

function extractReviewDecision(toolCalls = [], nodeId = '') {
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

async function runWorkerNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal = null, options = {}) {
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
    const promptPresetName = llmPresetName;
    const llmProfileResolution = resolveOrchestrationAgentProfileResolution(context, settings, preset);
    const api = llmProfileResolution.requestApi || String(context.mainApi || 'openai');
    const apiSettingsOverride = llmProfileResolution.apiSettingsOverride;
    const tools = buildNodeToolSet(nodeSpec, { isFinalStage });
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const maxRounds = getNodeIterationMaxRounds(settings);
    const outputToolName = isFinalStage ? 'luker_orch_final_guidance' : 'luker_orch_node_output';
    const runtimeToolMessages = [];
    let lastRound = 0;

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

            const basePromptMessages = await buildPresetAwareMessages(
                context,
                settings,
                String(preset.systemPrompt || '').trim(),
                iterationPrompt,
                {
                    api,
                    promptPresetName,
                    historyMessages: runtimeToolMessages,
                    worldInfoMessages: messages,
                    worldInfoType: String(payload?.type || 'quiet'),
                    runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
                    forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
                    abortSignal,
                },
            );
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const promptMessages = basePromptMessages;

            const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
                tools,
                allowedNames,
                llmPresetName,
                apiSettingsOverride,
                abortSignal,
                includeAssistantText: true,
                allowNoToolCalls: false,
                applyAgentTimeout: true,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const calls = Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [];
            if (calls.length === 0) {
                throw new Error(`Node '${nodeSpec.id}' did not return tool calls.`);
            }

            let finalizedOutput = null;
            for (const call of calls) {
                const name = String(call?.name || '').trim();
                if (!name) {
                    continue;
                }
                if (name === outputToolName && finalizedOutput === null) {
                    finalizedOutput = call?.args && typeof call.args === 'object' ? call.args : {};
                    continue;
                }
            }

            if (finalizedOutput !== null) {
                if (isFinalStage) {
                    const finalText = String(finalizedOutput?.text ?? '');
                    if (!finalText.trim()) {
                        throw new Error(`Node '${nodeSpec.id}' returned empty final guidance text.`);
                    }
                    finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
                        status: 'completed',
                        output: finalText,
                    });
                    return finalText;
                }
                if (finalizedOutput && typeof finalizedOutput === 'object') {
                    finishOrchestrationRuntimeNodeAttempt(trace, traceAttempt, {
                        status: 'completed',
                        output: finalizedOutput,
                    });
                    return finalizedOutput;
                }
                throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
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
        });
        throw error;
    }
}

async function replayStagesToReview(context, payload, messages, profile, runtime, {
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
        restartStageIndex: Number(earliestStageIndex || 0),
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

async function runReviewNode(context, payload, profile, nodeSpec, preset, messages, previousNodeOutputs, currentStageWorkerOutputs, abortSignal = null, options = {}) {
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
    const promptPresetName = llmPresetName;
    const llmProfileResolution = resolveOrchestrationAgentProfileResolution(context, settings, preset);
    const api = llmProfileResolution.requestApi || String(context.mainApi || 'openai');
    const apiSettingsOverride = llmProfileResolution.apiSettingsOverride;
    const tools = buildNodeToolSet(nodeSpec);
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const runtimeToolMessages = [];
    let currentPreviousNodeOutputs = mergeNodeOutputMaps(previousNodeOutputs);
    let currentStageOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);

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

            const basePromptMessages = await buildPresetAwareMessages(
                context,
                settings,
                String(preset.systemPrompt || '').trim(),
                iterationPrompt,
                {
                    api,
                    promptPresetName,
                    historyMessages: runtimeToolMessages,
                    worldInfoMessages: messages,
                    worldInfoType: String(payload?.type || 'quiet'),
                    runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
                    forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
                    abortSignal,
                },
            );
            const promptMessages = basePromptMessages;
            const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
                tools,
                allowedNames,
                llmPresetName,
                apiSettingsOverride,
                abortSignal,
                includeAssistantText: true,
                allowNoToolCalls: false,
                applyAgentTimeout: true,
            });
            const decision = extractReviewDecision(detailed?.toolCalls || [], nodeSpec.id);
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
            });
            throw error;
        }
    }

    throw new Error(`Review node '${nodeSpec.id}' exceeded max rounds (${maxRounds}).`);
}

async function executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal = null, options = {}) {
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

const AGENDA_TODO_STATUSES = Object.freeze(['todo', 'doing', 'done', 'blocked', 'dropped']);

function normalizeAgendaTodoStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return AGENDA_TODO_STATUSES.includes(normalized) ? normalized : 'todo';
}

function createAgendaRunId() {
    return `agenda_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getAgendaPlannerMaxRounds(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.min(20, Math.floor(Number(source?.agendaPlannerMaxRounds) || 6)));
}

function getAgendaMaxConcurrentAgents(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.min(12, Math.floor(Number(source?.agendaMaxConcurrentAgents) || 3)));
}

function getAgendaMaxTotalRuns(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.min(200, Math.floor(Number(source?.agendaMaxTotalRuns) || 24)));
}

function createAgendaTodo({ id = '', goal = '', status = 'todo' } = {}) {
    const todoId = sanitizeIdentifierToken(id, '');
    const goalText = String(goal || '').trim();
    if (!todoId || !goalText) {
        return null;
    }
    return {
        id: todoId,
        goal: goalText,
        status: normalizeAgendaTodoStatus(status),
    };
}

function buildAgendaRecentChatText(messages, settings = extension_settings[MODULE_NAME]) {
    return getRecentMessages(messages, settings?.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
}

function buildAgendaLastUserText(messages) {
    const { message: lastUser } = extractLastUserMessage(messages);
    return String(lastUser?.mes || '');
}

function selectAgendaRuns(runs = [], selectedRunIds = null) {
    const selected = selectedRunIds instanceof Set ? selectedRunIds : null;
    return (Array.isArray(runs) ? runs : []).filter((run) => {
        if (!selected) {
            return true;
        }
        return selected.has(String(run?.runId || ''));
    });
}

function buildAgendaSelectedRunOutputsText(runs = [], selectedRunIds = null) {
    const source = selectAgendaRuns(runs, selectedRunIds);
    if (source.length === 0) {
        return '(none)';
    }
    return source.map((run) => [
        `[${String(run?.runId || '')}] ${String(run?.agent || '')} / ${String(run?.todoId || '')}`,
        String(run?.outputText || ''),
    ].join('\n')).join('\n\n');
}

function buildAgendaDistillerOutputText(runs = [], selectedRunIds = null) {
    const selectedSource = selectAgendaRuns(runs, selectedRunIds);
    const selectedDistiller = selectedSource.filter(run => String(run?.agent || '') === 'distiller' && String(run?.outputText || '').trim());
    if (selectedDistiller.length > 0) {
        return String(selectedDistiller[selectedDistiller.length - 1]?.outputText || '');
    }
    const allDistiller = (Array.isArray(runs) ? runs : []).filter(run => String(run?.agent || '') === 'distiller' && String(run?.outputText || '').trim());
    return allDistiller.length > 0 ? String(allDistiller[allDistiller.length - 1]?.outputText || '') : '(none)';
}

function buildAgendaAvailableAgentsText(profile = {}) {
    const agents = profile?.agents && typeof profile.agents === 'object' ? profile.agents : {};
    const catalog = Object.entries(agents)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([agentId, preset]) => ({
            agent: String(agentId || ''),
            system_prompt: String(preset?.systemPrompt || ''),
            user_prompt_template: String(preset?.userPromptTemplate || ''),
        }));
    return [
        '## available_agents',
        '```yaml',
        toReadableYamlText({
            final_agent_id: String(profile?.finalAgentId || ''),
            agents: catalog,
        }, '{}'),
        '```',
    ].join('\n');
}

function upsertAgendaTodo(state, nextTodo) {
    if (!state || !Array.isArray(state.todos) || !nextTodo) {
        return;
    }
    const index = state.todos.findIndex(todo => String(todo?.id || '') === String(nextTodo.id || ''));
    if (index >= 0) {
        state.todos[index] = {
            ...state.todos[index],
            ...nextTodo,
            status: normalizeAgendaTodoStatus(nextTodo.status || state.todos[index]?.status),
        };
        return;
    }
    state.todos.push({
        id: String(nextTodo.id || ''),
        goal: String(nextTodo.goal || ''),
        status: normalizeAgendaTodoStatus(nextTodo.status),
    });
}

function buildAgendaSharedContextText(context, payload, messages) {
    const settings = extension_settings[MODULE_NAME];
    const recent = buildAgendaRecentChatText(messages, settings);
    const lastUserText = buildAgendaLastUserText(messages);
    return [
        '## shared_context',
        '### recent_chat',
        '```text',
        recent || '(empty)',
        '```',
        '### current_user_message',
        '```text',
        lastUserText,
        '```',
        '### runtime_limits',
        '```yaml',
        toReadableYamlText({
            planner_max_rounds: getAgendaPlannerMaxRounds(settings),
            max_concurrent_agents: getAgendaMaxConcurrentAgents(settings),
            max_total_runs: getAgendaMaxTotalRuns(settings),
            node_iteration_max_rounds: getNodeIterationMaxRounds(settings),
            review_rerun_max_rounds: getReviewRerunMaxRounds(settings),
            agent_timeout_seconds: Math.max(0, Math.floor(Number(settings?.agentTimeoutSeconds) || 0)),
        }, '{}'),
        '```',
    ].join('\n');
}

function buildAgendaTodosText(todos = []) {
    return [
        '## todo_board',
        '```yaml',
        toReadableYamlText(
            (Array.isArray(todos) ? todos : []).map(todo => ({
                id: String(todo?.id || ''),
                goal: String(todo?.goal || ''),
                status: normalizeAgendaTodoStatus(todo?.status),
            })),
            '[]',
        ),
        '```',
    ].join('\n');
}

function buildAgendaRunsText(runs = [], selectedRunIds = null) {
    const source = selectAgendaRuns(runs, selectedRunIds);
    if (source.length === 0) {
        return [
            '## prior_runs',
            '```text',
            '(none)',
            '```',
        ].join('\n');
    }
    return [
        '## prior_runs',
        ...source.map((run) => [
            `### ${String(run?.runId || '')}`,
            '```yaml',
            toReadableYamlText({
                todo_id: String(run?.todoId || ''),
                agent: String(run?.agent || ''),
                task_brief: String(run?.taskBrief || ''),
                input_run_ids: Array.isArray(run?.inputRunIds) ? run.inputRunIds.map(item => String(item || '')) : [],
            }, '{}'),
            '```',
            '```text',
            String(run?.outputText || ''),
            '```',
        ].join('\n')),
    ].join('\n\n');
}

function syncAgendaTrace(trace, state) {
    if (!trace || typeof trace !== 'object' || !state || typeof state !== 'object') {
        return;
    }
    trace.mode = ORCH_EXECUTION_MODE_AGENDA;
    trace.agenda = {
        plannerRounds: Math.max(0, Math.floor(Number(state.plannerRounds) || 0)),
        todos: Array.isArray(state.todos) ? structuredClone(state.todos) : [],
        runs: Array.isArray(state.runs) ? structuredClone(state.runs) : [],
        finalGuidance: String(state.finalGuidance || ''),
    };
}

function applyAgendaPlannerOps(state, plannerStep = {}) {
    if (!state || typeof state !== 'object') {
        return;
    }
    for (const rawOp of Array.isArray(plannerStep?.todo_ops) ? plannerStep.todo_ops : []) {
        const op = String(rawOp?.op || '').trim().toLowerCase();
        const todoId = sanitizeIdentifierToken(rawOp?.todo_id, '');
        if (!todoId) {
            continue;
        }
        if (op === 'add') {
            const nextTodo = createAgendaTodo({
                id: todoId,
                goal: String(rawOp?.goal || ''),
                status: rawOp?.status || 'todo',
            });
            if (nextTodo) {
                upsertAgendaTodo(state, nextTodo);
            }
            continue;
        }
        const index = state.todos.findIndex(todo => String(todo?.id || '') === todoId);
        if (index < 0) {
            continue;
        }
        if (op === 'set_status') {
            state.todos[index].status = normalizeAgendaTodoStatus(rawOp?.status);
        } else if (op === 'drop') {
            state.todos[index].status = 'dropped';
        }
    }
}

function normalizeAgendaDispatches(state, plannerStep = {}, profile = {}, settings = extension_settings[MODULE_NAME]) {
    const dispatches = [];
    const agents = profile?.agents && typeof profile.agents === 'object' ? profile.agents : {};
    const knownRunIds = new Set((Array.isArray(state?.runs) ? state.runs : []).map(run => String(run?.runId || '')).filter(Boolean));
    for (const rawDispatch of Array.isArray(plannerStep?.dispatches) ? plannerStep.dispatches : []) {
        const todoId = sanitizeIdentifierToken(rawDispatch?.todo_id, '');
        const agent = sanitizeIdentifierToken(rawDispatch?.agent, '');
        const taskBrief = String(rawDispatch?.task_brief || '').trim();
        if (!todoId || !agent || !taskBrief || !agents[agent]) {
            continue;
        }
        const inputRunIds = [...new Set(
            (Array.isArray(rawDispatch?.input_run_ids) ? rawDispatch.input_run_ids : [])
                .map(item => String(item || '').trim())
                .filter(runId => runId && knownRunIds.has(runId)),
        )];
        if (!state.todos.some(todo => String(todo?.id || '') === todoId)) {
            upsertAgendaTodo(state, createAgendaTodo({ id: todoId, goal: taskBrief, status: 'todo' }));
        }
        dispatches.push({
            todoId,
            agent,
            taskBrief,
            inputRunIds,
        });
    }
    const maxConcurrent = getAgendaMaxConcurrentAgents(settings);
    const remainingRunBudget = Math.max(0, getAgendaMaxTotalRuns(settings) - Number(state?.runs?.length || 0));
    return dispatches.slice(0, Math.min(maxConcurrent, remainingRunBudget));
}

async function runAgendaPlannerStep(context, payload, messages, profile, state, abortSignal = null) {
    const settings = extension_settings[MODULE_NAME];
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const planner = createAgendaPlannerDraft(profile?.planner);
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, planner);
    const llmProfileResolution = resolveOrchestrationAgentProfileResolution(context, settings, planner);
    const promptText = [
        '## planner_prompt',
        String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT),
        '',
        buildAutoInjectedNodePromptPrelude({
            previousOrchestration,
            approvedReviewFeedbackEntries: [],
        }),
        buildAgendaSharedContextText(context, payload, messages),
        buildAgendaAvailableAgentsText(profile),
        buildAgendaTodosText(state?.todos),
        buildAgendaRunsText(state?.runs),
        [
            '## planner_contract',
            '- Maintain the todo board explicitly through todo_ops.',
            '- Dispatch only agent ids listed in available_agents.',
            '- Dispatch only the next useful agent calls. Parallelize only truly independent work.',
            '- Read complete prior run outputs before adding new work.',
            '- Normal planner steps should include dispatches. todo_ops is optional.',
            '- Only the final planner step should include finalize.',
            '- finalize must be a concise reason/summary string.',
            '- Do not include dispatches in the same step that includes finalize.',
        ].join('\n'),
    ].filter(Boolean).join('\n\n');
    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        String(planner?.systemPrompt || DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT),
        promptText,
        {
            api: llmProfileResolution.requestApi,
            promptPresetName: llmPresetName,
            worldInfoMessages: messages,
            worldInfoType: String(payload?.type || 'quiet'),
            runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
            forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
            abortSignal,
        },
    );
    return requestToolCallWithRetry(settings, promptMessages, {
        functionName: AGENDA_PLANNER_TOOL,
        functionDescription: 'Update agenda todos and dispatch the next agent calls. Use finalize only once on the last planner step, with a concise reason/summary.',
        parameters: {
            type: 'object',
            anyOf: [
                { required: ['dispatches'] },
                { required: ['finalize'] },
            ],
            properties: {
                todo_ops: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            op: { type: 'string', enum: ['add', 'set_status', 'drop'] },
                            todo_id: { type: 'string' },
                            goal: { type: 'string' },
                            status: { type: 'string', enum: AGENDA_TODO_STATUSES },
                        },
                        required: ['op', 'todo_id'],
                        additionalProperties: false,
                    },
                },
                dispatches: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            todo_id: { type: 'string' },
                            agent: { type: 'string' },
                            task_brief: { type: 'string' },
                            input_run_ids: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                        },
                        required: ['todo_id', 'agent', 'task_brief', 'input_run_ids'],
                        additionalProperties: false,
                    },
                },
                finalize: {
                    type: 'string',
                    minLength: 1,
                    description: 'Use only on the final planner step. Provide a concise reason/summary and do not include dispatches.',
                },
            },
            additionalProperties: false,
        },
        llmPresetName,
        apiSettingsOverride: llmProfileResolution.apiSettingsOverride,
        abortSignal,
        applyAgentTimeout: true,
    });
}

async function runAgendaTextAgent(context, payload, messages, profile, state, dispatch, {
    kind = 'agent',
    finalReason = '',
}, abortSignal = null) {
    const settings = extension_settings[MODULE_NAME];
    const planner = createAgendaPlannerDraft(profile?.planner);
    const preset = profile?.agents?.[dispatch.agent] || {};
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset);
    const llmProfileResolution = resolveOrchestrationAgentProfileResolution(context, settings, preset);
    const systemPrompt = [
        String(preset.systemPrompt || 'You are an orchestration agent. Complete the assigned task carefully and return the full useful result through the required tool.').trim(),
        '',
        'Agenda runtime override:',
        '- Ignore any legacy spec-mode output schema wording if present.',
        `- The only valid output is ${AGENDA_RESULT_TOOL} with one complete text result.`,
    ].filter(Boolean).join('\n');
    const selectedRunIds = new Set((Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds : []).map(item => String(item || '').trim()).filter(Boolean));
    const currentTodo = (Array.isArray(state?.todos) ? state.todos : []).find(todo => String(todo?.id || '') === String(dispatch?.todoId || '')) || null;
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const renderedAgentPrompt = renderTemplate(
        normalizeTemplateForRuntime(String(preset?.userPromptTemplate || '')),
        {
            recent_chat: buildAgendaRecentChatText(messages, settings),
            last_user: buildAgendaLastUserText(messages),
            previous_outputs: buildAgendaSelectedRunOutputsText(state?.runs, selectedRunIds),
            distiller: buildAgendaDistillerOutputText(state?.runs, selectedRunIds),
        },
    ).trim();
    const promptText = [
        '## planner_prompt',
        String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT),
        '',
        buildAutoInjectedNodePromptPrelude({
            previousOrchestration,
            approvedReviewFeedbackEntries: [],
        }),
        '## current_todo',
        '```yaml',
        toReadableYamlText(currentTodo || {
            id: String(dispatch?.todoId || ''),
            goal: String(dispatch?.taskBrief || ''),
            status: 'doing',
        }, '{}'),
        '```',
        '## task_brief',
        '```text',
        String(dispatch?.taskBrief || ''),
        '```',
        finalReason ? ['## finalize_reason', '```text', String(finalReason || ''), '```'].join('\n') : '',
        buildAgendaSharedContextText(context, payload, messages),
        buildAgendaRunsText(state?.runs, selectedRunIds),
        [
            '## agenda_mode_output_override',
            '- If copied prompt text mentions legacy spec-mode fields or schemas, ignore that wording.',
            `- The only valid output is ${AGENDA_RESULT_TOOL} with one complete text result.`,
        ].join('\n'),
        renderedAgentPrompt
            ? ['## agent_extra_prompt', '```text', renderedAgentPrompt, '```'].join('\n')
            : '',
        [
            '## result_contract',
            `- Return the full result through ${AGENDA_RESULT_TOOL}.`,
            '- The text should contain complete useful content, not a summary placeholder.',
        ].join('\n'),
    ].filter(Boolean).join('\n\n');
    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        systemPrompt,
        promptText,
        {
            api: llmProfileResolution.requestApi,
            promptPresetName: llmPresetName,
            worldInfoMessages: messages,
            worldInfoType: String(payload?.type || 'quiet'),
            runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
            forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
            abortSignal,
        },
    );
    const result = await requestToolCallWithRetry(settings, promptMessages, {
        functionName: AGENDA_RESULT_TOOL,
        functionDescription: 'Submit the full textual result for the assigned orchestration task.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        llmPresetName,
        apiSettingsOverride: llmProfileResolution.apiSettingsOverride,
        abortSignal,
        applyAgentTimeout: true,
    });
    return {
        runId: createAgendaRunId(),
        todoId: String(dispatch?.todoId || ''),
        agent: String(dispatch?.agent || ''),
        taskBrief: String(dispatch?.taskBrief || ''),
        inputRunIds: Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds.slice() : [],
        outputText: String(result?.text || '').trim(),
        kind: String(kind || 'agent'),
    };
}

async function runAgendaOrchestration(context, payload, messages, profile) {
    const settings = extension_settings[MODULE_NAME];
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    const trace = createOrchestrationRuntimeTrace(context, payload, [], {
        note: 'Agenda mode runtime',
    });
    const state = {
        plannerRounds: 0,
        todos: [{
            id: 'main',
            goal: 'Produce the best next-turn orchestration guidance for the current request.',
            status: 'todo',
        }],
        runs: [],
        finalGuidance: '',
    };
    syncAgendaTrace(trace, state);
    const plannerMaxRounds = Math.min(getAgendaPlannerMaxRounds(settings), Math.max(1, Math.floor(Number(profile?.limits?.plannerMaxRounds) || getAgendaPlannerMaxRounds(settings))));
    let finalizeReason = '';

    for (let round = 1; round <= plannerMaxRounds; round++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        state.plannerRounds = round;
        syncAgendaTrace(trace, state);
        const plannerAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
            stageIndex: round - 1,
            stageId: `agenda_planner_round_${round}`,
            nodeIndex: 0,
            nodeId: 'agenda_planner',
            preset: 'agenda_planner',
            nodeType: ORCH_NODE_TYPE_WORKER,
            runKind: 'planner',
            slotKey: buildOrchestrationRuntimeSlotKey(round - 1, 0, `agenda_planner_${round}`),
        });
        const plannerStep = await runAgendaPlannerStep(context, payload, messages, profile, state, abortSignal);
        finishOrchestrationRuntimeNodeAttempt(trace, plannerAttempt, {
            status: 'completed',
            output: plannerStep,
        });
        applyAgendaPlannerOps(state, plannerStep);
        const dispatches = normalizeAgendaDispatches(state, plannerStep, profile, settings);
        const finalizeReasonText = String(plannerStep?.finalize || '').trim();
        const finalizeRequested = Boolean(finalizeReasonText);
        if (Array.isArray(plannerStep?.dispatches) && plannerStep.dispatches.length > 0 && dispatches.length === 0 && !finalizeRequested) {
            throw new Error('Agenda planner dispatched no valid agents. Check available agent ids and selected prior run ids.');
        }
        if (finalizeRequested && dispatches.length > 0) {
            throw new Error('Agenda planner cannot dispatch agents and finalize in the same step.');
        }
        for (const dispatch of dispatches) {
            const todo = state.todos.find(item => String(item?.id || '') === String(dispatch.todoId || ''));
            if (todo) {
                todo.status = todo.status === 'done' ? 'done' : 'doing';
            }
        }
        syncAgendaTrace(trace, state);
        if (finalizeRequested) {
            finalizeReason = finalizeReasonText;
            break;
        }
        if (dispatches.length === 0) {
            finalizeReason = finalizeReasonText || 'Planner produced no further dispatches.';
            break;
        }
        const newRuns = await Promise.all(dispatches.map(async (dispatch, dispatchIndex) => {
            const attempt = beginOrchestrationRuntimeNodeAttempt(trace, {
                stageIndex: round - 1,
                stageId: `agenda_agents_round_${round}`,
                nodeIndex: dispatchIndex,
                nodeId: `${dispatch.agent}:${dispatch.todoId}`,
                preset: dispatch.agent,
                nodeType: ORCH_NODE_TYPE_WORKER,
                runKind: 'worker',
                slotKey: buildOrchestrationRuntimeSlotKey(round - 1, dispatchIndex + 1, `${dispatch.agent}_${dispatch.todoId}_${round}`),
            });
            try {
                const result = await runAgendaTextAgent(context, payload, messages, profile, state, dispatch, { kind: 'agent' }, abortSignal);
                finishOrchestrationRuntimeNodeAttempt(trace, attempt, {
                    status: 'completed',
                    output: result.outputText,
                });
                return result;
            } catch (error) {
                finishOrchestrationRuntimeNodeAttempt(trace, attempt, {
                    status: 'failed',
                    error: String(error?.message || error),
                });
                throw error;
            }
        }));
        state.runs.push(...newRuns);
        syncAgendaTrace(trace, state);
        if (state.runs.length >= getAgendaMaxTotalRuns(settings)) {
            finalizeReason = 'Reached maxTotalRuns limit. Finalizing with collected work.';
            break;
        }
    }

    const finalAgentId = sanitizeIdentifierToken(profile?.finalAgentId, Object.keys(profile?.agents || {})[0] || 'finalizer');
    if (!profile?.agents?.[finalAgentId]) {
        throw new Error(`Agenda final agent '${finalAgentId}' is not configured.`);
    }
    const finalDispatch = {
        todoId: 'finalize',
        agent: finalAgentId,
        taskBrief: 'Read the resolved todo state and all completed runs, then produce the final orchestration guidance text.',
        inputRunIds: state.runs.map(run => String(run?.runId || '')).filter(Boolean),
    };
    const finalAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
        stageIndex: plannerMaxRounds,
        stageId: 'agenda_finalize',
        nodeIndex: 0,
        nodeId: finalAgentId,
        preset: finalAgentId,
        nodeType: ORCH_NODE_TYPE_WORKER,
        runKind: 'final',
        slotKey: buildOrchestrationRuntimeSlotKey(plannerMaxRounds, 0, `agenda_final_${finalAgentId}`),
    });
    const finalRun = await runAgendaTextAgent(context, payload, messages, profile, state, finalDispatch, {
        kind: 'final',
        finalReason: finalizeReason,
    }, abortSignal);
    if (!String(finalRun?.outputText || '').trim()) {
        finishOrchestrationRuntimeNodeAttempt(trace, finalAttempt, {
            status: 'failed',
            error: 'Agenda final agent returned empty guidance text.',
        });
        throw new Error('Agenda final agent returned empty guidance text.');
    }
    finishOrchestrationRuntimeNodeAttempt(trace, finalAttempt, {
        status: 'completed',
        output: finalRun.outputText,
    });
    state.finalGuidance = String(finalRun.outputText || '').trim();
    state.runs.push(finalRun);
    syncAgendaTrace(trace, state);

    return {
        stageOutputs: [{
            id: 'finalize',
            mode: 'serial',
            nodes: [{
                node: finalAgentId,
                output: state.finalGuidance,
            }],
        }],
        previousNodeOutputs: new Map([[finalAgentId, state.finalGuidance]]),
        runtimeTrace: trace,
        reviewRerunCount: 0,
        agendaState: structuredClone(state),
    };
}

async function runOrchestration(context, payload, messages, profile) {
    if (String(profile?.mode || '') === ORCH_EXECUTION_MODE_AGENDA || String(profile?.source || '') === 'agenda') {
        return runAgendaOrchestration(context, payload, messages, profile);
    }
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const runtime = {
        stages,
        stageOutputs: [],
        reviewRerunCount: 0,
        approvedReviewFeedbackEntries: [],
        trace: createOrchestrationRuntimeTrace(context, payload, stages),
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

function compactStageOutputs(stageOutputs) {
    return stageOutputs.map(stage => ({
        id: stage.id,
        mode: stage.mode,
        nodes: stage.nodes.map(node => ({
            node: node.node,
            output: node.output,
        })),
    }));
}

function normalizeNodeOutputForSnapshot(output) {
    if (typeof output === 'string') {
        return output;
    }
    if (output && typeof output === 'object') {
        return structuredClone(output);
    }
    return output;
}

function getFinalStageSnapshot(stageOutputs) {
    const compact = compactStageOutputs(stageOutputs);
    if (!Array.isArray(compact) || compact.length === 0) {
        return null;
    }
    const last = compact[compact.length - 1];
    if (!last || !Array.isArray(last.nodes)) {
        return null;
    }
    return {
        id: String(last.id || `stage_${compact.length}`),
        mode: String(last.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
        nodes: last.nodes
            .map(node => ({
                node: String(node?.node || ''),
                output: normalizeNodeOutputForSnapshot(node?.output),
            }))
            .filter(node => node.node),
    };
}

function extractNodeInjectionText(nodeOutput) {
    if (typeof nodeOutput === 'string') {
        const text = String(nodeOutput);
        return text.trim() ? text : '';
    }
    return '';
}

function buildCapsule(stageOutputs) {
    const finalStage = getFinalStageSnapshot(stageOutputs);
    const settings = extension_settings[MODULE_NAME];
    const customInstruction = String(settings?.capsuleCustomInstruction || '').trim();
    const finalTexts = Array.isArray(finalStage?.nodes)
        ? finalStage.nodes
            .map(node => extractNodeInjectionText(node?.output))
            .filter(Boolean)
        : [];
    const body = finalTexts.length <= 1
        ? (finalTexts[0] || '')
        : finalTexts.join('\n\n');
    if (!body) {
        return '';
    }
    if (!customInstruction) {
        return body;
    }
    return `${customInstruction}\n\n${body}`;
}

function reapplyLatestCapsuleInjection(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return;
    }
    const rebuiltText = buildCapsule(Array.isArray(latestOrchestrationSnapshot.stageOutputs) ? latestOrchestrationSnapshot.stageOutputs : []);
    const nextText = String(rebuiltText || latestOrchestrationSnapshot.capsuleText || '').trim();
    latestOrchestrationSnapshot = {
        ...latestOrchestrationSnapshot,
        capsuleText: nextText,
    };
    clearCapsulePrompt(context);
    void persistStoredOrchestrationSnapshot(context, latestOrchestrationSnapshot.anchorPlayableFloor, latestOrchestrationSnapshot);
}

async function onWorldInfoFinalized(payload) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];

    if (!settings.enabled) {
        return;
    }
    if (!shouldRunOrchestrationForPayload(payload)) {
        return;
    }
    if (orchInFlight) {
        return;
    }
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        await loadOrchestratorChatState(context, { force: false });
        clearCapsulePrompt(context);
        await selectLatestValidOrchestrationSnapshot(context, { persistCleanup: true });
        await emitOrchestratorResultEvent(context, payload, 'cancelled', {
            reason: 'generation_aborted_before_orchestration',
            note: 'Generation was aborted before orchestration started.',
            includeSnapshot: false,
        });
        updateUiStatus(i18n('Generation aborted. Skipped orchestration.'));
        return;
    }
    orchInFlight = true;
    const pluginAbortController = new AbortController();
    activeOrchRunAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const orchestrationPayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? {
            ...payload,
            signal: linkedAbort.signal,
            __lukerOrchGenerationSignal: payload?.signal || null,
        }
        : payload;
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = new Promise((resolve) => {
        resolveStopRequest = () => {
            if (stopRequestedByUser) {
                return;
            }
            stopRequestedByUser = true;
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
            resolve({ stopped: true });
        };
    });

    try {
        await loadOrchestratorChatState(context, { force: false });
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(getCoreMessages(payload));
        if (messages.length === 0) {
            clearLatestOrchestrationRuntimeTrace(context);
            clearCapsulePrompt(context);
            await selectLatestValidOrchestrationSnapshot(context, { persistCleanup: true });
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: 'empty_messages',
                note: 'Skipped orchestration because there are no playable messages.',
                includeSnapshot: false,
            });
            return;
        }
        const chatKey = getChatKey(context);
        const anchor = buildLastUserAnchor(context, messages);
        if (canReuseLatestOrchestrationSnapshot(chatKey, anchor)) {
            const capsuleText = String(latestOrchestrationSnapshot.capsuleText || '').trim();
            if (capsuleText) {
                const reuseTraceStages = String(profile?.mode || '') === ORCH_EXECUTION_MODE_AGENDA
                    ? []
                    : (sanitizeSpec(profile.spec)?.stages || []);
                const reuseTrace = createOrchestrationRuntimeTrace(context, payload, reuseTraceStages, {
                    status: 'reused',
                    note: i18n('Reused previous orchestration snapshot. No nodes executed.'),
                    capsuleText,
                });
                finalizeOrchestrationRuntimeTrace(reuseTrace, 'reused', {
                    capsuleText,
                    note: i18n('Reused previous orchestration snapshot. No nodes executed.'),
                });
                injectCapsuleToPayload(payload, capsuleText, settings);
                throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
                await emitOrchestratorResultEvent(context, payload, 'reused', {
                    includeSnapshot: true,
                    note: 'Reused previous orchestration snapshot.',
                });
                updateUiStatus(i18n('Orchestrator completed.'));
                clearRunInfoToast();
                return;
            }
        }
        updateUiStatus(i18n('Orchestrator running...'));
        showRunInfoToast(i18n('Orchestrator running...'), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                resolveStopRequest?.();
            },
        });

        const orchestrationTask = runOrchestration(context, orchestrationPayload, messages, profile);
        void orchestrationTask.catch((error) => {
            if (!stopRequestedByUser) {
                return;
            }
            if (!isAbortError(error, orchestrationPayload?.signal)) {
                console.warn(`[${MODULE_NAME}] Orchestration finished after user stop`, error);
            }
        });
        const raced = await Promise.race([
            orchestrationTask.then(finalRun => ({ stopped: false, finalRun })),
            stopRequestPromise,
        ]);
        if (raced?.stopped) {
            finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'cancelled', {
                note: i18n('Orchestration cancelled by user before completion.'),
            });
            clearCapsulePrompt(context);
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: 'user_stopped',
                note: 'Orchestration cancelled by user before completion.',
                includeSnapshot: false,
            });
            updateUiStatus(i18n('Orchestrator cancelled by user.'));
            return;
        }
        const finalRun = raced?.finalRun;
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');

        const capsuleText = buildCapsule(finalRun.stageOutputs || []);
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        injectCapsuleToPayload(payload, capsuleText, settings);
        await storeCompletedOrchestrationSnapshot(context, anchor, capsuleText, finalRun.stageOutputs || []);
        finalizeOrchestrationRuntimeTrace(finalRun?.runtimeTrace || getLatestOrchestrationRuntimeTrace(context), 'completed', {
            capsuleText,
            reviewRerunCount: Number(finalRun?.reviewRerunCount || 0),
        });
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        await emitOrchestratorResultEvent(context, payload, 'completed', {
            includeSnapshot: true,
            reviewRerunCount: Number(finalRun?.reviewRerunCount || 0),
        });
        updateUiStatus(i18n('Orchestrator completed.'));
        clearRunInfoToast();
    } catch (error) {
        if (isAbortError(error, orchestrationPayload?.signal)) {
            finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'cancelled', {
                note: Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted)
                    ? i18n('Generation aborted before orchestration completed.')
                    : i18n('Orchestration cancelled by user.'),
            });
            clearCapsulePrompt(context);
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped orchestration.')
                : i18n('Orchestrator cancelled by user.'));
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: generationAborted ? 'generation_aborted' : 'orchestration_cancelled',
                note: generationAborted
                    ? 'Generation aborted before orchestration completed.'
                    : 'Orchestration cancelled by user.',
                includeSnapshot: false,
            });
            clearRunInfoToast();
            return;
        }
        finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'failed', {
            error: String(error?.message || error),
        });
        clearCapsulePrompt(context);
        console.warn(`[${MODULE_NAME}] Orchestration failed`, error);
        const failText = i18nFormat('Orchestrator failed: ${0}', String(error?.message || error));
        updateUiStatus(failText);
        clearRunInfoToast();
        await emitOrchestratorResultEvent(context, payload, 'failed', {
            reason: 'runtime_error',
            error: String(error?.message || error),
            includeSnapshot: false,
        });
        notifyError(failText);
    } finally {
        linkedAbort.cleanup();
        if (activeOrchRunAbortController === pluginAbortController) {
            activeOrchRunAbortController = null;
        }
        clearRunInfoToast();
        orchInFlight = false;
    }
}

async function onMessageDeleted(_chatLength, details) {
    const context = getContext();
    await loadOrchestratorChatState(context, { force: false });
    const deletedPlayableFrom = normalizeAnchorPlayableFloor(details?.deletedPlayableSeqFrom);
    const deletedPlayableTo = normalizeAnchorPlayableFloor(details?.deletedPlayableSeqTo);
    const deletedAssistantFrom = Math.max(0, Math.floor(Number(details?.deletedAssistantSeqFrom) || 0));
    const deletedAssistantTo = Math.max(0, Math.floor(Number(details?.deletedAssistantSeqTo) || 0));
    const deletedPlayableCount = deletedPlayableFrom > 0 && deletedPlayableTo >= deletedPlayableFrom
        ? (deletedPlayableTo - deletedPlayableFrom + 1)
        : 0;
    const deletedAssistantCount = deletedAssistantFrom > 0 && deletedAssistantTo >= deletedAssistantFrom
        ? (deletedAssistantTo - deletedAssistantFrom + 1)
        : 0;
    const deletedUserCount = Math.max(deletedPlayableCount - deletedAssistantCount, 0);

    if (!deletedPlayableCount && !deletedAssistantCount) {
        await invalidateStoredOrchestrationAnchors(context, 0, { inclusive: true });
        return;
    }
    if (deletedUserCount > 0 && deletedPlayableFrom > 0) {
        await invalidateStoredOrchestrationAnchors(context, deletedPlayableFrom, { inclusive: true });
        return;
    }
    if (deletedPlayableTo > 0) {
        const changed = await invalidateStoredOrchestrationAnchors(context, deletedPlayableTo, { inclusive: false });
        if (!changed) {
            clearCapsulePrompt(context);
            ensureUi();
        }
        return;
    }

    clearCapsulePrompt(context);
    ensureUi();
}

async function onMessageEdited(messageId, mutationMeta = null) {
    const context = getContext();
    await loadOrchestratorChatState(context, { force: false });
    const sourceMessages = Array.isArray(context?.chat) ? context.chat : [];
    const resolvedMessageId = Math.floor(Number(messageId));
    const meta = mutationMeta && typeof mutationMeta === 'object'
        ? mutationMeta
        : null;
    const message = Number.isInteger(resolvedMessageId) && resolvedMessageId >= 0 && resolvedMessageId < sourceMessages.length
        ? sourceMessages[resolvedMessageId]
        : null;
    const playableSeq = normalizeAnchorPlayableFloor(meta?.playableSeq ?? (
        message && !message.is_system
            ? sourceMessages.slice(0, resolvedMessageId + 1).reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0)
            : 0
    ));
    const isUser = meta ? Boolean(meta.isUser) : Boolean(message?.is_user);
    const isAssistant = meta ? Boolean(meta.isAssistant) : Boolean(message && !message.is_system && !message.is_user);
    const isSystem = meta ? Boolean(meta.isSystem) : Boolean(message?.is_system);

    if (isSystem || !playableSeq) {
        await invalidateStoredOrchestrationAnchors(context, 0, { inclusive: true });
        return;
    }

    const changed = await invalidateStoredOrchestrationAnchors(context, playableSeq, { inclusive: isUser || !isAssistant });
    if (!changed) {
        clearCapsulePrompt(context);
        ensureUi();
    }
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function getCharacterDisplayName(context) {
    return getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context)) || i18n('(No character selected)');
}

function getCharacterDisplayNameByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return '';
    }
    const character = (context.characters || []).find(item => String(item?.avatar || '') === target);
    return String(character?.name || '').trim() || target;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function getOpenAIPresetNames(context) {
    const manager = context?.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function renderOpenAIPresetOptions(context, selectedName = '', emptyLabel = i18n('(Current preset)')) {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current preset)')))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}

function sanitizeConnectionProfileName(value = '') {
    return String(value || '').trim();
}

function getPresetApiPresetName(preset = null) {
    return sanitizeConnectionProfileName(
        preset?.apiPresetName
        ?? preset?.apiPreset
        ?? preset?.agentApiPresetName
        ?? '',
    );
}

function sanitizePromptPresetName(value = '') {
    return String(value || '').trim();
}

function getPresetPromptPresetName(preset = null) {
    return sanitizePromptPresetName(
        preset?.promptPresetName
        ?? preset?.llmPresetName
        ?? preset?.chatCompletionPresetName
        ?? preset?.openAIPresetName
        ?? preset?.agentPromptPresetName
        ?? '',
    );
}

function sanitizeConnectionProfilesForAiPrompt(profiles = getConnectionProfiles()) {
    return (Array.isArray(profiles) ? profiles : [])
        .map((profile) => {
            const name = sanitizeConnectionProfileName(profile?.name);
            if (!name) {
                return null;
            }
            return {
                name,
                api: String(profile?.api || '').trim(),
                model: String(profile?.model || '').trim(),
            };
        })
        .filter(Boolean);
}

function sanitizeOpenAIPresetNamesForAiPrompt(context) {
    return getOpenAIPresetNames(context);
}

function buildAgentApiRoutingPromptData(settings = extension_settings[MODULE_NAME]) {
    return {
        global_orchestration_api_preset: sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || ''),
        empty_value_behavior: 'Empty apiPresetName falls back to the global orchestration API preset. If that is also empty, runtime uses the current chat API configuration.',
        default_policy: 'Do not set planner/agent apiPresetName unless the user explicitly asks for a specific provider/model route for that planner or agent.',
        available_connection_profiles: sanitizeConnectionProfilesForAiPrompt(getConnectionProfiles()),
    };
}

function buildAgentPromptPresetRoutingPromptData(context, settings = extension_settings[MODULE_NAME]) {
    return {
        global_orchestration_prompt_preset: sanitizePromptPresetName(settings?.llmNodePresetName || ''),
        empty_value_behavior: 'Empty promptPresetName falls back to the global orchestration chat completion preset. If that is also empty, runtime uses the current chat completion preset configuration.',
        default_policy: 'Do not set planner/agent promptPresetName unless the user explicitly asks for a specific chat completion preset route for that planner or agent.',
        available_chat_completion_presets: sanitizeOpenAIPresetNamesForAiPrompt(context),
    };
}

function resolveOrchestrationAgentPromptPresetName(settings, preset = null) {
    return getPresetPromptPresetName(preset) || sanitizePromptPresetName(settings?.llmNodePresetName || '');
}

function renderConnectionProfileOptions(selectedName = '', emptyLabel = i18n('(Current API config)')) {
    const selected = sanitizeConnectionProfileName(selectedName);
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current API config)')))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function refreshOpenAIPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#luker_orch_llm_api_preset', settings.llmNodeApiPresetName],
        ['#luker_orch_llm_preset', settings.llmNodePresetName],
        ['#luker_orch_ai_suggest_api_preset', settings.aiSuggestApiPresetName],
        ['#luker_orch_ai_suggest_preset', settings.aiSuggestPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

function sanitizeIdentifierToken(value, fallback = '') {
    const normalized = String(value || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-]/g, '_');
    return normalized || String(fallback || '');
}

function createPresetDraft(seed = {}) {
    return {
        systemPrompt: String(seed.systemPrompt || '').trim(),
        userPromptTemplate: String(seed.userPromptTemplate || '').trim(),
        apiPresetName: getPresetApiPresetName(seed),
        promptPresetName: getPresetPromptPresetName(seed),
    };
}

function createAgendaPlannerDraft(seed = {}) {
    const source = typeof seed === 'string'
        ? { userPromptTemplate: seed }
        : (seed && typeof seed === 'object' ? seed : {});
    return createPresetDraft({
        ...defaultAgendaPlanner,
        ...source,
        systemPrompt: String(source.systemPrompt || defaultAgendaPlanner.systemPrompt).trim(),
        userPromptTemplate: String(source.userPromptTemplate || defaultAgendaPlanner.userPromptTemplate).trim(),
    });
}

function toEditablePresetMap(presets) {
    const normalized = {};
    const source = sanitizePresetMap(presets);
    for (const [key, value] of Object.entries(source)) {
        normalized[key] = createPresetDraft(value);
    }
    return normalized;
}

function toEditableSpec(spec, presets) {
    const sanitized = sanitizeSpec(spec);
    const presetIds = Object.keys(presets);
    const defaultPreset = presetIds[0] || 'distiller';
    if (!presets[defaultPreset]) {
        presets[defaultPreset] = createPresetDraft();
    }

    const stages = (Array.isArray(sanitized.stages) ? sanitized.stages : [])
        .map((stage, stageIndex) => {
            const stageId = sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const normalizedNodes = nodes.map((node, nodeIndex) => {
                const normalizedNode = normalizeNodeSpec(node);
                const preset = sanitizeIdentifierToken(normalizedNode.preset || normalizedNode.id, defaultPreset);
                if (!presets[preset]) {
                    presets[preset] = createPresetDraft();
                }
                return {
                    id: sanitizeIdentifierToken(normalizedNode.id || preset, `node_${nodeIndex + 1}`),
                    preset,
                    type: normalizeNodeType(normalizedNode.type),
                    userPromptTemplate: String(normalizedNode.userPromptTemplate || ''),
                };
            });
            return {
                id: stageId,
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: normalizedNodes.length > 0
                    ? normalizedNodes
                    : [{
                        id: defaultPreset,
                        preset: defaultPreset,
                        type: ORCH_NODE_TYPE_WORKER,
                        userPromptTemplate: '',
                    }],
            };
        })
        .filter(stage => stage.nodes.length > 0);

    if (stages.length > 0) {
        return { stages };
    }

    return {
        stages: [{
            id: 'distill',
            mode: 'serial',
            nodes: [{
                id: defaultPreset,
                preset: defaultPreset,
                type: ORCH_NODE_TYPE_WORKER,
                userPromptTemplate: '',
            }],
        }],
    };
}

function serializeEditorSpec(editorSpec) {
    const stages = Array.isArray(editorSpec?.stages) ? editorSpec.stages : [];
    return sanitizeSpec({
        stages: stages
            .map((stage, stageIndex) => ({
                id: sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`),
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: (Array.isArray(stage?.nodes) ? stage.nodes : [])
                    .map((node, nodeIndex) => {
                        const id = sanitizeIdentifierToken(node?.id, `node_${nodeIndex + 1}`);
                        const preset = sanitizeIdentifierToken(node?.preset, id);
                        const userPromptTemplate = String(node?.userPromptTemplate || '').trim();

                        const serialized = { id, preset, type: normalizeNodeType(node?.type) };
                        if (userPromptTemplate) {
                            serialized.userPromptTemplate = userPromptTemplate;
                        }
                        return serialized;
                    })
                    .filter(Boolean),
            }))
            .filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0),
    });
}

function serializeEditorPresetMap(editorPresets) {
    return sanitizePresetMap(editorPresets || {});
}

function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return null;
    }
    return (context.characters || []).find(char => String(char?.avatar || '') === target) || null;
}

function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return -1;
    }
    return (context.characters || []).findIndex(char => String(char?.avatar || '') === target);
}



function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

function getCharacterOverrideByAvatar(context, avatar) {
    const payload = getCharacterExtensionDataByAvatar(context, avatar);
    const override = payload?.override;
    return override && typeof override === 'object' ? override : null;
}

function getCharacterAgendaOverrideByAvatar(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    const agenda = override?.agenda;
    return agenda && typeof agenda === 'object' ? agenda : null;
}

function hasSpecOverrideData(override) {
    return Boolean(override && (
        (override.spec && typeof override.spec === 'object')
        || (override.presets && typeof override.presets === 'object')
        || (override.presetPatch && typeof override.presetPatch === 'object')
    ));
}

function hasAgendaOverrideData(override) {
    return Boolean(override?.agenda && typeof override.agenda === 'object');
}

function getCharacterOverrideExecutionMode(override) {
    if (!override || typeof override !== 'object') {
        return '';
    }
    const explicitMode = normalizeExecutionMode(override.mode);
    const hasSpec = hasSpecOverrideData(override);
    const hasAgenda = hasAgendaOverrideData(override);
    if (explicitMode === ORCH_EXECUTION_MODE_SPEC && hasSpec) {
        return explicitMode;
    }
    if (explicitMode === ORCH_EXECUTION_MODE_AGENDA && hasAgenda) {
        return explicitMode;
    }
    if (hasSpec && !hasAgenda) {
        return ORCH_EXECUTION_MODE_SPEC;
    }
    if (hasAgenda && !hasSpec) {
        return ORCH_EXECUTION_MODE_AGENDA;
    }
    if (hasSpec && hasAgenda) {
        const specUpdatedAt = Math.max(0, Number(override.updatedAt) || 0);
        const agendaUpdatedAt = Math.max(0, Number(override.agenda?.updatedAt) || 0);
        if (agendaUpdatedAt > specUpdatedAt) {
            return ORCH_EXECUTION_MODE_AGENDA;
        }
        if (specUpdatedAt > agendaUpdatedAt) {
            return ORCH_EXECUTION_MODE_SPEC;
        }
    }
    return '';
}

function normalizeCharacterOverrideMode(override) {
    if (!override || typeof override !== 'object') {
        return override;
    }
    const mode = getCharacterOverrideExecutionMode(override);
    if (mode) {
        override.mode = mode;
    } else {
        delete override.mode;
    }
    return override;
}

function getCharacterSavedExecutionModeByAvatar(context, avatar) {
    return getCharacterOverrideExecutionMode(getCharacterOverrideByAvatar(context, avatar));
}

function applyCharacterExecutionModeForAvatar(context, settings, avatar) {
    const preferredMode = getCharacterSavedExecutionModeByAvatar(context, avatar);
    if (!preferredMode || preferredMode === getExecutionMode(settings)) {
        return false;
    }
    settings.executionMode = preferredMode;
    settings.singleAgentModeEnabled = preferredMode === ORCH_EXECUTION_MODE_SINGLE;
    saveSettingsDebounced();
    return true;
}

function hasCharacterSpecOverride(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    return hasSpecOverrideData(override);
}

function hasCharacterAgendaOverride(context, avatar) {
    return hasAgendaOverrideData(getCharacterOverrideByAvatar(context, avatar));
}

function resolveOverridePresetMap(override, basePresets = {}) {
    if (override?.presets && typeof override.presets === 'object') {
        return sanitizePresetMap(override.presets);
    }
    // Legacy compatibility: older overrides stored only presetPatch.
    if (override?.presetPatch && typeof override.presetPatch === 'object') {
        return mergePresetMaps(basePresets, override.presetPatch);
    }
    return {};
}

function getCharacterCardSnapshot(context, avatar) {
    const character = getCharacterByAvatar(context, avatar) || {};
    const fromCardFields = (avatar && avatar === getCurrentAvatar(context) && typeof context.getCharacterCardFields === 'function')
        ? (context.getCharacterCardFields() || {})
        : {};

    const readField = (field) => {
        const value = character?.[field]
            ?? character?.data?.[field]
            ?? fromCardFields?.[field];
        return String(value || '').trim();
    };

    return {
        avatar: String(avatar || ''),
        name: String(character?.name || fromCardFields?.name || '').trim(),
        description: readField('description'),
        personality: readField('personality'),
        scenario: readField('scenario'),
        system: readField('system'),
        first_mes: readField('first_mes'),
        mes_example: readField('mes_example'),
        creator_notes: readField('creator_notes'),
    };
}

function ensureEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    if (!editor.presets || typeof editor.presets !== 'object' || Object.keys(editor.presets).length === 0) {
        editor.presets = {};
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
    editor.presets = toEditablePresetMap(editor.presets);
}

function ensureAgendaEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeAgendaWorkingProfile(editor);
    editor.planner = normalized.planner;
    editor.agents = normalized.agents;
    editor.finalAgentId = normalized.finalAgentId;
    editor.limits = normalized.limits;
    if ('avatar' in editor) {
        editor.avatar = String(editor.avatar || '');
    }
    if ('enabled' in editor) {
        editor.enabled = Boolean(editor.enabled);
    }
    if ('notes' in editor) {
        editor.notes = String(editor.notes || '');
    }
}

function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        const presetId = 'distiller';
        editor.presets = {
            [presetId]: createPresetDraft(),
        };
        return presetId;
    }
    return keys[0];
}

function createNewStage(editor) {
    const defaultPreset = pickDefaultPreset(editor);
    const index = (editor.spec?.stages?.length || 0) + 1;
    return {
        id: `stage_${index}`,
        mode: 'serial',
        nodes: [{
            id: defaultPreset,
            preset: defaultPreset,
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: '',
        }],
    };
}

function loadGlobalEditorState() {
    const settings = getSettings();
    const presets = toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(settings.orchestrationSpec, presets);
    return { spec, presets };
}

function loadCharacterEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const override = getCharacterOverrideByAvatar(context, safeAvatar);
    const useOverride = hasCharacterSpecOverride(context, safeAvatar);
    const presets = useOverride
        ? toEditablePresetMap(resolveOverridePresetMap(override, settings.presets))
        : toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(useOverride ? override?.spec : settings.orchestrationSpec, presets);
    return {
        avatar: safeAvatar,
        enabled: useOverride ? Boolean(override?.enabled) : false,
        notes: useOverride ? String(override?.notes || '') : '',
        spec,
        presets,
    };
}

function loadGlobalAgendaEditorState() {
    return cloneAgendaWorkingProfileFromSettings(getSettings());
}

function loadCharacterAgendaEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const agendaOverride = getCharacterAgendaOverrideByAvatar(context, safeAvatar);
    const profile = agendaOverride
        ? sanitizeAgendaWorkingProfile(agendaOverride)
        : cloneAgendaWorkingProfileFromSettings(settings);
    return {
        avatar: safeAvatar,
        enabled: Boolean(agendaOverride?.enabled),
        notes: String(agendaOverride?.notes || ''),
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: profile.limits,
    };
}

function initializeUiState(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar !== uiState.selectedAvatar) {
        applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    }
    uiState.selectedAvatar = activeAvatar;
    uiState.globalEditor = loadGlobalEditorState();
    uiState.characterEditor = loadCharacterEditorState(context, uiState.selectedAvatar);
    uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, uiState.selectedAvatar);
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

function syncCharacterEditorWithActiveAvatar(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar === uiState.selectedAvatar) {
        return;
    }
    applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    uiState.selectedAvatar = activeAvatar;
    uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

function hasCharacterOverride(context, avatar) {
    return hasCharacterSpecOverride(context, avatar);
}

function getScopePreferenceStateKey(mode = ORCH_EXECUTION_MODE_SPEC) {
    return normalizeExecutionMode(mode) === ORCH_EXECUTION_MODE_AGENDA
        ? 'agendaDisplayedScope'
        : 'specDisplayedScope';
}

function getStoredDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (normalizeExecutionMode(mode) === ORCH_EXECUTION_MODE_AGENDA) {
        return hasCharacterAgendaOverride(context, activeAvatar) ? 'character' : 'global';
    }
    return hasCharacterSpecOverride(context, activeAvatar) ? 'character' : 'global';
}

function setDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC, scope = '') {
    const key = getScopePreferenceStateKey(mode);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (scope === 'character' && activeAvatar) {
        uiState[key] = 'character';
        return uiState[key];
    }
    if (scope === 'global') {
        uiState[key] = 'global';
        return uiState[key];
    }
    uiState[key] = getStoredDisplayedScopeForMode(context, settings, mode);
    return uiState[key];
}

function syncDisplayedScopesFromStoredState(context, settings) {
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA);
}

function getDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const key = getScopePreferenceStateKey(mode);
    const preferredScope = String(uiState[key] || '');
    const storedScope = getStoredDisplayedScopeForMode(context, settings, mode);
    if (storedScope === 'character') {
        return 'character';
    }
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (preferredScope === 'character' && activeAvatar) {
        return 'character';
    }
    return 'global';
}

function getDisplayedScope(context, settings) {
    return getDisplayedScopeForMode(context, settings, getExecutionMode(settings));
}

function getEditorByScope(scope) {
    return scope === 'character' ? uiState.characterEditor : uiState.globalEditor;
}

function getAgendaEditorByScope(scope) {
    return scope === 'character' ? uiState.characterAgendaEditor : uiState.globalAgendaEditor;
}

function getScopeFromElementOrMode(element, context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const scope = String(
        jQuery(element).data('scope')
        || jQuery(element).closest('[data-luker-scope-root]').data('luker-scope-root')
        || getDisplayedScopeForMode(context, settings, mode),
    );
    return scope === 'character' ? 'character' : 'global';
}

function getAgendaScopeFromElement(element, context, settings) {
    return getScopeFromElementOrMode(element, context, settings, ORCH_EXECUTION_MODE_AGENDA);
}

function getExplicitScopeFromElement(element) {
    const scope = String(
        jQuery(element).data('scope')
        || jQuery(element).closest('[data-luker-scope-root]').data('luker-scope-root')
        || '',
    );
    return scope === 'character' ? 'character' : (scope === 'global' ? 'global' : '');
}

function getCopyScopeFromElement(element, context) {
    const explicitScope = getExplicitScopeFromElement(element);
    if (explicitScope) {
        return explicitScope;
    }
    return String(getCurrentAvatar(context) || '').trim() ? 'character' : 'global';
}

function getDisplayedScopeLabel(isCharacterScope, hasPersistedOverride, isEnabled) {
    if (!isCharacterScope) {
        return i18n('Global profile (no character override for current card)');
    }
    if (!hasPersistedOverride) {
        return i18n('Character draft (not saved yet)');
    }
    return isEnabled
        ? i18n('Character override (enabled)')
        : i18n('Character override (configured, currently disabled)');
}

function getPopupEditingLabel(isCharacterScope, hasPersistedOverride, isEnabled) {
    if (!isCharacterScope) {
        return i18n('Global profile');
    }
    if (!hasPersistedOverride) {
        return i18n('Character draft (not saved yet)');
    }
    return isEnabled
        ? i18n('Current character override')
        : i18n('Character override (configured, currently disabled)');
}

function getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasPersistedOverride) {
    if (!isCharacterScope) {
        return i18n('Global Orchestration Profile');
    }
    const displayName = getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar;
    return hasPersistedOverride
        ? i18nFormat('Character Override: ${0}', displayName)
        : i18nFormat('Character Draft: ${0}', displayName);
}

function buildBestEffortSpecFromAgendaAgents(agents, finalAgentId) {
    const normalizedAgents = sanitizePresetMap(agents);
    const agentIds = Object.keys(normalizedAgents);
    const fallbackFinalAgentId = agentIds[0] || 'finalizer';
    const resolvedFinalAgentId = normalizedAgents[finalAgentId]
        ? String(finalAgentId)
        : fallbackFinalAgentId;
    const nonFinalAgentIds = agentIds.filter(id => id !== resolvedFinalAgentId);
    const distillerId = nonFinalAgentIds.find(id => {
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId === 'distiller' || normalizedId.includes('distill');
    }) || null;
    const reviewAgentIds = nonFinalAgentIds.filter(id => {
        if (id === distillerId) {
            return false;
        }
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId === 'critic'
            || normalizedId.includes('critic')
            || normalizedId.includes('review')
            || normalizedId.includes('audit');
    });
    const remainingWorkerIds = nonFinalAgentIds.filter(id => id !== distillerId && !reviewAgentIds.includes(id));
    const groundingAgentIds = remainingWorkerIds.filter(id => {
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId.includes('lore')
            || normalizedId.includes('ground')
            || normalizedId.includes('constraint')
            || normalizedId.includes('recall')
            || normalizedId.includes('memory');
    });
    const reasoningAgentIds = remainingWorkerIds.filter(id => {
        if (groundingAgentIds.includes(id)) {
            return false;
        }
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId.includes('plan')
            || normalizedId.includes('scene')
            || normalizedId.includes('progress')
            || normalizedId.includes('writer')
            || normalizedId.includes('draft');
    });
    const supportAgentIds = remainingWorkerIds.filter(id => !groundingAgentIds.includes(id) && !reasoningAgentIds.includes(id));
    const stages = [];

    if (distillerId) {
        stages.push({
            id: 'distill',
            mode: 'serial',
            nodes: [distillerId],
        });
    }

    if (groundingAgentIds.length > 0) {
        stages.push({
            id: 'grounding',
            mode: groundingAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: groundingAgentIds,
        });
    }

    if (reasoningAgentIds.length > 0) {
        stages.push({
            id: 'reason',
            mode: reasoningAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: reasoningAgentIds,
        });
    }

    if (supportAgentIds.length > 0) {
        stages.push({
            id: 'workers',
            mode: supportAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: supportAgentIds,
        });
    }

    if (reviewAgentIds.length > 0) {
        stages.push({
            id: 'review',
            mode: reviewAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: reviewAgentIds.map(id => ({
                id,
                preset: id,
                type: ORCH_NODE_TYPE_REVIEW,
            })),
        });
    }

    stages.push({
        id: 'finalize',
        mode: 'serial',
        nodes: [resolvedFinalAgentId],
    });

    return sanitizeSpec({ stages });
}

function copySpecPresetsIntoAgendaEditor(sourceEditor, agendaEditor) {
    ensureEditorIntegrity(sourceEditor);
    ensureAgendaEditorIntegrity(agendaEditor);
    agendaEditor.agents = sanitizePresetMap(sourceEditor.presets);
    if (agendaEditor.agents.synthesizer) {
        agendaEditor.agents.finalizer = structuredClone(agendaEditor.agents.synthesizer);
        delete agendaEditor.agents.synthesizer;
    }
    if (Object.keys(agendaEditor.agents).length === 0) {
        agendaEditor.agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
    }
    agendaEditor.finalAgentId = agendaEditor.agents.finalizer
        ? 'finalizer'
        : (Object.keys(agendaEditor.agents)[0] || 'finalizer');
}

function copyAgendaAgentsIntoSpecEditor(agendaEditor, specEditor) {
    ensureAgendaEditorIntegrity(agendaEditor);
    ensureEditorIntegrity(specEditor);
    const copiedPresets = sanitizePresetMap(agendaEditor.agents);
    const fallbackFinalAgentId = Object.keys(copiedPresets)[0] || 'finalizer';
    const finalAgentId = copiedPresets[agendaEditor.finalAgentId]
        ? sanitizeIdentifierToken(agendaEditor.finalAgentId, fallbackFinalAgentId)
        : fallbackFinalAgentId;
    specEditor.presets = copiedPresets;
    specEditor.spec = buildBestEffortSpecFromAgendaAgents(copiedPresets, finalAgentId);
    ensureEditorIntegrity(specEditor);
}

function renderPresetOptions(presets, selectedPreset) {
    const selected = String(selectedPreset || '');
    const ids = Object.keys(presets || {});
    const options = [];

    if (selected && !presets[selected]) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }

    for (const presetId of ids) {
        options.push(`<option value="${escapeHtml(presetId)}"${presetId === selected ? ' selected' : ''}>${escapeHtml(presetId)}</option>`);
    }

    return options.join('');
}

function renderWorkflowBoard(scope, editor) {
    const stages = Array.isArray(editor?.spec?.stages) ? editor.spec.stages : [];
    if (stages.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No stages yet. Add one stage to start orchestration.'))}</div>`;
    }

    const stageBlocks = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const isParallel = stage.mode === 'parallel';
        const modeClass = isParallel ? 'parallel' : 'serial';
        const modeIcon = isParallel ? 'fa-solid fa-arrows-split-up-and-left' : 'fa-solid fa-arrow-down-long';
        const modeLabel = isParallel ? i18n('Parallel') : i18n('Serial');
        const nodeType = (type) => normalizeNodeType(type) === ORCH_NODE_TYPE_REVIEW ? 'review' : 'worker';
        const nodeIcon = (type) => normalizeNodeType(type) === ORCH_NODE_TYPE_REVIEW ? 'fa-solid fa-magnifying-glass' : 'fa-solid fa-gear';

        const nodeCards = nodes.map((node, nodeIndex) => `
<details class="luker-studio-pipeline-node">
    <summary>
        <span class="luker-studio-pipeline-node-summary">
            <i class="luker-studio-pipeline-node-icon ${nodeIcon(node.type)}" aria-hidden="true"></i>
            <span class="luker-studio-pipeline-node-name">${escapeHtml(node.id || i18nFormat('Node ${0}', nodeIndex + 1))}</span>
            <span class="luker-studio-pipeline-node-type">${escapeHtml(nodeType(node.type))}</span>
        </span>
        <span class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="node-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Up'))}"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="node-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Down'))}"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="node-delete" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash" aria-hidden="true"></i></div>
        </span>
        <i class="luker-studio-pipeline-node-chevron fa-solid fa-chevron-right" aria-hidden="true"></i>
    </summary>
    <div class="luker-studio-pipeline-node-body">
        <label>${escapeHtml(i18n('Node ID'))}</label>
        <input class="text_pole" data-luker-field="node-id" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" value="${escapeHtml(node.id)}" />
        <label>${escapeHtml(i18n('Preset'))}</label>
        <select class="text_pole" data-luker-field="node-preset" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
            ${renderPresetOptions(editor.presets, node.preset)}
        </select>
        <label>${escapeHtml(i18n('Node Type'))}</label>
        <select class="text_pole" data-luker-field="node-type" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
            <option value="${ORCH_NODE_TYPE_WORKER}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_WORKER ? ' selected' : ''}>${escapeHtml(i18n('Worker'))}</option>
            <option value="${ORCH_NODE_TYPE_REVIEW}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_REVIEW ? ' selected' : ''}>${escapeHtml(i18n('Review'))}</option>
        </select>
        <label>${escapeHtml(i18n('Node Prompt Template (optional)'))}</label>
        <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="${escapeHtml(i18n('Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result and approved review feedback are auto-injected.'))}">${escapeHtml(node.userPromptTemplate)}</textarea>
    </div>
</details>`).join('');

        return `
<div class="luker-studio-pipeline-stage" data-mode="${modeClass}">
    <div class="luker-studio-pipeline-stage-head">
        <div class="luker-studio-pipeline-stage-id">
            <input class="text_pole" data-luker-field="stage-id" data-scope="${scope}" data-stage-index="${stageIndex}" value="${escapeHtml(stage.id)}" />
        </div>
        <span class="luker-studio-pipeline-mode-pill ${modeClass}">
            <i class="${modeIcon}" aria-hidden="true"></i>
            ${escapeHtml(modeLabel)}
        </span>
        <select class="text_pole" data-luker-field="stage-mode" data-scope="${scope}" data-stage-index="${stageIndex}" style="max-width:110px">
            <option value="serial"${stage.mode === 'serial' ? ' selected' : ''}>${escapeHtml(i18n('Serial'))}</option>
            <option value="parallel"${stage.mode === 'parallel' ? ' selected' : ''}>${escapeHtml(i18n('Parallel'))}</option>
        </select>
        <span class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="stage-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Up'))}"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="stage-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Down'))}"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="stage-delete" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash" aria-hidden="true"></i></div>
        </span>
    </div>
    <div class="luker-studio-pipeline-nodes">${nodeCards || `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No nodes. Add one to define this stage.'))}</div>`}</div>
    <div class="luker-studio-pipeline-stage-footer">
        <div class="menu_button menu_button_small" data-luker-action="node-add" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Add Node'))}</div>
    </div>
</div>`;
    });

    const connectorHtml = `
<div class="luker-studio-pipeline-connector">
    <div class="luker-studio-pipeline-connector-arrow"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></div>
</div>`;

    return `<div class="luker-studio-pipeline">${stageBlocks.join(connectorHtml)}</div>`;
}

function renderPresetBoard(scope, editor) {
    const entries = Object.entries(editor?.presets || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No presets yet.'))}</div>`;
    }

    return entries.map(([presetId, preset]) => `
<div class="luker-studio-card">
    <div class="luker-studio-card-header">
        <b>${escapeHtml(presetId)}</b>
        <div class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="preset-delete" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Agent API preset (Connection profile, empty = global orchestration API preset)'))}</label>
    <select class="text_pole" data-luker-field="preset-api-preset" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">
        ${renderConnectionProfileOptions(preset?.apiPresetName, i18n('(Global orchestration API preset)'))}
    </select>
    <label>${escapeHtml(i18n('Agent preset (params + prompt, empty = global orchestration preset)'))}</label>
    <select class="text_pole" data-luker-field="preset-prompt-preset" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">
        ${renderOpenAIPresetOptions(getContext(), preset?.promptPresetName, i18n('(Global orchestration prompt preset)'))}
    </select>
    <label>${escapeHtml(i18n('System Prompt'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="preset-system-prompt" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>${escapeHtml(i18n('User Prompt Template'))}</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-field="preset-user-template" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
</div>`).join('');
}

function getOrchestratorUiTemplateDeps() {
    return {
        DEFAULT_AGENDA_PLANNER_PROMPT,
        DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_SINGLE,
        ORCH_EXECUTION_MODE_SPEC,
        UI_BLOCK_ID,
        createAgendaPlannerDraft,
        ensureAgendaEditorIntegrity,
        escapeHtml,
        extension_prompt_roles,
        getAgendaEditorByScope,
        getCharacterAgendaOverrideByAvatar,
        getCharacterDisplayNameByAvatar,
        getCharacterOverrideByAvatar,
        getContext,
        getCurrentAvatar,
        getDisplayedScope,
        getEditorByScope,
        getExecutionMode,
        getPopupEditingLabel,
        getProfileTitleForScope,
        hasCharacterAgendaOverride,
        hasCharacterSpecOverride,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
        renderPresetBoard,
        renderWorkflowBoard,
        sanitizeIdentifierToken,
        sanitizePresetMap,
        syncCharacterEditorWithActiveAvatar,
        uiState,
        world_info_position,
    };
}

function buildLatestOrchestrationStateSummary(context) {
    const entry = getLatestOrchestrationEntry(context);
    const anchorCount = getLoadedOrchestrationHistoryAnchors(context).length;
    if (entry?.anchorPlayableFloor) {
        return i18nFormat('Last run state: user turn ${0} · stored anchors ${1}', entry.anchorPlayableFloor, anchorCount);
    }
    if (anchorCount > 0) {
        return i18nFormat('Last run state: none · stored anchors ${0}', anchorCount);
    }
    return i18n('Last run state: none');
}

function renderDynamicPanels(root, context) {
    const settings = getSettings();
    const executionMode = getExecutionMode(settings);
    const singleModeEnabled = executionMode === ORCH_EXECUTION_MODE_SINGLE;
    const agendaModeEnabled = executionMode === ORCH_EXECUTION_MODE_AGENDA;
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
    const agendaOverride = activeAvatar ? getCharacterAgendaOverrideByAvatar(context, activeAvatar) : null;
    const specScope = getDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC);
    const agendaScope = getDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA);
    const isSpecCharacterScope = specScope === 'character';
    const isAgendaCharacterScope = agendaScope === 'character';
    const hasSpecCharacterOverride = hasCharacterSpecOverride(context, activeAvatar);
    const hasAgendaCharacterOverride = hasCharacterAgendaOverride(context, activeAvatar);
    const isOverrideEnabled = Boolean(override?.enabled);
    const isAgendaOverrideEnabled = Boolean(agendaOverride?.enabled);
    root.find('#luker_orch_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : i18n('(No character card)'),
    );
    root.find('#luker_orch_profile_mode').text(
        getDisplayedScopeLabel(isSpecCharacterScope, hasSpecCharacterOverride, isOverrideEnabled),
    );
    root.find('#luker_orch_agenda_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : i18n('(No character card)'),
    );
    root.find('#luker_orch_agenda_profile_mode').text(
        getDisplayedScopeLabel(isAgendaCharacterScope, hasAgendaCharacterOverride, isAgendaOverrideEnabled),
    );
    const hasLastRun = Boolean(getLatestOrchestrationEntry(context));
    root.find('[data-luker-action="view-last-run"]').toggleClass('luker_orch_button_disabled', !hasLastRun);
    root.find('#luker_orch_last_run_state').text(buildLatestOrchestrationStateSummary(context));
    root.find('[data-luker-ai-goal-input]').val(String(uiState.aiGoal || ''));
    root.find('#luker_orch_spec_board').toggle(!singleModeEnabled && !agendaModeEnabled);
    root.find('#luker_orch_agenda_board').toggle(agendaModeEnabled);
    root.find('#luker_orch_single_mode_runtime_tools').toggle(singleModeEnabled);
    root.find('#luker_orch_single_mode_hint').toggle(singleModeEnabled);
    root.find('#luker_orch_single_agent_fields').toggle(singleModeEnabled);
    root.find('#luker_orch_execution_mode').val(executionMode);
    refreshOrchestrationEditorPopup(context, settings);
}

function refreshOrchestrationEditorPopup(context, settings) {
    const contentId = String(uiState.orchEditorPopupContentId || '');
    if (!contentId) {
        return;
    }
    const mount = jQuery(`#${contentId}`);
    if (!mount.length) {
        uiState.orchEditorPopupContentId = '';
        return;
    }
    mount.html(buildOrchestrationEditorPopupPanelHtml(getOrchestratorUiTemplateDeps(), context, settings));
}

async function openOrchestrationEditorPopup(context, settings) {
    ensureStyles();
    const contentId = `luker_orch_editor_popup_mount_${Date.now()}`;
    uiState.orchEditorPopupContentId = contentId;
    const popupHtml = `<div id="${contentId}"></div>`;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Orchestrator'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );
    refreshOrchestrationEditorPopup(context, settings);
    await popupPromise;
    if (uiState.orchEditorPopupContentId === contentId) {
        uiState.orchEditorPopupContentId = '';
    }
}

function updateUiStatus(text) {
    jQuery('#luker_orch_status').text(String(text || ''));
}

function showRunInfoToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeRunInfoToast) {
        toastr.clear(activeRunInfoToast);
        activeRunInfoToast = null;
    }
    activeRunInfoToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeRunInfoToast && typeof onStop === 'function') {
        const toastBody = activeRunInfoToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearRunInfoToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearRunInfoToast() {
    if (typeof toastr === 'undefined' || !activeRunInfoToast) {
        return;
    }
    toastr.clear(activeRunInfoToast);
    activeRunInfoToast = null;
}

function showAiBuildToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeAiBuildToast) {
        toastr.clear(activeAiBuildToast);
        activeAiBuildToast = null;
    }
    activeAiBuildToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeAiBuildToast && typeof onStop === 'function') {
        const toastBody = activeAiBuildToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearAiBuildToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearAiBuildToast() {
    if (typeof toastr === 'undefined' || !activeAiBuildToast) {
        return;
    }
    toastr.clear(activeAiBuildToast);
    activeAiBuildToast = null;
}

async function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    settings.orchestrationSpec = serializeEditorSpec(editor.spec);
    settings.presets = serializeEditorPresetMap(editor.presets);
    await saveSettings();
}

async function persistGlobalAgendaEditorFrom(settings, editor) {
    ensureAgendaEditorIntegrity(editor);
    settings.agendaPlanner = createAgendaPlannerDraft(editor.planner);
    delete settings.agendaPlannerPrompt;
    settings.agendaAgents = sanitizePresetMap(editor.agents);
    settings.agendaFinalAgentId = sanitizeIdentifierToken(editor.finalAgentId, 'finalizer');
    settings.agendaPlannerMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6)));
    settings.agendaMaxConcurrentAgents = Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3)));
    settings.agendaMaxTotalRuns = Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24)));
    ensureSettings();
    await saveSettings();
}

async function persistCharacterEditor(context, settings, avatar, {
    editor = uiState.characterEditor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureEditorIntegrity(editor);
    const characterPresets = serializeEditorPresetMap(editor.presets);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_SPEC,
        enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
        spec: serializeEditorSpec(editor.spec),
        presets: characterPresets,
        updatedAt: Date.now(),
        name: getCharacterDisplayNameByAvatar(context, target),
        notes: sourceNotes,
    };
    delete overridePayload.presetPatch;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

async function persistCharacterAgendaEditor(context, settings, avatar, {
    editor = uiState.characterAgendaEditor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureAgendaEditorIntegrity(editor);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_AGENDA,
        agenda: {
            enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
            planner: createAgendaPlannerDraft(editor.planner),
            agents: sanitizePresetMap(editor.agents),
            finalAgentId: sanitizeIdentifierToken(editor.finalAgentId, 'finalizer'),
            limits: {
                plannerMaxRounds: Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6))),
                maxConcurrentAgents: Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3))),
                maxTotalRuns: Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24))),
            },
            updatedAt: Date.now(),
            name: getCharacterDisplayNameByAvatar(context, target),
            notes: sourceNotes,
        },
    };

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

async function persistCopiedProfileTarget(context, settings, mode, scope) {
    const normalizedMode = normalizeExecutionMode(mode);
    const normalizedScope = scope === 'character' ? 'character' : 'global';
    const avatar = String(getCurrentAvatar(context) || '').trim();

    if (normalizedMode === ORCH_EXECUTION_MODE_AGENDA) {
        if (normalizedScope === 'character') {
            if (!avatar) {
                notifyError(i18n('No character selected.'));
                return false;
            }
            const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
                editor: uiState.characterAgendaEditor,
                forceEnabled: true,
            });
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return false;
            }
            uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
            ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
            updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            return true;
        }
        await persistGlobalAgendaEditorFrom(settings, uiState.globalAgendaEditor);
        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
        updateUiStatus(i18n('Saved to global profile.'));
        return true;
    }

    if (normalizedScope === 'character') {
        if (!avatar) {
            notifyError(i18n('No character selected.'));
            return false;
        }
        const ok = await persistCharacterEditor(context, settings, avatar, {
            editor: uiState.characterEditor,
            forceEnabled: true,
        });
        if (!ok) {
            notifyError(i18n('Failed to persist character override.'));
            return false;
        }
        uiState.characterEditor = loadCharacterEditorState(context, avatar);
        ensureEditorIntegrity(uiState.characterEditor);
        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
        updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
        return true;
    }

    await persistGlobalEditorFrom(settings, uiState.globalEditor);
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
    updateUiStatus(i18n('Saved to global profile.'));
    return true;
}

async function persistOrchestratorCharacterExtension(context, characterIndex, modulePayload) {
    const id = Number(characterIndex);
    const character = Number.isInteger(id) ? context?.characters?.[id] : null;
    if (!character) {
        return false;
    }

    const nextExtensions = cloneJsonCompatible(character?.data?.extensions ?? {});
    if (modulePayload && typeof modulePayload === 'object') {
        nextExtensions[MODULE_NAME] = modulePayload;
    } else {
        delete nextExtensions[MODULE_NAME];
    }

    character.data = character.data || {};
    character.data.extensions = nextExtensions;

    if (Number(context?.characterId) === id && character.json_data) {
        try {
            const jsonData = JSON.parse(character.json_data);
            jsonData.data = jsonData.data || {};
            jsonData.data.extensions = nextExtensions;
            character.json_data = JSON.stringify(jsonData);
            jQuery('#character_json_data').val(character.json_data);
        } catch {
            // Ignore malformed json_data snapshots.
        }
    }

    const response = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: String(character.name || '').trim() || 'character',
            avatar_url: character.avatar,
            field: 'extensions',
            value: nextExtensions,
        }),
    });

    if (!response.ok) {
        console.error('Failed to persist orchestrator extension data to character card', response.statusText);
    }
    return response.ok;
}

function createPortableProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    };
}

function createPortableAgendaProfileFromEditor(editor) {
    ensureAgendaEditorIntegrity(editor);
    return sanitizeAgendaWorkingProfile(editor);
}

function parseImportedProfilePayload(rawText) {
    let parsed = null;
    try {
        parsed = JSON.parse(String(rawText || ''));
    } catch {
        throw new Error(i18n('Invalid profile file format.'));
    }
    const profile = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object'
        ? parsed.profile
        : parsed;
    const mode = normalizeExecutionMode(parsed?.mode || profile?.mode);
    const spec = sanitizeSpec(profile?.spec);
    const presets = sanitizePresetMap(profile?.presets);
    if (Array.isArray(spec?.stages) && spec.stages.length > 0 && presets && Object.keys(presets).length > 0) {
        return { mode: ORCH_EXECUTION_MODE_SPEC, spec, presets };
    }

    const agendaProfile = profile?.agenda && typeof profile.agenda === 'object'
        ? profile.agenda
        : profile;
    const agents = sanitizePresetMap(agendaProfile?.agents);
    const isAgendaPayload = mode === ORCH_EXECUTION_MODE_AGENDA
        || String(parsed?.format || '') === PORTABLE_PROFILE_FORMAT_V2
        || String(parsed?.format || '') === 'luker_orchestrator_agenda_profile_v1';
    if (isAgendaPayload && Object.keys(agents).length > 0) {
        return {
            mode: ORCH_EXECUTION_MODE_AGENDA,
            agenda: sanitizeAgendaWorkingProfile(agendaProfile),
        };
    }

    throw new Error(i18n('Invalid profile file format.'));
}

function downloadJsonFile(fileName, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(fileName || 'orchestration-profile.json');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function pickJsonFileText() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files?.[0] || null;
            input.remove();
            if (!file) {
                resolve(null);
                return;
            }
            try {
                const text = await file.text();
                resolve(text);
            } catch (error) {
                reject(error);
            }
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

function chooseProfileScopeByConfirm(context, confirmKey) {
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (avatar) {
        return window.confirm(i18n(confirmKey)) ? 'global' : 'character';
    }
    if (!window.confirm(i18n('No character selected. Use global profile?'))) {
        return null;
    }
    return 'global';
}

function isPresetUsed(editor, presetId) {
    return isPresetReferencedInSpec(editor?.spec, presetId);
}

function isPresetReferencedInSpec(spec, presetId) {
    const targetPresetId = sanitizeIdentifierToken(presetId, '');
    if (!targetPresetId) {
        return false;
    }
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    return stages.some(stage =>
        (stage?.nodes || []).some(node => {
            const normalizedNode = normalizeNodeSpec(node);
            const nodePresetId = sanitizeIdentifierToken(normalizedNode?.preset || normalizedNode?.id, '');
            return nodePresetId === targetPresetId;
        }));
}

function buildAiProfileFromToolCalls(toolCalls) {
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

async function runAiCharacterProfileBuild(context, settings, { abortSignal = null } = {}) {
    syncCharacterEditorWithActiveAvatar(context);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const isCharacterMode = Boolean(avatar);
    const characterCard = isCharacterMode
        ? getCharacterCardSnapshot(context, avatar)
        : {
            avatar: '',
            name: 'Global Orchestration Profile',
            description: 'Build a reusable global orchestration profile that works across character cards.',
            personality: '',
            scenario: '',
            system: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
        };
    if (isCharacterMode && !characterCard.name) {
        throw new Error('Selected character card is invalid.');
    }

    const currentSpec = sanitizeSpec(settings.orchestrationSpec);
    const currentPresets = serializeEditorPresetMap(settings.presets);
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt({
        spec: currentSpec,
        presets: currentPresets,
    });
    const suggestSystemPromptBase = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    const suggestSystemPrompt = [
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
        'When deviating, explicitly optimize for this character card while preserving hard gates and final function-call text contract.',
    ].join('\n');
    const suggestUserPrompt = buildAiSuggestInputXml({
        character: characterCard,
        overrideGoal: String(uiState.aiGoal || ''),
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

    const aiSuggestApiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const suggestPresetName = String(settings.aiSuggestPresetName || '').trim();
    const worldInfoMessages = normalizeWorldInfoResolverMessages(
        getRecentMessages(Array.isArray(context?.chat) ? context.chat : [], settings.maxRecentMessages),
    );
    const aiSuggestProfileResolution = resolveChatCompletionRequestProfile({
        profileName: aiSuggestApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        suggestSystemPrompt,
        suggestUserPrompt,
        {
            api: aiSuggestProfileResolution.requestApi,
            promptPresetName: suggestPresetName,
            worldInfoMessages,
            worldInfoType: 'quiet',
        },
    );

    const tools = [
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
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const apiSettingsOverride = aiSuggestProfileResolution.apiSettingsOverride;

    updateUiStatus(i18nFormat('Generating orchestration profile for ${0}...', characterCard.name));
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
        const requestPromptMessages = reminderText
            ? mergeUserAddendumIntoPromptMessages(promptMessages, reminderText)
            : promptMessages;
        let toolCalls = [];
        try {
            toolCalls = await requestToolCallsWithRetry(settings, requestPromptMessages, {
                tools,
                allowedNames,
                llmPresetName: suggestPresetName,
                apiSettingsOverride,
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

    const suggestedSpec = sanitizeSpec(parsed.orchestrationSpec);
    const suggestedPatch = parsed.presetPatch && typeof parsed.presetPatch === 'object' ? parsed.presetPatch : {};
    const mergedPresets = mergePresetMaps(serializeEditorPresetMap(settings.presets), suggestedPatch);

    if (isCharacterMode) {
        uiState.characterEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
        uiState.characterEditor.presets = toEditablePresetMap(mergedPresets);
        uiState.characterEditor.enabled = true;

        const persisted = await persistCharacterEditor(context, settings, avatar, { forceEnabled: true });
        if (!persisted) {
            throw new Error(i18n('Failed to persist character override.'));
        }
        return {
            scope: 'character',
            avatar,
            name: getCharacterDisplayNameByAvatar(context, avatar) || characterCard.name,
        };
    }

    uiState.globalEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
    uiState.globalEditor.presets = toEditablePresetMap(mergedPresets);
    await persistGlobalEditorFrom(settings, uiState.globalEditor);
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    return {
        scope: 'global',
        avatar: '',
        name: i18n('Global profile'),
    };
}

function trimAiIterationMessages(session) {
    if (!session) {
        return;
    }
    if (!Array.isArray(session.messages)) {
        session.messages = [];
    }
}

function stringifyIterationSimulationForPrompt(simulation) {
    if (!simulation || typeof simulation !== 'object') {
        return '(none)';
    }
    try {
        return JSON.stringify({
            ok: Boolean(simulation.ok),
            summary: String(simulation.summary || ''),
            detail: simulation.detail && typeof simulation.detail === 'object' ? simulation.detail : {},
        });
    } catch {
        return String(simulation.summary || '(simulation)');
    }
}

function stringifyIterationSimulationListForPrompt(simulations) {
    const list = Array.isArray(simulations) ? simulations : [];
    if (list.length === 0) {
        return '(none)';
    }
    try {
        return JSON.stringify(list.map(item => ({
            ok: Boolean(item?.ok),
            summary: String(item?.summary || ''),
            detail: item?.detail && typeof item.detail === 'object' ? item.detail : {},
        })));
    } catch {
        return list.map(item => String(item?.summary || '(simulation)')).join('\n');
    }
}

function buildAiIterationAutoContinuePrompt(executionResult) {
    const simulationText = stringifyIterationSimulationListForPrompt(executionResult?.simulations);
    return [
        'AUTO CONTINUE',
        'Previous tool execution is complete. Review the result and continue iteration.',
        '',
        buildFriendlyIterationExecutionSummary(executionResult),
        '',
        '<simulation_results>',
        simulationText,
        '</simulation_results>',
        '',
        'If all requested work is complete, call luker_orch_finalize_iteration.',
        'Otherwise, emit the next focused tool calls.',
    ].join('\n');
}

function cloneWorkingProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: sanitizeSpec(serializeEditorSpec(editor.spec)),
        presets: sanitizePresetMap(serializeEditorPresetMap(editor.presets)),
    };
}

function createIterationEditorFromWorkingProfile(workingProfile) {
    const safeSpec = sanitizeSpec(workingProfile?.spec);
    const safePresets = sanitizePresetMap(workingProfile?.presets);
    return {
        spec: toEditableSpec(safeSpec, toEditablePresetMap(safePresets)),
        presets: toEditablePresetMap(safePresets),
    };
}

function sanitizeAgendaWorkingProfile(workingProfile = null) {
    const source = workingProfile && typeof workingProfile === 'object' ? workingProfile : {};
    const limitsSource = source?.limits && typeof source.limits === 'object' ? source.limits : source;
    const planner = createAgendaPlannerDraft(
        source?.planner && typeof source.planner === 'object'
            ? source.planner
            : {
                systemPrompt: source?.plannerSystemPrompt,
                userPromptTemplate: source?.plannerPrompt,
                apiPresetName: source?.plannerApiPresetName,
                promptPresetName: source?.plannerPromptPresetName,
            },
    );
    const agents = sanitizePresetMap(source?.agents);
    if (Object.keys(agents).length === 0) {
        agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
    }
    const finalAgentId = sanitizeIdentifierToken(
        source?.finalAgentId,
        agents.finalizer ? 'finalizer' : (Object.keys(agents)[0] || 'finalizer'),
    );
    return {
        planner,
        agents,
        finalAgentId: agents[finalAgentId]
            ? finalAgentId
            : (agents.finalizer ? 'finalizer' : (Object.keys(agents)[0] || 'finalizer')),
        limits: {
            plannerMaxRounds: Math.max(1, Math.min(20, Math.floor(Number(limitsSource?.plannerMaxRounds) || 6))),
            maxConcurrentAgents: Math.max(1, Math.min(12, Math.floor(Number(limitsSource?.maxConcurrentAgents) || 3))),
            maxTotalRuns: Math.max(1, Math.min(200, Math.floor(Number(limitsSource?.maxTotalRuns) || 24))),
        },
    };
}

function cloneAgendaWorkingProfileFromSettings(settings) {
    return sanitizeAgendaWorkingProfile({
        planner: settings?.agendaPlanner || {
            userPromptTemplate: settings?.agendaPlannerPrompt,
        },
        agents: sanitizePresetMap(settings?.agendaAgents),
        finalAgentId: sanitizeIdentifierToken(settings?.agendaFinalAgentId, 'finalizer'),
        limits: {
            plannerMaxRounds: Number(settings?.agendaPlannerMaxRounds || 6),
            maxConcurrentAgents: Number(settings?.agendaMaxConcurrentAgents || 3),
            maxTotalRuns: Number(settings?.agendaMaxTotalRuns || 24),
        },
    });
}

function cloneAgendaWorkingProfileFromEditor(editor) {
    ensureAgendaEditorIntegrity(editor);
    return sanitizeAgendaWorkingProfile(editor);
}

function buildAgendaProfileForRuntime(workingProfile = null) {
    const profile = sanitizeAgendaWorkingProfile(workingProfile);
    return {
        source: 'agenda',
        key: 'agenda_iteration',
        mode: ORCH_EXECUTION_MODE_AGENDA,
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: {
            plannerMaxRounds: profile.limits.plannerMaxRounds,
            maxConcurrentAgents: profile.limits.maxConcurrentAgents,
            maxTotalRuns: profile.limits.maxTotalRuns,
        },
    };
}

function isAgendaIterationSession(session) {
    return String(session?.mode || '') === ORCH_EXECUTION_MODE_AGENDA;
}

function cloneAiIterationWorkingProfile(mode, workingProfile) {
    if (String(mode || '') === ORCH_EXECUTION_MODE_AGENDA) {
        return sanitizeAgendaWorkingProfile(structuredClone(workingProfile || {}));
    }
    return {
        spec: sanitizeSpec(structuredClone(workingProfile?.spec || { stages: [] })),
        presets: sanitizePresetMap(structuredClone(workingProfile?.presets || {})),
    };
}

function getAiIterationDiffObjectHash(obj, index = 0) {
    if (!obj || typeof obj !== 'object') {
        return `${typeof obj}:${String(obj)}`;
    }
    const id = sanitizeIdentifierToken(obj.id, '');
    if (id) {
        return `id:${id}`;
    }
    const name = normalizeText(obj.name || '');
    if (name) {
        return `name:${name}`;
    }
    const preset = sanitizeIdentifierToken(obj.preset, '');
    if (preset) {
        return `preset:${preset}`;
    }
    const fallback = JSON.stringify(obj);
    return fallback || `index:${index}`;
}

const aiIterationDiffPatcher = createDiffPatcher({
    objectHash: getAiIterationDiffObjectHash,
    arrays: {
        detectMove: true,
        includeValueOnMove: false,
    },
    textDiff: {
        minLength: ORCH_ITERATION_DIFF_TEXT_MIN_LENGTH,
        diffMatchPatch: DiffMatchPatch,
    },
    cloneDiffValues: true,
});

function cloneAiIterationProfileDelta(delta) {
    if (!delta || typeof delta !== 'object') {
        return null;
    }
    return structuredClone(delta);
}

function buildAiIterationProfileDeltaPayload(mode, beforeProfile, afterProfile) {
    const safeBefore = cloneAiIterationWorkingProfile(mode, beforeProfile);
    const safeAfter = cloneAiIterationWorkingProfile(mode, afterProfile);
    const delta = aiIterationDiffPatcher.diff(safeBefore, safeAfter);
    const normalizedDelta = cloneAiIterationProfileDelta(delta);
    return {
        beforeProfile: safeBefore,
        afterProfile: safeAfter,
        delta: normalizedDelta,
        reverseDelta: normalizedDelta ? cloneAiIterationProfileDelta(reverseDiffDelta(normalizedDelta)) : null,
    };
}

function sanitizeAiIterationProfileDiffHtml(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function renderAiIterationProfileDeltaHtml(mode, delta, beforeProfile) {
    const normalizedDelta = cloneAiIterationProfileDelta(delta);
    if (!normalizedDelta) {
        return '';
    }
    try {
        const safeBefore = cloneAiIterationWorkingProfile(mode, beforeProfile);
        const safeAfter = cloneAiIterationWorkingProfile(mode, safeBefore);
        aiIterationDiffPatcher.patch(safeAfter, cloneAiIterationProfileDelta(normalizedDelta));
        const html = renderObjectDiffHtml({
            before: safeBefore,
            after: safeAfter,
            delta: normalizedDelta,
            beforeLabel: i18n('Before'),
            afterLabel: i18n('After'),
            missingLabel: i18n('(missing)'),
            renderTextDiff: renderIterationLineDiffHtml,
        });
        return sanitizeAiIterationProfileDiffHtml(html);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to render iteration profile delta`, error);
        return '';
    }
}

function ensureAiIterationSessionBaseWorkingProfile(session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    if (!session.baseWorkingProfile || typeof session.baseWorkingProfile !== 'object') {
        session.baseWorkingProfile = cloneAiIterationWorkingProfile(session.mode, session.workingProfile);
    }
}

function restoreAiIterationSessionStateFromMessages(session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    ensureAiIterationSessionBaseWorkingProfile(session);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const snapshotMessage = [...messages].reverse().find(item => item?.profileSnapshotAfter && typeof item.profileSnapshotAfter === 'object');
    session.workingProfile = cloneAiIterationWorkingProfile(
        session.mode,
        snapshotMessage?.profileSnapshotAfter || session.baseWorkingProfile,
    );
    session.lastSimulation = snapshotMessage?.lastSimulationAfter
        ? structuredClone(snapshotMessage.lastSimulationAfter)
        : null;
    const pendingMessage = [...messages].reverse().find(item => String(item?.toolState || '').trim().toLowerCase() === 'pending');
    const fallbackPendingExecutionCalls = pendingMessage ? buildExecutionToolCalls(normalizePersistentToolCalls(pendingMessage)) : [];
    const fallbackPendingSplit = pendingMessage ? splitAiIterationToolCallsForApproval(fallbackPendingExecutionCalls) : { approvalCalls: [] };
    session.pendingApproval = pendingMessage
        ? {
            messageId: String(pendingMessage?.id || ''),
            assistantText: String(pendingMessage?.content || ''),
            toolCalls: Array.isArray(pendingMessage?.pendingToolCalls)
                ? structuredClone(pendingMessage.pendingToolCalls)
                : fallbackPendingSplit.approvalCalls,
            executionToolCalls: Array.isArray(pendingMessage?.executionToolCalls)
                ? structuredClone(pendingMessage.executionToolCalls)
                : fallbackPendingExecutionCalls,
            createdAt: Number(pendingMessage?.at || Date.now()),
        }
        : null;
    session.updatedAt = Date.now();
}

function normalizeAiIterationSessionMessage(mode, rawMessage) {
    const role = String(rawMessage?.role || 'assistant').trim().toLowerCase();
    const message = {
        id: String(rawMessage?.id || '').trim() || makeAiIterationMessageId(),
        role: role === 'user' ? 'user' : 'assistant',
        content: String(rawMessage?.content || ''),
        auto: Boolean(rawMessage?.auto),
        at: Number(rawMessage?.at || Date.now()),
    };

    if (message.role === 'assistant') {
        const toolCalls = normalizePersistentToolCalls(rawMessage);
        const toolResults = normalizePersistentToolResults(rawMessage, toolCalls);
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        if (toolResults.length > 0) {
            message.tool_results = toolResults;
        }
        if (rawMessage?.toolSummary) {
            message.toolSummary = String(rawMessage.toolSummary || '');
        }
        if (rawMessage?.toolState) {
            message.toolState = String(rawMessage.toolState || '');
        }
        if (Array.isArray(rawMessage?.pendingToolCalls)) {
            message.pendingToolCalls = buildExecutionToolCalls(rawMessage.pendingToolCalls);
        }
        if (Array.isArray(rawMessage?.executionToolCalls)) {
            message.executionToolCalls = buildExecutionToolCalls(rawMessage.executionToolCalls);
        }
        if (rawMessage?.profileSnapshotBefore && typeof rawMessage.profileSnapshotBefore === 'object') {
            message.profileSnapshotBefore = cloneAiIterationWorkingProfile(mode, rawMessage.profileSnapshotBefore);
        }
        if (rawMessage?.profileDelta && typeof rawMessage.profileDelta === 'object') {
            message.profileDelta = cloneAiIterationProfileDelta(rawMessage.profileDelta);
        }
        if (rawMessage?.reverseProfileDelta && typeof rawMessage.reverseProfileDelta === 'object') {
            message.reverseProfileDelta = cloneAiIterationProfileDelta(rawMessage.reverseProfileDelta);
        }
        if (rawMessage?.profileSnapshotAfter && typeof rawMessage.profileSnapshotAfter === 'object') {
            message.profileSnapshotAfter = cloneAiIterationWorkingProfile(mode, rawMessage.profileSnapshotAfter);
        }
        if (rawMessage?.lastSimulationAfter && typeof rawMessage.lastSimulationAfter === 'object') {
            message.lastSimulationAfter = structuredClone(rawMessage.lastSimulationAfter);
        }
    }

    return message;
}

function normalizeAiIterationStoredSession(rawSession) {
    const mode = normalizeExecutionMode(rawSession?.mode) || ORCH_EXECUTION_MODE_SPEC;
    const baseWorkingProfile = cloneAiIterationWorkingProfile(
        mode,
        rawSession?.baseWorkingProfile || rawSession?.workingProfile,
    );
    const session = {
        id: String(rawSession?.id || '').trim() || `session_${Date.now()}`,
        mode,
        chatKey: String(rawSession?.chatKey || '').trim(),
        sourceScope: String(rawSession?.sourceScope || '').trim() === 'character' ? 'character' : 'global',
        sourceAvatar: String(rawSession?.sourceAvatar || '').trim(),
        sourceName: String(rawSession?.sourceName || '').trim(),
        revision: Math.max(1, Math.floor(Number(rawSession?.revision) || 1)),
        createdAt: Number(rawSession?.createdAt || Date.now()),
        updatedAt: Number(rawSession?.updatedAt || rawSession?.createdAt || Date.now()),
        workingProfile: cloneAiIterationWorkingProfile(mode, rawSession?.workingProfile || baseWorkingProfile),
        baseWorkingProfile,
        messages: (Array.isArray(rawSession?.messages) ? rawSession.messages : [])
            .map(item => normalizeAiIterationSessionMessage(mode, item)),
        lastSimulation: rawSession?.lastSimulation && typeof rawSession.lastSimulation === 'object'
            ? structuredClone(rawSession.lastSimulation)
            : null,
        pendingApproval: null,
    };
    restoreAiIterationSessionStateFromMessages(session);
    return session;
}

function createEmptyAiIterationHistoryState() {
    return {
        version: ORCH_CHARACTER_ITERATION_HISTORY_VERSION,
        sessions: [],
    };
}

function normalizeAiIterationHistoryState(rawState) {
    if (Number(rawState?.version || 0) !== ORCH_CHARACTER_ITERATION_HISTORY_VERSION) {
        return createEmptyAiIterationHistoryState();
    }
    const sessions = (Array.isArray(rawState?.sessions) ? rawState.sessions : [])
        .map(session => normalizeAiIterationStoredSession(session))
        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    return {
        version: ORCH_CHARACTER_ITERATION_HISTORY_VERSION,
        sessions: sessions.slice(-ORCH_CHARACTER_ITERATION_HISTORY_LIMIT),
    };
}

function replaceAiIterationSession(targetSession, sourceSession) {
    if (!targetSession || typeof targetSession !== 'object') {
        return sourceSession;
    }
    const normalized = normalizeAiIterationStoredSession(sourceSession);
    for (const key of Object.keys(targetSession)) {
        delete targetSession[key];
    }
    Object.assign(targetSession, normalized);
    return targetSession;
}

function upsertAiIterationHistorySession(historyState, session) {
    const normalizedState = normalizeAiIterationHistoryState(historyState);
    const normalizedSession = normalizeAiIterationStoredSession(session);
    const nextSessions = normalizedState.sessions.filter(item => String(item?.id || '') !== String(normalizedSession.id || ''));
    nextSessions.push(normalizedSession);
    nextSessions.sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    normalizedState.sessions = nextSessions.slice(-ORCH_CHARACTER_ITERATION_HISTORY_LIMIT);
    return normalizedState;
}

function deleteAiIterationHistorySession(historyState, sessionId) {
    const normalizedState = normalizeAiIterationHistoryState(historyState);
    const targetId = String(sessionId || '').trim();
    normalizedState.sessions = normalizedState.sessions.filter(item => String(item?.id || '') !== targetId);
    return normalizedState;
}

function findAiIterationHistorySession(historyState, sessionId) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return (Array.isArray(historyState?.sessions) ? historyState.sessions : [])
        .find(item => String(item?.id || '') === targetId) || null;
}

function getAiIterationHistorySessionsByMode(historyState, mode) {
    const targetMode = normalizeExecutionMode(mode) || ORCH_EXECUTION_MODE_SPEC;
    return (Array.isArray(historyState?.sessions) ? historyState.sessions : [])
        .filter(item => (normalizeExecutionMode(item?.mode) || ORCH_EXECUTION_MODE_SPEC) === targetMode);
}

function findAiIterationHistorySessionByMode(historyState, sessionId, mode) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return getAiIterationHistorySessionsByMode(historyState, mode)
        .find(item => String(item?.id || '') === targetId) || null;
}

function findLatestAiIterationHistorySessionByMode(historyState, mode) {
    const sessions = getAiIterationHistorySessionsByMode(historyState, mode);
    return sessions.length > 0 ? sessions[sessions.length - 1] : null;
}

async function loadAiIterationHistoryState(context, avatar) {
    const raw = await getCharacterState(avatar, ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE);
    return normalizeAiIterationHistoryState(raw || createEmptyAiIterationHistoryState());
}

async function persistAiIterationHistoryState(context, avatar, historyState) {
    await setCharacterState(
        avatar,
        ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE,
        normalizeAiIterationHistoryState(historyState),
    );
}

function loadGlobalAiIterationHistoryState() {
    ensureSettings();
    return normalizeAiIterationHistoryState(extension_settings?.[MODULE_NAME]?.[ORCH_GLOBAL_ITERATION_HISTORY_KEY]);
}

async function persistGlobalAiIterationHistoryState(historyState) {
    ensureSettings();
    extension_settings[MODULE_NAME][ORCH_GLOBAL_ITERATION_HISTORY_KEY] = normalizeAiIterationHistoryState(historyState);
    saveSettingsDebounced();
}

async function loadAiIterationHistoryStateForScope(context, { scope = 'global', avatar = '' } = {}) {
    if (String(scope || '').trim() === 'character' && String(avatar || '').trim()) {
        return await loadAiIterationHistoryState(context, avatar);
    }
    return loadGlobalAiIterationHistoryState();
}

async function persistAiIterationHistoryStateForScope(context, historyState, { scope = 'global', avatar = '' } = {}) {
    if (String(scope || '').trim() === 'character' && String(avatar || '').trim()) {
        await persistAiIterationHistoryState(context, avatar, historyState);
        return;
    }
    await persistGlobalAiIterationHistoryState(historyState);
}

function summarizeAiIterationHistorySession(session, fallback = '') {
    const firstUserMessage = (Array.isArray(session?.messages) ? session.messages : [])
        .find(item => String(item?.role || '').trim().toLowerCase() === 'user');
    const summary = String(firstUserMessage?.content || '').trim() || String(session?.sourceName || '').trim() || String(fallback || '').trim();
    return summary.length > 72
        ? `${summary.slice(0, 72).trim()}...`
        : summary;
}

function getAiIterationRollbackStartIndex(messages, messageIndex) {
    const index = asFiniteInteger(messageIndex, -1);
    const list = Array.isArray(messages) ? messages : [];
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
        return -1;
    }
    let removeFrom = index;
    const previous = removeFrom > 0 ? list[removeFrom - 1] : null;
    if (String(list[removeFrom]?.role || '').trim().toLowerCase() === 'assistant'
        && String(previous?.role || '').trim().toLowerCase() === 'user') {
        removeFrom -= 1;
    }
    return removeFrom;
}

function createAiIterationSession(context, settings) {
    if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
        syncCharacterEditorWithActiveAvatar(context);
        const scope = getDisplayedScope(context, settings);
        const editor = getAgendaEditorByScope(scope);
        const avatar = String(getCurrentAvatar(context) || '').trim();
        const sourceName = scope === 'character'
            ? (getCharacterDisplayNameByAvatar(context, avatar) || avatar || i18n('(No character card)'))
            : i18n('Global profile');
        const workingProfile = cloneAgendaWorkingProfileFromEditor(editor);
        return {
            id: `session_${Date.now()}`,
            mode: ORCH_EXECUTION_MODE_AGENDA,
            chatKey: getChatKey(context),
            sourceScope: scope,
            sourceAvatar: avatar,
            sourceName,
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            workingProfile,
            baseWorkingProfile: cloneAiIterationWorkingProfile(ORCH_EXECUTION_MODE_AGENDA, workingProfile),
            messages: [],
            lastSimulation: null,
            pendingApproval: null,
        };
    }
    syncCharacterEditorWithActiveAvatar(context);
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const sourceName = scope === 'character'
        ? (getCharacterDisplayNameByAvatar(context, avatar) || avatar || i18n('(No character card)'))
        : i18n('Global profile');
    const workingProfile = cloneWorkingProfileFromEditor(editor);
    return {
        id: `session_${Date.now()}`,
        chatKey: getChatKey(context),
        sourceScope: scope,
        sourceAvatar: avatar,
        sourceName,
        mode: ORCH_EXECUTION_MODE_SPEC,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workingProfile,
        baseWorkingProfile: cloneAiIterationWorkingProfile(ORCH_EXECUTION_MODE_SPEC, workingProfile),
        messages: [],
        lastSimulation: null,
        pendingApproval: null,
    };
}

function ensureAiIterationSession(context, settings, { forceNew = false } = {}) {
    if (!uiState.aiIterationSession || forceNew) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    if (String(uiState.aiIterationSession.mode || ORCH_EXECUTION_MODE_SPEC) !== getExecutionMode(settings)) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    const currentChatKey = getChatKey(context);
    if (String(uiState.aiIterationSession.chatKey || '') !== String(currentChatKey || '')) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    ensureAiIterationSessionBaseWorkingProfile(uiState.aiIterationSession);
    return uiState.aiIterationSession;
}

function summarizeStageForUi(stage) {
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    const nodeSummary = nodes.map((node) => {
        const type = normalizeNodeType(node?.type);
        return `${String(node?.id || '')}→${String(node?.preset || '')}${type === ORCH_NODE_TYPE_REVIEW ? ' [review]' : ''}`;
    }).filter(Boolean).join(' | ');
    return {
        id: String(stage?.id || ''),
        mode: String(stage?.mode || 'serial') === 'parallel' ? 'parallel' : 'serial',
        nodeSummary,
    };
}

const ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD = 1200;
const ITERATION_MESSAGE_FOLD_LINE_THRESHOLD = 18;

function isIterationMessageLikelySimulationContext(text) {
    const source = String(text || '');
    if (!source) {
        return false;
    }
    return source.includes('<simulation_results>')
        || source.includes('"all_stage_outputs"')
        || source.includes('"final_stage_id"')
        || source.includes('AUTO CONTINUE')
        || source.includes('Previous tool execution is complete. Review the result and continue iteration.');
}

function renderAiIterationMessageBodyHtml(content, { auto = false } = {}) {
    const text = stripIterationThoughtForDisplay(content || '');
    if (!text) {
        return escapeHtml('(empty)');
    }
    const lineCount = text.split('\n').length;
    const simulationLike = isIterationMessageLikelySimulationContext(text);
    const tooLong = text.length > ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD || lineCount > ITERATION_MESSAGE_FOLD_LINE_THRESHOLD;
    const shouldFold = simulationLike || tooLong;
    if (!shouldFold) {
        return escapeHtml(text);
    }

    const summary = simulationLike && auto
        ? i18n('Auto simulation context (folded)')
        : i18nFormat('Long message (${0} chars)', text.length);
    const preview = text.slice(0, 280).trim();

    return `
<details class="luker-studio-msg-folded">
    <summary>${escapeHtml(summary)}</summary>
    ${preview ? `<div class="luker-studio-msg-preview"><b>${escapeHtml(i18n('Preview'))}:</b> ${escapeHtml(preview)}${text.length > preview.length ? ' ...' : ''}</div>` : ''}
    <div class="luker-studio-msg-full">${escapeHtml(text)}</div>
</details>`;
}

function findPreviousAiIterationUserMessageIndex(messages, startIndex) {
    const list = Array.isArray(messages) ? messages : [];
    const index = Math.min(list.length - 1, Math.max(-1, Math.floor(Number(startIndex) || -1)));
    for (let i = index - 1; i >= 0; i--) {
        if (String(list[i]?.role || '').trim().toLowerCase() === 'user') {
            return i;
        }
    }
    return -1;
}

function canRefreshAiIterationAssistantMessage(session, messageIndex) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    const index = Math.floor(Number(messageIndex));
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        return false;
    }
    const item = items[index];
    if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
        return false;
    }
    if (Boolean(item?.auto)) {
        return false;
    }
    return findPreviousAiIterationUserMessageIndex(items, index) >= 0;
}

function canRollbackAiIterationAssistantMessage(session, messageIndex) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    const index = Math.floor(Number(messageIndex));
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        return false;
    }
    const item = items[index];
    if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
        return false;
    }
    if (String(item?.toolState || '').trim().toLowerCase() !== 'completed') {
        return false;
    }
    return Boolean(item?.profileDelta && typeof item.profileDelta === 'object')
        && Boolean(item?.profileSnapshotAfter && typeof item.profileSnapshotAfter === 'object');
}

function renderAiIterationMessageDiffHtml(session, item, messageIndex) {
    const toolState = String(item?.toolState || '').trim().toLowerCase();
    if (toolState === 'pending') {
        return '';
    }
    const profileDeltaHtml = item?.profileDelta
        ? renderAiIterationProfileDeltaHtml(session?.mode, item.profileDelta, item?.profileSnapshotBefore || session?.workingProfile)
        : '';
    if (!profileDeltaHtml) {
        return '';
    }
    const summaryLabel = toolState === 'completed'
        ? i18n('Applied changes diff')
        : (toolState === 'rejected' ? i18n('Rejected changes diff') : i18n('Pending changes diff'));
    const rollbackAction = canRollbackAiIterationAssistantMessage({ messages: [item] }, 0)
        ? `
    <div class="luker-studio-msg-actions">
        <div class="menu_button menu_button_small" data-luker-orch-action="rollback-message" data-luker-orch-message-index="${messageIndex}">${escapeHtml(i18n('Rollback round'))}</div>
    </div>`
        : '';
    return `
<details class="luker-studio-pending-diff"${toolState === 'pending' ? ' open' : ''}>
    <summary>${escapeHtml(summaryLabel)}</summary>
    <div class="luker-studio-diff">
        ${profileDeltaHtml}
    </div>
    ${rollbackAction}
</details>`;
}

function renderAiIterationSessionHistory(historyState, activeSessionId = '', modeFilter = '') {
    const sessions = getAiIterationHistorySessionsByMode(historyState, modeFilter).slice().reverse();
    if (sessions.length === 0) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No saved sessions yet.'))}</div>`;
    }
    return `<div class="luker-studio-history-list">${sessions.map((session) => {
        const sessionId = String(session?.id || '').trim();
        const isActive = sessionId && sessionId === String(activeSessionId || '').trim();
        const modeLabel = String(session?.mode || '').trim() === ORCH_EXECUTION_MODE_AGENDA ? 'Agenda' : 'Spec';
        const summary = summarizeAiIterationHistorySession(session, session?.sourceName || '');
        const meta = [
            modeLabel,
            `${Array.isArray(session?.messages) ? session.messages.length : 0} msgs`,
            new Date(Number(session?.updatedAt || session?.createdAt || Date.now())).toLocaleString(),
        ].join(' · ');
        return `
<div class="luker-studio-history-item${isActive ? ' active' : ''}">
    <div class="luker-studio-history-item-main">
        <div class="luker-studio-history-item-summary">${escapeHtml(summary || '(session)')}</div>
        <div class="luker-studio-history-item-time">${escapeHtml(meta)}</div>
    </div>
    <div class="luker-studio-history-item-actions">
        ${isActive ? `<div class="menu_button menu_button_small disabled">${escapeHtml(i18n('Current session'))}</div>` : `<div class="menu_button menu_button_small" data-luker-orch-action="load-session" data-luker-orch-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Load session'))}</div>`}
        <div class="menu_button menu_button_small" data-luker-orch-action="delete-session" data-luker-orch-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Delete session'))}</div>
    </div>
</div>`;
    }).join('')}</div>`;
}

function renderAiIterationConversation(session, { loading = false, loadingText = '' } = {}) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    if (items.length === 0 && !loading) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No messages yet. Start by telling AI what you want to optimize.'))}</div>`;
    }
    const html = items.map((item, index) => {
        const role = String(item?.role || 'assistant').toLowerCase();
        const auto = Boolean(item?.auto);
        const label = auto ? 'AUTO' : (role === 'user' ? 'You' : 'AI');
        const dataRole = role === 'user' ? 'user' : 'assistant';
        const bodyHtml = renderAiIterationMessageBodyHtml(item?.content || '', { auto });
        const toolSummary = String(item?.toolSummary || '').trim();
        const actionButtons = [];
        if (canRefreshAiIterationAssistantMessage(session, index)) {
            actionButtons.push(`<div class="menu_button menu_button_small" data-luker-orch-action="refresh-message" data-luker-orch-message-index="${index}">${escapeHtml(i18n('Regenerate'))}</div>`);
        }
        const actionsHtml = actionButtons.length > 0
            ? `<div class="luker-studio-msg-actions">${actionButtons.join('')}</div>`
            : '';
        const diffHtml = role === 'assistant'
            ? renderAiIterationMessageDiffHtml(session, item, index)
            : '';
        return `
<div class="luker-studio-msg" data-role="${dataRole}">
    <div class="luker-studio-msg-head">${escapeHtml(label)}</div>
    <div class="luker-studio-msg-body">${bodyHtml}</div>
    ${diffHtml}
    ${toolSummary ? `<div class="luker-studio-msg-meta">${escapeHtml(toolSummary)}</div>` : ''}
    ${actionsHtml}
</div>`;
    }).join('');
    if (!loading) {
        return html;
    }
    const label = String(loadingText || i18n('AI iteration is running...'));
    return `${html}
<div class="luker-studio-msg loading" data-role="assistant">
    <div class="luker-studio-msg-body"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(label)}</div>
</div>`;
}

const AI_ITERATION_EDITABLE_TOOL_NAMES = new Set([
    'luker_orch_set_stage',
    'luker_orch_remove_stage',
    'luker_orch_set_node',
    'luker_orch_remove_node',
    'luker_orch_set_preset',
    'luker_orch_remove_preset',
    'luker_orch_set_agenda_planner',
    'luker_orch_set_agenda_planner_prompt',
    'luker_orch_set_agenda_agent',
    'luker_orch_remove_agenda_agent',
    'luker_orch_set_agenda_final_agent',
    'luker_orch_set_agenda_limits',
]);

function isAiIterationEditableToolCallName(name) {
    return AI_ITERATION_EDITABLE_TOOL_NAMES.has(String(name || '').trim());
}

function splitAiIterationToolCallsForApproval(toolCalls) {
    const all = Array.isArray(toolCalls) ? toolCalls : [];
    const approvalCalls = [];
    for (const call of all) {
        const name = String(call?.name || '').trim();
        if (isAiIterationEditableToolCallName(name)) {
            approvalCalls.push(call);
            continue;
        }
    }
    return {
        allCalls: all,
        approvalCalls,
    };
}

function summarizeIterationToolCalls(toolCalls) {
    const counts = {
        stage_set: 0,
        stage_remove: 0,
        node_set: 0,
        node_remove: 0,
        preset_set: 0,
        preset_remove: 0,
        agenda_planner: 0,
        agenda_agent_set: 0,
        agenda_agent_remove: 0,
        agenda_final_agent: 0,
        agenda_limits: 0,
        other: 0,
    };
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (name === 'luker_orch_set_stage') counts.stage_set += 1;
        else if (name === 'luker_orch_remove_stage') counts.stage_remove += 1;
        else if (name === 'luker_orch_set_node') counts.node_set += 1;
        else if (name === 'luker_orch_remove_node') counts.node_remove += 1;
        else if (name === 'luker_orch_set_preset') counts.preset_set += 1;
        else if (name === 'luker_orch_remove_preset') counts.preset_remove += 1;
        else if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') counts.agenda_planner += 1;
        else if (name === 'luker_orch_set_agenda_agent') counts.agenda_agent_set += 1;
        else if (name === 'luker_orch_remove_agenda_agent') counts.agenda_agent_remove += 1;
        else if (name === 'luker_orch_set_agenda_final_agent') counts.agenda_final_agent += 1;
        else if (name === 'luker_orch_set_agenda_limits') counts.agenda_limits += 1;
        else counts.other += 1;
    }
    const lines = [];
    if (counts.stage_set > 0) lines.push(`更新阶段 ${counts.stage_set}`);
    if (counts.stage_remove > 0) lines.push(`删除阶段 ${counts.stage_remove}`);
    if (counts.node_set > 0) lines.push(`更新节点 ${counts.node_set}`);
    if (counts.node_remove > 0) lines.push(`删除节点 ${counts.node_remove}`);
    if (counts.preset_set > 0) lines.push(`更新预设 ${counts.preset_set}`);
    if (counts.preset_remove > 0) lines.push(`删除预设 ${counts.preset_remove}`);
    if (counts.agenda_planner > 0) lines.push(`更新 agenda planner ${counts.agenda_planner}`);
    if (counts.agenda_agent_set > 0) lines.push(`更新 agenda agents ${counts.agenda_agent_set}`);
    if (counts.agenda_agent_remove > 0) lines.push(`删除 agenda agents ${counts.agenda_agent_remove}`);
    if (counts.agenda_final_agent > 0) lines.push(`更新 agenda final agent ${counts.agenda_final_agent}`);
    if (counts.agenda_limits > 0) lines.push(`更新 agenda 限制 ${counts.agenda_limits}`);
    if (counts.other > 0) lines.push(`其他操作 ${counts.other}`);
    return lines;
}

function stripIterationThoughtForDisplay(value) {
    const text = String(value ?? '');
    if (!text) {
        return '';
    }
    const withoutBlocks = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '');
    const withoutTags = withoutBlocks.replace(/<\/?thought\b[^>]*>/gi, '');
    return withoutTags.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeDiffPlaceholderValue(value) {
    const text = String(value ?? '');
    const normalized = text.trim();
    if (!normalized) {
        return '';
    }
    const notSetTokens = new Set([
        'Not set',
        '未设置',
        '未設定',
    ]);
    return notSetTokens.has(normalized) ? '' : text;
}

function formatDiffValue(value) {
    return sanitizeDiffPlaceholderValue(value);
}

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

function splitLineDiffText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    return normalized.length > 0 ? normalized.split('\n') : [];
}

function buildLineDiffOperations(beforeLines, afterLines) {
    const a = Array.isArray(beforeLines) ? beforeLines : [];
    const b = Array.isArray(afterLines) ? afterLines : [];
    if (a.length === 0 && b.length === 0) {
        return [];
    }
    if (a.length === 0) {
        return [{ type: 'insert', lines: b.slice() }];
    }
    if (b.length === 0) {
        return [{ type: 'delete', lines: a.slice() }];
    }
    if ((a.length * b.length) > LINE_DIFF_LCS_MAX_CELLS) {
        return [
            { type: 'delete', lines: a.slice() },
            { type: 'insert', lines: b.slice() },
        ];
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? (dp[i + 1][j + 1] + 1)
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const operations = [];
    const push = (type, line) => {
        const last = operations[operations.length - 1];
        if (last && last.type === type) {
            last.lines.push(line);
            return;
        }
        operations.push({ type, lines: [line] });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('equal', a[i]);
            i += 1;
            j += 1;
            continue;
        }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            push('delete', a[i]);
            i += 1;
            continue;
        }
        push('insert', b[j]);
        j += 1;
    }
    while (i < a.length) {
        push('delete', a[i]);
        i += 1;
    }
    while (j < b.length) {
        push('insert', b[j]);
        j += 1;
    }
    return operations;
}

function buildLineDiffRows(beforeValue, afterValue) {
    const beforeText = String(beforeValue ?? '');
    const afterText = String(afterValue ?? '');
    const operations = buildLineDiffOperations(splitLineDiffText(beforeText), splitLineDiffText(afterText));
    const stats = { added: 0, removed: 0, unchanged: 0 };

    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        for (const line of lines) {
            if (type === 'insert') {
                stats.added += 1;
                continue;
            }
            if (type === 'delete') {
                stats.removed += 1;
                continue;
            }
            stats.unchanged += 1;
        }
    }

    const maxChars = Math.max(beforeText.length, afterText.length);
    const lineCount = stats.added + stats.removed + stats.unchanged;
    const isLong = lineCount > LINE_DIFF_LONG_LINE_THRESHOLD || maxChars > LINE_DIFF_LONG_CHAR_THRESHOLD;

    return {
        operations,
        added: stats.added,
        removed: stats.removed,
        unchanged: stats.unchanged,
        openByDefault: !isLong,
    };
}

function splitInlineDiffTokens(text) {
    const source = String(text ?? '');
    return source.length > 0 ? (source.match(/\s+|[^\s]+/g) || []) : [];
}

function renderInlineDiffHtml(beforeText, afterText, mode = 'old') {
    const beforeTokens = splitInlineDiffTokens(beforeText);
    const afterTokens = splitInlineDiffTokens(afterText);
    if (beforeTokens.length === 0 && afterTokens.length === 0) {
        return '&nbsp;';
    }
    if ((beforeTokens.length * afterTokens.length) > LINE_DIFF_LCS_MAX_CELLS) {
        const fallback = escapeHtml(mode === 'new' ? String(afterText ?? '') : String(beforeText ?? ''));
        return fallback.length > 0 ? fallback : '&nbsp;';
    }
    const operations = buildLineDiffOperations(beforeTokens, afterTokens);
    const chunks = [];
    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const tokenText = escapeHtml(String((Array.isArray(operation?.lines) ? operation.lines : []).join('')));
        if (!tokenText) {
            continue;
        }
        if (type === 'equal') {
            chunks.push(tokenText);
            continue;
        }
        if (type === 'delete') {
            if (mode === 'old') {
                chunks.push(`<span class="luker_orch_line_diff_word_del">${tokenText}</span>`);
            }
            continue;
        }
        if (type === 'insert') {
            if (mode === 'new') {
                chunks.push(`<span class="luker_orch_line_diff_word_add">${tokenText}</span>`);
            }
        }
    }
    return chunks.length > 0 ? chunks.join('') : '&nbsp;';
}

function buildIterationLineDiffVisualRows(operations) {
    const rows = [];
    let beforeLineNo = 1;
    let afterLineNo = 1;
    const appendRow = (rowType, oldLine, oldHtml, newLine, newHtml) => {
        rows.push({
            rowType: String(rowType || ''),
            oldLine: String(oldLine || ''),
            oldHtml: String(oldHtml || '&nbsp;'),
            newLine: String(newLine || ''),
            newHtml: String(newHtml || '&nbsp;'),
        });
    };

    const safeOperations = Array.isArray(operations) ? operations : [];
    for (let index = 0; index < safeOperations.length; index++) {
        const operation = safeOperations[index];
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        const nextOperation = safeOperations[index + 1];
        if (type === 'delete' && String(nextOperation?.type || '') === 'insert') {
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'luker_orch_line_diff_row_mod',
                    String(beforeLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'old'),
                    String(afterLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'new'),
                );
                beforeLineNo += 1;
                afterLineNo += 1;
            }
            for (let i = pairCount; i < lines.length; i++) {
                const text = escapeHtml(String(lines[i] ?? '')) || '&nbsp;';
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('luker_orch_line_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('luker_orch_line_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

function renderIterationLineDiffSideRowsHtml(rows, side = 'old') {
    const safeRows = Array.isArray(rows) ? rows : [];
    const isOldSide = side !== 'new';
    return safeRows.map((row) => `
<tr class="luker_orch_line_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="luker_orch_line_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="luker_orch_line_diff_text ${isOldSide ? 'old' : 'new'}"><div class="luker_orch_line_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
}

function renderIterationLineDiffHtml(beforeValue, afterValue, fileLabel = 'field') {
    const payload = buildLineDiffRows(
        sanitizeDiffPlaceholderValue(beforeValue),
        sanitizeDiffPlaceholderValue(afterValue),
    );
    const summary = i18nFormat('Line diff (+${0} -${1})', payload.added, payload.removed);
    const safeLabel = escapeHtml(String(fileLabel || 'field'));
    const renderedRows = buildIterationLineDiffVisualRows(payload.operations);
    const expandLabel = escapeHtml(i18n('Expand diff'));
    const resizeLabel = escapeHtml(i18n('Resize diff columns'));
    return `
<details class="luker_orch_line_diff"${payload.openByDefault ? ' open' : ''}>
    <summary>
        <span class="luker_orch_line_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="luker_orch_line_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_expand_btn" data-luker-orch-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>
    </summary>
    <div class="luker_orch_line_diff_pre" data-luker-orch-diff-label="${safeLabel}">
        <div class="luker_orch_line_diff_dual" role="group">
            <div class="luker_orch_line_diff_side old">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table old" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="luker_orch_line_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="luker_orch_line_diff_side new">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table new" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
}

function closeOrchExpandedDiff(rootElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    if (!(root instanceof HTMLElement)) {
        return;
    }
    root.querySelectorAll('.luker_orch_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

function openOrchExpandedDiff(rootElement, triggerElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    const trigger = triggerElement instanceof Element ? triggerElement : null;
    const diffRoot = trigger?.closest?.('.luker_orch_line_diff');
    const diffBody = diffRoot?.querySelector?.('.luker_orch_line_diff_pre');
    if (!(root instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    closeOrchExpandedDiff(root);

    const diffLabel = String(diffBody.getAttribute('data-luker-orch-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'luker_orch_line_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="luker_orch_line_diff_zoom_backdrop" data-luker-orch-action="close-line-diff-zoom"></div>
<div class="luker_orch_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="luker_orch_line_diff_zoom_header">
        <div class="luker_orch_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_zoom_close" data-luker-orch-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="luker_orch_line_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.luker_orch_line_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    root.append(overlay);
}

function beginOrchLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.luker_orch_line_diff_dual');
    if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
        return;
    }

    pointer.preventDefault();
    pointer.stopPropagation();

    const bounds = dual.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
        return;
    }

    const minPercent = 15;
    const maxPercent = 85;
    const pointerId = pointer.pointerId;

    const applySplitAt = (clientX) => {
        const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
        dual.style.setProperty('--luker-orch-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Ignore release errors when capture was not acquired.
        }
    };

    const handlePointerMove = (moveEvent) => {
        if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
            return;
        }
        moveEvent.preventDefault();
        applySplitAt(moveEvent.clientX);
    };

    const handlePointerUp = (upEvent) => {
        if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
            return;
        }
        upEvent.preventDefault();
        cleanup();
    };

    splitter.classList.add('active');
    applySplitAt(pointer.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    try {
        splitter.setPointerCapture(pointerId);
    } catch {
        // Pointer capture may fail in some browsers and is optional here.
    }
}

function buildAgendaIterationPendingDiffState(session, pending) {
    const entries = [];
    const workingProfile = sanitizeAgendaWorkingProfile(session?.workingProfile);

    for (const call of Array.isArray(pending?.toolCalls) ? pending.toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const item = {
            name,
            summary: '',
            fields: [],
            rawArgs: args,
        };

        if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') {
            const beforePlanner = createAgendaPlannerDraft(workingProfile.planner);
            const afterPlanner = createAgendaPlannerDraft({
                ...beforePlanner,
                ...(Object.prototype.hasOwnProperty.call(args, 'systemPrompt')
                    ? { systemPrompt: String(args.systemPrompt || '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'userPromptTemplate') || Object.prototype.hasOwnProperty.call(args, 'plannerPrompt')
                    ? { userPromptTemplate: String(args.userPromptTemplate ?? args.plannerPrompt ?? '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            item.summary = 'Agenda planner updated';
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforePlanner.systemPrompt),
                after: formatDiffValue(afterPlanner.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforePlanner.userPromptTemplate),
                after: formatDiffValue(afterPlanner.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforePlanner)),
                after: formatDiffValue(getPresetApiPresetName(afterPlanner)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforePlanner)),
                after: formatDiffValue(getPresetPromptPresetName(afterPlanner)),
            });
            workingProfile.planner = afterPlanner;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            const beforeAgent = agentId ? structuredClone(workingProfile.agents[agentId] || null) : null;
            const afterAgent = createPresetDraft({
                ...(beforeAgent || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            if (agentId) {
                workingProfile.agents[agentId] = afterAgent;
            }
            item.summary = agentId
                ? `Agenda agent "${agentId}" ${beforeAgent ? 'updated' : 'created'}`
                : 'Agenda agent update skipped (missing agent_id)';
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforeAgent?.systemPrompt || ''),
                after: formatDiffValue(afterAgent.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforeAgent?.userPromptTemplate || ''),
                after: formatDiffValue(afterAgent.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforeAgent)),
                after: formatDiffValue(getPresetApiPresetName(afterAgent)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforeAgent)),
                after: formatDiffValue(getPresetPromptPresetName(afterAgent)),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            const existed = agentId ? structuredClone(workingProfile.agents[agentId] || null) : null;
            if (agentId && workingProfile.agents[agentId]) {
                delete workingProfile.agents[agentId];
            }
            const normalized = sanitizeAgendaWorkingProfile(workingProfile);
            workingProfile.planner = normalized.planner;
            workingProfile.agents = normalized.agents;
            workingProfile.finalAgentId = normalized.finalAgentId;
            workingProfile.limits = normalized.limits;
            item.summary = agentId
                ? `Agenda agent "${agentId}" ${existed ? 'removed' : 'remove skipped'}`
                : 'Agenda agent removal skipped (missing agent_id)';
            item.fields.push({
                label: 'result',
                before: existed ? 'exists' : '',
                after: existed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_final_agent') {
            const nextAgentId = sanitizeIdentifierToken(args.agent_id, '');
            item.summary = nextAgentId
                ? 'Agenda final agent updated'
                : 'Agenda final agent update skipped (missing agent_id)';
            item.fields.push({
                label: 'finalAgentId',
                before: formatDiffValue(workingProfile.finalAgentId),
                after: formatDiffValue(nextAgentId),
            });
            if (nextAgentId) {
                workingProfile.finalAgentId = nextAgentId;
            }
            const normalized = sanitizeAgendaWorkingProfile(workingProfile);
            workingProfile.finalAgentId = normalized.finalAgentId;
            workingProfile.agents = normalized.agents;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_limits') {
            const nextLimits = {
                plannerMaxRounds: args.planner_max_rounds ?? workingProfile.limits.plannerMaxRounds,
                maxConcurrentAgents: args.max_concurrent_agents ?? workingProfile.limits.maxConcurrentAgents,
                maxTotalRuns: args.max_total_runs ?? workingProfile.limits.maxTotalRuns,
            };
            const normalized = sanitizeAgendaWorkingProfile({
                ...workingProfile,
                limits: nextLimits,
            });
            item.summary = 'Agenda runtime limits updated';
            item.fields.push({
                label: 'plannerMaxRounds',
                before: formatDiffValue(String(workingProfile.limits.plannerMaxRounds)),
                after: formatDiffValue(String(normalized.limits.plannerMaxRounds)),
            });
            item.fields.push({
                label: 'maxConcurrentAgents',
                before: formatDiffValue(String(workingProfile.limits.maxConcurrentAgents)),
                after: formatDiffValue(String(normalized.limits.maxConcurrentAgents)),
            });
            item.fields.push({
                label: 'maxTotalRuns',
                before: formatDiffValue(String(workingProfile.limits.maxTotalRuns)),
                after: formatDiffValue(String(normalized.limits.maxTotalRuns)),
            });
            workingProfile.limits = normalized.limits;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_simulate') {
            item.summary = 'Run simulation';
            item.fields.push({
                label: 'simulation_text',
                before: '',
                after: formatDiffValue(args.simulation_text || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_finalize_iteration') {
            item.summary = 'Finalize iteration';
            item.fields.push({
                label: 'summary',
                before: '',
                after: formatDiffValue(args.summary || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_continue_iteration') {
            item.summary = 'Continue iteration';
            item.fields.push({
                label: 'note',
                before: '',
                after: formatDiffValue(args.note || ''),
            });
            entries.push(item);
            continue;
        }
    }

    return {
        entries,
        projectedProfile: sanitizeAgendaWorkingProfile(workingProfile),
    };
}

function buildAiIterationPendingDiffState(session, pending) {
    if (isAgendaIterationSession(session)) {
        return buildAgendaIterationPendingDiffState(session, pending);
    }
    const entries = [];
    const workingProfile = structuredClone(session?.workingProfile || { spec: { stages: [] }, presets: {} });
    const stages = Array.isArray(workingProfile?.spec?.stages) ? workingProfile.spec.stages : [];
    const presets = (workingProfile?.presets && typeof workingProfile.presets === 'object') ? workingProfile.presets : {};
    const pendingPresetRemovalEntries = new Map();

    for (const call of Array.isArray(pending?.toolCalls) ? pending.toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (!isAiIterationEditableToolCallName(name)) {
            continue;
        }
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const item = {
            name,
            summary: '',
            fields: [],
            rawArgs: args,
        };

        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            if (!stageId) {
                item.summary = 'Stage update skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const before = stages.find(stage => String(stage?.id || '') === stageId) || null;
            const beforeMode = before ? String(before.mode || 'serial') : '';
            const beforePosition = before ? stages.findIndex(stage => String(stage?.id || '') === stageId) : -1;

            let target = before;
            if (!target) {
                target = { id: stageId, mode, nodes: [] };
                stages.push(target);
            }
            target.mode = mode;
            const afterPositionTarget = stages.findIndex(stage => String(stage?.id || '') === stageId);
            applyIndexReorder(stages, afterPositionTarget, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const afterPosition = stages.findIndex(stage => String(stage?.id || '') === stageId);

            item.summary = stageId
                ? `Stage "${stageId}" ${before ? 'updated' : 'created'}`
                : 'Stage updated';
            item.fields.push({ label: 'mode', before: formatDiffValue(beforeMode), after: formatDiffValue(mode) });
            if (beforePosition !== afterPosition && beforePosition >= 0 && afterPosition >= 0) {
                item.fields.push({ label: 'position', before: String(beforePosition), after: String(afterPosition) });
            }
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                item.summary = 'Stage removal skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const index = stages.findIndex(stage => String(stage?.id || '') === stageId);
            const removed = index >= 0 ? structuredClone(stages[index]) : null;
            if (index >= 0) {
                stages.splice(index, 1);
            }
            item.summary = stageId
                ? `Stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`
                : 'Stage remove requested';
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node update skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, true);
            if (!stage) {
                item.summary = `Node "${nodeId}" update skipped (stage "${stageId}" invalid)`;
                entries.push(item);
                continue;
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            stage.nodes = nodes;
            const existingIndex = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const beforeNode = existingIndex >= 0 ? structuredClone(nodes[existingIndex]) : null;
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || 'distiller') || 'distiller';
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(beforeNode?.type);
            const afterUserPromptTemplate = typeof args.userPromptTemplate === 'string'
                ? normalizeTemplateForRuntime(args.userPromptTemplate)
                : (beforeNode ? String(beforeNode.userPromptTemplate || '') : '');
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: afterUserPromptTemplate,
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
            }

            item.summary = `Node "${nodeId}" in stage "${stageId}" ${beforeNode ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'preset',
                before: formatDiffValue(beforeNode?.preset || ''),
                after: formatDiffValue(presetId),
            });
            item.fields.push({
                label: 'type',
                before: formatDiffValue(normalizeNodeType(beforeNode?.type)),
                after: formatDiffValue(nextNodeType),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforeNode?.userPromptTemplate || ''),
                after: formatDiffValue(afterUserPromptTemplate),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node removal skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, false);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const index = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const removed = index >= 0 ? structuredClone(nodes[index]) : null;
            if (index >= 0) {
                nodes.splice(index, 1);
            }
            item.summary = `Node "${nodeId}" in stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`;
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset update skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            const queuedRemovalEntries = pendingPresetRemovalEntries.get(presetId) || [];
            for (const queuedItem of queuedRemovalEntries) {
                queuedItem.summary = `Preset "${presetId}" removal skipped (overridden by later preset update)`;
                queuedItem.fields = [{
                    label: 'result',
                    before: '',
                    after: 'unchanged',
                }];
            }
            pendingPresetRemovalEntries.delete(presetId);
            const beforePreset = presets[presetId] && typeof presets[presetId] === 'object'
                ? structuredClone(presets[presetId])
                : null;
            const afterPreset = createPresetDraft({
                ...(beforePreset || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            presets[presetId] = afterPreset;
            item.summary = `Preset "${presetId}" ${beforePreset ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforePreset?.systemPrompt || ''),
                after: formatDiffValue(afterPreset.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforePreset?.userPromptTemplate || ''),
                after: formatDiffValue(afterPreset.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforePreset)),
                after: formatDiffValue(getPresetApiPresetName(afterPreset)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforePreset)),
                after: formatDiffValue(getPresetPromptPresetName(afterPreset)),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset removal skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            item.summary = `Preset "${presetId}" removal requested`;
            item.fields.push({
                label: 'result',
                before: '',
                after: 'pending',
            });
            if (!pendingPresetRemovalEntries.has(presetId)) {
                pendingPresetRemovalEntries.set(presetId, []);
            }
            pendingPresetRemovalEntries.get(presetId).push(item);
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_simulate') {
            item.summary = 'Run simulation';
            item.fields.push({
                label: 'input',
                before: '',
                after: formatDiffValue(args.input || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_finalize_iteration') {
            item.summary = 'Finalize iteration';
            item.fields.push({
                label: 'summary',
                before: '',
                after: formatDiffValue(args.summary || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_continue_iteration') {
            item.summary = 'Continue iteration';
            item.fields.push({
                label: 'note',
                before: '',
                after: formatDiffValue(args.note || ''),
            });
            entries.push(item);
            continue;
        }

        item.summary = name || 'Unknown operation';
        entries.push(item);
    }

    for (const [presetId, queuedEntries] of pendingPresetRemovalEntries.entries()) {
        const presetExists = Boolean(presets[presetId] && typeof presets[presetId] === 'object');
        const inUse = isPresetReferencedInSpec(workingProfile?.spec, presetId);
        let summary = '';
        let before = '';
        let after = '';
        if (!presetExists) {
            summary = `Preset "${presetId}" remove skipped`;
            after = 'unchanged';
        } else if (inUse) {
            summary = `Preset "${presetId}" removal skipped (preset is still used by nodes)`;
            before = 'exists';
            after = 'unchanged';
        } else {
            delete presets[presetId];
            summary = `Preset "${presetId}" removed`;
            before = 'exists';
        }
        for (const queuedItem of queuedEntries) {
            queuedItem.summary = summary;
            queuedItem.fields = [{
                label: 'result',
                before,
                after,
            }];
        }
    }

    return {
        entries,
        projectedProfile: workingProfile,
    };
}

function renderAiIterationPendingApproval(session, popupId) {
    const pending = session?.pendingApproval;
    if (!pending) {
        return '';
    }
    const pendingMessage = findAiIterationMessageById(session?.messages, pending?.messageId);
    const pendingProfileDeltaHtml = pendingMessage?.profileDelta
        ? renderAiIterationProfileDeltaHtml(session?.mode, pendingMessage.profileDelta, pendingMessage?.profileSnapshotBefore || session?.workingProfile)
        : '';
    const summaryLines = summarizeIterationToolCalls(pending.toolCalls || []);
    const assistantText = stripIterationThoughtForDisplay(pending.assistantText || '');
    return `
<div class="luker-studio-pending">
    <div class="luker-studio-panel-title">${escapeHtml(i18n('Pending approval'))}</div>
    <div class="luker-studio-pending-hint">${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>
    ${assistantText ? `<div class="luker-studio-pending-text">${escapeHtml(assistantText)}</div>` : ''}
    <div class="luker-studio-pending-ops">
        ${summaryLines.length > 0 ? summaryLines.map(item => `<div class="luker-studio-pending-op">${escapeHtml(item)}</div>`).join('') : `<div class="luker-studio-pending-op">${escapeHtml(i18n('No editable operations were produced.'))}</div>`}
    </div>
    ${pendingProfileDeltaHtml ? `
    <details class="luker-studio-pending-diff" open>
        <summary>${escapeHtml(i18n('Pending changes diff'))}</summary>
        <div class="luker-studio-diff">
            ${pendingProfileDeltaHtml}
        </div>
    </details>` : ''}
    <div class="luker-studio-pending-actions">
        <div id="${popupId}_approve" class="menu_button">${escapeHtml(i18n('Approve changes'))}</div>
        <div id="${popupId}_reject" class="menu_button">${escapeHtml(i18n('Reject changes'))}</div>
    </div>
</div>`;
}

function renderAgendaIterationWorkingProfile(session, { profileOverride = null, previewPending = false } = {}) {
    const profile = sanitizeAgendaWorkingProfile(
        profileOverride && typeof profileOverride === 'object'
            ? profileOverride
            : session?.workingProfile,
    );
    const planner = createAgendaPlannerDraft(profile?.planner);
    const agentCards = Object.entries(profile?.agents || {})
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([agentId, preset]) => `
<div class="luker_orch_iter_stage">
    <div class="luker_orch_iter_stage_title">${escapeHtml(agentId)}</div>
    <div class="luker_orch_iter_stage_mode">${escapeHtml(agentId === profile.finalAgentId ? i18n('Final Agent') : i18n('Worker'))}</div>
    <div class="luker_orch_iter_preset_line"><b>API:</b> ${escapeHtml(getPresetApiPresetName(preset) || i18n('(Global orchestration API preset)'))}</div>
    <div class="luker_orch_iter_preset_line"><b>Preset:</b> ${escapeHtml(getPresetPromptPresetName(preset) || i18n('(Current preset)'))}</div>
    <div class="luker_orch_iter_stage_nodes">${escapeHtml(truncateOrchestrationRuntimePreview(preset?.systemPrompt || '', 180) || '(empty)')}</div>
</div>`).join('');
    const simulationSummary = session?.lastSimulation
        ? `${i18n('Simulation')}: ${String(session.lastSimulation.summary || '')}`
        : '';
    return `
<div class="luker_orch_iter_profile_meta">
    <div><b>${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</b></div>
    <div>${escapeHtml(`Revision #${Number(session?.revision || 1)}`)}</div>
    ${previewPending ? `<div>${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>` : ''}
    ${simulationSummary ? `<div>${escapeHtml(simulationSummary)}</div>` : ''}
</div>
<div class="luker_orch_iter_preset_line"><b>Final agent:</b> ${escapeHtml(profile.finalAgentId || '(none)')}</div>
<div class="luker_orch_iter_preset_line"><b>Planner API:</b> ${escapeHtml(getPresetApiPresetName(planner) || i18n('(Global orchestration API preset)'))}</div>
<div class="luker_orch_iter_preset_line"><b>Planner preset:</b> ${escapeHtml(getPresetPromptPresetName(planner) || i18n('(Current preset)'))}</div>
<div class="luker_orch_iter_preset_line"><b>Limits:</b> ${escapeHtml(`rounds=${profile.limits.plannerMaxRounds}, concurrent=${profile.limits.maxConcurrentAgents}, totalRuns=${profile.limits.maxTotalRuns}`)}</div>
<details class="luker_orch_iter_diff_raw" open>
    <summary>${escapeHtml(i18n('Planner system prompt'))}</summary>
    <pre>${escapeHtml(planner.systemPrompt || '')}</pre>
</details>
<details class="luker_orch_iter_diff_raw" open>
    <summary>${escapeHtml(i18n('Planner Prompt'))}</summary>
    <pre>${escapeHtml(planner.userPromptTemplate || '')}</pre>
</details>
<div class="luker_orch_iter_stage_list">${agentCards || '<div class="luker_orch_iter_empty">(no agents)</div>'}</div>`;
}

function renderAiIterationWorkingProfile(session, { profileOverride = null, previewPending = false } = {}) {
    if (isAgendaIterationSession(session)) {
        return renderAgendaIterationWorkingProfile(session, { profileOverride, previewPending });
    }
    const profile = profileOverride && typeof profileOverride === 'object'
        ? profileOverride
        : (session?.workingProfile || {});
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const stageCards = stages.map((stage) => {
        const info = summarizeStageForUi(stage);
        return `
<div class="luker_orch_iter_stage">
    <div class="luker_orch_iter_stage_title">${escapeHtml(info.id || '(stage)')}</div>
    <div class="luker_orch_iter_stage_mode">${escapeHtml(info.mode)}</div>
    <div class="luker_orch_iter_stage_nodes">${escapeHtml(info.nodeSummary || '(no nodes)')}</div>
</div>`;
    }).join('');
    const presetIds = Object.keys(profile?.presets || {}).sort();
    const presetSummary = presetIds.length > 0
        ? presetIds.map((presetId) => {
            const apiPresetName = getPresetApiPresetName(profile?.presets?.[presetId]);
            const promptPresetName = getPresetPromptPresetName(profile?.presets?.[presetId]);
            const routes = [
                apiPresetName ? `api=${apiPresetName}` : '',
                promptPresetName ? `preset=${promptPresetName}` : '',
            ].filter(Boolean);
            return routes.length > 0
                ? `${presetId} -> ${routes.join(', ')}`
                : presetId;
        }).join(', ')
        : '(none)';
    const simulationSummary = session?.lastSimulation
        ? `${i18n('Simulation')}: ${String(session.lastSimulation.summary || '')}`
        : '';
    return `
<div class="luker_orch_iter_profile_meta">
    <div><b>${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</b></div>
    <div>${escapeHtml(`Revision #${Number(session?.revision || 1)}`)}</div>
    ${previewPending ? `<div>${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>` : ''}
    ${simulationSummary ? `<div>${escapeHtml(simulationSummary)}</div>` : ''}
</div>
<div class="luker_orch_iter_stage_list">${stageCards || '<div class="luker_orch_iter_empty">(no stages)</div>'}</div>
<div class="luker_orch_iter_preset_line"><b>Presets:</b> ${escapeHtml(presetSummary)}</div>`;
}

function buildAiIterationSystemPrompt(settings, session = null) {
    const base = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    if (isAgendaIterationSession(session)) {
        return [
            base,
            '',
            'Iteration mode contract:',
            '- You are editing an existing agenda orchestration profile incrementally.',
            '- The working profile contains a planner preset, agenda agents, finalAgentId, and runtime limits.',
            '- The planner preset and agenda agents may optionally set apiPresetName to use a specific Connection Manager profile.',
            '- Leave planner/agent apiPresetName empty unless the user explicitly asks for per-agent model/provider routing. Empty means fallback to the global orchestration API preset.',
            '- If you set planner/agent apiPresetName, use only a name from available_connection_profiles.',
            '- The planner preset and agenda agents may optionally set promptPresetName to use a specific chat completion preset.',
            '- Leave planner/agent promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing. Empty means fallback to the global orchestration chat completion preset.',
            '- If you set planner/agent promptPresetName, use only a name from available_chat_completion_presets.',
            '- Prefer targeted edits. Do not rewrite the full planner preset unless necessary.',
            '- Keep the planner preset as the main orchestration contract and keep agent prompts concrete and task-oriented.',
            '- Use luker_orch_set_agenda_planner to create or update the agenda planner preset.',
            '- Use luker_orch_set_agenda_agent to create or update one agenda agent at a time.',
            '- Use luker_orch_set_agenda_final_agent to point final output to an existing agent id.',
            '- Use luker_orch_set_agenda_limits only for real budget changes, not for stylistic edits.',
            '- If user asks to test, call luker_orch_simulate with suitable input.',
            '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
            '- If you need user decision or clarification, do not call continue or finalize. Stop and wait for user.',
            '- When iteration is complete, call luker_orch_finalize_iteration.',
            '- Keep output practical and concise for real RP usage.',
        ].join('\n');
    }
    return [
        base,
        '',
        'Iteration mode contract:',
        '- You are editing an existing orchestration profile incrementally (diff-style).',
        '- Prefer targeted edits. Do not rebuild everything unless the user explicitly asks.',
        '- Think through what to change and why before issuing tool calls; output format follows the current prompt policy.',
        '- Presets may optionally set apiPresetName to use a specific Connection Manager profile.',
        '- Leave preset apiPresetName empty unless the user explicitly asks for per-agent model/provider routing. Empty means fallback to the global orchestration API preset.',
        '- If you set preset apiPresetName, use only a name from available_connection_profiles.',
        '- Presets may optionally set promptPresetName to use a specific chat completion preset.',
        '- Leave preset promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing. Empty means fallback to the global orchestration chat completion preset.',
        '- If you set preset promptPresetName, use only a name from available_chat_completion_presets.',
        `- Runtime prepends previous orchestration result and approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` before node template text; do not use placeholders for that context.`,
        '- Treat the working profile as hierarchical layers. Preserve or improve that layering when editing.',
        `- Nodes can be worker or review. Review nodes inspect only the directly adjacent previous worker layer, may rerun only specific node ids from that layer, and must emit mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
        ...getCriticPromptReminderLines().map(line => `- ${line}`),
        `- Keep approved worker outputs as passthrough context after review; treat approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` as supplemental refinement, not a replacement summary.`,
        '- If more than one layer needs audit, insert multiple review stages after those specific layers instead of using one late critic for everything.',
        '- Prefer dedicated serial review stages immediately after the worker stages they audit. Do not place review nodes in the final stage.',
        '- Do not create back-to-back review stages or consecutive critics with no worker layer between them.',
        `- Use luker_orch_set_node.type to set "${ORCH_NODE_TYPE_REVIEW}" when a node should behave as a reviewer.`,
        '- If user asks to test, call luker_orch_simulate with suitable input.',
        '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
        '- If you need user decision or clarification, do not call continue/finalize. Stop and wait for user.',
        '- When iteration is complete, call luker_orch_finalize_iteration.',
        '- Keep output practical and concise for real RP usage.',
    ].join('\n');
}

function getGlobalIterationBaselineProfile(settings, session = null) {
    if (isAgendaIterationSession(session)) {
        return cloneAgendaWorkingProfileFromSettings(settings);
    }
    return {
        spec: sanitizeSpec(settings?.orchestrationSpec),
        presets: sanitizePresetMap(settings?.presets),
    };
}

function buildAiIterationUserPrompt(settings, session, userInputText, {
    globalProfile = null,
    sourceScope = '',
    sourceName = '',
} = {}) {
    if (isAgendaIterationSession(session)) {
        const recentConversation = (Array.isArray(session?.messages) ? session.messages : [])
            .map(item => `${String(item?.role || 'assistant').toUpperCase()}: ${String(item?.content || '')}`)
            .join('\n\n');
        const workingProfileValue = sanitizeAgendaWorkingProfile(session?.workingProfile);
        const globalProfileValue = sanitizeAgendaWorkingProfile(globalProfile);
        const latestSimulationText = stringifyIterationSimulationForPrompt(session?.lastSimulation);
        const latestSnapshotText = toReadableYamlText(normalizeOrchestrationSnapshot(latestOrchestrationSnapshot) || {}, '{}');
        return [
            '# iteration_input',
            'You are in a multi-turn agenda orchestration iteration session.',
            'Apply focused edits through tools only. Keep edits minimal and high-impact.',
            '',
            '## source_scope',
            String(sourceScope || session?.sourceScope || 'global'),
            '',
            '## source_name',
            String(sourceName || session?.sourceName || ''),
            '',
            '## global_profile_baseline',
            '```yaml',
            toReadableYamlText(globalProfileValue, '{}'),
            '```',
            '',
            '## working_profile',
            '```yaml',
            toReadableYamlText(workingProfileValue, '{}'),
            '```',
            '',
            '## agent_api_routing',
            '```yaml',
            toReadableYamlText(buildAgentApiRoutingPromptData(settings), '{}'),
            '```',
            '',
            '## agent_prompt_preset_routing',
            '```yaml',
            toReadableYamlText(buildAgentPromptPresetRoutingPromptData(getContext(), settings), '{}'),
            '```',
            '',
            '## conversation_history',
            '```text',
            recentConversation || '(empty)',
            '```',
            '',
            '## latest_simulation',
            '```text',
            latestSimulationText,
            '```',
            '',
            '## latest_orchestration_snapshot',
            '```yaml',
            latestSnapshotText,
            '```',
            '',
            '## user_request',
            String(userInputText || '').trim(),
        ].join('\n');
    }
    const recentConversation = (Array.isArray(session?.messages) ? session.messages : [])
        .map(item => `${String(item?.role || 'assistant').toUpperCase()}: ${String(item?.content || '')}`)
        .join('\n\n');
    const workingProfileValue = {
        spec: session?.workingProfile?.spec || { stages: [] },
        presets: session?.workingProfile?.presets || {},
    };
    const globalProfileValue = {
        spec: globalProfile?.spec || { stages: [] },
        presets: globalProfile?.presets || {},
    };
    const aiVisibleWorkingProfile = sanitizeProfileForAiPrompt(workingProfileValue);
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt(globalProfileValue);
    const latestSimulationText = stringifyIterationSimulationForPrompt(session?.lastSimulation);
    const latestSnapshotText = toReadableYamlText(normalizeOrchestrationSnapshot(latestOrchestrationSnapshot) || {}, '{}');
    return [
        '# iteration_input',
        'You are in a multi-turn orchestration iteration session.',
        'Apply focused edits through tools only. Keep edits minimal and high-impact.',
        'If source_scope is character, treat global_profile_baseline as canonical reference and keep character edits as targeted overrides.',
        '',
        '## source_scope',
        String(sourceScope || session?.sourceScope || 'global'),
        '',
        '## source_name',
        String(sourceName || session?.sourceName || ''),
        '',
        '## global_profile_baseline',
        '```yaml',
        toReadableYamlText(aiVisibleGlobalProfile, '{}'),
        '```',
        '',
        '## working_profile',
        '```yaml',
        toReadableYamlText(aiVisibleWorkingProfile, '{}'),
        '```',
        '',
        '## agent_api_routing',
        '```yaml',
        toReadableYamlText(buildAgentApiRoutingPromptData(settings), '{}'),
        '```',
        '',
        '## agent_prompt_preset_routing',
        '```yaml',
        toReadableYamlText(buildAgentPromptPresetRoutingPromptData(getContext(), settings), '{}'),
        '```',
        '',
        '## review_node_contract',
        '```yaml',
        toReadableYamlText({
            type_field: {
                worker: ORCH_NODE_TYPE_WORKER,
                review: ORCH_NODE_TYPE_REVIEW,
            },
            runtime_behavior: `Treat review nodes as auditing only the directly adjacent previous worker layer. They request rerun only for specific node ids from that adjacent layer when needed, and must emit mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\` on both approve and rerun decisions.`,
            downstream_behavior: `Later stages keep receiving passthrough worker outputs plus approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\`; critic/review nodes do not replace them with summaries.`,
            topology_rule: 'Prefer dedicated serial review stages immediately after the workers being audited. If multiple layers need audit, add multiple review stages. Do not place review nodes in the final stage or back-to-back with another review stage.',
            ...getCriticReviewNodeContractShape(),
        }, '{}'),
        '```',
        '',
        '## conversation_history',
        '```text',
        recentConversation || '(empty)',
        '```',
        '',
        '## latest_simulation',
        '```text',
        latestSimulationText,
        '```',
        '',
        '## latest_orchestration_snapshot',
        '```yaml',
        latestSnapshotText,
        '```',
        '',
        '## user_request',
        String(userInputText || '').trim(),
    ].join('\n');
}

function buildAiIterationToolSet(session = null) {
    if (isAgendaIterationSession(session)) {
        return [
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_planner',
                    description: 'Create or update the agenda planner preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests planner-specific routing.',
                    parameters: {
                        type: 'object',
                        properties: {
                            systemPrompt: { type: 'string' },
                            userPromptTemplate: { type: 'string' },
                            apiPresetName: { type: 'string' },
                            promptPresetName: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_agent',
                    description: 'Create or update one agenda agent preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests per-agent routing.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                            systemPrompt: { type: 'string' },
                            userPromptTemplate: { type: 'string' },
                            apiPresetName: { type: 'string' },
                            promptPresetName: { type: 'string' },
                        },
                        required: ['agent_id', 'systemPrompt', 'userPromptTemplate'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_remove_agenda_agent',
                    description: 'Remove one agenda agent by id.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                        },
                        required: ['agent_id'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_final_agent',
                    description: 'Set which existing agenda agent should be used for final synthesis.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                        },
                        required: ['agent_id'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_limits',
                    description: 'Update agenda runtime limits.',
                    parameters: {
                        type: 'object',
                        properties: {
                            planner_max_rounds: { type: 'integer' },
                            max_concurrent_agents: { type: 'integer' },
                            max_total_runs: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_simulate',
                    description: 'Run orchestration simulation against recent chat messages or a custom user message.',
                    parameters: {
                        type: 'object',
                        properties: {
                            recent_messages_n: { type: 'integer' },
                            simulation_text: { type: 'string' },
                            trigger: { type: 'string', enum: ['normal', 'regenerate', 'continue'] },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_continue_iteration',
                    description: 'Request one automatic follow-up round after current tool execution.',
                    parameters: {
                        type: 'object',
                        properties: {
                            note: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_finalize_iteration',
                    description: 'Finalize this iteration turn with a concise summary.',
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
    return [
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_stage',
                description: 'Create or update one stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        mode: { type: 'string', enum: ['serial', 'parallel'] },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'mode'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_stage',
                description: 'Remove one stage by id.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                    },
                    required: ['stage_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_node',
                description: 'Create or update one node inside a stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                        preset: { type: 'string' },
                        type: { type: 'string', enum: [ORCH_NODE_TYPE_WORKER, ORCH_NODE_TYPE_REVIEW] },
                        userPromptTemplate: { type: 'string' },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_node',
                description: 'Remove one node from a stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_preset',
                description: 'Create or update one preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests per-agent routing.',
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
                name: 'luker_orch_remove_preset',
                description: 'Remove one preset by id. Preset in use by nodes cannot be removed.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                    },
                    required: ['preset_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_simulate',
                description: 'Run orchestration simulation against recent chat messages or a custom user message.',
                parameters: {
                    type: 'object',
                    properties: {
                        recent_messages_n: { type: 'integer' },
                        simulation_text: { type: 'string' },
                        trigger: { type: 'string', enum: ['normal', 'regenerate', 'continue'] },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_continue_iteration',
                description: 'Request one automatic follow-up round after current tool execution.',
                parameters: {
                    type: 'object',
                    properties: {
                        note: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_iteration',
                description: 'Finalize this iteration turn with a concise summary.',
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

function getChatMessagesForSimulation(context, recentMessagesN) {
    const all = Array.isArray(context?.chat) ? context.chat : [];
    const n = Math.max(1, Math.min(60, Math.floor(Number(recentMessagesN) || 12)));
    return normalizeWorldInfoResolverMessages(all.slice(Math.max(0, all.length - n)));
}

async function runAiIterationSimulation(context, session, args = {}, abortSignal = null) {
    await loadOrchestratorChatState(context, { force: false });
    const snapshotBefore = normalizeOrchestrationSnapshot(latestOrchestrationSnapshot);
    const simulationMessages = getChatMessagesForSimulation(context, args.recent_messages_n);
    const customText = String(args.simulation_text || '').trim();
    if (customText) {
        simulationMessages.push({
            role: 'user',
            is_user: true,
            name: String(context?.name1 || 'User'),
            mes: customText,
            content: customText,
        });
    }
    if (simulationMessages.length === 0) {
        return {
            ok: false,
            summary: 'No messages available for simulation.',
            detail: {},
        };
    }
    const profile = isAgendaIterationSession(session)
        ? buildAgendaProfileForRuntime(session?.workingProfile)
        : {
            spec: sanitizeSpec(session?.workingProfile?.spec),
            presets: sanitizePresetMap(session?.workingProfile?.presets),
        };
    const payload = {
        type: String(args?.trigger || 'normal').trim().toLowerCase() || 'normal',
        coreChat: simulationMessages,
        signal: abortSignal,
        forceWorldInfoResimulate: true,
    };
    let run = null;
    try {
        run = await runOrchestration(context, payload, structuredClone(simulationMessages), profile);
    } finally {
        latestOrchestrationSnapshot = snapshotBefore ? structuredClone(snapshotBefore) : null;
    }
    if (isAgendaIterationSession(session)) {
        const agendaState = run?.agendaState && typeof run.agendaState === 'object' ? run.agendaState : {};
        return {
            ok: true,
            summary: `Simulated agenda: ${Number(agendaState?.plannerRounds || 0)} planner rounds, ${Array.isArray(agendaState?.runs) ? agendaState.runs.length : 0} runs.`,
            detail: {
                planner_rounds: Number(agendaState?.plannerRounds || 0),
                todo_count: Array.isArray(agendaState?.todos) ? agendaState.todos.length : 0,
                run_count: Array.isArray(agendaState?.runs) ? agendaState.runs.length : 0,
                final_guidance: String(agendaState?.finalGuidance || ''),
                agenda_state: agendaState,
                input: {
                    recent_messages_n: Math.max(1, Math.min(60, Math.floor(Number(args?.recent_messages_n) || 12))),
                    simulation_text_used: Boolean(customText),
                },
            },
        };
    }
    const allStageOutputs = compactStageOutputs(run?.stageOutputs || []);
    const finalStage = getFinalStageSnapshot(run?.stageOutputs || []);
    const finalNodes = Array.isArray(finalStage?.nodes) ? finalStage.nodes : [];
    return {
        ok: true,
        summary: `Simulated ${Number(run?.stageOutputs?.length || 0)} stages with ${finalNodes.length} final outputs.`,
        detail: {
            stage_count: Number(run?.stageOutputs?.length || 0),
            final_stage_id: String(finalStage?.id || ''),
            final_stage_mode: String(finalStage?.mode || 'serial'),
            all_stage_outputs: allStageOutputs,
            input: {
                recent_messages_n: Math.max(1, Math.min(60, Math.floor(Number(args?.recent_messages_n) || 12))),
                simulation_text_used: Boolean(customText),
            },
        },
    };
}

function resolveIterationStage(session, stageId, createIfMissing = false) {
    const safeId = sanitizeIdentifierToken(stageId, '');
    if (!safeId) {
        return null;
    }
    const stages = session?.workingProfile?.spec?.stages || [];
    let stage = stages.find(item => String(item?.id || '') === safeId) || null;
    if (!stage && createIfMissing) {
        stage = { id: safeId, mode: 'serial', nodes: [] };
        stages.push(stage);
    }
    return stage;
}

function applyIndexReorder(list, currentIndex, position) {
    if (!Array.isArray(list) || currentIndex < 0 || currentIndex >= list.length) {
        return;
    }
    if (!Number.isInteger(position)) {
        return;
    }
    const targetIndex = Math.max(0, Math.min(list.length - 1, position));
    if (targetIndex === currentIndex) {
        return;
    }
    const [item] = list.splice(currentIndex, 1);
    list.splice(targetIndex, 0, item);
}

function buildFriendlyIterationExecutionSummary(result) {
    const lines = [];
    const actionCount = Array.isArray(result?.actions) ? result.actions.length : 0;
    if (actionCount > 0) {
        lines.push(`已执行 ${actionCount} 项操作。`);
    }
    const simulations = Array.isArray(result?.simulations) ? result.simulations : [];
    if (simulations.length > 0) {
        for (const sim of simulations) {
            lines.push(String(sim?.summary || '模拟已执行。'));
        }
    }
    if (result?.finalizeSummary) {
        lines.push(`总结：${String(result.finalizeSummary)}`);
    }
    return lines.join('\n').trim() || '已执行。';
}

async function executeAgendaIterationToolCalls(context, session, toolCalls, abortSignal = null) {
    const actions = [];
    const simulations = [];
    const toolResults = [];
    let finalized = false;
    let finalizeSummary = '';
    let continueRequested = false;
    let changed = false;
    session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const pushToolResult = (payload) => {
            toolResults.push({
                tool_call_id: callId,
                content: serializeToolResultContent(payload),
            });
        };
        if (!name) {
            continue;
        }
        if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') {
            session.workingProfile.planner = createAgendaPlannerDraft({
                ...session.workingProfile.planner,
                ...(Object.prototype.hasOwnProperty.call(args, 'systemPrompt')
                    ? { systemPrompt: String(args.systemPrompt || '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'userPromptTemplate') || Object.prototype.hasOwnProperty.call(args, 'plannerPrompt')
                    ? { userPromptTemplate: String(args.userPromptTemplate ?? args.plannerPrompt ?? '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = 'Agenda planner updated.';
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda agent update: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const beforeAgent = session.workingProfile.agents[agentId] || null;
            session.workingProfile.agents[agentId] = createPresetDraft({
                ...(beforeAgent || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = `Agenda agent "${agentId}" updated.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda agent removal: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            if (!session.workingProfile.agents[agentId]) {
                const actionText = `Skipped agenda agent removal: "${agentId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, agent_id: agentId });
                continue;
            }
            delete session.workingProfile.agents[agentId];
            session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
            const actionText = `Agenda agent "${agentId}" removed.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_final_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda final agent update: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            session.workingProfile.finalAgentId = agentId;
            session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
            if (String(session.workingProfile.finalAgentId || '') !== agentId) {
                const actionText = `Skipped agenda final agent update: "${agentId}" is not available.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, agent_id: agentId });
                continue;
            }
            const actionText = `Agenda final agent set to "${agentId}".`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_limits') {
            session.workingProfile = sanitizeAgendaWorkingProfile({
                ...session.workingProfile,
                limits: {
                    plannerMaxRounds: args.planner_max_rounds ?? session.workingProfile.limits.plannerMaxRounds,
                    maxConcurrentAgents: args.max_concurrent_agents ?? session.workingProfile.limits.maxConcurrentAgents,
                    maxTotalRuns: args.max_total_runs ?? session.workingProfile.limits.maxTotalRuns,
                },
            });
            const actionText = 'Agenda runtime limits updated.';
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_simulate') {
            const simulation = await runAiIterationSimulation(context, session, args, abortSignal);
            simulations.push(simulation);
            session.lastSimulation = simulation;
            const actionText = simulation.ok
                ? `Simulation finished: ${simulation.summary}`
                : `Simulation failed: ${simulation.summary}`;
            actions.push(actionText);
            pushToolResult({
                ok: Boolean(simulation?.ok),
                action: actionText,
                simulation,
            });
            continue;
        }
        if (name === 'luker_orch_continue_iteration') {
            continueRequested = true;
            const note = String(args.note || '').trim();
            const actionText = `Continue requested.${note ? ` ${note}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                continueRequested: true,
                note,
            });
            continue;
        }
        if (name === 'luker_orch_finalize_iteration') {
            finalized = true;
            finalizeSummary = String(args.summary || '').trim();
            const actionText = `Iteration finalized.${finalizeSummary ? ` ${finalizeSummary}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                finalized: true,
                summary: finalizeSummary,
            });
            continue;
        }
        const actionText = `Ignored unknown action: ${name}`;
        actions.push(actionText);
        pushToolResult({ ok: false, ignored: true, action: actionText });
    }

    session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
    session.revision = Number(session.revision || 0) + (changed ? 1 : 0);
    session.updatedAt = Date.now();
    trimAiIterationMessages(session);

    return {
        actions,
        simulations,
        toolResults,
        finalized,
        finalizeSummary,
        continueRequested,
        changed,
    };
}

async function executeAiIterationToolCalls(context, session, toolCalls, abortSignal = null) {
    if (isAgendaIterationSession(session)) {
        return executeAgendaIterationToolCalls(context, session, toolCalls, abortSignal);
    }
    const actions = [];
    const simulations = [];
    const toolResults = [];
    let finalized = false;
    let finalizeSummary = '';
    let continueRequested = false;
    let changed = false;
    const allowedPresetFallback = Object.keys(session?.workingProfile?.presets || {})[0] || 'distiller';
    const pendingPresetRemovalActions = new Map();
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const pushToolResult = (payload) => {
            toolResults.push({
                tool_call_id: callId,
                content: serializeToolResultContent(payload),
            });
        };
        if (!name) {
            continue;
        }
        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                const actionText = 'Skipped stage update: missing stage_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            const stage = resolveIterationStage(session, stageId, true);
            stage.mode = mode;
            if (!Array.isArray(stage.nodes)) {
                stage.nodes = [];
            }
            const stages = session.workingProfile.spec.stages;
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            applyIndexReorder(stages, index, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const actionText = `Stage "${stageId}" updated (${mode}).`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId, mode });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const stages = session?.workingProfile?.spec?.stages || [];
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            if (index >= 0) {
                stages.splice(index, 1);
                const actionText = `Stage "${stageId}" removed.`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId });
                changed = true;
            } else {
                const actionText = `Skipped stage removal: "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId });
            }
            continue;
        }
        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                const actionText = 'Skipped node update: missing stage_id or node_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const stage = resolveIterationStage(session, stageId, true);
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || allowedPresetFallback) || allowedPresetFallback;
            if (!session.workingProfile.presets[presetId]) {
                session.workingProfile.presets[presetId] = createPresetDraft();
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            const existingIndex = nodes.findIndex(item => String(item?.id || '') === nodeId);
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(existingIndex >= 0 ? nodes[existingIndex]?.type : ORCH_NODE_TYPE_WORKER);
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: typeof args.userPromptTemplate === 'string'
                    ? normalizeTemplateForRuntime(args.userPromptTemplate)
                    : (existingIndex >= 0 ? String(nodes[existingIndex]?.userPromptTemplate || '') : ''),
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" updated in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" added to stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            }
            stage.nodes = nodes;
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            const stage = resolveIterationStage(session, stageId, false);
            if (!stage || !Array.isArray(stage.nodes)) {
                const actionText = `Skipped node removal: stage "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId, node_id: nodeId });
                continue;
            }
            const index = stage.nodes.findIndex(item => String(item?.id || '') === nodeId);
            if (index >= 0) {
                stage.nodes.splice(index, 1);
                const actionText = `Node "${nodeId}" removed from stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId, node_id: nodeId });
                changed = true;
            } else {
                const actionText = `Skipped node removal: "${nodeId}" not found in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId, node_id: nodeId });
            }
            continue;
        }
        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                const actionText = 'Skipped preset update: missing preset_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const queuedRemovalActionIndexes = pendingPresetRemovalActions.get(presetId) || [];
            for (const actionIndex of queuedRemovalActionIndexes) {
                if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                    const actionText = `Skipped preset removal: "${presetId}" overridden by later preset update.`;
                    actions[actionIndex] = actionText;
                    if (toolResults[actionIndex]) {
                        toolResults[actionIndex].content = serializeToolResultContent({
                            ok: false,
                            error: actionText,
                            preset_id: presetId,
                        });
                    }
                }
            }
            pendingPresetRemovalActions.delete(presetId);
            const beforePreset = session.workingProfile.presets[presetId] || null;
            session.workingProfile.presets[presetId] = createPresetDraft({
                ...(beforePreset || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = `Preset "${presetId}" updated.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, preset_id: presetId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                const actionText = `Skipped preset removal: "${presetId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, preset_id: presetId });
                continue;
            }
            if (!pendingPresetRemovalActions.has(presetId)) {
                pendingPresetRemovalActions.set(presetId, []);
            }
            const actionText = `Preset "${presetId}" removal requested.`;
            actions.push(actionText);
            pendingPresetRemovalActions.get(presetId).push(actions.length - 1);
            pushToolResult({ ok: true, action: actionText, preset_id: presetId });
            continue;
        }
        if (name === 'luker_orch_simulate') {
            const simulation = await runAiIterationSimulation(context, session, args, abortSignal);
            simulations.push(simulation);
            session.lastSimulation = simulation;
            const actionText = simulation.ok
                ? `Simulation finished: ${simulation.summary}`
                : `Simulation failed: ${simulation.summary}`;
            actions.push(actionText);
            pushToolResult({
                ok: Boolean(simulation?.ok),
                action: actionText,
                simulation,
            });
            continue;
        }
        if (name === 'luker_orch_continue_iteration') {
            continueRequested = true;
            const note = String(args.note || '').trim();
            const actionText = `Continue requested.${note ? ` ${note}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                continueRequested: true,
                note,
            });
            continue;
        }
        if (name === 'luker_orch_finalize_iteration') {
            finalized = true;
            finalizeSummary = String(args.summary || '').trim();
            const actionText = `Iteration finalized.${finalizeSummary ? ` ${finalizeSummary}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                finalized: true,
                summary: finalizeSummary,
            });
            continue;
        }
        const actionText = `Ignored unknown action: ${name}`;
        actions.push(actionText);
        pushToolResult({ ok: false, ignored: true, action: actionText });
    }

    for (const [presetId, actionIndexes] of pendingPresetRemovalActions.entries()) {
        const presetExists = Boolean(session?.workingProfile?.presets?.[presetId]);
        const inUse = isPresetReferencedInSpec(session?.workingProfile?.spec, presetId);
        let message = '';
        if (!presetExists) {
            message = `Skipped preset removal: "${presetId}" not found.`;
        } else if (inUse) {
            message = `Skipped preset removal: "${presetId}" is still used by nodes.`;
        } else {
            delete session.workingProfile.presets[presetId];
            message = `Preset "${presetId}" removed.`;
            changed = true;
        }
        for (const actionIndex of actionIndexes) {
            if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                actions[actionIndex] = message;
                if (toolResults[actionIndex]) {
                    toolResults[actionIndex].content = serializeToolResultContent({
                        ok: !message.startsWith('Skipped'),
                        action: message,
                        ...(message.startsWith('Skipped') ? { error: message } : { changed: true }),
                        preset_id: presetId,
                    });
                }
            }
        }
    }

    session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
    session.workingProfile.presets = sanitizePresetMap(session.workingProfile.presets);
    session.revision = Number(session.revision || 0) + (changed ? 1 : 0);
    session.updatedAt = Date.now();
    trimAiIterationMessages(session);

    return {
        actions,
        simulations,
        toolResults,
        finalized,
        finalizeSummary,
        continueRequested,
        changed,
    };
}

async function runAiIterationTurn(context, settings, session, userText, abortSignal = null, { auto = false, appendUserMessage = true } = {}) {
    const text = String(userText || '').trim();
    if (!text) {
        return { ok: false, message: 'empty_input' };
    }
    if (appendUserMessage) {
        session.messages.push({ role: 'user', content: text, auto: Boolean(auto), at: Date.now() });
        trimAiIterationMessages(session);
    }

    const aiSuggestApiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const suggestPresetName = String(settings.aiSuggestPresetName || '').trim();
    const aiSuggestProfileResolution = resolveChatCompletionRequestProfile({
        profileName: aiSuggestApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const api = aiSuggestProfileResolution.requestApi;
    const apiSettingsOverride = aiSuggestProfileResolution.apiSettingsOverride;
    const tools = buildAiIterationToolSet(session);
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const globalBaseline = getGlobalIterationBaselineProfile(settings, session);
    const beforeWorkingProfile = cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile);

    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        buildAiIterationSystemPrompt(settings, session),
        buildAiIterationUserPrompt(settings, session, text, {
            globalProfile: globalBaseline,
            sourceScope: String(session?.sourceScope || ''),
            sourceName: String(session?.sourceName || ''),
        }),
        {
            api,
            promptPresetName: suggestPresetName,
            worldInfoMessages: session.messages,
            historyMessages: buildPersistentToolHistoryMessages(session.messages),
        },
    );
    const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
        tools,
        allowedNames,
        llmPresetName: suggestPresetName,
        apiSettingsOverride,
        abortSignal,
        includeAssistantText: true,
        allowNoToolCalls: true,
        applyAgentTimeout: false,
    });
    const executionToolCalls = buildExecutionToolCalls(Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : []);
    const assistantText = stripIterationThoughtForDisplay(detailed?.assistantText || '');
    if (executionToolCalls.length === 0) {
        if (assistantText) {
            session.messages.push({
                role: 'assistant',
                content: assistantText,
                auto: Boolean(auto),
                at: Date.now(),
            });
            trimAiIterationMessages(session);
            session.pendingApproval = null;
            session.updatedAt = Date.now();
            return { ok: true, pending: false, textOnly: true };
        }
        throw new Error(i18n('Function output is invalid.'));
    }
    const split = splitAiIterationToolCallsForApproval(executionToolCalls);
    const persistentToolCalls = buildPersistentToolCallsFromRawCalls(split.allCalls);
    const visibleAssistantText = assistantText || buildToolCallSummary(persistentToolCalls);
    if (split.approvalCalls.length > 0) {
        const pendingSummary = i18n('AI suggested changes are waiting for approval.');
        const pendingDiffState = buildAiIterationPendingDiffState(session, {
            toolCalls: split.approvalCalls,
        });
        const pendingDiffPayload = buildAiIterationProfileDeltaPayload(
            session?.mode,
            beforeWorkingProfile,
            pendingDiffState.projectedProfile,
        );
        const assistantMessage = createPersistentToolTurnMessage({
            messageId: makeAiIterationMessageId(),
            assistantText: visibleAssistantText,
            toolCalls: persistentToolCalls,
            toolResults: buildPendingToolResults(persistentToolCalls, pendingSummary),
            toolSummary: pendingSummary,
            toolState: 'pending',
            auto: Boolean(auto),
            at: Date.now(),
            extra: {
                pendingToolCalls: structuredClone(split.approvalCalls),
                executionToolCalls: structuredClone(split.allCalls),
                profileSnapshotBefore: pendingDiffPayload.beforeProfile,
                profileDelta: pendingDiffPayload.delta,
                reverseProfileDelta: pendingDiffPayload.reverseDelta,
            },
        });
        session.messages.push(assistantMessage);
        trimAiIterationMessages(session);
        session.pendingApproval = {
            messageId: assistantMessage.id,
            assistantText: visibleAssistantText,
            toolCalls: split.approvalCalls,
            executionToolCalls: split.allCalls,
            createdAt: Date.now(),
        };
        session.updatedAt = Date.now();
        return { ok: true, pending: true };
    }

    const executionResult = await executeAiIterationToolCalls(context, session, split.allCalls, abortSignal);
    const completedDiffPayload = buildAiIterationProfileDeltaPayload(
        session?.mode,
        beforeWorkingProfile,
        session?.workingProfile,
    );
    session.messages.push(createPersistentToolTurnMessage({
        messageId: makeAiIterationMessageId(),
        assistantText: visibleAssistantText,
        toolCalls: persistentToolCalls,
        toolResults: Array.isArray(executionResult?.toolResults) ? executionResult.toolResults : [],
        toolSummary: buildFriendlyIterationExecutionSummary(executionResult),
        toolState: 'completed',
        auto: Boolean(auto),
        at: Date.now(),
        extra: {
            profileSnapshotBefore: completedDiffPayload.beforeProfile,
            profileDelta: completedDiffPayload.delta,
            reverseProfileDelta: completedDiffPayload.reverseDelta,
            profileSnapshotAfter: cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile),
            lastSimulationAfter: session?.lastSimulation ? structuredClone(session.lastSimulation) : null,
        },
    }));
    trimAiIterationMessages(session);
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return {
        ok: true,
        pending: false,
        autoApplied: true,
        executionResult,
    };
}

async function applyAiIterationSessionToGlobal(context, settings, session, root) {
    if (isAgendaIterationSession(session)) {
        const profile = sanitizeAgendaWorkingProfile(session?.workingProfile);
        settings.executionMode = ORCH_EXECUTION_MODE_AGENDA;
        settings.singleAgentModeEnabled = false;
        settings.agendaPlanner = createAgendaPlannerDraft(profile.planner);
        delete settings.agendaPlannerPrompt;
        settings.agendaAgents = sanitizePresetMap(profile.agents);
        settings.agendaFinalAgentId = sanitizeIdentifierToken(profile.finalAgentId, 'finalizer');
        settings.agendaPlannerMaxRounds = profile.limits.plannerMaxRounds;
        settings.agendaMaxConcurrentAgents = profile.limits.maxConcurrentAgents;
        settings.agendaMaxTotalRuns = profile.limits.maxTotalRuns;
        await saveSettings();
        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
        renderDynamicPanels(root, context);
        notifySuccess(i18n('Iteration session applied to global profile.'));
        updateUiStatus(i18n('Iteration session applied to global profile.'));
        return;
    }
    settings.orchestrationSpec = sanitizeSpec(session?.workingProfile?.spec);
    settings.presets = sanitizePresetMap(session?.workingProfile?.presets);
    await saveSettings();
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    renderDynamicPanels(root, context);
    notifySuccess(i18n('Iteration session applied to global profile.'));
    updateUiStatus(i18n('Iteration session applied to global profile.'));
}

async function applyAiIterationSessionToCharacter(context, settings, session, root) {
    if (isAgendaIterationSession(session)) {
        const avatar = String(getCurrentAvatar(context) || '').trim();
        if (!avatar) {
            notifyError(i18n('No character selected. Cannot apply to character override.'));
            return;
        }
        const importedEditor = {
            ...cloneAgendaWorkingProfileFromEditor(session?.workingProfile || {}),
            enabled: true,
            notes: '',
        };
        const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
            editor: importedEditor,
            forceEnabled: true,
        });
        if (!ok) {
            notifyError(i18n('Failed to persist character override.'));
            return;
        }
        uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
        ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
        renderDynamicPanels(root, context);
        const name = getCharacterDisplayNameByAvatar(context, avatar) || avatar;
        notifySuccess(i18nFormat('Iteration session applied to character override: ${0}.', name));
        updateUiStatus(i18nFormat('Iteration session applied to character override: ${0}.', name));
        return;
    }
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (!avatar) {
        notifyError(i18n('No character selected. Cannot apply to character override.'));
        return;
    }
    const importedEditor = createIterationEditorFromWorkingProfile(session?.workingProfile || {});
    const ok = await persistCharacterEditor(context, settings, avatar, {
        editor: {
            ...importedEditor,
            enabled: true,
            notes: '',
        },
        forceEnabled: true,
    });
    if (!ok) {
        notifyError(i18n('Failed to persist character override.'));
        return;
    }
    uiState.characterEditor = loadCharacterEditorState(context, avatar);
    ensureEditorIntegrity(uiState.characterEditor);
    renderDynamicPanels(root, context);
    const name = getCharacterDisplayNameByAvatar(context, avatar) || avatar;
    notifySuccess(i18nFormat('Iteration session applied to character override: ${0}.', name));
    updateUiStatus(i18nFormat('Iteration session applied to character override: ${0}.', name));
}

async function openAiIterationStudio(context, settings, root) {
    ensureStyles();
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const displayedScope = getDisplayedScope(context, settings);
    const historyScope = displayedScope === 'character' && activeAvatar ? 'character' : 'global';
    const enableSessionHistory = true;
    let historyState = createEmptyAiIterationHistoryState();
    try {
        historyState = await loadAiIterationHistoryStateForScope(context, {
            scope: historyScope,
            avatar: activeAvatar,
        });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load AI iteration history`, error);
    }
    const session = ensureAiIterationSession(context, settings, { forceNew: false });
    const currentIterationMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
    const latestSession = findLatestAiIterationHistorySessionByMode(historyState, currentIterationMode);
    if (latestSession) {
        replaceAiIterationSession(session, latestSession);
    } else {
        if (historyScope === 'character') {
            session.sourceAvatar = activeAvatar;
        }
        historyState = upsertAiIterationHistorySession(historyState, session);
        try {
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to initialize AI iteration history`, error);
        }
    }
    uiState.aiIterationSession = session;
    const popupId = `luker_orch_iter_popup_${Date.now()}`;
    const namespace = `.lukerOrchIter_${popupId}`;
    const selector = `#${popupId}`;
    const popupHtml = buildAiIterationPopupHtml({
        escapeHtml,
        i18n,
        i18nFormat,
    }, popupId, session, {
        allowCharacterApply: Boolean(activeAvatar),
        enableSessionHistory,
    });
    let isRunning = false;

    const persistSessionHistory = async () => {
        try {
            if (historyScope === 'character') {
                session.sourceAvatar = activeAvatar;
            }
            session.updatedAt = Date.now();
            historyState = upsertAiIterationHistorySession(historyState, session);
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to persist AI iteration history`, error);
        }
    };

    const rerender = () => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find(`#${popupId}_sub`).text(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')));
        popupRoot.find(`#${popupId}_conversation`).html(renderAiIterationConversation(session, {
            loading: isRunning,
            loadingText: i18n('AI iteration is running...'),
        }));
        popupRoot.find(`#${popupId}_pending`).html(renderAiIterationPendingApproval(session, popupId));
        popupRoot.find(`#${popupId}_profile`).html(renderAiIterationWorkingProfile(session, {
            profileOverride: null,
            previewPending: Boolean(session?.pendingApproval),
        }));
        popupRoot.find(`#${popupId}_history`).html(renderAiIterationSessionHistory(historyState, session?.id, session?.mode));
    };

    const setStatus = (text) => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find(`#${popupId}_status`).text(String(text || ''));
    };

    const resetCurrentSession = async () => {
        const nextSession = createAiIterationSession(context, settings);
        if (historyScope === 'character') {
            nextSession.sourceAvatar = activeAvatar;
        }
        replaceAiIterationSession(session, nextSession);
        uiState.aiIterationSession = session;
        await persistSessionHistory();
        rerender();
    };

    const loadSessionById = async (sessionId) => {
        const currentMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
        const stored = findAiIterationHistorySessionByMode(historyState, sessionId, currentMode);
        if (!stored) {
            return false;
        }
        replaceAiIterationSession(session, stored);
        uiState.aiIterationSession = session;
        await persistSessionHistory();
        rerender();
        return true;
    };

    const deleteSessionById = async (sessionId) => {
        const currentMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
        const stored = findAiIterationHistorySessionByMode(historyState, sessionId, currentMode);
        if (!stored) {
            return false;
        }
        historyState = deleteAiIterationHistorySession(historyState, sessionId);
        try {
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to delete AI iteration session`, error);
        }
        if (String(session?.id || '') === String(sessionId || '').trim()) {
            const fallback = findLatestAiIterationHistorySessionByMode(historyState, currentMode)
                || createAiIterationSession(context, settings);
            if (historyScope === 'character') {
                fallback.sourceAvatar = activeAvatar;
            }
            replaceAiIterationSession(session, fallback);
            uiState.aiIterationSession = session;
            await persistSessionHistory();
        }
        rerender();
    };

    const maybeRunAutoContinue = async (executionResult, controller, source = 'approved') => {
        if (!executionResult || typeof executionResult !== 'object') {
            return false;
        }
        if (executionResult.finalized) {
            setStatus(source === 'approved'
                ? i18n('Changes approved and applied.')
                : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        if (executionResult.continueRequested || (Array.isArray(executionResult.simulations) && executionResult.simulations.length > 0)) {
            setStatus(i18n('Running auto-continue...'));
            const autoPrompt = buildAiIterationAutoContinuePrompt(executionResult);
            const followUp = await runAiIterationTurn(context, settings, session, autoPrompt, controller.signal, {
                auto: true,
                appendUserMessage: false,
            });
            await persistSessionHistory();
            setStatus(followUp?.pending ? i18n('AI suggested changes are waiting for approval.') : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        return false;
    };

    const runVisibleIterationTurn = async (text, { appendUserMessage = true, loadingText = '' } = {}) => {
        const safeText = String(text || '').trim();
        if (!safeText) {
            return false;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return false;
        }
        const popupRoot = jQuery(selector);
        const input = popupRoot.find(`#${popupId}_input`);
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        if (appendUserMessage) {
            session.messages.push({ role: 'user', content: safeText, auto: false, at: Date.now() });
            trimAiIterationMessages(session);
            input.val('');
            await persistSessionHistory();
        }
        isRunning = true;
        rerender();
        setStatus(loadingText || i18n('AI iteration is running...'));
        try {
            const result = await runAiIterationTurn(context, settings, session, safeText, controller.signal, { appendUserMessage: false });
            await persistSessionHistory();
            if (result?.pending) {
                setStatus(i18n('AI suggested changes are waiting for approval.'));
            } else if (result?.autoApplied) {
                const didHandle = await maybeRunAutoContinue(result.executionResult, controller, 'auto');
                if (!didHandle) {
                    setStatus(i18n('AI iteration updated.'));
                }
            } else {
                setStatus(i18n('AI iteration updated.'));
            }
            rerender();
            return true;
        } catch (error) {
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
            return false;
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    };

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('AI Iteration Studio'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );

    jQuery(document).off(namespace);
    rerender();

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_send`, async function () {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        const input = popupRoot.find(`#${popupId}_input`);
        const text = String(input.val() || '').trim();
        if (!text) {
            return;
        }
        await runVisibleIterationTurn(text, {
            appendUserMessage: true,
            loadingText: i18n('AI iteration is running...'),
        });
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_stop`, function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            activeAiIterationAbortController.abort();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_clear`, function () {
        void (async () => {
            await resetCurrentSession();
            setStatus(i18n('Iteration session reset.'));
        })();
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        openOrchExpandedDiff(rootElement, this);
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="refresh-message"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const messageIndex = asFiniteInteger(this.getAttribute('data-luker-orch-message-index'), -1);
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= (session?.messages?.length || 0)) {
            return;
        }
        if (!canRefreshAiIterationAssistantMessage(session, messageIndex)) {
            return;
        }
        const userIndex = findPreviousAiIterationUserMessageIndex(session.messages, messageIndex);
        if (userIndex < 0) {
            return;
        }
        const userText = String(session.messages[userIndex]?.content || '').trim();
        session.messages.splice(messageIndex);
        restoreAiIterationSessionStateFromMessages(session);
        await persistSessionHistory();
        rerender();
        setStatus(i18n('Regenerating message...'));
        await runVisibleIterationTurn(userText, {
            appendUserMessage: false,
            loadingText: i18n('Regenerating message...'),
        });
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="rollback-message"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const messageIndex = asFiniteInteger(this.getAttribute('data-luker-orch-message-index'), -1);
        if (!canRollbackAiIterationAssistantMessage(session, messageIndex)) {
            return;
        }
        const removeFrom = getAiIterationRollbackStartIndex(session.messages, messageIndex);
        if (!Number.isInteger(removeFrom) || removeFrom < 0) {
            return;
        }
        session.messages.splice(removeFrom);
        restoreAiIterationSessionStateFromMessages(session);
        await persistSessionHistory();
        rerender();
        setStatus(i18n('Rolled back to selected round.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="close-line-diff-zoom"], ${selector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`keydown${namespace}`, function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const rootElement = document.querySelector(selector);
        const overlay = rootElement?.querySelector?.('.luker_orch_line_diff_zoom_overlay');
        if (!(overlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`pointerdown${namespace}`, `${selector} .luker_orch_line_diff_splitter`, function (event) {
        beginOrchLineDiffResize(this, event.originalEvent || event);
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_approve`, async function () {
        const pending = session?.pendingApproval;
        if (!pending) {
            return;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        isRunning = true;
        rerender();
        const pendingSnapshot = {
            messageId: String(pending.messageId || ''),
            assistantText: String(pending.assistantText || ''),
            toolCalls: Array.isArray(pending.toolCalls) ? structuredClone(pending.toolCalls) : [],
            executionToolCalls: Array.isArray(pending.executionToolCalls) ? structuredClone(pending.executionToolCalls) : [],
            createdAt: Number(pending.createdAt || Date.now()),
        };
        session.pendingApproval = null;
        rerender();
        setStatus(i18n('Applying approved changes...'));
        try {
            const executionToolCalls = pendingSnapshot.executionToolCalls.length > 0
                ? pendingSnapshot.executionToolCalls
                : pendingSnapshot.toolCalls;
            const result = await executeAiIterationToolCalls(context, session, executionToolCalls, controller.signal);
            const targetMessage = findAiIterationMessageById(session.messages, pendingSnapshot.messageId);
            if (targetMessage) {
                const completedDiffPayload = buildAiIterationProfileDeltaPayload(
                    session?.mode,
                    targetMessage?.profileSnapshotBefore || session?.baseWorkingProfile || session?.workingProfile,
                    session?.workingProfile,
                );
                targetMessage.tool_results = Array.isArray(result?.toolResults) ? result.toolResults : [];
                targetMessage.toolSummary = buildFriendlyIterationExecutionSummary(result);
                targetMessage.toolState = 'completed';
                targetMessage.profileSnapshotBefore = completedDiffPayload.beforeProfile;
                targetMessage.profileDelta = completedDiffPayload.delta;
                targetMessage.reverseProfileDelta = completedDiffPayload.reverseDelta;
                targetMessage.profileSnapshotAfter = cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile);
                targetMessage.lastSimulationAfter = session?.lastSimulation ? structuredClone(session.lastSimulation) : null;
            }
            trimAiIterationMessages(session);
            await persistSessionHistory();
            const didHandle = await maybeRunAutoContinue(result, controller, 'approved');
            if (!didHandle) {
                setStatus(i18n('Changes approved and applied. Waiting for your next instruction.'));
                rerender();
            }
        } catch (error) {
            if (!session.pendingApproval) {
                session.pendingApproval = pendingSnapshot;
                rerender();
            }
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_reject`, function () {
        if (!session?.pendingApproval) {
            return;
        }
        const pending = session.pendingApproval;
        session.pendingApproval = null;
        const targetMessage = findAiIterationMessageById(session.messages, pending?.messageId);
        if (targetMessage) {
            targetMessage.tool_results = buildRejectedToolResults(pending?.executionToolCalls || pending?.toolCalls || [], i18n('Changes rejected.'));
            targetMessage.toolSummary = i18n('Changes rejected.');
            targetMessage.toolState = 'rejected';
        }
        trimAiIterationMessages(session);
        void persistSessionHistory();
        setStatus(i18n('Changes rejected.'));
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_new_session`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        await resetCurrentSession();
        setStatus(i18n('New session created.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="load-session"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const sessionId = String(this.getAttribute('data-luker-orch-session-id') || '').trim();
        if (!sessionId) {
            return;
        }
        const loaded = await loadSessionById(sessionId);
        if (loaded) {
            setStatus(i18n('Session loaded.'));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="delete-session"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const sessionId = String(this.getAttribute('data-luker-orch-session-id') || '').trim();
        if (!sessionId) {
            return;
        }
        if (!window.confirm(i18n('Delete this saved session?'))) {
            return;
        }
        try {
            await deleteSessionById(sessionId);
            setStatus(i18n('Session deleted.'));
        } catch (error) {
            setStatus(i18nFormat('Delete session failed: ${0}', String(error?.message || error)));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_global`, async function () {
        await applyAiIterationSessionToGlobal(context, settings, session, root);
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_character`, async function () {
        await applyAiIterationSessionToCharacter(context, settings, session, root);
        rerender();
    });

    await popupPromise;
    jQuery(document).off(namespace);
}

function bindUi() {
    const context = getContext();
    const settings = getSettings();

    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    initializeUiState(context);
    root.find('#luker_orch_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_orch_execution_mode').val(getExecutionMode(settings));
    root.find('#luker_orch_single_agent_system_prompt').val(String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT));
    root.find('#luker_orch_single_agent_user_prompt').val(String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE));
    root.find('#luker_orch_llm_api_preset').val(String(settings.llmNodeApiPresetName || ''));
    root.find('#luker_orch_llm_preset').val(String(settings.llmNodePresetName || ''));
    root.find('#luker_orch_include_world_info').prop('checked', Boolean(settings.includeWorldInfoWithPreset));
    root.find('#luker_orch_ai_suggest_api_preset').val(String(settings.aiSuggestApiPresetName || ''));
    root.find('#luker_orch_ai_suggest_preset').val(String(settings.aiSuggestPresetName || ''));
    root.find('#luker_orch_ai_suggest_system_prompt').val(String(settings.aiSuggestSystemPrompt || ''));
    root.find('#luker_orch_max_recent_messages').val(String(settings.maxRecentMessages || 14));
    root.find('#luker_orch_node_iterations').val(String(settings.nodeIterationMaxRounds || 3));
    root.find('#luker_orch_review_reruns').val(String(settings.reviewRerunMaxRounds ?? 2));
    root.find('#luker_orch_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_orch_agent_timeout').val(String(settings.agentTimeoutSeconds ?? 0));
    root.find('#luker_orch_rpm_limit').val(settings.rpmLimit || 0);
    root.find('#luker_orch_capsule_position').val(String(Number(settings.capsuleInjectPosition)));
    root.find('#luker_orch_capsule_depth').val(String(Number(settings.capsuleInjectDepth || 0)));
    root.find('#luker_orch_capsule_role').val(String(Number(settings.capsuleInjectRole)));
    root.find('#luker_orch_capsule_custom_instruction').val(String(settings.capsuleCustomInstruction || ''));
    refreshOpenAIPresetSelectors(root, context, settings);
    renderDynamicPanels(root, context);

    root.off('.lukerOrch');
    jQuery(document).off('.lukerOrchEditor');

    root.on('input.lukerOrch', '#luker_orch_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_execution_mode', function () {
        settings.executionMode = normalizeExecutionMode(jQuery(this).val());
        settings.singleAgentModeEnabled = settings.executionMode === ORCH_EXECUTION_MODE_SINGLE;
        saveSettingsDebounced();
        renderDynamicPanels(root, context);
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_system_prompt', function () {
        settings.singleAgentSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_user_prompt', function () {
        settings.singleAgentUserPromptTemplate = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_api_preset, .luker_orch_editor_popup #luker_orch_agenda_planner_api_preset`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_prompt_preset, .luker_orch_editor_popup #luker_orch_agenda_planner_prompt_preset`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.promptPresetName = sanitizePromptPresetName(jQuery(this).val());
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_system_prompt, .luker_orch_editor_popup #luker_orch_agenda_planner_system_prompt`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.systemPrompt = String(jQuery(this).val() || '');
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_prompt, .luker_orch_editor_popup #luker_orch_agenda_planner_prompt`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.userPromptTemplate = String(jQuery(this).val() || '');
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_final_agent, .luker_orch_editor_popup #luker_orch_agenda_final_agent`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.finalAgentId = sanitizeIdentifierToken(jQuery(this).val(), editor.finalAgentId || 'finalizer');
        renderDynamicPanels(root, context);
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_rounds, .luker_orch_editor_popup #luker_orch_agenda_planner_rounds`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.plannerMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_max_concurrent, .luker_orch_editor_popup #luker_orch_agenda_max_concurrent`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.maxConcurrentAgents = Math.max(1, Math.min(12, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_max_total_runs, .luker_orch_editor_popup #luker_orch_agenda_max_total_runs`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.maxTotalRuns = Math.max(1, Math.min(200, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    root.on('change.lukerOrch', '#luker_orch_llm_api_preset', function () {
        settings.llmNodeApiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_preset', function () {
        settings.llmNodePresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_include_world_info', function () {
        settings.includeWorldInfoWithPreset = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_api_preset', function () {
        settings.aiSuggestApiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_preset', function () {
        settings.aiSuggestPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_ai_suggest_system_prompt', function () {
        settings.aiSuggestSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('click.lukerOrch', '#luker_orch_reset_ai_prompt', function () {
        if (!window.confirm(i18n('Reset AI build prompt to default? This will overwrite current AI build system prompt.'))) {
            return;
        }
        settings.aiSuggestSystemPrompt = getDefaultAiSuggestSystemPrompt();
        root.find('#luker_orch_ai_suggest_system_prompt').val(settings.aiSuggestSystemPrompt);
        saveSettingsDebounced();
        notifySuccess(i18n('Reset AI build prompt'));
    });

    root.on('change.lukerOrch', '#luker_orch_max_recent_messages', function () {
        settings.maxRecentMessages = Math.max(1, Math.min(80, Number(jQuery(this).val()) || 14));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_node_iterations', function () {
        settings.nodeIterationMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(jQuery(this).val()) || 3)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_review_reruns', function () {
        settings.reviewRerunMaxRounds = Math.max(0, Math.min(20, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_tool_retries', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_agent_timeout', function () {
        settings.agentTimeoutSeconds = Math.max(0, Math.min(3600, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_rpm_limit', function () {
        settings.rpmLimit = Math.max(0, Math.floor(Number(jQuery(this).val()) || 0));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_position', function () {
        settings.capsuleInjectPosition = normalizeCapsuleInjectPosition(jQuery(this).val());
        jQuery(this).val(String(settings.capsuleInjectPosition));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_depth', function () {
        settings.capsuleInjectDepth = Math.max(0, Math.min(10000, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_role', function () {
        const value = Number(jQuery(this).val());
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        settings.capsuleInjectRole = allowedRoles.includes(value) ? value : extension_prompt_roles.SYSTEM;
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_capsule_custom_instruction', function () {
        settings.capsuleCustomInstruction = String(jQuery(this).val() || '').trim();
        reapplyLatestCapsuleInjection(getContext());
        saveSettingsDebounced();
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-ai-goal-input], .luker_orch_editor_popup [data-luker-ai-goal-input]`, function () {
        uiState.aiGoal = String(jQuery(this).val() || '');
    });

    jQuery(document).on('input.lukerOrchEditor change.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-field], .luker_orch_editor_popup [data-luker-field]`, function () {
        const field = String(jQuery(this).data('luker-field') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (field.startsWith('stage-') && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            if (field === 'stage-id') {
                editor.spec.stages[stageIndex].id = String(jQuery(this).val() || '');
            } else if (field === 'stage-mode') {
                editor.spec.stages[stageIndex].mode = String(jQuery(this).val() || 'serial') === 'parallel' ? 'parallel' : 'serial';
            }
            return;
        }

        if (field.startsWith('node-') && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            const node = stage?.nodes?.[nodeIndex];
            if (!node) {
                return;
            }
            if (field === 'node-id') {
                node.id = String(jQuery(this).val() || '');
            } else if (field === 'node-preset') {
                node.preset = sanitizeIdentifierToken(jQuery(this).val(), pickDefaultPreset(editor));
            } else if (field === 'node-type') {
                node.type = normalizeNodeType(jQuery(this).val());
            } else if (field === 'node-template') {
                node.userPromptTemplate = String(jQuery(this).val() || '');
            }
            return;
        }

        if (field.startsWith('preset-') && presetId && editor.presets[presetId]) {
            const preset = editor.presets[presetId];
            if (field === 'preset-system-prompt') {
                preset.systemPrompt = String(jQuery(this).val() || '');
            } else if (field === 'preset-user-template') {
                preset.userPromptTemplate = String(jQuery(this).val() || '');
            } else if (field === 'preset-api-preset') {
                preset.apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
            } else if (field === 'preset-prompt-preset') {
                preset.promptPresetName = sanitizePromptPresetName(jQuery(this).val());
            }
        }
    });

    jQuery(document).on('input.lukerOrchEditor change.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-agenda-agent-field], .luker_orch_editor_popup [data-luker-agenda-agent-field]`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        const agentId = sanitizeIdentifierToken(jQuery(this).data('agent-id'), '');
        const field = String(jQuery(this).data('luker-agenda-agent-field') || '');
        if (!agentId || !editor.agents?.[agentId]) {
            return;
        }
        if (field === 'systemPrompt') {
            editor.agents[agentId].systemPrompt = String(jQuery(this).val() || '');
        } else if (field === 'userPromptTemplate') {
            editor.agents[agentId].userPromptTemplate = String(jQuery(this).val() || '');
        } else if (field === 'apiPresetName') {
            editor.agents[agentId].apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        } else if (field === 'promptPresetName') {
            editor.agents[agentId].promptPresetName = sanitizePromptPresetName(jQuery(this).val());
        }
    });

    jQuery(document).on('click.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-action], .luker_orch_editor_popup [data-luker-action]`, async function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);
        const explicitScope = getExplicitScopeFromElement(this);

        if (action === 'agenda-copy-from-spec') {
            const copyScope = getCopyScopeFromElement(this, context);
            const agendaEditor = getAgendaEditorByScope(copyScope);
            const sourceEditor = getEditorByScope(copyScope);
            copySpecPresetsIntoAgendaEditor(sourceEditor, agendaEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, copyScope);
            if (!explicitScope) {
                const persisted = await persistCopiedProfileTarget(context, settings, ORCH_EXECUTION_MODE_AGENDA, copyScope);
                if (!persisted) {
                    return;
                }
            }
            notifySuccess(i18n('Copied spec agents into agenda as a starting point.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'spec-copy-from-agenda') {
            const copyScope = getCopyScopeFromElement(this, context);
            const agendaEditor = getAgendaEditorByScope(copyScope);
            const targetEditor = getEditorByScope(copyScope);
            copyAgendaAgentsIntoSpecEditor(agendaEditor, targetEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, copyScope);
            if (!explicitScope) {
                const persisted = await persistCopiedProfileTarget(context, settings, ORCH_EXECUTION_MODE_SPEC, copyScope);
                if (!persisted) {
                    return;
                }
            }
            notifySuccess(i18n('Copied agenda agents into spec presets and rebuilt stages as a starting point.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'agenda-agent-add') {
            const agendaScope = getAgendaScopeFromElement(this, context, settings);
            const agendaEditor = getAgendaEditorByScope(agendaScope);
            ensureAgendaEditorIntegrity(agendaEditor);
            const input = jQuery(this).closest('.luker_orch_preset_add_row').find('[data-luker-agenda-new-agent]');
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError(i18n('Preset ID cannot be empty.'));
                return;
            }
            if (agendaEditor.agents?.[candidate]) {
                notifyError(i18nFormat('Preset \'${0}\' already exists.', candidate));
                return;
            }
            agendaEditor.agents[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'agenda-agent-delete') {
            const agendaScope = getAgendaScopeFromElement(this, context, settings);
            const agendaEditor = getAgendaEditorByScope(agendaScope);
            ensureAgendaEditorIntegrity(agendaEditor);
            const agentId = sanitizeIdentifierToken(jQuery(this).data('agent-id'), '');
            if (!agentId || !agendaEditor.agents?.[agentId]) {
                return;
            }
            delete agendaEditor.agents[agentId];
            if (Object.keys(agendaEditor.agents).length === 0) {
                agendaEditor.agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
            }
            if (!agendaEditor.agents[agendaEditor.finalAgentId]) {
                agendaEditor.finalAgentId = Object.keys(agendaEditor.agents)[0] || '';
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-add') {
            editor.spec.stages.push(createNewStage(editor));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-delete' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            editor.spec.stages.splice(stageIndex, 1);
            if (editor.spec.stages.length === 0) {
                editor.spec.stages.push(createNewStage(editor));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-up' && Number.isInteger(stageIndex) && stageIndex > 0) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex - 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-down' && Number.isInteger(stageIndex) && stageIndex >= 0 && stageIndex < editor.spec.stages.length - 1) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex + 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-add' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            const defaultPreset = pickDefaultPreset(editor);
            editor.spec.stages[stageIndex].nodes.push({
                id: defaultPreset,
                preset: defaultPreset,
                type: ORCH_NODE_TYPE_WORKER,
                userPromptTemplate: '',
            });
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-delete' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            if (!stage?.nodes?.[nodeIndex]) {
                return;
            }
            stage.nodes.splice(nodeIndex, 1);
            if (stage.nodes.length === 0) {
                const defaultPreset = pickDefaultPreset(editor);
                stage.nodes.push({
                    id: defaultPreset,
                    preset: defaultPreset,
                    type: ORCH_NODE_TYPE_WORKER,
                    userPromptTemplate: '',
                });
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-up' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex) && nodeIndex > 0) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex - 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-down' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            if (nodeIndex < 0 || nodeIndex >= nodes.length - 1) {
                return;
            }
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex + 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-add') {
            const scopeRoot = jQuery(this).closest('[data-luker-scope-root]');
            const input = scopeRoot.find(`[data-luker-new-preset="${scope}"]`);
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError(i18n('Preset ID cannot be empty.'));
                return;
            }
            if (editor.presets[candidate]) {
                notifyError(i18nFormat('Preset \'${0}\' already exists.', candidate));
                return;
            }
            editor.presets[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-delete' && presetId) {
            if (!editor.presets[presetId]) {
                return;
            }
            if (isPresetUsed(editor, presetId)) {
                notifyError(i18nFormat('Preset \'${0}\' is still used by workflow nodes.', presetId));
                return;
            }
            delete editor.presets[presetId];
            ensureEditorIntegrity(editor);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reload-current') {
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                syncCharacterEditorWithActiveAvatar(context);
                const activeAvatar = String(getCurrentAvatar(context) || '').trim();
                if (hasCharacterAgendaOverride(context, activeAvatar)) {
                    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
                    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
                    updateUiStatus(i18nFormat('Reloaded character override for ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'));
                } else {
                    uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
                    updateUiStatus(i18n('Reloaded global profile from settings.'));
                }
                renderDynamicPanels(root, context);
                return;
            }
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (hasCharacterOverride(context, activeAvatar)) {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
                updateUiStatus(i18nFormat('Reloaded character override for ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'));
            } else {
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
                updateUiStatus(i18n('Reloaded global profile from settings.'));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reset-global') {
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                if (!window.confirm(i18n('Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.'))) {
                    return;
                }
                settings.executionMode = ORCH_EXECUTION_MODE_AGENDA;
                settings.singleAgentModeEnabled = false;
                settings.agendaPlanner = structuredClone(defaultAgendaPlanner);
                delete settings.agendaPlannerPrompt;
                settings.agendaAgents = sanitizePresetMap(defaultAgendaAgents);
                settings.agendaFinalAgentId = 'finalizer';
                settings.agendaPlannerMaxRounds = 6;
                settings.agendaMaxConcurrentAgents = 3;
                settings.agendaMaxTotalRuns = 24;
                await saveSettings();
                uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                renderDynamicPanels(root, context);
                notifySuccess(i18n('Global orchestration profile reset to defaults.'));
                updateUiStatus(i18n('Reset global profile to defaults.'));
                return;
            }
            if (!window.confirm(i18n('Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.'))) {
                return;
            }
            settings.orchestrationSpec = structuredClone(defaultSpec);
            settings.presets = structuredClone(defaultPresets);
            await saveSettings();
            uiState.globalEditor = loadGlobalEditorState();
            ensureEditorIntegrity(uiState.globalEditor);
            notifySuccess(i18n('Global orchestration profile reset to defaults.'));
            updateUiStatus(i18n('Reset global profile to defaults.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'save-global') {
            syncCharacterEditorWithActiveAvatar(context);
            const sourceScope = getDisplayedScope(context, settings);
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                const sourceEditor = getAgendaEditorByScope(sourceScope);
                await persistGlobalAgendaEditorFrom(settings, sourceEditor);
                uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
            } else {
                const sourceEditor = getEditorByScope(sourceScope);
                await persistGlobalEditorFrom(settings, sourceEditor);
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
            }
            notifySuccess(i18n('Global orchestration profile saved.'));
            updateUiStatus(i18n('Saved to global profile.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'export-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            const targetMode = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                ? ORCH_EXECUTION_MODE_AGENDA
                : ORCH_EXECUTION_MODE_SPEC;
            const scope = chooseProfileScopeByConfirm(context, 'Select export source: OK = global profile, Cancel = character override.');
            if (!scope) {
                return;
            }
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const safeName = sanitizeIdentifierToken(getCharacterDisplayNameByAvatar(context, avatar) || 'character', 'character');
            const payload = targetMode === ORCH_EXECUTION_MODE_AGENDA
                ? {
                    format: PORTABLE_PROFILE_FORMAT_V2,
                    mode: ORCH_EXECUTION_MODE_AGENDA,
                    scope,
                    exportedAt: new Date().toISOString(),
                    profile: createPortableAgendaProfileFromEditor(scope === 'global'
                        ? uiState.globalAgendaEditor
                        : uiState.characterAgendaEditor),
                }
                : {
                    format: PORTABLE_PROFILE_FORMAT_V1,
                    scope,
                    exportedAt: new Date().toISOString(),
                    profile: createPortableProfileFromEditor(scope === 'global'
                        ? uiState.globalEditor
                        : uiState.characterEditor),
                };
            const fileName = targetMode === ORCH_EXECUTION_MODE_AGENDA
                ? (scope === 'global'
                    ? 'luker-orchestrator-agenda-global.json'
                    : `luker-orchestrator-agenda-character-${safeName}.json`)
                : (scope === 'global'
                    ? 'luker-orchestrator-global.json'
                    : `luker-orchestrator-character-${safeName}.json`);
            downloadJsonFile(fileName, payload);
            if (scope === 'global') {
                notifySuccess(i18n('Exported global profile.'));
                updateUiStatus(i18n('Exported global profile.'));
            } else {
                notifySuccess(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                updateUiStatus(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            }
            return;
        }

        if (action === 'import-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            try {
                const fileText = await pickJsonFileText();
                if (!fileText) {
                    return;
                }
                const imported = parseImportedProfilePayload(fileText);
                const targetMode = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                    ? ORCH_EXECUTION_MODE_AGENDA
                    : ORCH_EXECUTION_MODE_SPEC;
                if (imported.mode !== targetMode) {
                    throw new Error(i18n('Imported profile does not match current execution mode.'));
                }
                const scope = chooseProfileScopeByConfirm(context, 'Select import target: OK = global profile, Cancel = character override.');
                if (!scope) {
                    return;
                }
                if (targetMode === ORCH_EXECUTION_MODE_AGENDA) {
                    if (scope === 'global') {
                        const profile = sanitizeAgendaWorkingProfile(imported.agenda);
                        settings.agendaPlanner = createAgendaPlannerDraft(profile.planner);
                        delete settings.agendaPlannerPrompt;
                        settings.agendaAgents = sanitizePresetMap(profile.agents);
                        settings.agendaFinalAgentId = sanitizeIdentifierToken(profile.finalAgentId, 'finalizer');
                        settings.agendaPlannerMaxRounds = profile.limits.plannerMaxRounds;
                        settings.agendaMaxConcurrentAgents = profile.limits.maxConcurrentAgents;
                        settings.agendaMaxTotalRuns = profile.limits.maxTotalRuns;
                        ensureSettings();
                        await saveSettings();
                        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
                        notifySuccess(i18n('Imported to global profile.'));
                        updateUiStatus(i18n('Imported to global profile.'));
                    } else {
                        const avatar = String(getCurrentAvatar(context) || '').trim();
                        if (!avatar) {
                            notifyError(i18n('No character selected.'));
                            return;
                        }
                        const importedEditor = {
                            planner: createAgendaPlannerDraft(imported.agenda.planner || {
                                userPromptTemplate: imported.agenda.plannerPrompt,
                            }),
                            agents: sanitizePresetMap(imported.agenda.agents),
                            finalAgentId: sanitizeIdentifierToken(imported.agenda.finalAgentId, 'finalizer'),
                            limits: {
                                plannerMaxRounds: imported.agenda.limits.plannerMaxRounds,
                                maxConcurrentAgents: imported.agenda.limits.maxConcurrentAgents,
                                maxTotalRuns: imported.agenda.limits.maxTotalRuns,
                            },
                            enabled: true,
                            notes: '',
                        };
                        const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
                            editor: importedEditor,
                            forceEnabled: true,
                        });
                        if (!ok) {
                            notifyError(i18n('Failed to persist character override.'));
                            return;
                        }
                        uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
                        ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
                        notifySuccess(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                        updateUiStatus(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                    }
                } else if (scope === 'global') {
                    settings.orchestrationSpec = sanitizeSpec(imported.spec);
                    settings.presets = sanitizePresetMap(imported.presets);
                    await saveSettings();
                    uiState.globalEditor = loadGlobalEditorState();
                    ensureEditorIntegrity(uiState.globalEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
                    notifySuccess(i18n('Imported to global profile.'));
                    updateUiStatus(i18n('Imported to global profile.'));
                } else {
                    const avatar = String(getCurrentAvatar(context) || '').trim();
                    if (!avatar) {
                        notifyError(i18n('No character selected.'));
                        return;
                    }
                    const importedEditor = {
                        spec: toEditableSpec(imported.spec, toEditablePresetMap(imported.presets)),
                        presets: toEditablePresetMap(imported.presets),
                        enabled: true,
                        notes: '',
                    };
                    const ok = await persistCharacterEditor(context, settings, avatar, {
                        editor: importedEditor,
                        forceEnabled: true,
                    });
                    if (!ok) {
                        notifyError(i18n('Failed to persist character override.'));
                        return;
                    }
                    uiState.characterEditor = loadCharacterEditorState(context, avatar);
                    ensureEditorIntegrity(uiState.characterEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
                    notifySuccess(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                    updateUiStatus(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                }
                renderDynamicPanels(root, context);
            } catch (error) {
                notifyError(i18nFormat('Import failed: ${0}', error?.message || error));
            }
            return;
        }

        if (action === 'save-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (!activeAvatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const sourceScope = getDisplayedScope(context, settings);
            const ok = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                ? await persistCharacterAgendaEditor(context, settings, activeAvatar, {
                    editor: getAgendaEditorByScope(sourceScope),
                    forceEnabled: sourceScope === 'character' ? null : true,
                })
                : await persistCharacterEditor(context, settings, activeAvatar, {
                    editor: getEditorByScope(sourceScope),
                    forceEnabled: sourceScope === 'character' ? null : true,
                });
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
                ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
            } else {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
            }
            notifySuccess(i18n('Character orchestration override saved.'));
            updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar)));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'clear-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const avatar = String(getCurrentAvatar(context) || '').trim();
            if (!avatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const characterIndex = getCharacterIndexByAvatar(context, avatar);
            if (characterIndex < 0) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const previous = getCharacterExtensionDataByAvatar(context, avatar);
            const nextPayload = { ...previous };
            const nextOverride = previous?.override && typeof previous.override === 'object'
                ? structuredClone(previous.override)
                : null;
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                if (nextOverride) {
                    delete nextOverride.agenda;
                }
            } else if (nextOverride) {
                delete nextOverride.spec;
                delete nextOverride.presets;
                delete nextOverride.presetPatch;
                delete nextOverride.enabled;
                delete nextOverride.updatedAt;
                delete nextOverride.name;
                delete nextOverride.notes;
            }
            normalizeCharacterOverrideMode(nextOverride);
            if (nextOverride && (
                (nextOverride.spec && typeof nextOverride.spec === 'object')
                || (nextOverride.presets && typeof nextOverride.presets === 'object')
                || (nextOverride.presetPatch && typeof nextOverride.presetPatch === 'object')
                || (nextOverride.agenda && typeof nextOverride.agenda === 'object')
            )) {
                nextPayload.override = nextOverride;
            } else {
                delete nextPayload.override;
            }
            const ok = await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
            applyCharacterExecutionModeForAvatar(context, settings, avatar);
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
                ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
            } else {
                uiState.characterEditor = loadCharacterEditorState(context, avatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
            }
            renderDynamicPanels(root, context);
            notifyInfo(i18n('Character orchestration override removed.'));
            updateUiStatus(i18nFormat('Removed character override for ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            return;
        }

        if (action === 'ai-suggest-character') {
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const displayName = avatar
                ? (getCharacterDisplayNameByAvatar(context, avatar) || i18n('(No character selected)'))
                : i18n('Global profile');
            const aiBuildAbortController = new AbortController();
            activeAiBuildAbortController = aiBuildAbortController;
            showAiBuildToast(i18nFormat('Generating orchestration profile for ${0}...', displayName), {
                stopLabel: i18n('Stop'),
                onStop: () => {
                    if (!aiBuildAbortController.signal.aborted) {
                        aiBuildAbortController.abort();
                    }
                },
            });
            try {
                const result = await runAiCharacterProfileBuild(context, settings, { abortSignal: aiBuildAbortController.signal });
                renderDynamicPanels(root, context);
                if (result?.scope === 'global') {
                    notifySuccess(i18n('Global orchestration profile generated by AI.'));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', i18n('Global profile')));
                } else {
                    notifySuccess(i18n('Character orchestration profile generated by AI.'));
                    const doneName = result?.name || getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', doneName));
                }
            } catch (error) {
                if (isAbortError(error, aiBuildAbortController.signal)) {
                    updateUiStatus(i18n('AI profile generation cancelled.'));
                } else {
                    notifyError(i18nFormat('AI profile generation failed: ${0}', error?.message || error));
                    updateUiStatus(i18n('AI profile generation failed.'));
                }
            } finally {
                if (activeAiBuildAbortController === aiBuildAbortController) {
                    activeAiBuildAbortController = null;
                }
                clearAiBuildToast();
            }
            return;
        }

        if (action === 'ai-iterate-open') {
            await openAiIterationStudio(context, settings, root);
            return;
        }

        if (action === 'view-last-run') {
            await openLastOrchestrationResult(context);
            return;
        }

        if (action === 'view-runtime-trace') {
            await openOrchestrationRuntimeTrace(context);
            return;
        }

        if (action === 'open-orch-editor') {
            await openOrchestrationEditorPopup(context, settings);
            return;
        }
    });
}

function ensureStyles() {
    if (jQuery(`#${ORCH_STYLE_ID}`).length) {
        return;
    }
    jQuery('head').append(`
<style id="${ORCH_STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${UI_BLOCK_ID} .luker_orch_board {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(160deg, rgba(29,46,39,0.28), rgba(21,31,43,0.2));
}
#${UI_BLOCK_ID} .luker_orch_button_disabled {
    opacity: 0.45;
    pointer-events: none;
}
#${UI_BLOCK_ID} .luker_orch_single_mode_tools {
    margin-top: 8px;
}
#${UI_BLOCK_ID} .luker_orch_state_summary {
    display: block;
    margin-top: 8px;
    opacity: 0.82;
}
.luker_orch_iter_popup {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.luker_orch_iter_profile {
    border: 1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent);
    border-radius: 8px;
    padding: 8px;
    background: color-mix(in oklab, var(--SmartThemeBodyColor) 5%, transparent);
    overflow: auto;
    min-height: 350px;
    max-height: 460px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}
.luker_orch_iter_empty {
    opacity: 0.8;
}
.luker_orch_iter_diff_popup {
    display: grid;
    gap: 10px;
    max-height: 72vh;
    overflow: auto;
    padding-right: 2px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}
.luker_orch_iter_diff_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    background: rgba(0,0,0,0.16);
    padding: 8px;
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff {
    display: grid;
    gap: 10px;
    font-size: 0.88rem;
    line-height: 1.45;
}
.luker_orch_iter_diff_popup .luker_object_diff_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.28));
    border-radius: 8px;
    background: rgba(0,0,0,0.14);
    padding: 8px;
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff_path {
    font-weight: 600;
    word-break: break-word;
}
.luker_orch_iter_diff_popup .luker_object_diff_grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff_col {
    min-width: 0;
    display: grid;
    gap: 6px;
    border-radius: 8px;
    padding: 8px;
    border-left: 3px solid transparent;
    background: rgba(255,255,255,0.04);
}
.luker_orch_iter_diff_popup .luker_object_diff_col.before {
    border-left-color: color-mix(in oklab, #f44336 68%, transparent);
    background: color-mix(in oklab, #f44336 10%, transparent);
}
.luker_orch_iter_diff_popup .luker_object_diff_col.after {
    border-left-color: color-mix(in oklab, #4caf50 68%, transparent);
    background: color-mix(in oklab, #4caf50 12%, transparent);
}
.luker_orch_iter_diff_popup .luker_object_diff_col_title {
    font-size: 0.9em;
    font-weight: 700;
    opacity: 0.82;
}
.luker_orch_iter_diff_popup .luker_object_diff_col pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
.luker_orch_iter_diff_popup .luker_object_diff_missing {
    opacity: 0.74;
    font-style: italic;
}
.luker_orch_iter_diff_popup .luker_object_diff_text {
    min-width: 0;
}
.luker_orch_iter_diff_popup .luker_object_diff_text .luker_orch_line_diff {
    margin: 0;
}
.luker_orch_iter_diff_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_iter_diff_fields {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_field {
    display: grid;
    gap: 6px;
}
.luker_orch_iter_diff_label {
    font-size: 0.92rem;
    opacity: 0.86;
}
.luker_orch_line_diff {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    border-radius: 6px;
    background: rgba(0,0,0,0.2);
}
.luker_orch_line_diff > summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    font-size: 0.9rem;
}
.luker_orch_line_diff_summary_main {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.luker_orch_line_diff_meta {
    opacity: 0.78;
    font-size: 0.88rem;
}
.luker_orch_line_diff_expand_btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_orch_line_diff_expand_btn i { pointer-events: none; }
.luker_orch_line_diff_pre {
    margin: 0;
    padding: 6px;
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    max-height: 320px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
}
.luker_orch_iter_grid,
.luker_orch_iter_col,
.luker_orch_iter_diff_popup,
.luker_orch_iter_diff_item,
.luker_orch_iter_diff_fields,
.luker_orch_iter_diff_field,
.luker_orch_line_diff,
.luker_orch_line_diff_pre { min-width: 0; max-width: 100%; box-sizing: border-box; }
.luker_orch_iter_conversation,
.luker_orch_iter_profile { -webkit-overflow-scrolling: touch; touch-action: pan-y; }
.luker_orch_line_diff_dual { --luker-orch-split-left: 50%; --luker-orch-splitter-width: 12px; display: grid; grid-template-columns: minmax(0, var(--luker-orch-split-left)) var(--luker-orch-splitter-width) minmax(0, calc(100% - var(--luker-orch-split-left) - var(--luker-orch-splitter-width))); gap: 0; width: 100%; min-width: 0; align-items: stretch; }
.luker_orch_line_diff_splitter { position: relative; cursor: col-resize; touch-action: none; user-select: none; background: transparent; }
.luker_orch_line_diff_splitter::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); border-radius: 999px; background: color-mix(in oklab, var(--SmartThemeBodyColor) 20%, transparent); transition: background-color .12s ease; }
.luker_orch_line_diff_splitter:hover::before,
.luker_orch_line_diff_splitter.active::before { background: color-mix(in oklab, var(--SmartThemeBodyColor) 38%, transparent); }
.luker_orch_line_diff_side { border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32)); border-radius: 6px; background: rgba(0,0,0,0.12); min-width: 0; overflow: hidden; }
.luker_orch_line_diff_side_scroll { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: auto; }
.luker_orch_line_diff_table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.82rem;
}
.luker_orch_line_diff_pre,
.luker_orch_line_diff_table,
.luker_orch_line_diff_row td,
.luker_orch_line_diff_text,
.luker_orch_line_diff_text_inner { text-align: left; }
.luker_orch_line_diff_row td {
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
    padding: 2px 6px;
    vertical-align: top;
}
.luker_orch_line_diff_row:last-child td { border-bottom: none; }
.luker_orch_line_diff_ln {
    width: 3.8em;
    text-align: right;
    color: color-mix(in oklab, var(--SmartThemeBodyColor) 72%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    position: sticky;
    left: 0;
    z-index: 3;
    background-color: var(--SmartThemeBlurTintColor);
    box-shadow: 1px 0 0 var(--SmartThemeBorderColor);
    background-image: none;
    opacity: 1;
}
.luker_orch_line_diff_text {
    width: auto;
    min-width: 0;
}
.luker_orch_line_diff_text_inner {
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
    user-select: text;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-width: max-content;
}
.luker_orch_line_diff_word_add {
    background: color-mix(in oklab, #4caf50 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_orch_line_diff_word_del {
    background: color-mix(in oklab, #d9534f 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_orch_line_diff_row_add .luker_orch_line_diff_text.new { background: color-mix(in oklab, #4caf50 12%, transparent); }
.luker_orch_line_diff_row_del .luker_orch_line_diff_text.old { background: color-mix(in oklab, #d9534f 12%, transparent); }
.luker_orch_line_diff_row_mod .luker_orch_line_diff_text.old { background: color-mix(in oklab, #d9534f 10%, transparent); }
.luker_orch_line_diff_row_mod .luker_orch_line_diff_text.new { background: color-mix(in oklab, #4caf50 10%, transparent); }
.luker_orch_line_diff_zoom_overlay {
    position: fixed;
    inset: 0;
    z-index: 10010;
    display: flex;
    align-items: center;
    justify-content: center;
}
.luker_orch_line_diff_zoom_backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, #000 70%, transparent);
}
.luker_orch_line_diff_zoom_dialog {
    position: relative;
    z-index: 1;
    width: min(1280px, 95vw);
    height: min(92vh, 920px);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 10px;
    background: var(--SmartThemeBlurTintColor);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(0,0,0,0.45);
}
.luker_orch_line_diff_zoom_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
}
.luker_orch_line_diff_zoom_title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.luker_orch_line_diff_zoom_close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_orch_line_diff_zoom_body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px;
}
.luker_orch_line_diff_zoom_body .luker_orch_line_diff_pre { max-height: none; height: auto; }
.luker_orch_iter_diff_raw summary {
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.9;
}
.luker_orch_iter_diff_raw pre {
    margin-top: 6px;
    margin-bottom: 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
    font-size: 0.84rem;
}
/* Runtime trace and last-run styles now use luker-studio classes from luker-studio.css */
.luker_orch_runtime_empty {
    opacity: 0.84;
    padding: 8px;
}
.luker_orch_kb_popup {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_list {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 10px;
    background: rgba(0,0,0,0.16);
    display: grid;
    gap: 8px;
}
.luker_orch_kb_card_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.luker_orch_kb_card_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_kb_meta_grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 6px 10px;
    font-size: 0.9rem;
    opacity: 0.92;
}
.luker_orch_kb_section {
    display: grid;
    gap: 6px;
}
.luker_orch_kb_section_title {
    font-weight: 600;
    font-size: 0.92rem;
}
.luker_orch_kb_tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.luker_orch_kb_tag {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(39, 117, 215, 0.16);
    border: 1px solid rgba(39, 117, 215, 0.35);
    font-size: 0.82rem;
}
.luker_orch_kb_empty {
    opacity: 0.8;
    font-size: 0.9rem;
}
.luker_orch_kb_sources {
    margin: 0;
    padding-left: 1.1em;
    display: grid;
    gap: 4px;
}
.luker_orch_kb_content {
    margin: 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.2);
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.38;
}
.luker_orch_iter_popup .menu_button,
.luker_orch_iter_popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.luker_orch_iter_empty {
    opacity: 0.8;
    font-size: 0.92rem;
}
.luker_orch_iter_profile_meta {
    display: grid;
    gap: 4px;
    margin-bottom: 8px;
}
.luker_orch_iter_stage_list {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_stage {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(255,255,255,0.02);
}
.luker_orch_iter_stage_title {
    font-weight: 600;
}
.luker_orch_iter_stage_mode {
    font-size: 0.82rem;
    opacity: 0.8;
    margin: 2px 0 4px;
}
.luker_orch_iter_stage_nodes {
    white-space: pre-wrap;
    word-break: break-word;
}
.luker_orch_iter_preset_line {
    margin-top: 10px;
    white-space: pre-wrap;
    word-break: break-word;
}
@media (max-width: 980px) {
    #${UI_BLOCK_ID} .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    #${UI_BLOCK_ID} .luker_orch_character_row {
        grid-template-columns: 1fr;
    }
    .luker_orch_editor_popup .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_col {
        min-height: 320px;
    }
    .luker_orch_line_diff_ln {
        width: 3.2em;
    }
}
</style>`);
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureStyles();

    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = buildOrchestratorSettingsHtml(getOrchestratorUiTemplateDeps());

    host.append(html);
    bindUi();
}

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    saveSettingsDebounced();
    clearCapsulePrompt(context);
    void loadOrchestratorChatState(context, { force: true }).finally(() => ensureUi());

    if (context.eventTypes.GENERATION_WORLD_INFO_FINALIZED) {
        context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, onWorldInfoFinalized);
    }
    if (context.eventTypes.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
    if (context.eventTypes.MESSAGE_EDITED) {
        context.eventSource.on(context.eventTypes.MESSAGE_EDITED, onMessageEdited);
    }
    if (context.eventTypes.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        const liveContext = getContext();
        abortActiveOrchestratorRun();
        loadedChatStateKey = '';
        latestOrchestrationSnapshot = null;
        latestOrchestrationHistoryIndex = null;
        clearLatestOrchestrationRuntimeTrace();
        clearCapsulePrompt(liveContext);
        void loadOrchestratorChatState(liveContext, { force: true }).finally(() => ensureUi());
    });
});
