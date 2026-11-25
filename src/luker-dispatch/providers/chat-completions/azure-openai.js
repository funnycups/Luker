// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Azure OpenAI chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import {
    AZURE_OPENAI_KEYS,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MODELS,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { stripNonChatReplayFields } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { resolveOpenAIEffort } from './reasoning-params.js';
import {
    emitCapabilityConflict,
    handleProviderDispatchError,
    relayUpstreamResponse,
} from './upstream-relay.js';
import {
    resolveOpenAIModelCapabilities,
    validateOpenAIChatCapabilities,
} from '../../../../public/scripts/lib/provider-capabilities.js';

/**
 * Dispatch an Azure OpenAI chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchAzureOpenAI(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();
    const apiKey = ctx.secrets.read(SECRET_KEYS.AZURE_OPENAI) || '';

    const { azure_base_url, azure_deployment_name, azure_api_version } = body;
    if (!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey) {
        const err = new Error('Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings.');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        if (Array.isArray(body.tools) && body.tools.length > 0) {
            const capabilityConflict = validateOpenAIChatCapabilities({ model: body.model, hasTools: true });
            if (capabilityConflict) {
                emitCapabilityConflict(ctx, capabilityConflict, 'Azure OpenAI');
                return;
            }
        }

        // Whitelist body fields per AZURE_OPENAI_KEYS.
        const apiRequestBody = /** @type {any} */ ({});
        for (const key of AZURE_OPENAI_KEYS) {
            if (Object.hasOwn(body, key)) {
                apiRequestBody[key] = body[key];
            }
        }
        if (Array.isArray(apiRequestBody.messages)) {
            apiRequestBody.messages = stripNonChatReplayFields(apiRequestBody.messages);
        }

        // Structured Output translation.
        if (body.json_schema) {
            apiRequestBody.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    strict: body.json_schema.strict ?? true,
                    schema: body.json_schema.value,
                },
            };
        }

        // Numeric logprobs → top_logprobs + boolean logprobs (OpenAI Chat spec).
        if (typeof apiRequestBody.logprobs === 'number' && apiRequestBody.logprobs > 0) {
            apiRequestBody.top_logprobs = apiRequestBody.logprobs;
            apiRequestBody.logprobs = true;
        }

        // Reasoning effort gating.
        const azureFixed = OPENAI_FIXED_REASONING_EFFORT[body.model];
        const supportsAzureReasoningEffort = OPENAI_REASONING_EFFORT_MODELS.includes(body.model)
            || resolveOpenAIModelCapabilities(body.model).supportsReasoningEffort;
        apiRequestBody.reasoning_effort = supportsAzureReasoningEffort
            ? (azureFixed ?? resolveOpenAIEffort(body.reasoning_effort, body.model))
            : undefined;

        const url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
        url.searchParams.set('api-version', azure_api_version);
        const fetchUrl = url.toString();

        console.info(`Sending request to Azure OpenAI: ${fetchUrl}`);
        console.debug('Azure OpenAI Request Body:', apiRequestBody);

        const headers = {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        };
        applyAdditionalParameters(apiRequestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['api-key']), apiRequestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(apiRequestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'Azure OpenAI',
            stream: Boolean(apiRequestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'Azure OpenAI');
    }
}
