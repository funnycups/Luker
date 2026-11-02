import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { createS3Client, probeConditionalWrites } from '../../../src/sync/backends/s3/client.js';
import { encryptObject } from '../../../src/sync/backends/s3/crypto.js';
import { startDnsFixture, startTlsFixture, startHttpFixture } from '../_lib/network-fixtures.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { getConfigFilePath, setConfigFilePath, reloadConfigCache } from '../../../src/util.js';

let storage, admin, proxy, settings;
const transports = [];
const owner = { getCurrentProfile: async () => ({ enabled: true, admin: true }) };
function transport(overrides = {}) {
    const client = createS3Client({ owner, settings: { ...settings, ...overrides } });
    transports.push(client);
    return client;
}
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `client-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    settings = { ...credentials, endpoint: proxy.endpoint, bucket, region: storage.region, prefix: 'namespace', forcePathStyle: true };
}, 240_000);
afterAll(async () => {
    await Promise.all(transports.map(client => client.close()));
    await proxy?.close();
    admin?.destroy();
    await storage?.stop();
});

test.each(['buffer', 'stream'])('real %s PUT uses exact encrypted Content-Length without aws-chunked', async kind => {
    const client = transport();
    const key = `packs/${randomBytes(16).toString('hex')}`;
    const bytes = encryptObject({ key: randomBytes(32), keyId: randomBytes(8).toString('hex'), domain: 'pack', context: settings, relativeKey: key, plaintext: randomBytes(65536) });
    const result = await client.put(key, kind === 'buffer' ? bytes : Readable.from([bytes]), { contentLength: bytes.length, ifNoneMatch: '*' });
    expect(result.etag).toMatch(/^".+"$/);
    const record = await proxy.waitForRequest({ method: 'PUT', keySuffix: key });
    expect(record.headers['content-length']).toBe(String(bytes.length));
    expect(record.headers['content-encoding'] ?? '').not.toContain('aws-chunked');
    expect(record.headers['x-amz-trailer']).toBeUndefined();
    expect(record.bytesObserved).toBe(bytes.length);
    const downloaded = await client.get(key);
    expect(Buffer.from(await downloaded.body.transformToByteArray())).toEqual(bytes);
    expect(downloaded).toMatchObject({ etag: result.etag, size: bytes.length });
    expect(await client.head(key)).toEqual({ etag: result.etag, size: bytes.length });
    expect((await client.list('packs/')).objects).toContainEqual({ key, etag: result.etag, size: bytes.length });
    await expect(client.put(key, bytes, { contentLength: bytes.length, ifNoneMatch: '*' })).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const replacement = await client.put(key, bytes, { contentLength: bytes.length, ifMatch: result.etag });
    expect(replacement.etag).toBe(result.etag);
    await client.delete(key);
    expect(await client.get(key)).toBeNull();
    expect(await client.head(key)).toBeNull();
});

test('concurrent probes use independent attempt keys and require real precondition failures', async () => {
    const client = transport();
    await Promise.all([probeConditionalWrites(client), probeConditionalWrites(client)]);
    const creates = proxy.requests.filter(record => record.method === 'PUT' && record.relativeKey.includes('/.probe/'));
    expect(new Set(creates.map(record => record.relativeKey)).size).toBe(2);
    expect(creates.filter(record => record.upstreamStatus === 412)).toHaveLength(4);
    expect((await client.list('.probe/')).objects).toEqual([]);
});

test.each([false, true])('If-Match quotes follow the backend setting when strip=%s', async strip => {
    const client = transport({ stripIfMatchQuotes: strip });
    const key = `packs/${randomBytes(16).toString('hex')}`;
    const bytes = randomBytes(64);
    const created = await client.put(key, bytes, { contentLength: bytes.length, ifNoneMatch: '*' });
    await client.put(key, bytes, { contentLength: bytes.length, ifMatch: created.etag });
    const record = await proxy.waitForRequest({ method: 'PUT', keySuffix: key, attempt: 2 });
    expect(record.headers['if-match']).toBe(strip ? created.etag.slice(1, -1) : created.etag);
});

test('setup detects a provider that accepts only a bare If-Match ETag', async () => {
    const prefix = `quoted-${randomBytes(8).toString('hex')}`;
    const client = transport({ prefix });
    const fault = proxy.addFault({ match: { method: 'PUT', keyPrefix: prefix }, rejectQuotedIfMatch: true, repeat: true });
    try {
        await expect(probeConditionalWrites(client)).rejects.toMatchObject({ code: 'S3_IF_MATCH_QUOTES_UNSUPPORTED' });
        const stripping = transport({ prefix, stripIfMatchQuotes: true });
        await probeConditionalWrites(stripping, { stripIfMatchQuotes: true });
        expect((await stripping.list('.probe/')).objects).toEqual([]);
    } finally { fault.cancel(); }
});

test.each([400, 501])('setup reports unsupported conditional writes when the provider answers %s', async status => {
    const fixture = await startHttpFixture((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(status, { 'content-type': 'application/xml' });
            res.end('<Error><Code>NotImplemented</Code><Message>conditional writes</Message></Error>');
        });
    });
    const client = createS3Client({ owner, settings: { ...settings, endpoint: fixture.url, prefix: '' } });
    transports.push(client);
    try {
        await expect(probeConditionalWrites(client)).rejects.toMatchObject({ code: 'CONDITIONAL_WRITES_UNSUPPORTED' });
    } finally { await fixture.close(); }
});

test('a 409 conditional request conflict is a retryable precondition failure', async () => {
    const fixture = await startHttpFixture((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(409, { 'content-type': 'application/xml' });
            res.end('<Error><Code>ConditionalRequestConflict</Code><Message>conflict</Message></Error>');
        });
    });
    const client = createS3Client({ owner, settings: { ...settings, endpoint: fixture.url, prefix: '' } });
    transports.push(client);
    try {
        await expect(client.put('head', Buffer.from('x'), { contentLength: 1, ifMatch: '"etag"' })).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED', $metadata: { httpStatusCode: 409 },
        });
    } finally { await fixture.close(); }
});

test.each(['if-match', 'if-none-match'])('stripping signed %s forwards to RustFS and rejects capability', async header => {
    const client = transport();
    const fault = proxy.addFault({ match: { method: 'PUT', attempt: header === 'if-match' ? 3 : 2, keySuffix: undefined }, once: true, stripHeaders: [header] });
    await expect(probeConditionalWrites(client)).rejects.toMatchObject({ code: 'CONDITIONAL_WRITES_UNSUPPORTED' });
    expect((await fault.reached).upstreamStatus).toBe(200);
    expect((await client.list('.probe/')).objects).toEqual([]);
});

test('wrong bucket and credentials are sanitized errors, not absence or capability unsupported', async () => {
    for (const client of [transport({ bucket: 'nonexistent-luker-bucket' }), transport({ secretAccessKey: 'private-invalid-secret' })]) {
        for (const operation of [() => client.get('absent'), () => client.head('absent'), () => probeConditionalWrites(client)]) {
            const error = await operation().catch(error => error);
            expect(['BUCKET_NOT_FOUND', 'AUTH_FAILED']).toContain(error.code);
            expect(String(error)).not.toMatch(/private-invalid-secret|luker-test-secret|SignatureDoesNotMatch|<Error>|X-Amz-/);
        }
    }
});

test('lost successful create response fails safely and a later probe uses a fresh key', async () => {
    const client = transport();
    const fault = proxy.addFault({ match: { method: 'PUT' }, once: true, dropResponseAfterUpstreamSuccess: true });
    await expect(probeConditionalWrites(client)).rejects.toMatchObject({ code: 'UNREACHABLE' });
    const lost = await fault.reached;
    expect(lost.upstreamStatus).toBe(200);
    expect(lost.responseDelivered).toBe(false);
    await probeConditionalWrites(client);
    const after = proxy.requests.filter(record => record.id > lost.id && record.method === 'PUT');
    expect(after.every(record => record.relativeKey !== lost.relativeKey)).toBe(true);
    expect((await client.list('.probe/')).objects).toEqual([]);
});

test('cleanup network failure does not reject a valid capability probe', async () => {
    const client = transport();
    const fault = proxy.addFault({ match: { method: 'DELETE' }, once: true, dropResponseAfterUpstreamSuccess: true });
    await probeConditionalWrites(client);
    expect((await fault.reached).upstreamStatus).toBe(204);
    await client.close();
});

test('cleanup failure preserves a primary unsupported-capability error', async () => {
    const client = transport();
    proxy.addFault({ match: { method: 'PUT', attempt: 2 }, once: true, stripHeaders: ['if-none-match'] });
    proxy.addFault({ match: { method: 'DELETE' }, once: true, dropResponseAfterUpstreamSuccess: true });
    await expect(probeConditionalWrites(client)).rejects.toMatchObject({ code: 'CONDITIONAL_WRITES_UNSUPPORTED' });
    await client.close();
});

test('SDK refuses redirects without hitting the target', async () => {
    const target = await startHttpFixture();
    try {
        proxy.addFault({ match: { method: 'GET', keySuffix: 'redirect' }, once: true, redirectTo: target.url });
        await expect(transport().get('redirect')).rejects.toMatchObject({ code: 'S3_PROVIDER_ERROR', $metadata: { httpStatusCode: 307 } });
        expect(target.hits).toEqual([]);
    } finally { await target.close(); }
});

test('invalid settings and request keys reject before remote work', async () => {
    const client = transport();
    const start = proxy.requests.length;
    expect(() => transport({ forcePathStyle: 'true' })).toThrow('S3_SETTINGS_INVALID');
    expect(() => transport({ endpoint: `${proxy.endpoint}?secret=hidden` })).toThrow('S3_SETTINGS_INVALID');
    await expect(client.get('../head')).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    await expect(client.list(null)).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    await expect(client.put('head', Buffer.alloc(1), { contentLength: 2 })).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    expect(proxy.requests).toHaveLength(start);
});

test('after-response gates expose actual storage status and do not alter unrelated requests', async () => {
    const client = transport();
    const key = 'gate-keyinfo.json';
    const gate = proxy.addFault({ match: { method: 'GET', keySuffix: key }, once: true, hold: 'after-upstream-response' });
    const result = client.get(key);
    const record = await gate.reached;
    expect(record.upstreamStatus).toBe(404);
    expect(record.responseDelivered).toBe(false);
    expect(await client.get('unrelated-absence')).toBeNull();
    gate.release();
    expect(await result).toBeNull();
    expect(record.responseDelivered).toBe(true);
});

test.each([true, false])('real DNS and TLS S3 transfer preserves base path and path-style=%s', async forcePathStyle => {
    const dns = await startDnsFixture();
    const hostname = forcePathStyle ? 'sync.test' : `${settings.bucket}.sync.test`;
    const signer = await admin.config.signer();
    // This reverse proxy maps the fixture's TLS virtual hosts and mount path
    // onto RustFS path addressing, signing the changed upstream route.
    const tls = await startTlsFixture({ dnsSans: [hostname], handler: (req, res) => {
        (async () => {
            const route = req.url.slice('/base'.length);
            const upstreamPath = forcePathStyle ? route : `/${settings.bucket}${route}`;
            const target = new URL(proxy.endpoint);
            const headers = { ...req.headers, host: target.host };
            delete headers.authorization;
            const parsed = new URL(upstreamPath, proxy.endpoint);
            const signed = await signer.sign({ protocol: target.protocol, hostname: target.hostname, method: req.method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers, body: req }, { signingRegion: settings.region, signingService: 's3' });
            const upstream = http.request(proxy.endpoint + upstreamPath, { method: req.method, headers: signed.headers }, response => {
                res.writeHead(response.statusCode, response.headers); response.pipe(res);
            });
            upstream.on('error', () => res.destroy()); req.pipe(upstream);
        })().catch(() => res.destroy());
    } });
    try {
        dns.setAnswers(hostname, { a: ['127.0.0.1'], aaaa: [] });
        const observations = [];
        const client = createS3Client({ owner, settings: { ...settings, endpoint: `https://sync.test:${tls.port}/base`, forcePathStyle }, network: { ca: tls.caPem, resolveAll: dns.resolveAll, onValidatedDial: value => observations.push(value) } });
        transports.push(client);
        const bytes = randomBytes(1234);
        await transport().put('tls', bytes, { contentLength: bytes.length });
        const result = await client.get('tls');
        expect(Buffer.from(await result.body.transformToByteArray())).toEqual(bytes);
        expect(tls.sniNames).toEqual([hostname]);
        expect(tls.hits).toHaveLength(1);
        expect(tls.hits[0].url).toBe(`/base/${forcePathStyle ? `${settings.bucket}/` : ''}namespace/tls?x-id=GetObject`);
        expect(observations).toEqual([expect.objectContaining({ hostname, address: '127.0.0.1' })]);
        expect(dns.queries.map(query => query.type).sort()).toEqual([1, 28]);
    } finally { await dns.close(); await tls.close(); }
});

test('SDK constructor CA preserves valid hostname and IP SAN identity and rejects wrong identities', async () => {
    const dns = await startDnsFixture();
    const signer = await admin.config.signer();
    const forward = (req, res) => {
        (async () => {
            const target = new URL(proxy.endpoint), parsed = new URL(req.url, proxy.endpoint);
            const headers = { ...req.headers, host: target.host }; delete headers.authorization;
            const signed = await signer.sign({ protocol: target.protocol, hostname: target.hostname, method: req.method, path: parsed.pathname,
                query: Object.fromEntries(parsed.searchParams), headers, body: req }, { signingRegion: settings.region, signingService: 's3' });
            const upstream = http.request(`${proxy.endpoint}${req.url}`, { method: req.method, headers: signed.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
            upstream.on('error', error => res.destroy(error)); req.pipe(upstream);
        })().catch(error => res.destroy(error));
    };
    const tls = await startTlsFixture({ dnsSans: ['sync.test'], ipSans: ['127.0.0.1'], handler: forward });
    const dnsOnly = await startTlsFixture({ dnsSans: ['sync.test'], handler: forward });
    const make = (endpoint, ca = tls.caPem) => {
        const client = createS3Client({ owner, settings: { ...settings, endpoint }, network: { resolveAll: dns.resolveAll, ca } });
        transports.push(client); return client;
    };
    try {
        for (const name of ['sync.test', 'wrong.test']) dns.setAnswers(name, { a: ['127.0.0.1'], aaaa: [] });
        const bytes = Buffer.from('complete trusted S3 payload');
        await transport().put('identity', bytes, { contentLength: bytes.length });
        for (const host of ['sync.test', '127.0.0.1']) {
            const downloaded = await make(`https://${host}:${tls.port}`).get('identity');
            expect(Buffer.from(await downloaded.body.transformToByteArray())).toEqual(bytes);
        }
        expect(tls.sniNames).toEqual(['sync.test', false]);
        expect(tls.hits.map(hit => hit.host)).toEqual([`sync.test:${tls.port}`, `127.0.0.1:${tls.port}`]);
        await expect(make(`https://wrong.test:${tls.port}`).get('identity')).rejects.toMatchObject({ code: 'UNREACHABLE' });
        await expect(make(`https://127.0.0.1:${dnsOnly.port}`, dnsOnly.caPem).get('identity')).rejects.toMatchObject({ code: 'UNREACHABLE' });
        expect(tls.hits).toHaveLength(2); expect(dnsOnly.hits).toEqual([]);
    } finally { await dns.close(); await tls.close(); await dnsOnly.close(); }
});

test('SDK mixed DNS and rebinding refuse forbidden hits at the production constructor boundary', async () => {
    const previous = process.env.LUKER_ENABLE_USER_ACCOUNTS;
    process.env.LUKER_ENABLE_USER_ACCOUNTS = 'true';
    const dns = await startDnsFixture(), observations = [];
    const before = proxy.requests.length;
    const client = createS3Client({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: false }) }, settings: { ...settings, endpoint: 'http://sync.test:0' },
        network: { resolveAll: dns.resolveAll, onValidatedDial: value => { observations.push(value); throw new Error('Public dial stopped after validation'); } } });
    transports.push(client);
    try {
        dns.setAnswers('sync.test', { a: ['8.8.8.8'], aaaa: ['::1'] });
        await expect(client.get('mixed')).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(observations).toEqual([]);
        dns.setAnswers('sync.test', { a: ['8.8.8.8'], aaaa: [] });
        await expect(client.get('public-observation')).rejects.toMatchObject({ code: 'UNREACHABLE' });
        expect(observations).toEqual([expect.objectContaining({ hostname: 'sync.test', address: '8.8.8.8' })]);
        dns.setAnswers('sync.test', { a: ['127.0.0.1'], aaaa: [] });
        await expect(client.get('rebound')).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(observations).toHaveLength(1);
        expect(proxy.requests).toHaveLength(before);
        expect(dns.queries.map(query => query.type).sort()).toEqual([1, 1, 1, 28, 28, 28]);
    } finally {
        await dns.close();
        if (previous === undefined) delete process.env.LUKER_ENABLE_USER_ACCOUNTS;
        else process.env.LUKER_ENABLE_USER_ACCOUNTS = previous;
    }
});

test('SDK literal policy and DNS-paused privilege revocation prevent dialing', async () => {
    const original = getConfigFilePath();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-policy-'));
    const dns = await startDnsFixture();
    let profile = { enabled: true, admin: false };
    const dynamicOwner = { getCurrentProfile: async () => profile };
    try {
        const config = path.join(dir, 'config.yaml');
        await fs.writeFile(config, 'enableUserAccounts: true\nsync:\n  allowPrivateAddressesForUsers: false\n');
        setConfigFilePath(config); reloadConfigCache();
        const network = { resolveAll: dns.resolveAll, onValidatedDial: value => observations.push(value) };
        const observations = [];
        for (const value of [profile, undefined, { enabled: false, admin: true }]) {
            profile = value;
            const client = createS3Client({ owner: dynamicOwner, settings, network }); transports.push(client);
            await expect(client.get('policy')).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            const source = new Readable({ read() {} });
            source.push(Buffer.from('pending'));
            await expect(client.put('policy-upload', source, { contentLength: 100 })).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            expect(source.closed).toBe(true);
        }
        profile = { enabled: true, admin: true };
        dns.setAnswers('sync.test', { a: ['127.0.0.1'], aaaa: [] });
        const hold = dns.holdNext('sync.test');
        const client = createS3Client({ owner: dynamicOwner, settings: { ...settings, endpoint: settings.endpoint.replace('127.0.0.1', 'sync.test') }, network }); transports.push(client);
        const result = client.get('revoked').catch(error => error);
        await hold.reached;
        profile = { enabled: true, admin: false };
        hold.release();
        expect(await result).toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(observations).toEqual([]);
        let reached, release;
        const reading = new Promise(resolve => { reached = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const closing = createS3Client({ owner: { getCurrentProfile: async () => { reached(); await held; return { enabled: true, admin: true }; } }, settings, network });
        transports.push(closing);
        const pending = closing.get('profile-close').catch(error => error);
        await reading;
        await closing.close();
        expect(await pending).toBeInstanceOf(Error);
        release();
        await new Promise(resolve => setImmediate(resolve));
        expect(observations).toEqual([]);
    } finally { setConfigFilePath(original); reloadConfigCache(); await dns.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
