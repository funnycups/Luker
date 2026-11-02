import { describe, test, expect } from '@jest/globals';
import { normalizeS3Settings, objectKey, newPackName, validateHead, encodeHead, decodeHead } from '../../src/sync/backends/s3/layout.js';

const settings = () => ({ endpoint: 'https://example.com/base', region: 'test-region', bucket: 'test-bucket', prefix: '/team/sync/', accessKeyId: 'access', secretAccessKey: 'secret', forcePathStyle: true, label: 'Device', passphrase: 'phrase', categories: ['chats'] });
const head = () => ({ v: 1, commit: 'a'.repeat(40), packs: [{ name: 'b'.repeat(32), size: 41 }], compactedFrom: [] });
const rejects = (fn, code) => expect(fn).toThrow(expect.objectContaining({ code }));

describe('S3 namespace settings', () => {
    test('normalizes only outer prefix slashes and joins names once', () => {
        expect(normalizeS3Settings(settings())).toEqual({ ...settings(), prefix: 'team/sync', stripIfMatchQuotes: false });
        for (const prefix of ['', '/', '///']) expect(normalizeS3Settings({ ...settings(), prefix }).prefix).toBe('');
        expect(objectKey({ prefix: '/team/sync/' }, 'head')).toBe('team/sync/head');
        expect(objectKey({ prefix: '' }, 'head')).toBe('head');
        expect(objectKey({ prefix: 'team' }, `packs/${'b'.repeat(32)}`)).toBe(`team/packs/${'b'.repeat(32)}`);
        expect(objectKey({ prefix: 'team' }, `.probe/${'c'.repeat(32)}`)).toBe(`team/.probe/${'c'.repeat(32)}`);
        expect(normalizeS3Settings({ ...settings(), endpoint: 'http://example.com/base/' }).endpoint).toBe('http://example.com/base/');
    });

    test('rejects coercion and unsafe paths before normalization', () => {
        for (const field of ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey', 'label', 'passphrase']) {
            for (const value of [null, 123, [], {}, true]) rejects(() => normalizeS3Settings({ ...settings(), [field]: value }), 'S3_SETTINGS_INVALID');
        }
        for (const value of [0, 1, 'true', null, {}]) rejects(() => normalizeS3Settings({ ...settings(), forcePathStyle: value }), 'S3_SETTINGS_INVALID');
        for (const value of [0, 1, 'true', null, {}]) rejects(() => normalizeS3Settings({ ...settings(), stripIfMatchQuotes: value }), 'S3_SETTINGS_INVALID');
        expect(normalizeS3Settings({ ...settings(), stripIfMatchQuotes: true }).stripIfMatchQuotes).toBe(true);
        for (const value of [[], ['unknown'], [1], Array(1), 'chats', null]) rejects(() => normalizeS3Settings({ ...settings(), categories: value }), 'S3_SETTINGS_INVALID');
        for (const prefix of ['a//b', 'a/./b', '..', 'a/../b', 'a\\b', 'a\u0000b', 'a\nb']) rejects(() => normalizeS3Settings({ ...settings(), prefix }), 'S3_SETTINGS_INVALID');
        for (const endpoint of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?a', 'https://example.com/#x', 'not a URL']) rejects(() => normalizeS3Settings({ ...settings(), endpoint }), 'S3_SETTINGS_INVALID');
        for (const relative of ['/head', '../head', 'a//b', 'packs/../head', 'a\\b']) expect(() => objectKey({ prefix: 'team' }, relative)).toThrow();
    });

    test('pack names are fresh lowercase 128-bit hex', () => {
        const a = newPackName();
        const b = newPackName();
        expect(a).toMatch(/^[a-f0-9]{32}$/);
        expect(b).toMatch(/^[a-f0-9]{32}$/);
        expect(a).not.toBe(b);
    });
});

describe('S3 head v1', () => {
    test('canonical order and round trip', () => {
        const input = head();
        const bytes = encodeHead({ compactedFrom: [], packs: input.packs, commit: input.commit, v: 1 });
        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect(bytes.toString()).toBe('{"v":1,"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","packs":[{"name":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":41}],"compactedFrom":[]}');
        expect(decodeHead(bytes)).toEqual(input);
        expect(validateHead(input)).toEqual(input);
    });

    test('rejects malformed names, sizes, duplicates, unknown fields and future compaction', () => {
        expect.hasAssertions();
        for (const patch of [
            { v: undefined }, { v: '1' }, { v: 1.5 }, { commit: 'A'.repeat(40) }, { commit: 123 },
            { packs: null }, { compactedFrom: ['a'.repeat(40)] }, { extra: true },
            { packs: [{ name: '../head', size: 41 }] }, { packs: [{ name: 'B'.repeat(32), size: 41 }] },
            { packs: [{ name: 'b'.repeat(32), size: 40 }] }, { packs: [{ name: 'b'.repeat(32), size: 41.5 }] },
            { packs: [{ name: 'b'.repeat(32), size: Number.MAX_SAFE_INTEGER + 1 }] },
            { packs: [{ name: 'b'.repeat(32), size: '41' }] }, { packs: [{ name: 'b'.repeat(32), size: 41, extra: true }] },
            { packs: [head().packs[0], head().packs[0]] },
        ]) {
            rejects(() => validateHead({ ...head(), ...patch }), 'S3_HEAD_INVALID');
            rejects(() => encodeHead({ ...head(), ...patch }), 'S3_HEAD_INVALID');
        }
        rejects(() => validateHead({ v: 2, packs: 'bad', extra: true }), 'S3_FORMAT_UNSUPPORTED');
        rejects(() => decodeHead(Buffer.from('{')), 'S3_HEAD_INVALID');
        rejects(() => decodeHead(Buffer.from([0xff])), 'S3_HEAD_INVALID');
        rejects(() => decodeHead('{"v":1}'), 'S3_HEAD_INVALID');
        rejects(() => decodeHead(Buffer.from('{"v":2,"packs":null}')), 'S3_FORMAT_UNSUPPORTED');
    });

    test('accepts safe integer sizes and long pack histories without arbitrary caps', () => {
        const input = { ...head(), packs: Array.from({ length: 10001 }, (_, index) => ({ name: index.toString(16).padStart(32, '0'), size: Number.MAX_SAFE_INTEGER })) };
        expect(decodeHead(encodeHead(input))).toEqual(input);
    });
});
