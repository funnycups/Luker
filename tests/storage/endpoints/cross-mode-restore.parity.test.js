// 16-pair cross-mode restore parity test:
//   {fs, sqlite, mysql, postgres} × {fs, sqlite, mysql, postgres}.
//
// The 12 cross pairs exercise the full crossModeRestore pipeline end-to-end:
// build a backup ZIP from a source engine, swap the live engine to the
// destination kind, drive POST /api/users/restore-backup over a real HTTP
// shape, then verify every Repo on the destination reflects the seeded data.
//
// The 4 same-mode pairs act as control: confirm the restore handler still
// takes the original same-mode path (no crossModeRestore delegation) for
// fs→fs, sqlite→sqlite, mysql→mysql, postgres→postgres.
//
// mysql / pg pairs skip when LUKER_DISABLE_MYSQL_TESTS=1 /
// LUKER_DISABLE_POSTGRES_TESTS=1 — matching the existing harness skip
// convention for environments without a local test DB.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import archiver from 'archiver';
import multer from 'multer';
import request from 'supertest';

import { makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import {
    getChatRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    getNamedDocRepo,
    getPresetRepo,
    getGroupRepo,
    getStatsRepo,
    getStorageEngine,
} from '../../../src/storage/index.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { MysqlEngine } from '../../../src/storage/engines/mysql-engine.js';
import { PgEngine } from '../../../src/storage/engines/postgres-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';
import { USER_DIRECTORY_TEMPLATE } from '../../../src/constants.js';

const HEADER = { user_name: 'parity', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi 你好 🌍' },
    { name: 'Alice', is_user: false, mes: 'hello 世界 ✨' },
];

const FULL_SELECTION = {
    settings: true, secrets: true, characters: true, chats: true,
    lorebooks: true, presets: true, assets: true, extensions: true,
    globalExtensions: false, vectors: true,
};

const SKIP_MYSQL = !!process.env.LUKER_DISABLE_MYSQL_TESTS;
const SKIP_PG = !!process.env.LUKER_DISABLE_POSTGRES_TESTS;

const MODES = ['fs', 'sqlite', 'mysql', 'postgres'];

function pairs() {
    const all = [];
    for (const src of MODES) {
        for (const dst of MODES) {
            const sameMode = src === dst;
            all.push({ src, dst, sameMode });
        }
    }
    return all;
}

function maybeSkip({ src, dst }) {
    if ((src === 'mysql' || dst === 'mysql') && SKIP_MYSQL) return true;
    if ((src === 'postgres' || dst === 'postgres') && SKIP_PG) return true;
    return false;
}

function mountMulterShim(app, uploadsDir) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar');
    app.use(upload);
}

function buildDirs(userRoot) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
        dirs[key] = path.join(userRoot, rel);
    }
    return dirs;
}

// ---------------------------------------------------------------------------
// Source builders — produce a backup ZIP for each engine kind from a seeded
// repo set. Mirrors createBackupArchive (src/users.js) for fs; falls back to
// a hand-crafted archive + engine dump for the db-backed kinds.
// ---------------------------------------------------------------------------

async function seedSource(repos, handle) {
    await repos.settings.save(handle, { user_name: 'parity-source', custom: 'PV' });
    await repos.chat.save(handle, 'Alice', 'c1', HEADER, MESSAGES, null);
    await repos.worldInfo.save(handle, 'w1', { entries: { '0': { content: 'lore-x' } } });
    await repos.preset.save(handle, 'openai', 'p1', { temperature: 0.7 });
    await repos.namedDoc.save(handle, 'themes', 't1', { accent: '#abc' });
    await repos.group.save(handle, 'g1', { id: 'g1', name: 'G', chats: [] });
    await repos.stats.save(handle, { totalChats: 5 });
}

function buildReposForEngine(engine) {
    return {
        chat: new ChatRepo({ engine }),
        settings: new SettingsRepo({ engine }),
        preset: new PresetRepo({ engine }),
        worldInfo: new WorldInfoRepo({ engine }),
        namedDoc: new NamedDocRepo({ engine }),
        group: new GroupRepo({ engine }),
        stats: new StatsRepo({ engine }),
    };
}

async function buildSourceZip({ srcKind, srcEngine, srcDir, handle, zipPath }) {
    const arc = archiver('zip');
    const out = fs.createWriteStream(zipPath);
    const ready = new Promise((res, rej) => { arc.on('error', rej); out.on('close', res); });
    arc.pipe(out);
    arc.append(JSON.stringify({ schemaVersion: 1, handle }), { name: 'manifest.json' });

    if (srcKind === 'fs') {
        // Walk the user's on-disk tree and add every file.
        await addDirToZip(arc, srcDir, '');
    } else {
        // Capture engine dump + emit engine_meta + add any on-disk fs-tree
        // files (secrets, characters, etc. that are NOT engine-stored).
        const dumpStream = await srcEngine.dumpUser(handle);
        const tmpPath = path.join(os.tmpdir(), `parity-dump-${randomBytes(4).toString('hex')}.bin`);
        await pipeline(dumpStream, fs.createWriteStream(tmpPath));
        const dumpBytes = fs.readFileSync(tmpPath);
        fs.rmSync(tmpPath, { force: true });
        arc.append(JSON.stringify({ engineKind: srcKind, schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        // Add any fs-tree files that exist under the user dir (e.g.
        // secrets.json, characters/, etc. seeded by the harness).
        if (fs.existsSync(srcDir)) {
            await addDirToZip(arc, srcDir, '', { skipNames: new Set(['luker-storage.sqlite']) });
        }
    }
    arc.finalize();
    await ready;
}

async function addDirToZip(arc, dir, prefix, opts = {}) {
    const skipNames = opts.skipNames || new Set();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (skipNames.has(e.name)) continue;
        if (e.isDirectory()) {
            await addDirToZip(arc, full, rel, opts);
        } else if (e.isFile()) {
            arc.append(fs.readFileSync(full), { name: rel });
        }
    }
}

// ---------------------------------------------------------------------------
// Source seeding — spin up a transient engine of `srcKind` under a fresh
// dataRoot, seed it, capture its ZIP, then tear it down. The destination
// harness is built separately by the test body.
// ---------------------------------------------------------------------------

async function buildSourceArtifact(srcKind, handle) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `parity-src-${srcKind}-`));
    const srcDir = path.join(dataRoot, handle);
    fs.mkdirSync(srcDir, { recursive: true });
    let srcEngine;
    let dbCleanup = async () => {};
    if (srcKind === 'fs') {
        // Pre-create the dirs the repos need.
        for (const sub of ['chats', 'characters', 'worlds', 'groups', 'group chats', 'themes', 'movingUI', 'QuickReplies', 'OpenAI Settings', 'NovelAI Settings', 'KoboldAI Settings', 'TextGen Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) {
            fs.mkdirSync(path.join(srcDir, sub), { recursive: true });
        }
        srcEngine = new FsEngine({ directoriesByHandle: () => buildDirs(srcDir) });
    } else if (srcKind === 'sqlite') {
        srcEngine = new SqliteEngine({ directoriesByHandle: () => ({ root: srcDir }) });
    } else if (srcKind === 'mysql') {
        const dbName = `parity_src_${Date.now()}_${randomBytes(3).toString('hex')}`;
        const rootUrl = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
        const mysql = await import('mysql2/promise');
        const root = await mysql.default.createConnection(rootUrl);
        await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        await root.end();
        srcEngine = new MysqlEngine({ url: `${rootUrl}/${dbName}` });
        dbCleanup = async () => {
            try { await srcEngine.close(); } catch {}
            const c = await mysql.default.createConnection(rootUrl);
            try { await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } finally { await c.end(); }
        };
    } else if (srcKind === 'postgres') {
        const pg = await import('pg');
        const baseUrl = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
        const schemaName = `parity_src_${Date.now()}_${randomBytes(3).toString('hex')}`;
        const rootClient = new pg.default.Client({ connectionString: baseUrl });
        await rootClient.connect();
        await rootClient.query(`CREATE SCHEMA "${schemaName}"`);
        await rootClient.end();
        const url = `${baseUrl}?options=-csearch_path%3D${encodeURIComponent(schemaName)}`;
        srcEngine = new PgEngine({ url });
        dbCleanup = async () => {
            try { await srcEngine.close(); } catch {}
            const c = new pg.default.Client({ connectionString: baseUrl });
            await c.connect();
            try { await c.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } finally { await c.end(); }
        };
    }
    await seedSource(buildReposForEngine(srcEngine), handle);

    const zipPath = path.join(dataRoot, 'source.zip');
    await buildSourceZip({ srcKind, srcEngine, srcDir, handle, zipPath });

    if (srcKind === 'sqlite') {
        try { srcEngine.close(); } catch {}
    } else if (srcKind === 'mysql' || srcKind === 'postgres') {
        await dbCleanup();
    }

    return {
        zipBytes: fs.readFileSync(zipPath),
        cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
    };
}

// Resolve a scratch URL for the active mysql/pg harness so the cross-mode
// restore can ingest a mysql/pg-source ZIP. We point at the same DB instance
// the harness is using (different handle namespace inside the same DB).
function scratchUrlForHarness(harness, srcKind) {
    if (srcKind === 'mysql') {
        const rootUrl = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
        return `${rootUrl}/${harness.dbName || 'luker_test'}`;
    }
    if (srcKind === 'postgres') {
        const baseUrl = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
        return `${baseUrl}?options=-csearch_path%3D${encodeURIComponent(harness.schemaName || 'public')}`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Probe helpers used by the destination side.
// ---------------------------------------------------------------------------

async function probeAllRepos(handle) {
    return {
        chat: await getChatRepo().get(handle, 'Alice', 'c1'),
        settings: await getSettingsRepo().get(handle),
        world: await getWorldInfoRepo().get(handle, 'w1'),
        theme: await getNamedDocRepo().get(handle, 'themes', 't1'),
        preset: await getPresetRepo().get(handle, 'openai', 'p1'),
        group: await getGroupRepo().get(handle, 'g1'),
        stats: await getStatsRepo().get(handle),
    };
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

describe.each(pairs())('cross-mode restore: $src → $dst', ({ src, dst, sameMode }) => {
    if (maybeSkip({ src, dst })) {
        test.skip('skipped (mysql/pg tests disabled by env)', () => {});
        return;
    }

    let harness;
    let sourceArtifact;

    // Source seed uses the same handle the harness allocates ('u') so that
    // same-mode restores (where the source ZIP rows are queried under the
    // live engine's handle) still find their data. For cross-mode the
    // orchestrator overrides the handle via destHandle inside
    // MigrationRunner, so the literal source handle in the ZIP doesn't
    // matter there.
    beforeAll(async () => {
        sourceArtifact = await buildSourceArtifact(src, 'u');
    });
    afterAll(() => {
        sourceArtifact?.cleanup();
    });

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode: dst,
            mount: (app, { dirs }) => {
                const uploadsDir = path.join(dirs.root, 'cm-uploads');
                mountMulterShim(app, uploadsDir);
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });
    afterEach(async () => { if (harness) await harness.cleanup(); });

    test(`REGRESSION: ${src} ZIP restores into ${dst} engine end-to-end`, async () => {
        const scratchFields = {};
        let scratchTeardown = async () => {};
        // For mysql/pg source ZIPs, create a fresh scratch DB / schema on
        // demand. We can't reuse the destination harness's DB if the
        // destination ISN'T the same kind, and even when it IS, the
        // harness's namespace is dedicated to the live engine — using it
        // as scratch would mix scratch handle rows in with the live data
        // (cleanup deleteUser would still scope to the scratch handle,
        // but the test would be harder to reason about). Create a
        // throwaway namespace per test instead.
        if (src === 'mysql') {
            const rootUrl = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
            const dbName = `parity_scratch_${Date.now()}_${randomBytes(3).toString('hex')}`;
            const mysql = await import('mysql2/promise');
            const root = await mysql.default.createConnection(rootUrl);
            await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
            await root.end();
            scratchFields.scratchMysqlUrl = `${rootUrl}/${dbName}`;
            scratchTeardown = async () => {
                const c = await mysql.default.createConnection(rootUrl);
                try { await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } finally { await c.end(); }
            };
        }
        if (src === 'postgres') {
            const baseUrl = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
            const schemaName = `parity_scratch_${Date.now()}_${randomBytes(3).toString('hex')}`;
            const pg = await import('pg');
            const rootClient = new pg.default.Client({ connectionString: baseUrl });
            await rootClient.connect();
            await rootClient.query(`CREATE SCHEMA "${schemaName}"`);
            await rootClient.end();
            scratchFields.scratchPostgresUrl = `${baseUrl}?options=-csearch_path%3D${encodeURIComponent(schemaName)}`;
            scratchTeardown = async () => {
                const c = new pg.default.Client({ connectionString: baseUrl });
                await c.connect();
                try { await c.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } finally { await c.end(); }
            };
        }

        try {
            const req = request(harness.app)
                .post('/api/users/restore-backup')
                .field('handle', harness.handle)
                .field('mode', 'overwrite')
                .field('selection', JSON.stringify(FULL_SELECTION));
            for (const [k, v] of Object.entries(scratchFields)) req.field(k, v);
            const res = await req.attach('avatar', sourceArtifact.zipBytes, 'source.zip');

            if (res.status !== 200) console.log(`PARITY ${src}→${dst} FAILED:`, res.status, res.body);
            expect(res.status).toBe(200);
            if (sameMode) {
                // Same-mode path returned by the original restore code does NOT
                // produce a `crossMode` block.
                expect(res.body.crossMode).toBeUndefined();
            } else {
                expect(res.body.crossMode?.sourceKind).toBe(src);
                expect(res.body.crossMode?.destKind).toBe(dst);
            }

            const probe = await probeAllRepos(harness.handle);
            expect(probe.settings?.user_name).toBe('parity-source');
            expect(probe.chat?.body?.[0]?.mes).toBe('hi 你好 🌍');
            expect(probe.chat?.body?.[1]?.mes).toBe('hello 世界 ✨');
            expect(probe.world).toBeTruthy();
            expect(probe.preset?.temperature).toBe(0.7);
            expect(probe.theme?.accent).toBe('#abc');
            expect(probe.group?.id).toBe('g1');
            if (!sameMode) {
                // stats is migrated by MigrationRunner in cross-mode flows. The
                // same-mode restore handler doesn't include stats.json in any
                // selection category (it's derived from chats and intentionally
                // omitted from the backup ZIP target list), so stats won't land
                // back on the live engine through the same-mode path.
                expect(probe.stats?.totalChats).toBe(5);
            }
        } finally {
            try { await scratchTeardown(); } catch { /* best-effort */ }
        }
    }, 30000);
});
