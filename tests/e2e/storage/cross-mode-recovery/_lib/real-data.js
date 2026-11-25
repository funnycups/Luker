import fs from 'node:fs';
import path from 'node:path';
import { materializeSeed } from '../../../../harness/seed.js';

export function resolveRealDataRoot(value = process.env.LUKER_REAL_DATA_ROOT) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('Compatibility input LUKER_REAL_DATA_ROOT requires an explicit absolute directory');
    const root = path.resolve(value);
    if (!fs.statSync(root).isDirectory()) throw new TypeError(`Compatibility input is not a directory: ${root}`);
    return root;
}

/** Materialize selected bytes, then transfer them into the registered application data owner. */
export async function cloneRealDataForSpec({ scope, sourceDataRoot, specId }) {
    const seed = await materializeSeed(scope, { fixture: { kind: 'compatibility', root: resolveRealDataRoot(sourceDataRoot) } });
    const directory = await scope.directory(`compatibility ${specId}`);
    for (const name of fs.readdirSync(seed.dataRoot)) fs.renameSync(path.join(seed.dataRoot, name), path.join(directory.path, name));
    return directory;
}

export function realDataLooksPopulated(dataRoot) {
    const userRoot = path.join(dataRoot, 'default-user');
    const fsChats = path.join(userRoot, 'chats');
    const sqliteFile = path.join(userRoot, 'luker-storage.sqlite');
    return fs.existsSync(fsChats) && fs.statSync(fsChats).isDirectory()
        || fs.existsSync(sqliteFile) && fs.statSync(sqliteFile).size > 0;
}
