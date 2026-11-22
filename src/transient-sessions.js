// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { clientRelativePath, isPathUnderParent } from './util.js';

export const TRANSIENT_SESSION_HEADER = 'X-Luker-Transient-Session';
export const TRANSIENT_MEDIA_DIRECTORY = '_sandbox_tmp';
const JOURNAL_FILENAME = 'session.json';
// Server-issued UUIDs are also the names of the owned session directories.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessions = new Map();
const ownerSessions = new WeakMap();
const requestSessions = new WeakMap();

export class TransientSessionError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function assertOpen(session) {
    if (session.state !== 'open') {
        throw new TransientSessionError(410, 'TRANSIENT_SESSION_CLOSED', 'The temporary media session is closed.');
    }
}

function journalData(session) {
    return {
        version: 1,
        id: session.id,
        userHandle: session.userHandle,
        state: session.state,
        files: [...session.files],
        promotions: [...session.promotions.values()],
    };
}

function persistJournal(session) {
    const write = () => writeFileAtomic(
        path.join(session.directory, JOURNAL_FILENAME),
        JSON.stringify(journalData(session)),
    );
    // Each caller receives its own write failure. A later explicit retry must
    // still be able to write after a previous failed filesystem operation.
    session.journalWrite = session.journalWrite.then(write, write);
    return session.journalWrite;
}

function makeSession({ id, userHandle, directories, owner = null }) {
    return {
        id,
        userHandle,
        directories,
        owner,
        directory: path.join(directories.userImages, TRANSIENT_MEDIA_DIRECTORY, id),
        state: 'open',
        files: new Set(),
        promotions: new Map(),
        operations: new Set(),
        cleanupHandlers: new Set(),
        journalWrite: Promise.resolve(),
        closePromise: null,
    };
}

export async function createTransientSession({ userHandle, directories, owner }) {
    const session = makeSession({ id: randomUUID(), userHandle, directories, owner });
    const parent = path.dirname(session.directory);
    await fs.mkdir(parent, { recursive: true });
    if ((await fs.lstat(parent)).isSymbolicLink()) {
        throw new Error(`Temporary media directory must not be a symbolic link: ${parent}`);
    }
    await fs.mkdir(session.directory);
    try {
        await persistJournal(session);
    } catch (error) {
        try {
            await fs.rm(session.directory, { recursive: true });
        } catch (cleanupError) {
            throw new globalThis.AggregateError([error, cleanupError], `Cannot initialize or remove temporary media session ${session.id}`);
        }
        throw error;
    }
    sessions.set(session.id, session);
    let owned = ownerSessions.get(owner);
    if (!owned) {
        owned = new Set();
        ownerSessions.set(owner, owned);
    }
    owned.add(session);
    return session;
}

export function getTransientSessionForUser(id, userHandle, { allowClosing = false, allowMissing = false } = {}) {
    if (id === undefined) return null;
    const session = sessions.get(id);
    if (!session && allowMissing) return null;
    if (!session || session.userHandle !== userHandle) {
        throw new TransientSessionError(403, 'TRANSIENT_SESSION_FORBIDDEN', 'The temporary media session does not belong to this user.');
    }
    if (!allowClosing) assertOpen(session);
    return session;
}

export function getTransientSession(request, options) {
    return getTransientSessionForUser(
        request?.headers?.[TRANSIENT_SESSION_HEADER.toLowerCase()],
        request?.user?.profile?.handle,
        options,
    );
}

export function getRequestTransientSession(request) {
    const bound = requestSessions.get(request);
    if (bound) return bound;
    const session = getTransientSession(request);
    if (session) requestSessions.set(request, session);
    return session;
}

export async function closeTransientSessionForRequest(request) {
    let session = getTransientSession(request, { allowClosing: true, allowMissing: true });
    if (!session) {
        session = await loadJournalSession(request.user.directories, request.get(TRANSIENT_SESSION_HEADER));
    }
    if (session) await closeTransientSession(session);
}

export function trackTransientOperation(session, promise, { abort } = {}) {
    assertOpen(session);
    const operation = { promise: Promise.resolve(promise), abort };
    session.operations.add(operation);
    const finished = () => session.operations.delete(operation);
    operation.promise.then(finished, finished);
    return operation.promise;
}

export function registerTransientCleanup(session, cleanup) {
    if (session.state === 'closed') {
        throw new TransientSessionError(410, 'TRANSIENT_SESSION_CLOSED', 'The temporary media session is closed.');
    }
    // An already registered operation may acquire a resource while close is
    // waiting for it. Its cleanup must be included before close completes.
    session.cleanupHandlers.add(cleanup);
    return () => session.cleanupHandlers.delete(cleanup);
}

export function runTransientStateWrite(request, namespace, write) {
    const session = getTransientSession(request);
    if (!session) return write();
    if (![...session.promotions.values()].some(promotion => promotion.namespace === namespace)) {
        throw new TransientSessionError(403, 'TRANSIENT_STATE_FORBIDDEN', 'This state namespace has no pending image promotion in the temporary media session.');
    }
    // Closing waits for accepted commits before checking which final images are
    // referenced. A request arriving after close cannot acquire this authority.
    return trackTransientOperation(session, Promise.resolve().then(write));
}

function absoluteClientPath(directories, imagePath) {
    if (typeof imagePath !== 'string' || !imagePath || /^[a-z][a-z0-9+.-]*:/i.test(imagePath)) {
        throw new TransientSessionError(400, 'INVALID_MEDIA_PATH', 'Expected a managed image path.');
    }
    const decoded = decodeURIComponent(imagePath.split(/[?#]/, 1)[0]);
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.startsWith('//')) {
        throw new TransientSessionError(400, 'INVALID_MEDIA_PATH', 'Invalid managed image path.');
    }
    return path.resolve(directories.root, decoded.replace(/^\/+/, ''));
}

export function isTransientMediaPath(directories, absolutePath) {
    const relative = path.relative(directories.userImages, absolutePath);
    return relative.split(path.sep)[0].toLowerCase() === TRANSIENT_MEDIA_DIRECTORY;
}

function ownedImagePath(session, imagePath) {
    const absolute = absoluteClientPath(session.directories, imagePath);
    const relative = clientRelativePath(session.directories.root, absolute);
    if (!isPathUnderParent(session.directory, absolute) || !session.files.has(relative)) {
        throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'The image does not belong to this temporary media session.');
    }
    return absolute;
}

export function assertTransientMediaMutation(request, absolutePath) {
    const session = getTransientSession(request);
    if (!isTransientMediaPath(request.user.directories, absolutePath)) {
        if (session) {
            throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'A temporary media session cannot change a formal media file.');
        }
        return null;
    }
    if (!session) {
        throw new TransientSessionError(403, 'TRANSIENT_SESSION_REQUIRED', 'A temporary media session is required for this image.');
    }
    ownedImagePath(session, clientRelativePath(session.directories.root, absolutePath));
    return session;
}

export function assertTransientMediaRead(request, imagePath) {
    const session = getTransientSession(request);
    const absolute = absoluteClientPath(request.user.directories, imagePath);
    if (!isTransientMediaPath(request.user.directories, absolute)) return null;
    if (path.basename(absolute).toLowerCase() === JOURNAL_FILENAME) {
        throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'Temporary media session journals cannot be read directly.');
    }
    if (!session) {
        throw new TransientSessionError(403, 'TRANSIENT_SESSION_REQUIRED', 'An owned temporary media session is required for this image.');
    }
    ownedImagePath(session, imagePath);
    return session;
}

/**
 * Authorize an HTTP `/user/images/*` request using the exact path resolution
 * that `createRouteHandler` performs (a single `decodeURIComponent` on
 * `request.params[0]` with no `?`/`#` truncation).
 */
export function assertTransientMediaRouteRead(request, rawParam) {
    if (typeof rawParam !== 'string') {
        throw new TransientSessionError(400, 'INVALID_MEDIA_PATH', 'Expected a managed image path.');
    }
    let decoded;
    try {
        decoded = decodeURIComponent(rawParam);
    } catch {
        throw new TransientSessionError(400, 'INVALID_MEDIA_PATH', 'Invalid percent-encoding in image path.');
    }
    if (decoded.includes('\\') || decoded.includes('\0')) {
        throw new TransientSessionError(400, 'INVALID_MEDIA_PATH', 'Invalid managed image path.');
    }
    const directories = request.user.directories;
    const absolute = path.resolve(path.join(directories.userImages, decoded));
    if (!isPathUnderParent(directories.userImages, absolute)) {
        throw new TransientSessionError(403, 'INVALID_MEDIA_PATH', 'Image path escapes user images directory.');
    }
    if (!isTransientMediaPath(directories, absolute)) return null;
    if (path.basename(absolute).toLowerCase() === JOURNAL_FILENAME) {
        throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'Temporary media session journals cannot be read directly.');
    }
    const session = getTransientSession(request);
    if (!session) {
        throw new TransientSessionError(403, 'TRANSIENT_SESSION_REQUIRED', 'An owned temporary media session is required for this image.');
    }
    const relative = clientRelativePath(session.directories.root, absolute);
    if (!isPathUnderParent(session.directory, absolute) || !session.files.has(relative)) {
        throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'The image does not belong to this temporary media session.');
    }
    return session;
}

export function deleteTransientImage(session, absolutePath) {
    assertOpen(session);
    const relative = clientRelativePath(session.directories.root, absolutePath);
    if (!isPathUnderParent(session.directory, absolutePath) || !session.files.has(relative)) {
        throw new TransientSessionError(403, 'TRANSIENT_MEDIA_FORBIDDEN', 'The image does not belong to this temporary media session.');
    }
    const deleting = (async () => {
        await fs.unlink(absolutePath);
        session.files.delete(relative);
        await persistJournal(session);
    })();
    return trackTransientOperation(session, deleting);
}

export function writeTransientImage(session, filename, buffer) {
    assertOpen(session);
    if (!filename || path.basename(filename) !== filename || filename === '.' || filename === '..') {
        throw new TransientSessionError(400, 'INVALID_MEDIA_FILENAME', 'Expected an image filename without a directory.');
    }
    const absolute = path.join(session.directory, filename);
    const relative = clientRelativePath(session.directories.root, absolute);
    const writing = (async () => {
        session.files.add(relative);
        await persistJournal(session);
        await fs.writeFile(absolute, buffer);
        return relative;
    })();
    return trackTransientOperation(session, writing);
}

function referencedImages(document, session, images) {
    if (document != null && (typeof document !== 'object' || Array.isArray(document))) {
        throw new Error('The reference state is not a JSON object.');
    }
    const candidates = new Map(images.map(image => [
        absoluteClientPath(session.directories, image.imagePath),
        image.imagePath,
    ]));
    const referenced = new Set();
    function visit(value) {
        if (typeof value === 'string' && /^\/?user\/images\//.test(value)) {
            const candidate = candidates.get(absoluteClientPath(session.directories, value));
            if (candidate) referenced.add(candidate);
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item);
        } else if (value && typeof value === 'object') {
            for (const item of Object.values(value)) visit(item);
        }
    }
    visit(document);
    return referenced;
}

async function readReferenceDocument(session, namespace) {
    const { getNamedDocRepo } = await import('./storage/index.js');
    const result = await getNamedDocRepo().read(session.userHandle, 'globalStates', namespace);
    if (!result.exists) return null;
    if (!result.valid) {
        throw new Error(`Cannot read reference state "${namespace}": ${result.detail}`);
    }
    return result.value;
}

function assertPromotionPaths(session, promotion) {
    if (!SESSION_ID_PATTERN.test(promotion.id)
        || typeof promotion.namespace !== 'string' || !promotion.namespace || !Array.isArray(promotion.images)) {
        throw new Error(`Invalid promotion journal for session ${session.id}`);
    }
    for (const image of promotion.images) {
        ownedImagePath(session, image.sourcePath);
        const destination = absoluteClientPath(session.directories, image.imagePath);
        const references = path.join(session.directories.userImages, '_references');
        if (path.dirname(destination) !== references || !path.basename(destination).startsWith(promotion.id + '-')) {
            throw new Error(`Invalid promoted image path in session ${session.id}: ${image.imagePath}`);
        }
    }
}

async function settlePromotion(session, promotion, { rollback = false, persist = true } = {}) {
    assertPromotionPaths(session, promotion);
    const document = await readReferenceDocument(session, promotion.namespace);
    const referenced = referencedImages(document, session, promotion.images);
    if (rollback && referenced.size) {
        throw new TransientSessionError(409, 'PROMOTION_IN_USE', 'The promoted images are already referenced by saved state.');
    }
    for (const image of promotion.images) {
        if (!referenced.has(image.imagePath)) {
            await fs.rm(absoluteClientPath(session.directories, image.imagePath), { force: true });
        }
    }
    session.promotions.delete(promotion.id);
    if (persist) await persistJournal(session);
    return { retained: [...referenced] };
}

export function promoteTransientImages(session, imagePaths, { namespace } = {}) {
    assertOpen(session);
    if (!Array.isArray(imagePaths) || typeof namespace !== 'string' || !namespace) {
        throw new TransientSessionError(400, 'INVALID_PROMOTION', 'Expected an image path array and a target state namespace.');
    }
    const sources = [...new Set(imagePaths)].map(imagePath => ({ imagePath, absolute: ownedImagePath(session, imagePath) }));
    const promotionId = randomUUID();
    const promotion = {
        id: promotionId,
        namespace,
        images: sources.map(({ imagePath, absolute }, index) => ({
            sourcePath: imagePath,
            imagePath: clientRelativePath(session.directories.root, path.join(
                session.directories.userImages, '_references', `${promotionId}-${index}${path.extname(absolute)}`,
            )),
        })),
    };
    const promoting = (async () => {
        for (const source of sources) {
            const stat = await fs.lstat(source.absolute);
            if (!stat.isFile()) {
                throw new TransientSessionError(400, 'INVALID_PROMOTION_IMAGE', 'Only regular temporary image files can be promoted.');
            }
        }
        // Read the actual namespace before acquiring final filenames. Failure
        // must not be mistaken for an empty archive.
        await readReferenceDocument(session, namespace);
        session.promotions.set(promotion.id, promotion);
        await persistJournal(session);
        const references = path.join(session.directories.userImages, '_references');
        if (sources.length) await fs.mkdir(references, { recursive: true });
        for (const [index, source] of sources.entries()) {
            await fs.copyFile(
                source.absolute,
                absoluteClientPath(session.directories, promotion.images[index].imagePath),
                fs.constants.COPYFILE_EXCL,
            );
        }
        return { promotionId: promotion.id, images: promotion.images.map(image => ({ ...image })) };
    })();
    return trackTransientOperation(session, promoting);
}

export function rollbackTransientPromotion(session, promotionId) {
    assertOpen(session);
    const promotion = session.promotions.get(promotionId);
    if (!promotion) {
        throw new TransientSessionError(404, 'PROMOTION_NOT_FOUND', 'The image promotion was not found in this session.');
    }
    return trackTransientOperation(session, settlePromotion(session, promotion, { rollback: true }));
}

export function completeTransientPromotion(session, promotionId) {
    assertOpen(session);
    const promotion = session.promotions.get(promotionId);
    if (!promotion) {
        throw new TransientSessionError(404, 'PROMOTION_NOT_FOUND', 'The image promotion was not found in this session.');
    }
    return trackTransientOperation(session, settlePromotion(session, promotion));
}

export async function closeTransientSession(session) {
    if (session.state === 'closed') return;
    if (session.closePromise) return session.closePromise;
    session.state = 'closing';
    session.closePromise = (async () => {
        for (const operation of session.operations) operation.abort?.();
        await persistJournal(session);
        await Promise.allSettled([...session.operations].map(operation => operation.promise));
        for (const cleanup of session.cleanupHandlers) await cleanup();
        for (const promotion of [...session.promotions.values()]) await settlePromotion(session, promotion);
        await fs.rm(session.directory, { recursive: true });
        session.state = 'closed';
        session.files.clear();
        session.cleanupHandlers.clear();
        if (!session.owner || session.owner.readyState !== session.owner.OPEN) {
            sessions.delete(session.id);
            if (session.owner) ownerSessions.get(session.owner)?.delete(session);
        }
    })();
    try {
        await session.closePromise;
    } catch (error) {
        session.closePromise = null;
        throw error;
    }
}

export async function closeTransientOwnerSessions(owner) {
    const owned = ownerSessions.get(owner);
    if (!owned) return;
    const outcomes = await Promise.allSettled([...owned].map(closeTransientSession));
    for (const session of owned) {
        if (session.state === 'closed') {
            sessions.delete(session.id);
            owned.delete(session);
        }
    }
    const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new globalThis.AggregateError(errors, 'Temporary media cleanup failed after the owner disconnected.');
}

async function loadJournalSession(directories, id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
        throw new TransientSessionError(400, 'INVALID_TRANSIENT_SESSION', 'Expected a server-issued temporary session identifier.');
    }
    const directory = path.join(directories.userImages, TRANSIENT_MEDIA_DIRECTORY, id);
    let stat;
    try {
        stat = await fs.lstat(directory);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isDirectory()) throw new Error(`Unexpected temporary media entry: ${directory}`);
    const journal = JSON.parse(await fs.readFile(path.join(directory, JOURNAL_FILENAME), 'utf8'));
    if (journal.version !== 1 || journal.id !== id
        || journal.userHandle !== path.basename(directories.root)
        || !Array.isArray(journal.files) || !Array.isArray(journal.promotions)) {
        throw new Error(`Invalid temporary media journal: ${directory}`);
    }
    const session = makeSession({ id, userHandle: journal.userHandle, directories });
    session.state = 'closing';
    session.files = new Set(journal.files);
    session.promotions = new Map(journal.promotions.map(promotion => [promotion.id, promotion]));
    for (const filename of session.files) ownedImagePath(session, filename);
    for (const promotion of session.promotions.values()) assertPromotionPaths(session, promotion);
    sessions.set(id, session);
    return session;
}

export async function recoverTransientSessions(directoriesList) {
    const failures = [];
    for (const directories of directoriesList) {
        const parent = path.join(directories.userImages, TRANSIENT_MEDIA_DIRECTORY);
        let entries;
        try {
            entries = await fs.readdir(parent, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        for (const entry of entries) {
            const directory = path.join(parent, entry.name);
            try {
                if (!entry.isDirectory()) throw new Error(`Unexpected temporary media entry: ${directory}`);
                const session = await loadJournalSession(directories, entry.name);
                if (session) await closeTransientSession(session);
            } catch (error) {
                console.error(`Cannot recover temporary media session ${directory}:`, error);
                failures.push({ directory, error });
            }
        }
    }
    return { failures };
}
