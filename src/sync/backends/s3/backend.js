import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import git from 'isomorphic-git';
import { createS3Client } from './client.js';
import { validateStoredKey, validateStoredKeyId, validateKeyinfo, verifyStoredKey, encryptObject, decryptObject } from './crypto.js';
import { normalizeS3Settings, decodeHead, encodeHead, newPackName } from './layout.js';
import { fetchAndIndexPacks, prepareLocalPackStore } from './packs.js';
import { getShadowPaths } from '../../shadow.js';
import { assertSafeProjectionPath } from '../../materialize.js';
import { hasCompleteClosure, listObjectsChildrenFirst } from '../../objects.js';
import { atomicFs } from '../../pipeline/atomic-fs.js';
import { syncError } from '../../errors.js';
import { failpoint, FAILPOINTS } from '../../pipeline/failpoints.js';

const fail = code => { throw syncError(code, code); };
async function consume(result) {
    try { return Buffer.from(await result.body.transformToByteArray()); } catch { fail('UNREACHABLE'); } finally { result.body.destroy(); }
}

/** One admitted operation, with immutable settings and read/staging observations. */
export class S3Backend {
    #observation;
    #staged;
    constructor({ id, owner, entry, lease, network }) {
        this.id = id;
        this.kind = 's3';
        this.lease = lease;
        this.settings = Object.freeze(normalizeS3Settings(structuredClone(entry.s3)));
        this.keyId = validateStoredKeyId(this.settings.keyId);
        this.key = validateStoredKey(this.settings.derivedKey);
        this.paths = getShadowPaths({ userRoot: owner.userRoot, peerId: id });
        this.transport = createS3Client({ owner, settings: this.settings, network });
    }

    async #authenticate() {
        await this.lease.assertAlive();
        const result = await this.transport.get('keyinfo.json');
        if (!result) fail('S3_KEYINFO_MISSING');
        let info;
        const bytes = await consume(result);
        try { info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('S3_KEYINFO_INVALID'); }
        info = validateKeyinfo(info, this.settings);
        verifyStoredKey({ key: this.key, keyId: this.keyId, keyinfo: info, context: this.settings });
        await this.lease.assertAlive();
    }

    async #readObservation() {
        await this.#authenticate();
        const result = await this.transport.get('head');
        if (!result) return Object.freeze({ head: null, etag: null });
        const bytes = await consume(result);
        if (typeof result.etag !== 'string' || !result.etag) fail('S3_HEAD_INVALID');
        const payload = decryptObject({ key: this.key, keyId: this.keyId, context: this.settings, domain: 'head', relativeKey: 'head', envelope: bytes });
        const head = decodeHead(payload);
        for (const pack of head.packs) Object.freeze(pack);
        Object.freeze(head.packs); Object.freeze(head.compactedFrom); Object.freeze(head);
        await this.lease.assertAlive();
        return Object.freeze({ head, etag: result.etag, payload });
    }

    async readHead() {
        this.#staged = undefined;
        this.#observation = await this.#readObservation();
        return this.#observation.head ? Object.freeze({ oid: this.#observation.head.commit, etag: this.#observation.etag }) : null;
    }

    async fetchInto(want, _have) {
        const observation = this.#observation;
        if (!observation?.head || want.some(oid => oid !== observation.head.commit)) fail('S3_HEAD_INVALID');
        await this.#fetch(observation.head);
    }

    #fetch(head) {
        return fetchAndIndexPacks({ transport: this.transport, key: this.key, keyId: this.keyId, context: this.settings,
            paths: this.paths, head, withLocal: fn => this.lease.withLocal(fn) });
    }

    async recoverLocalPacks() {
        const observation = await this.#readObservation();
        if (observation.head) await this.#fetch(observation.head);
    }

    /** Independent pack validation precedes any Git lookup of this existing shadow. */
    async prepareLocal() {
        await prepareLocalPackStore({ paths: this.paths, withLocal: fn => this.lease.withLocal(fn) });
        const complete = () => this.lease.withLocal(async () => {
            if (!fs.existsSync(path.join(this.paths.gitDir, 'HEAD'))) return true;
            const names = new Set(['refs/heads/main']);
            const refs = await fs.promises.readdir(path.join(this.paths.gitDir, 'refs'), { recursive: true, withFileTypes: true });
            for (const ref of refs) {
                assertSafeProjectionPath(path.join(ref.parentPath, ref.name), path.resolve(this.paths.syncRoot, '..'));
                if (!ref.isFile()) continue;
                names.add(path.relative(this.paths.gitDir, path.join(ref.parentPath, ref.name)));
            }
            for (const ref of names) {
                let oid;
                try { oid = await git.resolveRef({ fs: atomicFs, gitdir: this.paths.gitDir, ref }); } catch (error) {
                    if (error.code === 'NotFoundError') continue;
                    throw error;
                }
                if (!await hasCompleteClosure({ dir: this.paths.workdir, gitdir: this.paths.gitDir, oid, verify: true })) return false;
            }
            return true;
        });
        if (await complete()) return;
        await this.recoverLocalPacks();
        if (!await complete()) fail('S3_INCOMPLETE_OBJECTS');
    }

    async pushObjects(oid, remoteOid) {
        const observation = this.#observation;
        if (!observation || (observation.head?.commit ?? null) !== remoteOid) fail('S3_HEAD_INVALID');
        this.#staged = undefined;
        let stage;
        try {
            const prepared = await this.lease.withLocal(async () => {
                const { workdir: dir, gitDir: gitdir } = this.paths;
                const skip = new Set(remoteOid ? await listObjectsChildrenFirst({ dir, gitdir, headOid: remoteOid, skip: new Set() }) : []);
                const oids = await listObjectsChildrenFirst({ dir, gitdir, headOid: oid, skip });
                const packs = [...(observation.head?.packs ?? [])];
                if (!oids.length) return { head: { v: 1, commit: oid, packs, compactedFrom: [] } };
                const { packfile } = await git.packObjects({ fs: atomicFs, dir, gitdir, oids, write: false });
                const name = newPackName();
                const bytes = encryptObject({ key: this.key, keyId: this.keyId, context: this.settings, domain: 'pack', relativeKey: `packs/${name}`, plaintext: Buffer.from(packfile) });
                stage = path.join(this.paths.peerDir, `.luker-staging-s3-${process.pid}-${randomBytes(16).toString('hex')}`);
                assertSafeProjectionPath(stage, path.resolve(this.paths.syncRoot, '..'));
                await this.lease.assertAlive();
                await fs.promises.writeFile(stage, bytes, { flag: 'wx', mode: 0o600 });
                return { name, size: bytes.length, head: { v: 1, commit: oid, packs: [...packs, { name, size: bytes.length }], compactedFrom: [] } };
            });
            if (stage) {
                await this.lease.assertAlive();
                const source = fs.createReadStream(stage);
                // Observe only after the SDK resumes its source. Installing a
                // data listener before consumption would start flowing early.
                source.once('resume', () => source.once('data', () => failpoint(FAILPOINTS.S3_UPLOAD_AFTER_FIRST_CHUNK)));
                await this.transport.put(`packs/${prepared.name}`, source, { contentLength: prepared.size, ifNoneMatch: '*' });
            }
            await this.lease.assertAlive();
            this.#staged = { observation, oid, head: prepared.head, payload: encodeHead(prepared.head) };
        } finally { if (stage) await fs.promises.rm(stage, { force: true }); }
    }

    async casHead(expected, oid) {
        const staged = this.#staged;
        this.#staged = undefined;
        if (!staged || staged.observation !== this.#observation || staged.oid !== oid || staged.observation.etag !== expected) fail('S3_HEAD_INVALID');
        await this.lease.assertAlive();
        const bytes = encryptObject({ key: this.key, keyId: this.keyId, context: this.settings, domain: 'head', relativeKey: 'head', plaintext: staged.payload });
        try {
            await this.transport.put('head', bytes, { contentLength: bytes.length, ...(expected === null ? { ifNoneMatch: '*' } : { ifMatch: expected }) });
            return { ok: true };
        } catch (error) {
            if (error.code === 'PRECONDITION_FAILED') {
                // A rejected condition with an unchanged head is not a race:
                // the provider refused a write the current ETag allows.
                const current = await this.#readObservation();
                if (current.etag === expected) {
                    if (expected !== null && !this.settings.stripIfMatchQuotes && /^".*"$/.test(expected)) {
                        throw syncError('S3_IF_MATCH_QUOTES_UNSUPPORTED', 'S3 service requires an unquoted If-Match ETag');
                    }
                    throw syncError('CONDITIONAL_WRITES_UNSUPPORTED', 'S3 conditional writes are required');
                }
                return { ok: false, reason: 'conflict' };
            }
            if (error.code !== 'UNREACHABLE') throw error;
            // Authenticate identity and context again, once; never resend a head PUT.
            const recovered = await this.#readObservation();
            return recovered.payload?.equals(staged.payload) ? { ok: true } : { ok: false, reason: 'conflict' };
        }
    }

    close() { return this.transport.close(); }
}
