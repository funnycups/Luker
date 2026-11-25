import { describe, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testWithResources } from '../harness/jest.js';
import { scanTestResourceOwnership } from '../../scripts/check-test-resource-ownership.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function writeTree(root, files) {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
}

describe('check-test-resource-ownership AST guard', () => {
    testWithResources('allows ordinary writes inside registered managed directories', async (scope) => {
        const dir = await scope.directory('ast-guard-clean');
        writeTree(dir.path, {
            'tests/package.json': JSON.stringify({
                scripts: {
                    'test:unit': 'node harness/run.js --profile unit',
                },
            }),
            'tests/e2e/sample.e2e.js': [
                'import fs from "node:fs";',
                'import path from "node:path";',
                'import { test } from "../harness/playwright.js";',
                'test("writes ordinary fixture files inside managed dir", async ({ resources }) => {',
                '    const owned = await resources.directory("fixture");',
                '    fs.mkdirSync(path.join(owned.path, "nested"), { recursive: true });',
                '    fs.writeFileSync(path.join(owned.path, "nested", "data.json"), "{}");',
                '    // Mentioning mkdtempSync or os.tmpdir() or new Proxy in comments is not executable code.',
                '    const doc = "fs.mkdtempSync(os.tmpdir()) child_process new Proxy";',
                '    expect(doc.length).toBeGreaterThan(0);',
                '});',
                '',
            ].join('\n'),
        });

        const result = scanTestResourceOwnership(dir.path, { baseline: null });
        expect(result.violations).toEqual([]);
    });

    testWithResources('catches unregistered temp directory allocations including aliased imports and .e2e-scratch', async (scope) => {
        const dir = await scope.directory('ast-guard-tempdirs');
        writeTree(dir.path, {
            'tests/unit/bad-dirs.test.js': [
                'import fs, { mkdtempSync as makeScratch } from "node:fs";',
                'import { tmpdir as sysTmp } from "node:os";',
                'import path from "node:path";',
                'const a = makeScratch(path.join(sysTmp(), "x-"));',
                'const b = fs.mkdtempSync("/tmp/y-");',
                'const c = path.join(process.cwd(), "tests", ".e2e-scratch", "run");',
                'export { a, b, c };',
                '',
            ].join('\n'),
        });

        const result = scanTestResourceOwnership(dir.path, { baseline: null });
        const categories = result.violations.map(v => v.category);
        expect(categories).toContain('unregistered-root-directory');
        expect(result.violations.length).toBeGreaterThanOrEqual(4);
    });

    testWithResources('catches unregistered child_process imports and dynamic imports without comment bypasses', async (scope) => {
        const dir = await scope.directory('ast-guard-process');
        writeTree(dir.path, {
            'tests/e2e/bad-proc.e2e.js': [
                '// allow-unregistered-process',
                'import { spawn as launchRaw } from "node:child_process";',
                'export async function run() {',
                '    launchRaw("echo", ["hi"]);',
                '    const cp = await import("child_process");',
                '    return cp.execFileSync("true");',
                '}',
                '',
            ].join('\n'),
        });

        const result = scanTestResourceOwnership(dir.path, { baseline: null });
        const procHits = result.violations.filter(v => v.category === 'unregistered-process');
        expect(procHits.length).toBeGreaterThanOrEqual(2);
    });

    testWithResources('catches unregistered database client imports outside harness', async (scope) => {
        const dir = await scope.directory('ast-guard-db');
        writeTree(dir.path, {
            'tests/storage/bad-db.test.js': [
                'import mysql from "mysql2/promise";',
                'import pg from "pg";',
                'export async function open() {',
                '    const pool = mysql.createPool({ uri: "mysql://localhost/test" });',
                '    const client = new pg.Client();',
                '    return { pool, client };',
                '}',
                '',
            ].join('\n'),
        });

        const result = scanTestResourceOwnership(dir.path, { baseline: null });
        const dbHits = result.violations.filter(v => v.category === 'unregistered-database');
        expect(dbHits.length).toBeGreaterThanOrEqual(2);
    });

    testWithResources('catches new Proxy stubs and --forceExit scripts', async (scope) => {
        const dir = await scope.directory('ast-guard-proxy-force');
        writeTree(dir.path, {
            'tests/package.json': JSON.stringify({
                scripts: {
                    'test:unit:serial': 'jest --runInBand --forceExit',
                },
            }),
            'tests/unit/bad-proxy.test.js': [
                'globalThis.Luker = new Proxy({}, { get: () => new Proxy(() => {}, {}) });',
                '',
            ].join('\n'),
        });

        const result = scanTestResourceOwnership(dir.path, { baseline: null });
        expect(result.violations.some(v => v.category === 'unregistered-proxy-stub')).toBe(true);
        expect(result.violations.some(v => v.category === 'force-exit-command')).toBe(true);
    });

    testWithResources('rejects new violations even when a baseline exists for unrelated files', async (scope) => {
        const dir = await scope.directory('ast-guard-baseline-ratchet');
        writeTree(dir.path, {
            'tests/unit/legacy.test.js': 'import { tmpdir } from "node:os"; export const x = tmpdir();\n',
            'tests/unit/new-file.test.js': 'import { tmpdir } from "node:os"; export const y = tmpdir();\n',
        });

        const result = scanTestResourceOwnership(dir.path, {
            baseline: {
                format: 'test-resource-ownership-baseline-v1',
                files: {
                    'tests/unit/legacy.test.js': { 'unregistered-root-directory': 1 },
                },
            },
        });
        expect(result.violations.some(v => v.file === 'tests/unit/new-file.test.js')).toBe(true);
        expect(result.violations.some(v => v.file === 'tests/unit/legacy.test.js')).toBe(false);
    });

    testWithResources('the repository passes the test resource ownership guard with zero unbaselined violations', async () => {
        const result = scanTestResourceOwnership(REPO_ROOT);
        expect(result.violations).toEqual([]);
        expect(result.staleBaseline).toEqual([]);
    });
});
