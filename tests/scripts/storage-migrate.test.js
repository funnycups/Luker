// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Argument-parser / help-output tests for scripts/storage-migrate.js.
//
// These tests spawn the script as a child node process with no real config
// or data root. They cover the help / usage / validation paths only — the
// real migration code path is exercised by tests/storage/migration/runner.test.js
// against synthesised user trees. The script is designed so all argument
// validation runs BEFORE bootstrap (config.yaml read, node-persist init,
// engine construction), which is what lets these tests run quickly without
// any tmp dirs or fixture setup.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/storage-migrate.js',
);

function runScript(args) {
    return new Promise((resolve) => {
        const child = spawn('node', [SCRIPT, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

describe('scripts/storage-migrate.js', () => {
    test('--help exits 0 with usage', async () => {
        const r = await runScript(['--help']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('storage-migrate');
        expect(r.stdout).toContain('--from');
        expect(r.stdout).toContain('--to');
    });

    test('-h short flag also prints help', async () => {
        const r = await runScript(['-h']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Usage:');
    });

    test('missing args exit non-zero with hint', async () => {
        const r = await runScript([]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('required');
    });

    test('matching --from and --to exits non-zero', async () => {
        const r = await runScript(['--from', 'fs', '--to', 'fs']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('must differ');
    });

    test('invalid mode value exits non-zero', async () => {
        const r = await runScript(['--from', 'invalid', '--to', 'sqlite']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('must be one of');
    });

    test('unknown argument exits non-zero', async () => {
        const r = await runScript(['--unknown']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('Unknown argument');
    });
});
