import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import git from 'isomorphic-git';
import writeFileAtomic from 'write-file-atomic';
import { atomicFs } from '../../pipeline/atomic-fs.js';
import { failpoint, FAILPOINTS } from '../../pipeline/failpoints.js';
import { assertSafeProjectionPath } from '../../materialize.js';
import { hasCompleteClosure } from '../../objects.js';
import { syncError } from '../../errors.js';
import { validateHead } from './layout.js';
import { decryptObject } from './crypto.js';
import { inspectPack, validatePackIndex, gitObjectOid } from './pack-integrity.js';

const FILENAME = /^pack-[a-f0-9]{40}\.pack$/;
const NAME = /^[a-f0-9]{32}$/;
const active = new Set();
const emptyLedger = () => ({ v: 1, packs: {} });
const random = () => crypto.randomBytes(16).toString('hex');
const ledgerPath = paths => path.join(paths.peerDir, 's3-packs.json');
function fail() { throw syncError('S3_PACK_INVALID', 'Invalid installed S3 pack'); }

function safePath(paths, target) {
    const boundary = path.resolve(paths.syncRoot, '..');
    if (path.dirname(path.resolve(paths.peerDir)) !== path.resolve(paths.syncRoot)
        || path.resolve(paths.gitDir) !== path.join(path.resolve(paths.peerDir), 'repo.git')
        || path.resolve(paths.workdir) !== path.join(path.resolve(paths.peerDir), 'workdir')) fail();
    assertSafeProjectionPath(target, boundary);
    const relative = path.relative(path.resolve(paths.peerDir), path.resolve(target));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail();
}

async function bytes(paths, file) {
    safePath(paths, file);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) fail();
    return fs.readFile(file);
}

async function writeLedger(paths, ledger) {
    safePath(paths, ledgerPath(paths));
    await writeFileAtomic(ledgerPath(paths), JSON.stringify(ledger), { mode: 0o600 });
}

export async function readIndexedPacks(paths) {
    const file = ledgerPath(paths);
    safePath(paths, file);
    let data;
    try { data = await bytes(paths, file); } catch (error) { if (error.code === 'ENOENT') return emptyLedger(); throw error; }
    try {
        const ledger = JSON.parse(data.toString('utf8'));
        if (!ledger || ledger.v !== 1 || !ledger.packs || typeof ledger.packs !== 'object' || Array.isArray(ledger.packs)
            || Object.keys(ledger).length !== 2) fail();
        for (const [name, record] of Object.entries(ledger.packs)) {
            if (!NAME.test(name) || !record || Object.keys(record).length !== 2 || typeof record.filename !== 'string' || !FILENAME.test(record.filename)
                || !Number.isSafeInteger(record.size) || record.size < 41) fail();
        }
        return ledger;
    } catch {
        await fs.rename(file, `${file}.unreadable-${random()}`);
        return emptyLedger();
    }
}

async function looseObject(paths, oid) {
    if (!/^[a-f0-9]{40}$/.test(oid)) fail();
    const file = path.join(paths.gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
    let compressed;
    try { compressed = await bytes(paths, file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const inflated = zlib.inflateSync(compressed, { info: true });
    if (inflated.engine.bytesWritten !== compressed.length) fail();
    const nul = inflated.buffer.indexOf(0);
    const match = /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/.exec(inflated.buffer.subarray(0, nul).toString('latin1'));
    if (nul < 0 || !match) fail();
    const body = inflated.buffer.subarray(nul + 1), type = match[1];
    if (String(body.length) !== match[2] || gitObjectOid(type, body) !== oid) fail();
    return { type, body };
}

async function quarantine(paths, files) {
    const root = path.join(paths.peerDir, `.s3-invalid-${random()}`);
    safePath(paths, root);
    await fs.mkdir(root, { mode: 0o700 });
    // Rename the idx first: after this point ordinary Git cannot enumerate it.
    for (const file of files) {
        try { await fs.rename(file, path.join(root, path.basename(file))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

/** No ordinary Git lookup is permitted while this raw-byte validation is in progress. */
async function inspectStore(paths) {
    const packdir = path.join(paths.gitDir, 'objects', 'pack');
    safePath(paths, packdir);
    const names = await fs.readdir(packdir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const lookup = new Map(), valid = new Map(), pending = new Map();
    for (const name of names.filter(name => name.endsWith('.idx'))) {
        const indexFile = path.join(packdir, name), packFile = indexFile.slice(0, -4) + '.pack';
        try {
            if (!FILENAME.test(path.basename(packFile))) fail();
            pending.set(name, { indexFile, packFile, pack: await bytes(paths, packFile), index: await bytes(paths, indexFile) });
        } catch { await quarantine(paths, [indexFile, packFile]); }
    }
    async function readExternalObject(oid) {
        const object = lookup.get(oid) ?? await looseObject(paths, oid);
        if (!object) fail();
        return object;
    }
    while (pending.size) {
        let progress = false;
        for (const [name, pair] of pending) {
            try {
                const inspection = await inspectPack(pair.pack, { readExternalObject });
                validatePackIndex({ ...pair, inspection });
                if (path.basename(pair.packFile) !== `pack-${inspection.checksum}.pack`) fail();
                valid.set(path.basename(pair.packFile), { ...pair, inspection });
                for (const object of inspection.objects) lookup.set(object.oid, object);
                pending.delete(name); progress = true;
            } catch (error) { pair.error = error; }
        }
        if (!progress) break;
    }
    for (const pair of pending.values()) await quarantine(paths, [pair.indexFile, pair.packFile]);
    const ledger = await readIndexedPacks(paths);
    let changed = false;
    for (const [name, record] of Object.entries(ledger.packs)) {
        const artifact = valid.get(record.filename);
        // AES-GCM envelope overhead is fixed by LKSR v1, not a transfer cap.
        if (!artifact || record.size !== artifact.pack.length + 41) { delete ledger.packs[name]; changed = true; }
    }
    if (changed) await writeLedger(paths, ledger);
    return { valid, readExternalObject, ledger };
}

async function sweepOwned(paths) {
    safePath(paths, paths.peerDir);
    const names = await fs.readdir(paths.peerDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names) {
        const match = /^\.luker-staging-s3-(\d+)-[a-f0-9]{32}$/.exec(name);
        if (!match) continue;
        const file = path.join(paths.peerDir, name);
        if (active.has(file) || Number(match[1]) === process.pid) continue;
        try { process.kill(Number(match[1]), 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
        safePath(paths, file);
        await fs.rm(file, { recursive: true, force: true });
    }
}

/** Called by the service before recovery/snapshot, without network I/O. */
export async function prepareLocalPackStore({ paths, withLocal }) {
    await withLocal(async () => { await sweepOwned(paths); await inspectStore(paths); });
}

export async function fetchAndIndexPacks({ transport, key, keyId, context, head: input, paths, withLocal }) {
    const head = validateHead(input);
    // Decide the complete batch inside one freshly validated local section.
    // This inventory never survives a lock release as authority for Git reads.
    const missing = await withLocal(async () => {
        await sweepOwned(paths);
        const store = await inspectStore(paths);
        return head.packs.filter(remote => store.ledger.packs[remote.name]?.size !== remote.size);
    });
    for (const remote of missing) {
        let qRoot;
        try {
            qRoot = await withLocal(async () => {
                const root = path.join(paths.peerDir, `.luker-staging-s3-${process.pid}-${random()}`);
                safePath(paths, root);
                await fs.mkdir(root, { mode: 0o700 }); active.add(root);
                return root;
            });
            const incoming = path.join(qRoot, 'encrypted');
            const handle = await withLocal(async () => { safePath(paths, incoming); return fs.open(incoming, 'wx', 0o600); });
            let response, received = 0;
            try {
                response = await transport.get(`packs/${remote.name}`);
                if (!response || response.size !== remote.size) fail();
                for await (const chunk of response.body) {
                    received += chunk.length;
                    if (!Number.isSafeInteger(received) || received > remote.size) fail();
                    await handle.writeFile(chunk);
                    failpoint(FAILPOINTS.S3_DOWNLOAD_AFTER_FIRST_CHUNK);
                }
                if (received !== remote.size) fail();
                await handle.sync();
            } finally { response?.body.destroy(); await handle.close(); }
            // No bytes are published until GCM authentication has completed.
            const envelope = await withLocal(() => bytes(paths, incoming));
            const pack = decryptObject({ key, keyId, context, domain: 'pack', relativeKey: `packs/${remote.name}`, envelope });
            await withLocal(async () => {
                const store = await inspectStore(paths);
                const bases = new Map();
                const inspection = await inspectPack(pack, { readExternalObject: async oid => {
                    const object = await store.readExternalObject(oid); bases.set(oid, object); return object;
                } });
                const qWorkdir = path.join(qRoot, 'workdir'), qGitdir = path.join(qRoot, 'repo.git');
                safePath(paths, qWorkdir); safePath(paths, qGitdir);
                await fs.mkdir(qWorkdir); await fs.mkdir(qGitdir);
                await git.init({ fs: atomicFs, dir: qWorkdir, gitdir: qGitdir, defaultBranch: 'main' });
                for (const [oid, object] of bases) {
                    const written = await git.writeObject({ fs: atomicFs, dir: qWorkdir, gitdir: qGitdir, type: object.type, object: object.body, format: 'content' });
                    if (written !== oid) fail();
                }
                const filename = `pack-${inspection.checksum}.pack`;
                const candidate = path.join(qGitdir, 'objects', 'pack', filename);
                await writeFileAtomic(candidate, pack, { mode: 0o600 });
                const indexed = await git.indexPack({ fs: atomicFs, dir: qWorkdir, gitdir: qGitdir, filepath: path.relative(qWorkdir, candidate), cache: {} });
                const indexedOids = new Set(indexed.oids);
                if (indexed.oids.length !== inspection.objects.length || indexedOids.size !== inspection.objects.length
                    || inspection.objects.some(object => !indexedOids.has(object.oid))) fail();
                const index = await fs.readFile(candidate.replace(/\.pack$/, '.idx'));
                validatePackIndex({ pack, index, inspection });
                const packdir = path.join(paths.gitDir, 'objects', 'pack');
                safePath(paths, packdir);
                await fs.mkdir(packdir, { recursive: true });
                const target = path.join(packdir, filename), targetIndex = target.replace(/\.pack$/, '.idx');
                safePath(paths, target); safePath(paths, targetIndex);
                await writeFileAtomic(target, pack, { mode: 0o600 });
                failpoint(FAILPOINTS.S3_PACK_INSTALLED_BEFORE_INDEX);
                await writeFileAtomic(targetIndex, index, { mode: 0o600 });
                failpoint(FAILPOINTS.S3_INDEXED_BEFORE_LEDGER);
                store.ledger.packs[remote.name] = { filename, size: remote.size };
                await writeLedger(paths, store.ledger);
            });
        } finally {
            if (qRoot) { active.delete(qRoot); await fs.rm(qRoot, { recursive: true, force: true }); }
        }
    }
    await withLocal(async () => {
        // Network and other local operations invalidate the earlier decisions.
        // Require every advertised artifact again, even with loose duplicates.
        const store = await inspectStore(paths);
        if (head.packs.some(remote => store.ledger.packs[remote.name]?.size !== remote.size)) throw syncError('S3_INCOMPLETE_OBJECTS', 'S3 pack inventory changed during transfer; sync again after local storage recovers');
        if (!await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: head.commit, verify: true })) {
            throw syncError('S3_INCOMPLETE_OBJECTS', 'S3 head object closure is incomplete');
        }
    });
}
