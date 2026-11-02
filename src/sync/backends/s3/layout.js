import { randomBytes } from 'node:crypto';
import { SYNC_CATEGORIES } from '../../categories.js';
import { syncError } from '../../errors.js';

const PACK_NAME = /^[a-f0-9]{32}$/;
const CATEGORY_IDS = new Set(SYNC_CATEGORIES.map(category => category.id));

function fail(code) {
    throw syncError(code, code);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields) {
    return isRecord(value) && Object.keys(value).length === fields.length
        && fields.every(field => Object.hasOwn(value, field));
}

function normalizePrefix(value) {
    if (typeof value !== 'string' || /[\\\p{Cc}]/u.test(value)) fail('S3_SETTINGS_INVALID');
    const prefix = value.replace(/^\/+|\/+$/g, '');
    if (prefix && prefix.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('S3_SETTINGS_INVALID');
    return prefix;
}

/** Validate form fields without coercion; namespace identity is independent of endpoint. */
export function normalizeS3Settings(input) {
    if (!isRecord(input)) fail('S3_SETTINGS_INVALID');
    for (const field of ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey']) {
        if (typeof input[field] !== 'string') fail('S3_SETTINGS_INVALID');
    }
    for (const field of ['label', 'passphrase']) {
        if (Object.hasOwn(input, field) && typeof input[field] !== 'string') fail('S3_SETTINGS_INVALID');
    }
    if (typeof input.forcePathStyle !== 'boolean' || !input.region || !input.bucket) fail('S3_SETTINGS_INVALID');
    if (Object.hasOwn(input, 'stripIfMatchQuotes') && typeof input.stripIfMatchQuotes !== 'boolean') fail('S3_SETTINGS_INVALID');
    if (Object.hasOwn(input, 'categories') && (!Array.isArray(input.categories) || !input.categories.length
        || Array.from(input.categories).some(category => typeof category !== 'string' || !CATEGORY_IDS.has(category)))) fail('S3_SETTINGS_INVALID');
    let endpoint;
    try {
        endpoint = new URL(input.endpoint);
    } catch {
        fail('S3_SETTINGS_INVALID');
    }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || input.endpoint.includes('?') || input.endpoint.includes('#')) fail('S3_SETTINGS_INVALID');
    return { ...input, prefix: normalizePrefix(input.prefix), stripIfMatchQuotes: input.stripIfMatchQuotes === true };
}

/** Join a normalized namespace with a safe relative object path, without URL encoding. */
export function objectKey(settings, relativeKey) {
    const prefix = normalizePrefix(settings?.prefix);
    if (typeof relativeKey !== 'string' || /[\\\p{Cc}]/u.test(relativeKey)
        || relativeKey.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('S3_SETTINGS_INVALID');
    return prefix ? `${prefix}/${relativeKey}` : relativeKey;
}

export function newPackName() {
    return randomBytes(16).toString('hex');
}

/** Return a canonical detached head, rejecting unsupported versions before v1 fields. */
export function validateHead(input) {
    if (!isRecord(input) || !Number.isInteger(input.v)) fail('S3_HEAD_INVALID');
    if (input.v !== 1) fail('S3_FORMAT_UNSUPPORTED');
    if (!exactFields(input, ['v', 'commit', 'packs', 'compactedFrom'])
        || typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)
        || !Array.isArray(input.packs) || !Array.isArray(input.compactedFrom) || input.compactedFrom.length) fail('S3_HEAD_INVALID');
    const names = new Set();
    const packs = [];
    for (const pack of input.packs) {
        if (!exactFields(pack, ['name', 'size']) || typeof pack.name !== 'string' || !PACK_NAME.test(pack.name)
            || !Number.isSafeInteger(pack.size) || pack.size < 41 || names.has(pack.name)) fail('S3_HEAD_INVALID');
        names.add(pack.name);
        packs.push({ name: pack.name, size: pack.size });
    }
    return { v: 1, commit: input.commit, packs, compactedFrom: [] };
}

export function encodeHead(input) {
    return Buffer.from(JSON.stringify(validateHead(input)), 'utf8');
}

export function decodeHead(bytes) {
    let input;
    try {
        if (!Buffer.isBuffer(bytes)) fail('S3_HEAD_INVALID');
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        fail('S3_HEAD_INVALID');
    }
    return validateHead(input);
}
