// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for HuggingFace Inference API images. Extracted from
// src/endpoints/stable-diffusion.js:874-914.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.HUGGINGFACE; missing key surfaces
//     as an error event (the legacy handler returned HTTP 400).
//   • POST to `https://api-inference.huggingface.co/models/${body.model}`
//     with `{inputs: body.prompt}`.
//   • Response body is raw image bytes; base64-encode and emit
//     `{image: <base64>}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdHuggingface(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.HUGGINGFACE);
    if (!key) {
        console.warn('Hugging Face key not found.');
        ctx.emit.error(new Error('Hugging Face key not found'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('huggingface', body));

    try {
        console.debug('Hugging Face request:', body);

        const huggingFaceUrl = `https://api-inference.huggingface.co/models/${body.model}`;
        ctx.inspection.attach(huggingFaceUrl, key);

        const result = await ctx.fetch(huggingFaceUrl, {
            method: 'POST',
            body: JSON.stringify({ inputs: body.prompt }),
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
        ctx.emit.head({ status: result.status, headers: {} });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            console.warn('Hugging Face returned an error.', text);
            const err = new Error('Hugging Face returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const buffer = await result.arrayBuffer();
        ctx.inspection.completeImage({ sizeBytes: buffer.byteLength });

        const payload = { image: Buffer.from(buffer).toString('base64') };
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(payload)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
