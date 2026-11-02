import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as settingsRouter } from '../../../src/endpoints/settings.js';
import { getSettingsRepo } from '../../../src/storage/index.js';

const DOCUMENT = {
    user_name: 'tester',
    extension_settings: {
        example: {
            enabled: true,
            history: { entries: [1, 2, 3] },
            nullable: null,
        },
        'array-namespace': [1, 2],
    },
};

describe.each(ENDPOINT_HARNESSES)('settings field resources on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/settings', settingsRouter);
            },
        });
        await getSettingsRepo().save(harness.handle, DOCUMENT);
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('lists one leaf per extension namespace with validators that match field responses', async () => {
        const directory = await request(harness.server)
            .get('/api/settings/fields')
            .query({ account: harness.handle })
            .expect(200);

        expect(directory.body.containers).toEqual([
            { path: '', keys: ['user_name', 'extension_settings'] },
            { path: '/extension_settings', keys: ['example', 'array-namespace'] },
        ]);
        const etags = Object.fromEntries(directory.body.fields.map(field => [field.path, field.etag]));
        expect(Object.keys(etags).sort()).toEqual([
            '/extension_settings/array-namespace',
            '/extension_settings/example',
            '/user_name',
        ]);

        const field = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example' })
            .expect(200);
        expect(field.body).toEqual(DOCUMENT.extension_settings.example);
        expect(field.headers.etag).toBe(etags['/extension_settings/example']);
    });

    test('revalidates unchanged plugin objects and changes only the edited plugin validator', async () => {
        const before = await request(harness.server)
            .get('/api/settings/fields')
            .query({ account: harness.handle })
            .expect(200);
        const beforeEtags = Object.fromEntries(before.body.fields.map(field => [field.path, field.etag]));

        const field = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example' })
            .expect(200);
        await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example' })
            .set('If-None-Match', field.headers.etag)
            .expect(304);

        await getSettingsRepo().save(harness.handle, {
            ...DOCUMENT,
            extension_settings: {
                ...DOCUMENT.extension_settings,
                example: { ...DOCUMENT.extension_settings.example, enabled: false },
            },
        });

        const after = await request(harness.server)
            .get('/api/settings/fields')
            .query({ account: harness.handle })
            .expect(200);
        const afterEtags = Object.fromEntries(after.body.fields.map(fieldEntry => [fieldEntry.path, fieldEntry.etag]));

        expect(afterEtags['/extension_settings/example'])
            .not.toBe(beforeEtags['/extension_settings/example']);
        expect(afterEtags['/extension_settings/array-namespace'])
            .toBe(beforeEtags['/extension_settings/array-namespace']);
    });

    test('rejects container and nested paths while allowing whole namespace leaves', async () => {
        const container = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings' })
            .expect(400);
        expect(container.body.code).toBe('invalid_args');
        const nested = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example/enabled' })
            .expect(400);
        expect(nested.body.code).toBe('invalid_args');
        const index = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/array-namespace/0' })
            .expect(400);
        expect(index.body.code).toBe('invalid_args');
        const objectLeaf = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example' })
            .expect(200);
        expect(objectLeaf.body).toEqual(DOCUMENT.extension_settings.example);
        const arrayLeaf = await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/array-namespace' })
            .expect(200);
        expect(arrayLeaf.body).toEqual([1, 2]);
    });

    test('distinguishes missing and malformed paths', async () => {
        await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/absent' })
            .expect(404);
        await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: '/extension_settings/example/absent' })
            .expect(400);
        await request(harness.server)
            .get('/api/settings/field')
            .query({ account: harness.handle, path: 'not-a-pointer' })
            .expect(400);
        const mismatched = await request(harness.server)
            .get('/api/settings/fields')
            .query({ account: 'other' })
            .expect(403);
        expect(mismatched.body.code).toBe('forbidden');
    });

    test('reports a corrupt settings document without replacing it', async () => {
        if (mode !== 'fs') {
            return;
        }
        fs.writeFileSync(path.join(harness.dirs.root, 'settings.json'), '{not json');
        const response = await request(harness.server)
            .get('/api/settings/fields')
            .query({ account: harness.handle })
            .expect(422);
        expect(response.body.code).toBe('invalid_resource');
        expect(fs.readFileSync(path.join(harness.dirs.root, 'settings.json'), 'utf8')).toBe('{not json');
    });
});
