// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Chutes images. Extracted from
// src/endpoints/stable-diffusion.js:1081-1130.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.CHUTES; missing key surfaces as an
//     error event (the legacy handler returned HTTP 400).
//   • POST to https://image.chutes.ai/generate with defaulted params
//     (guidance_scale=7, width=1024, height=1024, num_inference_steps=10).
//   • Response body is raw image bytes; emit `{image: <base64>}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://image.chutes.ai/generate';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdChutes(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.CHUTES);
    if (!key) {
        console.warn('Chutes key not found.');
        ctx.emit.error(new Error('Chutes key not found'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('chutes', body));

    try {
        const bodyParams = {
            model: body.model,
            prompt: body.prompt,
            negative_prompt: body.negative_prompt,
            guidance_scale: body.guidance_scale || 7.0,
            width: body.width || 1024,
            height: body.height || 1024,
            num_inference_steps: body.steps || 10,
        };

        console.debug('Chutes request:', bodyParams);

        ctx.inspection.attach(API_URL, key);
        const result = await ctx.fetch(API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(bodyParams),
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: result.status, headers: {} });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            console.warn('Chutes returned an error:', text);
            const err = new Error('Chutes returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const buffer = await result.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');

        ctx.inspection.completeImage({ sizeBytes: buffer.byteLength });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ image: base64 })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
