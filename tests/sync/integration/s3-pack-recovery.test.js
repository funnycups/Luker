import { beforeAll, afterAll, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import git from 'isomorphic-git';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { startS3Proxy } from '../../e2e/_lib/s3-proxy.js';
import { createS3Client } from '../../../src/sync/backends/s3/client.js';
import { encryptObject } from '../../../src/sync/backends/s3/crypto.js';
import { fetchAndIndexPacks, readIndexedPacks, prepareLocalPackStore } from '../../../src/sync/backends/s3/packs.js';
import { ensureShadowRepo, getShadowPaths } from '../../../src/sync/shadow.js';
import { hasCompleteClosure } from '../../../src/sync/objects.js';
import { buildPackFixture, startPackChild, objectOid, rawPack, refDelta } from '../_lib/s3-pack-fixtures.js';

let storage, admin, proxy, settings, transport;
const key = randomBytes(32), keyId = randomBytes(8).toString('hex');
beforeAll(async () => {
    storage = await startRustfsContainer();
    const credentials = { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey };
    admin = new S3Client({ endpoint: storage.endpoint, region: storage.region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucket = `packs-${randomBytes(8).toString('hex')}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    proxy = await startS3Proxy({ upstream: storage.endpoint, credentials, region: storage.region });
    settings = { ...credentials, endpoint: proxy.endpoint, bucket, region: storage.region, prefix: '', forcePathStyle: true };
    transport = createS3Client({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) }, settings });
}, 240_000);
afterAll(async () => { await transport?.close(); await proxy?.close(); admin?.destroy(); await storage?.stop(); });

async function publish(pack) {
    const name = randomBytes(16).toString('hex'), relativeKey = `packs/${name}`;
    const bytes = encryptObject({ key, keyId, domain: 'pack', context: settings, relativeKey, plaintext: pack });
    await transport.put(relativeKey, bytes, { contentLength: bytes.length, ifNoneMatch: '*' });
    return { name, size: bytes.length };
}
async function history(body = Buffer.from('hello')) {
    const blob = objectOid('blob', body);
    const treeBody = Buffer.concat([Buffer.from('100644 hello\0'), Buffer.from(blob, 'hex')]);
    const tree = objectOid('tree', treeBody);
    const commitBody = Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.org> 1 +0000\ncommitter Fixture <fixture@example.org> 1 +0000\n\nfixture\n`);
    const commit = objectOid('commit', commitBody);
    const fixture = await buildPackFixture({ objects: [{ body }, { type: 'tree', body: treeBody }, { type: 'commit', body: commitBody }] });
    return { ...fixture, commit, blob, body, treeBody, commitBody };
}
const headFor = (commit, packs) => ({ v: 1, commit, packs, compactedFrom: [] });
async function fetch(paths, head, withLocal = fn => fn()) {
    return fetchAndIndexPacks({ transport, paths, key, keyId, context: settings, head, withLocal });
}

test.each(['s3-download-after-first-chunk', 's3-pack-installed-before-index', 's3-indexed-before-ledger'])('actual SIGKILL at %s converges on restart with durable metadata and readable closure', async failpoint => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-crash-'));
    try {
        const fixture = await history(randomBytes(128 * 1024));
        const remote = await publish(fixture.pack), head = headFor(fixture.commit, [remote]);
        const dead = startPackChild({ root, endpoint: proxy.endpoint, settings, head, failpoint, key, keyId });
        const death = await dead.exited;
        if (death.signal !== 'SIGKILL') throw new Error(dead.stderr.join(''));
        expect(death).toEqual({ code: null, signal: 'SIGKILL' });
        expect(dead.stderr.join('')).toContain(`luker-sync-failpoint: ${failpoint}`);
        const paths = getShadowPaths({ userRoot: root, peerId: 's3-test' });
        const packdir = path.join(paths.gitDir, 'objects/pack');
        const visible = await fs.readdir(packdir);
        expect(visible.filter(name => name.endsWith('.idx')).length).toBe(failpoint === 's3-indexed-before-ledger' ? 1 : 0);
        expect((await readIndexedPacks(paths)).packs).toEqual({});
        // These belong to live-category swap recovery, never S3 transfer cleanup.
        const parked = path.join(paths.peerDir, '.luker-staging-replaced-legacy');
        await fs.mkdir(parked); await fs.writeFile(path.join(parked, 'data'), 'preserve');
        const restarted = startPackChild({ root, endpoint: proxy.endpoint, settings, head, key, keyId });
        expect(await restarted.exited).toEqual({ code: 0, signal: null });
        const ledger = await readIndexedPacks(paths);
        expect(ledger.packs[remote.name]).toMatchObject({ size: remote.size });
        expect((await fs.stat(path.join(paths.peerDir, 's3-packs.json'))).mode & 0o777).toBe(0o600);
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: fixture.commit, verify: true })).toBe(true);
        expect(await fs.readFile(path.join(parked, 'data'), 'utf8')).toBe('preserve');
        expect((await fs.readdir(paths.peerDir)).filter(name => /^\.luker-staging-s3-/.test(name))).toEqual([]);
        const before = proxy.requests.filter(record => record.method === 'GET').length;
        await fetch(paths, head);
        expect(proxy.requests.filter(record => record.method === 'GET')).toHaveLength(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 120_000);

test.each(['pack-only', 'loose-only'])('real indexPack bridges an external REF_DELTA base from validated %s storage', async kind => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-delta-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const base = Buffer.from('hello'), baseOid = objectOid('blob', base);
        if (kind === 'loose-only') {
            await git.writeBlob({ fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir, blob: base });
        } else {
            const fixture = await buildPackFixture({ objects: [{ body: base }] });
            const filename = `pack-${fixture.pack.subarray(-20).toString('hex')}`;
            await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${filename}.pack`), fixture.pack);
            await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${filename}.idx`), fixture.index);
        }
        const result = await history(Buffer.from('hello!'));
        const metadata = await buildPackFixture({ objects: [{ type: 'tree', body: result.treeBody }, { type: 'commit', body: result.commitBody }] });
        const delta = rawPack([refDelta(baseOid, Buffer.from([5, 6, 0x90, 5, 1, 33]))]);
        const packs = [await publish(metadata.pack), await publish(delta)];
        let bridged = false;
        await fetch(paths, headFor(result.commit, packs), async fn => {
            const value = await fn();
            // The candidate private ODB has been removed on settlement, but is
            // observable before the local callback returns from publication.
            for (const name of await fs.readdir(paths.peerDir)) {
                if (!name.startsWith('.luker-staging-s3-')) continue;
                const loose = path.join(paths.peerDir, name, 'repo.git/objects', baseOid.slice(0, 2), baseOid.slice(2));
                try {
                    await fs.stat(loose);
                    const object = await git.readObject({ fs: { promises: fs }, dir: path.join(paths.peerDir, name, 'workdir'), gitdir: path.join(paths.peerDir, name, 'repo.git'), oid: baseOid, format: 'content', cache: {} });
                    expect(object.type).toBe('blob');
                    expect(Buffer.from(object.object)).toEqual(base);
                    bridged = true;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            return value;
        });
        expect(bridged).toBe(true);
        expect(Buffer.from((await git.readBlob({ fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir, oid: result.blob })).blob).toString()).toBe('hello!');
        expect(Object.keys((await readIndexedPacks(paths)).packs)).toHaveLength(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('corrupt authenticated unrelated pack rejects even when wanted closure is already loose-present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-badpack-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const fixture = await history();
        for (const object of [{ type: 'blob', body: fixture.body }, { type: 'tree', body: fixture.treeBody }, { type: 'commit', body: fixture.commitBody }]) {
            await git.writeObject({ fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir, type: object.type, object: object.body, format: 'content' });
        }
        const bad = await buildPackFixture({ objects: [{ body: Buffer.from('unrelated') }] });
        bad.pack[bad.pack.length - 1] ^= 1;
        await expect(fetch(paths, headFor(fixture.commit, [await publish(bad.pack)]))).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
        expect((await readIndexedPacks(paths)).packs).toEqual({});
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing external base rejects without candidate index or ledger and authentication precedes installation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-missing-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const delta = rawPack([refDelta(objectOid('blob', Buffer.from('hello')), Buffer.from([5, 6, 0x90, 5, 1, 33]))]);
        await expect(fetch(paths, headFor('a'.repeat(40), [await publish(delta)]))).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
        const name = randomBytes(16).toString('hex'), relativeKey = `packs/${name}`;
        const bytes = encryptObject({ key, keyId, domain: 'pack', context: settings, relativeKey, plaintext: delta }); bytes[bytes.length - 1] ^= 1;
        await transport.put(relativeKey, bytes, { contentLength: bytes.length });
        await expect(fetch(paths, headFor('a'.repeat(40), [{ name, size: bytes.length }]))).rejects.toMatchObject({ code: 'S3_OBJECT_AUTH_FAILED' });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
        expect((await readIndexedPacks(paths)).packs).toEqual({});
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test.each(['pack-missing', 'pack-corrupt', 'index-missing', 'index-corrupt', 'ledger-missing', 'ledger-corrupt'])('%s does not suppress authenticated repair', async damage => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-repair-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const fixture = await history(), remote = await publish(fixture.pack), head = headFor(fixture.commit, [remote]);
        await fetch(paths, head);
        const record = (await readIndexedPacks(paths)).packs[remote.name];
        const packFile = path.join(paths.gitDir, 'objects/pack', record.filename), indexFile = packFile.replace('.pack', '.idx');
        const target = damage.startsWith('pack-') ? packFile : damage.startsWith('index-') ? indexFile : path.join(paths.peerDir, 's3-packs.json');
        if (damage.endsWith('missing')) await fs.unlink(target);
        else await fs.writeFile(target, 'damaged');
        const before = proxy.requests.filter(record => record.method === 'GET').length;
        await fetch(paths, head);
        expect(proxy.requests.filter(record => record.method === 'GET').length).toBeGreaterThan(before);
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: fixture.commit, verify: true })).toBe(true);
        expect((await readIndexedPacks(paths)).packs[remote.name]).toEqual(record);
        expect((await fs.readdir(paths.peerDir)).some(name => name.startsWith('s3-packs.json.unreadable-'))).toBe(damage === 'ledger-corrupt');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unchanged retained pack histories validate a linear artifact inventory rather than rescanning it for every advertised pack', async () => {
    const measurements = [];
    for (const count of [4, 8, 16]) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-inventory-work-'));
        try {
            const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
            const packs = [];
            let commit;
            for (let index = 0; index < count; index++) {
                const body = Buffer.from(`retained payload ${index}`);
                const blob = objectOid('blob', body);
                const treeBody = Buffer.concat([Buffer.from('100644 retained\0'), Buffer.from(blob, 'hex')]);
                const tree = objectOid('tree', treeBody);
                const commitBody = Buffer.from(`tree ${tree}\n${commit ? `parent ${commit}\n` : ''}author Fixture <fixture@example.org> ${index + 1} +0000\ncommitter Fixture <fixture@example.org> ${index + 1} +0000\n\nretained ${index}\n`);
                commit = objectOid('commit', commitBody);
                const fixture = await buildPackFixture({ objects: [{ body }, { type: 'tree', body: treeBody }, { type: 'commit', body: commitBody }] });
                packs.push(await publish(fixture.pack));
            }
            const head = headFor(commit, packs);
            await fetch(paths, head);
            const before = proxy.requests.filter(record => record.method === 'GET').length;
            const packdir = path.join(paths.gitDir, 'objects/pack');
            const originalRead = fs.readFile, originalList = fs.readdir;
            const reads = new Map();
            let enumerations = 0;
            fs.readFile = async (file, ...args) => {
                const data = await originalRead(file, ...args);
                if (path.dirname(String(file)) === packdir && /\.(pack|idx)$/.test(String(file))) reads.set(String(file), (reads.get(String(file)) ?? 0) + 1);
                return data;
            };
            fs.readdir = async (file, ...args) => {
                if (String(file) === packdir) enumerations++;
                return originalList(file, ...args);
            };
            try { await fetch(paths, head); } finally { fs.readFile = originalRead; fs.readdir = originalList; }
            const artifactReads = [...reads.values()].reduce((sum, value) => sum + value, 0);
            measurements.push({ count, artifactReads, enumerations, distinctArtifacts: reads.size });
            expect(proxy.requests.filter(record => record.method === 'GET')).toHaveLength(before);
            expect(reads.size).toBe(count * 2);
            expect([...reads.values()].every(value => value >= 2)).toBe(true);
            expect(artifactReads).toBeLessThanOrEqual(count * 6);
            expect(enumerations).toBeLessThanOrEqual(count * 3 + 2);
        } finally { await fs.rm(root, { recursive: true }); }
    }
    console.log('validated-pack-inventory-work', JSON.stringify(measurements));
}, 120_000);

test('a batch skip decision is revalidated after network release even when the damaged pack has a loose duplicate and unchanged stat fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-inventory-epoch-'));
    let gate;
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const original = await history(Buffer.from('old payload'));
        const remote = await publish(original.pack);
        await fetch(paths, headFor(original.commit, [remote]));
        for (const object of [{ type: 'blob', body: original.body }, { type: 'tree', body: original.treeBody }, { type: 'commit', body: original.commitBody }]) await git.writeObject({ fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir, type: object.type, object: object.body, format: 'content' });
        const next = await history(Buffer.from('new payload'));
        const second = await publish(next.pack);
        const head = headFor(next.commit, [remote, second]);
        const record = (await readIndexedPacks(paths)).packs[remote.name];
        const packfile = path.join(paths.gitDir, 'objects/pack', record.filename);
        const stat = await fs.stat(packfile);
        const bytes = await fs.readFile(packfile);
        gate = proxy.addFault({ match: { method: 'GET', keySuffix: `packs/${second.name}` }, once: true, hold: 'before-forward' });
        const outcome = fetch(paths, head).then(() => ({ succeeded: true }), error => ({ error }));
        await gate.reached;
        const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
        await fs.writeFile(packfile, damaged);
        await fs.utimes(packfile, stat.atime, stat.mtime);
        gate.release();
        expect(await outcome).toMatchObject({ error: { code: 'S3_INCOMPLETE_OBJECTS' } });
        expect((await readIndexedPacks(paths)).packs[remote.name]).toBeUndefined();
        await fetch(paths, head);
        expect((await readIndexedPacks(paths)).packs[remote.name]).toEqual(record);
        expect(await fs.readFile(packfile)).toEqual(bytes);
    } finally { gate?.release(); await fs.rm(root, { recursive: true }); }
});

test('concurrent prepare never sweeps an active same-process download and local lease removal rejects publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-lease-'));
    let gate;
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const fixture = await history(), remote = await publish(fixture.pack), head = headFor(fixture.commit, [remote]);
        gate = proxy.addFault({ match: { method: 'GET', keySuffix: `packs/${remote.name}` }, once: true, hold: 'before-forward' });
        let removed = false;
        const outcome = fetch(paths, head, async fn => {
            if (removed) throw Object.assign(new Error('Removed'), { code: 'SYNC_BACKEND_REMOVED' });
            return fn();
        }).catch(error => error);
        await gate.reached;
        const staged = (await fs.readdir(paths.peerDir)).filter(name => name.startsWith('.luker-staging-s3-'));
        expect(staged).toHaveLength(1);
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect((await fs.readdir(paths.peerDir)).filter(name => name.startsWith('.luker-staging-s3-'))).toEqual(staged);
        removed = true; gate.release();
        expect(await outcome).toMatchObject({ code: 'SYNC_BACKEND_REMOVED' });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
        expect((await readIndexedPacks(paths)).packs).toEqual({});
    } finally { gate?.release(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cross-pack delta dependency cycles are quarantined before any Git enumeration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-cycle-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-test' });
        const a = Buffer.from('hello'), b = Buffer.from('world');
        for (const [base, result] of [[a, b], [b, a]]) {
            const pack = rawPack([refDelta(objectOid('blob', base), Buffer.from([5, 5, 5, ...result]))]);
            const filename = `pack-${pack.subarray(-20).toString('hex')}`;
            await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${filename}.pack`), pack);
            // Real indexPack omits the unresolved delta, which must not grant acceptance.
            const fixture = await buildPackFixture({ deltas: [refDelta(objectOid('blob', base), Buffer.from([5, 5, 5, ...result]))] });
            await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${filename}.idx`), fixture.index);
        }
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
