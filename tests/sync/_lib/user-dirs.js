import fs from 'node:fs';
import path from 'node:path';

import { USER_DIRECTORY_TEMPLATE } from '../../../src/constants.js';

/**
 * Full per-user directory list rooted at `root`, same shape the server builds.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function makeUserDirs(root) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRECTORY_TEMPLATE)) dirs[key] = path.join(root, rel);
    for (const key of ['characters', 'worlds']) fs.mkdirSync(dirs[key], { recursive: true });
    return dirs;
}
