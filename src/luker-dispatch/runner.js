// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    createGenerationJob,
    appendGenerationEvent,
    accumulateChunkTextIntoJob,
    failGenerationJob,
} from '../endpoints/backends/luker-generation.js';
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
        const ctx = createDispatchContext({
            request, task: job, abortController,
            onEmit: (event) => {
                // 把 event 塞进 job.events 供 replay/persist
                appendGenerationEvent(job, event);
                // 从 chunk 字节里增量抽 text,喂给 auto-persist / /api/generation/active
                if (event?.kind === 'chunk') {
                    accumulateChunkTextIntoJob(job, event.data);
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
        } catch (err) {
            ctx.emit.error(err);
            failGenerationJob(job, err.message || String(err));
        }
    });
}
