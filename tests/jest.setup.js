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
