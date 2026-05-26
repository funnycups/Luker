import dns from 'node:dns/promises';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import storage from 'node-persist';
import express from 'express';
import ipaddr from 'ipaddr.js';
import yauzl from 'yauzl';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, createBackupArchive, ensurePublicDirectoriesExist, toAvatarKey, getAccountVersion, getUserDirectories, getUserBackupTargets, normalizeUserBackupSelection } from '../users.js';
import { SETTINGS_FILE, PUBLIC_DIRECTORIES, UPLOADS_DIRECTORY } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { invalidateRecentChatIndex } from './chats.js';
import { color, Cache, getConfigValue, ensureDirectory, isValidUrl, normalizeZipEntryPath, trimTrailingSlash } from '../util.js';
import { createLanMigrationOffer, LAN_MIGRATION_PATH_PREFIX } from '../lan-migration.js';
import { listForUser, mergeReadIds } from '../announcements.js';

const RESET_CACHE = new Cache(5 * 60 * 1000);
const FULL_IMPORT_SELECTION = Object.freeze({
    ...Object.fromEntries(Object.keys(normalizeUserBackupSelection({})).map((key) => [key, true])),
    globalExtensions: false,
});
const BACKUP_CATEGORY_ORDER = Object.freeze(Object.keys(FULL_IMPORT_SELECTION));
const LAN_MIGRATION_LINK_PATH_PATTERN = /^\/api\/users\/transfer\/backup\/[a-f0-9]{64}$/i;

function sanitizeBackupSelectionForUser(selection, isAdminUser) {
    const normalized = normalizeUserBackupSelection(selection);
    if (!isAdminUser) {
        normalized.globalExtensions = false;
    }
    return normalized;
}

function parseBackupSelectionPayload(payload) {
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload);
        } catch {
            return {};
        }
    }
    return payload;
}

function getRequestBaseUrl(request) {
    const forwardedProto = request.get('x-forwarded-proto');
    const protocol = forwardedProto || request.protocol || 'http';
    const host = request.get('x-forwarded-host') || request.get('host');
    return `${protocol}://${host}`;
}

function isLanMigrationAddress(address) {
    try {
        let parsed = ipaddr.parse(String(address || '').trim());
        if (parsed.kind() === 'ipv6' && parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
            parsed = parsed.toIPv4Address();
        }

        const range = parsed.range();
        if (parsed.kind() === 'ipv4') {
            return ['private', 'loopback', 'linkLocal'].includes(range);
        }

        return ['uniqueLocal', 'loopback', 'linkLocal'].includes(range);
    } catch {
        return false;
    }
}

async function resolveLanMigrationAddresses(hostname) {
    const value = String(hostname || '').trim();
    const candidate = value.replace(/^\[/, '').replace(/\]$/, '');
    if (!value) {
        return [];
    }

    if (candidate === 'localhost') {
        return ['127.0.0.1', '::1'];
    }

    if (net.isIP(candidate)) {
        return [candidate];
    }

    try {
        const results = await dns.lookup(candidate, { all: true, verbatim: true });
        return [...new Set(results.map(entry => String(entry?.address || '')).filter(Boolean))];
    } catch {
        return [];
    }
}

async function resolveLanMigrationSourceUrl(input) {
    if (!isValidUrl(input)) {
        throw new Error('Migration link is not a valid URL.');
    }

    const url = new URL(String(input).trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Migration link must use http or https.');
    }

    if (url.username || url.password) {
        throw new Error('Migration link cannot include credentials.');
    }

    if (url.search || url.hash) {
        throw new Error('Migration link format is invalid.');
    }

    const normalizedPath = trimTrailingSlash(url.pathname);
    if (!LAN_MIGRATION_LINK_PATH_PATTERN.test(normalizedPath)) {
        throw new Error('Migration link must be a one-time Luker migration link.');
    }

    const addresses = await resolveLanMigrationAddresses(url.hostname);
    if (addresses.length === 0 || !addresses.every(isLanMigrationAddress)) {
        throw new Error('Migration link host must resolve to a LAN or localhost address.');
    }

    url.pathname = normalizedPath;
    return url;
}

async function downloadLanMigrationArchive(sourceUrl, destinationPath) {
    const response = await fetch(sourceUrl, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: {
            'Accept': 'application/zip, application/octet-stream;q=0.9',
        },
    });

    if (response.status === 404 || response.status === 410) {
        throw new Error('Migration link expired or already used.');
    }

    if (!response.ok || !response.body) {
        throw new Error(`Failed to download migration archive (${response.status}).`);
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath, { mode: 0o600 }));
}

function normalizeRestoreArchiveEntryPath(entryName) {
    const normalized = normalizeZipEntryPath(entryName);
    if (normalized) {
        return normalized;
    }

    if (typeof entryName !== 'string') {
        return null;
    }

    const raw = entryName.replace(/\\/g, '/').trim();
    if (!raw) {
        return null;
    }

    const posixNormalized = path.posix.normalize(raw).replace(/^\/+/, '');
    const looksLikeLegacyGlobalExtensionsPath =
        posixNormalized.includes('public/scripts/extensions/third-party/') ||
        posixNormalized.includes('scripts/extensions/third-party/') ||
        posixNormalized.includes('extensions/third-party/') ||
        posixNormalized.includes('third-party/');

    if (!looksLikeLegacyGlobalExtensionsPath) {
        return null;
    }

    const stripped = posixNormalized.replace(/^(\.\.\/)+/, '');
    return normalizeZipEntryPath(stripped);
}

function toPosixRelativePath(basePath, targetPath) {
    const relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return '';
    }
    return path.posix.normalize(relative.split(path.sep).join('/'));
}

function buildRestoreDirectoryAliases(rootPath, allowedDirectories) {
    const aliases = [];
    const globalExtensionsPath = path.resolve(PUBLIC_DIRECTORIES.globalExtensions);

    for (const directory of allowedDirectories) {
        const resolvedDirectory = path.resolve(directory);
        const fromRoot = toPosixRelativePath(rootPath, resolvedDirectory);
        if (fromRoot) {
            aliases.push({ prefix: fromRoot, directory: resolvedDirectory });
        }

        const fromCwd = toPosixRelativePath(process.cwd(), resolvedDirectory);
        if (fromCwd) {
            aliases.push({ prefix: fromCwd, directory: resolvedDirectory });
        }

        if (resolvedDirectory === globalExtensionsPath) {
            aliases.push({ prefix: 'public/scripts/extensions/third-party', directory: resolvedDirectory });
            aliases.push({ prefix: 'scripts/extensions/third-party', directory: resolvedDirectory });
            aliases.push({ prefix: 'extensions/third-party', directory: resolvedDirectory });
            aliases.push({ prefix: 'third-party', directory: resolvedDirectory });
        }
    }

    const deduplicated = new Map();
    for (const alias of aliases) {
        if (!alias.prefix) {
            continue;
        }

        const key = `${alias.directory}::${alias.prefix}`;
        if (!deduplicated.has(key)) {
            deduplicated.set(key, alias);
        }
    }

    return [...deduplicated.values()];
}

function resolveAllowedRestorePath(normalizedEntryPath, rootPath, allowedFiles, allowedDirectories, directoryAliases = []) {
    const parts = normalizedEntryPath.split('/').filter(Boolean);
    const candidates = [];

    for (let index = 0; index < parts.length; index++) {
        const candidate = parts.slice(index).join('/');
        if (candidate) {
            candidates.push(candidate);
        }
    }

    for (const candidate of candidates) {
        if (!candidate || candidate === 'manifest.json') {
            continue;
        }

        const resolved = path.resolve(path.join(rootPath, candidate));

        if (allowedFiles.has(resolved)) {
            return resolved;
        }

        for (const directory of allowedDirectories) {
            if (resolved.startsWith(directory + path.sep)) {
                return resolved;
            }
        }

        for (const alias of directoryAliases) {
            if (!candidate.startsWith(`${alias.prefix}/`)) {
                continue;
            }

            const suffix = candidate.slice(alias.prefix.length + 1);
            if (!suffix) {
                continue;
            }

            const mappedPath = path.resolve(path.join(alias.directory, suffix));
            if (mappedPath.startsWith(alias.directory + path.sep)) {
                return mappedPath;
            }
        }
    }

    return '';
}

function addRestoreReportSample(report, entry, reason) {
    if (!entry || !reason) {
        return;
    }

    if (!Array.isArray(report.sampleSkippedEntries)) {
        report.sampleSkippedEntries = [];
    }

    if (report.sampleSkippedEntries.length >= 30) {
        return;
    }

    report.sampleSkippedEntries.push({ entry, reason });
}

function buildRestoreCategoryTargets(directories, selection, options = {}) {
    const categories = [];
    for (const category of BACKUP_CATEGORY_ORDER) {
        if (!selection[category]) {
            continue;
        }

        const categorySelection = Object.fromEntries(BACKUP_CATEGORY_ORDER.map((key) => [key, key === category]));
        const categoryTargets = getUserBackupTargets(directories, categorySelection, options);
        categories.push({
            name: category,
            files: new Set(categoryTargets.files.map(file => path.resolve(file))),
            directories: categoryTargets.directories.map(directory => path.resolve(directory)),
        });
    }
    return categories;
}

function resolveRestoreCategoryByTargetPath(targetPath, categoryTargets) {
    for (const category of categoryTargets) {
        if (category.files.has(targetPath)) {
            return category.name;
        }

        for (const directory of category.directories) {
            if (targetPath.startsWith(directory + path.sep)) {
                return category.name;
            }
        }
    }

    return '';
}

async function analyzeRestoreArchive(uploadPath, targetRoot, targetFiles, targetDirectories, categoryTargets) {
    /** @type {Map<string, { targetPath: string, category: string }>} */
    const targetByNormalizedEntry = new Map();
    const categoryStats = Object.fromEntries(
        categoryTargets.map((category) => [
            category.name,
            { targetableEntries: 0, restoredEntries: 0, failedEntries: 0 },
        ]),
    );
    const report = {
        totalEntries: 0,
        fileEntries: 0,
        directoryEntries: 0,
        targetableEntries: 0,
        skippedEntries: 0,
        rejectedEntries: 0,
        categoryStats,
        sampleSkippedEntries: [],
    };
    const directoryAliases = buildRestoreDirectoryAliases(targetRoot, targetDirectories);

    await new Promise((resolve, reject) => {
        yauzl.open(uploadPath, { lazyEntries: true, decodeStrings: true }, (openError, zipfile) => {
            if (openError) {
                reject(openError);
                return;
            }

            let finished = false;
            const finish = (error) => {
                if (finished) {
                    return;
                }
                finished = true;
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            zipfile.readEntry();

            zipfile.on('entry', (entry) => {
                try {
                    report.totalEntries += 1;
                    const normalized = normalizeRestoreArchiveEntryPath(entry.fileName);
                    if (!normalized) {
                        report.rejectedEntries += 1;
                        addRestoreReportSample(report, String(entry.fileName || ''), 'invalid_path');
                        zipfile.readEntry();
                        return;
                    }

                    if (entry.fileName.endsWith('/')) {
                        report.directoryEntries += 1;
                        zipfile.readEntry();
                        return;
                    }

                    const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                    if (unixFileType === 0o120000) {
                        report.rejectedEntries += 1;
                        addRestoreReportSample(report, normalized, 'symlink_rejected');
                        zipfile.readEntry();
                        return;
                    }

                    report.fileEntries += 1;
                    const targetPath = resolveAllowedRestorePath(normalized, targetRoot, targetFiles, targetDirectories, directoryAliases);
                    if (!targetPath) {
                        report.skippedEntries += 1;
                        addRestoreReportSample(report, normalized, 'path_not_in_selected_categories');
                        zipfile.readEntry();
                        return;
                    }

                    const category = resolveRestoreCategoryByTargetPath(targetPath, categoryTargets);
                    targetByNormalizedEntry.set(normalized, { targetPath, category });
                    report.targetableEntries += 1;
                    if (category && report.categoryStats[category]) {
                        report.categoryStats[category].targetableEntries += 1;
                    }
                    zipfile.readEntry();
                } catch (error) {
                    finish(error);
                }
            });

            zipfile.on('end', () => finish());
            zipfile.on('close', () => finish());
            zipfile.on('error', finish);
        });
    });

    return { targetByNormalizedEntry, report };
}

async function discardRestoreSnapshots(snapshots) {
    await Promise.all(snapshots.map(async (snap) => {
        try {
            if (snap.type === 'file') {
                await fsPromises.rm(snap.snapshot, { force: true });
            } else {
                await fsPromises.rm(snap.snapshot, { recursive: true, force: true });
            }
        } catch (error) {
            console.warn(`Failed to remove restore snapshot ${snap.snapshot}:`, error);
        }
    }));
}

async function rollbackRestoreSnapshots(snapshots) {
    const results = await Promise.all(snapshots.map(async (snap) => {
        try {
            if (snap.type === 'file') {
                await fsPromises.rm(snap.original, { force: true });
            } else {
                await fsPromises.rm(snap.original, { recursive: true, force: true });
            }
        } catch (error) {
            console.warn(`Failed to clear partial restore at ${snap.original} before rollback:`, error);
        }

        try {
            await fsPromises.rename(snap.snapshot, snap.original);
            return null;
        } catch (error) {
            console.error(`Failed to roll back snapshot ${snap.snapshot} -> ${snap.original}:`, error);
            return snap;
        }
    }));
    return results.filter((snap) => snap !== null);
}

async function restoreUserBackupArchive(uploadPath, directories, selection, mode, options = {}) {
    const backupTargets = getUserBackupTargets(directories, selection, options);
    const targetRoot = path.resolve(directories.root);
    const targetDirectories = backupTargets.directories.map(dir => path.resolve(dir));
    const targetFiles = new Set(backupTargets.files.map(file => path.resolve(file)));

    if (targetDirectories.length === 0 && targetFiles.size === 0) {
        throw new Error('At least one restore category must be selected.');
    }

    const categoryTargets = buildRestoreCategoryTargets(directories, selection, options);
    const analysis = await analyzeRestoreArchive(uploadPath, targetRoot, targetFiles, targetDirectories, categoryTargets);

    if (mode === 'overwrite' && analysis.report.targetableEntries === 0) {
        throw new Error('Archive does not match selected restore categories. Overwrite was cancelled to protect existing data.');
    }

    /** @type {{type: 'file'|'directory', original: string, snapshot: string}[]} */
    const snapshots = [];

    if (mode === 'overwrite') {
        const snapshotSuffix = `.restore-snapshot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        try {
            for (const filePath of targetFiles) {
                if (!fs.existsSync(filePath)) {
                    continue;
                }
                const snapshot = filePath + snapshotSuffix;
                await fsPromises.rename(filePath, snapshot);
                snapshots.push({ type: 'file', original: filePath, snapshot });
            }

            for (const directoryPath of targetDirectories) {
                if (fs.existsSync(directoryPath)) {
                    const snapshot = directoryPath + snapshotSuffix;
                    await fsPromises.rename(directoryPath, snapshot);
                    snapshots.push({ type: 'directory', original: directoryPath, snapshot });
                }
                ensureDirectory(directoryPath);
            }
        } catch (snapshotError) {
            const orphaned = await rollbackRestoreSnapshots(snapshots);
            const baseMessage = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
            if (orphaned.length > 0) {
                const paths = orphaned.map(snap => snap.snapshot).join(', ');
                throw new Error(`Failed to snapshot existing data before overwrite: ${baseMessage}. Manual recovery required for: ${paths}`);
            }
            throw new Error(`Failed to snapshot existing data before overwrite: ${baseMessage}`);
        }
    }

    const result = {
        restoredCount: 0,
        failedCount: 0,
        skippedCount: analysis.report.skippedEntries,
        rejectedCount: analysis.report.rejectedEntries,
        preflight: analysis.report,
    };

    try {
        await new Promise((resolve, reject) => {
            yauzl.open(uploadPath, { lazyEntries: true, decodeStrings: true }, (openError, zipfile) => {
                if (openError) {
                    reject(openError);
                    return;
                }

                let finished = false;
                const finish = (error) => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                zipfile.readEntry();

                zipfile.on('entry', (entry) => {
                    (async () => {
                        const normalized = normalizeRestoreArchiveEntryPath(entry.fileName);
                        if (!normalized) {
                            zipfile.readEntry();
                            return;
                        }

                        if (entry.fileName.endsWith('/')) {
                            zipfile.readEntry();
                            return;
                        }

                        const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                        if (unixFileType === 0o120000) {
                            zipfile.readEntry();
                            return;
                        }

                        const targetMapping = analysis.targetByNormalizedEntry.get(normalized);
                        if (!targetMapping) {
                            zipfile.readEntry();
                            return;
                        }

                        const targetPath = targetMapping.targetPath;
                        ensureDirectory(path.dirname(targetPath));

                        zipfile.openReadStream(entry, async (streamError, readStream) => {
                            if (streamError) {
                                finish(streamError);
                                return;
                            }

                            try {
                                await pipeline(readStream, fs.createWriteStream(targetPath, { mode: 0o644 }));
                                const zipLastModified = typeof entry.getLastModDate === 'function'
                                    ? entry.getLastModDate()
                                    : null;
                                if (zipLastModified instanceof Date && !Number.isNaN(zipLastModified.getTime())) {
                                    try {
                                        await fsPromises.utimes(targetPath, zipLastModified, zipLastModified);
                                    } catch {
                                        // Non-fatal: keep restored content even if timestamp restore fails.
                                    }
                                }
                                result.restoredCount += 1;
                                if (targetMapping.category && result.preflight.categoryStats[targetMapping.category]) {
                                    result.preflight.categoryStats[targetMapping.category].restoredEntries += 1;
                                }
                                zipfile.readEntry();
                            } catch (error) {
                                result.failedCount += 1;
                                if (targetMapping.category && result.preflight.categoryStats[targetMapping.category]) {
                                    result.preflight.categoryStats[targetMapping.category].failedEntries += 1;
                                }
                                addRestoreReportSample(result.preflight, normalized, `write_failed:${error instanceof Error ? error.message : String(error)}`);
                                finish(error);
                            }
                        });
                    })().catch(finish);
                });

                zipfile.on('end', () => finish());
                zipfile.on('close', () => finish());
                zipfile.on('error', finish);
            });
        });

        if (mode === 'overwrite') {
            await discardRestoreSnapshots(snapshots);
        }
    } catch (extractError) {
        if (mode === 'overwrite' && snapshots.length > 0) {
            const orphaned = await rollbackRestoreSnapshots(snapshots);
            const baseMessage = extractError instanceof Error ? extractError.message : String(extractError);
            if (orphaned.length > 0) {
                const paths = orphaned.map(snap => snap.snapshot).join(', ');
                throw new Error(`Restore failed; previous data partially rolled back from snapshot. Manual recovery required for: ${paths}. Original error: ${baseMessage}`);
            }
            throw new Error(`Restore failed; previous data restored from snapshot. Original error: ${baseMessage}`);
        }
        throw extractError;
    }

    if (result.preflight.targetableEntries === 0 && mode !== 'overwrite') {
        addRestoreReportSample(result.preflight, '(archive)', 'no_restorable_entries_detected');
    }

    return result;
}

export const router = express.Router();

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        request.session.handle = null;
        request.session.csrfToken = null;
        request.session.version = null;
        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }

        const user = request.user.profile;
        const viewModel = {
            handle: user.handle,
            name: user.name,
            avatar: await getUserAvatar(user.handle),
            admin: user.admin,
            password: !!user.password,
            created: user.created,
        };

        return response.json(viewModel);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // Avatar is not a data URL or not an empty string
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        await storage.setItem(toAvatarKey(request.body.handle), request.body.avatar);

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (!request.user.profile.admin && user.password && user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
            console.error('Change password failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
        } else {
            user.password = '';
            user.salt = '';
        }

        await storage.setItem(toKey(request.body.handle), user);

        // Update session version to keep the current session valid after password change
        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/backup', async (request, response) => {
    try {
        const allowFullDataBackup = !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');

        if (!allowFullDataBackup) {
            console.warn('Backup failed: Full data backup is disabled in configuration');
            return response.status(403).json({ error: 'Full data backup is disabled' });
        }

        const handle = request.body.handle;

        if (!handle) {
            console.warn('Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const parsedSelection = parseBackupSelectionPayload(request.body.selection);
        const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one backup category must be selected.' });
        }

        await createBackupArchive(handle, response, selection, { includeGlobalExtensions: isAdminUser });
    } catch (error) {
        console.error('Backup failed', error);
        return response.sendStatus(500);
    }
});

router.get('/backup', async (request, response) => {
    try {
        const handle = String(request.query.handle || '').trim();

        if (!handle) {
            console.warn('Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const parsedSelection = parseBackupSelectionPayload(request.query.selection);
        const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one backup category must be selected.' });
        }

        await createBackupArchive(handle, response, selection, { includeGlobalExtensions: isAdminUser });
    } catch (error) {
        console.error('Backup failed', error);
        return response.sendStatus(500);
    }
});

router.post('/lan-migration/offer', async (request, response) => {
    try {
        const handle = String(request.body?.handle || '').trim();
        if (!handle) {
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const parsedSelection = parseBackupSelectionPayload(request.body.selection);
        const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one backup category must be selected.' });
        }

        const { token, expiresAt } = createLanMigrationOffer({
            handle,
            selection,
            includeGlobalExtensions: isAdminUser,
        });
        const baseUrl = trimTrailingSlash(getRequestBaseUrl(request));
        const url = `${baseUrl}${LAN_MIGRATION_PATH_PREFIX}${token}`;
        return response.json({ url, expiresAt });
    } catch (error) {
        console.error('LAN migration offer failed', error);
        return response.sendStatus(500);
    }
});

router.post('/restore-backup', async (request, response) => {
    let uploadPath = '';

    try {
        const handle = request.body.handle;
        if (!handle) {
            console.warn('Restore failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Restore failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        if (!request.file) {
            return response.status(400).json({ error: 'No backup file uploaded' });
        }

        const originalName = String(request.file.originalname || '');
        if (!originalName.toLowerCase().endsWith('.zip')) {
            return response.status(400).json({ error: 'Backup file must be a .zip archive' });
        }

        uploadPath = request.file.path;
        const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite' ? 'overwrite' : 'merge';

        let parsedSelection = request.body.selection;
        if (typeof parsedSelection === 'string' && parsedSelection.trim()) {
            try {
                parsedSelection = JSON.parse(parsedSelection);
            } catch {
                parsedSelection = {};
            }
        }

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one restore category must be selected.' });
        }

        const directories = handle === request.user.profile.handle ? request.user.directories : getUserDirectories(handle);
        const restoreResult = await restoreUserBackupArchive(uploadPath, directories, selection, mode, { includeGlobalExtensions: isAdminUser });
        await invalidateRecentChatIndex(request);

        return response.json({
            mode,
            ...restoreResult,
        });
    } catch (error) {
        console.error('Restore failed', error);
        const message = error?.message || 'Restore failed';
        const statusCode = message.includes('Archive does not match selected restore categories') ? 400 : 500;
        return response.status(statusCode).json({ error: message });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/lan-migration/import', async (request, response) => {
    let downloadPath = '';

    try {
        const handle = String(request.body?.handle || '').trim();
        if (!handle) {
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const rawUrl = String(request.body?.url || '').trim();
        if (!rawUrl) {
            return response.status(400).json({ error: 'No migration link provided' });
        }

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const selection = sanitizeBackupSelectionForUser(parseBackupSelectionPayload(request.body.selection), isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one restore category must be selected.' });
        }

        const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite' ? 'overwrite' : 'merge';
        const sourceUrl = await resolveLanMigrationSourceUrl(rawUrl);
        const uploadsPath = path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
        ensureDirectory(uploadsPath);
        downloadPath = path.join(uploadsPath, `lan-migration-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.zip`);

        await downloadLanMigrationArchive(sourceUrl.toString(), downloadPath);

        const directories = handle === request.user.profile.handle ? request.user.directories : getUserDirectories(handle);
        const restoreResult = await restoreUserBackupArchive(downloadPath, directories, selection, mode, { includeGlobalExtensions: isAdminUser });
        await invalidateRecentChatIndex(request);

        return response.json({
            mode,
            source: {
                origin: sourceUrl.origin,
                host: sourceUrl.host,
            },
            ...restoreResult,
        });
    } catch (error) {
        console.error('LAN migration import failed', error);
        const message = error?.message || 'LAN migration import failed';
        const isValidationError = message.includes('Migration link')
            || message.includes('No migration link provided')
            || message.includes('At least one restore category')
            || message.includes('Archive does not match selected restore categories')
            || message.includes('Failed to download migration archive');
        const statusCode = isValidationError ? 400 : 500;
        return response.status(statusCode).json({ error: message });
    } finally {
        if (downloadPath) {
            await fsPromises.rm(downloadPath, { force: true });
        }
    }
});

router.post('/import/data-zip', async (request, response) => {
    let uploadPath = '';

    try {
        if (!request.file) {
            return response.status(400).json({ error: 'No backup file uploaded' });
        }

        const originalName = String(request.file.originalname || '');
        if (!originalName.toLowerCase().endsWith('.zip')) {
            return response.status(400).json({ error: 'Backup file must be a .zip archive' });
        }

        uploadPath = request.file.path;
        const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite' ? 'overwrite' : 'merge';
        const restoreResult = await restoreUserBackupArchive(uploadPath, request.user.directories, FULL_IMPORT_SELECTION, mode, { includeGlobalExtensions: false });
        await invalidateRecentChatIndex(request);

        return response.json({
            mode,
            ...restoreResult,
        });
    } catch (error) {
        console.error('Data ZIP import failed', error);
        const message = error?.message || 'Data ZIP import failed';
        const statusCode = message.includes('Archive does not match selected restore categories') ? 400 : 500;
        return response.status(statusCode).json({ error: message });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body.password;

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            console.warn('Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        await fsPromises.rm(pathToFile, { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.name = request.body.name;
        await storage.setItem(toKey(request.body.handle), user);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const resetCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode));
        console.log();
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        if (!request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }

        const code = RESET_CACHE.get(request.user.profile.handle);

        if (!code || code !== request.body.code) {
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }

        console.info('Resetting account data:', request.user.profile.handle);
        await fsPromises.rm(request.user.directories.root, { recursive: true, force: true });

        await ensurePublicDirectoriesExist();
        await checkForNewContent([request.user.directories]);

        RESET_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/announcements/me/list', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }
        const multiUser = getConfigValue('enableUserAccounts', false, 'boolean');
        const handle = request.user.profile.handle;
        const userRecord = await storage.getItem(toKey(handle));
        const readIds = Array.isArray(userRecord?.readAnnouncementIds)
            ? userRecord.readAnnouncementIds
            : [];
        const result = await listForUser({ readIds });
        return response.json({ ...result, multiUser });
    } catch (error) {
        console.error('Announcements me/list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/announcements/me/mark-read', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
        const handle = request.user.profile.handle;
        const userRecord = await storage.getItem(toKey(handle));
        if (!userRecord) {
            return response.sendStatus(404);
        }
        const next = mergeReadIds({
            existing: userRecord.readAnnouncementIds,
            ids,
        });
        userRecord.readAnnouncementIds = next;
        await storage.setItem(toKey(handle), userRecord);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Announcements me/mark-read failed:', error);
        return response.sendStatus(500);
    }
});
