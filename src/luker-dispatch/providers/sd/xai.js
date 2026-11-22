// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
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
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import {
    buildMultipartImageEditsPayload,
    normalizeImagesBaseUrl,
    resolveSdSecret,
} from './sd-auth.js';

const DEFAULT_XAI_BASE = 'https://api.x.ai/v1';

function detectBase64MimeType(raw) {
    if (raw.startsWith('iVBORw0KGgo')) return 'image/png';
    if (raw.startsWith('UklGR')) return 'image/webp';
    return 'image/jpeg';
}

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdXai(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('xai', body));

    let key;
    try {
        key = resolveSdSecret(ctx, [SECRET_KEYS.XAI]);
    } catch (err) {
        console.warn('xAI key not found.');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const loadedRefs = await loadReferenceInputs(ctx.user?.directories, body.references);
        const baseUrl = normalizeImagesBaseUrl(body.api_url, DEFAULT_XAI_BASE);

        let targetUrl;
        let fetchOptions;

        if (loadedRefs.length > 0) {
            targetUrl = `${baseUrl}/images/edits`;
            const multipart = buildMultipartImageEditsPayload({
                fields: {
                    prompt: body.prompt,
                    model: body.model,
                    aspect_ratio: body.aspect_ratio,
                    resolution: body.resolution,
                    response_format: 'b64_json',
                },
                loadedRefs,
            });
            fetchOptions = {
                method: 'POST',
                body: multipart.body,
                headers: {
                    ...multipart.headers,
                    'Authorization': `Bearer ${key}`,
                },
                signal: ctx.signal,
            };
        } else {
            targetUrl = `${baseUrl}/images/generations`;
            const requestBody = {
                prompt: body.prompt,
                model: body.model,
                aspect_ratio: body.aspect_ratio,
                resolution: body.resolution,
                response_format: 'b64_json',
            };
            console.debug('xAI request:', requestBody);
            fetchOptions = {
                method: 'POST',
                body: JSON.stringify(requestBody),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                signal: ctx.signal,
            };
        }

        ctx.inspection.attach(targetUrl, key);
        const result = await ctx.fetch(targetUrl, fetchOptions);

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
        const image = dataUrlMatch?.[2] || encodedImage;
        const mimeType = dataUrlMatch?.[1] || detectBase64MimeType(image);
        const format = mime.extension(mimeType) || 'jpg';

        ctx.inspection.completeImage({ format, data: image });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ image, format })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error('Error communicating with xAI', error);
        ctx.emit.error(error);
    }
}
