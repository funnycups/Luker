import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const hash = bytes => crypto.createHash('sha1').update(bytes).digest();
export const objectOid = (type, body) => hash(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).toString('hex');
export function seal(payload) { return Buffer.concat([payload, hash(payload)]); }
export function entryHeader(type, length) {
    const bytes = [(type << 4) | (length % 16)];
    length = Math.floor(length / 16);
    while (length) { bytes[bytes.length - 1] |= 128; bytes.push(length % 128); length = Math.floor(length / 128); }
    return Buffer.from(bytes);
}
export function rawPack(entries, count = entries.length) {
    const header = Buffer.alloc(12);
    header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
    return seal(Buffer.concat([header, ...entries]));
}
export function refDelta(baseOid, delta) {
    return Buffer.concat([entryHeader(7, delta.length), Buffer.from(baseOid, 'hex'), zlib.deflateSync(delta)]);
}
export async function buildPackFixture({ objects = [], deltas = [], corruption, externalObjects = [] }) {
    const entries = objects.map(({ type = 'blob', body }) => Buffer.concat([entryHeader({ commit: 1, tree: 2, blob: 3, tag: 4 }[type], body.length), zlib.deflateSync(body)]));
    entries.push(...deltas);
    let pack = rawPack(entries);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-pack-fixture-'));
    try {
        await git.init({ fs: { promises: fs }, dir: root });
        for (const { type, body } of externalObjects) {
            await git.writeObject({ fs: { promises: fs }, dir: root, type, object: body, format: 'content' });
        }
        await fs.writeFile(path.join(root, 'candidate.pack'), pack);
        const { oids } = await git.indexPack({ fs: { promises: fs }, dir: root, filepath: 'candidate.pack', cache: {} });
        const index = await fs.readFile(path.join(root, 'candidate.idx'));
        if (corruption) pack = corruption(pack);
        return { pack, index, oids };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export function highBitPackSignature(fixture) {
    const payload = Buffer.from(fixture.pack.subarray(0, -20));
    Buffer.from([0xd0, 0xc1, 0xc3, 0xcb]).copy(payload);
    const pack = seal(payload);
    const indexPayload = Buffer.from(fixture.index.subarray(0, -20));
    pack.subarray(-20).copy(indexPayload, indexPayload.length - 20);
    return { ...fixture, pack, index: seal(indexPayload) };
}

export function startPackChild({ root, endpoint, settings, head, failpoint, key, keyId, jitless = process.execArgv.includes('--jitless') }) {
    const child = spawn(process.execPath, [...(jitless ? ['--jitless'] : []), fileURLToPath(new URL('./s3-pack-child.mjs', import.meta.url))], {
        env: { ...process.env, LUKER_SYNC_FAILPOINT: failpoint ?? '', LUKER_PACK_CHILD: JSON.stringify({ root, settings: { ...settings, endpoint }, head, key: key.toString('base64'), keyId }) },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(chunk.toString()));
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    return { exited, stderr, kill: () => child.kill('SIGKILL') };
}
