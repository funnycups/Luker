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
  --help, -h             Show this message

Examples:
  node scripts/storage-migrate.js --from fs --to sqlite
  node scripts/storage-migrate.js --from sqlite --to fs --handle alice --dry-run
  node scripts/storage-migrate.js --from fs --to mysql --mysql-url mysql://luker:pw@db:3306/luker

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
    if (!args.from || !args.to) {
        return { ok: false, message: 'Both --from and --to are required.' };
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
    const backupRoot = path.join(dataRoot, '_storage-migrations');
    const runner = new MigrationRunner({
        sourceRepos,
        destRepos,
        snapshotPaths: {
            dataRoot,
            backupRoot,
            getUserRoot: (h) => getUserDirectories(h).root,
        },
        dryRun: args.dryRun,
    });

    console.log(`Migration: ${args.from} -> ${args.to}${args.dryRun ? ' (dry run)' : ''}`);
    console.log(`Users: ${handles.join(', ')}`);
    console.log(`Backup root: ${backupRoot}`);
    console.log('');

    let okCount = 0;
    let failCount = 0;
    for (const [i, handle] of handles.entries()) {
        console.log(`[${i + 1}/${handles.length}] migrating ${handle}...`);
        try {
            const stats = await runner.migrateUser(handle, {
                onProgress: ({ stage, ...extra }) => {
                    if (stage === 'starting') return;
                    const detail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
                    console.log(`  ${stage}${detail}`);
                },
            });
            okCount++;
            console.log(
                `  done: settings=${stats.settings} presets=${stats.presets} preset_states=${stats.preset_states}`
                + ` worlds=${stats.worlds} chats=${stats.chats} chat_states=${stats.chat_states}`
                + ` named_docs=${stats.named_docs} groups=${stats.groups} stats=${stats.stats}`,
            );
            if (stats.backupPath) console.log(`  backup: ${stats.backupPath}`);
            if (stats.errors.length > 0) {
                console.log(`  warnings: ${stats.errors.length}`);
                for (const e of stats.errors) console.log(`    - ${e.stage}: ${e.message}`);
            }
        } catch (err) {
            failCount++;
            console.error(`  FAILED: ${err.message}`);
        }
        console.log('');
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

main().catch((err) => {
    console.error('Fatal:', err?.stack || err?.message || String(err));
    process.exit(1);
});
