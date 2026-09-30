import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as mediaRouter } from '../../../src/endpoints/media-cleanup.js';
import { getChatRepo } from '../../../src/storage/index.js';
import { write as writeCardChunk } from '../../../src/character-card-parser.js';
import { appendMediaAttribution } from '../../../src/endpoints/media-attribution.js';

const SEED_PNG = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));
const HEADER = { user_name: 'tester', character_name: 'Ash', chat_metadata: {} };

function writeCard(dir, avatarFile, name) {
    fs.mkdirSync(dir, { recursive: true });
    const seed = fs.readFileSync(SEED_PNG);
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: '' } };
    fs.writeFileSync(path.join(dir, avatarFile), writeCardChunk(seed, JSON.stringify(card)));
}

function writeImage(userRoot, clientPath, bytes = 8) {
    const diskPath = path.join(userRoot, clientPath);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, Buffer.alloc(bytes));
    return diskPath;
}

describe.each(ENDPOINT_HARNESSES)('media deletion candidates on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/media', mediaRouter); },
        });
        fs.mkdirSync(harness.dirs.userImages, { recursive: true });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('chat scope unions the sidecar index and body-scanned references', async () => {
        await getChatRepo().save(harness.handle, 'Ash', 'main', HEADER, [
            { name: 'Ash', mes: 'see <img src="/user/images/Ash/body.png">' },
        ], null);
        writeImage(harness.dirs.root, '/user/images/Ash/body.png');
        writeImage(harness.dirs.root, '/user/images/Ash/indexed.png');
        await appendMediaAttribution({ profile: { handle: harness.handle }, directories: harness.dirs }, { char_dir: 'Ash', chat_name: 'main' }, '/user/images/Ash/indexed.png', 'Ash');

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'chat', char_dir: 'Ash', chat_name: 'main' })
            .expect(200);

        const paths = response.body.groups.flatMap(group => group.items.map(item => item.path));
        expect(new Set(paths)).toEqual(new Set(['/user/images/Ash/body.png', '/user/images/Ash/indexed.png']));
        expect(response.body.notes).toEqual([]);
    });

    test('chat scope strips .jsonl from chat_name forwarded by list endpoints', async () => {
        await getChatRepo().save(harness.handle, 'Ash', 'main', HEADER, [
            { name: 'Ash', mes: 'see <img src="/user/images/Ash/body.png">' },
        ], null);
        writeImage(harness.dirs.root, '/user/images/Ash/body.png');

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'chat', char_dir: 'Ash', chat_name: 'main.jsonl' })
            .expect(200);

        const paths = response.body.groups.flatMap(group => group.items.map(item => item.path));
        expect(paths).toEqual(['/user/images/Ash/body.png']);
    });

    test('chat scope resolves group chat references', async () => {
        const groupId = 'group-nightly';
        await getChatRepo().save(harness.handle, '', groupId, HEADER, [
            { name: 'Ash', mes: 'see <img src="/user/images/group-body.png">' },
        ], null, { isGroup: true, groupId });
        writeImage(harness.dirs.root, '/user/images/group-body.png');

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'chat', is_group: true, chat_name: groupId })
            .expect(200);

        const paths = response.body.groups.flatMap(group => group.items.map(item => item.path));
        expect(paths).toEqual(['/user/images/group-body.png']);
    });

    test('chat scope drops missing files and never leaves user/images', async () => {
        await getChatRepo().save(harness.handle, 'Ash', 'main', HEADER, [
            { name: 'Ash', mes: 'gone /user/images/Ash/gone.png and outside /user/files/x.png' },
        ], null);

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'chat', char_dir: 'Ash', chat_name: 'main' })
            .expect(200);

        expect(response.body.groups).toEqual([]);
    });

    test('character scope lists the owned folders plus chat references', async () => {
        writeCard(harness.dirs.characters, 'ash.png', 'Ash');
        const gallery = writeImage(harness.dirs.root, '/user/images/Ash/gallery.png', 16);
        const sprite = writeImage(harness.dirs.root, '/characters/Ash/happy.png', 4);
        await getChatRepo().save(harness.handle, 'ash', 'main', HEADER, [
            { name: 'Ash', mes: '<img src="/user/images/Ash/body.png">' },
        ], null);
        const body = writeImage(harness.dirs.root, '/user/images/Ash/body.png', 32);

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'character', avatar: 'ash.png' })
            .expect(200);

        const imagePaths = new Set(response.body.groups.find(g => g.kind === 'image').items.map(i => i.path));
        const spritePaths = response.body.groups.find(g => g.kind === 'sprite').items.map(i => i.path);
        expect(imagePaths).toEqual(new Set(['/user/images/Ash/gallery.png', '/user/images/Ash/body.png']));
        expect(spritePaths).toEqual(['/characters/Ash/happy.png']);
        const galleryItem = response.body.groups.find(g => g.kind === 'image').items.find(i => i.path === '/user/images/Ash/gallery.png');
        expect(galleryItem.size).toBe(16);
        expect(response.body.notes).toEqual([]);
        expect(fs.existsSync(gallery) && fs.existsSync(sprite) && fs.existsSync(body)).toBe(true);
    });

    test('character scope skips folder scan when another card shares the name', async () => {
        writeCard(harness.dirs.characters, 'ash.png', 'Ash');
        writeCard(harness.dirs.characters, 'ash-copy.png', 'Ash');
        writeImage(harness.dirs.root, '/user/images/Ash/gallery.png');
        await getChatRepo().save(harness.handle, 'ash', 'main', HEADER, [
            { name: 'Ash', mes: '<img src="/user/images/Ash/body.png">' },
        ], null);
        writeImage(harness.dirs.root, '/user/images/Ash/body.png');

        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'character', avatar: 'ash.png' })
            .expect(200);

        const paths = response.body.groups.flatMap(group => group.items.map(item => item.path));
        expect(paths).toEqual(['/user/images/Ash/body.png']);
        expect(response.body.notes).toEqual(['same_name_shared_folder_skipped']);
    });

    test('character scope without any owned assets returns empty groups', async () => {
        writeCard(harness.dirs.characters, 'ash.png', 'Ash');
        const response = await request(harness.app)
            .post('/api/media/deletion-candidates')
            .send({ scope: 'character', avatar: 'ash.png' })
            .expect(200);
        expect(response.body).toEqual({ groups: [], notes: [] });
    });

    test('rejects unsupported scopes and missing chat names', async () => {
        await request(harness.app).post('/api/media/deletion-candidates').send({ scope: 'server' }).expect(400);
        await request(harness.app).post('/api/media/deletion-candidates').send({ scope: 'chat', char_dir: 'Ash' }).expect(400);
    });
});
