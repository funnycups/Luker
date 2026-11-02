import { beforeAll, afterAll, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { deriveKey } from '../../../src/sync/backends/s3/crypto.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const childPath = 'tests/sync/_lib/s3-backend-child.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let storage, proxy, admin, scratch, input;
const expected = [];

beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `production-jitless-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 's3-production-jitless-'));
    for (const mib of [1, 50]) {
        const bytes = randomBytes(mib * 1024 * 1024);
        const filename = `${mib}mib.bin`;
        fs.writeFileSync(path.join(scratch, filename), bytes);
        expected.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    input = { endpoint: proxy.endpoint, region: storage.region, bucket, prefix: 'production', forcePathStyle: true,
        accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, passphrase: `private acceptance ${randomBytes(16).toString('hex')}` };
}, 240_000);

afterAll(async () => {
    await proxy?.close();
    admin?.destroy();
    await storage?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

async function runChild(execArgv) {
    const child = spawn(process.execPath, [...execArgv, childPath], { cwd: root,
        env: { ...process.env, LUKER_FORCE_JITLESS: '1', LUKER_S3_ACCEPTANCE_INPUT: JSON.stringify(input), LUKER_S3_ACCEPTANCE_ROOT: scratch },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const terminal = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { ...terminal, stdout, stderr };
}

test('compatibility selection alone cannot claim actual-jitless acceptance', async () => {
    const result = await runChild([]);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ACTUAL_JITLESS_REQUIRED');
});

test('actual --jitless uses production setup, crypto, immutable pack publication and verified indexed pull', async () => {
    const result = await runChild(['--jitless']);
    expect(result.signal).toBeNull();
    expect(`${result.code}\n${result.stderr}`).toMatch(/^0\n/);
    const report = JSON.parse(result.stdout);
    expect(report.runtime).toMatchObject({ execArgv: expect.arrayContaining(['--jitless']), hasWebAssembly: false, compatibility: true, node: process.version });
    expect(report.kdf).toEqual({ v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1, independentlyMatched: true });
    expect(report.payloads).toEqual(expected.map(value => ({ ...value, decryptedBytes: value.bytes, decryptedSha256: value.sha256,
        pulledBytes: value.bytes, pulledSha256: value.sha256, gitBytes: value.bytes, gitSha256: value.sha256 })));
    expect(report.negativeControls).toEqual({ truncated: true, tampered: 'S3_OBJECT_AUTH_FAILED', wrongPhrase: 'S3_WRONG_PASSPHRASE', damagedIndex: 'S3_PACK_INVALID', staleCas: { ok: false, reason: 'conflict' } });
    expect(report.closure).toEqual({ source: true, receiver: true, sameHead: true, exactObjectSet: true });
    expect(report.packs).toHaveLength(1);
    expect(report.packs[0]).toMatchObject({ objects: report.reachableObjects, indexVerified: true, immutable: true });
    expect(report.closed).toBe(true);
    const puts = proxy.requests.filter(record => record.method === 'PUT');
    expect(puts.filter(record => /\/packs\//.test(record.relativeKey)).map(record => record.headers['if-none-match'])).toEqual(['*']);
    expect(puts.filter(record => record.relativeKey === 'production/head').map(record => record.upstreamStatus)).toEqual([200, 200, 412]);
    const metadata = await admin.send(new GetObjectCommand({ Bucket: input.bucket, Key: 'production/keyinfo.json' }));
    const keyinfo = JSON.parse(await metadata.Body.transformToString());
    const key = await deriveKey(input.passphrase, keyinfo);
    for (const secret of [input.accessKeyId, input.secretAccessKey, input.passphrase, key.toString('base64')]) {
        expect((result.stdout + result.stderr).includes(secret)).toBe(false);
    }
    console.log(`Actual-jitless production evidence: ${result.stdout.trim()}`);
}, 600_000);
