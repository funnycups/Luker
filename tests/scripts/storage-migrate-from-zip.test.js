// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Tests for `scripts/storage-migrate.js --from-zip <path>` — the CLI front-end
// to the cross-mode-restore orchestrator. Two layers:
//
//   1. Argument-parser / pre-flight tests — spawn the script with bogus args
//      and assert it exits 2 with an actionable message. These run without
//      a real config or data root.
//
//   2. End-to-end smoke: build a sqlite-source ZIP, run the CLI against a
//      throwaway data-root with config.yaml pinning storage.mode=fs, assert
//      the live fs engine now contains the converted data and the exit
//      code is 0.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';

import { SqliteEngine } from '../../src/storage/engines/sqlite-engine.js';
import { FsEngine } from '../../src/storage/engines/fs-engine.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../src/storage/engine-backup-entries.js';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/storage-migrate.js',
);

function runScript(args, cwd) {
    return new Promise((resolve) => {
        const child = spawn('node', [SCRIPT, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd,
            env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

function makeTempCwd() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-cli-fromzip-'));
    return cwd;
}

function writeConfigYaml(cwd, storageMode) {
    const dataRoot = path.join(cwd, 'data');
    fs.mkdirSync(dataRoot, { recursive: true });
    const config = [
        `dataRoot: ${JSON.stringify(dataRoot)}`,
        `storage:`,
        `    mode: ${storageMode}`,
        `enableUserAccounts: false`,
        `whitelist: false`,
        `whitelistDockerHosts: false`,
        `port: 0`,
        `listen: false`,
        `protocol:`,
        `    ipv4: true`,
        `    ipv6: false`,
        `disableCsrfProtection: true`,
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(cwd, 'config.yaml'), config);
    return dataRoot;
}

async function buildSqliteSourceZip(zipPath, srcDir, handle) {
    fs.mkdirSync(srcDir, { recursive: true });
    const engine = new SqliteEngine({ directoriesByHandle: () => ({ root: srcDir }) });
    try {
        await new SettingsRepo({ engine }).save(handle, { user_name: 'cli-fromzip', custom: 'YY' });
        await new ChatRepo({ engine }).save(handle, 'Alice', 'c1',
            { user_name: 'cli-fromzip' },
            [{ name: 'User', mes: 'cli 你好 🌍', is_user: true }], null);
    } finally {
        engine.close();
    }
    const dumpBytes = fs.readFileSync(path.join(srcDir, 'luker-storage.sqlite'));
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        arc.finalize();
    });
}

describe('scripts/storage-migrate.js --from-zip', () => {
    test('--from-zip + --from is rejected (mutually exclusive)', async () => {
        const r = await runScript(['--from-zip', '/tmp/x.zip', '--from', 'fs', '--to', 'sqlite']);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/mutually exclusive/i);
    });

    test('--from-zip with missing file exits 2', async () => {
        const cwd = makeTempCwd();
        try {
            writeConfigYaml(cwd, 'fs');
            const r = await runScript(['--from-zip', '/nonexistent/path.zip'], cwd);
            expect(r.code).toBe(2);
            expect(r.stderr).toMatch(/file not found/i);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    test('--from-zip with --dry-run is rejected', async () => {
        const r = await runScript(['--from-zip', '/tmp/x.zip', '--dry-run']);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/dry-run is not supported/i);
    });

    test('--from-zip rejects same-mode source/dest', async () => {
        const cwd = makeTempCwd();
        try {
            const dataRoot = writeConfigYaml(cwd, 'fs');
            // Pre-create user dir so initUserStorage finds it.
            fs.mkdirSync(path.join(dataRoot, 'alice'), { recursive: true });
            // Build a fs-source-style ZIP with engine_meta declaring fs.
            const zipPath = path.join(cwd, 'fs.zip');
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(zipPath);
                const arc = archiver('zip');
                arc.on('error', reject);
                out.on('close', resolve);
                arc.pipe(out);
                arc.append('{}', { name: 'manifest.json' });
                arc.append(JSON.stringify({ engineKind: 'fs', schemaVersion: 1, handle: 'alice' }), { name: ENGINE_META_ENTRY });
                arc.finalize();
            });
            const r = await runScript(['--from-zip', zipPath, '--handle', 'alice'], cwd);
            expect(r.code).toBe(2);
            expect(r.stderr).toMatch(/matches live engine/i);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    test('end-to-end: sqlite ZIP → fs server', async () => {
        const cwd = makeTempCwd();
        try {
            const dataRoot = writeConfigYaml(cwd, 'fs');
            // initUserStorage auto-creates a `default-user` handle on first
            // run when no users exist. Restore against that handle so the
            // CLI's existence check passes without us mocking node-persist.
            const handle = 'default-user';

            // Build sqlite-source ZIP. The meta carries the source handle
            // ('alice'); we pass --handle default-user to redirect the
            // ingestion onto the live user the CLI knows about.
            const zipPath = path.join(cwd, 'sqlite.zip');
            const srcDir = path.join(cwd, 'src-dir');
            await buildSqliteSourceZip(zipPath, srcDir, 'alice');

            const r = await runScript(['--from-zip', zipPath, '--handle', handle], cwd);
            if (r.code !== 0) console.error('CLI FAILED:', r.stderr || r.stdout);
            expect(r.code).toBe(0);
            expect(r.stdout).toMatch(/Done\./);

            // Verify the live fs engine now contains the data. FsEngine
            // requires the full per-user directory map, not just root, so
            // we build it from the same template the production server uses.
            const userRoot = path.join(dataRoot, handle);
            const verifyDirs = {
                root: userRoot,
                chats: path.join(userRoot, 'chats'),
                groupChats: path.join(userRoot, 'group chats'),
                characters: path.join(userRoot, 'characters'),
                worlds: path.join(userRoot, 'worlds'),
                groups: path.join(userRoot, 'groups'),
                themes: path.join(userRoot, 'themes'),
                movingUI: path.join(userRoot, 'movingUI'),
                quickreplies: path.join(userRoot, 'QuickReplies'),
                openAI_Settings: path.join(userRoot, 'OpenAI Settings'),
                novelAI_Settings: path.join(userRoot, 'NovelAI Settings'),
                koboldAI_Settings: path.join(userRoot, 'KoboldAI Settings'),
                textGen_Settings: path.join(userRoot, 'TextGen Settings'),
                instruct: path.join(userRoot, 'instruct'),
                context: path.join(userRoot, 'context'),
                sysprompt: path.join(userRoot, 'sysprompt'),
                reasoning: path.join(userRoot, 'reasoning'),
            };
            const fsEngine = new FsEngine({ directoriesByHandle: () => verifyDirs });
            const settings = await new SettingsRepo({ engine: fsEngine }).get(handle);
            expect(settings?.user_name).toBe('cli-fromzip');
            const chat = await new ChatRepo({ engine: fsEngine }).get(handle, 'Alice', 'c1');
            expect(chat?.body[0]?.mes).toBe('cli 你好 🌍');
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    }, 60000);
});
