import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { write as writeCardChunk } from '../../../src/character-card-parser.js';
import { diskCache } from '../../../src/endpoints/characters.js';

const seedPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));

function seedCard(charsDir, name, card) {
    fs.mkdirSync(charsDir, { recursive: true });
    const seed = fs.readFileSync(seedPath);
    fs.writeFileSync(path.join(charsDir, `${name}.png`), writeCardChunk(seed, JSON.stringify(card)));
}

const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    unknown_root: { keep: 'yes' },
    data: {
        name: 'Alice',
        description: 'old',
        personality: 'calm',
        scenario: 'room',
        first_mes: 'hello',
        mes_example: '',
        tags: ['a'],
        extensions: {
            cache_fixture: { enabled: true, history: { text: 'preserve me' } },
        },
        character_book: { name: 'book', entries: [{ content: 'book text' }] },
    },
};

describe.each(ENDPOINT_HARNESSES)('character field save on $name', ({ mode }) => {
    afterAll(() => { diskCache.dispose(); });
    let harness;
    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => app.use('/api/characters', charactersRouter),
        });
        seedCard(harness.dirs.characters, 'Alice', CARD);
    });
    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('persists a data-only patch without altering extensions or unknown root fields', async () => {
        const before = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Alice.png' })
            .expect(200);

        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/data/description', value: 'new' }],
            })
            .expect(200);

        const after = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Alice.png' })
            .expect(200);
        assert.equal(after.body.data.description, 'new');
        assert.deepEqual(after.body.data.extensions, before.body.data.extensions);
        assert.deepEqual(after.body.data.character_book, before.body.data.character_book);
        assert.deepEqual(after.body.unknown_root, { keep: 'yes' });
    });

    test('rejects extension and non-data paths', async () => {
        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/data/extensions/cache_fixture/enabled', value: false }],
            })
            .expect(400);

        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/unknown', value: true }],
            })
            .expect(400);

        const current = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Alice.png' })
            .expect(200);
        assert.equal(current.body.data.extensions.cache_fixture.enabled, true);
    });

    test('rejects an empty name and prototype-path writes without touching the card', async () => {
        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/data/name', value: '   ' }],
            })
            .expect(400);

        await request(harness.server)
            .post('/api/characters/patch')
            .send({
                avatar_url: 'Alice.png',
                operations: [{ op: 'add', path: '/data/__proto__/polluted', value: true }],
            })
            .expect(400);

        const current = await request(harness.server)
            .post('/api/characters/get')
            .send({ avatar_url: 'Alice.png' })
            .expect(200);
        assert.equal(current.body.data.name, 'Alice');
        assert.equal({}.polluted, undefined);
    });
});
