import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';

import {
    router as imageMetadataRouter,
    initializeAllUserMetadata,
    METADATA_FILE,
    METADATA_CACHE_FILE,
} from '../../src/endpoints/image-metadata.js';
import { router as backgroundsRouter } from '../../src/endpoints/backgrounds.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PNG = fs.readFileSync(path.join(REPO_ROOT, 'default/content/backgrounds/__transparent.png'));
const CACHE_FIELDS = ['hash', 'aspectRatio', 'isAnimated', 'dominantColor', 'thumbnailResolution', 'mtime'];

describe('image metadata keeps the device-local cache out of the synced file', () => {
    let root;
    let app;
    const syncedPath = () => path.join(root, METADATA_FILE);
    const cachePath = () => path.join(root, METADATA_CACHE_FILE);
    const syncedBytes = () => fs.readFileSync(syncedPath(), 'utf8');
    const synced = () => JSON.parse(syncedBytes());
    const cache = () => JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    const addBackground = name => fs.writeFileSync(path.join(root, 'backgrounds', name), PNG);
    const mtimeOf = name => fs.statSync(path.join(root, 'backgrounds', name)).mtimeMs;
    const listBackgrounds = () => request(app).post('/api/backgrounds/all').send({});

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-image-metadata-'));
        for (const dir of ['backgrounds', 'thumbnails']) fs.mkdirSync(path.join(root, dir), { recursive: true });
        app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root, backgrounds: path.join(root, 'backgrounds'), thumbnails: path.join(root, 'thumbnails'), thumbnailsBg: path.join(root, 'thumbnails', 'bg') } };
            next();
        });
        app.use('/api/image-metadata', imageMetadataRouter);
        app.use('/api/backgrounds', backgroundsRouter);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('the synced file holds only the added time and folders while the cache holds what the file derives', async () => {
        addBackground('glade.png');
        expect((await listBackgrounds()).status).toBe(200);
        const entry = synced().images['backgrounds/glade.png'];
        expect(Object.keys(entry).sort()).toEqual(['addedTimestamp', 'folderIds']);
        expect(entry.folderIds).toEqual([]);
        expect(Number.isFinite(entry.addedTimestamp)).toBe(true);
        expect(synced()).toEqual({ version: 2, images: { 'backgrounds/glade.png': entry }, folders: [] });
        const cached = cache().images['backgrounds/glade.png'];
        expect(Object.keys(cached).sort()).toEqual([...CACHE_FIELDS].sort());
        expect(cached.mtime).toBe(mtimeOf('glade.png'));

        const all = await request(app).post('/api/image-metadata/all').send({ prefix: 'backgrounds/' });
        expect(all.body.images['backgrounds/glade.png']).toMatchObject({ ...cached, folderIds: [], addedTimestamp: entry.addedTimestamp });
    });

    test('the cache file lies outside every synced category', async () => {
        const { SYNC_CATEGORIES, resolveCategoryPaths } = await import('../../src/sync/categories.js');
        const { USER_DIRECTORY_TEMPLATE } = await import('../../src/constants.js');
        const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, rel]) => [key, path.join(root, rel)]));
        const covered = SYNC_CATEGORIES.flatMap(category => resolveCategoryPaths(category, directories).map(resolved => resolved.absolutePath));
        const cacheFile = cachePath();
        expect(covered.length).toBeGreaterThan(0);
        expect(covered.some(target => cacheFile === target || cacheFile.startsWith(`${target}${path.sep}`))).toBe(false);
    });

    test('an added time the synced file already holds is kept and the file is not rewritten', async () => {
        addBackground('glade.png');
        fs.writeFileSync(syncedPath(), JSON.stringify({ version: 2, images: { 'backgrounds/glade.png': { addedTimestamp: 12345, folderIds: [] } }, folders: [] }, null, 4));
        const before = syncedBytes();
        expect((await listBackgrounds()).status).toBe(200);
        expect(syncedBytes()).toBe(before);
        const all = await request(app).post('/api/image-metadata/all').send({});
        expect(all.body.images['backgrounds/glade.png'].addedTimestamp).toBe(12345);
    });

    test('reads with nothing new rewrite neither file', async () => {
        addBackground('glade.png');
        await listBackgrounds();
        const syncedStat = fs.statSync(syncedPath()).mtimeMs;
        const cacheStat = fs.statSync(cachePath()).mtimeMs;
        const before = [syncedBytes(), fs.readFileSync(cachePath(), 'utf8')];
        await new Promise(resolve => setTimeout(resolve, 20));
        await listBackgrounds();
        await request(app).post('/api/image-metadata').send({ paths: ['backgrounds/glade.png'], type: 'bg' });
        await request(app).post('/api/image-metadata/all').send({});
        await request(app).post('/api/backgrounds/folders').send({});
        expect([syncedBytes(), fs.readFileSync(cachePath(), 'utf8')]).toEqual(before);
        expect(fs.statSync(syncedPath()).mtimeMs).toBe(syncedStat);
        expect(fs.statSync(cachePath()).mtimeMs).toBe(cacheStat);
    });

    test('the synced file lists images in key order whatever order they were added in', async () => {
        addBackground('zeta.png');
        await listBackgrounds();
        addBackground('alpha.png');
        await listBackgrounds();
        expect(Object.keys(synced().images)).toEqual(['backgrounds/alpha.png', 'backgrounds/zeta.png']);
        const folder = (await request(app).post('/api/image-metadata/folders/create').send({ name: 'Dawn Skies' })).body;
        expect((await request(app).post('/api/image-metadata/folders/assign').send({ id: folder.id, paths: ['backgrounds/zeta.png'] })).status).toBe(200);
        expect(synced()).toEqual({
            version: 2,
            images: { 'backgrounds/alpha.png': expect.any(Object), 'backgrounds/zeta.png': expect.objectContaining({ folderIds: [folder.id] }) },
            folders: [{ id: folder.id, name: 'Dawn Skies', thumbnailFile: '' }],
        });
    });

    test('startup moves the cache fields of an old combined file to the cache and keeps the folders', async () => {
        addBackground('glade.png');
        const old = {
            version: 1,
            images: { 'backgrounds/glade.png': { hash: 'old-hash', aspectRatio: 1, isAnimated: false, dominantColor: '#123456', folderIds: ['f1'], addedTimestamp: 777, thumbnailResolution: 14400, mtime: mtimeOf('glade.png') } },
            folders: [{ id: 'f1', name: 'Dawn Skies', thumbnailFile: 'glade.png' }],
        };
        fs.writeFileSync(syncedPath(), JSON.stringify(old, null, 4));
        await initializeAllUserMetadata([{ root }]);
        expect(synced()).toEqual({ version: 2, images: { 'backgrounds/glade.png': { addedTimestamp: 777, folderIds: ['f1'] } }, folders: old.folders });
        expect(cache().images['backgrounds/glade.png']).toMatchObject({ hash: 'old-hash', dominantColor: '#123456', mtime: mtimeOf('glade.png') });

        const after = [syncedBytes(), fs.readFileSync(cachePath(), 'utf8')];
        await initializeAllUserMetadata([{ root }]);
        expect([syncedBytes(), fs.readFileSync(cachePath(), 'utf8')]).toEqual(after);
        const folders = await request(app).post('/api/backgrounds/folders').send({});
        expect(folders.body).toEqual({ folders: old.folders, imageFolderMap: { 'glade.png': ['f1'] } });
    });

    test('an old combined file from another device is read without a rewrite and its cache fields are not trusted', async () => {
        addBackground('glade.png');
        const foreign = {
            version: 1,
            images: { 'backgrounds/glade.png': { hash: 'foreign', aspectRatio: 2, isAnimated: false, dominantColor: '#abcdef', folderIds: ['f1'], addedTimestamp: 42, thumbnailResolution: 14400, mtime: 1 } },
            folders: [{ id: 'f1', name: 'Dawn Skies', thumbnailFile: '' }],
        };
        fs.writeFileSync(syncedPath(), JSON.stringify(foreign, null, 4));
        const before = syncedBytes();
        expect((await listBackgrounds()).status).toBe(200);
        expect(syncedBytes()).toBe(before);
        const all = await request(app).post('/api/image-metadata/all').send({});
        expect(all.body.images['backgrounds/glade.png']).toMatchObject({ folderIds: ['f1'], addedTimestamp: 42, aspectRatio: 1, mtime: mtimeOf('glade.png') });
        expect(all.body.images['backgrounds/glade.png'].hash).not.toBe('foreign');
        expect(all.body.folders).toEqual(foreign.folders);
    });

    test('the cache fields of an old combined file that arrived after startup are not adopted even when the mtime matches', async () => {
        addBackground('glade.png');
        await initializeAllUserMetadata([{ root }]);
        const arrived = {
            version: 1,
            images: { 'backgrounds/glade.png': { hash: 'foreign', aspectRatio: 2, isAnimated: false, dominantColor: '#abcdef', folderIds: [], addedTimestamp: 42, thumbnailResolution: 14400, mtime: mtimeOf('glade.png') } },
            folders: [],
        };
        fs.rmSync(cachePath());
        fs.writeFileSync(syncedPath(), JSON.stringify(arrived, null, 4));
        expect((await listBackgrounds()).status).toBe(200);
        expect(cache().images['backgrounds/glade.png']).toMatchObject({ aspectRatio: 1, mtime: mtimeOf('glade.png') });
        expect(cache().images['backgrounds/glade.png'].hash).not.toBe('foreign');
        const all = await request(app).post('/api/image-metadata/all').send({});
        expect(all.body.images['backgrounds/glade.png'].dominantColor).not.toBe('#abcdef');
    });

    test('a synced file that does not parse reports a read failure without replacing its bytes or cache', async () => {
        addBackground('glade.png');
        await listBackgrounds();
        const cached = fs.readFileSync(cachePath());
        const corrupt = '{"version": 2, "images": {"backgrounds/glade.png": {"addedTimestamp": 1, "folderIds": ["f1"]}}, "folders": [{"id": "f1", "name": "Dawn Sk';
        fs.writeFileSync(syncedPath(), corrupt);
        const error = jest.spyOn(console, 'error');
        try {
            await initializeAllUserMetadata([{ root }]);
            expect((await listBackgrounds()).status).toBe(500);
            expect(syncedBytes()).toBe(corrupt);
            expect(fs.readFileSync(cachePath())).toEqual(cached);
            expect(error.mock.calls.some(args => args.some(arg => String(arg).includes(METADATA_FILE)))).toBe(true);
        } finally {
            error.mockRestore();
        }
    });

    test.each(['generation', 'startup'])('a real index read denial during %s preserves complete assignments and cache', async operation => {
        addBackground('glade.png');
        await listBackgrounds();
        const folder = (await request(app).post('/api/image-metadata/folders/create').send({ name: 'Kept folder' })).body;
        await request(app).post('/api/image-metadata/folders/assign').send({ id: folder.id, paths: ['backgrounds/glade.png'] }).expect(200);
        const original = fs.readFileSync(syncedPath());
        const cached = fs.readFileSync(cachePath());
        addBackground('new.png');
        fs.chmodSync(syncedPath(), 0o000);
        try {
            if (operation === 'startup') await initializeAllUserMetadata([{ root }]);
            const response = await request(app).post('/api/image-metadata').send({ paths: ['backgrounds/new.png'], type: 'bg' });
            expect(response.status).toBe(500);
            expect(response.body).toMatchObject({ code: 'IMAGE_METADATA_READ_FAILED', error: expect.stringContaining(METADATA_FILE) });
            expect(fs.readFileSync(cachePath())).toEqual(cached);
        } finally { fs.chmodSync(syncedPath(), 0o600); }
        expect(fs.readFileSync(syncedPath())).toEqual(original);
        const all = await request(app).post('/api/image-metadata/all').send({}).expect(200);
        expect(all.body.images['backgrounds/glade.png'].folderIds).toEqual([folder.id]);
    });

    test.each([
        ['folders/create', { name: 'New folder' }],
        ['folders/set-thumbnails', { updates: [{ id: 'f1', thumbnailFile: 'glade.png' }] }],
    ])('a malformed index blocks %s without replacing any synchronized or cached bytes', async (route, body) => {
        addBackground('glade.png');
        await listBackgrounds();
        const original = fs.readFileSync(syncedPath());
        const cached = fs.readFileSync(cachePath());
        const corrupt = `${original.toString('utf8').slice(0, -1)}INVALID_PRIVATE_INDEX`;
        fs.writeFileSync(syncedPath(), corrupt);
        const response = await request(app).post(`/api/image-metadata/${route}`).send(body);
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'IMAGE_METADATA_PRESERVED', error: expect.stringContaining(METADATA_FILE) });
        expect(JSON.stringify(response.body).includes('INVALID_PRIVATE_INDEX')).toBe(false);
        expect(syncedBytes()).toBe(corrupt);
        expect(fs.readFileSync(cachePath())).toEqual(cached);
        fs.writeFileSync(syncedPath(), original);
        await request(app).post(`/api/image-metadata/${route}`).send(body).expect(200);
    });

    test('rename and delete move and drop the entry in both files', async () => {
        addBackground('glade.png');
        await listBackgrounds();
        expect((await request(app).post('/api/backgrounds/rename').send({ old_bg: 'glade.png', new_bg: 'river.png' })).status).toBe(200);
        expect(Object.keys(synced().images)).toEqual(['backgrounds/river.png']);
        expect(Object.keys(cache().images)).toEqual(['backgrounds/river.png']);
        expect((await request(app).post('/api/backgrounds/delete').send({ bg: 'river.png' })).status).toBe(200);
        expect(synced().images).toEqual({});
        expect(cache().images).toEqual({});
    });
});
