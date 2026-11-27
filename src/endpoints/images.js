import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';

import { clientRelativePath, removeFileExtension, getImages, isPathUnderParent } from '../util.js';
import { MEDIA_EXTENSIONS, MEDIA_REQUEST_TYPE } from '../constants.js';
import { appendMediaAttribution } from './media-attribution.js';
import {
    assertTransientMediaMutation,
    assertTransientMediaRead,
    deleteTransientImage,
    getTransientSession,
    TRANSIENT_MEDIA_DIRECTORY,
    writeTransientImage,
} from '../transient-sessions.js';

export const AI_ATTACHMENTS_DIRECTORY = '_ai_attachments';

const HIDDEN_GALLERY_DIRECTORIES = new Set([
    TRANSIENT_MEDIA_DIRECTORY,
    AI_ATTACHMENTS_DIRECTORY,
]);

function normalizeClientRelativePath(rawPath) {
    if (typeof rawPath !== 'string') return '';
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) return '';
    const withoutQuery = trimmed.split(/[?#]/, 1)[0];
    let decoded;
    try {
        decoded = decodeURIComponent(withoutQuery);
    } catch {
        return '';
    }
    if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('//')) {
        return '';
    }
    return decoded.replace(/^\/+/, '');
}

async function resolveRealDir(dirPath) {
    try {
        return await fs.promises.realpath(dirPath);
    } catch (err) {
        if (err?.code === 'ENOENT') {
            return path.resolve(dirPath);
        }
        throw err;
    }
}

/**
 * Ensure the directory for the provided file path exists.
 * If not, it will recursively create the directory.
 *
 * @param {string} filePath - The full path of the file for which the directory should be ensured.
 */
function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

export const router = express.Router();

/**
 * Endpoint to handle image uploads.
 * The image should be provided in the request body in base64 format.
 * Optionally, a character name can be provided to save the image in a sub-folder.
 *
 * @route POST /api/images/upload
 * @param {Object} request.body - The request payload.
 * @param {string} request.body.image - The base64 encoded image data.
 * @param {string} [request.body.ch_name] - Optional character name to determine the sub-directory.
 * @returns {Object} response - The response object containing the path where the image was saved.
 */
router.post('/upload', async (request, response) => {
    try {
        if (!request.body) {
            return response.status(400).send({ error: 'No data provided' });
        }

        const { image, format } = request.body;

        if (!image) {
            return response.status(400).send({ error: 'No image data provided' });
        }

        const validFormat = MEDIA_EXTENSIONS.includes(format);
        if (!validFormat) {
            return response.status(400).send({ error: 'Invalid image format' });
        }
        const transientSession = getTransientSession(request);
        if (!transientSession && sanitize(String(request.body.ch_name || '')).toLowerCase() === TRANSIENT_MEDIA_DIRECTORY) {
            return response.status(403).json({ error: 'The temporary media directory requires an owned session.' });
        }

        // Constructing filename and path
        let filename;
        if (request.body.filename) {
            filename = `${removeFileExtension(request.body.filename)}.${format}`;
        } else {
            filename = `${transientSession ? randomUUID() : Date.now()}.${format}`;
        }
        if (transientSession) {
            const savedPath = await writeTransientImage(transientSession, sanitize(filename), Buffer.from(image, 'base64'));
            return response.send({ path: savedPath });
        }

        // if character is defined, save to a sub folder for that character
        let pathToNewFile = path.join(request.user.directories.userImages, sanitize(filename));
        if (request.body.ch_name) {
            pathToNewFile = path.join(request.user.directories.userImages, sanitize(request.body.ch_name), sanitize(filename));
        }

        ensureDirectoryExistence(pathToNewFile);
        const imageBuffer = Buffer.from(image, 'base64');
        await fs.promises.writeFile(pathToNewFile, new Uint8Array(imageBuffer));
        const savedPath = clientRelativePath(request.user.directories.root, pathToNewFile);
        if (request.body.attribution) {
            try {
                await appendMediaAttribution(request.user, request.body.attribution, savedPath, request.body.ch_name);
            } catch (error) {
                console.warn('Failed to record media attribution:', error);
            }
        }
        response.send({ path: savedPath });
    } catch (error) {
        console.error(error);
        response.status(error.status || 500).send({ error: 'Failed to save the image', details: error.message });
    }
});

router.post('/list/:folder?', (request, response) => {
    try {
        if (request.params.folder) {
            if (request.body.folder) {
                return response.status(400).send({ error: 'Folder specified in both URL and body' });
            }

            console.warn('Deprecated: Use POST /api/images/list with folder in request body');
            request.body.folder = request.params.folder;
        }

        if (!request.body.folder) {
            return response.status(400).send({ error: 'No folder specified' });
        }
        const normalizedFolder = sanitize(String(request.body.folder)).toLowerCase();
        if (HIDDEN_GALLERY_DIRECTORIES.has(normalizedFolder)) {
            return response.status(403).send({ error: 'Internal media folders cannot be listed in the gallery.' });
        }

        const directoryPath = path.join(request.user.directories.userImages, sanitize(request.body.folder));
        const type = Number(request.body.type ?? MEDIA_REQUEST_TYPE.IMAGE);
        const sort = request.body.sortField || 'date';
        const order = request.body.sortOrder || 'asc';

        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }

        const images = getImages(directoryPath, sort, type);
        if (order === 'desc') {
            images.reverse();
        }
        return response.send(images);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'Unable to retrieve files' });
    }
});

router.post('/folders', (request, response) => {
    try {
        const directoryPath = request.user.directories.userImages;
        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }

        const folders = fs.readdirSync(directoryPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && !HIDDEN_GALLERY_DIRECTORIES.has(dirent.name.toLowerCase()))
            .map(dirent => dirent.name);

        return response.send(folders);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'Unable to retrieve folders' });
    }
});

router.post('/delete', async (request, response) => {
    try {
        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const pathToDelete = path.join(request.user.directories.root, request.body.path);
        if (!isPathUnderParent(request.user.directories.userImages, pathToDelete)) {
            return response.status(400).send('Invalid path');
        }
        const transientSession = assertTransientMediaMutation(request, pathToDelete);

        if (!fs.existsSync(pathToDelete)) {
            return response.status(404).send('File not found');
        }

        if (transientSession) {
            await deleteTransientImage(transientSession, pathToDelete);
        } else {
            fs.unlinkSync(pathToDelete);
        }
        console.info(`Deleted image: ${request.body.path} from ${request.user.profile.handle}`);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.status(error.status || 500).send({ error: error.message });
    }
});

router.post('/copy', async (request, response) => {
    try {
        const rawPaths = request.body?.paths;
        if (!Array.isArray(rawPaths)) {
            return response.status(400).json({ error: 'paths must be an array.' });
        }
        const uniquePaths = [...new Set(rawPaths.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))];
        if (uniquePaths.length === 0) {
            return response.json({ copies: {}, missing: [] });
        }

        const userRoot = path.resolve(request.user.directories.root);
        const userImagesDir = path.resolve(request.user.directories.userImages);
        const realUserImagesDir = await resolveRealDir(userImagesDir);
        const targetDir = path.join(userImagesDir, AI_ATTACHMENTS_DIRECTORY);
        await fs.promises.mkdir(targetDir, { recursive: true });

        const copies = {};
        const missing = [];
        const createdDestPaths = [];
        const cleanupCreated = async () => {
            if (createdDestPaths.length === 0) return;
            const results = await Promise.allSettled(createdDestPaths.splice(0).map(p => fs.promises.unlink(p)));
            for (const r of results) {
                if (r.status === 'rejected' && r.reason?.code !== 'ENOENT') {
                    console.error('[images/copy] Failed to remove rolled-back attachment:', r.reason);
                }
            }
        };
        try {
            for (const rawPath of uniquePaths) {
                const rel = normalizeClientRelativePath(rawPath);
                if (!rel) {
                    await cleanupCreated();
                    return response.status(400).json({ error: `Invalid image path: ${rawPath}` });
                }
                const sourceAbs = path.resolve(userRoot, rel);
                if (!isPathUnderParent(userImagesDir, sourceAbs)) {
                    await cleanupCreated();
                    return response.status(400).json({ error: `Path is outside user images directory: ${rawPath}` });
                }
                assertTransientMediaRead(request, rawPath);

                let stat;
                try {
                    stat = await fs.promises.stat(sourceAbs);
                } catch (err) {
                    if (err?.code === 'ENOENT') {
                        missing.push(rawPath);
                        continue;
                    }
                    throw err;
                }
                if (!stat.isFile()) {
                    await cleanupCreated();
                    return response.status(400).json({ error: `Path is not a regular file: ${rawPath}` });
                }
                const realSource = await fs.promises.realpath(sourceAbs);
                if (!isPathUnderParent(realUserImagesDir, realSource)) {
                    await cleanupCreated();
                    return response.status(400).json({ error: `Symlink target escapes user images directory: ${rawPath}` });
                }
                const resolvedInUserImages = path.resolve(userImagesDir, path.relative(realUserImagesDir, realSource));
                assertTransientMediaRead(request, clientRelativePath(userRoot, resolvedInUserImages));

                const ext = path.extname(realSource).toLowerCase().replace(/^\./, '');
                const safeExt = MEDIA_EXTENSIONS.includes(ext) ? ext : 'png';
                const destPath = path.join(targetDir, `${randomUUID()}.${safeExt}`);
                createdDestPaths.push(destPath);
                await fs.promises.copyFile(realSource, destPath);
                copies[rawPath] = clientRelativePath(userRoot, destPath);
            }
        } catch (innerError) {
            await cleanupCreated();
            throw innerError;
        }

        return response.json({ copies, missing });
    } catch (error) {
        console.error('Image copy failed:', error);
        return response.status(error?.status || 500).json({ error: error?.message || 'Failed to copy images.' });
    }
});

router.post('/delete-batch', async (request, response) => {
    try {
        const rawPaths = request.body?.paths;
        if (!Array.isArray(rawPaths)) {
            return response.status(400).json({ error: 'paths must be an array.' });
        }
        const uniquePaths = [...new Set(rawPaths.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))];
        if (uniquePaths.length === 0) {
            return response.json({ deleted: [], missing: [], failed: [] });
        }

        const userRoot = path.resolve(request.user.directories.root);
        const attachmentsDir = path.resolve(request.user.directories.userImages, AI_ATTACHMENTS_DIRECTORY);
        const realAttachmentsDir = await resolveRealDir(attachmentsDir);

        const deleted = [];
        const missing = [];
        const failed = [];
        const validatedTargets = [];
        // Validate every path in the batch before unlinking anything so an HTTP 400
        // rejection never leaves partial deletions behind.
        for (const rawPath of uniquePaths) {
            const rel = normalizeClientRelativePath(rawPath);
            if (!rel) {
                return response.status(400).json({ error: `Invalid attachment path: ${rawPath}` });
            }
            const targetAbs = path.resolve(userRoot, rel);
            if (!isPathUnderParent(attachmentsDir, targetAbs)) {
                return response.status(400).json({ error: `Batch deletion is restricted to ${AI_ATTACHMENTS_DIRECTORY}: ${rawPath}` });
            }

            let lstat;
            try {
                lstat = await fs.promises.lstat(targetAbs);
            } catch (err) {
                if (err?.code === 'ENOENT') {
                    missing.push(rawPath);
                    continue;
                }
                failed.push({ path: rawPath, error: String(err?.message || err) });
                continue;
            }
            if (lstat.isSymbolicLink() || !lstat.isFile()) {
                return response.status(400).json({ error: `Attachment path must be a regular file: ${rawPath}` });
            }
            const realTarget = await fs.promises.realpath(targetAbs);
            if (!isPathUnderParent(realAttachmentsDir, realTarget)) {
                return response.status(400).json({ error: `Path escapes ${AI_ATTACHMENTS_DIRECTORY}: ${rawPath}` });
            }
            validatedTargets.push({ rawPath, realTarget });
        }

        for (const { rawPath, realTarget } of validatedTargets) {
            try {
                await fs.promises.unlink(realTarget);
                deleted.push(rawPath);
            } catch (err) {
                if (err?.code === 'ENOENT') {
                    missing.push(rawPath);
                } else {
                    failed.push({ path: rawPath, error: String(err?.message || err) });
                }
            }
        }

        return response.json({ deleted, missing, failed });
    } catch (error) {
        console.error('Batch image deletion failed:', error);
        return response.status(error?.status || 500).json({ error: error?.message || 'Failed to delete attachment images.' });
    }
});
