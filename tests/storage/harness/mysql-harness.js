import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { MysqlEngine } from '../../../src/storage/engines/mysql-engine.js';

// Local dev container default. Override with LUKER_TEST_MYSQL_ROOT_URL if the
// docker-compose port mapping changes.
const ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';

// Stub directory map. MysqlEngine stores nothing on disk, but the Repo contract
// tests share their beforeEach with FsEngine, which means they call
// `fs.mkdirSync(h.dirs.<bucket>, { recursive: true })` to pre-create the FS
// scaffold. Mirror the SqliteEngine harness's behavior: hand back paths under
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

// Each call creates a unique database so parallel tests don't collide and a
// crashed test doesn't leak state into the next run. Cleanup drops the DB.
export async function makeTempMysqlEngineHarness() {
    const dbName = `luker_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const rootConn = await mysql.createConnection(ROOT_URL);
    try {
        await rootConn.query(
            `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
        );
    } finally {
        await rootConn.end();
    }
    const url = `${ROOT_URL}/${dbName}`;
    const engine = new MysqlEngine({ url });
    const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-contract-mysql-'));
    const dirs = buildStubDirs(stubRoot);
    const backupRoot = path.join(stubRoot, '_storage-migrations');
    return {
        engine,
        kind: 'mysql',
        handle: 'u',
        dbName,
        dataRoot: stubRoot,
        backupRoot,
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: async () => {
            try { await engine.close(); } catch { /* pool may already be dead */ }
            const c = await mysql.createConnection(ROOT_URL);
            try { await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``); }
            finally { await c.end(); }
            try { fs.rmSync(stubRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}
