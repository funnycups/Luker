import { readResourceJson, resourceQuery } from './resource-read.js';
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

function isInvalidResource(error) {
    return error?.status === 422;
}

function warnInvalidResource(label, error) {
    console.warn(`Skipping unreadable ${label}: ${error?.message || error}`);
    toastr.warning(t`Skipped unreadable ${label}.`, t`Warning`, { preventDuplicates: true });
}

async function readNamedEntries(bucket, names, { signal } = {}) {
    const route = namedRoute(bucket);
    return Promise.all(names.map(async (name) => {
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
    }));
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
    return Promise.all(names.map(async (name) => {
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
    }));
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

export async function loadPresetResources({ selected = {}, complete = false, signal } = {}) {
    const byApi = {};
    await Promise.all(PRESET_API_IDS.map(async (apiId) => {
        const selectedName = selected?.[apiId];
        const readEntries = async (names) => Promise.all(names.map(async (name) => {
            if (!complete && name !== selectedName) {
                return { name, body: null };
            }
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
        }));

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
