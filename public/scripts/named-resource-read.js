import { invalidateResourceReadsByPrefix, readResourceJson, resourceQuery } from './resource-read.js';
import { BULK_RESOURCE_READ_CONCURRENCY, mapWithConcurrency } from './util/concurrent-map.js';
import { findCanonicalNameInList } from './util/lookup-name.js';
import { t } from './i18n.js';

const NAMED_DOC_ROUTES = Object.freeze({
    themes: '/api/themes',
    movingUI: '/api/moving-ui',
    quickReplies: '/api/quick-replies',
});

export const PRESET_API_IDS = Object.freeze([
    'novel',
    'openai',
    'textgenerationwebui',
    'kobold',
]);

const PRESET_API_RESPONSE_KEYS = Object.freeze({
    novel: { bodies: 'novelai_settings', names: 'novelai_setting_names' },
    openai: { bodies: 'openai_settings', names: 'openai_setting_names' },
    textgenerationwebui: { bodies: 'textgenerationwebui_presets', names: 'textgenerationwebui_preset_names' },
    kobold: { bodies: 'koboldai_settings', names: 'koboldai_setting_names' },
});

function isInvalidResource(error) {
    return error?.status === 422;
}

function warnInvalidResource(label, error) {
    console.warn(`Skipping unreadable ${label}: ${error?.message || error}`);
    toastr.warning(t`Skipped unreadable ${label}.`, t`Warning`, { preventDuplicates: true });
}

async function readNamedEntries(bucket, names, { signal, concurrency = BULK_RESOURCE_READ_CONCURRENCY } = {}) {
    const route = namedRoute(bucket);
    return mapWithConcurrency(names, concurrency, async (name, _index, itemSignal) => {
        try {
            const documentQuery = await resourceQuery({ name }, { signal: itemSignal });
            const result = await readResourceJson(`${route}/get?${documentQuery}`, { signal: itemSignal });
            return { name, doc: result.value };
        } catch (error) {
            if (error?.status === 404) {
                return { name, missing: true };
            }
            if (isInvalidResource(error)) {
                warnInvalidResource(`${bucket} document ${name}`, error);
                return null;
            }
            throw error;
        }
    }, { signal, abortOnError: true });
}

async function listNamedDocuments(bucket, { signal } = {}) {
    const route = namedRoute(bucket);
    const query = await resourceQuery();
    const { value } = await readResourceJson(`${route}/list?${query}`, { signal });
    return Array.isArray(value?.names) ? value.names : [];
}

function withoutMissing(entries) {
    return entries.filter(entry => entry && !entry.missing);
}

function assertNoMissing(entries) {
    if (entries.some(entry => entry?.missing)) {
        throw new Error('A resource disappeared while its collection was being read.');
    }
}

function namedRoute(bucket) {
    const route = NAMED_DOC_ROUTES[bucket];
    if (!route) {
        throw new Error(`Unknown named document collection: ${bucket}`);
    }
    return route;
}

export async function listPresetDocuments(apiId, { signal } = {}) {
    const query = await resourceQuery({ apiId });
    const { value } = await readResourceJson(`/api/presets/list?${query}`, { signal });
    return Array.isArray(value?.names) ? value.names : [];
}

export async function readPresetDocument(apiId, name, { signal } = {}) {
    const query = await resourceQuery({ apiId, name });
    const { value } = await readResourceJson(`/api/presets/get?${query}`, { signal });
    return value;
}

export async function loadNamedDocumentEntries(bucket, { signal, concurrency = BULK_RESOURCE_READ_CONCURRENCY } = {}) {
    let names = await listNamedDocuments(bucket, { signal });
    let entries = await readNamedEntries(bucket, names, { signal, concurrency });
    if (entries.some(entry => entry?.missing)) {
        names = await listNamedDocuments(bucket, { signal });
        entries = await readNamedEntries(bucket, names, { signal, concurrency });
        assertNoMissing(entries);
    }
    return withoutMissing(entries);
}

export async function loadNamedDocumentCollection(bucket, { signal, concurrency = BULK_RESOURCE_READ_CONCURRENCY } = {}) {
    return stampNamedDocuments(await loadNamedDocumentEntries(bucket, { signal, concurrency }));
}

async function readPresetEntries(apiId, names, { signal, concurrency = BULK_RESOURCE_READ_CONCURRENCY } = {}) {
    return mapWithConcurrency(names, concurrency, async (name, _index, itemSignal) => {
        try {
            return { name, doc: await readPresetDocument(apiId, name, { signal: itemSignal }) };
        } catch (error) {
            if (error?.status === 404) {
                return { name, missing: true };
            }
            if (isInvalidResource(error)) {
                warnInvalidResource(`preset ${apiId}/${name}`, error);
                return null;
            }
            throw error;
        }
    }, { signal, abortOnError: true });
}

export async function loadPresetDocumentEntries(apiId, { signal, concurrency = BULK_RESOURCE_READ_CONCURRENCY } = {}) {
    let names = await listPresetDocuments(apiId, { signal });
    let entries = await readPresetEntries(apiId, names, { signal, concurrency });
    if (entries.some(entry => entry?.missing)) {
        names = await listPresetDocuments(apiId, { signal });
        entries = await readPresetEntries(apiId, names, { signal, concurrency });
        assertNoMissing(entries);
    }
    return withoutMissing(entries);
}

export async function listThemeDirectory({ signal } = {}) {
    const query = await resourceQuery();
    const { value } = await readResourceJson(`/api/themes/list?${query}`, { signal });
    const names = Array.isArray(value?.names) ? value.names : [];
    const builtin = Array.isArray(value?.builtin) ? value.builtin : [];
    return { names, builtin };
}

export async function readThemeDocument(name, { signal } = {}) {
    if (typeof name !== 'string' || !name) {
        return null;
    }
    try {
        const query = await resourceQuery({ name });
        const { value } = await readResourceJson(`/api/themes/get?${query}`, { signal });
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return typeof value.name === 'string' && value.name ? value : { ...value, name };
        }
        return null;
    } catch (error) {
        if (error?.status === 404) {
            return null;
        }
        if (isInvalidResource(error)) {
            warnInvalidResource(`themes document ${name}`, error);
            return null;
        }
        throw error;
    }
}

export function invalidateThemeResourceReads() {
    invalidateResourceReadsByPrefix('/api/themes/');
}

export async function listWorldInfoNames({ signal } = {}) {
    const query = await resourceQuery();
    const { value } = await readResourceJson(`/api/worldinfo/list?${query}`, { signal });
    return Array.isArray(value?.names) ? value.names : [];
}

export async function readWorldInfoDocument(name, { signal } = {}) {
    const query = await resourceQuery({ name });
    const { value } = await readResourceJson(`/api/worldinfo/get?${query}`, { signal });
    return value;
}

export function stampNamedDocuments(entries) {
    return entries.map(({ name, doc }) => {
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
            return typeof doc.name === 'string' && doc.name ? doc : { ...doc, name };
        }
        return { name };
    });
}

/**
 * Resolves which preset name(s) from `names` should be eagerly hydrated
 * during bootstrap for one API.
 *
 * Accepts a single candidate string or an ordered candidate array. Returns the
 * first canonical match using tolerant case-insensitive lookup normalization.
 * When at least one candidate was provided but none exists on disk, falls back
 * to `[names[0]]` so startup hydrates the fallback preset selected by runtime.
 *
 * @param {string[]} names
 * @param {string|string[]|null|undefined} rawSelected
 * @returns {string[]}
 */
export function resolveBootstrapSelectedNames(names, rawSelected) {
    if (!Array.isArray(names) || names.length === 0) {
        return [];
    }
    const rawList = Array.isArray(rawSelected) ? rawSelected : [rawSelected];
    const candidates = rawList
        .map(candidate => (typeof candidate === 'string' ? candidate.trim() : ''))
        .filter(Boolean);
    if (candidates.length === 0) {
        return [];
    }
    for (const candidate of candidates) {
        const matched = findCanonicalNameInList(names, candidate, { caseInsensitive: true });
        if (matched) {
            return [matched];
        }
    }
    return [names[0]];
}

export async function loadPresetResources({
    selected = {},
    complete = false,
    skipNames = {},
    apiIds = PRESET_API_IDS,
    signal,
    concurrency = BULK_RESOURCE_READ_CONCURRENCY,
} = {}) {
    const requestedApis = Array.from(new Set(
        (Array.isArray(apiIds) ? apiIds : PRESET_API_IDS)
            .filter(apiId => Object.prototype.hasOwnProperty.call(PRESET_API_RESPONSE_KEYS, apiId)),
    ));
    if (requestedApis.length === 0) {
        return {};
    }

    const skippedByApi = new Map(
        requestedApis.map((apiId) => [apiId, new Set(Array.isArray(skipNames?.[apiId]) ? skipNames[apiId] : [])]),
    );

    const fetchEntriesForApis = async (targetApiIds, namesByApi) => {
        const entriesByApi = new Map();
        const tasks = [];
        for (const apiId of targetApiIds) {
            const skipped = skippedByApi.get(apiId);
            const names = namesByApi.get(apiId) || [];
            const selectedSet = complete
                ? null
                : new Set(resolveBootstrapSelectedNames(names, selected?.[apiId]));
            const entries = names.map((name, index) => {
                if ((!complete && !selectedSet.has(name)) || skipped.has(name)) {
                    return { name, body: null };
                }
                tasks.push({ apiId, index, name });
                return null;
            });
            entriesByApi.set(apiId, entries);
        }

        await mapWithConcurrency(tasks, concurrency, async (task, _index, itemSignal) => {
            const { apiId, index, name } = task;
            const entries = entriesByApi.get(apiId);
            try {
                const document = await readPresetDocument(apiId, name, { signal: itemSignal });
                entries[index] = { name, body: JSON.stringify(document) };
            } catch (error) {
                if (error?.status === 404) {
                    entries[index] = { name, missing: true };
                    return;
                }
                if (isInvalidResource(error)) {
                    warnInvalidResource(`preset ${apiId}/${name}`, error);
                    entries[index] = null;
                    return;
                }
                throw error;
            }
        }, { signal, abortOnError: true });

        return entriesByApi;
    };

    const namesByApi = new Map();
    await mapWithConcurrency(requestedApis, concurrency, async (apiId, _index, itemSignal) => {
        namesByApi.set(apiId, await listPresetDocuments(apiId, { signal: itemSignal }));
    }, { signal, abortOnError: true });

    const entriesByApi = await fetchEntriesForApis(requestedApis, namesByApi);
    const missingApis = requestedApis.filter(apiId => entriesByApi.get(apiId).some(entry => entry?.missing));
    if (missingApis.length > 0) {
        const retryNamesByApi = new Map();
        await mapWithConcurrency(missingApis, concurrency, async (apiId, _index, itemSignal) => {
            retryNamesByApi.set(apiId, await listPresetDocuments(apiId, { signal: itemSignal }));
        }, { signal, abortOnError: true });
        const retriedByApi = await fetchEntriesForApis(missingApis, retryNamesByApi);
        for (const apiId of missingApis) {
            const retriedEntries = retriedByApi.get(apiId);
            assertNoMissing(retriedEntries);
            entriesByApi.set(apiId, retriedEntries);
        }
    }

    const result = {};
    for (const apiId of requestedApis) {
        const valid = withoutMissing(entriesByApi.get(apiId));
        const keys = PRESET_API_RESPONSE_KEYS[apiId];
        result[keys.bodies] = valid.map(entry => entry.body);
        result[keys.names] = valid.map(entry => entry.name);
    }

    return result;
}
