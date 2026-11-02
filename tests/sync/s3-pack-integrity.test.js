import { expect, test } from '@jest/globals';
import zlib from 'node:zlib';
import { inspectPack, validatePackIndex } from '../../src/sync/backends/s3/pack-integrity.js';
import { buildPackFixture, entryHeader, rawPack, refDelta, objectOid, seal, highBitPackSignature, hash } from './_lib/s3-pack-fixtures.js';

const body = Buffer.from('hello');
test('rejects high-bit PACK signature with valid recalculated pack and index checksums', async () => {
    const fixture = highBitPackSignature(await buildPackFixture({ objects: [{ body }] }));
    expect(hash(fixture.pack.subarray(0, -20))).toEqual(fixture.pack.subarray(-20));
    expect(hash(fixture.index.subarray(0, -20))).toEqual(fixture.index.subarray(-20));
    expect(fixture.index.subarray(-40, -20)).toEqual(fixture.pack.subarray(-20));
    await expect(inspectPack(fixture.pack)).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});
test('independent inspection hashes all real objects and binds the real public index', async () => {
    const fixture = await buildPackFixture({ objects: [{ body }, { body: Buffer.from('world') }] });
    const inspection = await inspectPack(fixture.pack);
    expect(inspection.objects.map(object => object.body.toString())).toEqual(['hello', 'world']);
    expect(inspection.objects[0].oid).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
    expect(() => validatePackIndex({ ...fixture, inspection })).not.toThrow();
});
test.each(['trailer', 'count', 'termination', 'length', 'zlib'])('rejects invalid PACK %s independently of indexPack', async kind => {
    let pack = rawPack([Buffer.concat([entryHeader(3, body.length), zlib.deflateSync(body)])]);
    if (kind === 'trailer') pack[pack.length - 1] ^= 1;
    if (kind === 'count') { const payload = Buffer.from(pack.subarray(0, -20)); payload.writeUInt32BE(2, 8); pack = seal(payload); }
    if (kind === 'termination') pack = seal(Buffer.concat([pack.subarray(0, -20), Buffer.from([0])]));
    if (kind === 'length') pack = rawPack([Buffer.concat([entryHeader(3, 6), zlib.deflateSync(body)])]);
    if (kind === 'zlib') pack = rawPack([Buffer.concat([entryHeader(3, 5), zlib.deflateSync(body).subarray(0, -1)])]);
    await expect(inspectPack(pack)).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});
test('same-type swapped offsets with recomputed index checksum reject', async () => {
    const fixture = await buildPackFixture({ objects: [{ body }, { body: Buffer.from('world') }] });
    const inspection = await inspectPack(fixture.pack);
    const index = Buffer.from(fixture.index);
    const offsets = 8 + 1024 + 2 * 24;
    const a = index.readUInt32BE(offsets), b = index.readUInt32BE(offsets + 4);
    index.writeUInt32BE(b, offsets); index.writeUInt32BE(a, offsets + 4);
    // Swap CRCs too: only OID-to-offset binding can catch this.
    const crc = offsets - 8;
    const c = index.readUInt32BE(crc), d = index.readUInt32BE(crc + 4);
    index.writeUInt32BE(d, crc); index.writeUInt32BE(c, crc + 4);
    const signed = seal(index.subarray(0, -20));
    expect(() => validatePackIndex({ pack: fixture.pack, index: signed, inspection })).toThrow();
});
test('REF_DELTA resolves a same-pack base and a verified external base', async () => {
    const oid = objectOid('blob', body);
    const delta = Buffer.from([5, 6, 0x90, 5, 1, 33]); // copy hello; insert !
    const same = rawPack([refDelta(oid, delta), Buffer.concat([entryHeader(3, 5), zlib.deflateSync(body)])]);
    expect((await inspectPack(same)).objects[0].body.toString()).toBe('hello!');
    const external = rawPack([refDelta(oid, delta)]);
    expect((await inspectPack(external, { readExternalObject: async requested => {
        expect(requested).toBe(oid); return { type: 'blob', body };
    } })).objects[0].body.toString()).toBe('hello!');
    await expect(inspectPack(external)).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
    await expect(inspectPack(external, { readExternalObject: async () => ({ type: 'tree', body }) })).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});
test.each([[5, 1, 0], [5, 6, 0x91, 4, 5], [4, 5, 0x90, 5], [5, 6, 0x90, 5]].map(bytes => [bytes]))('rejects delta opcode/size violations %j', async bytes => {
    await expect(inspectPack(rawPack([refDelta(objectOid('blob', body), Buffer.from(bytes))]), {
        readExternalObject: async () => ({ type: 'blob', body }),
    })).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});

test('OFS_DELTA accepts only an earlier entry boundary', async () => {
    const base = Buffer.concat([entryHeader(3, 5), zlib.deflateSync(body)]);
    const delta = Buffer.from([5, 6, 0x90, 5, 1, 33]);
    const entry = distance => Buffer.concat([entryHeader(6, delta.length), Buffer.from([distance]), zlib.deflateSync(delta)]);
    expect((await inspectPack(rawPack([base, entry(base.length)]))).objects[1].body.toString()).toBe('hello!');
    await expect(inspectPack(rawPack([base, entry(base.length - 1)]))).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
    await expect(inspectPack(rawPack([base, entry(0)]))).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});

test('same-pack cyclic REF_DELTA dependencies reject without omitted objects', async () => {
    const other = objectOid('blob', Buffer.from('world'));
    const pack = rawPack([refDelta(other, Buffer.from([5, 5, 5, ...body])), refDelta(objectOid('blob', body), Buffer.from([5, 5, 5, ...Buffer.from('world')]))]);
    await expect(inspectPack(pack)).rejects.toMatchObject({ code: 'S3_PACK_INVALID' });
});

test('forward REF_DELTA chains resolve after their external ancestor without querying unresolved candidate bases as authoritative', async () => {
    const intermediate = objectOid('blob', Buffer.from('hello!'));
    const pack = rawPack([
        refDelta(intermediate, Buffer.from([6, 7, 0x90, 6, 1, 33])),
        refDelta(objectOid('blob', body), Buffer.from([5, 6, 0x90, 5, 1, 33])),
    ]);
    const inspected = await inspectPack(pack, { readExternalObject: async oid => {
        if (oid !== objectOid('blob', body)) throw new Error('not installed');
        return { type: 'blob', body };
    } });
    expect(inspected.objects.map(object => object.body.toString())).toEqual(['hello!!', 'hello!']);
});

test.each(['fanout', 'sort', 'crc', 'boundary', 'pack-sha', 'index-sha', 'count', 'extra', 'large-offset'])('IDX %s corruption is rejected', async kind => {
    const fixture = await buildPackFixture({ objects: [{ body }, { body: Buffer.from('world') }] });
    const inspection = await inspectPack(fixture.pack);
    let index = Buffer.from(fixture.index);
    if (kind === 'fanout') index.writeUInt32BE(1, 8);
    if (kind === 'sort') index.copy(index, 1032 + 20, 1032, 1032 + 20);
    if (kind === 'crc') index[1032 + 40] ^= 1;
    if (kind === 'boundary') index.writeUInt32BE(13, 1032 + 48);
    if (kind === 'pack-sha') index[index.length - 40] ^= 1;
    if (kind === 'count') index.writeUInt32BE(1, 1028);
    if (kind === 'large-offset') index.writeUInt32BE(0x80000000, 1032 + 48);
    if (kind === 'extra') index = Buffer.concat([index.subarray(0, -20), Buffer.alloc(8), index.subarray(-20)]);
    index = seal(index.subarray(0, -20));
    if (kind === 'index-sha') index[index.length - 1] ^= 1;
    let failure;
    try { validatePackIndex({ pack: fixture.pack, index, inspection }); } catch (error) { failure = error; }
    expect(failure?.code).toBe(kind === 'large-offset' ? 'S3_GIT_FORMAT_UNSUPPORTED' : 'S3_PACK_INVALID');
});
