import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.resolve(__dirname, '../config.yaml');

if (!getConfigFilePath()) {
    setConfigFilePath(configPath);
    reloadConfigCache();
}

// Mirror what server.js sets so middleware that reads files under
// `globalThis.DATA_ROOT` (e.g. basicAuth's unauthorized.html lookup) does not
// blow up under jest. Resolves to the repo's bundled default data dir.
if (!globalThis.DATA_ROOT) {
    globalThis.DATA_ROOT = path.resolve(__dirname, '../public');
}
