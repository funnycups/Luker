import { createS3Client, probeConditionalWrites } from './client.js';
import { normalizeS3Settings } from './layout.js';
import { createKeyinfo, unlockKeyinfo, validateKeyinfo, validateStoredKey, validateStoredKeyId, verifyStoredKey } from './crypto.js';
import { syncError } from '../../errors.js';
import { s3SettingsSnapshot } from '../../state.js';
import { syncService } from '../../sync-service.js';

const INPUT_FIELDS = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'stripIfMatchQuotes', 'accessKeyId', 'secretAccessKey', 'passphrase', 'label', 'categories'];
function fail(code) { throw syncError(code, code); }

function settingsFor(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !INPUT_FIELDS.includes(field))) fail('S3_SETTINGS_INVALID');
    const fields = { ...input };
    if (previous && (Object.hasOwn(fields, 'accessKeyId') || Object.hasOwn(fields, 'secretAccessKey'))) {
        if (fields.accessKeyId === '' && fields.secretAccessKey === '') {
            delete fields.accessKeyId; delete fields.secretAccessKey;
        } else if (typeof fields.accessKeyId !== 'string' || !fields.accessKeyId || typeof fields.secretAccessKey !== 'string' || !fields.secretAccessKey) fail('S3_SETTINGS_INVALID');
    }
    const normalized = normalizeS3Settings({ ...previous?.s3, ...fields });
    if (!normalized.accessKeyId || !normalized.secretAccessKey) fail('S3_SETTINGS_INVALID');
    const settings = Object.fromEntries(['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'stripIfMatchQuotes', 'accessKeyId', 'secretAccessKey'].map(field => [field, normalized[field]]));
    if (previous) {
        const old = s3SettingsSnapshot(previous.s3);
        if (old.bucket !== settings.bucket || old.prefix !== settings.prefix) fail('S3_SETTINGS_INVALID');
    }
    return settings;
}

async function readKeyinfo(transport, context) {
    const result = await transport.get('keyinfo.json');
    if (!result) return null;
    let bytes;
    try { bytes = await result.body.transformToByteArray(); } catch { fail('UNREACHABLE'); }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('S3_KEYINFO_INVALID'); }
    return validateKeyinfo(parsed, context);
}

async function withPreparation(owner, previous, fn) {
    if (!previous) return fn(async () => {});
    return syncService.withBackendOperation(owner, previous.backendId, 'prepare', lease => fn(lease.assertAlive));
}

/**
 * Network preparation only. The caller owns final maintenance and registry commit.
 * `previous` is a private BackendEntry with its registry `backendId` attached.
 * Edit input is a flat, explicit patch of form fields; Add requires all settings
 * and a passphrase. Never forward this private result as a client response.
 */
export async function prepareS3Backend({ owner, input, previous, network }) {
    const settings = settingsFor(input, previous);
    if (previous) validateStoredKeyId(previous.s3.keyId);
    if (!previous && typeof input.passphrase !== 'string') fail('S3_SETTINGS_INVALID');
    return withPreparation(owner, previous, async assertAlive => {
        const transport = createS3Client({ owner, settings, network });
        try {
            await assertAlive();
            await probeConditionalWrites({
                async put(...args) {
                    await assertAlive();
                    const result = await transport.put(...args);
                    await assertAlive();
                    return result;
                },
                // Cleanup must still remove this attempt's probe after removal.
                delete: key => transport.delete(key),
            }, { stripIfMatchQuotes: settings.stripIfMatchQuotes });
            await assertAlive();
            let keyinfo = await readKeyinfo(transport, settings);
            await assertAlive();
            let key;
            if (!keyinfo) {
                if (previous) fail('S3_KEYINFO_MISSING');
                const candidate = await createKeyinfo({ passphrase: input.passphrase, context: settings });
                await assertAlive();
                const bytes = Buffer.from(JSON.stringify(candidate.keyinfo), 'utf8');
                try {
                    await transport.put('keyinfo.json', bytes, { contentLength: bytes.length, ifNoneMatch: '*' });
                    keyinfo = candidate.keyinfo;
                    key = candidate.key;
                } catch (error) {
                    if (error.code !== 'PRECONDITION_FAILED' && error.code !== 'UNREACHABLE') throw error;
                    await assertAlive();
                    keyinfo = await readKeyinfo(transport, settings);
                    if (!keyinfo) throw error;
                }
                await assertAlive();
            }
            if (previous && keyinfo.keyId !== previous.s3.keyId) fail('S3_KEY_MISMATCH');
            if (!key) {
                if (Object.hasOwn(input, 'passphrase')) key = await unlockKeyinfo({ passphrase: input.passphrase, keyinfo, context: settings });
                else {
                    key = validateStoredKey(previous.s3.derivedKey);
                    verifyStoredKey({ key, keyId: previous.s3.keyId, keyinfo, context: settings });
                }
            }
            await assertAlive();
            return { s3: { ...settings, keyId: keyinfo.keyId, derivedKey: key.toString('base64') }, ...(previous ? { expectedS3: s3SettingsSnapshot(previous.s3) } : {}) };
        } finally { await transport.close(); }
    });
}

/** `previous` has the same private entry + backendId shape as prepareS3Backend. */
export async function prepareS3Unlock({ owner, previous, passphrase, network }) {
    validateStoredKeyId(previous?.s3?.keyId);
    if (typeof passphrase !== 'string') fail('S3_SETTINGS_INVALID');
    const expectedS3 = s3SettingsSnapshot(previous.s3);
    return withPreparation(owner, previous, async assertAlive => {
        const transport = createS3Client({ owner, settings: expectedS3, network });
        try {
            await assertAlive();
            const keyinfo = await readKeyinfo(transport, expectedS3);
            await assertAlive();
            if (!keyinfo) fail('S3_KEYINFO_MISSING');
            if (keyinfo.keyId !== expectedS3.keyId) fail('S3_KEY_MISMATCH');
            const key = await unlockKeyinfo({ passphrase, keyinfo, context: expectedS3 });
            await assertAlive();
            return { derivedKey: key.toString('base64'), expectedS3 };
        } finally { await transport.close(); }
    });
}
