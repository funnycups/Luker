import { describe, test, expect } from '@jest/globals';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    validateKeyinfo, validateStoredKey, validateStoredKeyId, deriveKey, createKeyinfo,
    unlockKeyinfo, verifyStoredKey, encodeEnvelope, encryptObject, decryptObject,
} from '../../src/sync/backends/s3/crypto.js';

const fixture = JSON.parse(readFileSync(new URL('./_fixtures/s3-v1-vectors.json', import.meta.url)));
const key = Buffer.from(fixture.key, 'hex');
const nonce = Buffer.from(fixture.nonce, 'hex');
const { keyId, context } = fixture;
const metadata = () => ({ v: 1, kdf: 'scrypt', salt: 'AAECAwQFBgcICQoLDA0ODw==', N: 131072, r: 8, p: 1, keyId, verifier: fixture.verifierBase64 });
const args = vector => ({ key, keyId, context, ...vector, plaintext: Buffer.from(vector.plaintext) });
const rejects = (fn, code) => expect(fn).toThrow(expect.objectContaining({ code }));

describe('S3 v1 encryption', () => {
    test.each(fixture.vectors)('encodes and decodes literal $domain vector', vector => {
        const input = args(vector);
        const envelope = encodeEnvelope({ ...input, nonce });
        expect(envelope.toString('hex')).toBe(vector.hex);
        expect(envelope.length).toBe(input.plaintext.length + 41);
        expect(envelope.subarray(0, 5).toString('hex')).toBe('4c4b535201');
        expect(envelope.subarray(5, 13).toString('hex')).toBe(keyId);
        expect(envelope.subarray(13, 25)).toEqual(nonce);
        expect(decryptObject({ ...input, envelope: Buffer.from(vector.hex, 'hex') })).toEqual(input.plaintext);
    });

    test('independent built-in crypto confirms the literal vectors and AAD', () => {
        for (const vector of fixture.vectors) {
            const header = Buffer.from('4c4b5352010102030405060708000102030405060708090a0b', 'hex');
            const aad = Buffer.concat([header, Buffer.from(JSON.stringify(['luker-sync', 1, vector.domain, 'vector-bucket', 'team/sync', vector.relativeKey]))]);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
            cipher.setAAD(aad);
            expect(Buffer.concat([header, cipher.update(vector.plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('hex')).toBe(vector.hex);
        }
        expect(Buffer.concat([Buffer.from(fixture.vectors[0].hex, 'hex').subarray(0, 25), Buffer.from('["luker-sync",1,"verifier","vector-bucket","team/sync","keyinfo.json"]')]).toString('hex')).toBe(fixture.verifierAad);
        expect(Buffer.from(fixture.vectors[0].hex, 'hex').toString('base64')).toBe(fixture.verifierBase64);
    });

    test('production encryption uses fresh nonces and accepts empty plaintext', () => {
        const input = { ...args(fixture.vectors[1]), plaintext: Buffer.alloc(0) };
        const a = encryptObject(input);
        const b = encryptObject(input);
        expect(a.length).toBe(41);
        expect(a.subarray(13, 25)).not.toEqual(b.subarray(13, 25));
        expect(decryptObject({ ...input, envelope: a })).toEqual(Buffer.alloc(0));
    });

    test('rejects tampering at all header and authentication boundaries', () => {
        expect.hasAssertions();
        const input = args(fixture.vectors[2]);
        const envelope = Buffer.from(fixture.vectors[2].hex, 'hex');
        for (const offset of [0, 5, 13, 25, envelope.length - 1]) {
            const changed = Buffer.from(envelope);
            changed[offset] ^= 1;
            rejects(() => decryptObject({ ...input, envelope: changed }), offset === 5 ? 'S3_KEY_MISMATCH' : 'S3_OBJECT_AUTH_FAILED');
        }
        const future = Buffer.from(envelope);
        future[4] = 2;
        rejects(() => decryptObject({ ...input, envelope: future }), 'S3_FORMAT_UNSUPPORTED');
        rejects(() => decryptObject({ ...input, envelope: future.subarray(0, 5) }), 'S3_FORMAT_UNSUPPORTED');
        for (const length of [0, 4, 5, 12, 13, 24, 25, 40]) rejects(() => decryptObject({ ...input, envelope: envelope.subarray(0, length) }), 'S3_OBJECT_AUTH_FAILED');
        future[0] = 0;
        rejects(() => decryptObject({ ...input, envelope: future }), 'S3_OBJECT_AUTH_FAILED');
        for (const patch of [
            { key: Buffer.alloc(32) }, { context: { ...context, bucket: 'other' } },
            { context: { ...context, prefix: 'other' } }, { relativeKey: `packs/${'c'.repeat(32)}` },
            { domain: 'head', relativeKey: 'head' },
        ]) rejects(() => decryptObject({ ...input, ...patch, envelope }), 'S3_OBJECT_AUTH_FAILED');
    });

    test('validates key buffers and explicit nonces before cipher construction', () => {
        for (const value of [null, key.toString('base64'), new Uint8Array(32), Buffer.alloc(31), Buffer.alloc(33)]) {
            rejects(() => encryptObject({ ...args(fixture.vectors[0]), key: value }), 'S3_STORED_KEY_INVALID');
        }
        for (const value of [null, Buffer.alloc(11), Buffer.alloc(13), new Uint8Array(12)]) {
            expect(() => encodeEnvelope({ ...args(fixture.vectors[0]), nonce: value })).toThrow();
        }
    });
});

describe('keyinfo validation and unlock', () => {
    test('canonical stored key and ID validation', () => {
        expect(validateStoredKey(key.toString('base64'))).toEqual(key);
        expect(validateStoredKeyId(keyId)).toBe(keyId);
        for (const value of [key, '', key.toString('base64').slice(0, -1), `${key.toString('base64')}\n`, Buffer.alloc(31).toString('base64'), `${key.toString('base64').slice(0, -2)}9=`]) rejects(() => validateStoredKey(value), 'S3_STORED_KEY_INVALID');
        for (const value of [null, 123, 'A'.repeat(16), 'a'.repeat(15), 'a'.repeat(17)]) rejects(() => validateStoredKeyId(value), 'S3_LOCAL_KEY_ID_INVALID');
    });

    test('validates exact metadata and version precedence synchronously', () => {
        expect(validateKeyinfo(metadata(), context)).toEqual(metadata());
        for (const patch of [
            { v: undefined }, { v: '1' }, { v: 1.5 }, { kdf: 'other' }, { extra: true },
            { N: 1.5 }, { N: Number.MAX_SAFE_INTEGER + 1 }, { r: '8' }, { p: null },
            { salt: 'AAECAwQFBgcICQoLDA0ODx==' }, { salt: 'AAECAwQFBgcICQoLDA0ODw' },
            { salt: Buffer.alloc(15).toString('base64') }, { keyId: 'A'.repeat(16) },
            { verifier: `${fixture.verifierBase64}\n` }, { verifier: 'A'.repeat(1000000) },
            { verifier: Buffer.alloc(66).toString('base64') }, { verifier: `${fixture.verifierBase64.slice(0, -3)}B==` },
        ]) rejects(() => validateKeyinfo({ ...metadata(), ...patch }, context), 'S3_KEYINFO_INVALID');
        for (const patch of [{ N: 2 ** 30 }, { N: 32768 }, { r: 16 }, { p: 2 }, { v: 2, salt: {}, extra: true }]) rejects(() => validateKeyinfo({ ...metadata(), ...patch }, context), 'S3_FORMAT_UNSUPPORTED');
        for (const offset of [0, 5]) {
            const verifier = Buffer.from(fixture.verifierBase64, 'base64');
            verifier[offset] ^= 1;
            rejects(() => validateKeyinfo({ ...metadata(), verifier: verifier.toString('base64') }, context), 'S3_KEYINFO_INVALID');
        }
        const verifier = Buffer.from(fixture.verifierBase64, 'base64');
        verifier[4] = 2;
        rejects(() => validateKeyinfo({ ...metadata(), verifier: verifier.toString('base64') }, context), 'S3_FORMAT_UNSUPPORTED');
    });

    test('stored key verifier distinguishes malformed, wrong, and mismatched identity', () => {
        expect(verifyStoredKey({ key, keyId, keyinfo: metadata(), context })).toBeUndefined();
        rejects(() => verifyStoredKey({ key: Buffer.alloc(32), keyId, keyinfo: metadata(), context }), 'S3_STORED_KEY_REJECTED');
        rejects(() => verifyStoredKey({ key: Buffer.alloc(31), keyId, keyinfo: metadata(), context }), 'S3_STORED_KEY_INVALID');
        rejects(() => verifyStoredKey({ key, keyId: 'a'.repeat(16), keyinfo: metadata(), context }), 'S3_KEY_MISMATCH');
        rejects(() => verifyStoredKey({ key, keyId: 'bad', keyinfo: metadata(), context }), 'S3_LOCAL_KEY_ID_INVALID');
        rejects(() => verifyStoredKey({ key, keyId, keyinfo: metadata(), context: { ...context, bucket: 'other' } }), 'S3_STORED_KEY_REJECTED');
    });

    test('rejects unsafe context before any unlock derivation', () => {
        expect.hasAssertions();
        for (const value of [undefined, null, {}, { bucket: [], prefix: '' }, { bucket: 'bucket', prefix: 1 }, { bucket: 'bucket', prefix: 'a//b' }]) {
            rejects(() => unlockKeyinfo({ passphrase: 'phrase', keyinfo: metadata(), context: value }), 'S3_SETTINGS_INVALID');
            rejects(() => createKeyinfo({ passphrase: 'phrase', context: value }), 'S3_SETTINGS_INVALID');
        }
    });

    test('authenticates verifier plaintext and binds normalized namespace', () => {
        const wrongPlaintext = encodeEnvelope({ ...args(fixture.vectors[0]), plaintext: Buffer.from('X'.repeat(26)), nonce });
        const changed = { ...metadata(), verifier: wrongPlaintext.toString('base64') };
        expect(validateKeyinfo(changed, context)).toEqual(changed);
        rejects(() => verifyStoredKey({ key, keyId, keyinfo: changed, context }), 'S3_STORED_KEY_REJECTED');
        const envelope = Buffer.from(fixture.vectors[0].hex, 'hex');
        expect(decryptObject({ ...args(fixture.vectors[0]), context: { ...context, prefix: '/team/sync/' }, envelope })).toEqual(Buffer.from(fixture.vectors[0].plaintext));
        for (const patch of [{ domain: 'head' }, { domain: 'unknown' }, { relativeKey: '../head' }]) rejects(() => decryptObject({ ...args(fixture.vectors[0]), ...patch, envelope }), 'S3_OBJECT_AUTH_FAILED');
    });

    test('actual default async scrypt matches built-in output and unlocks', async () => {
        const passphrase = 'fixture phrase — not retained';
        const created = await createKeyinfo({ passphrase, context });
        expect(Object.keys(created).sort()).toEqual(['key', 'keyinfo']);
        expect(created.keyinfo).toMatchObject({ v: 1, kdf: 'scrypt', N: 131072, r: 8, p: 1 });
        expect(created.keyinfo.verifier).toHaveLength(92);
        expect(Buffer.from(created.keyinfo.verifier, 'base64')).toHaveLength(67);
        const independent = await promisify(crypto.scrypt)(passphrase, Buffer.from(created.keyinfo.salt, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
        expect(created.key).toEqual(independent);
        expect(await deriveKey(passphrase, created.keyinfo)).toEqual(independent);
        expect(await unlockKeyinfo({ passphrase, keyinfo: created.keyinfo, context })).toEqual(independent);
        await expect(unlockKeyinfo({ passphrase: 'wrong', keyinfo: created.keyinfo, context })).rejects.toMatchObject({ code: 'S3_WRONG_PASSPHRASE' });
        expect(verifyStoredKey({ ...created, keyId: created.keyinfo.keyId, context })).toBeUndefined();
        expect(JSON.stringify(created.keyinfo)).not.toContain(passphrase);
    });

    test('hostile keyinfo rejects in a real child before costly KDF', () => {
        const moduleUrl = new URL('../../src/sync/backends/s3/crypto.js', import.meta.url).href;
        const script = `
            import { deriveKey, unlockKeyinfo, validateKeyinfo } from ${JSON.stringify(moduleUrl)};
            import assert from 'node:assert/strict';
            const base = ${JSON.stringify(metadata())};
            const context = ${JSON.stringify(context)};
            for (let i = 0; i < 100; i++) {
                for (const patch of [{N: 2 ** 30}, {r: 1024}, {p: 1024}, {verifier: 'A'.repeat(1000000)}, {extra: true}]) {
                    const input = {...base, ...patch};
                    assert.throws(() => validateKeyinfo(input, context), e => e.code.startsWith('S3_'));
                    assert.throws(() => deriveKey('phrase', input), e => e.code.startsWith('S3_'));
                    assert.throws(() => unlockKeyinfo({passphrase: 'phrase', keyinfo: input, context}), e => e.code.startsWith('S3_'));
                }
            }
            console.log('hostile metadata rejected');
        `;
        // Harness deadline only: repeated valid-cost derivations cannot complete here;
        // hostile parameters must be rejected synchronously, without invoking scrypt.
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
        expect(output.trim()).toBe('hostile metadata rejected');
    });
});
