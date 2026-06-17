/**
 * Static defaults + rule constants for the orchestrator extension.
 *
 * Owns the shipped default workflow (`defaultSpec`, `defaultPresets`,
 * `defaultAgendaAgents`, `defaultAgendaPlanner`) plus the seed
 * `defaultSettings` blob used by `ensureSettings` when a fresh chat
 * has no persisted config. Also holds the rule-text constants and
 * helpers used to build the AI-build system prompt — those live here
 * because the constants and helpers exist solely to seed
 * `defaultSettings.requestSystemPrompt`.
 *
 * Pure data + pure functions: no I/O, no side effects, no `extension_settings`
 * coupling. Constants that govern runtime control flow but aren't part of
 * any persisted default (template-var regexes, world-info position lists,
 * iteration history namespaces, etc.) intentionally stay in main.js for
 * now and will move into more specific modules in later refactors.
 */

const __ctx = Luker.getContext();
const extension_prompt_roles = __ctx.constants.promptRoles;
const world_info_position = __ctx.constants.wiPosition;

export const DEFAULT_CAPSULE_CUSTOM_INSTRUCTION = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';
export const DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT = 'You are a single-agent orchestration planner for roleplay generation. Produce concise, actionable guidance for the next reply while preserving continuity, character consistency, and world constraints. Before function-call output, provide one concise <thought>...</thought> that reflects your role-specific reasoning.';
export const DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE = [
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
export const ORCH_EXECUTION_MODE_SPEC = 'spec';
export const ORCH_EXECUTION_MODE_SINGLE = 'single';
export const ORCH_EXECUTION_MODE_AGENDA = 'agenda';
// Loop mode literal kept canonical here (matches `persistence.js`
// `ORCH_EXECUTION_MODE_LOOP`). Listed in `ORCH_EXECUTION_MODES` so
// `normalizeExecutionMode` accepts it; the loop profile schema and
// sanitizer live in `persistence.js` next to its floor-state binding.
export const ORCH_EXECUTION_MODE_LOOP = 'loop';
// Director mode literal + factory live in `director-defaults.js` so they can
// be imported by tests without dragging in the rest of this module's
// script.js / lib bundle chain. Re-exported here so callers reading the
// canonical defaults module still pick them up.
export {
    ORCH_EXECUTION_MODE_DIRECTOR,
    createDefaultDirectorProfile,
    getDirectorLimitBounds,
    sanitizeDirectorProfile,
} from './director-defaults.js';
import {
    ORCH_EXECUTION_MODE_DIRECTOR as _ORCH_EXECUTION_MODE_DIRECTOR,
    createFullDirectorProfile as _createFullDirectorProfile,
    createMinimalDirectorProfile as _createMinimalDirectorProfile,
} from './director-defaults.js';
export const ORCH_EXECUTION_MODES = Object.freeze([
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_EXECUTION_MODE_SINGLE,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_LOOP,
    _ORCH_EXECUTION_MODE_DIRECTOR,
]);
export const PORTABLE_PROFILE_FORMAT_V1 = 'luker_orchestrator_profile_v1';
export const PORTABLE_PROFILE_FORMAT_V2 = 'luker_orchestrator_profile_v2';
export const PORTABLE_PROFILE_FORMAT_V3 = 'luker_orchestrator_profile_v3';
export const PORTABLE_PROFILE_FORMAT_V4 = 'luker_orchestrator_profile_v4';
export const AGENDA_PLANNER_TOOL = 'luker_orch_planner_step';
export const AGENDA_RESULT_TOOL = 'luker_orch_submit_result';
export const DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT = 'You are an orchestration planner. Maintain a todo list, dispatch the minimum useful set of agents, read every returned result carefully, and stop when the final orchestration guidance is ready. Before the function call, provide one concise <thought>...</thought> that reflects current planning.';
export const DEFAULT_AGENDA_PLANNER_PROMPT = [
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
export const TEMPLATE_PLACEHOLDER_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller'];
export const AUTO_INJECTED_CONTEXT_VARS = ['previous_orchestration'];
export const LEGACY_REMOVED_CONTEXT_VARS = ['previous_snapshot'];
export const ALLOWED_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS, ...AUTO_INJECTED_CONTEXT_VARS, ...LEGACY_REMOVED_CONTEXT_VARS];
export const AI_VISIBLE_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS];
export const AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE = '(auto-injected above)';
export const AUTO_INJECTED_PLACEHOLDER_AI_NOTE = '(auto-injected by runtime before this template)';
export const AUTO_INJECTED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${AUTO_INJECTED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
export const LEGACY_REMOVED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${LEGACY_REMOVED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
export const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
export const CAPSULE_INJECT_POSITION_SCHEMA_VERSION = 2;
export const ORCH_NODE_TYPE_WORKER = 'worker';
export const ORCH_NODE_TYPE_REVIEW = 'review';
export const ORCH_REVIEW_TOOL_APPROVE = 'luker_orch_review_approve';
export const ORCH_REVIEW_TOOL_RERUN = 'luker_orch_request_rerun';
export const ORCH_REVIEW_FEEDBACK_FIELD = 'review_feedback';
export const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);
export const REQUIRED_AI_BUILD_NODE_IDS = ['lorebook_reader', 'anti_data_guard'];
export const ANTI_DATA_BLOCKED_LEXICON = [
    '观察', '分析', '评估', '统计', '监测', '检测', '实验', '推测', '记录', '汇报',
    'observation', 'analyze', 'analysis', 'evaluate', 'metric', 'kpi', 'ratio', 'probability',
];
export const ORCH_AI_QUALITY_AXES = {
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
export const ORCH_CRITIC_REQUIRED_GATES = Object.freeze([
    'continuity and timeline coherence',
    'causality and action-consequence coherence',
    'character/role consistency and anti-OOC drift',
    'active lorebook/world-info hard constraints',
    'anti-data/report-tone/weather-broadcast violations',
    'over-interpretation or unsupported escalation',
    'human realism and situational plausibility',
    'world autonomy and avoiding user-centric collapse',
]);
export const ORCH_CRITIC_PROMPT_AUTHORING_RULE = 'The critic/review preset itself must hardcode the review checklist and decision gate. Do not assume node.type, stage position, or preset name alone will make the model audit outputs.';
export const ORCH_CRITIC_CONSTRAINT_RESTATEMENT_RULE = 'Because critics do not see upstream worker prompt text at runtime, every critic/review preset must explicitly restate the audited layer\'s concrete pass/fail requirements, including worker-specific hard constraints, banned patterns, required preserved facts, and output obligations.';
export const ORCH_REVIEW_LAYERING_RULE = 'Treat orchestration as explicit hierarchical layers. A critic/review node audits only the immediately preceding worker layer, not the full earlier pipeline.';
export const ORCH_REVIEW_VISIBILITY_RULE = 'Critic visibility is local: do not make a critic depend on or audit non-adjacent earlier-stage nodes. If an older layer also needs review, add another critic immediately after that layer.';
export const ORCH_REVIEW_RERUN_SCOPE_RULE = 'A critic may request rerun only for the minimal specific worker node ids in the directly adjacent previous layer it audits.';
export const ORCH_REVIEW_MULTI_CRITIC_RULE = 'If multiple layers need review gates, insert critics after those specific layers as needed. Multiple critics are valid; do not collapse all review into one final critic.';
export const ORCH_REVIEW_REDUNDANCY_RULE = 'Do not place two critic/review stages or nodes back-to-back with no worker layer between them; adjacent critics are redundant and meaningless.';
export const ORCH_CRITIC_DECISION_RULE = `Approve only when every required gate passes. If any material issue exists, request rerun of the minimal specific worker node ids from the directly adjacent previous layer only. Every approve/rerun tool call must include mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`. Never emit synthesis, replacement guidance, or silent approval.`;

export function getCriticPromptReminderLines() {
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

export function getCriticReviewNodeContractShape() {
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

export const LOREBOOK_READ_GUIDANCE_LINES = Object.freeze([
    'You — the iteration AI — have editor-side lorebook tools to explore and edit the world books visible right now: read (world_book_list / lorebook_list / lorebook_query / lorebook_get) and write (lorebook_str_replace_in_entry / lorebook_update_entry, both propose-mode, user-approved). These serve YOUR audit and editing. They are NOT the runtime agent\'s tool surface. The runtime agent\'s lorebook surface is described in each mode block below; do not assume parity.',
    'Do NOT copy lorebook entry bodies into any field of the profile you edit. If a runtime agent needs an entry, design it to fetch the entry at runtime through its OWN tools (named in the mode block below); do not paste content.',
    'You MAY propose lorebook entry edits when an entry hard-constrains output in a way that conflicts with the orchestration you are designing. Classify each conflict before repairing: process coercion (directives that pin HOW the agent thinks during the run — every-round CoT templates, mandatory thinking blocks, "always check X before answering") versus final-output shape (directives that pin the FORM of the final committed reply — wrapping tags, closing recaps, "speak in poetry"). Process coercion poisons the agent loop and must be stripped, its cognitive intent harvested as worldbuilding / persona / scene-anchor content the agent reads as narrative input — not as a new rule. Final-output shape is legitimate and should be kept, rewritten to make the finalize semantics explicit so intermediate orchestration nodes stay free. Use `lorebook_str_replace_in_entry` for surgical clause-level edits that preserve the rest of the entry; reserve `lorebook_update_entry` with `{ "disable": true }` for entries that are pure format coercion with no salvageable content. Never delete entries. Both write tools are approval-gated: each call captures a {before, after} proposal envelope and returns it to you, while the popup renders a diff card the user reviews and approves or rejects. Nothing reaches the on-disk world book until the user approves the card AND clicks Apply. Treat your tool result as "captured for review", not as "applied" — your next round can keep designing without waiting for the disk write to land.',
]);

export function getDefaultRequestSystemPrompt() {
    // Mode-agnostic base — applies to spec / director / agenda / loop alike.
    // Spec-specific guidance lives in `SPEC_DEFAULT_GUIDANCE_LINES` below and
    // is prepended to the spec contract block in `buildAiIterationSystemPrompt`,
    // so director / agenda / loop never see the spec-isms (stages / nodes /
    // anti_data_guard / set_stage / placeholder rules / etc).
    //
    // `settings.requestSystemPrompt` overrides this generic base. If you
    // need to customize the spec-only guidance, that's currently hardcoded
    // — a future mode-edit feature will expose per-mode overrides.
    return [
        'You design AI orchestration profiles for an RP character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'Edit scope:',
        '- Match the user\'s edit scope. If they ask for a small adjustment ("punchier", "tighten", "5% shorter", "fix this one detail"), change only what that asks for; leave everything else byte-identical.',
        '- Do not delete, restructure, or rewrite parts of the profile the user did not name. When existing content already covers a topic the user just refined, keep its surroundings and edit in place.',
        '- Only rewrite broadly when the user explicitly asks for a rewrite / overhaul / redesign.',
        'Each preset / agent may optionally set apiPresetName to route through a specific Connection Manager profile. Leave empty unless the user explicitly asks for per-agent routing. Empty means fallback to the global orchestration API preset.',
        'If you set apiPresetName, use only names from available_connection_profiles.',
        'Each preset / agent may optionally set promptPresetName to route through a specific chat completion preset. Leave empty unless the user explicitly asks for per-agent routing. Empty means fallback to the global orchestration chat completion preset.',
        'If you set promptPresetName, use only names from available_chat_completion_presets.',
        'Do NOT hardcode any fixed narrator persona / identity / roleplay character in system prompts.',
        'Do NOT mirror long single-prompt identity blocks; focus on process quality and constraints.',
        'Runtime context guarantee: orchestration agents and final generation already see assembled preset / character card / world-info context.',
        'Do NOT repeat full character biography in agent / node prompts. Prefer compact behavior policy and decision criteria.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        'Flexibility policy: treat the provided blueprint as a strong baseline, not a prison.',
        'Multi-round iteration control: the popup auto-continues whenever you emit any tool call this round, so tool results become context for the next round. To end the iteration, respond with plain text and emit no tool calls.',
        'Batch independent edits in a single response. When the user request implies several independent changes (e.g. patch main prompt + edit a skill + flip a flag), emit all of them as parallel tool calls in one round rather than serializing one-per-round. Sequential rounds are only for changes whose later step truly depends on the earlier step\'s result (e.g. read a file, then patch based on what it said).',
    ].join('\n');
}

/**
 * Spec-mode-specific guidance — the stages / nodes / presets / anti_data_guard
 * / lorebook_reader / distiller / set_stage / placeholder-rules block that
 * USED to live inside `getDefaultRequestSystemPrompt`. Hoisted into its own
 * constant so it can be prepended to the spec contract block in
 * `buildAiIterationSystemPrompt` without polluting director / agenda / loop
 * modes (which have no concept of stages or `set_stage` and were getting
 * confused by these spec-only rules).
 *
 * Owned by spec mode. A future per-mode customization feature will let users
 * override this; for now it's hardcoded.
 */
export const SPEC_DEFAULT_GUIDANCE_LINES = Object.freeze([
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
    'Each node must have a distinct role, concrete output focus, and minimal overlap.',
    'Prefer practical distiller/planner/critic/synthesizer style agents and add custom presets only when necessary.',
    'Planner-like presets must not be thin "analyze and plan" prompts; give them explicit sequencing rules, evidence usage rules, branching discipline, and stop conditions.',
    'When you create a planner role, keep it self-contained and reusable as a dedicated preset rather than scattering planner logic across unrelated nodes.',
    'Require explicit hard-gate checks (consistency, OOC, causality, continuity, over-interpretation) in the critic review node.',
    'Hard requirement: include one dedicated node id "lorebook_reader" to explicitly study active lorebook/world-info constraints.',
    'Hard requirement: include one dedicated node id "anti_data_guard" to explicitly block data-like writing and metric-style phrasing.',
    `For anti_data_guard, enforce blocked lexicon as hard risk: ${ANTI_DATA_BLOCKED_LEXICON.join(', ')}.`,
    'For anti_data_guard, also hard-block detached report/bulletin cadence (e.g., weather-broadcast style flat narration).',
    'For anti_data_guard, avoid genre slogans and style branding; output hard compliance checks and rewrite rules only.',
    'Those two required nodes must exist even when you innovate other stage/node designs.',
    'Require final synthesizer output to be concise, actionable, and directly usable for drafting.',
    'You may innovate node roles/stage topology for this specific character card if quality improves.',
    'Any innovation must keep hard-gate coverage, causal clarity, and final-output contract intact.',
    `Allowed template placeholders ONLY: ${AI_VISIBLE_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
    'Do not invent any other placeholder names.',
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
    'Call luker_orch_set_stage one stage per call.',
    'luker_orch_set_stage arguments must be flat: stage_id, mode.',
    'Call luker_orch_set_preset one preset per call.',
    'Hard rule: one response must contain COMPLETE tool calls for this task. Do not stop after a single tool call.',
    'Hard rule: minimum 2 tool calls in one response, including at least one luker_orch_set_stage.',
]);

/**
 * Legacy default text used ONCE for migration detection. Returns the exact
 * full spec-flavored prompt that `getDefaultRequestSystemPrompt` produced
 * before the split. Match-and-clear logic in `main.js` extension-settings
 * init compares stored `settings.requestSystemPrompt` against this; an
 * exact match means "user never customized" and is safe to reset. Delete
 * this function one release after the migration has propagated.
 */
export function getLegacyDefaultRequestSystemPromptForMigration() {
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
        'Call luker_orch_set_stage one stage per call.',
        'luker_orch_set_stage arguments must be flat: stage_id, mode.',
        'Call luker_orch_set_preset one preset per call.',
        'Edit scope:',
        '- Match the user\'s edit scope. If they ask for a small adjustment ("punchier", "tighten", "5% shorter", "fix this one node"), change only what that asks for; leave everything else byte-identical.',
        '- Do not delete, restructure, or rewrite stages, nodes, or presets the user did not name. When existing content already covers a topic the user just refined, keep its surrounding structure and edit in place.',
        '- Only rewrite broadly when the user explicitly asks for a rewrite / overhaul / redesign.',
        'Hard rule: one response must contain COMPLETE tool calls for this task. Do not stop after a single tool call.',
        'Hard rule: minimum 2 tool calls in one response, including at least one luker_orch_set_stage.',
        'Multi-round iteration control: the popup auto-continues whenever you emit any tool call this round, so tool results become context for the next round. To end the iteration, respond with plain text and emit no tool calls.',
    ].join('\n');
}

export const defaultSpec = {
    stages: [
        { id: 'distill', mode: 'serial', nodes: ['distiller'] },
        { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
        { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
        { id: 'review', mode: 'serial', nodes: [{ id: 'critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
        { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
    ],
    defaultTools: null,
};

export const defaultPresets = {
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

export const defaultAgendaAgents = {
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

export const defaultAgendaPlanner = {
    systemPrompt: DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_AGENDA_PLANNER_PROMPT,
    apiPresetName: '',
    promptPresetName: '',
};

// Default loop profile system prompt — shipped as a starting point for
// users who switch to loop mode. The runtime sanitizer in
// `persistence.js::sanitizeLoopProfile` fills in the rest of the V3 shape
// (tool flags default-on, max_rounds=20, wall_clock=300000ms, finalize
// forced true). Keeping the default text terse and action-oriented matches
// the project's prompt-writing convention.
export const DEFAULT_LOOP_SYSTEM_PROMPT = [
    'You are a single-agent orchestration loop for roleplay generation.',
    'Use the available tools to gather only the context you actually need to draft compact orchestration guidance for the next reply.',
    'Prefer fewer, targeted tool calls over exhaustive exploration.',
    'Call finalize(capsule_text) with the final guidance text when you have enough — do NOT keep gathering once you can write a good capsule.',
    'Preserve continuity, character consistency, anti-OOC discipline, and active world-info constraints in the capsule.',
].join('\n');

export const defaultLoopProfile = {
    mode: ORCH_EXECUTION_MODE_LOOP,
    apiPresetName: '',
    promptPresetName: '',
    system_prompt: DEFAULT_LOOP_SYSTEM_PROMPT,
    tools: {
        note: { add: true },
        chat: { read_range: true, search: true },
        lorebook: { world_book_list: true, list: true, search: true, get: true },
        memory: {
            schema: true,
            list_candidates: true,
            edge_summary: true,
            node_brief: true,
            expand_seeds: true,
            keyword_search: true,
            vector_search: true,
            find_by_name: true,
            compaction_candidates: true,
            node_create: true,
            node_edit: true,
            node_delete: true,
            link_upsert: true,
            link_delete: true,
            compact_nodes: true,
        },
        search: { search: true, visit: true },
        finalize: true,
    },
    max_rounds: 20,
    wall_clock_budget_ms: 300000,
};

export const defaultSettings = {
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
    maxRecentMessages: 14,
    capsuleInjectPosition: world_info_position.atDepth,
    capsuleInjectDepth: 0,
    capsuleInjectRole: extension_prompt_roles.SYSTEM,
    capsuleCustomInstruction: DEFAULT_CAPSULE_CUSTOM_INSTRUCTION,
    // NEW: per-mode preset libraries + active pointers. Initial Default
    // entries are seeded lazily by preset-library.js on first read so the
    // factory data isn't duplicated across this constant.
    presetLibraries: { spec: {}, agenda: {}, loop: {}, director: {} },
    activePresetIds: { spec: '', agenda: '', loop: '', director: '' },
    presetLibrariesMigrationDone: 0,
    chatOverrides: {},
    requestApiPresetName: '',
    requestLlmPresetName: '',
    requestSystemPrompt: getDefaultRequestSystemPrompt(),
    rpmLimit: 0,
    useStreamingTransport: false,
};

/**
 * Build a factory "Default" preset entry for the given mode. Used by
 * preset-library.js when seeding the first entry of an empty library and
 * by the global one-shot migration when no legacy data exists.
 *
 * Director mode returns an array of entries (Full + Minimal); all other
 * modes return a single object. Callers must branch on `Array.isArray`.
 */
export function createFactoryPresetForMode(mode) {
    if (mode === ORCH_EXECUTION_MODE_LOOP) {
        return { name: 'Default', ...defaultLoopProfile };
    }
    if (mode === _ORCH_EXECUTION_MODE_DIRECTOR) {
        return [
            { id: 'default-full', name: 'Default (记忆图 + 搜索)',    ..._createFullDirectorProfile() },
            { id: 'default',      name: 'Default (无记忆图，无搜索)', ..._createMinimalDirectorProfile() },
        ];
    }
    if (mode === ORCH_EXECUTION_MODE_AGENDA) {
        return {
            name: 'Default',
            planner: defaultAgendaPlanner,
            agents: defaultAgendaAgents,
            finalAgentId: 'finalizer',
            limits: { plannerMaxRounds: 6, maxConcurrentAgents: 3, maxTotalRuns: 24 },
        };
    }
    return { name: 'Default', spec: defaultSpec, presets: defaultPresets };
}
