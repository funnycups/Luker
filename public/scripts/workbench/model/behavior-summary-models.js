// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Workbench Settings (3A–3B).
// No DOM dependencies.

import { i18n, i18nFormat, listSeparator } from '../i18n.js';

function normalizeSourceNames(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(item => (item && typeof item === 'object'
            ? String(item.name || item.label || item.key || '')
            : String(item ?? '')).trim())
        .filter(Boolean);
}

function formatFloorsTokenText(floors) {
    if (floors === 'all') return i18n('No limit');
    const isBlank = floors === '' || floors === null || floors === undefined
        || (typeof floors === 'string' && floors.trim() === '');
    const num = isBlank ? 2 : Number(floors);
    const count = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 2;
    if (count === 0) return i18n('That floor only');
    if (count === 2) return i18n('2 floors each side');
    if (count === 5) return i18n('5 floors each side');
    return i18nFormat('${0} floors each side', count);
}

/**
 * 3A. Workbench AI & editing behavior summary.
 * Explicitly states Workbench AI never alters main chat replies or automatic
 * plugin tasks, and distinguishes preview-first vs direct apply.
 */
export function buildWorkbenchAiSummary({
    sharedConnection = '',
    sharedPreset = '',
    reviewChanges = true,
    targetOverrideCount = 0,
} = {}) {
    const conn = String(sharedConnection || '').trim();
    const preset = String(sharedPreset || '').trim();
    const review = reviewChanges !== false;
    const overrides = Math.max(0, Math.floor(Number(targetOverrideCount) || 0));

    const overrideTokenText = overrides === 0
        ? i18n('no per-target overrides')
        : (overrides === 1 ? i18n('1 target override') : i18nFormat('${0} target overrides', overrides));

    const scopeRow = {
        role: i18n('AI scope'),
        template: overrides === 0
            ? i18n('Workbench AI uses ${sharedConnection} + ${sharedPreset} (${targetOverrides}) and never alters main chat replies or automatic plugin tasks.')
            : i18n('Workbench AI uses ${sharedConnection} + ${sharedPreset} (${targetOverrides} set below) and never alters main chat replies or automatic plugin tasks.'),
        tokens: {
            sharedConnection: {
                field: 'sharedConnection',
                text: conn || i18n('Luker\'s current connection'),
                tone: 'active',
            },
            sharedPreset: {
                field: 'sharedPreset',
                text: preset || i18n('Luker\'s current preset'),
                tone: 'active',
            },
            targetOverrides: {
                field: 'targetOverrides',
                text: overrideTokenText,
                tone: overrides > 0 ? 'active' : 'off',
            },
        },
    };

    const applyRow = {
        role: i18n('Apply mode'),
        template: review
            ? i18n('${reviewChanges} — edits wait in a review list for your confirmation before saving.')
            : i18n('${reviewChanges} — AI edits save immediately without confirmation (undoable in Change history).'),
        tokens: {
            reviewChanges: {
                field: 'reviewChanges',
                text: review ? i18n('Preview before applying') : i18n('Direct apply'),
                tone: review ? 'active' : 'warn',
            },
        },
    };

    return {
        tone: 'active',
        rows: [scopeRow, applyRow],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * 3B. Workbench Q&A context & privacy summary.
 * Emits amber warnings when redaction is disabled or all local data sources
 * are unchecked.
 */
export function buildWorkbenchQaSummary({
    enabledSources = [],
    allSources = [],
    floors = 2,
    previewBeforeSend = false,
    redact = true,
} = {}) {
    const enabledList = normalizeSourceNames(enabledSources);
    void normalizeSourceNames(allSources);
    const hasSources = enabledList.length > 0;
    const isPreview = Boolean(previewBeforeSend);
    const isRedact = redact !== false;

    const sourcesRow = {
        role: i18n('Data sources'),
        template: hasSources
            ? i18n('Q&A can read ${enabledSources}, plus ${floors} around any referenced reply.')
            : i18n('Q&A can read ${enabledSources}, and ${floors} is inactive.'),
        tokens: {
            enabledSources: {
                field: 'qaSources',
                text: hasSources ? enabledList.join(listSeparator()) : i18n('none — Q&A has no local context'),
                tone: hasSources ? 'active' : 'warn',
            },
            floors: {
                field: 'qaFloors',
                text: formatFloorsTokenText(floors),
                tone: hasSources ? 'active' : 'off',
            },
        },
    };

    const privacyRow = {
        role: i18n('Privacy & send'),
        template: i18n('${redact} before sending, and ${previewBeforeSend}.'),
        tokens: {
            redact: {
                field: 'qaRedact',
                text: isRedact ? i18n('Strips API keys and URLs') : i18n('Sends raw keys and URLs'),
                tone: isRedact ? 'active' : 'warn',
            },
            previewBeforeSend: {
                field: 'qaPreviewBeforeSend',
                text: isPreview ? i18n('previews payload first') : i18n('sends immediately without preview'),
                tone: isPreview ? 'active' : 'off',
            },
        },
    };

    const warnings = [];
    if (!isRedact) {
        warnings.push({
            severity: 'warn',
            template: i18n('${redact} — API keys and endpoint URLs in logs or requests will be sent to the AI unmodified.'),
            tokens: {
                redact: {
                    field: 'qaRedact',
                    text: i18n('Redaction is off'),
                    tone: 'warn',
                },
            },
        });
    }
    if (!hasSources) {
        warnings.push({
            severity: 'warn',
            template: i18n('${enabledSources} — Q&A has no local context and can only read your question.'),
            tokens: {
                enabledSources: {
                    field: 'qaSources',
                    text: i18n('No data sources enabled'),
                    tone: 'warn',
                },
            },
        });
    }

    return {
        tone: warnings.length > 0 ? 'warn' : 'active',
        rows: [sourcesRow, privacyRow],
        warnings,
        dormantFields: hasSources ? [] : ['qaFloors'],
    };
}
