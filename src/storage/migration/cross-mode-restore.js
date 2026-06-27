// Cross-mode restore orchestrator. Called by restoreUserBackupArchive when
// engineMeta.engineKind !== currentEngine.kind. See
// docs/superpowers/specs/2026-06-26-cross-mode-backup-recovery-design.md §5.2.
//
// Flow:
//   1. acquireMigrationLock + setReadOnly(true)
//   2. snapshot live destination (overwrite mode only) — so a failure can roll back
//   3. materializeTransientSource(engineMeta, zip, scratchCreds) — build a live
//      source engine instance populated from the ZIP's dump
//   4. MigrationRunner(transient→liveEngine, categories=selectionToRunnerCategories,
//      skipInternalSnapshot=true, destHandle=realHandle).migrateUser(scratchHandle)
//   5. extractFsTreeCategories(zip, dirs, selection) — secrets/characters/etc.
//   6. transient.cleanup() — drop scratch dir / scratch DB rows
//   7. removeSnapshot (on success) or restoreFromSnapshot (on failure)
//   8. setReadOnly(false) + releaseMigrationLock
//
// Errors are surfaced as typed errors so the route handler maps to 400/500.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

import { ChatRepo } from '../repositories/chat-repo.js';
import { SettingsRepo } from '../repositories/settings-repo.js';
import { PresetRepo } from '../repositories/preset-repo.js';
import { WorldInfoRepo } from '../repositories/world-info-repo.js';
import { NamedDocRepo } from '../repositories/named-doc-repo.js';
import { GroupRepo } from '../repositories/group-repo.js';
import { StatsRepo } from '../repositories/stats-repo.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY, SCRATCH_HANDLE_PREFIX } from '../engine-backup-entries.js';
import { setReadOnly } from '../read-only-mode.js';
import { MigrationRunner } from './runner.js';
import { snapshotUser, restoreFromSnapshot, removeSnapshot } from './backup.js';
import { acquireMigrationLock, releaseMigrationLock, makeHolderId, startHeartbeat, stopHeartbeat } from './lock.js';
import { materializeTransientSource } from './transient-source.js';
import { selectionToRunnerCategories, FS_TREE_CATEGORIES } from './selection-mapping.js';
import {
    CrossModeScratchCredsRequiredError,
    CrossModeScratchConnectionError,
    CrossModeConversionFailedError,
} from './cross-mode-errors.js';

const CONVERT_STAGES = [
    'snapshotted', 'settings-copied', 'presets-copied', 'worlds-copied',
    'chats-copied', 'named-docs-copied', 'groups-copied', 'stats-copied',
    'verifying', 'verified', 'done',
];

/**
 * @typedef {object} CrossModeRestoreOpts
 * @property {string} dataRoot
 * @property {object} currentEngine
 * @property {Function} [getUserDirectories]   — directoriesByHandle factory for the live engine.
 * @property {(event: object) => void} [onProgress]
 * @property {{ mysqlUrl?: string, postgresUrl?: string, mysqlPoolSize?: number, postgresPoolSize?: number }} [scratchCreds]
 */

/**
 * @param {string} zipPath
 * @param {{ engineKind: string, handle?: string }} engineMeta
 * @param {object} dirs        Live user's `directories` object (must have `.root`).
 * @param {object} selection   10-key backup-category selection.
 * @param {'merge'|'overwrite'} mode
 * @param {CrossModeRestoreOpts} opts
 */
export async function crossModeRestore(zipPath, engineMeta, dirs, selection, mode, opts) {
    const { dataRoot, currentEngine, onProgress, scratchCreds } = opts;
    if (!zipPath) throw new Error('crossModeRestore: zipPath is required');
    if (!engineMeta?.engineKind) throw new Error('crossModeRestore: engineMeta.engineKind is required');
    if (!dirs?.root) throw new Error('crossModeRestore: dirs.root is required');
    if (!currentEngine?.kind) throw new Error('crossModeRestore: currentEngine is required');
    if (!dataRoot) throw new Error('crossModeRestore: dataRoot is required');

    const handle = path.basename(dirs.root);
    const backupRoot = path.join(dataRoot, '_storage-migrations');
    fs.mkdirSync(backupRoot, { recursive: true });

    // Gate: if backup is from mysql/pg, the operator must supply a scratch DB
    // connection string. This is a 400, not a 500 — the UI prompts and retries.
    if (engineMeta.engineKind === 'mysql' && !scratchCreds?.mysqlUrl) {
        throw new CrossModeScratchCredsRequiredError('mysql');
    }
    if (engineMeta.engineKind === 'postgres' && !scratchCreds?.postgresUrl) {
        throw new CrossModeScratchCredsRequiredError('postgres');
    }

    const scratchHandle = SCRATCH_HANDLE_PREFIX + crypto.randomBytes(16).toString('hex');
    const holderId = makeHolderId();
    const startedAt = Date.now();

    let snapshotPath = null;
    let transient = null;
    let heartbeat = null;
    const lockAcquired = await tryAcquireLock(dataRoot, holderId);
    if (!lockAcquired.ok) {
        // Bubble the lock contention up so the route returns 409.
        const err = new Error(lockAcquired.message);
        err.code = 'MIGRATION_LOCKED';
        throw err;
    }
    heartbeat = startHeartbeat({ dataRoot, holderId });
    setReadOnly(true);

    // Ensure the live user dir exists before snapshotting — snapshotUser
    // throws if userRoot is missing (e.g. fresh user dir, CLI ingest into a
    // brand-new handle). Treat missing dir as "nothing to snapshot" but
    // still create it so the subsequent extract has a target.
    if (!fs.existsSync(dirs.root)) {
        fs.mkdirSync(dirs.root, { recursive: true });
    }

    let cleanupWarning = null;
    try {
        // 1. Snapshot live destination (overwrite mode only — merge mode
        //    intentionally has no rollback per spec §4.2/4.3).
        if (mode === 'overwrite') {
            try {
                snapshotPath = await snapshotUser({
                    handle,
                    userRoot: dirs.root,
                    backupRoot,
                    engine: currentEngine,
                });
            } catch (err) {
                throw new CrossModeConversionFailedError(err, {
                    rollback: 'merge-no-snapshot',
                    snapshotPath: null,
                });
            }
        }

        // 2. Materialize transient source engine populated from the ZIP.
        transient = await materializeTransientSource(engineMeta, zipPath, {
            dataRoot, scratchHandle, scratchCreds,
        });

        // 3. MigrationRunner: scratch source → live destination.
        const sourceRepos = buildRepos(transient.engine);
        const destRepos = buildRepos(currentEngine);
        const runner = new MigrationRunner({
            sourceRepos,
            sourceEngine: transient.engine,
            destRepos,
            snapshotPaths: {
                dataRoot,
                backupRoot,
                getUserRoot: () => transient.scratchDirs.root,
            },
            categories: selectionToRunnerCategories(selection),
            skipInternalSnapshot: true,
        });

        const migrationStats = await runner.migrateUser(scratchHandle, {
            destHandle: handle,
            onProgress: (event) => {
                if (!onProgress || !event?.stage) return;
                try {
                    onProgress({ phase: 'convert', stage: event.stage, counts: event.counts }); // banned-words-allow
                } catch { /* sink errors */ }
            },
        });

        // 4. Extract fs-tree categories straight into the live user's dirs.
        const extractResult = await extractFsTreeCategories(zipPath, dirs, selection, {
            includeGlobalExtensions: !!opts.includeGlobalExtensions,
            onProgress,
        });

        // 5. Success: drop the snapshot and tear down the transient.
        if (snapshotPath) {
            try { removeSnapshot(snapshotPath); } catch { /* preserve on rm failure */ }
            snapshotPath = null;
        }
        try {
            await transient.cleanup();
        } catch (err) {
            cleanupWarning = err instanceof Error ? err.message : String(err);
        }
        transient = null;

        return {
            restoredCount: extractResult.restoredCount,
            failedCount: extractResult.failedCount,
            crossMode: {
                sourceKind: engineMeta.engineKind,
                destKind: currentEngine.kind,
                scratchHandle,
                durationMs: Date.now() - startedAt,
                converted: {
                    settings: migrationStats.settings,
                    presets: migrationStats.presets,
                    preset_states: migrationStats.preset_states,
                    worlds: migrationStats.worlds,
                    chats: migrationStats.chats,
                    chat_states: migrationStats.chat_states,
                    named_docs: migrationStats.named_docs,
                    groups: migrationStats.groups,
                    stats: migrationStats.stats,
                },
                cleanupWarning,
            },
        };
    } catch (err) {
        // Rollback path. Three states:
        //   - overwrite + snapshot exists  → restore live dest from snapshot
        //   - merge (no snapshot)          → cannot roll back, surface warning
        //   - rollback itself fails        → CCFE.partial with snapshotPath
        // Always try to clean up the transient last so a leaked scratch
        // doesn't survive the failure.
        //
        // Don't re-wrap if `err` is already a typed cross-mode error: those
        // carry their own HTTP code (400 for creds/connection, 500 for the
        // generic conversion failure). Wrapping a creds-required error in a
        // generic conversion failure would silently degrade it to 500 and
        // lose the structured payload the UI uses to prompt the operator.
        if (err instanceof CrossModeConversionFailedError
            || err instanceof CrossModeScratchCredsRequiredError
            || err instanceof CrossModeScratchConnectionError) {
            if (transient) {
                try { await transient.cleanup(); } catch { /* best-effort */ }
            }
            // Restore snapshot before re-throwing typed errors that don't
            // signal a partial rollback themselves — otherwise the dest
            // might already have been partially mutated.
            if (snapshotPath) {
                try {
                    await restoreFromSnapshot({
                        handle,
                        userRoot: dirs.root,
                        backupPath: snapshotPath,
                        engine: currentEngine,
                    });
                } catch { /* best-effort */ }
            }
            throw err;
        }
        if (snapshotPath) {
            try {
                await restoreFromSnapshot({
                    handle,
                    userRoot: dirs.root,
                    backupPath: snapshotPath,
                    engine: currentEngine,
                });
                if (transient) {
                    try { await transient.cleanup(); } catch { /* best-effort */ }
                }
                throw new CrossModeConversionFailedError(err, {
                    rollback: 'ok',
                    snapshotPath,
                });
            } catch (rbErr) {
                if (rbErr instanceof CrossModeConversionFailedError) throw rbErr;
                if (transient) {
                    try { await transient.cleanup(); } catch { /* best-effort */ }
                }
                throw new CrossModeConversionFailedError(err, {
                    rollback: 'partial',
                    rollbackError: rbErr,
                    snapshotPath,
                });
            }
        }
        if (transient) {
            try { await transient.cleanup(); } catch { /* best-effort */ }
        }
        throw new CrossModeConversionFailedError(err, {
            rollback: 'merge-no-snapshot',
            snapshotPath: null,
        });
    } finally {
        try { setReadOnly(false); } catch { /* best-effort */ }
        if (heartbeat) {
            try { stopHeartbeat(heartbeat); } catch { /* best-effort */ }
        }
        try { await releaseMigrationLock({ dataRoot, holderId }); } catch { /* best-effort */ }
    }
}

function buildRepos(engine) {
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

async function tryAcquireLock(dataRoot, holderId) {
    try {
        await acquireMigrationLock({ dataRoot, holderId });
        return { ok: true };
    } catch (err) {
        return { ok: false, message: err?.message || String(err) };
    }
}

/**
 * Stream-extract entries from `zipPath` into the live user's `dirs`, restricted
 * to the FS_TREE_CATEGORIES the user selected. Engine sentinels and
 * non-selected paths are skipped. Returns `{restoredCount, failedCount}`.
 *
 * This is independent of users-private.js's restoreUserBackupArchive on
 * purpose: that function handles the same-mode path end-to-end (including
 * engine dump replay) and intermixes db-side work; cross-mode wants ONLY
 * fs-tree extracts, since the db-side has already been handled by
 * MigrationRunner.
 *
 * @param {string} zipPath
 * @param {object} dirs            Live user directories object (root + per-category subdirs).
 * @param {object} selection
 * @param {{ includeGlobalExtensions?: boolean, onProgress?: Function }} opts
 */
export async function extractFsTreeCategories(zipPath, dirs, selection, opts = {}) {
    const includeGlobalExtensions = !!opts.includeGlobalExtensions;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    // Build the set of category names we'll honor, then the per-category
    // prefix → target-dir map. We resolve a few category-to-relpath
    // mappings here (matching USER_DIRECTORY_TEMPLATE keys + the
    // categories that span multiple subdirs).
    const enabled = new Set();
    for (const cat of FS_TREE_CATEGORIES) {
        if (cat === 'globalExtensions' && !includeGlobalExtensions) continue;
        if (selection?.[cat]) enabled.add(cat);
    }
    if (enabled.size === 0) {
        return { restoredCount: 0, failedCount: 0 };
    }

    // Each entry: { prefix: zip-entry-prefix (relative, posix), targetDir: absolute }.
    // Empty prefix means "exact filename" (settings.json, secrets.json, stats.json
    // — single-file categories).
    const rules = buildFsTreeRules(enabled, dirs);
    if (rules.length === 0) {
        return { restoredCount: 0, failedCount: 0 };
    }

    let restoredCount = 0;
    let failedCount = 0;
    let extractTotal = 0;
    let lastProgressAt = 0;
    const reportProgress = (current, total, force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        try {
            onProgress({ phase: 'extract', current, total }); // banned-words-allow
        } catch { /* sink errors */ }
    };

    await new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr) return reject(openErr);
            extractTotal = typeof zipfile.entryCount === 'number' ? zipfile.entryCount : 0;
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
                    // Skip sentinels + manifest + directory entries; engine dump
                    // is consumed by transient source, not extracted here.
                    if (name === ENGINE_META_ENTRY || name === ENGINE_DUMP_ENTRY || name === 'manifest.json') {
                        zipfile.readEntry();
                        return;
                    }
                    if (name.endsWith('/')) {
                        zipfile.readEntry();
                        return;
                    }
                    const target = matchFsTreeRule(name, rules);
                    if (!target) {
                        zipfile.readEntry();
                        return;
                    }
                    await fsPromises.mkdir(path.dirname(target), { recursive: true });
                    zipfile.openReadStream(entry, async (streamErr, readStream) => {
                        if (streamErr) return finish(streamErr);
                        try {
                            await pipeline(readStream, fs.createWriteStream(target, { mode: 0o644 }));
                            restoredCount += 1;
                            reportProgress(restoredCount + failedCount, extractTotal, false);
                            zipfile.readEntry();
                        } catch (writeErr) {
                            failedCount += 1;
                            reportProgress(restoredCount + failedCount, extractTotal, true);
                            finish(writeErr);
                        }
                    });
                })().catch(finish);
            });
            zipfile.on('end', () => finish());
            zipfile.on('error', finish);
        });
    });

    reportProgress(restoredCount + failedCount, extractTotal, true);
    return { restoredCount, failedCount };
}

/**
 * Build the per-category prefix→target-dir rules. Each rule has:
 *   - prefix: posix-style zip entry prefix (e.g. 'chats/', 'secrets.json')
 *   - targetDir: absolute path the suffix is appended to (for prefix-based
 *                rules) or the absolute file path (for exact-name rules)
 *   - exact:    true when prefix matches the whole entry name (no suffix).
 *
 * The category→prefix map mirrors getUserBackupTargets in src/users.js.
 */
function buildFsTreeRules(enabled, dirs) {
    const rules = [];
    if (enabled.has('secrets')) {
        rules.push({ prefix: 'secrets.json', targetPath: path.resolve(dirs.root, 'secrets.json'), exact: true });
    }
    if (enabled.has('characters')) {
        rules.push({ prefix: 'characters/', targetDir: path.resolve(dirs.characters), exact: false });
        rules.push({ prefix: 'User Avatars/', targetDir: path.resolve(dirs.avatars), exact: false });
        rules.push({ prefix: 'backgrounds/', targetDir: path.resolve(dirs.backgrounds), exact: false });
    }
    if (enabled.has('assets')) {
        rules.push({ prefix: 'assets/', targetDir: path.resolve(dirs.assets), exact: false });
        rules.push({ prefix: 'user/files/', targetDir: path.resolve(dirs.files), exact: false });
        rules.push({ prefix: 'user/images/', targetDir: path.resolve(dirs.userImages), exact: false });
        rules.push({ prefix: 'user/workflows/', targetDir: path.resolve(dirs.comfyWorkflows), exact: false });
    }
    if (enabled.has('extensions')) {
        rules.push({ prefix: 'extensions/', targetDir: path.resolve(dirs.extensions), exact: false });
    }
    if (enabled.has('vectors')) {
        rules.push({ prefix: 'vectors/', targetDir: path.resolve(dirs.vectors), exact: false });
    }
    if (enabled.has('globalExtensions')) {
        // globalExtensions targets a process-global dir, NOT a per-user one.
        // We rely on the live runtime's PUBLIC_DIRECTORIES.globalExtensions.
        // To avoid pulling it through the import chain here (this module prefers
        // to stay self-contained) we expose the rule via dirs.globalExtensions
        // if the caller passed it; otherwise skip silently.
        if (dirs.globalExtensions) {
            rules.push({ prefix: 'public/scripts/extensions/third-party/', targetDir: path.resolve(dirs.globalExtensions), exact: false });
            rules.push({ prefix: 'scripts/extensions/third-party/', targetDir: path.resolve(dirs.globalExtensions), exact: false });
            rules.push({ prefix: 'extensions/third-party/', targetDir: path.resolve(dirs.globalExtensions), exact: false });
            rules.push({ prefix: 'third-party/', targetDir: path.resolve(dirs.globalExtensions), exact: false });
        }
    }
    return rules;
}

function matchFsTreeRule(zipEntryName, rules) {
    // Refuse traversal-style entries.
    if (zipEntryName.includes('..') || zipEntryName.startsWith('/') || zipEntryName.includes('\0')) {
        return null;
    }
    for (const rule of rules) {
        if (rule.exact) {
            if (zipEntryName === rule.prefix) return rule.targetPath;
            continue;
        }
        if (zipEntryName.startsWith(rule.prefix)) {
            const suffix = zipEntryName.slice(rule.prefix.length);
            if (!suffix) continue;
            const resolved = path.resolve(rule.targetDir, suffix);
            const root = path.resolve(rule.targetDir);
            if (resolved !== root && !resolved.startsWith(root + path.sep)) {
                // Sandbox check — refuse anything that resolves outside.
                continue;
            }
            return resolved;
        }
    }
    return null;
}

export const _internals = {
    CONVERT_STAGES,
    buildFsTreeRules,
    matchFsTreeRule,
};
