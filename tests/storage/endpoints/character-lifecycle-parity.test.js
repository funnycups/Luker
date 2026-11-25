// Endpoint parity for character lifecycle (rename/delete): they must keep
// chat data in step with the avatar, and /characters/chats now drives
// chat_size + date_last_chat through ChatRepo so it doesn't report zero in
// db modes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import multer from 'multer';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter, diskCache } from '../../../src/endpoints/characters.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo, getWorldInfoRepo } from '../../../src/storage/index.js';
import { read as readCardChunk, write as writeCardChunk } from '../../../src/character-card-parser.js';
import { getFileVersion } from '../../../src/storage/file-version.js';

// Minimal PNG-with-V2-card payload — characters.js will accept whatever
// readCharacterData returns, but writeCharacterData expects a real PNG with
// a json chunk embedded. Stub by pre-writing a tiny "PNG" file that contains
// JSON characters.js can parse via readCharacterData on its own short-circuit
// fallback. Where the character data actually matters we set it explicitly.
//
// For these tests it's enough to plant an empty .png + a chat row.
/**
 * Plant a card the same way a real import does: a PNG with a `chara` tEXt
 * chunk, so readCharacterData resolves the display name during delete.
 */
function seedRealCardPng(charsDir, name, jsonData) {
    fs.mkdirSync(charsDir, { recursive: true });
    const seedPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));
    const seed = fs.readFileSync(seedPath);
    const png = writeCardChunk(seed, JSON.stringify(jsonData));
    fs.writeFileSync(path.join(charsDir, `${name}.png`), png);
}

function seedCharacterPng(charsDir, name, jsonData) {
    fs.mkdirSync(charsDir, { recursive: true });
    const filePath = path.join(charsDir, `${name}.png`);
    // characters.js expects PNG-with-text-chunk; fake one by writing the JSON
    // payload directly. characters.js readCharacterData uses pngExtract
    // which will fail; we only exercise endpoints that don't require parsing
    // the card body (chats/rename/delete).
    fs.writeFileSync(filePath, JSON.stringify(jsonData));
}

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [{ name: 'User', mes: 'hi' }, { name: 'Alice', mes: 'hello' }];

afterAll(() => diskCache.dispose());

describe.each(ENDPOINT_HARNESSES)('character lifecycle on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/characters', charactersRouter);
                app.use('/api/chats', chatsRouter);
            },
        });
    });


    test('REGRESSION: /api/characters/delete with delete_chats removes Repo-resident chats', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice', spec: 'chara_card_v2' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        await getChatRepo().save(harness.handle, 'Alice', 'second', HEADER, MESSAGES, null);

        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: true })
            .expect(200);

        const remaining = await getChatRepo().listForCharacter(harness.handle, 'Alice');
        expect(remaining).toEqual([]);
    });

    test('REGRESSION: /api/characters/delete without delete_chats leaves Repo chats intact', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);

        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: false })
            .expect(200);

        const remaining = await getChatRepo().listForCharacter(harness.handle, 'Alice');
        expect(remaining).toHaveLength(1);
    });

    test('deleting a character removes its name-keyed sprites and gallery folders', async () => {
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: '' },
        });

        const spritesDir = path.join(harness.dirs.characters, 'Alice');
        const galleryDir = path.join(harness.dirs.userImages, 'Alice');
        const otherDir = path.join(harness.dirs.userImages, 'Bob');
        fs.mkdirSync(spritesDir, { recursive: true });
        fs.writeFileSync(path.join(spritesDir, 'happy.png'), 'sprite-bytes');
        fs.mkdirSync(galleryDir, { recursive: true });
        fs.writeFileSync(path.join(galleryDir, 'portrait.png'), 'gallery-bytes');
        fs.mkdirSync(otherDir, { recursive: true });
        fs.writeFileSync(path.join(otherDir, 'keep.png'), 'other-bytes');

        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: false })
            .expect(200);

        expect(fs.existsSync(spritesDir)).toBe(false);
        expect(fs.existsSync(galleryDir)).toBe(false);
        expect(fs.existsSync(otherDir)).toBe(true);
    });

    test('skip_asset_cascade leaves name-keyed folders alone while deleting the card', async () => {
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: '' },
        });
        const galleryDir = path.join(harness.dirs.userImages, 'Alice');
        fs.mkdirSync(galleryDir, { recursive: true });
        fs.writeFileSync(path.join(galleryDir, 'portrait.png'), 'gallery-bytes');

        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: false, skip_asset_cascade: true })
            .expect(200);

        expect(fs.existsSync(path.join(harness.dirs.characters, 'Alice.png'))).toBe(false);
        expect(fs.existsSync(path.join(galleryDir, 'portrait.png'))).toBe(true);
    });

    test('cascade keeps shared name folders when another card resolves to the same name', async () => {
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: '' },
        });
        seedRealCardPng(harness.dirs.characters, 'Alice-copy', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: '' },
        });
        const sharedDir = path.join(harness.dirs.userImages, 'Alice');
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(sharedDir, 'keep.png'), 'keep-bytes');

        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: false })
            .expect(200);

        expect(fs.existsSync(path.join(sharedDir, 'keep.png'))).toBe(true);
        expect(fs.existsSync(path.join(harness.dirs.characters, 'Alice-copy.png'))).toBe(true);
    });

    test('REGRESSION: /api/characters/chats reports chat_size + date_last_chat from Repo', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);

        const res = await request(harness.server)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', metadata: true })
            .expect(200);

        const entry = res.body.find((e) => e.file_id === 'main');
        expect(entry).toBeDefined();
        expect(entry.chat_items).toBe(MESSAGES.length);
    });

    test('REGRESSION: Repo chats survive engine restart end-to-end', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'durable', HEADER, MESSAGES, null);

        await harness.reopenEngine();

        const res = await request(harness.server)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', simple: true })
            .expect(200);
        expect(res.body.map((e) => e.file_id)).toContain('durable');
    });
});

const hygieneSeedPngPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));

function isCaseInsensitiveDir(dir) {
    const upper = path.join(dir, 'ProbeCase.tmp');
    const lower = path.join(dir, 'probecase.tmp');
    fs.writeFileSync(upper, '1');
    try {
        const s1 = fs.lstatSync(upper, { bigint: true });
        try {
            const s2 = fs.lstatSync(lower, { bigint: true });
            return s1.dev === s2.dev && s1.ino === s2.ino;
        } catch {
            return false;
        }
    } finally {
        fs.rmSync(upper, { force: true });
    }
}

describe.each(ENDPOINT_HARNESSES)('character endpoints coordination, ConflictError mapping, and temp file hygiene on $name', ({ mode }) => {
    let harness;
    let uploadsDir;
    let onRouteEntered = null;

    function dispatchAndWaitForEntry(supertestReq) {
        const entered = new Promise((resolve) => { onRouteEntered = resolve; });
        const responsePromise = new Promise((resolve, reject) => {
            supertestReq.end((err, res) => (err ? reject(err) : resolve(res)));
        });
        return { entered, responsePromise };
    }

    beforeEach(async () => {
        onRouteEntered = null;
        harness = await makeEndpointHarness({
            mode,
            mount: (app, { dirs }) => {
                uploadsDir = path.join(dirs.root, 'char-uploads');
                fs.mkdirSync(uploadsDir, { recursive: true });
                const upload = multer({
                    storage: multer.diskStorage({
                        destination: (_req, _file, cb) => cb(null, uploadsDir),
                    }),
                }).single('avatar');
                app.use('/api/characters/create', upload);
                app.use('/api/characters/edit', upload);
                app.use('/api/characters/edit-avatar', upload);
                app.use('/api/characters', (_req, _res, next) => {
                    next();
                    if (onRouteEntered) {
                        const cb = onRouteEntered;
                        onRouteEntered = null;
                        cb();
                    }
                }, charactersRouter);
            },
        });
    });

    test('/duplicate returns 409 when racing a committed conditional world deletion and does not leave a duplicate card', async () => {
        const worlds = getWorldInfoRepo();
        const version = await worlds.save(harness.handle, 'BoundWorld', { entries: {} });
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', extensions: { world: 'BoundWorld' } },
        });

        let dupPromise;
        const deleted = await worlds.delete(harness.handle, 'BoundWorld', {
            expectedVersion: version,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/duplicate')
                        .send({ avatar_url: 'Alice.png' }),
                );
                dupPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });

        expect(deleted).toBe(true);
        const dupRes = await dupPromise;
        expect(dupRes.status).toBe(409);
        expect(dupRes.body.code).toBe('world_deleted');
        expect(fs.existsSync(path.join(harness.dirs.characters, 'Alice_1.png'))).toBe(false);
    });

    test('/create, /edit, and /edit-avatar map ConflictError to 409 and clean up uploaded temp files', async () => {
        const worlds = getWorldInfoRepo();
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: 'orig', extensions: { world: 'Ephemeral' } },
        });

        let v1 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let createPromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v1,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/create')
                        .field('ch_name', 'Created')
                        .field('world', 'Ephemeral')
                        .attach('avatar', hygieneSeedPngPath),
                );
                createPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        const createRes = await createPromise;
        expect(createRes.status).toBe(409);
        expect(createRes.body.code).toBe('world_deleted');
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        let v2 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let editPromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v2,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/edit')
                        .field('avatar_url', 'Alice.png')
                        .field('ch_name', 'Alice')
                        .field('world', 'Ephemeral')
                        .attach('avatar', hygieneSeedPngPath),
                );
                editPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        const editRes = await editPromise;
        expect(editRes.status).toBe(409);
        expect(editRes.body.code).toBe('world_deleted');
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        let v3 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let editAvatarPromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v3,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/edit-avatar')
                        .field('avatar_url', 'Alice.png')
                        .attach('avatar', hygieneSeedPngPath),
                );
                editAvatarPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        const editAvatarRes = await editAvatarPromise;
        expect(editAvatarRes.status).toBe(409);
        expect(editAvatarRes.body.code).toBe('world_deleted');
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        const missingRes = await request(harness.server)
            .post('/api/characters/edit-avatar')
            .field('avatar_url', 'DoesNotExist.png')
            .attach('avatar', hygieneSeedPngPath);
        expect(missingRes.status).toBe(400);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);
    });

    test('/rename, /patch, and /edit-attribute map ConflictError to 409', async () => {
        const worlds = getWorldInfoRepo();
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: 'before', extensions: { world: 'Ephemeral' } },
        });

        let v1 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let patchPromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v1,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/patch')
                        .send({ avatar_url: 'Alice.png', operations: [{ op: 'replace', path: '/data/description', value: 'after' }] }),
                );
                patchPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        expect((await patchPromise).status).toBe(409);

        let v2 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let attrPromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v2,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/edit-attribute')
                        .send({ avatar_url: 'Alice.png', ch_name: 'Alice', field: 'description', value: 'after' }),
                );
                attrPromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        expect((await attrPromise).status).toBe(409);

        let v3 = await worlds.save(harness.handle, 'Ephemeral', { entries: {} });
        let renamePromise;
        await worlds.delete(harness.handle, 'Ephemeral', {
            expectedVersion: v3,
            beforeDelete: async () => {
                const dispatched = dispatchAndWaitForEntry(
                    request(harness.server)
                        .post('/api/characters/rename')
                        .send({ avatar_url: 'Alice.png', new_name: 'Bob' }),
                );
                renamePromise = dispatched.responsePromise;
                await dispatched.entered;
            },
        });
        expect((await renamePromise).status).toBe(409);
        expect(fs.existsSync(path.join(harness.dirs.characters, 'Alice.png'))).toBe(true);
        expect(fs.existsSync(path.join(harness.dirs.characters, 'Bob.png'))).toBe(false);
    });

    test('/merge-attributes strips uppercase .PNG case-insensitively and preserves ifMatch self-exemption on case-insensitive FS', async () => {
        if (!isCaseInsensitiveDir(harness.dirs.characters)) {
            return;
        }
        const worlds = getWorldInfoRepo();
        const worldVersion = await worlds.save(harness.handle, 'OwnedWorld', { entries: {} });
        fs.mkdirSync(harness.dirs.characters, { recursive: true });
        const charPath = path.join(harness.dirs.characters, 'Keeper.PNG');
        fs.writeFileSync(charPath, writeCardChunk(fs.readFileSync(hygieneSeedPngPath), JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Keeper',
            data: { name: 'Keeper', description: 'old', extensions: { world: 'OwnedWorld' } },
        })));
        const characterVersion = getFileVersion(charPath);

        const res = await request(harness.server)
            .post('/api/characters/merge-attributes')
            .send({
                avatar: 'Keeper.PNG',
                data: { description: 'updated', extensions: { world: '' } },
                ifMatch: { characterVersion, world: { name: 'OwnedWorld', version: worldVersion } },
            });

        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(harness.dirs.characters, 'Keeper.PNG.png'))).toBe(false);
        const updated = JSON.parse(readCardChunk(fs.readFileSync(charPath)));
        expect(updated.data.description).toBe('updated');
    });

    test('uppercase .PNG character cards preserve extension casing across edit, patch, merge, chats, export, and delete', async () => {
        const worlds = getWorldInfoRepo();
        const worldVersion = await worlds.save(harness.handle, 'UpperWorld', { entries: {} });
        fs.mkdirSync(harness.dirs.characters, { recursive: true });
        const charPath = path.join(harness.dirs.characters, 'Keeper.PNG');
        const cardData = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Keeper',
            data: { name: 'Keeper', description: 'v0', extensions: { world: 'UpperWorld', card_app: { enabled: true } } },
        };
        fs.writeFileSync(charPath, writeCardChunk(fs.readFileSync(hygieneSeedPngPath), JSON.stringify(cardData)));
        await getChatRepo().save(harness.handle, 'Keeper', 'main', HEADER, MESSAGES, null);

        // /all and /chats strip .PNG case-insensitively when looking up chats
        const allRes = await request(harness.server).post('/api/characters/all').send({}).expect(200);
        const listed = allRes.body.find(c => c.avatar === 'Keeper.PNG');
        expect(listed).toBeDefined();
        expect(listed.date_last_chat).toBeGreaterThan(0);

        const chatsRes = await request(harness.server)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Keeper.PNG', simple: true })
            .expect(200);
        expect(chatsRes.body.map(e => e.file_id)).toContain('main');

        // /patch updates Keeper.PNG in place
        await request(harness.server)
            .post('/api/characters/patch')
            .send({ avatar_url: 'Keeper.PNG', operations: [{ op: 'replace', path: '/data/description', value: 'v1-patch' }] })
            .expect(200);
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v1-patch');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);

        // /edit (without file and with uploaded avatar) updates Keeper.PNG in place
        await request(harness.server)
            .post('/api/characters/edit')
            .send({ avatar_url: 'Keeper.PNG', ch_name: 'Keeper', description: 'v1-edit' })
            .expect(200);
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v1-edit');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);

        await request(harness.server)
            .post('/api/characters/edit')
            .field('avatar_url', 'Keeper.PNG')
            .field('ch_name', 'Keeper')
            .field('description', 'v1-edit-file')
            .attach('avatar', hygieneSeedPngPath)
            .expect(200);
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v1-edit-file');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        // /edit-attribute updates Keeper.PNG in place
        await request(harness.server)
            .post('/api/characters/edit-attribute')
            .send({ avatar_url: 'Keeper.PNG', ch_name: 'Keeper', field: 'description', value: 'v2-attr' })
            .expect(200);
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v2-attr');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);

        // /edit-avatar updates Keeper.PNG in place without creating Keeper.png
        await request(harness.server)
            .post('/api/characters/edit-avatar')
            .field('avatar_url', 'Keeper.PNG')
            .attach('avatar', hygieneSeedPngPath)
            .expect(200);
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        // /merge-attributes (single with ifMatch) preserves Keeper.PNG and self-exempts UpperWorld
        const characterVersion = getFileVersion(charPath);
        await request(harness.server)
            .post('/api/characters/merge-attributes')
            .send({
                avatar: 'Keeper.PNG',
                data: { description: 'v3-merge', extensions: { world: '' } },
                ifMatch: { characterVersion, world: { name: 'UpperWorld', version: worldVersion } },
            })
            .expect(200);
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v3-merge');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);

        // /merge-attributes (bulk) updates Keeper.PNG in place
        const bulkRes = await request(harness.server)
            .post('/api/characters/merge-attributes')
            .send({ avatars: ['Keeper.PNG'], data: { data: { description: 'v4-bulk' } } })
            .expect(200);
        expect(bulkRes.body).toEqual({ updated: ['Keeper.PNG'], skipped: [], failed: [] });
        expect(JSON.parse(readCardChunk(fs.readFileSync(charPath))).data.description).toBe('v4-bulk');
        expect(fs.readdirSync(harness.dirs.characters)).toEqual(['Keeper.PNG']);

        // /export (json and png) packs CardApp files under stem Keeper (not Keeper.PNG)
        const cardAppDir = path.join(harness.dirs.cardApps, 'Keeper');
        fs.mkdirSync(cardAppDir, { recursive: true });
        fs.writeFileSync(path.join(cardAppDir, 'app.json'), JSON.stringify({ title: 'UpperApp' }), 'utf8');
        const exportJsonRes = await request(harness.server)
            .post('/api/characters/export')
            .send({ avatar_url: 'Keeper.PNG', format: 'json' })
            .expect(200);
        expect(exportJsonRes.body?.data?.extensions?.card_app?.files?.['app.json']).toBe(JSON.stringify({ title: 'UpperApp' }));

        const exportPngRes = await new Promise((resolve, reject) => {
            request(harness.server)
                .post('/api/characters/export')
                .send({ avatar_url: 'Keeper.PNG', format: 'png' })
                .buffer(true)
                .parse((res, cb) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => cb(null, Buffer.concat(chunks)));
                    res.on('error', cb);
                })
                .end((err, res) => (err ? reject(err) : resolve(res)));
        });
        expect(exportPngRes.status).toBe(200);
        expect(JSON.parse(readCardChunk(exportPngRes.body))?.data?.extensions?.card_app?.files?.['app.json']).toBe(JSON.stringify({ title: 'UpperApp' }));

        // /delete with delete_chats removes Repo chats and CardApp dir stored under stem Keeper
        await request(harness.server)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Keeper.PNG', delete_chats: true })
            .expect(200);
        expect(fs.existsSync(charPath)).toBe(false);
        expect(fs.existsSync(cardAppDir)).toBe(false);
        expect(await getChatRepo().listForCharacter(harness.handle, 'Keeper')).toEqual([]);
    });

    test('/create, /edit-avatar, and bulk /merge-attributes surface writeCharacterData failure instead of HTTP 200', async () => {
        seedRealCardPng(harness.dirs.characters, 'Alice', {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Alice',
            data: { name: 'Alice', description: 'original' },
        });

        // Make characters dir read-only so writeFileAtomicSync inside writeCharacterData fails.
        fs.chmodSync(harness.dirs.characters, 0o500);
        try {
            const createNoFileRes = await request(harness.server)
                .post('/api/characters/create')
                .send({ ch_name: 'BlockedNoFile', file_name: 'BlockedNoFile' });
            expect(createNoFileRes.status).toBe(500);

            const createWithFileRes = await request(harness.server)
                .post('/api/characters/create')
                .field('ch_name', 'BlockedWithFile')
                .field('file_name', 'BlockedWithFile')
                .attach('avatar', hygieneSeedPngPath);
            expect(createWithFileRes.status).toBe(500);
            expect(fs.readdirSync(uploadsDir)).toEqual([]);

            const editAvatarRes = await request(harness.server)
                .post('/api/characters/edit-avatar')
                .field('avatar_url', 'Alice.png')
                .attach('avatar', hygieneSeedPngPath);
            expect(editAvatarRes.status).toBe(500);
            expect(fs.readdirSync(uploadsDir)).toEqual([]);

            const bulkMergeRes = await request(harness.server)
                .post('/api/characters/merge-attributes')
                .send({ avatars: ['Alice.png'], data: { description: 'should-fail' } })
                .expect(200);
            expect(bulkMergeRes.body).toEqual({ updated: [], skipped: [], failed: ['Alice.png'] });
        } finally {
            fs.chmodSync(harness.dirs.characters, 0o700);
        }
    });
});
