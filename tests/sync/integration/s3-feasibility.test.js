import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { runS3Feasibility } from '../../../src/sync/backends/s3/feasibility.js';

let s3;
beforeAll(async () => { s3 = await startRustfsContainer(); }, 240_000);
afterAll(async () => { await s3?.stop(); });

describe('runS3Feasibility against real RustFS', () => {
    test('every step passes and reports timings', async () => {
        const report = await runS3Feasibility({
            endpoint: s3.endpoint, region: s3.region, bucket: `feas${Date.now()}`,
            accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey,
            forcePathStyle: true, createBucket: true,
        });
        const failed = report.steps.filter(s => !s.ok);
        expect(failed).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.steps.map(s => s.name)).toEqual([
            'sdk.import', 'client.init', 'bucket.create', 'put.ifNoneMatch.new', 'put.ifNoneMatch.exists412',
            'put.ifMatch.wrong412', 'put.ifMatch.right', 'get', 'head', 'list', 'delete',
            'scrypt', 'aesgcm.1MiB', 'aesgcm.50MiB', 'git.prepareSample', 'git.packObjects', 'git.indexPack',
        ]);
        for (const s of report.steps) expect(typeof s.ms).toBe('number');
    }, 240_000);

    test('a wrong secret makes the S3 steps fail with an error, not a throw', async () => {
        const report = await runS3Feasibility({
            endpoint: s3.endpoint, region: s3.region, bucket: `feasbad${Date.now()}`,
            accessKeyId: s3.accessKeyId, secretAccessKey: 'wrong', forcePathStyle: true, createBucket: true,
        });
        expect(report.ok).toBe(false);
        const create = report.steps.find(s => s.name === 'bucket.create');
        expect(create.ok).toBe(false);
        expect(create.error).toMatch(/\S/);
    }, 240_000);
});
