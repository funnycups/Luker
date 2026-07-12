// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for ComfyUI. Extracted from
// src/endpoints/stable-diffusion.js:703-792 (`/generate`) plus the
// `waitForComfyCompletion` helper at :576-701.
//
// Consumes a DispatchContext and emits chunk/end/error events; never
// touches Express request/response or the request socket.
//
// Preserved from the legacy handler:
//   • Submit prompt to `${baseUrl}/prompt` with a generated clientId
//     (attached to promptBody.client_id) so the internal WebSocket can
//     receive execution status messages.
//   • Wait for completion via a WebSocket to `${wsBase}/ws?clientId=…`
//     with up to WS_MAX_RETRIES auto-reconnects; fall back to
//     `${baseUrl}/history/${promptId}` polling on WS failure.
//   • On abort, fire-and-forget POST to `${baseUrl}/interrupt` and call
//     ctx.inspection.abort() (replaces the legacy request.socket poking).
//   • On success fetch `${baseUrl}/view?filename=…&subfolder=…&type=…`,
//     base64-encode, and emit `{format, data}` JSON.

import crypto from 'node:crypto';
import urlJoin from 'url-join';
import WebSocketLib from 'ws';
import { delay, getBasicAuthHeader, tryParse } from '../../../util.js';
import { extractImageMeta } from '../../../request-inspector.js';
import path from 'node:path';

// The ws WebSocket ctor is injectable via `__setWebSocketForTest` so unit
// tests can swap a fake without depending on ESM mocking of the `ws`
// package (which is CJS and does not play cleanly with
// jest.unstable_mockModule in the current toolchain).
let WebSocket = WebSocketLib;
export function __setWebSocketForTest(ctor) { WebSocket = ctor || WebSocketLib; }
export function __resetWebSocketForTest() { WebSocket = WebSocketLib; }

const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_RETRY_MAX = 3;
const WS_MAX_RETRIES = 3;
const WS_RETRY_DELAY_MS = 2000;
const WS_OPEN_TIMEOUT_MS = 5000;

/**
 * Wait for ComfyUI prompt completion via WebSocket (preferred) or
 * polling fallback. Behaviour identical to the legacy helper at
 * src/endpoints/stable-diffusion.js:576-701.
 */
async function waitForComfyCompletion(baseUrl, promptId, clientId, signal, ctxFetch) {
    const parsedBase = new URL(baseUrl);
    const wsProtocol = parsedBase.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${parsedBase.host}/ws?clientId=${clientId}`;
    const deadline = Date.now() + TIMEOUT_MS;

    for (let attempt = 0; attempt <= WS_MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');
        if (Date.now() >= deadline) break;

        try {
            const ws = new WebSocket(wsUrl);

            await new Promise((resolve, reject) => {
                const openTimeout = setTimeout(() => {
                    ws.terminate();
                    reject(new Error('WS open timeout'));
                }, WS_OPEN_TIMEOUT_MS);
                ws.on('open', () => { clearTimeout(openTimeout); resolve(); });
                ws.on('error', (err) => { clearTimeout(openTimeout); reject(err); });
            });

            if (attempt > 0) {
                console.debug(`[ComfyUI] WebSocket reconnected (attempt ${attempt + 1})`);
            } else {
                console.debug('[ComfyUI] WebSocket connected, waiting for completion...');
            }

            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('ComfyUI generation timed out'));
                }, Math.max(deadline - Date.now(), 1000));

                if (signal) {
                    signal.addEventListener('abort', () => {
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error('Aborted'));
                    }, { once: true });
                }

                ws.on('message', (rawData) => {
                    if (typeof rawData !== 'string' && !Buffer.isBuffer(rawData)) return;
                    let msg;
                    try { msg = JSON.parse(rawData.toString()); } catch { return; }

                    if (msg.type === 'executing' && msg.data?.prompt_id === promptId && msg.data?.node === null) {
                        clearTimeout(timeout);
                        ws.close();
                        resolve('done');
                    } else if (msg.type === 'execution_error' && msg.data?.prompt_id === promptId) {
                        clearTimeout(timeout);
                        ws.close();
                        const d = msg.data;
                        reject(new Error(`ComfyUI generation failed.\n\n${d.node_type || 'Unknown'} [${d.node_id || '?'}] ${d.exception_type || 'Error'}: ${d.exception_message || 'Unknown error'}`));
                    }
                });

                ws.on('error', (err) => { clearTimeout(timeout); ws.close(); reject(err); });
                ws.on('close', (code) => {
                    clearTimeout(timeout);
                    reject(new Error(`ComfyUI WebSocket closed (code: ${code})`));
                });
            });

            if (result === 'done') return;
        } catch (wsError) {
            const isRetryable = wsError.message?.includes('WebSocket closed') || wsError.message?.includes('WS open timeout');
            if (!isRetryable || wsError.message === 'Aborted') {
                throw wsError;
            }

            if (attempt < WS_MAX_RETRIES) {
                console.debug(`[ComfyUI] WebSocket dropped (${wsError.message}), retrying in ${WS_RETRY_DELAY_MS}ms (${attempt + 1}/${WS_MAX_RETRIES})...`);
                await delay(WS_RETRY_DELAY_MS);
            } else {
                console.debug(`[ComfyUI] WebSocket failed after ${WS_MAX_RETRIES + 1} attempts, falling back to polling`);
            }
        }
    }

    // Polling fallback
    console.debug('[ComfyUI] Using polling fallback (2s interval)...');
    const historyUrl = new URL(urlJoin(baseUrl, `/history/${promptId}`));

    while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Aborted');

        let lastError = null;
        for (let retry = 0; retry < POLL_RETRY_MAX; retry++) {
            try {
                const result = await ctxFetch(historyUrl, { signal });
                if (!result.ok) throw new Error(`HTTP ${result.status}`);
                /** @type {any} */
                const history = await result.json();
                const item = history[promptId];
                if (item) return;
                break;
            } catch (err) {
                lastError = err;
                if (err.name === 'AbortError' || signal?.aborted) throw err;
                if (retry < POLL_RETRY_MAX - 1) await delay(500);
            }
        }
        if (lastError && lastError.name !== 'AbortError') {
            console.warn(`[ComfyUI] Poll attempt failed: ${lastError.message}, will retry...`);
        }
        await delay(POLL_INTERVAL_MS);
    }
    throw new Error('ComfyUI generation timed out (polling)');
}

/**
 * @param {object} ctx DispatchContext
 * @returns {Promise<void>}
 */
export async function dispatchSdComfy(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('comfyui', body));

    let settled = false;
    let disposeCloseHandler = null;

    try {
        const clientId = crypto.randomUUID();
        const baseUrl = body.url;

        const promptUrl = new URL(urlJoin(baseUrl, '/prompt'));
        const promptBody = JSON.parse(body.prompt);
        promptBody.client_id = clientId;
        ctx.inspection.attach(promptUrl, '');

        // ComfyUI is the one dispatch whose upstream state lives on a
        // remote server we cannot resume — a GPU job keeps running until
        // it either completes or receives /interrupt. If the client
        // disconnects (tab close, cancel), the runner's default
        // "generation-job survives disconnect" behaviour would leak the
        // remote GPU cycle until natural completion. Opt in via
        // ctx.onRequestClose to fire /interrupt + abort the local
        // controller so waitForComfyCompletion exits its WS/poll loop.
        //
        // Registered BEFORE the /prompt POST so a very fast disconnect
        // still triggers /interrupt once we know the baseUrl. promptId is
        // not required by /interrupt (it interrupts the currently running
        // prompt for whichever workflow the server is executing).
        if (typeof ctx.onRequestClose === 'function') {
            disposeCloseHandler = ctx.onRequestClose(() => {
                if (settled) return;
                try {
                    const interruptUrl = new URL(urlJoin(baseUrl, '/interrupt'));
                    ctx.fetch(interruptUrl, {
                        method: 'POST',
                        headers: { 'Authorization': getBasicAuthHeader(body.auth) },
                    }).catch(() => {});
                } catch { /* ignore */ }
                try { ctx.abort?.(); } catch { /* ignore */ }
            });
        }

        const promptResult = await ctx.fetch(promptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(promptBody),
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        // Only the initial /prompt fetch emits head; the /history and
        // /view image-download fetches, the /interrupt fire-and-forget,
        // and the internal ComfyUI WebSocket are all internal.
        ctx.emit.head({ status: promptResult.status, headers: promptResult.headers });

        if (!promptResult.ok) {
            const text = await promptResult.text().catch(() => '');
            const err = new Error('ComfyUI returned an error.');
            err.cause = tryParse(text);
            // Surface upstream status + body to the client via chunk + end
            // (head already emitted above). Client sees
            // Response.status=<upstream> and Response.body readable so
            // callers can do `await response.text()` or
            // `await response.json()` for structured error inspection.
            ctx.inspection.failImage(err, promptResult.status ?? 500);
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        /** @type {any} */
        const promptData = await promptResult.json();
        const promptId = promptData.prompt_id;

        // Wire abort → POST /interrupt + inspection abort.
        const onAbort = () => {
            if (!settled) {
                try {
                    const interruptUrl = new URL(urlJoin(baseUrl, '/interrupt'));
                    ctx.fetch(interruptUrl, {
                        method: 'POST',
                        headers: { 'Authorization': getBasicAuthHeader(body.auth) },
                    }).catch(() => {});
                } catch { /* ignore */ }
                try { ctx.inspection.abort(); } catch { /* ignore */ }
            }
        };
        if (ctx.signal.aborted) {
            onAbort();
        } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }

        await waitForComfyCompletion(baseUrl, promptId, clientId, ctx.signal, ctx.fetch);
        settled = true;

        const historyUrl = new URL(urlJoin(baseUrl, `/history/${promptId}`));
        const historyResult = await ctx.fetch(historyUrl, { signal: ctx.signal });
        if (!historyResult.ok) {
            throw new Error('ComfyUI returned an error fetching history.');
        }
        /** @type {any} */
        const historyData = await historyResult.json();
        const historyItem = historyData[promptId];
        if (!historyItem) {
            throw new Error('ComfyUI history item not found after execution.');
        }

        if (historyItem.status?.status_str === 'error') {
            const errorMessages = historyItem.status?.messages
                ?.filter(it => it[0] === 'execution_error')
                .map(it => it[1])
                .map(it => `${it.node_type} [${it.node_id}] ${it.exception_type}: ${it.exception_message}`)
                .join('\n') || '';
            throw new Error(`ComfyUI generation did not succeed.\n\n${errorMessages}`.trim());
        }

        const outputs = Object.keys(historyItem.outputs).map(it => historyItem.outputs[it]);
        console.debug('ComfyUI outputs:', outputs);
        const imgInfo = outputs.map(it => it.images).flat()[0] ?? outputs.map(it => it.gifs).flat()[0];
        if (!imgInfo) {
            throw new Error('ComfyUI did not return any recognizable outputs.');
        }
        const imgUrl = new URL(urlJoin(baseUrl, '/view'));
        imgUrl.search = `?filename=${imgInfo.filename}&subfolder=${imgInfo.subfolder}&type=${imgInfo.type}`;
        const imgResponse = await ctx.fetch(imgUrl, { signal: ctx.signal });
        if (!imgResponse.ok) {
            throw new Error('ComfyUI returned an error.');
        }
        const format = path.extname(imgInfo.filename).slice(1).toLowerCase() || 'png';
        const imgBuffer = await imgResponse.arrayBuffer();
        ctx.inspection.completeImage({ format, sizeBytes: imgBuffer.byteLength });

        const payload = { format, data: Buffer.from(imgBuffer).toString('base64') };
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(payload)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 500);
        console.error('ComfyUI error:', error);
        ctx.emit.error(error);
    } finally {
        // Drop the close hook once the dispatch has settled — a normal
        // response tail routinely fires request 'close' just after we
        // emit end/error, and we don't want to POST /interrupt on a
        // successfully completed prompt.
        try { disposeCloseHandler?.(); } catch { /* ignore */ }
    }
}
