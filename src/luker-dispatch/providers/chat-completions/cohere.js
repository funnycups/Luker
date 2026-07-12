// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Cohere chat completions. Extracted from legacy
// `sendCohereRequest` (src/endpoints/backends/chat-completions.js:1328-1423).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe).
//
// COHERE-specific note: unlike other providers, the legacy non-streaming
// path transforms the upstream Cohere JSON into OAI chat-completion shape
// via `normalizeCohereResponseToOAI` before returning to the caller. We
// preserve that transformation here — the emitted chunk carries the
// normalized JSON, not the raw upstream body. Streaming pass-through
// remains verbatim (upstream SSE bytes are relayed unchanged), matching
// legacy `forwardStreamingResponseWithJob` behavior.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { convertCohereMessages, getPromptNames } from '../../../prompt-converters.js';
import { normalizeCohereResponseToOAI } from '../../../endpoints/backends/chat-completions.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

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
        };

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

        const fetchUrl = API_COHERE_V2 + '/chat';
        ctx.inspection.attach(fetchUrl, apiKey, requestBody);

        console.debug('Cohere request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
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
            console.warn(`Cohere API returned error: ${resp.status} ${resp.statusText} ${errText}`);
            const msg = `Cohere upstream ${resp.status}: ${errText}`;
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
            // Legacy sendCohereRequest returns `normalizeCohereResponseToOAI(rawJson)`
            // to the client, not the raw upstream body. Preserve that shape here.
            const rawJson = await resp.json();
            console.debug('Cohere response:', rawJson);
            const normalized = normalizeCohereResponseToOAI(rawJson);
            const bytes = new TextEncoder().encode(JSON.stringify(normalized));
            ctx.emit.chunk(bytes);
            ctx.emit.end();
            // Cohere's raw response carries usage.tokens.{input,output} on a
            // shape the OAI-normalized reply doesn't expose (normalized only
            // has flat usage.prompt_tokens / completion_tokens). The
            // inspector currently only special-cases source='claude' /
            // 'makersuite' / 'vertexai' for rawApiResponse-derived usage,
            // so this call is a forward-compat wiring: today
            // extractUsageFromOAI on the normalized payload is what fills
            // the entry, but passing the raw body means a future
            // extractUsageFromCohere addition (tool_plan reasoning tokens,
            // citations, cache metrics) has the source-of-truth data
            // available without touching this call site again.
            try { ctx.inspection.complete(normalized, rawJson); }
            catch { /* inspection best-effort */ }
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        console.error('Error communicating with Cohere API: ', err);
        ctx.emit.error(err);
    }
}
