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
//   • Retry loop on resolved-Response 403/503: MAX_RETRIES=50, 2500ms
//     delay. fetch() rejections carry no `.status`, so the retry branch
//     is evaluated on the Response (not on rejected errors); a rejected
//     fetch terminates the dispatch immediately.

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
    ctx.inspection.start();

    if (!body.api_server) {
        const err = new Error('kobold dispatch: api_server missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    // localhost → 127.0.0.1 rewrite (legacy line 28-30).
    let apiServer = body.api_server;
    if (typeof apiServer === 'string' && apiServer.indexOf('localhost') !== -1) {
        apiServer = apiServer.replace('localhost', '127.0.0.1');
    }

    // Wire the can_abort side channel — fire-and-forget POST to
    // `${api_server}/extra/abort` when the dispatch signal aborts.
    //
    // In addition to signal-aborted, opt into ctx.onRequestClose so a
    // client TCP-close also fires /extra/abort. The runner does not
    // default-bind close → abort (generation-job-survives-disconnect
    // contract), but Kobold's classic backend has no resume channel:
    // once the client drops, the GPU keeps generating until it finishes
    // on its own, wasting cycles on a job nobody is watching. Opt-in
    // mirrors comfy.js:196-208 which faces the same "no resume" upstream.
    // Disposer is deferred to after the main fetch loop settles so a
    // clean response tail's `request 'close'` does not re-fire abort.
    let disposeCloseHook = null;
    if (body.can_abort) {
        const onAbort = () => { void fireKoboldAbort(ctx, apiServer); };
        if (ctx.signal.aborted) {
            onAbort();
        } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        if (typeof ctx.onRequestClose === 'function') {
            disposeCloseHook = ctx.onRequestClose(() => {
                void fireKoboldAbort(ctx, apiServer);
                try { ctx.abort?.(); } catch { /* ignore */ }
            });
        }
    }

    const upstreamBody = buildKoboldBody(body);
    const headers = buildKoboldHeaders(apiServer);
    const url = body.streaming
        ? `${apiServer}/extra/generate/stream`
        : `${apiServer}/v1/generate`;

    console.debug(upstreamBody);

    try {
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
                // Retry note: 403/503 retries branch on the resolved Response
                // (fetch rejections carry no `.status`, so status checks must
                // be evaluated on a Response, not on a rejected error). Head
                // fires only once per completed request because retry `continue`
                // skips the head emit below.
                if (!resp.ok && (resp.status === 403 || resp.status === 503)) {
                    if (attempt < MAX_RETRIES - 1) {
                        console.warn(`KoboldAI is busy. Retry attempt ${attempt + 1} of ${MAX_RETRIES}...`);
                        await delay(RETRY_DELAY_MS);
                        continue;
                    }
                }

                ctx.emit.head({ status: resp.status, headers: resp.headers });

                if (body.streaming) {
                    // Streaming path gate for upstream !ok: mirrors the
                    // non-streaming branch below (and legacy
                    // forwardFetchResponse({jsonErrorResponse:true}) shape).
                    // Without this gate the raw JSON error body pipes into the
                    // client SSE parser mid-stream and is silently dropped, so
                    // the user sees an empty response with no error toast.
                    // Head has already been emitted above with the real
                    // upstream status, so we only need chunk+end here.
                    if (!resp.ok) {
                        let errText = '';
                        try { errText = await resp.text(); } catch { /* body already consumed */ }
                        console.warn(`Kobold returned error (streaming): ${resp.status} ${resp.statusText} ${errText}`);
                        let message = errText;
                        try {
                            const errorJson = JSON.parse(errText);
                            message = errorJson?.detail?.msg || errText;
                        } catch { /* not JSON */ }
                        ctx.inspection.fail(new Error(String(message)), resp?.status ?? 502);
                        if (errText) {
                            ctx.emit.chunk(new TextEncoder().encode(errText));
                        }
                        ctx.emit.end();
                        return;
                    }
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
                    ctx.inspection.fail(new Error(String(message)), resp?.status ?? 502);
                    // Surface upstream status + body to the client via chunk + end
                    // (head already emitted above). Client sees
                    // Response.status=<upstream> and Response.body readable so
                    // callers can do `await response.text()` or
                    // `await response.json()` for structured error inspection
                    // (matches legacy handler shape which returned
                    // `.status(4xx).send({error:{...}})`).
                    if (errText) {
                        ctx.emit.chunk(new TextEncoder().encode(errText));
                    }
                    ctx.emit.end();
                    return;
                }

                /** @type {any} */
                const data = await resp.json();
                console.debug('Endpoint response:', data);
                const encoder = new TextEncoder();
                ctx.emit.chunk(encoder.encode(JSON.stringify(data)));
                ctx.emit.end();
                return;
            } catch (error) {
                // fetch() rejections (network error, AbortError, invalid URL)
                // carry no `.status`, so the 403/503 retry lives on the
                // resolved-Response branch above. Rejections terminate the
                // dispatch immediately.
                try { ctx.inspection.fail(error); } catch { /* inspection best-effort */ }
                if (error && 'status' in error) {
                    console.error('Status Code from Kobold:', error.status);
                }
                ctx.emit.error(error);
                return;
            }
        }

        // Exhausted retries.
        console.error('Max retries exceeded. Giving up.');
        const err = new Error('Max retries exceeded');
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    } finally {
        // Drop the close hook once the dispatch has settled — a normal
        // response tail routinely fires request 'close' just after we
        // emit end/error, and we don't want to POST /extra/abort on a
        // successfully completed generation.
        try { disposeCloseHook?.(); } catch { /* ignore */ }
    }
}
