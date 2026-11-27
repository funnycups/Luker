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
// Every engine dump carries the ORIGINAL source handle in its rows. The
// engines' `restoreUser` validates the dump and writes its rows under the
// handle it is given, so the rows land in the isolated scratchHandle
// namespace and tear down cleanly via deleteUser. An invalid dump throws
// `RestoreDumpInvalidError` before the source is used.

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

import { FsEngine } from '../engines/fs-engine.js';
import { SqliteEngine, assertValidSqliteFile, rewriteSqliteHandle } from '../engines/sqlite-engine.js';
import { MysqlEngine } from '../engines/mysql-engine.js';
import { PgEngine } from '../engines/postgres-engine.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY, SCRATCH_HANDLE_PREFIX } from '../engine-backup-entries.js';
import { USER_DIRECTORY_TEMPLATE } from '../../constants.js';
import { CrossModeScratchConnectionError } from './cross-mode-errors.js';
import { RestoreDumpInvalidError } from '../errors.js';

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
async function removeScratchRoot(scratchRoot) {
    try {
        await fsPromises.rm(scratchRoot, { recursive: true, force: true });
    } catch (rmErr) {
        if (rmErr?.code !== 'ENOENT') {
            console.error(`[transient-source] Failed to remove scratch directory "${scratchRoot}":`, rmErr);
        }
    }
}

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

    if (!['fs', 'sqlite', 'mysql', 'postgres'].includes(kind)) {
        throw new Error(`materializeTransientSource: unsupported engineKind "${kind}"`);
    }

    const scratchRoot = path.join(dataRoot, '_storage-migrations', scratchHandle);
    await fsPromises.mkdir(scratchRoot, { recursive: true });

    try {
        if (kind === 'fs') return await buildFsTransient({ scratchRoot, scratchHandle, zipPath });
        if (kind === 'sqlite') return await buildSqliteTransient({ scratchRoot, scratchHandle, zipPath });
        if (kind === 'mysql') return await buildMysqlTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds });
        return await buildPgTransient({ scratchRoot, scratchHandle, zipPath, scratchCreds });
    } catch (err) {
        await removeScratchRoot(scratchRoot);
        throw err;
    }
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

async function runCleanupSteps(contextLabel, steps) {
    const errors = [];
    for (const { label, run } of steps) {
        try {
            await run();
        } catch (err) {
            console.error(`[transient-source] ${contextLabel} ${label} failed:`, err);
            errors.push(`${label}: ${err?.message || String(err)}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`${contextLabel} cleanup failed (${errors.join('; ')})`);
    }
}

async function removeScratchDir(scratchRoot) {
    try {
        await fsPromises.rm(scratchRoot, { recursive: true, force: true });
    } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
    }
}

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
            await runCleanupSteps('fs transient', [
                { label: 'engine.close', run: () => engine.close() },
                { label: 'remove scratchRoot', run: () => removeScratchDir(scratchRoot) },
            ]);
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
        throw new RestoreDumpInvalidError(`sqlite backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
    }
    await assertValidSqliteFile(dumpDest);
    // The SqliteEngine queries `WHERE handle = ?` with scratchHandle, and
    // the dump's rows still carry the source's original handle.
    rewriteSqliteHandle(dumpDest, scratchHandle);

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
            await runCleanupSteps('sqlite transient', [
                { label: 'engine.close', run: () => engine.close() },
                { label: 'remove scratchRoot', run: () => removeScratchDir(scratchRoot) },
            ]);
        },
    };
}

// --------------------------------------------------------------------------
// mysql source: connect to operator-supplied scratch DB and restore the dump
// under scratchHandle.
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
    let dumpStream = null;
    let restoreStarted = false;
    try {
        try {
            await engine.ping();
        } catch (err) {
            throw new CrossModeScratchConnectionError('mysql', err);
        }

        dumpStream = await openEngineDumpStream(zipPath);
        if (!dumpStream) {
            throw new RestoreDumpInvalidError(`mysql backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
        }
        restoreStarted = true;
        await engine.restoreUser(scratchHandle, dumpStream);
    } catch (err) {
        if (dumpStream && !dumpStream.destroyed) {
            try { dumpStream.destroy(); } catch (destroyErr) { console.error('[transient-source] mysql dumpStream.destroy failed:', destroyErr); }
        }
        if (restoreStarted) {
            try { await engine.deleteUser(scratchHandle); } catch (delErr) { console.error('[transient-source] mysql rollback deleteUser failed:', delErr); }
        }
        try { await engine.close(); } catch (closeErr) { console.error('[transient-source] mysql rollback engine.close failed:', closeErr); }
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
            await runCleanupSteps('mysql transient', [
                { label: 'engine.deleteUser', run: () => engine.deleteUser(scratchHandle) },
                { label: 'engine.close', run: () => engine.close() },
                { label: 'remove scratchRoot', run: () => removeScratchDir(scratchRoot) },
            ]);
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
    let dumpStream = null;
    let restoreStarted = false;
    try {
        try {
            await engine.ping();
        } catch (err) {
            throw new CrossModeScratchConnectionError('postgres', err);
        }

        dumpStream = await openEngineDumpStream(zipPath);
        if (!dumpStream) {
            throw new RestoreDumpInvalidError(`postgres backup ZIP is missing ${ENGINE_DUMP_ENTRY}`);
        }
        restoreStarted = true;
        await engine.restoreUser(scratchHandle, dumpStream);
    } catch (err) {
        if (dumpStream && !dumpStream.destroyed) {
            try { dumpStream.destroy(); } catch (destroyErr) { console.error('[transient-source] postgres dumpStream.destroy failed:', destroyErr); }
        }
        if (restoreStarted) {
            try { await engine.deleteUser(scratchHandle); } catch (delErr) { console.error('[transient-source] postgres rollback deleteUser failed:', delErr); }
        }
        try { await engine.close(); } catch (closeErr) { console.error('[transient-source] postgres rollback engine.close failed:', closeErr); }
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
            await runCleanupSteps('postgres transient', [
                { label: 'engine.deleteUser', run: () => engine.deleteUser(scratchHandle) },
                { label: 'engine.close', run: () => engine.close() },
                { label: 'remove scratchRoot', run: () => removeScratchDir(scratchRoot) },
            ]);
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
                if (err) {
                    try { zipfile.close(); } catch { /* best-effort */ }
                    reject(err);
                } else {
                    resolve();
                }
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
                            if (!readStream.destroyed) {
                                readStream.on('error', () => {});
                                readStream.destroy();
                            }
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
 * Open a read stream over the ZIP's `_engine_dump.bin` entry along with an
 * idempotent closer for the underlying zipfile, or resolve to null when absent.
 */
function openEngineDumpEntry(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr) return reject(openErr);
            let settled = false;
            let zipClosed = false;
            const closeZip = () => {
                if (zipClosed) return;
                zipClosed = true;
                try { zipfile.close(); } catch { /* already closed */ }
            };
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
                        closeZip();
                        return reject(streamErr);
                    }
                    // Keep the zipfile alive until the consumer drains or
                    // destroys the stream; close it on end / error / close.
                    readStream.once('end', closeZip);
                    readStream.once('error', closeZip);
                    readStream.once('close', closeZip);
                    resolve({ stream: readStream, closeZip });
                });
            });
            zipfile.on('end', () => {
                if (!settled) {
                    settled = true;
                    closeZip();
                    resolve(null);
                }
            });
            zipfile.on('error', (err) => {
                closeZip();
                if (!settled) { settled = true; reject(err); }
            });
        });
    });
}

/**
 * Open a read stream over the ZIP's `_engine_dump.bin` entry, or resolve to
 * null when the entry is absent.
 */
async function openEngineDumpStream(zipPath) {
    const opened = await openEngineDumpEntry(zipPath);
    return opened ? opened.stream : null;
}

/**
 * Extract `_engine_dump.bin` from the ZIP and write it to `destPath`.
 * Returns true if the entry was found and written, false otherwise.
 */
async function extractEngineDumpToFile(zipPath, destPath) {
    const opened = await openEngineDumpEntry(zipPath);
    if (!opened) return false;
    const { stream, closeZip } = opened;
    try {
        await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
        await pipeline(stream, fs.createWriteStream(destPath));
        return true;
    } catch (err) {
        if (!stream.destroyed) {
            stream.on('error', () => {});
            stream.destroy();
        }
        closeZip();
        throw err;
    }
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
