import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'runtime';

async function acceptance() {
    if (!process.execArgv.includes('--jitless') || typeof WebAssembly !== 'undefined') {
        throw Object.assign(new Error('ACTUAL_JITLESS_REQUIRED'), { code: 'ACTUAL_JITLESS_REQUIRED' });
    }
    const input = JSON.parse(process.env.LUKER_S3_ACCEPTANCE_INPUT);
    const root = process.env.LUKER_S3_ACCEPTANCE_ROOT;
    const { setConfigFilePath } = await import('../../../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../../../default/config.yaml', import.meta.url)));
    globalThis.DATA_ROOT = root;
    const { default: git } = await import('isomorphic-git');
    const { FsEngine } = await import('../../../src/storage/engines/fs-engine.js');
    const { makeUserDirs } = await import('./user-dirs.js');
    const { prepareS3Backend } = await import('../../../src/sync/backends/s3/setup.js');
    const { createS3BackendEntry } = await import('../../../src/sync/state.js');
    const { syncService } = await import('../../../src/sync/sync-service.js');
    const { S3Backend } = await import('../../../src/sync/backends/s3/backend.js');
    const { createS3Client } = await import('../../../src/sync/backends/s3/client.js');
    const { encryptObject, decryptObject } = await import('../../../src/sync/backends/s3/crypto.js');
    const { decodeHead } = await import('../../../src/sync/backends/s3/layout.js');
    const { readIndexedPacks } = await import('../../../src/sync/backends/s3/packs.js');
    const { inspectPack, validatePackIndex } = await import('../../../src/sync/backends/s3/pack-integrity.js');
    const { atomicFs } = await import('../../../src/sync/pipeline/atomic-fs.js');
    const { hasCompleteClosure, listObjectsChildrenFirst } = await import('../../../src/sync/objects.js');
    const { getShadowPaths } = await import('../../../src/sync/shadow.js');
    const devices = [];
    let transport;
    async function device(name) {
        const userRoot = path.join(root, name);
        fs.mkdirSync(userRoot);
        const directories = makeUserDirs(userRoot);
        const owner = { userRoot, directories, handle: name, displayName: name,
            engine: new FsEngine({ directoriesByHandle: () => directories }), getCurrentProfile: async () => ({ enabled: true, admin: true }) };
        const id = `s3-${randomBytes(16).toString('hex')}`;
        const value = { owner, id, paths: getShadowPaths({ userRoot, peerId: id }) };
        devices.push(value);
        return value;
    }
    async function admitted(device, fn) {
        return syncService.withBackendOperation(device.owner, device.id, 'drive', async lease => {
            await lease.context();
            const backend = new S3Backend({ id: device.id, owner: device.owner, entry: device.entry, lease });
            try { return await fn(backend); } finally { await backend.close(); }
        });
    }
    async function consume(relativeKey) {
        const result = await transport.get(relativeKey);
        assert.ok(result, `Missing remote object ${relativeKey}`);
        try { return Buffer.from(await result.body.transformToByteArray()); }
        finally { result.body.destroy(); }
    }
    let report;
    try {
        stage = 'production setup';
        const a = await device('source'), b = await device('receiver');
        stage = 'source setup';
        const prepared = await prepareS3Backend({ owner: a.owner, input });
        stage = 'source registry installation';
        a.entry = await createS3BackendEntry({ userRoot: a.owner.userRoot, backendId: a.id, label: 'Source', categories: ['backgrounds'], s3: prepared.s3 });
        stage = 'receiver wrong-phrase rejection';
        await assert.rejects(prepareS3Backend({ owner: b.owner, input: { ...input, passphrase: 'wrong acceptance phrase' } }), { code: 'S3_WRONG_PASSPHRASE' });
        const receiver = await prepareS3Backend({ owner: b.owner, input });
        b.entry = await createS3BackendEntry({ userRoot: b.owner.userRoot, backendId: b.id, label: 'Receiver', categories: ['backgrounds'], s3: receiver.s3 });
        assert.ok(a.entry.s3.derivedKey === b.entry.s3.derivedKey, 'Independent setup must unlock the same key');
        transport = createS3Client({ owner: a.owner, settings: a.entry.s3 });
        const keyinfo = JSON.parse(await consume('keyinfo.json'));
        const { v, kdf, N, r, p } = keyinfo;
        assert.deepEqual({ v, kdf, N, r, p }, { v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1 });
        const key = Buffer.from(a.entry.s3.derivedKey, 'base64');
        const independent = await promisify(scrypt)(input.passphrase, Buffer.from(keyinfo.salt, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
        assert.ok(key.equals(independent), 'Default KDF must match independent built-in derivation');
        const context = a.entry.s3, keyId = context.keyId;
        report = { runtime: { execArgv: process.execArgv, hasWebAssembly: typeof WebAssembly !== 'undefined', compatibility: process.env.LUKER_FORCE_JITLESS === '1', node: process.version },
            kdf: { v, kdf, N, r, p, independentlyMatched: true }, payloads: [], negativeControls: {} };
        stage = 'complete payload encryption';
        for (const mib of [1, 50]) {
            const filename = `${mib}mib.bin`, plaintext = fs.readFileSync(path.join(root, filename));
            assert.equal(plaintext.length, mib * 1024 * 1024);
            const args = { key, keyId, context, domain: 'pack', relativeKey: `packs/${'a'.repeat(32)}` };
            const envelope = encryptObject({ ...args, plaintext });
            assert.equal(envelope.length, plaintext.length + 41);
            const decrypted = decryptObject({ ...args, envelope });
            assert.ok(decrypted.equals(plaintext), 'Decryption must retain every input byte');
            assert.notEqual(sha256(decrypted.subarray(0, -1)), sha256(plaintext), 'Truncated equal copies cannot satisfy complete input equality');
            report.negativeControls.truncated = true;
            const tampered = Buffer.from(envelope); tampered[tampered.length - 1] ^= 1;
            assert.throws(() => decryptObject({ ...args, envelope: tampered }), { code: 'S3_OBJECT_AUTH_FAILED' });
            report.negativeControls.tampered = 'S3_OBJECT_AUTH_FAILED';
            fs.mkdirSync(path.join(a.owner.userRoot, 'backgrounds'), { recursive: true });
            fs.writeFileSync(path.join(a.owner.userRoot, 'backgrounds', filename), plaintext);
            report.payloads.push({ filename, bytes: plaintext.length, sha256: sha256(plaintext), decryptedBytes: decrypted.length, decryptedSha256: sha256(decrypted) });
        }
        report.negativeControls.wrongPhrase = 'S3_WRONG_PASSPHRASE';
        stage = 'admitted snapshot and immutable upload';
        const pushed = await syncService.trigger(a.owner, a.id, 'manual');
        assert.equal(pushed.ok, true, `Publication rejected: ${pushed.code}`);
        assert.equal(pushed.outcome.pushed, true);
        const head = decodeHead(decryptObject({ key, keyId, context, domain: 'head', relativeKey: 'head', envelope: await consume('head') }));
        assert.equal(head.packs.length, 1);
        stage = 'admitted fetch and production index installation';
        const pulled = await syncService.trigger(b.owner, b.id, 'manual');
        assert.equal(pulled.ok, true, `Pull rejected: ${pulled.code}`);
        const oid = await git.resolveRef({ fs: atomicFs, gitdir: b.paths.gitDir, ref: 'refs/heads/main' });
        assert.equal(oid, head.commit);
        assert.equal(await git.resolveRef({ fs: atomicFs, gitdir: a.paths.gitDir, ref: 'refs/heads/main' }), oid);
        for (const record of report.payloads) {
            const expected = fs.readFileSync(path.join(root, record.filename));
            const live = fs.readFileSync(path.join(b.owner.userRoot, 'backgrounds', record.filename));
            const { blob } = await git.readBlob({ fs: atomicFs, gitdir: b.paths.gitDir, oid, filepath: `backgrounds/${record.filename}` });
            const bytes = Buffer.from(blob);
            assert.ok(live.equals(expected), 'Materialized payload must equal the complete independent input');
            assert.ok(bytes.equals(expected), 'Indexed Git payload must equal the complete independent input');
            Object.assign(record, { pulledBytes: live.length, pulledSha256: sha256(live), gitBytes: bytes.length, gitSha256: sha256(bytes) });
        }
        stage = 'independent pack/index/closure validation';
        const ledger = await readIndexedPacks(b.paths);
        assert.deepEqual(Object.keys(ledger.packs).sort(), head.packs.map(pack => pack.name).sort());
        const packedOids = new Set();
        report.packs = [];
        for (const remote of head.packs) {
            const envelope = await consume(`packs/${remote.name}`);
            assert.equal(envelope.length, remote.size);
            const pack = decryptObject({ key, keyId, context, domain: 'pack', relativeKey: `packs/${remote.name}`, envelope });
            const inspection = await inspectPack(pack);
            const installed = path.join(b.paths.gitDir, 'objects/pack', ledger.packs[remote.name].filename);
            assert.ok(fs.readFileSync(installed).equals(pack), 'Installed pack must retain the entire authenticated pack');
            const index = fs.readFileSync(installed.replace(/\.pack$/, '.idx'));
            validatePackIndex({ pack, index, inspection });
            const changed = Buffer.from(index); changed[changed.length - 1] ^= 1;
            assert.throws(() => validatePackIndex({ pack, index: changed, inspection }), { code: 'S3_PACK_INVALID' });
            report.negativeControls.damagedIndex = 'S3_PACK_INVALID';
            for (const object of inspection.objects) packedOids.add(object.oid);
            report.packs.push({ name: remote.name, encryptedBytes: remote.size, checksum: inspection.checksum, objects: inspection.objects.length, indexVerified: true, immutable: true });
        }
        const reachable = await listObjectsChildrenFirst({ dir: a.paths.workdir, gitdir: a.paths.gitDir, headOid: head.commit, skip: new Set() });
        assert.deepEqual([...packedOids].sort(), [...reachable].sort());
        report.reachableObjects = reachable.length;
        const complete = device => hasCompleteClosure({ dir: device.paths.workdir, gitdir: device.paths.gitDir, oid: head.commit, verify: true });
        assert.equal(await complete(a), true); assert.equal(await complete(b), true);
        report.closure = { source: true, receiver: true, sameHead: true, exactObjectSet: true };
        stage = 'genuine stale conditional head';
        await admitted(a, async backend => {
            const observation = await backend.readHead();
            assert.equal(observation.oid, head.commit);
            await backend.pushObjects(observation.oid, observation.oid);
            // Change only ciphertext through the real transport. The stale
            // opaque ETag must fail even though the decrypted head is identical.
            const bytes = encryptObject({ key, keyId, context, domain: 'head', relativeKey: 'head', plaintext: Buffer.from(JSON.stringify(head)) });
            await transport.put('head', bytes, { contentLength: bytes.length, ifMatch: observation.etag });
            const result = await backend.casHead(observation.etag, observation.oid);
            assert.deepEqual(result, { ok: false, reason: 'conflict' });
            report.negativeControls.staleCas = result;
        });
        for (const device of devices) assert.deepEqual(fs.readdirSync(device.paths.peerDir).filter(name => name.startsWith('.luker-staging-s3-')), []);
        const serialized = JSON.stringify(report);
        for (const secret of [input.accessKeyId, input.secretAccessKey, input.passphrase, context.derivedKey]) assert.equal(serialized.includes(secret), false, 'Public evidence must not contain secrets');
    } finally {
        stage = `${stage}; close`;
        await transport?.close();
        for (const device of devices) await syncService.removeBackend(device.owner, device.id);
    }
    report.closed = true;
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

try { await acceptance(); } catch (error) {
    // Production errors are code-only; assertion messages contain no private
    // setup objects. Do not print arbitrary provider payloads or credentials.
    console.error(JSON.stringify({ stage, code: error.code ?? error.name,
        stack: error.code === 'S3_SETTINGS_INVALID' ? error.stack : undefined,
        assertion: error.name === 'AssertionError' ? error.message : undefined }));
    process.exitCode = 1;
}
