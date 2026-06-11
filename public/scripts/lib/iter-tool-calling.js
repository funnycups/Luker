/**
 * Tool-call request driver — shared infrastructure used by the iteration-
 * studio shell (every adapter's LLM round-trip) and the orchestrator
 * runtime. Handles SSE / non-SSE transport selection, the RPM throttle
 * window, retry-on-empty-tool-call, and abort propagation.
 *
 * Originally lived in extensions/orchestrator/ as the orchestrator's
 * one-call-per-node driver; hoisted to lib/ in SP-5
 * (docs/superpowers/specs/2026-05-22-iter-shell-contract-surgery.md) so
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

// The RPM bucket (`_rpmTimestamps`) is module-private and therefore process-
// wide: if a user has two iteration-studio popups open at once (e.g.
// CardApp Studio + orchestrator's iteration popup), their requests queue
// against the same window. This matches the user-facing concept of "I have
// one backend rate limit," not per-popup quota.

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

const _rpmTimestamps = [];

export async function waitForRpmSlot(settings, abortSignal = null) {
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

export async function requestToolCallWithRetry(context, settings, {
    taskMessages = [],
    runtimeWorldInfo = null,
    apiPresetName = '',
    llmPresetName = '',
    functionName = '',
    functionDescription = '',
    parameters = {},
    abortSignal = null,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
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
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            await waitForRpmSlot(settings, abortSignal);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
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
            };
            const result = settings?.useStreamingTransport
                ? await context.generateTaskStream(generateTaskOpts).result
                : await context.generateTask(generateTaskOpts);
            throwIfAborted(abortSignal, 'Orchestration aborted.');
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
            if (isAbortError(error, abortSignal)) {
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

// Control-flow tool calls (e.g. continue / finalize an iteration loop) do
// not represent edits to apply; they steer the runner / iteration loop
// itself and are routed to `onControlCall` instead of `onToolCall` so
// popups can update their state machine without treating them as
// user-visible operations.
//
// Detection is delegated to the caller via `opts.isControlCall` because
// every popup uses its own namespaced control tool names — orchestrator
// emits `luker_orch_continue_iteration` / `luker_orch_finalize_iteration`,
// memory-graph schema iteration emits `luker_mg_schema_continue_iteration`
// / `_finalize_iteration`, CPA and CEA popups have none. A single hardcoded
// allowlist in the shared runner would silently misroute calls. When
// `isControlCall` is omitted the runner treats every call as non-control,
// so popups without control tools opt out by simply not passing it.
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
    onAssistantText = null,
    onToolCall = null,
    onControlCall = null,
    onUsage = null,
    isControlCall = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const allowedSet = Array.isArray(allowedNames)
        ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
        : (allowedNames instanceof Set ? allowedNames : null);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptSignal = isAbortSignalLike(abortSignal) ? abortSignal : null;
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            await waitForRpmSlot(settings, abortSignal);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
                worldInfoSource: 'none',
                runtimeWorldInfo: runtimeWorldInfo || {},
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice: 'auto',
                functionCallMode: 'auto',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                // Iter studio popups (CPA / MG schema / Orch / CEA editor)
                // are EDITING source text that still contains literal
                // {{user}} / {{char}} / {{getvar::}} macros. The model
                // must see those source templates verbatim so str_replace
                // anchors land and the model doesn't "fix" template
                // placeholders into rendered names. Runtime executors
                // (orch nodes, MG extraction, preset use in chat) want
                // macros expanded — they call requestToolCallWithRetry
                // (singular) instead, which inherits generateTask's
                // default true.
                substituteMacros: false,
                abortSignal: attemptSignal,
            };
            const result = settings?.useStreamingTransport
                ? await context.generateTaskStream(generateTaskOpts).result
                : await context.generateTask(generateTaskOpts);
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map(call => ({
                name: String(call?.name || ''),
                args: call?.args && typeof call.args === 'object' ? call.args : {},
                raw: call?.raw || null,
            }));
            const filteredCalls = allowedSet && allowedSet.size > 0
                ? normalizedCalls.filter(call => allowedSet.has(call.name))
                : normalizedCalls;
            const assistantText = String(result?.assistantText || '');
            const reasoning = String(result?.reasoning || '');
            let returnValue;
            if (filteredCalls.length === 0) {
                if (allowNoToolCalls && assistantText) {
                    returnValue = includeAssistantText
                        ? { toolCalls: [], assistantText, rawAssistantText: assistantText, reasoning }
                        : [];
                } else {
                    throw new Error('Model response did not contain any matching tool calls.');
                }
            } else {
                const validationError = validateParsedToolCalls(filteredCalls, tools);
                if (validationError) {
                    throw new Error(validationError);
                }
                returnValue = includeAssistantText
                    ? { toolCalls: filteredCalls, assistantText, rawAssistantText: assistantText, reasoning }
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
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }
    throw lastError || new Error('Multi tool call request failed.');
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

export function createPersistentToolCallPayload(name, args = {}, id = '') {
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
    return {
        id: String(id || '').trim() || makeRuntimeToolCallId(),
        type: 'function',
        function: {
            name: toolName,
            arguments: JSON.stringify(safeArgs),
        },
    };
}

export function buildPersistentToolCallsFromRawCalls(rawCalls = []) {
    return (Array.isArray(rawCalls) ? rawCalls : [])
        .map((call) => createPersistentToolCallPayload(call?.name, call?.args, call?.id))
        .filter(Boolean);
}

export function normalizePersistentToolCalls(message) {
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

export function normalizePersistentToolResults(message, toolCalls = []) {
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

export function findAiIterationMessageById(messages, messageId) {
    const id = String(messageId || '').trim();
    if (!id || !Array.isArray(messages)) {
        return null;
    }
    return messages.find(item => String(item?.id || '').trim() === id) || null;
}

export function buildToolCallSummary(toolCalls = []) {
    const names = (Array.isArray(toolCalls) ? toolCalls : [])
        .map(call => String(call?.function?.name || '').trim())
        .filter(Boolean);
    if (names.length === 0) {
        return '';
    }
    return `Tools: ${names.join(', ')}`;
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

export function buildRejectedToolResults(toolCalls = [], summaryText = '') {
    return buildPersistentToolCallsFromRawCalls(toolCalls).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: false,
            rejected: true,
            summary: String(summaryText || 'Rejected by user.'),
        }),
    })).filter(item => item.tool_call_id);
}

export function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim().replace(/\./g, '_');
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
