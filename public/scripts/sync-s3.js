import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';

export function syncSettingsError(code) {
    switch (code) {
        case 'S3_WRONG_PASSPHRASE': return t`The passphrase does not match this bucket and prefix.`;
        case 'S3_LOCAL_KEY_ID_INVALID':
        case 'S3_KEY_MISMATCH': return t`This backend's key identity is invalid or changed. Remove it and add it again. Unlock cannot change its identity.`;
        case 'S3_STORED_KEY_INVALID':
        case 'S3_STORED_KEY_REJECTED': return t`Unlock this backend with its passphrase.`;
        case 'S3_SETTINGS_INVALID': return t`Check the S3 endpoint, region, bucket, prefix and credentials.`;
        case 'S3_KEYINFO_INVALID': return t`The encryption metadata is invalid.`;
        case 'S3_KEYINFO_MISSING': return t`The encryption metadata is missing. Restore it before syncing.`;
        case 'S3_FORMAT_UNSUPPORTED': return t`This encryption format is not supported. Update Luker.`;
        case 'S3_SETTINGS_CHANGED': return t`The settings changed while saving. Open the form again.`;
        case 'CONDITIONAL_WRITES_UNSUPPORTED': return t`This provider does not support the conditional writes sync requires.`;
        case 'S3_IF_MATCH_QUOTES_UNSUPPORTED': return t`This provider rejects a quoted ETag in If-Match. Turn on "Send ETag without quotes" for this backend and save again.`;
        case 'SYNC_PRIVATE_ADDRESS': return t`Outbound sync to private addresses is disabled for this account. Ask an administrator to enable it.`;
        case 'AUTH_FAILED': return t`S3 authentication failed. Check the credentials and bucket permissions.`;
        case 'BUCKET_NOT_FOUND': return t`The bucket could not be found. Check that it exists and that this backend uses the correct endpoint.`;
        case 'SYNC_DNS_ERROR':
        case 'UNREACHABLE': return t`The S3 endpoint could not be reached.`;
        case 'S3_HEAD_INVALID':
        case 'S3_OBJECT_AUTH_FAILED':
        case 'S3_PACK_INVALID':
        case 'S3_INCOMPLETE_OBJECTS':
        case 'S3_OBJECT_NOT_FOUND': return t`S3 sync data is missing or invalid. Restore the bucket's sync data before syncing again.`;
        case 'PRECONDITION_FAILED': return t`The S3 data changed during sync. Sync again to receive the latest version.`;
        case 'S3_PROVIDER_ERROR': return t`The S3 provider rejected the request. Check its availability and bucket permissions.`;
        case 'S3_SOURCE_ERROR': return t`The local upload could not be read. Check local storage and sync again.`;
        case 'SYNC_AGENT_DESTROYED':
        case 'S3_TRANSPORT_CLOSED': return t`The S3 connection was closed. Sync again when the backend is available.`;
        case 'INVALID_DEVICE_LABEL': return t`Enter a valid device label.`;
        case 'INVALID_CATEGORIES': return t`Select at least one category to sync.`;
        case 'UNDO_NOT_COMMITTED': return t`Undo could not update the local files. The undo point was kept.`;
        case 'PENDING_READ_FAILED': return t`Some pending sync records could not be read.`;
        default: return t`S3 sync failed (${code || 'SYNC_FAILED'}). Check the backend settings and provider availability before syncing again.`;
    }
}

/**
 * The `s3` settings and passphrase of a backend form. Blank credentials and
 * passphrase are left out when editing, so the stored values are kept.
 *
 * @param {{ endpoint: string, region: string, bucket: string, prefix: string, accessKeyId: string, secretAccessKey: string, forcePathStyle: boolean, passphrase: string }} values
 * @param {'add'|'edit'} mode
 * @returns {{ s3: Record<string, string|boolean>, passphrase?: string }}
 */
export function s3SettingsPayload(values, mode) {
    const s3 = {};
    for (const name of ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey']) {
        const value = String(values[name] || '');
        if (mode === 'add' || value || !['accessKeyId', 'secretAccessKey'].includes(name)) s3[name] = value;
    }
    s3.forcePathStyle = Boolean(values.forcePathStyle);
    s3.stripIfMatchQuotes = Boolean(values.stripIfMatchQuotes);
    const payload = { s3 };
    if (mode === 'add' || values.passphrase) payload.passphrase = String(values.passphrase || '');
    return payload;
}

/**
 * Route that saves a backend form.
 *
 * @param {'add'|'edit'|'unlock'} mode
 * @param {string} [backendId]
 * @param {boolean} [lan] A LAN backend, whose edit saves only label and categories
 * @returns {string}
 */
export function backendSettingsUrl(mode, backendId, lan = false) {
    const base = '/api/sync/v1/backends';
    return mode === 'add' ? `${base}/s3` : `${base}/${encodeURIComponent(backendId)}${mode === 'unlock' ? '/unlock' : lan ? '' : '/s3'}`;
}

/**
 * Save backend settings.
 *
 * @param {string} url From `backendSettingsUrl`
 * @param {object} payload
 * @returns {Promise<any>} The answer of the route
 * @throws {Error & { code?: string }} With a user-facing message when the save failed
 */
export async function postBackendSettings(url, payload) {
    const response = await fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw Object.assign(new Error(syncSettingsError(body.code)), { code: body.code });
    return body;
}
