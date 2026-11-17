// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from 'node:buffer';

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import {
    buildMultipartImageEditsPayload,
    normalizeImagesBaseUrl,
    resolveSdSecret,
    stripInternalSdDispatchFields,
} from './sd-auth.js';

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

export async function dispatchSdOpenaiImage(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('openai', body));

    try {
        const key = resolveSdSecret(ctx, [SECRET_KEYS.OPENAI]);
        const loadedRefs = await loadReferenceInputs(ctx.user?.directories, body.references);
        const baseUrl = normalizeImagesBaseUrl(body.api_url, DEFAULT_OPENAI_BASE);
        const model = String(body.model || '').trim();

        let targetUrl;
        let fetchOptions;

        if (loadedRefs.length > 0) {
            if (/dall-e-3/i.test(model)) {
                throw new Error(`OpenAI model "${model}" does not support reference image edits. Select gpt-image-1 or gpt-image-2.`);
            }
            targetUrl = `${baseUrl}/images/edits`;
            const isDalle2 = /dall-e-2/i.test(model);
            if (isDalle2 && loadedRefs.length > 1) {
                throw new Error(`OpenAI model "${model}" supports at most 1 reference image.`);
            }
            const multipart = buildMultipartImageEditsPayload({
                fields: {
                    model,
                    prompt: body.prompt,
                    size: body.size,
                    n: body.n ?? 1,
                    quality: body.quality,
                    response_format: body.response_format,
                },
                loadedRefs,
                singleField: isDalle2,
            });
            fetchOptions = {
                method: 'POST',
                headers: {
                    ...multipart.headers,
                    'Authorization': `Bearer ${key}`,
                },
                body: multipart.body,
                signal: ctx.signal,
            };
        } else {
            targetUrl = `${baseUrl}/images/generations`;
            const cleanBody = stripInternalSdDispatchFields(body);
            fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                body: JSON.stringify(cleanBody),
                signal: ctx.signal,
            };
        }

        ctx.inspection.attach(targetUrl, key);
        const result = await ctx.fetch(targetUrl, fetchOptions);
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            const err = new Error(`OpenAI image generation failed (${result.status})`);
            ctx.inspection.failImage(err, result.status || 500);
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const data = await result.json();
        const firstItem = data?.data?.[0];
        if (firstItem && !firstItem.b64_json && typeof firstItem.url === 'string') {
            const imgResp = await ctx.fetch(firstItem.url, { method: 'GET', signal: ctx.signal });
            if (!imgResp.ok) {
                throw new Error(`Failed to fetch OpenAI generated image URL (${imgResp.status}).`);
            }
            firstItem.b64_json = Buffer.from(await imgResp.arrayBuffer()).toString('base64');
        }

        const b64 = String(firstItem?.b64_json || '');
        if (!b64) {
            throw new Error('OpenAI image response did not include b64_json data.');
        }

        ctx.inspection.completeImage({ format: 'png', data: b64 });
        ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(data)));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 400);
        ctx.emit.error(error);
    }
}
