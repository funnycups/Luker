// Endpoint-level test harness for verifying that REST routes behave
// identically across every supported storage engine.
//
// The user's "presets vanish after refresh in db mode" bug surfaced because
// the storage layer (`src/storage/`) is fully engine-agnostic but several
// endpoint files still read directly from `fs.*` while writes route through
// the Repo. The Repo-layer tests in `tests/storage/repositories/` never see
// this gap because they round-trip Repo → Repo.
//
// This harness wires up a tiny Express app:
//   1. initStorage({mode}) so getXxxRepo() returns the right engine.
//   2. setUserDataMiddleware-style stub that injects request.user
//      ({profile: {handle}, directories: {...}}).
//   3. Whatever router(s) the test wants to mount.
// Tests drive the app with `supertest`.
//
// Engines covered (matches CONTRACT_HARNESSES used by Repo-layer tests):
//   - FsEngine            (always on)
//   - SqliteEngine        (always on)
//   - MysqlEngine         (skip with LUKER_DISABLE_MYSQL_TESTS=1)
//   - PgEngine            (skip with LUKER_DISABLE_POSTGRES_TESTS=1)
//
// To restart the engine mid-test (read-after-restart parity check), call
// harness.reopenEngine(). FsEngine has nothing to close; the SQL engines tear
// down their connection/pool and re-create against the same data root so the
// next request sees only what is durably persisted.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import bodyParser from 'body-parser';
import express from 'express';
import mysql from 'mysql2/promise';
import pg from 'pg';
import request from 'supertest';

import { initStorage, getStorageEngine } from '../../../src/storage/index.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE — must stay in sync.
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

function buildDirs(userDir) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    return dirs;
}

function precreateCommonDirs(dirs) {
    // Pre-create the directories that endpoints assume exist. fs-mode
    // matches what the real server's migrateUserData does at boot.
    fs.mkdirSync(dirs.root, { recursive: true });
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.groups, { recursive: true });
    fs.mkdirSync(dirs.groupChats, { recursive: true });
    fs.mkdirSync(dirs.worlds, { recursive: true });
    fs.mkdirSync(dirs.backups, { recursive: true });
    fs.mkdirSync(dirs.openAI_Settings, { recursive: true });
    fs.mkdirSync(dirs.novelAI_Settings, { recursive: true });
    fs.mkdirSync(dirs.koboldAI_Settings, { recursive: true });
    fs.mkdirSync(dirs.textGen_Settings, { recursive: true });
    fs.mkdirSync(dirs.themes, { recursive: true });
    fs.mkdirSync(dirs.movingUI, { recursive: true });
    fs.mkdirSync(dirs.quickreplies, { recursive: true });
    fs.mkdirSync(dirs.instruct, { recursive: true });
    fs.mkdirSync(dirs.context, { recursive: true });
    fs.mkdirSync(dirs.sysprompt, { recursive: true });
    fs.mkdirSync(dirs.reasoning, { recursive: true });
    fs.mkdirSync(dirs.cardApps, { recursive: true });
}

// Local dev container defaults — keep in sync with mysql-harness.js / pg-harness.js.
const MYSQL_ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
const PG_ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';

function makeEngineFactory({ mode, dataRoot, handle, extraHandles, dbName, pgSchemaUrl }) {
    const userDir = path.join(dataRoot, handle);
    const dirs = buildDirs(userDir);
    // Extra handles share the same `dataRoot` (so the same sqlite/mysql/pg
    // database/schema serves them) but each gets its own sibling user dir,
    // so fs-mode keeps the per-user filesystem layout the real server uses.
    const extraDirs = {};
    for (const h of extraHandles || []) {
        extraDirs[h] = buildDirs(path.join(dataRoot, h));
    }
    const directoriesByHandle = (h) => {
        if (h === handle) return dirs;
        if (extraDirs[h]) return extraDirs[h];
        throw new Error(`unknown handle ${h}`);
    };

    return {
        dirs,
        extraDirs,
        directoriesByHandle,
        get mysqlUrl() { return mode === 'mysql' ? `${MYSQL_ROOT_URL}/${dbName}` : null; },
        get pgUrl() { return mode === 'postgres' ? pgSchemaUrl : null; },
    };
}

async function useConnection(connection, run) {
    let value;
    const failures = [];
    try { value = await run(connection); } catch (error) { failures.push(error); }
    try { await connection.end(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Connection operation and closure failed');
    return value;
}

async function createMysqlDatabase(dbName, acquired) {
    const conn = await mysql.createConnection(MYSQL_ROOT_URL);
    await useConnection(conn, async () => {
        await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        acquired();
    });
}

async function dropMysqlDatabase(dbName) {
    const conn = await mysql.createConnection(MYSQL_ROOT_URL);
    await useConnection(conn, () => conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``));
}

async function createPgSchema(schema, acquired) {
    const c = new pg.Client({ connectionString: PG_ROOT_URL });
    await useConnection(c, async () => {
        await c.connect();
        await c.query(`CREATE SCHEMA "${schema}"`);
        acquired();
    });
}

async function dropPgSchema(schema) {
    const c = new pg.Client({ connectionString: PG_ROOT_URL });
    await useConnection(c, async () => {
        await c.connect();
        await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
}

function pgSchemaConnUrl(schema) {
    return `${PG_ROOT_URL}?options=-csearch_path%3D${encodeURIComponent(schema)}`;
}

/**
 * Build a mounted app, owned IPv4 listener and storage engine for a single test.
 *
 * @param {object} opts
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} opts.mode
 * @param {string} [opts.handle] Isolated owner for routes using cached user directories.
 * @param {(app: import('express').Express, ctx: {handle: string, dirs: object}) => void} opts.mount
 *        Callback that mounts routers onto the app. Runs AFTER initStorage so
 *        routers that capture getXxxRepo() at module load time work.
 * @param {object} [opts.profile]  Override request.user.profile (default: {handle, admin: true}).
 * @param {string[]} [opts.extraHandles]
 *        Additional handles the engine should know about. Each gets a sibling
 *        user directory under `dataRoot`, pre-created with the same shape as
 *        the primary handle's, and is registered in `directoriesByHandle`.
 *        Multi-user routes (admin delete, backup/restore, migration) need
 *        this because the primary `handle` is the request issuer and cannot
 *        be the deletion target.
 * @returns {Promise<{app, server, dataRoot, handle, dirs, extraDirs, mode, engine, reopenEngine, cleanup}>}
 */
export async function makeEndpointHarness({ mode, mount, profile, extraHandles, handle = 'u' }) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `luker-ep-${mode}-`));
    const dbName = (mode === 'mysql' || mode === 'postgres')
        ? `luker_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
        : null;
    let engine, factory, server, listening = false, closing = false, databaseCreated = false, cleanupJob;
    let readiness = Promise.resolve();
    const activeTransport = new Set(), activeWork = new Set(), workFailures = new Set();
    const continuations = new WeakMap();
    let groupedWorkFailure;

    function workFailure() {
        if (workFailures.size === 0) return;
        if (workFailures.size === 1) return [...workFailures][0];
        if (groupedWorkFailure?.errors.length !== workFailures.size) groupedWorkFailure = new AggregateError([...workFailures], 'Endpoint fixture admitted work failed');
        return groupedWorkFailure;
    }

    async function drainActive() {
        while (activeTransport.size || activeWork.size) await Promise.all([...activeTransport, ...activeWork]);
    }

    function enterCallback(req) {
        const continuation = continuations.get(req);
        if (continuation) {
            continuations.delete(req);
            activeWork.delete(continuation.promise);
            continuation.resolve();
        }
    }

    function continueDispatch(req, next, args) {
        enterCallback(req);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        continuations.set(req, { promise, resolve });
        activeWork.add(promise);
        return next(...args);
    }

    function observeHandler(handler, nextIndex = handler.length === 4 ? 3 : 2) {
        const observed = function (...args) {
            const req = args[nextIndex === 3 ? 1 : 0], next = args[nextIndex];
            enterCallback(req);
            args[nextIndex] = (...values) => continueDispatch(req, next, values);
            let returned;
            try { returned = Reflect.apply(handler, this, args); }
            catch (error) { workFailures.add(error); return args[nextIndex](error); }
            if (returned && typeof returned.then === 'function') {
                // Observe the actual returned promise before the framework discards
                // its return value. Transport events cannot release this work.
                const settled = Promise.resolve(returned).then(undefined, error => {
                    workFailures.add(error);
                    args[nextIndex](error);
                }).then(() => { activeWork.delete(settled); }, error => {
                    workFailures.add(error);
                    activeWork.delete(settled);
                });
                activeWork.add(settled);
            }
            return returned;
        };
        Object.defineProperty(observed, 'length', { value: handler.length });
        return observed;
    }

    // Imported routers are shared. Observe only a fixture-owned dispatch graph;
    // neither their layers nor any framework/HTTP prototype is modified.
    function copyRouter(source, root = false) {
        const router = Object.assign(express.Router(), source);
        router.handle = (req, res, next) => source.handle.call(router, req, res, (...args) => {
            if (root) { enterCallback(req); return next(...args); }
            return continueDispatch(req, next, args);
        });
        router.params = Object.fromEntries(Object.entries(source.params).map(([name, callbacks]) => [name, callbacks.map(callback => observeHandler(callback, 2))]));
        router.stack = source.stack.map(copyLayer);
        return router;
    }

    function copyLayer(source) {
        const layer = Object.assign(Object.create(Object.getPrototypeOf(source)), source);
        if (source.route) {
            layer.route = Object.assign(Object.create(Object.getPrototypeOf(source.route)), source.route);
            layer.route.stack = source.route.stack.map(copyLayer);
            layer.handle = layer.route.dispatch.bind(layer.route);
        } else if (source.handle.stack) layer.handle = copyRouter(source.handle);
        else layer.handle = observeHandler(source.handle);
        return layer;
    }

    async function openEngine() {
        await initStorage({
            mode,
            directoriesByHandle: factory.directoriesByHandle,
            mysql: factory.mysqlUrl ? { url: factory.mysqlUrl } : null,
            postgres: factory.pgUrl ? { url: factory.pgUrl } : null,
        });
        engine = getStorageEngine();
        if (typeof engine.ping === 'function') {
            await engine.ping(handle);
        }
    }

    function reopenEngine() {
        const previous = readiness;
        readiness = previous.then(async () => {
            await drainActive();
            const failure = workFailure();
            if (failure) throw failure;
            const current = engine;
            await current.close();
            engine = undefined;
            await openEngine();
        });
        return readiness;
    }

    function cleanup() {
        if (!cleanupJob) cleanupJob = (async () => {
            const failures = [];
            closing = true;
            // Stop listener admission before waiting for requests or closing storage.
            const closure = listening ? new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            }) : Promise.resolve();
            const settled = await Promise.allSettled([closure, readiness]);
            for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
            await drainActive();
            const failure = workFailure();
            if (failure && !failures.includes(failure)) failures.push(failure);
            if (engine) {
                try { await engine.close(); } catch (error) { failures.push(error); }
            }
            if (databaseCreated) {
                try {
                    if (mode === 'mysql') await dropMysqlDatabase(dbName);
                    else await dropPgSchema(dbName);
                } catch (error) { failures.push(error); }
            }
            try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'Endpoint fixture cleanup failed');
        })();
        return cleanupJob;
    }

    try {
        if (mode === 'mysql') await createMysqlDatabase(dbName, () => { databaseCreated = true; });
        if (mode === 'postgres') await createPgSchema(dbName, () => { databaseCreated = true; });
        factory = makeEngineFactory({ mode, dataRoot, handle, extraHandles, dbName, pgSchemaUrl: mode === 'postgres' ? pgSchemaConnUrl(dbName) : null });
        precreateCommonDirs(factory.dirs);
        for (const h of extraHandles || []) precreateCommonDirs(factory.extraDirs[h]);
        await openEngine();

        const app = express();
        app.use((req, res, next) => {
            // Reopen gates new admissions while already-admitted HTTP work drains.
            readiness.then(() => {
                if (res.destroyed) return;
                if (closing) { res.sendStatus(503); return; }
                const settled = new Promise(resolve => {
                    const done = () => {
                        res.off('finish', done); res.off('close', done);
                        activeTransport.delete(settled); resolve();
                    };
                    res.once('finish', done); res.once('close', done);
                });
                activeTransport.add(settled);
                next();
            }, next);
        });
        app.use(bodyParser.json({ limit: '500mb' }));
        app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
        const userProfile = profile || { handle, admin: true, enabled: true, name: 'Test', created: 0, password: '', salt: '' };
        app.use((req, _res, next) => {
            req.user = { profile: userProfile, directories: factory.dirs };
            next();
        });
        await mount(app, { handle, dirs: factory.dirs });
        app._router = copyRouter(app._router, true);
        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject); listening = true; resolve();
            });
        });
        return {
            app, server, dataRoot, handle, dirs: factory.dirs, extraDirs: factory.extraDirs, mode,
            get engine() { return engine; }, reopenEngine, cleanup,
        };
    } catch (original) {
        try { await cleanup(); }
        catch (error) { throw new AggregateError([original, ...(error instanceof AggregateError ? error.errors : [error])], 'Endpoint fixture setup and cleanup failed'); }
        throw original;
    }
}

// ---- parameterization ----
//
// ENDPOINT_HARNESSES describes the four engines a test should exercise. Each
// entry exposes:
//   name : human-readable label used in `describe.each` titles
//   mode : the storage mode string passed to initStorage
//
// Tests do:
//   describe.each(ENDPOINT_HARNESSES)('XYZ on $name', ({ mode }) => { ... });
// then build their own harness in beforeEach with makeEndpointHarness({mode}).
const allEntries = [
    { name: 'fs',       mode: 'fs' },
    { name: 'sqlite',   mode: 'sqlite' },
    { name: 'mysql',    mode: 'mysql',    disableEnv: 'LUKER_DISABLE_MYSQL_TESTS' },
    { name: 'postgres', mode: 'postgres', disableEnv: 'LUKER_DISABLE_POSTGRES_TESTS' },
];

export const ENDPOINT_HARNESSES = allEntries.filter(
    (e) => !e.disableEnv || !process.env[e.disableEnv],
);

export const DB_ONLY_HARNESSES = ENDPOINT_HARNESSES.filter((e) => e.mode !== 'fs');

/**
 * Upload a backup archive through the chunked session endpoints so tests can
 * reference it by uploadId — the same sequence the browser performs.
 *
 * @param {import('node:http').Server} server Owned listening server from makeEndpointHarness
 * @param {Buffer} bytes                   raw ZIP bytes
 * @param {{handle: string, chunkSize?: number}} opts
 * @returns {Promise<string>} uploadId
 */
export async function uploadArchiveToSession(server, bytes, { handle, chunkSize = bytes.length } = {}) {
    const initRes = await request(server)
        .post('/api/users/restore-backup/uploads')
        .send({ handle, fileName: 'backup.zip', size: bytes.length });
    if (initRes.status !== 200) {
        throw new Error(`upload init failed: ${initRes.status} ${JSON.stringify(initRes.body)}`);
    }
    const { uploadId } = initRes.body;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const res = await request(server)
            .put(`/api/users/restore-backup/uploads/${uploadId}/chunks/${offset}`)
            .set('Content-Type', 'application/octet-stream')
            .send(slice);
        if (res.status !== 200) {
            throw new Error(`chunk ${offset} failed: ${res.status} ${JSON.stringify(res.body)}`);
        }
    }
    const finRes = await request(server)
        .post(`/api/users/restore-backup/uploads/${uploadId}/finalize`)
        .send({});
    if (finRes.status !== 200) {
        throw new Error(`finalize failed: ${finRes.status} ${JSON.stringify(finRes.body)}`);
    }
    return uploadId;
}
