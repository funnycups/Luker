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
import os from 'node:os';
import path from 'node:path';

import bodyParser from 'body-parser';
import express from 'express';
import mysql from 'mysql2/promise';
import pg from 'pg';

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

function makeEngineFactory({ mode, dataRoot, handle, dbName, pgSchemaUrl }) {
    const userDir = path.join(dataRoot, handle);
    const dirs = buildDirs(userDir);
    const directoriesByHandle = (h) => {
        if (h !== handle) throw new Error(`unknown handle ${h}`);
        return dirs;
    };

    return {
        dirs,
        directoriesByHandle,
        get mysqlUrl() { return mode === 'mysql' ? `${MYSQL_ROOT_URL}/${dbName}` : null; },
        get pgUrl() { return mode === 'postgres' ? pgSchemaUrl : null; },
    };
}

async function createMysqlDatabase(dbName) {
    const conn = await mysql.createConnection(MYSQL_ROOT_URL);
    try {
        await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    } finally {
        await conn.end();
    }
}

async function dropMysqlDatabase(dbName) {
    const conn = await mysql.createConnection(MYSQL_ROOT_URL);
    try { await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``); }
    finally { await conn.end(); }
}

async function createPgSchema(schema) {
    const c = new pg.Client({ connectionString: PG_ROOT_URL });
    await c.connect();
    try { await c.query(`CREATE SCHEMA "${schema}"`); }
    finally { await c.end(); }
}

async function dropPgSchema(schema) {
    const c = new pg.Client({ connectionString: PG_ROOT_URL });
    await c.connect();
    try { await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await c.end(); }
}

function pgSchemaConnUrl(schema) {
    return `${PG_ROOT_URL}?options=-csearch_path%3D${encodeURIComponent(schema)}`;
}

/**
 * Build a configured Express app + storage engine for a single test.
 *
 * @param {object} opts
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} opts.mode
 * @param {(app: import('express').Express, ctx: {handle: string, dirs: object}) => void} opts.mount
 *        Callback that mounts routers onto the app. Runs AFTER initStorage so
 *        routers that capture getXxxRepo() at module load time work.
 * @param {object} [opts.profile]  Override request.user.profile (default: {handle, admin: true}).
 * @returns {Promise<{app, dataRoot, handle, dirs, mode, engine, reopenEngine, cleanup}>}
 */
export async function makeEndpointHarness({ mode, mount, profile }) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `luker-ep-${mode}-`));
    const handle = 'u';
    const dbName = (mode === 'mysql' || mode === 'postgres')
        ? `luker_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
        : null;
    if (mode === 'mysql') await createMysqlDatabase(dbName);
    if (mode === 'postgres') await createPgSchema(dbName);

    const factory = makeEngineFactory({
        mode, dataRoot, handle, dbName,
        pgSchemaUrl: mode === 'postgres' ? pgSchemaConnUrl(dbName) : null,
    });
    precreateCommonDirs(factory.dirs);

    initStorage({
        mode,
        directoriesByHandle: factory.directoriesByHandle,
        mysql: factory.mysqlUrl ? { url: factory.mysqlUrl } : null,
        postgres: factory.pgUrl ? { url: factory.pgUrl } : null,
    });
    let engine = getStorageEngine();
    if (typeof engine.ping === 'function') {
        await engine.ping(handle);
    }

    const app = express();
    app.use(bodyParser.json({ limit: '500mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
    const userProfile = profile || { handle, admin: true, enabled: true, name: 'Test', created: 0, password: '', salt: '' };
    app.use((req, _res, next) => {
        req.user = {
            profile: userProfile,
            directories: factory.dirs,
        };
        next();
    });
    await Promise.resolve(mount(app, { handle, dirs: factory.dirs }));

    async function reopenEngine() {
        // Close current engine, then re-initStorage so getXxxRepo() returns a
        // fresh handle. Simulates a real server restart against the same data
        // root: only durable state survives.
        const current = getStorageEngine();
        if (current && typeof current.close === 'function') {
            await current.close();
        }
        initStorage({
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

    async function cleanup() {
        try {
            const current = getStorageEngine();
            if (current && typeof current.close === 'function') {
                await current.close();
            }
        } catch { /* engine may already be torn down */ }
        if (mode === 'mysql') {
            try { await dropMysqlDatabase(dbName); } catch { /* best-effort */ }
        }
        if (mode === 'postgres') {
            try { await dropPgSchema(dbName); } catch { /* best-effort */ }
        }
        try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    return {
        app,
        dataRoot,
        handle,
        dirs: factory.dirs,
        mode,
        get engine() { return getStorageEngine(); },
        reopenEngine,
        cleanup,
    };
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
