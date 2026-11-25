import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getFileVersion } from '../../../src/storage/file-version.js';

/** Preserve physical filenames: a stem-keyed map would discard coexisting files. */
export function worldFilenameState(directory) {
    const enumeration = fs.readdirSync(directory);
    const files = Object.fromEntries(enumeration.filter(name => path.extname(name).toLowerCase() === '.json').sort().map(name => {
        const file = path.join(directory, name);
        const bytes = fs.readFileSync(file);
        const stat = fs.statSync(file);
        return [name, { bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), doc: JSON.parse(bytes.toString('utf8')), version: getFileVersion(file), inode: stat.ino, device: stat.dev }];
    }));
    return { enumeration, files };
}
