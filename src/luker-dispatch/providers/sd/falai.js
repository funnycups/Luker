// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for fal.ai. Extracted from
// src/endpoints/stable-diffusion.js:1388-1486.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.FALAI; missing key surfaces as an
//     error event (the legacy handler returned HTTP 400).
//   • POST task to `https://queue.fal.run/fal-ai/${body.model}` with
//     the `Key ${key}` scheme (fal.ai uses this instead of Bearer),
//     enable_safety_checker=false, safety_tolerance=6.
//   • Poll `status_url` every 2500ms up to MAX_ATTEMPTS=100:
//       IN_QUEUE / IN_PROGRESS → continue
//       COMPLETED              → fetch response_url; if resultData.detail
//                                is set throw its first entry; otherwise
//                                fetch images[0].url with the same key
//                                and emit `{image:<b64>}`.
//       other                  → throw with statusData as cause.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through all fetch calls — the legacy
//     handler ignored aborts.

import { delay } from '../../../util.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const POLL_INTERVAL_MS = 2500;
const MAX_ATTEMPTS = 100;

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdFalai(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.FALAI);
    if (!key) {
        console.warn('FAL.AI key not found.');
        ctx.emit.error(new Error('FAL.AI key not found'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('falai', body));

    try {
        const requestBody = {
            prompt: body.prompt,
            image_size: { width: body.width, height: body.height },
            num_inference_steps: body.steps,
            seed: body.seed ?? null,
            guidance_scale: body.guidance,
            enable_safety_checker: false,
            safety_tolerance: 6,
        };

        console.debug('FAL.AI request:', requestBody);

        const falaiUrl = `https://queue.fal.run/fal-ai/${body.model}`;
        ctx.inspection.attach(falaiUrl, key);
        const result = await ctx.fetch(falaiUrl, {
            method: 'POST',
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${key}`,
            },
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        // Only the initial queue-submit fetch emits head; the status
        // poll, response-URL fetch, and CDN image-download below are
        // internal.
        ctx.emit.head({ status: result.status, headers: {} });

        if (!result.ok) {
            console.warn('FAL.AI returned an error.');
            const err = new Error('FAL.AI returned an error');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        /** @type {any} */
        const taskData = await result.json();
        const { status_url } = taskData;

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            if (ctx.signal.aborted) throw new Error('Aborted');
            await delay(POLL_INTERVAL_MS);

            const statusResult = await ctx.fetch(status_url, {
                headers: { 'Authorization': `Key ${key}` },
                signal: ctx.signal,
            });

            if (!statusResult.ok) {
                const text = await statusResult.text().catch(() => '');
                console.warn('FAL.AI returned an error.', text);
                const err = new Error('FAL.AI returned an error');
                ctx.inspection.failImage(err, 500);
                ctx.emit.error(err);
                return;
            }

            /** @type {any} */
            const statusData = await statusResult.json();

            if (statusData?.status === 'IN_QUEUE' || statusData?.status === 'IN_PROGRESS') continue;

            if (statusData?.status === 'COMPLETED') {
                const resultFetch = await ctx.fetch(statusData?.response_url, {
                    method: 'GET',
                    headers: { 'Authorization': `Key ${key}` },
                    signal: ctx.signal,
                });
                /** @type {any} */
                const resultData = await resultFetch.json();

                if (resultData.detail !== null && resultData.detail !== undefined) {
                    throw new Error('FAL.AI failed to generate image.', {
                        cause: `${resultData.detail[0].loc[1]}: ${resultData.detail[0].msg}`,
                    });
                }

                const imageFetch = await ctx.fetch(resultData?.images[0].url, {
                    headers: { 'Authorization': `Key ${key}` },
                    signal: ctx.signal,
                });

                const fetchData = await imageFetch.arrayBuffer();
                const image = Buffer.from(fetchData).toString('base64');
                ctx.inspection.completeImage({ sizeBytes: fetchData.byteLength });

                const encoder = new TextEncoder();
                ctx.emit.chunk(encoder.encode(JSON.stringify({ image })));
                ctx.emit.end();
                return;
            }

            throw new Error('FAL.AI failed to generate image.', { cause: statusData });
        }
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
