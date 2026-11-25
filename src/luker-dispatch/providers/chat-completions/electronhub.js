// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Electron Hub chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import {
    cachingAtDepthForOpenRouterClaude,
    cachingSystemPromptForOpenRouter,
    stripNonChatReplayFields,
} from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { passthroughReasoningEffort } from './reasoning-params.js';
import {
    handleProviderDispatchError,
    relayUpstreamResponse,
    resolveClaudeCacheConfig,
} from './upstream-relay.js';

const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';

/**
 * Dispatch an Electron Hub chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchElectronHub(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();
    const apiKey = ctx.secrets.read(SECRET_KEYS.ELECTRONHUB) || '';

    if (!apiKey) {
        console.warn('Electron Hub key is missing.');
        const err = new Error('Electron Hub key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const bodyParams = {};
        const { cacheTTL, enableSystemPromptCache, cachingAtDepth } = resolveClaudeCacheConfig(body);

        if (body.enable_web_search) {
            bodyParams.web_search = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams.tools = body.tools;
            bodyParams.tool_choice = body.tool_choice;
        }

        const effort = passthroughReasoningEffort(body.reasoning_effort);
        const reasoning = {};
        if (effort) reasoning.effort = effort;
        if (!body.include_reasoning) reasoning.exclude = true;
        if (Object.keys(reasoning).length) bodyParams.reasoning = reasoning;

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

        const isClaude = /^claude-/.test(body.model);

        if (Array.isArray(body.messages) && isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(body.messages, cacheTTL);
            }

            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(body.messages, cachingAtDepth, cacheTTL);
            }
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
            'top_k': body.top_k,
            'logit_bias': body.logit_bias,
            'seed': body.seed,
            ...bodyParams,
        };

        const fetchUrl = API_ELECTRONHUB + '/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('Electron Hub request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'Electron Hub',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'Electron Hub');
    }
}
