/**
 * Sync status: reads what sync left for the user to decide (pending file
 * conflicts, chat conflict branches and restored chats, files sync cannot
 * update) and opens the Data window on its conflicts page on page load
 * while anything is pending, and again when a status check finds something
 * not shown yet. Also holds the helpers that page uses to preview, resolve
 * and dismiss those items.
 */
import { characters, getCharacters, getRequestHeaders, openCharacterChat, selectCharacterById } from '../script.js';
import { eventSource, event_types } from './events.js';
import { getGroups, groups, openGroupById, openGroupChat, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { initializeSyncActivity } from './sync-activity.js';

const ENDPOINTS = {
    status: '/api/sync/v1/status',
    blob: (backendId, oid) => `/api/sync/v1/blob/${encodeURIComponent(backendId)}/${encodeURIComponent(oid)}`,
    resolve: '/api/sync/v1/conflicts/resolve',
    dismiss: '/api/sync/v1/notices/dismiss',
};

// The status call is local; the interval only bounds how fast the window
// opens for conflicts found by a background sync.
const STATUS_POLL_MS = 30_000;
const ACTIVE_STATUS_POLL_MS = 5000;
// A network switch rejects the request in flight; retry once after a pause
// so the read survives the switch instead of reporting a lost connection.
const STATUS_RETRY_DELAY_MS = 1000;
// Last authoritative answer to "does this account have sync backends", kept
// across loads so a failed read can stay quiet for an account without sync.
const CONFIGURED_STORAGE_KEY = 'syncConfigured';
let pollTimer = null;
let activityRunning = false;
let syncConfigured = globalThis.localStorage?.getItem(CONFIGURED_STORAGE_KEY) === 'true';

const TEXT_EXTENSIONS = ['.json', '.jsonl', '.txt', '.md', '.yaml', '.yml', '.css', '.js'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const shownKeys = new Set();
let statusReadFailed = false;
let checks = 0;
let statusVersion = 0;

/** Key of a pending conflict; a conflict recorded again gets a new key. */
export const conflictKey = entry => `c:${entry.path}:${entry.createdAt}`;
/** Key of a pending notice. */
export const noticeKey = notice => `n:${notice.path}`;

function pendingKeys(status) {
    return [
        ...status.conflicts.map(conflictKey),
        ...status.notices.map(noticeKey),
        ...Object.entries(status.backends ?? {}).flatMap(([id, b]) => (b.lastSync?.stalled ?? []).map(p => `s:${id}:${p}`)),
    ];
}

/**
 * Blobs and object URLs of one popup, by backend and oid, so cards that
 * show the same version share one download.
 */
export function createPreviewCache() {
    const blobs = new Map();
    const urls = new Map();
    let revoked = false;
    return {
        blob(backendId, oid) {
            const key = `${backendId}:${oid}`;
            if (!blobs.has(key)) {
                blobs.set(key, fetch(ENDPOINTS.blob(backendId, oid), { headers: getRequestHeaders() }).then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.blob();
                }));
            }
            return blobs.get(key);
        },
        async url(backendId, oid) {
            const key = `${backendId}:${oid}`;
            const blob = await this.blob(backendId, oid);
            // A download that finishes after the popup closed gets no URL, which nothing would revoke.
            if (revoked) return null;
            if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
            return urls.get(key);
        },
        revoke() {
            revoked = true;
            for (const url of urls.values()) URL.revokeObjectURL(url);
        },
    };
}

/**
 * Load one version of a conflicting file for preview. Text and image files
 * are told apart by the extension of the path.
 *
 * @param {ReturnType<typeof createPreviewCache>} previews
 * @param {{ backendId: string, oid: string | null, path: string }} version
 * @returns {Promise<{ kind: 'deleted' } | { kind: 'text', text: string } | { kind: 'image', url: string } | { kind: 'binary', bytes: number } | null>}
 * Null when the cache was revoked before an image finished downloading.
 */
export async function loadSyncPreview(previews, { backendId, oid, path }) {
    if (oid === null) return { kind: 'deleted' };
    const blob = await previews.blob(backendId, oid);
    const lower = path.toLowerCase();
    if (TEXT_EXTENSIONS.some(ext => lower.endsWith(ext))) return { kind: 'text', text: await blob.text() };
    if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
        const url = await previews.url(backendId, oid);
        return url === null ? null : { kind: 'image', url };
    }
    return { kind: 'binary', bytes: blob.size };
}

/** Mark a conflict row another device resolved and disable its choices. */

export function reportingBackends(entry) {
    return [...new Set([...(entry?.backends ?? []), ...Object.keys(entry?.recordVersions ?? {}), entry?.backendId].filter(Boolean))];
}

/** True when a backend that reports the entry has pending records that could not be read. */
export function recordUnknown(entry, status) {
    return !status || reportingBackends(entry).some(id => status.errors?.[id] || status.backends?.[id]?.pendingError);
}

async function findCharacterIndex(avatar) {
    const index = characters.findIndex(c => c.avatar === avatar);
    if (index >= 0) return index;
    // A character a sync brought in is not in the list loaded at page start.
    await getCharacters();
    return characters.findIndex(c => c.avatar === avatar);
}

/**
 * Open the chat a notice points at.
 *
 * @param {object} notice Pending notice of the status
 * @throws {Error & { code: string }} With a user-facing message when the chat or its group could not be found or opened
 */
export async function openSyncNoticeTarget(notice) {
    const { target } = notice;
    const restored = notice.kind === 'restored';
    const failure = (message, code) => Object.assign(new Error(message), { code });
    const missing = () => failure(restored ? t`The chat could not be found.` : t`The branch chat could not be found.`, 'CHAT_MISSING');
    if (target.kind === 'group') {
        if (target.groupId === null) throw failure(restored ? t`The group of this chat could not be found.` : t`The group of this branch chat could not be found.`, 'GROUP_MISSING');
        // The group list loaded at page start does not hold chats a sync added.
        await getGroups();
        const group = groups.find(g => g.id === target.groupId);
        if (!group || !group.chats.includes(target.name)) throw missing();
        // `openGroupChat` switches chats within the selected group only.
        if (selected_group !== target.groupId && !await openGroupById(target.groupId)) {
            throw failure(t`The group of this chat could not be opened.`, 'GROUP_OPEN_FAILED');
        }
        await openGroupChat(target.groupId, target.name);
        return;
    }
    const index = await findCharacterIndex(target.avatar);
    if (index < 0) throw missing();
    await selectCharacterById(index);
    await openCharacterChat(target.name);
}

/** @returns {Promise<boolean>} true when the chat was opened */

/**
 * Dismiss a notice, then read the status again to learn whether it is gone.
 * Status reads that started before are discarded.
 *
 * @param {object} notice Pending notice of the status
 * @returns {Promise<{ removed: boolean }>} `removed` is false when another backend still reports the notice
 * @throws {Error & { code?: string }} `NOTICE_UNKNOWN` when the records of a reporting backend could not be read
 */
export async function dismissSyncNotice(notice) {
    statusVersion += 1;
    try {
        const response = await fetch(ENDPOINTS.dismiss, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [notice.path] }),
        });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code });
        const result = body.results?.find(result => result.path === notice.path);
        const latest = await readStatus();
        const failed = code => Object.assign(new Error(t`Some notices could not be dismissed. Recover the affected backends and retry.`), { code });
        if (!latest || recordUnknown(notice, latest)) throw failed('NOTICE_UNKNOWN');
        if (latest.notices.some(entry => entry.path === notice.path)) {
            if (body.ok === false || !result?.applied) throw failed('NOTICE_NOT_DISMISSED');
            return { removed: false };
        }
        return { removed: true };
    } finally {
        statusVersion += 1;
    }
}

/**
 * Send conflict choices to the server.
 *
 * @param {{ path: string, choice: string, review: object }[]} choices
 * @returns {Promise<{ results: any[], partialFailure: boolean, unapplied: string[] }>} `unapplied` lists the paths whose choice was not applied
 */
export async function submitConflictChoices(choices) {
    const response = await fetch(ENDPOINTS.resolve, {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(choices),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code });
    const results = Array.isArray(body.results) ? body.results : [];
    const resultErrors = Object.assign({}, body.errors, ...results.map(result => result.errors));
    return {
        results,
        partialFailure: body.ok === false || Object.keys(resultErrors).length > 0,
        unapplied: results.filter(result => !result.applied).map(result => result.path),
    };
}

/** Discard status reads in flight, such as before and after a choice changes the pending records. */
export function invalidateSyncStatusReads() {
    statusVersion += 1;
}

function statusFailure() {
    console.error('[sync] status read failed');
    // Without backends there is no sync state to be uncertain about.
    if (!syncConfigured) return;
    document.dispatchEvent(new CustomEvent('sync-status-read-failed'));
    if (!statusReadFailed) toastr.error(t`Could not read sync status. Check the connection and retry.`, t`Sync`);
    statusReadFailed = true;
}

async function fetchStatus() {
    const response = await fetch(ENDPOINTS.status, { headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    if (!Array.isArray(status?.conflicts) || !Array.isArray(status?.notices) || ![status.backends, status.errors].every(value => value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error('Invalid sync status response');
    return status;
}

async function requestStatus(version) {
    let status;
    try {
        status = await fetchStatus();
    } catch (error) {
        // `fetch` rejects with a TypeError when the request never reached the
        // server. An answer with an error status or an invalid body is final.
        if (!(error instanceof TypeError) || version !== statusVersion) throw error;
        await new Promise(resolve => setTimeout(resolve, STATUS_RETRY_DELAY_MS));
        if (version !== statusVersion) return null;
        status = await fetchStatus();
    }
    const configured = Object.keys(status.backends).length > 0;
    if (configured !== syncConfigured) {
        syncConfigured = configured;
        globalThis.localStorage?.setItem(CONFIGURED_STORAGE_KEY, String(configured));
    }
    return status;
}

/**
 * Read the status and announce it with `sync-status-updated`.
 * Null denotes an invalidated response, never a failed read.
 * @returns {Promise<object | null>}
 */
export async function readStatus() {
    const version = ++statusVersion;
    try {
        const status = await requestStatus(version);
        if (!status || version !== statusVersion) return null;
        statusReadFailed = false;
        document.dispatchEvent(new CustomEvent('sync-status-updated', { detail: status }));
        return status;
    } catch (error) {
        if (version === statusVersion) statusFailure();
        throw error;
    }
}

/**
 * Read the pending sync state and open the Data window when it holds something
 * not shown yet, or anything at all with `showSeen`. A check finishes once
 * the window is on screen, without waiting for the user to close it.
 */
async function check({ showSeen = false } = {}) {
    const version = ++statusVersion;
    try {
        const status = await requestStatus(version);
        if (!status || version !== statusVersion) return;
        statusReadFailed = false;
        document.dispatchEvent(new CustomEvent('sync-status-updated', { detail: status }));
        for (const backendId of Object.keys(status.errors ?? {})) {
            toastr.error(t`Could not read pending sync records for ${backendId}.`, t`Sync`);
        }
        const keys = pendingKeys(status);
        const unseen = keys.some(key => !shownKeys.has(key));
        // An open Data window lists new items live, so they count as shown
        // without moving the user away from the page they are on.
        const windowOpen = isDataWindowOpen();
        if (keys.length > 0 && (showSeen || (unseen && !windowOpen))) {
            await showSyncIssues();
            for (const key of keys) shownKeys.add(key);
        } else if (windowOpen) {
            for (const key of keys) shownKeys.add(key);
        }
    } catch (error) {
        if (version === statusVersion) statusFailure();
    } finally {
        checks += 1;
        document.body.dataset.syncStatusChecks = String(checks);
    }
}

/** True while the Data window is on screen. */
function isDataWindowOpen() {
    return document.querySelector('dialog.dw-layer[open]') !== null;
}

/** Open the Data window on the page listing what sync left to decide. */
async function showSyncIssues() {
    try {
        const { openDataWindow } = await import('./data-window.js');
        openDataWindow({ tab: 'sync', view: 'conflicts' });
    } catch (error) {
        console.error('[sync] could not open the Data window', error);
    }
}

function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (document.visibilityState === 'visible') await check();
        schedulePoll();
    }, activityRunning ? ACTIVE_STATUS_POLL_MS : STATUS_POLL_MS);
}

document.addEventListener('sync-activity-updated', event => {
    if (activityRunning === event.detail.running) return;
    activityRunning = event.detail.running;
    if (pollTimer !== null) schedulePoll();
});

/**
 * @param {{ showSeen?: boolean }} [options] `showSeen` opens the window for
 * pending items the user already saw and closed.
 */
export function checkSyncStatusNow({ showSeen = false } = {}) {
    return check({ showSeen });
}

eventSource.on(event_types.APP_READY, async () => {
    initializeSyncActivity();
    await check({ showSeen: true });
    schedulePoll();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
});
