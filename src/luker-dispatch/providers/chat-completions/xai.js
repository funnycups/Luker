// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for xAI (Grok) chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertXAIMessages, getPromptNames, stripNonChatReplayFields } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';

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
    ctx.inspection.start();

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.XAI) || '';

    if (!apiKey && !body.base_url && !body.reverse_proxy) {
        console.warn('xAI API key is missing.');
        const err = new Error('xAI API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    let apiUrl;
    try {
        apiUrl = normalizeProviderBaseUrl('xai', body.reverse_proxy || body.base_url || API_XAI);
        new URL(apiUrl);
    } catch (parseErr) {
        const err = new Error(`xAI upstream URL invalid: ${parseErr?.message || parseErr}`);
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

        const xaiToken = normalizeReasoningToken(body.reasoning_effort);
        if (xaiToken !== 'auto' && xaiToken !== 'off') {
            // xAI accepts low/medium/high/xhigh; grok-4.5 treats xhigh as high.
            // Minimal has no equivalent and max is represented by the highest level.
            const xaiEffort = { minimal: 'low', max: 'xhigh' }[xaiToken] ?? xaiToken;
            bodyParams.reasoning_effort = xaiEffort;
        }

        if (body.json_schema) {
            bodyParams.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    strict: body.json_schema.strict ?? true,
                    schema: body.json_schema.value,
                },
            };
        }

        const processedMessages = stripNonChatReplayFields(convertXAIMessages(body.messages, getPromptNames({ body })));

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
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('xAI request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'xAI',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'xAI');
    }
}
