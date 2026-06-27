// Materialize a "transient source engine" from a backup ZIP for cross-mode
// restore. The orchestrator (crossModeRestore) constructs one of these per
// restore request, runs MigrationRunner against it, then calls cleanup().
//
// For each engineKind the transient mirrors the per-kind storage layout the
// live engine would expect:
//   - fs:       scratch dir under _storage-migrations/_xrestore_<id>/
//               populated with the full on-disk tree from the ZIP.
//   - sqlite:   same scratch dir + the dump bytes written as
//               luker-storage.sqlite at scratch root.
//   - mysql/pg: scratch DB connection (operator-provided) ingests the NDJSON
//               dump under a scratch handle on the operator's DB. Local
//               scratch dir is still created for the directoriesByHandle
//               contract (some Repo paths touch the per-user dir even when
//               the engine is db-backed).
//
// Important wrinkle for mysql/pg sources: the dump's INSERT params include
// the ORIGINAL source handle baked in (the engine doesn't parameterize
// handle separately — it's just the first column in every row). Replaying
// the dump verbatim on operator DB would land rows at the original handle,
// which may collide with the operator's real users. We stream-rewrite the
// first param of every dump line to substitute scratchHandle so the rows
// land in our isolated namespace and tear down cleanly via deleteUser.

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import Database from 'better-sqlite3';
import yauzl from 'yauzl';

import { FsEngine } from '../engines/fs-engine.js';
import { SqliteEngine } from '../engines/sqlite-engine.js';
import { MysqlEngine } from '../engines/mysql-engine.js';
import { PgEngine } from '../engines/postgres-engine.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY, SCRATCH_HANDLE_PREFIX } from '../engine-backup-entries.js';
import { USER_DIRECTORY_TEMPLATE } from '../../constants.js';
import { CrossModeScratchConnectionError } from './cross-mode-errors.js';

/**
 * @typedef {object} TransientSource
 * @property {object} engine            Live engine instance matching engineMeta.engineKind.
 * @property {string} scratchHandle     Handle the engine's per-user storage lives under.
 * @property {{ root: string }} scratchDirs  Directory map (only `.root` is guaranteed).
 * @property {() => Promise<void>} cleanup   Idempotent teardown.
 */

/**
 * @param {{ engineKind: 'fs'|'sqlite'|'mysql'|'postgres', handle?: string }} engineMeta
 * @param {string} zipPath
 * @param {{
 *   dataRoot: string,
 *   scratchHandle: string,
 *   scratchCreds: { mysqlUrl?: string, mysqlPoolSize?: number, postgresUrl?: string, postgresPoolSize?: number }|null,
 * }} opts
 * @returns {Promise<TransientSource>}
 */
export async function materializeTransientSource(engineMeta, zipPath, opts) {
    const kind = engineMeta?.engineKind;
    if (!kind) {
        throw new Error('materializeTransientSource: engineMeta.engineKind is required');
    }
    const { dataRoot, scratchHandle, scratchCreds } = opts;
    if (!scratchHandle || !scratchHandle.startsWith(SCRATCH_HANDLE_PREFIX)) {
        throw new Error(`materializeTransientSource: scratchHandle must start with ${SCRATCH_HANDLE_PREFIX}`);
    }
    if (!dataRoot) {
        throw new Error('materializeTransientSource: dataRoot is required');
    }

    const scratchRoot = path.join(dataRoot, '_storage-migrations', scratchHandle);
    await fsPromises.mkdir(scratchRoot, { recursive: true });

    if (kind === 'fs') return buildFsTransient({ scratchRoot, scratchHandle, zipPath });
    if (kind === 'sqlite') return buildSqliteTransient({ scratchRoot, scratchHandle, zipPath });
    if (kind === 'mysql') return buildMysqlTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds });
    if (kind === 'postgres') return buildPgTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds });
    throw new Error(`materializeTransientSource: unsupported engineKind "${kind}"`);
}

// --------------------------------------------------------------------------
// Directory layout helper — every kind needs the per-user dir tree built
// before the engine touches it, mirroring src/users.js's directories
// initialization for real users.
// --------------------------------------------------------------------------

/**
 * Build a {root, chats, characters, ...} map for the given scratchRoot,
 * using the same USER_DIRECTORY_TEMPLATE the production user-dir layout uses.
 */
function buildScratchDirs(scratchRoot) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
        dirs[key] = path.join(scratchRoot, rel);
    }
    return dirs;
}

/**
 * Pre-create every directory in the layout so engines/repos that mkdir-on-write
 * don't need to climb into a missing parent.
 */
function ensureScratchDirs(scratchDirs) {
    for (const dir of Object.values(scratchDirs)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// --------------------------------------------------------------------------
// fs source: extract every fs-tree entry from the ZIP into scratchRoot.
// --------------------------------------------------------------------------

async function buildFsTransient({ scratchRoot, scratchHandle, zipPath }) {
    const scratchDirs = buildScratchDirs(scratchRoot);
    ensureScratchDirs(scratchDirs);
    // Extract everything except the engine sentinels (fs source ZIPs don't
    // carry them anyway, but be defensive against malformed ZIPs).
    await extractZipTreeToScratch(zipPath, scratchRoot);

    const engine = new FsEngine({
        directoriesByHandle: (h) => {
            if (h !== scratchHandle) {
                throw new Error(`transient fs source: unknown handle ${h}`);
            }
            return scratchDirs;
        },
    });

    let cleanedUp = false;
    return {
        engine,
        scratchHandle,
        scratchDirs,
        async cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            try { await engine.close(); } catch { /* fs engine close is a no-op */ }
            await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => { /* best-effort */ });
        },
    };
}

// --------------------------------------------------------------------------
// sqlite source: write _engine_dump.bin to scratchRoot/luker-storage.sqlite,
// plus extract any fs-tree entries (secrets, characters, assets, etc.).
// --------------------------------------------------------------------------

async function buildSqliteTransient({ scratchRoot, scratchHandle, zipPath }) {
    const scratchDirs = buildScratchDirs(scratchRoot);
    ensureScratchDirs(scratchDirs);
    await extractZipTreeToScratch(zipPath, scratchRoot);
    // The .sqlite file is the engine's home — write it AT scratchRoot
    // (sqlite-engine looks for luker-storage.sqlite under dirs.root).
    const dumpDest = path.join(scratchRoot, 'luker-storage.sqlite');
    const dumpFound = await extractEngineDumpToFile(zipPath, dumpDest);
    if (!dumpFound) {
        throw new Error(`transient sqlite source: backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
    }
    // Rewrite the `handle` column on every user-data table from the source's
    // original handle to the scratchHandle so subsequent reads via the
    // SqliteEngine (which queries `WHERE handle = ?` with scratchHandle)
    // see the imported rows. The .sqlite dump is a byte-copy of the source's
    // per-user DB, so its rows still carry the original handle string —
    // without this UPDATE the engine reads return empty even though the
    // file itself contains the data.
    rewriteSqliteHandleInPlace(dumpDest, scratchHandle);

    const engine = new SqliteEngine({
        directoriesByHandle: (h) => {
            if (h !== scratchHandle) {
                throw new Error(`transient sqlite source: unknown handle ${h}`);
            }
            return scratchDirs;
        },
    });

    let cleanedUp = false;
    return {
        engine,
        scratchHandle,
        scratchDirs,
        async cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            try { engine.close(); } catch { /* engine may already be closed */ }
            await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => { /* best-effort */ });
        },
    };
}

/**
 * UPDATE every user-data table's `handle` column to `scratchHandle`. Done
 * synchronously via better-sqlite3 because the engine isn't open yet (this
 * runs immediately after writing the dump bytes and before the engine
 * lazily opens the file). All 9 tables listed in src/storage/engines/migrations/sqlite/0001-initial.sql
 * carry a `handle` column; we update them all in one transaction so a crash
 * mid-update leaves a recoverable state (re-running the cross-mode restore
 * with a fresh scratch dir is idempotent).
 */
function rewriteSqliteHandleInPlace(sqlitePath, scratchHandle) {
    const TABLES_WITH_HANDLE = [
        'chats', 'chat_states', 'settings', 'presets', 'preset_states',
        'worlds', 'named_docs', 'groups_table', 'stats',
    ];
    const db = new Database(sqlitePath);
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = OFF');
        const tx = db.transaction(() => {
            for (const tbl of TABLES_WITH_HANDLE) {
                db.prepare(`UPDATE ${tbl} SET handle = ?`).run(scratchHandle);
            }
        });
        tx();
    } finally {
        db.close();
    }
}

// --------------------------------------------------------------------------
// mysql source: connect to operator-supplied scratch DB, replay the dump
// rewriting the first param (handle column) to scratchHandle so rows land in
// our isolated namespace.
// --------------------------------------------------------------------------

async function buildMysqlTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds }) {
    if (!scratchCreds?.mysqlUrl) {
        throw new Error('transient mysql source: scratchCreds.mysqlUrl is required');
    }
    const scratchDirs = buildScratchDirs(scratchRoot);
    ensureScratchDirs(scratchDirs);
    await extractZipTreeToScratch(zipPath, scratchRoot);

    const engine = new MysqlEngine({
        url: scratchCreds.mysqlUrl,
        poolSize: scratchCreds.mysqlPoolSize,
    });
    try {
        await engine.ping();
    } catch (err) {
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw new CrossModeScratchConnectionError('mysql', err);
    }

    // Stream the dump from the ZIP, rewriting handle on each NDJSON line.
    const dumpStream = await openEngineDumpStream(zipPath);
    if (!dumpStream) {
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw new Error(`transient mysql source: backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
    }
    const rewritten = rewriteHandleInDumpStream(dumpStream, scratchHandle);
    try {
        await engine.restoreUser(scratchHandle, rewritten);
    } catch (err) {
        try { await engine.deleteUser(scratchHandle); } catch { /* best-effort */ }
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw err;
    }

    let cleanedUp = false;
    return {
        engine,
        scratchHandle,
        scratchDirs,
        async cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            try { await engine.deleteUser(scratchHandle); } catch { /* best-effort */ }
            try { await engine.close(); } catch { /* best-effort */ }
            await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        },
    };
}

// --------------------------------------------------------------------------
// postgres source: same shape as mysql, swapping engine class.
// --------------------------------------------------------------------------

async function buildPgTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds }) {
    if (!scratchCreds?.postgresUrl) {
        throw new Error('transient postgres source: scratchCreds.postgresUrl is required');
    }
    const scratchDirs = buildScratchDirs(scratchRoot);
    ensureScratchDirs(scratchDirs);
    await extractZipTreeToScratch(zipPath, scratchRoot);

    const engine = new PgEngine({
        url: scratchCreds.postgresUrl,
        poolSize: scratchCreds.postgresPoolSize,
    });
    try {
        await engine.ping();
    } catch (err) {
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw new CrossModeScratchConnectionError('postgres', err);
    }

    const dumpStream = await openEngineDumpStream(zipPath);
    if (!dumpStream) {
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw new Error(`transient postgres source: backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
    }
    const rewritten = rewriteHandleInDumpStream(dumpStream, scratchHandle);
    try {
        await engine.restoreUser(scratchHandle, rewritten);
    } catch (err) {
        try { await engine.deleteUser(scratchHandle); } catch { /* best-effort */ }
        try { await engine.close(); } catch { /* best-effort */ }
        await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        throw err;
    }

    let cleanedUp = false;
    return {
        engine,
        scratchHandle,
        scratchDirs,
        async cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            try { await engine.deleteUser(scratchHandle); } catch { /* best-effort */ }
            try { await engine.close(); } catch { /* best-effort */ }
            await fsPromises.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
        },
    };
}

// --------------------------------------------------------------------------
// Zip helpers
// --------------------------------------------------------------------------

/**
 * Walk the ZIP and extract every entry whose name is NOT one of the engine
 * sentinels (_engine_meta.json, _engine_dump.bin) and NOT manifest.json into
 * `scratchRoot`. Directory entries auto-create. Path-traversal entries
 * (containing `..` or absolute) are rejected.
 */
function extractZipTreeToScratch(zipPath, scratchRoot) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr) return reject(openErr);
            let finished = false;
            const finish = (err) => {
                if (finished) return;
                finished = true;
                if (err) reject(err); else resolve();
            };
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                (async () => {
                    const name = entry.fileName;
                    if (name === ENGINE_META_ENTRY || name === ENGINE_DUMP_ENTRY || name === 'manifest.json') {
                        zipfile.readEntry();
                        return;
                    }
                    if (name.endsWith('/')) {
                        // Directory entry — create and move on.
                        const dir = safeJoin(scratchRoot, name);
                        if (dir) await fsPromises.mkdir(dir, { recursive: true });
                        zipfile.readEntry();
                        return;
                    }
                    const target = safeJoin(scratchRoot, name);
                    if (!target) {
                        // Path traversal attempt — skip.
                        zipfile.readEntry();
                        return;
                    }
                    await fsPromises.mkdir(path.dirname(target), { recursive: true });
                    zipfile.openReadStream(entry, async (streamErr, readStream) => {
                        if (streamErr) return finish(streamErr);
                        try {
                            await pipeline(readStream, fs.createWriteStream(target, { mode: 0o644 }));
                            zipfile.readEntry();
                        } catch (writeErr) {
                            finish(writeErr);
                        }
                    });
                })().catch(finish);
            });
            zipfile.on('end', () => finish());
            zipfile.on('error', finish);
        });
    });
}

/**
 * Open a read stream over the ZIP's `_engine_dump.bin` entry, or resolve to
 * null when the entry is absent.
 */
function openEngineDumpStream(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr) return reject(openErr);
            let settled = false;
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (entry.fileName !== ENGINE_DUMP_ENTRY) {
                    zipfile.readEntry();
                    return;
                }
                zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (settled) return;
                    settled = true;
                    if (streamErr) {
                        try { zipfile.close(); } catch { /* best-effort */ }
                        return reject(streamErr);
                    }
                    // Keep the zipfile alive until the consumer drains the
                    // stream; close it on stream end / error.
                    readStream.on('end', () => { try { zipfile.close(); } catch {} });
                    readStream.on('error', () => { try { zipfile.close(); } catch {} });
                    resolve(readStream);
                });
            });
            zipfile.on('end', () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            });
            zipfile.on('error', (err) => {
                if (!settled) { settled = true; reject(err); }
            });
        });
    });
}

/**
 * Extract `_engine_dump.bin` from the ZIP and write it to `destPath`.
 * Returns true if the entry was found and written, false otherwise.
 */
async function extractEngineDumpToFile(zipPath, destPath) {
    const stream = await openEngineDumpStream(zipPath);
    if (!stream) return false;
    await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(stream, fs.createWriteStream(destPath));
    return true;
}

/**
 * Stream-transform a `{sql, params}` NDJSON dump so that the FIRST element of
 * every params array (always the source handle, by DUMP_TABLES contract) is
 * replaced with `scratchHandle`. The transform preserves CJK / emoji content
 * by re-encoding each parsed line as UTF-8 JSON.
 */
function rewriteHandleInDumpStream(source, scratchHandle) {
    async function* transform() {
        const decoder = new StringDecoder('utf8');
        let buf = '';
        for await (const chunk of source) {
            buf += decoder.write(chunk);
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                yield rewriteHandleInLine(line, scratchHandle) + '\n';
            }
        }
        buf += decoder.end();
        const tail = buf.trim();
        if (tail) yield rewriteHandleInLine(tail, scratchHandle) + '\n';
    }
    return Readable.from(transform());
}

function rewriteHandleInLine(line, scratchHandle) {
    const obj = JSON.parse(line);
    if (Array.isArray(obj.params) && obj.params.length > 0) {
        // Every DUMP_TABLES row begins with `handle` per
        // src/storage/engines/mysql-engine.js and postgres-engine.js.
        obj.params = [scratchHandle, ...obj.params.slice(1)];
    }
    return JSON.stringify(obj);
}

/**
 * Resolve `entryName` (relative path with forward slashes) against
 * `scratchRoot`, refusing absolute or traversing paths.
 */
function safeJoin(scratchRoot, entryName) {
    if (typeof entryName !== 'string' || entryName.length === 0) return null;
    if (entryName.startsWith('/') || entryName.includes('\0')) return null;
    const normalized = path.normalize(entryName).replace(/^([./\\])+/, '');
    if (!normalized || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return null;
    const target = path.resolve(scratchRoot, normalized);
    const root = path.resolve(scratchRoot);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return target;
}
