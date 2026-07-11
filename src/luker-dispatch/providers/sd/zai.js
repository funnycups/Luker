// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Z.AI images. Extracted from
// src/endpoints/stable-diffusion.js:1636-1717.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.ZAI; missing key surfaces as an
//     error event (the legacy handler returned HTTP 400).
//   • POST to https://api.z.ai/api/paas/v4/images/generations with
//     `{prompt, model, quality, size}`.
//   • Response has `data[0].url`. The URL is validated with
//     `isValidUrl()` and its hostname MUST end with `.z.ai` OR
//     `.ufileos.com` — otherwise the response is rejected. This is the
//     Z.AI hostname whitelist and is a security guard, not a bug.
//   • Image is not always immediately available. The legacy handler
//     retries with a 1s delay up to 5 times on HTTP 404 before giving up.
//   • Derive format from URL pathname extension; default to 'png'.
//     Emit `{image, format}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through all fetch calls — the legacy
//     handler ignored aborts.
//   • Inspection lifecycle added for consistency with other dispatches
//     (the legacy handler didn't call inspection helpers).
//   • Legacy code had a duplicate no-op `imageResponse` fetch outside
//     the retry loop; retained the retry-loop-only fetch for the same
//     wire behaviour without the redundant call.

import path from 'node:path';
import { delay, isValidUrl } from '../../../util.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://api.z.ai/api/paas/v4/images/generations';
const IMAGE_FETCH_MAX_ATTEMPTS = 5;
const IMAGE_FETCH_RETRY_MS = 1000;

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdZai(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.ZAI);
    if (!key) {
        console.warn('Z.AI key not found.');
        ctx.emit.error(new Error('Z.AI key not found'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('zai', body));

    try {
        console.debug('Z.AI image request:', body);

        ctx.inspection.attach(API_URL, key);
        const generateResponse = await ctx.fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                prompt: body.prompt,
                model: body.model,
                quality: body.quality,
                size: body.size,
            }),
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        // Only the initial generate fetch emits head; the CDN
        // image-download retries below are internal.
        ctx.emit.head({ status: generateResponse.status, headers: {} });

        if (!generateResponse.ok) {
            const text = await generateResponse.text().catch(() => '');
            console.warn('Z.AI returned an error.', text);
            const err = new Error('Z.AI returned an error');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        /** @type {any} */
        const data = await generateResponse.json();
        console.debug('Z.AI image response:', data);

        const urlString = String(data?.data?.[0]?.url ?? '');
        if (!urlString || !isValidUrl(urlString)) {
            console.warn('Z.AI returned an invalid image URL.');
            const err = new Error('Z.AI returned an invalid image URL');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        const url = new URL(urlString);
        if (!url.hostname.endsWith('.z.ai') && !url.hostname.endsWith('.ufileos.com')) {
            console.warn('Z.AI returned a URL with an unrecognized hostname.');
            const err = new Error('Z.AI returned a URL with an unrecognized hostname');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        for (let attempt = 0; attempt < IMAGE_FETCH_MAX_ATTEMPTS; attempt++) {
            if (ctx.signal.aborted) throw new Error('Aborted');
            const imageResponse = await ctx.fetch(url, { signal: ctx.signal });
            if (!imageResponse.ok) {
                if (imageResponse.status === 404) {
                    console.info('Z.AI image not found yet, retrying...', { attempt: attempt + 1 });
                    await delay(IMAGE_FETCH_RETRY_MS);
                    continue;
                }
                console.warn('Z.AI image fetch returned an error. Status:', imageResponse.status, imageResponse.statusText);
                const err = new Error('Z.AI image fetch returned an error');
                ctx.inspection.failImage(err, 500);
                ctx.emit.error(err);
                return;
            }

            const buffer = await imageResponse.arrayBuffer();
            const image = Buffer.from(buffer).toString('base64');
            const format = path.extname(url.pathname).substring(1).toLowerCase() || 'png';

            ctx.inspection.completeImage({ format, sizeBytes: buffer.byteLength });
            const encoder = new TextEncoder();
            ctx.emit.chunk(encoder.encode(JSON.stringify({ image, format })));
            ctx.emit.end();
            return;
        }

        console.warn('Z.AI image was not available after multiple attempts.');
        const err = new Error('Z.AI image was not available after multiple attempts');
        ctx.inspection.failImage(err, 500);
        ctx.emit.error(err);
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
