// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary model for Character Expressions.
// All runtime checks mirror public/scripts/extensions/expressions/index.js.
// No DOM dependencies.

const EXPRESSION_API = Object.freeze({
    local: 0,
    llm: 2,
    webllm: 3,
    none: 99,
});

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function normalizeApi(raw) {
    const num = Number(raw);
    if (num === EXPRESSION_API.local || num === EXPRESSION_API.llm || num === EXPRESSION_API.webllm || num === EXPRESSION_API.none) {
        return num;
    }
    return EXPRESSION_API.none;
}

function resolveApiLabel(api, translate) {
    switch (api) {
        case EXPRESSION_API.local:
            return translate('Local');
        case EXPRESSION_API.llm:
            return translate('Main API');
        case EXPRESSION_API.webllm:
            return translate('WebLLM Extension');
        case EXPRESSION_API.none:
        default:
            return translate('[ None ]');
    }
}

function resolveFallbackToken(fallbackRaw, translate) {
    const raw = String(fallbackRaw ?? '').trim();
    if (!raw || raw === '#none') {
        return {
            field: 'fallback',
            text: translate('no fallback sprite'),
            tone: 'off',
        };
    }
    if (raw === '#emoji') {
        return {
            field: 'fallback',
            text: translate('default emojis'),
            tone: 'active',
        };
    }
    return {
        field: 'fallback',
        text: raw,
        tone: 'active',
    };
}

/**
 * Builds the live behavioral summary model for Character Expressions settings.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildExpressionsSummaryModel(state = {}) {
    const translate = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;

    const api = normalizeApi(state.api);
    const promptType = state.promptType === 'full' ? 'full' : 'raw';
    const translateEnabled = Boolean(state.translate);
    const allowMultiple = state.allowMultiple === undefined ? true : Boolean(state.allowMultiple);
    const rerollIfSame = Boolean(state.rerollIfSame);
    const filterAvailable = Boolean(state.filterAvailable);
    const hasLlmPrompt = state.llmPrompt === undefined || Boolean(String(state.llmPrompt ?? '').trim());

    const apiToken = {
        field: 'api',
        text: resolveApiLabel(api, translate),
        tone: api === EXPRESSION_API.none ? 'off' : 'active',
    };

    const translateToken = {
        field: 'translate',
        text: translateEnabled
            ? translate('pre-translates message text to English')
            : translate('classifies original text'),
        tone: (api === EXPRESSION_API.llm && promptType === 'full' && translateEnabled)
            ? 'warn'
            : (translateEnabled ? 'active' : 'off'),
    };

    const filterToken = {
        field: 'filterAvailable',
        text: filterAvailable
            ? translate('filters labels to assigned sprites')
            : translate('uses full expression list'),
        tone: filterAvailable ? 'active' : 'off',
    };

    const promptTypeToken = {
        field: 'promptType',
        text: promptType === 'full' ? translate('Full Context') : translate('Limited Context'),
        tone: 'active',
    };

    let classifierRow;
    if (api === EXPRESSION_API.none) {
        classifierRow = {
            role: translate('Classifier'),
            tone: 'off',
            template: translate('${api} — automatic classification is off (manual sprite clicks and /emote only).'),
            tokens: { api: apiToken },
        };
    } else if (api === EXPRESSION_API.llm) {
        classifierRow = {
            role: translate('Classifier'),
            template: translate('Classifies new character replies via ${api} using ${promptType} (${filterAvailable}, ${translate}).'),
            tokens: {
                api: apiToken,
                promptType: promptTypeToken,
                filterAvailable: filterToken,
                translate: translateToken,
            },
        };
    } else if (api === EXPRESSION_API.webllm) {
        classifierRow = {
            role: translate('Classifier'),
            template: translate('Classifies new character replies via ${api} (${filterAvailable}, ${translate}).'),
            tokens: {
                api: apiToken,
                filterAvailable: filterToken,
                translate: translateToken,
            },
        };
    } else {
        classifierRow = {
            role: translate('Classifier'),
            template: translate('Classifies new character replies via ${api} (${translate}).'),
            tokens: {
                api: apiToken,
                translate: translateToken,
            },
        };
    }

    const fallbackToken = resolveFallbackToken(state.fallback, translate);
    const allowMultipleToken = {
        field: 'allowMultiple',
        text: allowMultiple
            ? translate('multiple sprites per expression')
            : translate('primary sprite only'),
        tone: allowMultiple ? 'active' : 'off',
    };

    const spritesRow = allowMultiple
        ? {
            role: translate('Sprites'),
            template: translate('Randomizes across ${allowMultiple} (${rerollIfSame}) with ${fallback} fallback.'),
            tokens: {
                allowMultiple: allowMultipleToken,
                rerollIfSame: {
                    field: 'rerollIfSame',
                    text: rerollIfSame
                        ? translate('avoids repeating current sprite')
                        : translate('may repeat current sprite'),
                    tone: rerollIfSame ? 'active' : 'off',
                },
                fallback: fallbackToken,
            },
        }
        : {
            role: translate('Sprites'),
            template: translate('Uses ${allowMultiple} with ${fallback} fallback.'),
            tokens: {
                allowMultiple: allowMultipleToken,
                fallback: fallbackToken,
            },
        };

    const warnings = [];
    if (api === EXPRESSION_API.llm && promptType === 'full' && translateEnabled) {
        warnings.push({
            severity: 'warn',
            template: translate('${promptType} ignores the single-message text, so ${translate} does extra work without affecting classification.'),
            tokens: {
                promptType: {
                    field: 'promptType',
                    text: translate('Full Context'),
                    tone: 'warn',
                },
                translate: {
                    field: 'translate',
                    text: translate('Translate text to English before classification'),
                    tone: 'warn',
                },
            },
        });
    }

    if (rerollIfSame && !allowMultiple) {
        warnings.push({
            severity: 'warn',
            template: translate('${rerollIfSame} is inactive while ${allowMultiple} is off — only the first sprite for each expression is used.'),
            tokens: {
                rerollIfSame: {
                    field: 'rerollIfSame',
                    text: translate('Re-roll if same sprite is used again', 'Re-roll if same expression is used again'),
                    tone: 'warn',
                },
                allowMultiple: {
                    field: 'allowMultiple',
                    text: translate('Allow multiple sprites per expression'),
                    tone: 'warn',
                },
            },
        });
    }

    if ((api === EXPRESSION_API.llm || api === EXPRESSION_API.webllm) && !hasLlmPrompt) {
        warnings.push({
            severity: 'danger',
            template: translate('${llmPrompt} is empty — expression classification will fail until a prompt is set or restored.'),
            tokens: {
                llmPrompt: {
                    field: 'llmPrompt',
                    text: translate('LLM Prompt'),
                    tone: 'danger',
                },
            },
        });
    }

    const dormantFields = [];
    if (api === EXPRESSION_API.none) {
        dormantFields.push('translate', 'filterAvailable', 'llmPrompt', 'promptType');
    } else if (api === EXPRESSION_API.local) {
        dormantFields.push('filterAvailable', 'llmPrompt', 'promptType');
    } else if (api === EXPRESSION_API.webllm) {
        dormantFields.push('promptType');
    }
    if (!allowMultiple) {
        dormantFields.push('rerollIfSame');
    }

    let tone = 'active';
    if (warnings.some((w) => w.severity === 'danger')) {
        tone = 'danger';
    } else if (warnings.length > 0) {
        tone = 'warn';
    } else if (api === EXPRESSION_API.none) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [classifierRow, spritesRow],
        warnings,
        dormantFields,
    };
}
