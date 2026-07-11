// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for classic KoboldAI. Extracted from
// src/endpoints/backends/kobold.js:19-173 (legacy `/generate` handler).
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// chunk/end/error events; never touches Express request/response.
//
// Preserved from the legacy handler:
//   • localhost → 127.0.0.1 rewrite for api_server
//   • streaming vs non-streaming URL suffix
//       stream    → `${api_server}/extra/generate/stream`
//       non-stream→ `${api_server}/v1/generate`
//   • body pickBy: gui_settings=true → send only prompt/max_context_length/
//     max_length (kobold uses its own GUI-configured sampler defaults);
//     otherwise send the full sampler bag verbatim
//   • can_abort side-channel: on ctx.signal abort, POST to
//     `${api_server}/extra/abort` (fire-and-forget)
//   • Upstream 4xx/5xx: reshape body `{detail:{msg}}` → emit.error with the
//     inner msg (falls back to raw text if not JSON)
//   • Retry loop on `error?.status === 403 || 503`: MAX_RETRIES=50,
//     2500ms delay. In practice fetch() rejections carry no `.status`, so
//     this loop only kicks in when the environment surfaces an HTTP-shaped
//     error (matches legacy behavior).

import { getOverrideHeaders } from '../../additional-headers.js';
import { pipeResponseBodyToEmit } from '../response-stream.js';

const MAX_RETRIES = 50;
const RETRY_DELAY_MS = 2500;

/**
 * Fire-and-forget POST to Kobold's abort side channel. Mirrors the
 * onAbortClose handler at src/endpoints/backends/kobold.js:35-51.
 *
 * @param {object} ctx DispatchContext
 * @param {string} apiServer rewritten api_server (localhost already swapped)
 * @returns {Promise<void>}
 */
async function fireKoboldAbort(ctx, apiServer) {
    try {
        console.info('Aborting Kobold generation...');
        const abortResponse = await ctx.fetch(`${apiServer}/extra/abort`, {
            method: 'POST',
        });
        if (!abortResponse.ok) {
            console.error('Error sending abort request to Kobold:', abortResponse.status);
        }
    } catch (error) {
        console.error(error);
    }
}

/**
 * Build outgoing body for Kobold. Mirrors the two branches at
 * src/endpoints/backends/kobold.js:56-97.
 *
 * @param {object} body ctx.body
 * @returns {object} upstream body object (JSON-serialized at fetch site)
 */
function buildKoboldBody(body) {
    /** @type {any} */
    const settings = {
        prompt: body.prompt,
        use_story: false,
        use_memory: false,
        use_authors_note: false,
        use_world_info: false,
        max_context_length: body.max_context_length,
        max_length: body.max_length,
    };

    if (!body.gui_settings) {
        Object.assign(settings, {
            rep_pen: body.rep_pen,
            rep_pen_range: body.rep_pen_range,
            rep_pen_slope: body.rep_pen_slope,
            temperature: body.temperature,
            tfs: body.tfs,
            top_a: body.top_a,
            top_k: body.top_k,
            top_p: body.top_p,
            min_p: body.min_p,
            typical: body.typical,
            sampler_order: body.sampler_order,
            singleline: !!body.singleline,
            use_default_badwordsids: body.use_default_badwordsids,
            mirostat: body.mirostat,
            mirostat_eta: body.mirostat_eta,
            mirostat_tau: body.mirostat_tau,
            grammar: body.grammar,
            sampler_seed: body.sampler_seed,
        });
        if (body.stop_sequence) {
            settings.stop_sequence = body.stop_sequence;
        }
    }

    return settings;
}

function buildKoboldHeaders(apiServer) {
    /** @type {any} */
    const headers = { 'Content-Type': 'application/json' };
    try {
        const overrides = getOverrideHeaders(new URL(apiServer).host);
        if (overrides && Object.keys(overrides).length > 0) {
            Object.assign(headers, overrides);
        }
    } catch { /* invalid URL — skip overrides (matches legacy: URL() throws would 500) */ }
    return headers;
}

async function delay(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Dispatch a Kobold /generate request through the transport-agnostic
 * event bus.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchKobold(ctx) {
    const body = ctx.body || {};

    if (!body.api_server) {
        ctx.emit.error(new Error('kobold dispatch: api_server missing'));
        return;
    }

    ctx.inspection.start();

    // localhost → 127.0.0.1 rewrite (legacy line 28-30).
    let apiServer = body.api_server;
    if (typeof apiServer === 'string' && apiServer.indexOf('localhost') !== -1) {
        apiServer = apiServer.replace('localhost', '127.0.0.1');
    }

    // Wire the can_abort side channel — fire-and-forget POST to
    // `${api_server}/extra/abort` when the dispatch signal aborts.
    if (body.can_abort) {
        const onAbort = () => { void fireKoboldAbort(ctx, apiServer); };
        if (ctx.signal.aborted) {
            onAbort();
        } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
    }

    const upstreamBody = buildKoboldBody(body);
    const headers = buildKoboldHeaders(apiServer);
    const url = body.streaming
        ? `${apiServer}/extra/generate/stream`
        : `${apiServer}/v1/generate`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            ctx.inspection.attach(url, '', upstreamBody);
            const resp = await ctx.fetch(url, {
                method: 'POST',
                body: JSON.stringify(upstreamBody),
                headers,
                signal: ctx.signal,
                timeout: 0,
            });

            // Architectural contract: every dispatch emits a single head
            // frame immediately after the upstream fetch resolves,
            // regardless of status. The WebSocket delivery layer
            // (ws-delivery) uses head to release the client-side
            // `await headPromise`; without it the client hangs on
            // subscribe races with setImmediate dispatch.
            //
            // Retry note: fetch() rejections re-enter the loop before
            // this line; only resolved responses (both ok and !ok) reach
            // head emit, so head fires exactly once per completed
            // request.
            ctx.emit.head({ status: resp.status, headers: {} });

            if (body.streaming) {
                // Streaming: forward raw SSE bytes verbatim. Do not gate on
                // resp.ok — legacy handler pipes streaming responses as-is
                // via forwardFetchResponse.
                await pipeResponseBodyToEmit(resp, ctx);
                return;
            }

            // Non-streaming
            if (!resp.ok) {
                let errText = '';
                try { errText = await resp.text(); } catch { /* body already consumed */ }
                console.warn(`Kobold returned error: ${resp.status} ${resp.statusText} ${errText}`);
                let message = errText;
                try {
                    const errorJson = JSON.parse(errText);
                    message = errorJson?.detail?.msg || errText;
                } catch { /* not JSON */ }
                const err = new Error(String(message));
                ctx.inspection.fail(err, resp?.status ?? 502);
                ctx.emit.error(err);
                return;
            }

            /** @type {any} */
            const data = await resp.json();
            const encoder = new TextEncoder();
            ctx.emit.chunk(encoder.encode(JSON.stringify(data)));
            ctx.emit.end();
            return;
        } catch (error) {
            // Legacy retry: 403/503 retry up to MAX_RETRIES with 2500ms.
            // In practice fetch() rejections carry no `.status`; kept 1:1
            // with legacy behavior — non-status errors fall through to the
            // default branch and emit immediately.
            const status = error?.status;
            if (status === 403 || status === 503) {
                console.warn(`KoboldAI is busy. Retry attempt ${attempt + 1} of ${MAX_RETRIES}...`);
                await delay(RETRY_DELAY_MS);
                continue;
            }
            if (status !== undefined) {
                console.error('Status Code from Kobold:', status);
            }
            try { ctx.inspection.fail(error); } catch { /* inspection best-effort */ }
            ctx.emit.error(error);
            return;
        }
    }

    // Exhausted retries.
    const err = new Error('Max retries exceeded');
    try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
    ctx.emit.error(err);
}
