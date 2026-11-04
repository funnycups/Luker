// Data source for the backup, restore and migration pages of the Data window.

import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { canViewSecrets } from './secrets.js';
import { uploadFileInChunks, finalizeRestoreUpload, abortRestoreUpload, RestoreUploadError } from './luker-chunked-upload.js';
import {
    BACKUP_CATEGORY_KEYS,
    BACKUP_DEFAULT_SELECTION,
    buildRestoreDiagnosticReport,
    createLanMigrationLink,
    downloadUserBackup,
    getCurrentUserHandle,
    importLanMigrationLink,
    isAdmin,
    isLocalOnlyHostName,
    probeBackupArchive,
    restoreUserData,
} from './user.js';

const ENGINE_LABELS = { sqlite: 'SQLite', mysql: 'MySQL', postgres: 'PostgreSQL' };
const SCRATCH_DEFAULTS = { mysql: { port: '3306', name: 'mysql' }, postgres: { port: '5432', name: 'postgres' } };

/**
 * Builds an Error the window can show as-is, with a machine-readable code.
 * @param {string} message Human-readable text
 * @param {string} code Error code the window branches on
 * @param {object} [extra] Extra fields copied onto the error
 * @returns {Error & { code: string }}
 */
function failure(message, code, extra = {}) {
    return Object.assign(new Error(message), { code }, extra);
}

/**
 * Human-readable reason for a failed request.
 * @param {any} error Caught error
 * @returns {string} Text to show
 */
function describe(error) {
    if (error instanceof TypeError && /fetch|network|load failed/i.test(String(error.message))) {
        return t`Could not reach the server. Check the connection and try again.`;
    }
    return String(error?.serverMessage || error?.message || error || t`Unknown error`);
}

/**
 * Display name of a storage engine kind.
 * @param {string} kind Engine kind reported by the server
 * @returns {string} Label
 */
function engineLabel(kind) {
    if (kind === 'fs') return t`File storage`;
    return ENGINE_LABELS[kind] || t`Current storage`;
}

/**
 * Backup categories in display order.
 * @returns {Array<{ id: string, label: string, def: boolean, sensitive?: boolean, adminOnly?: boolean }>}
 */
function buildCategories() {
    const labels = {
        settings: t`Settings`,
        secrets: t`API Keys / Secrets`,
        characters: t`Characters / Avatars`,
        chats: t`Chats / Groups`,
        lorebooks: t`Lorebooks`,
        presets: t`Presets / UI Layout`,
        assets: t`Assets / Files`,
        extensions: t`User Extensions`,
        globalExtensions: t`Global Extensions (Admin)`,
        vectors: t`Vector Indexes`,
    };
    return BACKUP_CATEGORY_KEYS.map(id => ({
        id,
        label: labels[id] || id,
        def: Boolean(BACKUP_DEFAULT_SELECTION[id]),
        ...(id === 'secrets' ? { sensitive: true } : {}),
        ...(id === 'globalExtensions' ? { adminOnly: true } : {}),
    }));
}

/**
 * Turns the window's category ids into the server's selection map.
 * @param {string[]} categories Selected category ids
 * @returns {Record<string, boolean>} Selection
 */
function toSelection(categories) {
    const chosen = new Set(categories || []);
    const selection = Object.fromEntries(BACKUP_CATEGORY_KEYS.map(key => [key, chosen.has(key)]));
    if (!Object.values(selection).some(Boolean)) {
        throw failure(t`Select at least one data category.`, 'NOTHING_SELECTED');
    }
    return selection;
}

/** The window says 'replace', the server says 'overwrite'. */
function toServerMode(mode) {
    return mode === 'replace' || mode === 'overwrite' ? 'overwrite' : 'merge';
}

/**
 * Connection URL for the scratch database from the window's form fields.
 * A full connection URL typed into the host field is used as-is.
 * @param {'mysql'|'postgres'} kind Engine of the backup
 * @param {{ host?: string, port?: string, user?: string, pass?: string, name?: string }} db Form fields
 * @returns {{ mysqlUrl: string } | { postgresUrl: string }} Scratch credentials for the restore request
 */
function buildScratchCreds(kind, db) {
    const host = String(db?.host || '').trim();
    let url;
    if (/^(mysql|postgres(ql)?):\/\//i.test(host)) {
        url = host;
    } else {
        const defaults = SCRATCH_DEFAULTS[kind];
        const user = String(db?.user || '').trim();
        const pass = String(db?.pass || '');
        const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '';
        const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        const port = String(db?.port || '').trim() || defaults.port;
        const name = String(db?.name || '').trim() || defaults.name;
        url = `${kind === 'postgres' ? 'postgres' : 'mysql'}://${auth}${hostPart}:${port}/${encodeURIComponent(name)}`;
    }
    return kind === 'mysql' ? { mysqlUrl: url } : { postgresUrl: url };
}

/**
 * Restore/migration result in the window's shape.
 * @param {any} result Server result (`restoredCount`, `skippedCount`, `preflight`, `crossMode`, ...)
 * @returns {{ restored: number, skipped: number, rejected: number, failed: number, empty: boolean, crossEngine: string, samples: string[] }}
 */
function toOutcome(result) {
    const cross = result?.crossMode;
    const samples = Array.isArray(result?.preflight?.sampleSkippedEntries) ? result.preflight.sampleSkippedEntries : [];
    const restored = Number(result?.restoredCount || 0);
    const skipped = Number(result?.skippedCount || 0);
    const rejected = Number(result?.rejectedCount || 0);
    const failed = Number(result?.failedCount || 0);
    const targetable = result?.preflight?.targetableEntries;
    // Database backups carry their rows in the engine dump instead of files:
    // the restore moved data even when no file was written, so it is not empty.
    const engineDump = Number(result?.preflight?.engineDumpEntries || 0) > 0;
    const empty = !engineDump && (targetable !== undefined ? Number(targetable) === 0 : restored === 0);
    return {
        restored,
        skipped,
        rejected,
        failed,
        empty,
        crossEngine: cross ? `${engineLabel(cross.sourceKind)} → ${engineLabel(cross.destKind)}` : '',
        samples: samples.slice(0, 12).map(item => (item?.reason ? `${item.entry} (${item.reason})` : String(item?.entry ?? item))),
    };
}

/**
 * Replaces the host of a migration link, keeping its path and token.
 * A bare host (no scheme) keeps the link's port; a full origin brings its own.
 * @param {string} link Link from the server
 * @param {string} address Origin or host the other device should use
 * @returns {string} Shareable link
 */
function linkWithAddress(link, address) {
    try {
        const original = new URL(link);
        const value = String(address || '').trim();
        if (!value) return original.toString();
        const hasScheme = value.includes('://');
        const target = new URL(hasScheme ? value : `${original.protocol}//${value}`);
        if (!hasScheme && !target.port && original.port) {
            target.port = original.port;
        }
        target.pathname = original.pathname;
        target.search = original.search;
        target.hash = original.hash;
        return target.toString();
    } catch {
        return String(link || '');
    }
}

/**
 * Creates the backup/restore/migration source of the Data window.
 * @param {object} state Shared snapshot object; fields are updated in place
 * @param {() => void} emit Notifies the window that `state` changed
 * @param {{ handle?: string }} [options] Target user when the admin panel acts for someone else
 * @returns {object} Source with start/stop and the backup methods
 */
export function createBackupSource(state, emit, options = {}) {
    /** Upload session kept between calls, so a restore can continue without sending the file again. */
    let upload = null;
    let engineKind = null;
    let busy = false;

    const refreshIdentity = () => {
        state.isAdmin = isAdmin();
        state.handle = getCurrentUserHandle();
    };
    refreshIdentity();
    state.caps = { allowFullBackup: true, allowSecrets: true, ...state.caps };
    state.backupCategories = buildCategories();

    const resolveHandle = handle => handle || options.handle || state.handle || getCurrentUserHandle();

    const discardUpload = session => {
        if (!session) return Promise.resolve();
        if (upload === session) upload = null;
        return session.uploadId ? abortRestoreUpload(session.uploadId, { headers: getRequestHeaders() }) : Promise.resolve();
    };

    async function currentEngineKind() {
        if (engineKind !== null) return engineKind;
        try {
            const response = await fetch('/api/storage/health', { headers: getRequestHeaders() });
            const data = await response.json();
            engineKind = String(data?.kind || '');
        } catch {
            engineKind = '';
        }
        return engineKind;
    }

    /**
     * Sends the file in chunks, continuing a session interrupted earlier.
     * @param {object} session Cached upload session
     * @param {File} file Backup ZIP
     * @param {string} handle Target user
     * @param {(progress: object) => void} onProgress Window progress observer
     */
    async function sendFile(session, file, handle, onProgress) {
        const percentOf = loaded => (file.size > 0 ? Math.min(100, Math.floor((loaded / file.size) * 100)) : 100);
        onProgress({ stage: 0, percent: percentOf(session.uploadedBytes), note: '' });
        try {
            const result = await uploadFileInChunks(file, {
                handle,
                headers: getRequestHeaders(),
                resume: session.uploadId ? { uploadId: session.uploadId, uploadedBytes: session.uploadedBytes } : null,
                onProgress: ({ loaded }) => onProgress({ stage: 0, percent: percentOf(loaded), note: '' }),
                onRetry: ({ reason, attempt, maxRetries }) => onProgress({
                    stage: 0,
                    note: reason === 'payload_too_large'
                        ? t`Chunk too large for the server, splitting and retrying…`
                        : t`Chunk upload failed, retrying (${attempt}/${maxRetries})…`,
                }),
            });
            session.uploadId = result.uploadId;
            session.uploadedBytes = result.uploadedBytes;
        } catch (error) {
            // Retries ran out on a network or server error: the server keeps
            // the session, so the window can offer to continue from here.
            if (error instanceof RestoreUploadError && error.uploadId && error.cause) {
                session.uploadId = error.uploadId;
                session.uploadedBytes = error.uploadedBytes;
                const percent = percentOf(error.uploadedBytes);
                throw failure(t`Upload interrupted at ${percent}%`, 'upload-interrupted', { percent });
            }
            if (error instanceof RestoreUploadError && error.uploadId) {
                session.uploadId = error.uploadId;
            }
            await discardUpload(session);
            throw failure(t`Could not upload the backup: ${describe(error)}`, 'UPLOAD_FAILED');
        }
    }

    /** Assembles the uploaded chunks; the server side is idempotent, so retry once. */
    async function assembleFile(session) {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await finalizeRestoreUpload(session.uploadId, { headers: getRequestHeaders() });
                session.finalized = true;
                return;
            } catch (error) {
                if (attempt >= 2) {
                    await discardUpload(session);
                    throw failure(t`Could not assemble the uploaded backup: ${describe(error)}`, 'ASSEMBLE_FAILED');
                }
                console.warn('Upload assembly failed; retrying once:', error);
            }
        }
    }

    const tempDbError = async kind => failure(
        t`This backup comes from another database engine and needs a temporary database connection.`,
        'needs-temp-db',
        { kind, source: engineLabel(kind), target: engineLabel(await currentEngineKind()) },
    );

    return {
        async start() {
            refreshIdentity();
            const allowSecrets = await canViewSecrets();
            state.caps = { ...state.caps, allowSecrets: allowSecrets !== false };
            emit();
        },

        stop() {
            if (!busy) discardUpload(upload);
        },

        currentHandle() {
            return state.handle;
        },

        /**
         * Downloads a backup ZIP of the selected categories.
         * @param {string[]} categories Category ids
         * @param {(progress: { stage: 'pack'|'download', percent?: number, loaded?: number }) => void} onProgress Progress observer
         * @returns {Promise<{ fileName: string, size: number }>}
         */
        async downloadBackup(categories, onProgress = () => {}) {
            const selection = toSelection(categories);
            onProgress({ stage: 'pack' });
            try {
                return await downloadUserBackup(resolveHandle(), selection, {
                    // The archive is zipped while it streams, so the size is
                    // usually unknown; stay on "packing" and report bytes.
                    onProgress: ({ loaded, total }) => onProgress(total > 0 && loaded > 0
                        ? { stage: 'download', percent: Math.min(100, Math.floor((loaded / total) * 100)) }
                        : { stage: 'pack', loaded }),
                });
            } catch (error) {
                if (error?.status === 403 && /disabled/i.test(String(error.serverMessage || ''))) {
                    state.caps = { ...state.caps, allowFullBackup: false };
                    emit();
                    throw failure(t`The server has disabled backup downloads.`, 'BACKUP_DISABLED');
                }
                throw failure(t`Failed to backup user data: ${describe(error)}`, 'BACKUP_FAILED');
            }
        },

        /**
         * Uploads and restores a backup ZIP. After `needs-temp-db` or
         * `upload-interrupted` a call with the same file reuses what the
         * server already has instead of sending the file again.
         * @param {{ file: File, mode: 'merge'|'replace', categories: string[], tempDb?: object|null, handle?: string }} request
         * @param {(progress: { stage: number, percent?: number, note?: string }) => void} onProgress Progress observer
         * @returns {Promise<{ restored: number, skipped: number, rejected: number, failed: number, empty: boolean, crossEngine: string, samples: string[] }>}
         */
        async restoreBackup({ file, mode, categories, tempDb = null, handle } = {}, onProgress = () => {}) {
            if (!file) throw failure(t`Choose a backup ZIP first.`, 'NO_FILE');
            const target = resolveHandle(handle);
            const selection = toSelection(categories);
            const serverMode = toServerMode(mode);
            const key = [target, file.name, file.size, file.lastModified].join('\u0000');
            if (upload && upload.key !== key) await discardUpload(upload);
            upload ??= { key, uploadId: null, uploadedBytes: 0, finalized: false, probe: undefined };
            const session = upload;

            busy = true;
            try {
                if (!session.finalized) {
                    await sendFile(session, file, target, onProgress);
                    onProgress({ stage: 1, note: '' });
                    await assembleFile(session);
                }

                // Probe failures stay non-fatal: the restore request gives the
                // definitive error for a broken ZIP.
                onProgress({ stage: 2, note: '' });
                if (session.probe === undefined) {
                    session.probe = await probeBackupArchive(session.uploadId).catch((error) => {
                        console.warn('Probe failed (continuing with direct restore):', error);
                        return null;
                    });
                }
                const kind = session.probe?.crossModeRequired ? session.probe.scratchCredsNeeded : null;
                if (kind && !tempDb) throw await tempDbError(kind);
                const scratchCreds = kind ? buildScratchCreds(kind, tempDb) : null;

                // The server consumes the upload session once the restore request reaches it.
                if (upload === session) upload = null;
                let result;
                try {
                    result = await restoreUserData(session.uploadId, target, selection, serverMode, undefined, {
                        scratchCreds,
                        onPhaseProgress: (event) => {
                            if (event?.phase && event.phase !== 'analyze') onProgress({ stage: 3, note: '' });
                        },
                    });
                } catch (error) {
                    console.error('Error restoring user data:', error);
                    // Drops the session if a transport failure kept the request
                    // from reaching the server; a consumed session answers 404.
                    abortRestoreUpload(session.uploadId, { headers: getRequestHeaders() });
                    if (error?.crossModeScratchRequired?.kind) throw await tempDbError(error.crossModeScratchRequired.kind);
                    if (error?.crossModeScratchConnection) {
                        throw failure(t`Could not use the temporary database: ${describe(error)}`, 'TEMP_DB_FAILED');
                    }
                    throw failure(t`Failed to restore backup: ${describe(error)}`, 'RESTORE_FAILED');
                }

                console.info('BACKUP_RESTORE_REPORT', buildRestoreDiagnosticReport({ handle: target, file, mode: serverMode, selection, result }));
                return toOutcome(result);
            } finally {
                busy = false;
            }
        },

        /**
         * Gives up an interrupted or waiting upload and deletes it on the server.
         * @returns {Promise<void>}
         */
        async cancelUpload() {
            if (!busy) await discardUpload(upload);
        },

        /**
         * Creates a one-time migration link for the selected categories.
         * @param {string[]} categories Category ids
         * @param {string} [handle] User whose data the link exports
         * @returns {Promise<{ addresses: string[], link: (address: string) => string, expiresAt: number }>}
         */
        async createMigrationLink(categories, handle) {
            const selection = toSelection(categories);
            let offer;
            try {
                offer = await createLanMigrationLink(resolveHandle(handle), selection);
            } catch (error) {
                console.error('Error creating LAN migration link:', error);
                throw failure(t`Failed to create migration link: ${describe(error)}`, 'LINK_FAILED');
            }
            const url = String(offer?.url || '');
            const addresses = [];
            for (const candidate of [url, location.origin]) {
                try {
                    const origin = new URL(candidate).origin;
                    if (!addresses.includes(origin)) addresses.push(origin);
                } catch { /* not a URL */ }
            }
            // A loopback address is only useful when nothing else is known.
            addresses.sort((a, b) => Number(isLocalOnlyHostName(new URL(a).hostname)) - Number(isLocalOnlyHostName(new URL(b).hostname)));
            return {
                addresses,
                link: address => linkWithAddress(url, address),
                expiresAt: Number(offer?.expiresAt) || Date.now() + 10 * 60 * 1000,
            };
        },

        /**
         * Pulls the data behind a migration link from the other device.
         * @param {{ link: string, mode: 'merge'|'replace', categories: string[], handle?: string }} request
         * @param {(progress: { stage: number, percent?: number }) => void} onProgress Progress observer
         * @returns {Promise<{ restored: number, skipped: number, rejected: number, failed: number, empty: boolean, crossEngine: string, samples: string[] }>}
         */
        async migrateFromLink({ link, mode, categories, handle } = {}, onProgress = () => {}) {
            const url = String(link || '').trim();
            let parsed = null;
            try { parsed = new URL(url); } catch { /* checked below */ }
            if (!parsed || !/^https?:$/.test(parsed.protocol)) {
                throw failure(t`This is not a valid migration link.`, 'BAD_LINK');
            }
            const target = resolveHandle(handle);
            const selection = toSelection(categories);
            const serverMode = toServerMode(mode);
            const stageOf = phase => (phase === 'download' ? 0 : phase === 'extract' || phase === 'finalize' ? 2 : 1);

            busy = true;
            onProgress({ stage: 0, percent: 0 });
            try {
                const result = await importLanMigrationLink(target, url, selection, serverMode, undefined, {
                    onPhaseProgress: event => event?.phase && onProgress({ stage: stageOf(event.phase) }),
                });
                console.info('LAN_MIGRATION_REPORT', buildRestoreDiagnosticReport({
                    handle: target,
                    file: { name: url, size: 0, type: 'lan-migration-link' },
                    mode: serverMode,
                    selection,
                    result,
                }));
                return toOutcome(result);
            } catch (error) {
                console.error('Error importing LAN migration link:', error);
                throw failure(t`Failed to import migration link: ${describe(error)}`, 'MIGRATION_FAILED');
            } finally {
                busy = false;
            }
        },
    };
}
