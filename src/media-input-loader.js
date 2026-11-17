// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';

import { isPathUnderParent } from './util.js';

export const ALLOWED_REFERENCE_ROLES = Object.freeze(new Set(['character', 'style', 'source']));

function stripQueryAndHash(rawPath) {
    return rawPath.split(/[?#]/, 1)[0];
}

function normalizeRelativeClientPath(clientPath) {
    if (typeof clientPath !== 'string') {
        throw new Error('Media input path must be a non-empty relative path string.');
    }
    const trimmed = clientPath.trim();
    if (!trimmed) {
        throw new Error('Media input path cannot be empty.');
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) {
        throw new Error(`External URL is not allowed as a managed media input; pass a local relative path instead: ${trimmed}`);
    }
    if (trimmed.includes('\0') || trimmed.includes('\\')) {
        throw new Error(`Media input path is not allowed: ${trimmed}`);
    }
    const stripped = stripQueryAndHash(trimmed);
    let decoded = stripped;
    try {
        decoded = decodeURIComponent(stripped);
    } catch {
        throw new Error(`Invalid percent-encoding in media input path: ${trimmed}`);
    }
    return decoded.replace(/^\/+/, '');
}

function getAllowedRoots(directories) {
    if (!directories || typeof directories !== 'object' || typeof directories.root !== 'string') {
        throw new Error('User directories are required to load managed media inputs.');
    }
    return [
        directories.userImages,
        directories.characters,
        directories.avatars,
    ].filter(dir => typeof dir === 'string' && dir.length > 0).map(dir => path.resolve(dir));
}

/**
 * Loads a managed user media file strictly within userImages, characters, or avatars.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} clientPath
 */
export async function loadManagedMediaInput(directories, clientPath) {
    const allowedRoots = getAllowedRoots(directories);
    const relativeTarget = normalizeRelativeClientPath(clientPath);
    const rootResolved = path.resolve(directories.root);
    const candidatePath = path.resolve(rootResolved, relativeTarget);

    const withinAllowed = allowedRoots.some(allowedDir => isPathUnderParent(allowedDir, candidatePath));
    if (!withinAllowed) {
        throw new Error(`Path "${clientPath}" is outside any managed media directory (allowed: /user/images, /characters, /User Avatars).`);
    }

    let stat;
    try {
        stat = await fs.promises.stat(candidatePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(`Managed media file not found: ${clientPath}`);
        }
        throw error;
    }
    if (!stat.isFile()) {
        throw new Error(`Managed media path is not a regular file: ${clientPath}`);
    }

    const realCandidate = await fs.promises.realpath(candidatePath);
    const realAllowedRoots = await Promise.all(
        allowedRoots.map(async dir => {
            try {
                return await fs.promises.realpath(dir);
            } catch {
                return dir;
            }
        }),
    );
    if (!realAllowedRoots.some(realRoot => isPathUnderParent(realRoot, realCandidate))) {
        throw new Error(`Symlink target for "${clientPath}" escapes managed media directories.`);
    }

    const buffer = await fs.promises.readFile(realCandidate);
    const detectedMime = mime.lookup(realCandidate) || 'application/octet-stream';
    if (!String(detectedMime).startsWith('image/')) {
        throw new Error(`Managed media input "${clientPath}" is not a supported image type (${detectedMime}).`);
    }
    const base64 = buffer.toString('base64');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return {
        diskPath: candidatePath,
        buffer,
        base64,
        sha256,
        mimeType: detectedMime,
        dataUrl: `data:${detectedMime};base64,${base64}`,
    };
}

/**
 * Validates and loads an array of structured reference image descriptors.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Array<object>} [references]
 */
export async function loadReferenceInputs(directories, references = []) {
    if (references == null) {
        return [];
    }
    if (!Array.isArray(references)) {
        throw new Error('references must be an array.');
    }
    const loaded = [];
    for (const [index, entry] of references.entries()) {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`references[${index}] must be an object.`);
        }
        const role = String(entry.role || 'character').trim();
        if (!ALLOWED_REFERENCE_ROLES.has(role)) {
            throw new Error(`Invalid reference role "${role}" at references[${index}]; expected character, style, or source.`);
        }
        const imagePath = String(entry.imagePath || '').trim();
        const media = await loadManagedMediaInput(directories, imagePath);
        const strength = entry.strength === undefined || entry.strength === null ? undefined : Number(entry.strength);
        if (strength !== undefined && (!Number.isFinite(strength) || strength < 0 || strength > 2)) {
            throw new Error(`Invalid reference strength at references[${index}]: ${entry.strength}`);
        }
        const fidelity = entry.fidelity === undefined || entry.fidelity === null ? undefined : Number(entry.fidelity);
        if (fidelity !== undefined && (!Number.isFinite(fidelity) || fidelity < 0 || fidelity > 1)) {
            throw new Error(`Invalid reference fidelity at references[${index}]: ${entry.fidelity}`);
        }
        loaded.push({
            imagePath,
            role,
            label: String(entry.label || '').trim(),
            strength,
            fidelity,
            styleAware: Boolean(entry.styleAware),
            ...media,
        });
    }
    return loaded;
}
