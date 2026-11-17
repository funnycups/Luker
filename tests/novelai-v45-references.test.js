import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';

import { Jimp, JimpMime } from '../src/jimp.js';
import { SECRET_KEYS, writeSecret } from '../src/endpoints/secrets.js';
import {
    padImageForNovelDirectorRef,
    buildNovelGenerationPayload,
    dispatchSdNovelImage,
    importNovelVibeFile,
} from '../src/luker-dispatch/providers/sd/novel-image.js';

async function makeSolidPngBuffer(width, height, color = 0x3366ccff) {
    const img = new Jimp({ width, height, color });
    return Buffer.from(await img.getBuffer(JimpMime.png));
}

function makeZipWithPng(pngBuffer) {
    const nameBuf = Buffer.from('image_0.png', 'utf8');
    const crc = zlib.crc32(pngBuffer) >>> 0;
    const size = pngBuffer.length;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralOffset = localHeader.length + size;
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(0, 42);
    nameBuf.copy(centralHeader, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralHeader.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localHeader, pngBuffer, centralHeader, eocd]);
}

function makeDispatchCtx({ directories, body }) {
    const chunks = [];
    const errors = [];
    const heads = [];
    const controller = new AbortController();
    return {
        body,
        user: { handle: 'default-user', directories, profile: { handle: 'default-user' } },
        signal: controller.signal,
        fetch,
        secrets: { read: () => null },
        inspection: {
            startImage() {},
            attach() {},
            completeImage() {},
            failImage() {},
        },
        emit: {
            head(h) { heads.push(h); },
            chunk(b) { chunks.push(Buffer.from(b)); },
            end() {},
            error(e) { errors.push(e); },
        },
        readTextOutput() {
            return Buffer.concat(chunks).toString('utf8');
        },
        errors,
        heads,
    };
}

describe('NovelAI V4/V4.5 director references, vibe caching, and char_captions', () => {
    let tmpRoot;
    let directories;
    let upstreamServer;
    let upstreamUrl;
    let encodeVibeCalls;
    let generateCalls;
    let samplePng;
    let sampleZip;

    beforeAll(async () => {
        encodeVibeCalls = [];
        generateCalls = [];
        samplePng = await makeSolidPngBuffer(64, 64, 0x22aa88ff);
        sampleZip = await makeZipWithPng(samplePng);

        upstreamServer = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const parsed = raw ? JSON.parse(raw) : null;
                if (req.url === '/ai/encode-vibe') {
                    encodeVibeCalls.push({ headers: req.headers, body: parsed });
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(Buffer.from('encoded-vibe-vector-bytes'));
                    return;
                }
                if (req.url === '/ai/generate-image') {
                    generateCalls.push({ headers: req.headers, body: parsed });
                    res.writeHead(200, { 'Content-Type': 'application/zip' });
                    res.end(sampleZip);
                    return;
                }
                res.writeHead(404);
                res.end('not found');
            });
        });
        await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
        upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => upstreamServer.close(resolve));
    });

    beforeEach(async () => {
        encodeVibeCalls.length = 0;
        generateCalls.length = 0;
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-nai-v45-'));
        directories = {
            root: tmpRoot,
            userImages: path.join(tmpRoot, 'user', 'images'),
            characters: path.join(tmpRoot, 'characters'),
            avatars: path.join(tmpRoot, 'User Avatars'),
        };
        fs.mkdirSync(path.join(directories.userImages, '_references'), { recursive: true });
        fs.mkdirSync(path.join(directories.userImages, '_style_references'), { recursive: true });
        writeSecret(directories, SECRET_KEYS.NOVEL, 'nai-test-token');
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('padImageForNovelDirectorRef pads portrait, square, and landscape images into 1024x1536, 1472x1472, and 1536x1024', async () => {
        const portraitBuf = await makeSolidPngBuffer(200, 300);
        const portraitB64 = await padImageForNovelDirectorRef(portraitBuf);
        const portraitOut = await Jimp.read(Buffer.from(portraitB64, 'base64'));
        expect([portraitOut.bitmap.width, portraitOut.bitmap.height]).toEqual([1024, 1536]);

        const squareBuf = await makeSolidPngBuffer(200, 200);
        const squareB64 = await padImageForNovelDirectorRef(squareBuf);
        const squareOut = await Jimp.read(Buffer.from(squareB64, 'base64'));
        expect([squareOut.bitmap.width, squareOut.bitmap.height]).toEqual([1472, 1472]);

        const landscapeBuf = await makeSolidPngBuffer(300, 200);
        const landscapeB64 = await padImageForNovelDirectorRef(landscapeBuf);
        const landscapeOut = await Jimp.read(Buffer.from(landscapeB64, 'base64'));
        expect([landscapeOut.bitmap.width, landscapeOut.bitmap.height]).toEqual([1536, 1024]);
    });

    test('dispatchSdNovelImage supports non-exclusive V4.5 character ref + cached style vibe + char_captions and disables sm/sm_dyn', async () => {
        const charBuf = await makeSolidPngBuffer(120, 180);
        const styleBuf = await makeSolidPngBuffer(160, 160, 0xaa3355ff);
        fs.writeFileSync(path.join(directories.userImages, '_references', 'heroine.png'), charBuf);
        fs.writeFileSync(path.join(directories.userImages, '_style_references', 'watercolor.png'), styleBuf);

        const requestBody = {
            model: 'nai-diffusion-4-5-full',
            novel_url: upstreamUrl,
            prompt: '2girls, rooftop conversation',
            negative_prompt: 'blurry, lowres',
            width: 832,
            height: 1216,
            steps: 28,
            scale: 5.5,
            sm: true,
            sm_dyn: true,
            references: [
                {
                    imagePath: '/user/images/_references/heroine.png',
                    role: 'character',
                    strength: 0.75,
                    fidelity: 0.8,
                    styleAware: true,
                },
                {
                    imagePath: '/user/images/_style_references/watercolor.png',
                    role: 'style',
                    strength: 0.5,
                },
            ],
            characterPrompts: [
                {
                    prompt: '1girl, silver hair, red ribbon',
                    negativePrompt: 'hat',
                    center: { x: 0.25, y: 0.5 },
                },
                {
                    prompt: '1girl, black bob cut, glasses',
                    negativePrompt: 'long hair',
                    center: { x: 0.75, y: 0.5 },
                },
            ],
        };

        const ctx1 = makeDispatchCtx({ directories, body: requestBody });
        await dispatchSdNovelImage(ctx1);
        expect(ctx1.errors).toHaveLength(0);
        expect(ctx1.readTextOutput()).toBe(samplePng.toString('base64'));
        expect(encodeVibeCalls).toHaveLength(1);
        expect(generateCalls).toHaveLength(1);

        const sentParams = generateCalls[0].body.parameters;
        expect(sentParams.sm).toBe(false);
        expect(sentParams.sm_dyn).toBe(false);
        expect(sentParams.director_reference_images).toHaveLength(1);
        expect(sentParams.director_reference_descriptions).toEqual([
            {
                caption: { base_caption: 'character&style', char_captions: [] },
                legacy_uc: false,
            },
        ]);
        expect(sentParams.director_reference_information_extracted).toEqual([1]);
        expect(sentParams.director_reference_strength_values).toEqual([0.75]);
        expect(sentParams.director_reference_secondary_strength_values).toEqual([0.2]);

        expect(sentParams.reference_image_multiple).toEqual([
            Buffer.from('encoded-vibe-vector-bytes').toString('base64'),
        ]);
        expect(sentParams.reference_strength_multiple).toEqual([0.5]);

        expect(sentParams.use_coords).toBe(true);
        expect(sentParams.v4_prompt.use_coords).toBe(true);
        expect(sentParams.v4_prompt.caption.char_captions).toEqual([
            { char_caption: '1girl, silver hair, red ribbon', centers: [{ x: 0.25, y: 0.5 }] },
            { char_caption: '1girl, black bob cut, glasses', centers: [{ x: 0.75, y: 0.5 }] },
        ]);
        expect(sentParams.v4_negative_prompt.caption.char_captions).toEqual([
            { char_caption: 'hat', centers: [{ x: 0.25, y: 0.5 }] },
            { char_caption: 'long hair', centers: [{ x: 0.75, y: 0.5 }] },
        ]);

        // Second call must hit disk vibe cache without calling /ai/encode-vibe again
        const cacheFiles = fs.readdirSync(path.join(directories.root, 'thumbnails', '_nai_vibes'));
        expect(cacheFiles).toHaveLength(1);
        expect(cacheFiles[0]).toMatch(/^[a-f0-9]{64}_nai-diffusion-4-5-full\.json$/);
        const ctx2 = makeDispatchCtx({ directories, body: requestBody });
        await dispatchSdNovelImage(ctx2);
        expect(ctx2.errors).toHaveLength(0);
        expect(encodeVibeCalls).toHaveLength(1);
        expect(generateCalls).toHaveLength(2);
    });

    test('importNovelVibeFile imports .naiv4vibe into _style_references and pre-populates _nai_vibes cache', async () => {
        const vibeJson = JSON.stringify({
            identifier: 'novelai-vibe-transfer',
            version: 1,
            type: 'encoding',
            encodings: {
                'v4-5full': {
                    abc123: {
                        encoding: Buffer.from('precomputed-v45-vibe').toString('base64'),
                        params: { information_extracted: 1 },
                    },
                },
            },
            importInfo: {
                strength: 0.45,
            },
        });

        const imported = await importNovelVibeFile({
            directories,
            fileName: 'cel_shade.naiv4vibe',
            content: vibeJson,
        });
        expect(imported.imagePath).toMatch(/^\/user\/images\/_style_references\//);
        expect(imported.strength).toBe(0.45);

        const ctx = makeDispatchCtx({
            directories,
            body: {
                model: 'nai-diffusion-4-5-full',
                novel_url: upstreamUrl,
                prompt: '1girl, solo',
                width: 832,
                height: 1216,
                references: [
                    { imagePath: imported.imagePath, role: 'style', strength: imported.strength },
                ],
            },
        });
        await dispatchSdNovelImage(ctx);
        expect(ctx.errors).toHaveLength(0);
        expect(encodeVibeCalls).toHaveLength(0);
        expect(generateCalls[0].body.parameters.reference_image_multiple).toEqual([
            Buffer.from('precomputed-v45-vibe').toString('base64'),
        ]);
    });

    test('buildNovelGenerationPayload switches action="img2img" for role="source" and rejects unsupported character refs on V3 or >4 refs', async () => {
        const srcBuf = await makeSolidPngBuffer(128, 128);
        fs.writeFileSync(path.join(directories.userImages, 'draft.png'), srcBuf);

        const img2imgPayload = await buildNovelGenerationPayload({
            directories,
            body: {
                model: 'nai-diffusion-4-5-full',
                prompt: 'refine lighting',
                width: 832,
                height: 1216,
                references: [{ imagePath: '/user/images/draft.png', role: 'source', strength: 0.4 }],
            },
            fetchFn: fetch,
            key: 'nai-test-token',
            imageBaseUrl: upstreamUrl,
        });
        expect(img2imgPayload.action).toBe('img2img');
        expect(img2imgPayload.parameters.image).toBe(srcBuf.toString('base64'));
        expect(img2imgPayload.parameters.strength).toBe(0.4);

        await expect(buildNovelGenerationPayload({
            directories,
            body: {
                model: 'nai-diffusion-3',
                prompt: '1girl',
                references: [{ imagePath: '/user/images/draft.png', role: 'character' }],
            },
            fetchFn: fetch,
            key: 'nai-test-token',
            imageBaseUrl: upstreamUrl,
        })).rejects.toThrow(/does not support character references/i);

        await expect(buildNovelGenerationPayload({
            directories,
            body: {
                model: 'nai-diffusion-4-5-full',
                prompt: 'group photo',
                references: Array.from({ length: 5 }, () => ({ imagePath: '/user/images/draft.png', role: 'character' })),
            },
            fetchFn: fetch,
            key: 'nai-test-token',
            imageBaseUrl: upstreamUrl,
        })).rejects.toThrow(/at most 4 character references/i);
    });
});
