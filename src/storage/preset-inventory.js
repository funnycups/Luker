import fs from 'node:fs';
import path from 'node:path';

import { assertConfinedPath } from './path-confinement.js';
import { buildSidecarFilename } from './engines/sidecar-naming.js';
import { PRESET_RECORDS_DIRECTORY, decodePresetRecordRelativePath, presetRecordIdentity } from './preset-paths.js';

/** Select all physical ownership structurally, before reading any document bytes. */
export function readPresetInventory({ folder, dirKey, boundary }) {
    assertConfinedPath({ boundary, absolutePath: folder });
    const entries = new Map();
    const byPath = new Map();
    let children;
    try { children = fs.readdirSync(folder, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return { entries, byPath };
        throw error;
    }
    const add = relativePath => {
        const record = decodePresetRecordRelativePath(dirKey, relativePath);
        if (!record) return;
        const absolutePath = path.join(folder, ...relativePath.split('/'));
        assertConfinedPath({ boundary, absolutePath });
        const key = presetRecordIdentity(record);
        const prior = entries.get(key);
        if (prior) throw Object.assign(new Error(`Duplicate preset identity ${key}: ${prior.absolutePath} and ${absolutePath}`), { code: 'PRESET_IDENTITY_DUPLICATE' });
        const entry = { record, relativePath, absolutePath, boundary };
        entries.set(key, entry);
        byPath.set(relativePath, entry);
    };
    const walkReserved = relative => {
        const absolutePath = path.join(folder, ...relative.split('/'));
        assertConfinedPath({ boundary, absolutePath });
        for (const child of fs.readdirSync(absolutePath, { withFileTypes: true })) {
            const next = `${relative}/${child.name}`;
            if (relative === PRESET_RECORDS_DIRECTORY && child.name !== 'v1') decodePresetRecordRelativePath(dirKey, next);
            if (child.isDirectory()) walkReserved(next);
            else if (child.isFile()) add(next);
            else throw Object.assign(new Error(`Invalid preset record entry at ${path.join(folder, next)}`), { code: 'PRESET_PROJECTION_INVALID' });
        }
    };
    for (const child of children) {
        if (child.name === PRESET_RECORDS_DIRECTORY) {
            if (!child.isDirectory()) throw Object.assign(new Error(`Preset record structure is not a directory at ${folder}`), { code: 'PRESET_PROJECTION_INVALID' });
            walkReserved(child.name);
        } else if (child.isFile() || child.isSymbolicLink()) add(child.name);
    }
    return { entries, byPath };
}

/** A missing requested tuple cannot read a different legacy slot owner's value. */
export function selectPresetEntry(inventory, record) {
    const identity = presetRecordIdentity(record);
    const entry = inventory.entries.get(identity);
    if (entry) return entry;
    const legacy = record.kind === 'preset' ? `${record.name}.json` : buildSidecarFilename(record.name, record.namespace);
    const other = inventory.byPath.get(legacy);
    if (other) throw Object.assign(new Error(`Preset key ${identity} aliases legacy owner ${presetRecordIdentity(other.record)} at ${other.absolutePath}; import or save the requested resource explicitly`), { code: 'PRESET_LEGACY_AMBIGUOUS' });
    return null;
}

/** Read only the selected source; parser diagnostics never include document bytes. */
export function readPresetEntry(entry) {
    assertConfinedPath({ boundary: entry.boundary, absolutePath: entry.absolutePath });
    const bytes = fs.readFileSync(entry.absolutePath);
    let doc;
    try { doc = JSON.parse(bytes.toString('utf8')); } catch {
        throw Object.assign(new Error(`Invalid preset JSON at ${entry.absolutePath}; restore or import this resource`), { code: 'PRESET_DOCUMENT_INVALID' });
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Object.assign(new Error(`Unsupported preset document shape at ${entry.absolutePath}; expected an object`), { code: 'PRESET_DOCUMENT_INVALID' });
    return { bytes, doc };
}
