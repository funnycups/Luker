/**
 * Template-variable helpers for orchestrator user/system prompts.
 *
 * Pure string transforms — no chat-state, no `extension_settings`, no
 * I/O. Owns the operations every caller needs against the
 * mustache-style `{{var}}` syntax used in node prompt templates:
 *
 *   - `replaceAutoInjectedTemplatePlaceholders`: collapse the
 *     `{{previous_orchestration}}` placeholder so it cannot leak back
 *     into a runtime prompt; the runtime injects that content out-of-band.
 *   - `replaceLegacyRemovedTemplatePlaceholders`: strip the obsolete
 *     `{{previous_snapshot}}` placeholder cleanly, in case a stored
 *     template still mentions it.
 *   - `normalizeTemplateForRuntime` / `normalizeTemplateForAiPrompt`:
 *     thin wrappers that combine both replacements with a context-
 *     appropriate replacement string (a runtime note vs. an
 *     AI-author-facing note).
 *
 * `renderTemplate` is the final substitution pass that fills in the
 * concrete user-visible variables (recent_chat, last_user, etc.). It
 * accepts both the new `previous_orchestration` and the legacy
 * `previous_snapshot` so older saved sessions still render.
 */

import {
    AUTO_INJECTED_PLACEHOLDER_AI_NOTE,
    AUTO_INJECTED_PLACEHOLDER_REGEX,
    AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
    LEGACY_REMOVED_PLACEHOLDER_REGEX,
} from './defaults.js';

function replaceAutoInjectedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(AUTO_INJECTED_PLACEHOLDER_REGEX, String(replacement || ''));
}

function replaceLegacyRemovedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(LEGACY_REMOVED_PLACEHOLDER_REGEX, String(replacement || ''));
}

export function normalizeTemplateForRuntime(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

export function normalizeTemplateForAiPrompt(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_AI_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

export function renderTemplate(template, vars) {
    const safeVars = vars && typeof vars === 'object' ? vars : {};
    const replacements = {
        recent_chat: String(safeVars.recent_chat || ''),
        last_user: String(safeVars.last_user || ''),
        previous_outputs: String(safeVars.previous_outputs || ''),
        distiller: String(safeVars.distiller || ''),
        previous_snapshot: String(safeVars.previous_snapshot || ''),
        previous_orchestration: String(safeVars.previous_orchestration || ''),
    };
    let output = String(template || '');
    for (const [key, value] of Object.entries(replacements)) {
        output = output.replaceAll(`{{${key}}}`, value);
    }
    return output;
}
