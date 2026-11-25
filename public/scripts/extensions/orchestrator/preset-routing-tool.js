// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * `luker_orch_list_preset_routing` — iteration-studio read tool returning
 * the connection profiles and chat completion preset names an agent can be
 * routed through. The executor is `readAgentPresetRouting`
 * (agent-resolution.js); iter-studio/studio.js dispatches it inline like
 * the other read tools.
 *
 * Also owns the rewrite of persisted iteration prompts: `requestSystemPrompt`
 * and `iterModePrompt*` are seeded from the code defaults and stored, so a
 * stored line that still names the fields of the removed up-front routing
 * dump is replaced by the line that points at this tool. Lines the user
 * edited no longer match and stay as written.
 *
 * Import-free so main.js, studio.js and the main.js Jest harness load it
 * without the connection-manager chain.
 */

export const PRESET_ROUTING_TOOL_NAME = 'luker_orch_list_preset_routing';

export const PRESET_ROUTING_TOOL_DEF = {
    type: 'function',
    function: {
        name: PRESET_ROUTING_TOOL_NAME,
        description: 'List the connection profiles and chat completion presets an agent can be routed through, plus the global orchestration defaults an empty apiPresetName / promptPresetName falls back to. Read-only. Call it before setting any apiPresetName or promptPresetName and use only names it returns. Returns {api: {global_orchestration_api_preset, empty_value_behavior, default_policy, available_connection_profiles: [{name, api, model}]}, prompt: {global_orchestration_prompt_preset, empty_value_behavior, default_policy, available_local_global_chat_completion_presets: [name], available_card_bound_chat_completion_presets: [name]}}.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
};

export function isPresetRoutingTool(name) {
    return String(name || '') === PRESET_ROUTING_TOOL_NAME;
}

// [replaced line, current line]. The current lines are the literal lines of
// getDefaultRequestSystemPrompt (defaults.js), LOOP_ITERATION_CONTRACT_LINES
// (loop-iteration.js) and the director / agenda / spec iteration mode blocks
// (main.js); tests/orchestrator/ensure-settings-migration.test.js pins that
// every current line is present in the seeded defaults.
export const PRESET_ROUTING_PROMPT_LINE_MIGRATIONS = Object.freeze([
    [
        'If you set apiPresetName, use only names from available_connection_profiles.',
        'Before setting apiPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_connection_profiles.',
    ],
    [
        'If you set promptPresetName, use only names from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are safe to reference from any card. Prefer local-global names for portable profiles; use a card-bound name only when the profile is meant to ship with the same card.',
        'Before setting promptPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are safe to reference from any card. Prefer local-global names for portable profiles; use a card-bound name only when the profile is meant to ship with the same card.',
    ],
    [
        '- If you set apiPresetName, use only a name from available_connection_profiles. If you set promptPresetName, use only a name from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names are portable. Prefer local-global names for a portable loop profile; use a card-bound name only when the profile is meant to ship with the same card.',
        '- Before setting apiPresetName or promptPresetName, call `luker_orch_list_preset_routing`. Use only an apiPresetName from its available_connection_profiles and only a promptPresetName from its available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names are portable. Prefer local-global names for a portable loop profile; use a card-bound name only when the profile is meant to ship with the same card.',
    ],
    [
        '- `mainAgent.apiPresetName` / `mainAgent.promptPresetName` may be empty (inherit the global orchestration API / chat completion preset). If set, apiPresetName must be a name from available_connection_profiles; promptPresetName must be a name from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card. Same semantics for each sub-agent\'s own preset fields.',
        '- `mainAgent.apiPresetName` / `mainAgent.promptPresetName` may be empty (inherit the global orchestration API / chat completion preset). Before setting either, call `luker_orch_list_preset_routing`: apiPresetName must be a name from its available_connection_profiles; promptPresetName must be a name from its available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card. Same semantics for each sub-agent\'s own preset fields.',
    ],
    [
        '- If you set planner/agent apiPresetName, use only a name from available_connection_profiles.',
        '- Before setting planner/agent apiPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_connection_profiles.',
    ],
    [
        '- If you set planner/agent promptPresetName, use only a name from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card.',
        '- Before setting planner/agent promptPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card.',
    ],
    [
        '- If you set preset apiPresetName, use only a name from available_connection_profiles.',
        '- Before setting preset apiPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_connection_profiles.',
    ],
    [
        '- If you set preset promptPresetName, use only a name from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card.',
        '- Before setting preset promptPresetName, call `luker_orch_list_preset_routing` and use only a name from its available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names live in the user preset library and are portable across cards. Prefer local-global names when the profile is meant to be portable; use a card-bound name only when this profile is meant to ship with the same card.',
    ],
]);

const LINE_MIGRATIONS = new Map(PRESET_ROUTING_PROMPT_LINE_MIGRATIONS);

/**
 * Replace every line of `text` that equals a replaced routing line with its
 * current line. Non-string and empty input is returned unchanged.
 */
export function migratePresetRoutingPromptLines(text) {
    if (typeof text !== 'string' || !text) return text;
    return text.split('\n').map((line) => LINE_MIGRATIONS.get(line) ?? line).join('\n');
}
