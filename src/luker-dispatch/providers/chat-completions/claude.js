// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Anthropic Claude chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import {
    convertClaudeMessages,
    cachingAtDepthForClaude,
    getPromptNames,
    calculateClaudeBudgetTokens,
} from '../../../prompt-converters.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { applyAdditionalParameters } from './custom-params.js';
import {
    emitCapabilityConflict,
    handleProviderDispatchError,
    relayUpstreamResponse,
    resolveClaudeCacheConfig,
} from './upstream-relay.js';
import {
    buildClaudeTool,
    color,
    convertClaudeToolChoice,
    getConfigValue,
} from '../../../util.js';
import {
    resolveClaudeModelCapabilities,
    validateClaudeRequestCapabilities,
} from '../../../../public/scripts/lib/provider-capabilities.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';

const API_CLAUDE = 'https://api.anthropic.com/v1';

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
    ctx.inspection.start();

    // Direct body-supplied password wins (proxy_password override).
    const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    const secretKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.CLAUDE) || '';

    if (!secretKey && !body.base_url && !body.reverse_proxy) {
        console.warn('Claude API key is missing.');
        // Legacy shape: `.status(400).send({error:true})`. Surface the missing
        // key as an HTTP 400 with a parseable JSON envelope via head+chunk+
        // end so the client's `!response.ok` branch fires with a meaningful
        // body (not a generic stream error). Client:
        //   • ws-delivery reads msg.type='head' → resolves headPromise with
        //     status=400, then chunk/end enqueue the body → proxiedFetch
        //     constructs `new Response(stream, { status: 400 })`.
        //   • openai.js sees `!response.ok`, reads `.text()`, throws with
        //     the envelope substring (matches pre-refactor error surface).
        const errBody = JSON.stringify({ error: true, message: 'Claude API key is missing.' });
        ctx.emit.head({ status: 400, headers: { 'content-type': 'application/json' } });
        ctx.emit.chunk(new TextEncoder().encode(errBody));
        ctx.emit.end();
        ctx.inspection.fail(new Error('Claude API key is missing.'), 400);
        return;
    }

    let apiUrl;
    try {
        apiUrl = normalizeProviderBaseUrl('claude', body.reverse_proxy || body.base_url || API_CLAUDE);
        new URL(apiUrl);
    } catch (parseErr) {
        const err = new Error(`Claude upstream URL invalid: ${parseErr?.message || parseErr}`);
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        const additionalHeaders = {};
        // Upstream ST hard-coded 'output-128k-2025-02-19' (added with Sonnet 3.7) and
        // 'context-1m-2025-08-07' (added with Opus 4.6) as unconditional defaults. Per
        // platform.claude.com docs, both are now dead flags for every current Claude model:
        //   - 128k output is native on Fable 5 / Opus 4.6+ / Sonnet 4.6+; older models
        //     (Sonnet 4.5 = 64k, Opus 4.5 = 64k, Opus 4.1 = 32k) never supported 128k
        //     regardless of this beta, so it was never useful on them either.
        //   - 1M context is GA (no beta required) on Opus 4.6+ / Sonnet 4.6+ / Fable 5;
        //     it was retired on Sonnet 4.5 / Sonnet 4 on 2026-04-30.
        // AWS Bedrock rejects unknown beta names with `ValidationException: invalid beta
        // flag`, breaking Fable 5 on Bedrock proxies. Removed.
        const betaHeaders = [];
        const useTools = Array.isArray(body.tools) && body.tools.length > 0;
        const useSystemPrompt = Boolean(body.use_sysprompt);
        const convertedPrompt = convertClaudeMessages(
            body.messages,
            body.assistant_prefill,
            useSystemPrompt,
            useTools,
            getPromptNames({ body }),
        );
        const enableAdaptiveThinking = getConfigValue('claude.enableAdaptiveThinking', true, 'boolean');
        const caps = resolveClaudeModelCapabilities(body.model, { enableAdaptiveThinking });
        const useThinking = caps.supportsThinking;
        const useWebSearch = caps.supportsWebSearch && Boolean(body.enable_web_search);
        const isLimitedSampling = caps.limitedSampling;
        const useVerbosity = caps.supportsVerbosity;
        const noPrefillModel = caps.noPrefill;
        const isAdaptiveModel = caps.adaptiveThinking;
        const noSamplingModel = caps.noSampling;
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
            functionTools[functionTools.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
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
            if (caps.supportsNativeStructuredOutput) {
                // Claude 4.1+/4.5+/4.6+/4.7+/5+ support native structured outputs via output_config.format.
                requestBody.output_config ??= {};
                requestBody.output_config.format = {
                    type: 'json_schema',
                    schema: body.json_schema.value,
                };
            } else {
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
        }

        if (useWebSearch) {
            const webSearchTool = [{ 'type': 'web_search_20250305', 'name': 'web_search' }];
            requestBody.tools = [...webSearchTool, ...(requestBody.tools || [])];
        }

        if (cachingAtDepth !== -1) {
            cachingAtDepthForClaude(convertedPrompt.messages, cachingAtDepth, cacheTTL);
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

        const reasoningToken = normalizeReasoningToken(body.reasoning_effort);
        const includeReasoning = Boolean(body.include_reasoning);

        const budgetTokens = calculateClaudeBudgetTokens(requestBody.max_tokens, reasoningToken, requestBody.stream, isAdaptiveModel);

        if (reasoningToken === 'off' && caps.canDisableThinking && !caps.alwaysThinking) {
            if (caps.offThinkingMode === 'between_tools') {
                fixThinkingPrefill = true;
                requestBody.thinking = { type: 'between_tools' };
            } else if (caps.offThinkingMode === 'omit') {
                // Thinking is off by default on these models; send nothing.
            } else {
                fixThinkingPrefill = true;
                requestBody.thinking = { type: 'disabled' };
            }
        } else if (useThinking && typeof budgetTokens === 'string') {
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive' };
            if (noSamplingModel && includeReasoning) {
                requestBody.thinking.display = 'summarized';
            }
            requestBody.output_config ??= {};
            requestBody.output_config.effort = budgetTokens;
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        } else if (useThinking && Number.isInteger(budgetTokens)) {
            fixThinkingPrefill = true;
            const minThinkTokens = 1024;
            if (requestBody.max_tokens <= minThinkTokens) {
                const newValue = requestBody.max_tokens + minThinkTokens;
                console.warn(color.yellow(`Claude thinking requires a minimum of ${minThinkTokens} response tokens.`));
                console.info(color.blue(`Increasing response length to ${newValue}.`));
                requestBody.max_tokens = newValue;
            }
            requestBody.thinking = { type: 'enabled', budget_tokens: budgetTokens };
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        } else if (useThinking && includeReasoning && (reasoningToken === 'auto' || reasoningToken === 'off')
            && caps.defaultThinkingRequiresDisplay) {
            // These families think by default; readable summaries require an explicit display request.
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive', display: 'summarized' };
        }

        const lastClaudeMessage = convertedPrompt.messages.length
            ? convertedPrompt.messages[convertedPrompt.messages.length - 1]
            : null;
        const isPauseTurnResume = Boolean(body.claude_pause_turn_continuation);
        if ((fixThinkingPrefill || noPrefillModel) && !isPauseTurnResume && lastClaudeMessage?.role === 'assistant') {
            lastClaudeMessage.role = 'user';
        }

        if (useVerbosity && body.verbosity && !requestBody.output_config?.effort) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = body.verbosity;
        }

        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }

        applyAdditionalParameters(requestBody, additionalHeaders, body);

        const capabilityConflict = validateClaudeRequestCapabilities({
            model: body.model,
            thinking: requestBody.thinking,
            toolChoice: requestBody.tool_choice,
            enableAdaptiveThinking,
        });
        if (capabilityConflict) {
            emitCapabilityConflict(ctx, capabilityConflict, 'Claude');
            return;
        }

        const fetchUrl = apiUrl.endsWith('/') ? apiUrl + 'messages' : apiUrl + '/messages';
        const requestHeaders = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(secretKey ? { 'x-api-key': secretKey } : {}),
            ...additionalHeaders,
        };
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(requestHeaders, secretKey, ['x-api-key']), requestBody);

        console.debug('Claude request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers: requestHeaders,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'Claude',
            stream: Boolean(requestBody.stream),
            completeInspection: true,
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'Claude');
    }
}
