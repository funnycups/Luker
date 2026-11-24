// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure live behavioral summary model for Hook Order settings.
// No DOM dependencies.

function defaultTranslate(text) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? '')) : String(text ?? '');
}

/**
 * Builds the 1-row live behavioral summary model for Hook Order
 * (detected listener hook count and custom vs detected default order counts).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildHookOrderSummaryModel(state = {}) {
    const i18n = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;

    let detectedCount = 0;
    let customCount = 0;

    if (Array.isArray(state.hooks)) {
        for (const hook of state.hooks) {
            const listeners = Array.isArray(hook?.discoveredPlugins)
                ? hook.discoveredPlugins.length
                : Math.max(0, Math.floor(Number(hook?.listenerCount) || 0));
            if (listeners <= 0) {
                continue;
            }
            detectedCount += 1;
            if (Array.isArray(hook?.customOrder) && hook.customOrder.length > 0) {
                customCount += 1;
            }
        }
    } else {
        detectedCount = Math.max(0, Math.floor(Number(state.detectedCount) || 0));
        customCount = Math.max(0, Math.min(detectedCount, Math.floor(Number(state.customCount) || 0)));
    }

    if (detectedCount === 0) {
        return {
            tone: 'dormant',
            rows: [{
                role: i18n('Hook order'),
                tone: 'off',
                template: i18n('${detectedCount} hooks with detected listeners — custom ordering is inactive.'),
                tokens: {
                    detectedCount: {
                        field: null,
                        text: '0',
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [],
        };
    }

    if (customCount === 0) {
        return {
            tone: 'active',
            rows: [{
                role: i18n('Hook order'),
                template: i18n('${detectedCount} hooks with detected listeners — all use ${orderMode}.'),
                tokens: {
                    detectedCount: {
                        field: 'hookList',
                        text: String(detectedCount),
                        tone: 'active',
                    },
                    orderMode: {
                        field: 'hookList',
                        text: i18n('detected default order'),
                        tone: 'active',
                    },
                },
            }],
            warnings: [],
            dormantFields: [],
        };
    }

    const defaultCount = detectedCount - customCount;
    return {
        tone: 'active',
        rows: [{
            role: i18n('Hook order'),
            template: i18n('${detectedCount} hooks with detected listeners — ${customCount} custom execution order, ${defaultCount} detected default order.'),
            tokens: {
                detectedCount: {
                    field: 'hookList',
                    text: String(detectedCount),
                    tone: 'active',
                },
                customCount: {
                    field: 'customHooks',
                    text: String(customCount),
                    tone: 'active',
                },
                defaultCount: {
                    field: 'hookList',
                    text: String(defaultCount),
                    tone: defaultCount > 0 ? 'active' : 'off',
                },
            },
        }],
        warnings: [],
        dormantFields: [],
    };
}
