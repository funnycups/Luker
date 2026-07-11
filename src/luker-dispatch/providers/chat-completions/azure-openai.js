// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Azure OpenAI chat completions. Extracted from legacy
// `sendAzureOpenAIRequest` (src/endpoints/backends/chat-completions.js:2064-2157).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe). Azure OpenAI specifics:
//   - URL is constructed from body.azure_base_url +
//     `/openai/deployments/${azure_deployment_name}/chat/completions`
//     with `?api-version={azure_api_version}` query param.
//   - Auth uses `api-key` header (Azure convention), NOT `Authorization: Bearer`.
//   - Request body is whitelist-copied from AZURE_OPENAI_KEYS only.
//   - json_schema translated to Azure/OpenAI-native response_format shape
//     (name/strict/schema; strict defaults to true if not specified).
//   - logprobs>0 (numeric) is translated to top_logprobs + boolean logprobs.
//   - reasoning_effort is only set for models in OPENAI_REASONING_EFFORT_MODELS,
//     honoring OPENAI_FIXED_REASONING_EFFORT and OPENAI_REASONING_EFFORT_MAP.

import {
    AZURE_OPENAI_KEYS,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

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
    const apiKey = ctx.secrets.read(SECRET_KEYS.AZURE_OPENAI) || '';

    const { azure_base_url, azure_deployment_name, azure_api_version } = body;
    if (!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey) {
        ctx.emit.error(new Error('Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings.'));
        return;
    }

    ctx.inspection.start();

    try {
        // Whitelist body fields per AZURE_OPENAI_KEYS.
        const apiRequestBody = /** @type {any} */ ({});
        for (const key of AZURE_OPENAI_KEYS) {
            if (Object.hasOwn(body, key)) {
                apiRequestBody[key] = body[key];
            }
        }

        // Structured Output translation.
        if (body.json_schema) {
            apiRequestBody['response_format'] = {
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
        apiRequestBody['reasoning_effort'] = OPENAI_REASONING_EFFORT_MODELS.includes(body.model)
            ? OPENAI_FIXED_REASONING_EFFORT[body.model] ?? OPENAI_REASONING_EFFORT_MAP[body.reasoning_effort] ?? body.reasoning_effort
            : undefined;

        const url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
        url.searchParams.set('api-version', azure_api_version);
        const fetchUrl = url.toString();
        ctx.inspection.attach(fetchUrl, apiKey, apiRequestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(apiRequestBody),
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
            },
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: resp.status, headers: {} });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `Azure OpenAI upstream ${resp.status}: ${errText}`;
            ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
            // Surface upstream status + body to the client via chunk + end
            // (head already emitted above). Client sees
            // Response.status=<upstream> and Response.body readable so
            // callers can do `await response.text()` or
            // `await response.json()` for structured error inspection
            // (matches legacy handler shape which returned
            // `.status(4xx).send({error:{...}})`).
            if (errText) {
                ctx.emit.chunk(new TextEncoder().encode(errText));
            }
            ctx.emit.end();
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
