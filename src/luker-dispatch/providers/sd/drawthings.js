// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for SD DrawThings. Extracted from
// src/endpoints/stable-diffusion.js:1150-1186.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Copy body, strip `url` and `auth` before serialising (they are
//     transport-level fields, not part of the upstream payload).
//   • POST to `${body.url}/sdapi/v1/txt2img` with Basic Auth from
//     body.auth.
//   • Response JSON forwarded as-is.
//
// Fixed vs legacy:
//   • signal:ctx.signal is now threaded through the upstream POST — the
//     legacy handler ignored aborts (Task 7 spec: fix long-standing
//     zero-abort gap).

import { getBasicAuthHeader } from '../../../util.js';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdDrawthings(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('drawthings', body));

    try {
        console.debug('SD DrawThings API request:', body);

        const url = new URL(body.url);
        url.pathname = '/sdapi/v1/txt2img';

        /** @type {any} */
        const upstream = { ...body };
        delete upstream.url;
        delete upstream.auth;
        const authHeader = getBasicAuthHeader(body.auth);

        ctx.inspection.attach(url, body.auth || '');
        const result = await ctx.fetch(url, {
            method: 'POST',
            body: JSON.stringify(upstream),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
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
            const err = new Error('SD DrawThings API returned an error.');
            err.cause = text;
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
