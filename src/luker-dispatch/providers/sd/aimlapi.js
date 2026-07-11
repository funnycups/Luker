// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for AI/ML API images. Extracted from
// src/endpoints/stable-diffusion.js:1593-1632.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.AIMLAPI; missing key surfaces as
//     an error event (the legacy handler returned HTTP 400).
//   • Forward request body verbatim to
//     https://api.aimlapi.com/v1/images/generations with AIMLAPI_HEADERS.
//   • Response may return `data.images[0]` OR `data.data[0]`. The image
//     object may contain any of: b64_json, base64, url. When only `url`
//     is present, fetch and base64-encode.
//   • Emit `{format:'png', data:<base64>}` as JSON.
//
// URL note:
//   • The client posts to `/api/sd/aimlapi/generate-image`, NOT `/generate`
//     like the other SD providers. The router mount and PROXY_PATTERNS
//     must reflect this asymmetry.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through both upstream POST and the
//     follow-up image fetch — the legacy handler ignored aborts.
//   • Inspection lifecycle (startImage/completeImage/failImage) was
//     absent in the legacy handler and is added here for consistency
//     with the other 11 orphan dispatches.

import { AIMLAPI_HEADERS } from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const API_URL = 'https://api.aimlapi.com/v1/images/generations';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdAimlapi(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.AIMLAPI);
    if (!key) {
        console.warn('AI/ML API key not found.');
        ctx.emit.error(new Error('AI/ML API key not found'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('aimlapi', body));

    try {
        console.debug('AI/ML API image request:', body);

        ctx.inspection.attach(API_URL, key);
        const apiRes = await ctx.fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                ...AIMLAPI_HEADERS,
            },
            body: JSON.stringify(body),
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: apiRes.status, headers: {} });

        if (!apiRes.ok) {
            const errText = await apiRes.text().catch(() => '');
            const err = new Error('AI/ML API returned an error');
            err.cause = errText;
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        /** @type {any} */
        const data = await apiRes.json();
        const imgObj = Array.isArray(data.images) ? data.images[0] : data.data?.[0];
        if (!imgObj) {
            const err = new Error('No image returned');
            ctx.inspection.failImage(err, 500);
            ctx.emit.error(err);
            return;
        }

        let base64;
        if (imgObj.b64_json || imgObj.base64) {
            base64 = imgObj.b64_json || imgObj.base64;
        } else if (imgObj.url) {
            const blobRes = await ctx.fetch(imgObj.url, { signal: ctx.signal });
            if (!blobRes.ok) throw new Error('Failed to fetch image URL');
            const buffer = await blobRes.arrayBuffer();
            base64 = Buffer.from(buffer).toString('base64');
        } else {
            throw new Error('Unsupported image format');
        }

        ctx.inspection.completeImage({ format: 'png', sizeBytes: Math.round(base64.length * 0.75) });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ format: 'png', data: base64 })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
