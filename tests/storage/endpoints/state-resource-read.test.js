import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { router as presetsRouter } from '../../../src/endpoints/presets.js';
import { write as writeCardChunk } from '../../../src/character-card-parser.js';
import { getChatRepo, getPresetRepo } from '../../../src/storage/index.js';

const seedPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));

function seedCard(charsDir, name) {
    fs.mkdirSync(charsDir, { recursive: true });
    const seed = fs.readFileSync(seedPath);
    const png = writeCardChunk(seed, JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name, description: '', extensions: {} },
    }));
    fs.writeFileSync(path.join(charsDir, `${name}.png`), png);
}

describe.each(ENDPOINT_HARNESSES)('state resource GETs on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/characters', charactersRouter);
                app.use('/api/chats', chatsRouter);
                app.use('/api/presets', presetsRouter);
            },
        });
        seedCard(harness.dirs.characters, 'Alice');
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('revalidates character state without changing its envelope', async () => {
        await request(harness.server)
            .post('/api/characters/state/set')
            .send({ avatar_url: 'Alice.png', namespace: 'example', data: { enabled: true } })
            .expect(200);

        const first = await request(harness.server)
            .get('/api/characters/state/get')
            .query({ account: harness.handle, avatar: 'Alice.png', namespace: 'example' })
            .expect(200);
        assert.deepEqual(first.body, { ok: true, data: { enabled: true } });
        assert.match(first.headers.etag, /^W\//);

        await request(harness.server)
            .get('/api/characters/state/get')
            .query({ account: harness.handle, avatar: 'Alice.png', namespace: 'example' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        const missing = await request(harness.server)
            .get('/api/characters/state/get')
            .query({ account: harness.handle, avatar: 'Alice.png', namespace: 'absently_missing' })
            .expect(200);
        assert.deepEqual(missing.body, { ok: true, data: null });

        await request(harness.server)
            .get('/api/characters/state/get')
            .query({ account: 'other', avatar: 'Alice.png', namespace: 'example' })
            .expect(403);
    });

    test('reads single and group chat state from query targets', async () => {
        const repo = getChatRepo();
        await repo.save(harness.handle, 'Alice', 'chat', {}, [], null);
        await repo.setState(harness.handle, 'Alice', 'chat', 'example', { single: true });
        await repo.save(harness.handle, null, 'group-1', {}, [], null, { isGroup: true, groupId: 'group-1' });
        await repo.setState(harness.handle, null, 'group-1', 'example', { group: true }, { isGroup: true, groupId: 'group-1' });

        const single = await request(harness.server)
            .get('/api/chats/state/get')
            .query({
                account: harness.handle,
                is_group: 'false',
                avatar_url: 'Alice.png',
                file_name: 'chat.jsonl',
                namespace: 'example',
            })
            .expect(200);
        assert.deepEqual(single.body, { ok: true, data: { single: true } });

        const group = await request(harness.server)
            .get('/api/chats/state/get')
            .query({ account: harness.handle, is_group: 'true', id: 'group-1', namespace: 'example' })
            .expect(200);
        assert.deepEqual(group.body, { ok: true, data: { group: true } });

        await request(harness.server)
            .get('/api/chats/state/get')
            .query({ account: harness.handle, is_group: 'nope', id: 'group-1', namespace: 'example' })
            .expect(400);
    });

    test('reads preset state and distinguishes absent state from failures', async () => {
        const repo = getPresetRepo();
        await repo.save(harness.handle, 'openai', 'Alpha', { temperature: 0.5 });
        await repo.setState(harness.handle, 'openai', 'Alpha', 'example', { cursor: 4 });

        const loaded = await request(harness.server)
            .get('/api/presets/state/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Alpha', namespace: 'example' })
            .expect(200);
        assert.deepEqual(loaded.body, { ok: true, data: { cursor: 4 } });

        const absent = await request(harness.server)
            .get('/api/presets/state/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Alpha', namespace: 'other' })
            .expect(200);
        assert.deepEqual(absent.body, { ok: true, data: null });

        await request(harness.server)
            .get('/api/presets/state/get')
            .query({ account: harness.handle, apiId: 'bogus', name: 'Alpha', namespace: 'example' })
            .expect(400);
    });
});
