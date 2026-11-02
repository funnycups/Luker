import { createCipheriv, createDecipheriv, randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { objectKey } from './layout.js';
import { syncError } from '../../errors.js';

const scrypt = promisify(nodeScrypt);
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const MAGIC = Buffer.from('LKSR', 'ascii');
const VERIFIER = Buffer.from('Luker Sync key verifier v1', 'utf8');
const KEY_ID = /^[a-f0-9]{16}$/;
const KEYINFO_FIELDS = ['v', 'kdf', 'salt', 'N', 'r', 'p', 'keyId', 'verifier'];

/**
 * @typedef {object} Keyinfo
 * @property {1} v
 * @property {'scrypt'} kdf
 * @property {string} salt Canonical padded base64 of 16 bytes.
 * @property {131072} N
 * @property {8} r
 * @property {1} p
 * @property {string} keyId Lowercase hex of 8 bytes.
 * @property {string} verifier Canonical padded base64 of the 67-byte envelope.
 */

function fail(code) {
    // Never include passphrases, keys, metadata or provider payloads in errors.
    throw syncError(code, code);
}

function canonicalBase64(value, size, code) {
    // Fixed encoded size is checked before allocating a decoded buffer.
    if (typeof value !== 'string' || value.length !== 4 * Math.ceil(size / 3)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(code);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== size || bytes.toString('base64') !== value) fail(code);
    return bytes;
}

function keyBuffer(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('S3_STORED_KEY_INVALID');
    return key;
}

export function validateStoredKey(value) {
    return canonicalBase64(value, 32, 'S3_STORED_KEY_INVALID');
}

export function validateStoredKeyId(value) {
    if (typeof value !== 'string' || !KEY_ID.test(value)) fail('S3_LOCAL_KEY_ID_INVALID');
    return value;
}

function validateContext(context) {
    if (!context || typeof context.bucket !== 'string' || !context.bucket || typeof context.prefix !== 'string') fail('S3_SETTINGS_INVALID');
    // AAD uses the same normalization as the storage namespace.
    const joined = objectKey(context, 'head');
    return { bucket: context.bucket, prefix: joined === 'head' ? '' : joined.slice(0, -5) };
}

function contextBytes(domain, context, relativeKey) {
    const normalized = validateContext(context);
    if (!((domain === 'verifier' && relativeKey === 'keyinfo.json') || (domain === 'head' && relativeKey === 'head')
        || (domain === 'pack' && typeof relativeKey === 'string' && /^packs\/[a-f0-9]{32}$/.test(relativeKey)))) fail('S3_OBJECT_AUTH_FAILED');
    return Buffer.from(JSON.stringify(['luker-sync', 1, domain, normalized.bucket, normalized.prefix, relativeKey]), 'utf8');
}

function validateEnvelope(envelope, keyId, shapeCode) {
    if (!Buffer.isBuffer(envelope) || envelope.length < 5 || !envelope.subarray(0, 4).equals(MAGIC)) fail(shapeCode);
    if (envelope[4] !== 1) fail('S3_FORMAT_UNSUPPORTED');
    if (envelope.length < 41) fail(shapeCode);
    if (envelope.subarray(5, 13).toString('hex') !== keyId) fail(shapeCode === 'S3_KEYINFO_INVALID' ? shapeCode : 'S3_KEY_MISMATCH');
}

/** Parse metadata before any expensive work. Authentication happens only during unlock. */
export function validateKeyinfo(input, context) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isInteger(input.v)) fail('S3_KEYINFO_INVALID');
    if (input.v !== 1) fail('S3_FORMAT_UNSUPPORTED');
    if (Object.keys(input).length !== KEYINFO_FIELDS.length || !KEYINFO_FIELDS.every(field => Object.hasOwn(input, field))
        || input.kdf !== 'scrypt' || !['N', 'r', 'p'].every(field => Number.isSafeInteger(input[field]) && input[field] > 0)
        || typeof input.keyId !== 'string' || !KEY_ID.test(input.keyId)) fail('S3_KEYINFO_INVALID');
    if (input.N !== SCRYPT.N || input.r !== SCRYPT.r || input.p !== SCRYPT.p) fail('S3_FORMAT_UNSUPPORTED');
    canonicalBase64(input.salt, 16, 'S3_KEYINFO_INVALID');
    const verifier = canonicalBase64(input.verifier, 67, 'S3_KEYINFO_INVALID');
    validateEnvelope(verifier, input.keyId, 'S3_KEYINFO_INVALID');
    if (context !== undefined) validateContext(context);
    return { v: 1, kdf: 'scrypt', salt: input.salt, N: input.N, r: input.r, p: input.p, keyId: input.keyId, verifier: input.verifier };
}

function validatePhrase(phrase) {
    if (typeof phrase !== 'string') fail('S3_SETTINGS_INVALID');
}

/** Validation is synchronous; only the built-in KDF runs asynchronously. */
export function deriveKey(phrase, keyinfo) {
    const validated = validateKeyinfo(keyinfo);
    validatePhrase(phrase);
    return scrypt(phrase, Buffer.from(validated.salt, 'base64'), 32, SCRYPT);
}

/** Explicit-input primitive for interoperability; callers normally use encryptObject. */
export function encodeEnvelope({ key, keyId, nonce, domain, context, relativeKey, plaintext }) {
    keyBuffer(key);
    validateStoredKeyId(keyId);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 12 || !Buffer.isBuffer(plaintext)) fail('S3_OBJECT_AUTH_FAILED');
    const suffix = contextBytes(domain, context, relativeKey);
    const header = Buffer.concat([MAGIC, Buffer.from([1]), Buffer.from(keyId, 'hex'), nonce]);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.concat([header, suffix]));
    return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function encryptObject(args) {
    return encodeEnvelope({ ...args, nonce: randomBytes(12) });
}

export function decryptObject({ key, keyId, domain, context, relativeKey, envelope }) {
    keyBuffer(key);
    validateStoredKeyId(keyId);
    validateEnvelope(envelope, keyId, 'S3_OBJECT_AUTH_FAILED');
    const suffix = contextBytes(domain, context, relativeKey);
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(13, 25));
        decipher.setAAD(Buffer.concat([envelope.subarray(0, 25), suffix]));
        decipher.setAuthTag(envelope.subarray(-16));
        return Buffer.concat([decipher.update(envelope.subarray(25, -16)), decipher.final()]);
    } catch {
        fail('S3_OBJECT_AUTH_FAILED');
    }
}

function authenticateVerifier(key, keyinfo, context, failureCode) {
    try {
        const plaintext = decryptObject({ key, keyId: keyinfo.keyId, domain: 'verifier', context, relativeKey: 'keyinfo.json', envelope: Buffer.from(keyinfo.verifier, 'base64') });
        if (!plaintext.equals(VERIFIER)) fail(failureCode);
    } catch {
        fail(failureCode);
    }
}

export function createKeyinfo({ passphrase, context }) {
    validatePhrase(passphrase);
    validateContext(context);
    const salt = randomBytes(16);
    const keyId = randomBytes(8).toString('hex');
    return scrypt(passphrase, salt, 32, SCRYPT).then(key => {
        const verifier = encryptObject({ key, keyId, domain: 'verifier', context, relativeKey: 'keyinfo.json', plaintext: VERIFIER }).toString('base64');
        return { keyinfo: { v: 1, kdf: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyId, verifier }, key };
    });
}

export function unlockKeyinfo({ passphrase, keyinfo, context }) {
    const validated = validateKeyinfo(keyinfo, context);
    validateContext(context);
    return deriveKey(passphrase, validated).then(key => {
        authenticateVerifier(key, validated, context, 'S3_WRONG_PASSPHRASE');
        return key;
    });
}

export function verifyStoredKey({ key, keyId, keyinfo, context }) {
    validateStoredKeyId(keyId);
    keyBuffer(key);
    const validated = validateKeyinfo(keyinfo, context);
    if (keyId !== validated.keyId) fail('S3_KEY_MISMATCH');
    authenticateVerifier(key, validated, context, 'S3_STORED_KEY_REJECTED');
}
