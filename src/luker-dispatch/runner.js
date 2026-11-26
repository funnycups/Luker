// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
    createGenerationJob,
    appendGenerationEvent,
    accumulateChunkTextIntoJob,
    finalizeJobProtocolStream,
    completeGenerationJobFromText,
    failGenerationJob,
    attachJobToRequest,
    notifyJobTextProgress,
    releaseTransientGenerationJobs,
} from '../endpoints/backends/luker-generation.js';
import {
    applyInspectionPlainTextResult,
    completeInspection,
    completeInspectionFromStream,
    failInspectionParseError,
    findEntry,
    updateInspectionPlainTextState,
} from '../request-inspector.js';
import {
    ProtocolParseError,
    WIRE_PROTOCOLS,
    buildCompatChatCompletionPayload,
    createSseFramer,
    parseProtocolResponse,
    resolveWireProtocol,
} from '../../public/scripts/lib/protocol-parser/index.js';
import { createDispatchContext } from './context.js';
import {
    applyPlainTextResultToResponseParts,
    buildClientPlainTextMeta,
    evaluatePlainTextToolCallTurn,
    preparePlainTextToolRequest,
    runPlainTextFormatCorrectionRetries,
} from './plain-text-tool-calling.js';
import { createRequestProxyAgent } from '../request-proxy.js';
import {
    assertTransientMediaRead,
    getRequestTransientSession,
    registerTransientCleanup,
    trackTransientOperation,
} from '../transient-sessions.js';
import { dispatchLog as console, withDispatchLogging } from './logging.js';

const TEXT_GENERATION_ENDPOINTS = new Set([
    'chat-completions',
    'text-completions',
    'kobold',
    'novelai',
]);

function normalizeDispatchHeadEvent(event, { endpoint, isStream }) {
    if (event?.kind !== 'head' || !TEXT_GENERATION_ENDPOINTS.has(endpoint)) {
        return event;
    }
    const status = Number(event.data?.status ?? 200);
    if (status < 200 || status >= 300) {
        return event;
    }
    const headers = { ...(event.data?.headers || {}) };
    const currentContentType = String(headers['content-type'] || '').toLowerCase();
    if (isStream) {
        const allowJsonFallbackHeader = endpoint === 'chat-completions' && currentContentType.includes('application/json');
        if (!currentContentType.includes('text/event-stream') && !allowJsonFallbackHeader) {
            headers['content-type'] = 'text/event-stream; charset=utf-8';
        }
    } else if (!currentContentType.includes('application/json')) {
        headers['content-type'] = 'application/json; charset=utf-8';
    }
    return {
        ...event,
        data: {
            ...(event.data || {}),
            status,
            headers,
        },
    };
}

export async function runLukerDispatch(request, response, { endpoint, select, postProcessMessages = null }) {
    let session;
    try {
        session = getRequestTransientSession(request);
        if (Array.isArray(request.body?.references)) {
            for (const entry of request.body.references) {
                if (entry && typeof entry.imagePath === 'string' && entry.imagePath.trim()) {
                    assertTransientMediaRead(request, entry.imagePath);
                }
            }
        }
    } catch (error) {
        response.status(error.status || 500).json({ error: error.message, code: error.code });
        return;
    }
    // Prefer the client-supplied job_id (from body.luker_generation.job_id)
    // when present so /jobs/status?id=<uuid> queries hit the same job the
    // runner created. The client pre-generates a uuid and stashes it in the
    // body so it can poll for auto-persist.
    const bodyJobId = String(request.body?.luker_generation?.job_id || '').trim();
    const headerId = String(request.headers?.['x-luker-request-id'] || '').trim();
    const requestId = bodyJobId || headerId || randomUUID();

    // Prepare backend-owned plain-text function calling orchestration before
    // selecting the provider so `luker_plain_text_tools` and native
    // `tools`/`tool_choice` are stripped before upstream dispatch and invalid
    // explicit trigger signals fail fast with HTTP 400.
    let plainTextSession;
    try {
        plainTextSession = preparePlainTextToolRequest(request.body || {});
    } catch (error) {
        response.status(error.status || 400).json({ error: error.message });
        return;
    }
    request.body = plainTextSession.dispatchBody;
    if (typeof postProcessMessages === 'function' && Array.isArray(request.body?.messages)) {
        request.body.messages = postProcessMessages(request.body.messages);
    }
    if (plainTextSession.active) {
        request.__lukerPlainTextMeta = {
            enabled: true,
            mode: plainTextSession.config.mode,
            triggerSignal: plainTextSession.config.triggerSignal,
            tools: plainTextSession.config.tools,
            toolChoice: plainTextSession.config.toolChoice,
            attempt: 1,
            maxAttempts: plainTextSession.config.retry.maxAttempts,
            retryOf: null,
            originalError: '',
        };
    }

    let dispatchFn;
    try {
        dispatchFn = select(request.body || {}, request);
    } catch (err) {
        response.status(400).json({ error: err.message || 'select failed' });
        return;
    }
    if (typeof dispatchFn !== 'function') {
        response.status(400).json({ error: 'dispatch function not provided' });
        return;
    }

    // Validate before creating a job: createDispatchContext also builds the
    // per-request proxy agent, and a malformed URL must fail the HTTP request
    // instead of throwing inside the background dispatch.
    try {
        createRequestProxyAgent(request.body?.network_proxy);
    } catch (error) {
        response.status(400).json({ error: error.message });
        return;
    }

    const persistTarget = request.body?.luker_generation?.persist_target || null;
    let job;
    try {
        job = createGenerationJob(request, {
            job_id: requestId,
            persist_target: persistTarget,
        });
    } catch (error) {
        response.status(error.status || 500).json({ error: error.message, code: error.code });
        return;
    }
    if (!job) {
        response.status(500).json({ error: 'failed to create task' });
        return;
    }
    // Attach the job to the request so any downstream middleware / router
    // that inspects `getJobFromRequest(request)` sees the active job. The
    // legacy handlers all did this immediately after createGenerationJob;
    // the refactor forgot to carry it over, leaving getJobFromRequest
    // permanently returning null.
    attachJobToRequest(request, job);
    const abortController = new AbortController();
    job.abortController = abortController;

    // Client-disconnect notification pipe.
    //
    // Refactor intentionally does NOT default-bind close→abort like the
    // legacy `bindRequestCloseAbort` helper did. Core motivation of the
    // runner rewrite is "generation-job survives disconnect": the
    // auto-persist grace timer catches a mid-flight tab close and persists
    // the still-arriving upstream text so a subsequent
    // GET /api/generation/active can hand the job back to the client.
    // Auto-aborting on TCP close would break that contract, leak whatever
    // the upstream already spent, and race the grace timer.
    //
    // A dispatch that *does* need side effects on client disconnect (e.g.
    // ComfyUI must POST /interrupt or the GPU keeps generating on an
    // external server whose job we cannot resume) opts in by calling
    // ctx.onRequestClose(cb). Explicit user-initiated cancel still lives
    // on the POST /api/generation/:id/abort path (cancelGenerationJobForRequest).
    const onCloseHandlers = new Set();
    // `request.once('close', ...)` guards against Express emitting close
    // more than once on some socket teardown paths; each handler still
    // runs at most once because it is only added once.
    if (request && typeof request.once === 'function') {
        request.once('close', () => withDispatchLogging(Boolean(session), () => {
            for (const handler of onCloseHandlers) {
                try { handler(); } catch (err) { console.warn('[Dispatch] onRequestClose handler threw:', err); }
            }
        }));
    }

    response.status(200);
    response.setHeader('x-luker-generation-id', requestId);
    // Initial snapshot only — always '0' because dispatch has not yet run
    // and headers are flushed by response.json() below (setHeader after flush
    // is a no-op). The authoritative persisted/status metadata is delivered
    // over the dedicated WS `meta` channel before the terminal `end` frame.
    response.setHeader('x-luker-server-persisted', '0');
    response.json({});

    // Background dispatch
    const dispatch = async () => {
        // Two INDEPENDENT event stores fed from the same emit stream:
        //
        //   1. `job.events[]` — envelope shape `{seq, data:{kind, data}, ts}`.
        //      This is what `ws-delivery.js:eventToFrame` consumes to build
        //      the per-frame wire messages the browser expects
        //      (`{type:'head'|'chunk'|'end'|'error', ...}`). It MUST hold
        //      envelopes, not decoded SSE payload strings — the client's
        //      WebSocket handler dispatches on `msg.type` and would drop
        //      every non-envelope frame.
        //
        //      Also replayed verbatim by `/jobs/events{-stream}` recovery
        //      endpoints. The frontend recovery `handleEvent`
        //      (public/script.js:815) only reads `payload.seq`; it does not
        //      inspect `payload.data`, so the envelope shape does not
        //      regress the SSE catch-up path either. The authoritative
        //      recovery text feed is the periodic `status` frame carrying
        //      `job.text`, which is accumulated below via
        //      `accumulateChunkTextIntoJob`.
        //
        //   2. `inspectionEvents[]` — array of SSE `data:` payload strings.
        //      Consumed by `completeInspectionFromStream` (below, on
        //      dispatch success) which parses provider-native usage /
        //      responseParts / thinking blocks out of each frame. Legacy
        //      shape. Only kept when startInspection ran (chat / text /
        //      kobold / novelai). SD dispatches go through
        //      startImageInspection / completeImage and ignore this array.
        //
        // TCP-level chunk boundaries don't align with SSE frame boundaries:
        // a single chunk may contain multiple `data: {...}\n\n` frames or
        // split a frame across chunks. `sseBuffer` reassembles partials
        // before flushing per fully-received payload into `inspectionEvents`.
        //
        // `job.text` accumulation is a THIRD independent channel driven by
        // `accumulateChunkTextIntoJob(job, bytes)` on every chunk. That
        // helper owns its own buffer on `job._sseBuffer` (does the same
        // CRLF-normalise + `\n\n` frame split + `extractTextFromStreamingFrameData`
        // as the legacy `forwardStreamingWithGenerationJob` path). We do
        // NOT rely on `appendGenerationEvent`'s built-in text extraction
        // here because it JSON.parses whatever we hand it — passing an
        // envelope object would silently yield '' delta for every frame
        // (JSON.parse('[object Object]') throws → caught → empty).
        const inspectionEvents = [];
        const inspectionDecoder = new StringDecoder('utf8');
        let inspectionDecoderFlushed = false;
        const sseFramer = createSseFramer();
        function flushSseFrames(chunkText) {
            const frames = sseFramer.push(chunkText);
            for (const frame of frames) {
                inspectionEvents.push({ event: frame.event, data: frame.data });
            }
        }
        function flushInspectionDecoder(isStream) {
            if (inspectionDecoderFlushed) return;
            inspectionDecoderFlushed = true;
            const tail = inspectionDecoder.end();
            if (!tail) return;
            if (isStream) {
                flushSseFrames(tail);
            } else {
                inspectionEvents.push(tail);
            }
        }
        function flushSseTailBuffer() {
            flushInspectionDecoder(true);
            const tailFrames = sseFramer.flush();
            for (const frame of tailFrames) {
                inspectionEvents.push({ event: frame.event, data: frame.data });
            }
        }
        let dispatchSawError = false;
        let dispatchErrorMessage = '';
        let endEmitted = false;
        let upstreamHeadStatus = 200;
        let effectiveIsStream = Boolean(request.body?.stream || request.body?.streaming);
        job._isStream = effectiveIsStream;
        const wantsNativeWire = String(request.headers?.['x-luker-wire'] || '').trim().toLowerCase() === 'native';
        const declaredProtocol = endpoint === 'chat-completions'
            ? resolveWireProtocol(request.body?.chat_completion_source)
            : null;
        const shouldBufferNonStreamCompat = () => endpoint === 'chat-completions'
            && !effectiveIsStream
            && !wantsNativeWire
            && declaredProtocol !== null
            && declaredProtocol !== WIRE_PROTOCOLS.OPENAI_CHAT;
        const bufferedNonStreamChunks = [];
        let bufferedNonStreamFlushed = false;
        function flushBufferedNonStreamChunks(replacementBytes = null) {
            if (bufferedNonStreamFlushed) return;
            bufferedNonStreamFlushed = true;
            if (replacementBytes !== null) {
                bufferedNonStreamChunks.length = 0;
                appendGenerationEvent(job, { kind: 'chunk', data: replacementBytes });
                return;
            }
            for (const chunkEvent of bufferedNonStreamChunks) {
                appendGenerationEvent(job, chunkEvent);
            }
            bufferedNonStreamChunks.length = 0;
        }
        let initialPlainTextMetaEmitted = false;
        const plainTextStreamDetector = plainTextSession.active ? plainTextSession.createDetector() : null;
        let lastDetectedJobTextLen = 0;
        let livePlainTextParsingNotified = false;
        const ctx = createDispatchContext({
            request, abortController,
            onCloseHandlers,
            onStreamMode: (streamMode) => {
                effectiveIsStream = Boolean(streamMode);
                job._isStream = effectiveIsStream;
                if (effectiveIsStream && bufferedNonStreamChunks.length > 0) {
                    flushBufferedNonStreamChunks(null);
                }
            },
            onEmit: (rawEvent) => {
                const event = normalizeDispatchHeadEvent(rawEvent, { endpoint, isStream: effectiveIsStream });
                if (event?.kind === 'end') {
                    // Defer appending the terminal `end` envelope until the
                    // runner has completed inspection, plain-text evaluation,
                    // generation-job persistence, and emitted the dedicated
                    // `meta` frame, so wire ordering is always
                    // `head -> chunk* -> meta -> end`.
                    if (effectiveIsStream) {
                        flushSseTailBuffer();
                        finalizeJobProtocolStream(job);
                    } else {
                        flushInspectionDecoder(false);
                        finalizeJobProtocolStream(job);
                    }
                    return;
                }
                if (event?.kind === 'error') {
                    flushBufferedNonStreamChunks(null);
                    dispatchSawError = true;
                    dispatchErrorMessage = String(event.data?.message || 'Dispatch error');
                    appendGenerationEvent(job, event);
                    failGenerationJob(job, dispatchErrorMessage);
                    return;
                }
                if (event?.kind === 'head') {
                    upstreamHeadStatus = Number(event.data?.status ?? 200);
                    const headContentType = String(event.data?.headers?.['content-type'] || '').toLowerCase();
                    if (endpoint === 'chat-completions'
                        && effectiveIsStream
                        && upstreamHeadStatus >= 200
                        && upstreamHeadStatus < 300
                        && headContentType.includes('application/json')) {
                        effectiveIsStream = false;
                        job._isStream = false;
                    }
                }
                const bufferThisChunk = event?.kind === 'chunk'
                    && !bufferedNonStreamFlushed
                    && shouldBufferNonStreamCompat()
                    && upstreamHeadStatus >= 200
                    && upstreamHeadStatus < 300;
                if (bufferThisChunk) {
                    bufferedNonStreamChunks.push(event);
                } else {
                    // Store every envelope (head / chunk / meta) in `job.events`
                    // so `ws-delivery.js:eventToFrame` turns each entry into the
                    // exact wire frame the browser's WS handler dispatches on.
                    appendGenerationEvent(job, event);
                }
                if (event?.kind === 'head' && plainTextSession.active && !initialPlainTextMetaEmitted && upstreamHeadStatus >= 200 && upstreamHeadStatus < 300) {
                    initialPlainTextMetaEmitted = true;
                    // Publish trigger metadata out-of-band right after head so
                    // streaming clients can mask the post-trigger call region
                    // during live rendering without generating triggers locally.
                    appendGenerationEvent(job, {
                        kind: 'meta',
                        data: {
                            generation_id: job.id,
                            plain_text_function_call: {
                                enabled: true,
                                mode: plainTextSession.config.mode,
                                status: 'pending',
                                triggerSignal: plainTextSession.config.triggerSignal,
                                attempt: 1,
                                maxAttempts: plainTextSession.config.retry.maxAttempts,
                            },
                        },
                    });
                }
                if (event?.kind === 'chunk') {
                    // Chunk-only side channels:
                    //   - accumulate job.text so /jobs/status recovery
                    //     shows live text (frontend `handleStatus` reads
                    //     `payload.text`).
                    //   - decode + SSE-frame into `inspectionEvents` for
                    //     completeInspectionFromStream at dispatch tail.
                    const bytes = event.data;
                    accumulateChunkTextIntoJob(job, bytes);
                    // Live backend detection of entering plain-text call syntax
                    // during streaming keeps Request Inspector in `parsing`
                    // state until terminal completion or interruption.
                    if (plainTextStreamDetector && effectiveIsStream && typeof job.text === 'string' && job.text.length > lastDetectedJobTextLen) {
                        const textDelta = job.text.slice(lastDetectedJobTextLen);
                        lastDetectedJobTextLen = job.text.length;
                        const processed = plainTextStreamDetector.processTextDelta(textDelta);
                        if (processed.detected && !livePlainTextParsingNotified) {
                            livePlainTextParsingNotified = true;
                            updateInspectionPlainTextState(request, {
                                status: 'parsing',
                                triggerSignal: plainTextSession.config.triggerSignal,
                            });
                        }
                    }
                    // Throttled status push so a reconnecting client's
                    // recovery preview streams live instead of freezing at
                    // its subscribe-time snapshot until awaiting_ack.
                    notifyJobTextProgress(job);
                    let text = '';
                    if (bytes && typeof bytes === 'string') {
                        text = bytes;
                    } else if (bytes && (bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
                        try {
                            const buf = Buffer.isBuffer(bytes)
                                ? bytes
                                : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                            text = inspectionDecoder.write(buf);
                        } catch {
                            text = '';
                        }
                    }
                    if (!text) return;
                    if (effectiveIsStream) {
                        flushSseFrames(text);
                    } else {
                        // Non-stream: the chunk is the full upstream JSON
                        // body. Push once as a single inspection entry;
                        // the completeInspection path below JSON.parses
                        // inspectionEvents.join('') to hand the raw
                        // payload to the inspector.
                        inspectionEvents.push(text);
                    }
                }
            },
        });
        try {
            await dispatchFn(ctx);
            if (dispatchSawError) {
                try {
                    const entry = findEntry(request);
                    if (entry && entry.status === 'running') {
                        if (abortController.signal.aborted) {
                            ctx.inspection.abort();
                        } else if (entry.type === 'image') {
                            ctx.inspection.failImage(new Error(dispatchErrorMessage || 'Dispatch error'), 500);
                        } else {
                            ctx.inspection.fail(new Error(dispatchErrorMessage || 'Dispatch error'), 500);
                        }
                    }
                } catch (err) {
                    console.error('[Runner] Failed to finalize errored request inspection:', err);
                }
            } else {
                // Flush providers that did not call ctx.emit.end() themselves
                // before computing final job.text / job.parsedTurn.
                ctx.emit.end();

                const isSuccessStatus = upstreamHeadStatus >= 200 && upstreamHeadStatus < 300;
                const isAborted = abortController.signal.aborted || job.status === 'cancelled';
                // Runner-side inspector completion runs BEFORE plain-text
                // evaluation and BEFORE emitting `meta` + `end` so the
                // inspector entry is complete and race-free the moment the
                // client observes stream completion.
                try {
                    const entry = findEntry(request);
                    if (entry && entry.type === 'chat' && entry.status === 'running') {
                        if (isAborted) {
                            ctx.inspection.abort();
                        } else if (!isSuccessStatus) {
                            ctx.inspection.fail(new Error(`Upstream returned HTTP ${upstreamHeadStatus}`), upstreamHeadStatus);
                        } else if (effectiveIsStream) {
                            flushSseTailBuffer();
                            const invalidSse = sseFramer.getInvalidDiagnostic?.();
                            const protocol = resolveWireProtocol(entry.source);
                            if (protocol && inspectionEvents.length === 0 && invalidSse) {
                                const parseErr = new ProtocolParseError({
                                    protocol,
                                    stage: 'sse',
                                    location: 'stream',
                                    message: 'Expected text/event-stream SSE frames, received non-SSE response body.',
                                    rawDiagnostic: invalidSse,
                                });
                                failInspectionParseError(request, parseErr, {
                                    kind: 'streaming',
                                    protocol,
                                    rawBody: invalidSse,
                                }, 200);
                            } else {
                                completeInspectionFromStream(request, inspectionEvents, job.text || '');
                            }
                        } else {
                            const rawBody = inspectionEvents.join('');
                            try {
                                const payload = JSON.parse(rawBody);
                                completeInspection(request, payload, payload);
                            } catch (parseCause) {
                                const protocol = resolveWireProtocol(entry.source) || entry.source || 'unknown';
                                const parseErr = new ProtocolParseError({
                                    protocol,
                                    stage: 'json',
                                    location: 'body',
                                    message: `Malformed non-streaming JSON response: ${parseCause.message}`,
                                    cause: parseCause,
                                    rawDiagnostic: rawBody,
                                });
                                failInspectionParseError(request, parseErr, {
                                    kind: 'non-streaming',
                                    protocol,
                                    rawBody,
                                }, 200);
                            }
                        }
                    }
                } catch (err) {
                    console.error('[Runner] Failed to finalize request inspection:', err);
                }

                // Validate non-streaming chat protocol responses even when
                // Request Inspector is disabled (transient sessions) or when
                // the response body is empty, so malformed JSON never silently
                // falls through to plain-text evaluation or awaiting_ack.
                let parsedRawNonStreamPayload = null;
                if (isSuccessStatus && !isAborted && !effectiveIsStream && !job.parseError && (!job.parsedTurn || job._streamMode !== 'json')) {
                    const protocol = resolveWireProtocol(request.body?.chat_completion_source);
                    if (protocol) {
                        const rawBody = inspectionEvents.join('');
                        try {
                            parsedRawNonStreamPayload = JSON.parse(rawBody);
                            const turn = parseProtocolResponse(protocol, parsedRawNonStreamPayload);
                            job.parsedTurn = turn;
                            if (typeof turn.text === 'string') {
                                job.text = turn.text;
                            }
                            job._streamMode = 'json';
                        } catch (parseCause) {
                            const parseErr = parseCause instanceof ProtocolParseError
                                ? parseCause
                                : new ProtocolParseError({
                                    protocol,
                                    stage: 'json',
                                    location: 'body',
                                    message: `Malformed non-streaming JSON response: ${parseCause?.message || parseCause}`,
                                    cause: parseCause,
                                    rawDiagnostic: rawBody,
                                });
                            job.parsedTurn = null;
                            job.text = '';
                            job.parseError = parseErr.toDiagnostic();
                        }
                    }
                }

                // Flush buffered non-streaming chunks for non-OAI protocols:
                // on a valid parsed turn (default wire mode), emit a compat
                // superset preserving all native upstream fields alongside OAI
                // `choices[0].message`; on errors, aborts, or `x-luker-wire:
                // native`, emit the original upstream bytes verbatim.
                if (bufferedNonStreamChunks.length > 0) {
                    if (isSuccessStatus && !isAborted && !job.parseError && job.parsedTurn) {
                        let rawPayload = parsedRawNonStreamPayload;
                        if (rawPayload === null) {
                            try {
                                rawPayload = JSON.parse(inspectionEvents.join(''));
                            } catch {
                                rawPayload = null;
                            }
                        }
                        if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
                            const compatBody = buildCompatChatCompletionPayload(job.parsedTurn, rawPayload);
                            flushBufferedNonStreamChunks(new TextEncoder().encode(JSON.stringify(compatBody)));
                        } else {
                            flushBufferedNonStreamChunks(null);
                        }
                    } else {
                        flushBufferedNonStreamChunks(null);
                    }
                }

                // Backend plain-text function-calling evaluation & configured
                // format-correction retries. Upstream HTTP bytes already passed
                // through untouched; authoritative results travel via WS `meta`.
                let clientPlainTextMeta = null;
                if (plainTextSession.active && isSuccessStatus) {
                    const entry1 = findEntry(request);
                    const hasProtocolFailure = Boolean(job.parseError || entry1?.parseError || entry1?.status === 'error');
                    if (isAborted) {
                        updateInspectionPlainTextState(request, {
                            status: 'aborted',
                            failureReason: 'aborted',
                            error: 'Aborted',
                        });
                        clientPlainTextMeta = buildClientPlainTextMeta({
                            status: 'aborted',
                            displayText: '',
                            calls: [],
                            toolCalls: [],
                            error: 'Aborted',
                            failureReason: 'aborted',
                        }, {
                            mode: plainTextSession.config.mode,
                            triggerSignal: plainTextSession.config.triggerSignal,
                            attempt: 1,
                            maxAttempts: plainTextSession.config.retry.maxAttempts,
                            inspectorEntryId: entry1?.id || null,
                        });
                    } else if (!hasProtocolFailure) {
                        const initialTurn = job.parsedTurn || {
                            text: job.text || entry1?.responseText || '',
                            parts: Array.isArray(entry1?.responseParts) ? entry1.responseParts : [],
                        };

                        const attempt1Result = evaluatePlainTextToolCallTurn(initialTurn, plainTextSession.config);
                        const attempt1Parts = applyPlainTextResultToResponseParts(
                            Array.isArray(initialTurn.parts) && initialTurn.parts.length > 0 ? initialTurn.parts : entry1?.responseParts,
                            attempt1Result,
                            {
                                triggerSignal: plainTextSession.config.triggerSignal,
                                attempt: 1,
                                maxAttempts: plainTextSession.config.retry.maxAttempts,
                                retryOf: null,
                                originalError: '',
                            },
                        );
                        applyInspectionPlainTextResult(request, {
                            turn: initialTurn,
                            ptResult: attempt1Result,
                            config: plainTextSession.config,
                            responseParts: attempt1Parts,
                            attempt: 1,
                            maxAttempts: plainTextSession.config.retry.maxAttempts,
                            retryOf: null,
                            originalError: '',
                        });

                        let finalTurn = initialTurn;
                        let finalResult = attempt1Result;
                        let finalAttempt = 1;
                        let finalRetryOf = null;
                        let finalOriginalError = '';
                        let finalEntryId = entry1?.id || null;

                        if (attempt1Result.status === 'parse_failed'
                            && plainTextSession.config.retry.enabled
                            && plainTextSession.config.retry.maxAttempts > 1) {
                            const retryOutcome = await runPlainTextFormatCorrectionRetries({
                                originalRequest: request,
                                cleanDispatchBody: plainTextSession.dispatchBody,
                                baseMessages: plainTextSession.baseMessages,
                                postProcessMessages,
                                select,
                                abortController,
                                initialEntryId: entry1?.id || null,
                                initialTurn,
                                initialPtResult: attempt1Result,
                                config: plainTextSession.config,
                            });
                            finalTurn = retryOutcome.turn || finalTurn;
                            finalResult = retryOutcome.ptResult;
                            finalAttempt = retryOutcome.attempt;
                            finalRetryOf = retryOutcome.retryOf;
                            finalOriginalError = retryOutcome.originalError;
                            finalEntryId = retryOutcome.inspectorEntryId || finalEntryId;
                        }

                        if (finalResult.status === 'parsed') {
                            job.text = finalResult.displayText;
                            const baseTurn = finalAttempt > 1 ? finalTurn : (job.parsedTurn || finalTurn);
                            if (baseTurn) {
                                const sanitizedTurn = { ...baseTurn, text: finalResult.displayText };
                                delete sanitizedTurn.nativeContentBlocks;
                                delete sanitizedTurn.nativeParts;
                                delete sanitizedTurn.responsesOutputItems;
                                job.parsedTurn = sanitizedTurn;
                            }
                        } else if (finalResult.status === 'none' && finalAttempt > 1) {
                            job.text = finalResult.displayText ?? '';
                            if (finalTurn) {
                                job.parsedTurn = finalTurn;
                            }
                        } else if (finalResult.status === 'parse_failed' || finalResult.status === 'network_error' || finalResult.status === 'aborted') {
                            // Never persist broken XML call markup into chat history.
                            job.text = '';
                        }

                        clientPlainTextMeta = buildClientPlainTextMeta(finalResult, {
                            mode: plainTextSession.config.mode,
                            triggerSignal: plainTextSession.config.triggerSignal,
                            attempt: finalAttempt,
                            maxAttempts: plainTextSession.config.retry.maxAttempts,
                            retryOf: finalRetryOf,
                            originalError: finalOriginalError,
                            inspectorEntryId: finalEntryId,
                            replacedTurn: finalAttempt > 1 ? finalTurn : null,
                        });
                    }
                }

                // Advance the generation job FIRST so the `meta` frame we emit
                // next reports the accurate `persisted` flag and `status`.
                // Non-2xx upstream statuses, protocol parse errors / in-stream
                // provider errors, and aborted jobs must fail rather than
                // entering `awaiting_ack` with an auto-persist grace timer.
                const protocolParseError = job.parseError || findEntry(request)?.parseError || null;
                const abortedNow = isAborted || abortController.signal.aborted || job.status === 'cancelled';
                try {
                    if (abortedNow || job.status === 'failed') {
                        if (job.status !== 'cancelled' && job.status !== 'failed') {
                            const reason = abortController.signal.reason;
                            failGenerationJob(job, reason instanceof Error ? reason.message : String(reason || 'Aborted'));
                        }
                    } else if (!isSuccessStatus) {
                        failGenerationJob(job, `Upstream returned HTTP ${upstreamHeadStatus}`);
                    } else if (protocolParseError) {
                        failGenerationJob(job, protocolParseError.message || 'Upstream protocol parse error');
                    } else {
                        await completeGenerationJobFromText(request, job, job.text || '', request.body?.model || '');
                    }
                } catch (err) {
                    console.error('[Runner] Failed to update generation job state:', err);
                }
                // Emit dedicated out-of-band WS `meta` frame for BOTH streaming
                // and non-streaming requests so upstream response.body stays
                // 100% verbatim upstream wire bytes with zero synthetic frames.
                ctx.emit.meta({
                    generation_id: job.id,
                    persisted: Boolean(job.persisted),
                    status: job.status,
                    ...(clientPlainTextMeta ? { plain_text_function_call: clientPlainTextMeta } : {}),
                });
                if (!endEmitted) {
                    endEmitted = true;
                    appendGenerationEvent(job, { kind: 'end', data: null });
                }
            }
        } catch (err) {
            if (plainTextSession.active) {
                const isAbort = err?.name === 'AbortError' || abortController.signal.aborted;
                try {
                    updateInspectionPlainTextState(request, {
                        status: isAbort ? 'aborted' : 'network_error',
                        failureReason: isAbort ? 'aborted' : 'network',
                        error: err?.message || String(err || ''),
                    });
                } catch (updateErr) {
                    console.error('[Runner] Failed to update plain-text inspection state:', updateErr);
                }
            }
            // Order matters: (1) surface to client through emit.error so the
            // WS delivery layer flips the terminal-lock and abandons any
            // buffered chunks; (2) transition the generation job from
            // `running` → `failed` so /api/generation/active stops handing
            // out a zombie id that keeps ticking until the 2h TTL prune
            // reaper collects it; (3) mark the request-inspector entry as
            // errored with an explicit 500 so the UI shows a fault instead
            // of a perma-pending row. Every step wrapped in its own
            // try/catch: any one throwing must not prevent the others (a
            // failInspection throw was previously swallowing the
            // failGenerationJob call above the fix).
            try { ctx.emit.error(err); } catch (e) { console.warn('[Runner] emit.error threw:', e); }
            try { failGenerationJob(job, err?.message || String(err)); } catch (e) { console.warn('[Runner] failGenerationJob threw:', e); }
            try {
                const entry = findEntry(request);
                if (entry && entry.status === 'running') {
                    if (err?.name === 'AbortError' || abortController.signal.aborted) {
                        ctx.inspection.abort();
                    } else if (entry.type === 'image') {
                        ctx.inspection.failImage(err, 500);
                    } else {
                        // Explicit 500: an unhandled dispatch throw is not an
                        // upstream 4xx (those go through the dispatch's own
                        // !resp.ok branch which sets httpStatus to the real
                        // upstream code). Route through ctx.inspection.fail so
                        // dispatches that override the inspection facade (tests)
                        // see the same call site.
                        ctx.inspection.fail(err, 500);
                    }
                }
            } catch (e) { console.warn('[Runner] inspection.fail threw:', e); }
        }
    };
    const operation = new Promise((resolve, reject) => {
        setImmediate(() => { withDispatchLogging(Boolean(session), dispatch).then(resolve, reject); });
    });
    if (session) {
        trackTransientOperation(session, operation, {
            abort: () => withDispatchLogging(true, () => abortController.abort('Temporary session closed.')),
        });
        registerTransientCleanup(session, () => releaseTransientGenerationJobs(session));
    }
    void operation.catch(error => {
        appendGenerationEvent(job, {
            kind: 'error',
            data: { code: 'internal', message: error.message },
        });
        failGenerationJob(job, error.message);
    });
}
