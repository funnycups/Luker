// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SILLYTAVERN_ALLOWKEYSEXPOSURE = 'false';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
}));

let router;
let getUntrustedRequestAgent;
let server;
let baseUrl;
let tempUserRoot;

beforeAll(async () => {
    tempUserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-search-images-'));
    fs.writeFileSync(path.join(tempUserRoot, 'secrets.json'), JSON.stringify({
        _migrated: true,
        api_key_serper: [{ id: 's1', value: 'serper-test-key', label: 'Serper', active: true }],
        api_key_serpapi: [{ id: 's2', value: 'serpapi-test-key', label: 'SerpApi', active: true }],
        api_key_brave_search: [{ id: 's3', value: 'brave-test-key', label: 'Brave', active: true }],
        api_key_tavily: [{ id: 's4', value: 'tavily-test-key', label: 'Tavily', active: true }],
        api_key_exa: [{ id: 's5', value: 'exa-test-key', label: 'Exa', active: true }],
        api_key_zai_search: [{ id: 's6', value: 'zai-test-key', label: 'Zai', active: true }],
        api_key_deepseek_search: [{ id: 's7', value: 'deepseek-test-key', label: 'DeepSeek', active: true }],
    }));

    ({ router } = await import('../src/endpoints/search.js'));
    ({ getUntrustedRequestAgent } = await import('../src/private-request-filter.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories: { root: tempUserRoot } };
        next();
    });
    app.use('/api/search', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempUserRoot, { recursive: true, force: true });
});

beforeEach(() => {
    fetchMock.mockReset();
});

function postJson(pathname, body) {
    return fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/search/images', () => {
    test.each(['exa', 'zai', 'deepseek'])(
        'rejects text-only provider %s with HTTP 400 IMAGE_SEARCH_UNSUPPORTED_BY_PROVIDER',
        async (provider) => {
            const res = await postJson('/api/search/images', { provider, query: 'character portrait' });
            expect(res.status).toBe(400);
            const payload = await res.json();
            expect(payload.code).toBe('IMAGE_SEARCH_UNSUPPORTED_BY_PROVIDER');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    test('normalizes Serper /images results', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                images: [
                    {
                        title: 'Heroine Full Art',
                        imageUrl: 'https://cdn.example.com/art/heroine_full.png',
                        thumbnailUrl: 'https://cdn.example.com/art/heroine_thumb.jpg',
                        link: 'https://wiki.example.com/Heroine',
                        imageWidth: 1200,
                        imageHeight: 1800,
                    },
                ],
            }),
        });

        const res = await postJson('/api/search/images', {
            provider: 'serper',
            query: 'Heroine standing portrait',
            max_results: 5,
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(fetchMock).toHaveBeenCalledWith(
            'https://google.serper.dev/images',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(data).toEqual({
            provider: 'serper',
            query: 'Heroine standing portrait',
            result_count: 1,
            results: [
                {
                    title: 'Heroine Full Art',
                    imageUrl: 'https://cdn.example.com/art/heroine_full.png',
                    thumbnailUrl: 'https://cdn.example.com/art/heroine_thumb.jpg',
                    pageUrl: 'https://wiki.example.com/Heroine',
                    width: 1200,
                    height: 1800,
                    source: 'serper',
                },
            ],
        });
    });

    test('normalizes SerpApi google_images, Brave images, Tavily images, SearXNG images, and DuckDuckGo images', async () => {
        // 1. SerpApi
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                images_results: [
                    {
                        title: 'SerpApi Character Sheet',
                        original: 'https://img.example.org/sheet.png',
                        thumbnail: 'https://img.example.org/sheet_s.png',
                        link: 'https://img.example.org/page',
                        original_width: 1024,
                        original_height: 1536,
                    },
                ],
            }),
        });
        const serpRes = await postJson('/api/search/images', { provider: 'serpapi', query: 'sheet' });
        expect(serpRes.status).toBe(200);
        expect((await serpRes.json()).results[0]).toMatchObject({
            title: 'SerpApi Character Sheet',
            imageUrl: 'https://img.example.org/sheet.png',
            thumbnailUrl: 'https://img.example.org/sheet_s.png',
            width: 1024,
            height: 1536,
            source: 'serpapi',
        });

        // 2. Brave
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                results: [
                    {
                        title: 'Brave Illustration',
                        url: 'https://gallery.example.org/post/1',
                        thumbnail: { src: 'https://thumbs.example.org/1.jpg' },
                        properties: { url: 'https://gallery.example.org/full/1.png', width: 900, height: 1400 },
                    },
                ],
            }),
        });
        const braveRes = await postJson('/api/search/images', { provider: 'brave', query: 'illustration' });
        expect(braveRes.status).toBe(200);
        expect((await braveRes.json()).results[0]).toMatchObject({
            title: 'Brave Illustration',
            imageUrl: 'https://gallery.example.org/full/1.png',
            thumbnailUrl: 'https://thumbs.example.org/1.jpg',
            pageUrl: 'https://gallery.example.org/post/1',
            width: 900,
            height: 1400,
            source: 'brave',
        });

        // 3. Tavily
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                images: [{ url: 'https://tavily.example.org/char.webp', description: 'Character concept art' }],
                results: [{ title: 'Concept Page', url: 'https://tavily.example.org/article', content: '...' }],
            }),
        });
        const tavilyRes = await postJson('/api/search/images', { provider: 'tavily', query: 'concept' });
        expect(tavilyRes.status).toBe(200);
        expect((await tavilyRes.json()).results[0]).toMatchObject({
            title: 'Character concept art',
            imageUrl: 'https://tavily.example.org/char.webp',
            source: 'tavily',
        });

        // 4. SearXNG
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                results: [
                    {
                        title: 'SearXNG Sprite',
                        img_src: 'https://searx.example.org/full.png',
                        thumbnail_src: 'https://searx.example.org/thumb.png',
                        url: 'https://searx.example.org/wiki',
                        resolution: '800x1200',
                    },
                ],
            }),
        });
        const searxRes = await postJson('/api/search/images', {
            provider: 'searxng',
            query: 'sprite',
            options: { baseUrl: 'https://searx.example.org' },
        });
        expect(searxRes.status).toBe(200);
        expect((await searxRes.json()).results[0]).toMatchObject({
            title: 'SearXNG Sprite',
            imageUrl: 'https://searx.example.org/full.png',
            width: 800,
            height: 1200,
            source: 'searxng',
        });

        // 5. DuckDuckGo (vqd token + i.js)
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: { get: () => 'text/html' },
                text: async () => '<html><script>vqd="4-1234567890abcdef";</script></html>',
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({
                    results: [
                        {
                            title: 'DDG Portrait',
                            image: 'https://ddg.example.org/portrait.jpg',
                            thumbnail: 'https://ddg.example.org/portrait_t.jpg',
                            url: 'https://ddg.example.org/character',
                            width: 768,
                            height: 1152,
                        },
                    ],
                }),
            });
        const ddgRes = await postJson('/api/search/images', { provider: 'ddg', query: 'portrait' });
        expect(ddgRes.status).toBe(200);
        expect((await ddgRes.json()).results[0]).toMatchObject({
            title: 'DDG Portrait',
            imageUrl: 'https://ddg.example.org/portrait.jpg',
            width: 768,
            height: 1152,
            source: 'ddg',
        });
    });
});

describe('POST /api/search/page-images', () => {
    test('blocks private and localhost URLs before issuing any network request', async () => {
        for (const badUrl of ['http://127.0.0.1/secret', 'http://localhost/admin', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
            const res = await postJson('/api/search/page-images', { url: badUrl });
            expect(res.status).toBe(400);
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('extracts og:image, infobox full-res srcset, lazy-loaded data-src, and filters data: and <64px icons via untrusted agent', async () => {
        const html = `
            <!doctype html>
            <html>
            <head>
                <title>Character Profile - Encyclopedia</title>
                <meta property="og:image" content="/assets/og_banner.jpg" />
            </head>
            <body>
                <aside class="portable-infobox">
                    <figure class="pi-item pi-image">
                        <img
                            class="pi-image-thumbnail"
                            src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
                            srcset="/img/char_300.png 300w, /img/char_1200.png 1200w, /img/char_600.png 600w"
                            alt="Default Outfit"
                            width="300"
                            height="600"
                        />
                        <figcaption class="pi-caption">Standard Uniform</figcaption>
                    </figure>
                </aside>
                <main>
                    <img src="/icons/badge.png" width="24" height="24" alt="Tiny Badge" />
                    <img src="data:image/png;base64,AAAA" alt="Placeholder" />
                    <figure>
                        <img data-src="//static.example.org/gallery/awakened_2x.webp" alt="Awakened Form" width="1024" height="1536" />
                        <figcaption>Awakened Illustration</figcaption>
                    </figure>
                </main>
            </body>
            </html>
        `;

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'text/html; charset=utf-8' },
            text: async () => html,
        });

        const res = await postJson('/api/search/page-images', {
            url: 'https://wiki.example.org/characters/Astra',
        });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://wiki.example.org/characters/Astra',
            expect.objectContaining({ agent: getUntrustedRequestAgent() }),
        );

        const payload = await res.json();
        expect(payload.pageTitle).toBe('Character Profile - Encyclopedia');
        expect(payload.pageUrl).toBe('https://wiki.example.org/characters/Astra');
        expect(payload.images).toEqual([
            {
                imageUrl: 'https://wiki.example.org/assets/og_banner.jpg',
                alt: '',
                caption: 'og:image',
            },
            {
                imageUrl: 'https://wiki.example.org/img/char_1200.png',
                alt: 'Default Outfit',
                caption: 'Standard Uniform',
                width: 300,
                height: 600,
            },
            {
                imageUrl: 'https://static.example.org/gallery/awakened_2x.webp',
                alt: 'Awakened Form',
                caption: 'Awakened Illustration',
                width: 1024,
                height: 1536,
            },
        ]);
    });
});
