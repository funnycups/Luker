// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Electron Hub images. Extracted from
// src/endpoints/stable-diffusion.js:958-1018.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.ELECTRONHUB; missing key surfaces
//     as an error event (the legacy handler returned HTTP 400).
//   • POST to https://api.electronhub.ai/v1/images/generations with
//     `{model, prompt, response_format:'b64_json', size?, quality?}`.
//   • Response has `data[0].b64_json`; emit `{image}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://api.electronhub.ai/v1/images/generations';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdElectronHub(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('electronhub', body));

    const key = ctx.secrets.read(SECRET_KEYS.ELECTRONHUB);
    if (!key) {
        console.warn('Electron Hub key not found.');
        const err = new Error('Electron Hub key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const bodyParams = {
            model: body.model,
            prompt: body.prompt,
            response_format: 'b64_json',
        };
        if (body.size) bodyParams.size = body.size;
        if (body.quality) bodyParams.quality = body.quality;

        console.debug('Electron Hub request:', bodyParams);

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
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const errorText = await result.text().catch(() => '');
            console.warn('Electron Hub returned an error.', result.status, result.statusText, errorText);
            const err = new Error('Electron Hub returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (errorText) {
                ctx.emit.chunk(new TextEncoder().encode(errorText));
            }
            ctx.emit.end();
            return;
        }

        /** @type {any} */
        const data = await result.json();
        const image = data?.data?.[0]?.b64_json;
        if (!image) {
            console.warn('Electron Hub returned invalid data.');
            const err = new Error('Electron Hub returned invalid data');
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
