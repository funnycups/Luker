import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

function fingerprint(stat) {
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Reads the current parsed JSON object for a file, reusing the last parse only
 * while the file identity, size, mtime and ctime are unchanged.
 *
 * Parse failures throw and leave the previous cache entry untouched.
 */
export function readCurrentJsonFile(filePath) {
    const key = path.resolve(filePath);
    let stat;
    try {
        stat = fs.statSync(key, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            cache.delete(key);
            return null;
        }
        throw error;
    }

    const fingerprintValue = fingerprint(stat);
    const cached = cache.get(key);
    if (cached?.fingerprint === fingerprintValue) {
        return cached.value;
    }

    const value = JSON.parse(fs.readFileSync(key, 'utf8'));
    cache.set(key, { fingerprint: fingerprintValue, value });
    return value;
}

export function invalidateCurrentJsonFile(filePath) {
    cache.delete(path.resolve(filePath));
}
