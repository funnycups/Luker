/* eslint jest/no-conditional-expect: off -- Transport, native engine and rejection cases retain their complete distinct contracts. */
/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "nativeWorkLifetime"] }] */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as checkpoint } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { ENDPOINT_HARNESSES, makeEndpointHarness } from './endpoint-harness.js';
import { getSettingsRepo, getStorageEngine } from '../../../src/storage/index.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { ConflictError } from '../../../src/storage/errors.js';
import { seed, capture, expectMoved, nativeSelected, groupOptions } from './group-rename-fixtures.js';

function recordLifecycle(label, value) {
    if (process.env.LUKER_RENAME_PAYLOAD_EVIDENCE) fs.appendFileSync(process.env.LUKER_RENAME_PAYLOAD_EVIDENCE, JSON.stringify({ test: expect.getState().currentTestName, label, execArgv: process.execArgv, ...value }) + '\n');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function nativeWorkLifetime({ mode, action, transport, outcome = 'success', cleanupFailure = false }) {
    const release = deferred(), started = deferred(), finished = deferred(), closed = deferred();
    const originalError = new Error('owned returned handler rejection');
    const router = express.Router(), nested = express.Router();
    let h, repo, nativeEngine, transaction, work, lifecycle, client, response, before, admitted, moved, selectedAfter, rejectedSource, rejectedNative, handlerResult, settled = false;
    const failures = [];
    const key = name => ({ kind: 'chat', handle: h.handle, charDir: '', name, ...groupOptions(name) });
    nested.param('token', (req, _res, next, value) => Promise.resolve().then(() => { req.params.token = value; next(); }));
    // A returned promise, not a response event, owns the complete native move.
    nested.get('/:token', (req, res) => {
        work = (async () => {
            await nativeEngine.withTransaction(h.handle, async tx => {
                transaction = tx;
                const snapshot = await tx.captureChatMove(key('old'));
                res.once('close', closed.resolve);
                started.resolve({ token: req.params.token, snapshot: Object.keys(snapshot) });
                if (transport === 'finished') res.json({ admitted: true });
                await release.promise;
                if (outcome === 'handler-reject') throw originalError;
                if (outcome === 'storage-reject') await tx.putChatState(key('old'), 'memory_graph', { replacement: true }, { ifAbsent: true });
                const publication = await tx.publishChatMove(key('new'), snapshot);
                if (!publication.updated) throw new ConflictError('rename_target_exists', key('new'));
                await tx.deleteChatMoveSource(snapshot);
            });
            moved = await capture(repo, h, 'new');
            selectedAfter = await nativeSelected(h, 'new');
            if (transport === 'connected') res.json({ moved: true });
        })();
        // Observe rejection immediately even when the unchanged fixture ignores it.
        work.then(() => { handlerResult = { ok: true }; finished.resolve(); }, error => { handlerResult = { error }; finished.resolve(); });
        return work;
    });
    router.use('/native', nested);
    const originalLayer = nested.stack[0], originalHandler = originalLayer.route.stack[0].handle;
    const errorChain = [];
    try {
        h = await makeEndpointHarness({ mode, mount(app) {
            app.use('/move', router);
            app.use(async (error, _req, res, _next) => {
                await checkpoint(); errorChain.push(error);
                rejectedSource = await capture(repo, h, 'old');
                rejectedNative = await nativeSelected(h, 'old');
                if (!res.destroyed) res.status(500).end();
            });
        } });
        nativeEngine = h.engine;
        repo = new ChatRepo({ engine: nativeEngine });
        before = await seed(repo, h); admitted = await nativeSelected(h, 'old');
        const server = h.server, address = server.address(), token = randomUUID();
        response = new Promise(resolve => {
            client = http.get({ host: address.address, port: address.port, path: `/move/native/${token}`, agent: false }, res => {
                let body = '';
                res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
                res.once('end', () => resolve({ status: res.statusCode, body }));
                res.once('error', error => resolve({ error }));
            });
            client.once('error', error => resolve({ error }));
        });
        expect(await started.promise).toEqual({ token, snapshot: [] });
        if (transport === 'disconnected') client.destroy();
        if (transport !== 'connected') await closed.promise;
        if (cleanupFailure) fs.chmodSync(h.dataRoot, 0o500);
        const operation = action === 'reopen' ? h.reopenEngine() : h.cleanup();
        lifecycle = operation.then(() => { settled = true; return { ok: true }; }, error => { settled = true; return { error }; });
        // Yield without a timer, abort deadline or event-only completion assumption.
        await checkpoint();
        const pending = { settled, rootPresent: fs.existsSync(h.dataRoot), sameEngine: h.engine === nativeEngine, sqliteOpen: transaction._db?.open, mysqlClosed: nativeEngine._pool?.pool?._closed, postgresEnding: nativeEngine._pool?.ending };
        release.resolve();
        await finished.promise;
        const result = await lifecycle, peer = await response;
        if (action === 'reopen' && outcome === 'success' && !result.error && !handlerResult.error) {
            expect(h.engine).not.toBe(nativeEngine);
            expect(h.server).toBe(server); expect(h.server.address()).toEqual(address);
            expectMoved(await capture(new ChatRepo({ engine: h.engine }), h, 'new'), before, mode);
            expect(await nativeSelected(h, 'new')).toEqual(admitted);
        }
        const cleanupJob = h.cleanup();
        expect(h.cleanup()).toBe(cleanupJob);
        const cleanup = await cleanupJob.then(() => ({ ok: true }), error => ({ error }));
        const repeated = await h.cleanup().then(() => ({ ok: true }), error => ({ error }));
        recordLifecycle('admitted native work settlement', {
            mode, action, transport, outcome, cleanupFailure, address, pending, admitted, selectedAfter, rejectedNative,
            handlerError: handlerResult.error && { name: handlerResult.error.name, code: handlerResult.error.code, message: handlerResult.error.message },
            lifecycleError: result.error && { name: result.error.name, code: result.error.code, message: result.error.message },
            cleanupErrors: cleanup.error && (cleanup.error instanceof AggregateError ? cleanup.error.errors : [cleanup.error]).map(error => ({ name: error.name, code: error.code, message: error.message })),
            peerError: peer.error && { name: peer.error.name, code: peer.error.code },
            sameCleanupError: repeated.error === cleanup.error, sharedRouterUnchanged: nested.stack[0] === originalLayer && originalLayer.route.stack[0].handle === originalHandler,
        });
        expect(pending.settled).toBe(false);
        expect(pending.rootPresent).toBe(true);
        expect(pending.sameEngine).toBe(true);
        expect(pending.sqliteOpen).not.toBe(false);
        expect(pending.mysqlClosed).not.toBe(true);
        expect(pending.postgresEnding).not.toBe(true);
        expect(nested.stack[0]).toBe(originalLayer); expect(originalLayer.route.stack[0].handle).toBe(originalHandler);
        if (transport === 'disconnected') expect(peer.error?.code).toBe('ECONNRESET');
        else expect(peer.status).toBe(200);
        if (outcome === 'success') {
            expect(handlerResult).toEqual({ ok: true }); expect(result).toEqual({ ok: true }); expect(cleanup).toEqual({ ok: true });
            expectMoved(moved, before, mode); expect(selectedAfter).toEqual(admitted);
            expect(errorChain).toEqual([]);
        } else {
            expect(handlerResult.error).toBeInstanceOf(outcome === 'storage-reject' ? ConflictError : Error);
            if (outcome === 'handler-reject') expect(handlerResult.error).toBe(originalError);
            expect(errorChain).toEqual([handlerResult.error]);
            expectMoved(rejectedSource, before, mode); expect(rejectedNative).toEqual(admitted);
            const errors = cleanup.error instanceof AggregateError ? cleanup.error.errors : [cleanup.error];
            expect(errors).toContain(handlerResult.error);
            if (cleanupFailure) {
                expect(cleanup.error).toBeInstanceOf(AggregateError);
                expect(errors).toHaveLength(2);
                expect(['EACCES', 'EPERM', 'ENOTEMPTY']).toContain(errors.find(error => error !== handlerResult.error).code);
            } else {
                expect(result.error).toBe(handlerResult.error); expect(cleanup.error).toBe(handlerResult.error);
            }
        }
        expect(repeated.error).toBe(cleanup.error);
        expect(h.server).toBe(server); expect(server.listening).toBe(false);
        if (!cleanupFailure) expect(fs.existsSync(h.dataRoot)).toBe(false);
    } catch (error) { failures.push(error); }
    release.resolve();
    if (work) await finished.promise;
    if (client && !client.destroyed) client.destroy();
    if (response) await response;
    if (lifecycle) await lifecycle;
    if (h) {
        const cleanup = await h.cleanup().then(() => null, error => error);
        if (cleanup && (outcome === 'success' || (cleanup !== handlerResult?.error && !cleanupFailure))) failures.push(cleanup);
        if (cleanupFailure && fs.existsSync(h.dataRoot)) {
            try { fs.chmodSync(h.dataRoot, 0o700); fs.rmSync(h.dataRoot, { recursive: true }); }
            catch (error) { failures.push(error); }
        }
    }
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw unique[0];
    if (unique.length > 1) throw new AggregateError(unique, 'Native work control and cleanup failed');
}

describe.each(ENDPOINT_HARNESSES)('admitted native work on $name', ({ mode }) => {
    describe.each(['reopen', 'cleanup'])('%s', action => {
        test.each(['disconnected', 'finished', 'connected'])('%s transport retains captured work until explicit release', async transport => {
            await nativeWorkLifetime({ mode, action, transport });
        });
        test.each(['handler-reject', 'storage-reject'])('disconnected %s remains visible after admitted work settles', async outcome => {
            await nativeWorkLifetime({ mode, action, transport: 'disconnected', outcome });
        });
    });
});

test('disconnected original work rejection and native cleanup failure retain repeated-cleanup identity', async () => {
    await nativeWorkLifetime({ mode: 'fs', action: 'cleanup', transport: 'disconnected', outcome: 'handler-reject', cleanupFailure: true });
});

describe.each(ENDPOINT_HARNESSES)('owned endpoint listener on $name', ({ mode }) => {
    let h;
    afterEach(async () => { if (h) await h.cleanup(); h = undefined; });

    test('mounted app and repeated agent requests use one explicitly bound IPv4 listener across reopen', async () => {
        let mounted;
        const completed = [];
        h = await makeEndpointHarness({ mode, mount(app) {
            mounted = app;
            app.get('/identity/:token', async (req, res) => {
                const settings = await getSettingsRepo().get(req.user.profile.handle);
                const identity = { token: req.params.token, address: req.socket.localAddress, port: req.socket.localPort, settings };
                res.once('finish', () => completed.push(identity));
                res.json(identity);
            });
        } });
        expect(h.app).toBe(mounted);
        expect(h.server?.listening).toBe(true);
        const address = h.server.address();
        expect(address).toEqual({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) });
        expect(address.port).toBeGreaterThan(0);
        await getSettingsRepo().save(h.handle, { retained: ['渡口', null, false] });
        const agent = request.agent(h.server);
        for (const target of [request(h.server), agent]) {
            const token = randomUUID();
            const response = await target.get(`/identity/${token}`).expect(200);
            expect(response.body).toEqual({ token, address: address.address, port: address.port, settings: { retained: ['渡口', null, false] } });
            expect(completed).toContainEqual(response.body);
            expect(response.request.url).toBe(`http://127.0.0.1:${address.port}/identity/${token}`);
            recordLifecycle('owned client and server identity', { mode, address, url: response.request.url, response: response.body, completed: [...completed] });
        }
        const server = h.server;
        await h.reopenEngine();
        expect(h.server).toBe(server);
        expect(h.server.address()).toEqual(address);
        const token = randomUUID();
        expect((await agent.get(`/identity/${token}`).expect(200)).body.settings).toEqual({ retained: ['渡口', null, false] });
        const root = h.dataRoot;
        await h.cleanup(); await h.cleanup();
        expect(server.listening).toBe(false); expect(server.address()).toBeNull();
        expect(fs.existsSync(root)).toBe(false);
    });

    test('mount failure settles acquired engine and data without replacing the original failure', async () => {
        const original = new Error('owned mount failed');
        let root;
        await expect(makeEndpointHarness({ mode, mount(_app, { dirs }) {
            root = path.dirname(dirs.root);
            const engine = getStorageEngine();
            recordLifecycle('mount failure acquired resources', { mode, root, database: engine._pool?.pool?.config?.connectionConfig?.database, schemaUrl: engine._pool?.options?.connectionString });
            throw original;
        } })).rejects.toBe(original);
        expect(fs.existsSync(root)).toBe(false);
    });

    test('request failure remains visible and repeated cleanup settles the owned listener', async () => {
        h = await makeEndpointHarness({ mode, mount(app) { app.get('/failure', (_req, res) => res.status(503).json({ error: 'owned request failure' })); } });
        expect(h.server?.listening).toBe(true);
        const failure = await request(h.server).get('/failure').expect(200).then(() => null, error => error);
        expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain('503');
        await h.cleanup(); await h.cleanup();
        expect(h.server.listening).toBe(false); expect(fs.existsSync(h.dataRoot)).toBe(false);
    });

    test('engine reopen drains an admitted request while retaining the same listener', async () => {
        let release, entered;
        let queuedEntered = false;
        const blocked = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        h = await makeEndpointHarness({ mode, mount(app) { app.get('/active', async (req, res) => {
            entered(); await blocked;
            await getSettingsRepo().save(req.user.profile.handle, { retained: 'settled before reopen' });
            res.json({ ok: true });
        }); app.get('/queued', async (req, res) => {
            queuedEntered = true;
            res.json(await getSettingsRepo().get(req.user.profile.handle));
        }); } });
        expect(h.server?.listening).toBe(true);
        const pending = request(h.server).get('/active').then(value => ({ value }), error => ({ error }));
        await started;
        const server = h.server, reopen = h.reopenEngine().then(() => ({ ok: true }), error => ({ error }));
        const received = deferred();
        server.once('request', received.resolve);
        const queued = request(server).get('/queued').then(value => ({ value }), error => ({ error }));
        await received.promise;
        await checkpoint();
        const admittedBeforeRelease = queuedEntered;
        release();
        expect((await pending).value?.body).toEqual({ ok: true });
        expect(await reopen).toEqual({ ok: true });
        expect((await queued).value?.body).toEqual({ retained: 'settled before reopen' });
        expect(admittedBeforeRelease).toBe(false);
        expect(h.server).toBe(server);
        expect(await getSettingsRepo().get(h.handle)).toEqual({ retained: 'settled before reopen' });
    });
});

test('teardown waits for an in-flight owned response before removing its data', async () => {
    let h, release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    try {
        h = await makeEndpointHarness({ mode: 'fs', mount(app) { app.get('/active', async (_req, res) => {
            entered(); await blocked;
            res.json({ exists: fs.existsSync(h.dataRoot) });
        }); } });
        expect(h.server?.listening).toBe(true);
        const pending = request(h.server).get('/active').then(value => ({ value }), error => ({ error }));
        await started;
        const closing = h.cleanup().then(() => ({ ok: true }), error => ({ error }));
        expect(fs.existsSync(h.dataRoot)).toBe(true);
        release();
        expect((await pending).value?.body).toEqual({ exists: true });
        expect(await closing).toEqual({ ok: true });
        expect(fs.existsSync(h.dataRoot)).toBe(false);
    } finally { release(); if (h) await h.cleanup(); }
});

test('a genuine transport failure settles only the fixture-owned peer', async () => {
    const h = await makeEndpointHarness({ mode: 'fs', mount(app) { app.get('/disconnect', req => req.socket.destroy()); } });
    try {
        expect(h.server?.listening).toBe(true);
        const error = await request(h.server).get('/disconnect').then(() => null, failure => failure);
        recordLifecycle('owned transport failure', { code: error.code, name: error.name, message: error.message });
        expect(error.name).toBe('Error'); expect(error.code).toBe('ECONNRESET');
        await h.cleanup(); await h.cleanup();
        expect(h.server.listening).toBe(false);
    } finally { await h.cleanup(); }
});

test('cleanup retains an unexpected native permission failure across repeated calls', async () => {
    const h = await makeEndpointHarness({ mode: 'fs', mount() {} });
    fs.chmodSync(h.dataRoot, 0o500);
    try {
        const failure = await h.cleanup().then(() => null, error => error);
        recordLifecycle('owned native cleanup failure', { code: failure.code, name: failure.name, path: failure.path });
        expect(failure.name).toBe('Error');
        expect(['EACCES', 'EPERM', 'ENOTEMPTY']).toContain(failure.code);
        expect(failure.path.startsWith(h.dataRoot)).toBe(true);
        expect(await h.cleanup().then(() => null, error => error)).toBe(failure);
        expect(h.server.listening).toBe(false);
    } finally { fs.chmodSync(h.dataRoot, 0o700); fs.rmSync(h.dataRoot, { recursive: true }); }
});

test('setup retains both the original mount failure and its real cleanup failure', async () => {
    const original = new Error('owned setup failure');
    let root;
    try {
        const failure = await makeEndpointHarness({ mode: 'fs', mount(_app, { dirs }) {
            root = path.dirname(dirs.root); fs.chmodSync(root, 0o500); throw original;
        } }).then(() => null, error => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toContain(original);
        const cleanupFailure = failure.errors.find(error => error !== original);
        recordLifecycle('owned setup and cleanup failure', { original: original.message, code: cleanupFailure.code, path: cleanupFailure.path });
        expect(['EACCES', 'EPERM', 'ENOTEMPTY']).toContain(cleanupFailure.code);
        expect(cleanupFailure.path.startsWith(root)).toBe(true);
    } finally { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true }); }
});

test('cleanup closes its own engine rather than the latest globally initialized fixture', async () => {
    const first = await makeEndpointHarness({ mode: 'fs', mount() {} });
    const second = await makeEndpointHarness({ mode: 'sqlite', mount() {} });
    try {
        const db = getStorageEngine();
        await getSettingsRepo().save(second.handle, { retained: 'second engine' });
        const connection = db._dbs.get(second.handle);
        await first.cleanup();
        expect(getStorageEngine()).toBe(db);
        expect(connection.open).toBe(true);
        expect(await getSettingsRepo().get(second.handle)).toEqual({ retained: 'second engine' });
        expect(second.server.listening).toBe(true);
    } finally { await first.cleanup(); await second.cleanup(); }
});
