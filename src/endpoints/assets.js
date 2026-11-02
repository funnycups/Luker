import path from 'node:path';
import fs from 'node:fs';
import { finished } from 'node:stream/promises';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import fetch from 'node-fetch';

import { UNSAFE_EXTENSIONS } from '../constants.js';
import { clientRelativePath, isValidUrl } from '../util.js';
import { getHostFromUrl, isHostWhitelisted } from './content-manager.js';
import { runGatedWrite } from '../sync/in-progress-gate.js';
import { makeStagingPath, isStagingEntryName } from '../sync/staging.js';

const VALID_CATEGORIES = ['bgm', 'ambient', 'blip', 'live2d', 'vrm', 'character', 'temp'];

/**
 * Validates the input filename for the asset.
 * @param {string} inputFilename Input filename
 * @returns {{error: boolean, message?: string}} Whether validation failed, and why if so
 */
export function validateAssetFileName(inputFilename) {
    if (!/^[a-zA-Z0-9_\-.]+$/.test(inputFilename)) {
        return {
            error: true,
            message: 'Illegal character in filename; only alphanumeric, \'_\', \'-\' are accepted.',
        };
    }

    const inputExtension = path.extname(inputFilename).toLowerCase();
    if (UNSAFE_EXTENSIONS.some(ext => ext === inputExtension)) {
        return {
            error: true,
            message: 'Forbidden file extension.',
        };
    }

    if (inputFilename.startsWith('.')) {
        return {
            error: true,
            message: 'Filename cannot start with \'.\'',
        };
    }

    if (sanitize(inputFilename) !== inputFilename) {
        return {
            error: true,
            message: 'Reserved or long filename.',
        };
    }

    return { error: false };
}

/**
 * Recursive function to get files
 * @param {string} dir - The directory to search for files
 * @param {string[]} files - The array of files to return
 * @returns {string[]} - The array of files
 */
function getFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    // Get an array of all files and directories in the passed directory using fs.readdirSync
    const fileList = fs.readdirSync(dir, { withFileTypes: true });
    // Create the full path of the file/directory by concatenating the passed directory and file/directory name
    for (const file of fileList) {
        if (isStagingEntryName(file.name)) continue;
        const name = path.join(dir, file.name);
        // Check if the current file/directory is a directory using fs.statSync
        if (file.isDirectory()) {
            // If it is a directory, recursively call the getFiles function with the directory path and the files array
            getFiles(name, files);
        } else {
            // If it is a file, push the full path to the files array
            files.push(name);
        }
    }
    return files;
}

/**
 * Ensure that the asset folders exist.
 * @param {import('../users.js').UserDirectoryList} directories - The user's directories
 */
function ensureFoldersExist(directories) {
    const folderPath = path.join(directories.assets);

    for (const category of VALID_CATEGORIES) {
        const assetCategoryPath = path.join(folderPath, category);
        if (fs.existsSync(assetCategoryPath) && !fs.statSync(assetCategoryPath).isDirectory()) {
            fs.unlinkSync(assetCategoryPath);
        }
        if (!fs.existsSync(assetCategoryPath)) {
            fs.mkdirSync(assetCategoryPath, { recursive: true });
        }
    }
}

export const router = express.Router();

/**
 * HTTP POST handler function to retrieve name of all files of a given folder path.
 *
 * @param {Object} request - HTTP Request object. Require folder path in query
 * @param {Object} response - HTTP Response object will contain a list of file path.
 *
 * @returns {void}
 */
router.post('/get', async (request, response) => {
    const folderPath = path.join(request.user.directories.assets);
    let output = {};

    try {
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            ensureFoldersExist(request.user.directories);

            const folders = fs.readdirSync(folderPath, { withFileTypes: true })
                .filter(file => file.isDirectory());

            for (const { name: folder } of folders) {
                if (folder == 'temp')
                    continue;

                // Live2d assets
                if (folder == 'live2d') {
                    output[folder] = [];
                    const live2d_folder = path.normalize(path.join(folderPath, folder));
                    const files = getFiles(live2d_folder);
                    //console.debug("FILE FOUND:",files)
                    for (let file of files) {
                        if (file.includes('model') && file.endsWith('.json')) {
                            //console.debug("Asset live2d model found:",file)
                            output[folder].push(clientRelativePath(request.user.directories.root, file));
                        }
                    }
                    continue;
                }

                // VRM assets
                if (folder == 'vrm') {
                    output[folder] = { 'model': [], 'animation': [] };
                    // Extract models
                    const vrm_model_folder = path.normalize(path.join(folderPath, 'vrm', 'model'));
                    let files = getFiles(vrm_model_folder);
                    //console.debug("FILE FOUND:",files)
                    for (let file of files) {
                        if (!file.endsWith('.placeholder')) {
                            //console.debug("Asset VRM model found:",file)
                            output.vrm.model.push(clientRelativePath(request.user.directories.root, file));
                        }
                    }

                    // Extract models
                    const vrm_animation_folder = path.normalize(path.join(folderPath, 'vrm', 'animation'));
                    files = getFiles(vrm_animation_folder);
                    //console.debug("FILE FOUND:",files)
                    for (let file of files) {
                        if (!file.endsWith('.placeholder')) {
                            //console.debug("Asset VRM animation found:",file)
                            output.vrm.animation.push(clientRelativePath(request.user.directories.root, file));
                        }
                    }
                    continue;
                }

                // Other assets (bgm/ambient/blip)
                const files = fs.readdirSync(path.join(folderPath, folder))
                    .filter(filename => {
                        return filename != '.placeholder' && !isStagingEntryName(filename);
                    });
                output[folder] = [];
                for (const file of files) {
                    output[folder].push(`assets/${folder}/${file}`);
                }
            }
        }
    } catch (err) {
        console.error(err);
    }
    return response.send(output);
});

/**
 * HTTP POST handler function to download the requested asset.
 *
 * @param {Object} request - HTTP Request object, expects a url, a category and a filename.
 * @param {Object} response - HTTP Response only gives status.
 *
 * @returns {void}
 */
router.post('/download', async (request, response) => {
    let stagingDir = null;
    // Staging is removed before every response, so a client that sees the
    // response never sees the staging directory. A failed removal is logged
    // and never blocks the response.
    const removeStaging = async () => {
        if (!stagingDir) return;
        try {
            await fs.promises.rm(stagingDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Failed to remove asset staging directory', stagingDir, cleanupError);
        }
        stagingDir = null;
    };
    try {
        if (!isValidUrl(request.body.url)) {
            console.warn('Asset download failed: Must be a valid URL');
            return response.sendStatus(400);
        }

        const url = String(request.body.url);
        const inputCategory = request.body.category;

        const host = getHostFromUrl(url);
        if (!isHostWhitelisted(host)) {
            console.error(`Received an import for "${host}", but site is not whitelisted. This domain must be added to the config key "whitelistImportDomains" to allow import from this source.`);
            return response.sendStatus(404);
        }

        // Check category
        let category = null;
        for (let i of VALID_CATEGORIES)
            if (i == inputCategory)
                category = i;

        if (category === null) {
            console.error('Bad request: unsupported asset category.');
            return response.sendStatus(400);
        }

        // Validate filename
        ensureFoldersExist(request.user.directories);
        const validation = validateAssetFileName(request.body.filename);
        if (validation.error)
            return response.status(400).send(validation.message);

        // Download into a staging sibling of the destination, so the
        // transfer holds no write-gate slot and a snapshot never sees a
        // partial file.
        const file_path = path.join(request.user.directories.assets, category, request.body.filename);
        stagingDir = await makeStagingPath(file_path, 'asset');
        const tempPath = path.join(stagingDir, request.body.filename);
        console.info('Request received to download', url, 'to', file_path);

        const res = await fetch(url);
        if (!res.ok || res.body === null) {
            throw new Error(`Unexpected response ${res.statusText}`);
        }
        const fileStream = fs.createWriteStream(tempPath, { flags: 'wx' });
        // @ts-ignore
        await finished(res.body.pipe(fileStream));

        if (category === 'character') {
            const fileContent = fs.readFileSync(tempPath);
            const contentType = mime.lookup(tempPath) || 'application/octet-stream';
            await removeStaging();
            response.setHeader('Content-Type', contentType);
            response.send(fileContent);
            return;
        }

        console.info('Download finished, moving file from', tempPath, 'to', file_path);
        const syncOwner = { handle: request.user.profile.handle, userRoot: request.user.directories.root };
        await runGatedWrite(syncOwner, async () => {
            fs.copyFileSync(tempPath, file_path);
        });
        await removeStaging();
        response.sendStatus(200);
    } catch (error) {
        console.error(error);
        await removeStaging();
        response.sendStatus(500);
    }
});

/**
 * HTTP POST handler function to delete the requested asset.
 *
 * @param {Object} request - HTTP Request object, expects a category and a filename
 * @param {Object} response - HTTP Response only gives stats.
 *
 * @returns {void}
 */
router.post('/delete', async (request, response) => {
    const inputCategory = request.body.category;

    // Check category
    let category = null;
    for (let i of VALID_CATEGORIES)
        if (i == inputCategory)
            category = i;

    if (category === null) {
        console.error('Bad request: unsupported asset category.');
        return response.sendStatus(400);
    }

    // Validate filename
    const validation = validateAssetFileName(request.body.filename);
    if (validation.error)
        return response.status(400).send(validation.message);

    const file_path = path.join(request.user.directories.assets, category, request.body.filename);
    console.info('Request received to delete', category, file_path);

    try {
        if (!fs.existsSync(file_path)) {
            console.error('Asset not found.');
            return response.sendStatus(400);
        }

        await fs.promises.unlink(file_path);
        console.info('Asset deleted.');
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

///////////////////////////////
/**
 * HTTP POST handler function to retrieve a character background music list.
 *
 * @param {Object} request - HTTP Request object, expects a character name in the query.
 * @param {Object} response - HTTP Response object will contain a list of audio file path.
 *
 * @returns {void}
 */
router.post('/character', async (request, response) => {
    if (request.query.name === undefined) return response.sendStatus(400);

    // For backwards compatibility, don't reject invalid character names, just sanitize them
    const name = sanitize(request.query.name.toString());
    const inputCategory = request.query.category;

    // Check category
    let category = null;
    for (let i of VALID_CATEGORIES)
        if (i == inputCategory)
            category = i;

    if (category === null) {
        console.error('Bad request: unsupported asset category.');
        return response.sendStatus(400);
    }

    const folderPath = path.join(request.user.directories.characters, name, category);

    let output = [];
    try {
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            // Live2d assets
            if (category == 'live2d') {
                const folders = fs.readdirSync(folderPath, { withFileTypes: true });
                for (const folderInfo of folders) {
                    if (!folderInfo.isDirectory()) continue;

                    const modelFolder = folderInfo.name;
                    const live2dModelPath = path.join(folderPath, modelFolder);
                    for (let file of fs.readdirSync(live2dModelPath)) {
                        //console.debug("Character live2d model found:", file)
                        if (file.includes('model') && file.endsWith('.json'))
                            output.push(path.join('characters', name, category, modelFolder, file));
                    }
                }
                return response.send(output);
            }

            // Other assets
            const files = fs.readdirSync(folderPath)
                .filter(filename => {
                    return filename != '.placeholder';
                });

            for (let i of files)
                output.push(`/characters/${name}/${category}/${i}`);
        }
        return response.send(output);
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});
