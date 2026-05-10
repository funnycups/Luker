/**
 * One-stop request API for Luker extensions. Encapsulates profile resolution,
 * prompt assembly, sender dispatch, and response normalization so extensions
 * never directly touch sendOpenAIRequest / buildPresetAwarePromptMessages /
 * resolveChatCompletionRequestProfile.
 */

function getDefaultResolver() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    return ctx?.connectionProfiles?.resolve || null;
}

const SUPPORTED_APIS = new Set(['openai', 'kobold', 'koboldhorde', 'novel', 'textgenerationwebui']);

function getDefaultRawPromptBuilder() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    return typeof ctx?.createRawPrompt === 'function' ? ctx.createRawPrompt : null;
}

function getDefaultBuilder() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    return typeof ctx?.buildPresetAwarePromptMessages === 'function' ? ctx.buildPresetAwarePromptMessages : null;
}

function getDefaultWorldInfoResolver() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    return typeof ctx?.resolveWorldInfoForMessages === 'function' ? ctx.resolveWorldInfoForMessages : null;
}

function getDefaultSenders() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    if (!ctx) return null;
    return ctx.generateTaskSenders || null;
}

function getDefaultSubstituteParams() {
    const ctx = typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext()
        : null;
    return typeof ctx?.substituteParams === 'function' ? ctx.substituteParams : null;
}

/**
 * Run substituteParams over each task message's string content. Side-effect
 * macros ({{setvar/addvar/incvar/decvar/deletevar}}) are stripped via
 * `skipSideEffects:true` so plugin requests cannot mutate chat_metadata
 * variables on every dispatch.
 *
 * @param {Array} taskMessages
 * @param {(content: string, options?: object) => string} substituteParamsFn
 * @returns {Array}
 */
export function applyMacroSubstitution(taskMessages, substituteParamsFn) {
    if (!Array.isArray(taskMessages) || taskMessages.length === 0) {
        return taskMessages;
    }
    if (typeof substituteParamsFn !== 'function') {
        return taskMessages;
    }
    return taskMessages.map(message => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        if (typeof message.content !== 'string' || !message.content) {
            return message;
        }
        return { ...message, content: substituteParamsFn(message.content, { skipSideEffects: true }) };
    });
}

export class GenerateTaskError extends Error {
    constructor(code, message, { cause = null, details = null } = {}) {
        super(message);
        this.name = 'GenerateTaskError';
        this.code = code;
        this.cause = cause;
        this.details = details;
    }
}

/**
 * Resolve a connection profile name into the (requestApi, apiSettingsOverride) pair
 * needed to dispatch a request. Wraps `resolveChatCompletionRequestProfile` with an
 * injection seam so tests can mock the resolver without setting up live settings.
 *
 * Fully synchronous: when `options.resolver` is omitted, the default resolver is
 * looked up at call time via `globalThis.SillyTavern.getContext().connectionProfiles.resolve`.
 *
 * @param {string} apiPresetName
 * @param {object} [options]
 * @param {function} [options.resolver] - injection seam; defaults to resolveChatCompletionRequestProfile
 * @param {string} [options.defaultApi]
 * @param {string} [options.defaultSource]
 * @returns {{ requestApi: string, apiSettingsOverride: object|null }}
 */
export function resolveProfile(apiPresetName, {
    resolver = null,
    defaultApi = 'openai',
    defaultSource = '',
} = {}) {
    const effectiveResolver = typeof resolver === 'function' ? resolver : getDefaultResolver();
    if (typeof effectiveResolver !== 'function') {
        throw new GenerateTaskError(
            'unknown',
            'No connection-profile resolver available (SillyTavern.getContext().connectionProfiles.resolve missing). Inject `resolver` or call generateTask after Luker boot.',
        );
    }
    const resolution = effectiveResolver({
        profileName: String(apiPresetName || '').trim(),
        defaultApi: String(defaultApi || 'openai').trim() || 'openai',
        defaultSource: String(defaultSource || '').trim(),
    });
    return {
        requestApi: String(resolution?.requestApi || defaultApi || 'openai'),
        apiSettingsOverride: resolution?.apiSettingsOverride && typeof resolution.apiSettingsOverride === 'object'
            ? resolution.apiSettingsOverride
            : null,
    };
}

/**
 * Compute the runtime world info snapshot for a generateTask call.
 * Short-circuits when caller provides runtimeWorldInfo (unless forceWorldInfoResimulate).
 *
 * @param {object} args
 * @param {'task'|'chat'|'custom'|'none'} [args.worldInfoSource='none']
 * @param {Array} [args.taskMessages]
 * @param {Array|null} [args.customWorldInfoMessages]
 * @param {object|null} [args.runtimeWorldInfo]
 * @param {boolean} [args.forceWorldInfoResimulate]
 * @param {string} [args.worldInfoType]
 * @param {object} [options]
 * @param {function} [options.worldInfoResolver] - resolveWorldInfoForMessages-shaped function (msgs, opts) => snapshot
 * @returns {Promise<object>}
 */
export async function resolveWorldInfo({
    worldInfoSource = 'none',
    taskMessages = [],
    customWorldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
} = {}, {
    worldInfoResolver = null,
} = {}) {
    const hasSnapshot = runtimeWorldInfo && typeof runtimeWorldInfo === 'object'
        && Object.keys(runtimeWorldInfo).length > 0;
    if (hasSnapshot && !forceWorldInfoResimulate) {
        return runtimeWorldInfo;
    }

    if (worldInfoSource === 'none') {
        return {};
    }
    if (worldInfoSource === 'custom' && !Array.isArray(customWorldInfoMessages)) {
        throw new GenerateTaskError(
            'invalid_input',
            "worldInfoSource='custom' requires customWorldInfoMessages to be an array",
        );
    }
    if (typeof worldInfoResolver !== 'function') {
        return {};
    }

    let messages;
    let fallbackToCurrentChat;
    switch (worldInfoSource) {
        case 'task':
            messages = Array.isArray(taskMessages) ? taskMessages : [];
            fallbackToCurrentChat = false;
            break;
        case 'chat':
            messages = [];
            fallbackToCurrentChat = true;
            break;
        case 'custom':
            messages = customWorldInfoMessages;
            fallbackToCurrentChat = false;
            break;
        default:
            throw new GenerateTaskError(
                'invalid_input',
                `Unknown worldInfoSource: '${worldInfoSource}'`,
            );
    }

    return await worldInfoResolver(messages, {
        type: String(worldInfoType || 'quiet'),
        fallbackToCurrentChat,
    });
}

/**
 * Build the chat-completion-shaped message array using the active prompt preset envelope.
 * Output is always [{role, content}, ...]; non-openai families fold this later via renderForApi.
 *
 * Rule: when `llmPresetName` is set, force envelope api='openai' (regardless of requestApi),
 * matching existing extension behavior (memory-graph / completion-preset-assistant).
 *
 * @param {object} args
 * @param {Array} args.taskMessages
 * @param {boolean} [args.includeCharacterCard]
 * @param {string} [args.llmPresetName]
 * @param {string} [args.requestApi='openai']
 * @param {object|null} [args.runtimeWorldInfo]
 * @param {object} [options]
 * @param {function} [options.builder] - context.buildPresetAwarePromptMessages, must be injected
 * @returns {Array}
 */
export function assembleMessages({
    taskMessages = [],
    includeCharacterCard = true,
    llmPresetName = '',
    requestApi = 'openai',
    runtimeWorldInfo = null,
} = {}, { builder } = {}) {
    if (typeof builder !== 'function') {
        throw new GenerateTaskError(
            'unknown',
            'assembleMessages requires a builder function (context.buildPresetAwarePromptMessages)',
        );
    }
    const presetName = String(llmPresetName || '').trim();
    const envelopeApi = presetName ? 'openai' : (String(requestApi || 'openai').trim() || 'openai');
    return builder({
        messages: Array.isArray(taskMessages) ? taskMessages : [],
        envelopeOptions: {
            includeCharacterCard: includeCharacterCard !== false,
            api: envelopeApi,
            promptPresetName: presetName,
        },
        promptPresetName: presetName,
        runtimeWorldInfo: runtimeWorldInfo || null,
    });
}

/**
 * Convert chat-completion messages array into the shape expected by the per-family sender.
 * - openai: pass through (messages array)
 * - kobold/koboldhorde/novel/textgenerationwebui: fold via rawPromptBuilder → single text string
 * - any other requestApi: throws unsupported_api
 *
 * The default rawPromptBuilder is looked up at runtime via
 * globalThis.SillyTavern.getContext().createRawPrompt (wired in Task 0.9).
 * Tests must inject `rawPromptBuilder`.
 *
 * @param {string} requestApi
 * @param {Array} messages
 * @param {object} [options]
 * @param {function} [options.rawPromptBuilder]
 * @returns {Array|string}
 */
export function renderForApi(requestApi, messages, { rawPromptBuilder = null } = {}) {
    if (!SUPPORTED_APIS.has(requestApi)) {
        throw new GenerateTaskError(
            'unsupported_api',
            `requestApi '${requestApi}' is not supported by generateTask`,
        );
    }
    if (requestApi === 'openai') {
        return messages;
    }
    const builder = typeof rawPromptBuilder === 'function'
        ? rawPromptBuilder
        : getDefaultRawPromptBuilder();
    if (typeof builder !== 'function') {
        throw new GenerateTaskError(
            'unsupported_api',
            `requestApi '${requestApi}' folding requires a rawPromptBuilder (createRawPrompt). Inject one or expose it via SillyTavern.getContext().createRawPrompt.`,
        );
    }
    return builder(messages, requestApi, false, false, '', '');
}

/**
 * Dispatch a request to the per-family sender. ALL senders are injected via the
 * `senders` option — there is no module-level default because static imports of
 * sibling sender modules would pull in `script.js` → `lib.js` → `lib.core.bundle.js`
 * and break Jest. Task 0.8 (`generateTask` main) is responsible for assembling
 * the senders bundle at runtime.
 *
 * Required keys per requestApi:
 * - openai: `sendOpenAIRequest`
 * - koboldhorde: `generateHorde`, `getKoboldGenerationData`, `getKoboldRuntime`
 * - kobold (non-horde): `getKoboldGenerationData`, `getKoboldRuntime`, `getGenerateUrl`, `getRequestHeaders`, `fetchImpl`
 * - novel: `getNovelGenerationData`, `getNovelRuntime`, `getGenerateUrl`, `getRequestHeaders`, `fetchImpl`
 * - textgenerationwebui: `getTextGenGenerationData`, `getGenerateUrl`, `getRequestHeaders`, `fetchImpl`
 *
 * @returns {Promise<*>} raw sender response (sender-specific shape)
 */
export async function dispatchToSender({
    requestApi,
    payload,
    tools = null,
    toolChoice = 'auto',
    jsonSchema = null,
    llmPresetName = '',
    apiSettingsOverride = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
} = {}, { senders = null } = {}) {
    if (!SUPPORTED_APIS.has(requestApi)) {
        throw new GenerateTaskError(
            'unsupported_api',
            `requestApi '${requestApi}' is not supported by dispatchToSender`,
        );
    }
    const s = senders && typeof senders === 'object' ? senders : {};

    if (requestApi === 'openai') {
        if (typeof s.sendOpenAIRequest !== 'function') {
            throw new GenerateTaskError('unknown', 'dispatchToSender openai path requires senders.sendOpenAIRequest');
        }
        const hasTools = Array.isArray(tools) && tools.length > 0;
        return await s.sendOpenAIRequest('quiet', payload, abortSignal, {
            tools: hasTools ? tools : null,
            toolChoice,
            replaceTools: hasTools,
            jsonSchema,
            llmPresetName: String(llmPresetName || '').trim(),
            apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            requestScope: 'extension_internal',
            functionCallMode: String(functionCallMode || 'auto'),
            functionCallOptions: functionCallOptions || null,
        });
    }

    if (requestApi === 'koboldhorde') {
        if (typeof s.generateHorde !== 'function' || typeof s.getKoboldGenerationData !== 'function' || typeof s.getKoboldRuntime !== 'function') {
            throw new GenerateTaskError('unknown', 'dispatchToSender koboldhorde path requires senders.generateHorde / getKoboldGenerationData / getKoboldRuntime');
        }
        const rt = s.getKoboldRuntime();
        const settings = rt?.koboldai_settings && rt?.koboldai_setting_names
            ? rt.koboldai_settings[rt.koboldai_setting_names[rt.kai_settings?.preset_settings]]
            : null;
        const data = s.getKoboldGenerationData(String(payload), settings, rt?.amount_gen, rt?.max_context, true, 'quiet');
        return await s.generateHorde(String(payload), data, abortSignal, false);
    }

    let body;
    if (requestApi === 'kobold') {
        if (typeof s.getKoboldGenerationData !== 'function' || typeof s.getKoboldRuntime !== 'function') {
            throw new GenerateTaskError('unknown', 'dispatchToSender kobold path requires senders.getKoboldGenerationData / getKoboldRuntime');
        }
        const rt = s.getKoboldRuntime();
        if (rt?.kai_settings?.preset_settings === 'gui') {
            body = {
                prompt: String(payload),
                gui_settings: true,
                max_length: rt.amount_gen,
                max_context_length: rt.max_context,
                api_server: rt.kai_settings.api_server,
            };
        } else {
            const settings = rt?.koboldai_settings && rt?.koboldai_setting_names
                ? rt.koboldai_settings[rt.koboldai_setting_names[rt.kai_settings.preset_settings]]
                : null;
            body = s.getKoboldGenerationData(String(payload), settings, rt?.amount_gen, rt?.max_context, false, 'quiet');
        }
    } else if (requestApi === 'novel') {
        if (typeof s.getNovelGenerationData !== 'function' || typeof s.getNovelRuntime !== 'function') {
            throw new GenerateTaskError('unknown', 'dispatchToSender novel path requires senders.getNovelGenerationData / getNovelRuntime');
        }
        const rt = s.getNovelRuntime();
        const settings = rt?.novelai_settings && rt?.novelai_setting_names
            ? rt.novelai_settings[rt.novelai_setting_names[rt.nai_settings?.preset_settings_novel]]
            : null;
        body = s.getNovelGenerationData(payload, settings, rt?.amount_gen, false, false, null, 'quiet');
    } else { // textgenerationwebui
        if (typeof s.getTextGenGenerationData !== 'function') {
            throw new GenerateTaskError('unknown', 'dispatchToSender textgenerationwebui path requires senders.getTextGenGenerationData');
        }
        body = await s.getTextGenGenerationData(payload, undefined, false, false, null, 'quiet');
    }

    if (typeof s.getGenerateUrl !== 'function' || typeof s.getRequestHeaders !== 'function' || typeof s.fetchImpl !== 'function') {
        throw new GenerateTaskError('unknown', `dispatchToSender ${requestApi} path requires senders.getGenerateUrl / getRequestHeaders / fetchImpl`);
    }
    const url = s.getGenerateUrl(requestApi);
    const response = await s.fetchImpl(url, {
        method: 'POST',
        headers: s.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
        signal: abortSignal,
    });
    if (!response.ok) {
        let errBody = null;
        try { errBody = await response.json(); } catch { /* swallow */ }
        throw new GenerateTaskError(
            'network',
            `${requestApi} sender HTTP ${response.status}`,
            { details: { status: response.status, body: errBody } },
        );
    }
    return await response.json();
}

const VALID_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'abort', 'error']);

function emptyResultShape(raw) {
    return {
        assistantText: '',
        toolCalls: [],
        jsonData: null,
        reasoning: null,
        finishReason: 'stop',
        usage: null,
        raw: raw ?? null,
    };
}

function extractOpenAiUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') {
        return null;
    }
    const promptTokens = Number(rawUsage.prompt_tokens);
    const completionTokens = Number(rawUsage.completion_tokens);
    const totalTokens = Number(rawUsage.total_tokens);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens) && !Number.isFinite(totalTokens)) {
        return null;
    }
    return {
        promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };
}

function coerceFinishReason(value, fallback = 'stop') {
    const v = String(value || '').trim();
    return VALID_FINISH_REASONS.has(v) ? v : fallback;
}

/**
 * Normalize per-family raw sender response into the unified result shape.
 *
 * @param {object} args
 * @param {string} args.requestApi
 * @param {'text'|'tool'|'json'} args.mode
 * @param {*} args.raw
 * @returns {object} { assistantText, toolCalls, jsonData, reasoning, finishReason, usage, raw }
 */
export function normalizeResponse({ requestApi, mode, raw }) {
    const result = emptyResultShape(raw);

    if (mode === 'json') {
        let jsonString;
        if (typeof raw === 'string') {
            jsonString = raw;
        } else if (raw && typeof raw === 'object' && Array.isArray(raw.choices) && raw.choices.length > 0) {
            // openai chat-completion shape — sendOpenAIRequest returns the full data object
            const content = raw.choices[0]?.message?.content;
            if (typeof content !== 'string') {
                throw new GenerateTaskError(
                    'json_schema_violation',
                    'jsonSchema response: choices[0].message.content is not a string',
                    { details: { rawShape: 'chat_completion_no_content_string' } },
                );
            }
            jsonString = content;
            // Also extract metadata available on the openai chat-completion shape.
            result.finishReason = coerceFinishReason(raw.choices[0].finish_reason);
            result.usage = extractOpenAiUsage(raw.usage);
        } else {
            throw new GenerateTaskError(
                'json_schema_violation',
                'jsonSchema response: unrecognized shape (expected string or chat-completion object)',
                { details: { rawType: typeof raw } },
            );
        }
        try {
            result.jsonData = JSON.parse(jsonString);
        } catch (e) {
            throw new GenerateTaskError(
                'json_schema_violation',
                `jsonSchema response failed JSON.parse: ${e.message}`,
                { cause: e, details: { jsonString } },
            );
        }
        return result;
    }

    if (requestApi === 'openai') {
        const choice = Array.isArray(raw?.choices) ? raw.choices[0] : null;
        if (!choice || !choice.message) {
            throw new GenerateTaskError('no_response', 'openai sender returned no choices');
        }
        const message = choice.message;
        result.assistantText = String(message.content || '');
        result.reasoning = message.reasoning_content
            ? String(message.reasoning_content)
            : (message.reasoning ? String(message.reasoning) : null);
        result.finishReason = coerceFinishReason(choice.finish_reason);
        result.usage = extractOpenAiUsage(raw.usage);

        if (mode === 'tool' && Array.isArray(message.tool_calls)) {
            result.toolCalls = message.tool_calls.map(call => {
                const fn = call?.function;
                let parsedArgs = {};
                const rawArgs = String(fn?.arguments ?? '');
                if (rawArgs) {
                    try {
                        parsedArgs = JSON.parse(rawArgs);
                    } catch (e) {
                        throw new GenerateTaskError(
                            'tool_call_parse',
                            `Tool call '${fn?.name}' arguments failed JSON.parse: ${e.message}`,
                            { cause: e, details: { rawArgs } },
                        );
                    }
                }
                return {
                    name: String(fn?.name || ''),
                    args: parsedArgs,
                    raw: call,
                };
            });
        }
        return result;
    }

    // kobold / koboldhorde / novel / textgenerationwebui
    let text = '';
    if (Array.isArray(raw?.results) && raw.results.length > 0) {
        text = String(raw.results[0]?.text || '');
    } else if (Array.isArray(raw?.choices) && raw.choices.length > 0) {
        text = String(raw.choices[0]?.text || raw.choices[0]?.message?.content || '');
    } else if (typeof raw === 'string') {
        text = raw;
    }
    if (!text) {
        throw new GenerateTaskError('no_response', `${requestApi} sender returned no text`);
    }
    result.assistantText = text;
    return result;
}

function _wrapSenderError(error, abortSignal) {
    if (error instanceof GenerateTaskError) {
        return error;
    }
    const msg = error?.message ? String(error.message) : String(error);
    const isAbort = error?.name === 'AbortError'
        || msg === 'Cancelled by stop event'
        || (abortSignal && abortSignal.aborted);
    if (isAbort) {
        return new GenerateTaskError('aborted', 'request aborted', { cause: error });
    }
    if (error?.code === 'ENOTFOUND' || /fetch|network|ENETUNREACH|ECONNREFUSED/i.test(msg)) {
        return new GenerateTaskError('network', `network error: ${msg}`, { cause: error });
    }
    if (/api[ _-]?key|unauthorized|401/i.test(msg)) {
        return new GenerateTaskError('auth_missing', `auth error: ${msg}`, { cause: error });
    }
    if (/429|rate[ _-]?limit/i.test(msg)) {
        return new GenerateTaskError('rate_limit', `rate limited: ${msg}`, { cause: error });
    }
    return new GenerateTaskError('unknown', `generateTask sender failed: ${msg}`, { cause: error });
}

const RESPONSE_MODES = { TEXT: 'text', TOOL: 'tool', JSON: 'json' };

/**
 * Luker.context.generateTask — one-stop extension request API.
 *
 * Encapsulates: profile resolution, prompt envelope assembly, multi-family
 * sender dispatch, and unified response normalization. Extensions should
 * never directly call sendOpenAIRequest / buildPresetAwarePromptMessages /
 * resolveChatCompletionRequestProfile.
 *
 * See `docs/superpowers/specs/2026-05-06-generate-task-design.md` for the
 * full surface description and design rationale.
 *
 * @param {object} params
 * @param {Array}   [params.taskMessages]
 * @param {boolean} [params.includeCharacterCard=true]
 * @param {'task'|'chat'|'custom'|'none'} [params.worldInfoSource='none']
 * @param {Array|null} [params.customWorldInfoMessages]
 * @param {object|null} [params.runtimeWorldInfo]
 * @param {boolean} [params.forceWorldInfoResimulate]
 * @param {string}  [params.worldInfoType='quiet']
 * @param {string}  [params.llmPresetName]
 * @param {string}  [params.apiPresetName]
 * @param {Array|null} [params.tools]
 * @param {string|object} [params.toolChoice='auto']
 * @param {object|null} [params.jsonSchema]
 * @param {'auto'|'native'|'prompt_xml'|'prompt_json'} [params.functionCallMode='auto']
 * @param {object|null} [params.functionCallOptions]
 * @param {AbortSignal} [params.abortSignal]
 * @param {boolean} [params.substituteMacros=true] - Apply `substituteParams` (with
 *   `skipSideEffects:true`) to each task message's string `content` before
 *   assembly so registered macros — Luker built-ins (`{{user}}`, `{{char}}`,
 *   `{{datetime}}`, `{{random:a,b}}`, …) and any extension-registered macros
 *   that flow through the same engine (e.g. MagVarUpdate's `{{getvar::}}`) —
 *   resolve in plugin requests just like in the main chat path. Set to `false`
 *   for authoring-class flows whose AI must see `{{...}}` literally (preset
 *   editor, character card editor, lorebook diff analysis); see the
 *   "When to opt out" section in
 *   `docs/development/extension-api/generation.md`.
 * @param {object} [internal] - injection seam for tests; do not pass from extension code
 * @returns {Promise<object>} unified result shape (see spec)
 */
export async function generateTask({
    taskMessages = [],
    includeCharacterCard = true,
    worldInfoSource = 'none',
    customWorldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    llmPresetName = '',
    apiPresetName = '',
    tools = null,
    toolChoice = 'auto',
    jsonSchema = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
    substituteMacros = true,
} = {}, { _injected = null } = {}) {
    // ── 1. Input validation ──
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const hasJsonSchema = jsonSchema && typeof jsonSchema === 'object';
    if (hasTools && hasJsonSchema) {
        throw new GenerateTaskError('invalid_input', 'tools and jsonSchema are mutually exclusive');
    }

    const profileResolver = _injected?.profileResolver || null;
    const worldInfoResolver = _injected?.worldInfoResolver || getDefaultWorldInfoResolver();
    const builder = _injected?.builder || getDefaultBuilder();
    const rawPromptBuilder = _injected?.rawPromptBuilder || null;
    const senders = _injected?.senders || getDefaultSenders();
    const substituteParamsFn = _injected?.substituteParams || getDefaultSubstituteParams();

    // ── 2. Profile resolution ──
    const profile = resolveProfile(apiPresetName, {
        resolver: profileResolver,
        defaultApi: _injected?.defaultApi || 'openai',
        defaultSource: _injected?.defaultSource || '',
    });

    // ── 3. llmPresetName cross-family check ──
    let effectiveLlmPresetName = String(llmPresetName || '').trim();
    if (effectiveLlmPresetName && profile.requestApi !== 'openai') {
        console.warn(`[generate-task] llmPresetName='${effectiveLlmPresetName}' ignored on non-openai requestApi='${profile.requestApi}'`);
        effectiveLlmPresetName = '';
    }

    // ── 4. World info ──
    const wi = await resolveWorldInfo({
        worldInfoSource,
        taskMessages,
        customWorldInfoMessages,
        runtimeWorldInfo,
        forceWorldInfoResimulate,
        worldInfoType,
    }, { worldInfoResolver });

    // ── 4.5 Macro substitution on caller-supplied task messages ──
    // Preset-supplied prompt entries are substituted later inside
    // buildPresetAwarePromptMessages, but caller-supplied taskMessages bypass
    // that path; without this step, plugin requests ship `{{user}}` /
    // `{{getvar::}}` / etc. as literal text. skipSideEffects:true is mandatory
    // — otherwise every plugin call would re-fire setvar/addvar macros and
    // mutate chat_metadata.variables on each dispatch.
    const effectiveTaskMessages = substituteMacros
        ? applyMacroSubstitution(taskMessages, substituteParamsFn)
        : taskMessages;

    // ── 5. Assemble messages (envelope-aware, chat-completion shape) ──
    const messages = assembleMessages({
        taskMessages: effectiveTaskMessages,
        includeCharacterCard,
        llmPresetName: effectiveLlmPresetName,
        requestApi: profile.requestApi,
        runtimeWorldInfo: wi,
    }, { builder });

    // ── 6. Render per-family ──
    const payload = renderForApi(profile.requestApi, messages, { rawPromptBuilder });

    // ── 7. Dispatch ──
    const mode = hasJsonSchema ? RESPONSE_MODES.JSON : (hasTools ? RESPONSE_MODES.TOOL : RESPONSE_MODES.TEXT);
    let raw;
    try {
        raw = await dispatchToSender({
            requestApi: profile.requestApi,
            payload,
            tools,
            toolChoice,
            jsonSchema,
            llmPresetName: effectiveLlmPresetName,
            apiSettingsOverride: profile.apiSettingsOverride,
            functionCallMode,
            functionCallOptions,
            abortSignal,
        }, { senders });
    } catch (e) {
        throw _wrapSenderError(e, abortSignal);
    }

    // ── 8. Normalize response ──
    return normalizeResponse({ requestApi: profile.requestApi, mode, raw });
}
