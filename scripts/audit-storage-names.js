#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// audit-storage-names — read-only sweep that lists every per-user resource
// (worlds, themes / movingUI / quickReplies, groups, presets, chats) whose
// name would NOT survive a strict sanitize-and-round-trip: names containing
// path separators or other characters `sanitize-filename` strips, names that
// carry a `.json` / `.jsonl` suffix as if they were filenames, or names
// longer than the 128-char column limit used by MySQL / Postgres.
//
// Use this before tightening name validation at the engine layer, or before
// switching to MySQL / Postgres — both will start rejecting names that the
// FS engine has been silently rewriting. The script never mutates anything.

import process from 'node:process';
import sanitizeFilename from 'sanitize-filename';

const MAX_NAME_LEN = 128;
const SUFFIX_HINTS = ['.json', '.jsonl'];

function classify(name) {
    const reasons = [];
    const trimmed = String(name || '').trim();
    if (trimmed !== name) reasons.push('leading/trailing whitespace');

    const sanitized = sanitizeFilename(trimmed);
    if (sanitized !== trimmed) reasons.push(`sanitize-filename rewrites "${trimmed}" → "${sanitized}"`);

    for (const suffix of SUFFIX_HINTS) {
        if (trimmed.toLowerCase().endsWith(suffix)) {
            reasons.push(`looks like a filename (trailing "${suffix}")`);
            break;
        }
    }

    if (Buffer.byteLength(trimmed, 'utf8') > MAX_NAME_LEN) {
        reasons.push(`length ${Buffer.byteLength(trimmed, 'utf8')} bytes exceeds MySQL/Postgres column limit (${MAX_NAME_LEN})`);
    }

    const nfc = trimmed.normalize('NFC');
    if (nfc !== trimmed) reasons.push('not NFC-normalized (will compare unequal across engines that normalize)');

    return reasons;
}

function printHelp() {
    console.log(`audit-storage-names — list per-user names that won't survive strict validation

Usage:
  node scripts/audit-storage-names.js [--handle <handle>]

Reports every name in worlds, themes, movingUI, quickReplies, groups, presets,
and chats that:
  - sanitize-filename would rewrite (slashes, NUL, reserved characters)
  - ends with .json / .jsonl (filename leaking in where a bare name was expected)
  - exceeds ${MAX_NAME_LEN} bytes (MySQL/Postgres VARCHAR(128) limit)
  - is not NFC-normalized

Exits 0 with the report; nothing is mutated. Reads the live storage backend
declared in config.yaml — run this before tightening name validation at the
engine layer or before switching to MySQL / Postgres so you know in advance
which records will start being rejected.

Options:
  --handle <handle>  Audit only one user (default: all users)
  --help, -h         Show this message
`);
}

function parseArgs(argv) {
    const args = { handle: null, help: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--handle') args.handle = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

async function bootstrap() {
    const { initConfig } = await import('../src/config-init.js');
    const { getConfigValue } = await import('../src/util.js');
    initConfig('./config.yaml');
    const dataRoot = getConfigValue('dataRoot', './data');
    globalThis.DATA_ROOT = dataRoot;
    const { initUserStorage, getAllUserHandles, getUserDirectories } = await import('../src/users.js');
    await initUserStorage(dataRoot);
    return { getAllUserHandles, getUserDirectories, getConfigValue };
}

async function buildLiveEngineAndRepos({ getUserDirectories, getConfigValue }) {
    const mode = getConfigValue('storage.mode', 'fs');
    const { FsEngine } = await import('../src/storage/engines/fs-engine.js');
    const { SqliteEngine } = await import('../src/storage/engines/sqlite-engine.js');
    const { MysqlEngine } = await import('../src/storage/engines/mysql-engine.js');
    const { PgEngine } = await import('../src/storage/engines/postgres-engine.js');

    let engine;
    if (mode === 'fs') engine = new FsEngine({ directoriesByHandle: getUserDirectories });
    else if (mode === 'sqlite') engine = new SqliteEngine({ directoriesByHandle: getUserDirectories });
    else if (mode === 'mysql') {
        const cfg = getConfigValue('storage.mysql', null);
        if (!cfg?.url) throw new Error('storage.mode=mysql but storage.mysql.url is unset');
        engine = new MysqlEngine({ url: cfg.url, poolSize: cfg.poolSize });
    } else if (mode === 'postgres') {
        const cfg = getConfigValue('storage.postgres', null);
        if (!cfg?.url) throw new Error('storage.mode=postgres but storage.postgres.url is unset');
        engine = new PgEngine({ url: cfg.url, poolSize: cfg.poolSize });
    } else {
        throw new Error(`unknown storage mode: ${mode}`);
    }

    const { ChatRepo } = await import('../src/storage/repositories/chat-repo.js');
    const { PresetRepo, PRESET_FOLDER_BY_API_ID } = await import('../src/storage/repositories/preset-repo.js');
    const { WorldInfoRepo } = await import('../src/storage/repositories/world-info-repo.js');
    const { NamedDocRepo, BUCKET_TO_DIR } = await import('../src/storage/repositories/named-doc-repo.js');
    const { GroupRepo } = await import('../src/storage/repositories/group-repo.js');

    return {
        mode,
        engine,
        repos: {
            chat: new ChatRepo({ engine }),
            preset: new PresetRepo({ engine }),
            worldInfo: new WorldInfoRepo({ engine }),
            namedDoc: new NamedDocRepo({ engine }),
            group: new GroupRepo({ engine }),
        },
        namedDocBuckets: Object.keys(BUCKET_TO_DIR),
        presetApiIds: Object.keys(PRESET_FOLDER_BY_API_ID),
        presetFolderByApiId: PRESET_FOLDER_BY_API_ID,
    };
}

async function auditHandle(handle, ctx) {
    const findings = [];
    const record = (bucket, name, reasons) => {
        if (reasons.length) findings.push({ bucket, name, reasons });
    };

    // World — listNames is cheaper than full list and surfaces the same names.
    try {
        const names = await ctx.repos.worldInfo.listNames(handle);
        for (const name of names) record('world', name, classify(name));
    } catch (err) {
        console.warn(`[${handle}] world list failed: ${err.message}`);
    }

    // Named-doc buckets.
    for (const bucket of ctx.namedDocBuckets) {
        try {
            const entries = await ctx.repos.namedDoc.list(handle, bucket);
            for (const entry of entries) {
                const name = entry?.key?.name;
                if (name) record(`named-doc/${bucket}`, name, classify(name));
            }
        } catch (err) {
            console.warn(`[${handle}] named-doc/${bucket} list failed: ${err.message}`);
        }
    }

    // Groups (id is the on-disk identifier).
    try {
        const groups = await ctx.repos.group.list(handle);
        for (const entry of groups) {
            const id = entry?.key?.id;
            if (id) record('group', id, classify(id));
        }
    } catch (err) {
        console.warn(`[${handle}] group list failed: ${err.message}`);
    }

    // Presets — distinct apiId folders. Some apiIds share a folder
    // (kobold + koboldhorde both map to koboldAI_Settings); list each folder
    // once so a multi-mapped preset doesn't appear twice in the report.
    const seenPresetFolders = new Set();
    for (const apiId of ctx.presetApiIds) {
        const folder = ctx.presetFolderByApiId[apiId];
        if (seenPresetFolders.has(folder)) continue;
        seenPresetFolders.add(folder);
        try {
            const entries = await ctx.repos.preset.list(handle, apiId);
            for (const entry of entries) {
                const name = entry?.key?.name;
                if (name) record(`preset/${folder}`, name, classify(name));
            }
        } catch (err) {
            console.warn(`[${handle}] preset/${folder} list failed: ${err.message}`);
        }
    }

    // Chats — both per-character and group chats.
    try {
        const chats = await ctx.repos.chat.listAll(handle);
        for (const entry of chats) {
            const key = entry?.key;
            if (!key?.name) continue;
            const label = key.isGroup ? `chat/group/${key.groupId || ''}` : `chat/${key.charDir || '(none)'}`;
            record(label, key.name, classify(key.name));
            if (!key.isGroup && key.charDir) {
                // charDir is the per-character folder name, also a name we
                // round-trip through FS / DB. Audit it once per chat row so
                // we surface dir-level damage too.
                record('chat-dir', key.charDir, classify(key.charDir));
            }
        }
    } catch (err) {
        console.warn(`[${handle}] chat list failed: ${err.message}`);
    }

    return findings;
}

function printHandleReport(handle, findings) {
    if (!findings.length) {
        console.log(`[${handle}] clean — no name issues`);
        return;
    }
    console.log(`[${handle}] ${findings.length} issue(s):`);
    // Dedup chat-dir entries (every chat row repeats the same dir name).
    const seen = new Set();
    for (const f of findings) {
        const key = `${f.bucket}\0${f.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  - ${f.bucket}: ${JSON.stringify(f.name)}`);
        for (const reason of f.reasons) console.log(`      • ${reason}`);
    }
}

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

    const { getAllUserHandles, getUserDirectories, getConfigValue } = await bootstrap();
    const ctx = await buildLiveEngineAndRepos({ getUserDirectories, getConfigValue });

    const allHandles = await getAllUserHandles();
    if (args.handle && !allHandles.includes(args.handle)) {
        console.error(`Handle "${args.handle}" not found. Known handles: ${allHandles.join(', ') || '(none)'}`);
        process.exit(2);
    }
    const handles = args.handle ? [args.handle] : allHandles;
    if (!handles.length) {
        console.log('No users found.');
        process.exit(0);
    }

    console.log(`Auditing names in storage.mode=${ctx.mode} across ${handles.length} handle(s)...\n`);
    let totalIssues = 0;
    for (const handle of handles) {
        const findings = await auditHandle(handle, ctx);
        // Same dedup count as the printer uses, so the summary matches the output.
        const unique = new Set(findings.map(f => `${f.bucket}\0${f.name}`)).size;
        totalIssues += unique;
        printHandleReport(handle, findings);
    }
    console.log(`\nDone. ${totalIssues} unique name issue(s) across ${handles.length} handle(s).`);
    process.exit(0);
}

main().catch(err => {
    console.error(err?.stack || err);
    process.exit(1);
});
