// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for AI21 chat completions. Extracted from legacy
// `sendAI21Request` (src/endpoints/backends/chat-completions.js:1155-1230).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertAI21Messages, getPromptNames } from '../../../prompt-converters.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_AI21 = 'https://api.ai21.com/studio/v1';

/**
 * Dispatch an AI21 chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchAI21(ctx) {
    const body = ctx.body || {};
    const apiKey = ctx.secrets.read(SECRET_KEYS.AI21) || '';

    if (!apiKey) {
        ctx.emit.error(new Error('AI21 API key is missing'));
        return;
    }

    ctx.inspection.start();

    try {
        const bodyParams = {};
        // Hack to support JSON schema — mirror legacy sendAI21Request behavior:
        // AI21 has no dedicated schema field, so we append a user message
        // carrying the schema and switch response_format to json_object.
        if (body.json_schema) {
            bodyParams.response_format = { type: 'json_object' };
            const schemaMessage = {
                role: 'user',
                content: `JSON schema for the response:\n${JSON.stringify(body.json_schema.value, null, 4)}`,
            };
            if (Array.isArray(body.messages)) {
                body.messages.push(schemaMessage);
            }
        }

        const convertedPrompt = convertAI21Messages(body.messages, getPromptNames({ body }));
        const requestBody = {
            messages: convertedPrompt,
            model: body.model,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            stop: body.stop,
            stream: body.stream,
            tools: body.tools,
            ...bodyParams,
        };

        const fetchUrl = API_AI21 + '/chat/completions';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `AI21 upstream ${resp.status}: ${errText.slice(0, 500)}`;
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
