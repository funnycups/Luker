import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import request from 'supertest';

import { startLanDevice } from '../_lib/lan-devices.js';
import { createSyncRouter } from '../../../src/endpoints/sync.js';
import { readRegistry, updateRegistry, upsertLanBackend } from '../../../src/sync/state.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { makeDevice, makeRemote } from '../_lib/devices.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { runSyncCycle, readUndoPoint } from '../../../src/sync/pipeline/cycle.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';

const PEER = 'u@0a1b2c3d';

describe('backend routes', () => {
    let A;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'Phone', categories: ['worlds'], peerAuth: { username: 'u', password: 'pw' }, syncSecret: 'a'.repeat(64) });
    });
    afterEach(() => A.close());

    test('routes require a logged-in user', async () => {
        const app = express();
        app.use('/api/sync/v1', createSyncRouter({ userStore: A.userStore }));
        for (const [method, route] of [['get', '/backends'], ['post', '/backends/x/sync'], ['post', '/schedule'], ['delete', '/backends/x']]) {
            expect((await request(app)[method](`/api/sync/v1${route}`)).status).toBe(401);
        }
    });

    test('GET /backends lists sanitized entries, the schedule and the running flags', async () => {
        const { status, body } = await A.call('GET', '/backends');
        expect(status).toBe(200);
        expect(body.backends[PEER]).toMatchObject({ kind: 'lan', label: 'Phone', categories: ['worlds'], lan: { peerId: PEER, hasStoredCredentials: true } });
        expect(JSON.stringify(body)).not.toContain('pw');
        expect(JSON.stringify(body)).not.toContain('a'.repeat(64));
        expect(body.schedule).toEqual({ idleSeconds: 60, pollSeconds: 300 });
        expect(body.running).toEqual({});
    });

    test('POST /backends/:id updates label and categories', async () => {
        expect((await A.call('POST', `/backends/${PEER}`, { body: { label: 'Tablet', categories: ['chats'] } })).status).toBe(200);
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER]).toMatchObject({ label: 'Tablet', categories: ['chats'] });
        expect((await A.call('POST', '/backends/u@ffffffff', { body: { label: 'x' } })).body).toMatchObject({ code: 'UNKNOWN_BACKEND' });
    });

    test('POST /backends/:id refuses categories that are not a list of ids', async () => {
        expect(await A.call('POST', `/backends/${PEER}`, { body: { categories: 'chats' } })).toMatchObject({ status: 400, body: { code: 'INVALID_CATEGORIES' } });
        expect((await A.call('POST', '/backends/u@ffffffff', { body: { label: 'x' } })).status).toBe(404);
    });

    test('DELETE /backends/:id removes the entry and the shadow directory', async () => {
        const { peerDir } = await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER });
        expect((await A.call('DELETE', `/backends/${PEER}`)).status).toBe(204);
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER]).toBeUndefined();
        expect(fs.existsSync(peerDir)).toBe(false);
        expect((await A.call('DELETE', '/backends/u@ffffffff')).status).toBe(204);
        expect((await A.call('DELETE', '/backends/bad*id')).status).toBe(400);
    });

    test('a legacy id that is not a ref component can only be removed', async () => {
        const legacy = '.foo@1234abcd';
        await updateRegistry({ userRoot: A.userRoot }, registry => {
            registry.backends[legacy] = { ...registry.backends[PEER], lan: { ...registry.backends[PEER].lan, peerId: legacy } };
        });
        expect(await A.call('POST', `/backends/${legacy}/sync`)).toMatchObject({ status: 400, body: { ok: false, code: 'INVALID_BACKEND_ID' } });
        expect(await A.call('POST', `/backends/${legacy}`, { body: { label: 'x' } })).toMatchObject({ status: 400, body: { code: 'INVALID_BACKEND_ID' } });
        expect(syncService.getRunning(A.userRoot)).toEqual({});
        expect((await A.call('DELETE', `/backends/${legacy}`)).status).toBe(204);
        expect((await readRegistry({ userRoot: A.userRoot })).backends[legacy]).toBeUndefined();
    });

    test('DELETE /backends/:id/auth clears stored credentials only', async () => {
        expect((await A.call('DELETE', `/backends/${PEER}/auth`)).body).toEqual({ ok: true });
        const { lan } = (await readRegistry({ userRoot: A.userRoot })).backends[PEER];
        expect(lan.peerAuth).toBeNull();
        expect(lan.syncSecret).toBe('a'.repeat(64));
        expect((await A.call('GET', '/backends')).body.backends[PEER].lan.hasStoredCredentials).toBe(false);
        expect(await A.call('DELETE', '/backends/u@ffffffff/auth')).toEqual({ status: 200, body: { ok: true } });
        expect((await A.call('DELETE', '/backends/bad*id/auth')).status).toBe(400);
    });

    test('POST /backends/:id/sync maps failures to statuses and codes', async () => {
        expect(await A.call('POST', `/backends/${PEER}/sync`)).toMatchObject({ status: 409, body: { ok: false, code: 'NO_BASE_URL' } });
        expect(await A.call('POST', '/backends/u@ffffffff/sync')).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND' } });
        expect(syncService.getRunning(A.userRoot)).not.toHaveProperty('u@ffffffff');
        await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'Phone', categories: ['worlds'], peerBaseUrl: 'http://127.0.0.1:9' });
        expect(await A.call('POST', `/backends/${PEER}/sync`)).toMatchObject({ status: 502, body: { ok: false, code: 'PEER_UNREACHABLE' } });
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lastSync.error).toMatchObject({ code: 'PEER_UNREACHABLE' });
    });

    test('a sync presents stored credentials and maps a refused login to 401', async () => {
        const seen = [];
        const stub = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/api/sync/v1/health') return res.end('{"ok":true,"protocol":2}');
            seen.push(req.headers.authorization ?? null);
            res.statusCode = 401;
            res.end('{"error":"no"}');
        });
        await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
        try {
            const peerBaseUrl = `http://127.0.0.1:${stub.address().port}`;
            await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'Phone', categories: ['worlds'], peerBaseUrl });
            expect(await A.call('POST', `/backends/${PEER}/sync`)).toMatchObject({ status: 401, body: { ok: false, code: 'PEER_AUTH_FAILED' } });
            await A.call('DELETE', `/backends/${PEER}/auth`);
            await A.call('POST', `/backends/${PEER}/sync`);
            expect(seen).toEqual([`Basic ${Buffer.from('u:pw').toString('base64')}`, null]);
        } finally {
            await new Promise(resolve => stub.close(resolve));
        }
    });

    test('POST /schedule saves valid values and rejects others', async () => {
        expect(await A.call('POST', '/schedule', { body: { idleSeconds: 5, pollSeconds: 30 } })).toEqual({ status: 200, body: { schedule: { idleSeconds: 5, pollSeconds: 30 } } });
        expect(await A.call('POST', '/schedule', { body: { idleSeconds: 0, pollSeconds: 30 } })).toMatchObject({ status: 400, body: { code: 'INVALID_SCHEDULE' } });
        expect((await A.call('GET', '/backends')).body.schedule).toEqual({ idleSeconds: 5, pollSeconds: 30 });
    });

    test.each([false, true])('counted undo preserves a local result when propagation is offline, skipped: %s', async skipped => {
        const remote = await makeRemote();
        const source = makeDevice({ remoteDir: remote.remoteDir, categories: ['worlds'] });
        const ctx = { ...A.owner, backendId: PEER, categories: ['worlds'], backend: new DirectoryBackend({ id: PEER, remoteDir: remote.remoteDir, userRoot: A.userRoot }) };
        try {
            source.write('worlds/d/x.json', 'before');
            await runSyncCycle(source.ctx); await runSyncCycle(ctx);
            if (skipped) source.remove('worlds/d/x.json');
            else source.write('worlds/d/x.json', 'after');
            await runSyncCycle(source.ctx); await runSyncCycle(ctx);
            if (skipped) A.write('worlds/d', 'obstruction');
            const gitdir = getShadowPaths({ userRoot: A.userRoot, peerId: PEER }).gitDir;
            const point = await readUndoPoint(gitdir);
            const response = await A.call('POST', `/backends/${PEER}/undo`);
            if (skipped) {
                expect(response).toMatchObject({ status: 409, body: { ok: false, committed: false, reverted: [], propagation: null, code: 'UNDO_NOT_COMMITTED' } });
                expect(await readUndoPoint(gitdir)).toEqual(point);
                expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lastSync.at).toBeNull();
            } else {
                expect(response).toMatchObject({ status: 409, body: { ok: false, committed: true, reverted: ['worlds/d/x.json'], propagation: { ok: false, code: 'NO_BASE_URL' } } });
                expect(A.read('worlds/d/x.json')).toBe('before');
                expect(await readUndoPoint(gitdir)).toBeNull();
            }
        } finally { source.cleanup(); remote.cleanup(); }
    });

    test('GET /categories and GET /availability describe what can sync', async () => {
        const { body } = await A.call('GET', '/categories');
        expect(body.categories.length).toBeGreaterThan(0);
        for (const category of body.categories) {
            expect(category).toMatchObject({ id: expect.any(String), displayKey: expect.any(String), descriptionKey: expect.any(String) });
            expect(category.paths).toBeUndefined();
        }
        expect((await A.call('GET', '/availability')).body).toEqual({ available: true });
    });
});
