// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary model for Chat Translation.
// All runtime checks mirror public/scripts/extensions/translate/index.js
// and src/endpoints/translate.js. No DOM dependencies.

const PROVIDER_LABELS = Object.freeze({
    libre: 'LibreTranslate',
    google: 'Google',
    lingva: 'Lingva',
    deepl: 'DeepL API',
    deeplx: 'DeepLX',
    bing: 'Bing',
    oneringtranslator: 'OneRingTranslator',
    yandex: 'Yandex',
});

const OPTIONAL_URL_PROVIDERS = new Set([
    'oneringtranslator',
    'deeplx',
    'lingva',
]);

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function normalizeAutoMode(raw) {
    const mode = String(raw || 'none').trim();
    if (mode === 'responses' || mode === 'inputs' || mode === 'both') {
        return mode;
    }
    return 'none';
}

function resolveAutoModeLabel(autoMode, translate) {
    switch (autoMode) {
        case 'responses':
            return translate('Translate responses', 'ext_translate_mode_responses');
        case 'inputs':
            return translate('Translate inputs', 'ext_translate_mode_inputs');
        case 'both':
            return translate('Translate both', 'ext_translate_mode_both');
        case 'none':
        default:
            return translate('None', 'ext_translate_mode_none');
    }
}

/**
 * Builds the live behavioral summary model for Chat Translation settings.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildTranslateSummaryModel(state = {}) {
    const translate = typeof state.i18n === 'function'
        ? state.i18n
        : (typeof state.translate === 'function' ? state.translate : defaultTranslate);

    const autoMode = normalizeAutoMode(state.autoMode);
    const provider = String(state.provider || 'google').trim() || 'google';
    const providerLabel = String(state.providerLabel || '').trim() || PROVIDER_LABELS[provider] || provider;
    const deeplEndpoint = state.deeplEndpoint === 'pro' ? 'pro' : 'free';
    const targetLanguage = String(state.targetLanguage || 'en').trim() || 'en';
    const targetLanguageLabel = String(state.targetLanguageLabel || '').trim()
        || (targetLanguage === 'en' ? translate('English') : targetLanguage);
    const hasKey = Boolean(state.hasKey);
    const hasUrl = Boolean(state.hasUrl);

    const autoModeToken = {
        field: 'autoMode',
        text: resolveAutoModeLabel(autoMode, translate),
        tone: autoMode === 'none' ? 'off' : 'active',
    };
    const targetLangToken = {
        field: 'targetLanguage',
        text: targetLanguageLabel,
        tone: (autoMode === 'inputs' || (targetLanguage === 'en' && autoMode === 'both'))
            ? (targetLanguage === 'en' ? 'warn' : 'off')
            : 'active',
    };
    const englishToken = {
        field: null,
        text: translate('English'),
        tone: 'active',
    };

    let modeRow;
    if (autoMode === 'none') {
        modeRow = {
            role: translate('Auto-mode', 'ext_translate_auto_mode'),
            tone: 'off',
            template: translate('${autoMode} — automatic translation is off, leaving only the manual message button and /translate into ${targetLanguage}.'),
            tokens: {
                autoMode: autoModeToken,
                targetLanguage: { ...targetLangToken, tone: 'off' },
            },
        };
    } else if (autoMode === 'responses') {
        modeRow = {
            role: translate('Auto-mode', 'ext_translate_auto_mode'),
            template: translate('${autoMode} — auto-translates incoming AI replies and reasoning into ${targetLanguage} for display only, keeping prompt text unchanged.'),
            tokens: {
                autoMode: autoModeToken,
                targetLanguage: targetLangToken,
            },
        };
    } else if (autoMode === 'inputs') {
        modeRow = {
            role: translate('Auto-mode', 'ext_translate_auto_mode'),
            template: translate('${autoMode} — auto-translates outgoing user inputs into ${english} for the model (original kept for display), while ${targetLanguage} is not the output language for inputs and only applies to manual /translate.'),
            tokens: {
                autoMode: autoModeToken,
                english: englishToken,
                targetLanguage: targetLangToken,
            },
        };
    } else {
        modeRow = {
            role: translate('Auto-mode', 'ext_translate_auto_mode'),
            template: translate('${autoMode} — auto-translates incoming AI replies and reasoning into ${targetLanguage} (display only) and outgoing user inputs into ${english} (sent to model).'),
            tokens: {
                autoMode: autoModeToken,
                targetLanguage: targetLangToken,
                english: englishToken,
            },
        };
    }

    let providerRow;
    if (provider === 'deepl') {
        providerRow = {
            role: translate('Provider', 'ext_translate_mode_provider'),
            template: translate('Routes requests through ${provider} (${deeplEndpoint}) with ${keyButton}.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'active',
                },
                deeplEndpoint: {
                    field: 'deeplEndpoint',
                    text: deeplEndpoint === 'pro' ? translate('Pro') : translate('Free'),
                    tone: 'active',
                },
                keyButton: {
                    field: 'keyButton',
                    text: hasKey ? translate('API key saved') : translate('missing API key'),
                    tone: hasKey ? 'active' : 'danger',
                },
            },
        };
    } else if (provider === 'libre') {
        providerRow = {
            role: translate('Provider', 'ext_translate_mode_provider'),
            template: translate('Routes requests through ${provider} at ${urlButton}.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'active',
                },
                urlButton: {
                    field: 'urlButton',
                    text: hasUrl ? translate('endpoint URL saved') : translate('missing endpoint URL'),
                    tone: hasUrl ? 'active' : 'danger',
                },
            },
        };
    } else if (OPTIONAL_URL_PROVIDERS.has(provider)) {
        providerRow = {
            role: translate('Provider', 'ext_translate_mode_provider'),
            template: translate('Routes requests through ${provider} (${urlButton}).'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'active',
                },
                urlButton: {
                    field: 'urlButton',
                    text: hasUrl ? translate('custom URL saved') : translate('default endpoint URL'),
                    tone: hasUrl ? 'active' : 'off',
                },
            },
        };
    } else {
        providerRow = {
            role: translate('Provider', 'ext_translate_mode_provider'),
            template: translate('Routes requests through ${provider}.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'active',
                },
            },
        };
    }

    const warnings = [];
    if (provider === 'deepl' && !hasKey) {
        warnings.push({
            severity: 'danger',
            template: translate('${provider} requires an API key — configure ${keyButton} or translation requests will fail.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'danger',
                },
                keyButton: {
                    field: 'keyButton',
                    text: translate('Key'),
                    tone: 'danger',
                },
            },
        });
    }

    if (provider === 'libre' && !hasUrl) {
        warnings.push({
            severity: 'danger',
            template: translate('${provider} requires a server URL — configure ${urlButton} or translation requests will fail.'),
            tokens: {
                provider: {
                    field: 'provider',
                    text: providerLabel,
                    tone: 'danger',
                },
                urlButton: {
                    field: 'urlButton',
                    text: translate('URL'),
                    tone: 'danger',
                },
            },
        });
    }

    if ((autoMode === 'inputs' || autoMode === 'both') && targetLanguage === 'en') {
        warnings.push({
            severity: 'warn',
            template: autoMode === 'inputs'
                ? translate('${targetLanguage} is set to English while ${autoMode} is active — outgoing inputs always translate to English regardless, and Target Language only applies to manual /translate.')
                : translate('${targetLanguage} is set to English while ${autoMode} is active — incoming replies will also be translated into English, while outgoing inputs always translate to English.'),
            tokens: {
                targetLanguage: {
                    field: 'targetLanguage',
                    text: translate('Target Language', 'ext_translate_target_lang'),
                    tone: 'warn',
                },
                autoMode: {
                    field: 'autoMode',
                    text: resolveAutoModeLabel(autoMode, translate),
                    tone: 'warn',
                },
            },
        });
    }

    const dormantFields = [];
    if (provider !== 'deepl') {
        dormantFields.push('deeplEndpoint');
    }

    let tone = 'active';
    if (warnings.some((w) => w.severity === 'danger')) {
        tone = 'danger';
    } else if (warnings.length > 0) {
        tone = 'warn';
    } else if (autoMode === 'none') {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [modeRow, providerRow],
        warnings,
        dormantFields,
    };
}
