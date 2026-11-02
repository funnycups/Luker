import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let s3;
beforeAll(async () => { s3 = await startRustfsContainer(); }, 240_000);
afterAll(async () => { await s3?.stop(); });

test('all feasibility steps pass in a real --jitless child process', () => {
    const out = execFileSync(process.execPath, ['--jitless', 'scripts/sync-s3-feasibility.mjs'], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            LUKER_S3_ENDPOINT: s3.endpoint, LUKER_S3_REGION: s3.region, LUKER_S3_BUCKET: `jitless${Date.now()}`,
            LUKER_S3_ACCESS_KEY_ID: s3.accessKeyId, LUKER_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
            LUKER_S3_FORCE_PATH_STYLE: '1', LUKER_S3_CREATE_BUCKET: '1',
        },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.env.hasWasm).toBe(false);
    expect(report.steps.filter(s => !s.ok)).toEqual([]);
}, 240_000);
