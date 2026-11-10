import fs from 'node:fs';
import path from 'node:path';

export const POINTER_FILE = 'data-location.json';
export const POINTER_VERSION = 1;
export const DATA_ENTRIES = Object.freeze([
    'config.yaml',
    'data',
    'backups',
    'plugins',
    'extensions',
    'http-auth.json',
]);

const isWindows = process.platform === 'win32';

/**
 * Resolve every existing ancestor to its physical path, so two spellings of
 * the same directory compare equal and a link cannot pose as a separate
 * folder. A missing tail is kept as written, because the caller may be
 * comparing a directory that has not been created yet.
 */
function canonicalPath(value) {
    const resolved = path.resolve(value);
    const missing = [];
    let current = resolved;
    while (true) {
        try {
            const real = fs.realpathSync(current);
            return missing.length === 0 ? real : path.join(real, ...missing.reverse());
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
                throw error;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return resolved;
            }
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

function normalizedPath(value) {
    const canonical = canonicalPath(value);
    return isWindows ? canonical.toLowerCase() : canonical;
}

function samePath(a, b) {
    return normalizedPath(a) === normalizedPath(b);
}

function isInside(parent, child) {
    const relative = path.relative(normalizedPath(parent), normalizedPath(child));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function invalid(pointerPath, detail) {
    return {
        state: null,
        error: {
            code: 'pointer-invalid',
            message: `Invalid data location record at ${pointerPath}: ${detail}`,
        },
    };
}

function validateState(pointerPath, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return invalid(pointerPath, 'the record is not an object.');
    }
    if (value.version !== undefined && value.version !== POINTER_VERSION) {
        return invalid(pointerPath, `unsupported version ${value.version}.`);
    }
    if (typeof value.userData !== 'string' || !value.userData || !path.isAbsolute(value.userData)) {
        return invalid(pointerPath, 'userData must be an absolute path.');
    }
    if (value.pendingMoveTo !== undefined && value.pendingDeleteFrom !== undefined) {
        return invalid(pointerPath, 'pendingMoveTo and pendingDeleteFrom cannot coexist.');
    }
    if (value.pendingMoveToIdentity !== undefined && value.pendingMoveTo === undefined) {
        return invalid(pointerPath, 'pendingMoveToIdentity requires pendingMoveTo.');
    }
    if (value.pendingMoveTo !== undefined
        && (typeof value.pendingMoveToIdentity !== 'string' || !/^\d+:\d+$/.test(value.pendingMoveToIdentity))) {
        return invalid(pointerPath, 'pendingMoveTo must carry the chosen folder identity.');
    }
    for (const key of ['pendingMoveTo', 'pendingDeleteFrom']) {
        const pending = value[key];
        if (pending === undefined) {
            continue;
        }
        if (typeof pending !== 'string' || !pending || !path.isAbsolute(pending)) {
            return invalid(pointerPath, `${key} must be an absolute path.`);
        }
        try {
            if (samePath(value.userData, pending) || isInside(value.userData, pending) || isInside(pending, value.userData)) {
                return invalid(pointerPath, `${key} must be outside userData.`);
            }
        } catch (error) {
            return invalid(pointerPath, `${key} cannot be resolved: ${error.message}`);
        }
    }
    return {
        state: {
            version: POINTER_VERSION,
            userData: value.userData,
            ...(value.pendingMoveTo === undefined ? {} : { pendingMoveTo: value.pendingMoveTo }),
            ...(value.pendingMoveToIdentity === undefined ? {} : { pendingMoveToIdentity: value.pendingMoveToIdentity }),
            ...(value.pendingDeleteFrom === undefined ? {} : { pendingDeleteFrom: value.pendingDeleteFrom }),
        },
        error: null,
    };
}

export function pointerPathFor(defaultUserData) {
    return path.join(defaultUserData, POINTER_FILE);
}

export function readLocationState(pointerPath) {
    let contents;
    try {
        contents = fs.readFileSync(pointerPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { state: null, error: null };
        }
        return invalid(pointerPath, error.message);
    }
    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch (error) {
        return invalid(pointerPath, error.message);
    }
    return validateState(pointerPath, parsed);
}

export function writeLocationState(pointerPath, state) {
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    const temporaryPath = `${pointerPath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        try {
            fs.renameSync(temporaryPath, pointerPath);
        } catch (error) {
            if ((error.code === 'EEXIST' || error.code === 'EPERM') && fs.existsSync(pointerPath)) {
                fs.rmSync(pointerPath, { force: true });
                fs.renameSync(temporaryPath, pointerPath);
            } else {
                throw error;
            }
        }
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

export function classifyDataTarget(target, { source, defaultUserData }) {
    const resolvedTarget = path.resolve(target);
    const resolvedSource = path.resolve(source);
    const resolvedDefault = path.resolve(defaultUserData);
    if (samePath(resolvedTarget, resolvedSource)) {
        return { mode: 'reject', reason: 'same' };
    }
    if (isInside(resolvedSource, resolvedTarget) || isInside(resolvedTarget, resolvedSource)) {
        return { mode: 'reject', reason: 'nested' };
    }
    if (isInside(resolvedTarget, resolvedDefault)) {
        return { mode: 'reject', reason: 'default-ancestor' };
    }

    let targetStats;
    try {
        targetStats = fs.statSync(resolvedTarget);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { mode: 'move' };
        }
        if (error.code === 'ENOTDIR') {
            return { mode: 'reject', reason: 'not-directory' };
        }
        throw error;
    }
    if (!targetStats.isDirectory()) {
        return { mode: 'reject', reason: 'not-directory' };
    }

    const entries = fs.readdirSync(resolvedTarget);
    if (entries.length === 0) {
        return { mode: 'move' };
    }
    if (entries.every(entry => entry === POINTER_FILE) && samePath(resolvedTarget, resolvedDefault)) {
        return { mode: 'move' };
    }

    let configStats;
    let dataStats;
    try {
        configStats = fs.statSync(path.join(resolvedTarget, 'config.yaml'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    try {
        dataStats = fs.statSync(path.join(resolvedTarget, 'data'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    if (configStats?.isFile() && dataStats?.isDirectory()) {
        return { mode: 'adopt' };
    }
    return { mode: 'reject', reason: 'unrecognized' };
}

function isExistingDataDirectory(directory) {
    try {
        return fs.statSync(path.join(directory, 'config.yaml')).isFile()
            && fs.statSync(path.join(directory, 'data')).isDirectory();
    } catch {
        return false;
    }
}

function isEmptyOrPointerOnly(directory, defaultDirectory) {
    let entries;
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return false;
    }
    if (entries.length === 0) {
        return true;
    }
    return samePath(directory, defaultDirectory)
        && entries.length === 1
        && entries[0] === POINTER_FILE;
}

/**
 * The startup error flow only points Luker at a folder; it never copies data.
 * The folder still may not contain the pointer, and it must be an empty folder
 * or an existing Luker directory.
 */
export function classifyRecoveryTarget(target, { defaultUserData }) {
    const resolvedTarget = path.resolve(target);
    if (isInside(resolvedTarget, defaultUserData)) {
        return { mode: 'reject', reason: 'default-ancestor' };
    }
    let stats;
    try {
        stats = fs.statSync(resolvedTarget);
    } catch (error) {
        if (error.code === 'ENOTDIR') {
            return { mode: 'reject', reason: 'not-directory' };
        }
        if (error.code === 'ENOENT') {
            return { mode: 'reject', reason: 'unrecognized' };
        }
        throw error;
    }
    if (!stats.isDirectory()) {
        return { mode: 'reject', reason: 'not-directory' };
    }
    if (isExistingDataDirectory(resolvedTarget)) {
        return { mode: 'adopt' };
    }
    if (isEmptyOrPointerOnly(resolvedTarget, defaultUserData)) {
        return { mode: 'empty' };
    }
    return { mode: 'reject', reason: 'unrecognized' };
}

export function directoryIdentity(directory) {
    const stats = fs.statSync(directory, { bigint: true });
    if (!stats.isDirectory()) {
        throw new Error(`${directory} is not a directory.`);
    }
    return `${stats.dev}:${stats.ino}`;
}

export function validateWritableDirectory(target) {
    const probe = path.join(
        target,
        `.luker-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
        fs.writeFileSync(probe, '');
    } catch (error) {
        throw new Error(`Luker cannot write to ${target}: ${error.message}`);
    } finally {
        fs.rmSync(probe, { force: true });
    }
}

function measureEntry(entryPath) {
    const stats = fs.lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
        return 0;
    }
    if (stats.isFile()) {
        return stats.size;
    }
    if (!stats.isDirectory()) {
        throw new Error(`Unsupported file type at ${entryPath}.`);
    }
    let total = 0;
    for (const name of fs.readdirSync(entryPath)) {
        total += measureEntry(path.join(entryPath, name));
    }
    return total;
}

export function checkFreeSpace(source, target) {
    let required = 0;
    for (const entry of DATA_ENTRIES) {
        try {
            required += measureEntry(path.join(source, entry));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    try {
        const stats = fs.statfsSync(target);
        const available = Number(stats.bavail) * Number(stats.bsize);
        return { enough: available >= required, required, available };
    } catch {
        return { enough: true, required, available: null };
    }
}

function realpathIfPresent(entryPath) {
    try {
        return fs.realpathSync(entryPath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
            return null;
        }
        throw error;
    }
}

function isSameOrInside(parent, child) {
    return samePath(parent, child) || isInside(parent, child);
}

/**
 * A link copied verbatim points at the same place from the destination. When
 * that place is inside the old data folder but outside the items being copied,
 * cleanup would delete the data the link needs. Reject the move instead.
 */
async function assertNoSourceOnlyLinks(source, entries) {
    const sourceReal = realpathIfPresent(source);
    if (!sourceReal) {
        return;
    }
    const copiedRoots = [];
    for (const entry of entries) {
        const entryPath = path.join(source, entry);
        let stats;
        try {
            stats = await fs.promises.lstat(entryPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        if (stats.isSymbolicLink()) {
            continue;
        }
        const real = realpathIfPresent(entryPath);
        if (real) {
            copiedRoots.push(real);
        }
    }

    const walk = async (entryPath) => {
        const stats = await fs.promises.lstat(entryPath);
        if (stats.isSymbolicLink()) {
            const resolved = realpathIfPresent(entryPath);
            if (!resolved) {
                return;
            }
            const insideSource = isSameOrInside(sourceReal, resolved);
            const insideCopied = copiedRoots.some(root => isSameOrInside(root, resolved));
            const linkTarget = await fs.promises.readlink(entryPath);
            if (insideSource && (path.isAbsolute(linkTarget) || !insideCopied)) {
                throw new Error(
                    `Cannot move ${entryPath}: the symbolic link points into the old data folder and would not survive the move.`,
                );
            }
            return;
        }
        if (!stats.isDirectory()) {
            return;
        }
        for (const name of await fs.promises.readdir(entryPath)) {
            await walk(path.join(entryPath, name));
        }
    };
    for (const entry of entries) {
        const entryPath = path.join(source, entry);
        try {
            await fs.promises.lstat(entryPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        await walk(entryPath);
    }
}

async function countTree(entryPath) {
    const stats = await fs.promises.lstat(entryPath);
    if (stats.isSymbolicLink()) {
        return { files: 1, bytes: 0 };
    }
    if (stats.isFile()) {
        return { files: 1, bytes: stats.size };
    }
    if (!stats.isDirectory()) {
        throw new Error(`Unsupported file type at ${entryPath}.`);
    }
    let files = 0;
    let bytes = 0;
    for (const name of await fs.promises.readdir(entryPath)) {
        const child = await countTree(path.join(entryPath, name));
        files += child.files;
        bytes += child.bytes;
    }
    return { files, bytes };
}

async function copyTree(sourcePath, targetPath, progress, emit) {
    const stats = await fs.promises.lstat(sourcePath);
    if (stats.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(sourcePath);
        let type = 'file';
        try {
            if ((await fs.promises.stat(sourcePath)).isDirectory()) {
                type = 'dir';
            }
        } catch {
            // Broken links keep the default type; Windows only uses this hint.
        }
        await fs.promises.symlink(linkTarget, targetPath, type);
        progress.copiedFiles += 1;
        emit();
        return;
    }
    if (stats.isDirectory()) {
        await fs.promises.mkdir(targetPath, { recursive: true });
        for (const name of await fs.promises.readdir(sourcePath)) {
            await copyTree(path.join(sourcePath, name), path.join(targetPath, name), progress, emit);
        }
        if (process.platform !== 'win32') {
            await fs.promises.chmod(targetPath, stats.mode);
            await fs.promises.utimes(targetPath, stats.atime, stats.mtime);
        }
        return;
    }
    if (stats.isFile()) {
        await fs.promises.copyFile(sourcePath, targetPath);
        if (process.platform !== 'win32') {
            await fs.promises.chmod(targetPath, stats.mode);
            await fs.promises.utimes(targetPath, stats.atime, stats.mtime);
        }
        progress.copiedBytes += stats.size;
        progress.copiedFiles += 1;
        emit();
        return;
    }
    throw new Error(`Unsupported file type at ${sourcePath}.`);
}

export async function migrateDataDirectory({
    source, target, entries = DATA_ENTRIES, onProgress = null,
    targetIdentity = null, defaultUserData = null,
}) {
    let targetStats;
    try {
        targetStats = fs.statSync(target);
    } catch (error) {
        throw new Error(`The move target is not available: ${target} (${error.message})`);
    }
    if (!targetStats.isDirectory()) {
        throw new Error(`The move target is not a directory: ${target}`);
    }
    if (targetIdentity !== null && directoryIdentity(target) !== targetIdentity) {
        throw new Error(`The move target is no longer the chosen folder: ${target}`);
    }
    const sourceStats = fs.statSync(source);
    if (!sourceStats.isDirectory()) {
        throw new Error(`The current data folder is not a directory: ${source}`);
    }
    if (samePath(source, target) || isInside(source, target) || isInside(target, source)) {
        throw new Error(`The move target overlaps the current data folder: ${target}`);
    }
    if (defaultUserData !== null && isInside(target, defaultUserData)) {
        throw new Error(`The move target contains the default data folder: ${target}`);
    }
    await assertNoSourceOnlyLinks(source, entries);

    let totalFiles = 0;
    let totalBytes = 0;
    for (const entry of entries) {
        try {
            const counted = await countTree(path.join(source, entry));
            totalFiles += counted.files;
            totalBytes += counted.bytes;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    const removeTargetEntries = async () => {
        for (const entry of entries) {
            await fs.promises.rm(path.join(target, entry), { recursive: true, force: true });
        }
    };
    await removeTargetEntries();

    const progress = { copiedFiles: 0, copiedBytes: 0 };
    let lastEmit = 0;
    const emit = (force = false) => {
        if (!onProgress) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastEmit < 100) {
            return;
        }
        lastEmit = now;
        onProgress({
            copiedBytes: progress.copiedBytes,
            totalBytes,
            copiedFiles: progress.copiedFiles,
            totalFiles,
        });
    };
    emit(true);

    try {
        for (const entry of entries) {
            const sourceEntry = path.join(source, entry);
            try {
                await fs.promises.lstat(sourceEntry);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            await copyTree(sourceEntry, path.join(target, entry), progress, emit);
        }
    } catch (error) {
        await removeTargetEntries();
        throw error;
    }

    if (progress.copiedBytes !== totalBytes) {
        await removeTargetEntries();
        throw new Error(`Copied ${progress.copiedBytes} of ${totalBytes} bytes from ${source}.`);
    }
    emit(true);
    return { copiedBytes: progress.copiedBytes, copiedFiles: progress.copiedFiles };
}

export async function cleanupSourceDirectory({ source, defaultUserData }) {
    try {
        await fs.promises.lstat(source);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (samePath(source, defaultUserData)) {
        for (const name of await fs.promises.readdir(source)) {
            if (name === POINTER_FILE) {
                continue;
            }
            await fs.promises.rm(path.join(source, name), { recursive: true, force: true });
        }
        return;
    }
    await fs.promises.rm(source, { recursive: true, force: true });
}

export async function finishPendingCleanup({ pointerPath, state, defaultUserData }) {
    if (!state?.pendingDeleteFrom) {
        return state;
    }
    await cleanupSourceDirectory({ source: state.pendingDeleteFrom, defaultUserData });
    const next = { version: POINTER_VERSION, userData: state.userData };
    writeLocationState(pointerPath, next);
    return next;
}

export function resolveLocation({ defaultUserData, envUserData = null }) {
    const resolvedDefault = path.resolve(defaultUserData);
    const pointerPath = pointerPathFor(resolvedDefault);
    if (envUserData) {
        return {
            activeUserData: path.resolve(envUserData),
            defaultUserData: resolvedDefault,
            pointerPath,
            locked: true,
            state: null,
            error: null,
        };
    }
    const { state, error } = readLocationState(pointerPath);
    if (error) {
        return {
            activeUserData: resolvedDefault,
            defaultUserData: resolvedDefault,
            pointerPath,
            locked: false,
            state: null,
            error,
        };
    }
    if (state) {
        return {
            activeUserData: state.userData,
            defaultUserData: resolvedDefault,
            pointerPath,
            locked: false,
            state,
            error: null,
        };
    }
    return {
        activeUserData: resolvedDefault,
        defaultUserData: resolvedDefault,
        pointerPath,
        locked: false,
        state: null,
        error: null,
    };
}
