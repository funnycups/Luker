// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for stable-diffusion.cpp. Extracted from
// src/endpoints/stable-diffusion.js:714-766.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • POST to `${body.url}/sdapi/v1/txt2img` with a shaped payload.
//   • clip_skip=1 (the default) is omitted from the payload: sd.cpp
//     produces blank images at clip_skip=1.
//   • Empty / undefined / null fields are stripped before serialising.
//   • Response JSON forwarded as-is.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import urlJoin from 'url-join';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdCpp(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('sd_cpp', body));

    try {
        const url = new URL(urlJoin(body.url, '/sdapi/v1/txt2img'));

        const payload = {
            model: body.model,
            prompt: body.prompt,
            negative_prompt: body.negative_prompt,
            width: body.width,
            height: body.height,
            steps: body.steps,
            cfg_scale: body.cfg_scale,
            seed: body.seed,
            batch_size: body.batch_size,
            sampler_name: body.sampler_name,
            scheduler: body.scheduler,
            clip_skip: body.clip_skip > 1 ? body.clip_skip : undefined,
        };

        for (const [key, value] of Object.entries(payload)) {
            if (value === undefined || value === null || value === '') {
                delete payload[key];
            }
        }

        console.debug('stable-diffusion.cpp request:', payload);

        ctx.inspection.attach(url, '');
        const result = await ctx.fetch(url, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
            },
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            const err = new Error('stable-diffusion.cpp server returned an error.');
            err.cause = text;
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const data = await result.json();
        ctx.inspection.completeImage();

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(data)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
