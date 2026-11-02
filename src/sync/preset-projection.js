import path from 'node:path';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import { decodePresetRecordRelativePath, encodePresetRecordRelativePath, presetRecordIdentity } from '../storage/preset-paths.js';
import { isRejectedPath } from './pipeline/git-tree.js';

export const PRESET_DIR_KEYS = Object.freeze([...new Set(Object.values(PRESET_FOLDER_BY_API_ID))]);
const relative = (directories, dirKey) => path.relative(directories.root, directories[dirKey]).split(path.sep).join('/');

export function encodePresetRecordPath(directories, record) {
    return `${relative(directories, record.dirKey)}/${encodePresetRecordRelativePath(record)}`;
}

export function decodePresetRecordPath(directories, relPath) {
    for (const dirKey of PRESET_DIR_KEYS) {
        if (typeof directories[dirKey] !== 'string') continue;
        const prefix = `${relative(directories, dirKey)}/`;
        if (relPath.startsWith(prefix)) return decodePresetRecordRelativePath(dirKey, relPath.slice(prefix.length));
    }
    return null;
}

/** Normalize declared identities for comparison without rewriting parent objects or pending keys. */
export function buildPresetIdentityView({ directories, files }) {
    const normalized = new Map();
    const pathByIdentity = new Map();
    const identityByPath = new Map();
    for (const [relPath, entry] of files) {
        const record = decodePresetRecordPath(directories, relPath);
        if (!record) {
            normalized.set(relPath, entry);
            continue;
        }
        const identity = presetRecordIdentity(record);
        if (pathByIdentity.has(identity)) throw Object.assign(new Error(`Duplicate preset tree identity ${identity}: ${pathByIdentity.get(identity)} and ${relPath}`), { code: 'PRESET_IDENTITY_DUPLICATE' });
        pathByIdentity.set(identity, relPath);
        identityByPath.set(relPath, identity);
        normalized.set(encodePresetRecordPath(directories, record), entry);
    }
    return { files: normalized, pathByIdentity, identityByPath };
}

export function resolvePresetChoicePath({ directories, files, recordPath, view = buildPresetIdentityView({ directories, files }) }) {
    const record = decodePresetRecordPath(directories, recordPath);
    if (!record) return recordPath;
    return view.pathByIdentity.get(presetRecordIdentity(record)) ?? encodePresetRecordPath(directories, record);
}

/** Carry hostile-entry exclusions across canonical identity views of every side. */
export function buildPresetIdentityViews({ directories, sides }) {
    const mappings = new Map();
    const views = sides.map(side => {
        const view = buildPresetIdentityView({ directories, files: side.files });
        for (const original of view.identityByPath.keys()) mappings.set(original, encodePresetRecordPath(directories, decodePresetRecordPath(directories, original)));
        return { ...side, files: view.files, rejected: new Map(side.rejected) };
    });
    for (const [index, side] of sides.entries()) {
        for (const [original, canonical] of mappings) {
            if (!isRejectedPath(side.rejected, original)) continue;
            const parts = original.split('/');
            const prefix = parts.map((_, i) => parts.slice(0, i + 1).join('/')).find(candidate => side.rejected.has(candidate));
            views[index].rejected.set(canonical, side.rejected.get(prefix));
        }
    }
    return views;
}
