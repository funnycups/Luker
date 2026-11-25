import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
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

    test('lists built-in and user themes and reads both with conditional validation', async () => {
        const doc = { name: 'Sample', value: 1 };
        await getNamedDocRepo().save(harness.handle, 'themes', 'Sample', doc);

        const list = await request(harness.server)
            .get('/api/themes/list')
            .query({ account: harness.handle })
            .expect(200);
        expect(list.body.builtin).toContain('Lens');
        expect(list.body.names).toEqual(expect.arrayContaining([...list.body.builtin, 'Sample']));

        const userFirst = await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'Sample' })
            .expect(200);
        expect(userFirst.body).toEqual(doc);

        await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'Sample' })
            .set('If-None-Match', userFirst.headers.etag)
            .expect(304);

        const builtinFirst = await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'Lens' })
            .expect(200);
        expect(builtinFirst.body.builtin).toBe(true);
        expect(builtinFirst.body.builtin_stylesheet).toBe('css/themes/lens.css');

        await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'Lens' })
            .set('If-None-Match', builtinFirst.headers.etag)
            .expect(304);

        await request(harness.server)
            .get('/api/themes/get')
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

    test('fetches every advertised legacy whitespace theme name exactly alongside built-ins', async () => {
        const names = [' Sample', 'Sample', 'Trailing ', ' Both '];
        if (mode === 'fs') names.push('Sample ', '   ');
        for (const name of names) {
            const doc = { name, marker: `stored:${name}` };
            if (mode === 'fs') {
                fs.writeFileSync(path.join(harness.dirs.themes, `${name}.json`), JSON.stringify(doc));
            } else {
                await getNamedDocRepo().save(harness.handle, 'themes', name, doc);
            }
        }
        const list = await request(harness.server).get('/api/themes/list')
            .query({ account: harness.handle }).expect(200);
        expect(list.body.names).toEqual(expect.arrayContaining([...list.body.builtin, ...names]));
        for (const name of names) {
            const first = await request(harness.server).get('/api/themes/get')
                .query({ account: harness.handle, name }).expect(200);
            expect(first.body).toEqual({ name, marker: `stored:${name}` });
            await request(harness.server).get('/api/themes/get')
                .query({ account: harness.handle, name })
                .set('If-None-Match', first.headers.etag).expect(304);
        }
        await request(harness.server).get('/api/themes/get')
            .query({ account: harness.handle, name: '' }).expect(400);
        await request(harness.server).get('/api/themes/get')
            .query({ account: harness.handle, name: '../Sample' }).expect(404);
    });

    test.each(['/api/moving-ui', '/api/quick-replies'])('keeps new %s saves normalized and validated', async (route) => {
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

    test('keeps new /api/themes saves normalized, validated, and read-only for built-ins', async () => {
        await request(harness.server).post('/api/themes/save')
            .send({ name: ' Saved ', value: 1 }).expect(200);
        await request(harness.server).post('/api/themes/save')
            .send({ name: '../Escape' }).expect(400);
        await request(harness.server).post('/api/themes/save')
            .send({ name: 'Lens', custom_css: 'body{}' }).expect(403);
        const list = await request(harness.server).get('/api/themes/list')
            .query({ account: harness.handle }).expect(200);
        expect(list.body.names).toContain('Saved');
        const saved = await request(harness.server).get('/api/themes/get')
            .query({ account: harness.handle, name: 'Saved' }).expect(200);
        expect(saved.body).toEqual({ name: ' Saved ', value: 1 });
        await request(harness.server).get('/api/themes/get')
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

    test('returns 404 when a requested preset name only has an aliased legacy state file', async () => {
        await getPresetRepo().setState(harness.handle, 'openai', 'A', 'n', { marker: 'state-only' });

        await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'A.luker-state.n' })
            .expect(404)
            .expect(({ body }) => {
                expect(body.code).toBe('not_found');
            });
    });

    test('distinguishes an invalid named document from a missing named document', async () => {
        if (mode !== 'fs') {
            return;
        }
        fs.writeFileSync(path.join(harness.dirs.themes, 'CorruptTheme.json'), '{not json');

        await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'CorruptTheme' })
            .expect(422)
            .expect(({ body }) => {
                expect(body.code).toBe('invalid_resource');
            });
    });

    test('reads preset and named documents without redundant directory pre-scans', async () => {
        if (mode !== 'fs') {
            return;
        }
        for (let i = 0; i < 8; i++) {
            await getPresetRepo().save(harness.handle, 'openai', `Preset_${i}`, { temperature: 0.5, index: i });
        }
        await getNamedDocRepo().save(harness.handle, 'themes', 'DirectTheme', { name: 'DirectTheme', value: 1 });

        const readdirSpy = jest.spyOn(fs, 'readdirSync');
        try {
            readdirSpy.mockClear();
            await request(harness.server)
                .get('/api/presets/get')
                .query({ account: harness.handle, apiId: 'openai', name: 'Preset_3' })
                .expect(200);
            expect(readdirSpy.mock.calls.length).toBe(1);

            readdirSpy.mockClear();
            await request(harness.server)
                .get('/api/themes/get')
                .query({ account: harness.handle, name: 'DirectTheme' })
                .expect(200);
            expect(readdirSpy.mock.calls.length).toBe(0);

            readdirSpy.mockClear();
            const allPresets = await getPresetRepo().listWithDocs(harness.handle, 'openai');
            expect(allPresets).toHaveLength(8);
            expect(readdirSpy.mock.calls.length).toBe(1);
        } finally {
            readdirSpy.mockRestore();
        }
    });

    test('reuses stat-fingerprinted representations across conditional preset and named document reads', async () => {
        if (mode !== 'fs') {
            return;
        }
        await getPresetRepo().save(harness.handle, 'openai', 'CachedPreset', { temperature: 0.6, marker: 'v1' });
        await getNamedDocRepo().save(harness.handle, 'themes', 'CachedTheme', { name: 'CachedTheme', bg: '#111' });

        const firstPreset = await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'CachedPreset' })
            .expect(200);
        const firstTheme = await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'CachedTheme' })
            .expect(200);

        const readFileSpy = jest.spyOn(fs, 'readFileSync');
        const hashSpy = jest.spyOn(crypto, 'createHash');
        try {
            readFileSpy.mockClear();
            hashSpy.mockClear();

            await request(harness.server)
                .get('/api/presets/get')
                .query({ account: harness.handle, apiId: 'openai', name: 'CachedPreset' })
                .set('If-None-Match', firstPreset.headers.etag)
                .expect(304);
            await request(harness.server)
                .get('/api/themes/get')
                .query({ account: harness.handle, name: 'CachedTheme' })
                .set('If-None-Match', firstTheme.headers.etag)
                .expect(304);

            expect(readFileSpy).not.toHaveBeenCalled();
            expect(hashSpy).not.toHaveBeenCalled();
        } finally {
            readFileSpy.mockRestore();
            hashSpy.mockRestore();
        }

        await getPresetRepo().save(harness.handle, 'openai', 'CachedPreset', { temperature: 0.9, marker: 'v2' });
        const updatedPreset = await request(harness.server)
            .get('/api/presets/get')
            .query({ account: harness.handle, apiId: 'openai', name: 'CachedPreset' })
            .set('If-None-Match', firstPreset.headers.etag)
            .expect(200);
        expect(updatedPreset.body).toEqual({ temperature: 0.9, marker: 'v2' });
        expect(updatedPreset.headers.etag).not.toBe(firstPreset.headers.etag);
    });
});
