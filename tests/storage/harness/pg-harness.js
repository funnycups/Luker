import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { PgEngine } from '../../../src/storage/engines/postgres-engine.js';

// Local dev container default. The luker role (DB owner) can both create and
// drop schemas inside the luker_test database, so we use it end-to-end rather
// than splitting between a superuser-for-DDL and a least-privilege app role.
const ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';

// Stub directory map. PgEngine stores nothing on disk, but the Repo contract
// tests share their beforeEach with FsEngine, which means they call
// `fs.mkdirSync(h.dirs.<bucket>, { recursive: true })` to pre-create the FS
// scaffold. Mirror the MysqlEngine harness's behavior: hand back paths under
// a per-harness temp root so the mkdirSync calls succeed as no-ops. Tests that
// actually assert on FS state are isolated in their own `describe` blocks that
// use makeTempFsEngineHarness directly, so they never reach this harness.
const USER_DIR_KEYS = Object.freeze([
    'root', 'thumbnails', 'thumbnailsBg', 'thumbnailsAvatar', 'thumbnailsPersona',
    'worlds', 'user', 'avatars', 'userImages', 'groups', 'groupChats', 'chats',
    'characters', 'backgrounds', 'novelAI_Settings', 'koboldAI_Settings',
    'openAI_Settings', 'textGen_Settings', 'themes', 'movingUI', 'extensions',
    'instruct', 'context', 'quickreplies', 'assets', 'comfyWorkflows', 'files',
    'vectors', 'backups', 'sysprompt', 'reasoning', 'cardApps',
]);

function buildStubDirs(rootDir) {
    const dirs = {};
    for (const key of USER_DIR_KEYS) dirs[key] = path.join(rootDir, key);
    return dirs;
}

// Each call creates a unique schema inside the shared luker_test database so
// parallel tests don't collide and a crashed test doesn't leak state into the
// next run. Cleanup drops the schema CASCADE.
//
// Postgres differs from MySQL here: you cannot CREATE/DROP DATABASE while
// connected to it (pg refuses with "cannot drop the currently open database"),
// and Postgres dislikes rapid database creation in general. The standard
// equivalent is per-schema isolation: every harness call creates a fresh
// schema namespace and the engine targets it via the connection's search_path.
export async function makeTempPgEngineHarness() {
    const schemaName = `luker_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const rootClient = new pg.Client({ connectionString: ROOT_URL });
    await rootClient.connect();
    try {
        await rootClient.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
        await rootClient.end();
    }
    // Bake search_path into the connection URL via the libpq "options" startup
    // parameter (`-c<setting>=<value>`). pg parses this and forwards it; every
    // connection the pool opens lands with the right search_path already set,
    // so no per-connection SET fires before each query. Verified working
    // against pg 8.x and Postgres 16.
    const urlWithSchema = `${ROOT_URL}?options=-csearch_path%3D${encodeURIComponent(schemaName)}`;
    const engine = new PgEngine({ url: urlWithSchema });
    const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-contract-pg-'));
    const dirs = buildStubDirs(stubRoot);
    return {
        engine,
        kind: 'postgres',
        handle: 'u',
        schemaName,
        dataRoot: stubRoot,
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: async () => {
            try { await engine.close(); } catch { /* pool may already be dead */ }
            const c = new pg.Client({ connectionString: ROOT_URL });
            await c.connect();
            try { await c.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); }
            finally { await c.end(); }
            try { fs.rmSync(stubRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}
