// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for MistralAI chat completions. Extracted from legacy
// `sendMistralAIRequest` (src/endpoints/backends/chat-completions.js:1237-1321).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe). Like CLAUDE, supports reverse_proxy /
// base_url / proxy_password overrides.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertMistralMessages, getPromptNames } from '../../../prompt-converters.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_MISTRAL = 'https://api.mistral.ai/v1';

/**
 * Dispatch a MistralAI chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchMistralAI(ctx) {
    const body = ctx.body || {};

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.MISTRALAI) || '';

    if (!apiKey && !body.reverse_proxy) {
        console.warn('MistralAI API key is missing.');
        ctx.emit.error(new Error('MistralAI API key is missing'));
        return;
    }

    let apiUrl;
    try {
        apiUrl = new URL(body.reverse_proxy || body.base_url || API_MISTRAL).toString();
    } catch (err) {
        ctx.emit.error(new Error(`MistralAI upstream URL invalid: ${err?.message || err}`));
        return;
    }

    ctx.inspection.start();

    try {
        const messages = convertMistralMessages(body.messages, getPromptNames({ body }));

        const requestBody = {
            'model': body.model,
            'messages': messages,
            'temperature': body.temperature,
            'top_p': body.top_p,
            'frequency_penalty': body.frequency_penalty,
            'presence_penalty': body.presence_penalty,
            'max_tokens': body.max_tokens,
            'stream': body.stream,
            'safe_prompt': body.safe_prompt,
            'random_seed': body.seed === -1 ? undefined : body.seed,
            'stop': Array.isArray(body.stop) && body.stop.length > 0 ? body.stop : undefined,
        };

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            requestBody['tools'] = body.tools;
            requestBody['tool_choice'] = body.tool_choice;
        }

        if (body.json_schema) {
            requestBody['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    description: body.json_schema.description,
                    schema: body.json_schema.value,
                    strict: body.json_schema.strict ?? true,
                },
            };
        }

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'chat/completions' : apiUrl + '/chat/completions';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        console.debug('MisralAI request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
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
            console.warn(`MistralAI API returned error: ${resp.status} ${resp.statusText} ${errText}`);
            const msg = `MistralAI upstream ${resp.status}: ${errText}`;
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
                console.debug('MistralAI response:', json);
            } catch { /* non-JSON body — skip debug log */ }
            ctx.emit.chunk(new Uint8Array(buf));
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        console.error('Error communicating with MistralAI API: ', err);
        ctx.emit.error(err);
    }
}
