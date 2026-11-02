import fs from 'node:fs';
import path from 'node:path';

/** Validate a complete path chain, including its trusted boundary and leaf. */
export function assertConfinedPath({ boundary, absolutePath }) {
    const root = path.resolve(boundary);
    const relative = path.relative(root, path.resolve(absolutePath));
    const fail = entry => Object.assign(new Error(`Unsafe live path at ${entry}: the path must remain inside ${root} without symbolic links`), { code: 'SYNC_UNSAFE_LIVE_PATH' });
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail(absolutePath);
    let current = root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
        if (segment) current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw fail(current);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
            throw error;
        }
    }
}
