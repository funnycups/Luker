// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for MiniMax chat completions.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { MINIMAX_ENDPOINT } from '../../../constants.js';
import { getPromptNames, postProcessPrompt, PROMPT_PROCESSING_TYPE, stripNonChatReplayFields } from '../../../prompt-converters.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import { handleProviderDispatchError, relayUpstreamResponse } from './upstream-relay.js';
import { resolveMinimaxModelCapabilities } from '../../../../public/scripts/lib/provider-capabilities.js';

const API_MINIMAX = 'https://api.minimax.io/v1';
const API_MINIMAX_CN = 'https://api.minimaxi.com/v1';

/**
 * Dispatch a MiniMax chat completion request through the transport-agnostic
 * event bus. Does NOT return a payload; results flow to the caller via
 * ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchMinimax(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();

    const apiUrl = body.minimax_endpoint === MINIMAX_ENDPOINT.CN
        ? API_MINIMAX_CN : API_MINIMAX;

    const apiKey = ctx.secrets.read(SECRET_KEYS.MINIMAX, { secretId: body.secret_id }) || '';

    if (!apiKey) {
        console.warn('MiniMax key is missing.');
        const err = new Error('MiniMax key is missing');
        ctx.inspection.fail(err, 400);
        ctx.emit.error(err);
        return;
    }

    try {
        // MiniMax does not allow consecutive messages with the same role.
        // Strip foreign replay envelopes first so consecutive same-role turns
        // merge cleanly instead of tripping "invalid chat setting (2013)".
        const messages = postProcessPrompt(stripNonChatReplayFields(body.messages), PROMPT_PROCESSING_TYPE.MERGE, getPromptNames({ body }));

        const bodyParams = {};

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams.tools = body.tools;
            bodyParams.tool_choice = body.tool_choice;
        }

        const minimaxCaps = resolveMinimaxModelCapabilities(body.model);
        const maxTokens = minimaxCaps.maxOutputTokens !== null && Number.isFinite(Number(body.max_tokens))
            ? Math.min(Number(body.max_tokens), minimaxCaps.maxOutputTokens)
            : body.max_tokens;

        const requestBody = {
            'messages': messages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': maxTokens,
            'stream': body.stream,
            'top_p': body.top_p,
            'stop': body.stop,
            ...bodyParams,
        };

        const minimaxToken = normalizeReasoningToken(body.reasoning_effort);
        if (minimaxToken !== 'auto') {
            requestBody.thinking = { type: minimaxToken === 'off' ? 'disabled' : 'enabled' };
            if (minimaxToken !== 'off') requestBody.reasoning_effort = minimaxToken;
        }

        const fetchUrl = apiUrl + '/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        };
        applyAdditionalParameters(requestBody, headers, body);
        ctx.inspection.attach(fetchUrl, resolveEffectiveApiKey(headers, apiKey, ['authorization']), requestBody);

        console.debug('MiniMax request:', requestBody);

        const resp = await ctx.fetch(fetchUrl, {
            method: 'POST',
            signal: ctx.signal,
            body: JSON.stringify(requestBody),
            headers,
        });

        await relayUpstreamResponse(ctx, resp, {
            label: 'MiniMax',
            stream: Boolean(requestBody.stream),
        });
    } catch (err) {
        handleProviderDispatchError(ctx, err, 'MiniMax');
    }
}
