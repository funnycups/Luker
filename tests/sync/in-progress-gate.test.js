/**
 * Unit tests for the sync write gate: a per-user-root reader/writer lock,
 * the waiting middleware and the dirty listener.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import {
    acquireReader,
    acquireWriter,
    withWriterLock,
    runGatedWrite,
    getGateState,
    setDirtyListener,
    isGatedPath,
    syncWriteGateMiddleware,
    GATED_ROUTES,
    matchGatedRoute,
    _resetGateForTests,
} from '../../src/sync/in-progress-gate.js';
import { SYNC_CATEGORIES } from '../../src/sync/categories.js';

const ROOT = '/tmp/luker-gate-alice';
const OTHER_ROOT = '/tmp/luker-gate-bob';
const IDLE = { readers: 0, writerHeld: false, waitingReaders: 0, waitingWriters: 0 };

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    while (!predicate()) await tick();
}
function track(promise) {
    const tracked = { done: false, value: undefined };
    tracked.promise = promise.then((value) => {
        tracked.done = true;
        tracked.value = value;
        return value;
    });
    return tracked;
}

beforeEach(() => {
    _resetGateForTests();
});

describe('opt-in dirty notification trace', () => {
    test('records actual streamed and ungated request notifications and background writes', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-dirty-trace-'));
        const file = path.join(dir, 'dirty.jsonl');
        const previous = process.env.LUKER_TEST_DIRTY_TRACE;
        process.env.LUKER_TEST_DIRTY_TRACE = file;
        const listener = jest.fn();
        setDirtyListener(listener);
        try {
            const app = express();
            app.use((req, res, next) => {
                req.user = { directories: { root: ROOT }, profile: { handle: 'alice' } };
                next();
            });
            app.use(syncWriteGateMiddleware());
            app.post('/api/themes/save', (req, res) => {
                res.write('started');
                setImmediate(() => res.end('finished'));
            });
            app.post('/api/extensions/install', async (req, res) => {
                await tick();
                await runGatedWrite({ userRoot: ROOT, handle: 'alice' }, async () => {});
                res.sendStatus(200);
            });
            app.post('/api/themes/delete', (req, res) => res.sendStatus(400));
            app.post('/api/secrets/read', (req, res) => res.sendStatus(200));
            await request(app).post('/api/themes/save?ignored=yes').expect(200);
            await request(app).post('/api/extensions/install').expect(200);
            await request(app).post('/api/themes/delete').expect(400);
            await request(app).post('/api/secrets/read').expect(200);
            await runGatedWrite({ userRoot: ROOT }, async () => {});
            expect(fs.existsSync(file)).toBe(true);
            const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
            expect(events.map(({ method, path: route }) => ({ method, path: route }))).toEqual([
                { method: 'POST', path: '/api/themes/save' },
                { method: 'POST', path: '/api/extensions/install' },
                { method: null, path: null },
            ]);
            expect(events.every(event => event.userRoot === ROOT && Number.isFinite(event.at))).toBe(true);
            expect(listener).toHaveBeenCalledTimes(3);
            expect(getGateState(ROOT)).toEqual(IDLE);
        } finally {
            if (previous === undefined) delete process.env.LUKER_TEST_DIRTY_TRACE;
            else process.env.LUKER_TEST_DIRTY_TRACE = previous;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('does not trace successful read-only writes or disabled notifications', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-dirty-trace-'));
        const file = path.join(dir, 'dirty.jsonl');
        const previous = process.env.LUKER_TEST_DIRTY_TRACE;
        try {
            process.env.LUKER_TEST_DIRTY_TRACE = file;
            await runGatedWrite({ userRoot: ROOT }, async () => {}, { dirty: false });
            expect(fs.existsSync(file)).toBe(false);
            delete process.env.LUKER_TEST_DIRTY_TRACE;
            setDirtyListener(jest.fn());
            await runGatedWrite({ userRoot: ROOT }, async () => {});
            expect(fs.existsSync(file)).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.LUKER_TEST_DIRTY_TRACE;
            else process.env.LUKER_TEST_DIRTY_TRACE = previous;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('reader/writer lock', () => {
    test('writer waits for in-flight readers to drain', async () => {
        const r1 = await acquireReader(ROOT);
        const r2 = await acquireReader(ROOT);
        const writer = track(acquireWriter(ROOT));
        await tick();
        expect(writer.done).toBe(false);
        expect(getGateState(ROOT)).toEqual({ readers: 2, writerHeld: false, waitingReaders: 0, waitingWriters: 1 });
        r1();
        await tick();
        expect(writer.done).toBe(false);
        r2();
        await writer.promise;
        expect(getGateState(ROOT)).toEqual({ readers: 0, writerHeld: true, waitingReaders: 0, waitingWriters: 0 });
        writer.value();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('readers arriving while a writer holds the gate wait instead of failing', async () => {
        const release = await acquireWriter(ROOT);
        const reader = track(acquireReader(ROOT));
        await tick();
        expect(reader.done).toBe(false);
        expect(getGateState(ROOT).waitingReaders).toBe(1);
        release();
        const readerRelease = await reader.promise;
        expect(getGateState(ROOT).readers).toBe(1);
        readerRelease();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('a pending writer blocks new readers so writers are not starved', async () => {
        const r1 = await acquireReader(ROOT);
        const writer = track(acquireWriter(ROOT));
        const r2 = track(acquireReader(ROOT));
        await tick();
        expect(r2.done).toBe(false);
        r1();
        await writer.promise;
        await tick();
        expect(r2.done).toBe(false);
        writer.value();
        await r2.promise;
        r2.value();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('readers queued behind a writer run before the next queued writer', async () => {
        const w1 = await acquireWriter(ROOT);
        const reader = track(acquireReader(ROOT));
        const w2 = track(acquireWriter(ROOT));
        await tick();
        w1();
        await reader.promise;
        await tick();
        expect(w2.done).toBe(false);
        reader.value();
        await w2.promise;
        w2.value();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('writers of the same user serialize', async () => {
        const w1 = await acquireWriter(ROOT);
        const w2 = track(acquireWriter(ROOT));
        await tick();
        expect(w2.done).toBe(false);
        w1();
        await w2.promise;
        w2.value();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('different users are independent', async () => {
        const release = await acquireWriter(ROOT);
        const other = await acquireReader(OTHER_ROOT);
        expect(getGateState(OTHER_ROOT).readers).toBe(1);
        other();
        release();
    });

    test('release functions are idempotent', async () => {
        const release = await acquireReader(ROOT);
        release();
        release();
        expect(getGateState(ROOT)).toEqual(IDLE);
        const writer = await acquireWriter(ROOT);
        writer();
    });

    test('withWriterLock releases after the callback throws', async () => {
        await expect(withWriterLock(ROOT, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('withWriterLock refuses to nest for the same user', async () => {
        await expect(withWriterLock(ROOT, () => withWriterLock(ROOT, async () => {}))).rejects.toThrow(/already holds/);
        expect(getGateState(ROOT)).toEqual(IDLE);
    });
});

describe('runGatedWrite', () => {
    test('waits for a held writer then runs and marks dirty', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        const release = await acquireWriter(ROOT);
        const write = track(runGatedWrite({ userRoot: ROOT, handle: 'alice' }, async () => 'written'));
        await tick();
        expect(write.done).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        release();
        await expect(write.promise).resolves.toBe('written');
        expect(probe).toHaveBeenCalledWith({ handle: 'alice', userRoot: ROOT });
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('does not mark dirty when the write throws', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        await expect(runGatedWrite({ userRoot: ROOT }, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
        expect(probe).not.toHaveBeenCalled();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('dirty: false never notifies', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        await runGatedWrite({ userRoot: ROOT }, async () => {}, { dirty: false });
        expect(probe).not.toHaveBeenCalled();
    });

    test('nested inside a held reader slot it runs without taking a second slot', async () => {
        let writer;
        const outer = runGatedWrite({ userRoot: ROOT, handle: 'alice' }, async () => {
            writer = track(acquireWriter(ROOT));
            await until(() => getGateState(ROOT).waitingWriters === 1);
            return runGatedWrite({ userRoot: ROOT, handle: 'alice' }, async () => 'inner');
        });
        await expect(outer).resolves.toBe('inner');
        await writer.promise;
        writer.value();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('nested inside a dirty: false slot it still marks dirty after its own write succeeds', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        await runGatedWrite({ userRoot: ROOT }, async () => {
            await runGatedWrite({ userRoot: ROOT, handle: 'alice' }, async () => {
                expect(probe).not.toHaveBeenCalled();
            });
            expect(probe).toHaveBeenCalledWith({ handle: 'alice', userRoot: ROOT });
            await runGatedWrite({ userRoot: ROOT }, async () => {}, { dirty: false });
            await expect(runGatedWrite({ userRoot: ROOT }, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
        }, { dirty: false });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('nested inside the writer side it runs inline and never marks dirty', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        await expect(withWriterLock(ROOT, () => runGatedWrite({ userRoot: ROOT }, async () => 'inner'))).resolves.toBe('inner');
        expect(probe).not.toHaveBeenCalled();
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('a background task started inside a released slot takes a fresh slot', async () => {
        let background;
        await runGatedWrite({ userRoot: ROOT }, async () => {
            background = new Promise(resolve => setImmediate(resolve)).then(async () => {
                await until(() => getGateState(ROOT).writerHeld);
                return runGatedWrite({ userRoot: ROOT }, async () => 'late');
            });
        });
        const release = await acquireWriter(ROOT);
        const late = track(background);
        await until(() => getGateState(ROOT).waitingReaders === 1);
        expect(late.done).toBe(false);
        release();
        await expect(late.promise).resolves.toBe('late');
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('a throwing dirty listener does not break the caller', async () => {
        setDirtyListener(() => { throw new Error('listener bug'); });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(runGatedWrite({ userRoot: ROOT }, async () => 'ok')).resolves.toBe('ok');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('setDirtyListener rejects non-functions', () => {
        expect(() => setDirtyListener('nope')).toThrow(TypeError);
        expect(() => setDirtyListener(null)).not.toThrow();
    });
});

describe('isGatedPath', () => {
    test('matches the explicit examples', () => {
        expect(isGatedPath('/api/chats/save')).toBe(true);
        expect(isGatedPath('/api/settings/save')).toBe(true);
    });

    test('matches expanded write paths under the same routers', () => {
        const gated = [
            '/api/chats/append', '/api/chats/patch', '/api/chats/rename', '/api/chats/delete',
            '/api/chats/meta', '/api/chats/meta/patch', '/api/chats/group/save', '/api/chats/group/append',
            '/api/settings/patch', '/api/settings/make-snapshot', '/api/presets/save', '/api/presets/delete',
            '/api/themes/save', '/api/themes/delete', '/api/quick-replies/save', '/api/moving-ui/save',
            '/api/worldinfo/edit', '/api/worldinfo/import', '/api/characters/edit', '/api/characters/create',
            '/api/characters/delete', '/api/users/me/settings/save',
        ];
        for (const p of gated) expect(isGatedPath(p)).toBe(true);
    });

    test('does NOT match read-only paths', () => {
        const allowed = [
            '/api/chats/get', '/api/chats/recent', '/api/chats/search', '/api/chats/export',
            '/api/chats/state/get', '/api/chats/state/get-batch', '/api/settings/get', '/api/settings/bootstrap',
            '/api/settings/get-snapshots', '/api/presets/state/get', '/api/presets/state/get-batch',
            '/api/worldinfo/get', '/api/worldinfo/list', '/api/characters/all', '/api/characters/get', '/api/characters/chats',
        ];
        for (const p of allowed) expect(isGatedPath(p)).toBe(false);
    });

    test('does NOT match the sync protocol itself', () => {
        expect(isGatedPath('/api/sync/v1/health')).toBe(false);
        expect(isGatedPath('/api/sync/v1/pull')).toBe(false);
        expect(isGatedPath('/api/sync/v1/session/manifest')).toBe(false);
        expect(isGatedPath('/api/sync/v1/session/object')).toBe(false);
    });

    test('accepts one trailing slash on gated paths only', () => {
        expect(isGatedPath('/api/chats/save/')).toBe(true);
        expect(isGatedPath('/api/settings/patch/')).toBe(true);
        expect(isGatedPath('/api/chats/save//')).toBe(false);
        expect(isGatedPath('/api/chats/get/')).toBe(false);
    });

    test('handles bad input without throwing', () => {
        expect(isGatedPath('')).toBe(false);
        expect(isGatedPath(null)).toBe(false);
        expect(isGatedPath(undefined)).toBe(false);
        expect(isGatedPath(42)).toBe(false);
    });
});

describe('syncWriteGateMiddleware', () => {
    function buildApp({ root = ROOT, handle = 'alice', routes = () => {} } = {}) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle, admin: true }, directories: { root } };
            next();
        });
        app.use(syncWriteGateMiddleware());
        routes(app);
        app.post('/api/chats/save', (_req, res) => res.json({ ok: true }));
        app.post('/api/settings/save', (_req, res) => res.json({ ok: true }));
        app.post('/api/worldinfo/edit', (_req, res) => res.status(400).send('World file must have a name'));
        app.post('/api/chats/get', (_req, res) => res.json({ ok: true }));
        app.get('/api/chats/save', (_req, res) => res.json({ ok: true }));
        app.post('/api/sync/v1/pull', (_req, res) => res.json({ ok: true }));
        return app;
    }

    function listen(app) {
        const sockets = { closed: 0 };
        return new Promise((resolve) => {
            const server = http.createServer(app);
            server.on('connection', socket => socket.on('close', () => { sockets.closed += 1; }));
            server.listen(0, '127.0.0.1', () => resolve({
                port: server.address().port,
                sockets,
                close: () => new Promise(done => server.close(done)),
            }));
        });
    }

    function rawPost(port, urlPath) {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json' } });
        req.on('error', () => {});
        req.end('{}');
        return req;
    }

    test('lets writes through when no sync is running', async () => {
        const res = await request(buildApp()).post('/api/chats/save').send({});
        expect(res.status).toBe(200);
    });

    test('a write that arrives while the writer is held waits and then succeeds', async () => {
        const app = buildApp();
        const release = await acquireWriter(ROOT);
        const response = track(request(app).post('/api/chats/save').send({}).then(r => r));
        await until(() => getGateState(ROOT).waitingReaders === 1);
        expect(response.done).toBe(false);
        release();
        const res = await response.promise;
        expect(res.status).toBe(200);
        expect(res.headers['retry-after']).toBeUndefined();
        await until(() => getGateState(ROOT).readers === 0);
        expect(getGateState(ROOT)).toEqual(IDLE);
    });

    test('the writer waits until an in-flight gated request responds', async () => {
        let enter;
        const entered = new Promise(resolve => { enter = resolve; });
        let finish;
        const latch = new Promise(resolve => { finish = resolve; });
        const app = buildApp({ routes: a => a.post('/api/chats/append', async (_req, res) => { enter(); await latch; res.json({ ok: true }); }) });
        const response = request(app).post('/api/chats/append').send({}).then(r => r);
        await entered;
        const writer = track(acquireWriter(ROOT));
        await tick();
        expect(writer.done).toBe(false);
        finish();
        expect((await response).status).toBe(200);
        await writer.promise;
        writer.value();
    });

    test('does NOT gate read endpoints, GET requests or the sync protocol while a writer holds', async () => {
        const app = buildApp();
        const release = await acquireWriter(ROOT);
        expect((await request(app).post('/api/chats/get').send({})).status).toBe(200);
        expect((await request(app).get('/api/chats/save')).status).toBe(200);
        expect((await request(app).post('/api/sync/v1/pull').send({})).status).toBe(200);
        release();
    });

    test('another user can write while one user is held', async () => {
        const release = await acquireWriter(ROOT);
        const res = await request(buildApp({ root: OTHER_ROOT, handle: 'bob' })).post('/api/chats/save').send({});
        expect(res.status).toBe(200);
        release();
    });

    test('lets writes through when the request has no authenticated user', async () => {
        const app = express();
        app.use(express.json());
        app.use(syncWriteGateMiddleware());
        app.post('/api/chats/save', (_req, res) => res.json({ ok: true }));
        const release = await acquireWriter(ROOT);
        expect((await request(app).post('/api/chats/save').send({})).status).toBe(200);
        release();
    });

    test('2xx marks dirty with handle and user root and 4xx does not', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        const app = buildApp();
        await request(app).post('/api/chats/save').send({}).expect(200);
        await until(() => probe.mock.calls.length === 1);
        expect(probe).toHaveBeenCalledWith({ handle: 'alice', userRoot: ROOT });
        await request(app).post('/api/worldinfo/edit').send({}).expect(400);
        await until(() => getGateState(ROOT).readers === 0);
        await tick();
        expect(probe).toHaveBeenCalledTimes(1);
    });

    test('a response closed by the client before finishing releases its slot', async () => {
        let enter;
        const entered = new Promise(resolve => { enter = resolve; });
        let finish;
        const latch = new Promise(resolve => { finish = resolve; });
        const probe = jest.fn();
        setDirtyListener(probe);
        const app = buildApp({ routes: a => a.post('/api/chats/patch', async (_req, res) => { enter(); await latch; res.json({ ok: true }); }) });
        const server = await listen(app);
        const req = rawPost(server.port, '/api/chats/patch');
        await entered;
        expect(getGateState(ROOT).readers).toBe(1);
        req.destroy();
        await until(() => getGateState(ROOT).readers === 0);
        const writer = await acquireWriter(ROOT);
        writer();
        finish();
        await server.close();
        expect(probe).not.toHaveBeenCalled();
    });

    test('a request abandoned while waiting never reaches the handler and holds no slot', async () => {
        const handlerCalls = jest.fn();
        const app = buildApp({ routes: a => a.post('/api/chats/rename', (_req, res) => { handlerCalls(); res.json({ ok: true }); }) });
        const server = await listen(app);
        const release = await acquireWriter(ROOT);
        const req = rawPost(server.port, '/api/chats/rename');
        await until(() => getGateState(ROOT).waitingReaders === 1);
        req.destroy();
        await until(() => server.sockets.closed === 1);
        await tick();
        release();
        await until(() => getGateState(ROOT).readers === 0 && getGateState(ROOT).waitingReaders === 0);
        await tick();
        expect(handlerCalls).not.toHaveBeenCalled();
        expect(getGateState(ROOT)).toEqual(IDLE);
        await server.close();
    });
});

describe('gate coverage', () => {
    const read = rel => fs.readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

    test('every sync category has at least one dirty route of its own', () => {
        const covered = new Set(GATED_ROUTES.filter(r => r.dirty && !r.wholesale).flatMap(r => r.categories));
        expect(SYNC_CATEGORIES.map(c => c.id).filter(id => !covered.has(id))).toEqual([]);
    });

    test('wholesale routes are the only ones tagged with every category', () => {
        const all = SYNC_CATEGORIES.length;
        for (const r of GATED_ROUTES) expect(r.categories.length === all).toBe(r.wholesale);
    });

    test.each([
        ['/api/groups/create', true], ['/api/groups/edit', true], ['/api/groups/delete', true],
        ['/api/chats/merge', true], ['/api/chats/group/split', true],
        ['/api/card-app/char-1/index.html', true], ['/api/card-app/char-1/rename', true],
        ['/api/skills/global/my-skill/file/write', true], ['/api/skills/global', true], ['/api/skills/import-bundled', true],
        ['/api/skills/pack-for-embed', false], ['/api/skills/extract-embed/preview', false],
        ['/api/images/upload', true], ['/api/images/delete', true],
        ['/api/sprites/upload', true], ['/api/sprites/upload-zip', true], ['/api/sprites/delete', true],
        ['/api/image-metadata/folders/create', true], ['/api/image-metadata/cleanup', true],
        ['/api/image-metadata', false], ['/api/image-metadata/', false], ['/api/image-metadata/all', false], ['/api/image-metadata/folders/get', false],
        ['/api/backgrounds/all', false], ['/api/backgrounds/upload', true],
        ['/api/vector/delete', true], ['/api/vector/purge', true], ['/api/vector/purge-all', true],
        ['/api/secrets/write', true], ['/api/secrets/rotate', true], ['/api/secrets/read', false], ['/api/secrets/find', false],
        ['/api/extensions/switch', true], ['/api/extensions/move', true], ['/api/extensions/delete', true],
        ['/api/stats/recreate', true],
        ['/api/sd/comfy/save-workflow', true], ['/api/sd/comfy/rename-workflow', true],
        ['/api/assets/get', false], ['/api/assets/delete', true],
        ['/api/media/delete', true], ['/api/data-maid/delete', true],
        ['/api/users/restore-backup', true], ['/api/users/restore-backup/uploads/abc123/finalize', true],
        ['/api/users/import/data-zip', true], ['/api/users/reset-settings', true],
        ['/api/groups/create/', true], ['/api/vector/delete/', true],
    ])('%s is gated with dirty=%s', (requestPath, dirty) => {
        expect(matchGatedRoute(requestPath)).toEqual(expect.objectContaining({ dirty }));
    });

    test.each([
        '/api/extensions/branches', '/api/extensions/version', '/api/extensions/install', '/api/extensions/update',
        '/api/vector/insert', '/api/vector/query', '/api/vector/query-by-vector', '/api/vector/query-multi', '/api/vector/list', '/api/vector/rerank',
        '/api/assets/download', '/api/content/importURL', '/api/content/importUUID', '/api/skills/import-from-url', '/api/skills/import-from-url/',
        '/api/stats/update', '/api/stats/get', '/api/images/list', '/api/images/folders', '/api/backgrounds/folders',
        '/api/sd/comfy/workflows', '/api/image-metadata-other',
    ])('%s is not gated by the middleware', (requestPath) => {
        expect(matchGatedRoute(requestPath)).toBeNull();
    });

    test('non-request and network-bound writers wrap only their disk writes in runGatedWrite', () => {
        const stats = read('endpoints/stats.js');
        expect(stats).toMatch(/runGatedWrite\(\{\s*handle,\s*userRoot\s*\},\s*async \(\) => \{\s*if \(!hasUnsavedStats\(handle\)\) return;\s*const stats = STATS\.get\(handle\);\s*await getStatsRepo\(\)\.save\(handle,\s*stats\);/);
        expect(stats).toMatch(/flushStatsForHandle\(\{\s*handle,\s*userRoot:\s*getUserDirectories\(handle\)\.root\s*\}\)/);
        expect(read('server-startup.js')).toMatch(/runGatedWrite\(\s*\{\s*handle,\s*userRoot\s*\},\s*\(\)\s*=>\s*ensureFreshInstallPopulate\(/);
        const vectors = read('endpoints/vectors.js');
        expect(vectors).toMatch(/runGatedWrite\(\{\s*userRoot:\s*directories\.root\s*\},\s*\(\)\s*=>\s*store\.createIndex\(\),\s*\{\s*dirty:\s*false\s*\}\)/);
        expect(vectors).toMatch(/const vectors = await getBatchVector\([^;]*\);\s*await runGatedWrite\(/);
        const extensions = read('endpoints/extensions.js');
        expect(extensions.match(/swapDirectoryInto\(/g)).toHaveLength(2);
        expect(extensions).toMatch(/await git\.clone\(url, clonePath, cloneOptions\)/);
        expect(read('endpoints/assets.js')).toMatch(/runGatedWrite\(syncOwner,\s*async \(\) => \{\s*fs\.copyFileSync\(tempPath, file_path\);/);
        expect(read('endpoints/skills.js')).toMatch(/runGatedWrite\(owner,\s*\(\) => repo\.install\(args\)\)/);
    });
});
