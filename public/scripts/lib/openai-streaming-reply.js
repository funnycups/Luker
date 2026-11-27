// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure streaming-frame reply/reasoning extractor across chat-completion providers.
 * Re-exported by `public/scripts/openai.js` as `chat_completion_sources` and
 * `getStreamingReply` without pulling browser/DOM modules into pure consumers.
 */

import { pushReasoningDetails } from '../util/reasoning-details.js';

export const chat_completion_sources = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    AI21: 'ai21',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    OPENAI_RESPONSES: 'openai_responses',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    ELECTRONHUB: 'electronhub',
    CHUTES: 'chutes',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    WORKERS_AI: 'workers_ai',
    MINIMAX: 'minimax',
};

const DATA_URL_REGEX = /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)*;?)?(base64)?,([a-z0-9!$&',()*+;=\-_%.~:@/?#]+)?$/i;

function isDataURL(str) {
    return typeof str === 'string' && DATA_URL_REGEX.test(str);
}

const OPENAI_COMPAT_REASONING_SOURCES = new Set([
    chat_completion_sources.CUSTOM,
    chat_completion_sources.POLLINATIONS,
    chat_completion_sources.AIMLAPI,
    chat_completion_sources.MOONSHOT,
    chat_completion_sources.COMETAPI,
    chat_completion_sources.ELECTRONHUB,
    chat_completion_sources.NANOGPT,
    chat_completion_sources.ZAI,
    chat_completion_sources.SILICONFLOW,
    chat_completion_sources.CHUTES,
    chat_completion_sources.WORKERS_AI,
    chat_completion_sources.FIREWORKS,
    chat_completion_sources.MINIMAX,
]);

/**
 * Extract incremental reply text and update streaming state (reasoning, blocks,
 * details, images, signatures) from one provider SSE frame.
 *
 * @param {object} data
 * @param {object} [state={}]
 * @param {{ chatCompletionSource: string, showThoughts?: boolean }} options
 * @returns {string}
 */
export function extractStreamingReply(data, state = {}, { chatCompletionSource, showThoughts = false }) {
    const targetState = state && typeof state === 'object' ? state : {};

    if (chatCompletionSource === chat_completion_sources.CLAUDE) {
        if (data?.type === 'content_block_start' && data?.content_block && Number.isInteger(data?.index)) {
            if (!Array.isArray(targetState.reasoningBlocks)) {
                targetState.reasoningBlocks = [];
            }
            const block = data.content_block;
            if (block.type === 'thinking') {
                targetState.reasoningBlocks[data.index] = { type: 'thinking', thinking: String(block.thinking || '') };
            } else if (block.type === 'redacted_thinking') {
                targetState.reasoningBlocks[data.index] = { type: 'redacted_thinking', data: String(block.data || '') };
            }
        } else if (data?.type === 'content_block_delta' && data?.delta && Number.isInteger(data?.index)) {
            const existing = Array.isArray(targetState.reasoningBlocks) ? targetState.reasoningBlocks[data.index] : null;
            if (existing) {
                if (data.delta.type === 'thinking_delta' && existing.type === 'thinking') {
                    existing.thinking += String(data.delta.thinking || '');
                } else if (data.delta.type === 'signature_delta' && existing.type === 'thinking') {
                    existing.signature = (existing.signature || '') + String(data.delta.signature || '');
                }
            }
        }
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (data?.delta?.thinking || '');
        }
        return data?.delta?.text || '';
    }

    if (chatCompletionSource === chat_completion_sources.MAKERSUITE || chatCompletionSource === chat_completion_sources.VERTEXAI) {
        const inlineData = data?.candidates?.[0]?.content?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData) || [];
        if (Array.isArray(inlineData) && inlineData.length > 0) {
            if (!Array.isArray(targetState.images)) {
                targetState.images = [];
            }
            targetState.images.push(...inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL));
        }
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (data?.candidates?.[0]?.content?.parts?.filter(x => x.thought)?.map(x => x.text)?.[0] || '');
        }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        parts.forEach((part) => {
            if (part?.thoughtSignature && typeof part.text === 'string') {
                targetState.signature = part.thoughtSignature;
            }
        });
        return data?.candidates?.[0]?.content?.parts?.filter(x => !x.thought)?.map(x => x.text)?.[0] || '';
    }

    if (chatCompletionSource === chat_completion_sources.COHERE) {
        return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
    }

    if (chatCompletionSource === chat_completion_sources.DEEPSEEK || chatCompletionSource === chat_completion_sources.XAI) {
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (data?.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '');
        }
        return data?.choices?.[0]?.delta?.content || '';
    }

    if (chatCompletionSource === chat_completion_sources.OPENROUTER) {
        const imageUrls = data?.choices?.[0]?.delta?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url) || [];
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            if (!Array.isArray(targetState.images)) {
                targetState.images = [];
            }
            targetState.images.push(...imageUrls.filter(isDataURL));
        }
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (
                data?.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                data?.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data?.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning ??
                data?.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content ??
                ''
            );
        }
        pushReasoningDetails(targetState, [
            ...(data?.choices?.[0]?.delta?.reasoning_details || []),
            ...(data?.choices?.[0]?.message?.reasoning_details || []),
        ]);
        return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    }

    if (chatCompletionSource === chat_completion_sources.OPENAI_RESPONSES) {
        const eventType = typeof data?.type === 'string' ? data.type : '';
        if (eventType === 'response.output_text.delta' && typeof data.delta === 'string') {
            return data.delta;
        }
        if ((eventType === 'response.reasoning_text.delta' || eventType === 'response.reasoning_summary_text.delta') && typeof data.delta === 'string') {
            if (showThoughts) {
                targetState.reasoning = (targetState.reasoning || '') + data.delta;
            }
            return '';
        }
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (
                data?.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data?.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                ''
            );
        }
        return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    }

    if (OPENAI_COMPAT_REASONING_SOURCES.has(chatCompletionSource)) {
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (
                data?.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data?.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                ''
            );
        }
        return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    }

    if (chatCompletionSource === chat_completion_sources.MISTRALAI) {
        if (showThoughts) {
            targetState.reasoning = (targetState.reasoning || '') + (data?.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '');
        }
        const content = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
        return Array.isArray(content) ? content.map(x => x.text).filter(x => x).join('') : content;
    }

    return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
}
