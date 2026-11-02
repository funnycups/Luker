/**
 * Runtime feasibility checks for the S3 sync backend.
 *
 * Exercises every runtime capability the S3 backend depends on and
 * reports per-step success and timing instead of throwing, so the same
 * report can be read from a CLI, an HTTP route on a device, or a test.
 * Used to decide whether the S3 backend can ship on runtimes without
 * a JIT (HarmonyOS runs Node with --jitless).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import git from 'isomorphic-git';

import { HAS_WASM } from '../../../runtime-capabilities.js';

const scrypt = util.promisify(crypto.scrypt);

// scrypt cost for the S3 backend's passphrase KDF: N=2^17, r=8, p=1 is
// the OWASP Password Storage Cheat Sheet minimum for scrypt. It needs
// 128*N*r = 128 MiB per derivation, and Node rejects the call unless
// maxmem exceeds that, hence 256 MiB.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// Payload sizes: 1 MiB is a typical chat file; 50 MiB approximates a
// first-sync pack for a mid-size library. Both only measure throughput.
const AES_SIZES = [['aesgcm.1MiB', 1 << 20], ['aesgcm.50MiB', 50 << 20]];

// Sample repo for the git steps. git.packObjects measures isomorphic-git's
// per-object deflate (native CompressionStream on Node) plus pack
// assembly and SHA-1; git.indexPack measures pako (pure-JS) inflate plus
// SHA-1 of every object, the cost that grows most under --jitless.
// 40 chat files × 280 KiB ≈ 10.9 MiB of JSONL plus ≈ 1.4 MiB of card
// stand-ins keeps the total near 12.3 MiB: large enough that per-byte
// cost dominates fixed overhead, small enough to finish in seconds.
const SAMPLE_CHAT_FILES = 40;
const SAMPLE_CHAT_FILE_BYTES = 280 * 1024;
// PNG character cards are a few hundred KiB and already compressed, so
// random bytes of these sizes stand in for them.
const SAMPLE_CARD_BYTES = [256 * 1024, 320 * 1024, 384 * 1024, 448 * 1024];
// Fixed seed so every run packs identical chat bytes and timings are
// comparable across devices.
const SAMPLE_SEED = 42;
// Messages of 20–139 words, a common roleplay reply length.
const SAMPLE_MIN_WORDS = 20;
const SAMPLE_WORD_SPAN = 120;
// Roughly one word in twelve carries punctuation.
const SAMPLE_PUNCT_RATE = 0.08;
// Consecutive messages are up to 10 minutes apart.
const SAMPLE_MAX_GAP_MS = 10 * 60 * 1000;
// With this vocabulary the chat JSONL deflates at ≈3.4:1 (measured with
// zlib), within the 3–5× range git usually reaches on text.
const SAMPLE_WORDS = (
    'the a and of to in she he her his they it was is with as at on for from that this but not you me my your we our '
    + 'glade forest lantern river stone light shadow wind voice hand eyes path night morning fire water sky tree leaf moss root '
    + 'gentle quiet warm cold soft bright dark ancient small tall slow sudden distant careful tired curious silver golden green '
    + 'walks smiles whispers turns watches listens reaches waits laughs sighs kneels rises steps pauses breathes nods glances '
    + 'softly slowly quietly gently again still almost never always perhaps maybe here there then now before after inside beyond '
    + 'magic spell healing wound potion herb book map door window table chair cup tea bread blanket cloak boots sword bow arrow '
    + 'friend stranger traveler guardian village town road bridge tower castle cave mountain valley lake meadow garden storm rain '
    + 'remember forget hope fear trust wonder promise answer question story song dream memory secret journey home rest'
).split(' ');
const SAMPLE_PUNCT = [',', '.', '!', '?', '...'];

/**
 * mulberry32: small deterministic PRNG returning floats in [0, 1).
 * @param {number} seed
 */
function mulberry32(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Builds deterministic SillyTavern-style chat JSONL files.
 * @returns {Buffer[]}
 */
function buildSampleChats() {
    const rnd = mulberry32(SAMPLE_SEED);
    const pick = list => list[Math.floor(rnd() * list.length)];
    let date = Date.UTC(2026, 0, 1);
    let index = 0;
    const files = [];
    for (let f = 0; f < SAMPLE_CHAT_FILES; f++) {
        const lines = [];
        let size = 0;
        while (size < SAMPLE_CHAT_FILE_BYTES) {
            const count = SAMPLE_MIN_WORDS + Math.floor(rnd() * SAMPLE_WORD_SPAN);
            const words = [];
            for (let k = 0; k < count; k++) {
                const word = pick(SAMPLE_WORDS);
                words.push(rnd() < SAMPLE_PUNCT_RATE ? word + pick(SAMPLE_PUNCT) : word);
            }
            date += Math.floor(rnd() * SAMPLE_MAX_GAP_MS);
            const isUser = index++ % 2 === 0;
            const line = JSON.stringify({
                name: isUser ? 'User' : 'Seraphina',
                is_user: isUser,
                send_date: new Date(date).toISOString(),
                mes: words.join(' '),
            }) + '\n';
            lines.push(line);
            size += Buffer.byteLength(line);
        }
        files.push(Buffer.from(lines.join('')));
    }
    return files;
}

function describeError(error) {
    return `${error?.name || 'Error'}: ${error?.message || error}`;
}

async function step(steps, name, fn) {
    const t0 = performance.now();
    try {
        const detail = await fn();
        steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), ...(detail ? { detail: String(detail) } : {}) });
        return true;
    } catch (error) {
        steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: describeError(error) });
        return false;
    }
}

function expect412(error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 412 || status === 409 || error?.name === 'PreconditionFailed') return;
    throw error;
}

function feasibilityIfMatch(config, value) {
    if (!config.stripIfMatchQuotes || typeof value !== 'string') return value;
    return /^".*"$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * @typedef {{ endpoint: string, region: string, bucket: string, prefix?: string,
 *             accessKeyId: string, secretAccessKey: string, forcePathStyle?: boolean,
 *             stripIfMatchQuotes?: boolean, createBucket?: boolean }} S3FeasibilityConfig
 * @typedef {{ name: string, ok: boolean, ms: number, detail?: string, error?: string }} FeasibilityStep
 * @typedef {{ env: { node: string, openssl: string, hasWasm: boolean, platform: string, arch: string },
 *             steps: FeasibilityStep[], ok: boolean }} FeasibilityReport
 */

/**
 * @param {FeasibilityStep[]} steps
 * @param {S3FeasibilityConfig} config
 */
async function runS3Steps(steps, config) {
    let sdk;
    await step(steps, 'sdk.import', async () => { sdk = await import('@aws-sdk/client-s3'); });
    if (!sdk) return;

    let client;
    await step(steps, 'client.init', async () => {
        client = new sdk.S3Client({
            endpoint: config.endpoint,
            region: config.region,
            forcePathStyle: Boolean(config.forcePathStyle),
            credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        });
    });
    if (!client) return;

    try {
        const Bucket = config.bucket;
        const Key = `${config.prefix ? `${config.prefix.replace(/\/+$/, '')}/` : ''}.luker-feasibility-${crypto.randomUUID()}`;
        let etag = '';
        const s3ok = await step(steps, 'bucket.create', async () => {
            if (!config.createBucket) return 'skipped';
            await client.send(new sdk.CreateBucketCommand({ Bucket }));
        });
        if (!s3ok) return;
        await step(steps, 'put.ifNoneMatch.new', async () => {
            const out = await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: 'a', IfNoneMatch: '*' }));
            etag = out.ETag;
        });
        await step(steps, 'put.ifNoneMatch.exists412', async () => {
            try { await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: 'b', IfNoneMatch: '*' })); } catch (e) { expect412(e); return '412'; }
            throw new Error('conditional create overwrote an existing object');
        });
        await step(steps, 'put.ifMatch.wrong412', async () => {
            try { await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: 'c', IfMatch: feasibilityIfMatch(config, '"00000000000000000000000000000000"') })); } catch (e) { expect412(e); return '412'; }
            throw new Error('If-Match with a wrong ETag was accepted');
        });
        await step(steps, 'put.ifMatch.right', async () => {
            try {
                const out = await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: 'd', IfMatch: feasibilityIfMatch(config, etag) }));
                etag = out.ETag;
            } catch (error) {
                const status = error?.$metadata?.httpStatusCode;
                if (!config.stripIfMatchQuotes && (status === 412 || status === 409) && /^".*"$/.test(etag)) {
                    throw new Error('If-Match with the current ETag was rejected; retry with LUKER_S3_STRIP_IF_MATCH_QUOTES=1');
                }
                throw error;
            }
        });
        await step(steps, 'get', async () => {
            const out = await client.send(new sdk.GetObjectCommand({ Bucket, Key }));
            const body = await out.Body.transformToString();
            if (body !== 'd') throw new Error(`unexpected body ${JSON.stringify(body)}`);
        });
        await step(steps, 'head', async () => {
            const out = await client.send(new sdk.HeadObjectCommand({ Bucket, Key }));
            if (out.ETag !== etag) throw new Error(`HEAD ETag ${out.ETag} != PUT ETag ${etag}`);
        });
        await step(steps, 'list', async () => {
            const out = await client.send(new sdk.ListObjectsV2Command({ Bucket, Prefix: Key }));
            if (!(out.Contents || []).some(o => o.Key === Key)) throw new Error('object missing from listing');
        });
        await step(steps, 'delete', async () => { await client.send(new sdk.DeleteObjectCommand({ Bucket, Key })); });
    } finally {
        client.destroy();
    }
}

/**
 * @param {FeasibilityStep[]} steps
 */
async function runCryptoSteps(steps) {
    let key;
    await step(steps, 'scrypt', async () => {
        // 16-byte random salt; 32-byte output is the AES-256 key size.
        key = await scrypt('feasibility-passphrase', crypto.randomBytes(16), 32, SCRYPT);
        return `N=${SCRYPT.N} r=${SCRYPT.r} p=${SCRYPT.p} maxmem=${SCRYPT.maxmem}`;
    });
    key ||= crypto.randomBytes(32);
    for (const [name, size] of AES_SIZES) {
        // Inputs are generated before the step so its time covers only
        // encrypt + decrypt + compare. 12 bytes is the GCM-recommended IV size.
        let plain;
        let iv;
        try {
            plain = crypto.randomBytes(size);
            iv = crypto.randomBytes(12);
        } catch (error) {
            steps.push({ name, ok: false, ms: 0, error: describeError(error) });
            continue;
        }
        await step(steps, name, async () => {
            const t0 = performance.now();
            const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
            const ct = Buffer.concat([enc.update(plain), enc.final()]);
            const tag = enc.getAuthTag();
            const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
            dec.setAuthTag(tag);
            const back = Buffer.concat([dec.update(ct), dec.final()]);
            if (!back.equals(plain)) throw new Error('round trip mismatch');
            // Floor of 1 µs only guards the division on coarse timers.
            const seconds = Math.max(performance.now() - t0, 1e-3) / 1000;
            return `encrypt+decrypt ${(size / (1 << 20) / seconds).toFixed(1)} MiB/s`;
        });
    }
}

/**
 * @param {FeasibilityStep[]} steps
 */
async function runGitSteps(steps) {
    let tmp;
    let oids = [];
    let rawBytes = 0;
    let packfile;
    let src;
    try {
        await step(steps, 'git.prepareSample', async () => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-feas-'));
            src = path.join(tmp, 'src');
            fs.mkdirSync(src, { recursive: true });
            await git.init({ fs, dir: src, defaultBranch: 'main' });
            const files = [
                ...buildSampleChats().map((data, i) => [`chat${i}.jsonl`, data]),
                ...SAMPLE_CARD_BYTES.map((size, i) => [`card${i}.png`, crypto.randomBytes(size)]),
            ];
            for (const [name, data] of files) {
                fs.writeFileSync(path.join(src, name), data);
                rawBytes += data.length;
                await git.add({ fs, dir: src, filepath: name });
            }
            const commit = await git.commit({ fs, dir: src, message: 'sample', author: { name: 'Luker Sync', email: 'sync@luker.local' } });
            const tree = (await git.readCommit({ fs, dir: src, oid: commit })).commit.tree;
            const { tree: entries } = await git.readTree({ fs, dir: src, oid: tree });
            oids = [commit, tree, ...entries.map(e => e.oid)];
            return `${files.length} files, ${rawBytes} raw bytes`;
        });
        await step(steps, 'git.packObjects', async () => {
            if (!oids.length) throw new Error('no sample repo from previous step');
            ({ packfile } = await git.packObjects({ fs, dir: src, oids }));
            return `${oids.length} objects, ${packfile.byteLength} pack bytes, ratio ${(rawBytes / packfile.byteLength).toFixed(2)}:1`;
        });
        await step(steps, 'git.indexPack', async () => {
            if (!packfile) throw new Error('no packfile from previous step');
            const dst = path.join(tmp, 'dst.git');
            await git.init({ fs, dir: dst, bare: true, defaultBranch: 'main' });
            const rel = 'objects/pack/pack-feasibility.pack';
            fs.writeFileSync(path.join(dst, rel), packfile);
            const out = await git.indexPack({ fs, dir: dst, gitdir: dst, filepath: rel });
            if (out.oids.length !== oids.length) throw new Error(`indexed ${out.oids.length} of ${oids.length}`);
        });
    } finally {
        if (tmp) {
            try {
                fs.rmSync(tmp, { recursive: true, force: true });
            } catch (error) {
                steps.push({ name: 'git.cleanup', ok: false, ms: 0, error: describeError(error) });
            }
        }
    }
}

/**
 * @param {S3FeasibilityConfig} config
 * @returns {Promise<FeasibilityReport>}
 */
export async function runS3Feasibility(config) {
    /** @type {FeasibilityStep[]} */
    const steps = [];
    const env = {
        node: process.version,
        openssl: process.versions.openssl || '',
        hasWasm: HAS_WASM,
        platform: process.platform,
        arch: process.arch,
    };
    await runS3Steps(steps, config);
    await runCryptoSteps(steps);
    await runGitSteps(steps);
    return { env, steps, ok: steps.every(s => s.ok) };
}
