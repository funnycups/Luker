/**
 * Tool-call request driver — shared infrastructure used by the iteration-
 * studio shell (every adapter's LLM round-trip) and the orchestrator
 * runtime. Handles SSE / non-SSE transport selection, the RPM throttle
 * window, retry-on-empty-tool-call, and abort propagation.
 *
 * Originally lived in extensions/orchestrator/ as the orchestrator's
 * one-call-per-node driver; later hoisted to lib/ so
 * the iteration-studio shell no longer imports from a plugin.
 *
 * Two related concerns live here:
 *
 *   1. Outbound requests — `requestToolCallWithRetry` (single forced
 *      function) and `requestToolCallsWithRetry` (multi tool, allowed
 *      names list). Both wrap `context.generateTask` from the Luker
 *      extension API: the helper resolves the connection profile + LLM
 *      preset internally, so callers pass `apiPresetName` /
 *      `llmPresetName` strings and a pre-resolved `runtimeWorldInfo`
 *      snapshot rather than a full `promptMessages` envelope. Both
 *      retry on transient failures up to `settings.toolCallRetryMax`,
 *      and gate every call through `waitForRpmSlot` to enforce
 *      `settings.rpmLimit`. Aborts are wired through whatever signal
 *      the caller passes (typically the user's stop-generation button);
 *      no time-triggered deadline.
 *
 *   2. Persistent tool-call message construction — the AI iteration
 *      session stores assistant turns with `tool_calls` / `tool_results`
 *      arrays so they round-trip through chat-completion replays. The
 *      `*PersistentTool*` family normalizes those payloads; the
 *      `buildExecutionToolCalls` / `appendStandardToolRoundMessages`
 *      family converts runtime tool-call records into the same shape
 *      for the standard chat history.
 */

// RPM windows live in a module-private Map keyed by bucket name. Callers
// that omit `rpmBucket` share the 'default' window: two iteration-studio
// popups open at once (e.g. CardApp Studio + orchestrator's iteration
// popup) queue against the same window, matching the user-facing concept
// of "I have one backend rate limit," not per-popup quota. Memory-graph's
// recall / extraction runtime passes its own bucket so it keeps the
// independent window it had before it moved onto this runner.

import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../extensions/function-call-runtime.js';
import {
    isAbortError,
    isAbortSignalLike,
    throwIfAborted,
} from './abort-utils.js';

const MODULE_NAME = 'orchestrator';

const DEFAULT_RPM_BUCKET = 'default';
const _rpmTimestamps = new Map();

function getRpmBucketTimestamps(bucket) {
    const key = String(bucket || '').trim() || DEFAULT_RPM_BUCKET;
    let timestamps = _rpmTimestamps.get(key);
    if (!timestamps) {
        timestamps = [];
        _rpmTimestamps.set(key, timestamps);
    }
    return timestamps;
}

/**
 * Normalize a tool-call retry count. `null`, `undefined` and blank strings
 * return `fallback`; anything else goes through `Number()`, and a finite
 * result is floored and clamped at 0. There is no upper bound: the value is
 * a user setting and every retry is gated by the RPM limiter and the
 * caller's abort signal.
 */
export function normalizeToolCallRetryMax(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

export async function waitForRpmSlot(settings, abortSignal = null, bucket = DEFAULT_RPM_BUCKET) {
    const limit = Math.max(0, Math.floor(Number(settings?.rpmLimit) || 0));
    if (limit <= 0) return;
    const timestamps = getRpmBucketTimestamps(bucket);
    const windowMs = 60_000;
    const pollMs = 200;
    while (true) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) return;
        const now = Date.now();
        while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
            timestamps.shift();
        }
        if (timestamps.length < limit) {
            timestamps.push(now);
            return;
        }
        const waitUntil = timestamps[0] + windowMs;
        const delay = Math.min(pollMs, Math.max(10, waitUntil - now));
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

function isNonRetryableToolError(error) {
    return Boolean(
        error?.nonRetryable === true
        || error?.code === 'capability_conflict'
        || error?.cause?.nonRetryable === true
        || error?.cause?.code === 'capability_conflict',
    );
}

export async function requestToolCallWithRetry(context, settings, {
    taskMessages = [],
    runtimeWorldInfo = null,
    apiPresetName = '',
    llmPresetName = '',
    functionName = '',
    functionDescription = '',
    parameters = {},
    abortSignal = null,
    includeCharacterCard = true,
    promptContext = null,
    transientSessionId = undefined,
    onPreparedRequest = null,
    activity = undefined,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retries = normalizeToolCallRetryMax(settings?.toolCallRetryMax, 0);
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
        const attemptSignal = isAbortSignalLike(abortSignal) ? abortSignal : null;
        try {
            throwIfAborted(abortSignal, 'Tool-call request aborted.');
            await waitForRpmSlot(settings, abortSignal);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: includeCharacterCard !== false,
                worldInfoSource: 'none',
                runtimeWorldInfo: runtimeWorldInfo || {},
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice,
                functionCallMode: 'auto',
                functionCallOptions: {
                    requiredFunctionName: fnName,
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                abortSignal: attemptSignal,
                ...(promptContext !== null && promptContext !== undefined ? { promptContext } : {}),
                ...(transientSessionId !== undefined ? { transientSessionId } : {}),
                ...(typeof onPreparedRequest === 'function' ? { onPreparedRequest } : {}),
                ...(activity !== undefined ? { activity } : {}),
            };
            const result = await context.generateTask(generateTaskOpts);
            throwIfAborted(abortSignal, 'Tool-call request aborted.');
            const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            const matched = calls.find(call => String(call?.name || '') === fnName);
            if (!matched) {
                throw new Error(`Model returned tool call, but not '${fnName}'.`);
            }
            return matched.args && typeof matched.args === 'object' ? matched.args : {};
        } catch (error) {
            if (isAbortError(error, abortSignal) || isNonRetryableToolError(error)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error(`Tool call '${fnName}' failed.`);
}

// Control-flow tool calls do not represent edits to apply; they steer the
// runner / iteration loop itself and are routed to `onControlCall` instead
// of `onToolCall` so popups can update their state machine without treating
// them as user-visible operations.
//
// Detection is delegated to the caller via `opts.isControlCall` because
// every popup uses its own namespaced control tool names — orchestrator
// emits `luker_orch_reset_live_to_blank` / `luker_orch_reset_live_to_global`,
// memory-graph schema iteration emits `luker_mg_schema_reset_live_to_blank`
// / `luker_mg_schema_reset_live_to_global`, CPA and CEA popups have none.
// A single hardcoded allowlist in the shared runner would silently misroute
// calls. When `isControlCall` is omitted the runner treats every call as
// non-control, so popups without control tools opt out by simply not
// passing it.
export async function requestToolCallsWithRetry(context, settings, {
    taskMessages = [],
    runtimeWorldInfo = null,
    apiPresetName = '',
    llmPresetName = '',
    tools = [],
    allowedNames = null,
    retriesOverride = null,
    abortSignal = null,
    includeAssistantText = false,
    allowNoToolCalls = false,
    substituteMacros = false,
    onAssistantText = null,
    onToolCall = null,
    onControlCall = null,
    onUsage = null,
    // Receives { error, attemptIndex, maxRetries } before a retry begins.
    onRetry = null,
    isControlCall = null,
    includeCharacterCard = true,
    promptContext = null,
    transientSessionId = undefined,
    onPreparedRequest = null,
    activity = undefined,
    // Fires once per attempt on the FIRST upstream stream chunk (text or
    // reasoning). Streaming path only — a non-streaming preset never
    // produces incremental chunks so the callback stays silent. Barrier
    // consumers (spec parallel, agenda round) wire this to their
    // cache-warmup slot's signalFirstChunk so followers can proceed the
    // moment the lead's upstream request commits — see
    // extensions/orchestrator/dispatch-barrier.js. Callback errors are
    // swallowed with a console.warn, matching the other observer hooks.
    onFirstChunk = null,
    // Iteration studios pass the tool-call ids their session already uses
    // (`collectIterToolCallIds(session.messages)`). The proposal bus
    // selects a turn's proposals by tool-call id, so a call whose id is
    // reserved, already in `taskMessages`, or repeated within the response
    // gets a fresh id. Omitted (runtime agents): provider ids pass through.
    reservedToolCallIds = null,
    // Wire-level tool choice, forwarded verbatim. Memory-graph forces a
    // single function with { type: 'function', function: { name } }.
    toolChoice = 'auto',
    // Added to functionCallOptions only when non-empty, so the default
    // wire stays { protocolStyle }.
    requiredFunctionName = '',
    // Optional semantic argument validator invoked per matched tool call
    // after schema validation. Returning a non-empty string throws a
    // retryable validation error.
    validateArgs = null,
    // Zero allowed tool calls normally throws and retries. Callers whose
    // own loop treats "no calls" as an answer (memory-graph extraction's
    // semantic retry, crawl exploration end) receive the empty result
    // instead — for empty, text-only and filtered-out responses alike.
    allowEmptyResponse = false,
    rpmBucket = DEFAULT_RPM_BUCKET,
    // Prefix for the retry console.warn.
    logLabel = MODULE_NAME,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retries = normalizeToolCallRetryMax(retriesOverride ?? settings?.toolCallRetryMax, 0);
    const allowedSet = Array.isArray(allowedNames)
        ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
        : (allowedNames instanceof Set ? allowedNames : null);
    const requiredName = String(requiredFunctionName || '').trim();
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptSignal = isAbortSignalLike(abortSignal) ? abortSignal : null;
        try {
            throwIfAborted(abortSignal, 'Tool-call request aborted.');
            await waitForRpmSlot(settings, abortSignal, rpmBucket);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: includeCharacterCard !== false,
                worldInfoSource: 'none',
                runtimeWorldInfo: runtimeWorldInfo || {},
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice,
                functionCallMode: 'auto',
                functionCallOptions: requiredName
                    ? { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA, requiredFunctionName: requiredName }
                    : { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA },
                // Default false preserves the iter-studio behavior: CPA /
                // MG schema / Orch / CEA editor popups are EDITING source
                // text that still contains literal {{user}} / {{char}} /
                // {{getvar::}} macros, and the model must see those
                // templates verbatim so str_replace anchors land rather
                // than "fixing" placeholders into rendered names. Callers
                // reading resolved content (e.g. a runtime agent reading
                // chat text) opt in by passing substituteMacros: true.
                substituteMacros: Boolean(substituteMacros),
                abortSignal: attemptSignal,
                ...(promptContext !== null && promptContext !== undefined ? { promptContext } : {}),
                ...(transientSessionId !== undefined ? { transientSessionId } : {}),
                ...(typeof onPreparedRequest === 'function' ? { onPreparedRequest } : {}),
                ...(activity !== undefined ? { activity } : {}),
            };
            // Streaming path (when the caller's preset has stream_openai
            // enabled AND the context exposes generateTaskStream): drain
            // chunks so we can fire onFirstChunk on the first upstream
            // delta. iter-studio popups don't actually consume the chunks
            // for rendering — they only need the terminal result — but
            // the barrier consumers (spec/agenda) DO need first-chunk
            // timing, and taking the stream path uniformly for both
            // keeps the wire behavior consistent (see director-tools.js
            // runOneRound for the same pattern on the main-agent path).
            const streamEnabled = typeof context.isStreamingPresetEnabled === 'function'
                && typeof context.generateTaskStream === 'function'
                && context.isStreamingPresetEnabled(generateTaskOpts.llmPresetName || '');
            let result;
            if (streamEnabled) {
                const { stream, result: resultPromise } = context.generateTaskStream(generateTaskOpts);
                let firstChunkFired = false;
                for await (const chunk of stream) {
                    // Any chunk (text or reasoning) means upstream has
                    // committed to processing — fire the barrier signal
                    // exactly once per attempt. The check-and-set is
                    // safe under JS's single-threaded consumer because
                    // for-await serializes chunk delivery.
                    if (!firstChunkFired && chunk && typeof chunk === 'object' && typeof chunk.delta === 'string') {
                        firstChunkFired = true;
                        if (typeof onFirstChunk === 'function') {
                            try {
                                onFirstChunk();
                            } catch (cbErr) {
                                console.warn('[iter-tool-calling] onFirstChunk threw', cbErr);
                            }
                        }
                    }
                    // We intentionally do NOT forward chunks anywhere —
                    // iter-studio consumers work off the terminal result,
                    // and the stream is just a plumbing detail for the
                    // first-chunk signal. Draining prevents back-pressure.
                }
                result = await resultPromise;
            } else {
                result = await context.generateTask(generateTaskOpts);
            }
            throwIfAborted(abortSignal, 'Tool-call request aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map(call => {
                const callSig = typeof call?.signature === 'string' && call.signature.length > 0
                    ? call.signature
                    : (typeof call?.raw?.signature === 'string' && call.raw.signature.length > 0
                        ? call.raw.signature
                        : (typeof call?.raw?.thoughtSignature === 'string' && call.raw.thoughtSignature.length > 0 ? call.raw.thoughtSignature : undefined));
                const callExtra = call?.extra_content && typeof call.extra_content === 'object'
                    ? structuredClone(call.extra_content)
                    : (call?.raw?.extra_content && typeof call.raw.extra_content === 'object' ? structuredClone(call.raw.extra_content) : undefined);
                return {
                    name: String(call?.name || ''),
                    args: call?.args && typeof call.args === 'object' ? call.args : {},
                    id: String(call?.id || call?.raw?.id || '').trim(),
                    ...(callSig ? { signature: callSig } : {}),
                    ...(callExtra ? { extra_content: callExtra } : {}),
                    raw: call?.raw || null,
                };
            });
            const rewrittenIds = reservedToolCallIds
                ? assignUniqueToolCallIds(normalizedCalls, [
                    ...reservedToolCallIds,
                    ...collectIterToolCallIds(taskMessages),
                ])
                : new Map();
            const filteredCalls = allowedSet && allowedSet.size > 0
                ? normalizedCalls.filter(call => allowedSet.has(call.name))
                : normalizedCalls;
            const callsFilteredOut = filteredCalls.length !== normalizedCalls.length;
            const assistantText = String(result?.assistantText || '');
            const reasoning = String(result?.reasoning || '');
            const signature = typeof result?.signature === 'string' && result.signature.length > 0 ? result.signature : null;
            const reasoningBlocks = Array.isArray(result?.reasoningBlocks) && result.reasoningBlocks.length > 0
                ? result.reasoningBlocks
                : null;
            const reasoningDetails = Array.isArray(result?.reasoningDetails) && result.reasoningDetails.length > 0
                ? result.reasoningDetails
                : null;
            const syncedEnvelopes = syncNativeEnvelopesWithToolCalls({
                nativeParts: Array.isArray(result?.nativeParts) && result.nativeParts.length > 0 ? result.nativeParts : null,
                nativeContentBlocks: Array.isArray(result?.nativeContentBlocks) && result.nativeContentBlocks.length > 0 ? result.nativeContentBlocks : null,
                responsesOutputItems: Array.isArray(result?.responsesOutputItems) && result.responsesOutputItems.length > 0 ? result.responsesOutputItems : null,
                rewrittenIds,
                callsFilteredOut,
            });
            const turnMeta = {
                reasoning,
                reasoningBlocks,
                reasoningDetails,
                ...(signature ? { signature } : {}),
                ...(syncedEnvelopes.nativeParts ? { nativeParts: syncedEnvelopes.nativeParts } : {}),
                ...(syncedEnvelopes.nativeContentBlocks ? { nativeContentBlocks: syncedEnvelopes.nativeContentBlocks } : {}),
                ...(syncedEnvelopes.responsesOutputItems ? { responsesOutputItems: syncedEnvelopes.responsesOutputItems } : {}),
            };
            let returnValue;
            if (filteredCalls.length === 0) {
                if ((allowNoToolCalls && assistantText) || allowEmptyResponse) {
                    returnValue = includeAssistantText
                        ? { toolCalls: [], assistantText, rawAssistantText: assistantText, ...turnMeta }
                        : [];
                } else {
                    throw new Error('Model response did not contain any matching tool calls.');
                }
            } else {
                const validationError = validateParsedToolCalls(filteredCalls, tools);
                if (validationError) {
                    throw Object.assign(new Error(validationError), { __toolCallValidation: true });
                }
                if (typeof validateArgs === 'function') {
                    for (const call of filteredCalls) {
                        const argError = validateArgs(call.args, call);
                        if (argError) {
                            throw Object.assign(new Error(argError), { __toolCallValidation: true });
                        }
                    }
                }
                returnValue = includeAssistantText
                    ? { toolCalls: filteredCalls, assistantText, rawAssistantText: assistantText, ...turnMeta }
                    : filteredCalls;
            }

            // Per-round callbacks fire AFTER validation and BEFORE return, so
            // a popup can rely on having seen the assistant turn and its
            // tool calls in order before applying anything to the live
            // target. A callback that throws must not derail the runner —
            // these are observers, not gating hooks.
            if (typeof onAssistantText === 'function' && assistantText) {
                try {
                    onAssistantText(assistantText);
                } catch (cbErr) {
                    console.warn('[iter-tool-calling] onAssistantText threw', cbErr);
                }
            }
            if (typeof onUsage === 'function' && result?.usage) {
                try {
                    onUsage(result.usage);
                } catch (cbErr) {
                    console.warn('[iter-tool-calling] onUsage threw', cbErr);
                }
            }
            if (filteredCalls.length > 0 && (typeof onToolCall === 'function' || typeof onControlCall === 'function')) {
                const detectControl = typeof isControlCall === 'function' ? isControlCall : null;
                for (const call of filteredCalls) {
                    let isControl = false;
                    if (detectControl) {
                        try {
                            isControl = !!detectControl(call);
                        } catch (predErr) {
                            console.warn('[iter-tool-calling] isControlCall threw; treating as non-control', predErr);
                            isControl = false;
                        }
                    }
                    const cb = isControl ? onControlCall : onToolCall;
                    if (typeof cb === 'function') {
                        try {
                            cb(call);
                        } catch (cbErr) {
                            console.warn(`[iter-tool-calling] ${isControl ? 'onControlCall' : 'onToolCall'} threw`, cbErr);
                        }
                    }
                }
            }

            return returnValue;
        } catch (error) {
            if (isAbortError(error, abortSignal) || isNonRetryableToolError(error)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            if (typeof onRetry === 'function') {
                onRetry({ error, attemptIndex: attempt, maxRetries: retries });
            }
            console.warn(`[${logLabel}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }
    throw lastError || new Error('Multi tool call request failed.');
}

/**
 * Every tool-call id an iteration session already uses: calls and results
 * in the persisted shape (`toolCalls[].id`, `toolResults[].tool_call_id`)
 * and in the wire shape (`tool_calls[].id`, `tool_call_id`).
 *
 * @param {Array<Object>} messages
 * @returns {Set<string>}
 */
export function collectIterToolCallIds(messages = []) {
    const ids = new Set();
    const add = (value) => {
        const id = String(value || '').trim();
        if (id) ids.add(id);
    };
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') continue;
        for (const tc of Array.isArray(message.toolCalls) ? message.toolCalls : []) add(tc?.id);
        for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) add(tc?.id);
        for (const tr of Array.isArray(message.toolResults) ? message.toolResults : []) add(tr?.tool_call_id);
        add(message.tool_call_id);
    }
    return ids;
}

// Empty ids are left alone: the studios synthesize one for them.
// Returns a map of original id -> FIFO queue of final emitted ids (only
// populated when at least one call was rewritten) so native replay envelopes
// stay positionally synchronized with the emitted tool calls.
function assignUniqueToolCallIds(calls, reservedIds) {
    const taken = new Set(reservedIds);
    /** @type {Map<string, string[]>} */
    const idQueues = new Map();
    let anyRewritten = false;
    for (const call of calls) {
        if (!call.id) continue;
        const oldId = call.id;
        let finalId = oldId;
        if (taken.has(oldId)) {
            finalId = makeRuntimeToolCallId();
            call.id = finalId;
            if (call.raw && typeof call.raw === 'object') call.raw = { ...call.raw, id: finalId };
            anyRewritten = true;
        }
        let queue = idQueues.get(oldId);
        if (!queue) {
            queue = [];
            idQueues.set(oldId, queue);
        }
        queue.push(finalId);
        taken.add(finalId);
    }
    return anyRewritten ? idQueues : new Map();
}

function consumeRewrittenId(rewrittenQueues, oldId) {
    if (!oldId || !rewrittenQueues.has(oldId)) return oldId;
    const queue = rewrittenQueues.get(oldId);
    return queue.length > 0 ? queue.shift() : oldId;
}

function syncNativeEnvelopesWithToolCalls({
    nativeParts,
    nativeContentBlocks,
    responsesOutputItems,
    rewrittenIds,
    callsFilteredOut,
}) {
    if (callsFilteredOut) {
        // Drop raw provider envelopes when calls were filtered out by allowedNames
        // so converters synthesize consistent tool blocks from `filteredCalls`
        // while keeping `reasoningBlocks`/`signature` intact.
        return { nativeParts: null, nativeContentBlocks: null, responsesOutputItems: null };
    }
    if (!rewrittenIds || rewrittenIds.size === 0) {
        return { nativeParts, nativeContentBlocks, responsesOutputItems };
    }
    const cloneQueues = () => {
        const map = new Map();
        for (const [k, v] of rewrittenIds.entries()) {
            map.set(k, Array.isArray(v) ? [...v] : v);
        }
        return map;
    };
    const nextContentBlocks = nativeContentBlocks
        ? (() => {
            const queues = cloneQueues();
            return nativeContentBlocks.map((block) => {
                if (block?.type === 'tool_use' && typeof block.id === 'string') {
                    const updatedId = consumeRewrittenId(queues, block.id);
                    if (updatedId !== block.id) return { ...block, id: updatedId };
                }
                return block;
            });
        })()
        : null;
    const nextParts = nativeParts
        ? (() => {
            const queues = cloneQueues();
            return nativeParts.map((part) => {
                const fc = part?.functionCall || part?.function_call;
                if (fc && typeof fc.id === 'string') {
                    const updatedId = consumeRewrittenId(queues, fc.id);
                    if (updatedId !== fc.id) {
                        const key = part.functionCall ? 'functionCall' : 'function_call';
                        return { ...part, [key]: { ...fc, id: updatedId } };
                    }
                }
                return part;
            });
        })()
        : null;
    const nextOutputItems = responsesOutputItems
        ? (() => {
            const queues = cloneQueues();
            return responsesOutputItems.map((item) => {
                if (item?.type === 'function_call' && typeof item.call_id === 'string') {
                    const updatedId = consumeRewrittenId(queues, item.call_id);
                    if (updatedId !== item.call_id) return { ...item, call_id: updatedId };
                }
                return item;
            });
        })()
        : null;
    return {
        nativeParts: nextParts,
        nativeContentBlocks: nextContentBlocks,
        responsesOutputItems: nextOutputItems,
    };
}

export function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function makeAiIterationMessageId(prefix = 'orch_msg') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function serializeToolResultContent(result) {
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

/**
 * Same as `serializeToolResultContent`, except an executor-supplied
 * non-empty `toolResultText` string is returned verbatim, so tagged-text
 * envelopes (`<simulation_result>` / `<annotations>`) reach the model
 * without JSON escaping. Used by the CPA and CEA iteration studios.
 */
export function serializeToolResultContentPreferText(result) {
    if (result && typeof result === 'object'
        && typeof result.toolResultText === 'string'
        && result.toolResultText) {
        return result.toolResultText;
    }
    return serializeToolResultContent(result);
}

function createPersistentToolCallPayload(name, args = {}, id = '', { signature = null, extra_content = null } = {}) {
    const rawName = String(name || '').trim();
    if (!rawName) {
        return null;
    }
    // Legacy migration: loop tool names used to be `<ns>.<verb>` (e.g.
    // `chat.read_range`). Anthropic's tool-name regex
    // `^[a-zA-Z0-9_-]{1,128}$` rejects dots, so the dispatcher and
    // schemas now use `<ns>_<verb>`. Persisted history from before the
    // rename still carries dot names; normalize here so replays send
    // Claude-compatible names AND the dispatcher REGISTRY lookup hits.
    const toolName = rawName.replace(/\./g, '_');
    const safeArgs = args && typeof args === 'object' ? structuredClone(args) : {};
    const sig = typeof signature === 'string' && signature.length > 0 ? signature : null;
    const extraContent = extra_content && typeof extra_content === 'object' ? structuredClone(extra_content) : null;
    return {
        id: String(id || '').trim() || makeRuntimeToolCallId(),
        type: 'function',
        function: {
            name: toolName,
            arguments: JSON.stringify(safeArgs),
        },
        ...(sig ? { signature: sig } : {}),
        ...(extraContent ? { extra_content: extraContent } : {}),
    };
}

export function buildPersistentToolCallsFromRawCalls(rawCalls = []) {
    return (Array.isArray(rawCalls) ? rawCalls : [])
        .map((call) => createPersistentToolCallPayload(call?.name, call?.args, call?.id, {
            signature: call?.signature || call?.raw?.signature || call?.raw?.thoughtSignature || null,
            extra_content: call?.extra_content || call?.raw?.extra_content || null,
        }))
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
        const payload = createPersistentToolCallPayload(call?.function?.name, args, call?.id, {
            signature: call?.signature || call?.thoughtSignature || null,
            extra_content: call?.extra_content || null,
        });
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

export function createPersistentToolTurnMessage({
    messageId = '',
    assistantText = '',
    toolCalls = [],
    toolResults = [],
    toolSummary = '',
    toolState = '',
    reasoning = '',
    signature = null,
    reasoningBlocks = null,
    reasoningDetails = null,
    nativeParts = null,
    nativeContentBlocks = null,
    responsesOutputItems = null,
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
    if (typeof reasoning === 'string' && reasoning.length > 0) {
        message.reasoning = reasoning;
    }
    if (typeof signature === 'string' && signature.length > 0) {
        message.signature = signature;
    }
    if (Array.isArray(reasoningBlocks) && reasoningBlocks.length > 0) {
        message.reasoning_blocks = reasoningBlocks;
    }
    if (Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
        message.reasoning_details = reasoningDetails;
    }
    if (Array.isArray(nativeParts) && nativeParts.length > 0) {
        message.native_parts = nativeParts;
    }
    if (Array.isArray(nativeContentBlocks) && nativeContentBlocks.length > 0) {
        message.native_content_blocks = nativeContentBlocks;
    }
    if (Array.isArray(responsesOutputItems) && responsesOutputItems.length > 0) {
        message.responses_output_items = responsesOutputItems;
    }
    if (toolSummary) {
        message.toolSummary = String(toolSummary);
    }
    if (toolState) {
        message.toolState = String(toolState);
    }
    return message;
}

export function buildPersistentToolHistoryMessages(messages = []) {
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
        const reasoning = typeof item?.reasoning === 'string' && item.reasoning.length > 0 ? item.reasoning : '';
        const signature = typeof item?.signature === 'string' && item.signature.length > 0 ? item.signature : null;
        const reasoningBlocks = Array.isArray(item?.reasoning_blocks) && item.reasoning_blocks.length > 0
            ? item.reasoning_blocks
            : (Array.isArray(item?.reasoningBlocks) && item.reasoningBlocks.length > 0 ? item.reasoningBlocks : null);
        const reasoningDetails = Array.isArray(item?.reasoning_details) && item.reasoning_details.length > 0
            ? item.reasoning_details
            : (Array.isArray(item?.reasoningDetails) && item.reasoningDetails.length > 0 ? item.reasoningDetails : null);
        const nativeParts = Array.isArray(item?.native_parts) && item.native_parts.length > 0
            ? item.native_parts
            : (Array.isArray(item?.nativeParts) && item.nativeParts.length > 0 ? item.nativeParts : null);
        const nativeContentBlocks = Array.isArray(item?.native_content_blocks) && item.native_content_blocks.length > 0
            ? item.native_content_blocks
            : (Array.isArray(item?.nativeContentBlocks) && item.nativeContentBlocks.length > 0 ? item.nativeContentBlocks : null);
        const responsesOutputItems = Array.isArray(item?.responses_output_items) && item.responses_output_items.length > 0
            ? item.responses_output_items
            : (Array.isArray(item?.responsesOutputItems) && item.responsesOutputItems.length > 0 ? item.responsesOutputItems : null);
        history.push({
            role: 'assistant',
            content: String(item?.content || '').trim(),
            ...(reasoning ? { reasoning } : {}),
            ...(signature ? { signature } : {}),
            ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
            ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
            ...(nativeParts ? { native_parts: nativeParts } : {}),
            ...(nativeContentBlocks ? { native_content_blocks: nativeContentBlocks } : {}),
            ...(responsesOutputItems ? { responses_output_items: responsesOutputItems } : {}),
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

export function buildExecutionToolCalls(rawCalls = []) {
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

export function buildPendingToolResults(toolCalls = [], summaryText = '') {
    return buildPersistentToolCallsFromRawCalls(toolCalls).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: true,
            pending: true,
            summary: String(summaryText || 'Pending review.'),
        }),
    })).filter(item => item.tool_call_id);
}

export function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '', {
    reasoning = '',
    signature = null,
    reasoningBlocks = null,
    reasoningDetails = null,
    nativeParts = null,
    nativeContentBlocks = null,
    responsesOutputItems = null,
} = {}) {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim().replace(/\./g, '_');
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const callSig = typeof call?.signature === 'string' && call.signature.length > 0
            ? call.signature
            : (typeof call?.raw?.signature === 'string' && call.raw.signature.length > 0
                ? call.raw.signature
                : (typeof call?.raw?.thoughtSignature === 'string' && call.raw.thoughtSignature.length > 0 ? call.raw.thoughtSignature : null));
        const callExtra = call?.extra_content && typeof call.extra_content === 'object'
            ? structuredClone(call.extra_content)
            : (call?.raw?.extra_content && typeof call.raw.extra_content === 'object' ? structuredClone(call.raw.extra_content) : null);
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            ...(callSig ? { signature: callSig } : {}),
            ...(callExtra ? { extra_content: callExtra } : {}),
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    const trimmedReasoning = typeof reasoning === 'string' ? reasoning : '';
    const trimmedSig = typeof signature === 'string' && signature.length > 0 ? signature : null;
    const trimmedBlocks = Array.isArray(reasoningBlocks) && reasoningBlocks.length > 0 ? reasoningBlocks : null;
    const trimmedDetails = Array.isArray(reasoningDetails) && reasoningDetails.length > 0 ? reasoningDetails : null;
    const trimmedNativeParts = Array.isArray(nativeParts) && nativeParts.length > 0 ? nativeParts : null;
    const trimmedNativeContentBlocks = Array.isArray(nativeContentBlocks) && nativeContentBlocks.length > 0 ? nativeContentBlocks : null;
    const trimmedResponsesOutputItems = Array.isArray(responsesOutputItems) && responsesOutputItems.length > 0 ? responsesOutputItems : null;

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        ...(trimmedReasoning ? { reasoning: trimmedReasoning } : {}),
        ...(trimmedSig ? { signature: trimmedSig } : {}),
        ...(trimmedBlocks ? { reasoning_blocks: trimmedBlocks } : {}),
        ...(trimmedDetails ? { reasoning_details: trimmedDetails } : {}),
        ...(trimmedNativeParts ? { native_parts: trimmedNativeParts } : {}),
        ...(trimmedNativeContentBlocks ? { native_content_blocks: trimmedNativeContentBlocks } : {}),
        ...(trimmedResponsesOutputItems ? { responses_output_items: trimmedResponsesOutputItems } : {}),
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
