// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Pollinations. Extracted from
// src/endpoints/stable-diffusion.js:1215-1263.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.POLLINATIONS; missing key surfaces
//     as an error event (the legacy handler returned HTTP 400).
//   • GET to https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}
//     with URL-encoded params (model / negative_prompt / seed /
//     width / height, plus optional enhance).
//   • Missing/negative seed randomised to [0, 10_000_000).
//   • Response body is the raw image; base64-encode and emit
//     `{image, format:<ext>}` JSON.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the fetch — the legacy handler
//     ignored aborts (Task 7 spec: fix long-standing zero-abort gap).

import mime from 'mime-types';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdPollinations(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('pollinations', body));

    const key = ctx.secrets.read(SECRET_KEYS.POLLINATIONS);
    if (!key) {
        console.warn('Pollinations API key not found.');
        const err = new Error('Pollinations API key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const promptUrl = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(body.prompt)}`);
        const params = new URLSearchParams({
            model: String(body.model),
            negative_prompt: String(body.negative_prompt),
            seed: String(body.seed >= 0 ? body.seed : Math.floor(Math.random() * 10_000_000)),
            width: String(body.width ?? 1024),
            height: String(body.height ?? 1024),
        });
        if (body.enhance) {
            params.set('enhance', String(true));
        }
        promptUrl.search = params.toString();

        console.info('Pollinations request URL:', promptUrl.toString());
        ctx.inspection.attach(promptUrl, key);

        const result = await ctx.fetch(promptUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${key}` },
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
            console.warn('Pollinations returned an error.', text);
            const err = new Error('Pollinations request failed.');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const contentType = result.headers.get('Content-Type')?.toString() || 'image/jpeg';
        const buffer = await result.arrayBuffer();
        const image = Buffer.from(buffer).toString('base64');
        const format = mime.extension(contentType) || 'jpg';

        ctx.inspection.completeImage({ format, sizeBytes: buffer.byteLength });
        const payload = { image, format };
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(payload)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
