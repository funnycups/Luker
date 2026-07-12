// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for ComfyUI running on RunPod. Extracted from
// src/endpoints/stable-diffusion.js:558-631.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read RunPod API key from SECRET_KEYS.COMFY_RUNPOD; missing key
//     surfaces as an error event (the legacy handler returned HTTP 400).
//   • POST prompt to `${baseUrl}/run`; unwrap/rewrap payload to
//     `{input: {workflow}}` shape expected by RunPod.
//   • Poll `${baseUrl}/status/${jobId}` every 500ms until
//     `status.output.images[0]` is present.
//   • Return `{format, data}` where format is derived from
//     `path.extname(item.filename)`.
//   • On abort, fire-and-forget POST to `${baseUrl}/cancel/${jobId}`
//     with the same bearer key.
//
// Fixed vs legacy:
//   • signal:ctx.signal is now threaded through all fetch calls — the
//     legacy handler only wired abort to a custom cancel POST, not the
//     upstream fetches themselves.

import path from 'node:path';
import urlJoin from 'url-join';
import { delay, tryParse } from '../../../util.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdComfyRunPod(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('comfyui_runpod', body));

    const key = ctx.secrets.read(SECRET_KEYS.COMFY_RUNPOD);
    if (!key) {
        console.warn('RunPod key not found.');
        const err = new Error('RunPod key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    let jobId;
    let item;
    const baseUrl = body.url;
    const url = new URL(urlJoin(baseUrl, '/run'));

    // Wire abort → POST /cancel + inspection abort.
    const onAbort = () => {
        if (!item && jobId) {
            try {
                const cancelUrl = new URL(urlJoin(baseUrl, `/cancel/${jobId}`));
                ctx.fetch(cancelUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${key}` },
                }).catch(() => {});
            } catch { /* ignore */ }
            try { ctx.inspection.abort(); } catch { /* ignore */ }
        }
    };
    if (ctx.signal.aborted) {
        // pre-aborted; still let the flow error out normally via fetch.
    } else {
        ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        const workflow = JSON.parse(body.prompt).prompt;
        const wrappedWorkflow = workflow?.input?.workflow ? workflow : ({ input: { workflow: workflow } });
        const runpodPrompt = JSON.stringify(wrappedWorkflow);

        console.debug('ComfyUI RunPod request:', wrappedWorkflow);

        ctx.inspection.attach(url, key);
        const promptResult = await ctx.fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}` },
            body: runpodPrompt,
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        // Only the initial /run job-submit fetch emits head; the
        // /status poll and /cancel fire-and-forget are internal.
        ctx.emit.head({ status: promptResult.status, headers: promptResult.headers });

        if (!promptResult.ok) {
            const text = await promptResult.text().catch(() => '');
            const err = new Error('ComfyUI returned an error.');
            err.cause = tryParse(text);
            // Surface upstream status + body to the client via chunk + end
            // (head already emitted above). Client sees
            // Response.status=<upstream> and Response.body readable so
            // callers can do `await response.text()` or
            // `await response.json()` for structured error inspection.
            ctx.inspection.failImage(err, promptResult.status ?? 500);
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        /** @type {any} */
        const data = await promptResult.json();
        jobId = data.id;
        const statusUrl = new URL(urlJoin(baseUrl, `/status/${jobId}`));
        while (true) {
            if (ctx.signal.aborted) throw new Error('Aborted');
            const result = await ctx.fetch(statusUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${key}` },
                signal: ctx.signal,
            });
            if (!result.ok) {
                throw new Error('ComfyUI returned an error.');
            }
            /** @type {any} */
            const status = await result.json();
            if (status.output) {
                item = status.output.images[0];
            }
            if (item) break;
            await delay(500);
        }

        const format = path.extname(item.filename).slice(1).toLowerCase() || 'png';
        ctx.inspection.completeImage({ format });

        const payload = { format, data: item.data };
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(payload)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error('ComfyUI error:', error);
        ctx.emit.error(error);
    }
}
