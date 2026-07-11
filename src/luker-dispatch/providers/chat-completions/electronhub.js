// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Electron Hub chat completions. Extracted from legacy
// `sendElectronHubRequest` (src/endpoints/backends/chat-completions.js:1767-1874).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe). Electron Hub specifics:
//   - When model matches /^claude-/, apply OpenRouter-style prompt-cache
//     annotations to messages via cachingSystemPromptForOpenRouter and/or
//     cachingAtDepthForOpenRouterClaude (mirrors legacy behavior). Cache
//     config resolution matches claude.js (body override → config.yaml).
//   - json_schema, web_search, tools/tool_choice, reasoning_effort forwarded.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import {
    cachingAtDepthForOpenRouterClaude,
    cachingSystemPromptForOpenRouter,
} from '../../../prompt-converters.js';
import { getConfigValue } from '../../../util.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';

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
 * Dispatch an Electron Hub chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchElectronHub(ctx) {
    const body = ctx.body || {};
    const apiKey = ctx.secrets.read(SECRET_KEYS.ELECTRONHUB) || '';

    if (!apiKey) {
        ctx.emit.error(new Error('Electron Hub key is missing'));
        return;
    }

    ctx.inspection.start();

    try {
        const bodyParams = {};
        const { cacheTTL, enableSystemPromptCache, cachingAtDepth } = resolveClaudeCacheConfig(body);

        if (body.enable_web_search) {
            bodyParams['web_search'] = true;
        }

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams['tools'] = body.tools;
            bodyParams['tool_choice'] = body.tool_choice;
        }

        if (body.reasoning_effort) {
            bodyParams['reasoning_effort'] = body.reasoning_effort;
        }

        if (body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: body.json_schema.name,
                    description: body.json_schema.description,
                    schema: body.json_schema.value,
                    strict: body.json_schema.strict ?? true,
                },
            };
        }

        const isClaude = /^claude-/.test(body.model);

        if (Array.isArray(body.messages) && isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(body.messages, cacheTTL);
            }

            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(body.messages, cachingAtDepth, cacheTTL);
            }
        }

        const requestBody = {
            'messages': body.messages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.max_tokens,
            'stream': body.stream,
            'presence_penalty': body.presence_penalty,
            'frequency_penalty': body.frequency_penalty,
            'top_p': body.top_p,
            'top_k': body.top_k,
            'logit_bias': body.logit_bias,
            'seed': body.seed,
            ...bodyParams,
        };

        const fetchUrl = API_ELECTRONHUB + '/chat/completions';
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
            const msg = `Electron Hub upstream ${resp.status}: ${errText}`;
            ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
            ctx.emit.error(new Error(msg));
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
