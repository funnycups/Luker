// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Cohere chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Both streaming and non-streaming upstream Cohere v2 responses are relayed
// verbatim in their native wire format.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertCohereMessages, getPromptNames } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';

const API_COHERE_V2 = 'https://api.cohere.ai/v2';

/**
 * Dispatch a Cohere chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchCohere(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();
    const apiKey = ctx.secrets.read(SECRET_KEYS.COHERE) || '';

    if (!apiKey) {
        console.warn('Cohere API key is missing.');
        const err = new Error('Cohere API key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const convertedHistory = convertCohereMessages(body.messages, getPromptNames({ body }));
        const tools = [];

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            tools.push(...body.tools);
            tools.forEach(tool => {
                if (tool?.function?.parameters?.$schema) {
                    delete tool.function.parameters.$schema;
                }
            });
        }

        // https://docs.cohere.com/reference/chat
        const requestBody = {
            stream: Boolean(body.stream),
            model: body.model,
            messages: convertedHistory.chatHistory,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            k: body.top_k,
            p: body.top_p,
            seed: body.seed,
            stop_sequences: body.stop,
            frequency_penalty: body.frequency_penalty,
            presence_penalty: body.presence_penalty,
            documents: [],
            tools: tools,
            logprobs: body.logprobs ? true : undefined,
        };

        // Cohere expresses tool_choice as REQUIRED / NONE; omitting it lets the
        // model decide. A named-function request is mapped to REQUIRED, the
        // closest available behavior (Cohere cannot force one specific tool).
        if (tools.length > 0) {
            if (body.tool_choice === 'none') {
                requestBody.tool_choice = 'NONE';
            } else if (body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) {
                requestBody.tool_choice = 'REQUIRED';
            }
        }

        const canDoSafetyMode = String(body.model).endsWith('08-2024');
        if (canDoSafetyMode) {
            requestBody.safety_mode = 'OFF';
        }

        if (body.json_schema) {
            requestBody.response_format = {
                type: 'json_schema',
                schema: body.json_schema.value,
            };
        }

        const cohereToken = normalizeReasoningToken(body.reasoning_effort);
        if (cohereToken === 'off') {
            requestBody.thinking = { type: 'disabled' };
        } else if (cohereToken !== 'auto') {
            requestBody.thinking = { type: 'enabled' };
        }

        const fetchUrl = API_COHERE_V2 + '/chat';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('Cohere request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'Cohere',
            stream: Boolean(requestBody.stream),
            completeInspection: true,
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'Cohere');
    }
}
