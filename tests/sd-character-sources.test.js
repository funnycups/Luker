// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

import '../src/fetch-patch.js';
import { Jimp, JimpMime } from '../src/jimp.js';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
}));

let router;
let getUntrustedRequestAgent;
let server;
let baseUrl;
let tempRoot;
let directories;
let validPortraitPng;
let tinyIconPng;

beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-char-sources-'));
    directories = {
        root: tempRoot,
        userImages: path.join(tempRoot, 'user', 'images'),
        characters: path.join(tempRoot, 'characters'),
        avatars: path.join(tempRoot, 'User Avatars'),
    };
    fs.mkdirSync(path.join(directories.userImages, '_studio'), { recursive: true });
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.avatars, { recursive: true });

    const img128 = new Jimp({ width: 128, height: 192, color: 0x4488ccff });
    validPortraitPng = Buffer.from(await img128.getBuffer(JimpMime.png));

    const img16 = new Jimp({ width: 16, height: 16, color: 0xff0000ff });
    tinyIconPng = Buffer.from(await img16.getBuffer(JimpMime.png));

    fs.writeFileSync(path.join(directories.userImages, '_studio', 'draft_oc.png'), validPortraitPng);

    ({ router } = await import('../src/endpoints/sd-character-sources.js'));
    ({ getUntrustedRequestAgent } = await import('../src/private-request-filter.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/sd/character-sources', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
    fetchMock.mockReset();
});

function postJson(pathname, body) {
    return globalThis.fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/sd/character-sources/search', () => {
    test('queries Bangumi character endpoint and returns structured candidates + grep-style formattedLines', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                data: [
                    {
                        id: 4201,
                        name: '星野凛',
                        summary: '身披深蓝斗篷的巡星骑士。',
                        images: { large: 'https://lain.bgm.tv/pic/crt/l/42/01/4201.jpg' },
                        infobox: [
                            { key: '简体中文名', value: '星野凛' },
                            { key: '别名', value: [{ v: 'Hoshino Rin' }, { v: 'Starlight' }] },
                        ],
                    },
                ],
            }),
        });

        const res = await postJson('/api/sd/character-sources/search', {
            source: 'bangumi',
            query: '星野凛',
            work: '巡星记',
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.candidates).toHaveLength(1);
        expect(body.candidates[0]).toMatchObject({
            name: '星野凛',
            aliases: expect.arrayContaining(['Hoshino Rin', 'Starlight']),
            imageUrls: ['https://lain.bgm.tv/pic/crt/l/42/01/4201.jpg'],
            pageUrl: 'https://bgm.tv/character/4201',
        });
        expect(body.formattedLines).toContain('1: [bangumi] 星野凛');
        expect(body.formattedLines).toContain('https://lain.bgm.tv/pic/crt/l/42/01/4201.jpg');
    });

    test('validates MediaWiki host against SSRF and extracts original pageimages', async () => {
        const badRes = await postJson('/api/sd/character-sources/search', {
            source: 'mediawiki',
            query: 'Test',
            wikiHost: '127.0.0.1',
        });
        expect(badRes.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                query: {
                    pages: {
                        99: {
                            pageid: 99,
                            title: 'Celeste Vance',
                            fullurl: 'https://lore.fandom.com/wiki/Celeste_Vance',
                            extract: 'Silver-haired airship navigator.',
                            original: { source: 'https://static.wikia.nocookie.net/lore/images/celeste.png' },
                        },
                    },
                },
            }),
        });

        const okRes = await postJson('/api/sd/character-sources/search', {
            source: 'mediawiki',
            query: 'Celeste Vance',
            wikiHost: 'lore.fandom.com',
        });
        expect(okRes.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://lore.fandom.com/api.php?'),
            expect.objectContaining({ agent: getUntrustedRequestAgent() }),
        );
        const data = await okRes.json();
        expect(data.candidates[0]).toMatchObject({
            name: 'Celeste Vance',
            imageUrls: ['https://static.wikia.nocookie.net/lore/images/celeste.png'],
            pageUrl: 'https://lore.fandom.com/wiki/Celeste_Vance',
        });
    });

    test('normalizes Booru character query with solo filter, aggregates appearance tags without artist/meta noise, and fails fast on 403/challenge', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ([
                {
                    id: 101,
                    file_url: 'https://cdn.donmai.us/original/a1.png',
                    tag_string_character: 'celeste_vance',
                    tag_string_copyright: 'sky_chronicles',
                    tag_string_artist: 'some_artist',
                    tag_string_meta: 'highres absurdres',
                    tag_string_general: '1girl solo silver_hair amber_eyes navy_coat brass_goggles looking_at_viewer',
                },
                {
                    id: 102,
                    file_url: 'https://cdn.donmai.us/original/a2.png',
                    tag_string_character: 'celeste_vance',
                    tag_string_copyright: 'sky_chronicles',
                    tag_string_artist: 'another_artist',
                    tag_string_meta: 'highres commentary',
                    tag_string_general: '1girl solo silver_hair amber_eyes navy_coat white_background',
                },
            ]),
        });

        const res = await postJson('/api/sd/character-sources/search', {
            source: 'booru',
            booruSite: 'danbooru',
            query: 'Celeste Vance',
        });
        expect(res.status).toBe(200);
        const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
        expect(calledUrl.searchParams.get('tags')).toBe('celeste_vance solo');

        const data = await res.json();
        expect(data.candidates).toHaveLength(1);
        expect(data.candidates[0].work).toBe('sky_chronicles');
        expect(data.candidates[0].characterTag).toBe('celeste_vance');
        expect(data.candidates[0].tags).toEqual(
            expect.arrayContaining(['silver_hair', 'amber_eyes', 'navy_coat']),
        );
        expect(data.candidates[0].tags).not.toContain('some_artist');
        expect(data.candidates[0].tags).not.toContain('highres');
        expect(data.candidates[0].tags).not.toContain('looking_at_viewer');
        expect(data.formattedLines).toContain('character_tag=celeste_vance');

        // Upstream 403 / anti-bot challenge returns structured error immediately without retry/bypass
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            headers: { get: () => 'text/html' },
            text: async () => '<html>Just a moment... Enable JavaScript and cookies to continue</html>',
        });
        const blockedRes = await postJson('/api/sd/character-sources/search', {
            source: 'booru',
            booruSite: 'danbooru',
            query: 'Celeste Vance',
        });
        expect(blockedRes.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const blockedJson = await blockedRes.json();
        expect(blockedJson.code).toBe('UPSTREAM_CHALLENGE_OR_FORBIDDEN');
    });
});

describe('POST /api/sd/character-sources/fetch-image and /promote-local-image', () => {
    test('rejects HTML disguised as HTTP 200 image, rejects <64px icons, and atomically stores valid images in _references', async () => {
        // 1. HTML hotlink error page returning HTTP 200
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'text/html' },
            arrayBuffer: async () => Buffer.from('<html><body>Hotlink forbidden</body></html>', 'utf8'),
        });
        const htmlRes = await postJson('/api/sd/character-sources/fetch-image', {
            imageUrl: 'https://img.example.org/hotlink.png',
            profileId: 'char_celeste',
        });
        expect(htmlRes.status).toBe(422);
        expect((await htmlRes.json()).code).toBe('INVALID_IMAGE_DATA');

        // 2. Tiny 16x16 icon rejected
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => tinyIconPng,
        });
        const tinyRes = await postJson('/api/sd/character-sources/fetch-image', {
            imageUrl: 'https://img.example.org/icon.png',
            profileId: 'char_celeste',
        });
        expect(tinyRes.status).toBe(422);
        expect((await tinyRes.json()).code).toBe('IMAGE_TOO_SMALL');

        // 3. Valid 128x192 portrait saved atomically under /user/images/_references/<profileId>_<sha>.png
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => validPortraitPng,
        });
        const okRes = await postJson('/api/sd/character-sources/fetch-image', {
            imageUrl: 'https://img.example.org/portrait.png',
            refererUrl: 'https://wiki.example.org/Celeste',
            profileId: 'char_celeste',
        });
        expect(okRes.status).toBe(200);
        expect(fetchMock).toHaveBeenLastCalledWith(
            'https://img.example.org/portrait.png',
            expect.objectContaining({
                agent: getUntrustedRequestAgent(),
                headers: expect.objectContaining({ Referer: 'https://wiki.example.org/Celeste' }),
            }),
        );
        const saved = await okRes.json();
        expect(saved.imagePath).toMatch(/^\/user\/images\/_references\/char_celeste_[0-9a-f]{16}\.png$/);
        expect(saved.width).toBe(128);
        expect(saved.height).toBe(192);
        const diskFile = path.join(tempRoot, saved.imagePath.replace(/^\//, ''));
        expect(fs.existsSync(diskFile)).toBe(true);
    });

    test('promote-local-image promotes managed studio draft to _references and rejects path traversal', async () => {
        const badRes = await postJson('/api/sd/character-sources/promote-local-image', {
            sourcePath: '/user/images/../../secrets.json',
            profileId: 'char_oc',
        });
        expect(badRes.status).toBe(400);

        const okRes = await postJson('/api/sd/character-sources/promote-local-image', {
            sourcePath: '/user/images/_studio/draft_oc.png',
            profileId: 'char_oc',
        });
        expect(okRes.status).toBe(200);
        const promoted = await okRes.json();
        expect(promoted.imagePath).toMatch(/^\/user\/images\/_references\/char_oc_[0-9a-f]{16}\.png$/);
        expect(promoted.width).toBe(128);
        expect(promoted.height).toBe(192);
        expect(fs.existsSync(path.join(tempRoot, promoted.imagePath.replace(/^\//, '')))).toBe(true);
    });

    test('character-sources-client bridges web source through getExtensionApi("search-tools") without cross-plugin imports', async () => {
        const { searchCharacterSources, formatCharacterSourceCandidates } = await import('../public/scripts/extensions/stable-diffusion/character-sources-client.js');
        const searchImagesSpy = jest.fn(async ({ query }) => ({
            provider: 'serper',
            query,
            results: [
                {
                    title: 'Celeste Official Art',
                    imageUrl: 'https://art.example.org/celeste.png',
                    pageUrl: 'https://art.example.org/post/1',
                    width: 1000,
                    height: 1500,
                },
            ],
        }));

        const mockCtx = {
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getExtensionApi: (name) => (name === 'search-tools' ? { searchImages: searchImagesSpy } : null),
        };

        const out = await searchCharacterSources({
            context: mockCtx,
            source: 'web',
            query: 'Celeste Vance',
            work: 'Sky Chronicles',
        });
        expect(searchImagesSpy).toHaveBeenCalledWith(
            expect.objectContaining({ query: 'Celeste Vance Sky Chronicles' }),
            expect.anything(),
        );
        expect(out.candidates).toHaveLength(1);
        expect(out.formattedLines).toContain('1: [web] Celeste Official Art');
        expect(out.formattedLines).toContain('https://art.example.org/celeste.png');
        expect(formatCharacterSourceCandidates('booru', [{
            name: 'Celeste Vance',
            characterTag: 'celeste_vance',
            work: 'sky_chronicles',
        }])).toContain('character_tag=celeste_vance');
    });
});
