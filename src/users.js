// Native Node Modules
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// Express and other dependencies
import storage from 'node-persist';
import express from 'express';
import mime from 'mime-types';
import archiver from 'archiver';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import ipMatching from 'ip-matching';

import { USER_DIRECTORY_TEMPLATE, DEFAULT_USER, PUBLIC_DIRECTORIES, SETTINGS_FILE, UPLOADS_DIRECTORY } from './constants.js';
import { getConfigValue, color, delay, generateTimestamp, invalidateFirefoxCache, Cache, formatBytes, resolvePathWithinParent, isPathUnderParent, setPermissionsSync } from './util.js';
import { readSecret, writeSecret, SECRETS_FILE } from './endpoints/secrets.js';
import { getContentOfType } from './endpoints/content-manager.js';
import { serverDirectory } from './server-directory.js';
import { getAdminSettings, getEffectiveUserQuotaBytes, getDirectorySizeBytes } from './admin-settings.js';
import { filterValidIpPatterns, getIpFromRequest } from './express-common.js';
import { extensionsEnabledFeatureGuard } from './endpoints/extensions.js';

export const KEY_PREFIX = 'user:';
const AVATAR_PREFIX = 'avatar:';
const ENABLE_ACCOUNTS = getConfigValue('enableUserAccounts', false, 'boolean');
const AUTHELIA_AUTH = getConfigValue('sso.autheliaAuth', false, 'boolean');
const AUTHENTIK_AUTH = getConfigValue('sso.authentikAuth', false, 'boolean');
const PER_USER_BASIC_AUTH = getConfigValue('perUserBasicAuth', false, 'boolean');
const ANON_CSRF_SECRET = crypto.randomBytes(64).toString('base64');
const STORAGE_USAGE_CACHE = new Cache(5000);
const QUOTA_ENFORCED_PATH_PREFIXES = [
    '/api/chats/save',
    '/api/chats/append',
    '/api/chats/patch',
    '/api/chats/import',
    '/api/chats/group/save',
    '/api/chats/group/append',
    '/api/chats/group/patch',
    '/api/chats/group/import',
    '/api/worldinfo/edit',
    '/api/worldinfo/import',
    '/api/worldinfo/patch',
    '/api/characters/create',
    '/api/characters/edit',
    '/api/characters/import',
    '/api/characters/duplicate',
    '/api/characters/state/set',
    '/api/characters/state/patch',
    '/api/presets/state/patch',
    '/api/settings/save',
    '/api/settings/patch',
    '/api/images/upload',
    '/api/files/upload',
    '/api/backgrounds/upload',
    '/api/avatars/upload',
    '/api/groups/create',
    '/api/groups/edit',
];
const TRUSTED_PROXIES = filterValidIpPatterns(getConfigValue('sso.trustedProxies', ['127.0.0.1', '::1']) ?? [], (entry, message) => `${color.red('Warning')}: Ignoring invalid sso.trustedProxies entry ${color.yellow(entry)} - ${message}`);

/**
 * Cache for user directories.
 * @type {Map<string, UserDirectoryList>}
 */
const DIRECTORIES_CACHE = new Map();
const PUBLIC_USER_AVATAR = '/img/default-user.png';
const COOKIE_SECRET_PATH = 'cookie-secret.txt';

const STORAGE_KEYS = {
    csrfSecret: 'csrfSecret',
    /**
     * @deprecated Read from COOKIE_SECRET_PATH in DATA_ROOT instead.
     */
    cookieSecret: 'cookieSecret',
};

export const USER_BACKUP_SELECTION_DEFAULTS = Object.freeze({
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

/**
 * @typedef {Object} User
 * @property {string} handle - The user's short handle. Used for directories and other references
 * @property {string} name - The user's name. Displayed in the UI
 * @property {number} created - The timestamp when the user was created
 * @property {string} password - Scrypt hash of the user's password
 * @property {string} salt - Salt used for hashing the password
 * @property {boolean} enabled - Whether the user is enabled
 * @property {boolean} admin - Whether the user is an admin (can manage other users)
 */

/**
 * @typedef {Object} UserViewModel
 * @property {string} handle - The user's short handle. Used for directories and other references
 * @property {string} name - The user's name. Displayed in the UI
 * @property {string} avatar - The user's avatar image
 * @property {boolean} [admin] - Whether the user is an admin (can manage other users)
 * @property {boolean} password - Whether the user is password protected
 * @property {boolean} [enabled] - Whether the user is enabled
 * @property {number} [created] - The timestamp when the user was created
 */

/**
 * @typedef {Object} UserDirectoryList
 * @property {string} root - The root directory for the user
 * @property {string} thumbnails - The directory where the thumbnails are stored
 * @property {string} thumbnailsBg - The directory where the background thumbnails are stored
 * @property {string} thumbnailsAvatar - The directory where the avatar thumbnails are stored
 * @property {string} thumbnailsPersona - The directory where the persona thumbnails are stored
 * @property {string} worlds - The directory where the WI are stored
 * @property {string} user - The directory where the user's public data is stored
 * @property {string} avatars - The directory where the avatars are stored
 * @property {string} userImages - The directory where the images are stored
 * @property {string} groups - The directory where the groups are stored
 * @property {string} groupChats - The directory where the group chats are stored
 * @property {string} chats - The directory where the chats are stored
 * @property {string} characters - The directory where the characters are stored
 * @property {string} backgrounds - The directory where the backgrounds are stored
 * @property {string} novelAI_Settings - The directory where the NovelAI settings are stored
 * @property {string} koboldAI_Settings - The directory where the KoboldAI settings are stored
 * @property {string} openAI_Settings - The directory where the OpenAI settings are stored
 * @property {string} textGen_Settings - The directory where the TextGen settings are stored
 * @property {string} themes - The directory where the themes are stored
 * @property {string} movingUI - The directory where the moving UI data is stored
 * @property {string} extensions - The directory where the extensions are stored
 * @property {string} instruct - The directory where the instruct templates is stored
 * @property {string} context - The directory where the context templates is stored
 * @property {string} quickreplies - The directory where the quick replies are stored
 * @property {string} assets - The directory where the assets are stored
 * @property {string} comfyWorkflows - The directory where the ComfyUI workflows are stored
 * @property {string} files - The directory where the uploaded files are stored
 * @property {string} vectors - The directory where the vectors are stored
 * @property {string} backups - The directory where the backups are stored
 * @property {string} sysprompt - The directory where the system prompt data is stored
 * @property {string} reasoning - The directory where the reasoning templates are stored
 */

/**
 * Ensures that the content directories exist.
 * @returns {Promise<import('./users.js').UserDirectoryList[]>} - The list of user directories
 */
export async function ensurePublicDirectoriesExist() {
    for (const dir of Object.values(PUBLIC_DIRECTORIES)) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const userHandles = await getAllUserHandles();
    const directoriesList = userHandles.map(handle => getUserDirectories(handle));
    for (const userDirectories of directoriesList) {
        for (const dir of Object.values(userDirectories)) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }
    return directoriesList;
}

/**
 * Prints an error message and exits the process if necessary
 * @param {string} message The error message to print
 * @returns {void}
 */
function logSecurityAlert(message) {
    const { basicAuthMode, whitelistMode } = globalThis.COMMAND_LINE_ARGS;
    if (basicAuthMode || whitelistMode) return; // safe!
    console.error(color.red(message));
    if (getConfigValue('securityOverride', false, 'boolean')) {
        console.warn(color.red('Security has been overridden. If it\'s not a trusted network, change the settings.'));
        return;
    }
    process.exit(1);
}

/**
 * Generates a random password for each admin user without one, persists it,
 * and prints the resulting credentials to stderr. Caller is responsible for
 * deciding when this should run (i.e. no other protection layer is active).
 * @param {Array<import('./users.js').User>} adminUsers
 * @returns {Promise<void>}
 */
async function provisionRandomAdminPasswords(adminUsers) {
    const banner = '='.repeat(60);
    const sep = '-'.repeat(60);
    for (const user of adminUsers) {
        const password = crypto.randomBytes(12).toString('base64url');
        const salt = getPasswordSalt();
        user.password = getPasswordHash(password, salt);
        user.salt = salt;
        await storage.setItem(toKey(user.handle), user);
        console.error(color.red(banner));
        console.error(color.red(' Luker generated a random password for an admin account.'));
        console.error(color.red(' Save it now and change it after first login.'));
        console.error(color.red(sep));
        console.error(`   user: ${color.yellow(user.handle)}`);
        console.error(`   pass: ${color.yellow(password)}`);
        console.error(color.red(banner));
    }
}

/**
 * Verifies the security settings and prints warnings if necessary
 * @returns {Promise<void>}
 */
export async function verifySecuritySettings() {
    const { listen, basicAuthMode } = globalThis.COMMAND_LINE_ARGS;

    // Skip all security checks as listen is set to false
    if (!listen) {
        return;
    }

    if (!ENABLE_ACCOUNTS) {
        logSecurityAlert('Your current Luker configuration is insecure (listening to non-localhost). Enable whitelisting, basic authentication or user accounts.');
    }

    const users = await getAllEnabledUsers();
    const unprotectedUsers = users.filter(x => !x.password);
    const unprotectedAdminUsers = unprotectedUsers.filter(x => x.admin);

    if (unprotectedUsers.length > 0) {
        console.warn(color.blue('A friendly reminder that the following users are not password protected:'));
        unprotectedUsers.map(x => `${color.yellow(x.handle)} ${color.red(x.admin ? '(admin)' : '')}`).forEach(x => console.warn(x));
        console.log();
        console.warn(`Consider setting a password in the admin panel or by using the ${color.blue('recover.js')} script.`);
        console.log();

        if (unprotectedAdminUsers.length > 0) {
            const { basicAuthMode: hasBasicAuth, whitelistMode: hasWhitelist } = globalThis.COMMAND_LINE_ARGS;
            if (!hasBasicAuth && !hasWhitelist) {
                if (getConfigValue('securityOverride', false, 'boolean')) {
                    console.error(color.red('If you are not using basic authentication or whitelisting, you should set a password for all admin users.'));
                    console.warn(color.red('Security has been overridden. If it\'s not a trusted network, change the settings.'));
                } else {
                    try {
                        await provisionRandomAdminPasswords(unprotectedAdminUsers);
                    } catch (err) {
                        console.error(color.red(`Failed to auto-provision admin passwords: ${err.message}`));
                        console.error(color.red('Refusing to start with unprotected admin accounts.'));
                        process.exit(1);
                    }
                }
            }
        }
    }

    if (basicAuthMode) {
        const perUserBasicAuth = getConfigValue('perUserBasicAuth', false, 'boolean');
        if (perUserBasicAuth && !ENABLE_ACCOUNTS) {
            console.error(color.red(
                'Per-user basic authentication is enabled, but user accounts are disabled. This configuration may be insecure.',
            ));
        } else if (!perUserBasicAuth) {
            const basicAuthUserName = getConfigValue('basicAuthUser.username', '');
            const basicAuthUserPassword = getConfigValue('basicAuthUser.password', '');
            if (!basicAuthUserName || !basicAuthUserPassword) {
                console.warn(color.yellow(
                    'Basic Authentication is enabled, but username or password is not set or empty!',
                ));
            }
        }
    }
}

export function cleanUploads() {
    try {
        const uploadsPath = path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
        if (fs.existsSync(uploadsPath)) {
            const uploads = fs.readdirSync(uploadsPath);

            if (!uploads.length) {
                return;
            }

            console.debug(`Cleaning uploads folder (${uploads.length} files)`);
            uploads.forEach(file => {
                const pathToFile = path.join(uploadsPath, file);
                fs.unlinkSync(pathToFile);
            });
        }
    } catch (err) {
        console.error(err);
    }
}

/**
 * Gets a list of all user directories.
 * @returns {Promise<import('./users.js').UserDirectoryList[]>} - The list of user directories
 */
export async function getUserDirectoriesList() {
    const userHandles = await getAllUserHandles();
    const directoriesList = userHandles.map(handle => getUserDirectories(handle));
    return directoriesList;
}

/**
 * Perform migration from the old user data format to the new one.
 */
export async function migrateUserData() {
    const publicDirectory = path.join(process.cwd(), 'public');

    // No need to migrate if the characters directory doesn't exists
    if (!fs.existsSync(path.join(publicDirectory, 'characters'))) {
        return;
    }

    const TIMEOUT = 10;

    console.log();
    console.log(color.magenta('Preparing to migrate user data...'));
    console.log(`All public data will be moved to the ${globalThis.DATA_ROOT} directory.`);
    console.log('This process may take a while depending on the amount of data to move.');
    console.log(`Backups will be placed in the ${PUBLIC_DIRECTORIES.backups} directory.`);
    console.log(`The process will start in ${TIMEOUT} seconds. Press Ctrl+C to cancel.`);

    for (let i = TIMEOUT; i > 0; i--) {
        console.log(`${i}...`);
        await delay(1000);
    }

    console.log(color.magenta('Starting migration... Do not interrupt the process!'));

    const userDirectories = getUserDirectories(DEFAULT_USER.handle);

    const dataMigrationMap = [
        {
            old: path.join(publicDirectory, 'assets'),
            new: userDirectories.assets,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'backgrounds'),
            new: userDirectories.backgrounds,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'characters'),
            new: userDirectories.characters,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'chats'),
            new: userDirectories.chats,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'context'),
            new: userDirectories.context,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'group chats'),
            new: userDirectories.groupChats,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'groups'),
            new: userDirectories.groups,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'instruct'),
            new: userDirectories.instruct,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'KoboldAI Settings'),
            new: userDirectories.koboldAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'movingUI'),
            new: userDirectories.movingUI,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'NovelAI Settings'),
            new: userDirectories.novelAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'OpenAI Settings'),
            new: userDirectories.openAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'QuickReplies'),
            new: userDirectories.quickreplies,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'TextGen Settings'),
            new: userDirectories.textGen_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'themes'),
            new: userDirectories.themes,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'user'),
            new: userDirectories.user,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'User Avatars'),
            new: userDirectories.avatars,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'worlds'),
            new: userDirectories.worlds,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'scripts/extensions/third-party'),
            new: userDirectories.extensions,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'thumbnails'),
            new: userDirectories.thumbnails,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'vectors'),
            new: userDirectories.vectors,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'secrets.json'),
            new: path.join(userDirectories.root, 'secrets.json'),
            file: true,
        },
        {
            old: path.join(publicDirectory, 'settings.json'),
            new: path.join(userDirectories.root, 'settings.json'),
            file: true,
        },
        {
            old: path.join(publicDirectory, 'stats.json'),
            new: path.join(userDirectories.root, 'stats.json'),
            file: true,
        },
    ];

    const currentDate = new Date().toISOString().split('T')[0];
    const backupDirectory = path.join(process.cwd(), PUBLIC_DIRECTORIES.backups, '_migration', currentDate);

    if (!fs.existsSync(backupDirectory)) {
        fs.mkdirSync(backupDirectory, { recursive: true });
    }

    const errors = [];

    for (const migration of dataMigrationMap) {
        console.log(`Migrating ${migration.old} to ${migration.new}...`);

        try {
            if (!fs.existsSync(migration.old)) {
                console.log(color.yellow(`Skipping migration of ${migration.old} as it does not exist.`));
                continue;
            }

            if (migration.file) {
                // Copy the file to the new location
                fs.cpSync(migration.old, migration.new, { force: true });
                // Move the file to the backup location
                fs.cpSync(
                    migration.old,
                    path.join(backupDirectory, path.basename(migration.old)),
                    { recursive: true, force: true },
                );
                fs.rmSync(migration.old, { recursive: true, force: true });
            } else {
                // Copy the directory to the new location
                fs.cpSync(migration.old, migration.new, { recursive: true, force: true });
                // Move the directory to the backup location
                fs.cpSync(
                    migration.old,
                    path.join(backupDirectory, path.basename(migration.old)),
                    { recursive: true, force: true },
                );
                fs.rmSync(migration.old, { recursive: true, force: true });
            }
        } catch (error) {
            console.error(color.red(`Error migrating ${migration.old} to ${migration.new}:`), error.message);
            errors.push(migration.old);
        }
    }

    if (errors.length > 0) {
        console.log(color.red('Migration completed with errors. Move the following files manually:'));
        errors.forEach(error => console.error(error));
    }

    console.log(color.green('Migration completed!'));
}

export async function migrateSystemPrompts() {
    /**
     * Gets the default system prompts.
     * @returns {Promise<any[]>} - The list of default system prompts
     */
    async function getDefaultSystemPrompts() {
        try {
            return getContentOfType('sysprompt', 'json');
        } catch {
            return [];
        }
    }

    const directories = await getUserDirectoriesList();
    for (const directory of directories) {
        try {
            const migrateMarker = path.join(directory.sysprompt, '.migrated');
            if (fs.existsSync(migrateMarker)) {
                continue;
            }
            const backupsPath = path.join(directory.backups, '_sysprompt');
            fs.mkdirSync(backupsPath, { recursive: true });
            const defaultPrompts = await getDefaultSystemPrompts();
            const instucts = fs.readdirSync(directory.instruct);
            let migratedPrompts = [];
            for (const instruct of instucts) {
                const instructPath = path.join(directory.instruct, instruct);
                const sysPromptPath = path.join(directory.sysprompt, instruct);
                if (path.extname(instruct) === '.json' && !fs.existsSync(sysPromptPath)) {
                    const instructData = JSON.parse(fs.readFileSync(instructPath, 'utf8'));
                    if ('system_prompt' in instructData && 'name' in instructData) {
                        const backupPath = path.join(backupsPath, `${instructData.name}.json`);
                        fs.cpSync(instructPath, backupPath, { force: true });
                        const syspromptData = { name: instructData.name, content: instructData.system_prompt };
                        migratedPrompts.push(syspromptData);
                        delete instructData.system_prompt;
                        writeFileAtomicSync(instructPath, JSON.stringify(instructData, null, 4));
                    }
                }
            }
            // Only leave unique contents
            migratedPrompts = _.uniqBy(migratedPrompts, 'content');
            // Only leave contents that are not in the default prompts
            migratedPrompts = migratedPrompts.filter(x => !defaultPrompts.some(y => y.content === x.content));
            for (const sysPromptData of migratedPrompts) {
                sysPromptData.name = `[Migrated] ${sysPromptData.name}`;
                const syspromptPath = path.join(directory.sysprompt, `${sysPromptData.name}.json`);
                writeFileAtomicSync(syspromptPath, JSON.stringify(sysPromptData, null, 4));
                console.log(`Migrated system prompt ${sysPromptData.name} for ${directory.root.split(path.sep).pop()}`);
            }
            writeFileAtomicSync(migrateMarker, '');
        } catch (error) {
            console.error('Error migrating system prompts:', error);
        }
    }
}

export async function migratePublicOverrides() {
    const migrationMap = [
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'forbidden-by-whitelist.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'forbidden-by-whitelist.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'host-not-allowed.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'host-not-allowed.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'unauthorized.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'unauthorized.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'url-not-found.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'url-not-found.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'css', 'user.css'),
            newPath: path.join(globalThis.DATA_ROOT, '_css', 'user.css'),
        },
    ];

    for (const { oldPath, newPath } of migrationMap) {
        try {
            if (fs.existsSync(newPath)) {
                continue;
            }
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.cpSync(oldPath, newPath, { force: true });
                fs.unlinkSync(oldPath);
                setPermissionsSync(newPath);
                console.log(`Migrated ${path.basename(oldPath)} to data root.`);
            }
        } catch (error) {
            console.error(`Error migrating ${oldPath} to ${newPath}:`, error);
        }
    }
}

/**
 * Converts a user handle to a storage key.
 * @param {string} handle User handle
 * @returns {string} The key for the user storage
 */
export function toKey(handle) {
    return `${KEY_PREFIX}${handle}`;
}

/**
 * Converts a user handle to a storage key for avatars.
 * @param {string} handle User handle
 * @returns {string} The key for the avatar storage
 */
export function toAvatarKey(handle) {
    return `${AVATAR_PREFIX}${handle}`;
}

/**
 * Initializes the user storage.
 * @param {string} dataRoot The root directory for user data
 * @returns {Promise<void>}
 */
export async function initUserStorage(dataRoot) {
    console.log('Using data root:', color.green(dataRoot));
    await storage.init({
        dir: path.join(dataRoot, '_storage'),
        ttl: false, // Never expire
        expiredInterval: 0,
    });

    const keys = await getAllUserHandles();

    // If there are no users, create the default user
    if (keys.length === 0) {
        await storage.setItem(toKey(DEFAULT_USER.handle), DEFAULT_USER);
    }
}

/**
 * Get the cookie secret from the config. If it doesn't exist, generate a new one.
 * @param {string} dataRoot The root directory for user data
 * @returns {string} The cookie secret
 */
export function getCookieSecret(dataRoot) {
    const cookieSecretPath = path.join(dataRoot, COOKIE_SECRET_PATH);

    if (fs.existsSync(cookieSecretPath)) {
        const stat = fs.statSync(cookieSecretPath);
        if (stat.size > 0) {
            return fs.readFileSync(cookieSecretPath, 'utf8');
        }
    }

    const oldSecret = getConfigValue(STORAGE_KEYS.cookieSecret);
    if (oldSecret) {
        console.log('Migrating cookie secret from config.yaml...');
        writeFileAtomicSync(cookieSecretPath, oldSecret, { encoding: 'utf8' });
        return oldSecret;
    }

    console.warn(color.yellow('Cookie secret is missing from data root. Generating a new one...'));
    const secret = crypto.randomBytes(64).toString('base64');
    writeFileAtomicSync(cookieSecretPath, secret, { encoding: 'utf8' });
    return secret;
}

/**
 * Generates a random password salt.
 * @returns {string} The password salt
 */
export function getPasswordSalt() {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Get the session name for the current server.
 * @returns {string} The session name
 */
export function getCookieSessionName() {
    // Get server hostname and hash it to generate a session suffix
    const hostname = os.hostname() || 'localhost';
    const suffix = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 8);
    return `session-${suffix}`;
}

export function getSessionCookieAge() {
    // Defaults to "no expiration" if not set
    const configValue = getConfigValue('sessionTimeout', -1, 'number');

    // Convert to milliseconds
    if (configValue > 0) {
        return configValue * 1000;
    }

    // "No expiration" is just 400 days as per RFC 6265
    if (configValue < 0) {
        return 400 * 24 * 60 * 60 * 1000;
    }

    // 0 means session cookie is deleted when the browser session ends
    // (depends on the implementation of the browser)
    return undefined;
}

/**
 * Hashes a password using scrypt with the provided salt.
 * @param {string} password Password to hash
 * @param {string} salt Salt to use for hashing
 * @returns {string} Hashed password
 */
export function getPasswordHash(password, salt) {
    return crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
}

/**
 * Get the CSRF secret from the storage.
 * @param {import('express').Request} [request] HTTP request object
 * @returns {string} The CSRF secret
 */
export function getCsrfSecret(request) {
    if (!request || !request.user) {
        return ANON_CSRF_SECRET;
    }

    let csrfSecret = readSecret(request.user.directories, STORAGE_KEYS.csrfSecret);

    if (!csrfSecret) {
        csrfSecret = crypto.randomBytes(64).toString('base64');
        writeSecret(request.user.directories, STORAGE_KEYS.csrfSecret, csrfSecret);
    }

    return csrfSecret;
}

/**
 * Gets a list of all user handles.
 * @returns {Promise<string[]>} - The list of user handles
 */
export async function getAllUserHandles() {
    const keys = await storage.keys(x => x.key.startsWith(KEY_PREFIX));
    const handles = keys.map(x => x.replace(KEY_PREFIX, ''));
    return handles;
}

/**
 * Gets the directories listing for the provided user.
 * @param {string} handle User handle
 * @returns {UserDirectoryList} User directories
 */
export function getUserDirectories(handle) {
    if (DIRECTORIES_CACHE.has(handle)) {
        const cache = DIRECTORIES_CACHE.get(handle);
        if (cache) {
            return cache;
        }
    }

    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key in directories) {
        directories[key] = path.join(globalThis.DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    DIRECTORIES_CACHE.set(handle, directories);
    return directories;
}

/**
 * Gets the avatar URL for the provided user.
 * @param {string} handle User handle
 * @returns {Promise<string>} User avatar URL
 */
export async function getUserAvatar(handle) {
    try {
        // Check if the user has a custom avatar
        const avatarKey = toAvatarKey(handle);
        const avatar = await storage.getItem(avatarKey);

        if (avatar) {
            return avatar;
        }

        // Fallback to reading from files if custom avatar is not set
        const directory = getUserDirectories(handle);
        const pathToSettings = path.join(directory.root, SETTINGS_FILE);
        const settings = fs.existsSync(pathToSettings) ? JSON.parse(fs.readFileSync(pathToSettings, 'utf8')) : {};
        const avatarFile = settings?.power_user?.default_persona || settings?.user_avatar;
        if (!avatarFile) {
            return PUBLIC_USER_AVATAR;
        }
        const avatarPath = resolvePathWithinParent(directory.avatars, avatarFile);
        if (!avatarPath || !fs.existsSync(avatarPath)) {
            return PUBLIC_USER_AVATAR;
        }
        const mimeType = mime.lookup(avatarPath);
        const base64Content = fs.readFileSync(avatarPath, 'base64');
        return `data:${mimeType};base64,${base64Content}`;
    } catch {
        // Ignore errors
        return PUBLIC_USER_AVATAR;
    }
}

/**
 * Checks if the user should be redirected to the login page.
 * @param {import('express').Request} request Request object
 * @returns {boolean} Whether the user should be redirected to the login page
 */
export function shouldRedirectToLogin(request) {
    return ENABLE_ACCOUNTS && !request.user;
}

/**
 * Tries auto-login if there is only one user and it's not password protected.
 * or another configured method such authlia or basic
 * @param {import('express').Request} request Request object
 * @param {boolean} basicAuthMode If Basic auth mode is enabled
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
export async function tryAutoLogin(request, basicAuthMode) {
    if (!ENABLE_ACCOUNTS || request.user || !request.session) {
        return false;
    }

    if (!request.query.noauto) {
        if (await singleUserLogin(request)) {
            return true;
        }

        if (AUTHELIA_AUTH && await autheliaUserLogin(request)) {
            return true;
        }

        if (AUTHENTIK_AUTH && await authentikUserLogin(request)) {
            return true;
        }

        if (basicAuthMode && PER_USER_BASIC_AUTH && await basicUserLogin(request)) {
            return true;
        }
    }

    return false;
}

/**
 * Tries auto-login if there is only one user and it's not password protected.
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function singleUserLogin(request) {
    if (!request.session) {
        return false;
    }

    const userHandles = await getAllUserHandles();
    if (userHandles.length === 1) {
        const user = await storage.getItem(toKey(userHandles[0]));
        if (user && !user.password) {
            request.session.handle = userHandles[0];
            request.session.version = getAccountVersion(user);
            return true;
        }
    }
    return false;
}

/**
 * Attempts auto-login using an Authelia header.
 * https://www.authelia.com/integration/trusted-header-sso/introduction/
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function autheliaUserLogin(request) {
    return headerUserLogin(request, 'Remote-User');
}

/**
 * Attempts auto-login using an Authentik header.
 * https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function authentikUserLogin(request) {
    return headerUserLogin(request, 'X-Authentik-Username');
}

/**
 * Check if the request can authenticate SSO users based on the trusted proxies configuration and the request's IP address.
 * @param {string} ip The IP address of the request
 * @return {boolean} If the request is from a trusted proxy based on the configuration
 */
function isRequestFromTrustedProxy(ip) {
    if (!Array.isArray(TRUSTED_PROXIES)) {
        console.warn(color.yellow('sso.trustedProxies is not an array. Please check your config.yaml. SSO auto-login will not work.'));
        return false;
    }

    // Bypass magic value check if the user explicitly configured
    if (TRUSTED_PROXIES.length === 1 && TRUSTED_PROXIES[0] === '*') {
        console.warn(color.yellow('sso.trustedProxies is set to accept all IPs. This is not recommended for production environments.'));
        return true;
    }

    // If the IP is missing or unknown, we can't trust it
    if (!ip || ip === 'unknown') {
        return false;
    }

    // At least one entry in the trusted proxies list must match the request IP for it to be considered trusted
    for (const entry of TRUSTED_PROXIES) {
        try {
            // This will throw if the entry is not a valid IP or CIDR
            const match = ipMatching.getMatch(entry);
            if (ipMatching.matches(ip, match)) {
                return true;
            }
        } catch (e) {
            continue;
        }
    }

    return false;
}

/**
 * Tries auto-login with a given header.
 * @param {import('express').Request} request Request object
 * @param {string} [header='Remote-User'] The header to use for the trusted user
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function headerUserLogin(request, header = 'Remote-User') {
    if (!request.session) {
        return false;
    }

    const remoteUser = request.get(header);
    if (!remoteUser) {
        return false;
    }
    console.debug(`Attempting auto-login for user from header ${header}: ${remoteUser}`);

    const ip = getIpFromRequest(request);
    const isTrusted = isRequestFromTrustedProxy(ip);
    if (!isTrusted) {
        console.warn(color.yellow(`Received ${header} header from untrusted IP ${ip}. Ignoring for auto-login.`));
        return false;
    }

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (remoteUser.toLowerCase() === userHandle) {
            const user = await storage.getItem(toKey(userHandle));
            if (user && user.enabled) {
                request.session.handle = userHandle;
                request.session.version = getAccountVersion(user);
                return true;
            }
        }
    }
    return false;
}

/**
 * Tries auto-login with basic auth username.
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function basicUserLogin(request) {
    if (!request.session) {
        return false;
    }

    const authHeader = request.headers.authorization;

    if (!authHeader) {
        return false;
    }

    const [scheme, credentials] = authHeader.split(' ');

    if (scheme !== 'Basic' || !credentials) {
        return false;
    }

    const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
        .toString('utf8')
        .split(':');
    const password = passwordParts.join(':');

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (username === userHandle) {
            const user = await storage.getItem(toKey(userHandle));
            // Verify pass again here just to be sure
            if (user && user.enabled && user.password && user.password === getPasswordHash(password, user.salt)) {
                request.session.handle = userHandle;
                request.session.version = getAccountVersion(user);
                return true;
            }
        }
    }

    return false;
}

/**
 * Gets the account version tag for the provided user.
 * @param {User} user User account object
 * @returns {string} Account version tag
 */
export function getAccountVersion(user) {
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([user.handle, user.password, user.salt]))
        .digest('hex');
}

/**
 * Middleware to add user data to the request object.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 */
export async function setUserDataMiddleware(request, response, next) {
    // If user accounts are disabled, use the default user
    if (!ENABLE_ACCOUNTS) {
        const handle = DEFAULT_USER.handle;
        const directories = getUserDirectories(handle);
        request.user = {
            profile: DEFAULT_USER,
            directories: directories,
        };
        return next();
    }

    if (!request.session) {
        console.error('Session not available');
        return response.sendStatus(500);
    }

    // If user accounts are enabled, get the user from the session
    let handle = request.session?.handle;

    // If we have the only user and it's not password protected, use it
    if (!handle) {
        return next();
    }

    /** @type {User} */
    const user = await storage.getItem(toKey(handle));

    if (!user) {
        console.error('User not found:', handle);
        return next();
    }

    if (!user.enabled) {
        console.error('User is disabled:', handle);
        return next();
    }

    if (Object.hasOwn(request.session, 'version')) {
        if (request.session.version !== getAccountVersion(user)) {
            console.warn('User data has changed since the session was created. Invalidating session for user:', handle);
            request.session.handle = null;
            request.session.csrfToken = null;
            request.session.version = null;
            request.session = null;
            return response.sendStatus(403);
        }
    } else {
        // If there is no version in the session, it means it's an old session. Upgrade it by adding the version.
        request.session.version = getAccountVersion(user);
    }

    const directories = getUserDirectories(handle);
    request.user = {
        profile: user,
        directories: directories,
    };

    // Touch the session if loading the home page
    if (request.method === 'GET' && request.path === '/') {
        request.session.touch = Date.now();
    }

    return next();
}

/**
 * Middleware to add user data to the request object.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 */
function isQuotaEnforcedRequest(request) {
    if (!request?.path || request.method !== 'POST') {
        return false;
    }

    return QUOTA_ENFORCED_PATH_PREFIXES.some(prefix => request.path.startsWith(prefix));
}

/**
 * Enforces per-user storage quota on write-heavy endpoints.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 * @returns {Promise<any>}
 */
export async function enforceUserQuotaMiddleware(request, response, next) {
    if (!ENABLE_ACCOUNTS || !request.user || request.user.profile.admin) {
        return next();
    }

    if (!isQuotaEnforcedRequest(request)) {
        return next();
    }

    try {
        const settings = await getAdminSettings();
        const quotaBytes = getEffectiveUserQuotaBytes(request.user.profile, settings);

        if (!Number.isFinite(quotaBytes) || quotaBytes < 0) {
            return next();
        }

        const handle = request.user.profile.handle;
        let usageBytes = STORAGE_USAGE_CACHE.get(handle);
        if (!Number.isFinite(usageBytes)) {
            usageBytes = await getDirectorySizeBytes(request.user.directories.root);
            STORAGE_USAGE_CACHE.set(handle, usageBytes);
        }

        const requestLength = Number(request.headers['content-length'] || 0);
        const projectedUsage = usageBytes + (Number.isFinite(requestLength) && requestLength > 0 ? requestLength : 0);

        if (projectedUsage > quotaBytes) {
            const message = 'Storage quota exceeded. Used ' + formatBytes(usageBytes) + ' of ' + formatBytes(quotaBytes) + '.';
            return response.status(413).json({ error: message, usedBytes: usageBytes, quotaBytes: quotaBytes });
        }

        return next();
    } catch (error) {
        console.error('Failed to enforce storage quota:', error);
        return response.sendStatus(500);
    }
}

export function requireLoginMiddleware(request, response, next) {
    if (!request.user) {
        return response.sendStatus(403);
    }

    return next();
}

/**
 * Middleware to host the login page.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 */
export async function loginPageMiddleware(request, response) {
    if (!ENABLE_ACCOUNTS) {
        console.log('User accounts are disabled. Redirecting to index page.');
        return response.redirect('/');
    }

    try {
        const { basicAuthMode } = globalThis.COMMAND_LINE_ARGS;
        const autoLogin = await tryAutoLogin(request, basicAuthMode);

        if (autoLogin) {
            return response.redirect('/');
        }
    } catch (error) {
        console.error('Error during auto-login:', error);
    }

    return response.sendFile('login.html', { root: path.join(serverDirectory, 'public') });
}

/**
 * Creates a route handler for serving files from a specific directory.
 * @param {(req: import('express').Request) => string} directoryFn A function that returns the directory path to serve files from
 * @returns {import('express').RequestHandler}
 */
function createRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const fullPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(fullPath))) {
                return res.sendStatus(403);
            }
            const exists = fs.existsSync(fullPath);
            if (!exists) {
                return res.sendStatus(404);
            }

            invalidateFirefoxCache(filePath, req, res);
            return res.sendFile(filePath, { root: directory });
        } catch (error) {
            return res.sendStatus(500);
        }
    };
}

/**
 * Creates a route handler for serving extensions.
 * @param {(req: import('express').Request) => string} directoryFn A function that returns the directory path to serve files from
 * @returns {import('express').RequestHandler}
 */
function createExtensionsRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const localPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(localPath))) {
                return res.sendStatus(403);
            }
            const existsLocal = fs.existsSync(localPath);
            if (existsLocal) {
                return res.sendFile(filePath, { root: directory });
            }

            const globalPath = path.join(PUBLIC_DIRECTORIES.globalExtensions, filePath);
            if (!isPathUnderParent(PUBLIC_DIRECTORIES.globalExtensions, path.resolve(globalPath))) {
                return res.sendStatus(403);
            }
            const existsGlobal = fs.existsSync(globalPath);
            if (existsGlobal) {
                return res.sendFile(filePath, { root: PUBLIC_DIRECTORIES.globalExtensions });
            }

            return res.sendStatus(404);
        } catch (error) {
            return res.sendStatus(500);
        }
    };
}

/**
 * Verifies that the current user is an admin.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 * @returns {any}
 */
export function requireAdminMiddleware(request, response, next) {
    if (!request.user) {
        return response.sendStatus(403);
    }

    if (request.user.profile.admin) {
        return next();
    }

    console.warn('Unauthorized access to admin endpoint:', request.originalUrl);
    return response.sendStatus(403);
}

/**
 * Returns true when the request belongs to an admin, or when user accounts are disabled
 * (single-user mode is implicitly admin).
 * @param {import('express').Request} request Request
 * @returns {boolean}
 */
export function isRequestAdmin(request) {
    if (!ENABLE_ACCOUNTS) {
        return true;
    }
    return Boolean(request?.user?.profile?.admin);
}

/**
 * Normalizes a backup category selection object.
 * @param {Record<string, boolean|string|number>|null|undefined} selectionInput Selection payload from the client
 * @returns {Record<string, boolean>} Normalized selection
 */
export function normalizeUserBackupSelection(selectionInput) {
    const normalized = { ...USER_BACKUP_SELECTION_DEFAULTS };

    if (!selectionInput || typeof selectionInput !== 'object') {
        return normalized;
    }

    for (const key of Object.keys(normalized)) {
        if (!(key in selectionInput)) {
            continue;
        }

        const value = selectionInput[key];
        if (typeof value === 'boolean') {
            normalized[key] = value;
            continue;
        }

        if (typeof value === 'number') {
            normalized[key] = value !== 0;
            continue;
        }

        if (typeof value === 'string') {
            const lowered = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(lowered)) {
                normalized[key] = true;
            } else if (['false', '0', 'no', 'off'].includes(lowered)) {
                normalized[key] = false;
            }
        }
    }

    return normalized;
}

/**
 * Gets selected backup target files and directories for a user.
 * @param {UserDirectoryList} directories User directories
 * @param {Record<string, boolean>} selection Selection object
 * @param {{ includeGlobalExtensions?: boolean }} [options] Additional target options
 * @returns {{ files: string[], directories: string[] }} Backup targets
 */
export function getUserBackupTargets(directories, selection, options = {}) {
    const includeGlobalExtensions = options?.includeGlobalExtensions === true;
    const selectedFiles = new Set();
    const selectedDirectories = new Set();

    if (selection.settings) {
        selectedFiles.add(path.join(directories.root, SETTINGS_FILE));
        selectedDirectories.add(directories.backups);
    }

    if (selection.secrets) {
        selectedFiles.add(path.join(directories.root, SECRETS_FILE));
    }

    if (selection.characters) {
        selectedDirectories.add(directories.characters);
        selectedDirectories.add(directories.avatars);
        selectedDirectories.add(directories.backgrounds);
    }

    if (selection.chats) {
        selectedDirectories.add(directories.chats);
        selectedDirectories.add(directories.groups);
        selectedDirectories.add(directories.groupChats);
    }

    if (selection.lorebooks) {
        selectedDirectories.add(directories.worlds);
    }

    if (selection.presets) {
        selectedDirectories.add(directories.novelAI_Settings);
        selectedDirectories.add(directories.koboldAI_Settings);
        selectedDirectories.add(directories.openAI_Settings);
        selectedDirectories.add(directories.textGen_Settings);
        selectedDirectories.add(directories.instruct);
        selectedDirectories.add(directories.context);
        selectedDirectories.add(directories.quickreplies);
        selectedDirectories.add(directories.themes);
        selectedDirectories.add(directories.movingUI);
        selectedDirectories.add(directories.sysprompt);
        selectedDirectories.add(directories.reasoning);
    }

    if (selection.assets) {
        selectedDirectories.add(directories.assets);
        selectedDirectories.add(directories.files);
        selectedDirectories.add(directories.userImages);
        selectedDirectories.add(directories.comfyWorkflows);
    }

    if (selection.extensions) {
        selectedDirectories.add(directories.extensions);
    }

    if (selection.globalExtensions && includeGlobalExtensions) {
        selectedDirectories.add(PUBLIC_DIRECTORIES.globalExtensions);
    }

    if (selection.vectors) {
        selectedDirectories.add(directories.vectors);
    }

    return {
        files: [...selectedFiles],
        directories: [...selectedDirectories],
    };
}

/**
 * Converts an absolute file system path into a stable backup archive path.
 * Paths inside user root remain user-root relative. Paths outside user root
 * (for example global extensions) are stored relative to process cwd.
 * @param {string} rootPath User root path
 * @param {string} targetPath Absolute file or directory path to archive
 * @returns {string} Safe relative archive path
 */
function getBackupArchivePath(rootPath, targetPath) {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(targetPath);

    const relativeToRoot = path.relative(resolvedRoot, resolvedTarget);
    if (relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
        return path.posix.normalize(relativeToRoot.split(path.sep).join('/'));
    }

    const relativeToCwd = path.relative(process.cwd(), resolvedTarget);
    if (relativeToCwd && !relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd)) {
        return path.posix.normalize(relativeToCwd.split(path.sep).join('/'));
    }

    return path.posix.normalize(path.basename(resolvedTarget));
}

/**
 * Creates an archive of selected user data.
 * @param {string} handle User handle
 * @param {import('express').Response} response Express response object to write to
 * @param {Record<string, boolean|string|number>} [selectionInput] Backup selection payload
 * @param {{ includeGlobalExtensions?: boolean }} [options] Additional target options
 * @returns {Promise<void>} Promise that resolves when the archive is created
 */
export async function createBackupArchive(handle, response, selectionInput = undefined, options = {}) {
    const directories = getUserDirectories(handle);
    const selection = normalizeUserBackupSelection(selectionInput);
    const targets = getUserBackupTargets(directories, selection, options);

    if (targets.files.length === 0 && targets.directories.length === 0) {
        throw new Error('At least one backup category must be selected.');
    }

    console.info('Backup requested for', handle, selection);
    const archive = archiver('zip');

    archive.on('error', function (err) {
        response.status(500).send({ error: err.message });
    });

    // Log archive size when the source stream has been fully drained.
    // Do not force-close the HTTP response here; the pipe lifecycle handles it.
    archive.on('end', function () {
        console.info(`Archive wrote ${archive.pointer()} bytes`);
    });

    const timestamp = generateTimestamp();

    // Set the archive name
    response.attachment(`${handle}-${timestamp}.zip`);

    // This is the streaming magic
    // @ts-ignore
    archive.pipe(response);

    const manifest = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        handle,
        selection,
    };

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    for (const filePath of targets.files) {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            continue;
        }

        const archivePath = getBackupArchivePath(directories.root, filePath);
        archive.file(filePath, { name: archivePath });
    }

    for (const directoryPath of targets.directories) {
        if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
            continue;
        }

        const archivePath = getBackupArchivePath(directories.root, directoryPath);
        archive.directory(directoryPath, archivePath);
    }

    archive.finalize();
}

/**
 * Gets all of the users.
 * @returns {Promise<User[]>}
 */
async function getAllUsers() {
    if (!ENABLE_ACCOUNTS) {
        return [];
    }
    /**
     * @type {User[]}
     */
    const users = await storage.values();
    return users;
}

/**
 * Gets all of the enabled users.
 * @returns {Promise<User[]>}
 */
export async function getAllEnabledUsers() {
    const users = await getAllUsers();
    return users.filter(x => x.enabled);
}

/**
 * Express router for serving files from the user's directories.
 */
export const router = express.Router();
router.use('/backgrounds/*', createRouteHandler(req => req.user.directories.backgrounds));
router.use('/characters/*', createRouteHandler(req => req.user.directories.characters));
router.use('/User%20Avatars/*', createRouteHandler(req => req.user.directories.avatars));
router.use('/assets/*', createRouteHandler(req => req.user.directories.assets));
router.use('/user/images/*', createRouteHandler(req => req.user.directories.userImages));
router.use('/user/files/*', createRouteHandler(req => req.user.directories.files));
router.use('/scripts/extensions/third-party/*', extensionsEnabledFeatureGuard, createExtensionsRouteHandler(req => req.user.directories.extensions));
