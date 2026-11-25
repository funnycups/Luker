// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { escapeHtml } from '../lib/html-escape.js';

/**
 * List unique, trimmed Chat Completion (OpenAI) preset names from the host context.
 * @param {object} context
 * @param {{ sort?: boolean }} [options]
 * @returns {string[]}
 */
export function getOpenAIPresetNames(context, { sort = false } = {}) {
    let rawNames = null;
    const manager = context?.getPresetManager?.('openai');
    if (manager && typeof manager.getAllPresets === 'function') {
        const names = manager.getAllPresets();
        if (Array.isArray(names)) {
            rawNames = names;
        }
    }
    if (!rawNames && typeof context?.presets?.list === 'function') {
        const refs = context.presets.list('openai');
        if (Array.isArray(refs)) {
            rawNames = refs.map(ref => ref?.name);
        }
    }
    if (!Array.isArray(rawNames)) {
        return [];
    }
    const unique = [...new Set(rawNames.map(name => String(name || '').trim()).filter(Boolean))];
    if (sort) {
        unique.sort((left, right) => left.localeCompare(right));
    }
    return unique;
}

/**
 * List unique, trimmed Chat Completion connection profile names from either a
 * pre-fetched profiles array or the host context.
 * @param {object | Array<object>} source - Host context or array of profile objects
 * @param {{ sort?: boolean }} [options]
 * @returns {string[]}
 */
export function getConnectionProfileNames(source, { sort = false } = {}) {
    const rawProfiles = Array.isArray(source)
        ? source
        : (typeof source?.connectionProfiles?.list === 'function' ? source.connectionProfiles.list() : []);
    if (!Array.isArray(rawProfiles)) {
        return [];
    }
    const unique = [...new Set(rawProfiles.map(profile => String(profile?.name || '').trim()).filter(Boolean))];
    if (sort) {
        unique.sort((left, right) => left.localeCompare(right));
    }
    return unique;
}

/**
 * Render `<option>` elements for a selector with an empty-default option and a
 * `(missing)` placeholder when `selectedName` is not present in `names`.
 * @param {string[]} names
 * @param {{ selectedName?: string, emptyLabel?: string, missingLabel?: string }} [options]
 * @returns {string}
 */
export function renderSelectOptions(names, {
    selectedName = '',
    emptyLabel = '',
    missingLabel = '(missing)',
} = {}) {
    const selected = String(selectedName || '').trim();
    const list = Array.isArray(names) ? names : [];
    const options = [`<option value="">${escapeHtml(String(emptyLabel || ''))}</option>`];
    for (const name of list) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !list.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(String(missingLabel || '(missing)'))}</option>`);
    }
    return options.join('');
}

/**
 * Render `<option>` elements for a Chat Completion preset selector.
 * @param {object} context
 * @param {string} [selectedName]
 * @param {{ emptyLabel?: string, missingLabel?: string, sort?: boolean }} [options]
 * @returns {string}
 */
export function renderOpenAIPresetOptions(context, selectedName = '', {
    emptyLabel = '(Current preset)',
    missingLabel = '(missing)',
    sort = false,
} = {}) {
    return renderSelectOptions(getOpenAIPresetNames(context, { sort }), {
        selectedName,
        emptyLabel,
        missingLabel,
    });
}

/**
 * Render `<option>` elements for a Chat Completion connection profile selector.
 * @param {object | Array<object>} source - Host context or array of profile objects
 * @param {string} [selectedName]
 * @param {{ emptyLabel?: string, missingLabel?: string, sort?: boolean }} [options]
 * @returns {string}
 */
export function renderConnectionProfileOptions(source, selectedName = '', {
    emptyLabel = '(Current API config)',
    missingLabel = '(missing)',
    sort = false,
} = {}) {
    return renderSelectOptions(getConnectionProfileNames(source, { sort }), {
        selectedName,
        emptyLabel,
        missingLabel,
    });
}
