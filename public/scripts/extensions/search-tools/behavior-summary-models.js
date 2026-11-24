// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure live behavioral summary models for Search Tools settings (Main Card +
// Shared Lorebook Injection Card). No DOM dependencies.

import { getSearchProviderDefinition } from './providers.js';

const DEFAULT_POSITIONS = Object.freeze({
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
});

const DEFAULT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

const AGENT_FIELDS = Object.freeze([
    'agentApiPresetName',
    'agentPresetName',
    'includeWorldInfoWithPreset',
    'toolCallRetryMax',
    'agentSystemPrompt',
]);

const LOREBOOK_FIELDS = Object.freeze([
    'lorebookPosition',
    'lorebookDepth',
    'lorebookRole',
    'lorebookEntryOrder',
]);

function defaultTranslate(text) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? '')) : String(text ?? '');
}

function clampInt(raw, min, max, fallback) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function resolvePositionLabel(posVal, positions, i18n) {
    const p = positions || DEFAULT_POSITIONS;
    const num = Number(posVal);
    if (num === Number(p.before)) return i18n('Before Character Definitions');
    if (num === Number(p.after)) return i18n('After Character Definitions');
    if (num === Number(p.ANTop)) return i18n('Before Author\'s Note');
    if (num === Number(p.ANBottom)) return i18n('After Author\'s Note');
    if (num === Number(p.EMTop)) return i18n('Before Example Messages');
    if (num === Number(p.EMBottom)) return i18n('After Example Messages');
    if (num === Number(p.atDepth)) return i18n('At Chat Depth');
    return String(posVal ?? '');
}

function resolveRoleLabel(roleVal, roles, i18n) {
    const r = roles || DEFAULT_ROLES;
    const num = Number(roleVal);
    if (num === Number(r.SYSTEM)) return i18n('System');
    if (num === Number(r.USER)) return i18n('User');
    if (num === Number(r.ASSISTANT)) return i18n('Assistant');
    return String(roleVal ?? '');
}

/**
 * Builds the top-of-panel behavioral summary model for Search Tools
 * (2x2 interaction between main-model tools and pre-request search agent,
 * provider configuration, fetch limits, and credential/prompt warnings).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildSearchToolsMainSummary(state = {}) {
    const i18n = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;
    const enabled = Boolean(state.enabled);
    const preRequestEnabled = Boolean(state.preRequestEnabled);
    const providerDef = getSearchProviderDefinition(state.provider);
    const providerText = String(state.providerLabel || '').trim() || i18n(providerDef.label);
    const maxResults = clampInt(state.defaultMaxResults, 1, 20, 8);
    const visitMaxChars = clampInt(state.defaultVisitMaxChars, 0, 50000, 4000);

    const apiPresetName = String(state.agentApiPresetName || '').trim();
    const presetName = String(state.agentPresetName || '').trim();
    const includeWi = state.includeWorldInfoWithPreset !== false;
    const retries = clampInt(state.toolCallRetryMax, 0, 5, 2);
    const agentPrompt = String(state.agentSystemPrompt ?? '');

    const requiresSecret = Boolean(providerDef.secretKey);
    const missingSecret = requiresSecret && state.hasApiKey === false;
    const missingSearxngUrl = providerDef.id === 'searxng' && !String(state.baseUrl || '').trim();
    const missingPrompt = preRequestEnabled && !agentPrompt.trim();

    const mainModelRow = enabled
        ? {
            role: i18n('Main model'),
            template: i18n('${enabled} — main chat model can search the web and visit pages.'),
            tokens: {
                enabled: {
                    field: 'enabled',
                    text: i18n('Web search & visit tools exposed'),
                    tone: 'active',
                },
            },
        }
        : {
            role: i18n('Main model'),
            tone: 'off',
            template: i18n('${enabled} — main chat model cannot call web search tools directly.'),
            tokens: {
                enabled: {
                    field: 'enabled',
                    text: i18n('Tools not exposed'),
                    tone: 'off',
                },
            },
        };

    const agentRow = preRequestEnabled
        ? {
            role: i18n('Pre-request agent'),
            template: i18n('${preRequestEnabled} before generation using ${agentApiPresetName} + ${agentPresetName}, ${includeWorldInfoWithPreset}, up to ${toolCallRetryMax} tool retries.'),
            tokens: {
                preRequestEnabled: {
                    field: 'preRequestEnabled',
                    text: i18n('Runs automatically'),
                    tone: 'active',
                },
                agentApiPresetName: {
                    field: 'agentApiPresetName',
                    text: apiPresetName || i18n('(Current API config)'),
                    tone: 'active',
                },
                agentPresetName: {
                    field: 'agentPresetName',
                    text: presetName || i18n('(Current preset)'),
                    tone: 'active',
                },
                includeWorldInfoWithPreset: {
                    field: 'includeWorldInfoWithPreset',
                    text: includeWi ? i18n('with world info') : i18n('without world info'),
                    tone: includeWi ? 'active' : 'off',
                },
                toolCallRetryMax: {
                    field: 'toolCallRetryMax',
                    text: String(retries),
                    tone: retries > 0 ? 'active' : 'off',
                },
            },
        }
        : {
            role: i18n('Pre-request agent'),
            tone: 'off',
            template: i18n('${preRequestEnabled} — no automatic web research or lorebook writes run before generation.'),
            tokens: {
                preRequestEnabled: {
                    field: 'preRequestEnabled',
                    text: i18n('Pre-request agent off'),
                    tone: 'off',
                },
            },
        };

    const bothOff = !enabled && !preRequestEnabled;
    const noTruncation = visitMaxChars === 0;
    let providerTemplate;
    if (bothOff) {
        providerTemplate = noTruncation
            ? i18n('Queries ${provider} (up to ${defaultMaxResults} results, ${defaultVisitMaxChars} on visited pages) — Orchestrator and other plugins can still call it when main toggles are off.')
            : i18n('Queries ${provider} (up to ${defaultMaxResults} results, truncates visited pages at ${defaultVisitMaxChars} chars) — Orchestrator and other plugins can still call it when main toggles are off.');
    } else {
        providerTemplate = noTruncation
            ? i18n('Queries ${provider} returning up to ${defaultMaxResults} results and ${defaultVisitMaxChars} on visited pages.')
            : i18n('Queries ${provider} returning up to ${defaultMaxResults} results and truncating visited pages at ${defaultVisitMaxChars} chars.');
    }

    const providerRow = {
        role: i18n('Provider & limits'),
        template: providerTemplate,
        tokens: {
            provider: {
                field: 'provider',
                text: providerText,
                tone: (missingSecret || missingSearxngUrl) ? 'danger' : 'active',
            },
            defaultMaxResults: {
                field: 'defaultMaxResults',
                text: String(maxResults),
                tone: 'active',
            },
            defaultVisitMaxChars: {
                field: 'defaultVisitMaxChars',
                text: noTruncation ? i18n('no truncation') : String(visitMaxChars),
                tone: noTruncation ? 'off' : 'active',
            },
        },
    };

    const warnings = [];
    if (missingSecret) {
        warnings.push({
            severity: 'danger',
            template: i18n('${provider} requires an API key that is not configured — search calls will fail until configured.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerText,
                    tone: 'danger',
                },
            },
        });
    }
    if (missingSearxngUrl) {
        warnings.push({
            severity: 'danger',
            template: i18n('${provider} has an empty ${searxngBaseUrl} — search calls will fail until a URL is set.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerText,
                    tone: 'danger',
                },
                searxngBaseUrl: {
                    field: 'searxngBaseUrl',
                    text: i18n('SearXNG instance URL'),
                    tone: 'danger',
                },
            },
        });
    }
    if (missingPrompt) {
        warnings.push({
            severity: 'danger',
            template: i18n('Pre-request search agent is enabled with an empty ${agentSystemPrompt} — the agent cannot run without instructions.'),
            tokens: {
                agentSystemPrompt: {
                    field: 'agentSystemPrompt',
                    text: i18n('Agent system prompt'),
                    tone: 'danger',
                },
            },
        });
    }

    const hasDanger = warnings.some((w) => w.severity === 'danger');
    let tone = 'active';
    if (hasDanger) {
        tone = 'danger';
    } else if (bothOff) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [mainModelRow, agentRow, providerRow],
        warnings,
        dormantFields: preRequestEnabled ? [] : [...AGENT_FIELDS],
    };
}

/**
 * Builds the Shared Lorebook Injection behavioral summary model for Search Tools.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildSearchToolsLorebookSummary(state = {}) {
    const i18n = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;
    const enabled = Boolean(state.enabled);
    const preRequestEnabled = Boolean(state.preRequestEnabled);
    const positions = state.positions || DEFAULT_POSITIONS;
    const roles = state.roles || DEFAULT_ROLES;

    const rawPos = Number(state.lorebookPosition ?? positions.atDepth);
    const isAtDepth = rawPos === Number(positions.atDepth);
    const depth = clampInt(state.lorebookDepth, 0, 9999, 9999);
    const roleVal = Number(state.lorebookRole ?? roles.SYSTEM);
    const order = clampInt(state.lorebookEntryOrder, 0, 20000, 9800);

    if (!enabled && !preRequestEnabled) {
        return {
            tone: 'dormant',
            rows: [{
                role: i18n('Lorebook injection'),
                tone: 'off',
                template: i18n('Shared search lorebook is inactive while both ${enabled} and ${preRequestEnabled} are off — stored entries are not injected.'),
                tokens: {
                    enabled: {
                        field: 'enabled',
                        text: i18n('Expose tools to main model'),
                        tone: 'off',
                    },
                    preRequestEnabled: {
                        field: 'preRequestEnabled',
                        text: i18n('Run pre-request search agent'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...LOREBOOK_FIELDS],
        };
    }

    const tokens = {
        lorebookPosition: {
            field: 'lorebookPosition',
            text: resolvePositionLabel(rawPos, positions, i18n),
            tone: 'active',
        },
        ...(isAtDepth ? {
            lorebookDepth: {
                field: 'lorebookDepth',
                text: String(depth),
                tone: 'active',
            },
            lorebookRole: {
                field: 'lorebookRole',
                text: resolveRoleLabel(roleVal, roles, i18n),
                tone: 'active',
            },
        } : {}),
        lorebookEntryOrder: {
            field: 'lorebookEntryOrder',
            text: String(order),
            tone: 'active',
        },
    };

    let template;
    if (!preRequestEnabled) {
        template = isAtDepth
            ? i18n('Existing stored entries stay injected at ${lorebookPosition}, depth ${lorebookDepth} as ${lorebookRole}, order ${lorebookEntryOrder} — no new automatic entries are written while pre-request agent is off.')
            : i18n('Existing stored entries stay injected at ${lorebookPosition}, order ${lorebookEntryOrder} — no new automatic entries are written while pre-request agent is off.');
    } else {
        template = isAtDepth
            ? i18n('Writes and injects stored search entries at ${lorebookPosition}, depth ${lorebookDepth} as ${lorebookRole}, order ${lorebookEntryOrder}.')
            : i18n('Writes and injects stored search entries at ${lorebookPosition}, order ${lorebookEntryOrder}.');
    }

    return {
        tone: 'active',
        rows: [{
            role: i18n('Lorebook injection'),
            template,
            tokens,
        }],
        warnings: [],
        dormantFields: [],
    };
}
