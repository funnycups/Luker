// SPDX-License-Identifier: AGPL-3.0-or-later
// Chunked restore upload sessions.
//
// Restore ZIPs arrive as raw octet-stream chunks keyed by their byte offset
// (`chunks/<offset>.part`, renamed to `<offset>.chunk` once complete) so a
// failed chunk retries idempotently without renumbering the rest of the
// queue. `finalizeRestoreUpload` validates the offset chain and concatenates
// the chunks into `archive.zip`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { UPLOADS_DIRECTORY } from './constants.js';

export const RESTORE_UPLOAD_SESSIONS_ROOT = 'restore-sessions';
// Abandoned sessions are swept lazily on init; 24h mirrors the cross-mode
// scratch GC so every upload-side leftover shares one retention policy.
export const RESTORE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const RESTORE_UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
// UI update throttle for assemble progress; purely cosmetic — emitting on
// every pipeline tick would flood the NDJSON progress stream.
const ASSEMBLE_PROGRESS_THROTTLE_MS = 100;

export function getRestoreUploadSessionsRoot(dataRoot) {
    return path.join(dataRoot, UPLOADS_DIRECTORY, RESTORE_UPLOAD_SESSIONS_ROOT);
}

export function getRestoreUploadSessionDir(dataRoot, uploadId) {
    if (!RESTORE_UPLOAD_ID_PATTERN.test(String(uploadId || ''))) {
        return null;
    }
    return path.join(getRestoreUploadSessionsRoot(dataRoot), uploadId);
}

export function getRestoreUploadArchivePath(dataRoot, uploadId) {
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    return dir ? path.join(dir, 'archive.zip') : null;
}

function getRestoreUploadMetaPath(dataRoot, uploadId) {
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    return dir ? path.join(dir, 'meta.json') : null;
}

function getRestoreUploadChunksDir(dataRoot, uploadId) {
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    return dir ? path.join(dir, 'chunks') : null;
}

export async function createRestoreUploadSession({ dataRoot, handle, fileName, size }) {
    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    await fsPromises.mkdir(path.join(dir, 'chunks'), { recursive: true });
    const meta = { handle, fileName, size, createdAt: new Date().toISOString() };
    await fsPromises.writeFile(getRestoreUploadMetaPath(dataRoot, uploadId), JSON.stringify(meta), 'utf8');
    return { uploadId, meta };
}

export async function readRestoreUploadMeta(dataRoot, uploadId) {
    const metaPath = getRestoreUploadMetaPath(dataRoot, uploadId);
    if (!metaPath) {
        return null;
    }
    try {
        return JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    } catch (err) {
        if (err?.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

/**
 * Stream one chunk onto disk. The body goes to `<offset>.part` and is only
 * renamed to `<offset>.chunk` after the whole request arrived, so an
 * interrupted upload never leaves a chunk the finalize pass would trust.
 * Retrying the same offset truncates the stale `.part` (write streams default
 * to the 'w' flag).
 */
export async function writeRestoreUploadChunk({ dataRoot, uploadId, offset, stream, declaredSize }) {
    const chunksDir = getRestoreUploadChunksDir(dataRoot, uploadId);
    const partPath = path.join(chunksDir, `${offset}.part`);
    const finalPath = path.join(chunksDir, `${offset}.chunk`);
    const remaining = declaredSize - offset;
    let bytes = 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > remaining) {
                callback(new RangeError('chunk_exceeds_declared_size'));
                return;
            }
            callback(null, chunk);
        },
    });
    try {
        await pipeline(stream, counter, fs.createWriteStream(partPath));
    } catch (err) {
        await fsPromises.rm(partPath, { force: true }).catch(() => {});
        throw err;
    }
    if (bytes === 0) {
        await fsPromises.rm(partPath, { force: true }).catch(() => {});
        throw new RangeError('empty_chunk');
    }
    await fsPromises.rename(partPath, finalPath);
    return { bytes };
}

export async function finalizeRestoreUpload({ dataRoot, uploadId, meta, onProgress = null }) {
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    const archivePath = path.join(dir, 'archive.zip');
    const declaredSize = meta.size;

    // Idempotent: a completed archive short-circuits a finalize retry — the
    // concat below is the expensive part.
    try {
        const stat = await fsPromises.stat(archivePath);
        if (stat.isFile() && stat.size === declaredSize) {
            return { size: declaredSize };
        }
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            throw err;
        }
    }

    const chunksDir = path.join(dir, 'chunks');
    const names = await fsPromises.readdir(chunksDir).catch((err) => {
        if (err?.code === 'ENOENT') return [];
        throw err;
    });
    const chunks = [];
    for (const name of names) {
        const match = /^(\d+)\.chunk$/.exec(name);
        if (!match) {
            continue; // *.part and anything unexpected are never trusted
        }
        const chunkPath = path.join(chunksDir, name);
        const stat = await fsPromises.stat(chunkPath);
        chunks.push({ offset: Number(match[1]), size: stat.size, path: chunkPath });
    }
    chunks.sort((a, b) => a.offset - b.offset);

    let cursor = 0;
    for (const chunk of chunks) {
        if (chunk.offset !== cursor) {
            throw makeUploadIncompleteError(`missing chunk at offset ${cursor}`, cursor);
        }
        cursor += chunk.size;
    }
    if (cursor !== declaredSize) {
        throw makeUploadIncompleteError(`assembled ${cursor} of ${declaredSize} bytes`, cursor);
    }

    const partPath = `${archivePath}.part`;
    await fsPromises.rm(partPath, { force: true });
    let copied = 0;
    let lastEmit = 0;
    const counter = new Transform({
        transform(data, _encoding, callback) {
            copied += data.length;
            if (onProgress) {
                const now = Date.now();
                if (now - lastEmit >= ASSEMBLE_PROGRESS_THROTTLE_MS || copied === declaredSize) {
                    lastEmit = now;
                    onProgress({ copied, total: declaredSize });
                }
            }
            callback(null, data);
        },
    });
    const chunkSource = Readable.from(async function* () {
        for (const chunk of chunks) {
            yield* fs.createReadStream(chunk.path);
        }
    }());
    await pipeline(chunkSource, counter, fs.createWriteStream(partPath));
    await fsPromises.rename(partPath, archivePath);
    await fsPromises.rm(chunksDir, { recursive: true, force: true });
    return { size: declaredSize };
}

function makeUploadIncompleteError(message, missingOffset) {
    const error = new Error(`upload_incomplete: ${message}`);
    error.code = 'UPLOAD_INCOMPLETE';
    error.missingOffset = missingOffset;
    return error;
}

export async function deleteRestoreUploadSession({ dataRoot, uploadId }) {
    const dir = getRestoreUploadSessionDir(dataRoot, uploadId);
    if (!dir) {
        return false;
    }
    await fsPromises.rm(dir, { recursive: true, force: true });
    return true;
}

export async function sweepStaleRestoreUploadSessions({ dataRoot, maxAgeMs }) {
    const root = getRestoreUploadSessionsRoot(dataRoot);
    let names;
    try {
        names = await fsPromises.readdir(root);
    } catch (err) {
        if (err?.code === 'ENOENT') {
            return { scanned: 0, removed: 0 };
        }
        throw err;
    }
    let scanned = 0;
    let removed = 0;
    const now = Date.now();
    for (const name of names) {
        if (!RESTORE_UPLOAD_ID_PATTERN.test(name)) {
            continue;
        }
        scanned += 1;
        const dir = path.join(root, name);
        let newestMs = 0;
        // Chunk writes refresh `chunks/` mtime, not the session dir's, so
        // both must be considered or a long in-flight upload gets swept.
        for (const candidate of [dir, path.join(dir, 'chunks')]) {
            try {
                newestMs = Math.max(newestMs, (await fsPromises.stat(candidate)).mtimeMs);
            } catch { /* missing candidate — ignore */ }
        }
        if (newestMs > 0 && now - newestMs > maxAgeMs) {
            try {
                await fsPromises.rm(dir, { recursive: true, force: true });
                removed += 1;
            } catch { /* best-effort */ }
        }
    }
    return { scanned, removed };
}
