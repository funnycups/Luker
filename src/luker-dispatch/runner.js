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
    failInspection,
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

    response.status(200);
    response.setHeader('x-luker-generation-id', requestId);
    response.setHeader('x-luker-server-persisted', '0');
    response.json({});

    // Background dispatch
    setImmediate(async () => {
        // Stream events accumulator for the request inspector. Only kept when
        // startInspection ran (i.e. dispatch is a chat/text/kobold/novelai
        // provider that calls ctx.inspection.start()). SD dispatches use the
        // image inspector via startImage/completeImage and manage complete
        // themselves — the runner-side complete below is a no-op for them
        // because findEntry() returns null when there's no __inspectorId.
        //
        // inspectionEvents holds one string per SSE `data:` payload, NOT one
        // per chunk. TCP-level chunk boundaries don't align with SSE frame
        // boundaries: a single chunk may contain multiple `data: {...}\n\n`
        // frames concatenated, or split a frame across two chunks. We
        // maintain a per-job _inspectorSseBuffer separately from
        // _sseBuffer (used by accumulateChunkTextIntoJob) so text and
        // inspector extraction are independent.
        const inspectionEvents = [];
        let inspectorSseBuffer = '';
        function flushInspectorSseFrames(chunkText) {
            inspectorSseBuffer += chunkText;
            if (!inspectorSseBuffer.includes('\n\n')) return;
            const frames = inspectorSseBuffer.split('\n\n');
            inspectorSseBuffer = frames.pop() || '';
            for (const frame of frames) {
                if (!frame) continue;
                const dataLines = [];
                for (const line of frame.split('\n')) {
                    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (dataLines.length === 0) continue;
                const payload = dataLines.join('\n');
                if (!payload) continue;
                inspectionEvents.push(payload);
            }
        }
        const ctx = createDispatchContext({
            request, task: job, abortController,
            onEmit: (event) => {
                // 把 event 塞进 job.events 供 replay/persist
                appendGenerationEvent(job, event);
                // 从 chunk 字节里增量抽 text,喂给 auto-persist / /api/generation/active
                if (event?.kind === 'chunk') {
                    accumulateChunkTextIntoJob(job, event.data);
                    // Capture chunk bytes as SSE-parsed payloads for the
                    // inspector usage/text extractor. Non-streaming chat
                    // dispatches emit exactly one chunk = the full JSON body;
                    // that chunk won't contain `\n\n` so no frames flush here
                    // — the non-stream branch below handles it via JSON.parse
                    // in runner's completeInspection call.
                    try {
                        const bytes = event.data;
                        let text = '';
                        if (bytes && typeof bytes === 'string') {
                            text = bytes;
                        } else if (bytes && (bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
                            text = Buffer.from(bytes).toString('utf8');
                        }
                        if (text) {
                            const isStream = Boolean(request.body?.stream || request.body?.streaming);
                            if (isStream) {
                                flushInspectorSseFrames(text);
                            } else {
                                // Non-stream: push the raw chunk (full JSON body)
                                // so the runner's non-stream branch can JSON.parse
                                // inspectionEvents.join('') into the payload.
                                inspectionEvents.push(text);
                            }
                        }
                    } catch { /* best-effort */ }
                } else if (event?.kind === 'end') {
                    // 收尾:如果 SSE 尾部帧没有 \n\n 结束符,追加 \n\n 触发最后一次 flush
                    const tail = String(job._sseBuffer || '');
                    if (tail && !tail.endsWith('\n\n')) {
                        accumulateChunkTextIntoJob(job, '\n\n');
                    }
                    job._sseBuffer = '';
                    // Same flush for the inspector's SSE buffer so a tail
                    // frame without terminator still gets parsed.
                    if (inspectorSseBuffer && !inspectorSseBuffer.endsWith('\n\n')) {
                        flushInspectorSseFrames('\n\n');
                    }
                    inspectorSseBuffer = '';
                }
            },
        });
        try {
            await dispatchFn(ctx);
            // Emit the legacy trailer SSE frame carrying luker.generation_id
            // + persisted + status. Frontend openai.js:4316 reads this frame
            // to learn the job id and persist flag. Legacy
            // forwardStreamingWithGenerationJob appended this at stream tail;
            // the refactor dropped it. ONLY for streaming — non-stream body
            // is a single JSON blob that `await response.json()` would fail
            // to parse if an SSE-shaped frame were appended.
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
                    ctx.emit.chunk(new TextEncoder().encode(`data: ${trailer}\n\n`));
                } catch { /* best-effort */ }
            }
            // 若 dispatch 没显式 emit end,兜底
            ctx.emit.end();
            // Advance the generation job to `awaiting_ack` so:
            //   - GET /jobs/status returns a terminal state (SSE consumers exit)
            //   - the auto-persist grace timer arms (client-ACK-race)
            //   - acknowledgeGenerationJobsForRequest accepts the ack
            // Legacy handlers did this via `finalizePayloadWithJob` /
            // `forwardStreamingWithGenerationJob`; the refactor missed it,
            // leaving every job stuck on `running` until TTL cleared it.
            //
            // Runs AFTER emit.end so client's stream close is not delayed by
            // the async work here.
            try {
                await completeGenerationJobFromText(request, job, job.text || '', request.body?.model || '');
            } catch { /* generation-job best-effort; never crash background */ }
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
                if (entry && entry.type === 'chat') {
                    if (isStream) {
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
            ctx.emit.error(err);
            failGenerationJob(job, err.message || String(err));
            try {
                const entry = findEntry(request);
                if (entry && entry.type === 'chat') {
                    failInspection(request, err?.message || String(err));
                }
            } catch { /* inspector best-effort */ }
        }
    });
}
