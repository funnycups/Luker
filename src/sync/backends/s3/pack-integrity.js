import crypto from 'node:crypto';
import zlib from 'node:zlib';
import crc from 'crc';
import { syncError } from '../../errors.js';

const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const sha = bytes => crypto.createHash('sha1').update(bytes).digest();
export const gitObjectOid = (type, body) => crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
function invalid() { throw syncError('S3_PACK_INVALID', 'Invalid Git pack or index'); }
function safe(value) { if (!Number.isSafeInteger(value) || value < 0) invalid(); return value; }

function applyDelta(base, delta) {
    let p = 0;
    function byte() { if (p >= delta.length) invalid(); return delta[p++]; }
    function size() {
        let value = 0, factor = 1, b;
        do { b = byte(); value = safe(value + (b & 127) * factor); factor = safe(factor * 128); } while (b & 128);
        return value;
    }
    if (size() !== base.length) invalid();
    const length = size();
    const chunks = [];
    let written = 0;
    while (p < delta.length) {
        const op = byte();
        let chunk;
        if (op & 128) {
            let offset = 0, count = 0;
            for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
            for (let i = 0; i < 3; i++) if (op & (16 << i)) count += byte() * 2 ** (8 * i);
            // Git delta copy length zero encodes 64 KiB, not an empty copy.
            if (!count) count = 0x10000;
            if (offset + count > base.length) invalid();
            chunk = base.subarray(offset, offset + count);
        } else {
            if (!op || p + op > delta.length) invalid();
            chunk = delta.subarray(p, p + op); p += op;
        }
        written = safe(written + chunk.length);
        if (written > length) invalid();
        chunks.push(chunk);
    }
    if (written !== length) invalid();
    return Buffer.concat(chunks, written);
}

/** Parse PACK independently: indexPack neither verifies the trailer nor guarantees delta completeness. */
export async function inspectPack(pack, { readExternalObject } = {}) {
    try {
        if (!Buffer.isBuffer(pack) || pack.length < 32 || !pack.subarray(0, 4).equals(Buffer.from('PACK')) || pack.readUInt32BE(4) !== 2) invalid();
        const limit = pack.length - 20;
        const checksum = sha(pack.subarray(0, limit));
        if (!checksum.equals(pack.subarray(limit))) invalid();
        const count = pack.readUInt32BE(8);
        const entries = [], boundaries = new Map(), resolved = new Map();
        let p = 12;
        function byte() { if (p >= limit) invalid(); return pack[p++]; }
        for (let i = 0; i < count; i++) {
            const offset = p;
            let b = byte();
            const kind = (b >> 4) & 7;
            let length = b & 15, factor = 16;
            while (b & 128) { b = byte(); length = safe(length + (b & 127) * factor); factor = safe(factor * 128); }
            let base;
            if (kind === 6) {
                b = byte(); let distance = b & 127;
                while (b & 128) { b = byte(); distance = safe((distance + 1) * 128 + (b & 127)); }
                base = boundaries.get(offset - distance);
                if (!base) invalid();
            } else if (kind === 7) {
                if (p + 20 > limit) invalid();
                base = pack.subarray(p, p + 20).toString('hex'); p += 20;
            } else if (!TYPES[kind]) invalid();
            const inflated = zlib.inflateSync(pack.subarray(p, limit), { info: true });
            const consumed = inflated.engine.bytesWritten;
            if (!consumed || p + consumed > limit || inflated.buffer.length !== length) invalid();
            p += consumed;
            const entry = { offset, end: p, crc: crc.crc32(pack.subarray(offset, p)) >>> 0, kind, base, data: inflated.buffer };
            if (TYPES[kind]) {
                entry.type = TYPES[kind]; entry.body = entry.data;
                entry.oid = gitObjectOid(entry.type, entry.body); resolved.set(entry.oid, entry);
            }
            entries.push(entry); boundaries.set(offset, entry);
        }
        if (p !== limit) invalid();
        const pending = new Set(entries.filter(entry => !entry.oid));
        const unavailable = new Set();
        while (pending.size) {
            let progress = false;
            for (const entry of pending) {
                const base = entry.kind === 6 ? entry.base : resolved.get(entry.base);
                if (!base?.oid) continue;
                entry.type = base.type; entry.body = applyDelta(base.body, entry.data);
                entry.oid = gitObjectOid(entry.type, entry.body); resolved.set(entry.oid, entry);
                pending.delete(entry); progress = true;
            }
            if (progress) continue;
            if (!readExternalObject) invalid();
            for (const entry of pending) {
                if (entry.kind !== 7 || resolved.has(entry.base) || unavailable.has(entry.base)) continue;
                let base;
                try { base = await readExternalObject(entry.base); } catch { unavailable.add(entry.base); continue; }
                if (!base || !Object.values(TYPES).includes(base.type) || !Buffer.isBuffer(base.body) || gitObjectOid(base.type, base.body) !== entry.base) invalid();
                resolved.set(entry.base, { ...base, oid: entry.base }); progress = true;
            }
            if (!progress) invalid();
        }
        return { checksum: checksum.toString('hex'), objects: entries.map(({ oid, type, body, offset, end, crc }) => ({ oid, type, body, offset, end, crc })) };
    } catch (error) {
        if (error.code === 'S3_PACK_INVALID') throw error;
        invalid();
    }
}

/** Bind every IDX row to independently decoded PACK bytes, not merely to a valid offset. */
export function validatePackIndex({ pack, index, inspection }) {
    if (!Buffer.isBuffer(index) || index.length < 1072 || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2) invalid();
    const count = index.readUInt32BE(1028);
    if (count !== pack.readUInt32BE(8) || count !== inspection.objects.length) invalid();
    const oidStart = 1032, crcStart = oidStart + count * 20, offsetStart = crcStart + count * 4;
    if (index.length < offsetStart + count * 4 + 40) invalid();
    for (let i = 0; i < count; i++) {
        if (index.readUInt32BE(offsetStart + i * 4) >= 0x80000000) {
            // cap-ok: installed isomorphic-git GitPackIndex.fromIdx has no large-offset table decoder.
            throw syncError('S3_GIT_FORMAT_UNSUPPORTED', 'Installed isomorphic-git cannot read IDX 64-bit offset tables');
        }
    }
    if (index.length !== offsetStart + count * 4 + 40 || !sha(index.subarray(0, -20)).equals(index.subarray(-20))
        || index.subarray(-40, -20).toString('hex') !== inspection.checksum
        || !sha(pack.subarray(0, -20)).equals(pack.subarray(-20)) || pack.subarray(-20).toString('hex') !== inspection.checksum) invalid();
    const offsets = new Map(inspection.objects.map(object => [object.offset, object]));
    const distribution = Array(256).fill(0);
    let previous = '';
    for (let i = 0; i < count; i++) {
        const oid = index.subarray(oidStart + i * 20, oidStart + (i + 1) * 20).toString('hex');
        if (oid <= previous) invalid(); previous = oid;
        distribution[parseInt(oid.slice(0, 2), 16)]++;
        const offset = index.readUInt32BE(offsetStart + i * 4), object = offsets.get(offset);
        if (!object || object.oid !== oid || object.crc !== index.readUInt32BE(crcStart + i * 4)) invalid();
        offsets.delete(offset);
    }
    let cumulative = 0;
    for (let i = 0; i < 256; i++) { cumulative += distribution[i]; if (index.readUInt32BE(8 + i * 4) !== cumulative) invalid(); }
    if (offsets.size) invalid();
}
