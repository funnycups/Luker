// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for TogetherAI images. Extracted from
// src/endpoints/stable-diffusion.js:943-999.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read Together API key from SECRET_KEYS.TOGETHERAI; missing key
//     surfaces as an error event (the legacy handler returned HTTP 400).
//   • POST to https://api.together.xyz/v1/images/generations with a
//     shaped payload (prompt / negative_prompt / height / width / model /
//     steps / seed / n=1). Missing/negative seed is randomised to
//     [0, 10_000_000).
//   • Response is `{data:[{b64_json?, url?}]}`; if only `url` is present
//     we fetch it and base64-encode the bytes.
//   • Emit `{format:'jpg', data:<base64>}` as JSON.
//
// Fixed vs legacy:
//   • signal:ctx.signal is now threaded through both the main POST and
//     the follow-up image fetch — the legacy handler ignored aborts on
//     both (Task 7 spec: fix long-standing zero-abort gap).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const IMAGES_URL = 'https://api.together.xyz/v1/images/generations';

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdTogether(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('together', body));

    const key = ctx.secrets.read(SECRET_KEYS.TOGETHERAI);
    if (!key) {
        console.warn('TogetherAI key not found.');
        const err = new Error('TogetherAI key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        console.debug('TogetherAI request:', body);
        ctx.inspection.attach(IMAGES_URL, key);

        const seed = body.seed >= 0 ? body.seed : Math.floor(Math.random() * 10_000_000);
        const result = await ctx.fetch(IMAGES_URL, {
            method: 'POST',
            body: JSON.stringify({
                prompt: body.prompt,
                negative_prompt: body.negative_prompt,
                height: body.height,
                width: body.width,
                model: body.model,
                steps: body.steps,
                n: 1,
                seed,
            }),
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
        // Only the initial images-generation fetch emits head; the
        // fallback URL-download fetch below is internal.
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            console.warn('TogetherAI returned an error.', { body: text });
            const err = new Error('TogetherAI returned an error');
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
        console.debug('TogetherAI response:', data);

        const choice = data?.data?.[0];
        let b64_json = choice?.b64_json;

        if (!b64_json) {
            if (!choice?.url) {
                throw new Error('TogetherAI response missing b64_json and url');
            }
            const imgResp = await ctx.fetch(choice.url, { signal: ctx.signal });
            const buffer = await imgResp.arrayBuffer();
            b64_json = Buffer.from(buffer).toString('base64');
        }

        ctx.inspection.completeImage({ format: 'jpg', sizeBytes: Math.round(b64_json.length * 0.75) });
        const payload = { format: 'jpg', data: b64_json };
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(payload)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
