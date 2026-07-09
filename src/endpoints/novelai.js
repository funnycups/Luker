import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';
import express from 'express';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { readAllChunks, extractFileFromZipBuffer } from '../util.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { dispatchNovelAI } from '../luker-dispatch/providers/novelai.js';

const API_NOVELAI = 'https://api.novelai.net';
const IMAGE_NOVELAI = 'https://image.novelai.net';

// Constants for skip_cfg_above_sigma (Variety+) calculation
const REFERENCE_PIXEL_COUNT = 1011712;   // 832 * 1216 reference image size
const SIGMA_MAGIC_NUMBER = 19;           // Base sigma multiplier for V3 and V4 models
const SIGMA_MAGIC_NUMBER_V4_5 = 58;      // Base sigma multiplier for V4.5 models

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magicConstant = modelName?.includes('nai-diffusion-4-5')
        ? SIGMA_MAGIC_NUMBER_V4_5
        : SIGMA_MAGIC_NUMBER;

    const pixelCount = width * height;
    const ratio = pixelCount / REFERENCE_PIXEL_COUNT;

    return Math.pow(ratio, 0.5) * magicConstant;
}

export const router = express.Router();

router.post('/status', async function (req, res) {
    if (!req.body) return res.sendStatus(400);
    const api_key_novel = readSecret(req.user.directories, SECRET_KEYS.NOVEL);

    if (!api_key_novel) {
        console.warn('NovelAI Access Token is missing.');
        return res.sendStatus(400);
    }

    try {
        const response = await fetch(API_NOVELAI + '/user/subscription', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + api_key_novel,
            },
        });

        if (response.ok) {
            const data = await response.json();
            return res.send(data);
        } else if (response.status == 401) {
            console.error('NovelAI Access Token is incorrect.');
            return res.send({ error: true });
        } else {
            console.warn('NovelAI returned an error:', response.statusText);
            return res.send({ error: true });
        }
    } catch (error) {
        console.error(error);
        return res.send({ error: true });
    }
});

router.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'novelai',
    select: () => dispatchNovelAI,
}));

router.post('/generate-image', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    const key = readSecret(request.user.directories, SECRET_KEYS.NOVEL);

    if (!key) {
        console.warn('NovelAI Access Token is missing.');
        return response.sendStatus(400);
    }

    try {
        console.debug('NAI Diffusion request:', request.body);
        const generateUrl = `${IMAGE_NOVELAI}/ai/generate-image`;
        const generateResult = await fetch(generateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'generate',
                input: request.body.prompt ?? '',
                model: request.body.model ?? 'nai-diffusion',
                parameters: {
                    params_version: 3,
                    prefer_brownian: true,
                    negative_prompt: request.body.negative_prompt ?? '',
                    height: request.body.height ?? 512,
                    width: request.body.width ?? 512,
                    scale: request.body.scale ?? 9,
                    seed: request.body.seed >= 0 ? request.body.seed : Math.floor(Math.random() * 9999999999),
                    sampler: request.body.sampler ?? 'k_dpmpp_2m',
                    noise_schedule: request.body.scheduler ?? 'karras',
                    steps: request.body.steps ?? 28,
                    n_samples: 1,
                    // NAI handholding for prompts
                    ucPreset: 0,
                    qualityToggle: false,
                    add_original_image: false,
                    controlnet_strength: 1,
                    deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: request.body.decrisper ?? false,
                    legacy: false,
                    legacy_v3_extend: false,
                    sm: request.body.sm ?? false,
                    sm_dyn: request.body.sm_dyn ?? false,
                    uncond_scale: 1,
                    skip_cfg_above_sigma: request.body.variety_boost
                        ? calculateSkipCfgAboveSigma(
                            request.body.width ?? 512,
                            request.body.height ?? 512,
                            request.body.model ?? 'nai-diffusion',
                        )
                        : null,
                    use_coords: false,
                    characterPrompts: [],
                    reference_image_multiple: [],
                    reference_information_extracted_multiple: [],
                    reference_strength_multiple: [],
                    v4_negative_prompt: {
                        caption: {
                            base_caption: request.body.negative_prompt ?? '',
                            char_captions: [],
                        },
                    },
                    v4_prompt: {
                        caption: {
                            base_caption: request.body.prompt ?? '',
                            char_captions: [],
                        },
                        use_coords: false,
                        use_order: true,
                    },
                },
            }),
        });

        if (!generateResult.ok) {
            const text = await generateResult.text();
            console.warn('NovelAI returned an error.', generateResult.statusText, text);
            return response.sendStatus(500);
        }

        const archiveBuffer = await generateResult.arrayBuffer();
        const imageBuffer = await extractFileFromZipBuffer(archiveBuffer, '.png');

        if (!imageBuffer) {
            console.error('NovelAI generated an image, but the PNG file was not found.');
            return response.sendStatus(500);
        }

        const originalBase64 = imageBuffer.toString('base64');

        // No upscaling
        if (isNaN(request.body.upscale_ratio) || request.body.upscale_ratio <= 1) {
            return response.send(originalBase64);
        }

        try {
            console.info('Upscaling image...');
            const upscaleUrl = `${API_NOVELAI}/ai/upscale`;
            const upscaleResult = await fetch(upscaleUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    image: originalBase64,
                    height: request.body.height,
                    width: request.body.width,
                    scale: request.body.upscale_ratio,
                }),
            });

            if (!upscaleResult.ok) {
                const text = await upscaleResult.text();
                throw new Error('NovelAI returned an error.', { cause: text });
            }

            const upscaledArchiveBuffer = await upscaleResult.arrayBuffer();
            const upscaledImageBuffer = await extractFileFromZipBuffer(upscaledArchiveBuffer, '.png');

            if (!upscaledImageBuffer) {
                throw new Error('NovelAI upscaled an image, but the PNG file was not found.');
            }

            const upscaledBase64 = upscaledImageBuffer.toString('base64');

            return response.send(upscaledBase64);
        } catch (error) {
            console.warn('NovelAI generated an image, but upscaling failed. Returning original image.', error);
            return response.send(originalBase64);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/generate-voice', async (request, response) => {
    const token = readSecret(request.user.directories, SECRET_KEYS.NOVEL);

    if (!token) {
        console.error('NovelAI Access Token is missing.');
        return response.sendStatus(400);
    }

    const text = request.body.text;
    const voice = request.body.voice;

    if (!text || !voice) {
        return response.sendStatus(400);
    }

    try {
        const url = `${API_NOVELAI}/ai/generate-voice?text=${encodeURIComponent(text)}&voice=-1&seed=${encodeURIComponent(voice)}&opus=false&version=v2`;
        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'audio/mpeg',
            },
        });

        if (!result.ok) {
            const errorText = await result.text();
            console.error('NovelAI returned an error.', result.statusText, errorText);
            return response.sendStatus(500);
        }

        const chunks = await readAllChunks(result.body);
        const buffer = Buffer.concat(chunks.map(chunk => new Uint8Array(chunk)));
        response.setHeader('Content-Type', 'audio/mpeg');
        return response.send(buffer);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
