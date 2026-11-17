// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Advanced-settings defaults and normalization.
 *
 * `ADVANCED_SETTING_DEFAULTS` carries only the keys that are seeded into
 * `defaultSettings`. The five unseeded keys are deliberately absent so their
 * slots stay empty on disk and the code constants keep driving the runtime
 * value; a seeded text slot would freeze the constant for that user.
 *
 * `normalizeAdvancedSettings` returns all 24 registered keys. The Advanced
 * panel and the Layer-2 API both write the whole normalized object, so the
 * shape stays a full snapshot even though the registry knows more keys than
 * the seeded defaults.
 */

import { CONFIG_FIELDS } from './fields.js';

const UNSEDDED_KEYS = new Set([
    'extractTemplate',
    'extractEdgeRules',
    'extractConcurrent',
    'graphIterSystemPrompt',
    'configIterSystemPrompt',
]);

/** Settings keys seeded into `defaultSettings` with their code defaults. */
export const ADVANCED_SETTING_DEFAULTS = Object.freeze(Object.fromEntries(
    Object.values(CONFIG_FIELDS)
        .filter(def => !UNSEDDED_KEYS.has(def.key))
        .map(def => [def.key, def.defaultValue]),
));

function pickBase(fallbackSource) {
    return fallbackSource && typeof fallbackSource === 'object'
        ? fallbackSource
        : ADVANCED_SETTING_DEFAULTS;
}

function normalizeInt(def, input, base) {
    const raw = Number(input[def.key]);
    const fallback = Number(base[def.key] ?? def.defaultValue);
    let value = Math.floor(Number.isFinite(raw) ? raw : fallback);
    if (Number.isFinite(def.min)) {
        value = Math.max(def.min, value);
    }
    if (Number.isFinite(def.max)) {
        value = Math.min(def.max, value);
    }
    return value;
}

function normalizeBool(def, input, base) {
    if (typeof input[def.key] === 'boolean') {
        return input[def.key];
    }
    if (typeof base[def.key] === 'boolean') {
        return base[def.key];
    }
    return def.defaultValue;
}

function normalizeEnum(def, input, base) {
    const candidate = String(input[def.key] ?? '').trim().toLowerCase();
    if (def.values.includes(candidate)) {
        return candidate;
    }
    const baseCandidate = String(base[def.key] ?? '').trim().toLowerCase();
    return def.values.includes(baseCandidate) ? baseCandidate : def.defaultValue;
}

function normalizeText(def, input, base) {
    let value = String(input[def.key] ?? '').trim();
    if (!value) {
        const baseValue = String(base[def.key] ?? '').trim();
        value = def.fillDefaultOnNormalize ? (baseValue || def.defaultValue) : baseValue;
    }
    if (def.clearWhenDefault && value === String(def.defaultValue ?? '').trim()) {
        return '';
    }
    return value;
}

/**
 * Normalize the crawl candidate limit. 0 means unlimited; positive values
 * clamp to the registry bounds. Empty, non-numeric, and negative values fall
 * back instead of silently turning into the unlimited sentinel.
 */
export function normalizeCrawlCandidateLimit(value, fallback = 40) {
    const def = CONFIG_FIELDS['settings.extractCrawlCandidateLimit'];
    const rawText = value === null || value === undefined ? '' : String(value).trim();
    const raw = rawText === '' ? NaN : Number(rawText);
    const fallbackNum = Number(fallback);
    const candidate = Number.isFinite(raw) && raw >= 0
        ? raw
        : (Number.isFinite(fallbackNum) && fallbackNum >= 0 ? fallbackNum : def.defaultValue);
    return Math.max(def.min, Math.min(def.max, Math.floor(candidate)));
}

/**
 * Normalize a settings snapshot against a fallback source. Returns every
 * registered key; text slots that only repeat a default stay empty unless
 * the field is explicitly seeded from the default.
 */
export function normalizeAdvancedSettings(source = null, fallbackSource = null) {
    const input = source && typeof source === 'object' ? source : {};
    const base = pickBase(fallbackSource);
    const normalized = {};
    for (const def of Object.values(CONFIG_FIELDS)) {
        switch (def.kind) {
            case 'int':
                normalized[def.key] = def.key === 'extractCrawlCandidateLimit'
                    ? normalizeCrawlCandidateLimit(input[def.key], base[def.key] ?? def.defaultValue)
                    : normalizeInt(def, input, base);
                break;
            case 'bool':
                normalized[def.key] = normalizeBool(def, input, base);
                break;
            case 'enum':
                normalized[def.key] = normalizeEnum(def, input, base);
                break;
            case 'text':
                normalized[def.key] = normalizeText(def, input, base);
                break;
            default:
                normalized[def.key] = def.defaultValue;
        }
    }
    return normalized;
}

/**
 * Normalize `values` against `target` and write all 24 keys back. Mutates
 * `target` in place.
 */
export function applyAdvancedSettings(target, values) {
    if (!target || typeof target !== 'object') {
        return;
    }
    const normalized = normalizeAdvancedSettings(values, target);
    for (const def of Object.values(CONFIG_FIELDS)) {
        target[def.key] = normalized[def.key];
    }
}

/** Floor and clamp the extraction exclusion window at zero. */
export function normalizeExtractExcludeRecentTurns(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}

/** Clamp the recall query window to the registry bounds, falling back when unparsable. */
export function sanitizeRecallQueryMessages(rawValue, fallback = 2) {
    const num = Number(rawValue);
    const fallbackNum = Number(fallback);
    const effective = Number.isFinite(num)
        ? num
        : (Number.isFinite(fallbackNum) ? fallbackNum : 2);
    const { min, max } = CONFIG_FIELDS['settings.recallQueryMessages'];
    return Math.max(min, Math.min(max, Math.floor(effective)));
}
