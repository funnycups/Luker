// SPDX-License-Identifier: AGPL-3.0-or-later

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import {
    extractImageFromChatCompletionResponse,
    formatReferenceCaption,
    normalizeChatCompletionsUrl,
    resolveSdSecret,
} from './sd-auth.js';

export async function dispatchSdChatImage(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('chat_image', body));

    try {
        const url = normalizeChatCompletionsUrl(body.api_url || 'https://api.openai.com/v1');
        const key = resolveSdSecret(ctx, [SECRET_KEYS.CUSTOM], { includeAllChatKeys: true });
        const model = String(body.model || '').trim();
        if (!model) {
            throw new Error('Chat image model is empty.');
        }

        const loadedRefs = await loadReferenceInputs(ctx.user?.directories, body.references);
        const promptParts = [String(body.prompt || '').trim()];
        if (body.negative_prompt) {
            promptParts.push(`Avoid: ${String(body.negative_prompt).trim()}`);
        }
        if (body.aspect_ratio) {
            promptParts.push(`Aspect ratio: ${String(body.aspect_ratio).trim()}`);
        }
        const finalPrompt = promptParts.filter(Boolean).join('\n');

        let userContent;
        if (loadedRefs.length > 0) {
            userContent = [];
            for (const ref of loadedRefs) {
                userContent.push({ type: 'text', text: formatReferenceCaption(ref) });
                userContent.push({ type: 'image_url', image_url: { url: ref.dataUrl } });
            }
            userContent.push({ type: 'text', text: finalPrompt });
        } else {
            userContent = finalPrompt;
        }

        const requestBody = {
            model,
            messages: [{ role: 'user', content: userContent }],
            stream: false,
        };

        ctx.inspection.attach(url, key);
        const result = await ctx.fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });

        ctx.emit.head({ status: result.status, headers: result.headers });
        if (!result.ok) {
            const errText = await result.text().catch(() => '');
            const err = new Error(`Chat image provider returned HTTP ${result.status}`);
            ctx.inspection.failImage(err, result.status || 500);
            if (errText) ctx.emit.chunk(new TextEncoder().encode(errText));
            ctx.emit.end();
            return;
        }

        const data = await result.json();
        const extracted = await extractImageFromChatCompletionResponse(data, ctx.fetch, ctx.signal);
        ctx.inspection.completeImage({ format: extracted.format, data: extracted.image });
        ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(extracted)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 400);
        ctx.emit.error(error);
    }
}
