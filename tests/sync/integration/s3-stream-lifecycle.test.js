import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { createS3Client } from '../../../src/sync/backends/s3/client.js';
import { startDnsFixture } from '../_lib/network-fixtures.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let storage, proxy, admin, settings;
const clients = [];
function client() {
    const transport = createS3Client({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) }, settings });
    clients.push(transport);
    return transport;
}
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `streams-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    settings = { ...credentials, endpoint: proxy.endpoint, bucket, region: storage.region, prefix: '', forcePathStyle: true };
}, 240_000);
afterAll(async () => {
    await Promise.all(clients.map(value => value.close()));
    await proxy?.close(); admin?.destroy(); await storage?.stop();
});

test('source I/O failure event aborts a held real SDK upload without waiting for gate release', async () => {
    const transport = client();
    const source = new Readable({ read() {} });
    const gate = proxy.addFault({ match: { method: 'PUT', relativeKey: 'source-error' }, once: true, hold: 'before-forward' });
    const outcome = transport.put('source-error', source, { contentLength: 100 }).catch(error => error);
    source.push(Buffer.from('pending'));
    await gate.reached;
    source.destroy(Object.assign(new Error('secret file path'), { code: 'EIO' }));
    expect(await outcome).toMatchObject({ code: 'S3_SOURCE_ERROR' });
    expect(source.destroyed).toBe(true);
    gate.release();
    await transport.close();
});

test('close aborts held uploads and destroys unread GET bodies', async () => {
    const transport = client();
    await transport.put('download', randomBytes(1024 * 1024), { contentLength: 1024 * 1024 });
    const download = await transport.get('download');
    const source = new Readable({ read() {} });
    const gate = proxy.addFault({ match: { method: 'PUT', relativeKey: 'closing' }, once: true, hold: 'before-forward' });
    const outcome = transport.put('closing', source, { contentLength: 100 }).catch(error => error);
    source.push(Buffer.from('pending'));
    await gate.reached;
    await transport.close();
    expect(await outcome).toBeInstanceOf(Error);
    expect(source.destroyed).toBe(true);
    expect(download.body.destroyed).toBe(true);
    gate.release();
    await expect(transport.head('download')).rejects.toMatchObject({ code: 'S3_TRANSPORT_CLOSED' });
});

test.each(['precondition', 'auth'])('real early %s rejection destroys a pending source', async mode => {
    const transport = client();
    const key = `early-${mode}`;
    await transport.put(key, Buffer.from('existing'), { contentLength: 8 });
    const source = new Readable({ read() {} });
    const rejected = mode === 'auth' ? createS3Client({ owner: {}, settings: { ...settings, secretAccessKey: 'bad' } }) : transport;
    const gate = mode === 'precondition' ? proxy.addFault({ match: { method: 'PUT', relativeKey: key }, once: true, hold: 'after-first-body-chunk' }) : null;
    clients.push(rejected);
    const outcome = rejected.put(key, source, { contentLength: 100, ifNoneMatch: '*' }).catch(error => error);
    source.push(Buffer.from('pending'));
    if (gate) { await gate.reached; gate.release(); }
    const error = await outcome;
    expect(error).toMatchObject(mode === 'auth' ? { code: 'AUTH_FAILED' } : { $metadata: { httpStatusCode: 412 } });
    expect(source.destroyed).toBe(true);
    await rejected.close();
});

test('an early actual upstream success also destroys a pending source', async () => {
    const transport = client();
    const source = new Readable({ read() {} });
    const gate = proxy.addFault({ match: { method: 'PUT', relativeKey: 'early-success' }, once: true, hold: 'after-first-body-chunk', stripHeaders: ['if-none-match'] });
    const outcome = transport.put('early-success', source, { contentLength: 100, ifNoneMatch: '*' });
    source.push(Buffer.from('pending'));
    const record = await gate.reached;
    gate.release();
    expect(await outcome).toMatchObject({ etag: expect.any(String) });
    expect(record.upstreamStatus).toBe(200);
    expect(source.closed).toBe(true);
    await transport.close();
});

test.each(['reset', 'destroy'])('%s settles a pending upload and releases the source', async mode => {
    const transport = client();
    const source = new Readable({ read() {} });
    const gate = proxy.addFault({ match: { method: 'PUT', relativeKey: mode }, once: true, hold: 'before-forward' });
    const outcome = transport.put(mode, source, { contentLength: 100 }).catch(error => error);
    source.push(Buffer.from('pending'));
    const record = await gate.reached;
    if (mode === 'reset') gate.cancel(); else source.destroy();
    expect(await outcome).toMatchObject({ code: mode === 'reset' ? 'UNREACHABLE' : 'S3_SOURCE_ERROR' });
    expect(source.destroyed).toBe(true);
    gate.release();
    await transport.close();
    expect(source.listeners('error')).toEqual([]);
    expect(record.responseDelivered).toBe(false);
});

test('actual file uploads release ownership on success and actual file-open failure', async () => {
    const transport = client();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 's3-source-'));
    try {
        const file = path.join(dir, 'ciphertext');
        const bytes = randomBytes(65577);
        await fsp.writeFile(file, bytes);
        const source = fs.createReadStream(file);
        await transport.put('file', source, { contentLength: bytes.length });
        expect(source.closed).toBe(true);
        const result = await transport.get('file');
        expect(Buffer.from(await result.body.transformToByteArray())).toEqual(bytes);
        await fsp.unlink(file);
        const missing = fs.createReadStream(file);
        await expect(transport.put('missing-file', missing, { contentLength: bytes.length })).rejects.toMatchObject({ code: 'S3_SOURCE_ERROR' });
        expect(missing.closed).toBe(true);
        await transport.close();
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('forwarding-only conditional PUT barrier holds original bytes and completes their exact body', async () => {
    const transport = client();
    // Larger than HTTP's first socket chunk, so the barrier cannot observe a
    // complete body. This is fixture data, not a transport size restriction.
    const bytes = randomBytes(256 * 1024);
    const source = Readable.from([bytes]);
    const gate = proxy.addFault({ match: { method: 'PUT', relativeKey: 'original-forwarding' }, hold: 'after-first-forwarded-body-chunk' });
    const outcome = transport.put('original-forwarding', source, { contentLength: bytes.length, ifNoneMatch: '*' });
    // An earlier assertion can fail while the original upload is still held.
    const settled = outcome.catch(() => {});
    try {
        const record = await gate.reached;
        expect(Number(record.headers['content-length'])).toBe(bytes.length);
        expect(record.bytesObserved).toBeGreaterThan(0);
        expect(record.bytesObserved).toBeLessThan(bytes.length);
        expect(record.bytesForwarded).toBe(record.bytesObserved);
        expect(record.upstreamStatus).toBeNull();
        gate.release();
        expect(await outcome).toMatchObject({ etag: expect.any(String) });
        expect(record.upstreamStatus).toBe(200);
        const stored = await transport.get('original-forwarding');
        expect(Buffer.from(await stored.body.transformToByteArray())).toEqual(bytes);
        expect(source.closed).toBe(true);
    } finally {
        gate.release();
        try { await transport.close(); } finally { await settled; }
    }
});

test('SDK close cancels pending DNS admission before any dial', async () => {
    const dns = await startDnsFixture();
    dns.setAnswers('held.sync.test', { a: ['127.0.0.1'], aaaa: [] });
    const gate = dns.holdNext('held.sync.test');
    const observations = [];
    const transport = createS3Client({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) }, settings: { ...settings, endpoint: settings.endpoint.replace('127.0.0.1', 'held.sync.test') }, network: {
        resolveAll: dns.resolveAll,
        onValidatedDial: value => observations.push(value),
    } });
    clients.push(transport);
    try {
        const outcome = transport.get('held').catch(error => error);
        await gate.reached;
        await transport.close();
        expect(await outcome).toBeInstanceOf(Error);
        gate.release();
        await new Promise(resolve => setImmediate(resolve));
        expect(observations).toEqual([]);
    } finally { gate.release(); await dns.close(); }
});

test('download first-chunk barrier retains body ownership until explicit close', async () => {
    const transport = client();
    const bytes = randomBytes(1024 * 1024);
    await transport.put('held-download', bytes, { contentLength: bytes.length });
    const gate = proxy.addFault({ match: { method: 'GET', relativeKey: 'held-download' }, once: true, hold: 'after-first-body-chunk' });
    const pending = transport.get('held-download');
    const record = await gate.reached;
    const response = await pending;
    await transport.close();
    expect(response.body.destroyed).toBe(true);
    gate.release();
    await new Promise(resolve => setImmediate(resolve));
    expect(record.responseDelivered).toBe(false);
});
