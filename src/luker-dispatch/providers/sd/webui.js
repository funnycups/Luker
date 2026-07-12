// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for SD WebUI (auto1111 / forge). Extracted from
// src/endpoints/stable-diffusion.js:300-357.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response or the request socket.
//
// Preserved from the legacy handler:
//   • Pre-flight probe to `${url}/sdapi/v1/options` to detect Forge; when
//     the response does NOT contain `forge_preset`, strip
//     override_settings.forge_additional_modules from the outgoing body
//     (mirrors the auto1111 vs Forge branching).
//   • POST to `${url}/sdapi/v1/txt2img` with Basic Auth from `body.auth`.
//   • On abort, fire-and-forget POST to `${url}/sdapi/v1/interrupt`
//     (replaces the legacy `request.socket.removeAllListeners('close')`
//     socket poking — dispatch layer uses ctx.signal instead).

import _ from 'lodash';
import { getBasicAuthHeader } from '../../../util.js';
import { extractImageMeta } from '../../../request-inspector.js';

async function tryDetectForge(ctx, baseUrl, authHeader) {
    try {
        const optionsUrl = new URL(baseUrl);
        optionsUrl.pathname = '/sdapi/v1/options';
        const optionsResult = await ctx.fetch(optionsUrl, {
            headers: { 'Authorization': authHeader },
        });
        if (optionsResult.ok) {
            /** @type {any} */
            const optionsData = await optionsResult.json();
            return 'forge_preset' in optionsData;
        }
    } catch (error) {
        console.error('SD WebUI failed to get options:', error);
    }
    return null;
}

function fireInterrupt(ctx, baseUrl, authHeader) {
    try {
        const interruptUrl = new URL(baseUrl);
        interruptUrl.pathname = '/sdapi/v1/interrupt';
        ctx.fetch(interruptUrl, {
            method: 'POST',
            headers: { 'Authorization': authHeader },
        }).catch(() => { /* fire-and-forget */ });
    } catch { /* invalid URL — silently skip */ }
}

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdWebui(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('sd_webui', body));

    const authHeader = getBasicAuthHeader(body.auth);

    try {
        // Forge probe — copy body so we don't mutate the caller's version
        // (legacy handler mutates ctx.body directly; dispatch clones).
        /** @type {any} */
        const outgoing = { ...body };
        const isForge = await tryDetectForge(ctx, body.url, authHeader);
        if (isForge === false) {
            // Deep-clone override_settings before unsetting to preserve
            // the caller's structure.
            if (outgoing.override_settings) {
                outgoing.override_settings = { ...outgoing.override_settings };
                _.unset(outgoing, 'override_settings.forge_additional_modules');
            }
        }

        // Wire abort → /interrupt (dispatch replacement for the legacy
        // request.socket.on('close') hook).
        const onAbort = () => fireInterrupt(ctx, body.url, authHeader);
        if (ctx.signal.aborted) {
            onAbort();
        } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }

        const txt2imgUrl = new URL(body.url);
        txt2imgUrl.pathname = '/sdapi/v1/txt2img';
        ctx.inspection.attach(txt2imgUrl, body.auth || '');

        console.debug('SD WebUI request:', outgoing);
        const result = await ctx.fetch(txt2imgUrl, {
            method: 'POST',
            body: JSON.stringify(outgoing),
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
        // Only the main txt2img fetch emits head; the Forge-detect
        // options probe and the fire-and-forget /interrupt call are
        // internal.
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            const err = new Error('SD WebUI returned an error.');
            err.cause = text;
            ctx.inspection.failImage(err, result.status ?? 500);
            // Surface upstream status + body to the client via chunk + end
            // (head already emitted above). Client sees Response.body
            // readable so callers can inspect the upstream error payload.
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
