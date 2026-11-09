// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Display names for schema types, relations and fields, on top of
// memory-graph's i18n helpers. Internal identifiers stay off the screen in
// Chinese locales; other locales fall back to a readable form of the key.
// Pure: no DOM access.

import { i18n, i18nFormat } from '../i18n.js';

export { i18n, i18nFormat };

const TYPE_LABELS = { event: 'Event', character_sheet: 'Character sheet', location_state: 'Location', thread: 'Plot thread', rule_constraint: 'Rule' };

const RELATION_LABELS = { related: 'Related', involved_in: 'Involved in', occurred_at: 'Occurred at', mentions: 'Mentions', evidence: 'Evidence', updates: 'Updates', advances: 'Advances', partner_of: 'Partner', family_of: 'Family', allied_with: 'Allied', hostile_to: 'Hostile', mentor_of: 'Mentor', sworn_to: 'Sworn to', debt_owed_to: 'Owes', deceiving: 'Deceiving', contains: 'Contains', semantic_contains: 'Summary contains' };

const FIELD_LABELS = { summary: 'Summary', title: 'Name', name: 'Name', aliases: 'Aliases', traits: 'Traits', identity: 'Identity', goal: 'Goal', inventory: 'Key items', language_sample: 'Speaking style', addressing_user: 'How they address the user', controller: 'Controller', danger: 'Danger', resources: 'Resources', state: 'State', status: 'State', note: 'Remarks' };

// Names coming from the user's schema (set by the app after each load).
let customTypeLabels = {};
let customFieldLabels = {};

export function isChineseLocale() {
    return String(Luker.getContext().getCurrentLocale() || '').toLowerCase().startsWith('zh');
}

export function listSeparator() {
    return isChineseLocale() ? '\u3001' : ', ';
}

/** "language_sample" -> "Language sample". */
export function humanizeKey(key) {
    const text = String(key || '').replace(/_+/g, ' ').trim();
    return text ? text[0].toUpperCase() + text.slice(1) : i18n('Unnamed item');
}

/** @param {{types?: Record<string,string>, columns?: Record<string, Record<string,string>>}} maps */
export function setDisplayLabels(maps = {}) {
    customTypeLabels = { ...(maps.types || {}) };
    customFieldLabels = {};
    for (const [type, columns] of Object.entries(maps.columns || {})) customFieldLabels[type] = { ...columns };
}

export function typeLabel(type) {
    return customTypeLabels[type] || (TYPE_LABELS[type] ? i18n(TYPE_LABELS[type]) : i18n('Other'));
}

export function builtinTypeLabel(type) {
    return TYPE_LABELS[type] ? i18n(TYPE_LABELS[type]) : '';
}

export function relationLabel(type) {
    return i18n(RELATION_LABELS[type] || 'Related');
}

export function hasFieldLabel(key) {
    return Object.hasOwn(FIELD_LABELS, key);
}

/** Display name for a record item; `type` lets user-defined names win. */
export function fieldLabel(key, type = '') {
    if (type && customFieldLabels[type]?.[key]) return customFieldLabels[type][key];
    if (hasFieldLabel(key)) return i18n(FIELD_LABELS[key]);
    if (/[\u3400-\u9fff]/.test(key)) return key;
    return isChineseLocale() ? i18n('Unnamed item') : humanizeKey(key);
}

/** "Level 1 summary" for depth 1, etc. */
export function depthLabel(depth) {
    const n = Math.max(1, Math.floor(Number(depth) || 1));
    return n <= 10 ? i18n(`Level ${n} summary`) : i18nFormat('Level ${0} summary', n);
}
