// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Embedding & Rerank profile management for Connection Manager.
//
// Embedding/rerank profiles share storage with chat-completion (cc/tc) profiles
// in `extension_settings.connectionManager.profiles` — they are distinguished by
// their `mode` field ('embed' / 'rerank'). Unlike cc/tc profiles, they are NOT
// "applied" globally: consumer plugins (vectors, memory-graph) look them up by id
// and hand them to the EmbeddingService.

import { event_types, eventSource, saveSettingsDebounced } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { uuidv4 } from '../../utils.js';
import { t } from '../../i18n.js';
import { secret_state } from '../../secrets.js';
import {
    EMBED_MODE,
    RERANK_MODE,
    EMBEDDING_SOURCE_DEFS,
    RERANK_SOURCE_DEFS,
    getEmbeddingSourceDef,
    getRerankSourceDef,
    listEmbeddingSourceDefs,
    listRerankSourceDefs,
    compactProfile,
    validateProfileFields,
} from './embed-rerank-core.js';

export {
    getEmbeddingSourceDef,
    getRerankSourceDef,
    listEmbeddingSourceDefs,
    listRerankSourceDefs,
};

/**
 * @typedef {object} EmbedProfile
 * @property {string} id
 * @property {'embed'} mode
 * @property {string} name
 * @property {string} source
 * @property {string} [model]
 * @property {string} ['api-url']
 * @property {string} ['proxy-password']
 * @property {string} ['secret-id']
 * @property {string} ['jina-late-chunking']
 * @property {string} ['jina-dimensions']
 * @property {string} ['jina-task']
 * @property {string} ['ollama-keep']
 * @property {string} ['siliconflow-endpoint']
 * @property {string} ['workers-ai-account-id']
 * @property {string} ['vertexai-region']
 * @property {string} ['vertexai-auth-mode']
 * @property {string} ['vertexai-express-project-id']
 */

/**
 * @typedef {object} RerankProfile
 * @property {string} id
 * @property {'rerank'} mode
 * @property {string} name
 * @property {string} source
 * @property {string} [model]
 * @property {string} ['api-url']
 * @property {string} ['proxy-password']
 * @property {string} ['secret-id']
 */

function ensureProfilesArray() {
    if (!extension_settings.connectionManager) {
        extension_settings.connectionManager = { profiles: [], selectedProfile: null };
    }
    if (!Array.isArray(extension_settings.connectionManager.profiles)) {
        extension_settings.connectionManager.profiles = [];
    }
    return extension_settings.connectionManager.profiles;
}

/**
 * @returns {EmbedProfile[]}
 */
export function listEmbeddingProfiles() {
    return ensureProfilesArray()
        .filter(p => p && String(p.mode || '') === EMBED_MODE)
        .map(p => /** @type {EmbedProfile} */ (p));
}

/**
 * @returns {RerankProfile[]}
 */
export function listRerankProfiles() {
    return ensureProfilesArray()
        .filter(p => p && String(p.mode || '') === RERANK_MODE)
        .map(p => /** @type {RerankProfile} */ (p));
}

/**
 * @param {string} id
 * @returns {EmbedProfile|null}
 */
export function getEmbeddingProfileById(id) {
    if (!id) return null;
    return /** @type {EmbedProfile|null} */ (
        listEmbeddingProfiles().find(p => p.id === id) || null
    );
}

/**
 * @param {string} id
 * @returns {RerankProfile|null}
 */
export function getRerankProfileById(id) {
    if (!id) return null;
    return /** @type {RerankProfile|null} */ (
        listRerankProfiles().find(p => p.id === id) || null
    );
}

function isNameTaken(name, exceptId = '') {
    return ensureProfilesArray().some(p => p && p.name === name && p.id !== exceptId);
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Builds the inner HTML for the embed/rerank profile form.
 * Source-specific fields are present in the DOM but hidden when irrelevant.
 * @param {'embed'|'rerank'} mode
 * @param {object} initial Initial values keyed by field name
 * @returns {string}
 */
function buildFormHtml(mode, initial = {}) {
    const sourceDefs = mode === EMBED_MODE ? EMBEDDING_SOURCE_DEFS : RERANK_SOURCE_DEFS;
    const sourceOptions = sourceDefs.map(s =>
        `<option value="${escapeHtml(s.id)}"${initial.source === s.id ? ' selected' : ''}>${escapeHtml(s.label)}</option>`,
    ).join('');

    const title = mode === EMBED_MODE ? t`Embedding Profile` : t`Rerank Profile`;
    const lateChunking = String(initial['jina-late-chunking'] || '') === 'true';
    const ollamaKeep = String(initial['ollama-keep'] || '') === 'true';

    return `
    <div class="embed-rerank-profile-form" data-mode="${mode}">
        <h3 class="margin0">${escapeHtml(title)}</h3>
        <div class="flex-container flexFlowColumn flexNoGap marginTop10">
            <label class="marginTop5">
                <span>${escapeHtml(t`Profile Name`)}</span>
                <input type="text" class="text_pole" data-field="name" value="${escapeHtml(initial.name || '')}" />
            </label>
            <label class="marginTop5">
                <span>${escapeHtml(t`Source`)}</span>
                <select class="text_pole" data-field="source">${sourceOptions}</select>
            </label>
            <label class="marginTop5" data-row="model">
                <span>${escapeHtml(t`Model`)}</span>
                <input type="text" class="text_pole" data-field="model" value="${escapeHtml(initial.model || '')}" />
            </label>
            <label class="marginTop5" data-row="api-url">
                <span data-i18n-url-required="${escapeHtml(t`Server URL (required)`)}" data-i18n-url-optional="${escapeHtml(t`URL Override (optional)`)}">${escapeHtml(t`URL Override (optional)`)}</span>
                <input type="text" class="text_pole" data-field="api-url" value="${escapeHtml(initial['api-url'] || '')}" placeholder="https://" />
                <small class="marginTop5">${escapeHtml(t`When set, requests are sent to this URL using the API Key below; the saved Secret is ignored.`)}</small>
            </label>
            <label class="marginTop5" data-row="proxy-password">
                <span>${escapeHtml(t`API Key (used with URL Override)`)}</span>
                <input type="text" class="text_pole" data-field="proxy-password" value="${escapeHtml(initial['proxy-password'] || '')}" autocomplete="off" />
            </label>
            <label class="marginTop5" data-row="secret-id">
                <span>${escapeHtml(t`Saved Secret`)}</span>
                <select class="text_pole" data-field="secret-id"></select>
            </label>

            <!-- Per-provider extras -->
            <div class="marginTop10" data-row="jina-options">
                <label class="checkbox_label">
                    <input type="checkbox" data-field="jina-late-chunking" ${lateChunking ? 'checked' : ''} />
                    <span>${escapeHtml(t`Late Chunking`)}</span>
                </label>
                <label class="marginTop5">
                    <span>${escapeHtml(t`Dimensions (0 = auto)`)}</span>
                    <input type="number" min="0" class="text_pole" data-field="jina-dimensions" value="${escapeHtml(initial['jina-dimensions'] || '')}" />
                </label>
                <label class="marginTop5">
                    <span>${escapeHtml(t`Task (optional)`)}</span>
                    <input type="text" class="text_pole" data-field="jina-task" value="${escapeHtml(initial['jina-task'] || '')}" placeholder="retrieval.passage" />
                </label>
            </div>
            <div class="marginTop10" data-row="ollama-options">
                <label class="checkbox_label">
                    <input type="checkbox" data-field="ollama-keep" ${ollamaKeep ? 'checked' : ''} />
                    <span>${escapeHtml(t`Keep model loaded between requests`)}</span>
                </label>
            </div>
            <div class="marginTop10" data-row="siliconflow-options">
                <label>
                    <span>${escapeHtml(t`Endpoint Region`)}</span>
                    <select class="text_pole" data-field="siliconflow-endpoint">
                        <option value="" ${!initial['siliconflow-endpoint'] ? 'selected' : ''}>${escapeHtml(t`International`)}</option>
                        <option value="cn" ${initial['siliconflow-endpoint'] === 'cn' ? 'selected' : ''}>${escapeHtml(t`China`)}</option>
                    </select>
                </label>
            </div>
            <div class="marginTop10" data-row="workers-ai-options">
                <label>
                    <span>${escapeHtml(t`Cloudflare Account ID`)}</span>
                    <input type="text" class="text_pole" data-field="workers-ai-account-id" value="${escapeHtml(initial['workers-ai-account-id'] || '')}" />
                </label>
            </div>
            <div class="marginTop10" data-row="vertexai-options">
                <label>
                    <span>${escapeHtml(t`Auth Mode`)}</span>
                    <select class="text_pole" data-field="vertexai-auth-mode">
                        <option value="" ${!initial['vertexai-auth-mode'] ? 'selected' : ''}>${escapeHtml(t`Default (API Key)`)}</option>
                        <option value="express" ${initial['vertexai-auth-mode'] === 'express' ? 'selected' : ''}>${escapeHtml(t`Express`)}</option>
                        <option value="service-account" ${initial['vertexai-auth-mode'] === 'service-account' ? 'selected' : ''}>${escapeHtml(t`Service Account`)}</option>
                    </select>
                </label>
                <label class="marginTop5">
                    <span>${escapeHtml(t`Region`)}</span>
                    <input type="text" class="text_pole" data-field="vertexai-region" value="${escapeHtml(initial['vertexai-region'] || '')}" placeholder="us-central1" />
                </label>
                <label class="marginTop5">
                    <span>${escapeHtml(t`Express Project ID`)}</span>
                    <input type="text" class="text_pole" data-field="vertexai-express-project-id" value="${escapeHtml(initial['vertexai-express-project-id'] || '')}" />
                </label>
            </div>
        </div>
    </div>`;
}

function readSecretsForKey(secretKey) {
    const list = secret_state?.[secretKey];
    if (!Array.isArray(list)) return [];
    return list.map(item => ({
        id: String(item?.id || ''),
        label: String(item?.label || ''),
        active: Boolean(item?.active),
    })).filter(item => item.id);
}

function refreshSecretSelect($select, sourceDef, currentValue) {
    $select.empty();
    if (!sourceDef?.secretKey) {
        $select.append('<option value=""></option>');
        $select.val('');
        return;
    }

    $select.append(`<option value="">${escapeHtml(t`Use active (default)`)}</option>`);

    const items = readSecretsForKey(sourceDef.secretKey);
    for (const item of items) {
        const labelText = item.label || (item.active ? `(${item.id.slice(0, 6)}…) ★` : `(${item.id.slice(0, 6)}…)`);
        $select.append(`<option value="${escapeHtml(item.id)}"${currentValue === item.id ? ' selected' : ''}>${escapeHtml(labelText)}</option>`);
    }

    if (currentValue && !items.some(i => i.id === currentValue)) {
        // Persist orphan id so the user doesn't lose their reference
        $select.append(`<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue.slice(0, 12))}…</option>`);
    } else if (!currentValue) {
        $select.val('');
    }
}

function applySourceVisibility($form, mode, sourceId) {
    const def = mode === EMBED_MODE ? getEmbeddingSourceDef(sourceId) : getRerankSourceDef(sourceId);
    if (!def) return;

    const showRow = (rowName, show) => {
        $form.find(`[data-row="${rowName}"]`).toggle(!!show);
    };

    showRow('model', !!def.needsModel || sourceId === 'webllm');
    showRow('api-url', !!def.needsUrl || !!def.urlOptional);
    showRow('proxy-password', !!def.needsUrl || !!def.urlOptional);
    showRow('secret-id', !!def.secretKey);

    showRow('jina-options', sourceId === 'jina');
    showRow('ollama-options', sourceId === 'ollama');
    showRow('siliconflow-options', sourceId === 'siliconflow');
    showRow('workers-ai-options', sourceId === 'workers_ai');
    showRow('vertexai-options', sourceId === 'vertexai' || sourceId === 'palm');

    // Update URL field label between "required" and "optional"
    const urlLabelSpan = $form.find('[data-row="api-url"] > span').first();
    if (urlLabelSpan.length) {
        const required = !!def.needsUrl && !def.urlOptional;
        const text = required
            ? urlLabelSpan.attr('data-i18n-url-required')
            : urlLabelSpan.attr('data-i18n-url-optional');
        if (text) urlLabelSpan.text(text);
    }
}

function readFormValues($form) {
    const out = {};
    $form.find('[data-field]').each(function () {
        const $el = $(this);
        const field = $el.attr('data-field');
        if (!field) return;
        if ($el.is(':checkbox')) {
            out[field] = $el.prop('checked') ? 'true' : '';
        } else {
            out[field] = String($el.val() ?? '').trim();
        }
    });
    return out;
}

/**
 * Open the create/edit popup for an embed or rerank profile.
 * @param {'embed'|'rerank'} mode
 * @param {object} initial Initial field values
 * @returns {Promise<object|null>} The collected field values, or null if cancelled
 */
async function openProfilePopup(mode, initial = {}) {
    const html = buildFormHtml(mode, initial);
    const $form = $(html);

    const $sourceSelect = $form.find('[data-field="source"]');
    const $secretSelect = $form.find('[data-field="secret-id"]');

    const onSourceChange = () => {
        const sourceId = String($sourceSelect.val() || '');
        const def = mode === EMBED_MODE ? getEmbeddingSourceDef(sourceId) : getRerankSourceDef(sourceId);
        applySourceVisibility($form, mode, sourceId);
        refreshSecretSelect($secretSelect, def, initial['secret-id'] || '');
        // Auto-fill default model on change if model field is blank
        const $modelInput = $form.find('[data-field="model"]');
        if (def && !String($modelInput.val() || '').trim() && def.defaultModel) {
            $modelInput.val(def.defaultModel);
        }
    };
    $sourceSelect.on('change', onSourceChange);
    onSourceChange();

    const popup = new Popup($form, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        large: false,
        allowVerticalScrolling: true,
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    return readFormValues($form);
}

function validateAndAssemble(mode, values, existingId = '') {
    const takenNames = ensureProfilesArray()
        .filter(p => p && p.id !== existingId)
        .map(p => String(p?.name || ''));
    const result = validateProfileFields(mode, values, takenNames);
    if (!result.ok) {
        toastr.error(result.error);
        return null;
    }
    result.profile.id = existingId || uuidv4();
    return result.profile;
}

/**
 * Create a new embedding or rerank profile via popup form.
 * @param {'embed'|'rerank'} mode
 * @param {object} [prefill]
 * @returns {Promise<object|null>}
 */
async function createProfile(mode, prefill = {}) {
    const initial = { source: mode === EMBED_MODE ? 'transformers' : 'cohere', ...prefill };
    const values = await openProfilePopup(mode, initial);
    if (!values) return null;
    const profile = validateAndAssemble(mode, values);
    if (!profile) return null;

    ensureProfilesArray().push(profile);
    saveSettingsDebounced();
    await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, profile);
    return profile;
}

/**
 * Edit an existing embedding or rerank profile via popup form.
 * @param {'embed'|'rerank'} mode
 * @param {string} profileId
 * @returns {Promise<object|null>}
 */
async function editProfile(mode, profileId) {
    const list = ensureProfilesArray();
    const idx = list.findIndex(p => p && p.id === profileId && String(p.mode || '') === mode);
    if (idx < 0) {
        toastr.warning(t`Profile not found.`);
        return null;
    }
    const existing = list[idx];
    const values = await openProfilePopup(mode, existing);
    if (!values) return null;
    const updated = validateAndAssemble(mode, values, existing.id);
    if (!updated) return null;

    const oldProfile = structuredClone(existing);
    list[idx] = updated;
    saveSettingsDebounced();
    await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, updated);
    return updated;
}

/**
 * Delete a profile after confirmation.
 * @param {'embed'|'rerank'} mode
 * @param {string} profileId
 * @returns {Promise<boolean>}
 */
async function deleteProfile(mode, profileId) {
    const list = ensureProfilesArray();
    const idx = list.findIndex(p => p && p.id === profileId && String(p.mode || '') === mode);
    if (idx < 0) return false;
    const profile = list[idx];
    const confirmed = await Popup.show.confirm(t`Delete profile "${profile.name}"?`, '');
    if (!confirmed) return false;

    list.splice(idx, 1);
    saveSettingsDebounced();
    await eventSource.emit(event_types.CONNECTION_PROFILE_DELETED, profile);
    return true;
}

export const createEmbeddingProfile = (prefill) => createProfile(EMBED_MODE, prefill);
export const editEmbeddingProfile = (profileId) => editProfile(EMBED_MODE, profileId);
export const deleteEmbeddingProfile = (profileId) => deleteProfile(EMBED_MODE, profileId);

export const createRerankProfile = (prefill) => createProfile(RERANK_MODE, prefill);
export const editRerankProfile = (profileId) => editProfile(RERANK_MODE, profileId);
export const deleteRerankProfile = (profileId) => deleteProfile(RERANK_MODE, profileId);

/**
 * Persist a pre-built embed profile (used by migrations).
 * Returns the inserted profile, or null if a name conflict prevents insertion.
 */
export function upsertEmbeddingProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    profile.mode = EMBED_MODE;
    if (!profile.id) profile.id = uuidv4();
    if (!profile.name) return null;
    const list = ensureProfilesArray();
    const idx = list.findIndex(p => p && p.id === profile.id);
    const cleaned = compactProfile({ ...profile }, EMBED_MODE);
    if (idx >= 0) {
        list[idx] = cleaned;
    } else {
        if (isNameTaken(cleaned.name)) return null;
        list.push(cleaned);
    }
    saveSettingsDebounced();
    return cleaned;
}

/**
 * Persist a pre-built rerank profile (used by migrations).
 */
export function upsertRerankProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    profile.mode = RERANK_MODE;
    if (!profile.id) profile.id = uuidv4();
    if (!profile.name) return null;
    const list = ensureProfilesArray();
    const idx = list.findIndex(p => p && p.id === profile.id);
    const cleaned = compactProfile({ ...profile }, RERANK_MODE);
    if (idx >= 0) {
        list[idx] = cleaned;
    } else {
        if (isNameTaken(cleaned.name)) return null;
        list.push(cleaned);
    }
    saveSettingsDebounced();
    return cleaned;
}

/**
 * Render a `<select>` element with all embed/rerank profiles for the given mode.
 * Includes a `<None>` option with empty value.
 * @param {HTMLSelectElement} selectEl
 * @param {'embed'|'rerank'} mode
 * @param {string} [selectedId]
 */
export function renderProfileSelect(selectEl, mode, selectedId = '') {
    selectEl.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '<None>';
    selectEl.appendChild(noneOption);

    const list = mode === EMBED_MODE ? listEmbeddingProfiles() : listRerankProfiles();
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const profile of list) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name;
        selectEl.appendChild(opt);
    }
    selectEl.value = selectedId || '';
}

export const EMBEDDING_MODE_NAME = EMBED_MODE;
export const RERANK_MODE_NAME = RERANK_MODE;
