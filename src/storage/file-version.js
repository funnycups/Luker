import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Content and file identity, including same-content replacement. */
export function getFileVersion(filePath) {
    const stat = fs.statSync(filePath, { bigint: true });
    return createHash('sha256')
        .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':'))
        .update('\0')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}
