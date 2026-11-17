import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

function fingerprint(stat) {
    return `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Reads the current parsed JSON object and per-fingerprint derived cache map
 * for a file, reusing the last parse only while the file identity, mode, size,
 * mtime and ctime are unchanged.
 *
 * Parse failures throw and leave the previous cache entry untouched.
 */
export function readCurrentJsonFileEntry(filePath) {
    const key = path.resolve(filePath);
    let stat;
    try {
        stat = fs.statSync(key, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            cache.delete(key);
            return null;
        }
        throw error;
    }
    if (!stat.isFile()) {
        cache.delete(key);
        return null;
    }

    const fingerprintValue = fingerprint(stat);
    const cached = cache.get(key);
    if (cached?.fingerprint === fingerprintValue) {
        return cached;
    }

    const value = JSON.parse(fs.readFileSync(key, 'utf8'));
    const entry = { fingerprint: fingerprintValue, value, derived: new Map() };
    cache.set(key, entry);
    return entry;
}

export function readCurrentJsonFile(filePath) {
    return readCurrentJsonFileEntry(filePath)?.value ?? null;
}

export function invalidateCurrentJsonFile(filePath) {
    cache.delete(path.resolve(filePath));
}
