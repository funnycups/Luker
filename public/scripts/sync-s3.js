import { getRequestHeaders } from '../script.js';
import { t, translate } from './i18n.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';

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

export function renderSyncCategories(container, categories, selected) {
    container.empty();
    for (const cat of categories) {
        const input = $('<input type="checkbox" name="lanSyncCategory">').val(cat.id).prop('checked', selected ? selected.includes(cat.id) : cat.syncDefault === 'on');
        const fallback = cat.id.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ');
        container.append($('<label class="checkbox_label lanSyncCategoryItem"></label>').append(input, ' ', $('<span></span>').text(translate(fallback, cat.displayKey))));
    }
}

/** Secrets are supplied only by the user; blank edit fields retain stored values. */
export async function openS3BackendForm({ mode, backendId, backend, categories, onSaved }) {
    const template = $(await renderTemplateAsync('userSyncS3'));
    const lan = backend?.kind === 'lan';
    const unlock = mode === 'unlock';
    const field = name => template.find(`.syncS3${name}`);
    template.find('h3').text(unlock ? t`Unlock S3 backend` : mode === 'add' ? t`Add S3 backend` : t`Edit sync backend`);
    template.find('.syncS3ConnectionFields').toggleClass('displayNone', lan || unlock);
    template.find('.syncS3CommonFields').toggleClass('displayNone', unlock);
    template.find('.syncS3PassphraseField').toggleClass('displayNone', lan);
    template.find('.syncS3RetentionNote').toggleClass('displayNone', mode !== 'edit' || lan);
    field('Label').val(backend?.label || '');
    const regions = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1'];
    if (backend?.s3?.region && !regions.includes(backend.s3.region)) regions.push(backend.s3.region);
    for (const region of regions) field('Region').append($('<option></option>').val(region).text(region));
    for (const name of ['Endpoint', 'Region', 'Bucket', 'Prefix']) {
        field(name).val(backend?.s3?.[name[0].toLowerCase() + name.slice(1)] ?? (name === 'Region' ? 'us-east-1' : ''));
    }
    field('ForcePathStyle').prop('checked', backend?.s3?.forcePathStyle ?? true);
    field('StripIfMatchQuotes').prop('checked', backend?.s3?.stripIfMatchQuotes ?? false);
    if (mode === 'edit') field('Bucket').add(field('Prefix')).prop('readOnly', true);
    renderSyncCategories(field('CategoryGrid'), categories, backend?.categories);
    const clear = () => field('AccessKeyId').add(field('SecretAccessKey')).add(field('Passphrase')).val('');
    const popup = new Popup(template, POPUP_TYPE.TEXT, '', { okButton: t`Cancel`, wide: true, allowVerticalScrolling: true, onClosing: () => { clear(); return true; } });
    let saving = false;
    let disposed = false;
    let pendingSave = null;
    field('SaveButton').on('click', async () => {
        if (saving || disposed) return;
        const label = String(field('Label').val() || '').trim();
        const selected = field('CategoryGrid').find('input:checked').toArray().map(input => input.value);
        if (!unlock && (!label || !selected.length)) {
            field('Error').text(!label ? t`Enter a label for this backend.` : t`Select at least one category to sync.`).removeClass('displayNone');
            return;
        }
        const payload = unlock ? { passphrase: String(field('Passphrase').val() || '') } : { label, categories: selected };
        if (!lan && !unlock) {
            payload.s3 = {};
            for (const name of ['Endpoint', 'Region', 'Bucket', 'Prefix', 'AccessKeyId', 'SecretAccessKey']) {
                const value = String(field(name).val() || '');
                if (mode === 'add' || value || !['AccessKeyId', 'SecretAccessKey'].includes(name)) payload.s3[name[0].toLowerCase() + name.slice(1)] = value;
            }
            payload.s3.forcePathStyle = field('ForcePathStyle').prop('checked');
            payload.s3.stripIfMatchQuotes = field('StripIfMatchQuotes').prop('checked');
            if (mode === 'add' || field('Passphrase').val()) payload.passphrase = String(field('Passphrase').val() || '');
        }
        const base = '/api/sync/v1/backends';
        const url = mode === 'add' ? `${base}/s3` : `${base}/${encodeURIComponent(backendId)}${unlock ? '/unlock' : lan ? '' : '/s3'}`;
        saving = true;
        let settled;
        pendingSave = new Promise(resolve => { settled = resolve; });
        field('SaveButton').prop('disabled', true);
        field('Error').addClass('displayNone').text('');
        try {
            const response = await fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload) });
            const body = await response.json();
            if (!response.ok || body.ok === false) throw new Error(syncSettingsError(body.code));
            clear();
            if (!disposed) await popup.completeAffirmative();
            await onSaved?.(body);
        } catch (error) {
            if (!disposed) field('Error').text(String(error.message || error)).removeClass('displayNone');
        } finally {
            saving = false;
            field('SaveButton').prop('disabled', false);
            settled();
        }
    });
    try { await popup.show(); } finally {
        disposed = true;
        clear();
        template.find('*').off();
        // Closing disposes the UI immediately, but the caller owns backend
        // admission until the already-submitted operation has settled.
        await pendingSave;
    }
}
