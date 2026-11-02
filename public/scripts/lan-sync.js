/**
 * Sync panel: LAN pairing, LAN/S3 backend settings, sync and undo,
 * device labels and the sync schedule.
 *
 * Reachable from User Settings → Account → Backup & Restore → Sync.
 * The panel itself is rendered into a `callGenericPopup` modal so it
 * lives alongside the existing User-Settings flows (Backup, Snapshots,
 * Admin) without competing for top-bar drawer space.
 *
 * Wire protocol details — none, that is the engine's concern. This
 * module only drives the routes of `src/endpoints/sync-backends.js`
 * (`/backends`, `/backends/:id/sync`, `/backends/:id/undo`, `/schedule`)
 * and the pairing routes of `src/endpoints/sync.js`. Conflicts a sync
 * leaves are decided in the sync popup of `sync-status.js`.
 *
 * SYNC_CATEGORIES is fetched lazily from `/api/sync/v1/categories`. The
 * list isn't bundled into the frontend so adding a category server-side
 * automatically appears in the UI on next panel open, with no rebuild.
 */
import { t, translate } from './i18n.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { checkSyncStatusNow } from './sync-status.js';
import { beginSyncActivity, syncActivityNeedsAttention } from './sync-activity.js';
import { openS3BackendForm, syncSettingsError } from './sync-s3.js';
import { renderTemplateAsync } from './templates.js';
import { copyText } from './utils.js';
import { getRequestHeaders } from '../script.js';

const ENDPOINTS = {
    backends: '/api/sync/v1/backends',
    backend: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}`,
    backendSync: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/sync`,
    backendUndo: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/undo`,
    backendAuth: (id) => `/api/sync/v1/backends/${encodeURIComponent(id)}/auth`,
    schedule: '/api/sync/v1/schedule',
    pairStart: '/api/sync/v1/pair/start',
    pairAccept: '/api/sync/v1/pair/accept',
    categories: '/api/sync/v1/categories',
    availability: '/api/sync/v1/availability',
};

/**
 * Pairing-link wire format. Carries the minimum needed for the consumer
 * to call `/pair/accept`. Versioned scheme so future fields can be
 * introduced without breaking existing clients.
 */
const PAIR_LINK_SCHEME = 'luker-sync';
const PAIR_LINK_VERSION = 'v1';
let openPanelPromise = null;
const pendingBackendActions = new Set();

function buildPairLink({ peerBaseUrl, peerId, label, categories, pairCode }) {
    const params = new URLSearchParams();
    params.set('base', peerBaseUrl);
    params.set('peer', peerId);
    params.set('label', label || '');
    params.set('cats', (categories || []).join(','));
    if (pairCode) {
        params.set('code', pairCode);
    }
    return `${PAIR_LINK_SCHEME}://pair/${PAIR_LINK_VERSION}?${params.toString()}`;
}

/**
 * Parse a pairing link previously built by `buildPairLink`. Returns null
 * on any malformed input; the caller falls back to manual-fields entry.
 * The function is intentionally lenient about scheme prefix so a user who
 * accidentally clipped the prefix can still paste the rest.
 */
function parsePairLink(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept both `luker-sync://pair/v1?...` and the bare query string.
    const queryIdx = trimmed.indexOf('?');
    if (queryIdx < 0) return null;
    const qs = trimmed.slice(queryIdx + 1);
    const params = new URLSearchParams(qs);
    const base = params.get('base');
    const peer = params.get('peer');
    if (!base || !peer) return null;
    return {
        peerBaseUrl: base,
        peerId: peer,
        label: params.get('label') || '',
        categories: (params.get('cats') || '').split(',').filter(Boolean),
        pairCode: params.get('code') || '',
    };
}

/**
 * True when a base URL points at this device's own loopback interface.
 * A link carrying a loopback base can never be reached by another device,
 * so the UI warns when the selected address is one of these.
 * @param {string} url Base URL
 * @returns {boolean} True for localhost / 127.0.0.1 / ::1
 */
function isLoopbackBaseUrl(url) {
    try {
        const hostname = new URL(String(url)).hostname.toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    } catch {
        return false;
    }
}

/**
 * Rebuild the generated pairing link from the address the user selected in
 * `.lanSyncBaseUrlSelect`, and show the loopback warning when that address
 * is not reachable from another device.
 * @param {JQuery} template Panel root
 * @param {{ peerId: string, label: string, categories: string[], pairCode?: string }|null} state Pair-start payload
 */
function renderGeneratedPairLink(template, state) {
    if (!state) return;
    const base = String(template.find('.lanSyncBaseUrlSelect').val() || '').trim();
    const link = buildPairLink({
        peerBaseUrl: base,
        peerId: state.peerId,
        label: state.label,
        categories: state.categories,
        pairCode: state.pairCode,
    });
    template.find('.lanSyncGeneratedLink').val(link);
    template.find('.lanSyncBaseUrlWarning').toggleClass('displayNone', !isLoopbackBaseUrl(base));
}

/**
 * Categories fetched once per panel open. Server-side `SYNC_CATEGORIES`
 * already speaks displayKey/descriptionKey i18n keys; we render directly
 * against them rather than maintaining a parallel UI registry.
 */
async function loadCategories() {
    try {
        const res = await fetch(ENDPOINTS.categories, { headers: getRequestHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body?.categories) || body.categories.some(category => typeof category?.id !== 'string' || typeof category.displayKey !== 'string')) throw new Error('Invalid category response');
        return body.categories;
    } catch {
        throw new Error(t`Could not load sync categories. Check the connection and reopen Sync.`);
    }
}

/**
 * The sync backends, which of them are syncing now, and the schedule.
 *
 * @returns {Promise<{ backends: Record<string, any>, running: Record<string, boolean>, schedule: { idleSeconds?: number, pollSeconds?: number } }>}
 */
async function loadBackends() {
    const res = await fetch(ENDPOINTS.backends, { headers: getRequestHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (![body?.backends, body?.running, body?.schedule, body?.device].every(value => value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error(t`Invalid sync backend response.`);
    return { backends: body.backends, running: body.running, schedule: body.schedule, device: body.device };
}

/**
 * Probe whether LAN Sync is available on this server. Returns the raw
 * `{available, reason?}` shape from `/availability`; today every storage
 * mode is supported and the route returns `{available: true}` — the
 * unreachable branch below covers the "server isn't responding" case so
 * the caller can render an honest error instead of crashing on a missing
 * field.
 */
async function loadAvailability() {
    try {
        const res = await fetch(ENDPOINTS.availability, { headers: getRequestHeaders() });
        if (!res.ok) return { available: false, reason: 'unreachable' };
        return await res.json();
    } catch {
        return { available: false, reason: 'unreachable' };
    }
}

/**
 * Fetch the logged-in user's handle for the pairing pre-flight check.
 * Returns the handle string, `''` if the call succeeded but the response
 * had no handle, or `null` if the request failed entirely — `null` lets
 * the caller fall through to the server-side gate rather than blocking
 * the user on a transient network error.
 *
 * @returns {Promise<string | null>}
 */
async function getCurrentHandleForSync() {
    try {
        const res = await fetch('/api/users/me', { headers: getRequestHeaders() });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        if (!body) return null;
        return String(body.handle || '');
    } catch {
        return null;
    }
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return t`Never`;
    const delta = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return t`just now`;
    if (minutes < 60) return t`${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t`${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return t`${days} day(s) ago`;
}

function renderCategoryGrid(container, categories, defaultSelected) {
    container.empty();
    for (const cat of categories) {
        const checked = defaultSelected
            ? defaultSelected.includes(cat.id)
            : cat.syncDefault === 'on';
        const label = $('<label class="checkbox_label lanSyncCategoryItem"></label>');
        const input = $('<input type="checkbox" name="lanSyncCategory">');
        input.val(cat.id);
        input.prop('checked', checked);
        // Show English-derived friendly text by default (id → Title Case);
        // data-i18n on the same node lets translate() swap it for the
        // localized string at attach time when zh-CN/zh-TW are active.
        // Without this, English users would see the raw i18n key
        // ("sync.category.characters") because there is no en.json file —
        // the fallback IS the data-i18n value.
        const span = $('<span></span>');
        span.attr('data-i18n', cat.displayKey);
        span.text(englishFallbackForCategory(cat.id));
        label.append(input).append(' ').append(span);
        container.append(label);
    }
}

function englishFallbackForCategory(id) {
    return String(id)
        .split('-')
        .map(w => w[0]?.toUpperCase() + w.slice(1))
        .join(' ');
}

function collectSelectedCategoryIds(container) {
    const ids = [];
    container.find('input[name="lanSyncCategory"]:checked').each(function () {
        ids.push(String($(this).val()));
    });
    return ids;
}

function showStatusBanner(template, kind, message) {
    const banner = template.find('.lanSyncStatusBanner');
    banner.removeClass('displayNone success warning error info');
    banner.addClass(kind);
    banner.text(message);
}

function clearStatusBanner(template) {
    const banner = template.find('.lanSyncStatusBanner');
    banner.addClass('displayNone');
    banner.text('');
}

/**
 * Translated message for a sync failure code, or null when the code has
 * none and the server's own message is shown.
 *
 * @param {string} code
 * @param {any} body Error body of the route
 * @returns {string | null}
 */
function syncErrorCodeMessage(code, body = {}) {
    switch (code) {
        case 'UNDO_NOT_COMMITTED':
        case 'PENDING_READ_FAILED':
        case 'AUTH_FAILED':
        case 'BUCKET_NOT_FOUND':
        case 'UNREACHABLE':
        case 'SYNC_DNS_ERROR':
        case 'S3_LOCAL_KEY_ID_INVALID':
        case 'S3_KEY_MISMATCH':
        case 'S3_STORED_KEY_INVALID':
        case 'S3_STORED_KEY_REJECTED':
            return syncSettingsError(code);
        case 'RECONCILE_FAILED':
            return t`The other device could not apply the synced changes.`;
        case 'PEER_PROTOCOL_OUTDATED':
            return t`The peer's Luker version is too old. Upgrade it and sync again.`;
        case 'PEER_CALLBACK_UNREACHABLE':
            return t`The other device cannot connect back to this device. Enable LAN listening and check the firewall, then use the same pairing link again.`;
        case 'SYNC_PRIVATE_ADDRESS':
            return t`Outbound sync to private addresses is disabled for this account. Ask an administrator to enable it.`;
        case 'PEER_FORGOTTEN':
            return t`The other device no longer knows this device. Forget it and pair again.`;
        case 'SYNC_BACKEND_MAINTENANCE':
            return t`The other device is updating its sync settings. Sync again after it finishes.`;
        case 'NO_BASE_URL':
            return t`This device does not know the other device's address yet. Sync once from the other device.`;
        case 'INVALID_BACKEND_ID':
            return t`This device was paired by an older Luker version. Forget it and pair again.`;
        case 'PEER_AUTH_FAILED':
        case 'PEER_AUTH_REQUIRED':
            return t`Authentication to the other device failed. Forget and re-pair if its credentials changed.`;
        case 'HANDLE_MISMATCH':
            return t`This pairing link is for ${String(body.gotHandle || '')}, but you're logged in as ${String(body.expectedHandle || '')}. Pair from the matching account, or use the same handle on both devices.`;
        case 'PEER_UNREACHABLE': {
            // A failed offer carries the network cause in `detail`; a failed
            // run carries it as the message.
            const cause = String((body.stage === 'offer' ? body.detail : body.detail || body.error) || '').trim();
            return cause ? t`Could not reach the other device (${cause}).` : t`Could not reach the other device.`;
        }
        default:
            return code?.startsWith('S3_') ? syncSettingsError(code) : null;
    }
}

/**
 * Report a sync failure to the user and to the logs.
 *
 * The browser console line lands in the frontend log buffer, which every
 * user's debug-log export includes, so a failure that never reaches a
 * banner still leaves a trace. The banner shows the reason inside the
 * panel, and the toast makes failures the user has to act on visible even
 * when the panel is not the active surface.
 *
 * `message` is the already-translated user-facing string; when absent,
 * `code` maps to a translated message when one is known, else the raw
 * `body.error` is shown. The log always carries the raw detail, so a
 * retry plus a debug-log export still names the real cause.
 */
function reportSyncError(template, { stage, status, code, message, body = {}, kind } = {}) {
    const shown = String(message || '').trim()
        || (code ? syncFailureReason(code, body, kind) : null)
        || String(body.error || '').trim()
        || `HTTP ${status || 0}`;
    const rawDetail = String(body.detail || body.error || '').trim();
    console.error(`[lan-sync] ${stage || 'sync'} failed`, {
        status,
        code,
        detail: rawDetail || undefined,
    });
    showStatusBanner(template, 'error', shown);
    toastr.error(shown, t`LAN Sync`);
}

/** The reason a failed sync shows, translated when its code is known. */
function syncFailureReason(code, body, kind) {
    return syncErrorCodeMessage(code, body) || (kind === 's3' ? syncSettingsError(code) : null)
        || String(body?.error || '').trim() || String(code || '');
}

function switchTab(template, tabName) {
    template.find('.lanSyncTabPanel').addClass('displayNone');
    template.find(`.lanSyncPanel${tabName}`).removeClass('displayNone');
    template.find('.lanSyncTab').removeClass('selected');
    template.find(`.lanSyncTab[data-tab="${kebabFromCamel(tabName)}"]`).addClass('selected');
}

function kebabFromCamel(s) {
    return s.replace(/[A-Z]/g, (m, i) => (i === 0 ? m.toLowerCase() : '-' + m.toLowerCase()));
}

function actionButton(className, icon, label) {
    const button = $('<div class="menu_button menu_button_icon"></div>').addClass(className);
    button.append($('<i class="fa-fw fa-solid"></i>').addClass(icon));
    button.append($('<span></span>').attr('data-i18n', label).text(translate(label)));
    return button;
}

function renderPeersList(template, state, handlers) {
    const list = template.find('.lanSyncPeersList');
    const empty = template.find('.lanSyncPeersEmpty');
    list.empty();
    const entries = Object.entries(state.backends);
    if (!entries.length) {
        empty.removeClass('displayNone');
        return;
    }
    empty.addClass('displayNone');
    for (const [backendId, backend] of entries) {
        const lastSync = backend.lastSync ?? {};
        const row = $('<div class="lanSyncPeerRow flex-container flexFlowColumn flexGap10"></div>');
        row.attr('data-backend-id', backendId).attr('data-kind', backend.kind);
        const title = $('<div class="lanSyncPeerTitle flex-container flexGap10"></div>');
        const label = $('<div class="lanSyncPeerLabel"></div>').text(backend.label || backendId);
        const meta = $('<div class="lanSyncPeerMeta menu_button_note"></div>')
            .text(t`Last sync: ${formatRelativeTime(lastSync.at)}`);
        if (state.running[backendId]) {
            meta.append(document.createTextNode(' · '), $('<span class="lanSyncPeerRunning"></span>').text(t`Syncing now`));
        }
        title.append(label).append($('<span class="syncBackendKind menu_button_note"></span>').text(backend.kind === 's3' ? 'S3' : 'LAN')).append(meta);

        const error = $('<div class="lanSyncPeerError menu_button_note"></div>');
        if (backend.pendingError) {
            error.text(t`Could not read pending sync records for ${backend.label || backendId}.`);
        } else if (lastSync.error) {
            error.text(t`Last sync failed: ${syncFailureReason(lastSync.error.code, { error: lastSync.error.message }, backend.kind)}`);
        } else {
            error.addClass('displayNone');
        }

        const stalled = $('<div class="lanSyncPeerStalled flex-container flexFlowColumn flexNoGap"></div>');
        if (Array.isArray(lastSync.stalled) && lastSync.stalled.length) {
            stalled.append($('<div class="menu_button_note"></div>').attr('data-i18n', 'Files sync cannot update').text(t`Files sync cannot update`));
            for (const relPath of lastSync.stalled) {
                stalled.append($('<div class="lanSyncPeerStalledPath"></div>').text(relPath));
            }
        } else {
            stalled.addClass('displayNone');
        }

        const actions = $('<div class="backupActionRow flex-container flexGap10"></div>');
        const pending = template.data('syncPendingActions')?.has(backendId) ?? false;
        actions.toggleClass('disabled', pending).attr('aria-busy', String(pending));
        const syncBtn = actionButton('lanSyncPeerSyncButton', 'fa-rotate', 'Sync now');
        const undoBtn = actionButton('lanSyncPeerUndoButton', 'fa-arrow-rotate-left', 'Undo last sync');
        const forgetBtn = actionButton('lanSyncPeerForgetButton', 'fa-trash', 'Remove');
        const editBtn = actionButton('syncBackendEditButton', 'fa-pen', 'Edit');
        actions.append(syncBtn, undoBtn, editBtn, forgetBtn);
        editBtn.on('click', () => handlers.onEdit(backendId, backend));
        if (backend.kind === 's3') {
            const unlockBtn = actionButton('syncBackendUnlockButton', 'fa-key', 'Unlock');
            unlockBtn.on('click', () => handlers.onUnlock(backendId, backend));
            actions.append(unlockBtn);
        }

        // "Clear credentials" only when the server reports stored ones —
        // showing it otherwise would be a dead button. The password itself
        // never leaves the disk through the backend list.
        if (backend.lan?.hasStoredCredentials) {
            const clearAuthBtn = actionButton('lanSyncPeerClearAuthButton', 'fa-key', 'Clear credentials');
            clearAuthBtn.on('click', () => handlers.onClearAuth(backendId, backend));
            actions.append(clearAuthBtn);
        }

        syncBtn.on('click', () => handlers.onSync(backendId, backend));
        undoBtn.on('click', () => handlers.onUndo(backendId, backend));
        forgetBtn.on('click', () => handlers.onForget(backendId, backend));

        row.append(title).append(error).append(stalled).append(actions);
        list.append(row);
    }
}

/**
 * Show the outcome of a sync the user started, from the answer of
 * `POST /backends/:id/sync` or of `/pair/accept`. Returns true on success.
 */
function showSyncResult(template, label, response, body) {
    if (!response.ok || !body.ok) return false;
    // A run that merged nothing can still leave conflicts pending that another run recorded.
    const undecided = Math.max(Number(body.conflicts) || 0, Number(body.pendingConflicts) || 0);
    const stalled = Array.isArray(body.stalled) && body.stalled.length > 0;
    if (undecided > 0 && stalled) {
        showStatusBanner(template, 'warning', t`Synced with ${label}. ${undecided} file(s) need a decision. Some files kept the version on this device.`);
    } else if (undecided > 0) {
        showStatusBanner(template, 'warning', t`Synced with ${label}. ${undecided} file(s) need a decision.`);
    } else if (stalled) {
        showStatusBanner(template, 'warning', t`Synced with ${label}. Some files kept the version on this device.`);
    } else {
        showStatusBanner(template, 'success', t`Synced with ${label}.`);
    }
    checkSyncStatusNow({ showSeen: undecided > 0 });
    return true;
}

/**
 * Sync an already-paired device now. The status or error is rendered into
 * the panel's status banner.
 */
async function runSyncNow(template, backendId, backend) {
    const label = backend.label || backendId;
    const complete = beginSyncActivity({ backendId, label });
    let ok = false;
    let needsAttention = false;
    clearStatusBanner(template);
    showStatusBanner(template, 'info', t`Syncing with ${label}…`);
    try {
        const res = await fetch(ENDPOINTS.backendSync(backendId), {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        const body = await res.json();
        ok = res.ok && body.ok === true && !body.lastSync?.error;
        needsAttention = Number(body.pendingConflicts) > 0 || Number(body.conflicts) > 0 || Boolean(body.stalled?.length || body.lastSync?.stalled?.length);
        if (showSyncResult(template, label, res, body)) return;
        reportSyncError(template, { stage: 'sync', status: res.status, code: body.code, body, kind: backend.kind });
    } catch (e) {
        reportSyncError(template, { stage: 'sync', message: String(e.message || e), body: { detail: e.stack || String(e.message || e) } });
    } finally {
        complete({ ok, needsAttention });
        // Success already requests an admitted status in showSyncResult.
        // Failures must also supersede pre-settlement reads.
        if (!ok) await checkSyncStatusNow();
    }
}

function renderSchedule(template, schedule) {
    template.find('.lanSyncIdleSeconds').val(schedule?.idleSeconds ?? '');
    template.find('.lanSyncPollSeconds').val(schedule?.pollSeconds ?? '');
}

async function saveSchedule(template) {
    const button = template.find('.lanSyncSaveScheduleButton');
    if (button.hasClass('disabled')) return;
    const idleSeconds = Number(template.find('.lanSyncIdleSeconds').val());
    const pollSeconds = Number(template.find('.lanSyncPollSeconds').val());
    const valid = v => Number.isFinite(v) && v > 0;
    if (!valid(idleSeconds) || !valid(pollSeconds)) {
        toastr.warning(t`Enter a positive number of seconds.`, t`LAN Sync`);
        return;
    }
    button.addClass('disabled');
    try {
        const res = await fetch(ENDPOINTS.schedule, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ idleSeconds, pollSeconds }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        renderSchedule(template, body.schedule);
        toastr.success(t`Schedule saved.`, t`LAN Sync`);
    } catch (e) {
        console.error('[lan-sync] schedule save failed', { detail: String(e.message || e) });
        toastr.error(String(e.message || e), t`LAN Sync`);
    } finally {
        button.removeClass('disabled');
    }
}

/**
 * Public entry: open the LAN Sync panel.
 */
export function openLanSyncPanel() {
    if (!openPanelPromise) openPanelPromise = showLanSyncPanel().finally(() => { openPanelPromise = null; });
    return openPanelPromise;
}

async function showLanSyncPanel() {
    const template = $(await renderTemplateAsync('userLanSync'));

    // Payload from the last `/pair/start`, kept so the address selector can
    // rebuild the link without re-minting the one-time pairing code.
    let pairNewState = null;

    // Availability check first — the route is kept as a stable forward-
    // compatible surface so the UI can branch on `available: false` if a
    // future blocker (read-only mount, missing git binary, etc.) needs to
    // be surfaced. There are no live blockers today.
    const availability = await loadAvailability();
    if (!availability.available) {
        const message = t`LAN Sync is unavailable. The server reported: ${availability.reason || 'unknown reason'}.`;
        template.find('.lanSyncUnavailableMessage').text(message);
        template.find('.lanSyncUnavailable').removeClass('displayNone');
        template.find('.lanSyncMain').addClass('displayNone');
        await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
        return;
    }

    const categories = await loadCategories();
    let state;
    try { state = await loadBackends(); } catch {
        throw new Error(t`Could not load sync backends. Check the connection and reopen Sync.`);
    }

    // Wire tabs.
    template.find('.lanSyncTab').on('click', function () {
        const tab = $(this).data('tab');
        const camel = tab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const pascal = camel[0].toUpperCase() + camel.slice(1);
        switchTab(template, pascal);
    });

    // Default tab.
    switchTab(template, Object.keys(state.backends).length ? 'Peers' : 'PairNew');

    renderCategoryGrid(template.find('.lanSyncCategoryGrid'), categories);
    renderCategoryGrid(template.find('.lanSyncAcceptCategoryGrid'), categories);
    renderSchedule(template, state.schedule);
    template.find('.lanSyncSaveScheduleButton').on('click', () => saveSchedule(template));
    template.find('.syncDeviceLabel').val(state.device?.label || '');
    template.find('.syncSaveDeviceLabelButton').on('click', async function () {
        if ($(this).prop('disabled')) return;
        $(this).prop('disabled', true);
        try {
            const response = await fetch('/api/sync/v1/device', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ label: String(template.find('.syncDeviceLabel').val() || '') }) });
            const body = await response.json();
            if (!response.ok) throw new Error(syncSettingsError(body.code));
            template.find('.syncDeviceLabel').val(body.device.label);
            template.find('.syncDeviceLabelResolved').text(t`Name for future edits: ${body.device.resolvedLabel}`);
            toastr.success(t`Device label saved.`, t`Sync`);
        } catch (error) { showStatusBanner(template, 'error', String(error.message || error)); } finally { $(this).prop('disabled', false); }
    });

    const handlers = {
        async onEdit(backendId, backend) {
            await openS3BackendForm({ mode: 'edit', backendId, backend, categories, onSaved: () => refreshPeers(template, handlers) });
        },
        async onUnlock(backendId, backend) {
            await openS3BackendForm({ mode: 'unlock', backendId, backend, categories, onSaved: () => refreshPeers(template, handlers) });
        },
        async onSync(backendId, backend) {
            await runSyncNow(template, backendId, backend);
            await refreshPeers(template, handlers);
        },
        async onUndo(backendId, backend) {
            clearStatusBanner(template);
            const label = backend.label || backendId;
            const confirm = await callGenericPopup(
                $('<div></div>').text(t`Undo the last sync with ${label}? Files that sync changed go back to their earlier versions on every device that syncs with this one. Files edited after it keep the newer edit.`),
                POPUP_TYPE.CONFIRM, '',
                { okButton: t`Undo`, cancelButton: t`Cancel` },
            );
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            showStatusBanner(template, 'info', t`Undo`);
            try {
                const res = await fetch(ENDPOINTS.backendUndo(backendId), {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });
                const body = await res.json().catch(() => ({}));
                if (res.status === 404 && body.code === 'NO_BACKUP_TAG') {
                    toastr.info(t`Nothing to undo — no prior sync recorded.`, t`LAN Sync`);
                    return;
                }
                if (!res.ok || body.ok === false || body.committed === false || body.propagation?.ok === false) {
                    const reason = syncFailureReason(body.code || body.propagation?.code, body, backend.kind);
                    const diagnostic = body.reconcile ? ` ${JSON.stringify(body.reconcile)}` : '';
                    throw new Error((reason || `HTTP ${res.status}`) + diagnostic);
                }
                const keptEdited = Array.isArray(body.keptEdited) ? body.keptEdited : [];
                if (keptEdited.length) {
                    const message = t`Reverted the last sync with ${label}. These files were edited after it and were left as they are: ${keptEdited.join(', ')}`;
                    showStatusBanner(template, 'warning', message);
                    toastr.warning(message, t`LAN Sync`);
                } else {
                    const message = t`Reverted the last sync with ${label}.`;
                    showStatusBanner(template, 'success', message);
                    toastr.success(message, t`LAN Sync`);
                }
                checkSyncStatusNow();
                await refreshPeers(template, handlers);
            } catch (e) {
                console.error('[lan-sync] undo failed', { detail: String(e.message || e) });
                showStatusBanner(template, 'error', String(e.message || e));
                toastr.error(String(e.message || e), t`Undo failed`);
                await checkSyncStatusNow();
                await refreshPeers(template, handlers);
            }
        },
        async onForget(backendId, backend) {
            const confirm = await callGenericPopup(
                $('<div></div>').text(t`Remove ${backend.label || backendId}? This removes its local sync configuration and history. The bucket and other devices are unaffected.`),
                POPUP_TYPE.CONFIRM, '',
                { okButton: t`Remove`, cancelButton: t`Cancel` },
            );
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            try {
                const res = await fetch(ENDPOINTS.backend(backendId), {
                    method: 'DELETE',
                    headers: getRequestHeaders(),
                });
                if (!res.ok && res.status !== 204) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `HTTP ${res.status}`);
                }
                toastr.success(t`Forgotten.`, t`LAN Sync`);
                await refreshPeers(template, handlers);
            } catch (e) {
                console.error('[lan-sync] forget failed', { detail: String(e.message || e) });
                toastr.error(String(e.message || e), t`Forget failed`);
            }
        },
        async onClearAuth(backendId, backend) {
            // No confirm popup — the action is non-destructive (re-pair
            // can reinstate credentials) and the button only appears
            // when credentials are actually stored. After success the
            // refreshed list no longer shows the button.
            try {
                const res = await fetch(ENDPOINTS.backendAuth(backendId), {
                    method: 'DELETE',
                    headers: getRequestHeaders(),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `HTTP ${res.status}`);
                }
                toastr.success(t`Credentials cleared.`, t`LAN Sync`);
                await refreshPeers(template, handlers);
            } catch (e) {
                console.error('[lan-sync] clear-auth failed', { detail: String(e.message || e) });
                toastr.error(String(e.message || e), t`Failed to clear credentials for ${backend.label || backendId}.`);
            }
        },
    };

    // Action admission outlives panel closure and disposable row nodes.
    const pendingActions = pendingBackendActions;
    template.data('syncPendingActions', pendingActions);
    for (const [name, handler] of Object.entries(handlers)) {
        handlers[name] = async (backendId, backend) => {
            if (pendingActions.has(backendId)) return;
            pendingActions.add(backendId);
            const render = () => renderPeersList(template, template.data('syncBackendState') ?? state, handlers);
            render();
            try { await handler(backendId, backend); } finally {
                pendingActions.delete(backendId);
                render();
                document.dispatchEvent(new CustomEvent('sync-backend-actions-updated'));
            }
        };
    }
    renderPeersList(template, state, handlers);
    const updateReview = () => {
        const hidden = !syncActivityNeedsAttention();
        template.find('.syncReviewIssuesButton').prop('hidden', hidden).toggleClass('displayNone', hidden);
    };
    updateReview();
    template.find('.syncReviewIssuesButton').on('click', () => checkSyncStatusNow({ showSeen: true }));
    const onActions = () => refreshPeers(template, handlers);
    template.find('.syncAddS3Button').on('click', () => openS3BackendForm({ mode: 'add', categories, onSaved: async () => {
        switchTab(template, 'Peers');
        await refreshPeers(template, handlers);
    } }));
    // Status is emitted only after sync-status's response-order barrier.
    const onStatus = event => {
        if (template.data('syncStatusReadFailed') && !template.data('syncBackendReadFailed')) clearStatusBanner(template);
        template.data('syncStatusReadFailed', false);
        template.data('syncPendingErrors', event.detail.errors ?? {});
        const current = template.data('syncBackendState');
        if (!current) return;
        for (const [id, backend] of Object.entries(current.backends)) {
            backend.pendingError = event.detail.errors?.[id] ?? null;
            if (event.detail.backends?.[id]) backend.lastSync = event.detail.backends[id].lastSync;
        }
        current.running = Object.fromEntries(Object.entries(event.detail.backends ?? {}).map(([id, backend]) => [id, backend.running]));
        renderPeersList(template, current, handlers);
    };
    const onStatusFailure = () => {
        template.data('syncStatusReadFailed', true);
        showStatusBanner(template, 'error', t`Could not read sync status. Check the connection and retry.`);
    };
    template.data('syncBackendState', state);
    document.addEventListener('sync-status-updated', onStatus);
    document.addEventListener('sync-status-read-failed', onStatusFailure);
    document.addEventListener('sync-activity-updated', updateReview);
    document.addEventListener('sync-backend-actions-updated', onActions);
    let closed = false;
    const poll = async () => {
        if (closed) return;
        if (document.visibilityState === 'visible') {
            await refreshPeers(template, handlers);
            await checkSyncStatusNow();
        }
        if (!closed) timer = setTimeout(poll, 5000);
    };
    let timer = setTimeout(poll, 5000);

    // ====== Pair new device tab ======

    template.find('.lanSyncGenerateLinkButton').on('click', async function () {
        const label = String(template.find('.lanSyncPairLabel').val() || '').trim();
        const cats = collectSelectedCategoryIds(template.find('.lanSyncCategoryGrid'));
        if (!label) {
            toastr.warning(t`Enter a label for the other device first.`, t`LAN Sync`);
            return;
        }
        if (!cats.length) {
            toastr.warning(t`Select at least one category to sync.`, t`LAN Sync`);
            return;
        }

        try {
            const res = await fetch(ENDPOINTS.pairStart, {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ label, categories: cats }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            const body = await res.json();
            pairNewState = {
                peerId: body.peerId,
                label: body.label,
                categories: body.categories,
                pairCode: body.pairCode,
            };
            // Offer every address a peer could use: the request-derived
            // origin first, then the reachable interface addresses the
            // server detected. Default to a non-loopback one when present,
            // so the shared link is usable without manual editing.
            const bases = [];
            for (const candidate of [body.peerBaseUrl, ...(Array.isArray(body.candidateBaseUrls) ? body.candidateBaseUrls : [])]) {
                const base = String(candidate || '').trim();
                if (base && !bases.includes(base)) bases.push(base);
            }
            const select = template.find('.lanSyncBaseUrlSelect');
            select.empty();
            for (const base of bases) {
                const suffix = isLoopbackBaseUrl(base) ? ` ${t`(this device only)`}` : '';
                select.append($('<option>').val(base).text(`${base}${suffix}`));
            }
            select.val(bases.find(base => !isLoopbackBaseUrl(base)) || bases[0] || '');
            renderGeneratedPairLink(template, pairNewState);
            template.find('.lanSyncPairNewResult').removeClass('displayNone');
            template.find('.lanSyncPairNewForm').addClass('displayNone');
            await refreshPeers(template, handlers);
        } catch (e) {
            toastr.error(String(e.message || e), t`Failed to generate pairing link`);
        }
    });

    template.find('.lanSyncBaseUrlSelect').on('change', function () {
        renderGeneratedPairLink(template, pairNewState);
    });

    template.find('.lanSyncCopyLinkButton').on('click', async function () {
        const link = String(template.find('.lanSyncGeneratedLink').val() || '').trim();
        if (!link) return;
        try {
            await copyText(link);
            toastr.success(t`Pairing link copied.`, t`LAN Sync`);
        } catch {
            toastr.info(t`Copy from the field above.`, t`LAN Sync`);
        }
    });

    template.find('.lanSyncNewLinkButton').on('click', function () {
        pairNewState = null;
        template.find('.lanSyncBaseUrlSelect').empty();
        template.find('.lanSyncBaseUrlWarning').addClass('displayNone');
        template.find('.lanSyncPairNewResult').addClass('displayNone');
        template.find('.lanSyncPairNewForm').removeClass('displayNone');
        template.find('.lanSyncGeneratedLink').val('');
    });

    // ====== Pair with existing device tab ======

    template.find('.lanSyncAcceptLink').on('input', function () {
        const raw = String($(this).val() || '').trim();
        const parsed = parsePairLink(raw);
        if (!parsed) return;
        template.find('.lanSyncAcceptBaseUrl').val(parsed.peerBaseUrl);
        template.find('.lanSyncAcceptPeerId').val(parsed.peerId);
        template.find('.lanSyncAcceptLabel').val(parsed.label || '');
        template.find('.lanSyncAcceptPairCode').val(parsed.pairCode || '');
        if (parsed.categories.length) {
            // Pre-check exactly the categories the other device wants.
            template.find('.lanSyncAcceptCategoryGrid input[name="lanSyncCategory"]').each(function () {
                const id = $(this).val();
                $(this).prop('checked', parsed.categories.includes(id));
            });
        }
    });

    template.find('.lanSyncAcceptButton').on('click', async function () {
        const peerBaseUrl = String(template.find('.lanSyncAcceptBaseUrl').val() || '').trim();
        const remotePeerId = String(template.find('.lanSyncAcceptPeerId').val() || '').trim();
        const label = String(template.find('.lanSyncAcceptLabel').val() || '').trim();
        const categories = collectSelectedCategoryIds(template.find('.lanSyncAcceptCategoryGrid'));
        const username = String(template.find('.lanSyncAcceptUsername').val() || '').trim();
        const password = String(template.find('.lanSyncAcceptPassword').val() || '');
        const pairCode = String(template.find('.lanSyncAcceptPairCode').val() || '').trim();

        if (!peerBaseUrl || !remotePeerId) {
            toastr.warning(t`Paste the pairing link or fill in the base URL and peer ID.`, t`LAN Sync`);
            return;
        }
        if (!categories.length) {
            toastr.warning(t`Select at least one category to sync.`, t`LAN Sync`);
            return;
        }

        try {
            await runPairAccept(template, {
                peerBaseUrl,
                remotePeerId,
                label,
                categories,
                pairCode: pairCode || null,
                peerAuth: (username && password) ? { username, password } : null,
            });
        } finally {
            template.find('.lanSyncAcceptPassword, .lanSyncAcceptUsername, .lanSyncAcceptPairCode').val('');
        }
        await refreshPeers(template, handlers);
    });

    try {
        await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onClosing: () => { template.find('input[type="password"], .lanSyncAcceptUsername, .lanSyncAcceptPairCode').val(''); return true; },
        });
    } finally {
        closed = true;
        clearTimeout(timer);
        document.removeEventListener('sync-status-updated', onStatus);
        document.removeEventListener('sync-status-read-failed', onStatusFailure);
        document.removeEventListener('sync-activity-updated', updateReview);
        document.removeEventListener('sync-backend-actions-updated', onActions);
        template.find('input[type="password"], .lanSyncAcceptUsername, .lanSyncAcceptPairCode').val('');
        template.find('*').off();
    }
}

async function refreshPeers(template, handlers) {
    try {
        const state = await loadBackends();
        for (const [id, backend] of Object.entries(state.backends)) backend.pendingError = template.data('syncPendingErrors')?.[id] ?? null;
        template.data('syncBackendState', state);
        renderPeersList(template, state, handlers);
        if (template.data('syncBackendReadFailed')) clearStatusBanner(template);
        template.data('syncBackendReadFailed', false);
    } catch (error) {
        console.error('[sync] backend refresh failed', error);
        template.data('syncBackendReadFailed', true);
        showStatusBanner(template, 'error', t`Could not refresh sync backends. The last loaded configuration is still displayed.`);
    }
}

/**
 * Message for a pairing that failed before it was saved, when it differs
 * from the one for a failed sync of a paired device.
 */
function pairFailureMessage(body) {
    if (body.code === 'PEER_AUTH_FAILED' || body.code === 'PEER_AUTH_REQUIRED') {
        return t`Authentication to the other device failed. Check your credentials.`;
    }
    if (body.code === 'PEER_UNREACHABLE') {
        const cause = String(body.detail || '').trim();
        return cause
            ? t`Could not reach the other device (${cause}). Check the base URL and that the device is online.`
            : t`Could not reach the other device. Check the base URL and that the device is online.`;
    }
    return null;
}

async function runPairAccept(template, payload) {
    clearStatusBanner(template);

    // Pre-flight handle check. The server enforces the same gate on
    // `/pair/accept`, but doing it here avoids even hitting the network
    // when the user is clearly logged in as the wrong account (e.g.
    // accepted a link minted for `alice` while logged in as `bob`).
    // The replacements MUST stay in sync with `sanitizeHandleForPeerId` in
    // `src/endpoints/sync.js` — both sides need to agree on the
    // sanitized form to compare correctly.
    const peerIdPrefix = String(payload.remotePeerId || '').split('@')[0];
    const localHandle = await getCurrentHandleForSync();
    if (localHandle !== null) {
        const expected = String(localHandle || 'peer').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(?=\.)/g, '_').replace(/^\./, '_');
        if (expected !== peerIdPrefix) {
            showStatusBanner(template, 'error',
                t`This pairing link is for ${peerIdPrefix}, but you're logged in as ${expected}. Pair from the matching account, or use the same handle on both devices.`);
            return;
        }
    }

    const label = payload.label || payload.remotePeerId;
    showStatusBanner(template, 'info', t`Syncing with ${label}…`);
    try {
        const res = await fetch(ENDPOINTS.pairAccept, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (showSyncResult(template, body.label || label, res, body)) {
            notifyCredentialsStored(payload);
            return;
        }
        // A `backendId` in a failed answer means the pairing was saved and
        // only the first sync failed.
        if (body.backendId) {
            const message = t`Paired with ${body.label || label}, but the first sync failed: ${syncFailureReason(body.code, body)}`;
            reportSyncError(template, { stage: 'first sync', status: res.status, code: body.code, message, body });
            notifyCredentialsStored(payload);
            return;
        }
        reportSyncError(template, { stage: body.stage || 'pair', status: res.status, code: body.code, message: pairFailureMessage(body), body });
    } catch (e) {
        reportSyncError(template, { stage: 'pair', message: String(e.message || e), body: { detail: e.stack || String(e.message || e) } });
    }
}

/**
 * Toast the "credentials saved" notice after a pairing that saved
 * basic-auth fields. The server persists them on the backend entry
 * (file mode 0600) so later syncs don't need them supplied again;
 * surfacing the "Clear credentials" affordance avoids the trap where a
 * user changes their other device's password and gets silent 401s on
 * every sync.
 *
 * No-op when the pair was credential-less, so the notice doesn't fire
 * for a pure-loopback / single-user setup.
 */
function notifyCredentialsStored(payload) {
    if (payload?.peerAuth?.username && payload?.peerAuth?.password) {
        toastr.info(
            t`Credentials saved for this peer. Use 'Clear credentials' on the peer card to remove them.`,
            t`LAN Sync`,
        );
    }
}
