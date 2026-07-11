// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for DeepSeek chat completions. Extracted from legacy
// `sendDeepSeekRequest` (src/endpoints/backends/chat-completions.js:1430-1547).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe).

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import {
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    addAssistantPrefix,
    addReasoningContentToToolCalls,
    getPromptNames,
} from '../../../prompt-converters.js';
import { excludeKeysByYaml, mergeObjectWithYaml } from '../../../util.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_DEEPSEEK = 'https://api.deepseek.com/beta';

/**
 * Dispatch a DeepSeek chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchDeepSeek(ctx) {
    const body = ctx.body || {};

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.DEEPSEEK) || '';

    if (!apiKey && !body.base_url && !body.reverse_proxy) {
        ctx.emit.error(new Error('DeepSeek API key is missing'));
        return;
    }

    let apiUrl;
    try {
        apiUrl = new URL(body.reverse_proxy || body.base_url || API_DEEPSEEK).toString();
    } catch (err) {
        ctx.emit.error(new Error(`DeepSeek upstream URL invalid: ${err?.message || err}`));
        return;
    }

    ctx.inspection.start();

    try {
        const bodyParams = {};
        const headers = {};

        if (body.logprobs > 0) {
            bodyParams['top_logprobs'] = body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams['tools'] = body.tools;
            bodyParams['tool_choice'] = body.tool_choice;

            // DeepSeek doesn't permit empty required arrays.
            bodyParams.tools.forEach(tool => {
                const required = tool?.function?.parameters?.required;
                if (Array.isArray(required) && required.length === 0) {
                    delete tool.function.parameters.required;
                }
            });
        }

        // Hack to support JSON schema — mirror legacy sendDeepSeekRequest behavior:
        // DeepSeek has no dedicated schema field, so we append a user message
        // carrying the schema and switch response_format to json_object.
        if (body.json_schema) {
            bodyParams.response_format = { type: 'json_object' };
            const message = {
                role: 'user',
                content: `JSON schema for the response:\n${JSON.stringify(body.json_schema.value, null, 4)}`,
            };
            if (Array.isArray(body.messages)) {
                body.messages.push(message);
            }
        }

        mergeObjectWithYaml(bodyParams, body.custom_include_body);
        mergeObjectWithYaml(headers, body.custom_include_headers);

        const processedMessages = addAssistantPrefix(
            postProcessPrompt(body.messages, PROMPT_PROCESSING_TYPE.SEMI, getPromptNames({ body })),
            bodyParams.tools,
            'prefix',
        );
        addReasoningContentToToolCalls(processedMessages);

        if (body.reasoning_effort) {
            bodyParams['reasoning_effort'] = body.reasoning_effort;
            bodyParams['thinking'] = { type: 'enabled' };
            // DeepSeek thinking mode rejects `tool_choice` (returns 400). Strip it here
            // so the frontend patch is not the only line of defense; `tools` stays and
            // the service falls back to auto behavior. Forced-function callers rely on retry.
            delete bodyParams['tool_choice'];
        }

        const requestBody = {
            'messages': processedMessages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.max_tokens,
            'stream': body.stream,
            'presence_penalty': body.presence_penalty,
            'frequency_penalty': body.frequency_penalty,
            'top_p': body.top_p,
            'stop': body.stop,
            'seed': body.seed,
            ...bodyParams,
        };

        excludeKeysByYaml(requestBody, body.custom_exclude_body);

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'chat/completions' : apiUrl + '/chat/completions';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `DeepSeek upstream ${resp.status}: ${errText.slice(0, 500)}`;
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
