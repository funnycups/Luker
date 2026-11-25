// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for MistralAI chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertMistralMessages, getPromptNames } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';

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
    ctx.inspection.start();

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.MISTRALAI) || '';

    if (!apiKey && !body.base_url && !body.reverse_proxy) {
        console.warn('MistralAI API key is missing.');
        const err = new Error('MistralAI API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    let apiUrl;
    try {
        apiUrl = normalizeProviderBaseUrl('mistral', body.reverse_proxy || body.base_url || API_MISTRAL);
        new URL(apiUrl);
    } catch (parseErr) {
        const err = new Error(`MistralAI upstream URL invalid: ${parseErr?.message || parseErr}`);
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const messages = convertMistralMessages(body.messages, getPromptNames({ body }));

        const requestBody = {
            'model': body.model,
            'messages': messages,
            'temperature': body.temperature,
            'top_p': body.top_p,
            'top_k': body.top_k,
            'n': body.n,
            'frequency_penalty': body.frequency_penalty,
            'presence_penalty': body.presence_penalty,
            'max_tokens': body.max_tokens,
            'stream': body.stream,
            'safe_prompt': body.safe_prompt,
            'random_seed': body.seed === -1 ? undefined : body.seed,
            'stop': Array.isArray(body.stop) && body.stop.length > 0 ? body.stop : undefined,
        };

        const mistralToken = normalizeReasoningToken(body.reasoning_effort);
        if (mistralToken === 'off') {
            requestBody.reasoning_effort = 'none';
        } else if (mistralToken !== 'auto') {
            requestBody.reasoning_effort = mistralToken === 'medium' ? 'high' : mistralToken;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            requestBody.tools = body.tools;
            requestBody.tool_choice = body.tool_choice;
        }

        if (body.json_schema) {
            requestBody.response_format = {
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
        const headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('MisralAI request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'MistralAI',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'MistralAI');
    }
}
