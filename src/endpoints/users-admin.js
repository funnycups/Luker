import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import yaml from 'yaml';
import yauzl from 'yauzl';
import {
    getAdminSettings,
    saveAdminSettings,
    getEffectiveUserQuotaBytes,
    getDirectorySizeBytes,
} from '../admin-settings.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
} from '../users.js';
import { DEFAULT_USER, PUBLIC_DIRECTORIES } from '../constants.js';
import { clearCapturedLogs, getCapturedLogs } from '../log-capture.js';
import {
    fetchLatestApkReleaseInfo,
    getGitUpdateStatus,
    startGitUpdate,
} from '../updater.js';
import {
    createAnnouncement,
    deleteAnnouncement,
    listAnnouncements,
    updateAnnouncement,
    ValidationError as AnnouncementValidationError,
} from '../announcements.js';
import { ensureDirectory, getConfigFilePath, getConfigValue, normalizeZipEntryPath, reloadConfigCache } from '../util.js';
import {
    installServerPlugin,
    listInstalledServerPlugins,
    removeServerPlugin,
    updateServerPlugin,
} from '../plugin-loader.js';
import { SERVER_PLUGINS_DIRECTORY } from '../constants.js';
import {
    getStorageEngine,
    initStorage,
    isReadOnly,
    setReadOnly,
} from '../storage/index.js';
import { FsEngine } from '../storage/engines/fs-engine.js';
import { SqliteEngine } from '../storage/engines/sqlite-engine.js';
import { MysqlEngine } from '../storage/engines/mysql-engine.js';
import { PgEngine } from '../storage/engines/postgres-engine.js';
import { ChatRepo } from '../storage/repositories/chat-repo.js';
import { SettingsRepo } from '../storage/repositories/settings-repo.js';
import { PresetRepo } from '../storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../storage/repositories/group-repo.js';
import { StatsRepo } from '../storage/repositories/stats-repo.js';
import { MigrationRunner } from '../storage/migration/runner.js';
import { acquireMigrationLock, releaseMigrationLock, makeHolderId, startHeartbeat, stopHeartbeat } from '../storage/migration/lock.js';
import { persistStorageBackendToConfig, resolveStorageDbConfig } from '../storage/config-persistence.js';
import {
    computeFingerprint,
    createState,
    shouldResume,
    pendingHandles,
    markStart,
    markStage,
    markDone,
    markFailed,
    isAllDone,
    serializeStatus,
} from '../storage/migration/state.js';

export const router = express.Router();

function sanitizeDefaultExtensionFolderName(name) {
    const base = String(name || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);
    return base || 'imported-extension';
}

function toGlobalExtensionRelativePath(normalizedEntryPath, defaultFolderName = '') {
    const normalized = String(normalizedEntryPath || '').replace(/^\/+/, '');
    if (!normalized) {
        return '';
    }

    const trimmed = normalized.replace(/^data\/[^/]+\/extensions\/third-party\//, '')
        .replace(/^public\/scripts\/extensions\/third-party\//, '')
        .replace(/^scripts\/extensions\/third-party\//, '')
        .replace(/^extensions\/third-party\//, '')
        .replace(/^third-party\//, '');

    const candidate = trimmed || normalized;
    if (!candidate || candidate.startsWith('.') || candidate.startsWith('..')) {
        return '';
    }

    if (!candidate.includes('/')) {
        const safeFolder = sanitizeDefaultExtensionFolderName(defaultFolderName);
        return `${safeFolder}/${candidate}`;
    }

    return candidate;
}

async function importGlobalExtensionsZip(uploadPath, originalName = '') {
    const targetRoot = path.resolve(PUBLIC_DIRECTORIES.globalExtensions);
    ensureDirectory(targetRoot);
    const defaultFolderName = sanitizeDefaultExtensionFolderName(path.parse(String(originalName || '')).name);

    const result = {
        importedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
    };

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
                    const normalized = normalizeZipEntryPath(entry.fileName);
                    if (!normalized) {
                        result.rejectedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    if (entry.fileName.endsWith('/')) {
                        zipfile.readEntry();
                        return;
                    }

                    const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                    if (unixFileType === 0o120000) {
                        result.rejectedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    const relativeTargetPath = toGlobalExtensionRelativePath(normalized, defaultFolderName);
                    if (!relativeTargetPath) {
                        result.skippedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    const targetPath = path.resolve(path.join(targetRoot, relativeTargetPath));
                    if (!(targetPath === targetRoot || targetPath.startsWith(targetRoot + path.sep))) {
                        result.rejectedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    ensureDirectory(path.dirname(targetPath));

                    zipfile.openReadStream(entry, async (streamError, readStream) => {
                        if (streamError) {
                            finish(streamError);
                            return;
                        }

                        try {
                            await pipeline(readStream, fs.createWriteStream(targetPath, { mode: 0o644 }));
                            result.importedCount += 1;
                            zipfile.readEntry();
                        } catch (error) {
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

    return result;
}

router.post('/logs/get', requireAdminMiddleware, async (request, response) => {
    try {
        const parsedLimit = Number(request.body?.limit);
        const parsedSinceId = Number(request.body?.sinceId);
        const rawStartTime = request.body?.startTime;
        const rawEndTime = request.body?.endTime;
        const searchTerm = String(request.body?.searchTerm || '').trim();
        const parsedStartTime = rawStartTime === null || rawStartTime === undefined || rawStartTime === '' ? NaN : Number(rawStartTime);
        const parsedEndTime = rawEndTime === null || rawEndTime === undefined || rawEndTime === '' ? NaN : Number(rawEndTime);
        const limit = Number.isFinite(parsedLimit) ? Math.min(5000, Math.max(1, Math.floor(parsedLimit))) : 800;
        const sinceId = Number.isFinite(parsedSinceId) ? Math.max(0, Math.floor(parsedSinceId)) : 0;
        const startTime = Number.isFinite(parsedStartTime) ? Math.max(0, Math.floor(parsedStartTime)) : undefined;
        const endTime = Number.isFinite(parsedEndTime) ? Math.max(0, Math.floor(parsedEndTime)) : undefined;
        const levels = Array.isArray(request.body?.levels) ? request.body.levels : undefined;

        const result = getCapturedLogs({ sinceId, limit, levels, startTime, endTime, searchTerm });
        return response.json(result);
    } catch (error) {
        console.error('Admin logs get failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/logs/clear', requireAdminMiddleware, async (_request, response) => {
    try {
        clearCapturedLogs();
        return response.sendStatus(204);
    } catch (error) {
        console.error('Admin logs clear failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/update/status', requireAdminMiddleware, async (request, response) => {
    try {
        const parsedSinceId = Number(request.body?.sinceId);
        const parsedLimit = Number(request.body?.limit);
        const sinceId = Number.isFinite(parsedSinceId) ? Math.max(0, Math.floor(parsedSinceId)) : 0;
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.floor(parsedLimit)) : undefined;

        return response.json({
            git: getGitUpdateStatus({ sinceId, limit }),
        });
    } catch (error) {
        console.error('Update status failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/update/start', requireAdminMiddleware, async (_request, response) => {
    try {
        const result = startGitUpdate();
        if (!result.started) {
            return response.status(409).json({ error: String(result.reason || 'already_running'), ...result });
        }
        return response.status(202).json(result);
    } catch (error) {
        console.error('Start update failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/update/apk-latest', requireAdminMiddleware, async (_request, response) => {
    try {
        const release = await fetchLatestApkReleaseInfo();
        return response.json(release);
    } catch (error) {
        console.error('APK latest release fetch failed:', error);
        return response.status(400).json({ error: String(error?.message || error) });
    }
});

router.post('/overview', requireAdminMiddleware, async (_request, response) => {
    try {
        const adminSettings = await getAdminSettings();

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        const usersWithStats = await Promise.all(users.map(async user => {
            const directories = getUserDirectories(user.handle);
            const storageBytes = await getDirectorySizeBytes(directories.root);
            const effectiveQuotaBytes = getEffectiveUserQuotaBytes(user, adminSettings);

            return {
                handle: user.handle,
                name: user.name,
                admin: user.admin,
                enabled: user.enabled,
                password: Boolean(user.password),
                created: user.created,
                storageBytes: storageBytes,
                storageQuotaBytes: effectiveQuotaBytes,
                storageUsageRatio: effectiveQuotaBytes >= 0 ? storageBytes / Math.max(effectiveQuotaBytes, 1) : null,
            };
        }));

        usersWithStats.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));

        const totals = {
            users: usersWithStats.length,
            enabledUsers: usersWithStats.filter(x => x.enabled).length,
            adminUsers: usersWithStats.filter(x => x.admin).length,
            protectedUsers: usersWithStats.filter(x => x.password).length,
            storageBytes: usersWithStats.reduce((acc, user) => acc + user.storageBytes, 0),
            overQuotaUsers: usersWithStats.filter(x => x.storageQuotaBytes >= 0 && x.storageBytes > x.storageQuotaBytes).length,
        };

        const security = {
            adminWithoutPassword: usersWithStats.filter(x => x.admin && !x.password).map(x => x.handle),
            disabledAdmins: usersWithStats.filter(x => x.admin && !x.enabled).map(x => x.handle),
            disabledUsers: usersWithStats.filter(x => !x.enabled).map(x => x.handle),
        };

        return response.json({
            server: {
                nodeVersion: process.version,
                platform: process.platform,
                uptimeSec: Math.floor(process.uptime()),
                now: Date.now(),
            },
            totals,
            settings: adminSettings,
            users: usersWithStats,
            security,
        });
    } catch (error) {
        console.error('Admin overview failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/settings/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const settings = await getAdminSettings();
        return response.json(settings);
    } catch (error) {
        console.error('Admin settings get failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/settings/save', requireAdminMiddleware, async (request, response) => {
    try {
        const saved = await saveAdminSettings(request.body || {});
        return response.json(saved);
    } catch (error) {
        console.error('Admin settings save failed:', error);
        return response.sendStatus(500);
    }
});

function resolveYamlBool(rawValue, defaultValue) {
    if (rawValue === undefined || rawValue === null) {
        return defaultValue;
    }
    const lower = String(rawValue).trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return rawValue;
}

function readYamlBool(rawValue, defaultValue) {
    const resolved = resolveYamlBool(rawValue, defaultValue);
    return typeof resolved === 'boolean' ? resolved : defaultValue;
}

/**
 * Reject configs whose resolved values would crash the server on next startup.
 * Mirrors the exit-on-bad-config checks in src/users.js (verifySecuritySettings)
 * and src/server-main.js (IPv4/IPv6 guard) so a save in the admin UI cannot
 * leave the instance in a state that refuses to boot.
 * @param {unknown} parsed Parsed YAML root
 * @returns {{ codes: string[], errors: string[] }} Machine-readable codes for the
 *   frontend i18n layer, plus English fallback messages for non-UI clients.
 */
function validateConfigSafety(parsed) {
    if (!parsed || typeof parsed !== 'object') return { codes: [], errors: [] };
    const codes = [];
    const errors = [];

    const listen = readYamlBool(parsed.listen, false);
    if (listen) {
        const whitelistMode = readYamlBool(parsed.whitelistMode, true);
        const basicAuthMode = readYamlBool(parsed.basicAuthMode, false);
        const enableUserAccounts = readYamlBool(parsed.enableUserAccounts, false);
        const securityOverride = readYamlBool(parsed.securityOverride, false);
        if (!whitelistMode && !basicAuthMode && !enableUserAccounts && !securityOverride) {
            codes.push('CONFIG_UNSAFE_NO_AUTH');
            errors.push(
                'Refusing to save: "listen" is enabled but every auth layer is off. ' +
                'Enable at least one of "whitelistMode", "basicAuthMode", or "enableUserAccounts" ' +
                '(or set "securityOverride: true" to opt out). ' +
                'Saving this config would cause the server to exit on next startup.',
            );
        }
    }

    const protocol = parsed.protocol;
    const ipv4Raw = protocol && typeof protocol === 'object' ? protocol.ipv4 : undefined;
    const ipv6Raw = protocol && typeof protocol === 'object' ? protocol.ipv6 : undefined;
    const ipv4 = resolveYamlBool(ipv4Raw, true);
    const ipv6 = resolveYamlBool(ipv6Raw, false);
    if (ipv4 === false && ipv6 === false) {
        codes.push('CONFIG_UNSAFE_NO_PROTOCOL');
        errors.push(
            'Refusing to save: both "protocol.ipv4" and "protocol.ipv6" are disabled. ' +
            'At least one must be enabled (or set to "auto") or the server will exit on next startup.',
        );
    }

    return { codes, errors };
}

router.post('/config/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const configPath = getConfigFilePath();
        if (!configPath) {
            return response.status(500).json({ error: 'Config path not initialized' });
        }

        const content = await fsPromises.readFile(configPath, 'utf8');
        return response.json({ path: configPath, content });
    } catch (error) {
        console.error('Config get failed:', error);
        return response.status(500).json({ error: String(error?.message || error) });
    }
});

router.post('/config/save', requireAdminMiddleware, async (request, response) => {
    try {
        const content = request.body?.content;
        if (typeof content !== 'string') {
            return response.status(400).json({ error: 'Missing config content' });
        }

        const configPath = getConfigFilePath();
        if (!configPath) {
            return response.status(500).json({ error: 'Config path not initialized' });
        }

        const parsedConfig = yaml.parse(content);
        const { codes: safetyCodes, errors: safetyErrors } = validateConfigSafety(parsedConfig);
        if (safetyCodes.length > 0) {
            return response.status(400).json({ error: safetyErrors.join(' '), codes: safetyCodes });
        }
        await fsPromises.writeFile(configPath, content, 'utf8');
        reloadConfigCache();

        return response.json({
            ok: true,
            hotReloadApplied: true,
            restartRecommended: true,
        });
    } catch (error) {
        if (error instanceof Error && error.name.startsWith('YAML')) {
            return response.status(400).json({ error: error.message });
        }
        console.error('Config save failed:', error);
        return response.status(500).json({ error: String(error?.message || error) });
    }
});

router.post('/import/config', requireAdminMiddleware, async (request, response) => {
    let uploadPath = '';

    try {
        if (!request.file) {
            return response.status(400).json({ error: 'No config file uploaded' });
        }
        uploadPath = request.file.path;

        const content = await fsPromises.readFile(uploadPath, 'utf8');
        const parsedConfig = yaml.parse(content);
        const { codes: safetyCodes, errors: safetyErrors } = validateConfigSafety(parsedConfig);
        if (safetyCodes.length > 0) {
            return response.status(400).json({ error: safetyErrors.join(' '), codes: safetyCodes });
        }

        const configPath = getConfigFilePath();
        if (!configPath) {
            return response.status(500).json({ error: 'Config path not initialized' });
        }

        await fsPromises.writeFile(configPath, content, 'utf8');
        reloadConfigCache();

        return response.json({
            ok: true,
            path: configPath,
            hotReloadApplied: true,
            restartRecommended: true,
        });
    } catch (error) {
        if (error instanceof Error && error.name.startsWith('YAML')) {
            return response.status(400).json({ error: error.message });
        }
        console.error('Config import failed:', error);
        return response.status(500).json({ error: String(error?.message || error) });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/import/global-extensions', requireAdminMiddleware, async (request, response) => {
    let uploadPath = '';

    try {
        if (!request.file) {
            return response.status(400).json({ error: 'No extensions ZIP uploaded' });
        }

        const originalName = String(request.file.originalname || '').trim();
        const lowerName = originalName.toLowerCase();
        if (lowerName.includes('.') && !lowerName.endsWith('.zip')) {
            return response.status(400).json({ error: 'Extensions file must be a .zip archive' });
        }

        uploadPath = request.file.path;
        const result = await importGlobalExtensionsZip(uploadPath, originalName);

        return response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        console.error('Global extensions import failed:', error);
        return response.status(500).json({ error: String(error?.message || error) });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/plugins/list', requireAdminMiddleware, async (_request, response) => {
    try {
        const plugins = await listInstalledServerPlugins(SERVER_PLUGINS_DIRECTORY);
        const enabled = !!getConfigValue('enableServerPlugins', false, 'boolean');

        return response.json({
            ok: true,
            enabled,
            pluginsPath: path.resolve(SERVER_PLUGINS_DIRECTORY),
            plugins,
        });
    } catch (error) {
        console.error('Server plugin list failed:', error);
        return response.status(500).json({ error: String(error?.message || error) });
    }
});

router.post('/plugins/install', requireAdminMiddleware, async (request, response) => {
    try {
        const repoUrl = String(request.body?.repoUrl || '').trim();
        if (!repoUrl) {
            return response.status(400).json({ error: 'Missing plugin repository URL' });
        }

        const plugin = await installServerPlugin(SERVER_PLUGINS_DIRECTORY, repoUrl);
        const enabled = !!getConfigValue('enableServerPlugins', false, 'boolean');

        return response.json({
            ok: true,
            enabled,
            restartRecommended: true,
            plugin,
        });
    } catch (error) {
        console.error('Server plugin install failed:', error);
        const statusCode = Number(error?.statusCode);
        const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
        return response.status(status).json({ error: String(error?.message || error) });
    }
});

router.post('/plugins/update', requireAdminMiddleware, async (request, response) => {
    try {
        const directory = String(request.body?.directory || '').trim();
        if (!directory) {
            return response.status(400).json({ error: 'Missing plugin directory name' });
        }

        const plugin = await updateServerPlugin(SERVER_PLUGINS_DIRECTORY, directory);

        return response.json({
            ok: true,
            restartRecommended: true,
            plugin,
        });
    } catch (error) {
        console.error('Server plugin update failed:', error);
        const statusCode = Number(error?.statusCode);
        const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
        return response.status(status).json({ error: String(error?.message || error) });
    }
});

router.post('/plugins/delete', requireAdminMiddleware, async (request, response) => {
    try {
        const directory = String(request.body?.directory || '').trim();
        if (!directory) {
            return response.status(400).json({ error: 'Missing plugin directory name' });
        }

        const plugin = await removeServerPlugin(SERVER_PLUGINS_DIRECTORY, directory);

        return response.json({
            ok: true,
            restartRecommended: true,
            plugin,
        });
    } catch (error) {
        console.error('Server plugin delete failed:', error);
        const statusCode = Number(error?.statusCode);
        const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
        return response.status(status).json({ error: String(error?.message || error) });
    }
});

router.post('/set-quota', requireAdminMiddleware, async (request, response) => {
    try {
        const handle = String(request.body?.handle || '').trim();
        if (!handle) {
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(handle));
        if (!user) {
            return response.status(404).json({ error: 'User not found' });
        }

        const rawQuota = request.body?.storageQuotaBytes;
        const parsed = Number(rawQuota);
        if (rawQuota === null || rawQuota === '' || rawQuota === undefined || !Number.isFinite(parsed) || parsed < 0) {
            delete user.storageQuotaBytes;
        } else {
            user.storageQuotaBytes = Math.floor(parsed);
        }

        await storage.setItem(toKey(handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Set user quota failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * Slugifies a given text string.
 * - Converts to lowercase
 * - Trims whitespace
 * - Replaces spaces and special characters with hyphens
 * - Removes leading and trailing hyphens
 * - Uses lodash.deburr to remove diacritical marks
 * @param {string} text Text to slugify
 * @returns {string} Slugified text
 */
function slugify(text) {
    return lodash.deburr(String(text ?? '').toLowerCase().trim()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

router.post('/get', requireAdminMiddleware, async (_request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .map(user => new Promise(resolve => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        avatar: avatar,
                        admin: user.admin,
                        enabled: user.enabled,
                        created: user.created,
                        password: !!user.password,
                        storageQuotaBytes: Number.isFinite(Number(user.storageQuotaBytes)) ? Number(user.storageQuotaBytes) : null,
                        oauthProviders: Object.keys(user.oauth || {}),
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            console.warn('Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handles = await getAllUserHandles();
        const handle = slugify(request.body.handle);

        if (!handle) {
            console.warn('Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            console.warn('Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';
        const adminSettings = await getAdminSettings();
        const defaultQuotaBytes = Number(adminSettings?.storage?.defaultUserQuotaBytes);

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
            storageQuotaBytes: Number.isFinite(defaultQuotaBytes) && defaultQuotaBytes >= 0 ? Math.floor(defaultQuotaBytes) : undefined,
        };

        await storage.setItem(toKey(handle), newUser);

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        return response.json({ handle: newUser.handle });
    } catch (error) {
        console.error('User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            console.warn('Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        await storage.removeItem(toKey(request.body.handle));

        // Order: keyv first (admin can no longer log in even if a later step
        // throws), then engine rows, then the optional fs.rm dir wipe. If
        // engine.deleteUser throws after the keyv removal, the user is
        // half-deleted (auth gone, engine rows survive). engine.deleteUser
        // is idempotent on every engine (fs/sqlite are no-ops per design
        // spec §4.1 / §5.3; mysql/postgres run a transactional sweep and
        // already have ECONNRESET/deadlock retry baked in), so an admin
        // can simply re-POST /delete to complete the cleanup. The engine
        // call runs BEFORE the optional fs.rm so sqlite can close+evict
        // its cached Database handle without racing the directory rm.
        await getStorageEngine().deleteUser(request.body.handle);

        if (request.body.purge) {
            const directories = getUserDirectories(request.body.handle);
            console.info('Deleting data directories for', request.body.handle);
            await fsPromises.rm(directories.root, { recursive: true, force: true });
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            console.warn('Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const text = slugify(request.body.text);

        return response.send(text);
    } catch (error) {
        console.error('Slugify failed:', error);
        return response.sendStatus(500);
    }
});

function respondAnnouncementError(error, response) {
    if (error instanceof AnnouncementValidationError) {
        return response.status(400).json({ error: error.message });
    }
    console.error('Announcement endpoint failed:', error);
    return response.status(500).json({ error: 'internal' });
}

router.post('/announcements/list', requireAdminMiddleware, async (_request, response) => {
    try {
        const items = await listAnnouncements();
        return response.json({ items });
    } catch (error) {
        return respondAnnouncementError(error, response);
    }
});

router.post('/announcements/create', requireAdminMiddleware, async (request, response) => {
    try {
        const body = request.body || {};
        const item = await createAnnouncement({
            level: body.level,
            title: body.title,
            body: body.body,
            createdBy: request.user?.profile?.handle || 'admin',
        });
        return response.json({ item });
    } catch (error) {
        return respondAnnouncementError(error, response);
    }
});

router.post('/announcements/update', requireAdminMiddleware, async (request, response) => {
    try {
        const body = request.body || {};
        if (typeof body.id !== 'string' || !body.id) {
            return response.status(400).json({ error: 'id is required' });
        }
        const item = await updateAnnouncement({
            id: body.id,
            level: body.level,
            title: body.title,
            body: body.body,
        });
        if (item === null) {
            return response.status(404).json({ error: 'not found' });
        }
        return response.json({ item });
    } catch (error) {
        return respondAnnouncementError(error, response);
    }
});

router.post('/announcements/delete', requireAdminMiddleware, async (request, response) => {
    try {
        const body = request.body || {};
        if (typeof body.id !== 'string' || !body.id) {
            return response.status(400).json({ error: 'id is required' });
        }
        const ok = await deleteAnnouncement({ id: body.id });
        if (!ok) return response.status(404).json({ error: 'not found' });
        return response.sendStatus(204);
    } catch (error) {
        return respondAnnouncementError(error, response);
    }
});

// ----------------------------------------------------------------------------
// Storage engine status / migration (Phase 3)
// ----------------------------------------------------------------------------
//
// Two admin endpoints back the migration UI / CLI. They live in this file so
// they pick up `requireAdminMiddleware` automatically (same pattern as the
// existing /storage/* user-account endpoints above).
//
// Concurrency model: a module-level `_migrationState` object holds resume
// state for the in-flight migration (or null if none is running) and blocks
// overlapping migrations whose target fingerprint differs. The migration
// itself is synchronous from the HTTP caller's perspective — we don't return
// until the per-user copy + verify pass is done. That matches the Phase 3
// simplification (no SSE / progress stream). The endpoint flips the global
// read-only flag via setReadOnly() for the duration; the storage error
// middleware turns the resulting StorageReadOnlyError from concurrent writers
// into a 503.

let _migrationState = null;
let _lastMigrationAt = null;

/**
 * Return the current engine mode by inspecting the live engine instance.
 * Each engine sets `this.kind = '<mode>'` in its constructor; we read that
 * rather than chaining instanceof checks so the list of supported modes
 * stays in one place (the engine classes themselves).
 */
function detectCurrentMode() {
    const engine = getStorageEngine();
    const kind = engine?.kind;
    if (kind === 'fs' || kind === 'sqlite' || kind === 'mysql' || kind === 'postgres') {
        return kind;
    }
    return 'unknown';
}

function buildRepos(engine) {
    return {
        chat: new ChatRepo({ engine }),
        settings: new SettingsRepo({ engine }),
        preset: new PresetRepo({ engine }),
        worldInfo: new WorldInfoRepo({ engine }),
        namedDoc: new NamedDocRepo({ engine }),
        group: new GroupRepo({ engine }),
        stats: new StatsRepo({ engine }),
    };
}

router.post('/storage/status', requireAdminMiddleware, async (_request, response) => {
    return response.send({
        currentMode: detectCurrentMode(),
        migrationInProgress: _migrationState != null,
        readOnly: isReadOnly(),
        lastMigration: _lastMigrationAt,
        state: serializeStatus(_migrationState, Date.now()),
    });
});

router.post('/storage/migrate', requireAdminMiddleware, async (request, response) => {
    const targetMode = request.body?.targetMode;
    const SUPPORTED_MODES = ['fs', 'sqlite', 'mysql', 'postgres'];
    if (!SUPPORTED_MODES.includes(targetMode)) {
        return response.status(400).send({
            error: 'invalid_target_mode',
            message: `targetMode must be one of: ${SUPPORTED_MODES.join(', ')}`,
        });
    }

    // For shared-DB engines (mysql, postgres) the request body may carry
    // connection credentials; if absent, fall back to config.yaml so an
    // operator who has already filled storage.{mysql,postgres} in the
    // config file can trigger migration without re-typing the URL.
    // resolveStorageDbConfig tracks which fields came from the body so
    // persistStorageBackendToConfig only rewrites the ones the operator
    // actually typed.
    function resolveDbConfig(mode) {
        return resolveStorageDbConfig({
            inline: request.body?.[mode],
            fromConfig: getConfigValue(`storage.${mode}`, null),
        });
    }

    let mysqlResolved = null;
    let postgresResolved = null;
    if (targetMode === 'mysql') {
        mysqlResolved = resolveDbConfig('mysql');
        if (!mysqlResolved) {
            return response.status(400).send({
                error: 'mysql_config_missing',
                message: 'mode=mysql requires storage.mysql.url (in request body or config.yaml)',
            });
        }
    }
    if (targetMode === 'postgres') {
        postgresResolved = resolveDbConfig('postgres');
        if (!postgresResolved) {
            return response.status(400).send({
                error: 'postgres_config_missing',
                message: 'mode=postgres requires storage.postgres.url (in request body or config.yaml)',
            });
        }
    }
    const mysqlConfig = mysqlResolved?.engine ?? null;
    const postgresConfig = postgresResolved?.engine ?? null;

    const sourceMode = detectCurrentMode();
    if (sourceMode === targetMode && _migrationState == null) {
        return response.status(400).send({
            error: 'already_in_target_mode',
            currentMode: sourceMode,
        });
    }

    const fingerprint = computeFingerprint({ targetMode, mysqlConfig, postgresConfig });
    const decision = shouldResume(_migrationState, fingerprint);
    if (decision.kind === 'conflict') {
        return response.status(409).send({
            error: 'migration_in_progress_different_target',
            message: 'a different migration target is already in progress; POST /storage/migrate/reset to clear',
            currentTargetMode: _migrationState.targetMode,
        });
    }

    const dataRoot = globalThis.DATA_ROOT;
    if (!dataRoot) {
        return response.status(500).send({
            error: 'data_root_missing',
            message: 'globalThis.DATA_ROOT is not set; server bootstrap incomplete',
        });
    }
    const backupRoot = path.join(dataRoot, '_storage-migrations');

    // Cross-process lock (spec §C item 6): refuse the request if another
    // process (a parallel admin call, or the CLI in `scripts/storage-migrate.js`)
    // is already migrating against the same dataRoot. Without this guard the
    // two would race on the source→dest copy and the engine swap. Acquired
    // here — after dataRoot is known but before any per-user work — so a
    // contended request never touches user state.
    const lockHolderId = makeHolderId();
    try {
        await acquireMigrationLock({ dataRoot, holderId: lockHolderId });
    } catch (lockErr) {
        return response.status(409).send({
            error: 'migration_locked',
            message: lockErr?.message || String(lockErr),
        });
    }

    // Heartbeat (spec §4.5): a real migration can run well past the 60s
    // default TTL — a multi-user dataRoot with large worldbooks routinely
    // does. Without a refresh loop the lock would expire mid-migration and
    // a competing acquirer could evict us between per-user steps. Started
    // here (after acquire succeeded, so we never arm a timer that races a
    // 409 return) and stopped in the matching `finally` below.
    const heartbeat = startHeartbeat({ dataRoot, holderId: lockHolderId });

    let destEngine;
    try {
        const handles = await getAllUserHandles();
        if (decision.kind === 'fresh') {
            _migrationState = createState({
                targetMode, fingerprint, handles, now: new Date().toISOString(),
            });
        } else {
            // Resume: detect users registered since the original attempt to avoid
            // silently dropping them on the dest swap. Operator must reset and retry.
            const knownHandles = new Set(Object.keys(_migrationState.perUser));
            const newHandles = handles.filter(h => !knownHandles.has(h));
            if (newHandles.length > 0) {
                return response.status(409).send({
                    error: 'migration_handles_changed',
                    message: 'new users registered since the original migration attempt; POST /storage/migrate/reset and retry',
                    newHandles,
                });
            }
        }

        const sourceEngine = getStorageEngine();
        if (targetMode === 'sqlite') {
            destEngine = new SqliteEngine({ directoriesByHandle: getUserDirectories });
        } else if (targetMode === 'fs') {
            destEngine = new FsEngine({ directoriesByHandle: getUserDirectories });
        } else if (targetMode === 'mysql') {
            destEngine = new MysqlEngine(mysqlConfig);
        } else {
            destEngine = new PgEngine(postgresConfig);
        }

        const runner = new MigrationRunner({
            sourceRepos: buildRepos(sourceEngine),
            sourceEngine,
            destRepos: buildRepos(destEngine),
            snapshotPaths: {
                dataRoot,
                backupRoot,
                getUserRoot: (h) => getUserDirectories(h).root,
            },
        });

        const startedAt = Date.now();
        const toRun = pendingHandles(_migrationState);

        setReadOnly(true);
        try {
            for (const handle of toRun) {
                markStart(_migrationState, handle, new Date().toISOString());
                try {
                    const onProgress = (event) => {
                        // Each runner-emitted stage carries (stage, counts) so
                        // /storage/status surfaces per-user progress while the
                        // migration is mid-flight.
                        markStage(_migrationState, handle, {
                            stage: event?.stage ?? null,
                            counts: event?.counts ?? null,
                        }, new Date().toISOString());
                    };
                    const stats = await runner.migrateUser(handle, { onProgress });
                    markDone(_migrationState, handle, new Date().toISOString(), {
                        settings: stats.settings,
                        presets: stats.presets,
                        preset_states: stats.preset_states,
                        worlds: stats.worlds,
                        chats: stats.chats,
                        chat_states: stats.chat_states,
                        named_docs: stats.named_docs,
                        groups: stats.groups,
                        stats: stats.stats,
                    });
                } catch (err) {
                    markFailed(_migrationState, handle, err?.message || String(err), new Date().toISOString());
                    console.error(`Storage migration error for ${handle}:`, err);
                }
            }
        } finally {
            setReadOnly(false);
        }

        if (!isAllDone(_migrationState)) {
            if (destEngine?.close) {
                try { await destEngine.close(); } catch { /* best-effort */ }
            }
            return response.status(500).send({
                ok: false,
                perUser: _migrationState.perUser,
                durationMs: Date.now() - startedAt,
                currentMode: sourceMode,
                message: 'one or more users failed to migrate; source engine retained, run POST /storage/migrate again to resume',
            });
        }

        // All users done — swap engine + persist config.
        const oldEngine = sourceEngine;
        initStorage({
            mode: targetMode,
            directoriesByHandle: getUserDirectories,
            mysql: mysqlConfig,
            postgres: postgresConfig,
        });
        if (oldEngine?.close) {
            try { await oldEngine.close(); } catch { /* best-effort */ }
        }
        _lastMigrationAt = new Date().toISOString();
        const finalPerUser = _migrationState.perUser;
        _migrationState = null;

        const persistResult = await persistStorageBackendToConfig({
            configPath: getConfigFilePath(),
            safetyCheck: validateConfigSafety,
            targetMode,
            mysqlInline: mysqlResolved?.inlineFields ?? null,
            postgresInline: postgresResolved?.inlineFields ?? null,
        });
        if (persistResult.ok) {
            reloadConfigCache();
        } else {
            console.error('Storage config persist failed:', persistResult.error);
        }

        return response.send({
            ok: true,
            perUser: finalPerUser,
            durationMs: Date.now() - startedAt,
            currentMode: targetMode,
            configPersisted: persistResult.ok,
            configPersistError: persistResult.ok ? undefined : persistResult.error,
        });
    } catch (err) {
        console.error('Storage migration failed:', err);
        if (destEngine?.close) {
            try { await destEngine.close(); } catch { /* best-effort */ }
        }
        return response.status(500).send({
            error: 'migration_error',
            message: err?.message || String(err),
        });
    } finally {
        // Always release the lock, whether the migration ran to completion,
        // returned a 500 partial-failure, threw, or short-circuited via an
        // early `return response.status(...)` from inside the try. Release
        // is conditional on holder match so it's safe even in the
        // pathological case of a TTL-eviction overlap.
        //
        // Stop the heartbeat first — clearing the interval before release
        // means we can't race ourselves (a tick already fired but mid-acquire
        // would re-write the lockfile after release rms it). `stopHeartbeat`
        // is null-safe so this is fine even if we never got that far.
        stopHeartbeat(heartbeat);
        await releaseMigrationLock({ dataRoot, holderId: lockHolderId });
    }
});

router.post('/storage/migrate/reset', requireAdminMiddleware, async (request, response) => {
    if (request.body?.confirm !== true) {
        return response.status(400).send({
            error: 'reset_requires_confirm',
            message: 'pass { confirm: true } to reset in-memory migration state',
        });
    }
    _migrationState = null;
    setReadOnly(false);
    return response.send({ ok: true });
});
