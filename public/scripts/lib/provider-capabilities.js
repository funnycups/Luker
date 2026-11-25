// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Shared zero-DOM, zero-storage declarative provider/model capability tables
// and request-compatibility validators consumed by both backend dispatchers
// (`src/luker-dispatch/`) and browser request builders (`public/scripts/`).
//
// Design rules:
//   - Every protocol constraint records its official documentation source,
//     applicable model IDs/families, and verification date.
//   - Product-level canonical-token mappings are explicitly labeled as product
//     mappings rather than official API restrictions.
//   - Unknown/future models report `'unknown'` instead of fabricating false
//     rejection or false confirmation so new releases work without waiting for
//     a hardcoded allowlist update.

/**
 * Extract the canonical trailing model identifier from bare or vendor/path-prefixed
 * IDs (e.g. `publishers/google/models/gemini-3-pro-image` -> `gemini-3-pro-image`).
 * @param {unknown} model
 * @returns {string}
 */
export function normalizeModelBaseId(model) {
    return String(model ?? '').trim().split('/').pop() ?? '';
}

/**
 * Build a deterministic, non-retryable HTTP 400 capability-conflict error.
 * @param {string} message
 * @param {{ provider: string, model: string, conflictCode: string }} details
 * @returns {Error & { status: number, code: string, conflictCode: string, provider: string, model: string, nonRetryable: boolean }}
 */
export function createCapabilityConflictError(message, { provider, model, conflictCode }) {
    const err = /** @type {any} */ (new Error(message));
    err.status = 400;
    err.code = 'capability_conflict';
    err.conflictCode = conflictCode;
    err.provider = provider;
    err.model = model;
    err.nonRetryable = true;
    return err;
}

// ---------------------------------------------------------------------------
// Google Gemini / Vertex AI (generateContent / streamGenerateContent)
//
// Official sources verified 2026-11-24:
//   - https://ai.google.dev/gemini-api/docs/image-generation
//   - https://ai.google.dev/gemini-api/docs/models
//   - https://ai.google.dev/gemini-api/docs/function-calling
//   - https://ai.google.dev/gemini-api/docs/google-search
//   - https://ai.google.dev/gemini-api/docs/latest-model
//
// Verified protocol constraints:
//   1. Image generation models:
//      - `gemini-nano-banana-2.1`, `gemini-3-pro-image`, `gemini-3.1-flash-image`:
//        imageOutput=supported, imageSize=true, systemInstruction=true,
//        googleSearch=supported, functionCalling=unsupported.
//      - `gemini-3.1-flash-lite-image`:
//        imageOutput=supported, imageSize=true, systemInstruction=true,
//        googleSearch=unsupported, functionCalling=unsupported.
//      - `gemini-2.5-flash-image`:
//        imageOutput=supported, imageSize=false, systemInstruction=true,
//        googleSearch=unsupported, functionCalling=unsupported.
//      - Retired models (`gemini-2.0-flash-exp*`, `gemini-2.5-flash-image-preview`)
//        are removed from the active allowlist.
//      - Future image models matching `/(?:^|-)image(?:$|-)|nano-banana/i` enter
//        image output mode without requiring a new allowlist entry.
//      - Unrecognized custom/future models report `'unknown'` so explicit user
//        configuration is forwarded rather than silently dropped.
//   2. `systemInstruction`: supported by all Gemini models including image
//      models; unsupported only by Gemma 3 (`gemma-3*`).
//   3. Built-in tools (`googleSearch`, `urlContext`, `codeExecution`) vs
//      `functionDeclarations`:
//      - Independent capabilities; image models lacking function calling can
//        still use `googleSearch` when supported by the model.
//      - Gemini 3 and Gemini 4 support combining built-in tools and
//        `functionDeclarations` in the same `tools` array.
//      - Gemini 2.x models reject combining built-in tools with
//        `functionDeclarations`.
//   4. Sampling parameters (`temperature`, `topP`, `topK`, `candidateCount`)
//      are deprecated on Gemini 3.5 Flash-Lite, Gemini 3.6/3.7/3.8 Flash, and
//      Gemini 4.
// ---------------------------------------------------------------------------

/**
 * Resolve protocol capabilities for a Google AI Studio / Vertex AI model ID.
 * @param {unknown} model
 */
export function resolveGeminiModelCapabilities(model) {
    const base = normalizeModelBaseId(model);
    const lower = base.toLowerCase();
    const isGemini3 = /^gemini-3/i.test(lower);
    const isGemini4 = /^gemini-4/i.test(lower);
    const isGemini25 = /^gemini-2\.5/i.test(lower);
    const isImageFamily = /(?:^|-)image(?:$|-)|nano-banana/i.test(lower);
    const noPrefill = /^gemini-3\.[678]-flash|^gemini-3\.5-flash-lite|^gemini-4/i.test(lower);
    const supportsMediaResolution = isGemini3 || isGemini4;
    const supportsThoughtSignature = isGemini25 || isGemini3 || isGemini4 || /nano-banana/i.test(lower);
    const requiresToolThoughtSignature = isGemini3 || isGemini4 || /nano-banana/i.test(lower);
    const requiresImageThoughtSignature = isImageFamily && requiresToolThoughtSignature;
    const sharedFlags = {
        noPrefill,
        supportsMediaResolution,
        supportsThoughtSignature,
        requiresToolThoughtSignature,
        requiresImageThoughtSignature,
    };

    if (/^gemma-3/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemma-3',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: false,
            functionCalling: 'unsupported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    if (/^gemma-4/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemma-4',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    if (lower.includes('learnlm')) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'learnlm',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    if (/^gemini-robotics-er-/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'robotics',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    // Known Gemini image-generation models (verified 2026-11-25).
    // Nano Banana 2.1 (`gemini-nano-banana-2.1`) supports `thinkingLevel`
    // (MINIMAL / MEDIUM / HIGH) and `imageSize` (1K / 2K / 4K), and rejects
    // text sampling parameters (`temperature`, `topP`, `topK`, `seed`, `logprobs`).
    if (/^gemini-nano-banana/i.test(lower) || /nano-banana/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'image',
            imageOutput: 'supported',
            imageSize: true,
            systemInstruction: true,
            functionCalling: 'unsupported',
            googleSearch: 'supported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'level',
            thinkingSupportsOff: true,
            thinkingSupportsMinimal: true,
            supportsSampling: false,
            supportsSeed: false,
        };
    }

    if (/^gemini-3\.1-flash-lite-image/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'image',
            imageOutput: 'supported',
            imageSize: true,
            systemInstruction: true,
            functionCalling: 'unsupported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'level',
            thinkingSupportsOff: true,
            thinkingSupportsMinimal: true,
            supportsSampling: true,
        };
    }

    if (/^gemini-3-pro-image/i.test(lower) || /^gemini-3\.1-flash-image/i.test(lower)) {
        const isPro = /^gemini-3-pro-image/i.test(lower);
        return {
            ...sharedFlags,
            modelId: base,
            family: 'image',
            imageOutput: 'supported',
            imageSize: true,
            systemInstruction: true,
            functionCalling: 'unsupported',
            googleSearch: 'supported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'level',
            thinkingSupportsOff: true,
            thinkingSupportsMinimal: !isPro,
            supportsSampling: true,
        };
    }

    if (/^gemini-2\.5-flash-image/i.test(lower)) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'image',
            imageOutput: 'supported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'unsupported',
            googleSearch: 'unsupported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    if (/(?:^|-)image(?:$|-)/i.test(lower)) {
        const isGemini3Plus = /^gemini-[34]/i.test(lower);
        return {
            ...sharedFlags,
            modelId: base,
            family: 'image',
            imageOutput: 'supported',
            imageSize: isGemini3Plus || !/^gemini-2/i.test(lower),
            systemInstruction: true,
            functionCalling: 'unknown',
            googleSearch: 'unknown',
            combineBuiltinAndFunctionTools: 'unknown',
            thinkingMode: isGemini3Plus ? 'level' : 'none',
            thinkingSupportsOff: isGemini3Plus,
            thinkingSupportsMinimal: /^gemini-3/i.test(lower) && !/^gemini-3\.7-flash|^gemini-3[.\d]*-pro/i.test(lower),
            supportsSampling: !/^gemini-4/i.test(lower),
        };
    }

    if (isGemini4) {
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemini-4',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'supported',
            combineBuiltinAndFunctionTools: 'supported',
            thinkingMode: 'level',
            thinkingSupportsOff: true,
            thinkingSupportsMinimal: false,
            supportsSampling: false,
        };
    }

    if (isGemini3) {
        const isThinking = /^gemini-3[.\d]*-(flash|pro)/i.test(lower);
        const lacksMinimal = /^gemini-3\.7-flash|^gemini-3[.\d]*-pro/i.test(lower);
        const noSampling = /^gemini-3\.[678]-flash|^gemini-3\.5-flash-lite/i.test(lower);
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemini-3',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'supported',
            combineBuiltinAndFunctionTools: 'supported',
            thinkingMode: isThinking ? 'level' : 'none',
            thinkingSupportsOff: isThinking,
            thinkingSupportsMinimal: isThinking && !lacksMinimal,
            supportsSampling: !noSampling,
        };
    }

    if (isGemini25) {
        const isThinking = /^gemini-2\.5-(flash|pro)/i.test(lower);
        const isPro = /^gemini-2\.5-pro/i.test(lower);
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemini-2.5',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: 'supported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: isThinking ? 'budget' : 'none',
            thinkingSupportsOff: isThinking && !isPro,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    if (/^gemini-2\.0/i.test(lower)) {
        const isLite = /^gemini-2\.0-flash-lite/i.test(lower);
        return {
            ...sharedFlags,
            modelId: base,
            family: 'gemini-2.0',
            imageOutput: 'unsupported',
            imageSize: false,
            systemInstruction: true,
            functionCalling: 'supported',
            googleSearch: isLite ? 'unsupported' : 'supported',
            combineBuiltinAndFunctionTools: 'unsupported',
            thinkingMode: 'none',
            thinkingSupportsOff: false,
            thinkingSupportsMinimal: false,
            supportsSampling: true,
        };
    }

    // Unknown or future model ID: do not fabricate false rejection.
    return {
        ...sharedFlags,
        modelId: base,
        family: 'unknown',
        imageOutput: 'unknown',
        imageSize: true,
        systemInstruction: true,
        functionCalling: 'unknown',
        googleSearch: 'unknown',
        combineBuiltinAndFunctionTools: 'unknown',
        thinkingMode: 'none',
        thinkingSupportsOff: false,
        thinkingSupportsMinimal: false,
        supportsSampling: true,
    };
}

/**
 * Validate requested Gemini/Vertex AI options against model capabilities.
 * Returns a non-retryable 400 conflict error on known protocol incompatibilities,
 * or `null` when valid (or when model capabilities are unknown).
 *
 * @param {object} params
 * @param {unknown} params.model
 * @param {boolean} [params.requestImages]
 * @param {boolean} [params.hasFunctionTools]
 * @param {boolean} [params.enableWebSearch]
 * @param {boolean} [params.hasCustomBuiltinTools]
 * @param {boolean} [params.hasBuiltinSearch]
 */
export function validateGeminiRequestCapabilities({
    model,
    requestImages = false,
    hasFunctionTools = false,
    enableWebSearch = false,
    hasCustomBuiltinTools = false,
    hasBuiltinSearch = false,
}) {
    const caps = resolveGeminiModelCapabilities(model);
    const modelLabel = caps.modelId || String(model || 'unknown');

    if (requestImages && caps.imageOutput === 'unsupported') {
        return createCapabilityConflictError(
            `Model "${modelLabel}" does not support inline image output (request_images). Disable "Request inline images" or select an image-capable Gemini model.`,
            { provider: 'gemini', model: modelLabel, conflictCode: 'gemini_image_output_unsupported' },
        );
    }

    if (hasFunctionTools && caps.functionCalling === 'unsupported') {
        return createCapabilityConflictError(
            `Model "${modelLabel}" does not support function calling (tools).`,
            { provider: 'gemini', model: modelLabel, conflictCode: 'gemini_function_calling_unsupported' },
        );
    }

    if ((enableWebSearch || hasBuiltinSearch) && caps.googleSearch === 'unsupported') {
        return createCapabilityConflictError(
            `Model "${modelLabel}" does not support Google Search grounding (enable_web_search).`,
            { provider: 'gemini', model: modelLabel, conflictCode: 'gemini_web_search_unsupported' },
        );
    }

    const hasAnyBuiltin = Boolean(enableWebSearch || hasBuiltinSearch || hasCustomBuiltinTools);
    if (hasFunctionTools && hasAnyBuiltin && caps.combineBuiltinAndFunctionTools === 'unsupported') {
        return createCapabilityConflictError(
            `Model "${modelLabel}" cannot combine function calling with built-in tools (such as Google Search) in the same request.`,
            { provider: 'gemini', model: modelLabel, conflictCode: 'gemini_builtin_and_function_tools_conflict' },
        );
    }

    return null;
}

// ---------------------------------------------------------------------------
// Anthropic Claude (POST /v1/messages)
//
// Official sources verified 2026-11-24:
//   - https://platform.claude.com/docs/en/build-with-claude/thinking
//   - https://platform.claude.com/docs/en/build-with-claude/extended-thinking
//   - https://platform.claude.com/docs/en/build-with-claude/structured-outputs
//   - https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
//
// Verified protocol constraints:
//   1. Native structured output (`output_config.format = { type: 'json_schema', schema }`):
//      supported across Claude 4.1+, 4.5+, 4.6+, 4.7+, 4.8+, and 5+ families
//      (Opus, Sonnet, Haiku, Fable, Mythos). Legacy Claude 3.x / 4.0 fall back
//      to forced schema tool use.
//   2. Forced `tool_choice` (`{ type: 'any' }` or `{ type: 'tool', name }`):
//      - Rejected whenever manual extended thinking (`thinking: { type: 'enabled' }`)
//        is active on any model.
//      - Under adaptive thinking, accepted by Opus/Sonnet 4.6, Opus 4.7, Opus/Sonnet 5,
//        Haiku 5.5, Fable 5, Mythos 5; rejected by Opus 5.5, Sonnet 5.5, Fable 5.1,
//        and Mythos 5.1.
//   3. Sampling suppression (`temperature`, `top_p`, `top_k`):
//      rejected on Opus 4.7+, Opus 4.8, Fable 5, Mythos 5, Opus 5, Sonnet 5,
//      and Haiku 5.5.
//   4. Effort tokens (`low`/`medium`/`high`/`xhigh`/`max`) are forwarded verbatim
//      without artificial model-family clamping.
// ---------------------------------------------------------------------------

/**
 * Resolve protocol capabilities for an Anthropic Claude model ID.
 * @param {unknown} model
 * @param {{ enableAdaptiveThinking?: boolean }} [options]
 */
export function resolveClaudeModelCapabilities(model, { enableAdaptiveThinking = true } = {}) {
    const base = normalizeModelBaseId(model);
    const lower = base.toLowerCase();

    const supportsThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    const supportsWebSearch = /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    const limitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(lower);
    const noSampling = /^claude-(opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5-5)/.test(lower);
    const supportsVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    const noPrefill = /^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    const adaptiveThinking = /^claude-(haiku-5|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5)/.test(lower)
        || (Boolean(enableAdaptiveThinking) && /^claude-(opus-4-6|sonnet-4-6)/.test(lower));
    const alwaysThinking = /^claude-(fable-5|mythos-5|mythos-preview|opus-5-5)/.test(lower);
    const canDisableThinking = /^claude-(sonnet-5|opus-5|haiku-5-5|sonnet-5-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|opus-4-5|sonnet-4-5|haiku-4-5)/.test(lower)
        && !alwaysThinking;
    const defaultThinkingRequiresDisplay = /^claude-(fable|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);

    let offThinkingMode = 'none';
    if (canDisableThinking && !alwaysThinking) {
        if (/^claude-sonnet-5-5/.test(lower)) {
            offThinkingMode = 'between_tools';
        } else if (/^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|opus-4-5|sonnet-4-5|haiku-4-5)/.test(lower)) {
            offThinkingMode = 'omit';
        } else {
            offThinkingMode = 'disabled';
        }
    }

    const supportsNativeStructuredOutput = /^claude-(opus-4-1|opus-4-5|sonnet-4-5|haiku-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    const rejectsForcedToolWithAdaptiveThinking = /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/.test(lower);
    const adaptiveThinkingByDefault = /^claude-(fable-5|mythos-5|mythos-preview|opus-5|sonnet-5|haiku-5)/.test(lower);
    // Official Anthropic model specs (verified 2026-11-25): 1M context window
    // on Sonnet 4.5+, Opus 4.6+, and all Claude 5 / Fable 5 / Mythos 5 / Haiku 5.5
    // models; 200k on earlier Claude 3/4/Haiku 4.5 models.
    const maxContextTokens = /^claude-(sonnet-4-5|sonnet-4-6|sonnet-5|opus-4-6|opus-4-7|opus-4-8|opus-5|haiku-5|fable-5|mythos-5|mythos-preview)/.test(lower)
        ? 1000000
        : 200000;

    return {
        modelId: base,
        supportsThinking,
        supportsWebSearch,
        limitedSampling,
        noSampling,
        supportsVerbosity,
        noPrefill,
        adaptiveThinking,
        alwaysThinking,
        canDisableThinking,
        offThinkingMode,
        defaultThinkingRequiresDisplay,
        supportsNativeStructuredOutput,
        rejectsForcedToolWithAdaptiveThinking,
        adaptiveThinkingByDefault,
        maxContextTokens,
    };
}

/**
 * Check whether an Anthropic `tool_choice` object forces a tool call.
 * @param {any} toolChoice
 * @returns {boolean}
 */
export function isClaudeForcedToolChoice(toolChoice) {
    return Boolean(toolChoice && typeof toolChoice === 'object' && (toolChoice.type === 'any' || toolChoice.type === 'tool'));
}

/**
 * Validate Claude request thinking + tool_choice compatibility before fetch.
 * Returns a non-retryable 400 conflict error on documented protocol conflicts,
 * or `null` when compatible.
 *
 * @param {object} params
 * @param {unknown} params.model
 * @param {any} [params.thinking]
 * @param {any} [params.toolChoice]
 * @param {boolean} [params.enableAdaptiveThinking]
 */
export function validateClaudeRequestCapabilities({
    model,
    thinking = null,
    toolChoice = null,
    enableAdaptiveThinking = true,
}) {
    if (!isClaudeForcedToolChoice(toolChoice)) {
        return null;
    }

    const caps = resolveClaudeModelCapabilities(model, { enableAdaptiveThinking });
    const modelLabel = caps.modelId || String(model || 'unknown');

    if (thinking?.type === 'enabled') {
        return createCapabilityConflictError(
            `Claude manual extended thinking cannot be combined with forced tool_choice ("${toolChoice.type}") on "${modelLabel}". Switch reasoning effort to off/auto or use tool_choice "auto".`,
            { provider: 'claude', model: modelLabel, conflictCode: 'claude_manual_thinking_forced_tool_conflict' },
        );
    }

    const adaptiveActive = thinking?.type === 'adaptive'
        || (!thinking && (caps.alwaysThinking || caps.adaptiveThinkingByDefault));
    if (adaptiveActive && caps.rejectsForcedToolWithAdaptiveThinking) {
        return createCapabilityConflictError(
            `Model "${modelLabel}" rejects forced tool_choice ("${toolChoice.type}") while adaptive thinking is active. Use tool_choice "auto" or disable thinking where supported.`,
            { provider: 'claude', model: modelLabel, conflictCode: 'claude_adaptive_thinking_forced_tool_conflict' },
        );
    }

    return null;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions & Responses API
//
// Official sources verified 2026-11-25:
//   - https://developers.openai.com/api/docs/guides/latest-model
//   - https://platform.openai.com/docs/guides/reasoning
//   - https://platform.openai.com/docs/guides/function-calling
//   - https://developers.openai.com/api/reference/resources/responses/methods/create
//
// Verified protocol constraints:
//   1. GPT-6 Astra / Sol family (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.2-astra`,
//      `gpt-6.2-sol`, etc.):
//      - Support Chat Completions text generation, but function tools require
//        the OpenAI Responses API (`/v1/responses`).
//      - Reject `reasoning_effort: "none"`; documented lowest substitute is `"low"`.
//      - Reject `temperature`, `top_p`, `logprobs`, and legacy `max_tokens`.
//   2. `o1`/`o3`/`o4` and `gpt-5`/`gpt-6` reasoning models:
//      - Reject `temperature` and `top_p` when reasoning is active (GPT-5.1–5.4
//        non-chat-latest allow sampling only when reasoning effort is `"none"`).
//   3. Native Chat Completions streaming requires `stream_options: { include_usage: true }`
//      to emit token usage.
// ---------------------------------------------------------------------------

/**
 * Resolve protocol capabilities for an OpenAI model ID.
 * @param {unknown} model
 */
export function resolveOpenAIModelCapabilities(model) {
    const base = normalizeModelBaseId(model);
    const lower = base.toLowerCase();

    const isO1 = /^o1(?:-|$)/.test(lower);
    const isOSeries = /^(o1|o3|o4)/.test(lower);
    const isGpt5 = /^gpt-5/.test(lower);
    const isGpt6 = /^gpt-6/.test(lower);
    const isGpt6ResponsesOnlyTools = /^gpt-6(?:\.\d+)?-(?:astra|sol)/.test(lower);
    const isChatLatestGpt5 = /^gpt-5-chat-latest/.test(lower);
    const isGpt51To54NonChat = /^gpt-5\.(1|2|3|4)/.test(lower) && !/chat-latest/.test(lower);
    const rejectsReasoningNone = isGpt6ResponsesOnlyTools;
    const isReasoningModel = isOSeries || isGpt5 || isGpt6;
    const isKnownNonReasoningModel = /^(?:gpt-3\.5|gpt-4|chatgpt-4o|davinci|babbage)/.test(lower) || isChatLatestGpt5;
    const supportsReasoningEffort = isReasoningModel && !isChatLatestGpt5;
    const supportsVerbosity = /^(?:gpt-5|gpt-6)/.test(lower);
    const supportsXhigh = /^gpt-6|^gpt-5\.(4|5|6)|^gpt-5\.1-codex-max/.test(lower);
    const supportsResponsesMax = /^gpt-6|^gpt-5\.6/.test(lower);
    const isBaseGpt5 = /^gpt-5(?:-|$)/.test(lower);

    return {
        modelId: base,
        isO1,
        isOSeries,
        isGpt5,
        isGpt6,
        isReasoningModel,
        isKnownNonReasoningModel,
        supportsReasoningEffort,
        isBaseGpt5,
        isGpt6ResponsesOnlyTools,
        isChatLatestGpt5,
        isGpt51To54NonChat,
        chatCompletionsSupportsTools: !isGpt6ResponsesOnlyTools && !isChatLatestGpt5 && !isO1,
        rejectsReasoningNone,
        supportsVerbosity,
        supportsXhigh,
        supportsResponsesMax,
    };
}

/**
 * Whether sampling parameters (`temperature`, `top_p`) are accepted on the
 * OpenAI Responses API for the given model and resolved reasoning effort.
 * @param {unknown} model
 * @param {string|undefined} resolvedEffort
 * @returns {boolean}
 */
export function openAIResponsesSupportsSampling(model, resolvedEffort) {
    const caps = resolveOpenAIModelCapabilities(model);
    if (!caps.isReasoningModel) return true;
    if (caps.isGpt51To54NonChat && resolvedEffort === 'none') return true;
    return false;
}

/**
 * Validate OpenAI / Azure OpenAI Chat Completions request compatibility before fetch.
 * @param {object} params
 * @param {unknown} params.model
 * @param {boolean} [params.hasTools]
 */
export function validateOpenAIChatCapabilities({ model, hasTools = false }) {
    const caps = resolveOpenAIModelCapabilities(model);
    const modelLabel = caps.modelId || String(model || 'unknown');

    if (hasTools && !caps.chatCompletionsSupportsTools) {
        if (caps.isGpt6ResponsesOnlyTools) {
            return createCapabilityConflictError(
                `Model "${modelLabel}" does not support function calling on Chat Completions. Switch the connection source to OpenAI Responses API.`,
                { provider: 'openai', model: modelLabel, conflictCode: 'openai_chat_tools_require_responses' },
            );
        }
        return createCapabilityConflictError(
            `Model "${modelLabel}" does not support function calling on Chat Completions.`,
            { provider: 'openai', model: modelLabel, conflictCode: 'openai_chat_tools_unsupported' },
        );
    }

    return null;
}

// ---------------------------------------------------------------------------
// MiniMax Chat Completions (https://platform.minimax.io)
//
// Official sources verified 2026-11-25:
//   - https://platform.minimax.io/docs/api-reference/text-post
//   - https://platform.minimax.io/docs/guides/models-intro
//
// Verified protocol constraints:
//   1. `temperature` must lie in `(0.0, 1.0]`; `0` is rejected by the API.
//   2. `M2-her` (retired legacy role-play variant): documented 64K (65,536)
//      context window and hard 2,048 max_tokens completion cap.
//   3. `MiniMax-M3` / `MiniMax-M3.1*`: 1M (1,000,000) context window; no
//      2,048 output cap (API allows up to 512K output tokens).
//   4. Other MiniMax M2 / Text-01 models: 204,800 default context window,
//      no artificial output cap.
// ---------------------------------------------------------------------------

/**
 * Resolve documented MiniMax model context and output token constraints.
 * @param {unknown} model
 */
export function resolveMinimaxModelCapabilities(model) {
    const base = normalizeModelBaseId(model);
    const lower = base.toLowerCase();

    if (lower === 'm2-her' || lower === 'minimax-m2-her') {
        return {
            modelId: base,
            maxContextTokens: 65536,
            maxOutputTokens: 2048, // cap-ok: MiniMax M2-her documented max_tokens ceiling (platform.minimax.io)
            retired: true,
        };
    }

    if (/^minimax-m3(?:$|[.-])/i.test(lower)) {
        return {
            modelId: base,
            maxContextTokens: 1000000,
            maxOutputTokens: null,
            retired: false,
        };
    }

    return {
        modelId: base,
        maxContextTokens: 204800,
        maxOutputTokens: null,
        retired: false,
    };
}
