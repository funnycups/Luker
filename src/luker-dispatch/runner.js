// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
    createGenerationJob,
    appendGenerationEvent,
    accumulateChunkTextIntoJob,
    completeGenerationJobFromText,
    failGenerationJob,
    attachJobToRequest,
} from '../endpoints/backends/luker-generation.js';
import {
    completeInspection,
    completeInspectionFromStream,
    findEntry,
} from '../request-inspector.js';
import { createDispatchContext } from './context.js';

export async function runLukerDispatch(request, response, { endpoint, select }) {
    // Prefer the client-supplied job_id (from body.luker_generation.job_id)
    // when present so /jobs/status?id=<uuid> queries hit the same job the
    // runner created. Legacy client code (openai.js:4201) pre-generates a
    // uuid and stashes it in the body so it can poll for auto-persist.
    const bodyJobId = String(request.body?.luker_generation?.job_id || '').trim();
    const headerId = String(request.headers?.['x-luker-request-id'] || '').trim();
    const requestId = bodyJobId || headerId || randomUUID();

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

    const persistTarget = request.body?.luker_generation?.persist_target || null;
    const job = createGenerationJob(request, {
        job_id: requestId,
        persist_target: persistTarget,
    });
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
        request.once('close', () => {
            for (const handler of onCloseHandlers) {
                try { handler(); }
                catch (err) { console.warn('[Dispatch] onRequestClose handler threw:', err); }
            }
        });
    }

    response.status(200);
    response.setHeader('x-luker-generation-id', requestId);
    response.setHeader('x-luker-server-persisted', '0');
    response.json({});

    // Background dispatch
    setImmediate(async () => {
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
        let sseBuffer = '';
        // SSE frame parsing 1:1 copied from legacy
        // forwardStreamingWithGenerationJob (luker-generation.js in the
        // pre-refactor tree). Do NOT simplify or "modernize" any step:
        //   - CRLF → LF normalization on every append (nginx-wrapped
        //     Anthropic and Claude passthrough proxies emit CRLF)
        //   - `while (indexOf) { slice frame; slice buffer; }` loop instead
        //     of split.pop (keeps partial frame consumption explicit)
        //   - .trimEnd() then .slice(5).trimStart() per line (NOT full
        //     .trim() — that strips payload-internal trailing whitespace
        //     in Claude thinking/tool_use deltas)
        //   - separate tail flush after chunks stop (last frame may not
        //     terminate with \n\n)
        //
        // Only feeds `inspectionEvents`. `job.events` receives envelopes
        // in `onEmit` directly; `job.text` is accumulated in `onEmit` via
        // `accumulateChunkTextIntoJob` on the raw bytes.
        function flushSseFrames(chunkText) {
            sseBuffer += chunkText;
            sseBuffer = sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            let delimiterIndex = sseBuffer.indexOf('\n\n');
            while (delimiterIndex !== -1) {
                const frame = sseBuffer.slice(0, delimiterIndex);
                sseBuffer = sseBuffer.slice(delimiterIndex + 2);
                const dataLines = frame
                    .split('\n')
                    .map(line => line.replace(/\s+$/, ''))
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^\s+/, ''));
                if (dataLines.length > 0) {
                    const payload = dataLines.join('\n');
                    if (payload) {
                        inspectionEvents.push(payload);
                    }
                }
                delimiterIndex = sseBuffer.indexOf('\n\n');
            }
        }
        function flushSseTailBuffer() {
            if (!sseBuffer) return;
            const tail = sseBuffer;
            sseBuffer = '';
            if (!tail.trim()) return;
            const dataLines = tail
                .split('\n')
                .map(line => line.replace(/\s+$/, ''))
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^\s+/, ''));
            if (dataLines.length === 0) return;
            const payload = dataLines.join('\n');
            if (payload) {
                inspectionEvents.push(payload);
            }
        }
        const ctx = createDispatchContext({
            request, task: job, abortController,
            onCloseHandlers,
            onEmit: (event) => {
                // Store every envelope (head / chunk / end / error) in
                // `job.events` so `ws-delivery.js:eventToFrame` can turn
                // each entry into the exact wire frame the browser's WS
                // handler dispatches on (`msg.type`). Without this,
                // eventToFrame's `typeof data !== 'object'` guard returns
                // null for every entry and NOTHING reaches the client —
                // Response bodies stay pending forever.
                appendGenerationEvent(job, event);
                if (event?.kind === 'chunk') {
                    // Chunk-only side channels:
                    //   - accumulate job.text so /jobs/status recovery
                    //     shows live text (frontend `handleStatus` reads
                    //     `payload.text`).
                    //   - decode + SSE-frame into `inspectionEvents` for
                    //     completeInspectionFromStream at dispatch tail.
                    const bytes = event.data;
                    accumulateChunkTextIntoJob(job, bytes);
                    let text = '';
                    if (bytes && typeof bytes === 'string') {
                        text = bytes;
                    } else if (bytes && (bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
                        try { text = Buffer.from(bytes).toString('utf8'); }
                        catch { text = ''; }
                    }
                    if (!text) return;
                    const isStream = Boolean(request.body?.stream || request.body?.streaming);
                    if (isStream) {
                        flushSseFrames(text);
                    } else {
                        // Non-stream: the chunk is the full upstream JSON
                        // body. Push once as a single inspection entry;
                        // the completeInspection path below JSON.parses
                        // inspectionEvents.join('') to hand the raw
                        // payload to the inspector.
                        inspectionEvents.push(text);
                    }
                } else if (event?.kind === 'end') {
                    // Tail-flush any SSE residue that never received a
                    // closing \n\n. Real providers (Claude, OpenAI usage
                    // deltas) often ship the terminal frame without the
                    // closing separator; without this, the final
                    // usage/message_delta payload never lands in the
                    // inspector.
                    if (sseBuffer) {
                        if (!sseBuffer.endsWith('\n\n')) {
                            flushSseFrames('\n\n');
                        } else {
                            flushSseFrames('');
                        }
                    }
                    sseBuffer = '';
                }
                // `head` and `error` intentionally have no side channel —
                // they're already in `job.events` for WS delivery, and
                // failInspection / completeInspection paths in the outer
                // try/catch cover the inspector surface.
            },
        });
        try {
            await dispatchFn(ctx);
            // Advance the generation job to `awaiting_ack` FIRST so the
            // trailer we emit next reports the current `persisted` flag
            // accurately. `completeGenerationJobFromText` arms the 15s
            // auto-persist grace timer; `job.persisted` flips to `true`
            // asynchronously when the timer fires (or when a fast synchronous
            // persistence path completes it inline in tests). Callers that
            // need the final flag still poll /jobs/status — the trailer just
            // carries whatever state we can observe *right now*.
            //
            // Legacy handlers called this via `finalizePayloadWithJob` /
            // `forwardStreamingWithGenerationJob`; the refactor initially
            // called it AFTER emitting the trailer, guaranteeing every
            // trailer reported `persisted: false` and `status: 'running'`.
            try {
                await completeGenerationJobFromText(request, job, job.text || '', request.body?.model || '');
            } catch { /* generation-job best-effort; never crash background */ }
            // Emit the legacy trailer SSE frame carrying luker.generation_id
            // + persisted + status. Frontend openai.js:4316 reads this frame
            // to learn the job id and persist flag. Legacy
            // forwardStreamingWithGenerationJob appended this at stream tail;
            // the refactor dropped it. ONLY for streaming — non-stream body
            // is a single JSON blob that `await response.json()` would fail
            // to parse if an SSE-shaped frame were appended.
            //
            // Uses `emit.trailer` (context.js) which bypasses safeEmit's
            // terminal-lock: dispatches emit `end` at their own tail, and
            // without the bypass every trailer would be silently dropped.
            const isStream = Boolean(request.body?.stream || request.body?.streaming);
            if (isStream) {
                try {
                    const trailer = JSON.stringify({
                        luker: {
                            generation_id: job.id,
                            persisted: Boolean(job.persisted),
                            status: job.status,
                        },
                    });
                    ctx.emit.trailer(new TextEncoder().encode(`data: ${trailer}\n\n`));
                } catch { /* best-effort */ }
            }
            // 若 dispatch 没显式 emit end,兜底 (already terminal → no-op).
            ctx.emit.end();
            // Runner-side inspector complete. Only advance `type: 'chat'`
            // entries — SD dispatches use `startImageInspection` (creates a
            // `type: 'image'` entry with its own completeImage lifecycle),
            // and calling completeInspectionFromStream on an image entry
            // would clobber its already-set responseText/parts/usage.
            //
            // For NON-streaming chat requests, inspectionEvents contains a
            // single decoded string = the full upstream JSON body.
            // completeInspectionFromStream tries to parse it as SSE frames
            // ("data: {...}\n\n") and yields empty usage/parts. Detect the
            // non-stream case via body.stream and route to completeInspection
            // with the parsed payload instead — matches legacy
            // finalizePayloadWithJob→completeInspection semantics so
            // inspector UI shows usage + parts for non-stream Claude / OAI /
            // Gemini / etc.
            try {
                const entry = findEntry(request);
                // Don't overwrite terminal states set by the dispatch itself:
                //   - failInspection (upstream 4xx/5xx handled in dispatch's
                //     !resp.ok branch — sets status='error' + real httpStatus)
                //   - abortInspection (user-cancelled)
                //   - completeInspection (dispatch that owns the raw upstream
                //     body — Claude / MakerSuite / VertexAI / Cohere — calls
                //     ctx.inspection.complete(oai, raw) directly so the
                //     extractors see provider-native fields like
                //     usage.cache_read_input_tokens, usageMetadata.
                //     cachedContentTokenCount, thinking blocks with
                //     signatures. Runner-side completeInspection can only
                //     pass (payload, payload) which loses the raw shape.)
                // Without this guard, upstream Claude 400 requests come back
                // as status='success' httpStatus=200 in the inspector UI
                // because runner-side completeInspection unconditionally
                // rewrites status/httpStatus regardless of prior state.
                if (entry && entry.type === 'chat' && entry.status === 'running') {
                    if (isStream) {
                        // Grab any final frame that didn't terminate with
                        // \n\n before extractors run — otherwise
                        // usage/message_delta frames at the very tail get
                        // dropped and responseParts + usage come back empty.
                        flushSseTailBuffer();
                        completeInspectionFromStream(request, inspectionEvents, job.text || '');
                    } else {
                        // Best-effort JSON parse of accumulated single-frame
                        // body; if it fails (unexpected non-JSON payload)
                        // fall back to the streaming path so we at least set
                        // status/duration/httpStatus and don't leave the
                        // entry perma-pending.
                        let payload = null;
                        try {
                            payload = JSON.parse(inspectionEvents.join(''));
                        } catch { /* fall through */ }
                        if (payload && typeof payload === 'object') {
                            completeInspection(request, payload, payload);
                        } else {
                            completeInspectionFromStream(request, inspectionEvents, job.text || '');
                        }
                    }
                }
            } catch { /* inspector best-effort, never fails the request */ }
        } catch (err) {
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
            try { ctx.emit.error(err); }
            catch (e) { console.warn('[Runner] emit.error threw:', e); }
            try { failGenerationJob(job, err?.message || String(err)); }
            catch (e) { console.warn('[Runner] failGenerationJob threw:', e); }
            try {
                const entry = findEntry(request);
                if (entry && entry.type === 'chat') {
                    // Explicit 500: an unhandled dispatch throw is not an
                    // upstream 4xx (those go through the dispatch's own
                    // !resp.ok branch which sets httpStatus to the real
                    // upstream code). Route through ctx.inspection.fail so
                    // dispatches that override the inspection facade (tests)
                    // see the same call site.
                    ctx.inspection.fail(err, 500);
                }
            } catch (e) { console.warn('[Runner] inspection.fail threw:', e); }
        }
    });
}
