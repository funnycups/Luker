// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Internal default configuration table for the Completion Preset Assistant extension.
 */

import {
    buildBaseSystemPrompt,
    buildOrchestratorOptimizeModeBlock,
    buildJailbreakOnlyModeBlock,
} from './cpa-iteration/system-prompts.js';

export const MODULE_NAME = 'completion_preset_assistant';

export const DEFAULT_CPA_BASE_SYSTEM_PROMPT = buildBaseSystemPrompt();
export const DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE = buildOrchestratorOptimizeModeBlock();
export const DEFAULT_CPA_MODE_JAILBREAK_ONLY = buildJailbreakOnlyModeBlock();

export const PROMPT_DEFAULTS = Object.freeze({
    iterBaseSystemPrompt: DEFAULT_CPA_BASE_SYSTEM_PROMPT,
    iterModePromptOrchestratorOptimize: DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE,
    iterModePromptJailbreakOnly: DEFAULT_CPA_MODE_JAILBREAK_ONLY,
});

export const PROMPT_FIELDS = Object.freeze([
    Object.freeze({ key: 'iterBaseSystemPrompt', id: 'cpa_iter_base_system_prompt', label: 'Iteration base prompt' }),
    Object.freeze({ key: 'iterModePromptOrchestratorOptimize', id: 'cpa_iter_mode_orchestrator_prompt', label: 'Orchestrator optimization mode prompt' }),
    Object.freeze({ key: 'iterModePromptJailbreakOnly', id: 'cpa_iter_mode_jailbreak_prompt', label: 'Jailbreak-only mode prompt' }),
]);

export const defaultSettings = Object.freeze({
    requestLlmPresetName: '',
    requestApiPresetName: '',
    ...PROMPT_DEFAULTS,
});
