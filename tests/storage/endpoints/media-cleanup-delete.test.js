import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as mediaRouter } from '../../../src/endpoints/media-cleanup.js';

function writeFileAt(root, clientPath, bytes = 4) {
    const diskPath = path.join(root, clientPath);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, Buffer.alloc(bytes));
    return diskPath;
}

describe.each(ENDPOINT_HARNESSES)('media delete on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/media', mediaRouter); },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('deletes only files under user images and characters', async () => {
        const gallery = writeFileAt(harness.dirs.root, '/user/images/Ash/pic.png');
        const sprite = writeFileAt(harness.dirs.root, '/characters/Ash/happy.png');
        const foreign = writeFileAt(harness.dirs.root, '/backups/keep.png');

        const response = await request(harness.app)
            .post('/api/media/delete')
            .send({ paths: ['/user/images/Ash/pic.png', '/characters/Ash/happy.png', '/backups/keep.png', '/user/images/Ash/../Ash/pic.png'] })
            .expect(200);

        expect(new Set(response.body.deleted)).toEqual(new Set(['/user/images/Ash/pic.png', '/characters/Ash/happy.png']));
        expect(new Set(response.body.skipped)).toEqual(new Set(['/backups/keep.png']));
        expect(fs.existsSync(gallery)).toBe(false);
        expect(fs.existsSync(sprite)).toBe(false);
        expect(fs.existsSync(foreign)).toBe(true);
    });

    test('skips traversal outside the root and non-strings', async () => {
        const response = await request(harness.app)
            .post('/api/media/delete')
            .send({ paths: ['/user/images/../../config.yaml', 42, '/user/images/Ash/../../user/images/Ash/gone.png'] })
            .expect(200);
        expect(response.body.deleted).toEqual([]);
        expect(response.body.failed).toEqual([]);
        expect(response.body.skipped.length).toBe(3);
    });

    test('skips entries that are already gone', async () => {
        const target = path.join(harness.dirs.root, 'user', 'images', 'Ash', 'race.png');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'x');
        // Remove before the request so the endpoint sees a missing file.
        fs.rmSync(target);
        const response = await request(harness.app)
            .post('/api/media/delete')
            .send({ paths: ['/user/images/Ash/race.png'] })
            .expect(200);
        expect(response.body.skipped).toEqual(['/user/images/Ash/race.png']);
        expect(response.body.failed).toEqual([]);
    });

    test('rejects a missing paths array', async () => {
        await request(harness.app).post('/api/media/delete').send({}).expect(400);
    });
});
