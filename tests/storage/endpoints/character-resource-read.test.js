import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { write as writeCardChunk, read as readCard } from '../../../src/character-card-parser.js';
import { getChatRepo } from '../../../src/storage/index.js';
import { diskCache } from '../../../src/endpoints/characters.js';
import { assembleCharacterRaw } from '../../../src/character-resource-view.js';
import { applyPatch } from '../../../public/scripts/util/fast-json-patch.js';

const seedPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));

function seedCard(charsDir, name, card) {
    fs.mkdirSync(charsDir, { recursive: true });
    const seed = fs.readFileSync(seedPath);
    const png = writeCardChunk(seed, JSON.stringify(card));
    fs.writeFileSync(path.join(charsDir, `${name}.png`), png);
}

const V1_CARD = {
    name: 'Legacy Alice',
    description: 'A V1 card',
    personality: 'Steady',
    scenario: '',
    first_mes: 'Old greeting',
    mes_example: '',
    extensions: { legacy_fixture: { keep: true } },
};

const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: 'Alice',
        description: 'A description',
        personality: 'Calm',
        scenario: 'A room',
        first_mes: 'Hello',
        mes_example: '',
        tags: ['one', 'two'],
        extensions: {
            cache_fixture: {
                enabled: true,
                history: { entries: Array.from({ length: 8 }, (_, index) => ({ index, text: `entry ${index}` })) },
            },
            depth_prompt: { prompt: 'depth', depth: 4, role: 'system' },
        },
        character_book: {
            name: 'embedded',
            entries: [{ keys: ['k'], content: 'book text', enabled: true }],
        },
    },
    unknown_root: { keep: [1, 2, 3] },
};

describe.each(ENDPOINT_HARNESSES)('character resource reads on $name', ({ mode }) => {
    afterAll(() => { diskCache.dispose(); });
    let harness;
    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            handle: randomUUID(),
            mount: (app) => app.use('/api/characters', charactersRouter),
        });
        seedCard(harness.dirs.characters, 'Alice', CARD);
    });
    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('reconstructs a legacy character from field and projection resources', async () => {
        const directoryResponse = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        const directory = directoryResponse.body;
        assert.equal(typeof directory.projection.etag, 'string');
        assert.ok(Array.isArray(directory.rawLayout));
        assert.ok(Array.isArray(directory.fields));

        const values = new Map();
        for (const field of directory.fields) {
            const fieldResponse = await request(harness.server)
                .get('/api/characters/field')
                .query({ account: harness.handle, avatar: 'Alice.png', path: field.path })
                .expect(200);
            assert.equal(fieldResponse.headers.etag, field.etag);
            assert.equal(fieldResponse.type, 'application/json');
            values.set(field.path, fieldResponse.text);
        }

        const raw = assembleCharacterRaw(directory.rawLayout, values);
        const legacyResponse = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Alice.png' })
            .expect(200);
        assert.equal(raw, legacyResponse.body.json_data);
        assert.equal(raw, readCard(fs.readFileSync(path.join(harness.dirs.characters, 'Alice.png'))));

        const projectionResponse = await request(harness.server)
            .get('/api/characters/projection')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        assert.equal(projectionResponse.body.patch.length > 0, true);
        assert.deepEqual(projectionResponse.body.keyOrder, Object.keys(legacyResponse.body));
        const rebuilt = applyPatch(JSON.parse(raw), projectionResponse.body.patch).newDocument;
        rebuilt.json_data = raw;
        assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), legacyResponse.body);
    });

    test('reconstructs a V1 card from the same raw source contract', async () => {
        seedCard(harness.dirs.characters, 'Legacy', V1_CARD);

        const directory = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Legacy.png' })
            .expect(200);
        const values = new Map();
        for (const field of directory.body.fields) {
            const fieldResponse = await request(harness.server)
                .get('/api/characters/field')
                .query({ account: harness.handle, avatar: 'Legacy.png', path: field.path })
                .expect(200);
            values.set(field.path, fieldResponse.text);
        }
        const raw = assembleCharacterRaw(directory.body.rawLayout, values);
        const legacy = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Legacy.png' })
            .expect(200);
        assert.equal(raw, legacy.body.json_data);
        assert.equal(legacy.body.data.name, 'Legacy Alice');
        assert.deepEqual(legacy.body.data.extensions.legacy_fixture, { keep: true });
    });

    test('keeps unchanged field validators after an ordinary data edit', async () => {
        const first = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        const before = new Map(first.body.fields.map(field => [field.path, field.etag]));

        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/data/description', value: 'changed' }],
            })
            .expect(200);

        const second = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        const after = new Map(second.body.fields.map(field => [field.path, field.etag]));
        assert.notEqual(after.get('/data/description'), before.get('/data/description'));
        assert.equal(after.get('/data/extensions/cache_fixture'), before.get('/data/extensions/cache_fixture'));
        assert.equal(after.get('/data/character_book'), before.get('/data/character_book'));
    });

    test('distinguishes a missing card and an unreadable card', async () => {
        await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Missing.png' })
            .expect(404);

        fs.writeFileSync(path.join(harness.dirs.characters, 'Broken.png'), 'not a png');
        const broken = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Broken.png' })
            .expect(422);
        assert.equal(broken.body.code, 'invalid_resource');
    });

    test('refreshes the projection when chat statistics change', async () => {
        const first = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        await getChatRepo().save(harness.handle, 'Alice', 'chat', {}, [], null);
        const second = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'Alice.png' })
            .expect(200);
        assert.notEqual(second.body.projection.etag, first.body.projection.etag);
    });

    test('returns 404 for an unknown field and 400 for an escaped container path', async () => {
        await request(harness.server)
            .get('/api/characters/field')
            .query({ account: harness.handle, avatar: 'Alice.png', path: '/missing' })
            .expect(404);
        await request(harness.server)
            .get('/api/characters/field')
            .query({ account: harness.handle, avatar: 'Alice.png', path: '/data' })
            .expect(400);
    });

    test.each([
        [' Alice', 'Alice'],
        ['Alice:Prime', 'AlicePrime'],
    ])('reads the exact existing filename %s rather than its normalized sibling', async (name, sibling) => {
        seedCard(harness.dirs.characters, sibling, CARD);
        seedCard(harness.dirs.characters, name, {
            ...CARD,
            data: { ...CARD.data, description: 'Exact filename target' },
        });
        const response = await request(harness.server)
            .get('/api/characters/field')
            .query({ account: harness.handle, avatar: `${name}.png`, path: '/data/description' })
            .expect(200);
        assert.equal(JSON.parse(response.text), 'Exact filename target');
    });

    test.each([
        [' Alice', 'Alice'],
        ['Alice:Prime', 'AlicePrime'],
    ])('patches the exact existing filename %s without changing its sibling', async (name, sibling) => {
        seedCard(harness.dirs.characters, sibling, CARD);
        seedCard(harness.dirs.characters, name, CARD);
        const siblingPath = path.join(harness.dirs.characters, `${sibling}.png`);
        const siblingBytes = fs.readFileSync(siblingPath);
        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: `${name}.png`,
                operations: [{ op: 'replace', path: '/data/description', value: 'Patched exact target' }],
            })
            .expect(200);
        const saved = JSON.parse(readCard(fs.readFileSync(path.join(harness.dirs.characters, `${name}.png`))));
        assert.equal(saved.data.description, 'Patched exact target');
        assert.deepEqual(fs.readFileSync(siblingPath), siblingBytes);
    });

    test('reads an advertised field whose root property name is empty', async () => {
        seedCard(harness.dirs.characters, 'EmptyKey', { ...CARD, '': { preserved: true } });
        const directory = await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar: 'EmptyKey.png' })
            .expect(200);
        const field = directory.body.fields.find(candidate => candidate.path === '/');
        assert.ok(field);
        const response = await request(harness.server)
            .get('/api/characters/field')
            .query({ account: harness.handle, avatar: 'EmptyKey.png', path: '/' })
            .expect(200);
        assert.equal(response.headers.etag, field.etag);
        assert.deepEqual(response.body, { preserved: true });
    });

    test.each(['../Alice.png', '/Alice.png', '.', '..'])('rejects an avatar path %s without mutating cards', async avatar => {
        const before = fs.readFileSync(path.join(harness.dirs.characters, 'Alice.png'));
        await request(harness.server)
            .get('/api/characters/fields')
            .query({ account: harness.handle, avatar })
            .expect(400);
        await request(harness.server)
            .post('/api/characters/patch')
            .send({ avatar_url: avatar, operations: [{ op: 'replace', path: '/data/description', value: 'escaped' }] })
            .expect(400);
        assert.deepEqual(fs.readFileSync(path.join(harness.dirs.characters, 'Alice.png')), before);
    });
});
