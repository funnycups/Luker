import { getRequestHeaders } from '../script.js';
import {
    clearFrontendLogs,
    getFrontendLogsSnapshot,
    installFrontendLogCapture,
    isFrontendConsoleDebugLoggingEnabled,
} from './frontend-log-manager.js';
import { t } from './i18n.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { debounce } from './utils.js';
import { downloadFromServer } from './luker-download.js';
import { openDataWindow } from './data-window.js';
import { resetResourceReads } from './resource-read.js';

/**
 * @type {import('../../src/users.js').UserViewModel} Logged in user
 */
export let currentUser = null;
export let accountsEnabled = false;

// Extend the session every 10 minutes
const SESSION_EXTEND_INTERVAL = 10 * 60 * 1000;
export const BACKUP_CATEGORY_KEYS = Object.freeze([
    'settings',
    'secrets',
    'characters',
    'chats',
    'lorebooks',
    'presets',
    'assets',
    'extensions',
    'globalExtensions',
    'vectors',
]);
export const BACKUP_DEFAULT_SELECTION = Object.freeze({
    settings: true,
    secrets: true,
    characters: true,
    chats: true,
    lorebooks: true,
    presets: true,
    assets: true,
    extensions: true,
    globalExtensions: false,
    vectors: false,
});
const DEFAULT_LOG_VIEW_LIMIT = 300;
const MAX_LOG_VIEW_LIMIT = 5000;
const MAX_LOG_VIEW_CHARS = 250000;

function normalizeOptionalTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : null;
}

function normalizeLogQueryOptions(options = {}) {
    return {
        limit: Math.min(MAX_LOG_VIEW_LIMIT, Math.max(1, Math.floor(Number(options.limit) || DEFAULT_LOG_VIEW_LIMIT))),
        sinceId: Math.max(0, Math.floor(Number(options.sinceId) || 0)),
        startTime: normalizeOptionalTimestamp(options.startTime),
        endTime: normalizeOptionalTimestamp(options.endTime),
        searchTerm: String(options.searchTerm || '').trim(),
    };
}

function buildLogOutputWithinCharBudget(entries, formatter, options = {}) {
    const maxChars = options?.maxChars ?? MAX_LOG_VIEW_CHARS;
    const normalizedMaxChars = Math.max(1, Math.floor(Number(maxChars) || MAX_LOG_VIEW_CHARS));
    const normalizedSearchTerm = String(options?.searchTerm || '').trim().toLowerCase();
    const lines = [];
    let totalChars = 0;
    let matchedEntries = 0;
    let filteredEntries = 0;
    let hiddenEntries = 0;
    let oversizedEntries = 0;
    let budgetExceeded = false;

    for (let index = entries.length - 1; index >= 0; index--) {
        const line = String(formatter(entries[index]) || '');
        if (normalizedSearchTerm && !line.toLowerCase().includes(normalizedSearchTerm)) {
            filteredEntries += 1;
            continue;
        }

        matchedEntries += 1;

        if (line.length > normalizedMaxChars) {
            hiddenEntries += 1;
            oversizedEntries += 1;
            continue;
        }

        const additionalChars = line.length + (lines.length > 0 ? 1 : 0);
        if (budgetExceeded || totalChars + additionalChars > normalizedMaxChars) {
            hiddenEntries += 1;
            budgetExceeded = true;
            continue;
        }

        lines.push(line);
        totalChars += additionalChars;
    }

    lines.reverse();

    return {
        text: lines.join('\n'),
        totalEntries: entries.length,
        matchedEntries,
        filteredEntries,
        visibleEntries: lines.length,
        hiddenEntries,
        oversizedEntries,
        totalChars,
        searchTerm: normalizedSearchTerm,
    };
}

function parseLogTimeInputValue(value, { roundUpMinute = false } = {}) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
        return null;
    }

    const timestamp = new Date(normalizedValue).getTime();
    if (!Number.isFinite(timestamp)) {
        return null;
    }

    if (roundUpMinute && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalizedValue)) {
        return timestamp + 59_999;
    }

    return timestamp;
}

/**
 * Enable or disable user account controls in the UI.
 * @param {boolean} isEnabled User account controls enabled
 * @returns {Promise<void>}
 */
export async function setUserControls(isEnabled) {
    accountsEnabled = isEnabled;
    installFrontendLogCapture();

    if (!isEnabled) {
        $('#logout_button').hide();
        $('#admin_button').show();
        $('#server_logs_button').show();
        return;
    }

    $('#logout_button').show();
    await getCurrentUser();
}

/**
 * Check if the current user is an admin.
 * @returns {boolean} True if the current user is an admin
 */
export function isAdmin() {
    if (!accountsEnabled) {
        return true;
    }

    if (!currentUser) {
        return false;
    }

    return Boolean(currentUser.admin);
}

/**
 * Gets the handle string of the current user.
 * @returns {string} User handle
 */
export function getCurrentUserHandle() {
    return currentUser?.handle || 'default-user';
}

/**
 * Get the current user.
 * @returns {Promise<void>}
 */
export async function getCurrentUser() {
    try {
        const response = await fetch('/api/users/me', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to get current user');
        }

        const nextUser = await response.json();
        if (currentUser?.handle && currentUser.handle !== nextUser?.handle) {
            resetResourceReads();
        }
        currentUser = nextUser;
        $('#admin_button').toggle(isAdmin());
        $('#server_logs_button').show();
    } catch (error) {
        console.error('Error getting current user:', error);
    }
}

/**
 * Map a config-validation error code returned by the server to a localized message.
 * Codes are defined in src/endpoints/users-admin.js#validateConfigSafety.
 * @param {string} code Machine-readable error code
 * @returns {string|null} Localized message, or null if the code is unknown
 */
export function getConfigValidationMessage(code) {
    switch (code) {
        case 'CONFIG_UNSAFE_NO_AUTH':
            return t`Cannot save: with "listen" on, you must enable one of whitelistMode, basicAuthMode, or enableUserAccounts (or set securityOverride: true). Otherwise the server will refuse to start.`;
        case 'CONFIG_UNSAFE_NO_PROTOCOL':
            return t`Cannot save: at least one of protocol.ipv4 or protocol.ipv6 must be enabled (or set to "auto"). Otherwise the server will refuse to start.`;
        default:
            return null;
    }
}

function localizeConfigValidationCodes(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return '';
    return codes.map(getConfigValidationMessage).filter(Boolean).join('\n');
}

export function clientBackupTimestamp() {
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * Streams a user's backup ZIP from the server into a download.
 * @param {string} handle Handle of the user to backup
 * @param {Record<string, boolean>} selection Backup category selection
 * @param {object} [options]
 * @param {(progress: { loaded: number, total: number }) => void} [options.onProgress] Download progress; total is 0 when unknown
 * @returns {Promise<{ fileName: string, size: number }>} Saved file name and byte count (0 when the Android bridge saves it)
 */
export async function downloadUserBackup(handle, selection, { onProgress = null } = {}) {
    const fileName = `${handle}-${clientBackupTimestamp()}.zip`;
    const result = await downloadFromServer({
        url: '/api/users/backup',
        fileName,
        mimeType: 'application/zip',
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ handle, selection }),
        onProgress,
    });
    return { fileName, size: Number(result?.size || 0) };
}

export async function restoreUserData(uploadId, handle, selection, mode, callback, { onPhaseProgress = null, scratchCreds = null } = {}) {
    const payload = { uploadId, handle, mode, selection };
    if (scratchCreds?.mysqlUrl) payload.scratchMysqlUrl = scratchCreds.mysqlUrl;
    if (scratchCreds?.postgresUrl) payload.scratchPostgresUrl = scratchCreds.postgresUrl;
    if (scratchCreds?.mysqlPoolSize != null) payload.scratchMysqlPoolSize = scratchCreds.mysqlPoolSize;
    if (scratchCreds?.postgresPoolSize != null) payload.scratchPostgresPoolSize = scratchCreds.postgresPoolSize;

    const stream = createRestoreProgressStream(onPhaseProgress);
    const response = await fetch('/api/users/restore-backup', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Accept': 'application/x-ndjson, application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err = new Error(data?.error || `Failed to restore backup (${response.status})`);
        // Forward the structured cross-mode payloads on the error so the UI
        // can drive the scratch-creds prompt without parsing the message.
        if (data?.crossModeScratchRequired) err.crossModeScratchRequired = data.crossModeScratchRequired;
        if (data?.crossModeScratchConnection) err.crossModeScratchConnection = data.crossModeScratchConnection;
        if (data?.crossModeFailure) err.crossModeFailure = data.crossModeFailure;
        throw err;
    }

    const contentType = String(response.headers.get('content-type') || '');
    let finalText = '';
    if (response.body && contentType.includes('application/x-ndjson')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stream.onChunk(decoder.decode(value, { stream: true }));
        }
    } else {
        finalText = await response.text();
    }
    stream.finish(finalText);

    if (stream.streamed) {
        if (stream.error) {
            throw new Error(stream.error);
        }
        if (!stream.result) {
            throw new Error('Restore stream ended without a result.');
        }
        callback?.(stream.result);
        return stream.result;
    }

    const data = finalText ? JSON.parse(finalText) : {};
    callback?.(data);
    return data;
}

/**
 * Peek at a backup ZIP to find out whether the current server can restore it
 * directly (same-mode) or needs the cross-mode conversion pipeline — and, if
 * the source engine is mysql/postgres, whether the UI must prompt the user
 * for a scratch DB connection string before submitting.
 *
 * Returns `{ engineKind, schemaVersion, sourceHandle, crossModeRequired,
 * scratchCredsNeeded }` from POST /api/users/restore-backup/probe.
 */
export async function probeBackupArchive(uploadId) {
    const response = await fetch('/api/users/restore-backup/probe', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ uploadId }),
    });
    if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(`Probe failed (${response.status}): ${txt}`);
    }
    return await response.json();
}

/**
 * @param {((event: any) => void)|null} onPhaseProgress
 */
function createRestoreProgressStream(onPhaseProgress) {
    let buffer = '';
    const state = { streamed: false, result: null, error: null };
    const dispatch = typeof onPhaseProgress === 'function' ? onPhaseProgress : null;
    const consumeLine = (raw) => {
        const line = raw.trim();
        if (!line || line[0] !== '{') {
            return;
        }
        let payload;
        try {
            payload = JSON.parse(line);
        } catch {
            return;
        }
        state.streamed = true;
        if (payload.type === 'progress' && dispatch) {
            try { dispatch(payload); } catch { /* observer errors must not abort */ }
        } else if (payload.type === 'result') {
            const { type: _type, ...rest } = payload;
            state.result = rest;
        } else if (payload.type === 'error') {
            state.error = String(payload.error || 'Restore failed');
        }
    };
    const drain = (text) => {
        if (typeof text !== 'string' || !text) {
            return;
        }
        buffer += text;
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            consumeLine(raw);
            idx = buffer.indexOf('\n');
        }
    };
    return {
        onChunk: drain,
        finish(finalText) {
            if (typeof finalText === 'string' && finalText.length > 0 && !state.streamed) {
                // Server did not stream — caller will parse the response as a single JSON document.
                return;
            }
            if (buffer) {
                consumeLine(buffer);
                buffer = '';
            }
        },
        get streamed() { return state.streamed; },
        get result() { return state.result; },
        get error() { return state.error; },
    };
}

export async function createLanMigrationLink(handle, selection) {
    const response = await fetch('/api/users/lan-migration/offer', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ handle, selection }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create migration link');
    }

    return response.json();
}

export function isLocalOnlyHostName(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

export async function importLanMigrationLink(handle, url, selection, mode, callback, { onPhaseProgress = null } = {}) {
    const response = await fetch('/api/users/lan-migration/import', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Accept': 'application/x-ndjson, application/json' },
        body: JSON.stringify({
            handle,
            url,
            selection,
            mode,
        }),
    });

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/x-ndjson') && response.body) {
        const stream = createRestoreProgressStream(onPhaseProgress);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (; ;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            stream.onChunk(decoder.decode(value, { stream: true }));
        }
        stream.onChunk(decoder.decode());
        stream.finish('');
        if (stream.error) {
            throw new Error(stream.error);
        }
        if (!stream.result) {
            throw new Error('LAN migration stream ended without a result.');
        }
        callback?.(stream.result);
        return stream.result;
    }

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to import migration link');
    }

    const data = await response.json();
    callback?.(data);
    return data;
}

export function buildRestoreDiagnosticReport({ handle, file, mode, selection, result }) {
    return {
        timestamp: new Date().toISOString(),
        handle: String(handle || ''),
        mode: String(mode || 'merge'),
        file: {
            name: String(file?.name || ''),
            size: Number(file?.size || 0),
            type: String(file?.type || ''),
        },
        selection: selection || {},
        result: {
            restoredCount: Number(result?.restoredCount || 0),
            skippedCount: Number(result?.skippedCount || 0),
            rejectedCount: Number(result?.rejectedCount || 0),
            failedCount: Number(result?.failedCount || 0),
            preflight: result?.preflight || {},
        },
    };
}

async function fetchServerLogs(options = {}) {
    const { limit, sinceId, startTime, endTime, searchTerm } = normalizeLogQueryOptions(options);
    const response = await fetch('/api/users/logs/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ limit, sinceId, startTime, endTime, searchTerm }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch server logs');
    }

    return response.json();
}

async function clearServerLogsRemote() {
    const response = await fetch('/api/users/logs/clear', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to clear server logs');
    }
}

function formatServerLogEntry(entry) {
    const date = new Date(Number(entry?.timestamp) || Date.now());
    const level = String(entry?.level || 'log').toUpperCase();
    const message = String(entry?.message || '');
    return `[${date.toLocaleString()}] [${level}] ${message}`;
}

function formatFrontendLogEntry(entry) {
    const date = new Date(Number(entry?.timestamp) || Date.now());
    const level = String(entry?.level || 'log').toUpperCase();
    const source = String(entry?.source || 'console');
    const message = String(entry?.message || '');
    return `[${date.toLocaleString()}] [${level}] [${source}] ${message}`;
}

async function openLogsViewer() {
    installFrontendLogCapture();
    const canViewServerLogs = !accountsEnabled || isAdmin();
    const template = $(`
        <div class="userBackupManager flex-container flexFlowColumn flexNoGap">
            <h3 class="marginBot5">${t`Logs`}</h3>
            <div class="backupActionRow flex-container flexGap10 marginBot10">
                <label class="checkbox_label backupRestoreModeLabel logSourceLabel">
                    <span>${t`Log source`}</span>
                    <select class="serverLogsSource text_pole">
                        ${canViewServerLogs ? `<option value="server">${t`Server`}</option>` : ''}
                        <option value="frontend">${t`Frontend`}</option>
                    </select>
                </label>
                <label class="checkbox_label backupRestoreModeLabel logFilterLabel">
                    <span>${t`Start time`}</span>
                    <input type="datetime-local" class="serverLogsStartTime text_pole" step="60">
                </label>
                <label class="checkbox_label backupRestoreModeLabel logFilterLabel">
                    <span>${t`End time`}</span>
                    <input type="datetime-local" class="serverLogsEndTime text_pole" step="60">
                </label>
                <label class="checkbox_label backupRestoreModeLabel logFilterLabel">
                    <span>${t`Max entries`}</span>
                    <input type="number" class="serverLogsLimit text_pole" min="1" max="${MAX_LOG_VIEW_LIMIT}" step="50" value="${DEFAULT_LOG_VIEW_LIMIT}">
                </label>
            </div>
            <div class="backupActionRow flex-container flexGap10 marginBot10">
                <div class="serverLogsRefreshButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-rotate"></i>
                    <span>${t`Refresh`}</span>
                </div>
                <div class="serverLogsCopyButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-copy"></i>
                    <span>${t`Copy`}</span>
                </div>
                <div class="serverLogsClearButton menu_button menu_button_icon">
                    <i class="fa-fw fa-solid fa-trash"></i>
                    <span>${t`Clear`}</span>
                </div>
                <label class="checkbox_label backupRestoreModeLabel">
                    <input type="checkbox" class="serverLogsAutoRefresh" checked>
                    <span>${t`Auto refresh`}</span>
                </label>
            </div>
            <div class="backupActionRow flex-container flexGap10 marginBot10">
                <label class="checkbox_label backupRestoreModeLabel logFilterLabel wide100p">
                    <span>${t`Search`}</span>
                    <input type="search" class="serverLogsSearch text_pole" placeholder="${t`Search loaded logs`}">
                </label>
            </div>
            <textarea class="text_pole serverLogsOutput" rows="20" readonly></textarea>
            <div class="menu_button_note serverLogsNote"></div>
            <div class="menu_button_note serverLogsStatus"></div>
        </div>
    `);

    const output = template.find('.serverLogsOutput');
    const autoRefresh = template.find('.serverLogsAutoRefresh');
    const sourceSelect = template.find('.serverLogsSource');
    const startTimeInput = template.find('.serverLogsStartTime');
    const endTimeInput = template.find('.serverLogsEndTime');
    const limitInput = template.find('.serverLogsLimit');
    const searchInput = template.find('.serverLogsSearch');
    const noteElement = template.find('.serverLogsNote');
    const statusElement = template.find('.serverLogsStatus');
    let latestServerId = 0;
    let latestFrontendId = 0;
    let renderedServerEntries = [];
    let renderedFrontendEntries = [];
    let currentSearchTerm = '';
    let closed = false;
    let inFlight = false;
    let reloadQueued = false;
    let currentSource = canViewServerLogs ? 'server' : 'frontend';
    sourceSelect.val(currentSource);

    const updateNote = () => {
        if (currentSource === 'server') {
            noteElement.text(t`This viewer shows runtime backend logs captured in memory.`);
            return;
        }

        noteElement.text(isFrontendConsoleDebugLoggingEnabled()
            ? t`This viewer shows frontend console logs captured in this app session.`
            : t`Frontend debug logs are off. Console output of every level is still recorded here; turn the switch on in User Settings to also record API request logs and echo routine output to the browser console.`);
    };

    const isBackendSearchActive = () => currentSource === 'server' && currentSearchTerm.length > 0;

    const updateSearchPlaceholder = () => {
        const placeholder = currentSource === 'server' ? t`Search server logs` : t`Search loaded logs`;
        searchInput.attr('placeholder', placeholder);
    };

    const updateStatus = (summary = null) => {
        if (!summary) {
            statusElement.text(t`Showing the newest complete log entries that fit within a ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget.`);
            return;
        }

        if (summary.totalEntries === 0) {
            statusElement.text(t`No logs matched the current filters.`);
            return;
        }

        if (summary.searchTerm && summary.matchedEntries === 0) {
            statusElement.text(isBackendSearchActive() ? t`No logs matched the current search.` : t`No loaded logs matched the current search.`);
            return;
        }

        if (summary.visibleEntries === 0) {
            statusElement.text(t`Matching logs exceeded the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget. Narrow the filters to inspect them safely.`);
            return;
        }

        const matchingEntries = summary.searchTerm ? summary.matchedEntries : summary.totalEntries;

        if (summary.hiddenEntries > 0) {
            statusElement.text(summary.searchTerm
                ? (isBackendSearchActive()
                    ? t`Showing ${summary.visibleEntries} of ${matchingEntries} matching entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget. ${summary.hiddenEntries} additional matching entries are hidden.`
                    : t`Showing ${summary.visibleEntries} of ${matchingEntries} matching loaded entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget. ${summary.hiddenEntries} additional matching entries are hidden.`)
                : t`Showing ${summary.visibleEntries} complete entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget. ${summary.hiddenEntries} additional entries are hidden.`);
            return;
        }

        statusElement.text(summary.searchTerm
            ? (isBackendSearchActive()
                ? t`Showing ${summary.visibleEntries} matching entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget.`
                : t`Showing ${summary.visibleEntries} matching loaded entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget.`)
            : t`Showing ${summary.visibleEntries} complete entries within the ${MAX_LOG_VIEW_CHARS.toLocaleString()} character display budget.`);
    };

    const renderOutput = (entries, formatter) => {
        const summary = buildLogOutputWithinCharBudget(entries, formatter, { searchTerm: currentSource === 'frontend' ? currentSearchTerm : '' });
        summary.searchTerm = currentSearchTerm;
        output.val(summary.text);
        output.scrollTop(summary.visibleEntries > 0 ? (output[0]?.scrollHeight || 0) : 0);
        updateStatus(summary);
    };

    const renderCurrentSourceLogs = () => {
        if (currentSource === 'server') {
            renderOutput(renderedServerEntries, formatServerLogEntry);
            return;
        }

        renderOutput(renderedFrontendEntries, formatFrontendLogEntry);
    };

    const readLogQuery = ({ sinceId = 0, silent = false } = {}) => {
        const startTime = parseLogTimeInputValue(startTimeInput.val());
        const endTime = parseLogTimeInputValue(endTimeInput.val(), { roundUpMinute: true });
        if (startTime !== null && endTime !== null && startTime > endTime) {
            if (!silent) {
                toastr.warning(t`Start time must be earlier than end time.`, t`Invalid log filter`);
            }
            return null;
        }

        return normalizeLogQueryOptions({
            limit: limitInput.val(),
            sinceId,
            startTime,
            endTime,
            searchTerm: currentSource === 'server' ? currentSearchTerm : '',
        });
    };

    const renderServerLogs = (payload, appendOnly = false, maxEntries = DEFAULT_LOG_VIEW_LIMIT) => {
        const incomingEntries = Array.isArray(payload?.entries) ? payload.entries : [];
        renderedServerEntries = appendOnly
            ? [...renderedServerEntries, ...incomingEntries].slice(-maxEntries)
            : incomingEntries.slice(-maxEntries);
        latestServerId = Number(payload?.latestId) || latestServerId;
        if (currentSource === 'server') {
            renderCurrentSourceLogs();
        }
    };

    const renderFrontendLogs = (payload, appendOnly = false, maxEntries = DEFAULT_LOG_VIEW_LIMIT) => {
        const incomingEntries = Array.isArray(payload?.entries) ? payload.entries : [];
        renderedFrontendEntries = appendOnly
            ? [...renderedFrontendEntries, ...incomingEntries].slice(-maxEntries)
            : incomingEntries.slice(-maxEntries);
        latestFrontendId = Number(payload?.latestId) || latestFrontendId;
        if (currentSource === 'frontend') {
            renderCurrentSourceLogs();
        }
    };

    const reloadAll = async () => {
        if (closed) {
            return;
        }

        if (inFlight) {
            reloadQueued = true;
            return;
        }

        updateNote();
        const query = readLogQuery();
        if (!query) {
            return;
        }

        inFlight = true;
        try {
            if (currentSource === 'server') {
                const payload = await fetchServerLogs(query);
                renderServerLogs(payload, false, query.limit);
            } else {
                const payload = getFrontendLogsSnapshot(query);
                renderFrontendLogs(payload, false, query.limit);
            }
        } catch (error) {
            const title = currentSource === 'server' ? t`Failed to fetch server logs` : t`Failed to fetch frontend logs`;
            console.error('Failed to load logs:', error);
            toastr.error(String(error.message || error), title);
        } finally {
            inFlight = false;
            if (reloadQueued && !closed) {
                reloadQueued = false;
                void reloadAll();
            }
        }
    };

    const loadIncremental = async () => {
        if (inFlight || closed || !autoRefresh.is(':checked')) {
            return;
        }

        const latestId = currentSource === 'server' ? latestServerId : latestFrontendId;
        const query = readLogQuery({ sinceId: latestId, silent: true });
        if (!query) {
            return;
        }

        if (query.endTime !== null && query.endTime < Date.now()) {
            return;
        }

        inFlight = true;
        try {
            if (currentSource === 'server') {
                const payload = await fetchServerLogs(query);
                renderServerLogs(payload, true, query.limit);
            } else {
                const payload = getFrontendLogsSnapshot(query);
                renderFrontendLogs(payload, true, query.limit);
            }
        } catch {
            // Keep silent during background refresh to avoid toast spam.
        } finally {
            inFlight = false;
        }
    };

    sourceSelect.on('change', async function () {
        const nextSource = String($(this).val() || 'frontend');
        if (nextSource === 'server' && !canViewServerLogs) {
            currentSource = 'frontend';
            sourceSelect.val('frontend');
            toastr.error(t`Only admins can view server logs.`, t`Permission denied`);
            return;
        }

        currentSource = nextSource;
        updateNote();
        updateSearchPlaceholder();
        await reloadAll();
    });

    template.find('.serverLogsRefreshButton').on('click', reloadAll);
    startTimeInput.on('change', reloadAll);
    endTimeInput.on('change', reloadAll);
    limitInput.on('change', function () {
        $(this).val(readLogQuery({ silent: true })?.limit || DEFAULT_LOG_VIEW_LIMIT);
        reloadAll();
    });
    searchInput.on('input', debounce((event) => {
        currentSearchTerm = String(event?.target?.value || '').trim();
        if (currentSource === 'server') {
            void reloadAll();
            return;
        }

        renderCurrentSourceLogs();
    }, 120));
    template.find('.serverLogsCopyButton').on('click', async () => {
        try {
            await navigator.clipboard.writeText(String(output.val() || ''));
            const title = currentSource === 'server' ? t`Server Logs` : t`Frontend Logs`;
            toastr.success(t`Logs copied to clipboard.`, title);
        } catch (error) {
            console.error('Copy logs failed:', error);
            const title = currentSource === 'server' ? t`Server Logs` : t`Frontend Logs`;
            toastr.error(t`Copy failed.`, title);
        }
    });
    template.find('.serverLogsClearButton').on('click', async () => {
        const confirmText = currentSource === 'server'
            ? t`Clear all captured server logs?`
            : t`Clear all captured frontend logs?`;
        const confirmed = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Clear`,
            cancelButton: t`Cancel`,
            wide: false,
            large: false,
        });

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            if (currentSource === 'server') {
                await clearServerLogsRemote();
                latestServerId = 0;
                renderedServerEntries = [];
                toastr.success(t`Server logs cleared.`, t`Server Logs`);
            } else {
                clearFrontendLogs();
                latestFrontendId = 0;
                renderedFrontendEntries = [];
                toastr.success(t`Frontend logs cleared.`, t`Frontend Logs`);
            }
            renderCurrentSourceLogs();
        } catch (error) {
            console.error('Clear logs failed:', error);
            const title = currentSource === 'server' ? t`Failed to clear server logs` : t`Failed to clear frontend logs`;
            toastr.error(String(error.message || error), title);
        }
    });

    updateNote();
    updateSearchPlaceholder();
    updateStatus();
    output.val(t`Loading logs...`);
    const timer = setInterval(loadIncremental, 1500);
    const popupPromise = callGenericPopup(template, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    });

    setTimeout(() => {
        if (!closed) {
            void reloadAll();
        }
    }, 0);

    try {
        await popupPromise;
    } finally {
        closed = true;
        clearInterval(timer);
    }
}

/**
 * Posts to a user API endpoint and throws the server's error message on failure.
 * @param {string} url Endpoint
 * @param {object} [body] JSON body; omitted for body-less requests
 * @returns {Promise<Response>} The successful response
 */
async function postUserApi(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: body === undefined ? getRequestHeaders({ omitContentType: true }) : getRequestHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data?.error || data?.message || 'Unknown error');
        error.data = data;
        throw error;
    }
    return response;
}

/**
 * Changes a user's password.
 * @param {string} handle User handle
 * @param {string} oldPassword Current password (not needed for admins)
 * @param {string} newPassword New password; empty removes it
 * @returns {Promise<void>}
 */
export async function requestChangePassword(handle, oldPassword, newPassword) {
    await postUserApi('/api/users/change-password', { handle, newPassword, oldPassword });
}

/**
 * Changes a user's display name.
 * @param {string} handle User handle
 * @param {string} name New display name
 * @returns {Promise<void>}
 */
export async function requestChangeName(handle, name) {
    await postUserApi('/api/users/change-name', { handle, name });
}

/**
 * Changes a user's avatar.
 * @param {string} handle User handle
 * @param {string} avatar Base64 data URL, or empty to remove the custom avatar
 * @returns {Promise<void>}
 */
export async function requestChangeAvatar(handle, avatar) {
    await postUserApi('/api/users/change-avatar', { avatar, handle });
}

/**
 * Resets a user's settings to factory defaults.
 * @param {string} handle User handle
 * @param {string} password Current password
 * @returns {Promise<void>}
 */
export async function requestResetSettings(handle, password) {
    await postUserApi('/api/users/reset-settings', { handle, password });
}

/**
 * Starts a full account reset: the server prints a reset code to its console.
 * @returns {Promise<void>}
 */
export async function requestResetCode() {
    await postUserApi('/api/users/reset-step1');
}

/**
 * Wipes all data of the current user.
 * @param {string} password Current password
 * @param {string} code Reset code from the server console
 * @returns {Promise<void>}
 */
export async function requestResetEverything(password, code) {
    await postUserApi('/api/users/reset-step2', { password, code });
}

/**
 * Lists the settings snapshots.
 * @returns {Promise<Snapshot[]>} Snapshots
 */
export async function fetchSnapshots() {
    const response = await postUserApi('/api/settings/get-snapshots');
    return response.json();
}

/**
 * Reads the content of a settings snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<string>} Snapshot content
 */
export async function fetchSnapshotContent(name) {
    const response = await postUserApi('/api/settings/load-snapshot', { name });
    return response.text();
}

/**
 * Records a snapshot of the current settings.
 * @returns {Promise<void>}
 */
export async function requestMakeSnapshot() {
    await postUserApi('/api/settings/make-snapshot');
}

/**
 * Restores the settings from a snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<void>}
 */
export async function requestRestoreSnapshot(name) {
    await postUserApi('/api/settings/restore-snapshot', { name });
}

// ---------- admin requests (throw on failure) ----------

/**
 * Lists all users.
 * @returns {Promise<import('../../src/users.js').UserViewModel[]>} Users
 */
export async function fetchUsers() {
    const response = await postUserApi('/api/users/get');
    return response.json();
}

/**
 * Reads the admin overview: server info, totals, per-user storage and security checks.
 * @returns {Promise<any>} Overview
 */
export async function fetchAdminOverview() {
    const response = await postUserApi('/api/users/overview');
    return response.json();
}

/**
 * Reads the global admin settings (default quota, registration, OAuth).
 * @returns {Promise<any>} Settings
 */
export async function fetchAdminSettings() {
    const response = await postUserApi('/api/users/settings/get');
    return response.json();
}

/**
 * Saves the global admin settings.
 * @param {any} payload Settings
 * @returns {Promise<any>} Saved settings
 */
export async function requestSaveAdminSettings(payload) {
    const response = await postUserApi('/api/users/settings/save', payload);
    return response.json();
}

/**
 * Reads config.yaml.
 * @returns {Promise<{path: string, content: string}>} Config file
 */
export async function fetchRuntimeConfig() {
    const response = await postUserApi('/api/users/config/get');
    return response.json();
}

/**
 * Saves config.yaml; validation errors come back localized.
 * @param {string} content File content
 * @returns {Promise<{ok: boolean, hotReloadApplied: boolean, restartRecommended: boolean}>} Save result
 */
export async function requestSaveRuntimeConfig(content) {
    try {
        const response = await postUserApi('/api/users/config/save', { content });
        return response.json();
    } catch (error) {
        const localized = localizeConfigValidationCodes(error.data?.codes);
        if (localized) error.message = localized;
        throw error;
    }
}

/**
 * Lists the installed server plugins.
 * @returns {Promise<{ok: boolean, enabled: boolean, pluginsPath: string, plugins: Array<any>}>} Plugins
 */
export async function fetchServerPlugins() {
    const response = await postUserApi('/api/users/plugins/list');
    return response.json();
}

/**
 * Installs a server plugin from a git repository.
 * @param {string} repoUrl Repository URL
 * @returns {Promise<{ok: boolean, enabled: boolean, restartRecommended: boolean, plugin: any}>} Result
 */
export async function requestInstallServerPlugin(repoUrl) {
    const response = await postUserApi('/api/users/plugins/install', { repoUrl });
    return response.json();
}

/**
 * Updates a server plugin from its git remote.
 * @param {string} directory Plugin directory
 * @returns {Promise<{ok: boolean, restartRecommended: boolean, plugin: any}>} Result
 */
export async function requestUpdateServerPlugin(directory) {
    const response = await postUserApi('/api/users/plugins/update', { directory });
    return response.json();
}

/**
 * Removes a server plugin.
 * @param {string} directory Plugin directory
 * @returns {Promise<{ok: boolean, restartRecommended: boolean, plugin: any}>} Result
 */
export async function requestRemoveServerPlugin(directory) {
    const response = await postUserApi('/api/users/plugins/delete', { directory });
    return response.json();
}

/**
 * Installs the npm dependencies of a server plugin.
 * @param {string} directory Plugin directory
 * @returns {Promise<{ok: boolean, installed: boolean, manager: string, plugin: any}>} Result
 */
export async function requestInstallPluginDependencies(directory) {
    const response = await postUserApi('/api/users/plugins/install-dependencies', { directory });
    return response.json();
}

/**
 * Sets a user's storage quota.
 * @param {string} handle User handle
 * @param {number|null} quotaBytes Quota in bytes; null uses the default
 * @returns {Promise<void>}
 */
export async function requestSetUserQuota(handle, quotaBytes) {
    await postUserApi('/api/users/set-quota', { handle, storageQuotaBytes: quotaBytes });
}

/**
 * Enables or disables a user account.
 * @param {string} handle User handle
 * @param {boolean} enabled Whether the account can sign in
 * @returns {Promise<void>}
 */
export async function requestSetUserEnabled(handle, enabled) {
    await postUserApi(enabled ? '/api/users/enable' : '/api/users/disable', { handle });
}

/**
 * Promotes a user to admin or demotes an admin to a regular user.
 * @param {string} handle User handle
 * @param {boolean} admin Whether the user becomes an admin
 * @returns {Promise<void>}
 */
export async function requestSetUserAdmin(handle, admin) {
    await postUserApi(admin ? '/api/users/promote' : '/api/users/demote', { handle });
}

/**
 * Creates a user.
 * @param {{handle: string, name: string, password: string}} user New user
 * @returns {Promise<{handle: string}>} The created handle
 */
export async function requestCreateUser(user) {
    const response = await postUserApi('/api/users/create', user);
    return response.json();
}

/**
 * Deletes a user.
 * @param {string} handle User handle
 * @param {boolean} purge Also delete the user's data folder
 * @returns {Promise<void>}
 */
export async function requestDeleteUser(handle, purge) {
    await postUserApi('/api/users/delete', { handle, purge });
}

/**
 * Turns a display name into a valid handle.
 * @param {string} text Display name
 * @returns {Promise<string>} Handle
 */
export async function requestSlugify(text) {
    const response = await postUserApi('/api/users/slugify', { text });
    return response.text();
}

/**
 * Lists all announcements.
 * @returns {Promise<Array<{id: string, level: string, title: string, body: string, createdAt: number}>>} Announcements
 */
export async function fetchAnnouncementsAdmin() {
    const response = await postUserApi('/api/users/announcements/list', {});
    const data = await response.json();
    return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Creates, updates or deletes an announcement.
 * @param {'create'|'update'|'delete'} op Operation
 * @param {object} payload Announcement fields (with id for update/delete)
 * @returns {Promise<void>}
 */
export async function requestAnnouncement(op, payload) {
    await postUserApi(`/api/users/announcements/${op}`, payload);
}

/**
 * Reads the storage backend status, including a running migration's progress.
 * @returns {Promise<any>} Status
 */
export async function fetchStorageBackendStatus() {
    const response = await postUserApi('/api/users/storage/status', {});
    return response.json();
}

/**
 * Migrates all user data to another storage backend.
 * @param {string} targetMode fs, sqlite, mysql or postgres
 * @param {object} [dbCreds] Connection overrides from buildStorageBackendCreds()
 * @returns {Promise<{ok: boolean, status: number, data: any}>} The server's report, also when it failed
 */
export async function triggerStorageBackendMigration(targetMode, dbCreds = {}) {
    const body = { targetMode };
    if (targetMode === 'mysql' && dbCreds.mysql) body.mysql = dbCreds.mysql;
    if (targetMode === 'postgres' && dbCreds.postgres) body.postgres = dbCreds.postgres;
    const response = await fetch('/api/users/storage/migrate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
}

/**
 * Log out the current user.
 * @returns {Promise<void>}
 */
async function logout() {
    resetResourceReads();
    await fetch('/api/users/logout', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    // On an explicit logout stop auto login
    // to allow user to change username even
    // when auto auth (such as authelia or basic)
    // would be valid
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('noauto', 'true');

    window.location.search = urlParams.toString();
}

/**
 * Pings the server to extend the user session.
 */
async function extendUserSession() {
    try {
        const response = await fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Ping did not succeed', { cause: response.status });
        }
    } catch (error) {
        console.error('Failed to extend user session', error);
    }
}

jQuery(() => {
    $('#logout_button').on('click', () => {
        logout();
    });
    $('#admin_button').on('click', () => {
        openDataWindow({ tab: 'users' });
    });
    $('#account_button').on('click', () => {
        openDataWindow({ tab: 'profile' });
    });
    $('#server_logs_button').on('click', () => {
        openLogsViewer();
    });
    setInterval(async () => {
        if (currentUser) {
            await extendUserSession();
        }
    }, SESSION_EXTEND_INTERVAL);
});
