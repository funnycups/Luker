import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import {
    clearComfyObjectInfoCache,
    fetchComfyObjectInfo,
    inspectComfyNodes,
    searchComfyObjectInfo,
} from '../src/comfy-object-info.js';
import { router as sdRouter } from '../src/endpoints/stable-diffusion.js';

const MOCK_OBJECT_INFO = {
    CheckpointLoaderSimple: {
        display_name: 'Load Checkpoint',
        category: 'loaders',
        description: 'Loads a diffusion checkpoint',
        input: { required: { ckpt_name: [['flux1-dev.safetensors', 'illustrious.safetensors']] }, optional: {} },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE'],
        output_is_list: [false, false, false],
    },
    LoraLoader: {
        display_name: 'Load LoRA',
        category: 'loaders',
        description: 'Applies a LoRA to MODEL and CLIP',
        input: {
            required: {
                model: ['MODEL'],
                clip: ['CLIP'],
                lora_name: [['detail_tweaker.safetensors']],
                strength_model: ['FLOAT', { default: 1.0 }],
                strength_clip: ['FLOAT', { default: 1.0 }],
            },
        },
        output: ['MODEL', 'CLIP'],
        output_name: ['MODEL', 'CLIP'],
        output_is_list: [false, false],
    },
    IPAdapterUnifiedLoader: {
        display_name: 'IPAdapter Unified Loader',
        category: 'ipadapter',
        description: 'Loads IPAdapter weights for character/style reference conditioning',
        input: { required: { model: ['MODEL'], preset: [['PLUS (high strength)', 'STANDARD']] } },
        output: ['MODEL', 'IPADAPTER'],
        output_name: ['MODEL', 'ipadapter'],
        output_is_list: [false, false],
    },
};

describe('comfy-object-info service and routes', () => {
    let comfyServer;
    let comfyBaseUrl;
    let apiServer;
    let apiBaseUrl;
    let hitCount = 0;
    let failNext = false;
    let lastAuthHeader = '';

    beforeAll(async () => {
        comfyServer = http.createServer((req, res) => {
            if (req.url === '/object_info') {
                hitCount += 1;
                lastAuthHeader = String(req.headers.authorization || '');
                if (failNext) {
                    res.writeHead(503, { 'Content-Type': 'text/plain' });
                    res.end('ComfyUI starting up');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(MOCK_OBJECT_INFO));
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise(resolve => comfyServer.listen(0, '127.0.0.1', resolve));
        comfyBaseUrl = `http://127.0.0.1:${comfyServer.address().port}`;

        const app = express();
        app.use(express.json());
        app.use('/api/sd', sdRouter);
        apiServer = http.createServer(app);
        await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
        apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => apiServer.close(resolve));
        await new Promise(resolve => comfyServer.close(resolve));
    });

    test('returns category directory when query and category are empty, filters multi-token queries, caches per URL, and honors refresh:true', async () => {
        clearComfyObjectInfoCache();
        hitCount = 0;
        const info1 = await fetchComfyObjectInfo({ baseUrl: comfyBaseUrl });
        const info2 = await fetchComfyObjectInfo({ baseUrl: comfyBaseUrl });
        expect(hitCount).toBe(1);
        expect(info1).toEqual(info2);

        await fetchComfyObjectInfo({ baseUrl: comfyBaseUrl, refresh: true });
        expect(hitCount).toBe(2);

        const dir = searchComfyObjectInfo(info1, {});
        expect(dir.mode).toBe('categories');
        expect(dir.totalNodes).toBe(3);
        expect(dir.categories.map(c => c.category)).toEqual(['ipadapter', 'loaders']);

        const hit = searchComfyObjectInfo(info1, { query: 'ipadapter reference' });
        expect(hit.mode).toBe('matches');
        expect(hit.matches.map(m => m.classType)).toEqual(['IPAdapterUnifiedLoader']);
        expect(hit.formattedLines).toContain('IPAdapterUnifiedLoader');
    });

    test('inspectComfyNodes returns exact input/output slot definitions and marks uninstalled class_types in notFound', async () => {
        const out = inspectComfyNodes(MOCK_OBJECT_INFO, ['LoraLoader', 'MissingCustomNode']);
        expect(out.notFound).toEqual(['MissingCustomNode']);
        expect(out.nodes.LoraLoader.outputs).toEqual([
            { index: 0, type: 'MODEL', name: 'MODEL', isList: false },
            { index: 1, type: 'CLIP', name: 'CLIP', isList: false },
        ]);
        expect(out.nodes.LoraLoader.requiredInputs.lora_name).toBeDefined();
    });

    test('surfaces 400 on missing url and 502 on unreachable or non-2xx ComfyUI server without returning empty fallback', async () => {
        clearComfyObjectInfoCache();
        await expect(fetchComfyObjectInfo({ baseUrl: '' })).rejects.toMatchObject({ statusCode: 400 });

        failNext = true;
        try {
            await expect(fetchComfyObjectInfo({ baseUrl: comfyBaseUrl, refresh: true })).rejects.toMatchObject({ statusCode: 502 });
        } finally {
            failNext = false;
        }
    });

    test('Express routes POST /api/sd/comfy/object-info/search and /node forward auth and propagate 400/502 errors', async () => {
        clearComfyObjectInfoCache();
        lastAuthHeader = '';

        const searchRes = await fetch(`${apiBaseUrl}/api/sd/comfy/object-info/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: comfyBaseUrl, auth: 'user:secret', category: 'loaders' }),
        });
        expect(searchRes.status).toBe(200);
        expect(lastAuthHeader).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
        const searchBody = await searchRes.json();
        expect(searchBody.mode).toBe('matches');
        expect(searchBody.matches.map(m => m.classType)).toEqual(['CheckpointLoaderSimple', 'LoraLoader']);

        const nodeRes = await fetch(`${apiBaseUrl}/api/sd/comfy/object-info/node`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: comfyBaseUrl, auth: 'user:secret', class_types: ['CheckpointLoaderSimple', 'NoSuchNode'] }),
        });
        expect(nodeRes.status).toBe(200);
        const nodeBody = await nodeRes.json();
        expect(nodeBody.notFound).toEqual(['NoSuchNode']);
        expect(nodeBody.nodes.CheckpointLoaderSimple.outputs[0]).toEqual({
            index: 0,
            type: 'MODEL',
            name: 'MODEL',
            isList: false,
        });

        const badUrlRes = await fetch(`${apiBaseUrl}/api/sd/comfy/object-info/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: '' }),
        });
        expect(badUrlRes.status).toBe(400);
        const badUrlBody = await badUrlRes.json();
        expect(badUrlBody.error).toMatch(/URL/i);

        failNext = true;
        try {
            const upstreamFailRes = await fetch(`${apiBaseUrl}/api/sd/comfy/object-info/node`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: comfyBaseUrl, refresh: true, class_types: ['LoraLoader'] }),
            });
            expect(upstreamFailRes.status).toBe(502);
            const upstreamFailBody = await upstreamFailRes.json();
            expect(upstreamFailBody.error).toMatch(/503/);
        } finally {
            failNext = false;
        }
    });
});
