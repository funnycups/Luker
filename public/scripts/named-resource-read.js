import { invalidateResourceReadsByPrefix, readResourceJson, resourceQuery } from './resource-read.js';
import { t } from './i18n.js';

const NAMED_DOC_ROUTES = Object.freeze({
    themes: '/api/themes',
    movingUI: '/api/moving-ui',
    quickReplies: '/api/quick-replies',
});

const PRESET_API_IDS = Object.freeze([
    'novel',
    'openai',
    'textgenerationwebui',
    'kobold',
]);

// Cap concurrent named-document and preset reads globally so bulk preloads cannot exhaust same-origin connections.
export const NAMED_RESOURCE_READ_CONCURRENCY = 6;

const LOOKUP_VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]/gu;

let activeNamedReads = 0;
const namedReadWaiters = [];

function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
}

function releaseNamedReadSlot() {
    activeNamedReads = Math.max(0, activeNamedReads - 1);
    while (activeNamedReads < NAMED_RESOURCE_READ_CONCURRENCY && namedReadWaiters.length > 0) {
        const next = namedReadWaiters.shift();
        if (!next.cancelled) {
            activeNamedReads += 1;
            next.grant();
            break;
        }
    }
}

function acquireNamedReadSlot(signal) {
    if (signal?.aborted) {
        return Promise.reject(abortError());
    }
    if (activeNamedReads < NAMED_RESOURCE_READ_CONCURRENCY) {
        activeNamedReads += 1;
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const waiter = {
            cancelled: false,
            grant: () => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            },
        };
        const onAbort = () => {
            waiter.cancelled = true;
            const index = namedReadWaiters.indexOf(waiter);
            if (index !== -1) {
                namedReadWaiters.splice(index, 1);
            }
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        namedReadWaiters.push(waiter);
    });
}

/**
 * Executes a single named-resource read within the bounded concurrency pool, cancelling immediately if aborted while queued.
 * @param {AbortSignal|undefined} signal Optional abort signal
 * @param {() => Promise<any>} task Async read callback
 * @returns {Promise<any>}
 */
async function withNamedResourceReadSlot(signal, task) {
    await acquireNamedReadSlot(signal);
    try {
        if (signal?.aborted) {
            throw abortError();
        }
        return await task();
    } finally {
        releaseNamedReadSlot();
    }
}

/**
 * Normalizes a preset name for tolerant lookup (trim, NFC normalization, and variation-selector stripping).
 * @param {string} value Raw preset name
 * @returns {string}
 */
function normalizePresetLookupKey(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }
    return text.normalize('NFC').replace(LOOKUP_VARIATION_SELECTORS_RE, '');
}

/**
 * Resolves the set of preset names to hydrate eagerly during bootstrap.
 * Accepts a single name or an array of candidates, tolerates whitespace/Unicode/case differences,
 * and falls back to `names[0]` when all saved candidates are missing on disk.
 * @param {string[]} names Preset names available on disk
 * @param {string|string[]|null|undefined} rawSelected Selected preset name or candidate list
 * @returns {Set<string>}
 */
function resolveBootstrapSelectedNames(names, rawSelected) {
    const matched = new Set();
    if (!Array.isArray(names) || names.length === 0) {
        return matched;
    }

    const rawList = Array.isArray(rawSelected) ? rawSelected : [rawSelected];
    const candidates = [];
    const seenCandidates = new Set();
    for (const entry of rawList) {
        const trimmed = typeof entry === 'string' ? entry.trim() : '';
        if (trimmed && !seenCandidates.has(trimmed)) {
            seenCandidates.add(trimmed);
            candidates.push(trimmed);
        }
    }

    if (candidates.length === 0) {
        return matched;
    }

    for (const candidate of candidates) {
        const normalizedCandidate = normalizePresetLookupKey(candidate);
        const lowerCandidate = normalizedCandidate.toLocaleLowerCase();
        const canonical = names.find(item => String(item ?? '').trim() === candidate)
            || names.find(item => normalizePresetLookupKey(item) === normalizedCandidate)
            || names.find(item => normalizePresetLookupKey(item).toLocaleLowerCase() === lowerCandidate);
        if (canonical) {
            matched.add(canonical);
        }
    }

    // Mirror runtime preset initialization fallback when every saved candidate has been deleted or renamed.
    if (matched.size === 0) {
        matched.add(names[0]);
    }

    return matched;
}

function isInvalidResource(error) {
    return error?.status === 422;
}

function warnInvalidResource(label, error) {
    console.warn(`Skipping unreadable ${label}: ${error?.message || error}`);
    toastr.warning(t`Skipped unreadable ${label}.`, t`Warning`, { preventDuplicates: true });
}

async function readNamedEntries(bucket, names, { signal } = {}) {
    const route = namedRoute(bucket);
    return Promise.all(names.map(name => withNamedResourceReadSlot(signal, async () => {
        try {
            const documentQuery = await resourceQuery({ name });
            const result = await readResourceJson(`${route}/get?${documentQuery}`, { signal });
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
    })));
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

export async function loadNamedDocumentEntries(bucket, { signal } = {}) {
    let names = await listNamedDocuments(bucket, { signal });
    let entries = await readNamedEntries(bucket, names, { signal });
    if (entries.some(entry => entry?.missing)) {
        names = await listNamedDocuments(bucket, { signal });
        entries = await readNamedEntries(bucket, names, { signal });
        assertNoMissing(entries);
    }
    return withoutMissing(entries);
}

export async function loadNamedDocumentCollection(bucket, { signal } = {}) {
    return stampNamedDocuments(await loadNamedDocumentEntries(bucket, { signal }));
}

async function readPresetEntries(apiId, names, { signal } = {}) {
    return Promise.all(names.map(name => withNamedResourceReadSlot(signal, async () => {
        try {
            return { name, doc: await readPresetDocument(apiId, name, { signal }) };
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
    })));
}

export async function loadPresetDocumentEntries(apiId, { signal } = {}) {
    let names = await listPresetDocuments(apiId, { signal });
    let entries = await readPresetEntries(apiId, names, { signal });
    if (entries.some(entry => entry?.missing)) {
        names = await listPresetDocuments(apiId, { signal });
        entries = await readPresetEntries(apiId, names, { signal });
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

export async function loadPresetResources({ selected = {}, complete = false, skipNames = {}, signal } = {}) {
    const byApi = {};
    await Promise.all(PRESET_API_IDS.map(async (apiId) => {
        const rawSelected = selected?.[apiId];
        const skipped = new Set(Array.isArray(skipNames?.[apiId]) ? skipNames[apiId] : []);
        const readEntries = async (names) => {
            const selectedSet = complete ? null : resolveBootstrapSelectedNames(names, rawSelected);
            return Promise.all(names.map(async (name) => {
                if ((!complete && !selectedSet.has(name)) || skipped.has(name)) {
                    return { name, body: null };
                }
                return withNamedResourceReadSlot(signal, async () => {
                    try {
                        const document = await readPresetDocument(apiId, name, { signal });
                        return { name, body: JSON.stringify(document) };
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
                });
            }));
        };

        let names = await listPresetDocuments(apiId, { signal });
        let entries = await readEntries(names);
        if (entries.some(entry => entry?.missing)) {
            names = await listPresetDocuments(apiId, { signal });
            entries = await readEntries(names);
            assertNoMissing(entries);
        }
        const valid = withoutMissing(entries);
        byApi[apiId] = {
            names: valid.map(entry => entry.name),
            bodies: valid.map(entry => entry.body),
        };
    }));

    return {
        novelai_settings: byApi.novel.bodies,
        novelai_setting_names: byApi.novel.names,
        openai_settings: byApi.openai.bodies,
        openai_setting_names: byApi.openai.names,
        textgenerationwebui_presets: byApi.textgenerationwebui.bodies,
        textgenerationwebui_preset_names: byApi.textgenerationwebui.names,
        koboldai_settings: byApi.kobold.bodies,
        koboldai_setting_names: byApi.kobold.names,
    };
}
