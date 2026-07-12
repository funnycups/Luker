// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for xAI images (Grok image generation). Extracted from
// src/endpoints/stable-diffusion.js:1490-1548.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.XAI; missing key surfaces as an
//     error event (the legacy handler returned HTTP 400).
//   • POST to https://api.x.ai/v1/images/generations with
//     `{prompt, model, aspect_ratio, resolution, response_format:'b64_json'}`.
//   • Response has `data[0].b64_json`; the value may either be a raw
//     base64 buffer (always JPEG) OR a data URL. Parse the data URL
//     with mime.extension() to derive `format`; otherwise fall back to
//     'jpg'. Emit `{image, format}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import mime from 'mime-types';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://api.x.ai/v1/images/generations';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdXai(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('xai', body));

    const key = ctx.secrets.read(SECRET_KEYS.XAI);
    if (!key) {
        console.warn('xAI key not found.');
        const err = new Error('xAI key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const requestBody = {
            prompt: body.prompt,
            model: body.model,
            aspect_ratio: body.aspect_ratio,
            resolution: body.resolution,
            response_format: 'b64_json',
        };

        console.debug('xAI request:', requestBody);

        ctx.inspection.attach(API_URL, key);
        const result = await ctx.fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
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
            console.warn('xAI returned an error.', text);
            const err = new Error('xAI returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        /** @type {any} */
        const data = await result.json();
        const encodedImage = String(data?.data?.[0]?.b64_json || '');
        if (!encodedImage) {
            console.warn('xAI returned invalid data.');
            const err = new Error('xAI returned invalid data');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        const dataUrlMatch = encodedImage.match(/^data:(.+);base64,(.+)$/);
        const mimeType = dataUrlMatch?.[1] || 'image/jpeg';
        const format = mime.extension(mimeType) || 'jpg';
        const image = dataUrlMatch?.[2] || encodedImage;

        ctx.inspection.completeImage({ sizeBytes: Math.round(image.length * 0.75) });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ image, format })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error('Error communicating with xAI', error);
        ctx.emit.error(error);
    }
}
