// Local test helpers for the iterstudio batch. Most are imports from the
// preset _helpers since the shared concerns (normalizeIterStudioSettings)
// are the same.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionBodyNamespace } from '../../../public/scripts/workbench/model/sessions.js';

export { normalizeIterStudioSettings } from '../preset/_helpers.js';
export { sessionBodyNamespace };

export function globalStatePath(dataRoot, namespace) {
    return resolve(dataRoot, 'default-user', 'states', `${namespace}.json`);
}

export function characterStatePath(dataRoot, avatarOrBase, namespace) {
    const base = String(avatarOrBase).replace(/\.png$/i, '');
    return resolve(dataRoot, 'default-user', 'characters', `${base}.state.${namespace}.json`);
}

export function readJsonIfExists(filePath) {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
}

export function readGlobalWorkbenchBodies(dataRoot, filter = null) {
    const index = readJsonIfExists(globalStatePath(dataRoot, 'workbench_sessions'));
    const summaries = Array.isArray(index?.sessions) ? index.sessions : [];
    const matched = filter ? summaries.filter(filter) : summaries;
    return matched.map((summary) => readJsonIfExists(globalStatePath(dataRoot, sessionBodyNamespace(summary.id)))).filter(Boolean);
}

export function readCharacterWorkbenchBodies(dataRoot, avatarOrBase, filter = null) {
    const index = readJsonIfExists(characterStatePath(dataRoot, avatarOrBase, 'workbench_sessions'));
    const summaries = Array.isArray(index?.sessions) ? index.sessions : [];
    const matched = filter ? summaries.filter(filter) : summaries;
    return matched.map((summary) => readJsonIfExists(characterStatePath(dataRoot, avatarOrBase, sessionBodyNamespace(summary.id)))).filter(Boolean);
}
