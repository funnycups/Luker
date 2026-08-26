// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// OpenAI Responses API chat-completion dispatch. Speaks the /v1/responses
// wire format: ST's chat-completions generate_data is mapped onto a
// Responses request body (instructions/input/tools/reasoning), the upstream
// response is passed through verbatim — streaming SSE frames are semantic
// Responses events that the browser adapts into chat chunks (see
// public/scripts/openai-responses.js).
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express.

import { OPENAI_REASONING_EFFORT_MAP } from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import {
    excludeKeysByYaml,
    mergeObjectWithYaml,
    normalizeOpenAIBaseUrl,
} from '../../../util.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const DEFAULT_RESPONSES_BASE_URL = 'https://api.openai.com/v1';

/**
 * Stringify an ST message content value (string or content-part array) to
 * plain text. Only text-bearing parts contribute; other part types are
 * skipped here because they are handled structurally elsewhere.
 * @param {any} content
 * @returns {string}
 */
function stringifyMessageContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('');
}

/**
 * Map one ST message content value onto a Responses input content value.
 * Strings pass through; content-part arrays map text/image_url parts onto
 * input_text / input_image parts (image_url.url may itself be a string in
 * some shapes, so accept both).
 * @param {any} content
 * @returns {string|object[]}
 */
function convertMessageContent(content) {
    if (!Array.isArray(content)) {
        return stringifyMessageContent(content);
    }
    /** @type {object[]} */
    const parts = [];
    for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'input_text', text: part.text });
        } else if (part?.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (typeof url === 'string' && url.length > 0) {
                parts.push({ type: 'input_image', image_url: url });
            }
        }
        // Other part types have no Responses equivalent here; drop them.
    }
    return parts.length > 0 ? parts : '';
}

/**
 * Build a Responses API request body from ST chat-completions generate_data.
 * Chat parameters with no Responses equivalent (stop / logit_bias / n /
 * penalties / seed) are intentionally dropped; they can be injected via the
 * CUSTOM-shared custom_include_body YAML blob.
 * @param {object} body generate_data
 * @returns {object} Responses create-request body
 */
export function buildResponsesRequestBody(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    /** @type {string[]} */
    const instructionsParts = [];
    /** @type {object[]} */
    const input = [];
    for (const message of messages) {
        const role = String(message?.role || '');
        if (role === 'system' || role === 'developer') {
            const text = stringifyMessageContent(message.content);
            if (text) instructionsParts.push(text);
            continue;
        }
        if (role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: String(message.tool_call_id || ''),
                output: stringifyMessageContent(message.content),
            });
            continue;
        }
        if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const text = stringifyMessageContent(message.content);
            if (text) input.push({ role: 'assistant', content: text });
            for (const toolCall of message.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: String(toolCall.id || ''),
                    name: String(toolCall.function?.name || ''),
                    arguments: String(toolCall.function?.arguments || '{}'),
                });
            }
            continue;
        }
        input.push({
            role: role === 'assistant' ? 'assistant' : 'user',
            content: convertMessageContent(message.content),
        });
    }

    /** @type {any} */
    const requestBody = {
        model: body.model,
        input,
        stream: Boolean(body.stream),
        store: false,
    };
    if (instructionsParts.length > 0) {
        requestBody.instructions = instructionsParts.join('\n\n');
    }

    const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
        requestBody.max_output_tokens = maxTokens;
    }

    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature)) requestBody.temperature = temperature;
    const topP = Number(body.top_p);
    if (Number.isFinite(topP)) requestBody.top_p = topP;

    if (body.reasoning_effort || body.include_reasoning) {
        requestBody.reasoning = {};
        if (body.reasoning_effort) {
            requestBody.reasoning.effort = OPENAI_REASONING_EFFORT_MAP[body.reasoning_effort] ?? body.reasoning_effort;
        }
        if (body.include_reasoning) {
            requestBody.reasoning.summary = 'auto';
        }
    }

    /** @type {object[]} */
    const tools = [];
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (tool?.type === 'function' && tool.function?.name) {
                tools.push({
                    type: 'function',
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                });
            }
        }
    }
    if (body.enable_web_search) {
        tools.push({ type: 'web_search' });
    }
    if (tools.length > 0) requestBody.tools = tools;

    if (body.tool_choice != null) {
        if (typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function') {
            requestBody.tool_choice = { type: 'function', name: body.tool_choice.function?.name };
        } else {
            requestBody.tool_choice = body.tool_choice;
        }
    }

    return requestBody;
}

/**
 * Dispatch a chat-completion request over the OpenAI Responses wire format.
 * Results flow via ctx.emit.{head,chunk,end,error}. Never touches Express.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchOpenAIResponses(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();

    try {
        const apiUrl = normalizeOpenAIBaseUrl(body.responses_url || DEFAULT_RESPONSES_BASE_URL);
        const apiKey = ctx.secrets.read(SECRET_KEYS.OPENAI_RESPONSES);

        if (!apiKey && !body.responses_url) {
            console.warn('OpenAI Responses API key is missing.');
            const err = new Error('OpenAI Responses API key is missing.');
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }

        /** @type {any} */
        const headers = {};
        mergeObjectWithYaml(headers, body.custom_include_headers);

        const requestBody = buildResponsesRequestBody(body);
        mergeObjectWithYaml(requestBody, body.custom_include_body);
        excludeKeysByYaml(requestBody, body.custom_exclude_body);

        const endpointUrl = `${apiUrl}/responses`;
        ctx.inspection.attach(endpointUrl, apiKey, requestBody);

        console.debug('Responses request:', requestBody);

        const resp = await ctx.fetch(endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        // Architectural contract: exactly one head frame right after the
        // upstream fetch resolves (see openai-compatible.js for rationale).
        ctx.emit.head({ status: resp.status, headers: resp.headers });

        if (!resp.ok) {
            let errText = '';
            try { errText = await resp.text(); } catch { /* body already consumed */ }
            console.error('Responses request error: ', errText);
            const err = new Error(`Responses upstream ${resp.status}: ${errText}`);
            ctx.inspection.fail(err, resp?.status ?? 502);
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
            try {
                const json = JSON.parse(new TextDecoder().decode(buf));
                console.debug('Responses result:', json?.status);
            } catch { /* non-JSON body — skip debug log */ }
            ctx.emit.chunk(new Uint8Array(buf));
            ctx.emit.end();
        }
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        console.error('Generation failed', err);
        ctx.emit.error(err);
    }
}
