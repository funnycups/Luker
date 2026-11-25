// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for AI21 chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertAI21Messages, getPromptNames } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';

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
    ctx.inspection.start();
    const apiKey = ctx.secrets.read(SECRET_KEYS.AI21) || '';

    if (!apiKey) {
        console.warn('AI21 API key is missing.');
        const err = new Error('AI21 API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

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
            body.messages.push(schemaMessage);
        }

        const convertedPrompt = convertAI21Messages(body.messages, getPromptNames({ body }));
        const useTools = Array.isArray(body.tools) && body.tools.length > 0;
        // AI21 requires stream=false when tools are present, and n must be 1 when streaming.
        const forceNonStreaming = useTools || Number(body.n) > 1;
        const requestBody = {
            messages: convertedPrompt,
            model: body.model,
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            stop: body.stop,
            stream: forceNonStreaming ? false : Boolean(body.stream),
            n: body.n,
            tools: body.tools,
            ...bodyParams,
        };

        const fetchUrl = API_AI21 + '/chat/completions';
        const headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('AI21 request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'AI21',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'AI21');
    }
}
