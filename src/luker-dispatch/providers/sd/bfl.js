// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Black Forest Labs (Flux). Extracted from
// src/endpoints/stable-diffusion.js:1221-1336.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response.
//
// Preserved from the legacy handler:
//   • Read API key from SECRET_KEYS.BFL; missing key surfaces as an
//     error event (the legacy handler returned HTTP 400).
//   • POST task to `https://api.bfl.ml/v1/${body.model}` with the
//     x-key header, safety_tolerance=6, output_format=jpeg.
//   • Model-name suffix rewrites the payload:
//       -ultra    → drops steps/guidance/width/height/prompt_upsampling,
//                   adds aspect_ratio computed from width/height
//                   (clamped to the [9/21, 21/9] range).
//       -pro-1.1  → drops steps/guidance only.
//   • Poll `https://api.bfl.ml/v1/get_result?id=${id}` every 2500ms
//     for up to MAX_ATTEMPTS=100 attempts.
//     status='Pending' → continue; status='Ready' → fetch sample URL
//     and emit `{image:<b64>}`; any other status throws.
//
// Fixed vs legacy:
//   • signal:ctx.signal threaded through all fetch calls — the legacy
//     handler ignored aborts.

import { delay } from '../../../util.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { extractImageMeta } from '../../../request-inspector.js';

const POLL_INTERVAL_MS = 2500;
const MAX_ATTEMPTS = 100;

function getClosestAspectRatio(width, height) {
    const minAspect = 9 / 21;
    const maxAspect = 21 / 9;
    const currentAspect = width / height;

    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const simplifyRatio = (w, h) => {
        const divisor = gcd(w, h);
        return `${w / divisor}:${h / divisor}`;
    };

    if (currentAspect < minAspect) {
        const adjustedHeight = Math.round(width / minAspect);
        return simplifyRatio(width, adjustedHeight);
    } else if (currentAspect > maxAspect) {
        const adjustedWidth = Math.round(height * maxAspect);
        return simplifyRatio(adjustedWidth, height);
    } else {
        return simplifyRatio(width, height);
    }
}

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdBfl(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('bfl', body));

    const key = ctx.secrets.read(SECRET_KEYS.BFL);
    if (!key) {
        console.warn('BFL key not found.');
        const err = new Error('BFL key not found');
        ctx.inspection.failImage(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const requestBody = {
            prompt: body.prompt,
            steps: body.steps,
            guidance: body.guidance,
            width: body.width,
            height: body.height,
            prompt_upsampling: body.prompt_upsampling,
            seed: body.seed ?? null,
            safety_tolerance: 6,
            output_format: 'jpeg',
        };

        if (String(body.model).endsWith('-ultra')) {
            requestBody.aspect_ratio = getClosestAspectRatio(body.width, body.height);
            delete requestBody.steps;
            delete requestBody.guidance;
            delete requestBody.width;
            delete requestBody.height;
            delete requestBody.prompt_upsampling;
        }

        if (String(body.model).endsWith('-pro-1.1')) {
            delete requestBody.steps;
            delete requestBody.guidance;
        }

        console.debug('BFL request:', requestBody);

        const bflUrl = `https://api.bfl.ml/v1/${body.model}`;
        ctx.inspection.attach(bflUrl, key);
        const result = await ctx.fetch(bflUrl, {
            method: 'POST',
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'x-key': key,
            },
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        // Only the initial task-submit fetch emits head; the subsequent
        // status-poll and image-download fetches are internal.
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            console.warn('BFL returned an error.', text);
            const err = new Error('BFL returned an error');
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end.
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        /** @type {any} */
        const taskData = await result.json();
        const { id } = taskData;

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            if (ctx.signal.aborted) throw new Error('Aborted');
            await delay(POLL_INTERVAL_MS);

            const statusResult = await ctx.fetch(`https://api.bfl.ml/v1/get_result?id=${id}`, {
                signal: ctx.signal,
            });

            if (!statusResult.ok) {
                const text = await statusResult.text().catch(() => '');
                console.warn('BFL returned an error.', text);
                const err = new Error('BFL returned an error');
                ctx.inspection.failImage(err, 500);
                ctx.emit.error(err);
                return;
            }

            /** @type {any} */
            const statusData = await statusResult.json();

            if (statusData?.status === 'Pending') continue;

            if (statusData?.status === 'Ready') {
                const { sample } = statusData.result;
                const fetchResult = await ctx.fetch(sample, { signal: ctx.signal });
                const fetchData = await fetchResult.arrayBuffer();
                const image = Buffer.from(fetchData).toString('base64');
                ctx.inspection.completeImage({ format: 'jpeg', sizeBytes: fetchData.byteLength });

                const encoder = new TextEncoder();
                ctx.emit.chunk(encoder.encode(JSON.stringify({ image })));
                ctx.emit.end();
                return;
            }

            throw new Error('BFL failed to generate image.', { cause: statusData });
        }
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error(error);
        ctx.emit.error(error);
    }
}
