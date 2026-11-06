/**
 * Sync data source of the Data window: backends, pairing, S3 settings,
 * the conflicts and notices sync left to decide, and the local device
 * settings. Fills the shared snapshot and drives the routes through the
 * helpers of `lan-sync.js`, `sync-s3.js` and `sync-status.js`.
 *
 * Status follows the cadence of `sync-status.js`, which reads it every
 * 30 seconds while the page is visible, every 5 seconds while a sync runs,
 * and at once when the page becomes visible again. Every status read
 * refreshes the backend list as well.
 */
import { getRequestHeaders } from '../script.js';
import { t, translate } from './i18n.js';
import {
    SYNC_ENDPOINTS,
    buildPairLink,
    claimBackendAction,
    describeSyncFailure,
    englishFallbackForCategory,
    getCurrentHandleForSync,
    loadAvailability,
    loadBackends,
    loadCategories,
    pairFailureMessage,
    pairLinkBaseUrls,
    parsePairLink as parseLanPairLink,
    pendingBackendActions,
    sanitizeHandleForPeerId,
    syncFailureReason,
    undoLastBackendSync,
} from './lan-sync.js';
import { backendSettingsUrl, postBackendSettings, s3SettingsPayload, syncSettingsError } from './sync-s3.js';
import { beginSyncActivity } from './sync-activity.js';
import {
    checkSyncStatusNow,
    conflictKey,
    createPreviewCache,
    dismissSyncNotice,
    invalidateSyncStatusReads,
    loadSyncPreview,
    noticeKey,
    openSyncNoticeTarget,
    readStatus,
    recordUnknown,
    reportingBackends,
    submitConflictChoices,
} from './sync-status.js';

/** Groups of the category picker; categories in none of them go to "Other". */
const CATEGORY_GROUPS = [
    [() => t`Characters & chats`, ['characters', 'chats', 'worlds', 'card-apps', 'skills']],
    [() => t`Presets`, ['openai-presets', 'novelai-presets', 'koboldai-presets', 'textgen-presets', 'instruct', 'context', 'sysprompt', 'reasoning']],
    [() => t`Appearance`, ['themes', 'movingUI', 'quickreplies', 'backgrounds', 'avatars']],
    [() => t`Files`, ['assets', 'user-files', 'comfy-workflows', 'user-images', 'image-metadata', 'vectors', 'stats']],
    [() => t`System`, ['settings', 'extensions', 'secrets']],
];

/**
 * Category of a synced path, by the user-directory layout of
 * `USER_DIRECTORY_TEMPLATE` in `src/constants.js` and the paths of
 * `src/sync/categories.js`. Longer prefixes come first.
 */
const PATH_CATEGORIES = [
    ['user/files/', 'user-files'],
    ['user/workflows/', 'comfy-workflows'],
    ['user/images/', 'user-images'],
    ['characters/', 'characters'],
    ['chats/', 'chats'],
    ['groups/', 'chats'],
    ['group chats/', 'chats'],
    ['worlds/', 'worlds'],
    ['card-apps/', 'card-apps'],
    ['skills/', 'skills'],
    ['OpenAI Settings/', 'openai-presets'],
    ['NovelAI Settings/', 'novelai-presets'],
    ['KoboldAI Settings/', 'koboldai-presets'],
    ['TextGen Settings/', 'textgen-presets'],
    ['instruct/', 'instruct'],
    ['context/', 'context'],
    ['sysprompt/', 'sysprompt'],
    ['reasoning/', 'reasoning'],
    ['themes/', 'themes'],
    ['movingUI/', 'movingUI'],
    ['QuickReplies/', 'quickreplies'],
    ['assets/', 'assets'],
    ['backgrounds/', 'backgrounds'],
    ['User Avatars/', 'avatars'],
    ['vectors/', 'vectors'],
    ['extensions/', 'extensions'],
    ['image-metadata.json', 'image-metadata'],
    ['stats.json', 'stats'],
    ['settings.json', 'settings'],
    ['secrets.json', 'secrets'],
];

const LOADING = Object.freeze({ kind: 'loading' });
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

// Module-level so they survive closing and reopening the window while a
// request is still in flight.
/** Start time of each sync this page started, by backend. */
const localRuns = new Map();
/** When a backend was first seen running, by backend. */
const runningSince = new Map();
/** `lastSync.at` of a backend when undo answered that there was nothing to undo. */
const nothingToUndoAt = new Map();

/**
 * @param {string} message User-facing message
 * @param {string} [code]
 * @param {object} [extra]
 * @returns {Error & { code?: string }}
 */
function fail(message, code, extra = {}) {
    return Object.assign(new Error(message), { code }, extra);
}

/**
 * POST or DELETE a sync route and parse its JSON answer. A body that is
 * not JSON reads as `{}`.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<{ response: Response, body: any }>}
 */
async function requestJson(url, init) {
    let response;
    try {
        response = await fetch(url, { headers: getRequestHeaders(), ...init });
    } catch (error) {
        console.error('[data-window] sync request failed', url, error);
        throw fail(t`Could not reach the server. Check the connection and retry.`, 'NETWORK');
    }
    const body = await response.json().catch(() => ({}));
    return { response, body: body && typeof body === 'object' ? body : {} };
}

/** @param {string} id Category id @param {object[]} [categories] */
function categoryLabel(id, categories) {
    const category = categories?.find(c => c.id === id);
    return translate(englishFallbackForCategory(id), category?.displayKey || `sync.category.${id}`);
}

/** @param {string} path Synced path */
function categoryOfPath(path) {
    return PATH_CATEGORIES.find(([prefix]) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))?.[1] ?? null;
}

/**
 * Category picker groups of the server's categories.
 * @param {object[]} categories From `/categories`
 * @returns {[string, [string, string, boolean][]][]}
 */
function groupCategories(categories) {
    const byId = new Map(categories.map(category => [category.id, category]));
    const item = category => [category.id, categoryLabel(category.id, categories), category.syncDefault !== 'on'];
    const grouped = new Set();
    const groups = [];
    for (const [name, ids] of CATEGORY_GROUPS) {
        const items = ids.filter(id => byId.has(id)).map(id => item(byId.get(id)));
        ids.forEach(id => grouped.add(id));
        if (items.length) groups.push([name(), items]);
    }
    const rest = categories.filter(category => !grouped.has(category.id)).map(item);
    if (rest.length) groups.push([t`Other`, rest]);
    return groups;
}

/**
 * Pending entries of a new status, keeping the evidence of earlier entries
 * whose reporting backends cannot be read now: a reporter that is unknown
 * stays a reporter, and an entry only such a reporter held stays listed.
 *
 * @param {Map<string, object>} prior Entries by key
 * @param {object[]} reported Entries of the status
 * @param {object} status
 * @param {(entry: object) => string} keyOf
 * @returns {Map<string, object>}
 */
function mergePending(prior, reported, status, keyOf) {
    const unreadable = id => Boolean(status.errors?.[id] || status.backends?.[id]?.pendingError);
    const priorByPath = new Map([...prior.values()].map(entry => [entry.path, entry]));
    const next = new Map();
    for (const entry of reported) {
        const unknownReporters = reportingBackends(priorByPath.get(entry.path)).filter(unreadable);
        const merged = unknownReporters.length ? { ...entry, backends: [...new Set([...reportingBackends(entry), ...unknownReporters])] } : entry;
        next.set(keyOf(merged), merged);
    }
    const listed = new Set([...next.values()].map(entry => entry.path));
    for (const [key, entry] of prior) {
        if (!listed.has(entry.path) && recordUnknown(entry, status)) next.set(key, entry);
    }
    return next;
}

/**
 * Create the sync source of the Data window.
 *
 * @param {object} state Shared snapshot, whose sync fields are updated in place
 * @param {() => void} emit Called after every change of the snapshot
 */
export function createSyncSource(state, emit) {
    let started = false;
    let ready = null;
    /** @type {object[] | null} */
    let categories = null;
    let availabilityChecked = false;
    /** Answer of `/backends`, with the newer `lastSync` and running state of each status merged in. */
    let registry = null;
    let pendingErrors = {};
    let status = null;
    let statusError = false;
    let conflicts = new Map();
    let notices = new Map();
    /** @type {string | null} */
    let handle = null;
    let previews = null;
    /** Preview of each version, by backend, oid and path. */
    let previewResults = new Map();
    let backendsSequence = 0;
    let backendsRefresh = null;
    let backendsAgain = false;
    /** The pending pairing the last link of this window created. */
    let lastPairing = null;

    const defaults = {
        available: true,
        unavailableReason: '',
        statusError: false,
        listError: false,
        device: { label: '', placeholder: '' },
        schedule: { idle: 0, poll: 0 },
        syncCategories: [],
        backends: [],
        conflicts: [],
        notices: [],
    };
    for (const [field, value] of Object.entries(defaults)) {
        if (!(field in state)) state[field] = value;
    }

    const find = id => state.backends.find(backend => backend.id === id);

    /** Image preview only: text versions are reviewed through the change tree. */
    function previewOf(backendId, oid, path) {
        if (oid === null || oid === undefined) return { kind: 'deleted' };
        if (!IMAGE_EXTENSIONS.some(ext => String(path).toLowerCase().endsWith(ext))) return null;
        const key = `${backendId}:${oid}:${path}`;
        if (previewResults.has(key)) return previewResults.get(key);
        if (!previews) return LOADING;
        const results = previewResults;
        results.set(key, LOADING);
        loadSyncPreview(previews, { backendId, oid, path })
            .catch(error => ({ kind: 'error', message: String(error?.message || error) }))
            .then(result => {
                // Stopped meanwhile: the cache, and any object URL, is gone.
                if (results !== previewResults || result === null) return;
                results.set(key, result);
                buildConflicts();
                emit();
            });
        return LOADING;
    }

    function buildConflicts() {
        state.conflicts = [...conflicts.entries()].map(([key, entry]) => {
            const category = categoryOfPath(entry.path);
            const titles = {
                ours: t`Version from ${entry.oursDevice}`,
                theirs: t`Version from ${entry.theirsDevice}`,
                current: t`Current version`,
            };
            const oids = { ours: entry.ours, theirs: entry.theirs, current: entry.current };
            // A version identical to another is labelled once on the parent
            // that carries the note; the current version never receives it.
            const sameAs = id => id === 'current' ? [] : ['ours', 'theirs']
                .filter(other => other !== id && oids[other] !== null && oids[other] === oids[id])
                .map(other => titles[other]);
            const version = (id, oid, from) => ({ id, from, inUse: oid === entry.kept, preview: previewOf(entry.backendId, oid, entry.path), sameAs: sameAs(id) });
            return {
                key,
                backendId: entry.backendId,
                path: entry.path,
                kind: category ? categoryLabel(category, categories) : t`File`,
                stale: Boolean(entry.stale),
                unknown: statusError || recordUnknown(entry, status),
                review: {
                    backendId: entry.backendId,
                    path: entry.path,
                    ours: entry.ours,
                    theirs: entry.theirs,
                    current: entry.current,
                    kept: entry.kept,
                    oursDevice: entry.oursDevice,
                    theirsDevice: entry.theirsDevice,
                    stale: Boolean(entry.stale),
                    recordVersions: { ...entry.recordVersions },
                    currentVersions: { ...entry.currentVersions },
                },
                versions: [
                    version('ours', entry.ours, entry.oursDevice),
                    version('theirs', entry.theirs, entry.theirsDevice),
                    { id: 'current', current: true, inUse: false, preview: previewOf(entry.backendId, entry.current, entry.path), sameAs: [] },
                ],
            };
        });
    }

    function buildNotices() {
        state.notices = [...notices.entries()].map(([id, notice]) => {
            const restored = notice.kind === 'restored';
            const name = notice.target?.name ?? '';
            let detail;
            if (restored) {
                detail = typeof notice.deletedBy === 'string'
                    ? t`${name} was deleted on ${notice.deletedBy} but kept on ${notice.device}, so it was restored.`
                    : t`${name} was deleted on one device but kept on ${notice.device}, so it was restored.`;
            } else {
                detail = t`${notice.chat} was edited on two devices. The version from ${notice.device} was saved as the branch chat ${name}.`;
            }
            return {
                id,
                path: notice.path,
                type: restored ? 'restored' : 'fork',
                title: restored ? t`Restored chat ${name}` : t`Chat ${notice.chat || name} branched`,
                detail,
                action: restored ? t`Open chat` : t`Open branch`,
                missingGroup: notice.target?.kind === 'group' && notice.target.groupId === null,
                unknown: statusError || recordUnknown(notice, status),
            };
        });
    }

    function buildBackends() {
        if (!registry) return;
        const now = Date.now();
        state.backends = Object.entries(registry.backends).map(([id, backend]) => {
            const lastSync = backend.lastSync ?? {};
            const running = Boolean(registry.running?.[id]) || localRuns.has(id);
            if (!running) runningSince.delete(id);
            else if (!runningSince.has(id)) runningSince.set(id, localRuns.get(id) ?? now);
            const pendingError = pendingErrors[id] ?? backend.pendingError ?? null;
            const label = backend.label || id;
            let backendState = 'ok';
            if (running) backendState = 'running';
            else if (pendingError) backendState = 'unknown';
            else if (lastSync.error) backendState = 'error';
            else if (backend.kind === 'lan' && !backend.lan?.peerBaseUrl && !lastSync.at) backendState = 'pending';
            let error = null;
            if (lastSync.error) error = syncFailureReason(lastSync.error.code, { error: lastSync.error.message }, backend.kind);
            else if (pendingError) error = t`Could not read pending sync records for ${label}.`;
            return {
                id,
                kind: backend.kind === 's3' ? 's3' : 'lan',
                label,
                state: backendState,
                lastSync: Number(lastSync.at) || 0,
                startedAt: running ? runningSince.get(id) : undefined,
                categories: Array.isArray(backend.categories) ? [...backend.categories] : [],
                canUndo: Boolean(lastSync.at) && nothingToUndoAt.get(id) !== lastSync.at,
                hasStoredCredentials: Boolean(backend.lan?.hasStoredCredentials),
                stalled: Array.isArray(lastSync.stalled) ? [...lastSync.stalled] : [],
                error,
            };
        });
        state.device = { ...state.device, label: registry.device?.label || '' };
        state.schedule = { idle: Number(registry.schedule?.idleSeconds) || 0, poll: Number(registry.schedule?.pollSeconds) || 0 };
    }

    /** Availability, categories and handle; read again until they load. */
    async function loadStatic() {
        if (!availabilityChecked) {
            const availability = await loadAvailability();
            if (!availability.available) {
                state.available = false;
                state.unavailableReason = availability.reason === 'unreachable'
                    ? t`Could not reach the server. Check the connection and retry.`
                    : t`LAN Sync is unavailable. The server reported: ${availability.reason || 'unknown reason'}.`;
                emit();
                return;
            }
            availabilityChecked = true;
        }
        if (!categories) {
            try {
                categories = await loadCategories();
            } catch (error) {
                state.available = false;
                state.unavailableReason = String(error?.message || error);
                emit();
                return;
            }
            state.available = true;
            state.unavailableReason = '';
            state.syncCategories = groupCategories(categories);
            buildConflicts();
            emit();
        }
        if (handle === null) handle = await getCurrentHandleForSync();
    }

    /** Read the backend list again. Overlapping calls coalesce into one more read. */
    function refreshBackends() {
        if (backendsRefresh) {
            backendsAgain = true;
            return backendsRefresh;
        }
        backendsRefresh = (async () => {
            do {
                backendsAgain = false;
                const sequence = ++backendsSequence;
                try {
                    const loaded = await loadBackends();
                    if (sequence !== backendsSequence || !started) continue;
                    registry = loaded;
                    state.listError = false;
                } catch (error) {
                    console.error('[data-window] sync backend refresh failed', error);
                    if (sequence === backendsSequence) state.listError = true;
                }
                buildBackends();
                emit();
            } while (backendsAgain && started);
        })().finally(() => { backendsRefresh = null; });
        return backendsRefresh;
    }

    function onStatus(event) {
        const latest = event.detail;
        status = latest;
        statusError = false;
        pendingErrors = latest.errors ?? {};
        if (registry) {
            for (const [id, backend] of Object.entries(registry.backends)) {
                if (latest.backends?.[id]) backend.lastSync = latest.backends[id].lastSync ?? backend.lastSync;
            }
            registry.running = Object.fromEntries(Object.entries(latest.backends ?? {}).map(([id, backend]) => [id, Boolean(backend.running)]));
        }
        conflicts = mergePending(conflicts, latest.conflicts, latest, conflictKey);
        notices = mergePending(notices, latest.notices, latest, noticeKey);
        state.statusError = false;
        buildBackends();
        buildConflicts();
        buildNotices();
        emit();
        if (!categories || !availabilityChecked) loadStatic().catch(error => console.error('[data-window] could not load sync settings', error));
        refreshBackends();
    }

    function onStatusFailure() {
        statusError = true;
        state.statusError = true;
        buildConflicts();
        buildNotices();
        emit();
    }

    function onActions() {
        refreshBackends();
    }

    /**
     * Run an action that holds the backend's lock, shared with every other
     * window that shows the backend.
     * @template T
     * @param {string} id
     * @param {() => Promise<T>} action
     * @returns {Promise<T>}
     */
    async function withBackendAction(id, action) {
        const release = claimBackendAction(id);
        if (!release) throw fail(t`Another action on this backend is still running. Try again when it finishes.`, 'BACKEND_BUSY');
        try {
            return await action();
        } finally {
            release();
        }
    }

    function requireBackend(id) {
        const backend = find(id);
        if (!backend) throw fail(t`This sync backend no longer exists.`, 'UNKNOWN_BACKEND');
        return backend;
    }

    return {
        /**
         * Start listening for status and load the sync settings. Resolves
         * once the first load finished.
         * @returns {Promise<void>}
         */
        start() {
            if (started) return ready;
            started = true;
            previews = createPreviewCache();
            previewResults = new Map();
            document.addEventListener('sync-status-updated', onStatus);
            document.addEventListener('sync-status-read-failed', onStatusFailure);
            document.addEventListener('sync-backend-actions-updated', onActions);
            ready = (async () => {
                await loadStatic();
                if (!started) return;
                await refreshBackends();
                await checkSyncStatusNow();
            })().catch(error => console.error('[data-window] could not load sync', error));
            return ready;
        },

        /** Stop listening and release the previews. */
        stop() {
            if (!started) return;
            started = false;
            document.removeEventListener('sync-status-updated', onStatus);
            document.removeEventListener('sync-status-read-failed', onStatusFailure);
            document.removeEventListener('sync-backend-actions-updated', onActions);
            previews?.revoke();
            previews = null;
            previewResults = new Map();
        },

        /** True while an action holds the lock of the backend, in any window. */
        isBusy(id) {
            return pendingBackendActions.has(id);
        },

        async syncNow(id) {
            const backend = requireBackend(id);
            return withBackendAction(id, async () => {
                const complete = beginSyncActivity({ backendId: id, label: backend.label });
                localRuns.set(id, Date.now());
                buildBackends();
                emit();
                let ok = false;
                let needsAttention = false;
                try {
                    const { response, body } = await requestJson(SYNC_ENDPOINTS.backendSync(id), { method: 'POST' });
                    ok = response.ok && body.ok === true && !body.lastSync?.error;
                    needsAttention = Number(body.pendingConflicts) > 0 || Number(body.conflicts) > 0 || Boolean(body.stalled?.length || body.lastSync?.stalled?.length);
                    if (!response.ok || !body.ok) {
                        throw fail(describeSyncFailure({ stage: 'sync', status: response.status, code: body.code, body, kind: backend.kind }), body.code);
                    }
                    return {
                        // A run that merged nothing can still leave conflicts pending that another run recorded.
                        conflicts: Math.max(Number(body.conflicts) || 0, Number(body.pendingConflicts) || 0),
                        stalled: Array.isArray(body.stalled) ? body.stalled.length : 0,
                    };
                } finally {
                    complete({ ok, needsAttention });
                    localRuns.delete(id);
                    await refreshBackends();
                    await checkSyncStatusNow();
                }
            });
        },

        async undo(id) {
            const backend = requireBackend(id);
            return withBackendAction(id, async () => {
                const at = registry?.backends?.[id]?.lastSync?.at;
                try {
                    const result = await undoLastBackendSync(id, backend.kind);
                    if (result.nothingToUndo) {
                        nothingToUndoAt.set(id, at);
                        throw fail(t`Nothing to undo — no prior sync recorded.`, 'NOTHING_TO_UNDO');
                    }
                    return { kept: result.keptEdited };
                } catch (error) {
                    if (!error?.code) console.error('[lan-sync] undo failed', { detail: String(error?.message || error) });
                    throw error;
                } finally {
                    await checkSyncStatusNow();
                    await refreshBackends();
                }
            });
        },

        async remove(id) {
            return withBackendAction(id, async () => {
                try {
                    const { response, body } = await requestJson(SYNC_ENDPOINTS.backend(id), { method: 'DELETE' });
                    if (!response.ok && response.status !== 204) {
                        throw fail(describeSyncFailure({ stage: 'forget', status: response.status, code: body.code, body }), body.code);
                    }
                    if (lastPairing?.id === id) lastPairing = null;
                } finally {
                    await refreshBackends();
                }
            });
        },

        async clearAuth(id) {
            return withBackendAction(id, async () => {
                try {
                    const { response, body } = await requestJson(SYNC_ENDPOINTS.backendAuth(id), { method: 'DELETE' });
                    if (!response.ok) throw fail(describeSyncFailure({ stage: 'clear-auth', status: response.status, code: body.code, body }), body.code);
                } finally {
                    await refreshBackends();
                }
            });
        },

        async saveDevice(label) {
            const { response, body } = await requestJson('/api/sync/v1/device', { method: 'POST', body: JSON.stringify({ label: String(label || '') }) });
            if (!response.ok || !body.device) throw fail(syncSettingsError(body.code), body.code);
            if (registry) registry.device = { ...registry.device, label: body.device.label };
            state.device = { label: body.device.label, placeholder: body.device.label ? state.device.placeholder : body.device.resolvedLabel || state.device.placeholder };
            emit();
            return body.device.label;
        },

        async saveSchedule(idle, poll) {
            const { response, body } = await requestJson(SYNC_ENDPOINTS.schedule, { method: 'POST', body: JSON.stringify({ idleSeconds: idle, pollSeconds: poll }) });
            if (!response.ok || !body.schedule) {
                throw fail(body.code === 'INVALID_SCHEDULE' ? t`Enter a positive number of seconds.` : String(body.error || `HTTP ${response.status}`), body.code);
            }
            if (registry) registry.schedule = { ...body.schedule };
            state.schedule = { idle: Number(body.schedule.idleSeconds) || 0, poll: Number(body.schedule.pollSeconds) || 0 };
            emit();
            return state.schedule;
        },

        async createPairLink({ label, categories: selected }) {
            const { response, body } = await requestJson(SYNC_ENDPOINTS.pairStart, { method: 'POST', body: JSON.stringify({ label, categories: selected }) });
            if (!response.ok || !body.peerId) {
                throw fail(describeSyncFailure({ stage: 'pair start', status: response.status, code: body.code, body }), body.code);
            }
            // A new link for the same device replaces the one before it, if
            // that one was never used.
            const previous = lastPairing;
            lastPairing = { id: body.peerId, label: body.label };
            if (previous && previous.label === body.label && find(previous.id)?.state === 'pending') {
                await requestJson(SYNC_ENDPOINTS.backend(previous.id), { method: 'DELETE' })
                    .catch(error => console.warn('[data-window] could not remove the replaced pairing', error));
            }
            await refreshBackends();
            const pairing = { peerId: body.peerId, label: body.label, categories: body.categories, pairCode: body.pairCode };
            return {
                addresses: pairLinkBaseUrls(body),
                link: address => buildPairLink({ ...pairing, peerBaseUrl: address }),
            };
        },

        parsePairLink(link) {
            const parsed = parseLanPairLink(link);
            if (!parsed) return null;
            const prefix = parsed.peerId.split('@')[0];
            // The link carries the sanitized handle; report the login handle
            // when it is the same account, so the window compares like for like.
            let linkHandle = '';
            if (handle !== null) linkHandle = sanitizeHandleForPeerId(handle) === prefix ? handle : prefix;
            const known = categories ? new Set(categories.map(category => category.id)) : null;
            return {
                url: parsed.peerBaseUrl,
                peerId: parsed.peerId,
                code: parsed.pairCode,
                handle: linkHandle,
                label: parsed.label,
                categories: known ? parsed.categories.filter(id => known.has(id)) : parsed.categories,
            };
        },

        currentHandle() {
            return handle ?? '';
        },

        async acceptPair({ url, peerId, code, label, user, pass, categories: selected }) {
            const remotePeerId = String(peerId || '').trim();
            const prefix = remotePeerId.split('@')[0];
            const localHandle = await getCurrentHandleForSync();
            if (localHandle !== null) {
                handle = localHandle;
                const expected = sanitizeHandleForPeerId(localHandle);
                if (expected !== prefix) {
                    throw fail(t`This pairing link is for ${prefix}, but you're logged in as ${expected}. Pair from the matching account, or use the same handle on both devices.`, 'HANDLE_MISMATCH');
                }
            }
            const username = String(user || '').trim();
            const password = String(pass || '');
            const payload = {
                peerBaseUrl: String(url || '').trim(),
                remotePeerId,
                label: String(label || '').trim(),
                categories: selected,
                pairCode: String(code || '').trim() || null,
                peerAuth: username && password ? { username, password } : null,
            };
            const { response, body } = await requestJson(SYNC_ENDPOINTS.pairAccept, { method: 'POST', body: JSON.stringify(payload) });
            if (response.ok && body.ok) {
                await refreshBackends();
                checkSyncStatusNow();
                return find(body.backendId) ?? { id: body.backendId, kind: 'lan', label: body.label || payload.label || remotePeerId, state: 'ok', lastSync: Date.now(), categories: selected, canUndo: true, hasStoredCredentials: Boolean(payload.peerAuth), stalled: [] };
            }
            // A `backendId` in a failed answer means the pairing was saved and
            // only the first sync failed.
            if (body.backendId) {
                const message = describeSyncFailure({ stage: 'first sync', status: response.status, code: body.code, message: syncFailureReason(body.code, body), body });
                await refreshBackends();
                await checkSyncStatusNow();
                throw fail(message, body.code, { paired: true, backendId: body.backendId });
            }
            throw fail(describeSyncFailure({ stage: body.stage || 'pair', status: response.status, code: body.code, message: pairFailureMessage(body), body }), body.code);
        },

        async saveS3(form, id) {
            const mode = id ? 'edit' : 'add';
            const payload = {
                label: String(form.label || '').trim(),
                categories: form.categories,
                ...s3SettingsPayload({
                    endpoint: form.endpoint,
                    region: form.region || 'us-east-1',
                    bucket: form.bucket,
                    prefix: form.prefix,
                    accessKeyId: form.accessKey,
                    secretAccessKey: form.secretKey,
                    forcePathStyle: Boolean(form.pathStyle),
                    stripIfMatchQuotes: Boolean(form.stripQuotes),
                    passphrase: form.passphrase,
                }, mode),
            };
            const save = () => postBackendSettings(backendSettingsUrl(mode, id), payload);
            try {
                if (id) await withBackendAction(id, save);
                else await save();
            } finally {
                await refreshBackends();
            }
        },

        getS3(id) {
            const s3 = registry?.backends?.[id]?.s3 ?? {};
            return {
                endpoint: s3.endpoint || '',
                region: s3.region || '',
                bucket: s3.bucket || '',
                prefix: s3.prefix || '',
                pathStyle: s3.forcePathStyle ?? false,
                stripQuotes: s3.stripIfMatchQuotes ?? false,
            };
        },

        async unlockS3(id, passphrase) {
            if (!passphrase) throw fail(t`Enter the passphrase.`, 'EMPTY');
            await withBackendAction(id, async () => {
                try {
                    await postBackendSettings(backendSettingsUrl('unlock', id), { passphrase });
                } finally {
                    await refreshBackends();
                }
            });
        },

        async editLan(id, { label, categories: selected }) {
            await withBackendAction(id, async () => {
                try {
                    await postBackendSettings(backendSettingsUrl('edit', id, true), { label, categories: selected });
                } finally {
                    await refreshBackends();
                }
            });
        },

        /**
         * Object URL of one recorded version for the diff image pair.
         * @param {string} backendId
         * @param {string | null} oid
         * @returns {Promise<string | null>}
         */
        async previewUrl(backendId, oid) {
            if (!previews || oid === null || oid === undefined) return null;
            return previews.url(backendId, oid);
        },

        /**
         * @param {Record<string, { version: 'ours'|'theirs'|'current', review: object }>} choices By conflict key
         * @returns {Promise<{ applied: string[], alreadyResolved: { key: string, path: string }[], failed: { key: string, path: string, reason: string }[] }>}
         */
        async applyConflicts(choices) {
            const picks = [];
            for (const [key, { version, review }] of Object.entries(choices)) {
                const entry = conflicts.get(key);
                const shown = state.conflicts.find(conflict => conflict.key === key);
                if (!entry || !shown || shown.unknown || !review) continue;
                picks.push({
                    key,
                    entry,
                    choice: {
                        path: entry.path,
                        choice: version,
                        review: {
                            backendId: review.backendId,
                            selectedOid: version === 'current' ? review.current : review[version],
                            recordVersions: { ...review.recordVersions },
                            currentVersions: { ...review.currentVersions },
                        },
                    },
                });
            }
            if (!picks.length) throw fail(t`Choose a version for at least one file.`, 'NO_CHOICES');
            invalidateSyncStatusReads();
            try {
                let submitted;
                try {
                    submitted = await submitConflictChoices(picks.map(pick => pick.choice));
                } catch (error) {
                    console.error('[sync] could not apply the conflict choices', error);
                    throw fail(t`Could not apply the choices: ${String(error?.message || error)}`, error?.code || 'APPLY_FAILED');
                }
                const { partialFailure, unapplied } = submitted;
                // A choice another device resolved first is no longer pending.
                const latest = unapplied.length > 0 || partialFailure ? await readStatus().catch(() => null) : null;
                const pendingPaths = latest ? new Set(latest.conflicts.map(entry => entry.path)) : null;
                const isPending = pick => !pendingPaths || recordUnknown(pick.entry, latest) || pendingPaths.has(pick.entry.path);
                const readFailed = Boolean(latest && (latest.ok === false || Object.keys(latest.errors ?? {}).length > 0));
                const result = { applied: [], alreadyResolved: [], failed: [] };
                for (const pick of picks) {
                    const path = pick.entry.path;
                    if ((partialFailure || readFailed) && recordUnknown(pick.entry, latest)) {
                        result.failed.push({ key: pick.key, path, reason: t`Some pending sync records could not be read.` });
                    } else if (unapplied.includes(path) && isPending(pick)) {
                        result.failed.push({ key: pick.key, path, reason: t`This choice could not be applied yet.` });
                    } else if (unapplied.includes(path)) {
                        result.alreadyResolved.push({ key: pick.key, path });
                    } else {
                        result.applied.push(pick.key);
                    }
                }
                for (const key of [...result.applied, ...result.alreadyResolved.map(item => item.key)]) conflicts.delete(key);
                buildConflicts();
                emit();
                return result;
            } finally {
                invalidateSyncStatusReads();
                checkSyncStatusNow();
            }
        },

        async dismissNotice(id) {
            const notice = notices.get(id);
            if (!notice) return;
            if (state.notices.find(item => item.id === id)?.unknown) {
                throw fail(t`Some notices could not be dismissed. Recover the affected backends and retry.`, 'NOTICE_UNKNOWN');
            }
            try {
                const { removed } = await dismissSyncNotice(notice);
                if (removed) notices.delete(id);
            } catch (error) {
                console.error('[sync] could not dismiss the notice', error);
                throw error;
            } finally {
                buildNotices();
                emit();
            }
        },

        async openNotice(id) {
            const notice = notices.get(id);
            if (!notice) throw fail(t`The chat could not be found.`, 'CHAT_MISSING');
            await openSyncNoticeTarget(notice);
        },
    };
}
