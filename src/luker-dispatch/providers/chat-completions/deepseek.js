// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for DeepSeek chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import {
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    addAssistantPrefix,
    ensureDeepSeekReasoningContent,
    getPromptNames,
    stripNonChatReplayFields,
} from '../../../prompt-converters.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';

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
    ctx.inspection.start();

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.DEEPSEEK) || '';

    if (!apiKey && !body.base_url && !body.reverse_proxy) {
        console.warn('DeepSeek API key is missing.');
        const err = new Error('DeepSeek API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    let apiUrl;
    try {
        apiUrl = normalizeProviderBaseUrl('deepseek', body.reverse_proxy || body.base_url || API_DEEPSEEK);
        new URL(apiUrl);
    } catch (parseErr) {
        const err = new Error(`DeepSeek upstream URL invalid: ${parseErr?.message || parseErr}`);
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const bodyParams = {};
        const headers = {};

        if (body.logprobs > 0) {
            bodyParams.top_logprobs = body.logprobs;
            bodyParams.logprobs = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams.tools = body.tools;
            bodyParams.tool_choice = body.tool_choice;

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
            body.messages.push(message);
        }

        const processedMessages = addAssistantPrefix(
            postProcessPrompt(stripNonChatReplayFields(body.messages), PROMPT_PROCESSING_TYPE.SEMI, getPromptNames({ body })),
            bodyParams.tools,
            'prefix',
        );
        ensureDeepSeekReasoningContent(processedMessages);

        const reasoningToken = normalizeReasoningToken(body.reasoning_effort);
        if (reasoningToken !== 'auto') {
            bodyParams.thinking = { type: reasoningToken === 'off' ? 'disabled' : 'enabled' };
            if (reasoningToken !== 'off') {
                bodyParams.reasoning_effort = reasoningToken;
                // DeepSeek thinking mode rejects `tool_choice` (returns 400). Strip it here
                // so the frontend patch is not the only line of defense; `tools` stays and
                // the service falls back to auto behavior. Forced-function callers rely on retry.
                delete bodyParams.tool_choice;
            }
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

        applyAdditionalParameters(requestBody, headers, body);

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'chat/completions' : apiUrl + '/chat/completions';
        const requestHeaders = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            ...headers,
        };
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(requestHeaders, apiKey, ['authorization']), requestBody);

        console.debug('DeepSeek request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: requestHeaders,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'DeepSeek',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'DeepSeek');
    }
}
