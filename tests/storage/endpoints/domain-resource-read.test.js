import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as worldInfoRouter } from '../../../src/endpoints/worldinfo.js';
import { router as presetsRouter } from '../../../src/endpoints/presets.js';
import { router as quickRepliesRouter } from '../../../src/endpoints/quick-replies.js';
import { router as themesRouter } from '../../../src/endpoints/themes.js';
import { router as movingUiRouter } from '../../../src/endpoints/moving-ui.js';
import { getNamedDocRepo, getPresetRepo, getWorldInfoRepo } from '../../../src/storage/index.js';

describe.each(ENDPOINT_HARNESSES)('domain resource GETs on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/worldinfo', worldInfoRouter);
                app.use('/api/presets', presetsRouter);
                app.use('/api/quick-replies', quickRepliesRouter);
                app.use('/api/themes', themesRouter);
                app.use('/api/moving-ui', movingUiRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('lists and reads preset bodies with validation', async () => {
        const doc = { temperature: 0.7, custom_marker: 'stored' };
        await getPresetRepo().save(harness.handle, 'openai', 'Alpha', doc);

        const list = await request(harness.server)
            .get('/api/presets/list')
            .query({ account: harness.handle, apiId: 'openai' })
            .expect(200);
        expect(list.body).toEqual({ names: ['Alpha'] });

        const first = await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Alpha' })
            .expect(200);
        expect(first.body).toEqual(doc);
        expect(first.headers.etag).toMatch(/^W\//);

        await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Alpha' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Missing' })
            .expect(404);
    });

    test('lists and reads world documents with validation', async () => {
        const doc = { entries: { 0: { uid: 0, key: ['x'], content: 'lore' } } };
        await getWorldInfoRepo().save(harness.handle, 'Lore', doc);

        const list = await request(harness.server)
            .get('/api/worldinfo/list')
            .query({ account: harness.handle })
            .expect(200);
        expect(list.body).toEqual({ names: ['Lore'] });

        const first = await request(harness.server)
            .get('/api/worldinfo/get')
            .query({ account: harness.handle, name: 'Lore' })
            .expect(200);
        expect(first.body).toEqual(doc);

        await request(harness.server)
            .get('/api/worldinfo/get')
            .query({ account: harness.handle, name: 'Lore' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        await request(harness.server)
            .get('/api/worldinfo/get')
            .query({ account: harness.handle, name: 'Missing' })
            .expect(404);
    });

    test.each([
        ['themes', '/api/themes', 'themes'],
        ['moving-ui', '/api/moving-ui', 'movingUI'],
        ['quick-replies', '/api/quick-replies', 'quickReplies'],
    ])('lists and reads %s documents with validation', async (_label, route, bucket) => {
        const doc = { name: 'Sample', value: 1 };
        await getNamedDocRepo().save(harness.handle, bucket, 'Sample', doc);

        const list = await request(harness.server)
            .get(`${route}/list`)
            .query({ account: harness.handle })
            .expect(200);
        expect(list.body).toEqual({ names: ['Sample'] });

        const first = await request(harness.server)
            .get(`${route}/get`)
            .query({ account: harness.handle, name: 'Sample' })
            .expect(200);
        expect(first.body).toEqual(doc);

        await request(harness.server)
            .get(`${route}/get`)
            .query({ account: harness.handle, name: 'Sample' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        await request(harness.server)
            .get(`${route}/get`)
            .query({ account: harness.handle, name: 'Missing' })
            .expect(404);
    });

    test('rejects a different account', async () => {
        const response = await request(harness.server)
            .get('/api/themes/list')
            .query({ account: 'someone-else' })
            .expect(403);
        expect(response.body.code).toBe('forbidden');
    });

    test.each([
        ['/api/themes', 'themes', 'themes'],
        ['/api/moving-ui', 'movingUI', 'movingUI'],
        ['/api/quick-replies', 'quickReplies', 'quickreplies'],
    ])('fetches every advertised legacy whitespace name from %s exactly', async (route, bucket, dirKey) => {
        const names = [' Sample', 'Sample', 'Trailing ', ' Both '];
        if (mode === 'fs') names.push('Sample ', '   ');
        for (const name of names) {
            const doc = { name, marker: `stored:${name}` };
            if (mode === 'fs') {
                // Seed legacy files directly: fresh saves intentionally trim names.
                fs.writeFileSync(path.join(harness.dirs[dirKey], `${name}.json`), JSON.stringify(doc));
            } else {
                await getNamedDocRepo().save(harness.handle, bucket, name, doc);
            }
        }
        const list = await request(harness.server).get(`${route}/list`)
            .query({ account: harness.handle }).expect(200);
        expect(list.body.names).toEqual(expect.arrayContaining(names));
        expect(list.body.names).toHaveLength(names.length);
        for (const name of list.body.names) {
            const first = await request(harness.server).get(`${route}/get`)
                .query({ account: harness.handle, name }).expect(200);
            expect(first.body).toEqual({ name, marker: `stored:${name}` });
            await request(harness.server).get(`${route}/get`)
                .query({ account: harness.handle, name })
                .set('If-None-Match', first.headers.etag).expect(304);
        }
        await request(harness.server).get(`${route}/get`)
            .query({ account: harness.handle, name: '' }).expect(400);
        await request(harness.server).get(`${route}/get`)
            .query({ account: harness.handle, name: '../Sample' }).expect(404);
    });

    test.each(['/api/themes', '/api/moving-ui', '/api/quick-replies'])('keeps new %s saves normalized and validated', async (route) => {
        await request(harness.server).post(`${route}/save`)
            .send({ name: ' Saved ', value: 1 }).expect(200);
        await request(harness.server).post(`${route}/save`)
            .send({ name: '../Escape' }).expect(400);
        const list = await request(harness.server).get(`${route}/list`)
            .query({ account: harness.handle }).expect(200);
        expect(list.body).toEqual({ names: ['Saved'] });
        const saved = await request(harness.server).get(`${route}/get`)
            .query({ account: harness.handle, name: 'Saved' }).expect(200);
        expect(saved.body).toEqual({ name: ' Saved ', value: 1 });
        await request(harness.server).get(`${route}/get`)
            .query({ account: harness.handle, name: ' Saved ' }).expect(404);
    });

    test('distinguishes an invalid preset from a missing preset', async () => {
        if (mode !== 'fs') {
            return;
        }
        fs.writeFileSync(path.join(harness.dirs.openAI_Settings, 'Corrupt.json'), '{not json');

        await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'Corrupt' })
            .expect(422)
            .expect(({ body }) => {
                expect(body.code).toBe('invalid_resource');
            });
    });
});
