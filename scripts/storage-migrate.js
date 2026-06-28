#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// storage-migrate — headless CLI front-end for MigrationRunner.
//
// Use this when you need to copy a user's per-handle state between any pair
// of storage engines (fs / sqlite / mysql / postgres) without going through
// the admin web UI — e.g. on a headless container, during automated
// provisioning, or to perform a dry-run audit of source data before
// swapping backends.
//
// The script does NOT mutate config.yaml. After a successful migration the
// operator edits `storage.mode` and restarts the server so the live engine
// picks up the new backend.

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Argument parsing — kept import-free + side-effect-free so `--help`, missing
// args, etc. exit immediately without dragging in node-persist, config.yaml,
// better-sqlite3 native bindings, or anything else from the server modules.
// The CLI test suite leans on this: it spawns the script with various arg
// combinations and asserts on exit codes / stderr.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {
        from: null,
        to: null,
        handle: null,
        dryRun: false,
        help: false,
        mysqlUrl: null,
        mysqlPoolSize: null,
        postgresUrl: null,
        postgresPoolSize: null,
        fromZip: null,
        mode: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--from') args.from = argv[++i];
        else if (arg === '--to') args.to = argv[++i];
        else if (arg === '--handle') args.handle = argv[++i];
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--mysql-url') args.mysqlUrl = argv[++i];
        else if (arg === '--mysql-pool-size') args.mysqlPoolSize = Number(argv[++i]);
        else if (arg === '--postgres-url') args.postgresUrl = argv[++i];
        else if (arg === '--postgres-pool-size') args.postgresPoolSize = Number(argv[++i]);
        else if (arg === '--from-zip') args.fromZip = argv[++i];
        else if (arg === '--mode') args.mode = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function printHelp() {
    console.log(`storage-migrate — migrate Luker user data between storage backends

Usage:
  node scripts/storage-migrate.js --from <mode> --to <mode> [options]

Modes:
  fs                     Per-user JSON/JSONL files on disk
  sqlite                 Per-user better-sqlite3 database
  mysql                  Shared MySQL 8.0+ database keyed by handle
  postgres               Shared PostgreSQL 14+ database keyed by handle

Options:
  --from <mode>          Source engine (required)
  --to <mode>            Destination engine (required)
  --handle <handle>      Migrate only a specific user handle (default: all users)
  --dry-run              Enumerate + verify source data without writing destination or taking a backup
  --mysql-url <url>      MySQL connection string (required if --from=mysql or --to=mysql,
                         unless storage.mysql.url is already set in config.yaml)
  --mysql-pool-size <n>  MySQL pool size (default: storage.mysql.poolSize or 10)
  --postgres-url <url>   PostgreSQL connection string (same rule as --mysql-url)
  --postgres-pool-size <n> PostgreSQL pool size (default: storage.postgres.poolSize or 10)
  --from-zip <path>      Cross-mode restore: ingest a backup ZIP into the live storage
                         engine (declared in config.yaml). Source engine is read from
                         the ZIP's _engine_meta.json. When the source is mysql/postgres,
                         also pass --mysql-url / --postgres-url for the scratch DB.
  --mode <merge|overwrite> Restore mode for --from-zip (default: overwrite, which takes
                         a snapshot before restore so a failure can roll back).
  --handle <handle>      Target handle for --from-zip (default: source handle from ZIP)
  --help, -h             Show this message

Examples:
  node scripts/storage-migrate.js --from fs --to sqlite
  node scripts/storage-migrate.js --from sqlite --to fs --handle alice --dry-run
  node scripts/storage-migrate.js --from fs --to mysql --mysql-url mysql://luker:pw@db:3306/luker
  node scripts/storage-migrate.js --from-zip ./backup.zip --handle alice
  node scripts/storage-migrate.js --from-zip ./mysql-backup.zip --handle alice \\
      --mysql-url mysql://luker:pw@scratch:3306/luker_scratch

Behavior:
  Backup of each user's source state is written to <dataRoot>/_storage-migrations/<timestamp>-<handle>/
  before any destination writes. Backups are never deleted automatically.

  This script does NOT swap the active storage.mode in config.yaml. After a successful migration,
  edit your config.yaml and restart the server to use the new backend.
`);
}

const VALID_MODES = ['fs', 'sqlite', 'mysql', 'postgres'];

function validateArgs(args) {
    // Validation order matters: --help short-circuits everything else (already
    // handled by the caller); after that we surface the most operator-useful
    // hint per call rather than dumping every problem at once.

    // --from-zip is a separate mode: ingest a ZIP into the live engine
    // (declared in config.yaml). It does NOT require --from/--to but does
    // require either --handle or the ZIP to carry a source handle in meta.
    if (args.fromZip) {
        if (args.from || args.to) {
            return { ok: false, message: '--from-zip is mutually exclusive with --from / --to.' };
        }
        if (args.dryRun) {
            return { ok: false, message: '--dry-run is not supported for --from-zip.' };
        }
        if (args.mode && args.mode !== 'merge' && args.mode !== 'overwrite') {
            return { ok: false, message: '--mode must be merge or overwrite.' };
        }
        return { ok: true };
    }

    if (!args.from || !args.to) {
        return { ok: false, message: 'Both --from and --to are required (or use --from-zip).' };
    }
    if (!VALID_MODES.includes(args.from) || !VALID_MODES.includes(args.to)) {
        return {
            ok: false,
            message: `--from and --to must be one of: ${VALID_MODES.join(', ')} (got --from=${args.from} --to=${args.to})`,
        };
    }
    if (args.from === args.to) {
        return { ok: false, message: '--from and --to must differ.' };
    }
    if (args.mysqlPoolSize !== null && !Number.isFinite(args.mysqlPoolSize)) {
        return { ok: false, message: '--mysql-pool-size must be a number.' };
    }
    if (args.postgresPoolSize !== null && !Number.isFinite(args.postgresPoolSize)) {
        return { ok: false, message: '--postgres-pool-size must be a number.' };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Bootstrap helpers — invoked only after arg validation passes.
// ---------------------------------------------------------------------------

async function bootstrap() {
    // Mirrors recover.js: standalone tools read ./config.yaml relative to CWD.
    // We document this in --help so the operator knows to run from the repo
    // root. `initConfig` calls setConfigFilePath() AND addMissingConfigValues()
    // so getConfigValue() works against the freshly written file.
    const { initConfig } = await import('../src/config-init.js');
    const { getConfigValue } = await import('../src/util.js');
    const configPath = './config.yaml';
    initConfig(configPath);

    // server.js does globalThis.DATA_ROOT = cliArgs.dataRoot; cliArgs.dataRoot
    // is filled from config.dataRoot when --dataRoot isn't passed. We don't
    // support the standalone CommandLineParser here — too heavy, and most of
    // its flags don't apply. So pull dataRoot straight from config (with the
    // same './data' fallback the parser would have applied).
    const dataRoot = getConfigValue('dataRoot', './data');
    globalThis.DATA_ROOT = dataRoot;

    const { initUserStorage, getAllUserHandles, getUserDirectories } = await import('../src/users.js');
    await initUserStorage(dataRoot);

    return { dataRoot, getAllUserHandles, getUserDirectories, getConfigValue };
}

async function buildEnginesAndRepos({ fromMode, toMode, getUserDirectories, dbConfigs }) {
    const { FsEngine } = await import('../src/storage/engines/fs-engine.js');
    const { SqliteEngine } = await import('../src/storage/engines/sqlite-engine.js');
    const { MysqlEngine } = await import('../src/storage/engines/mysql-engine.js');
    const { PgEngine } = await import('../src/storage/engines/postgres-engine.js');
    const { ChatRepo } = await import('../src/storage/repositories/chat-repo.js');
    const { SettingsRepo } = await import('../src/storage/repositories/settings-repo.js');
    const { PresetRepo } = await import('../src/storage/repositories/preset-repo.js');
    const { WorldInfoRepo } = await import('../src/storage/repositories/world-info-repo.js');
    const { NamedDocRepo } = await import('../src/storage/repositories/named-doc-repo.js');
    const { GroupRepo } = await import('../src/storage/repositories/group-repo.js');
    const { StatsRepo } = await import('../src/storage/repositories/stats-repo.js');

    function buildEngine(mode) {
        if (mode === 'fs') return new FsEngine({ directoriesByHandle: getUserDirectories });
        if (mode === 'sqlite') return new SqliteEngine({ directoriesByHandle: getUserDirectories });
        if (mode === 'mysql') return new MysqlEngine(dbConfigs.mysql);
        if (mode === 'postgres') return new PgEngine(dbConfigs.postgres);
        throw new Error(`unknown engine mode: ${mode}`);
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

    const sourceEngine = buildEngine(fromMode);
    const destEngine = buildEngine(toMode);
    return {
        sourceEngine,
        destEngine,
        sourceRepos: buildRepos(sourceEngine),
        destRepos: buildRepos(destEngine),
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    let args;
    try {
        args = parseArgs(process.argv);
    } catch (err) {
        console.error(`Argument error: ${err.message}\n`);
        printHelp();
        process.exit(2);
    }

    if (args.help) {
        printHelp();
        process.exit(0);
    }

    const v = validateArgs(args);
    if (!v.ok) {
        console.error(v.message);
        console.error('');
        printHelp();
        process.exit(2);
    }

    // From here on we need a real config + data root + node-persist.
    const { dataRoot, getAllUserHandles, getUserDirectories, getConfigValue } = await bootstrap();

    // Branch: --from-zip uses the cross-mode-restore orchestrator instead of
    // the live-engine MigrationRunner path. The destination engine is the
    // live one (from config.yaml's storage.mode); the source engine kind is
    // read from the ZIP's _engine_meta.json.
    if (args.fromZip) {
        await runFromZip({ args, dataRoot, getAllUserHandles, getUserDirectories });
        return;
    }

    // Resolve mysql/postgres credentials: CLI flag wins, fall back to config.yaml.
    function resolveDbConfig(mode, urlFlag, poolSizeFlag) {
        if (urlFlag) {
            return { url: urlFlag, poolSize: poolSizeFlag ?? undefined };
        }
        const fromConfig = getConfigValue(`storage.${mode}`, null);
        if (fromConfig && typeof fromConfig.url === 'string' && fromConfig.url) {
            return {
                url: fromConfig.url,
                poolSize: poolSizeFlag ?? (Number.isFinite(fromConfig.poolSize) ? fromConfig.poolSize : undefined),
            };
        }
        return null;
    }

    const dbConfigs = { mysql: null, postgres: null };
    const dbModesInUse = new Set([args.from, args.to].filter(m => m === 'mysql' || m === 'postgres'));
    if (dbModesInUse.has('mysql')) {
        dbConfigs.mysql = resolveDbConfig('mysql', args.mysqlUrl, args.mysqlPoolSize);
        if (!dbConfigs.mysql) {
            console.error('mode=mysql requires --mysql-url or storage.mysql.url in config.yaml');
            process.exit(2);
        }
    }
    if (dbModesInUse.has('postgres')) {
        dbConfigs.postgres = resolveDbConfig('postgres', args.postgresUrl, args.postgresPoolSize);
        if (!dbConfigs.postgres) {
            console.error('mode=postgres requires --postgres-url or storage.postgres.url in config.yaml');
            process.exit(2);
        }
    }

    const allHandles = await getAllUserHandles();
    if (args.handle && !allHandles.includes(args.handle)) {
        console.error(`Handle "${args.handle}" not found. Known handles: ${allHandles.join(', ') || '(none)'}`);
        process.exit(2);
    }
    const handles = args.handle ? [args.handle] : allHandles;

    if (handles.length === 0) {
        console.log('No users found. Nothing to migrate.');
        process.exit(0);
    }

    const { sourceEngine, destEngine, sourceRepos, destRepos } = await buildEnginesAndRepos({
        fromMode: args.from,
        toMode: args.to,
        getUserDirectories,
        dbConfigs,
    });

    const { MigrationRunner } = await import('../src/storage/migration/runner.js');
    const { acquireMigrationLock, releaseMigrationLock, makeHolderId, startHeartbeat, stopHeartbeat } = await import('../src/storage/migration/lock.js');
    const backupRoot = path.join(dataRoot, '_storage-migrations');
    const runner = new MigrationRunner({
        sourceRepos,
        sourceEngine,
        destRepos,
        snapshotPaths: {
            dataRoot,
            backupRoot,
            getUserRoot: (h) => getUserDirectories(h).root,
        },
        dryRun: args.dryRun,
    });

    // Cross-process lock (spec §C item 6): refuse to run if the admin route
    // (or another CLI invocation) is already migrating this dataRoot. Mirrors
    // the admin route's acquire/finally pattern so the two entry points
    // genuinely interlock — without this the CLI could happily race a live
    // admin migration on the same data root.
    const lockHolderId = makeHolderId();
    try {
        await acquireMigrationLock({ dataRoot, holderId: lockHolderId });
    } catch (lockErr) {
        console.error(`Cannot acquire migration lock: ${lockErr?.message || String(lockErr)}`);
        console.error('');
        console.error('Another migration is already running against this dataRoot. Wait for it to finish,');
        console.error(`or if you believe the lock is stale, inspect/remove ${path.join(dataRoot, '_migration.lock')}.`);
        // Best-effort close so we don't leak DB pool sockets on the exit.
        if (sourceEngine.close) { try { await sourceEngine.close(); } catch { /* best-effort */ } }
        if (destEngine.close) { try { await destEngine.close(); } catch { /* best-effort */ } }
        process.exit(2);
    }

    console.log(`Migration: ${args.from} -> ${args.to}${args.dryRun ? ' (dry run)' : ''}`);
    console.log(`Users: ${handles.join(', ')}`);
    console.log(`Backup root: ${backupRoot}`);
    console.log('');

    // VARCHAR(128) preflight: MySQL and Postgres truncate or raise mid-copy
    // when a name doesn't fit. Surface the conflict up front so the operator
    // can rename in the live app before the migration begins writing.
    if (args.to === 'mysql' || args.to === 'postgres') {
        const { preflightNameLengths, formatPreflightOffenders } = await import('../src/storage/migration/preflight.js');
        const { PRESET_FOLDER_BY_API_ID } = await import('../src/storage/repositories/preset-repo.js');
        const { BUCKET_TO_DIR } = await import('../src/storage/repositories/named-doc-repo.js');
        const preflight = await preflightNameLengths({
            dstMode: args.to,
            sourceRepos,
            handles,
            namedDocBuckets: Object.keys(BUCKET_TO_DIR),
            presetApiIds: Object.keys(PRESET_FOLDER_BY_API_ID),
        });
        if (!preflight.ok) {
            console.error(formatPreflightOffenders(preflight.offenders));
            if (sourceEngine.close) { try { await sourceEngine.close(); } catch { /* best-effort */ } }
            if (destEngine.close) { try { await destEngine.close(); } catch { /* best-effort */ } }
            await releaseMigrationLock({ dataRoot, holderId: lockHolderId }).catch(() => {});
            process.exit(2);
        }
    }

    // Heartbeat (spec §4.5): the CLI is the long-running entry point — a
    // multi-user dataRoot migration will routinely exceed the 60s default
    // TTL. Without a refresh loop the lock would expire mid-run and an
    // admin route invocation could evict us. Armed after a successful
    // acquire so we never start a timer for a 409-path; torn down in the
    // matching `finally` below before release.
    const heartbeat = startHeartbeat({ dataRoot, holderId: lockHolderId });

    let okCount = 0;
    let failCount = 0;
    try {
        const result = await runMigration({
            runner,
            handles,
        });
        okCount = result.okCount;
        failCount = result.failCount;
    } finally {
        // Release the lock before the NEXT STEPS message so a follow-up
        // `storage-migrate` invocation (e.g. operator re-runs to mop up a
        // failed user) isn't blocked while we're still printing.
        //
        // Stop the heartbeat first so a pending tick can't write to the
        // lockfile after release rms it. `stopHeartbeat` is null-safe.
        stopHeartbeat(heartbeat);
        await releaseMigrationLock({ dataRoot, holderId: lockHolderId });
    }

    // Close engines before reporting summary so any teardown errors surface.
    if (sourceEngine.close) {
        try { await sourceEngine.close(); } catch { /* best-effort */ }
    }
    if (destEngine.close) {
        try { await destEngine.close(); } catch { /* best-effort */ }
    }

    console.log(`Summary: ${okCount} migrated, ${failCount} failed.`);
    if (!args.dryRun && okCount > 0) {
        console.log('');
        console.log('NEXT STEPS:');
        console.log('  1. Verify your data in the destination engine.');
        console.log(`  2. Edit config.yaml: set storage.mode to "${args.to}".`);
        console.log('  3. Restart the server.');
        console.log('');
        console.log(`Backup snapshots remain at ${backupRoot} and are NOT deleted automatically.`);
    }

    process.exit(failCount > 0 ? 1 : 0);
}

/**
 * Drive a built `MigrationRunner` over `handles` via `migrateAllUsers`, which
 * is the entry point that flips `setReadOnly(true)` for the duration of the
 * batch (spec §C item 5). The per-user for-loop the CLI used previously
 * skipped that read-only enforcement and is no longer used.
 *
 * Console logging is owned by this function so the CLI keeps its existing
 * per-handle progress lines and per-user summary block; callers under test
 * can pass a `logger` to silence or capture output without screen-scraping
 * stdout. The returned `{okCount, failCount, results}` shape feeds the CLI's
 * exit-code + NEXT STEPS rendering.
 *
 * Exported so the CLI smoke test can drive it directly without spawning a
 * child node process — the test asserts read-only enforcement was active
 * mid-run via the same `onProgress` channel the runner uses.
 *
 * @param {object} opts
 * @param {import('../src/storage/migration/runner.js').MigrationRunner} opts.runner
 * @param {string[]} opts.handles
 * @param {{log: (...args: any[]) => void, error: (...args: any[]) => void}} [opts.logger]
 * @returns {Promise<{okCount: number, failCount: number, results: object}>}
 */
export async function runMigration({ runner, handles, logger = console }) {
    const log = logger.log.bind(logger);
    const error = logger.error.bind(logger);

    const total = handles.length;
    // Print the "[i/N] migrating <handle>..." header the first time we see a
    // progress event for a given handle. The runner emits `snapshotted` first
    // on real runs and `settings-copied` first on dry-runs (no snapshot stage),
    // so keying off the first event per handle is the only portable signal.
    let order = 0;
    const handleOrder = new Map();

    const results = await runner.migrateAllUsers(handles, {
        onProgress: ({ handle, stage, ...extra }) => {
            if (!handleOrder.has(handle)) {
                handleOrder.set(handle, ++order);
                log(`[${handleOrder.get(handle)}/${total}] migrating ${handle}...`);
            }
            if (stage === 'done') {
                const stats = extra.stats;
                log(
                    `  done: settings=${stats.settings} presets=${stats.presets} preset_states=${stats.preset_states}`
                    + ` worlds=${stats.worlds} chats=${stats.chats} chat_states=${stats.chat_states}`
                    + ` named_docs=${stats.named_docs} groups=${stats.groups} stats=${stats.stats}`,
                );
                // NOTE: do NOT print `stats.backupPath` here. The `done` event
                // fires inside the runner's success path BEFORE its outer
                // `finally` runs the snapshot GC (the default).
                // The path is still set on `stats` at this instant but the
                // directory is gone by the time the operator reads the log,
                // so "backup: <path>" sends them to a "No such file" hunt.
                // Failure paths take a different log line (`user-failed`)
                // and preserve the snapshot via the same GC condition.
                if (stats.errors.length > 0) {
                    log(`  warnings: ${stats.errors.length}`);
                    for (const e of stats.errors) log(`    - ${e.stage}: ${e.message}`);
                }
                log('');
                return;
            }
            if (stage === 'user-failed') {
                error(`  FAILED: ${extra.error}`);
                log('');
                return;
            }
            // Suppress `starting` for parity with the previous CLI output;
            // every other stage is informational and worth echoing.
            if (stage === 'starting') return;
            const detail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
            log(`  ${stage}${detail}`);
        },
    });

    let okCount = 0;
    let failCount = 0;
    for (const handle of handles) {
        const r = results[handle];
        // migrateAllUsers writes either a full stats object (success — even on
        // dry-run, where `verified` is intentionally false) or a thin
        // `{ handle, error, verified: false }` envelope (failure).  The
        // distinguishing field is `error`, NOT `verified`, since dry-runs
        // legitimately end with verified=false.
        if (r && typeof r.error === 'string') failCount++;
        else okCount++;
    }
    return { okCount, failCount, results };
}

/**
 * CLI handler for `--from-zip <path>`: ingest a backup ZIP into the live
 * engine via the cross-mode-restore orchestrator. Exits the process with a
 * status code matching the outcome (0 success, 1 conversion failure,
 * 2 argument / pre-flight error).
 *
 * @param {object} ctx
 * @param {object} ctx.args
 * @param {string} ctx.dataRoot
 * @param {() => Promise<string[]>} ctx.getAllUserHandles
 * @param {(handle: string) => object} ctx.getUserDirectories
 */
export async function runFromZip({ args, dataRoot, getAllUserHandles, getUserDirectories }) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const yauzl = (await import('yauzl')).default;
    const { initStorage, getStorageEngine } = await import('../src/storage/index.js');
    const { initUserStorage } = await import('../src/users.js');
    const { ENGINE_META_ENTRY } = await import('../src/storage/engine-backup-entries.js');
    const { crossModeRestore } = await import('../src/storage/migration/cross-mode-restore.js');
    const { getConfigValue } = await import('../src/util.js');

    const zipPath = path.default ? path.default.resolve(args.fromZip) : path.resolve(args.fromZip);
    if (!fs.existsSync(zipPath)) {
        console.error(`--from-zip: file not found at ${zipPath}`);
        process.exit(2);
    }

    // Peek at the ZIP to find the source engine kind.
    const engineMeta = await readEngineMetaFromZipCli(zipPath, yauzl, ENGINE_META_ENTRY);
    if (!engineMeta) {
        console.error('--from-zip: backup ZIP has no _engine_meta.json. Legacy fs-only backups cannot be ingested via --from-zip; restore from the web UI on an fs-mode server instead.');
        process.exit(2);
    }
    console.log(`Cross-mode restore from ZIP:`);
    console.log(`  source engine: ${engineMeta.engineKind} (handle=${engineMeta.handle || '(unknown)'})`);

    // Initialize the LIVE engine from config.yaml.
    await initUserStorage(dataRoot);
    initStorage({
        mode: getConfigValue('storage.mode', 'fs'),
        directoriesByHandle: getUserDirectories,
        mysql: getConfigValue('storage.mysql', null),
        postgres: getConfigValue('storage.postgres', null),
        acquireTimeoutMs: getConfigValue('storage.acquireTimeoutMs', 30000),
        retries: { transient: getConfigValue('storage.retries.transient', 3) },
    });
    const currentEngine = getStorageEngine();
    console.log(`  dest engine: ${currentEngine.kind}`);

    if (engineMeta.engineKind === currentEngine.kind) {
        console.error(`Source engine (${engineMeta.engineKind}) matches live engine. Use the standard restore UI instead — --from-zip is for cross-mode restores only.`);
        process.exit(2);
    }

    // Resolve the destination handle: --handle wins; else use the meta's
    // source handle; else error.
    const allHandles = await getAllUserHandles();
    const targetHandle = args.handle || engineMeta.handle;
    if (!targetHandle) {
        console.error('--from-zip: provide --handle (the ZIP does not declare a source handle in its meta).');
        process.exit(2);
    }
    if (!allHandles.includes(targetHandle)) {
        console.error(`--from-zip: handle "${targetHandle}" does not exist on this server. Existing handles: ${allHandles.join(', ') || '(none)'}`);
        process.exit(2);
    }
    console.log(`  target handle: ${targetHandle}`);

    // Resolve scratch creds if needed.
    let scratchCreds = null;
    if (engineMeta.engineKind === 'mysql') {
        if (!args.mysqlUrl) {
            console.error('--from-zip: source engine is mysql; pass --mysql-url for the scratch DB.');
            process.exit(2);
        }
        scratchCreds = { mysqlUrl: args.mysqlUrl, mysqlPoolSize: args.mysqlPoolSize ?? undefined };
    }
    if (engineMeta.engineKind === 'postgres') {
        if (!args.postgresUrl) {
            console.error('--from-zip: source engine is postgres; pass --postgres-url for the scratch DB.');
            process.exit(2);
        }
        scratchCreds = { postgresUrl: args.postgresUrl, postgresPoolSize: args.postgresPoolSize ?? undefined };
    }

    const mode = args.mode === 'merge' ? 'merge' : 'overwrite';
    const dirs = getUserDirectories(targetHandle);
    // Restore all categories — same as web UI's "select all".
    const selection = {
        settings: true, secrets: true, characters: true, chats: true,
        lorebooks: true, presets: true, assets: true, extensions: true,
        globalExtensions: true, vectors: true,
    };

    console.log(`  mode: ${mode}`);
    console.log('');
    console.log('Starting cross-mode restore...');

    try {
        const result = await crossModeRestore(
            zipPath,
            engineMeta,
            dirs,
            selection,
            mode,
            {
                dataRoot,
                currentEngine,
                onProgress: (event) => {
                    if (event?.phase === 'convert' && event.stage) { // banned-words-allow
                        console.log(`  convert: ${event.stage}`);
                    }
                },
                scratchCreds,
                includeGlobalExtensions: true,
            },
        );
        console.log('');
        console.log(`Done. Restored ${result.restoredCount} fs-tree files; cross-mode duration ${result.crossMode.durationMs}ms.`);
        const c = result.crossMode.converted;
        console.log(`  settings=${c.settings} presets=${c.presets} (states=${c.preset_states}) worlds=${c.worlds} chats=${c.chats} (states=${c.chat_states}) named_docs=${c.named_docs} groups=${c.groups} stats=${c.stats}`);
        if (currentEngine.close) try { await currentEngine.close(); } catch {}
        process.exit(0);
    } catch (err) {
        console.error(`Cross-mode restore failed: ${err?.message || err}`);
        if (err?.snapshotPath) {
            console.error(`Snapshot preserved at: ${err.snapshotPath}`);
            console.error(`Run restoreFromSnapshot manually if rollback was incomplete.`);
        }
        if (currentEngine.close) try { await currentEngine.close(); } catch {}
        process.exit(1);
    }
}

function readEngineMetaFromZipCli(zipPath, yauzl, ENGINE_META_ENTRY) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
            if (openErr) return reject(openErr);
            let settled = false;
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (entry.fileName !== ENGINE_META_ENTRY) {
                    zipfile.readEntry();
                    return;
                }
                zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (settled) return;
                    if (streamErr) { settled = true; try { zipfile.close(); } catch {} return reject(streamErr); }
                    const chunks = [];
                    readStream.on('data', (c) => chunks.push(c));
                    readStream.on('error', (e) => { if (!settled) { settled = true; try { zipfile.close(); } catch {} reject(e); } });
                    readStream.on('end', () => {
                        if (settled) return;
                        settled = true;
                        try { zipfile.close(); } catch {}
                        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
                    });
                });
            });
            zipfile.on('end', () => { if (!settled) { settled = true; resolve(null); } });
            zipfile.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
        });
    });
}

// Only auto-run main() when invoked as a script. Importing this file from a
// test (the CLI smoke test imports `runMigration` directly) must not trigger
// the bootstrap path or attempt to call `process.exit`.
const isMainModule = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch((err) => {
        console.error('Fatal:', err?.stack || err?.message || String(err));
        process.exit(1);
    });
}
