// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
    createGenerationJob,
    appendGenerationEvent,
    accumulateChunkTextIntoJob,
    failGenerationJob,
} from '../endpoints/backends/luker-generation.js';
import {
    completeInspectionFromStream,
    failInspection,
} from '../request-inspector.js';
import { createDispatchContext } from './context.js';

export async function runLukerDispatch(request, response, { endpoint, select }) {
    const requestId = String(request.headers?.['x-luker-request-id'] || '').trim();
    if (!requestId) {
        response.status(400).json({ error: 'x-luker-request-id header required' });
        return;
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

    const persistTarget = request.body?.luker_generation?.persist_target || null;
    const job = createGenerationJob(request, {
        job_id: requestId,
        persist_target: persistTarget,
    });
    if (!job) {
        response.status(500).json({ error: 'failed to create task' });
        return;
    }
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
        const inspectionEvents = [];
        const ctx = createDispatchContext({
            request, task: job, abortController,
            onEmit: (event) => {
                // 把 event 塞进 job.events 供 replay/persist
                appendGenerationEvent(job, event);
                // 从 chunk 字节里增量抽 text,喂给 auto-persist / /api/generation/active
                if (event?.kind === 'chunk') {
                    accumulateChunkTextIntoJob(job, event.data);
                    // Capture each chunk as a decoded string for the inspector
                    // usage/text extractor. Best-effort — if bytes aren't UTF-8
                    // we still count the frame but text extraction handles it.
                    try {
                        const bytes = event.data;
                        if (bytes && typeof bytes === 'string') {
                            inspectionEvents.push(bytes);
                        } else if (bytes && (bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
                            inspectionEvents.push(Buffer.from(bytes).toString('utf8'));
                        }
                    } catch { /* best-effort */ }
                } else if (event?.kind === 'end') {
                    // 收尾:如果 SSE 尾部帧没有 \n\n 结束符,追加 \n\n 触发最后一次 flush
                    const tail = String(job._sseBuffer || '');
                    if (tail && !tail.endsWith('\n\n')) {
                        accumulateChunkTextIntoJob(job, '\n\n');
                    }
                    job._sseBuffer = '';
                }
            },
        });
        try {
            await dispatchFn(ctx);
            // 若 dispatch 没显式 emit end,兜底
            ctx.emit.end();
            // Runner-side inspector complete. Safe no-op when startInspection
            // never fired (SD image handlers, non-chat dispatch). This is why
            // 请求检查器 previously stuck at "running" — no dispatch called
            // completeInspection; the runner now covers it.
            try {
                completeInspectionFromStream(request, inspectionEvents, job.text || '');
            } catch { /* inspector best-effort, never fails the request */ }
        } catch (err) {
            ctx.emit.error(err);
            failGenerationJob(job, err.message || String(err));
            try {
                failInspection(request, err?.message || String(err));
            } catch { /* inspector best-effort */ }
        }
    });
}
