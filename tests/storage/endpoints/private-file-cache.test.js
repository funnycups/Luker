import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as cardAppRouter } from '../../../src/endpoints/card-app.js';
import { createSkillsRouter } from '../../../src/endpoints/skills.js';
import { createSkillRepository } from '../../../src/skills/repository.js';
import { read as readCard, stripCharacterMetadata, write as writeCard } from '../../../src/character-card-parser.js';

const seedPath = fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url));

describe.each(ENDPOINT_HARNESSES)('private file reads on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/card-app', cardAppRouter);
                app.use('/api/skills', createSkillsRouter({
                    getRepository: () => createSkillRepository(harness.dirs.root),
                    getMemoryIndex: () => null,
                }));
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('revalidates a CardApp file after an edit', async () => {
        const charDir = path.join(harness.dirs.cardApps, 'Alice');
        fs.mkdirSync(charDir, { recursive: true });
        const filePath = path.join(charDir, 'index.js');
        fs.writeFileSync(filePath, 'export const value = 1;\n');

        const first = await request(harness.server)
            .get('/api/card-app/Alice/index.js')
            .expect(200);
        assert.equal(first.text, 'export const value = 1;\n');
        assert.match(first.headers['cache-control'], /private/);
        assert.match(first.headers['cache-control'], /no-cache/);
        assert.equal(first.headers.vary, 'Cookie');
        assert.ok(first.headers.etag);

        await request(harness.server)
            .get('/api/card-app/Alice/index.js')
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        fs.writeFileSync(filePath, 'export const value = 2;\n');
        const changed = await request(harness.server)
            .get('/api/card-app/Alice/index.js')
            .expect(200);
        assert.equal(changed.text, 'export const value = 2;\n');
        assert.notEqual(changed.headers.etag, first.headers.etag);
    });

    test('lists skill metadata without changing the editor response shape', async () => {
        const skillDir = path.join(harness.dirs.root, 'skills', 'global', 'demo');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n');
        fs.writeFileSync(path.join(skillDir, 'notes.txt'), 'hello');
        fs.writeFileSync(path.join(skillDir, 'asset.bin'), Buffer.from([0, 1, 2, 3]));

        const listing = await request(harness.server)
            .get('/api/skills/global/demo/files')
            .expect(200);
        assert.deepEqual(listing.body.files.map(file => file.path), ['SKILL.md', 'asset.bin', 'notes.txt']);
        assert.equal(listing.body.files.find(file => file.path === 'notes.txt').size, 5);
        assert.equal(listing.body.files.find(file => file.path === 'asset.bin').isBinary, true);
    });

    test('strips embedded card metadata from an avatar display PNG', async () => {
        const seal = fs.readFileSync(seedPath);
        const card = JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Alice', description: 'display', extensions: {} },
        });
        const withMetadata = writeCard(seal, card);
        assert.equal(readCard(withMetadata).includes('Alice'), true);

        const display = stripCharacterMetadata(withMetadata);
        assert.throws(() => readCard(display), /No PNG metadata/);
        assert.notEqual(Buffer.compare(display, withMetadata), 0);
    });
});
