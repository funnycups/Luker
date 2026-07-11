// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for MiniMax chat completions. Extracted from legacy
// `sendMinimaxRequest` (src/endpoints/backends/chat-completions.js:1983-2058).
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js (see that file's
// header for the full recipe). MiniMax specifics:
//   - Two upstream regions selected by body.minimax_endpoint (global vs cn).
//   - Secret read honors optional body.secret_id (legacy readSecret third arg)
//     via ctx.secrets.read(key, { secretId }); no active-secret fallback,
//     matching legacy behavior which passes the id straight through.
//   - Consecutive same-role messages are merged (PROMPT_PROCESSING_TYPE.MERGE)
//     to avoid MiniMax "invalid chat setting (2013)".
//   - Model 'M2-her' caps max_tokens at 2048.

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { MINIMAX_ENDPOINT } from '../../../constants.js';
import { getPromptNames, postProcessPrompt, PROMPT_PROCESSING_TYPE } from '../../../prompt-converters.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

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

    const apiUrl = body.minimax_endpoint === MINIMAX_ENDPOINT.CN
        ? API_MINIMAX_CN : API_MINIMAX;

    const secretId = typeof body.secret_id === 'string' ? body.secret_id : undefined;
    const apiKey = ctx.secrets.read(SECRET_KEYS.MINIMAX, { secretId }) || '';

    if (!apiKey) {
        ctx.emit.error(new Error('MiniMax key is missing'));
        return;
    }

    ctx.inspection.start();

    try {
        // MiniMax does not allow consecutive messages with the same role.
        // Merge them into a single message to avoid "invalid chat setting (2013)".
        const messages = postProcessPrompt(body.messages, PROMPT_PROCESSING_TYPE.MERGE, getPromptNames({ body }));

        const bodyParams = {};

        if (Array.isArray(body.tools) && body.tools.length > 0) {
            bodyParams['tools'] = body.tools;
            bodyParams['tool_choice'] = body.tool_choice;
        }

        const requestBody = {
            'messages': messages,
            'model': body.model,
            'temperature': body.temperature,
            'max_tokens': body.model === 'M2-her' ? Math.min(body.max_tokens, 2048) : body.max_tokens,
            'stream': body.stream,
            'top_p': body.top_p,
            'stop': body.stop,
            ...bodyParams,
        };

        const fetchUrl = apiUrl + '/chat/completions';
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
            const msg = `MiniMax upstream ${resp.status}: ${errText}`;
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
