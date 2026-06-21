import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import bytes from 'bytes';

import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { getSettingsRepo, getPresetRepo, getNamedDocRepo, getWorldInfoRepo } from '../storage/index.js';
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
 * @param {object} userDirectories Per-user directory map
 * @returns {void}
 */
function triggerAutoSave(handle, userDirectories) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(
            () => { backupUserSettings(handle, userDirectories, true).catch((err) => console.error('autosave failed:', err)); },
            AUTOSAVE_INTERVAL,
        );
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

// Engine-agnostic adapter: shape PresetRepo.listWithDocs() output to match
// the legacy `{fileContents: string[], fileNames: string[]}` payload the
// frontend expects (openai.js#hydrateOpenAIPresetData JSON.parses each
// element). Keeping the strings means clients don't have to be re-taught.
async function presetsFromRepo(handle, apiId) {
    const entries = await getPresetRepo().listWithDocs(handle, apiId);
    const fileContents = entries.map((e) => JSON.stringify(e.doc));
    const fileNames = entries.map((e) => e.name);
    return { fileContents, fileNames };
}

// Engine-agnostic adapter: matches readAndParseFromDirectory's
// "parsed JSON objects only" shape, but also stamps each entry's `name`
// field from the Repo key so the frontend can resolve themes / movingUI
// presets back. The legacy fs reader trusted each file's internal `.name`
// property — which is what the existing serializers write — but we keep
// the same shape regardless of where the data came from.
async function namedDocsFromRepo(handle, bucket) {
    const entries = await getNamedDocRepo().listWithDocs(handle, bucket);
    return entries.map((e) => {
        // Most named docs are written by save-with-name endpoints, so their
        // body already has `name`. Preserve the body's existing field if it
        // matches, otherwise stamp from the Repo key.
        if (e.doc && typeof e.doc === 'object' && !Array.isArray(e.doc)) {
            if (typeof e.doc.name !== 'string' || !e.doc.name) {
                return { ...e.doc, name: e.name };
            }
            return e.doc;
        }
        return { name: e.name };
    });
}

export async function buildSettingsResponse(request, { includePresetContents = true, includeQuickReplyPresets = true } = {}) {
    const handle = request.user.profile.handle;
    const parsedSettings = await getSettingsRepo().get(handle);
    if (parsedSettings == null) {
        throw new Error(`settings missing for handle ${handle}`);
    }
    const settings = JSON.stringify(parsedSettings);

    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = await presetsFromRepo(handle, 'novel');
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = await presetsFromRepo(handle, 'openai');
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = await presetsFromRepo(handle, 'textgenerationwebui');
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = await presetsFromRepo(handle, 'kobold');

    const world_names = await getWorldInfoRepo().listNames(handle);

    const themes = await namedDocsFromRepo(handle, 'themes');
    const movingUIPresets = await namedDocsFromRepo(handle, 'movingUI');
    const quickReplyPresets = includeQuickReplyPresets
        ? await namedDocsFromRepo(handle, 'quickReplies')
        : [];

    // instruct / context / sysprompt / reasoning are still in PresetRepo (not
    // NamedDocRepo) — their bodies use the `name` field internally and the
    // frontend expects raw parsed objects, not the {fileContents, fileNames}
    // pair. Drop the wrapper.
    const instructEntries = await getPresetRepo().listWithDocs(handle, 'instruct');
    const contextEntries = await getPresetRepo().listWithDocs(handle, 'context');
    const syspromptEntries = await getPresetRepo().listWithDocs(handle, 'sysprompt');
    const reasoningEntries = await getPresetRepo().listWithDocs(handle, 'reasoning');
    const stampedName = (e) => {
        if (e.doc && typeof e.doc === 'object' && !Array.isArray(e.doc)) {
            if (typeof e.doc.name !== 'string' || !e.doc.name) {
                return { ...e.doc, name: e.name };
            }
            return e.doc;
        }
        return { name: e.name };
    };
    const instruct = instructEntries.map(stampedName);
    const context = contextEntries.map(stampedName);
    const sysprompt = syspromptEntries.map(stampedName);
    const reasoning = reasoningEntries.map(stampedName);


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
            const userDirectories = getUserDirectories(handle);
            await backupUserSettings(handle, userDirectories, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings doc by reading the LIVE state from
 * SettingsRepo (not the on-disk settings.json — that file is only the FS
 * engine's storage shape and is empty in db modes). Writes the resulting
 * JSON to `<backups>/settings_<handle>_<ts>.json`.
 * @param {string} handle User handle
 * @param {object} userDirectories Per-user directory map (from request.user.directories or getUserDirectories)
 * @param {boolean} preventDuplicates Skip when content matches the latest backup
 * @returns {Promise<void>}
 */
async function backupUserSettings(handle, userDirectories, preventDuplicates) {
    if (!fs.existsSync(userDirectories.root)) {
        return;
    }
    fs.mkdirSync(userDirectories.backups, { recursive: true });

    const settingsDoc = await getSettingsRepo().get(handle);
    if (settingsDoc == null) return;
    const serialized = JSON.stringify(settingsDoc, null, 4);

    if (preventDuplicates && isDuplicateBackup(userDirectories, handle, serialized)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    fs.writeFileSync(backupFile, serialized, 'utf8');
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks whether the latest backup file matches the current Repo snapshot.
 * Reads the previous backup off disk and string-compares against the
 * already-serialized current content.
 */
function isDuplicateBackup(userDirectories, handle, currentSerialized) {
    const latestBackup = getLatestBackup(userDirectories, handle);
    if (!latestBackup) {
        return false;
    }
    try {
        return fs.readFileSync(latestBackup, 'utf8') === currentSerialized;
    } catch {
        return false;
    }
}

/**
 * Gets the latest backup file for a user.
 */
function getLatestBackup(userDirectories, handle) {
    if (!fs.existsSync(userDirectories.backups)) return null;
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
        triggerAutoSave(handle, request.user.directories);
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
        triggerAutoSave(handle, request.user.directories);
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

// Settings snapshots live on disk as `<backups>/settings_<handle>_<ts>.json`
// regardless of storage mode. They're admin-visible artifacts (rotation,
// archival tools, manual recovery) so leaving them on the filesystem is
// intentional. The CONTENTS of those files now come from SettingsRepo, not
// from a stale on-disk settings.json. See backupUserSettings.
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

router.post('/make-snapshot', async (request, response) => {
    try {
        await backupUserSettings(request.user.profile.handle, request.user.directories, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

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

        // Load the snapshot from disk and write it through SettingsRepo. The
        // legacy implementation overwrote `<root>/settings.json` directly,
        // which is a silent no-op in db modes (the engine reads from a SQL
        // table, not from disk).
        const raw = fs.readFileSync(snapshotPath, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseErr) {
            console.error('restore-snapshot: snapshot file is not valid JSON', parseErr);
            return response.status(400).send({ error: 'Snapshot file is corrupt.' });
        }
        await getSettingsRepo().save(request.user.profile.handle, parsed);

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
