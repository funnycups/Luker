// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Stability AI. Extracted from
// src/endpoints/stable-diffusion.js:1267-1327.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.STABILITY; missing key surfaces as
//     an error event (the legacy handler returned HTTP 400).
//   • body shape is `{payload, model}`; payload keys are FormData
//     serialised, filtering out undefined values (matches String(value)
//     of the legacy handler).
//   • Model → API URL branching:
//       stable-image-ultra  → v2beta/stable-image/generate/ultra
//       stable-image-core   → v2beta/stable-image/generate/core
//       stable-diffusion-3  → v2beta/stable-image/generate/sd3
//     unknown model → throw.
//   • Response body is the raw image; base64-encode and emit the
//     resulting STRING as a UTF-8 chunk. This preserves the wire shape
//     of the legacy `response.send(Buffer.from(buffer).toString('base64'))`
//     (client-side reads via `response.text()`, not `.json()`).
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts (Task 7 spec: fix long-standing zero-abort gap).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

function resolveStabilityUrl(model) {
    switch (model) {
        case 'stable-image-ultra':
            return 'https://api.stability.ai/v2beta/stable-image/generate/ultra';
        case 'stable-image-core':
            return 'https://api.stability.ai/v2beta/stable-image/generate/core';
        case 'stable-diffusion-3':
            return 'https://api.stability.ai/v2beta/stable-image/generate/sd3';
        default:
            throw new Error('Invalid Stability AI model selected');
    }
}

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdStability(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('stability', body));

    const key = ctx.secrets.read(SECRET_KEYS.STABILITY);
    if (!key) {
        console.warn('Stability AI key not found.');
        const err = new Error('Stability AI key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const { payload, model } = body;
        console.debug('Stability AI request:', model, payload);

        const formData = new FormData();
        for (const [k, v] of Object.entries(payload || {})) {
            if (v !== undefined) {
                formData.append(k, String(v));
            }
        }

        const apiUrl = resolveStabilityUrl(model);

        ctx.inspection.attach(apiUrl, key);
        const result = await ctx.fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'image/*',
            },
            body: formData,
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
            console.warn('Stability AI returned an error.', result.status, result.statusText, text);
            const err = new Error('Stability AI returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            // Note: successful responses are raw base64 (not JSON), but
            // Stability error responses are JSON — this branch handles the
            // error case only, so JSON pass-through is correct here.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const buffer = await result.arrayBuffer();
        ctx.inspection.completeImage({ sizeBytes: buffer.byteLength });

        // Wire shape: raw base64 STRING (not JSON). Client reads via
        // response.text(). Emit the base64 string as UTF-8 bytes so the
        // downstream event bus preserves it verbatim.
        const b64 = Buffer.from(buffer).toString('base64');
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(b64));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
