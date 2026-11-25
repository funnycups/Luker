import { createHash } from 'node:crypto';

/** Hash the ordered relative paths and content hashes of a skill bundle. */
export function hashFiles(files) {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file.relPath); hash.update('\0');
        hash.update(file.sha256); hash.update('\0');
    }
    return hash.digest('hex');
}
