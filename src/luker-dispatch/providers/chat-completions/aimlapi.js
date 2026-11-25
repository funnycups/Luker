// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for AI/ML API chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { AIMLAPI_HEADERS } from '../../../constants.js';
import { stripNonChatReplayFields } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { passthroughReasoningEffort } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';

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
    ctx.inspection.start();
    const apiKey = ctx.secrets.read(SECRET_KEYS.AIMLAPI) || '';

    if (!apiKey) {
        console.warn('AI/ML API key is missing.');
        const err = new Error('AI/ML API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const bodyParams = {};

        if (body.logprobs > 0) {
            bodyParams.top_logprobs = body.logprobs;
            bodyParams.logprobs = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams.tools = body.tools;
            bodyParams.tool_choice = body.tool_choice;
        }

        if (Array.isArray(body.stop) && body.stop.length > 0) {
            bodyParams.stop = body.stop;
        }

        const effort = passthroughReasoningEffort(body.reasoning_effort);
        if (effort) {
            bodyParams.reasoning_effort = effort;
        }

        if (body.json_schema) {
            bodyParams.response_format = {
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
            'messages': stripNonChatReplayFields(body.messages),
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
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            ...AIMLAPI_HEADERS,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('AI/ML API request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'AI/ML API',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'AI/ML API');
    }
}
