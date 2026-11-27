// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
    TOOL_PROTOCOL_STYLE,
    PlainTextFunctionCallStreamDetector,
    buildFunctionCallRetryAddendum,
    buildPlainTextToolProtocolMessage,
    diagnosePlainTextFunctionCallError,
    findLastTriggerSignalOutsideThought,
    generateRandomTriggerSignal,
    isToolCallMandatory,
    mergeSystemAddendumIntoPromptMessages,
    normalizeToolMessagesForPlainTextFunctionCalling,
    parseStrictPlainTextFunctionCallsAfterTrigger,
    validateParsedToolCalls,
} from '../../public/scripts/extensions/function-call-runtime.js';
import {
    ProtocolParseError,
    parseProtocolResponse,
    resolveWireProtocol,
} from '../../public/scripts/lib/protocol-parser/index.js';
import { createDispatchContext } from './context.js';
import {
    abortInspection,
    applyInspectionPlainTextResult,
    completeInspection,
    failInspection,
    failInspectionParseError,
    findEntry,
    linkInspectionRetry,
    updateInspectionPlainTextState,
} from '../request-inspector.js';

function cloneJsonSafe(value) {
    if (value == null) return value;
    try {
        return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function normalizeRetryConfig(rawRetry) {
    if (!rawRetry || typeof rawRetry !== 'object') {
        return { enabled: false, maxAttempts: 1 };
    }
    const enabled = Boolean(rawRetry.enabled);
    const parsedMax = Number(rawRetry.maxAttempts);
    const maxAttempts = Number.isFinite(parsedMax) && parsedMax >= 1
        ? Math.round(parsedMax)
        : 1;
    return {
        enabled: enabled && maxAttempts > 1,
        maxAttempts: enabled ? maxAttempts : 1,
    };
}

function validateTriggerSignal(rawTrigger) {
    if (rawTrigger === undefined || rawTrigger === null || rawTrigger === '') {
        return generateRandomTriggerSignal();
    }
    if (typeof rawTrigger !== 'string') {
        const err = new Error('Invalid luker_plain_text_tools.triggerSignal: must be a non-empty single-line string.');
        err.status = 400;
        throw err;
    }
    const trimmed = rawTrigger.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) {
        const err = new Error('Invalid luker_plain_text_tools.triggerSignal: must be a non-empty single-line string.');
        err.status = 400;
        throw err;
    }
    return trimmed;
}

/**
 * Inspect `rawBody.luker_plain_text_tools`, strip all internal plain-text config
 * and native `tools`/`tool_choice` before upstream provider dispatch, and build
 * the backend-prepared prompt messages with trigger + tool history conversion.
 *
 * @param {object} rawBody
 * @returns {{
 *   active: boolean,
 *   dispatchBody: object,
 *   config: object | null,
 *   baseMessages: object[] | null,
 *   createDetector: (() => PlainTextFunctionCallStreamDetector) | null,
 * }}
 */
export function preparePlainTextToolRequest(rawBody) {
    const sourceBody = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const rawConfig = sourceBody.luker_plain_text_tools;

    // Always strip the internal envelope so it can never leak upstream.
    const cleanBody = { ...sourceBody };
    delete cleanBody.luker_plain_text_tools;

    if (!rawConfig || typeof rawConfig !== 'object') {
        return {
            active: false,
            dispatchBody: cleanBody,
            config: null,
            baseMessages: null,
            createDetector: null,
        };
    }

    const mode = String(rawConfig.mode || 'prompt_xml').trim().toLowerCase();
    const tools = Array.isArray(rawConfig.tools) ? cloneJsonSafe(rawConfig.tools) : [];
    if (mode !== 'prompt_xml' || tools.length === 0) {
        return {
            active: false,
            dispatchBody: cleanBody,
            config: null,
            baseMessages: null,
            createDetector: null,
        };
    }

    const triggerSignal = validateTriggerSignal(rawConfig.triggerSignal);
    const toolChoice = rawConfig.toolChoice !== undefined ? cloneJsonSafe(rawConfig.toolChoice) : 'auto';
    const protocolStyle = rawConfig.protocolStyle === TOOL_PROTOCOL_STYLE.TABLE
        ? TOOL_PROTOCOL_STYLE.TABLE
        : TOOL_PROTOCOL_STYLE.JSON_SCHEMA;
    const requiredFunctionName = String(
        rawConfig.requiredFunctionName
        || toolChoice?.function?.name
        || (typeof toolChoice === 'object' ? toolChoice?.name : '')
        || '',
    ).trim();
    const requiresToolCall = isToolCallMandatory({ toolChoice, requiredFunctionName });
    const retry = normalizeRetryConfig(rawConfig.retry);

    const incomingMessages = Array.isArray(cleanBody.messages)
        ? cleanBody.messages.map(m => (m && typeof m === 'object' ? { ...m } : m))
        : [];
    const normalizedMessages = normalizeToolMessagesForPlainTextFunctionCalling(incomingMessages, {
        triggerSignal,
    });
    const preparedMessages = mergeSystemAddendumIntoPromptMessages(
        normalizedMessages,
        buildPlainTextToolProtocolMessage(tools, {
            requiredFunctionName,
            style: protocolStyle,
            triggerSignal,
            toolChoice,
        }),
    );

    cleanBody.messages = preparedMessages;
    delete cleanBody.tools;
    delete cleanBody.tool_choice;

    const config = {
        mode,
        tools,
        toolChoice,
        protocolStyle,
        requiredFunctionName,
        requiresToolCall,
        triggerSignal,
        retry,
    };

    return {
        active: true,
        dispatchBody: cleanBody,
        config,
        baseMessages: cloneJsonSafe(preparedMessages),
        createDetector: () => new PlainTextFunctionCallStreamDetector({ triggerSignal }),
    };
}

/**
 * Evaluate a completed ParsedTurn under the backend plain-text tool-calling
 * contract. Strictly separates:
 *   - `'none'`: normal prose (no trigger outside thought blocks, and call not mandatory)
 *   - `'parsed'`: trigger entered, XML & JSON arguments valid, tool names & schemas valid
 *   - `'parse_failed'`: trigger entered (or call mandatory) and parsing/validation failed;
 *     never splices broken XML into visible displayText and never emits incomplete toolCalls.
 *
 * @param {object} turn Unified ParsedTurn from protocol-parser
 * @param {object} config Prepared plain-text config
 */
export function evaluatePlainTextToolCallTurn(turn, config) {
    const rawText = String(turn?.text || '');
    const triggerSignal = String(config?.triggerSignal || '').trim();
    const triggerPos = triggerSignal ? findLastTriggerSignalOutsideThought(rawText, triggerSignal) : -1;
    const requiresToolCall = Boolean(config?.requiresToolCall);
    const toolChoice = config?.toolChoice ?? 'auto';
    const requiredFunctionName = String(config?.requiredFunctionName || '').trim();

    if (triggerPos < 0) {
        if (!requiresToolCall) {
            return {
                status: 'none',
                detected: false,
                displayText: rawText,
                rawResponseText: rawText,
                callRegionRaw: '',
                callSpan: null,
                calls: [],
                toolCalls: [],
                error: '',
                failureReason: null,
            };
        }

        const missingError = 'Model text output did not include the required trigger signal.';
        return {
            status: 'parse_failed',
            detected: false,
            displayText: rawText.trim(),
            rawResponseText: rawText,
            callRegionRaw: rawText,
            callSpan: null,
            calls: [],
            toolCalls: [],
            error: missingError,
            failureReason: 'syntax',
        };
    }

    const preambleText = rawText.slice(0, triggerPos);
    const displayText = preambleText.trim();
    const callRegionRaw = rawText.slice(triggerPos);
    const callSpan = { start: triggerPos, end: rawText.length };
    const afterTrigger = rawText.slice(triggerPos + triggerSignal.length);

    try {
        if (toolChoice === 'none') {
            throw new Error('Tool-choice constraint forbids calling any tool in this response.');
        }

        const parsedCalls = parseStrictPlainTextFunctionCallsAfterTrigger(afterTrigger);

        if (requiredFunctionName) {
            const invalidCall = parsedCalls.find(c => String(c.name || '').trim() !== requiredFunctionName);
            if (invalidCall) {
                throw new Error(`Required tool '${requiredFunctionName}', but model called '${invalidCall.name}'.`);
            }
        }

        const validationError = validateParsedToolCalls(parsedCalls, config?.tools);
        if (validationError) {
            throw new Error(validationError);
        }

        const callsWithIds = parsedCalls.map((call) => ({
            id: String(call?.id || `call_${randomUUID().replaceAll('-', '')}`),
            name: String(call?.name || '').trim(),
            args: call?.args && typeof call.args === 'object' ? cloneJsonSafe(call.args) : {},
        }));

        const toolCalls = callsWithIds.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
            },
        }));

        return {
            status: 'parsed',
            detected: true,
            displayText,
            rawResponseText: rawText,
            callRegionRaw,
            callSpan,
            calls: callsWithIds,
            toolCalls,
            error: '',
            failureReason: null,
        };
    } catch (err) {
        const errMessage = err instanceof Error && err.message ? err.message : String(err || 'Plain-text function call parse error.');
        const diagnostic = diagnosePlainTextFunctionCallError(rawText, {
            triggerSignal,
            triggerRequired: true,
        });
        const detailedError = errMessage === 'Model text output did not contain parseable function-call XML.'
            ? (diagnostic || errMessage)
            : errMessage;

        return {
            status: 'parse_failed',
            detected: true,
            displayText,
            rawResponseText: rawText,
            callRegionRaw,
            callSpan,
            calls: [],
            toolCalls: [],
            error: detailedError,
            failureReason: 'syntax',
        };
    }
}

/**
 * Rebuild ordered Inspector `responseParts` so preceding thinking & text blocks
 * keep their exact original order while the call region at `callSpan` is
 * replaced with a dedicated `plain_text_tool_calls` part that can toggle
 * between parsed calls/error view and raw call-region text independently.
 *
 * @param {object[]} originalParts
 * @param {object} ptResult
 * @param {{ triggerSignal?: string, attempt?: number, maxAttempts?: number, retryOf?: string|null, originalError?: string }} [meta]
 * @returns {object[]}
 */
export function applyPlainTextResultToResponseParts(originalParts, ptResult, meta = {}) {
    const parts = Array.isArray(originalParts) ? originalParts.map(cloneJsonSafe) : [];
    if (!ptResult || ptResult.status === 'none') {
        return parts;
    }

    const regionPart = {
        type: 'plain_text_tool_calls',
        status: ptResult.status,
        triggerSignal: String(meta.triggerSignal || ''),
        calls: Array.isArray(ptResult.calls) ? cloneJsonSafe(ptResult.calls) : [],
        error: String(ptResult.error || ''),
        failureReason: ptResult.failureReason || null,
        callRegionRaw: String(ptResult.callRegionRaw || ''),
        callSpan: ptResult.callSpan ? { ...ptResult.callSpan } : null,
        attempt: Number.isInteger(meta.attempt) ? meta.attempt : 1,
        maxAttempts: Number.isInteger(meta.maxAttempts) ? meta.maxAttempts : 1,
        retryOf: meta.retryOf || null,
        originalError: String(meta.originalError || ''),
    };

    const span = ptResult.callSpan;
    if (!span || !Number.isInteger(span.start) || span.start < 0) {
        return [...parts, regionPart];
    }

    const nextParts = [];
    let textCursor = 0;
    let regionInserted = false;

    for (const part of parts) {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') {
            nextParts.push(part);
            continue;
        }
        const partStart = textCursor;
        const partEnd = partStart + part.text.length;
        textCursor = partEnd;

        if (partEnd <= span.start) {
            nextParts.push(part);
            continue;
        }

        if (partStart < span.start && partEnd > span.start) {
            const beforeText = part.text.slice(0, span.start - partStart).trimEnd();
            if (beforeText) {
                nextParts.push({ type: 'text', text: beforeText });
            }
            if (!regionInserted) {
                nextParts.push(regionPart);
                regionInserted = true;
            }
            continue;
        }

        // partStart >= span.start: part falls completely inside the call region.
        if (!regionInserted) {
            nextParts.push(regionPart);
            regionInserted = true;
        }
    }

    if (!regionInserted) {
        nextParts.push(regionPart);
    }

    return nextParts;
}

/**
 * Build the out-of-band WS `meta.plain_text_function_call` payload consumed by
 * the frontend without mutating the native HTTP response body.
 */
export function buildClientPlainTextMeta(ptResult, {
    mode = 'prompt_xml',
    triggerSignal = '',
    attempt = 1,
    maxAttempts = 1,
    retryOf = null,
    originalError = '',
    inspectorEntryId = null,
    replacedTurn = null,
} = {}) {
    const payload = {
        enabled: true,
        mode,
        status: ptResult.status,
        triggerSignal,
        displayText: ptResult.displayText ?? '',
        calls: Array.isArray(ptResult.calls) ? cloneJsonSafe(ptResult.calls) : [],
        toolCalls: Array.isArray(ptResult.toolCalls) ? cloneJsonSafe(ptResult.toolCalls) : [],
        error: String(ptResult.error || ''),
        failureReason: ptResult.failureReason || null,
        attempt,
        maxAttempts,
        retryOf: retryOf || null,
        originalError: String(originalError || ''),
        inspectorEntryId: inspectorEntryId || null,
    };
    if (replacedTurn && attempt > 1) {
        const stripNativeReplay = ptResult.status === 'parsed';
        payload.replacedTurn = {
            reasoning: replacedTurn.reasoning || '',
            signature: replacedTurn.signature || null,
            reasoningBlocks: replacedTurn.reasoningBlocks || null,
            reasoningDetails: replacedTurn.reasoningDetails || null,
            nativeParts: stripNativeReplay ? null : (replacedTurn.nativeParts || null),
            nativeContentBlocks: stripNativeReplay ? null : (replacedTurn.nativeContentBlocks || null),
            responsesOutputItems: stripNativeReplay ? null : (replacedTurn.responsesOutputItems || null),
            images: Array.isArray(replacedTurn.images) ? cloneJsonSafe(replacedTurn.images) : [],
            citations: Array.isArray(replacedTurn.citations) && replacedTurn.citations.length > 0 ? cloneJsonSafe(replacedTurn.citations) : null,
            refusal: replacedTurn.refusal || null,
            usage: replacedTurn.usage || null,
            finishReason: replacedTurn.finishReason || null,
            nativeFinishReason: replacedTurn.nativeFinishReason || null,
            stopSequence: replacedTurn.stopSequence || null,
            stopDetails: replacedTurn.stopDetails ? cloneJsonSafe(replacedTurn.stopDetails) : null,
        };
    }
    return payload;
}

function failRetryAttempt({
    retryRequest,
    retryEntry,
    handle,
    retryOfEntryId,
    terminalStatus,
    failureReason,
    error,
    inspectionAction = null,
}) {
    if (typeof inspectionAction === 'function') {
        inspectionAction();
    }
    updateInspectionPlainTextState(retryRequest, {
        status: terminalStatus,
        failureReason,
        error,
        finalStatus: terminalStatus,
    });
    if (retryOfEntryId && retryEntry?.id) {
        linkInspectionRetry(handle, retryOfEntryId, retryEntry.id, terminalStatus);
    }
    return {
        ok: false,
        terminalStatus,
        failureReason,
        error,
        entryId: retryEntry?.id || null,
        turn: null,
        ptResult: null,
    };
}

/**
 * Execute a single backend-owned plain-text format-correction retry attempt
 * internally (non-streaming), recording a linked Request Inspector entry and
 * never swallowing HTTP, network, abort, or protocol parse errors.
 */
async function executeSinglePlainTextRetry({
    originalRequest,
    cleanDispatchBody,
    select,
    abortController,
    retryMessages,
    attempt,
    maxAttempts,
    retryOfEntryId,
    originalError,
    config,
}) {
    if (abortController.signal.aborted) {
        const abortErr = new DOMException('Aborted', 'AbortError');
        return {
            ok: false,
            terminalStatus: 'aborted',
            failureReason: 'aborted',
            error: abortErr.message,
            entryId: null,
            turn: null,
            ptResult: null,
        };
    }

    const retryBody = {
        ...cloneJsonSafe(cleanDispatchBody),
        messages: retryMessages,
        stream: false,
        n: 1,
    };
    delete retryBody.luker_plain_text_tools;
    delete retryBody.tools;
    delete retryBody.tool_choice;

    const retryRequest = {
        body: retryBody,
        headers: originalRequest?.headers || {},
        user: originalRequest?.user,
        lukerGenerationJob: originalRequest?.lukerGenerationJob || null,
        __inspectorRetryOf: retryOfEntryId || null,
        __inspectorAttempt: attempt,
        __inspectorOriginalError: originalError || '',
        __lukerPlainTextMeta: {
            enabled: true,
            mode: config.mode,
            triggerSignal: config.triggerSignal,
            tools: config.tools,
            toolChoice: config.toolChoice,
            attempt,
            maxAttempts,
            retryOf: retryOfEntryId || null,
            originalError: originalError || '',
        },
    };

    const retryDispatchFn = select(retryBody, retryRequest);
    if (typeof retryDispatchFn !== 'function') {
        throw new Error('Plain-text retry dispatch function not provided.');
    }

    let headStatus = 200;
    const chunks = [];
    let emitErrorMsg = '';
    const retryCtx = createDispatchContext({
        request: retryRequest,
        abortController,
        onEmit: (event) => {
            if (event?.kind === 'head') {
                headStatus = Number(event.data?.status ?? 200);
            } else if (event?.kind === 'chunk' && event.data != null) {
                if (typeof event.data === 'string') {
                    chunks.push(Buffer.from(event.data, 'utf8'));
                } else if (event.data instanceof Uint8Array || Buffer.isBuffer(event.data)) {
                    chunks.push(Buffer.from(event.data));
                }
            } else if (event?.kind === 'error') {
                emitErrorMsg = String(event.data?.message || 'Upstream retry dispatch failed');
            }
        },
    });

    const handle = String(originalRequest?.user?.profile?.handle || '');

    try {
        await retryDispatchFn(retryCtx);
    } catch (err) {
        const isAbort = err?.name === 'AbortError' || abortController.signal.aborted;
        const msg = err?.message || String(err || 'Retry request failed');
        const terminalStatus = isAbort ? 'aborted' : 'network_error';
        const failureReason = isAbort ? 'aborted' : 'network';
        const retryEntry = findEntry(retryRequest);
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus,
            failureReason,
            error: `Plain-text format-correction retry #${attempt} failed: ${msg}`,
            inspectionAction: () => {
                if (retryEntry && retryEntry.status === 'running') {
                    if (isAbort) {
                        abortInspection(retryRequest);
                    } else {
                        failInspection(retryRequest, msg, 500);
                    }
                }
            },
        });
    }

    const retryEntry = findEntry(retryRequest);

    if (abortController.signal.aborted) {
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: 'aborted',
            failureReason: 'aborted',
            error: 'Plain-text format-correction retry aborted.',
            inspectionAction: () => {
                if (retryEntry && retryEntry.status === 'running') {
                    abortInspection(retryRequest);
                }
            },
        });
    }

    if (emitErrorMsg) {
        const msg = `Plain-text format-correction retry #${attempt} failed: ${emitErrorMsg}`;
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: 'network_error',
            failureReason: 'network',
            error: msg,
            inspectionAction: () => {
                if (retryEntry && retryEntry.status === 'running') {
                    failInspection(retryRequest, emitErrorMsg, 502);
                }
            },
        });
    }

    const rawText = Buffer.concat(chunks).toString('utf8');
    if (headStatus < 200 || headStatus >= 300) {
        const msg = `Plain-text format-correction retry #${attempt} returned HTTP ${headStatus}${rawText ? `: ${rawText}` : ''}`;
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: 'network_error',
            failureReason: 'network',
            error: msg,
            inspectionAction: () => {
                if (retryEntry && retryEntry.status === 'running') {
                    failInspection(retryRequest, msg, headStatus);
                }
            },
        });
    }

    const protocol = resolveWireProtocol(retryBody.chat_completion_source);
    if (!protocol) {
        const parseErr = new ProtocolParseError({
            protocol: String(retryBody.chat_completion_source || 'unknown'),
            stage: 'protocol_mismatch',
            location: 'chat_completion_source',
            message: `Plain-text format-correction retry #${attempt} has undeclared wire protocol for source "${String(retryBody.chat_completion_source || '')}".`,
            rawDiagnostic: rawText,
        });
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: 'parse_failed',
            failureReason: 'syntax',
            error: parseErr.message,
            inspectionAction: () => failInspectionParseError(retryRequest, parseErr, {
                kind: 'non-streaming',
                protocol: String(retryBody.chat_completion_source || 'unknown'),
                rawBody: rawText,
            }, 200),
        });
    }

    let parsedJson;
    try {
        parsedJson = JSON.parse(rawText);
    } catch (parseCause) {
        const parseErr = new ProtocolParseError({
            protocol,
            stage: 'json',
            location: 'body',
            message: `Plain-text format-correction retry #${attempt} returned malformed JSON: ${parseCause.message}`,
            cause: parseCause,
            rawDiagnostic: rawText,
        });
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: 'parse_failed',
            failureReason: 'syntax',
            error: parseErr.message,
            inspectionAction: () => failInspectionParseError(retryRequest, parseErr, {
                kind: 'non-streaming',
                protocol,
                rawBody: rawText,
            }, 200),
        });
    }

    let retryTurn;
    try {
        retryTurn = parseProtocolResponse(protocol, parsedJson);
    } catch (err) {
        const isProviderError = err instanceof ProtocolParseError && err.stage === 'provider_error';
        const msg = isProviderError
            ? `Plain-text format-correction retry #${attempt} returned provider error: ${err.message}`
            : `Plain-text format-correction retry #${attempt} failed protocol parsing: ${err?.message || err}`;
        return failRetryAttempt({
            retryRequest,
            retryEntry,
            handle,
            retryOfEntryId,
            terminalStatus: isProviderError ? 'network_error' : 'parse_failed',
            failureReason: isProviderError ? 'network' : 'syntax',
            error: msg,
            inspectionAction: () => {
                if (retryEntry && retryEntry.status !== 'error') {
                    failInspectionParseError(retryRequest, err, {
                        kind: 'non-streaming',
                        protocol,
                        payload: parsedJson,
                    }, 200);
                }
            },
        });
    }

    if (retryEntry && retryEntry.status === 'running') {
        completeInspection(retryRequest, parsedJson, parsedJson);
    }

    const retryPtResult = evaluatePlainTextToolCallTurn(retryTurn, config);
    const retryResponseParts = applyPlainTextResultToResponseParts(retryTurn.parts, retryPtResult, {
        triggerSignal: config.triggerSignal,
        attempt,
        maxAttempts,
        retryOf: retryOfEntryId || null,
        originalError: originalError || '',
    });
    applyInspectionPlainTextResult(retryRequest, {
        turn: retryTurn,
        ptResult: retryPtResult,
        config,
        responseParts: retryResponseParts,
        attempt,
        maxAttempts,
        retryOf: retryOfEntryId || null,
        originalError: originalError || '',
    });
    if (retryOfEntryId && retryEntry?.id) {
        linkInspectionRetry(handle, retryOfEntryId, retryEntry.id, retryPtResult.status);
    }

    return {
        ok: true,
        terminalStatus: retryPtResult.status,
        failureReason: retryPtResult.failureReason,
        error: retryPtResult.error,
        entryId: retryEntry?.id || null,
        turn: retryTurn,
        ptResult: retryPtResult,
    };
}

/**
 * Run configured backend-owned format-correction retries after Attempt 1 failed
 * plain-text function-call parsing/validation. Never swallows retry errors and
 * never returns Attempt 1's broken result when a retry fails with HTTP/network/
 * protocol errors.
 */
export async function runPlainTextFormatCorrectionRetries({
    originalRequest,
    cleanDispatchBody,
    baseMessages,
    postProcessMessages = null,
    select,
    abortController,
    initialEntryId,
    initialTurn,
    initialPtResult,
    config,
}) {
    const maxAttempts = config?.retry?.enabled ? Number(config.retry.maxAttempts || 1) : 1;
    let currentMessages = cloneJsonSafe(baseMessages || []);
    let lastRawText = String(initialTurn?.text || '');
    let lastPtResult = initialPtResult;
    let finalTurn = initialTurn;
    let finalAttempt = 1;
    let finalEntryId = initialEntryId || null;
    const originalError = String(initialPtResult?.error || '');

    for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
        const retryPrompt = buildFunctionCallRetryAddendum({
            rawResponse: lastRawText,
            errorDetails: lastPtResult.error,
            triggerSignal: config.triggerSignal,
            requiredFunctionName: config.requiredFunctionName,
            plainTextMode: true,
        });
        const appendedTurn = lastRawText.trim()
            ? [
                { role: 'assistant', content: lastRawText },
                { role: 'user', content: retryPrompt },
            ]
            : [{ role: 'user', content: retryPrompt }];
        const nextRawMessages = currentMessages.concat(appendedTurn);
        const retryMessages = typeof postProcessMessages === 'function'
            ? postProcessMessages(cloneJsonSafe(nextRawMessages))
            : nextRawMessages;

        const outcome = await executeSinglePlainTextRetry({
            originalRequest,
            cleanDispatchBody,
            select,
            abortController,
            retryMessages,
            attempt,
            maxAttempts,
            retryOfEntryId: initialEntryId,
            originalError,
            config,
        });

        finalAttempt = attempt;
        finalEntryId = outcome.entryId || finalEntryId;

        if (!outcome.ok) {
            return {
                turn: null,
                ptResult: {
                    status: outcome.terminalStatus,
                    detected: true,
                    displayText: '',
                    rawResponseText: lastRawText,
                    callRegionRaw: lastPtResult.callRegionRaw || '',
                    callSpan: lastPtResult.callSpan || null,
                    calls: [],
                    toolCalls: [],
                    error: outcome.error,
                    failureReason: outcome.failureReason,
                },
                attempt: finalAttempt,
                maxAttempts,
                retryOf: initialEntryId || null,
                originalError,
                inspectorEntryId: finalEntryId,
            };
        }

        finalTurn = outcome.turn;
        lastPtResult = outcome.ptResult;
        lastRawText = String(outcome.turn?.text || '');
        currentMessages = nextRawMessages;

        if (outcome.ptResult.status === 'parsed' || outcome.ptResult.status === 'none') {
            return {
                turn: finalTurn,
                ptResult: lastPtResult,
                attempt: finalAttempt,
                maxAttempts,
                retryOf: initialEntryId || null,
                originalError,
                inspectorEntryId: finalEntryId,
            };
        }
    }

    return {
        turn: finalTurn,
        ptResult: lastPtResult,
        attempt: finalAttempt,
        maxAttempts,
        retryOf: initialEntryId || null,
        originalError,
        inspectorEntryId: finalEntryId,
    };
}
