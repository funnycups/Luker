// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure live behavioral summary model for Completion Preset Assistant.
// No DOM dependencies.

import {
    buildBaseSystemPrompt,
    buildOrchestratorOptimizeModeBlock,
    buildJailbreakOnlyModeBlock,
} from './cpa-iteration/system-prompts.js';

const PROMPT_KEYS = Object.freeze([
    'iterBaseSystemPrompt',
    'iterModePromptOrchestratorOptimize',
    'iterModePromptJailbreakOnly',
]);

let cachedDefaults = null;

function getDefaultPrompts() {
    if (!cachedDefaults) {
        cachedDefaults = Object.freeze({
            iterBaseSystemPrompt: buildBaseSystemPrompt(),
            iterModePromptOrchestratorOptimize: buildOrchestratorOptimizeModeBlock(),
            iterModePromptJailbreakOnly: buildJailbreakOnlyModeBlock(),
        });
    }
    return cachedDefaults;
}

function defaultTranslate(text) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? '')) : String(text ?? '');
}

/**
 * Builds the 1-row behavioral summary model for Completion Preset Assistant
 * settings (default vs N/3 custom prompt overrides and Workbench Settings note).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildCpaSummaryModel(state = {}) {
    const i18n = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;
    const defaults = state.defaultPrompts || getDefaultPrompts();

    const overriddenKeys = [];
    for (const key of PROMPT_KEYS) {
        if (Object.hasOwn(state, key) && state[key] !== undefined && String(state[key]) !== String(defaults[key] ?? '')) {
            overriddenKeys.push(key);
        }
    }

    if (overriddenKeys.length === 0) {
        return {
            tone: 'active',
            rows: [{
                role: i18n('Prompts & AI'),
                template: i18n('${promptStatus} use built-in defaults — AI connection and preset are configured in Workbench → Settings.'),
                tokens: {
                    promptStatus: {
                        field: [...PROMPT_KEYS],
                        text: i18n('All 3 iteration prompts'),
                        tone: 'active',
                    },
                },
            }],
            warnings: [],
            dormantFields: [],
        };
    }

    return {
        tone: 'active',
        rows: [{
            role: i18n('Prompts & AI'),
            template: i18n('${customCount} iteration prompts use custom overrides — AI connection and preset are configured in Workbench → Settings.'),
            tokens: {
                customCount: {
                    field: overriddenKeys,
                    text: `${overriddenKeys.length}/${PROMPT_KEYS.length}`,
                    tone: 'active',
                },
            },
        }],
        warnings: [],
        dormantFields: [],
    };
}
