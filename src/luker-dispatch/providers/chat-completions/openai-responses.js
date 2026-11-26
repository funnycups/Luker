// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// OpenAI Responses API chat-completion dispatch. Speaks the /v1/responses
// wire format: chat-completions generate_data is mapped onto a Responses
// request body (instructions/input/tools/reasoning), and the upstream response
// is relayed verbatim for client and inspector parsing through the shared
// protocol parser.
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { excludeKeysByYaml } from '../../../util.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { resolveOpenAIEffort } from './reasoning-params.js';
import {
    handleProviderDispatchError,
    relayUpstreamResponse,
} from './upstream-relay.js';
import {
    openAIResponsesSupportsSampling,
    resolveOpenAIModelCapabilities,
} from '../../../../public/scripts/lib/provider-capabilities.js';

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
 * Attach `reasoning.encrypted_content` to `requestBody.include` whenever
 * reasoning is active and stateless (`store === false`). Runs after additional
 * parameter overrides in `dispatchOpenAIResponses` so `store: true` or
 * `reasoning.effort: 'none'` overrides suppress encrypted reasoning inclusion,
 * and user-provided `include` entries are preserved.
 * @param {Record<string, any>} requestBody
 * @param {object} body
 */
function applyResponsesEncryptedReasoningInclude(requestBody, body) {
    if (requestBody.store !== false) {
        return;
    }
    const model = requestBody.model ?? body?.model;
    const caps = resolveOpenAIModelCapabilities(model);
    if (caps.isKnownNonReasoningModel) {
        return;
    }
    const effort = requestBody.reasoning && typeof requestBody.reasoning === 'object'
        ? requestBody.reasoning.effort
        : resolveOpenAIEffort(body?.reasoning_effort, model, { responsesApi: true });
    if (effort === 'none') {
        return;
    }
    const reasoningActive = Boolean(requestBody.reasoning) || caps.supportsReasoningEffort;
    if (!reasoningActive) {
        return;
    }
    if (Array.isArray(requestBody.include)) {
        if (!requestBody.include.includes('reasoning.encrypted_content')) {
            requestBody.include.push('reasoning.encrypted_content');
        }
    } else if (requestBody.include === undefined) {
        requestBody.include = ['reasoning.encrypted_content'];
    }
}

function canReplayResponsesOutputItems(message) {
    if (message?.role !== 'assistant' || !Array.isArray(message.responses_output_items) || message.responses_output_items.length === 0) {
        return false;
    }
    if (Array.isArray(message.content)) {
        return false;
    }
    const items = message.responses_output_items.filter(item => item && typeof item === 'object');
    if (items.length === 0) {
        return false;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const nativeCalls = items.filter(item => item.type === 'function_call');
    if (nativeCalls.length !== toolCalls.length) {
        return false;
    }
    if (toolCalls.length > 0) {
        const nativeCallIds = new Set(
            nativeCalls
                .map(item => String(item.call_id || item.id || ''))
                .filter(Boolean),
        );
        for (const tc of toolCalls) {
            if (!tc?.id || !nativeCallIds.has(String(tc.id))) {
                return false;
            }
        }
    }
    if (typeof message.content === 'string') {
        const expectedText = message.content.replace(/\r/g, '').trim();
        const textParts = [];
        const refusalParts = [];
        for (const item of items) {
            if (item.type !== 'message' || !Array.isArray(item.content)) continue;
            for (const part of item.content) {
                if (!part || typeof part !== 'object') continue;
                if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
                    textParts.push(part.text);
                } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
                    refusalParts.push(part.refusal);
                }
            }
        }
        const nativeText = (textParts.length > 0 ? textParts.join('') : refusalParts.join('')).replace(/\r/g, '').trim();
        if (expectedText !== nativeText) {
            return false;
        }
    }
    return true;
}

/**
 * Build a Responses API request body from ST chat-completions generate_data.
 * Chat parameters with no Responses equivalent (stop / logit_bias / n /
 * penalties / seed) are intentionally dropped; they can be injected via the
 * CUSTOM-shared custom_include_body YAML blob.
 * @param {object} body generate_data
 * @param {{ applyEncryptedInclude?: boolean }} [options]
 * @returns {object} Responses create-request body
 */
export function buildResponsesRequestBody(body, { applyEncryptedInclude = true } = {}) {
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
        if (canReplayResponsesOutputItems(message)) {
            // Replay exact finalized Responses output items verbatim in original order
            // (preserving reasoning id/summary/encrypted_content, message id/metadata,
            // and function_call items for stateless store:false continuation).
            for (const item of message.responses_output_items) {
                if (item && typeof item === 'object') {
                    input.push(structuredClone(item));
                }
            }
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

    const caps = resolveOpenAIModelCapabilities(body.model);
    const responsesEffort = resolveOpenAIEffort(body.reasoning_effort, body.model, { responsesApi: true });
    if (!caps.isKnownNonReasoningModel && (responsesEffort || body.include_reasoning)) {
        requestBody.reasoning = {};
        if (responsesEffort) requestBody.reasoning.effort = responsesEffort;
        if (body.include_reasoning && responsesEffort !== 'none') requestBody.reasoning.summary = 'auto';
    }

    if (openAIResponsesSupportsSampling(body.model, responsesEffort)) {
        const temperature = Number(body.temperature);
        if (Number.isFinite(temperature)) requestBody.temperature = temperature;
        const topP = Number(body.top_p);
        if (Number.isFinite(topP)) requestBody.top_p = topP;
    }

    if (body.json_schema) {
        requestBody.text = {
            format: {
                type: 'json_schema',
                name: body.json_schema.name || 'response',
                ...(body.json_schema.description ? { description: body.json_schema.description } : {}),
                schema: body.json_schema.value,
                strict: body.json_schema.strict ?? true,
            },
        };
    }

    if (body.verbosity && caps.supportsVerbosity) {
        requestBody.text ??= {};
        requestBody.text.verbosity = body.verbosity;
    }

    /** @type {object[]} */
    const tools = [];
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (tool?.type === 'function' && tool.function?.name) {
                const fnTool = {
                    type: 'function',
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                };
                if (typeof tool.function.strict === 'boolean') {
                    fnTool.strict = tool.function.strict;
                }
                tools.push(fnTool);
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

    if (applyEncryptedInclude) {
        applyResponsesEncryptedReasoningInclude(requestBody, body);
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
        const apiUrl = normalizeProviderBaseUrl('openai_responses', body.responses_url || DEFAULT_RESPONSES_BASE_URL);
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
        const requestBody = buildResponsesRequestBody(body, { applyEncryptedInclude: false });
        applyAdditionalParameters(requestBody, headers, body);
        applyResponsesEncryptedReasoningInclude(requestBody, body);
        excludeKeysByYaml(requestBody, body?.custom_exclude_body);

        const endpointUrl = `${apiUrl}/responses`;
        const requestHeaders = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            ...headers,
        };
        ctx.inspection.attach(endpointUrl, resolveEffectiveApiKey(requestHeaders, apiKey, ['authorization']), requestBody);

        console.debug('Responses request:', requestBody);

        const resp = await ctx.fetch(endpointUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'Responses',
            stream: Boolean(requestBody.stream),
            logResponse: (json) => console.debug('Responses result:', json?.status),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'Responses');
    }
}
