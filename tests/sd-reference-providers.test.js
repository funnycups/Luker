import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';

import { SECRET_KEYS, writeSecret } from '../src/endpoints/secrets.js';
import { dispatchSdGoogleImage } from '../src/luker-dispatch/providers/sd/google-image.js';
import { dispatchSdChatImage } from '../src/luker-dispatch/providers/sd/chat-image.js';
import { dispatchSdOpenaiImage } from '../src/luker-dispatch/providers/sd/openai-image.js';
import { dispatchSdOpenrouterImage } from '../src/luker-dispatch/providers/sd/openrouter-image.js';
import { dispatchSdXai } from '../src/luker-dispatch/providers/sd/xai.js';
import { dispatchSdWebui } from '../src/luker-dispatch/providers/sd/webui.js';
import { dispatchSdPollinations } from '../src/luker-dispatch/providers/sd/pollinations.js';
import { PROXY_PATTERNS } from '../public/scripts/ws-delivery.js';

const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeTestCtx({ directories, body }) {
    const chunks = [];
    const heads = [];
    const errors = [];
    const controller = new AbortController();
    return {
        body,
        user: { handle: 'default-user', directories, profile: { handle: 'default-user' } },
        signal: controller.signal,
        fetch,
        secrets: {
            read(key, opts) {
                if (opts && Object.hasOwn(opts, 'secretId')) {
                    return null;
                }
                return null;
            },
        },
        inspection: {
            startImage() {},
            attach() {},
            completeImage() {},
            failImage() {},
        },
        emit: {
            head(h) { heads.push(h); },
            chunk(bytes) { chunks.push(Buffer.from(bytes)); },
            end() {},
            error(err) { errors.push(err); },
        },
        readJsonOutput() {
            const raw = Buffer.concat(chunks).toString('utf8');
            return raw ? JSON.parse(raw) : null;
        },
        readRawOutput() {
            return Buffer.concat(chunks).toString('utf8');
        },
        heads,
        errors,
    };
}

describe('Google Gemini native image and chat_image multimodal reference providers', () => {
    let tmpRoot;
    let directories;
    let upstreamServer;
    let upstreamUrl;
    let receivedRequests;

    beforeAll(async () => {
        receivedRequests = [];
        upstreamServer = http.createServer((req, res) => {
            const bodyChunks = [];
            req.on('data', c => bodyChunks.push(c));
            req.on('end', () => {
                const rawBody = Buffer.concat(bodyChunks).toString('utf8');
                let jsonBody = null;
                try { jsonBody = JSON.parse(rawBody); } catch { jsonBody = null; }
                receivedRequests.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: jsonBody,
                    rawBody,
                });

                if (req.url.includes(':generateContent')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [
                                    { text: 'Rendered character scene.' },
                                    { inlineData: { mimeType: 'image/png', data: PNG_1X1_B64 } },
                                ],
                            },
                        }],
                    }));
                    return;
                }

                if (req.url.includes(':predict')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        predictions: [{ bytesBase64Encoded: PNG_1X1_B64 }],
                    }));
                    return;
                }

                if (req.url === '/v1/chat/completions') {
                    const mode = req.headers['x-test-response-shape'] || 'images_array';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (mode === 'content_parts') {
                        res.end(JSON.stringify({
                            choices: [{
                                message: {
                                    role: 'assistant',
                                    content: [
                                        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1_B64}` } },
                                    ],
                                },
                            }],
                        }));
                    } else {
                        res.end(JSON.stringify({
                            choices: [{
                                message: {
                                    role: 'assistant',
                                    content: '',
                                    images: [{ image_url: { url: `data:image/png;base64,${PNG_1X1_B64}` } }],
                                },
                            }],
                        }));
                    }
                    return;
                }

                if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        data: [{ b64_json: PNG_1X1_B64 }],
                    }));
                    return;
                }

                if (req.url === '/sdapi/v1/options') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sd_model_checkpoint: 'test.safetensors' }));
                    return;
                }

                if (req.url === '/sdapi/v1/img2img' || req.url === '/sdapi/v1/txt2img') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ images: [PNG_1X1_B64] }));
                    return;
                }

                res.writeHead(404);
                res.end('not found');
            });
        });
        await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
        const addr = upstreamServer.address();
        upstreamUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => upstreamServer.close(resolve));
    });

    beforeEach(() => {
        receivedRequests.length = 0;
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sd-ref-prov-'));
        directories = {
            root: tmpRoot,
            userImages: path.join(tmpRoot, 'user', 'images'),
            characters: path.join(tmpRoot, 'characters'),
            avatars: path.join(tmpRoot, 'User Avatars'),
        };
        fs.mkdirSync(path.join(directories.userImages, '_references'), { recursive: true });
        fs.mkdirSync(path.join(directories.userImages, '_style_references'), { recursive: true });
        fs.writeFileSync(path.join(directories.userImages, '_references', 'char1.png'), Buffer.from(PNG_1X1_B64, 'base64'));
        fs.writeFileSync(path.join(directories.userImages, '_style_references', 'style1.png'), Buffer.from(PNG_1X1_B64, 'base64'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('dispatchSdGoogleImage sends interleaved reference parts and aspectRatio via :generateContent using bound secret_id', async () => {
        const defaultId = writeSecret(directories, SECRET_KEYS.MAKERSUITE, 'global-default-key');
        expect(defaultId).toBeTruthy();
        const profileSecretId = writeSecret(directories, SECRET_KEYS.MAKERSUITE, 'profile-gemini-key');

        const ctx = makeTestCtx({
            directories,
            body: {
                model: 'gemini-2.5-flash-image',
                api: 'makersuite',
                api_url: upstreamUrl,
                secret_id: profileSecretId,
                prompt: 'standing under neon rain',
                aspect_ratio: '2:3',
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character', label: '星 — 常服' },
                    { imagePath: '/user/images/_style_references/style1.png', role: 'style' },
                ],
            },
        });

        await dispatchSdGoogleImage(ctx);
        expect(ctx.errors).toHaveLength(0);
        const output = ctx.readJsonOutput();
        expect(output).toEqual({ image: PNG_1X1_B64, format: 'png' });

        expect(receivedRequests).toHaveLength(1);
        const req = receivedRequests[0];
        expect(req.url).toBe('/v1beta/models/gemini-2.5-flash-image:generateContent');
        expect(req.headers['x-goog-api-key']).toBe('profile-gemini-key');
        expect(req.body.generationConfig).toMatchObject({
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '2:3' },
        });
        const parts = req.body.contents[0].parts;
        expect(parts).toEqual([
            { text: '[Character reference: 星 — 常服]' },
            { inlineData: { mimeType: 'image/png', data: PNG_1X1_B64 } },
            { text: '[Style reference]' },
            { inlineData: { mimeType: 'image/png', data: PNG_1X1_B64 } },
            { text: 'standing under neon rain' },
        ]);
    });

    test('dispatchSdGoogleImage rejects missing secret_id instead of falling back to default key, and rejects references on Imagen :predict', async () => {
        writeSecret(directories, SECRET_KEYS.MAKERSUITE, 'global-default-key');

        const badSecretCtx = makeTestCtx({
            directories,
            body: {
                model: 'gemini-2.5-flash-image',
                api: 'makersuite',
                api_url: upstreamUrl,
                secret_id: 'nonexistent-secret-id',
                prompt: 'a cat',
            },
        });
        await dispatchSdGoogleImage(badSecretCtx);
        expect(badSecretCtx.errors).toHaveLength(1);
        expect(badSecretCtx.errors[0].message).toMatch(/nonexistent-secret-id/);
        expect(receivedRequests).toHaveLength(0);

        const imagenRefCtx = makeTestCtx({
            directories,
            body: {
                model: 'imagen-4.0-generate-001',
                api: 'makersuite',
                api_url: upstreamUrl,
                prompt: 'a cat',
                references: [{ imagePath: '/user/images/_references/char1.png', role: 'character' }],
            },
        });
        await dispatchSdGoogleImage(imagenRefCtx);
        expect(imagenRefCtx.errors).toHaveLength(1);
        expect(imagenRefCtx.errors[0].message).toMatch(/does not support reference images/i);
    });

    test('dispatchSdChatImage sends interleaved text + image_url parts and parses images from message.images and content[]', async () => {
        const customSecretId = writeSecret(directories, SECRET_KEYS.CUSTOM, 'relay-secret-token');

        const ctx1 = makeTestCtx({
            directories,
            body: {
                model: 'gpt-4o-image-relay',
                api_url: `${upstreamUrl}/v1`,
                secret_id: customSecretId,
                prompt: 'draw her smiling in a cafe',
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character', label: '林晚 — 风衣' },
                ],
            },
        });
        await dispatchSdChatImage(ctx1);
        expect(ctx1.errors).toHaveLength(0);
        expect(ctx1.readJsonOutput()).toEqual({ image: PNG_1X1_B64, format: 'png' });

        expect(receivedRequests).toHaveLength(1);
        const req1 = receivedRequests[0];
        expect(req1.url).toBe('/v1/chat/completions');
        expect(req1.headers.authorization).toBe('Bearer relay-secret-token');
        expect(req1.body.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '[Character reference: 林晚 — 风衣]' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1_B64}` } },
                    { type: 'text', text: 'draw her smiling in a cafe' },
                ],
            },
        ]);
    });

    test('dispatchSdOpenaiImage uses /v1/images/generations without refs and multipart /v1/images/edits with refs', async () => {
        const oaiSecretId = writeSecret(directories, SECRET_KEYS.OPENAI, 'oai-profile-key');

        const genCtx = makeTestCtx({
            directories,
            body: {
                model: 'gpt-image-1',
                prompt: 'a quiet harbor at dawn',
                size: '1024x1024',
                n: 1,
                api_url: `${upstreamUrl}/v1`,
                secret_id: oaiSecretId,
            },
        });
        await dispatchSdOpenaiImage(genCtx);
        expect(genCtx.errors).toHaveLength(0);
        expect(genCtx.readJsonOutput()).toEqual({ data: [{ b64_json: PNG_1X1_B64 }] });
        expect(receivedRequests[0].url).toBe('/v1/images/generations');
        expect(receivedRequests[0].headers.authorization).toBe('Bearer oai-profile-key');
        expect(receivedRequests[0].body.secret_id).toBeUndefined();
        expect(receivedRequests[0].body.api_url).toBeUndefined();

        receivedRequests.length = 0;
        const editCtx = makeTestCtx({
            directories,
            body: {
                model: 'gpt-image-1',
                prompt: 'drinking tea by the window',
                size: '1024x1536',
                n: 1,
                api_url: `${upstreamUrl}/v1`,
                secret_id: oaiSecretId,
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character', label: '苏梨 — 校服' },
                    { imagePath: '/user/images/_style_references/style1.png', role: 'style', label: '水彩胶片' },
                ],
            },
        });
        await dispatchSdOpenaiImage(editCtx);
        expect(editCtx.errors).toHaveLength(0);
        expect(editCtx.readJsonOutput()).toEqual({ data: [{ b64_json: PNG_1X1_B64 }] });
        expect(receivedRequests).toHaveLength(1);
        const editReq = receivedRequests[0];
        expect(editReq.url).toBe('/v1/images/edits');
        expect(editReq.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(editReq.rawBody).toContain('name="image[]"');
        expect(editReq.rawBody).toContain('Reference image 1 (character): 苏梨 — 校服');
        expect(editReq.rawBody).toContain('Reference image 2 (style): 水彩胶片');
        expect(editReq.rawBody).toContain('drinking tea by the window');
    });

    test('dispatchSdXai switches to multipart /v1/images/edits when references are passed and honors secret_id + api_url', async () => {
        const xaiSecretId = writeSecret(directories, SECRET_KEYS.XAI, 'xai-profile-key');
        const ctx = makeTestCtx({
            directories,
            body: {
                model: 'grok-imagine-image',
                prompt: 'rooftop sunset',
                aspect_ratio: '16:9',
                api_url: `${upstreamUrl}/v1`,
                secret_id: xaiSecretId,
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character', label: 'Kiana' },
                ],
            },
        });
        await dispatchSdXai(ctx);
        expect(ctx.errors).toHaveLength(0);
        expect(ctx.readJsonOutput()).toEqual({ image: PNG_1X1_B64, format: 'png' });
        expect(receivedRequests).toHaveLength(1);
        expect(receivedRequests[0].url).toBe('/v1/images/edits');
        expect(receivedRequests[0].headers.authorization).toBe('Bearer xai-profile-key');
        expect(receivedRequests[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(receivedRequests[0].rawBody).toContain('Reference image 1 (character): Kiana');
    });

    test('dispatchSdOpenrouterImage builds multimodal messages[0].content array when references are supplied', async () => {
        const orSecretId = writeSecret(directories, SECRET_KEYS.OPENROUTER, 'or-profile-key');
        const ctx = makeTestCtx({
            directories,
            body: {
                model: 'google/gemini-2.5-flash-image-preview',
                prompt: 'walking through autumn leaves',
                aspect_ratio: '3:4',
                api_url: `${upstreamUrl}/v1`,
                secret_id: orSecretId,
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character', label: '白露' },
                ],
            },
        });
        await dispatchSdOpenrouterImage(ctx);
        expect(ctx.errors).toHaveLength(0);
        expect(ctx.readJsonOutput()).toEqual({ image: PNG_1X1_B64, format: 'png' });
        expect(receivedRequests).toHaveLength(1);
        const req = receivedRequests[0];
        expect(req.url).toBe('/v1/chat/completions');
        expect(req.headers.authorization).toBe('Bearer or-profile-key');
        expect(req.body.image_config).toEqual({ aspect_ratio: '3:4' });
        expect(req.body.messages[0].content).toEqual([
            { type: 'text', text: '[Character reference: 白露]' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1_B64}` } },
            { type: 'text', text: 'walking through autumn leaves' },
        ]);
    });

    test('dispatchSdWebui routes role="source" to /sdapi/v1/img2img and rejects role="character"', async () => {
        fs.writeFileSync(path.join(directories.userImages, 'source1.png'), Buffer.from(PNG_1X1_B64, 'base64'));
        const sourceCtx = makeTestCtx({
            directories,
            body: {
                url: upstreamUrl,
                prompt: 'change dress color to crimson',
                denoising_strength: 0.75,
                references: [
                    { imagePath: '/user/images/source1.png', role: 'source', strength: 0.55 },
                ],
            },
        });
        await dispatchSdWebui(sourceCtx);
        expect(sourceCtx.errors).toHaveLength(0);
        expect(sourceCtx.readJsonOutput()).toEqual({ images: [PNG_1X1_B64] });
        const img2imgReq = receivedRequests.find(r => r.url === '/sdapi/v1/img2img');
        expect(img2imgReq).toBeDefined();
        expect(img2imgReq.body.init_images).toEqual([PNG_1X1_B64]);
        expect(img2imgReq.body.denoising_strength).toBe(0.55);
        expect(img2imgReq.body.references).toBeUndefined();

        receivedRequests.length = 0;
        const charCtx = makeTestCtx({
            directories,
            body: {
                url: upstreamUrl,
                prompt: 'portrait',
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character' },
                ],
            },
        });
        await dispatchSdWebui(charCtx);
        expect(charCtx.errors).toHaveLength(1);
        expect(charCtx.errors[0].message).toMatch(/source|img2img|does not support/i);
        expect(receivedRequests.find(r => r.url === '/sdapi/v1/txt2img')).toBeUndefined();
    });

    test('dispatchSdPollinations explicitly rejects reference images instead of silently running text-to-image', async () => {
        writeSecret(directories, SECRET_KEYS.POLLINATIONS, 'poll-key');
        const ctx = makeTestCtx({
            directories,
            body: {
                model: 'flux',
                prompt: 'forest',
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character' },
                ],
            },
        });
        await dispatchSdPollinations(ctx);
        expect(ctx.errors).toHaveLength(1);
        expect(ctx.errors[0].message).toMatch(/does not support reference images/i);
        expect(receivedRequests).toHaveLength(0);
    });

    test('ws-delivery PROXY_PATTERNS covers all luker-dispatch SD endpoints', () => {
        const requiredRoutes = [
            '/api/google/generate-image',
            '/api/sd/chat-image/generate',
            '/api/openai/generate-image',
            '/api/openrouter/image/generate',
            '/api/novelai/generate-image',
        ];
        for (const route of requiredRoutes) {
            expect(PROXY_PATTERNS.some(p => route.includes(p))).toBe(true);
        }
    });
});
