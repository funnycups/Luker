/**
 * Read-only editor display helpers.
 *
 * Functions that consult `uiState` (and DOM `data-scope` attributes) to
 * answer the questions the editor panel rendering paths repeatedly ask:
 *   - "Which editor draft should we render right now?" — `getEditorByScope`,
 *     `getAgendaEditorByScope`
 *   - "Which scope is the user currently looking at?" —
 *     `getDisplayedScopeForMode`, `getDisplayedScope`
 *   - "Which scope did this DOM element originate from?" —
 *     `getScopeFromElementOrMode`, `getAgendaScopeFromElement`,
 *     `getExplicitScopeFromElement`, `getCopyScopeFromElement`
 *   - "What label do we put in the panel header / popup title?" —
 *     `getDisplayedScopeLabel`, `getPopupEditingLabel`,
 *     `getProfileTitleForScope`
 *
 * These helpers never mutate state. State mutation (loaders + scope
 * writes) lives in `editor-state.js`; persist + portable-profile creation
 * lives in `editor-persist.js`.
 */

import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_SPEC,
} from './defaults.js';
import {
    getCharacterDisplayNameByAvatar,
    getExecutionMode,
} from './character-overrides.js';
import { getCurrentAvatar } from './snapshot-cache.js';
import { i18n, i18nFormat } from './i18n.js';
import {
    getScopePreferenceStateKey,
    getStoredDisplayedScopeForMode,
    uiState,
} from './editor-state.js';

export function getDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const key = getScopePreferenceStateKey(mode);
    const preferredScope = String(uiState[key] || '');
    const storedScope = getStoredDisplayedScopeForMode(context, settings, mode);
    if (storedScope === 'character') {
        return 'character';
    }
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (preferredScope === 'character' && activeAvatar) {
        return 'character';
    }
    return 'global';
}

export function getDisplayedScope(context, settings) {
    return getDisplayedScopeForMode(context, settings, getExecutionMode(settings));
}

export function getIterationDefaultScope(context) {
    return String(getCurrentAvatar(context) || '').trim() ? 'character' : 'global';
}

export function getEditorByScope(scope) {
    return scope === 'character' ? uiState.characterEditor : uiState.globalEditor;
}

export function getAgendaEditorByScope(scope) {
    return scope === 'character' ? uiState.characterAgendaEditor : uiState.globalAgendaEditor;
}

export function getScopeFromElementOrMode(element, context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const scope = String(
        jQuery(element).data('scope')
        || jQuery(element).closest('[data-luker-scope-root]').data('luker-scope-root')
        || getDisplayedScopeForMode(context, settings, mode),
    );
    return scope === 'character' ? 'character' : 'global';
}

export function getAgendaScopeFromElement(element, context, settings) {
    return getScopeFromElementOrMode(element, context, settings, ORCH_EXECUTION_MODE_AGENDA);
}

export function getExplicitScopeFromElement(element) {
    const scope = String(
        jQuery(element).data('scope')
        || jQuery(element).closest('[data-luker-scope-root]').data('luker-scope-root')
        || '',
    );
    return scope === 'character' ? 'character' : (scope === 'global' ? 'global' : '');
}

export function getCopyScopeFromElement(element, context) {
    const explicitScope = getExplicitScopeFromElement(element);
    if (explicitScope) {
        return explicitScope;
    }
    return String(getCurrentAvatar(context) || '').trim() ? 'character' : 'global';
}

export function getDisplayedScopeLabel(isCharacterScope, hasPersistedOverride, isEnabled) {
    if (!isCharacterScope) {
        return i18n('Global profile (no character override for current card)');
    }
    if (!hasPersistedOverride) {
        return i18n('Character draft (not saved yet)');
    }
    return isEnabled
        ? i18n('Character override (enabled)')
        : i18n('Character override (configured, currently disabled)');
}

export function getPopupEditingLabel(isCharacterScope, hasPersistedOverride, isEnabled) {
    if (!isCharacterScope) {
        return i18n('Global profile');
    }
    if (!hasPersistedOverride) {
        return i18n('Character draft (not saved yet)');
    }
    return isEnabled
        ? i18n('Current character override')
        : i18n('Character override (configured, currently disabled)');
}

export function getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasPersistedOverride) {
    if (!isCharacterScope) {
        return i18n('Global Orchestration Profile');
    }
    const displayName = getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar;
    return hasPersistedOverride
        ? i18nFormat('Character Override: ${0}', displayName)
        : i18nFormat('Character Draft: ${0}', displayName);
}
