/**
 * Per-character override accessors for the orchestrator.
 *
 * Characters can override the global orchestration spec / agenda / loop
 * profile / preset map by writing under
 * `character.data.extensions.orchestrator.override`. This module owns
 * the read-side helpers for those overrides plus the execution-mode
 * resolution that decides which override branch (`spec` vs `agenda`
 * vs `loop`) is active for a given character.
 *
 * Three layers of helpers live here:
 *
 *   1. Character lookup — `getCharacterByAvatar`, `getCharacterIndexByAvatar`,
 *      `getCharacterDisplayName`, `getCharacterDisplayNameByAvatar`.
 *   2. Override read accessors — `getCharacterExtensionDataByAvatar`,
 *      `getCharacterOverrideByAvatar`, `getCharacterAgendaOverrideByAvatar`,
 *      `getCharacterLoopOverrideByAvatar`,
 *      `hasSpecOverrideData`, `hasAgendaOverrideData`, `hasLoopOverrideData`,
 *      `hasCharacterSpecOverride`, `hasCharacterAgendaOverride`,
 *      `hasCharacterLoopOverride`, `hasCharacterOverride`,
 *      `getCharacterCardSnapshot`.
 *   3. Execution-mode resolution — `normalizeExecutionMode`,
 *      `getExecutionMode`, `getCharacterOverrideExecutionMode`,
 *      `normalizeCharacterOverrideMode`, `getCharacterSavedExecutionModeByAvatar`,
 *      `applyCharacterExecutionModeForAvatar`. The character override can
 *      pin a mode (`override.mode = 'spec' | 'agenda' | 'loop'`); if absent
 *      the mode is inferred from which sub-payload is present, falling
 *      back to whichever updatedAt is newer when multiple are present.
 *
 * Writers (`persist*Editor`, character-extension write paths) stay in
 * the editor-state layer and main.js since they wire into save / event
 * dispatch flows.
 */

const __ctx = SillyTavern.getContext();
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
import {
    ORCH_EXECUTION_MODES,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SINGLE,
    ORCH_EXECUTION_MODE_SPEC,
} from './defaults.js';
import { i18n } from './i18n.js';
import { getCurrentAvatar } from './snapshot-cache.js';

const MODULE_NAME = 'orchestrator';

export function normalizeExecutionMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ORCH_EXECUTION_MODES.includes(normalized) ? normalized : ORCH_EXECUTION_MODE_SPEC;
}

export function getExecutionMode(settings = extension_settings[MODULE_NAME]) {
    return normalizeExecutionMode(settings?.executionMode);
}

export function getCharacterDisplayName(context) {
    return getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context)) || i18n('(No character selected)');
}

export function getCharacterDisplayNameByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return '';
    }
    const character = (context.characters || []).find(item => String(item?.avatar || '') === target);
    return String(character?.name || '').trim() || target;
}

export function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return null;
    }
    return (context.characters || []).find(char => String(char?.avatar || '') === target) || null;
}

export function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return -1;
    }
    return (context.characters || []).findIndex(char => String(char?.avatar || '') === target);
}

export function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

export function getCharacterOverrideByAvatar(context, avatar) {
    const payload = getCharacterExtensionDataByAvatar(context, avatar);
    const override = payload?.override;
    return override && typeof override === 'object' ? override : null;
}

export function getCharacterAgendaOverrideByAvatar(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    const agenda = override?.agenda;
    return agenda && typeof agenda === 'object' ? agenda : null;
}

export function getCharacterLoopOverrideByAvatar(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    const loop = override?.loop;
    return loop && typeof loop === 'object' ? loop : null;
}

export function getCharacterDirectorOverrideByAvatar(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    const director = override?.director;
    return director && typeof director === 'object' ? director : null;
}

export function hasSpecOverrideData(override) {
    return Boolean(override && (
        (override.spec && typeof override.spec === 'object')
        || (override.presets && typeof override.presets === 'object')
        || (override.presetPatch && typeof override.presetPatch === 'object')
    ));
}

export function hasAgendaOverrideData(override) {
    return Boolean(override?.agenda && typeof override.agenda === 'object');
}

export function hasLoopOverrideData(override) {
    return Boolean(override?.loop && typeof override.loop === 'object');
}

export function hasDirectorOverrideData(override) {
    return Boolean(override?.director && typeof override.director === 'object');
}

export function getCharacterOverrideExecutionMode(override) {
    if (!override || typeof override !== 'object') {
        return '';
    }
    const explicitMode = normalizeExecutionMode(override.mode);
    const hasSpec = hasSpecOverrideData(override);
    const hasAgenda = hasAgendaOverrideData(override);
    const hasLoop = hasLoopOverrideData(override);
    const hasDirector = hasDirectorOverrideData(override);
    if (explicitMode === ORCH_EXECUTION_MODE_SPEC && hasSpec) {
        return explicitMode;
    }
    if (explicitMode === ORCH_EXECUTION_MODE_AGENDA && hasAgenda) {
        return explicitMode;
    }
    if (explicitMode === ORCH_EXECUTION_MODE_LOOP && hasLoop) {
        return explicitMode;
    }
    if (explicitMode === ORCH_EXECUTION_MODE_DIRECTOR && hasDirector) {
        return explicitMode;
    }
    const presentBranches = [
        hasSpec ? ORCH_EXECUTION_MODE_SPEC : null,
        hasAgenda ? ORCH_EXECUTION_MODE_AGENDA : null,
        hasLoop ? ORCH_EXECUTION_MODE_LOOP : null,
        hasDirector ? ORCH_EXECUTION_MODE_DIRECTOR : null,
    ].filter(Boolean);
    if (presentBranches.length === 1) {
        return presentBranches[0];
    }
    if (presentBranches.length > 1) {
        // Pick the most recently updated branch. `override.updatedAt` is
        // owned by the spec branch (legacy convention). Agenda + loop +
        // director each store their own `updatedAt` on the sub-payload.
        const candidates = [];
        if (hasSpec) {
            candidates.push({
                mode: ORCH_EXECUTION_MODE_SPEC,
                updatedAt: Math.max(0, Number(override.updatedAt) || 0),
            });
        }
        if (hasAgenda) {
            candidates.push({
                mode: ORCH_EXECUTION_MODE_AGENDA,
                updatedAt: Math.max(0, Number(override.agenda?.updatedAt) || 0),
            });
        }
        if (hasLoop) {
            candidates.push({
                mode: ORCH_EXECUTION_MODE_LOOP,
                updatedAt: Math.max(0, Number(override.loop?.updatedAt) || 0),
            });
        }
        if (hasDirector) {
            candidates.push({
                mode: ORCH_EXECUTION_MODE_DIRECTOR,
                updatedAt: Math.max(0, Number(override.director?.updatedAt) || 0),
            });
        }
        candidates.sort((left, right) => right.updatedAt - left.updatedAt);
        const top = candidates[0];
        const second = candidates[1];
        if (top && (!second || top.updatedAt > second.updatedAt)) {
            return top.mode;
        }
    }
    return '';
}

export function normalizeCharacterOverrideMode(override) {
    if (!override || typeof override !== 'object') {
        return override;
    }
    const mode = getCharacterOverrideExecutionMode(override);
    if (mode) {
        override.mode = mode;
    } else {
        delete override.mode;
    }
    return override;
}

export function getCharacterSavedExecutionModeByAvatar(context, avatar) {
    return getCharacterOverrideExecutionMode(getCharacterOverrideByAvatar(context, avatar));
}

export function applyCharacterExecutionModeForAvatar(context, settings, avatar) {
    const preferredMode = getCharacterSavedExecutionModeByAvatar(context, avatar);
    if (!preferredMode || preferredMode === getExecutionMode(settings)) {
        return false;
    }
    settings.executionMode = preferredMode;
    settings.singleAgentModeEnabled = preferredMode === ORCH_EXECUTION_MODE_SINGLE;
    saveSettingsDebounced();
    return true;
}

function cardHasPresetLibraryForMode(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const lib = ext.presetLibraries?.[mode];
    return Boolean(lib && typeof lib === 'object' && Object.keys(lib).length > 0);
}

export function hasCharacterSpecOverride(context, avatar) {
    const override = getCharacterOverrideByAvatar(context, avatar);
    if (hasSpecOverrideData(override)) return true;
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_SPEC);
}

export function hasCharacterAgendaOverride(context, avatar) {
    if (hasAgendaOverrideData(getCharacterOverrideByAvatar(context, avatar))) return true;
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_AGENDA);
}

export function hasCharacterLoopOverride(context, avatar) {
    if (hasLoopOverrideData(getCharacterOverrideByAvatar(context, avatar))) return true;
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_LOOP);
}

export function hasCharacterDirectorOverride(context, avatar) {
    if (hasDirectorOverrideData(getCharacterOverrideByAvatar(context, avatar))) return true;
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR);
}

export function hasCharacterOverride(context, avatar) {
    return hasCharacterSpecOverride(context, avatar);
}

/**
 * Dual-shape read accessor. Returns a `{ [presetId]: presetEntry }` map
 * for the given character + mode:
 *
 *   1. New shape: `presetLibraries.<mode>` exists on the card → return it.
 *   2. Legacy shape: `override.<mode>` (or override.spec/presets) exists →
 *      synthesize a one-entry library `{ default: { name: 'Default', ...legacyPayload } }`.
 *   3. Neither → empty `{}`.
 *
 * Read-only. Writers go through editor-persist.js which always emits the
 * new shape and drops legacy keys in the same payload.
 */
export function getCharacterPresetLibrary(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const newLib = ext.presetLibraries?.[mode];
    if (newLib && typeof newLib === 'object' && Object.keys(newLib).length > 0) {
        return newLib;
    }
    // Legacy fall-back
    const override = ext.override || {};
    if (mode === ORCH_EXECUTION_MODE_SPEC) {
        if (override.spec || override.presets) {
            return { default: { name: 'Default', spec: override.spec, presets: override.presets } };
        }
    } else if (override[mode] && typeof override[mode] === 'object') {
        return { default: { name: 'Default', ...override[mode] } };
    }
    return {};
}

export function getCharacterActivePresetId(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const fromNew = ext.activePresetIds?.[mode];
    if (fromNew && ext.presetLibraries?.[mode]?.[fromNew]) return String(fromNew);
    // Legacy: if a legacy override exists for this mode, return 'default' (the synthetic id).
    const lib = getCharacterPresetLibrary(context, avatar, mode);
    if (lib.default) return 'default';
    const firstKey = Object.keys(lib)[0];
    return firstKey || '';
}

/**
 * True when the card's preset library for this mode should override the
 * global active preset. Reads `override.enabled` for back-compat
 * (existing tooling already toggles this) and also requires the card
 * library to actually have a usable entry.
 */
export function isCharacterPresetActiveOverrideEnabled(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    if (!ext.override?.enabled) {
        // Also accept per-mode legacy flags
        if (mode === ORCH_EXECUTION_MODE_SPEC && !ext.override?.enabled) return false;
        if (mode !== ORCH_EXECUTION_MODE_SPEC && !ext.override?.[mode]?.enabled) return false;
    }
    const id = getCharacterActivePresetId(context, avatar, mode);
    if (!id) return false;
    const lib = getCharacterPresetLibrary(context, avatar, mode);
    return Boolean(lib[id]);
}

/**
 * Compute the next character-extension payload after a "Clear Character
 * Override" click for the given execution mode.
 *
 * Strips both the legacy `override.<mode>` field AND the new-shape
 * `presetLibraries.<mode>` / `activePresetIds.<mode>` slots, then drops
 * empty containers so `hasCharacter*Override` reads false afterwards.
 * Pure (no I/O) so it can be unit-tested independent of the click
 * handler — main.js wires this into the persistence + UI reload path.
 */
export function clearCharacterExtensionForMode(previous, mode) {
    const previousExt = previous && typeof previous === 'object' ? previous : {};
    const normalizedMode = normalizeExecutionMode(mode);
    const next = { ...previousExt };
    const nextOverride = previousExt.override && typeof previousExt.override === 'object'
        ? structuredClone(previousExt.override)
        : null;
    const nextLibraries = previousExt.presetLibraries && typeof previousExt.presetLibraries === 'object'
        ? structuredClone(previousExt.presetLibraries)
        : null;
    const nextActiveIds = previousExt.activePresetIds && typeof previousExt.activePresetIds === 'object'
        ? structuredClone(previousExt.activePresetIds)
        : null;
    if (normalizedMode === ORCH_EXECUTION_MODE_LOOP) {
        if (nextOverride) delete nextOverride.loop;
    } else if (normalizedMode === ORCH_EXECUTION_MODE_AGENDA) {
        if (nextOverride) delete nextOverride.agenda;
    } else if (normalizedMode === ORCH_EXECUTION_MODE_DIRECTOR) {
        if (nextOverride) delete nextOverride.director;
    } else if (nextOverride) {
        delete nextOverride.spec;
        delete nextOverride.presets;
        delete nextOverride.presetPatch;
        delete nextOverride.enabled;
        delete nextOverride.updatedAt;
        delete nextOverride.name;
        delete nextOverride.notes;
    }
    if (nextLibraries) {
        delete nextLibraries[normalizedMode];
    }
    if (nextActiveIds) {
        delete nextActiveIds[normalizedMode];
    }
    normalizeCharacterOverrideMode(nextOverride);
    const overrideStillHasPayload = nextOverride && (
        (nextOverride.spec && typeof nextOverride.spec === 'object')
        || (nextOverride.presets && typeof nextOverride.presets === 'object')
        || (nextOverride.presetPatch && typeof nextOverride.presetPatch === 'object')
        || (nextOverride.agenda && typeof nextOverride.agenda === 'object')
        || (nextOverride.loop && typeof nextOverride.loop === 'object')
        || (nextOverride.director && typeof nextOverride.director === 'object')
    );
    if (overrideStillHasPayload) {
        next.override = nextOverride;
    } else {
        delete next.override;
    }
    const librariesStillPopulated = nextLibraries && Object.keys(nextLibraries).some(key =>
        nextLibraries[key] && typeof nextLibraries[key] === 'object' && Object.keys(nextLibraries[key]).length > 0,
    );
    if (librariesStillPopulated) {
        next.presetLibraries = nextLibraries;
    } else {
        delete next.presetLibraries;
    }
    const activeIdsStillPopulated = nextActiveIds && Object.keys(nextActiveIds).some(key => nextActiveIds[key]);
    if (activeIdsStillPopulated) {
        next.activePresetIds = nextActiveIds;
    } else {
        delete next.activePresetIds;
    }
    return next;
}

export function getCharacterCardSnapshot(context, avatar) {
    const character = getCharacterByAvatar(context, avatar) || {};
    const fromCardFields = (avatar && avatar === getCurrentAvatar(context) && typeof context.getCharacterCardFields === 'function')
        ? (context.getCharacterCardFields() || {})
        : {};

    const readField = (field) => {
        const value = character?.[field]
            ?? character?.data?.[field]
            ?? fromCardFields?.[field];
        return String(value || '').trim();
    };

    return {
        avatar: String(avatar || ''),
        name: String(character?.name || fromCardFields?.name || '').trim(),
        description: readField('description'),
        personality: readField('personality'),
        scenario: readField('scenario'),
        system: readField('system'),
        first_mes: readField('first_mes'),
        mes_example: readField('mes_example'),
        creator_notes: readField('creator_notes'),
    };
}
