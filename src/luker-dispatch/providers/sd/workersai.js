// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Cloudflare Workers AI. Extracted from
// src/endpoints/stable-diffusion.js:1870-1959.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.WORKERS_AI; missing key → error.
//   • body.account_id and body.model are required (legacy handler
//     returned HTTP 400 for either); we emit an error instead.
//   • POST to
//     `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`.
//   • Shape params: prompt / negative_prompt / width / height /
//     num_steps / guidance / seed — dropping undefined entries.
//   • flux-2 models require multipart/form-data; other models get
//     JSON with Content-Type: application/json.
//   • Response can be either JSON `{result.image}` OR raw binary; both
//     paths emit `{format:'png', image:<base64>}`.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through the upstream POST — the legacy
//     handler ignored aborts.
//   • Inspection lifecycle added (legacy handler didn't call inspection
//     helpers).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdWorkersai(ctx) {
    const body = ctx.body || {};

    const key = ctx.secrets.read(SECRET_KEYS.WORKERS_AI);
    if (!key) {
        console.warn('Cloudflare Workers AI API key not found.');
        ctx.emit.error(new Error('Cloudflare Workers AI API key not found'));
        return;
    }

    const accountId = String(body.account_id || '').trim();
    if (!accountId) {
        console.warn('Cloudflare Workers AI Account ID not found.');
        ctx.emit.error(new Error('Cloudflare Workers AI Account ID not found'));
        return;
    }

    const model = String(body.model || '').trim();
    if (!model) {
        console.warn('Cloudflare Workers AI model not specified.');
        ctx.emit.error(new Error('Cloudflare Workers AI model not specified'));
        return;
    }

    ctx.inspection.startImage(extractImageMeta('workersai', body));

    try {
        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;

        const payload = {
            prompt: body.prompt,
            negative_prompt: body.negative_prompt || undefined,
            width: body.width ? Number(body.width) : undefined,
            height: body.height ? Number(body.height) : undefined,
            num_steps: body.steps ? Number(body.steps) : undefined,
            guidance: body.scale ? Number(body.scale) : undefined,
            seed: body.seed >= 0 ? Number(body.seed) : undefined,
        };

        for (const prop of Object.keys(payload)) {
            if (payload[prop] === undefined) delete payload[prop];
        }

        console.debug('Cloudflare Workers AI request:', model, payload);

        const apiRequest = {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}` },
            signal: ctx.signal,
        };

        if (/flux-2/.test(model)) {
            const formData = new FormData();
            for (const [k, v] of Object.entries(payload)) {
                formData.append(k, String(v));
            }
            apiRequest.body = formData;
        } else {
            apiRequest.headers = { ...apiRequest.headers, 'Content-Type': 'application/json' };
            apiRequest.body = JSON.stringify(payload);
        }

        ctx.inspection.attach(apiUrl, key);
        const result = await ctx.fetch(apiUrl, apiRequest);

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: result.status, headers: {} });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            console.warn('Cloudflare Workers AI returned an error.', result.status, result.statusText, text);
            const err = new Error('Cloudflare Workers AI returned an error');
            err.cause = text;
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const contentType = result.headers.get('content-type') || '';

        // Partner models return JSON with base64 image
        if (contentType.includes('application/json')) {
            /** @type {any} */
            const data = await result.json();
            const image = data?.result?.image || data?.image;
            if (!image) {
                console.warn('Cloudflare Workers AI returned JSON without image data.');
                const err = new Error('Cloudflare Workers AI returned JSON without image data');
                ctx.inspection.failImage(err, 500);
                ctx.emit.error(err);
                return;
            }
            ctx.inspection.completeImage({ format: 'png', sizeBytes: Math.round(image.length * 0.75) });
            const encoder = new TextEncoder();
            ctx.emit.chunk(encoder.encode(JSON.stringify({ format: 'png', image })));
            ctx.emit.end();
            return;
        }

        // Non-partner models return raw binary image data
        const buffer = await result.arrayBuffer();
        const image = Buffer.from(buffer).toString('base64');
        ctx.inspection.completeImage({ format: 'png', sizeBytes: buffer.byteLength });

        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify({ format: 'png', image })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
