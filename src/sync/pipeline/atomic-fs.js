import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import writeFileAtomic from 'write-file-atomic';

/**
 * fs client handed to isomorphic-git. isomorphic-git sends every file write
 * (loose objects, packfiles, refs, packed-refs, HEAD, config, index and
 * checkout output) through `writeFile`. Routing that through
 * write-file-atomic writes a sibling temp file and renames it over the
 * target, so a process killed mid-write leaves either the old file or the
 * new file, never a truncated one. The other methods are plain
 * `fs.promises`.
 *
 * isomorphic-git selects the promise API when the client has an enumerable
 * `promises` property, and binds readFile, writeFile, mkdir, rmdir, unlink,
 * stat, lstat, readdir, readlink, symlink and (when present) rm.
 */
export const atomicFs = Object.freeze({
    promises: Object.freeze({
        readFile: (...args) => fs.promises.readFile(...args),
        writeFile: (file, data, options) => writeFileAtomic(file, data, normalizeWriteOptions(options)),
        mkdir: (...args) => fs.promises.mkdir(...args),
        rmdir: (...args) => fs.promises.rmdir(...args),
        unlink: (...args) => fs.promises.unlink(...args),
        stat: (...args) => fs.promises.stat(...args),
        lstat: (...args) => fs.promises.lstat(...args),
        readdir: (...args) => fs.promises.readdir(...args),
        readlink: (...args) => fs.promises.readlink(...args),
        symlink: (...args) => fs.promises.symlink(...args),
        rm: (...args) => fs.promises.rm(...args),
    }),
});

/**
 * isomorphic-git passes nothing, an encoding string, or `{ mode, encoding }`.
 * write-file-atomic mutates its options object, so it always gets a copy.
 *
 * @param {unknown} options
 * @returns {object}
 */
function normalizeWriteOptions(options) {
    if (typeof options === 'string') return { encoding: options };
    if (!options || typeof options !== 'object') return {};
    return { ...options };
}

/** write-file-atomic names its temp file `<target>.<unsigned 32-bit murmur hash>`. */
const ATOMIC_TEMP_NAME = /^.+\.\d+$/;

/**
 * Wall-clock start of this process. A temp file whose mtime is older was
 * left by an earlier process that was killed between create and rename;
 * a newer one may belong to a write still in flight in this process.
 */
const PROCESS_STARTED_AT_MS = performance.timeOrigin;

/**
 * Delete write-file-atomic temp files that a killed process left inside a
 * git directory, so they are never listed as refs or tags. Sync-created ref
 * names, loose object names and pack names never end in `.<digits>`.
 * `objects/incoming/` holds the object receive path's own temp files and is
 * left alone.
 *
 * @param {string} gitdir
 * @returns {Promise<string[]>} removed paths relative to `gitdir`, POSIX form
 */
export async function sweepStaleAtomicTemps(gitdir) {
    const removed = [];
    const incoming = path.join(gitdir, 'objects', 'incoming');
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (abs !== incoming) await walk(abs);
                continue;
            }
            if (!entry.isFile() || !ATOMIC_TEMP_NAME.test(entry.name)) continue;
            try {
                const stat = await fs.promises.stat(abs);
                if (stat.mtimeMs >= PROCESS_STARTED_AT_MS) continue;
                await fs.promises.unlink(abs);
            } catch (error) {
                // Renamed into place or removed by a concurrent sweep.
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            removed.push(path.relative(gitdir, abs).split(path.sep).join('/'));
        }
    };
    await walk(gitdir);
    return removed;
}
