import {
    invalidateResourceReads,
    invalidateResourceReadsByPrefix,
    loadResourceBootstrap,
    readResourceJson,
    readResourceText,
} from '../resource-read.js';
import { applyPatch } from '../util/fast-json-patch.js';

function resourceError(code, resource, detail, extra = {}) {
    const error = new Error(detail || code);
    error.code = code;
    error.resource = resource;
    if (detail) error.detail = detail;
    Object.assign(error, extra);
    return error;
}

function urlFor(account, avatar, suffix) {
    const params = new URLSearchParams({ account, avatar });
    return `/api/characters/${suffix}?${params.toString()}`;
}

function fieldUrl(account, avatar, path) {
    const params = new URLSearchParams({ account, avatar, path });
    return `/api/characters/field?${params.toString()}`;
}

function projectionUrl(account, avatar) {
    const params = new URLSearchParams({ account, avatar });
    return `/api/characters/projection?${params.toString()}`;
}

function reorderObject(value, keyOrder) {
    const ordered = {};
    for (const key of keyOrder) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            ordered[key] = value[key];
        }
    }
    for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
            ordered[key] = value[key];
        }
    }
    return ordered;
}

/**
 * Reads a complete legacy character object from the lossless source layout and
 * the runtime projection. The source string is reconstructed byte-for-byte,
 * then the existing normalization patch restores the runtime view.
 *
 * @param {string} avatar
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function loadCharacterResource(avatar, { signal } = {}) {
    const { account } = await loadResourceBootstrap({ signal });
    const directoryUrl = urlFor(account, avatar, 'fields');
    const directory = await readResourceJson(directoryUrl, { signal });
    const rawLayout = directory.value?.rawLayout;
    const fields = directory.value?.fields;
    if (!Array.isArray(rawLayout) || !Array.isArray(fields)) {
        throw resourceError('invalid_resource', directoryUrl, 'Character field directory is incomplete.');
    }

    const values = new Map();
    await Promise.all(fields.map(async (field) => {
        if (typeof field?.path !== 'string' || typeof field?.etag !== 'string') {
            throw resourceError('invalid_resource', directoryUrl, 'Character field entry is invalid.');
        }
        const url = fieldUrl(account, avatar, field.path);
        const result = await readResourceText(url, { signal });
        if (result.etag !== field.etag) {
            throw resourceError('read_conflict', url, 'Character field validator does not match the directory.', {
                path: field.path,
                expected: field.etag,
                actual: result.etag,
            });
        }
        values.set(field.path, result.text);
    }));

    const raw = rawLayout.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.path === 'string' && values.has(part.path)) {
            return values.get(part.path);
        }
        throw resourceError('read_conflict', directoryUrl, `Character layout field ${part?.path ?? '<unknown>'} is missing.`);
    }).join('');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw resourceError('invalid_resource', directoryUrl, `Character source is not valid JSON: ${error.message}`);
    }

    const projectionUrlValue = projectionUrl(account, avatar);
    const projection = await readResourceJson(projectionUrlValue, { signal });
    if (projection.etag !== directory.value?.projection?.etag) {
        throw resourceError('read_conflict', projectionUrlValue, 'Character projection validator does not match the directory.', {
            expected: directory.value?.projection?.etag,
            actual: projection.etag,
        });
    }

    let character;
    try {
        character = applyPatch(parsed, projection.value.patch, true, false).newDocument;
    } catch (error) {
        throw resourceError('invalid_resource', projectionUrlValue, `Character projection could not be applied: ${error.message}`);
    }
    character.json_data = raw;
    return reorderObject(character, Array.isArray(projection.value.keyOrder) ? projection.value.keyOrder : Object.keys(character));
}

/**
 * Invalidates in-flight directory/field/projection reads for one card after a
 * local save. The browser cache itself is revalidated by the server.
 */
export async function invalidateCharacterResource(avatar) {
    const { account } = await loadResourceBootstrap();
    invalidateResourceReads([
        urlFor(account, avatar, 'fields'),
        projectionUrl(account, avatar),
    ]);
    invalidateResourceReadsByPrefix(urlFor(account, avatar, 'field'));
}
