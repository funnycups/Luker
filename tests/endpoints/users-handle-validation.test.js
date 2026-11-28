import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import storage from 'node-persist';
import request from 'supertest';

import { router as usersAdminRouter } from '../../src/endpoints/users-admin.js';
import { router as usersPrivateRouter } from '../../src/endpoints/users-private.js';
import { getUserDirectories, toKey } from '../../src/users.js';
import { getStorageEngine, initStorage } from '../../src/storage/index.js';

function buildApp(adminHandle = 'admin-handle') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: adminHandle, admin: true, enabled: true, name: 'Admin' },
            directories: getUserDirectories(adminHandle),
        };
        next();
    });
    app.use('/api/users', usersAdminRouter);
    app.use('/api/users', usersPrivateRouter);
    return app;
}

describe('admin user handle and target validation', () => {
    let tmpRoot;
    let dataRoot;
    let outsideDir;
    let prevDataRoot;
    let app;
    let handleCounter = 0;

    function nextHandle(prefix) {
        handleCounter += 1;
        return `${prefix}-${Date.now()}-${handleCounter}`;
    }

    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-handle-val-'));
        dataRoot = path.join(tmpRoot, 'data');
        outsideDir = path.join(tmpRoot, 'escape');
        fs.mkdirSync(dataRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, 'sentinel.txt'), 'keep');

        prevDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = dataRoot;

        await initStorage({ mode: 'fs', directoriesByHandle: getUserDirectories });

        await storage.init({
            dir: path.join(dataRoot, '_storage'),
            ttl: false,
            expiredInterval: 0,
        });

        app = buildApp(nextHandle('admin'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        globalThis.DATA_ROOT = prevDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('POST /delete rejects non-string and unknown or traversal handles without touching files', async () => {
        const badType = await request(app)
            .post('/api/users/delete')
            .send({ handle: ['../escape'], purge: true });
        expect(badType.status).toBe(400);

        const traversal = await request(app)
            .post('/api/users/delete')
            .send({ handle: '../escape', purge: true });
        expect(traversal.status).toBe(404);
        expect(fs.existsSync(path.join(outsideDir, 'sentinel.txt'))).toBe(true);
    });

    test('POST /delete disables the user before engine cleanup so failed deletes can be retried', async () => {
        const target = nextHandle('retry-user');
        const targetDirs = getUserDirectories(target);
        fs.mkdirSync(targetDirs.root, { recursive: true });
        fs.writeFileSync(path.join(targetDirs.root, 'marker.txt'), 'data');

        await storage.setItem(toKey(target), {
            handle: target,
            name: 'Retry User',
            created: 0,
            password: '',
            salt: '',
            admin: false,
            enabled: true,
        });

        const deleteSpy = jest.spyOn(getStorageEngine(), 'deleteUser')
            .mockRejectedValueOnce(new Error('transient db outage'));

        const first = await request(app)
            .post('/api/users/delete')
            .send({ handle: target, purge: true });
        expect(first.status).toBe(500);

        const afterFail = await storage.getItem(toKey(target));
        expect(afterFail).toBeDefined();
        expect(afterFail.enabled).toBe(false);
        expect(fs.existsSync(targetDirs.root)).toBe(true);

        const retry = await request(app)
            .post('/api/users/delete')
            .send({ handle: target, purge: true });
        expect(retry.status).toBe(204);
        expect(deleteSpy).toHaveBeenCalledTimes(2);
        expect(await storage.getItem(toKey(target))).toBeUndefined();
        expect(fs.existsSync(targetDirs.root)).toBe(false);
    });

    test('POST /storage/inspect-any rejects unknown and traversal targets even when the directory exists', async () => {
        const traversal = await request(app)
            .post('/api/users/storage/inspect-any')
            .send({ target: '../escape', path: [] });
        expect(traversal.status).toBe(404);
        expect(traversal.body.error?.code).toBe('E_TARGET_NOT_FOUND');

        const known = nextHandle('inspected');
        const knownDirs = getUserDirectories(known);
        fs.mkdirSync(knownDirs.root, { recursive: true });
        await storage.setItem(toKey(known), {
            handle: known,
            name: 'Inspected',
            created: 0,
            password: '',
            salt: '',
            admin: false,
            enabled: true,
        });

        const ok = await request(app)
            .post('/api/users/storage/inspect-any')
            .send({ target: known, path: [] });
        expect(ok.status).toBe(200);
        expect(ok.body.target).toEqual({ type: 'user', handle: known });
    });

    test.each([
        ['/api/users/backup', { selection: { settings: true } }],
        ['/api/users/lan-migration/offer', { selection: { settings: true } }],
        ['/api/users/restore-backup/uploads', { fileName: 'b.zip', size: 16 }],
        ['/api/users/restore-backup', { uploadId: '0'.repeat(32), selection: { settings: true } }],
        ['/api/users/lan-migration/import', { url: 'http://127.0.0.1:8000/api/users/transfer/backup/' + 'a'.repeat(64), selection: { settings: true } }],
    ])('POST %s rejects non-string and unknown or traversal handles', async (route, extraBody) => {
        const badType = await request(app)
            .post(route)
            .send({ ...extraBody, handle: { bad: true } });
        expect(badType.status).toBe(400);

        const traversal = await request(app)
            .post(route)
            .send({ ...extraBody, handle: '../escape' });
        expect(traversal.status).toBe(404);
    });

    test('POST /lan-migration/offer and /restore-backup/uploads allow admins to target an existing user', async () => {
        const target = nextHandle('existing');
        await storage.setItem(toKey(target), {
            handle: target,
            name: 'Existing',
            created: 0,
            password: '',
            salt: '',
            admin: false,
            enabled: true,
        });

        const offerRes = await request(app)
            .post('/api/users/lan-migration/offer')
            .send({ handle: target, selection: { settings: true } });
        expect(offerRes.status).toBe(200);
        expect(offerRes.body.url).toContain('/api/users/transfer/backup/');

        const uploadRes = await request(app)
            .post('/api/users/restore-backup/uploads')
            .send({ handle: target, fileName: 'backup.zip', size: 16 });
        expect(uploadRes.status).toBe(200);
        expect(uploadRes.body.uploadId).toMatch(/^[0-9a-f]{32}$/);
    });
});
