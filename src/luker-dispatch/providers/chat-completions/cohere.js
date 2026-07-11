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
    const apiKey = ctx.secrets.read(SECRET_KEYS.COHERE) || '';

    if (!apiKey) {
        ctx.emit.error(new Error('Cohere API key is missing'));
        return;
    }

    ctx.inspection.start();

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

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
        });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            const msg = `Cohere upstream ${resp.status}: ${errText}`;
            ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
            ctx.emit.error(new Error(msg));
            return;
        }

        if (body.stream) {
            await pipeResponseBodyToEmit(resp, ctx);
        } else {
            // Legacy sendCohereRequest returns `normalizeCohereResponseToOAI(rawJson)`
            // to the client, not the raw upstream body. Preserve that shape here.
            const rawJson = await resp.json();
            const normalized = normalizeCohereResponseToOAI(rawJson);
            const bytes = new TextEncoder().encode(JSON.stringify(normalized));
            ctx.emit.chunk(bytes);
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
