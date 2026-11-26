/**
 * One-stop request API for Luker extensions. Encapsulates profile resolution,
 * prompt assembly, sender dispatch, and response normalization so extensions
 * never directly touch sendOpenAIRequest / buildPresetAwarePromptMessages /
 * resolveChatCompletionRequestProfile.
 */

import { acquireActivityLease, resolveRequestActivityLeaseOptions, withActivityLease } from './activity-guard.js';
import { regexAgentPluginOutput } from './lib/chat-regex.js';
import { transientSessionHeaders } from './lib/transient-session.js';

function getDefaultResolver() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return ctx?.connectionProfiles?.resolve || null;
}

const SUPPORTED_APIS = new Set(['openai', 'kobold', 'koboldhorde', 'novel', 'textgenerationwebui']);

function getDefaultRawPromptBuilder() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return typeof ctx?.createRawPrompt === 'function' ? ctx.createRawPrompt : null;
}

function getDefaultBuilder() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return typeof ctx?.buildPresetAwarePromptMessages === 'function' ? ctx.buildPresetAwarePromptMessages : null;
}

function getDefaultWorldInfoResolver() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return typeof ctx?.resolveWorldInfoForMessages === 'function' ? ctx.resolveWorldInfoForMessages : null;
}

function getDefaultSenders() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    if (!ctx) return null;
    return ctx.generateTaskSenders || null;
}

function getDefaultSubstituteParams() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return typeof ctx?.substituteParams === 'function' ? ctx.substituteParams : null;
}

function getDefaultCapturedSubstituteParams() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    return typeof ctx?.substituteCapturedMacros === 'function' ? ctx.substituteCapturedMacros : null;
}

function getDefaultCapturedReplyRegex() {
    const ctx = typeof globalThis.Luker?.getContext === 'function'
        ? globalThis.Luker.getContext()
        : null;
    if (!ctx?.regex || typeof ctx.regex.applyRegex !== 'function' || typeof ctx.substituteCapturedMacros !== 'function') {
        return null;
    }
    return (text, promptContext) => {
        const raw = String(text ?? '');
        if (!raw) return '';
        return ctx.regex.applyRegex(raw, ctx.regex.placement.AI_OUTPUT, {
            isPluginOutput: true,
            scripts: Array.isArray(promptContext.regexScripts) ? promptContext.regexScripts : [],
            substitute: (value, options) => ctx.substituteCapturedMacros(value, promptContext.macroEnv, options),
            isolated: true,
        });
    };
}

/**
 * Capture a serializable prompt-context snapshot through the active Luker runtime.
 * Delegated lazily through `Luker.getContext()` so this module remains importable
 * outside the browser bootstrap chain.
 *
 * @param {{ scope: 'preset' | 'chat', llmPresetName?: string, apiPresetName?: string }} [options]
 * @param {{ _injected?: { captureTaskPromptContext?: Function } | null }} [internal]
 * @returns {Promise<object>}
 */
export async function captureTaskPromptContext(options = {}, { _injected = null } = {}) {
    const impl = typeof _injected?.captureTaskPromptContext === 'function'
        ? _injected.captureTaskPromptContext
        : globalThis.Luker?.getContext?.()?.captureTaskPromptContext;
    if (typeof impl !== 'function') {
        throw new GenerateTaskError(
            'unknown',
            'captureTaskPromptContext is unavailable (Luker.getContext().captureTaskPromptContext missing).',
        );
    }
    return await impl(options);
}

function validatePromptContext(promptContext) {
    if (promptContext === null || promptContext === undefined) {
        return null;
    }
    if (typeof promptContext !== 'object'
        || !promptContext.envelope || typeof promptContext.envelope !== 'object'
        || !promptContext.macroEnv || typeof promptContext.macroEnv !== 'object') {
        throw new GenerateTaskError('invalid_input', 'promptContext must be a captured TaskPromptContext object.');
    }
    return promptContext;
}

/**
 * Read `stream_openai` from the preset named by `llmPresetName` (canonical
 * lookup against `openai_setting_names`); fall back to the currently selected
 * chat-completion preset's `oai_settings.stream_openai` when the name is empty
 * or unknown.
 *
 * The OpenAI senders treat `type='quiet'` requests as non-streaming unless the
 * caller flips `allowStreamingForQuiet:true`. `generateTask` always sends
 * 'quiet', so without this lookup every plugin request collapsed to
 * one-shot transport regardless of preset. Reading the flag here lets the
 * caller's selected preset drive transport (SSE vs one-shot POST) without
 * surfacing it as a separate API parameter.
 *
 * Returns `false` when the runtime is unavailable so generate-task degrades
 * gracefully in tests / non-browser contexts.
 *
 * @param {object|null} openAiRuntime  { oai_settings, openai_settings, openai_setting_names }
 * @param {string} llmPresetName
 * @returns {boolean}
 */
export function resolveOpenAiStreamFlag(openAiRuntime, llmPresetName = '') {
    if (!openAiRuntime || typeof openAiRuntime !== 'object') {
        return false;
    }
    const presetName = String(llmPresetName || '').trim();
    if (presetName) {
        const settingNames = openAiRuntime.openai_setting_names || {};
        const settingsList = openAiRuntime.openai_settings || [];
        const presetIndex = settingNames[presetName];
        const presetSource = Number.isInteger(presetIndex) ? settingsList[presetIndex] : null;
        if (presetSource && typeof presetSource === 'object' && Object.hasOwn(presetSource, 'stream_openai')) {
            return Boolean(presetSource.stream_openai);
        }
    }
    return Boolean(openAiRuntime.oai_settings?.stream_openai);
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
        if (message.substituteMacros === false) {
            const { substituteMacros: _skip, ...rest } = message;
            return rest;
        }
        if (Array.isArray(message.content)) {
            let changed = false;
            const nextParts = message.content.map(part => {
                if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text) {
                    const replaced = substituteParamsFn(part.text, { skipSideEffects: true });
                    if (replaced !== part.text) {
                        changed = true;
                        return { ...part, text: replaced };
                    }
                }
                return part;
            });
            return changed ? { ...message, content: nextParts } : message;
        }
        if (typeof message.content !== 'string' || !message.content) {
            return message;
        }
        return { ...message, content: substituteParamsFn(message.content, { skipSideEffects: true }) };
    });
}

/**
 * Create a push/pull async channel for streaming chunks.
 *
 * - `push(chunk)`: produce a chunk. Dropped if no consumer has ever attached
 *   (spec: "Increments arriving with no consumer are not buffered for late
 *   delivery"). Once a consumer attaches via `for await`, subsequent pushes
 *   are delivered to waiters or queued for the next pull.
 * - `close()`: close the channel cleanly; pending `next()` calls resolve `{done:true}`.
 * - `fail(err)`: close the channel with an error; pending and subsequent `next()`
 *   calls reject with the same error instance.
 * - `iterable`: the consumer-facing `AsyncIterable`. Calling `Symbol.asyncIterator`
 *   marks the channel as consumed; the iterator implements both `next()` and
 *   `return()` (the latter so `break` from `for await` closes cleanly).
 *
 * @returns {{
 *   push: (chunk: any) => void,
 *   close: () => void,
 *   fail: (err: Error) => void,
 *   iterable: AsyncIterable<any>,
 * }}
 */
function _createAsyncChunkChannel() {
    const queue = [];
    const waiters = [];
    let closed = false;
    let errored = null;
    let hasConsumer = false;

    const push = (chunk) => {
        if (closed) return;
        if (!hasConsumer) return; // spec: drop chunks if no consumer ever attached
        if (waiters.length > 0) {
            waiters.shift()({ value: chunk, done: false });
        } else {
            queue.push(chunk);
        }
    };

    const close = () => {
        closed = true;
        while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
    };

    const fail = (err) => {
        closed = true;
        errored = err;
        while (waiters.length > 0) waiters.shift()(Promise.reject(err));
    };

    const iterable = {
        [Symbol.asyncIterator]() {
            hasConsumer = true;
            return {
                next() {
                    if (errored) return Promise.reject(errored);
                    if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
                    if (closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve) => { waiters.push(resolve); });
                },
                return() {
                    closed = true;
                    while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
                    return Promise.resolve({ value: undefined, done: true });
                },
            };
        },
    };

    return { push, close, fail, iterable };
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
 * looked up at call time via `globalThis.Luker.getContext().connectionProfiles.resolve`.
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
            'No connection-profile resolver available (Luker.getContext().connectionProfiles.resolve missing). Inject `resolver` or call generateTask after Luker boot.',
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
 * @param {function} [args.postActivationHook] - transform the activated snapshot before injection
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
    postActivationHook = null,
    promptContext = null,
} = {}, {
    worldInfoResolver = null,
} = {}) {
    if (promptContext && typeof promptContext === 'object') {
        return promptContext.runtimeWorldInfo && typeof promptContext.runtimeWorldInfo === 'object'
            ? promptContext.runtimeWorldInfo
            : {};
    }

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
            'worldInfoSource=\'custom\' requires customWorldInfoMessages to be an array',
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
        postActivationHook,
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
    promptContext = null,
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
        ...(promptContext ? { envelope: promptContext.envelope, promptContext } : {}),
        envelopeOptions: {
            includeCharacterCard: promptContext
                ? Boolean(promptContext.envelope?.characterCard)
                : includeCharacterCard !== false,
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
 * globalThis.Luker.getContext().createRawPrompt (wired in Task 0.9).
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
            `requestApi '${requestApi}' folding requires a rawPromptBuilder (createRawPrompt). Inject one or expose it via Luker.getContext().createRawPrompt.`,
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
    apiPresetName = '',
    apiSettingsOverride = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
    transientSessionId = undefined,
    onPreparedRequest = null,
    promptNames = null,
} = {}, { senders = null } = {}) {
    if (!SUPPORTED_APIS.has(requestApi)) {
        throw new GenerateTaskError(
            'unsupported_api',
            `requestApi '${requestApi}' is not supported by dispatchToSender`,
        );
    }
    const sessionHeaders = transientSessionHeaders(transientSessionId);
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
            // apiPresetName is forwarded (not just apiSettingsOverride) so
            // profile-scoped knobs read by name — RPM throttle
            // (openai.js:sendOpenAIRequest) and per-profile max-request-retries
            // (postChatCompletionGenerateRequest → getMaxRequestRetries) —
            // resolve against the caller's target profile, not the active
            // main-chat profile.
            apiPresetName: String(apiPresetName || '').trim(),
            apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            requestScope: 'extension_internal',
            functionCallMode: String(functionCallMode || 'auto'),
            functionCallOptions: functionCallOptions || null,
            ...(transientSessionId !== undefined ? { transientSessionId } : {}),
            ...(typeof onPreparedRequest === 'function' ? { onPreparedRequest } : {}),
            ...(promptNames ? { promptNames } : {}),
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
        const hordeOptions = {};
        if (transientSessionId !== undefined) hordeOptions.transientSessionId = transientSessionId;
        if (typeof onPreparedRequest === 'function') hordeOptions.onPreparedRequest = onPreparedRequest;
        return Object.keys(hordeOptions).length > 0
            ? await s.generateHorde(String(payload), data, abortSignal, false, hordeOptions)
            : await s.generateHorde(String(payload), data, abortSignal, false);
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
    if (typeof onPreparedRequest === 'function') {
        onPreparedRequest({ requestApi, payload: JSON.parse(JSON.stringify(body)) });
    }
    const response = await s.fetchImpl(url, {
        method: 'POST',
        headers: { ...s.getRequestHeaders(), ...sessionHeaders },
        cache: 'no-cache',
        body: JSON.stringify(body),
        signal: abortSignal,
    });
    if (!response.ok) {
        let errBody = null;
        try { errBody = await response.json(); } catch { /* swallow */ }
        const detail = errBody?.error?.message || errBody?.message || (typeof errBody?.error === 'string' ? errBody.error : '');
        throw new GenerateTaskError(
            'network',
            detail ? `${requestApi} sender HTTP ${response.status}: ${detail}` : `${requestApi} sender HTTP ${response.status}`,
            { details: { status: response.status, body: errBody } },
        );
    }
    return await response.json();
}

/**
 * Streaming variant of dispatchToSender. Consumes the openai.js streaming
 * sender (which returns a generator factory yielding cumulative
 * `{ text, toolCalls, state }` frames), computes per-frame text/reasoning
 * deltas, and exposes them through an AsyncIterable. The accumulated final
 * frame is re-shaped into a non-streaming openai response object so
 * `normalizeResponse` can ingest it unchanged.
 *
 * @returns {{ stream: AsyncIterable<{type:'text'|'reasoning',delta:string}>, rawTerminal: Promise<object> }}
 */
export function dispatchToSenderStreaming({
    requestApi,
    payload,
    tools = null,
    toolChoice = 'auto',
    jsonSchema = null,
    llmPresetName = '',
    apiPresetName = '',
    apiSettingsOverride = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
    transientSessionId = undefined,
    onPreparedRequest = null,
    promptNames = null,
} = {}, { senders = null } = {}) {
    if (requestApi !== 'openai') {
        throw new GenerateTaskError(
            'stream_unavailable',
            `streaming is not available for requestApi '${requestApi}'`,
        );
    }
    transientSessionHeaders(transientSessionId);
    const s = senders && typeof senders === 'object' ? senders : {};
    if (typeof s.sendOpenAIRequest !== 'function') {
        throw new GenerateTaskError('unknown', 'dispatchToSenderStreaming requires senders.sendOpenAIRequest');
    }
    const hasTools = Array.isArray(tools) && tools.length > 0;

    // Push/pull channel: producer pushes chunks, consumer pulls via async iterator.
    const channel = _createAsyncChunkChannel();
    const stream = channel.iterable;

    let resolveTerminal, rejectTerminal;
    const rawTerminal = new Promise((res, rej) => { resolveTerminal = res; rejectTerminal = rej; });
    // Caller may consume `stream` and ignore `rawTerminal`; suppress unhandled
    // rejection. The caller's `await rawTerminal` still observes the rejection.
    rawTerminal.catch(() => {});

    (async () => {
        try {
            const genFactory = await s.sendOpenAIRequest('quiet', payload, abortSignal, {
                tools: hasTools ? tools : null,
                toolChoice,
                replaceTools: hasTools,
                jsonSchema,
                llmPresetName: String(llmPresetName || '').trim(),
                // See dispatchToSender: forward apiPresetName so RPM throttle
                // and per-profile max-request-retries resolve against the
                // caller's target profile.
                apiPresetName: String(apiPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallMode: String(functionCallMode || 'auto'),
                functionCallOptions: functionCallOptions || null,
                allowStreamingForQuiet: true,
                ...(transientSessionId !== undefined ? { transientSessionId } : {}),
                ...(typeof onPreparedRequest === 'function' ? { onPreparedRequest } : {}),
                ...(promptNames ? { promptNames } : {}),
            });
            if (typeof genFactory !== 'function') {
                throw new GenerateTaskError('no_response', 'openai streaming sender did not return a generator factory');
            }
            let lastText = '';
            let lastReasoning = '';
            let lastFrame = null;
            for await (const frame of genFactory()) {
                lastFrame = frame;
                const curText = String(frame?.text || '');
                const curReasoning = String(frame?.state?.reasoning || '');
                if (curReasoning.length > lastReasoning.length && curReasoning.startsWith(lastReasoning)) {
                    channel.push({ type: 'reasoning', delta: curReasoning.slice(lastReasoning.length) });
                }
                lastReasoning = curReasoning;
                // openai.js usually appends to `text`, but the plain-text function-call retry
                // path (openai.js attemptPlainTextFunctionCallRetry) REPLACES `text` with the
                // post-retry display string. Detect replacement via `startsWith` and emit the
                // whole new string as one delta in that case so callers receive correct text.
                if (curText !== lastText) {
                    if (curText.startsWith(lastText)) {
                        channel.push({ type: 'text', delta: curText.slice(lastText.length) });
                    } else {
                        channel.push({ type: 'text', delta: curText });
                    }
                }
                lastText = curText;
            }
            channel.close();

            const finalText = lastText;
            const finalReasoning = lastReasoning;
            const finalReasoningBlocks = Array.isArray(lastFrame?.state?.reasoningBlocks)
                ? lastFrame.state.reasoningBlocks.filter(Boolean)
                : [];
            const finalReasoningDetails = Array.isArray(lastFrame?.state?.reasoningDetails)
                ? lastFrame.state.reasoningDetails.filter(Boolean)
                : [];
            // openai.js's streamData accumulates tool calls as a 2D array
            // shaped `toolCalls[choiceIndex][toolCallIndex]`. The
            // non-streaming response shape (which `normalizeResponse`
            // consumes downstream) expects `message.tool_calls` to be
            // 1D — the tool calls for choice 0. Without this flatten,
            // `normalizeResponse` reads `call?.function?.name` on what
            // is actually a sub-array, getting `undefined`, and every
            // tool call ends up with `name: ''`.
            const rawToolCalls = lastFrame?.toolCalls;
            const choiceToolCalls = Array.isArray(rawToolCalls?.[0])
                ? rawToolCalls[0]
                : (Array.isArray(rawToolCalls) ? rawToolCalls : []);
            // Provider-agnostic OpenAI tool_call normalization. ST's
            // `ToolManager.parseToolCalls` accumulates each provider's
            // native streaming shape — Anthropic's `content_block`,
            // Gemini's `part.functionCall`, Cohere's `tool-call-*`
            // events — and historically left the merged tool call in
            // that native shape. Downstream consumers (this file's
            // `normalizeResponse`, every assistant turn echoed back to
            // the API on the next round of a tool-call loop, etc.) all
            // expect the OpenAI shape `{id, type: 'function', function:
            // {name, arguments}}`. Anthropic's path was patched in
            // `parseToolCalls` to fill that view incrementally; this
            // pass is the cross-provider safety net: it normalizes
            // Gemini/Cohere/etc. (and is a no-op when the call is
            // already OpenAI-shaped), and drops sparse holes /
            // unnameable entries before publishing the final result.
            const finalSignature = typeof lastFrame?.state?.signature === 'string' && lastFrame.state.signature.length > 0
                ? lastFrame.state.signature
                : null;
            const finalNativeParts = Array.isArray(lastFrame?.state?.nativeParts)
                ? lastFrame.state.nativeParts.filter(Boolean)
                : [];
            const finalNativeContentBlocks = Array.isArray(lastFrame?.state?.nativeContentBlocks)
                ? lastFrame.state.nativeContentBlocks.filter(Boolean)
                : [];
            const finalResponsesOutputItems = Array.isArray(lastFrame?.state?.responsesOutputItems)
                ? lastFrame.state.responsesOutputItems.filter(Boolean)
                : [];
            const finalCitations = Array.isArray(lastFrame?.state?.citations)
                ? lastFrame.state.citations.filter(Boolean)
                : [];
            const finalRefusal = typeof lastFrame?.state?.refusal === 'string' && lastFrame.state.refusal.length > 0
                ? lastFrame.state.refusal
                : null;
            const finalToolCalls = choiceToolCalls
                .map(tc => _normalizeToolCallToOpenAiShape(tc))
                .filter(tc => tc && typeof tc?.function?.name === 'string' && tc.function.name.length > 0);
            resolveTerminal({
                choices: [{
                    message: {
                        content: finalText,
                        ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
                        ...(finalSignature ? { signature: finalSignature } : {}),
                        ...(finalReasoningBlocks.length > 0 ? { reasoning_blocks: finalReasoningBlocks } : {}),
                        ...(finalReasoningDetails.length > 0 ? { reasoning_details: finalReasoningDetails } : {}),
                        ...(finalNativeParts.length > 0 ? { native_parts: finalNativeParts } : {}),
                        ...(finalNativeContentBlocks.length > 0 ? { native_content_blocks: finalNativeContentBlocks } : {}),
                        ...(finalResponsesOutputItems.length > 0 ? { responses_output_items: finalResponsesOutputItems } : {}),
                        ...(finalCitations.length > 0 ? { citations: finalCitations } : {}),
                        ...(finalRefusal ? { refusal: finalRefusal } : {}),
                        tool_calls: finalToolCalls,
                    },
                    finish_reason: lastFrame?.state?.finishReason || 'stop',
                    ...(lastFrame?.state?.nativeFinishReason ? { native_finish_reason: lastFrame.state.nativeFinishReason } : {}),
                    ...(lastFrame?.state?.stopSequence ? { stop_sequence: lastFrame.state.stopSequence } : {}),
                    ...(lastFrame?.state?.stopDetails ? { stop_details: lastFrame.state.stopDetails } : {}),
                }],
                usage: lastFrame?.state?.usage || null,
            });
        } catch (e) {
            channel.fail(e);
            rejectTerminal(e);
        }
    })();

    return { stream, rawTerminal };
}

/**
 * Coerce a tool-call object from any provider's streaming-native shape
 * into the OpenAI tool_call shape `{id, type: 'function', function:
 * {name, arguments}}`. Used by the streaming pipeline to give downstream
 * normalizers and the next tool-call-loop round a single uniform shape
 * regardless of which provider streamed the call.
 *
 * Provider shapes we may see in input:
 *   - OpenAI:    `{id, type: 'function', function: {name, arguments}}`
 *                (already correct; fast-path returns unchanged)
 *   - Anthropic: `{type: 'tool_use', id, name, input, caller}` — and
 *                `parseToolCalls`'s Anthropic path pre-fills the
 *                OpenAI `function.*` view, so most of these land on
 *                the fast-path too.
 *   - Gemini:    `{name, args, thoughtSignature?}` (args is an object)
 *   - Cohere:    accumulated from `tool-call-*` events; structure
 *                varies — we read whichever name/args fields exist.
 *
 * Returns `null` for sparse holes / un-nameable entries; the caller
 * filters those out before publishing.
 *
 * @param {object|null|undefined} tc
 * @returns {{id: string, type: 'function', function: {name: string, arguments: string}}|null}
 */
function _normalizeToolCallToOpenAiShape(tc) {
    if (!tc || typeof tc !== 'object') return null;
    const signature = typeof tc.signature === 'string' && tc.signature.length > 0
        ? tc.signature
        : (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature.length > 0 ? tc.thoughtSignature : undefined);
    const extraContent = tc.extra_content && typeof tc.extra_content === 'object'
        ? structuredClone(tc.extra_content)
        : undefined;
    // Fast path: already OpenAI-shaped.
    if (tc.function && typeof tc.function === 'object'
        && typeof tc.function.name === 'string' && tc.function.name.length > 0) {
        if ((signature && tc.signature !== signature) || (extraContent && !tc.extra_content)) {
            return {
                ...tc,
                ...(signature ? { signature } : {}),
                ...(extraContent ? { extra_content: extraContent } : {}),
            };
        }
        return tc;
    }
    const name = tc?.function?.name || tc?.name || '';
    if (!name) return null;
    const argsCandidate = tc?.function?.arguments ?? tc?.input ?? tc?.args ?? null;
    let argsStr;
    if (typeof argsCandidate === 'string') {
        argsStr = argsCandidate;
    } else if (argsCandidate && typeof argsCandidate === 'object') {
        try { argsStr = JSON.stringify(argsCandidate); } catch { argsStr = ''; }
    } else {
        argsStr = '';
    }
    return {
        ...tc,
        id: tc.id || `call_${Math.random().toString(36).slice(2, 12)}`,
        type: 'function',
        function: {
            name: String(name),
            arguments: argsStr,
        },
        ...(signature ? { signature } : {}),
        ...(extraContent ? { extra_content: extraContent } : {}),
    };
}

function emptyResultShape(raw) {
    return {
        assistantText: '',
        toolCalls: [],
        jsonData: null,
        reasoning: null,
        signature: null,
        reasoningBlocks: null,
        reasoningDetails: null,
        nativeParts: null,
        nativeContentBlocks: null,
        responsesOutputItems: null,
        citations: null,
        refusal: null,
        finishReason: 'stop',
        nativeFinishReason: null,
        stopDetails: null,
        usage: null,
        raw: raw ?? null,
    };
}

function extractOpenAiUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') {
        return null;
    }
    const promptTokens = Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens);
    const completionTokens = Number(rawUsage.completion_tokens ?? rawUsage.output_tokens);
    const totalRaw = Number(rawUsage.total_tokens);
    const totalTokens = Number.isFinite(totalRaw)
        ? totalRaw
        : ((Number.isFinite(promptTokens) || Number.isFinite(completionTokens))
            ? (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0)
            : NaN);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens) && !Number.isFinite(totalTokens)) {
        return null;
    }
    const out = {
        promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };
    const cachedTokens = Number(rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.input_tokens_details?.cached_tokens ?? rawUsage.cache_read_input_tokens);
    const cacheCreationTokens = Number(rawUsage.prompt_tokens_details?.cache_creation_tokens ?? rawUsage.cache_creation_input_tokens);
    const reasoningTokens = Number(rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.output_tokens_details?.reasoning_tokens);
    const toolUsePromptTokens = Number(rawUsage.prompt_tokens_details?.tool_use_prompt_tokens ?? rawUsage.tool_use_prompt_tokens);
    if (Number.isFinite(cachedTokens)) out.cachedTokens = cachedTokens;
    if (Number.isFinite(cacheCreationTokens)) out.cacheCreationTokens = cacheCreationTokens;
    if (Number.isFinite(reasoningTokens)) out.reasoningTokens = reasoningTokens;
    if (Number.isFinite(toolUsePromptTokens)) out.toolUsePromptTokens = toolUsePromptTokens;
    return out;
}

function coerceFinishReason(value, fallback = 'stop') {
    const v = String(value || '').trim();
    return v || fallback;
}

/**
 * Normalize per-family raw sender response into the unified result shape.
 *
 * @param {object} args
 * @param {string} args.requestApi
 * @param {'text'|'tool'|'json'} args.mode
 * @param {*} args.raw
 * @returns {object} { assistantText, toolCalls, jsonData, reasoning, reasoningBlocks, reasoningDetails, finishReason, usage, raw }
 */
export function normalizeResponse({ requestApi, mode, raw }) {
    const result = emptyResultShape(raw);

    if (mode === 'json') {
        let jsonString;
        if (typeof raw === 'string') {
            jsonString = raw;
        } else if (raw && typeof raw === 'object' && Array.isArray(raw.choices) && raw.choices.length > 0) {
            // openai chat-completion shape — sendOpenAIRequest returns the full data object
            const msg = raw.choices[0]?.message;
            const content = msg?.content;
            // In json mode (`tools` and `jsonSchema` are mutually exclusive), any tool_calls
            // present came from a forced schema tool; check it before prose preamble text.
            if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
                const toolArgs = msg.tool_calls[0]?.function?.arguments;
                if (typeof toolArgs === 'string' && toolArgs.trim().length > 0) {
                    jsonString = toolArgs;
                } else if (toolArgs && typeof toolArgs === 'object') {
                    jsonString = JSON.stringify(toolArgs);
                }
            }
            if (typeof jsonString !== 'string' && typeof content === 'string') {
                jsonString = content;
            }
            if (typeof jsonString !== 'string') {
                throw new GenerateTaskError(
                    'json_schema_violation',
                    'jsonSchema response: choices[0].message.content is not a string',
                    { details: { rawShape: 'chat_completion_no_content_string' } },
                );
            }
            // Also extract metadata available on the openai chat-completion shape.
            result.finishReason = coerceFinishReason(raw.choices[0].finish_reason);
            result.usage = extractOpenAiUsage(raw.usage);
        } else if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
            // Native Anthropic Messages JSON response (forced schema tool_use.input before preamble text).
            const toolUseBlock = raw.content.find(b => b?.type === 'tool_use' && b.input !== undefined);
            const textBlock = raw.content.find(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
            if (toolUseBlock) {
                jsonString = typeof toolUseBlock.input === 'string' ? toolUseBlock.input : JSON.stringify(toolUseBlock.input);
            } else if (textBlock) {
                jsonString = textBlock.text;
            } else {
                throw new GenerateTaskError(
                    'json_schema_violation',
                    'jsonSchema response: native content contains neither JSON text nor tool_use input',
                    { details: { rawShape: 'native_content_no_json' } },
                );
            }
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
        result.signature = typeof message.signature === 'string' && message.signature.length > 0
            ? message.signature
            : null;
        result.reasoningBlocks = Array.isArray(message.reasoning_blocks) && message.reasoning_blocks.length > 0
            ? message.reasoning_blocks
            : null;
        result.reasoningDetails = Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0
            ? message.reasoning_details
            : null;
        result.nativeParts = Array.isArray(message.native_parts) && message.native_parts.length > 0
            ? message.native_parts
            : (Array.isArray(raw?.responseContent?.parts) && raw.responseContent.parts.length > 0 ? raw.responseContent.parts : null);
        result.nativeContentBlocks = Array.isArray(message.native_content_blocks) && message.native_content_blocks.length > 0
            ? message.native_content_blocks
            : (Array.isArray(raw?.content) && raw.content.length > 0 ? raw.content : null);
        result.responsesOutputItems = Array.isArray(message.responses_output_items) && message.responses_output_items.length > 0
            ? message.responses_output_items
            : null;
        result.citations = Array.isArray(message.citations) && message.citations.length > 0
            ? message.citations
            : null;
        result.refusal = typeof message.refusal === 'string' && message.refusal.length > 0
            ? message.refusal
            : null;
        result.finishReason = coerceFinishReason(choice.finish_reason);
        result.nativeFinishReason = typeof choice.native_finish_reason === 'string' && choice.native_finish_reason.length > 0
            ? choice.native_finish_reason
            : (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0 ? choice.finish_reason : null);
        result.stopDetails = choice.stop_details && typeof choice.stop_details === 'object'
            ? choice.stop_details
            : (typeof choice.stop_sequence === 'string' ? { stop_sequence: choice.stop_sequence } : null);
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
                const callSig = typeof call?.signature === 'string' && call.signature.length > 0
                    ? call.signature
                    : (typeof call?.thoughtSignature === 'string' && call.thoughtSignature.length > 0 ? call.thoughtSignature : undefined);
                const callExtra = call?.extra_content && typeof call.extra_content === 'object'
                    ? structuredClone(call.extra_content)
                    : undefined;
                return {
                    name: String(fn?.name || ''),
                    args: parsedArgs,
                    ...(callSig ? { signature: callSig } : {}),
                    ...(callExtra ? { extra_content: callExtra } : {}),
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
    if (error?.nonRetryable === true || error?.code === 'capability_conflict') {
        const wrapped = new GenerateTaskError('capability_conflict', msg, { cause: error });
        wrapped.nonRetryable = true;
        if (error?.status) wrapped.status = error.status;
        return wrapped;
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
 * @param {object} params
 * @param {Array}   [params.taskMessages]
 * @param {boolean} [params.includeCharacterCard=true]
 * @param {'task'|'chat'|'custom'|'none'} [params.worldInfoSource='none']
 * @param {Array|null} [params.customWorldInfoMessages]
 * @param {object|null} [params.runtimeWorldInfo]
 * @param {boolean} [params.forceWorldInfoResimulate]
 * @param {string}  [params.worldInfoType='quiet']
 * @param {function} [params.postActivationHook] - transform the activated snapshot before injection
 * @param {string}  [params.llmPresetName]
 * @param {string}  [params.apiPresetName]
 * @param {Array|null} [params.tools]
 * @param {string|object} [params.toolChoice='auto']
 * @param {object|null} [params.jsonSchema]
 * @param {'auto'|'native'|'prompt_xml'} [params.functionCallMode='auto']
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
 * @param {object} [params.promptContext]
 * @param {string} [params.transientSessionId]
 * @param {function} [params.onPreparedRequest]
 * @param {boolean|object} [params.activity=true] - Activity guard lease override or `false` to opt out
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
    postActivationHook = null,
    llmPresetName = '',
    apiPresetName = '',
    tools = null,
    toolChoice = 'auto',
    jsonSchema = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
    substituteMacros = true,
    promptContext = null,
    transientSessionId = undefined,
    onPreparedRequest = null,
    activity = true,
} = {}, { _injected = null } = {}) {
    // ── 1. Input validation ──
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const hasJsonSchema = jsonSchema && typeof jsonSchema === 'object';
    if (hasTools && hasJsonSchema) {
        throw new GenerateTaskError('invalid_input', 'tools and jsonSchema are mutually exclusive');
    }
    const validatedPromptContext = validatePromptContext(promptContext);
    transientSessionHeaders(transientSessionId);

    const profileResolver = _injected?.profileResolver || null;
    const worldInfoResolver = _injected?.worldInfoResolver || getDefaultWorldInfoResolver();
    const builder = _injected?.builder || getDefaultBuilder();
    const rawPromptBuilder = _injected?.rawPromptBuilder || null;
    const senders = _injected?.senders || getDefaultSenders();
    const substituteParamsFn = _injected?.substituteParams || getDefaultSubstituteParams();

    const leaseOptions = resolveRequestActivityLeaseOptions(activity, 'core:generate-task');
    const runTask = async () => {
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
            postActivationHook,
            promptContext: validatedPromptContext,
        }, { worldInfoResolver });

        // ── 4.5 Macro substitution on caller-supplied task messages ──
        // Preset-supplied prompt entries are substituted later inside
        // buildPresetAwarePromptMessages, but caller-supplied taskMessages bypass
        // that path; without this step, plugin requests ship `{{user}}` /
        // `{{getvar::}}` / etc. as literal text. skipSideEffects:true is mandatory
        // — otherwise every plugin call would re-fire setvar/addvar macros and
        // mutate chat_metadata.variables on each dispatch.
        const effectiveSubstituteFn = validatedPromptContext
            ? (content, options) => {
                const capturedSubstitute = _injected?.substituteCapturedMacros || getDefaultCapturedSubstituteParams();
                if (typeof capturedSubstitute !== 'function') {
                    throw new GenerateTaskError('unknown', 'Captured task macro substitution is unavailable.');
                }
                return capturedSubstitute(content, validatedPromptContext.macroEnv, options);
            }
            : substituteParamsFn;
        const effectiveTaskMessages = substituteMacros
            ? applyMacroSubstitution(taskMessages, effectiveSubstituteFn)
            : taskMessages;

        // ── 5. Assemble messages (envelope-aware, chat-completion shape) ──
        const messages = assembleMessages({
            taskMessages: effectiveTaskMessages,
            includeCharacterCard: validatedPromptContext
                ? Boolean(validatedPromptContext.envelope?.characterCard)
                : includeCharacterCard,
            llmPresetName: effectiveLlmPresetName,
            requestApi: profile.requestApi,
            runtimeWorldInfo: wi,
            promptContext: validatedPromptContext,
        }, { builder });

        // ── 6. Render per-family ──
        const payload = renderForApi(profile.requestApi, messages, { rawPromptBuilder });

        // ── 7. Dispatch ──
        // OpenAI-family: when the resolved preset has `stream_openai: true`, run
        // the streaming sender and accumulate frames into the same chat-completion
        // shape `normalizeResponse` expects. This keeps the wire-level transport
        // tied to the user-selected preset while leaving `generateTask`'s contract
        // — `Promise<terminal>` — unchanged. `generateTaskStream` remains the
        // entry point for callers that want chunk-by-chunk delivery.
        const mode = hasJsonSchema ? RESPONSE_MODES.JSON : (hasTools ? RESPONSE_MODES.TOOL : RESPONSE_MODES.TEXT);
        const promptNames = validatedPromptContext
            ? {
                userName: String(validatedPromptContext.macroEnv?.names?.user ?? ''),
                charName: String(validatedPromptContext.macroEnv?.names?.char ?? ''),
                groupNames: Array.isArray(validatedPromptContext.macroEnv?.contextSnapshot?.groupNames)
                    ? validatedPromptContext.macroEnv.contextSnapshot.groupNames
                    : [],
            }
            : null;
        const useStreamingTransport = profile.requestApi === 'openai'
            && resolveOpenAiStreamFlag(senders?.getOpenAiRuntime?.(), effectiveLlmPresetName);
        let raw;
        try {
            if (useStreamingTransport) {
                const { stream: innerStream, rawTerminal } = dispatchToSenderStreaming({
                    requestApi: profile.requestApi,
                    payload,
                    tools,
                    toolChoice,
                    jsonSchema,
                    llmPresetName: effectiveLlmPresetName,
                    apiPresetName,
                    apiSettingsOverride: profile.apiSettingsOverride,
                    functionCallMode,
                    functionCallOptions,
                    abortSignal,
                    transientSessionId,
                    onPreparedRequest,
                    promptNames,
                }, { senders });
                // Drain inner stream so the producer is not blocked waiting for a
                // consumer (chunks are dropped per channel spec when no consumer
                // attaches, but we attach defensively to avoid back-pressure
                // surprises if that contract ever changes).
                (async () => { try { for await (const _ of innerStream) { /* drop */ } } catch { /* surfaced via rawTerminal */ } })();
                raw = await rawTerminal;
            } else {
                raw = await dispatchToSender({
                    requestApi: profile.requestApi,
                    payload,
                    tools,
                    toolChoice,
                    jsonSchema,
                    llmPresetName: effectiveLlmPresetName,
                    apiPresetName,
                    apiSettingsOverride: profile.apiSettingsOverride,
                    functionCallMode,
                    functionCallOptions,
                    abortSignal,
                    transientSessionId,
                    onPreparedRequest,
                    promptNames,
                }, { senders });
            }
        } catch (e) {
            throw _wrapSenderError(e, abortSignal);
        }

        // ── 8. Normalize response ──
        const result = normalizeResponse({ requestApi: profile.requestApi, mode, raw });

        // ── 9. Plugin output-direction regex pass ──
        // Rules with the plugin reply lane (`pluginLanes: ['reply']`) cook the
        // assistant text a plugin request returns. toolCalls payloads are never touched.
        if (_injected?.regexOutputApplier) {
            result.assistantText = _injected.regexOutputApplier(result.assistantText);
        } else if (validatedPromptContext) {
            const capturedReplyRegex = _injected?.applyCapturedReplyRegex || getDefaultCapturedReplyRegex();
            if (typeof capturedReplyRegex === 'function') {
                result.assistantText = capturedReplyRegex(result.assistantText, validatedPromptContext);
            }
        } else {
            result.assistantText = regexAgentPluginOutput(result.assistantText);
        }

        return result;
    };

    return leaseOptions ? await withActivityLease(leaseOptions, runTask) : await runTask();
}

/**
 * Streaming companion to generateTask. Returns { stream, result }: stream is
 * an AsyncIterable of text/reasoning delta chunks; result is a Promise of the
 * same normalized shape generateTask returns. openai-family only.
 *
 * @param {object} params  same shape as generateTask (jsonSchema is rejected)
 * @returns {{ stream: AsyncIterable<{type:'text'|'reasoning',delta:string}>, result: Promise<object> }}
 */
export function generateTaskStream({
    taskMessages = [],
    includeCharacterCard = true,
    worldInfoSource = 'none',
    customWorldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    postActivationHook = null,
    llmPresetName = '',
    apiPresetName = '',
    tools = null,
    toolChoice = 'auto',
    jsonSchema = null,
    functionCallMode = 'auto',
    functionCallOptions = null,
    abortSignal = undefined,
    substituteMacros = true,
    promptContext = null,
    transientSessionId = undefined,
    onPreparedRequest = null,
    activity = true,
} = {}, { _injected = null } = {}) {
    // ── 1. Input validation ──
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const hasJsonSchema = jsonSchema && typeof jsonSchema === 'object';
    if (hasTools && hasJsonSchema) {
        throw new GenerateTaskError('invalid_input', 'tools and jsonSchema are mutually exclusive');
    }
    const validatedPromptContext = validatePromptContext(promptContext);
    transientSessionHeaders(transientSessionId);

    const profileResolver = _injected?.profileResolver || null;
    const worldInfoResolver = _injected?.worldInfoResolver || getDefaultWorldInfoResolver();
    const builder = _injected?.builder || getDefaultBuilder();
    const rawPromptBuilder = _injected?.rawPromptBuilder || null;
    const senders = _injected?.senders || getDefaultSenders();
    const substituteParamsFn = _injected?.substituteParams || getDefaultSubstituteParams();

    // ── 2. Profile resolution (and stream_unavailable for non-openai) ──
    const profile = resolveProfile(apiPresetName, {
        resolver: profileResolver,
        defaultApi: _injected?.defaultApi || 'openai',
        defaultSource: _injected?.defaultSource || '',
    });
    if (profile.requestApi !== 'openai') {
        throw new GenerateTaskError('stream_unavailable', `streaming is not available for requestApi '${profile.requestApi}'`);
    }

    // ── 3. llmPresetName trim ──
    const effectiveLlmPresetName = String(llmPresetName || '').trim();

    const mode = hasJsonSchema ? RESPONSE_MODES.JSON : (hasTools ? RESPONSE_MODES.TOOL : RESPONSE_MODES.TEXT);

    // Build the user-facing promise eagerly so caller can `await result`
    // without first consuming the stream. The async pipeline below pushes
    // chunks into the stream channel and resolves/rejects `result` at the end.
    let resolveResult, rejectResult;
    const result = new Promise((res, rej) => { resolveResult = res; rejectResult = rej; });
    result.catch(() => {}); // suppress unhandled rejection if caller ignores it

    // Inner-stream forwarding queue (consumer-facing AsyncIterable).
    const channel = _createAsyncChunkChannel();
    const stream = channel.iterable;

    const leaseOptions = resolveRequestActivityLeaseOptions(activity, 'core:generate-task');
    const releaseLease = leaseOptions ? acquireActivityLease(leaseOptions) : () => {};

    (async () => {
        try {
            // ── 4. World info ──
            const wi = await resolveWorldInfo({
                worldInfoSource,
                taskMessages,
                customWorldInfoMessages,
                runtimeWorldInfo,
                forceWorldInfoResimulate,
                worldInfoType,
                postActivationHook,
                promptContext: validatedPromptContext,
            }, { worldInfoResolver });

            // ── 4.5 Macro substitution ──
            const effectiveSubstituteFn = validatedPromptContext
                ? (content, options) => {
                    const capturedSubstitute = _injected?.substituteCapturedMacros || getDefaultCapturedSubstituteParams();
                    if (typeof capturedSubstitute !== 'function') {
                        throw new GenerateTaskError('unknown', 'Captured task macro substitution is unavailable.');
                    }
                    return capturedSubstitute(content, validatedPromptContext.macroEnv, options);
                }
                : substituteParamsFn;
            const effectiveTaskMessages = substituteMacros
                ? applyMacroSubstitution(taskMessages, effectiveSubstituteFn)
                : taskMessages;

            // ── 5. Assemble messages ──
            const messages = assembleMessages({
                taskMessages: effectiveTaskMessages,
                includeCharacterCard: validatedPromptContext
                    ? Boolean(validatedPromptContext.envelope?.characterCard)
                    : includeCharacterCard,
                llmPresetName: effectiveLlmPresetName,
                requestApi: profile.requestApi,
                runtimeWorldInfo: wi,
                promptContext: validatedPromptContext,
            }, { builder });

            // ── 6. Render per-family ──
            const payload = renderForApi(profile.requestApi, messages, { rawPromptBuilder });

            // ── 7. Dispatch (streaming) ──
            const promptNames = validatedPromptContext
                ? {
                    userName: String(validatedPromptContext.macroEnv?.names?.user ?? ''),
                    charName: String(validatedPromptContext.macroEnv?.names?.char ?? ''),
                    groupNames: Array.isArray(validatedPromptContext.macroEnv?.contextSnapshot?.groupNames)
                        ? validatedPromptContext.macroEnv.contextSnapshot.groupNames
                        : [],
                }
                : null;
            const { stream: innerStream, rawTerminal } = dispatchToSenderStreaming({
                requestApi: profile.requestApi,
                payload,
                tools,
                toolChoice,
                jsonSchema,
                llmPresetName: effectiveLlmPresetName,
                apiPresetName,
                apiSettingsOverride: profile.apiSettingsOverride,
                functionCallMode,
                functionCallOptions,
                abortSignal,
                transientSessionId,
                onPreparedRequest,
                promptNames,
            }, { senders });

            // Forward inner chunks to outer stream.
            (async () => {
                try {
                    for await (const c of innerStream) channel.push(c);
                } catch { /* error already surfaced via rawTerminal rejection */ }
            })();

            let raw;
            try {
                raw = await rawTerminal;
            } catch (e) {
                const wrapped = _wrapSenderError(e, abortSignal);
                channel.fail(wrapped);
                rejectResult(wrapped);
                return;
            }
            channel.close();

            // ── 8. Normalize ──
            try {
                const normalized = normalizeResponse({ requestApi: profile.requestApi, mode, raw });
                // ── 9. Plugin output-direction regex pass ──
                // Terminal text only; streamed deltas stay raw.
                if (_injected?.regexOutputApplier) {
                    normalized.assistantText = _injected.regexOutputApplier(normalized.assistantText);
                } else if (validatedPromptContext) {
                    const capturedReplyRegex = _injected?.applyCapturedReplyRegex || getDefaultCapturedReplyRegex();
                    if (typeof capturedReplyRegex === 'function') {
                        normalized.assistantText = capturedReplyRegex(normalized.assistantText, validatedPromptContext);
                    }
                } else {
                    normalized.assistantText = regexAgentPluginOutput(normalized.assistantText);
                }
                resolveResult(normalized);
            } catch (e) {
                rejectResult(e);
            }
        } catch (e) {
            const wrapped = _wrapSenderError(e, abortSignal);
            channel.fail(wrapped);
            rejectResult(wrapped);
        } finally {
            releaseLease();
        }
    })();

    return { stream, result };
}
