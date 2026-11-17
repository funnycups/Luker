// SPDX-License-Identifier: AGPL-3.0-or-later

import { OPENROUTER_HEADERS } from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import {
    extractImageFromChatCompletionResponse,
    formatReferenceCaption,
    normalizeChatCompletionsUrl,
    resolveSdSecret,
} from './sd-auth.js';

const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export async function dispatchSdOpenrouterImage(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('openrouter', body));

    try {
        const key = resolveSdSecret(ctx, [SECRET_KEYS.OPENROUTER]);
        const model = String(body.model || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!model || !prompt) {
            throw new Error('OpenRouter image generation requires both model and prompt.');
        }

        const loadedRefs = await loadReferenceInputs(ctx.user?.directories, body.references);
        const url = normalizeChatCompletionsUrl(body.api_url || DEFAULT_OPENROUTER_BASE);

        let userContent;
        if (loadedRefs.length > 0) {
            userContent = [];
            for (const ref of loadedRefs) {
                userContent.push({ type: 'text', text: formatReferenceCaption(ref) });
                userContent.push({ type: 'image_url', image_url: { url: ref.dataUrl } });
            }
            userContent.push({ type: 'text', text: prompt });
        } else {
            userContent = prompt;
        }

        const requestBody = {
            model,
            messages: [
                {
                    role: 'user',
                    content: userContent,
                },
            ],
            modalities: ['image'],
            image_config: {
                aspect_ratio: body.aspect_ratio || '1:1',
            },
        };

        ctx.inspection.attach(url, key);
        const response = await ctx.fetch(url, {
            method: 'POST',
            headers: {
                ...OPENROUTER_HEADERS,
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        ctx.emit.head({ status: response.status, headers: response.headers });
        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            const err = new Error(`OpenRouter image generation failed (${response.status})`);
            ctx.inspection.failImage(err, response.status || 500);
            if (errText) {
                ctx.emit.chunk(new TextEncoder().encode(errText));
            }
            ctx.emit.end();
            return;
        }

        const data = await response.json();
        const extracted = await extractImageFromChatCompletionResponse(data, ctx.fetch, ctx.signal);
        ctx.inspection.completeImage({ format: extracted.format, data: extracted.image });
        ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(extracted)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 400);
        ctx.emit.error(error);
    }
}
