// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Claude (Anthropic) chat completions. Extracted from
// legacy `sendClaudeRequest` (src/endpoints/backends/chat-completions.js).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// TEMPLATE: subsequent providers (4.2-4.26) should mirror this shape:
//   1) resolve secret via ctx.secrets.read (with secret_id + fallback)
//   2) build upstream request body/headers (copy from legacy sendXRequest)
//   3) ctx.inspection.start() / ctx.inspection.attach(url) before fetch
//   4) ctx.fetch(url, { signal: ctx.signal })
//   5) on !resp.ok: read body text, ctx.inspection.fail, ctx.emit.error, return
//   6) streaming: read resp.body as ReadableStream, ctx.emit.chunk per read,
//      then ctx.emit.end
//   7) non-streaming: ctx.emit.chunk(bytes of upstream JSON) + ctx.emit.end
//   8) try/catch around 3-7: ctx.inspection.fail + ctx.emit.error

import { SECRET_KEYS, readSecret } from '../../../endpoints/secrets.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';
import { normalizeClaudeResponseToOAI } from '../../../endpoints/backends/chat-completions.js';
import {
    convertClaudeMessages,
    cachingAtDepthForClaude,
    getPromptNames,
    calculateClaudeBudgetTokens,
} from '../../../prompt-converters.js';
import {
    buildClaudeTool,
    convertClaudeToolChoice,
    excludeKeysByYaml,
    getConfigValue,
    mergeObjectWithYaml,
} from '../../../util.js';

const API_CLAUDE = 'https://api.anthropic.com/v1';

const enableAdaptiveThinking = getConfigValue('claude.enableAdaptiveThinking', true, 'boolean');

function resolveClaudeCacheConfig(body) {
    const sysFromBody = body?.claude_enable_system_prompt_cache;
    const depthFromBody = body?.claude_caching_at_depth;
    const ttlFromBody = body?.claude_extended_ttl;

    const enableSystemPromptCache = typeof sysFromBody === 'boolean'
        ? sysFromBody
        : getConfigValue('claude.enableSystemPromptCache', false, 'boolean');

    const useExtendedTtl = typeof ttlFromBody === 'boolean'
        ? ttlFromBody
        : getConfigValue('claude.extendedTTL', false, 'boolean');
    const cacheTTL = useExtendedTtl ? '1h' : '5m';

    const depthRaw = typeof depthFromBody === 'number'
        ? depthFromBody
        : getConfigValue('claude.cachingAtDepth', -1, 'number');
    const cachingAtDepth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : -1;

    return { cacheTTL, enableSystemPromptCache, cachingAtDepth };
}

/**
 * Read Claude API key honoring optional `secret_id` in body, then falling back
 * to the active CLAUDE secret. Mirrors readProviderSecret() semantics without
 * requiring Express request shape.
 * @param {object} ctx DispatchContext
 * @returns {string}
 */
function resolveClaudeApiKey(ctx) {
    const requestedId = typeof ctx.body?.secret_id === 'string'
        ? ctx.body.secret_id.trim()
        : (typeof ctx.body?.secretId === 'string' ? ctx.body.secretId.trim() : '');

    if (requestedId) {
        const byId = ctx.secrets.read(SECRET_KEYS.CLAUDE, { secretId: requestedId });
        if (byId) return byId;
    }
    // Prefer ctx.secrets.read for consistency; fall through to active secret.
    const active = ctx.secrets.read(SECRET_KEYS.CLAUDE);
    return active || '';
}

/**
 * Dispatch a Claude chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchClaude(ctx) {
    const body = ctx.body || {};

    // Direct body-supplied password wins (legacy: proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const secretKey = bodyApiKey || resolveClaudeApiKey(ctx);

    if (!secretKey && !body.reverse_proxy) {
        ctx.emit.error(new Error('Claude API key is missing'));
        return;
    }

    let apiUrl;
    try {
        apiUrl = new URL(body.reverse_proxy || body.base_url || API_CLAUDE).toString();
    } catch (err) {
        ctx.emit.error(new Error(`Claude upstream URL invalid: ${err?.message || err}`));
        return;
    }

    ctx.inspection.start();

    try {
        const additionalHeaders = {};
        const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
        const useTools = Array.isArray(body.tools) && body.tools.length > 0;
        const useSystemPrompt = Boolean(body.use_sysprompt);
        const convertedPrompt = convertClaudeMessages(
            body.messages,
            body.assistant_prefill,
            useSystemPrompt,
            useTools,
            getPromptNames({ body }),
        );
        const useThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(body.model);
        const useWebSearch = /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(body.model) && Boolean(body.enable_web_search);
        const isLimitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(body.model);
        const useVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(body.model);
        const noPrefillModel = /^claude-(opus-4-6|sonnet-4-6|opus-4-7)/.test(body.model);
        const isAdaptiveModel = /^claude-(opus-4-7)/.test(body.model) || (enableAdaptiveThinking && /^claude-(opus-4-6|sonnet-4-6)/.test(body.model));
        const noSamplingModel = /^claude-(opus-4-7)/.test(body.model);
        let fixThinkingPrefill = false;

        const stopSequences = [];
        if (Array.isArray(body.stop)) {
            stopSequences.push(...body.stop);
        }

        const requestBody = {
            /** @type {any} */ system: [],
            messages: convertedPrompt.messages,
            model: body.model,
            max_tokens: body.max_tokens,
            stop_sequences: stopSequences,
            temperature: body.temperature,
            top_p: body.top_p,
            top_k: body.top_k,
            stream: body.stream,
        };
        const { cacheTTL, enableSystemPromptCache, cachingAtDepth } = resolveClaudeCacheConfig(body);
        if (useSystemPrompt) {
            if (enableSystemPromptCache && Array.isArray(convertedPrompt.systemPrompt) && convertedPrompt.systemPrompt.length) {
                convertedPrompt.systemPrompt[convertedPrompt.systemPrompt.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
            }
            requestBody.system = convertedPrompt.systemPrompt;
        } else {
            delete requestBody.system;
        }

        const functionTools = useTools
            ? body.tools
                .filter(tool => tool.type === 'function')
                .map(tool => buildClaudeTool(tool))
                .filter(Boolean)
            : [];

        if (enableSystemPromptCache && functionTools.length) {
            functionTools[functionTools.length - 1]['cache_control'] = { type: 'ephemeral', ttl: cacheTTL };
        }

        // See legacy sendClaudeRequest comment: attach cache_control to first-user
        // last text block when systemPrompt ends up empty (custom_prompt_post_processing
        // shape or use_sysprompt:false).
        if (enableSystemPromptCache && (!Array.isArray(convertedPrompt.systemPrompt) || convertedPrompt.systemPrompt.length === 0)) {
            const firstUser = Array.isArray(convertedPrompt.messages) ? convertedPrompt.messages[0] : null;
            if (firstUser && firstUser.role === 'user' && Array.isArray(firstUser.content)) {
                for (let i = firstUser.content.length - 1; i >= 0; i--) {
                    if (firstUser.content[i]?.type === 'text') {
                        firstUser.content[i].cache_control = { type: 'ephemeral', ttl: cacheTTL };
                        break;
                    }
                }
            }
        }

        if (functionTools.length) {
            requestBody.tools = functionTools;
            const toolChoice = convertClaudeToolChoice(body.tool_choice, body.parallel_tool_calls);
            if (toolChoice) {
                requestBody.tool_choice = toolChoice;
            }
        }

        if (body.json_schema) {
            const jsonTool = buildClaudeTool({
                name: body.json_schema.name,
                description: body.json_schema.description || 'Well-formed JSON object',
                parameters: body.json_schema.value,
            });
            if (jsonTool) {
                requestBody.tools = [...(requestBody.tools || []), jsonTool];
                requestBody.tool_choice = { type: 'tool', name: jsonTool.name };
            }
        }

        if (useWebSearch) {
            const webSearchTool = [{ 'type': 'web_search_20250305', 'name': 'web_search' }];
            requestBody.tools = [...webSearchTool, ...(requestBody.tools || [])];
        }

        if (requestBody.tools?.length) {
            betaHeaders.push('tools-2024-05-16');
        }

        if (cachingAtDepth !== -1) {
            cachingAtDepthForClaude(convertedPrompt.messages, cachingAtDepth, cacheTTL);
        }

        if (enableSystemPromptCache || cachingAtDepth !== -1) {
            betaHeaders.push('prompt-caching-2024-07-31');
            betaHeaders.push('extended-cache-ttl-2025-04-11');
        }

        if (isLimitedSampling) {
            if (requestBody.top_p < 1) {
                delete requestBody.temperature;
            } else {
                delete requestBody.top_p;
            }
        }

        if (noSamplingModel) {
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        const reasoningEffort = body.reasoning_effort;
        const budgetTokens = calculateClaudeBudgetTokens(requestBody.max_tokens, reasoningEffort, requestBody.stream, isAdaptiveModel);

        if (useThinking && typeof budgetTokens === 'string') {
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive' };
            const includeReasoning = Boolean(body.include_reasoning);
            if (noSamplingModel && includeReasoning) {
                requestBody.thinking.display = 'summarized';
            }
            requestBody.output_config ??= {};
            requestBody.output_config.effort = budgetTokens;
            delete requestBody.top_k;
        } else if (useThinking && Number.isInteger(budgetTokens)) {
            fixThinkingPrefill = true;
            const minThinkTokens = 1024;
            if (requestBody.max_tokens <= minThinkTokens) {
                requestBody.max_tokens = requestBody.max_tokens + minThinkTokens;
            }
            requestBody.thinking = { type: 'enabled', budget_tokens: budgetTokens };
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        if ((fixThinkingPrefill || noPrefillModel) && convertedPrompt.messages.length && convertedPrompt.messages[convertedPrompt.messages.length - 1].role === 'assistant') {
            convertedPrompt.messages[convertedPrompt.messages.length - 1].role = 'user';
        }

        if (useVerbosity && body.verbosity && !requestBody.output_config?.effort) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = body.verbosity;
        }

        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }

        mergeObjectWithYaml(requestBody, body.custom_include_body);
        excludeKeysByYaml(requestBody, body.custom_exclude_body);
        mergeObjectWithYaml(additionalHeaders, body.custom_include_headers);

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'messages' : apiUrl + '/messages';
        ctx.inspection.attach(fetchUrl, secretKey, requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': secretKey,
                ...additionalHeaders,
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
            const msg = `Claude upstream ${resp.status}: ${errText}`;
            ctx.inspection.fail(new Error(msg));
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
            // Non-streaming Claude returns Anthropic-shaped JSON
            // (content: [{type,text}], stop_reason, usage: {input_tokens,
            // output_tokens}). Frontend consumers (openai.js:4515 for main
            // chat, generate-task.js:807 for iter studio) expect OAI shape
            // (choices[0].message.content). Legacy sendClaudeRequest called
            // normalizeClaudeResponseToOAI before response.send; the refactor
            // dropped it so both non-stream paths returned raw Anthropic body
            // and consumers saw `undefined` / `no choices` errors.
            const anthropicJson = await resp.json();
            const oai = normalizeClaudeResponseToOAI(anthropicJson);
            const oaiBytes = new TextEncoder().encode(JSON.stringify(oai));
            ctx.emit.chunk(oaiBytes);
            ctx.emit.end();
        }
    } catch (err) {
        // AbortError, network error, or any body-construction throw.
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
