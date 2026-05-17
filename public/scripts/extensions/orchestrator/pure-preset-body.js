/**
 * Bundled "pure" Chat Completion preset for director-mode orchestrator agents.
 *
 * Why this exists: in director mode the orchestrator's main agent and
 * sub-agents call the LLM through ST's chat-completion path. Per the
 * director docs ("Recommended preset settings"), the preset they use
 * should NOT be the user's main RP preset — character-card / persona /
 * worldbook placeholders pollute the agent's prompt and burn tokens
 * re-reading content already visible elsewhere. Each director agent has
 * a `promptPresetName` field the user can set explicitly; when they
 * leave it blank, we want to fall back to a known-clean preset instead
 * of inheriting whatever they happen to have selected for chat. This
 * file is that bundled fallback.
 *
 * The body is mirrored byte-for-byte from
 * `data/default-user/OpenAI Settings/pure-preset.json` (which lives
 * under `data/` and therefore is NOT shipped with the plugin — that
 * file is per-user state, not bundled assets). Mirroring it here makes
 * the synthetic preset available the moment the orchestrator activates,
 * with no dependency on what the user happens to have on disk.
 *
 * Naming follows the synthetic-preset registry convention
 * `<owner>:<id>` introduced in `public/scripts/openai.js` —
 * `orchestrator` is the plugin id, `director-pure` is the role this
 * preset plays. The constant is exported separately from the body so
 * the resolver fallback in director-runtime.js / director-tools.js can
 * reference it without pulling the whole preset object into the test
 * graph.
 *
 * Registration happens once at plugin load in `main.js` via
 * `getContext().presets.registerSynthetic(NAME, BODY)`. Synthetic
 * presets take precedence over user-saved presets of the same name
 * (openai.js:getOpenAIPresetByName), and the registry is page-session
 * lived — there is no `unregisterSynthetic` call paired with this one
 * because the orchestrator plugin has no deactivate hook.
 */

export const DIRECTOR_PURE_PRESET_NAME = 'orchestrator:director-pure';

const PURE_PRESET_JSON = String.raw`{
    "temperature": 1,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "top_p": 1,
    "top_k": 0,
    "top_a": 0,
    "min_p": 0,
    "repetition_penalty": 1,
    "max_context_unlocked": true,
    "tool_reasoning_mode": "disabled",
    "openai_max_context": 2000000,
    "openai_max_tokens": 20000,
    "names_behavior": 0,
    "send_if_empty": "",
    "impersonation_prompt": "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    "new_chat_prompt": "[Start a new Chat]",
    "new_group_chat_prompt": "[Start a new group chat. Group members: {{group}}]",
    "new_example_chat_prompt": "[Example Chat]",
    "continue_nudge_prompt": "[Continue your last message without repeating its original content.]",
    "bias_preset_selected": "Default (none)",
    "wi_format": "{0}",
    "scenario_format": "{{scenario}}",
    "personality_format": "{{personality}}",
    "group_nudge_prompt": "[Write the next reply only as {{char}}.]",
    "stream_openai": false,
    "prompts": [
        {
            "name": "Main Prompt",
            "system_prompt": true,
            "role": "system",
            "content": "You are an AI assistant. Please use the following character descriptions of {{char}}, world info, and scenario as background context to complete the tasks provided by {{user}}. Do not roleplay as {{char}} directly.",
            "identifier": "main",
            "plugin_extra": false,
            "injection_position": 0,
            "injection_depth": 4,
            "injection_order": 100,
            "injection_trigger": [],
            "forbid_overrides": false
        },
        {
            "name": "Auxiliary Prompt",
            "system_prompt": true,
            "role": "system",
            "content": "",
            "identifier": "nsfw",
            "plugin_extra": false
        },
        {
            "identifier": "dialogueExamples",
            "name": "Chat Examples",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "name": "Post-History Instructions",
            "system_prompt": true,
            "role": "system",
            "content": "",
            "identifier": "jailbreak",
            "plugin_extra": false
        },
        {
            "identifier": "chatHistory",
            "name": "Chat History",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "worldInfoAfter",
            "name": "World Info (after)",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "worldInfoBefore",
            "name": "World Info (before)",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "enhanceDefinitions",
            "role": "system",
            "name": "Enhance Definitions",
            "content": "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
            "system_prompt": true,
            "marker": false,
            "plugin_extra": false
        },
        {
            "identifier": "charDescription",
            "name": "Char Description",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "charPersonality",
            "name": "Char Personality",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "scenario",
            "name": "Scenario",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "personaDescription",
            "name": "Persona Description",
            "system_prompt": true,
            "marker": true,
            "plugin_extra": false
        },
        {
            "identifier": "7cb25d31-4677-438e-bd27-ba727a171eac",
            "system_prompt": false,
            "enabled": false,
            "marker": false,
            "plugin_extra": false,
            "name": "context",
            "role": "system",
            "content": "<story context>",
            "injection_position": 0,
            "injection_depth": 4,
            "injection_order": 100,
            "injection_trigger": [],
            "forbid_overrides": false
        },
        {
            "identifier": "24f37e60-fa84-464b-8883-ce9d2a64b68a",
            "system_prompt": false,
            "enabled": false,
            "marker": false,
            "plugin_extra": false,
            "name": "/context",
            "role": "system",
            "content": "</story context>",
            "injection_position": 0,
            "injection_depth": 4,
            "injection_order": 100,
            "injection_trigger": [],
            "forbid_overrides": false
        },
        {
            "identifier": "ef55413d-69bf-4c53-be76-11e7946cf39f",
            "system_prompt": false,
            "enabled": false,
            "marker": false,
            "plugin_extra": false,
            "name": "CoT",
            "role": "assistant",
            "content": "<think>\nLet me start the mission\n</think>\nI'll stirictly follow the users requests. Let me start by <thought> first...",
            "injection_position": 0,
            "injection_depth": 4,
            "injection_order": 100,
            "injection_trigger": [],
            "forbid_overrides": false
        },
        {
            "identifier": "22b0836d-8c7c-4703-936e-70b0b6c3abaf",
            "system_prompt": false,
            "enabled": false,
            "marker": false,
            "plugin_extra": false,
            "name": "Start",
            "role": "user",
            "content": "Now please begin.",
            "injection_position": 0,
            "injection_depth": 4,
            "injection_order": 100,
            "injection_trigger": [],
            "forbid_overrides": false
        }
    ],
    "prompt_order": [
        {
            "character_id": 100000,
            "order": [
                {
                    "identifier": "main",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoBefore",
                    "enabled": true
                },
                {
                    "identifier": "charDescription",
                    "enabled": true
                },
                {
                    "identifier": "charPersonality",
                    "enabled": true
                },
                {
                    "identifier": "scenario",
                    "enabled": true
                },
                {
                    "identifier": "enhanceDefinitions",
                    "enabled": false
                },
                {
                    "identifier": "nsfw",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoAfter",
                    "enabled": true
                },
                {
                    "identifier": "dialogueExamples",
                    "enabled": true
                },
                {
                    "identifier": "chatHistory",
                    "enabled": true
                },
                {
                    "identifier": "jailbreak",
                    "enabled": true
                }
            ]
        },
        {
            "character_id": 100001,
            "order": [
                {
                    "identifier": "main",
                    "enabled": false
                },
                {
                    "identifier": "worldInfoBefore",
                    "enabled": true
                },
                {
                    "identifier": "personaDescription",
                    "enabled": true
                },
                {
                    "identifier": "charDescription",
                    "enabled": true
                },
                {
                    "identifier": "charPersonality",
                    "enabled": true
                },
                {
                    "identifier": "scenario",
                    "enabled": true
                },
                {
                    "identifier": "enhanceDefinitions",
                    "enabled": false
                },
                {
                    "identifier": "nsfw",
                    "enabled": false
                },
                {
                    "identifier": "worldInfoAfter",
                    "enabled": true
                },
                {
                    "identifier": "dialogueExamples",
                    "enabled": true
                },
                {
                    "identifier": "7cb25d31-4677-438e-bd27-ba727a171eac",
                    "enabled": false
                },
                {
                    "identifier": "chatHistory",
                    "enabled": true
                },
                {
                    "identifier": "24f37e60-fa84-464b-8883-ce9d2a64b68a",
                    "enabled": false
                },
                {
                    "identifier": "jailbreak",
                    "enabled": false
                },
                {
                    "identifier": "22b0836d-8c7c-4703-936e-70b0b6c3abaf",
                    "enabled": false
                },
                {
                    "identifier": "ef55413d-69bf-4c53-be76-11e7946cf39f",
                    "enabled": false
                }
            ]
        }
    ],
    "assistant_prefill": "",
    "assistant_impersonation": "",
    "use_sysprompt": false,
    "squash_system_messages": false,
    "media_inlining": true,
    "inline_image_quality": "low",
    "continue_prefill": false,
    "continue_postfix": " ",
    "function_calling": false,
    "tool_call_recurse_limit": 18,
    "show_thoughts": true,
    "reasoning_effort": "auto",
    "verbosity": "auto",
    "enable_web_search": false,
    "seed": -1,
    "n": 1,
    "request_images": false,
    "request_image_aspect_ratio": "",
    "request_image_resolution": "",
    "extensions": {
        "luker": {
            "prompt_layout": [],
            "prompt_groups": []
        }
    }
}`;

export const DIRECTOR_PURE_PRESET_BODY = JSON.parse(PURE_PRESET_JSON);
