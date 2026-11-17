import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { loadManagedMediaInput, loadReferenceInputs } from '../src/media-input-loader.js';
import { resolveAspectRatioDimensions } from '../public/scripts/extensions/stable-diffusion/aspect-ratio.js';

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

describe('media-input-loader', () => {
    let tmpRoot;
    let directories;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-media-loader-'));
        directories = {
            root: tmpRoot,
            userImages: path.join(tmpRoot, 'user', 'images'),
            characters: path.join(tmpRoot, 'characters'),
            avatars: path.join(tmpRoot, 'User Avatars'),
            chats: path.join(tmpRoot, 'chats'),
        };
        fs.mkdirSync(path.join(directories.userImages, '_references'), { recursive: true });
        fs.mkdirSync(directories.characters, { recursive: true });
        fs.mkdirSync(directories.avatars, { recursive: true });
        fs.mkdirSync(directories.chats, { recursive: true });

        fs.writeFileSync(path.join(directories.userImages, '_references', 'a.png'), PNG_1X1);
        fs.writeFileSync(path.join(directories.characters, 'Alice.png'), PNG_1X1);
        fs.writeFileSync(path.join(directories.avatars, 'u.png'), PNG_1X1);
        fs.writeFileSync(path.join(directories.chats, 'foo.jsonl'), '{"mes":"hi"}\n');
        fs.writeFileSync(path.join(tmpRoot, 'secrets.json'), '{"api_key":"secret"}');
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('loads managed files from userImages, characters, and User Avatars (including URL-encoded paths and query strings)', async () => {
        const refImg = await loadManagedMediaInput(directories, '/user/images/_references/a.png');
        expect(refImg.mimeType).toBe('image/png');
        expect(Buffer.compare(refImg.buffer, PNG_1X1)).toBe(0);
        expect(refImg.dataUrl).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`);

        const charImg = await loadManagedMediaInput(directories, '/characters/Alice.png?v=42');
        expect(charImg.mimeType).toBe('image/png');
        expect(charImg.diskPath).toBe(path.join(directories.characters, 'Alice.png'));

        const avatarImg = await loadManagedMediaInput(directories, '/User%20Avatars/u.png');
        expect(avatarImg.mimeType).toBe('image/png');
        expect(avatarImg.diskPath).toBe(path.join(directories.avatars, 'u.png'));
    });

    test('rejects traversal, disallowed directories, external URLs, and missing files with actionable errors', async () => {
        await expect(loadManagedMediaInput(directories, '../secrets.json'))
            .rejects.toThrow(/managed media directory|not allowed/i);
        await expect(loadManagedMediaInput(directories, '/user/images/../../secrets.json'))
            .rejects.toThrow(/managed media directory|not allowed/i);
        await expect(loadManagedMediaInput(directories, '/chats/foo.jsonl'))
            .rejects.toThrow(/managed media directory|not allowed/i);
        await expect(loadManagedMediaInput(directories, 'https://evil.example/a.png'))
            .rejects.toThrow(/external URL|relative path/i);
        await expect(loadManagedMediaInput(directories, '/user/images/_references/missing.png'))
            .rejects.toThrow(/not found/i);
    });

    test('loadReferenceInputs validates roles and normalizes reference metadata', async () => {
        const loaded = await loadReferenceInputs(directories, [
            { imagePath: '/user/images/_references/a.png', role: 'character', label: '星 — 常服', strength: 0.7, fidelity: 0.85 },
            { imagePath: '/characters/Alice.png', role: 'style', strength: 0.5 },
        ]);
        expect(loaded).toHaveLength(2);
        expect(loaded[0]).toMatchObject({
            imagePath: '/user/images/_references/a.png',
            role: 'character',
            label: '星 — 常服',
            strength: 0.7,
            fidelity: 0.85,
            mimeType: 'image/png',
        });
        await expect(loadReferenceInputs(directories, [{ imagePath: '/characters/Alice.png', role: 'unknown' }]))
            .rejects.toThrow(/invalid reference role/i);
    });
});

describe('resolveAspectRatioDimensions', () => {
    test('preserves pixel area aligned to multiples of 64 for general backends', () => {
        const portrait = resolveAspectRatioDimensions({ aspectRatio: '2:3', width: 1024, height: 1024 });
        expect(portrait.width % 64).toBe(0);
        expect(portrait.height % 64).toBe(0);
        expect(portrait.width).toBeLessThan(portrait.height);
        expect(portrait.aspectRatio).toBe('2:3');

        const widescreen = resolveAspectRatioDimensions({ aspectRatio: '16:9', width: 1024, height: 1024 });
        expect(widescreen.width % 64).toBe(0);
        expect(widescreen.height % 64).toBe(0);
        expect(widescreen.width).toBeGreaterThan(widescreen.height);

        const square = resolveAspectRatioDimensions({ aspectRatio: '1:1', width: 832, height: 1216 });
        expect(square.width).toBe(square.height);
        expect(square.width % 64).toBe(0);
    });

    test('maps to exact NovelAI Opus free-tier dimensions when novelOpusFree is enabled', () => {
        expect(resolveAspectRatioDimensions({ aspectRatio: '2:3', width: 1024, height: 1024, novelOpusFree: true }))
            .toEqual({ width: 832, height: 1216, aspectRatio: '2:3' });
        expect(resolveAspectRatioDimensions({ aspectRatio: '3:2', width: 1024, height: 1024, novelOpusFree: true }))
            .toEqual({ width: 1216, height: 832, aspectRatio: '3:2' });
        expect(resolveAspectRatioDimensions({ aspectRatio: '1:1', width: 832, height: 1216, novelOpusFree: true }))
            .toEqual({ width: 1024, height: 1024, aspectRatio: '1:1' });
    });

    test('throws on malformed aspectRatio string instead of silently falling back', () => {
        expect(() => resolveAspectRatioDimensions({ aspectRatio: 'bad', width: 1024, height: 1024 }))
            .toThrow(/aspect ratio/i);
    });
});
