// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Adapters between the OpenAI Responses wire format (/v1/responses) and the
 * Chat Completions shapes that the rest of this client consumes. The server
 * proxy forwards upstream bytes verbatim, so these run in the browser.
 * Zero dependencies — must stay importable from Jest (node environment).
 */

/**
 * Create a stateful adapter turning one Responses streaming event into an
 * equivalent chat-completions chunk (or null for lifecycle-only events).
 * The state tracks in-progress function_call items so argument deltas can be
 * attributed to the right parallel call slot.
 *
 * Throws on terminal failure events (`response.failed` / `error`).
 *
 * @returns {(event: object) => object|null}
 */
export function createResponsesEventAdapter() {
    /** @type {Map<number, {position: number, id: string, name: string, arguments: string}>} */
    const callsByOutputIndex = new Map();
    let nextPosition = 0;

    return function responsesEventToChatChunk(event) {
        const type = String(event?.type || '');

        switch (type) {
            case 'response.created':
            case 'response.in_progress':
            case 'response.output_item.added':
            case 'response.output_item.done':
            case 'response.content_part.added':
            case 'response.content_part.done': {
                if (type !== 'response.output_item.added') return null;
                const item = event.item;
                if (item?.type !== 'function_call') return null;
                const position = nextPosition++;
                callsByOutputIndex.set(Number(event.output_index), {
                    position,
                    id: String(item.call_id || item.id || ''),
                    name: String(item.name || ''),
                    arguments: '',
                });
                return {
                    choices: [{
                        index: 0,
                        delta: { tool_calls: [{ index: position, id: String(item.call_id || item.id || ''), type: 'function', function: { name: String(item.name || ''), arguments: '' } }] },
                        finish_reason: null,
                    }],
                };
            }

            case 'response.output_text.delta':
                return { choices: [{ index: 0, delta: { content: String(event.delta ?? '') }, finish_reason: null }] };

            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                return { choices: [{ index: 0, delta: { reasoning_content: String(event.delta ?? '') }, finish_reason: null }] };

            case 'response.function_call_arguments.delta': {
                const entry = callsByOutputIndex.get(Number(event.output_index));
                if (!entry) return null;
                const piece = String(event.delta ?? '');
                entry.arguments += piece;
                return {
                    choices: [{
                        index: 0,
                        delta: { tool_calls: [{ index: entry.position, function: { arguments: piece } }] },
                        finish_reason: null,
                    }],
                };
            }

            case 'response.completed': {
                const resp = event.response || {};
                const hasToolCalls = callsByOutputIndex.size > 0;
                return {
                    choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
                    ...(resp.usage ? { usage: mapUsage(resp.usage) } : {}),
                };
            }

            case 'response.incomplete':
                return {
                    choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
                    ...((event.response || {}).usage ? { usage: mapUsage(event.response.usage) } : {}),
                };

            case 'response.failed':
            case 'error':
                throw new Error(
                    event?.response?.error?.message
                    || event?.error?.message
                    || event?.message
                    || 'Responses upstream error',
                );

            default:
                return null;
        }
    };
}

/**
 * Convert a complete (non-streaming) Responses result object into the
 * chat.completion shape consumed by the non-streaming branch of
 * sendOpenAIRequest.
 * @param {object} responseObj Responses result
 * @returns {object} chat.completion-shaped object
 */
export function responsesResultToChatCompletion(responseObj) {
    if (String(responseObj?.status || '') === 'failed') {
        const message = String(responseObj?.error?.message || '') || 'Responses upstream request failed';
        throw new Error(message);
    }

    /** @type {string} */
    let content = '';
    /** @type {string[]} */
    const reasoningParts = [];
    /** @type {object[]} */
    const toolCalls = [];

    for (const item of Array.isArray(responseObj?.output) ? responseObj.output : []) {
        if (item?.type === 'message') {
            for (const part of Array.isArray(item.content) ? item.content : []) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    content += part.text;
                }
            }
        } else if (item?.type === 'reasoning') {
            for (const summary of Array.isArray(item.summary) ? item.summary : []) {
                if (summary?.type === 'summary_text' && typeof summary.text === 'string') {
                    reasoningParts.push(summary.text);
                }
            }
        } else if (item?.type === 'function_call') {
            toolCalls.push({
                id: String(item.call_id || item.id || ''),
                type: 'function',
                function: { name: String(item.name || ''), arguments: String(item.arguments || '{}') },
            });
        }
        // web_search_call / file_search_call etc. carry no displayable text;
        // skip them.
    }

    /** @type {any} */
    const message = { role: 'assistant', content };
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
        object: 'chat.completion',
        choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0
                ? 'tool_calls'
                : (String(responseObj?.status || '') === 'incomplete' ? 'length' : 'stop'),
        }],
        ...(responseObj?.usage ? { usage: mapUsage(responseObj.usage) } : {}),
    };
}

function mapUsage(usage) {
    const promptTokens = Number(usage?.input_tokens ?? 0);
    const completionTokens = Number(usage?.output_tokens ?? 0);
    const totalTokens = Number.isFinite(Number(usage?.total_tokens))
        ? Number(usage.total_tokens)
        : (Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : 0);
    return {
        prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
        total_tokens: totalTokens,
    };
}
