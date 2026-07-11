// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for AI/ML API chat completions. Extracted from legacy
// `sendAimlapiRequest` (src/endpoints/backends/chat-completions.js:1661-1760).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { AIMLAPI_HEADERS } from '../../../constants.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_AIMLAPI = 'https://api.aimlapi.com/v1';

/**
 * Dispatch an AI/ML API chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchAimlapi(ctx) {
    const body = ctx.body || {};
    const apiKey = ctx.secrets.read(SECRET_KEYS.AIMLAPI) || '';

    if (!apiKey) {
        ctx.emit.error(new Error('AI/ML API key is missing'));
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
            bodyParams['reasoning_effort'] = body.reasoning_effort;
        }

        if (body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    description: body.json_schema.description,
                    schema: body.json_schema.value,
                    strict: body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': body.messages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.max_tokens,
            'stream': body.stream,
            'presence_penalty': body.presence_penalty,
            'frequency_penalty': body.frequency_penalty,
            'top_p': body.top_p,
            'seed': body.seed,
            'n': body.n,
            ...bodyParams,
        };

        const fetchUrl = API_AIMLAPI + '/chat/completions';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...AIMLAPI_HEADERS,
            },
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `AI/ML API upstream ${resp.status}: ${errText.slice(0, 500)}`;
            ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
            ctx.emit.error(new Error(msg));
            return;
        }

        if (body.stream) {
            await pipeResponseBodyToEmit(resp, ctx);
        } else {
            const buf = await resp.arrayBuffer();
            ctx.emit.chunk(new Uint8Array(buf));
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
