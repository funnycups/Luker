import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { normalizeLookupText } from '../util.js';
import { getWorldInfoRepo } from '../storage/index.js';
import { PatchTestFailedError, PatchMissingParentError, UnsupportedPatchOpError, StorageReadOnlyError, InvalidArgumentError } from '../storage/errors.js';
import { assertSafeRepoName } from '../storage/name-validation.js';

/**
 * Coerces a corrupt `entries` array — `[null, null, ..., {uid:66,...}]`, a shape
 * legacy SillyTavern saves left behind on some books — back into the documented
 * uid-keyed object form. Null and non-object slots are dropped; surviving
 * entries are re-keyed by their own `uid` (falling back to the array index when
 * the entry has no usable uid). Returns the new file object plus a `changed`
 * flag so the caller can decide whether to write the normalized shape back to
 * disk and avoid hitting this hot path again next read.
 *
 * Also heals `originalData.entries` items left behind by `convertCharacterBook`:
 * those carry only `id` (the V2/V3 character_book spec field), but the client
 * delete/update helpers look up by `uid`. The mismatch means deleted entries
 * silently linger in `originalData`, and when the user later exports the world
 * the ghost entries ship along.
 *
 * @param {unknown} file
 * @returns {{ file: object, changed: boolean }}
 */
export function normalizeWorldInfoFile(file) {
    if (!_.isObjectLike(file) || Array.isArray(file)) {
        return { file, changed: false };
    }

    let workingFile = file;
    let changed = false;

    if (Array.isArray(workingFile.entries)) {
        const fixedEntries = {};
        workingFile.entries.forEach((entry, index) => {
            if (!_.isObjectLike(entry) || Array.isArray(entry)) return;
            const rawUid = entry.uid;
            const numericUid = Number(rawUid);
            const uid = Number.isFinite(numericUid) ? numericUid : index;
            fixedEntries[String(uid)] = { ...entry, uid };
        });
        workingFile = { ...workingFile, entries: fixedEntries };
        changed = true;
    }

    const originalEntries = workingFile.originalData?.entries;
    if (Array.isArray(originalEntries) && originalEntries.some((e) => _.isObjectLike(e) && e?.uid === undefined)) {
        const fixedOriginal = originalEntries.map((entry, index) => {
            if (!_.isObjectLike(entry) || Array.isArray(entry)) return entry;
            if (entry.uid !== undefined) return entry;
            const fallbackUid = entry.id !== undefined ? entry.id : index;
            return { ...entry, uid: fallbackUid };
        });
        workingFile = {
            ...workingFile,
            originalData: { ...workingFile.originalData, entries: fixedOriginal },
        };
        changed = true;
    }

    // Sweep orphans: originalData entries whose uid no longer exists in the
    // live `entries` map are leftover from pre-fix deletes that only touched
    // `entries`. Drop them so the next export does not ship ghost entries.
    // Skipped when the live `entries` map is empty — keeping originalData
    // intact protects books that legitimately use it as a snapshot.
    const liveEntries = workingFile.entries;
    const sweepableOriginal = workingFile.originalData?.entries;
    if (Array.isArray(sweepableOriginal)
        && _.isObjectLike(liveEntries) && !Array.isArray(liveEntries)
        && Object.keys(liveEntries).length > 0) {
        const liveUids = new Set(Object.keys(liveEntries));
        const surviving = sweepableOriginal.filter((entry) => {
            if (!_.isObjectLike(entry) || Array.isArray(entry)) return true;
            const uid = entry.uid;
            if (uid === undefined) return true;
            return liveUids.has(String(uid));
        });
        if (surviving.length !== sweepableOriginal.length) {
            workingFile = {
                ...workingFile,
                originalData: { ...workingFile.originalData, entries: surviving },
            };
            changed = true;
        }
    }

    return { file: workingFile, changed };
}

/**
 * Reads a world info file and repairs the array-form `entries` corruption in
 * place if found. Repair writes are best-effort: read-only mode and write
 * failures fall back to returning the in-memory normalized object so the read
 * still succeeds.
 *
 * @param {ReturnType<typeof getWorldInfoRepo>} repo
 * @param {string} handle
 * @param {string} name
 * @returns {Promise<object | null>}
 */
async function getNormalizedWorldInfoFile(repo, handle, name) {
    const file = await repo.get(handle, name);
    const { file: normalized, changed } = normalizeWorldInfoFile(file);
    if (changed) {
        try {
            await repo.save(handle, name, normalized);
        } catch (err) {
            if (!(err instanceof StorageReadOnlyError)) {
                console.warn(`World info ${name}: normalize-on-read save failed`, err);
            }
        }
    }
    return normalized;
}

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = resolveWorldInfoFilename(directories.worlds, worldInfoName);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

/**
 * Builds a world info filename from an uploaded filename while trimming invisible
 * whitespace from the basename so imports do not create hard-to-address files.
 * @param {string} originalName
 * @returns {string}
 */
export function sanitizeImportedWorldInfoFilename(originalName) {
    const parsed = path.parse(sanitize(String(originalName || '')));
    const baseName = String(parsed.name || '').trim();
    return baseName ? `${baseName}.json` : '';
}

/**
 * Finds the raw filename for a world info entry while comparing names with tolerant lookup rules.
 * The matched filename is returned exactly as it exists on disk.
 * @param {string[]} filenames
 * @param {string} worldInfoName
 * @returns {string}
 */
export function findMatchingWorldInfoFilename(filenames, worldInfoName) {
    const requested = String(worldInfoName || '').trim();
    if (!requested || !Array.isArray(filenames)) {
        return '';
    }

    const exactMatch = filenames.find((file) => path.parse(file).name === requested);
    if (exactMatch) {
        return exactMatch;
    }

    const normalizedRequested = normalizeLookupText(requested);
    if (!normalizedRequested) {
        return '';
    }

    return filenames.find((file) => normalizeLookupText(path.parse(file).name) === normalizedRequested) || '';
}

/**
 * Resolves a world info filename from a display name.
 * Falls back to tolerant matching so emoji variation selectors do not break lookups.
 * @param {string} directory
 * @param {string} worldInfoName
 * @returns {string}
 */
export function resolveWorldInfoFilename(directory, worldInfoName) {
    const requested = String(worldInfoName || '').trim();
    const exactFilename = sanitize(`${requested}.json`);
    const exactPath = path.join(directory, exactFilename);
    if (requested && fs.existsSync(exactPath)) {
        return exactFilename;
    }

    const jsonFiles = fs.readdirSync(directory)
        .filter(file => path.extname(file).toLowerCase() === '.json');
    return findMatchingWorldInfoFilename(jsonFiles, requested) || exactFilename;
}

export const router = express.Router();

router.post('/list', async (request, response) => {
    try {
        const items = await getWorldInfoRepo().list(request.user.profile.handle);
        const data = items.map(({ key, name, extensions }) => ({
            file_id: key.name,
            name,
            extensions,
        }));
        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/list-lite', async (request, response) => {
    try {
        const items = await getWorldInfoRepo().list(request.user.profile.handle);
        const names = items.map((item) => item.key.name);
        return response.send({ names });
    } catch (err) {
        console.error('Error reading World Info names:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const repo = getWorldInfoRepo();
    const handle = request.user.profile.handle;
    const canonical = await repo.resolveName(handle, request.body.name);
    if (canonical == null) {
        // File truly missing — legacy readWorldInfoFile(..., allowDummy=true) returned {entries:{}}.
        return response.send({ entries: {} });
    }
    const file = await getNormalizedWorldInfoFile(repo, handle, request.body.name);
    // file === null here means parse failure / corrupt JSON / non-object root.
    // Legacy 500'd via uncaught JSON.parse throw. Returning null is strictly safer:
    // the frontend already filters via isPlainObject and treats null as "skip" rather
    // than overwriting the user's data with an empty world.
    return response.send(file);
});

router.post('/get-batch', async (request, response) => {
    const names = [...new Set((Array.isArray(request.body?.names) ? request.body.names : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean))];

    if (!names.length) {
        return response.send({ data: {} });
    }

    const repo = getWorldInfoRepo();
    const handle = request.user.profile.handle;
    const data = {};
    for (const name of names) {
        const canonical = await repo.resolveName(handle, name);
        if (canonical == null) {
            // Missing — match allowDummy=true semantics.
            data[name] = { entries: {} };
        } else {
            const file = await getNormalizedWorldInfoFile(repo, handle, name);
            // null means corrupt; the frontend's isPlainObject filter handles it.
            data[name] = file;
        }
    }

    return response.send({ data });
});

router.post('/delete', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const deleted = await getWorldInfoRepo().delete(request.user.profile.handle, request.body.name);
    if (!deleted) {
        return response.sendStatus(404);
    }

    return response.sendStatus(200);
});

router.post('/import', async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = sanitizeImportedWorldInfoFilename(request.file.originalname);

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    let worldContent;
    try {
        worldContent = JSON.parse(fileContents);
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }
    if (!_.isObjectLike(worldContent) || Array.isArray(worldContent)) {
        return response.status(400).send('Is not a valid world info file');
    }
    // Coerce array-form `entries` (each entry carries its own `uid` inline)
    // into the documented uid-keyed object form. Some legacy authors and
    // merge tooling serialize world books this way; upstream ST's /import
    // accepts them and the frontend renders array-form entries fine. We
    // normalize here so the on-disk shape stays consistent with the rest
    // of the codebase (see normalizeWorldInfoFile — same coercion runs on
    // /get and /get-batch reads).
    const { file: normalizedContent } = normalizeWorldInfoFile(worldContent);
    if (!_.isObjectLike(normalizedContent.entries) || Array.isArray(normalizedContent.entries)) {
        return response.status(400).send('Is not a valid world info file');
    }
    worldContent = normalizedContent;

    const worldName = path.parse(filename).name;
    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }
    let safeWorldName;
    try {
        safeWorldName = assertSafeRepoName(worldName);
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return response.status(400).send({ error: err.message });
        }
        throw err;
    }

    try {
        await getWorldInfoRepo().save(request.user.profile.handle, safeWorldName, worldContent);
    } catch (err) {
        console.error('Error importing world info:', err);
        return response.sendStatus(500);
    }
    return response.send({ name: safeWorldName });
});

router.post('/edit', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    if (!_.isObjectLike(request.body.data) || Array.isArray(request.body.data)) {
        return response.status(400).send('Is not a valid world info file');
    }
    // Match /import: array-form `entries` (each entry inlines its own uid)
    // is a legitimate legacy shape produced by third-party merge tools.
    // Coerce back to the uid-keyed object form before persisting so the
    // saved shape stays consistent with normalizeWorldInfoFile's read-side
    // repair.
    const { file: normalizedData } = normalizeWorldInfoFile(request.body.data);
    if (!_.isObjectLike(normalizedData.entries) || Array.isArray(normalizedData.entries)) {
        return response.status(400).send('Is not a valid world info file');
    }

    let safeName;
    try {
        safeName = assertSafeRepoName(request.body.name);
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return response.status(400).send({ error: err.message });
        }
        throw err;
    }

    try {
        await getWorldInfoRepo().save(request.user.profile.handle, safeName, normalizedData);
        return response.send({ ok: true });
    } catch (err) {
        console.error('Error editing world info:', err);
        return response.sendStatus(500);
    }
});

router.post('/patch', async (request, response) => {
    try {
        const worldInfoName = String(request.body?.name || '').trim();
        if (!worldInfoName) {
            return response.status(400).send({ error: 'World file must have a name' });
        }

        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body?.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body?.operation) ? [request.body.operation] : []));

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No world info patch operations found. Expected body.operations or body.operation.' });
        }

        await getWorldInfoRepo().patch(request.user.profile.handle, worldInfoName, operations);
        return response.send({ ok: true, applied: operations.length });
    } catch (error) {
        if (error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
            return response.status(409).send({ error: 'World info patch test conflict.', code: 'patch_test_failed', details: String(error?.message || '') });
        }
        if (error instanceof UnsupportedPatchOpError) {
            return response.status(400).send({ error: 'Invalid world info patch payload.', code: 'patch_payload_invalid', details: String(error?.message || '') });
        }
        console.error('Error patching world info:', error);
        return response.status(500).send({ error: 'Failed to patch world info.' });
    }
});
