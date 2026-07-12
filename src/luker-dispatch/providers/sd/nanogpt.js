// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for NanoGPT images. Extracted from
// src/endpoints/stable-diffusion.js:1173-1217.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.NANOGPT; missing key surfaces as
//     an error event (the legacy handler returned HTTP 400).
//   • Forward the entire request body verbatim to
//     https://nano-gpt.com/api/generate-image, keyed via `x-api-key`.
//   • Response has `data[0].b64_json`; emit `{image}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://nano-gpt.com/api/generate-image';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdNanoGpt(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('nanogpt', body));

    const key = ctx.secrets.read(SECRET_KEYS.NANOGPT);
    if (!key) {
        console.warn('NanoGPT key not found.');
        const err = new Error('NanoGPT key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        console.debug('NanoGPT request:', body);

        ctx.inspection.attach(API_URL, key);
        const result = await ctx.fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
                'x-api-key': key,
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
            console.warn('NanoGPT returned an error.', text);
            const err = new Error('NanoGPT returned an error');
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
        const image = data?.data?.[0]?.b64_json;
        if (!image) {
            console.warn('NanoGPT returned invalid data.');
            const err = new Error('NanoGPT returned invalid data');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        ctx.inspection.completeImage({ sizeBytes: Math.round(image.length * 0.75) });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ image })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
