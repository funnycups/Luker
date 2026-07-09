/* eslint-disable dot-notation */
import express from 'express';
import fetch from 'node-fetch';
import urlJoin from 'url-join';

import {
    AIMLAPI_HEADERS,
    CHAT_COMPLETION_SOURCES,
    OPENROUTER_HEADERS,
    SILICONFLOW_ENDPOINT,
} from '../../constants.js';
import {
    color,
    getConfigValue,
    mergeObjectWithYaml,
    normalizeOpenAIBaseUrl,
    trimTrailingSlash,
    uuidv4,
} from '../../util.js';
import {
    getPromptNames,
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
} from '../../prompt-converters.js';

import { readSecret, SECRET_KEYS, readProviderSecret } from '../secrets.js';
import {
    getTokenizerModel,
    getSentencepiceTokenizer,
    getTiktokenTokenizer,
    sentencepieceTokenizers,
    webTokenizers,
    getWebTokenizer,
} from '../tokenizers.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';
import {
    cancelGenerationJobForRequest,
    getActiveGenerationJobsForRequest,
    getGenerationJobForRequest,
    subscribeToJob,
} from './luker-generation.js';
import { runLukerDispatch } from '../../luker-dispatch/runner.js';
import { dispatchClaude } from '../../luker-dispatch/providers/chat-completions/claude.js';
import { dispatchAI21 } from '../../luker-dispatch/providers/chat-completions/ai21.js';
import { dispatchMakerSuite } from '../../luker-dispatch/providers/chat-completions/makersuite.js';
import { dispatchMistralAI } from '../../luker-dispatch/providers/chat-completions/mistralai.js';
import { dispatchCohere } from '../../luker-dispatch/providers/chat-completions/cohere.js';
import { dispatchDeepSeek } from '../../luker-dispatch/providers/chat-completions/deepseek.js';
import { dispatchXai } from '../../luker-dispatch/providers/chat-completions/xai.js';
import { dispatchAimlapi } from '../../luker-dispatch/providers/chat-completions/aimlapi.js';
import { dispatchChutes } from '../../luker-dispatch/providers/chat-completions/chutes.js';
import { dispatchMinimax } from '../../luker-dispatch/providers/chat-completions/minimax.js';
import { dispatchElectronHub } from '../../luker-dispatch/providers/chat-completions/electronhub.js';
import { dispatchAzureOpenAI } from '../../luker-dispatch/providers/chat-completions/azure-openai.js';
import { dispatchOpenAICompatible } from '../../luker-dispatch/providers/chat-completions/openai-compatible.js';

const API_OPENAI = 'https://api.openai.com/v1';
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/beta';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';

const CLAUDE_STOP_REASON_TO_OAI = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    pause_turn: 'stop',
    refusal: 'content_filter',
};

/**
 * Normalize a Claude usage object into OpenAI snake_case shape:
 * `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details? }`.
 * `prompt_tokens_details` is emitted only when Claude reports cache reads
 * or writes; OpenAI itself uses the same `cached_tokens` key on that
 * sub-object, so downstream `usage` consumers see one shape across providers.
 * Returns `undefined` if the source has no usage fields at all.
 * @param {any} raw Claude `usage` object
 * @returns {object|undefined}
 */
function normalizeClaudeUsage(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const promptTokens = Number(raw.input_tokens);
    const completionTokens = Number(raw.output_tokens);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
    const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
    const completion = Number.isFinite(completionTokens) ? completionTokens : 0;
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
    };
    const cacheRead = Number(raw.cache_read_input_tokens);
    const cacheCreate = Number(raw.cache_creation_input_tokens);
    const details = {};
    if (Number.isFinite(cacheRead)) details.cached_tokens = cacheRead;
    if (Number.isFinite(cacheCreate)) details.cache_creation_tokens = cacheCreate;
    if (Object.keys(details).length) out.prompt_tokens_details = details;
    return out;
}

/**
 * Normalize a Gemini `usageMetadata` object into OpenAI snake_case shape.
 * Gemini reports `thoughtsTokenCount` separately from `candidatesTokenCount`;
 * those reasoning tokens are billed as output, so they are folded into
 * `completion_tokens` and additionally surfaced under
 * `completion_tokens_details.reasoning_tokens` (the OpenAI o-series shape).
 * Returns `undefined` if the source has no usage fields at all.
 * @param {any} meta Gemini `usageMetadata` object
 * @returns {object|undefined}
 */
function normalizeGeminiUsage(meta) {
    if (!meta || typeof meta !== 'object') return undefined;
    const promptTokens = Number(meta.promptTokenCount);
    const candidatesTokens = Number(meta.candidatesTokenCount);
    const thoughtsTokens = Number(meta.thoughtsTokenCount);
    const totalTokens = Number(meta.totalTokenCount);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(candidatesTokens) && !Number.isFinite(totalTokens)) {
        return undefined;
    }
    const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
    const candidates = Number.isFinite(candidatesTokens) ? candidatesTokens : 0;
    const thoughts = Number.isFinite(thoughtsTokens) ? thoughtsTokens : 0;
    const completion = candidates + thoughts;
    const total = Number.isFinite(totalTokens) ? totalTokens : (prompt + completion);
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    };
    const cached = Number(meta.cachedContentTokenCount);
    if (Number.isFinite(cached)) {
        out.prompt_tokens_details = { cached_tokens: cached };
    }
    if (Number.isFinite(thoughtsTokens)) {
        out.completion_tokens_details = { reasoning_tokens: thoughts };
    }
    return out;
}

/**
 * Normalize a Cohere v2 usage object into OpenAI snake_case shape. Prefers
 * Cohere's `billed_units` (the chargeable counts) over `tokens` (raw counts
 * that include system prompts). Also accepts already-OpenAI-shaped usage
 * for forward-compat with future Cohere endpoints or proxies.
 * Returns `undefined` if the source has no usage fields at all.
 * @param {any} raw Cohere `usage` object
 * @returns {object|undefined}
 */
function normalizeCohereUsage(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const billed = raw.billed_units;
    const tokens = raw.tokens;
    const candidate = (billed && typeof billed === 'object') ? billed
        : (tokens && typeof tokens === 'object') ? tokens
            : raw;
    const prompt = Number(candidate.input_tokens ?? candidate.prompt_tokens);
    const completion = Number(candidate.output_tokens ?? candidate.completion_tokens);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined;
    const p = Number.isFinite(prompt) ? prompt : 0;
    const c = Number.isFinite(completion) ? completion : 0;
    return {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: p + c,
    };
}

/**
 * Normalize a non-streaming Claude Messages API response into OAI chat-completion shape.
 * Preserves the original `content` array on the reply for callers that still need it.
 * @param {any} raw Claude response JSON
 * @returns {object} OAI chat-completion shaped reply
 */
export function normalizeClaudeResponseToOAI(raw) {
    const content = Array.isArray(raw?.content) ? raw.content : [];
    let text = '';
    let thinking = '';
    const toolCalls = [];
    // Anthropic requires thinking / redacted_thinking blocks to be echoed verbatim
    // in subsequent turns (including their signature field). Preserve them here
    // so downstream can round-trip the full block on the next request.
    const reasoningBlocks = [];

    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const type = String(block.type || '');
        if (type === 'text') {
            text += String(block.text || '');
        } else if (type === 'thinking') {
            thinking += String(block.thinking || '');
            const preserved = { type: 'thinking', thinking: String(block.thinking || '') };
            if (typeof block.signature === 'string' && block.signature.length > 0) {
                preserved.signature = block.signature;
            }
            reasoningBlocks.push(preserved);
        } else if (type === 'redacted_thinking') {
            reasoningBlocks.push({ type: 'redacted_thinking', data: String(block.data || '') });
        } else if (type === 'tool_use') {
            toolCalls.push({
                id: String(block.id || ''),
                type: 'function',
                function: {
                    name: String(block.name || ''),
                    arguments: JSON.stringify(block.input ?? {}),
                },
            });
        }
        // tool_result / server_tool_use stay accessible via reply.content.
    }

    const message = { role: 'assistant', content: text };
    if (thinking) message.reasoning_content = thinking;
    if (reasoningBlocks.length) message.reasoning_blocks = reasoningBlocks;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const finishReason = CLAUDE_STOP_REASON_TO_OAI[String(raw?.stop_reason || '')] ?? 'stop';

    const reply = {
        choices: [{ message, finish_reason: finishReason, index: 0 }],
        content,
    };
    const usage = normalizeClaudeUsage(raw?.usage);
    if (usage) reply.usage = usage;
    return reply;
}

const GEMINI_FINISH_REASON_TO_OAI = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    BLOCKLIST: 'content_filter',
    SPII: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'stop',
    OTHER: 'stop',
};

/**
 * Normalize a non-streaming Google generateContent response into OAI chat-completion shape.
 * Preserves the original candidate `content` object on the reply as `responseContent`
 * so existing readers (thought signatures, inlineData images) keep working.
 * @param {any} raw Google response JSON
 * @returns {object} OAI chat-completion shaped reply
 */
export function normalizeGeminiResponseToOAI(raw) {
    const candidate = Array.isArray(raw?.candidates) ? raw.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    let text = '';
    let thinking = '';
    const toolCalls = [];
    let hasFunctionCall = false;

    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const fc = part.functionCall ?? part.function_call;
        if (fc) {
            hasFunctionCall = true;
            const args = fc.args ?? fc.arguments ?? {};
            toolCalls.push({
                id: String(fc.id || `call_${uuidv4().replaceAll('-', '')}`),
                type: 'function',
                function: {
                    name: String(fc.name || ''),
                    arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
                },
            });
        } else if (part.thought && typeof part.text === 'string') {
            thinking += part.text;
        } else if (typeof part.text === 'string') {
            text += part.text;
        }
        // inlineData / fileData / thoughtSignature stay accessible via reply.responseContent.
    }

    const message = { role: 'assistant', content: text };
    if (thinking) message.reasoning_content = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const rawReason = String(candidate?.finishReason || '').toUpperCase();
    let finishReason = GEMINI_FINISH_REASON_TO_OAI[rawReason] ?? 'stop';
    if (hasFunctionCall) finishReason = 'tool_calls';

    const reply = {
        choices: [{ message, finish_reason: finishReason, index: 0 }],
        responseContent: candidate?.content,
    };
    const usage = normalizeGeminiUsage(raw?.usageMetadata);
    if (usage) reply.usage = usage;
    return reply;
}

const COHERE_FINISH_REASON_TO_OAI = {
    complete: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_call: 'tool_calls',
    error: 'stop',
    timeout: 'stop',
};

/**
 * Normalize a non-streaming Cohere v2 chat response into OAI chat-completion shape.
 * Cohere `tool_calls` are already OAI-shaped (function.name + arguments string);
 * the only restructuring is lifting `message` + `finish_reason` into `choices[0]`.
 * @param {any} raw Cohere response JSON
 * @returns {object} OAI chat-completion shaped reply
 */
export function normalizeCohereResponseToOAI(raw) {
    const rawMessage = raw?.message ?? {};
    const content = typeof rawMessage.content === 'string'
        ? rawMessage.content
        : Array.isArray(rawMessage.content)
            ? rawMessage.content.filter(c => c?.type === 'text').map(c => String(c?.text || '')).join('')
            : '';
    const toolCalls = Array.isArray(rawMessage.tool_calls)
        ? rawMessage.tool_calls.map(call => ({
            id: String(call?.id || ''),
            type: 'function',
            function: {
                name: String(call?.function?.name || ''),
                arguments: String(call?.function?.arguments ?? ''),
            },
        }))
        : [];

    const message = { role: 'assistant', content };
    if (typeof rawMessage.tool_plan === 'string' && rawMessage.tool_plan) {
        message.reasoning_content = rawMessage.tool_plan;
    }
    if (toolCalls.length) message.tool_calls = toolCalls;

    const finishReason = COHERE_FINISH_REASON_TO_OAI[String(raw?.finish_reason || '').toLowerCase()] ?? 'stop';

    const reply = {
        id: raw?.id,
        choices: [{ message, finish_reason: finishReason, index: 0 }],
    };
    const usage = normalizeCohereUsage(raw?.usage);
    if (usage) reply.usage = usage;
    return reply;
}

export const router = express.Router();

router.post('/jobs/status', async function (request, response) {
    try {
        const jobId = String(request.body?.id || '');
        if (!jobId) {
            return response.sendStatus(400);
        }

        const job = getGenerationJobForRequest(request, jobId);
        if (!job) {
            return response.sendStatus(404);
        }

        return response.send({
            id: job.id,
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            persisted: Boolean(job.persisted),
            error: job.error || '',
            created_at: job.createdAt,
            updated_at: job.updatedAt,
            finished_at: job.finishedAt || null,
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/jobs/events', async function (request, response) {
    try {
        const jobId = String(request.body?.id || '');
        const afterSeq = Math.max(0, Number(request.body?.after_seq) || 0);
        if (!jobId) {
            return response.sendStatus(400);
        }

        const job = getGenerationJobForRequest(request, jobId);
        if (!job) {
            return response.sendStatus(404);
        }

        const events = Array.isArray(job.events)
            ? job.events.filter(event => Number(event.seq) > afterSeq)
            : [];

        return response.send({
            id: job.id,
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            persisted: Boolean(job.persisted),
            events: events,
            error: job.error || '',
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/jobs/active', async function (request, response) {
    try {
        const jobs = getActiveGenerationJobsForRequest(request, request.body?.persist_target);
        return response.send({ jobs });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * SSE stream for an in-flight generation job. GET so EventSource can subscribe.
 * Emits replay events past `after_seq` (catch-up), then live `data:` frames
 * as the upstream LLM delivers them, plus typed `status` frames on state
 * changes. Closes the connection when the job reaches a terminal status.
 *
 * Replaces the FE-side 1Hz poll on /jobs/status with a single long-lived
 * connection, so recovery UI updates at the same cadence the original
 * client would have seen during streaming.
 */
router.get('/jobs/events-stream', function (request, response) {
    try {
        const jobId = String(request.query?.id || '');
        const afterSeq = Math.max(0, Number(request.query?.after_seq) || 0);
        if (!jobId) {
            response.sendStatus(400);
            return;
        }

        const job = getGenerationJobForRequest(request, jobId);
        if (!job) {
            response.sendStatus(404);
            return;
        }

        response.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        response.flushHeaders?.();

        const writeFrame = (eventName, payload) => {
            if (response.writableEnded) return false;
            try {
                if (eventName) response.write(`event: ${eventName}\n`);
                response.write(`data: ${JSON.stringify(payload)}\n\n`);
                return true;
            } catch {
                return false;
            }
        };

        // Catch-up: replay buffered events the client hasn't seen yet.
        const replayEvents = Array.isArray(job.events)
            ? job.events.filter(event => Number(event.seq) > afterSeq)
            : [];
        for (const event of replayEvents) {
            if (!writeFrame('event', event)) break;
        }

        // Initial status snapshot so the client immediately has full text + status.
        writeFrame('status', {
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            error: job.error || '',
            finished_at: job.finishedAt || null,
        });

        const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
        if (terminalStatuses.has(String(job.status || ''))) {
            try { response.end(); } catch { /* already closed */ }
            return;
        }

        let unsubscribed = false;
        const unsubscribe = subscribeToJob(jobId, (payload) => {
            if (unsubscribed) return;
            if (payload?.type === 'status') {
                writeFrame('status', payload);
                if (terminalStatuses.has(String(payload.status || ''))) {
                    unsubscribed = true;
                    unsubscribe();
                    try { response.end(); } catch { /* already closed */ }
                }
            } else if (payload?.type === 'event') {
                writeFrame('event', payload.entry);
            }
        });

        const cleanup = () => {
            if (!unsubscribed) {
                unsubscribed = true;
                unsubscribe();
            }
        };
        request.on('aborted', cleanup);
        request.on('close', cleanup);
        response.on('close', cleanup);
    } catch (error) {
        console.error(error);
        try { response.sendStatus(500); } catch { /* response may be partially written */ }
    }
});

router.post('/jobs/cancel', async function (request, response) {
    try {
        const result = cancelGenerationJobForRequest(request, request.body?.id, 'Cancelled by user');
        if (!result.ok) {
            return response.status(result.status).send({ error: { message: result.message } });
        }
        return response.send({
            id: result.job?.id || '',
            status: result.job?.status || '',
            cancelled: Boolean(result.cancelled),
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/status', async function (request, statusResponse) {
    try {
        if (!request.body) return statusResponse.sendStatus(400);

        let apiUrl = '';
        let apiKey = '';
        let headers = {};
        let queryParams = {};

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            apiUrl = normalizeOpenAIBaseUrl(request.body.reverse_proxy || request.body.base_url || API_OPENAI);
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.OPENAI) || '';
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            apiUrl = 'https://openrouter.ai/api/v1';
            apiKey = readProviderSecret(request, SECRET_KEYS.OPENROUTER);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...OPENROUTER_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
            apiUrl = new URL(request.body.reverse_proxy || request.body.base_url || API_MISTRAL).toString();
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.MISTRALAI) || '';
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            apiUrl = normalizeOpenAIBaseUrl(request.body.custom_url);
            apiKey = readProviderSecret(request, SECRET_KEYS.CUSTOM);
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
            apiUrl = API_COHERE_V1;
            apiKey = readProviderSecret(request, SECRET_KEYS.COHERE);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
            apiUrl = API_CHUTES;
            apiKey = readProviderSecret(request, SECRET_KEYS.CHUTES);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
            apiUrl = API_ELECTRONHUB;
            apiKey = readProviderSecret(request, SECRET_KEYS.ELECTRONHUB);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readProviderSecret(request, SECRET_KEYS.NANOGPT);
            headers = {};
            queryParams = { detailed: true };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
            apiUrl = new URL(request.body.reverse_proxy || request.body.base_url || API_DEEPSEEK.replace('/beta', '')).toString();
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.DEEPSEEK) || '';
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
            apiUrl = new URL(request.body.reverse_proxy || request.body.base_url || API_XAI).toString();
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.XAI) || '';
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AIMLAPI) {
            apiUrl = API_AIMLAPI;
            apiKey = readProviderSecret(request, SECRET_KEYS.AIMLAPI);
            headers = { ...AIMLAPI_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            apiUrl = 'https://gen.pollinations.ai/text';
            apiKey = readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readProviderSecret(request, SECRET_KEYS.GROQ);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readProviderSecret(request, SECRET_KEYS.COMETAPI);
            headers = {};
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = new URL(request.body.reverse_proxy || request.body.base_url || API_MOONSHOT).toString();
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.MOONSHOT) || '';
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readProviderSecret(request, SECRET_KEYS.FIREWORKS);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CLAUDE) {
            apiUrl = new URL(request.body.reverse_proxy || request.body.base_url || API_CLAUDE).toString();
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.CLAUDE) || '';
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);

            if (!apiKey && !request.body.base_url && !request.body.reverse_proxy) {
                console.warn('Claude API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const response = await fetch(`${trimTrailingSlash(apiUrl)}/models`, {
                    method: 'GET',
                    headers: {
                        'anthropic-version': '2023-06-01',
                        ...(apiKey ? { 'x-api-key': apiKey } : {}),
                        ...headers,
                    },
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = (Array.isArray(data?.data) ? data.data : [])
                        .map(model => ({ id: String(model?.id || '').trim() }))
                        .filter(model => model.id.length > 0);

                    console.info('Available Claude models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                }

                console.warn('Claude models endpoint failed:', response.status, response.statusText);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            } catch (error) {
                console.error('Error fetching Claude models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI) {
            const region = String(request.body.vertexai_region || 'us-central1');

            try {
                const auth = await getVertexAIAuth(request);
                const authHeader = auth.authHeader;
                const authType = auth.authType;
                let modelsUrl;
                /** @type {Record<string, string>} */
                const modelHeaders = {};

                if (authType === 'express') {
                    const keyParam = authHeader.replace('Bearer ', '');
                    const projectId = String(request.body.vertexai_express_project_id || '').trim();
                    const baseUrl = region === 'global'
                        ? 'https://aiplatform.googleapis.com'
                        : `https://${region}-aiplatform.googleapis.com`;
                    modelsUrl = projectId
                        ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models?key=${keyParam}`
                        : `${baseUrl}/v1/publishers/google/models?key=${keyParam}`;
                } else if (authType === 'full') {
                    const serviceAccountJson = readProviderSecret(request, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);

                    if (!serviceAccountJson) {
                        console.warn('Vertex AI Service Account JSON is missing.');
                        return statusResponse.status(400).send({ error: true });
                    }

                    let projectId;
                    try {
                        const serviceAccount = JSON.parse(serviceAccountJson);
                        projectId = getProjectIdFromServiceAccount(serviceAccount);
                    } catch (error) {
                        console.error('Failed to extract project ID from Service Account JSON:', error);
                        return statusResponse.status(400).send({ error: true });
                    }

                    modelsUrl = region === 'global'
                        ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models`
                        : `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models`;
                    modelHeaders['Authorization'] = authHeader;
                } else {
                    apiUrl = trimTrailingSlash(request.body.reverse_proxy || request.body.base_url || API_VERTEX_AI);
                    modelsUrl = `${apiUrl}/v1/publishers/google/models`;
                    modelHeaders['Authorization'] = authHeader;
                }

                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: modelHeaders,
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const rawModels = Array.isArray(data?.publisherModels) ? data.publisherModels : (Array.isArray(data?.models) ? data.models : []);
                    const models = rawModels
                        .filter(model =>
                            model?.supportedActions?.includes('generateContent') ||
                            model?.supportedActions?.includes('streamGenerateContent') ||
                            model?.supportedGenerationMethods?.includes('generateContent') ||
                            model?.supportedGenerationMethods?.includes('streamGenerateContent'))
                        .map(model => String(model?.name || model?.id || '').trim())
                        .map(name => name
                            .replace(/^projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\//, '')
                            .replace(/^publishers\/[^/]+\/models\//, '')
                            .replace(/^models\//, ''))
                        .filter(Boolean)
                        .map(id => ({ id }));

                    const uniqueModelMap = new Map();
                    for (const model of models) {
                        uniqueModelMap.set(model.id, model);
                    }

                    const uniqueModels = [...uniqueModelMap.values()].sort((a, b) => a.id.localeCompare(b.id));
                    console.info('Available Vertex AI models:', uniqueModels.map(m => m.id));
                    return statusResponse.send({ data: uniqueModels });
                }

                console.warn('Vertex AI models endpoint failed:', response.status, response.statusText);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            } catch (error) {
                console.error('Error fetching Vertex AI models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            apiKey = request.body.proxy_password || readProviderSecret(request, SECRET_KEYS.MAKERSUITE) || '';
            apiUrl = trimTrailingSlash(request.body.reverse_proxy || request.body.base_url || API_MAKERSUITE);
            const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
            const modelsUrl = !apiKey && (request.body.base_url || request.body.reverse_proxy)
                ? `${apiUrl}/${apiVersion}/models`
                : `${apiUrl}/${apiVersion}/models?key=${apiKey}`;

            if (!apiKey && !request.body.base_url && !request.body.reverse_proxy) {
                console.warn('Google AI Studio API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const response = await fetch(modelsUrl);

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    // Transform Google AI Studio models to OpenAI format
                    const models = data.models
                        ?.filter(model => model.supportedGenerationMethods?.includes('generateContent'))
                        ?.map(model => ({
                            ...model,
                            id: model.name.replace('models/', ''),
                        })) || [];

                    console.info('Available Google AI Studio models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    console.warn('Google AI Studio models endpoint failed:', response.status, response.statusText);
                    return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
                }
            } catch (error) {
                console.error('Error fetching Google AI Studio models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AZURE_OPENAI) {
            const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
            const apiKey = readProviderSecret(request, SECRET_KEYS.AZURE_OPENAI);

            // 1) Validate configuration from the frontend
            if (!apiKey || !azure_base_url || !azure_deployment_name || !azure_api_version) {
                console.warn('Azure OpenAI status check failed: missing config from frontend.');
                return statusResponse.status(400).send({ error: true, message: 'Azure configuration is incomplete.' });
            }
            // 2) Build URLs using the URL API for consistency and robustness.
            const modelsUrl = new URL('/openai/models', azure_base_url);
            modelsUrl.searchParams.set('api-version', azure_api_version);

            const chatUrl = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
            chatUrl.searchParams.set('api-version', azure_api_version);

            // Map common status codes to user-friendly error messages
            const azureStatusErrorMap = {
                400: 'API version may be invalid for this resource.',
                401: 'Invalid API key or insufficient permissions.',
                403: 'Invalid API key or insufficient permissions.',
                404: 'Endpoint URL appears incorrect (404).',
            };

            try {
                // ---- A) GET /models: fast sanity check for endpoint + api key + api version ----
                const apiConfigTest = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { 'api-key': apiKey, 'Accept': 'application/json' },
                });

                if (!apiConfigTest.ok) {
                    let errText = '';
                    try { errText = await apiConfigTest.text(); } catch { /* response body may be empty */ }

                    console.warn('Azure OpenAI GET /models failed:', apiConfigTest.status, apiConfigTest.statusText, errText || '');

                    const defaultMessage = `Azure Models endpoint error: ${apiConfigTest.statusText}`;
                    const message = azureStatusErrorMap[apiConfigTest.status] ?? defaultMessage;
                    return statusResponse.status(apiConfigTest.status).send({ error: true, message });
                }

                // ---- B) POST /chat/completions: verify deployment + read underlying model ID ----
                // Small, deterministic probe to minimize cost/latency
                const modelPayload = {
                    messages: [{ role: 'user', content: 'Say word Hi' }],
                    stream: false,
                    max_completion_tokens: 5,
                };

                const modelRequest = await fetch(chatUrl, {
                    method: 'POST',
                    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify(modelPayload),
                });

                let modelResponse;
                try {
                    modelResponse = await modelRequest.json();
                } catch {
                    modelResponse = { raw: 'Failed to parse JSON response from chat completions probe.' };
                }

                const modelId = /** @type {any} */ (modelResponse)?.model;
                if (!modelId) {
                    console.warn('Azure status check succeeded but could not find a model ID in the response.');
                    console.debug('Azure Response Body:', modelResponse);
                    // Keep a benign success to avoid UX disruption in the UI
                    return statusResponse.send({ data: [] });
                }

                console.info(color.green('Azure OpenAI connection successful. Detected model:'), modelId);
                // Consistent response format: always an array of { id }
                return statusResponse.send({ data: [{ id: modelId }] });
            } catch (error) {
                console.error('Azure OpenAI status check connection error:', error);
                return statusResponse.status(500).send({ error: true, message: 'Failed to connect to the Azure endpoint.' });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            const defaultApiUrl = request.body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
                ? API_SILICONFLOW_CN : API_SILICONFLOW;
            apiUrl = defaultApiUrl;
            apiKey = readProviderSecret(request, SECRET_KEYS.SILICONFLOW);
            headers = {};
            queryParams = { type: 'text', sub_type: 'chat' };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, request.body.secret_id);

            if (!apiKey) {
                console.warn('Cloudflare Workers AI API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const accountId = String(request.body.workers_ai_account_id || '').trim();
                if (!accountId) {
                    console.warn('Cloudflare Workers AI Account ID is missing.');
                    return statusResponse.status(400).send({ error: true });
                }

                const modelsUrl = new URL(`${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/models/search`);
                modelsUrl.searchParams.set('task', 'Text Generation');
                modelsUrl.searchParams.set('per_page', '1000');

                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                    },
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = Array.isArray(data?.result)
                        ? data.result.map(model => ({ ...model, id: model.name }))
                        : [];

                    console.debug('Available Cloudflare Workers AI models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    console.warn('Cloudflare Workers AI models endpoint failed:', response.status, response.statusText);
                    return statusResponse.status(response.status).send({ error: true });
                }
            } catch (error) {
                console.error('Error fetching Cloudflare Workers AI models:', error);
                return statusResponse.status(500).send({ error: true });
            }
        } else {
            console.warn('This chat completion source is not supported yet.');
            return statusResponse.status(400).send({ error: true });
        }

        if (!apiKey && !request.body.base_url && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('Chat Completion API key is missing.');
            return statusResponse.status(400).send({ error: true });
        }

        const modelsUrl = new URL(urlJoin(apiUrl, '/models'));
        Object.keys(queryParams).forEach(key => {
            modelsUrl.searchParams.append(key, queryParams[key]);
        });
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
        });

        if (response.ok) {
            /** @type {any} */
            let data = await response.json();

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS && Array.isArray(data)) {
                data = { data: data.map(model => ({ id: model.name, ...model })) };
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES && Array.isArray(data?.data)) {
                data.data = data.data
                    .filter(model => model?.id)
                    .map(model => {
                        if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
                            return {
                                ...model,
                                pricing: {
                                    ...model.pricing,
                                    input: model.pricing.prompt,
                                    output: model.pricing.completion,
                                },
                            };
                        }
                        return model;
                    });
            }

            statusResponse.send(data);

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE && Array.isArray(data?.models)) {
                data.data = data.models.map(model => ({ id: model.name, ...model }));
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER && Array.isArray(data?.data)) {
                let models = [];

                data.data.forEach(model => {
                    const context_length = model.context_length;
                    const tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
                    const tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);
                    models[model.id] = {
                        tokens_per_dollar: tokens_rounded + 'k',
                        context_length: context_length,
                    };
                });

                console.info('Available OpenRouter models:', models);
            } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
                const models = data?.data;
                console.info(models);
            } else {
                const models = data?.data;

                if (Array.isArray(models)) {
                    const modelIds = models.filter(x => x && typeof x === 'object').map(x => x.id).sort();
                    console.info('Available models:', modelIds);
                } else {
                    console.warn('Chat Completion endpoint did not return a list of models.');
                }
            }
        } else {
            let bodySnippet = '';
            try {
                const bodyText = await response.text();
                bodySnippet = bodyText.length > 500 ? bodyText.slice(0, 500) + '…' : bodyText;
            } catch { /* body may already be consumed or unreadable */ }
            console.error(
                `Chat Completion status check failed (GET ${modelsUrl.toString()} -> ${response.status} ${response.statusText}).`,
                'Either Access Token is incorrect or API endpoint is down.',
                bodySnippet ? `Response body: ${bodySnippet}` : '',
            );
            statusResponse.send({ error: true, data: { data: [] } });
        }
    } catch (e) {
        console.error(e);

        if (!statusResponse.headersSent) {
            statusResponse.send({ error: true });
        } else {
            statusResponse.end();
        }
    }
});

router.post('/bias', async function (request, response) {
    if (!request.body || !Array.isArray(request.body))
        return response.sendStatus(400);

    try {
        const result = {};
        const model = getTokenizerModel(String(request.query.model || ''));

        // no bias for claude
        if (model == 'claude') {
            return response.send(result);
        }

        let encodeFunction;

        if (sentencepieceTokenizers.includes(model)) {
            const tokenizer = getSentencepiceTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                console.error('Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encodeIds(text));
        } else if (webTokenizers.includes(model)) {
            const tokenizer = getWebTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                console.warn('Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encode(text));
        } else {
            const tokenizer = getTiktokenTokenizer(model);
            encodeFunction = (tokenizer.encode.bind(tokenizer));
        }

        for (const entry of request.body) {
            if (!entry || !entry.text) {
                continue;
            }

            try {
                const tokens = getEntryTokens(entry.text, encodeFunction);

                for (const token of tokens) {
                    result[token] = entry.value;
                }
            } catch {
                console.warn('Tokenizer failed to encode:', entry.text);
            }
        }

        // not needed for cached tokenizers
        //tokenizer.free();
        return response.send(result);

        /**
         * Gets tokenids for a given entry
         * @param {string} text Entry text
         * @param {(string) => Uint32Array} encode Function to encode text to token ids
         * @returns {Uint32Array} Array of token ids
         */
        function getEntryTokens(text, encode) {
            // Get raw token ids from JSON array
            if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
                try {
                    const json = JSON.parse(text);
                    if (Array.isArray(json) && json.every(x => typeof x === 'number')) {
                        return new Uint32Array(json);
                    }
                } catch {
                    // ignore
                }
            }

            // Otherwise, get token ids from tokenizer
            return encode(text);
        }
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

/**
 * Routing table: chat_completion_source → dispatch function.
 * 12 self-contained providers get dedicated dispatches; 13 OpenAI-compatible
 * providers share {@link dispatchOpenAICompatible}, which resolves the correct
 * base URL / auth / body params via internal per-source resolvers.
 * MAKERSUITE and VERTEXAI intentionally point at the same function
 * (dispatchMakerSuite handles both flavors internally).
 */
const CHAT_COMPLETION_DISPATCH_TABLE = {
    [CHAT_COMPLETION_SOURCES.CLAUDE]: dispatchClaude,
    [CHAT_COMPLETION_SOURCES.AI21]: dispatchAI21,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: dispatchMakerSuite,
    [CHAT_COMPLETION_SOURCES.VERTEXAI]: dispatchMakerSuite,
    [CHAT_COMPLETION_SOURCES.MISTRALAI]: dispatchMistralAI,
    [CHAT_COMPLETION_SOURCES.COHERE]: dispatchCohere,
    [CHAT_COMPLETION_SOURCES.DEEPSEEK]: dispatchDeepSeek,
    [CHAT_COMPLETION_SOURCES.XAI]: dispatchXai,
    [CHAT_COMPLETION_SOURCES.AIMLAPI]: dispatchAimlapi,
    [CHAT_COMPLETION_SOURCES.CHUTES]: dispatchChutes,
    [CHAT_COMPLETION_SOURCES.MINIMAX]: dispatchMinimax,
    [CHAT_COMPLETION_SOURCES.ELECTRONHUB]: dispatchElectronHub,
    [CHAT_COMPLETION_SOURCES.AZURE_OPENAI]: dispatchAzureOpenAI,
    // Shared OpenAI-compatible cascade (13 providers)
    [CHAT_COMPLETION_SOURCES.OPENAI]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.OPENROUTER]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.CUSTOM]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.PERPLEXITY]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.GROQ]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.FIREWORKS]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.NANOGPT]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.POLLINATIONS]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.MOONSHOT]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.COMETAPI]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.ZAI]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.SILICONFLOW]: dispatchOpenAICompatible,
    [CHAT_COMPLETION_SOURCES.WORKERS_AI]: dispatchOpenAICompatible,
};

/**
 * Resolve the dispatch function for a chat-completion request body.
 * Exported for the handler unit test; consumed by the runLukerDispatch thunk below.
 * @param {any} body Parsed request body
 * @returns {(ctx: import('../../luker-dispatch/context.js').DispatchContext) => Promise<void>}
 */
export function selectChatCompletionDispatch(body) {
    const source = String(body?.chat_completion_source || '');
    const fn = CHAT_COMPLETION_DISPATCH_TABLE[source];
    if (!fn) throw new Error(`Unsupported chat_completion_source: ${source}`);
    return fn;
}

router.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'chat-completions',
    select: (body) => selectChatCompletionDispatch(body),
}));

const multimodalModels = express.Router();

multimodalModels.post('/pollinations', async (_req, res) => {
    try {
        const response = await fetch('https://gen.pollinations.ai/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data)) {
            return res.json([]);
        }

        const multimodalModels = data
            .filter(m => Array.isArray(m?.input_modalities))
            .filter(m => m.input_modalities.includes('image'))
            .map(m => m.name);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/aimlapi', async (_req, res) => {
    try {
        const response = await fetch('https://api.aimlapi.com/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.features?.includes('openai/chat-completion.vision')).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/nanogpt', async (_req, res) => {
    try {
        const response = await fetch('https://nano-gpt.com/api/v1/models?detailed=true');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/electronhub', async (_req, res) => {
    try {
        const response = await fetch('https://api.electronhub.ai/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.metadata?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/chutes', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.CHUTES);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://llm.chutes.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        const data = await response.json();

        const modelsData = /** @type {{object: string, data: Array<{id: string, input_modalities?: string[]}>}} */ (data);
        const multimodalModels = modelsData.data
            .filter(m => m.input_modalities?.includes('image'))
            .map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/mistral', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MISTRALAI);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.mistral.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/xai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.XAI);

        if (!key) {
            return res.json([]);
        }

        // xAI's /models endpoint doesn't return modality info, so we must use /language-models instead
        const response = await fetch('https://api.x.ai/v1/language-models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.models.filter(m => m.input_modalities?.includes('image')).map(m => m.id);
        if (!multimodalModels.includes('grok-4-0709')) {
            // The endpoint says it doesn't support images, but it does
            multimodalModels.push('grok-4-0709');
        }
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/moonshot', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MOONSHOT);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.moonshot.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        const multimodalModels = data.data.filter(m => m.supports_image_in).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/workers_ai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.WORKERS_AI);
        const accountId = String(req.body.workers_ai_account_id || '').trim();

        if (!key || !accountId) {
            return res.json([]);
        }

        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text+Generation&per_page=1000`;
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + key },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const models = Array.isArray(data?.result)
            ? data.result
                .filter(m => Array.isArray(m.properties) && m.properties.some(p => p.property_id === 'vision' && p.value === 'true'))
                .map(m => m.name)
            : [];
        return res.json(models);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.use('/multimodal-models', multimodalModels);

router.post('/process', async function (request, response) {
    try {
        if (!Array.isArray(request.body.messages)) {
            return response.status(400).send({ error: 'Invalid messages format' });
        }

        if (!Object.values(PROMPT_PROCESSING_TYPE).includes(request.body.type)) {
            return response.status(400).send({ error: 'Unknown processing type' });
        }

        const messages = postProcessPrompt(request.body.messages, request.body.type, getPromptNames(request));
        return response.send({ messages });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
