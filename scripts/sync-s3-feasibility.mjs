#!/usr/bin/env node
// Prints the S3 sync feasibility report as JSON. Configure through env:
// LUKER_S3_ENDPOINT, LUKER_S3_REGION, LUKER_S3_BUCKET, LUKER_S3_PREFIX,
// LUKER_S3_ACCESS_KEY_ID, LUKER_S3_SECRET_ACCESS_KEY,
// LUKER_S3_FORCE_PATH_STYLE=1, LUKER_S3_STRIP_IF_MATCH_QUOTES=1,
// LUKER_S3_CREATE_BUCKET=1.
// Run with `node --jitless` to reproduce the HarmonyOS runtime.
import { runS3Feasibility } from '../src/sync/backends/s3/feasibility.js';

const e = process.env;
const report = await runS3Feasibility({
    endpoint: e.LUKER_S3_ENDPOINT,
    region: e.LUKER_S3_REGION || 'us-east-1',
    bucket: e.LUKER_S3_BUCKET,
    prefix: e.LUKER_S3_PREFIX || '',
    accessKeyId: e.LUKER_S3_ACCESS_KEY_ID,
    secretAccessKey: e.LUKER_S3_SECRET_ACCESS_KEY,
    forcePathStyle: e.LUKER_S3_FORCE_PATH_STYLE === '1',
    stripIfMatchQuotes: e.LUKER_S3_STRIP_IF_MATCH_QUOTES === '1',
    createBucket: e.LUKER_S3_CREATE_BUCKET === '1',
});
process.stdout.write(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
