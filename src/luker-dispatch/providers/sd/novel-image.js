// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ResizeStrategy } from '@jimp/plugin-resize';

import '../../../fetch-patch.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { Jimp, JimpMime } from '../../../jimp.js';
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import { extractFileFromZipBuffer, trimTrailingSlash } from '../../../util.js';
import { resolveSdSecret } from './sd-auth.js';

const DEFAULT_API_NOVELAI = 'https://api.novelai.net';
const DEFAULT_IMAGE_NOVELAI = 'https://image.novelai.net';

const REFERENCE_PIXEL_COUNT = 1011712; // 832 * 1216
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

const MAX_NOVEL_REFERENCES_PER_CHANNEL = 4; // cap-ok: upstream director_reference_images and reference_image_multiple arrays accept at most 4 items

const DIRECTOR_TARGET_SIZES = Object.freeze([
    { width: 1024, height: 1536 },
    { width: 1472, height: 1472 },
    { width: 1536, height: 1024 },
]);

const VIBE_MODEL_KEY_ALIASES = Object.freeze({
    'v4-5full': 'nai-diffusion-4-5-full',
    'v4-5curated': 'nai-diffusion-4-5-curated',
    'v4full': 'nai-diffusion-4-full',
    'v4curated': 'nai-diffusion-4-curated-preview',
    'v3': 'nai-diffusion-3',
    'furry3': 'nai-diffusion-furry-3',
});

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magicConstant = String(modelName || '').includes('nai-diffusion-4-5')
        ? SIGMA_MAGIC_NUMBER_V4_5
        : SIGMA_MAGIC_NUMBER;
    const pixelCount = width * height;
    const ratio = pixelCount / REFERENCE_PIXEL_COUNT;
    return Math.pow(ratio, 0.5) * magicConstant;
}

function isNovelV45Model(model) {
    return /^nai-diffusion-4-5\b/i.test(String(model || '').trim());
}

function isNovelV4OrLaterModel(model) {
    return /^nai-diffusion-4\b/i.test(String(model || '').trim());
}

function isNovelV3Model(model) {
    return /^nai-diffusion-(?:furry-)?3\b/i.test(String(model || '').trim());
}

function sanitizeCacheModelKey(model) {
    return String(model || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

function getVibeCacheDir(directories) {
    const root = directories?.root;
    if (!root) {
        return null;
    }
    return path.join(root, 'thumbnails', '_nai_vibes');
}

function getVibeCachePath(directories, fileSha256, model) {
    const cacheDir = getVibeCacheDir(directories);
    if (!cacheDir) {
        return null;
    }
    return path.join(cacheDir, `${fileSha256}_${sanitizeCacheModelKey(model)}.json`);
}

function readCachedVibeEncoding(directories, fileSha256, model) {
    const cachePath = getVibeCachePath(directories, fileSha256, model);
    if (!cachePath || !fs.existsSync(cachePath)) {
        return null;
    }
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return typeof raw?.encoding === 'string' && raw.encoding ? raw.encoding : null;
}

function writeCachedVibeEncoding(directories, fileSha256, model, encoding) {
    const cachePath = getVibeCachePath(directories, fileSha256, model);
    if (!cachePath) {
        return;
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileAtomicSync(cachePath, JSON.stringify({
        sha256: fileSha256,
        model,
        encoding,
        updatedAt: Date.now(),
    }), 'utf8');
}

export async function padImageForNovelDirectorRef(buffer) {
    const image = await Jimp.read(Buffer.from(buffer));
    const origW = Math.max(1, image.bitmap.width);
    const origH = Math.max(1, image.bitmap.height);
    const origRatio = origW / origH;

    let bestBucket = DIRECTOR_TARGET_SIZES[0];
    let bestDist = Infinity;
    for (const bucket of DIRECTOR_TARGET_SIZES) {
        const dist = Math.abs(Math.log(origRatio / (bucket.width / bucket.height)));
        if (dist < bestDist) {
            bestDist = dist;
            bestBucket = bucket;
        }
    }

    const scale = Math.min(bestBucket.width / origW, bestBucket.height / origH);
    const scaledW = Math.max(1, Math.round(origW * scale));
    const scaledH = Math.max(1, Math.round(origH * scale));
    const resized = image.clone().resize({ w: scaledW, h: scaledH, mode: ResizeStrategy.BILINEAR });

    const canvas = new Jimp({ width: bestBucket.width, height: bestBucket.height, color: 0x000000ff });
    const offsetX = Math.floor((bestBucket.width - scaledW) / 2);
    const offsetY = Math.floor((bestBucket.height - scaledH) / 2);
    canvas.blit({ src: resized, x: offsetX, y: offsetY });

    const pngBuf = await canvas.getBuffer(JimpMime.png);
    return Buffer.from(pngBuf).toString('base64');
}

async function resolveStyleVibeEncoding({ directories, ref, model, fetchFn, key, imageBaseUrl, signal }) {
    if (isNovelV3Model(model)) {
        return ref.base64;
    }
    if (!isNovelV4OrLaterModel(model)) {
        throw new Error(`NovelAI model "${model}" does not support style/vibe references.`);
    }

    const fileSha256 = ref.sha256 || crypto.createHash('sha256').update(ref.buffer).digest('hex');
    const cached = readCachedVibeEncoding(directories, fileSha256, model);
    if (cached) {
        return cached;
    }

    const encodeUrl = `${trimTrailingSlash(imageBaseUrl || DEFAULT_IMAGE_NOVELAI)}/ai/encode-vibe`;
    const response = await fetchFn(encodeUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            image: ref.base64,
            information_extracted: 1,
            model,
        }),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`NovelAI encode-vibe failed (${response.status}): ${errText}`);
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    let encoding = '';
    if (contentType.includes('application/json')) {
        const json = await response.json();
        encoding = String(json?.encoding || '');
    } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        encoding = bytes.toString('base64');
    }

    if (!encoding) {
        throw new Error('NovelAI encode-vibe returned an empty encoding.');
    }

    writeCachedVibeEncoding(directories, fileSha256, model, encoding);
    return encoding;
}

export async function importNovelVibeFile({ directories, fileName, content }) {
    if (!directories?.userImages) {
        throw new Error('User images directory is unavailable.');
    }
    let parsed;
    try {
        parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (err) {
        throw new Error(`Invalid .naiv4vibe JSON file: ${err.message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid .naiv4vibe payload.');
    }

    const extractedByModel = new Map();
    if (parsed.encodings && typeof parsed.encodings === 'object') {
        for (const [rawModelKey, group] of Object.entries(parsed.encodings)) {
            const canonicalModel = VIBE_MODEL_KEY_ALIASES[rawModelKey] || rawModelKey;
            if (typeof group === 'string' && group) {
                extractedByModel.set(canonicalModel, group);
            } else if (group && typeof group === 'object') {
                const firstEntry = Object.values(group).find(v => typeof v?.encoding === 'string' && v.encoding);
                if (firstEntry) {
                    extractedByModel.set(canonicalModel, firstEntry.encoding);
                }
            }
        }
    } else if (typeof parsed.encoding === 'string' && parsed.encoding) {
        const canonicalModel = VIBE_MODEL_KEY_ALIASES[parsed.model] || parsed.model || 'nai-diffusion-4-5-full';
        extractedByModel.set(canonicalModel, parsed.encoding);
    }

    if (extractedByModel.size === 0) {
        throw new Error('No vibe encodings found in .naiv4vibe file.');
    }

    let previewBuffer = null;
    const rawPreview = parsed.image || parsed.thumbnail || '';
    if (typeof rawPreview === 'string' && rawPreview.trim()) {
        const b64 = rawPreview.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').trim();
        try {
            const decoded = Buffer.from(b64, 'base64');
            await Jimp.read(decoded);
            previewBuffer = decoded;
        } catch {
            previewBuffer = null;
        }
    }

    if (!previewBuffer) {
        // Embed a deterministic hash of the vibe payload into pixel colors so each distinct .naiv4vibe has a unique SHA-256.
        const digest = crypto.createHash('sha256').update(JSON.stringify([...extractedByModel.entries()])).digest();
        const swatch = new Jimp({ width: 64, height: 64, color: 0x222634ff });
        for (let i = 0; i < 32; i++) {
            const r = digest[i % digest.length];
            const g = digest[(i + 7) % digest.length];
            const b = digest[(i + 13) % digest.length];
            const rgba = ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
            swatch.setPixelColor(rgba, i, 0);
        }
        previewBuffer = Buffer.from(await swatch.getBuffer(JimpMime.png));
    }

    const fileSha256 = crypto.createHash('sha256').update(previewBuffer).digest('hex');
    const baseStem = sanitize(path.basename(String(fileName || 'vibe'), '.naiv4vibe')).replace(/[^a-zA-Z0-9_-]+/g, '_') || 'vibe';
    const outFileName = `${baseStem}_${fileSha256.slice(0, 12)}.png`;
    const styleDir = path.join(directories.userImages, '_style_references');
    fs.mkdirSync(styleDir, { recursive: true });
    writeFileAtomicSync(path.join(styleDir, outFileName), previewBuffer);

    for (const [modelName, encoding] of extractedByModel.entries()) {
        writeCachedVibeEncoding(directories, fileSha256, modelName, encoding);
    }

    const strength = Number(parsed?.importInfo?.strength);
    return {
        imagePath: `/user/images/_style_references/${outFileName}`,
        strength: Number.isFinite(strength) ? strength : 0.6,
        models: [...extractedByModel.keys()],
    };
}

export async function buildNovelGenerationPayload({
    directories,
    body,
    fetchFn,
    key,
    imageBaseUrl,
    signal,
}) {
    const model = String(body.model ?? 'nai-diffusion-4-5-full').trim();
    const prompt = String(body.prompt ?? '');
    const negativePrompt = String(body.negative_prompt ?? '');
    const width = Number(body.width ?? 832);
    const height = Number(body.height ?? 1216);
    const seed = Number(body.seed) >= 0 ? Number(body.seed) : Math.floor(Math.random() * 9999999999);
    const isV4Plus = isNovelV4OrLaterModel(model);
    const isV45 = isNovelV45Model(model);

    const loadedRefs = await loadReferenceInputs(directories, body.references);
    const charRefs = loadedRefs.filter(r => r.role === 'character');
    const styleRefs = loadedRefs.filter(r => r.role === 'style');
    const sourceRefs = loadedRefs.filter(r => r.role === 'source');

    if (charRefs.length > 0 && !isV45) {
        throw new Error(`NovelAI model "${model}" does not support character references. Switch to a V4.5 model.`);
    }
    if (charRefs.length > MAX_NOVEL_REFERENCES_PER_CHANNEL) {
        throw new Error(`NovelAI supports at most ${MAX_NOVEL_REFERENCES_PER_CHANNEL} character references.`);
    }
    if (styleRefs.length > MAX_NOVEL_REFERENCES_PER_CHANNEL) {
        throw new Error(`NovelAI supports at most ${MAX_NOVEL_REFERENCES_PER_CHANNEL} style references.`);
    }
    if (sourceRefs.length > 1) {
        throw new Error('NovelAI img2img supports at most 1 source image.');
    }

    const rawCharPrompts = Array.isArray(body.characterPrompts) ? body.characterPrompts : [];
    const normalizedCharPrompts = rawCharPrompts
        .filter(item => item && typeof item.prompt === 'string' && item.prompt.trim())
        .map(item => {
            const hasCenter = Number.isFinite(Number(item?.center?.x)) && Number.isFinite(Number(item?.center?.y));
            const center = hasCenter
                ? { x: Number(item.center.x), y: Number(item.center.y) }
                : { x: 0.5, y: 0.5 };
            return {
                prompt: item.prompt.trim(),
                negativePrompt: String(item.negativePrompt ?? item.negative_prompt ?? '').trim(),
                center,
                hasCenter,
            };
        });
    const useCoords = normalizedCharPrompts.some(item => item.hasCenter);

    const sm = isV4Plus || body.sampler === 'ddim' ? false : Boolean(body.sm ?? false);
    const smDyn = isV4Plus || body.sampler === 'ddim' ? false : Boolean(body.sm_dyn ?? false);

    /** @type {Record<string, any>} */
    const parameters = {
        params_version: 3,
        prefer_brownian: true,
        negative_prompt: negativePrompt,
        height,
        width,
        scale: body.scale ?? 5.5,
        seed,
        sampler: body.sampler ?? 'k_euler_ancestral',
        noise_schedule: body.scheduler ?? 'karras',
        steps: body.steps ?? 28,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: false,
        add_original_image: sourceRefs.length > 0,
        controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false,
        dynamic_thresholding: Boolean(body.decrisper ?? false),
        legacy: false,
        legacy_v3_extend: false,
        sm,
        sm_dyn: smDyn,
        uncond_scale: 1,
        skip_cfg_above_sigma: body.variety_boost
            ? calculateSkipCfgAboveSigma(width, height, model)
            : null,
        use_coords: useCoords,
        characterPrompts: normalizedCharPrompts.map(item => ({
            prompt: item.prompt,
            uc: item.negativePrompt,
            center: item.center,
            enabled: true,
        })),
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        v4_negative_prompt: {
            caption: {
                base_caption: negativePrompt,
                char_captions: normalizedCharPrompts.map(item => ({
                    char_caption: item.negativePrompt,
                    centers: [item.center],
                })),
            },
            legacy_uc: false,
        },
        v4_prompt: {
            caption: {
                base_caption: prompt,
                char_captions: normalizedCharPrompts.map(item => ({
                    char_caption: item.prompt,
                    centers: [item.center],
                })),
            },
            use_coords: useCoords,
            use_order: true,
        },
    };

    if (charRefs.length > 0) {
        const paddedImages = [];
        const descriptions = [];
        const infoExtracted = [];
        const strengths = [];
        const secondaryStrengths = [];
        for (const ref of charRefs) {
            paddedImages.push(await padImageForNovelDirectorRef(ref.buffer));
            descriptions.push({
                caption: {
                    base_caption: ref.styleAware ? 'character&style' : 'character',
                    char_captions: [],
                },
                legacy_uc: false,
            });
            infoExtracted.push(1);
            strengths.push(Number((ref.strength ?? 0.6).toFixed(4)));
            secondaryStrengths.push(Number((1 - (ref.fidelity ?? 1)).toFixed(4)));
        }
        parameters.director_reference_images = paddedImages;
        parameters.director_reference_descriptions = descriptions;
        parameters.director_reference_information_extracted = infoExtracted;
        parameters.director_reference_strength_values = strengths;
        parameters.director_reference_secondary_strength_values = secondaryStrengths;
    }

    if (styleRefs.length > 0) {
        const encodedStyles = [];
        const styleInfo = [];
        const styleStrengths = [];
        for (const ref of styleRefs) {
            encodedStyles.push(await resolveStyleVibeEncoding({
                directories,
                ref,
                model,
                fetchFn,
                key,
                imageBaseUrl,
                signal,
            }));
            styleInfo.push(1);
            styleStrengths.push(Number((ref.strength ?? 0.6).toFixed(4)));
        }
        parameters.reference_image_multiple = encodedStyles;
        parameters.reference_information_extracted_multiple = styleInfo;
        parameters.reference_strength_multiple = styleStrengths;
    }

    let action = 'generate';
    if (sourceRefs.length > 0) {
        action = 'img2img';
        parameters.image = sourceRefs[0].base64;
        parameters.strength = Number((sourceRefs[0].strength ?? 0.7).toFixed(4));
        parameters.noise = 0;
        parameters.extra_noise_seed = seed;
    }

    return {
        action,
        input: prompt,
        model,
        parameters,
    };
}

export async function dispatchSdNovelImage(ctx) {
    const body = ctx.body || {};
    ctx.inspection.startImage(extractImageMeta('novel', body));

    try {
        const key = resolveSdSecret(ctx, [SECRET_KEYS.NOVEL]);
        const imageBaseUrl = trimTrailingSlash(String(body.novel_url || body.api_url || DEFAULT_IMAGE_NOVELAI).trim()) || DEFAULT_IMAGE_NOVELAI;
        const payload = await buildNovelGenerationPayload({
            directories: ctx.user?.directories,
            body,
            fetchFn: ctx.fetch,
            key,
            imageBaseUrl,
            signal: ctx.signal,
        });

        const generateUrl = `${imageBaseUrl}/ai/generate-image`;
        ctx.inspection.attach(generateUrl, key);
        const generateResult = await ctx.fetch(generateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: ctx.signal,
        });

        ctx.emit.head({ status: generateResult.status, headers: generateResult.headers });
        if (!generateResult.ok) {
            const text = await generateResult.text().catch(() => '');
            const err = new Error(`NovelAI returned HTTP ${generateResult.status}`);
            ctx.inspection.failImage(err, generateResult.status || 500);
            if (text) {
                ctx.emit.chunk(new TextEncoder().encode(text));
            }
            ctx.emit.end();
            return;
        }

        const archiveBuffer = await generateResult.arrayBuffer();
        const imageBuffer = await extractFileFromZipBuffer(archiveBuffer, '.png');
        if (!imageBuffer) {
            throw new Error('NovelAI generated an archive, but no PNG file was found.');
        }

        let finalBase64 = imageBuffer.toString('base64');

        if (!isNaN(Number(body.upscale_ratio)) && Number(body.upscale_ratio) > 1) {
            const upscaleBase = trimTrailingSlash(String(body.novel_url || DEFAULT_API_NOVELAI).trim()) || DEFAULT_API_NOVELAI;
            const upscaleUrl = `${upscaleBase}/ai/upscale`;
            const upscaleResult = await ctx.fetch(upscaleUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    image: finalBase64,
                    height: payload.parameters.height,
                    width: payload.parameters.width,
                    scale: body.upscale_ratio,
                }),
                signal: ctx.signal,
            });
            if (upscaleResult.ok) {
                const upscaledArchive = await upscaleResult.arrayBuffer();
                const upscaledPng = await extractFileFromZipBuffer(upscaledArchive, '.png');
                if (upscaledPng) {
                    finalBase64 = upscaledPng.toString('base64');
                }
            }
        }

        ctx.inspection.completeImage({ format: 'png', data: finalBase64 });
        ctx.emit.chunk(new TextEncoder().encode(finalBase64));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 400);
        ctx.emit.error(error);
    }
}
