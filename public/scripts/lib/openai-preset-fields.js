// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure OpenAI chat-completion preset field metadata and connection-field stripping.
 * Shared by `public/scripts/openai.js` and `public/scripts/character/presets-core.js`
 * without pulling DOM/browser boot dependencies into pure consumers.
 */

/**
 * preset_name -> [selector, setting_name, is_checkbox, is_connection]
 * @type {Record<string, [string, string, boolean, boolean]>}
 */
export const settingsToUpdate = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false],
    presence_penalty: ['#pres_pen_openai', 'pres_pen_openai', false, false],
    top_p: ['#top_p_openai', 'top_p_openai', false, false],
    top_k: ['#top_k_openai', 'top_k_openai', false, false],
    top_a: ['#top_a_openai', 'top_a_openai', false, false],
    min_p: ['#min_p_openai', 'min_p_openai', false, false],
    repetition_penalty: ['#repetition_penalty_openai', 'repetition_penalty_openai', false, false],
    max_context_unlocked: ['#oai_max_context_unlocked', 'max_context_unlocked', true, false],
    group_models: ['#cc_group_models', 'group_models', true, true],
    sort_models: ['#cc_sort_models', 'sort_models', false, true],
    openai_model: ['#openai_model_id', 'openai_model', false, true],
    claude_model: ['#claude_model_id', 'claude_model', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_use_fallback: ['#openrouter_use_fallback', 'openrouter_use_fallback', true, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    openrouter_quantizations: ['#openrouter_quantizations_chat', 'openrouter_quantizations', false, true],
    openrouter_allow_fallbacks: ['#openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
    openrouter_middleout: ['#openrouter_middleout', 'openrouter_middleout', false, true],
    tool_reasoning_mode: ['#tool_reasoning_mode', 'tool_reasoning_mode', false, false],
    ai21_model: ['#model_ai21_select', 'ai21_model', false, true],
    mistralai_model: ['#mistralai_model_id', 'mistralai_model', false, true],
    cohere_model: ['#model_cohere_select', 'cohere_model', false, true],
    perplexity_model: ['#model_perplexity_select', 'perplexity_model', false, true],
    groq_model: ['#model_groq_select', 'groq_model', false, true],
    chutes_model: ['#model_chutes_select', 'chutes_model', false, true],
    siliconflow_model: ['#model_siliconflow_select', 'siliconflow_model', false, true],
    siliconflow_endpoint: ['#siliconflow_endpoint', 'siliconflow_endpoint', false, true],
    minimax_model: ['#model_minimax_select', 'minimax_model', false, true],
    minimax_endpoint: ['#minimax_endpoint', 'minimax_endpoint', false, true],
    electronhub_model: ['#model_electronhub_select', 'electronhub_model', false, true],
    nanogpt_model: ['#model_nanogpt_select', 'nanogpt_model', false, true],
    nanogpt_provider: ['#nanogpt_provider', 'nanogpt_provider', false, true],
    nanogpt_payg_override: ['#nanogpt_payg_override', 'nanogpt_payg_override', true, true],
    deepseek_model: ['#deepseek_model_id', 'deepseek_model', false, true],
    aimlapi_model: ['#model_aimlapi_select', 'aimlapi_model', false, true],
    xai_model: ['#xai_model_id', 'xai_model', false, true],
    pollinations_model: ['#model_pollinations_select', 'pollinations_model', false, true],
    pollinations_endpoint: ['#pollinations_endpoint', 'pollinations_endpoint', false, true],
    moonshot_model: ['#moonshot_model_id', 'moonshot_model', false, true],
    fireworks_model: ['#model_fireworks_select', 'fireworks_model', false, true],
    cometapi_model: ['#model_cometapi_select', 'cometapi_model', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    responses_url: ['#responses_url_text', 'responses_url', false, true],
    custom_include_body: ['#custom_include_body', 'custom_include_body', false, true],
    custom_exclude_body: ['#custom_exclude_body', 'custom_exclude_body', false, true],
    custom_include_headers: ['#custom_include_headers', 'custom_include_headers', false, true],
    custom_prompt_post_processing: ['#custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
    google_model: ['#google_model_id', 'google_model', false, true],
    vertexai_model: ['#vertexai_model_id', 'vertexai_model', false, true],
    zai_model: ['#zai_model_id', 'zai_model', false, true],
    zai_endpoint: ['#zai_endpoint', 'zai_endpoint', false, true],
    workers_ai_model: ['#model_workers_ai_select', 'workers_ai_model', false, true],
    workers_ai_account_id: ['#workers_ai_account_id', 'workers_ai_account_id', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    names_behavior: ['#names_behavior', 'names_behavior', false, false],
    send_if_empty: ['#send_if_empty_textarea', 'send_if_empty', false, false],
    impersonation_prompt: ['#impersonation_prompt_textarea', 'impersonation_prompt', false, false],
    new_chat_prompt: ['#newchat_prompt_textarea', 'new_chat_prompt', false, false],
    new_group_chat_prompt: ['#newgroupchat_prompt_textarea', 'new_group_chat_prompt', false, false],
    new_example_chat_prompt: ['#newexamplechat_prompt_textarea', 'new_example_chat_prompt', false, false],
    continue_nudge_prompt: ['#continue_nudge_prompt_textarea', 'continue_nudge_prompt', false, false],
    bias_preset_selected: ['#openai_logit_bias_preset', 'bias_preset_selected', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    base_url: ['#openai_base_url', 'base_url', false, true],
    wi_format: ['#wi_format_textarea', 'wi_format', false, false],
    scenario_format: ['#scenario_format_textarea', 'scenario_format', false, false],
    personality_format: ['#personality_format_textarea', 'personality_format', false, false],
    group_nudge_prompt: ['#group_nudge_prompt_textarea', 'group_nudge_prompt', false, false],
    stream_openai: ['#stream_toggle', 'stream_openai', true, false],
    prompts: ['', 'prompts', false, false],
    prompt_order: ['', 'prompt_order', false, false],
    show_external_models: ['#openai_show_external_models', 'show_external_models', true, true],
    proxy_password: ['#openai_proxy_access_key', 'proxy_password', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    assistant_impersonation: ['#claude_assistant_impersonation', 'assistant_impersonation', false, false],
    use_sysprompt: ['#use_sysprompt', 'use_sysprompt', true, false],
    vertexai_auth_mode: ['#vertexai_auth_mode', 'vertexai_auth_mode', false, true],
    vertexai_region: ['#vertexai_region', 'vertexai_region', false, true],
    vertexai_express_project_id: ['#vertexai_express_project_id', 'vertexai_express_project_id', false, true],
    squash_system_messages: ['#squash_system_messages', 'squash_system_messages', true, false],
    media_inlining: ['#openai_media_inlining', 'media_inlining', true, false],
    inline_image_quality: ['#openai_inline_image_quality', 'inline_image_quality', false, false],
    continue_prefill: ['#continue_prefill', 'continue_prefill', true, false],
    continue_postfix: ['#continue_postfix', 'continue_postfix', false, false],
    kimi_partial_mode: ['#kimi_partial_mode', 'kimi_partial_mode', true, false],
    kimi_partial_content: ['#kimi_partial_content', 'kimi_partial_content', false, false],
    kimi_partial_name_source: ['#kimi_partial_name_source', 'kimi_partial_name_source', false, false],
    kimi_partial_name: ['#kimi_partial_name', 'kimi_partial_name', false, false],
    function_calling: ['#openai_function_calling', 'function_calling', true, false],
    function_calling_plain_text: ['#connection_profile_function_calling_plain_text', 'function_calling_plain_text', true, true],
    function_calling_plain_text_error_retry: ['#connection_profile_function_calling_plain_text_error_retry', 'function_calling_plain_text_error_retry', true, true],
    function_calling_plain_text_error_retry_max_attempts: ['#connection_profile_function_calling_plain_text_error_retry_max_attempts', 'function_calling_plain_text_error_retry_max_attempts', false, true],
    claude_enable_system_prompt_cache: ['#connection_profile_claude_enable_system_prompt_cache', 'claude_enable_system_prompt_cache', true, true],
    claude_caching_at_depth: ['#connection_profile_claude_caching_at_depth', 'claude_caching_at_depth', false, true],
    claude_extended_ttl: ['#connection_profile_claude_extended_ttl', 'claude_extended_ttl', true, true],
    gemini_enable_system_prompt_cache: ['#connection_profile_gemini_enable_system_prompt_cache', 'gemini_enable_system_prompt_cache', true, true],
    gemini_enable_history_cache: ['#connection_profile_gemini_enable_history_cache', 'gemini_enable_history_cache', true, true],
    gemini_cache_keep_recent_turns: ['#connection_profile_gemini_cache_keep_recent_turns', 'gemini_cache_keep_recent_turns', false, true],
    tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    reasoning_effort_by_source: ['#NULL_SELECTOR', 'reasoning_effort_by_source', false, false],
    verbosity: ['#openai_verbosity', 'verbosity', false, false],
    enable_web_search: ['#openai_enable_web_search', 'enable_web_search', true, false],
    seed: ['#seed_openai', 'seed', false, false],
    n: ['#n_openai', 'n', false, false],
    bypass_status_check: ['#openai_bypass_status_check', 'bypass_status_check', true, true],
    request_images: ['#openai_request_images', 'request_images', true, false],
    request_image_aspect_ratio: ['#request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
    request_image_resolution: ['#request_image_resolution', 'request_image_resolution', false, false],
    azure_base_url: ['#azure_base_url', 'azure_base_url', false, true],
    azure_deployment_name: ['#azure_deployment_name', 'azure_deployment_name', false, true],
    azure_api_version: ['#azure_api_version', 'azure_api_version', false, true],
    azure_openai_model: ['#azure_openai_model', 'azure_openai_model', false, true],
    extensions: ['#NULL_SELECTOR', 'extensions', false, false],
};

/**
 * Returns true if the OpenAI preset field belongs to API connection/model settings.
 * @param {string} presetKey
 * @returns {boolean}
 */
export function isOpenAIConnectionPresetField(presetKey) {
    return Boolean(settingsToUpdate?.[presetKey]?.[3]);
}

/**
 * Remove connection/model fields from a chat-completion preset object.
 * @param {object} preset
 * @returns {object}
 */
export function stripOpenAIConnectionFieldsFromPreset(preset) {
    const source = preset && typeof preset === 'object' ? structuredClone(preset) : {};
    for (const key of Object.keys(source)) {
        if (isOpenAIConnectionPresetField(key)) {
            delete source[key];
        }
    }
    return source;
}
