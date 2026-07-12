// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for xAI (Grok) chat completions. Extracted from legacy
// `sendXaiRequest` (src/endpoints/backends/chat-completions.js:1554-1654).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertXAIMessages, getPromptNames } from '../../../prompt-converters.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_XAI = 'https://api.x.ai/v1';

/**
 * Dispatch an xAI chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchXai(ctx) {
    const body = ctx.body || {};

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.XAI) || '';

    if (!apiKey && !body.base_url && !body.reverse_proxy) {
        console.warn('xAI API key is missing.');
        ctx.emit.error(new Error('xAI API key is missing'));
        return;
    }

    let apiUrl;
    try {
        apiUrl = new URL(body.reverse_proxy || body.base_url || API_XAI).toString();
    } catch (err) {
        ctx.emit.error(new Error(`xAI upstream URL invalid: ${err?.message || err}`));
        return;
    }

    ctx.inspection.start();

    try {
        const bodyParams = {};

        if (body.logprobs > 0) {
            bodyParams['top_logprobs'] = body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams['tools'] = body.tools;
            bodyParams['tool_choice'] = body.tool_choice;
        }

        if (Array.isArray(body.stop) && body.stop.length > 0) {
            bodyParams['stop'] = body.stop;
        }

        if (body.reasoning_effort) {
            // xAI only accepts 'high' or 'low'; anything else collapses to 'low'
            // (mirror legacy sendXaiRequest behavior).
            bodyParams['reasoning_effort'] = body.reasoning_effort === 'high' ? 'high' : 'low';
        }

        if (body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    strict: body.json_schema.strict ?? true,
                    schema: body.json_schema.value,
                },
            };
        }

        const processedMessages = convertXAIMessages(body.messages, getPromptNames({ body }));

        const requestBody = {
            'messages': processedMessages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.max_tokens,
            'max_completion_tokens': body.max_completion_tokens,
            'stream': body.stream,
            'presence_penalty': body.presence_penalty,
            'frequency_penalty': body.frequency_penalty,
            'top_p': body.top_p,
            'seed': body.seed,
            'n': body.n,
            ...bodyParams,
        };

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'chat/completions' : apiUrl + '/chat/completions';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        console.debug('xAI request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: resp.status, headers: {} });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            console.warn(`xAI API returned error: ${resp.status} ${resp.statusText} ${errText}`);
            const msg = `xAI upstream ${resp.status}: ${errText}`;
            ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
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

        if (body.stream) {
            await pipeResponseBodyToEmit(resp, ctx);
        } else {
            const buf = await resp.arrayBuffer();
            try {
                const json = JSON.parse(new TextDecoder().decode(buf));
                console.debug('xAI response:', json);
            } catch { /* non-JSON body — skip debug log */ }
            ctx.emit.chunk(new Uint8Array(buf));
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        console.error('Error communicating with xAI API: ', err);
        ctx.emit.error(err);
    }
}
