import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import bytes from 'bytes';

import { SETTINGS_FILE } from '../constants.js';
import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { getSettingsRepo } from '../storage/index.js';
import { applyJsonPatch } from '../storage/repositories/json-patch.js';
import { NotFoundError, PatchTestFailedError, PatchMissingParentError, UnsupportedPatchOpError } from '../storage/errors.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const PRESET_STATE_FILE_MARKER = '.luker-state.';
const ENABLE_REQUEST_COMPRESSION = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');
const REQUEST_COMPRESSION_MIN = bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb'));
const REQUEST_COMPRESSION_MAX = bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb'));
const REQUEST_COMPRESSION_TIMEOUT = Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number'));

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => backupUserSettings(handle, true), AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        functionToCall();
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {object} [options] Read options
 * @param {string} [options.fileExtension='.json'] File extension
 * @param {boolean} [options.excludePresetStateSidecars=false] Exclude preset state sidecar files
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, options = {}) {
    const {
        fileExtension = '.json',
        excludePresetStateSidecars = false,
    } = options;
    const files = fs
        .readdirSync(directoryPath)
        .filter((fileName) => {
            if (path.parse(fileName).ext !== fileExtension) {
                return false;
            }
            if (!excludePresetStateSidecars) {
                return true;
            }
            return !isPresetStateSidecarFile(fileName, fileExtension);
        })
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        } catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

function isPresetStateSidecarFile(fileName, fileExtension = '.json') {
    if (path.parse(fileName).ext !== fileExtension) {
        return false;
    }

    const basename = path.parse(fileName).name;
    const normalizedBasename = basename.toLowerCase();
    const markerIndex = normalizedBasename.lastIndexOf(PRESET_STATE_FILE_MARKER);
    if (markerIndex === -1) {
        return false;
    }

    const namespace = basename.slice(markerIndex + PRESET_STATE_FILE_MARKER.length);
    return Boolean(namespace) && /^[a-z0-9._-]+$/i.test(namespace);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
        excludePresetStateSidecars = false,
    } = options;

    const files = fs.readdirSync(directoryPath)
        .sort(sortFunction)
        .filter((fileName) => {
            if (path.parse(fileName).ext !== fileExtension) {
                return false;
            }
            if (!excludePresetStateSidecars) {
                return true;
            }
            return !isPresetStateSidecarFile(fileName, fileExtension);
        });
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            console.warn(`${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

function readWorldNames(directoryPath) {
    return fs
        .readdirSync(directoryPath)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b))
        .map(item => path.parse(item).name);
}

function retainSelectedPresetContents(fileContents, fileNames, selectedName) {
    if (!Array.isArray(fileContents) || !Array.isArray(fileNames)) {
        return [];
    }

    return fileNames.map((name, index) => name === selectedName ? fileContents[index] : null);
}

export async function buildSettingsResponse(request, { includePresetContents = true, includeQuickReplyPresets = true } = {}) {
    const handle = request.user.profile.handle;
    const parsedSettings = await getSettingsRepo().get(handle);
    if (parsedSettings == null) {
        throw new Error(`settings missing for handle ${handle}`);
    }
    const settings = JSON.stringify(parsedSettings);

    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
            excludePresetStateSidecars: true,
        });

    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings),
            removeFileExtension: true,
            excludePresetStateSidecars: true,
        });

    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings),
            removeFileExtension: true,
            excludePresetStateSidecars: true,
        });

    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings),
            removeFileExtension: true,
            excludePresetStateSidecars: true,
        });

    const world_names = readWorldNames(request.user.directories.worlds);

    const themes = readAndParseFromDirectory(request.user.directories.themes);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI);
    const quickReplyPresets = includeQuickReplyPresets ? readAndParseFromDirectory(request.user.directories.quickreplies) : [];

    const instruct = readAndParseFromDirectory(request.user.directories.instruct, { excludePresetStateSidecars: true });
    const context = readAndParseFromDirectory(request.user.directories.context, { excludePresetStateSidecars: true });
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt, { excludePresetStateSidecars: true });
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning, { excludePresetStateSidecars: true });

    const selectedKoboldPreset = parsedSettings?.kai_settings?.preset_settings ?? parsedSettings?.preset_settings;
    const selectedNovelPreset = parsedSettings?.preset_settings_novel;
    const selectedOpenAIPreset = parsedSettings?.oai_settings?.preset_settings_openai ?? parsedSettings?.preset_settings_openai;
    const selectedTextGenPreset = parsedSettings?.textgenerationwebui_settings?.preset;

    return {
        settings,
        koboldai_settings: includePresetContents
            ? koboldai_settings
            : retainSelectedPresetContents(koboldai_settings, koboldai_setting_names, selectedKoboldPreset),
        koboldai_setting_names,
        world_names,
        novelai_settings: includePresetContents
            ? novelai_settings
            : retainSelectedPresetContents(novelai_settings, novelai_setting_names, selectedNovelPreset),
        novelai_setting_names,
        openai_settings: includePresetContents
            ? openai_settings
            : retainSelectedPresetContents(openai_settings, openai_setting_names, selectedOpenAIPreset),
        openai_setting_names,
        textgenerationwebui_presets: includePresetContents
            ? textgenerationwebui_presets
            : retainSelectedPresetContents(textgenerationwebui_presets, textgenerationwebui_preset_names, selectedTextGenPreset),
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
    };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        return;
    }

    if (!fs.existsSync(sourceFile)) {
        return;
    }

    fs.copyFileSync(sourceFile, backupFile);
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
function areFilesEqual(file1, file2) {
    if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
        return false;
    }

    const content1 = fs.readFileSync(file1);
    const content2 = fs.readFileSync(file2);
    return content1.toString() === content2.toString();
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/patch', async function (request, response) {
    try {
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body?.operations)
                ? [request.body.operations]
                : (request.body?.operation ? [request.body.operation] : []));

        if (!Array.isArray(operations) || operations.length === 0) {
            return response.status(400).send({ error: 'No settings patch operations found. Expected body.operations or body.operation.' });
        }

        const handle = request.user.profile.handle;
        const repo = getSettingsRepo();
        try {
            await repo.patch(handle, operations);
        } catch (err) {
            if (err instanceof NotFoundError) {
                const seeded = applyJsonPatch({}, operations);
                await repo.save(handle, seeded);
            } else {
                throw err;
            }
        }
        triggerAutoSave(handle);
        return response.send({ result: 'ok', applied: operations.length });
    } catch (error) {
        if (error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
            return response.status(409).send({
                error: 'Settings patch test conflict.',
                code: 'patch_test_failed',
                details: String(error?.message || ''),
            });
        }
        if (error instanceof UnsupportedPatchOpError) {
            return response.status(400).send({
                error: 'Invalid settings patch payload.',
                code: 'patch_payload_invalid',
                details: String(error?.message || ''),
            });
        }
        console.error('Error patching settings:', error);
        return response.status(500).send({ error: 'Failed to patch settings.' });
    }
});

router.post('/save', async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        await getSettingsRepo().save(handle, request.body);
        triggerAutoSave(handle);
        response.send({ result: 'ok' });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

// Wintermute's code
router.post('/get', async (request, response) => {
    try {
        return response.send(await buildSettingsResponse(request));
    } catch (e) {
        return response.sendStatus(500);
    }
});

router.post('/bootstrap', async (request, response) => {
    try {
        return response.send(await buildSettingsResponse(request, {
            includePresetContents: false,
            includeQuickReplyPresets: false,
        }));
    } catch (e) {
        return response.sendStatus(500);
    }
});

// TODO(storage-phase-2): route through engine-level snapshot API
router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

// TODO(storage-phase-2): route through engine-level snapshot API
router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

// TODO(storage-phase-2): route through engine-level snapshot API
router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

// TODO(storage-phase-2): route through engine-level snapshot API
router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        fs.rmSync(pathToSettings, { force: true });
        fs.copyFileSync(snapshotPath, pathToSettings);

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
