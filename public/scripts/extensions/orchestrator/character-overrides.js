/**
 * Per-character override accessors for the orchestrator.
 *
 * Characters override the global orchestration spec / agenda / loop / director
 * profile by storing their own per-mode preset libraries under
 * `character.data.extensions.orchestrator.presetLibraries.<mode>` (with the
 * active id in `activePresetIds.<mode>`). A boolean flag per mode in
 * `overrideEnabled.<mode>` decides whether the card's library is actually
 * applied or the global profile wins. A small `override` envelope persists
 * the saved execution mode for the card (`override.mode`).
 *
 * Three layers of helpers live here:
 *
 *   1. Character lookup — `getCharacterByAvatar`, `getCharacterIndexByAvatar`,
 *      `getCharacterDisplayName`, `getCharacterDisplayNameByAvatar`.
 *   2. Override read accessors — `getCharacterExtensionDataByAvatar`,
 *      `getCharacterOverrideByAvatar`, `getCharacterAgendaOverrideByAvatar`,
 *      `getCharacterLoopOverrideByAvatar`, `getCharacterDirectorOverrideByAvatar`,
 *      `hasCharacterSpecOverride`, `hasCharacterAgendaOverride`,
 *      `hasCharacterLoopOverride`, `hasCharacterDirectorOverride`,
 *      `hasCharacterOverride`, `hasCharacterSpecPresetLibrary`,
 *      `hasCharacterAgendaPresetLibrary`, `hasCharacterLoopPresetLibrary`,
 *      `hasCharacterDirectorPresetLibrary`, `getCharacterCardSnapshot`.
 *      The four per-mode `getCharacter*OverrideByAvatar` accessors return
 *      a lightweight `{ mode, enabled }` view stitched together from the
 *      `overrideEnabled[mode]` flag — they exist for UI render paths that
 *      only need the enabled bit, not the full preset payload. The two
 *      predicate families are NOT interchangeable: `has*Override` means
 *      "actively applied right now" (library + toggle on), while
 *      `has*PresetLibrary` means "library saved on card regardless of
 *      toggle" and is only for UI plumbing that must keep working while
 *      the toggle is off (the toggle itself, the "configured, currently
 *      disabled" label branch, the profile-title renderer).
 *   3. Execution-mode resolution — `normalizeExecutionMode`,
 *      `getExecutionMode`, `getCharacterSavedExecutionModeByAvatar`,
 *      `applyCharacterExecutionModeForAvatar`. The card pins the saved
 *      mode via `override.mode`; the dispatcher reads global
 *      `extension_settings.orchestrator.executionMode` and is realigned
 *      to that pinned mode whenever the card becomes active.
 *
 * Writers (`persist*Editor`, character-extension write paths) stay in
 * the editor-state layer and main.js since they wire into save / event
 * dispatch flows.
 */

const __ctx = Luker.getContext();
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
import { migrateAndPersistLegacyCardOverrideForMode } from './preset-library.js';

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

function readOverrideEnabledFlag(ext, mode) {
    const flags = ext?.overrideEnabled;
    if (!flags || typeof flags !== 'object') return false;
    return Boolean(flags[mode]);
}

/**
 * Light `{ mode, enabled }` view of a card's override for one mode. UI
 * render paths only need the enabled bit; the full preset payload is
 * read separately through the preset-library accessors. Returns null
 * when the card has no library for this mode.
 */
function makeOverrideView(context, avatar, mode) {
    if (!cardHasPresetLibraryForMode(context, avatar, mode)) return null;
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    return { mode, enabled: readOverrideEnabledFlag(ext, mode) };
}

export function getCharacterOverrideByAvatar(context, avatar) {
    return makeOverrideView(context, avatar, ORCH_EXECUTION_MODE_SPEC);
}

export function getCharacterAgendaOverrideByAvatar(context, avatar) {
    return makeOverrideView(context, avatar, ORCH_EXECUTION_MODE_AGENDA);
}

export function getCharacterLoopOverrideByAvatar(context, avatar) {
    return makeOverrideView(context, avatar, ORCH_EXECUTION_MODE_LOOP);
}

export function getCharacterDirectorOverrideByAvatar(context, avatar) {
    return makeOverrideView(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR);
}

export function getCharacterSavedExecutionModeByAvatar(context, avatar) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const pinned = normalizeExecutionMode(ext?.override?.mode);
    if (pinned && cardHasPresetLibraryForMode(context, avatar, pinned)) {
        return pinned;
    }
    for (const mode of ORCH_EXECUTION_MODES) {
        if (mode === ORCH_EXECUTION_MODE_SINGLE) continue;
        if (cardHasPresetLibraryForMode(context, avatar, mode)) return mode;
    }
    return '';
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

/**
 * Two override predicates per mode:
 *
 *   `hasCharacter<Mode>Override`         — "the card's override is
 *       actively taking effect right now". True iff the library exists
 *       AND the per-mode `overrideEnabled` flag is on. This is the
 *       predicate for anything that decides which profile/scope to use
 *       (displayed scope, runtime skill filter, iter-studio's exposed
 *       reset tool, etc.) — the toggle-off state must be indistinguishable
 *       from "no override at all".
 *
 *   `hasCharacter<Mode>PresetLibrary`    — "the card has a saved
 *       library for this mode regardless of the toggle". This is the
 *       predicate for UI plumbing that must keep working while the
 *       toggle is off: the override toggle itself needs to stay
 *       visible so the user can re-enable, the "configured, currently
 *       disabled" chip label branch fires here, and the profile-title
 *       renderer treats it as a persisted (not draft) card override.
 *
 * Callers must not confuse the two: mistaking library-presence for
 * "active" is exactly the bug that made toggle-off refresh only the
 * preset dropdown while the workspace, active preset, and skill scope
 * silently stayed pinned to the card.
 */
export function hasCharacterSpecOverride(context, avatar) {
    return isCharacterPresetActiveOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_SPEC);
}

export function hasCharacterAgendaOverride(context, avatar) {
    return isCharacterPresetActiveOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_AGENDA);
}

export function hasCharacterLoopOverride(context, avatar) {
    return isCharacterPresetActiveOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_LOOP);
}

export function hasCharacterDirectorOverride(context, avatar) {
    return isCharacterPresetActiveOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR);
}

export function hasCharacterOverride(context, avatar) {
    return hasCharacterSpecOverride(context, avatar);
}

export function hasCharacterSpecPresetLibrary(context, avatar) {
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_SPEC);
}

export function hasCharacterAgendaPresetLibrary(context, avatar) {
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_AGENDA);
}

export function hasCharacterLoopPresetLibrary(context, avatar) {
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_LOOP);
}

export function hasCharacterDirectorPresetLibrary(context, avatar) {
    return cardHasPresetLibraryForMode(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR);
}

/**
 * Per-character preset library for one mode. Returns the `{ [presetId]:
 * presetEntry }` map from `presetLibraries.<mode>`, or `{}` when the
 * card has none. Writers go through editor-persist.js.
 */
export function getCharacterPresetLibrary(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const lib = ext.presetLibraries?.[mode];
    if (lib && typeof lib === 'object' && Object.keys(lib).length > 0) {
        return lib;
    }
    return {};
}

export function getCharacterActivePresetId(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const fromNew = ext.activePresetIds?.[mode];
    if (fromNew && ext.presetLibraries?.[mode]?.[fromNew]) return String(fromNew);
    const lib = getCharacterPresetLibrary(context, avatar, mode);
    const firstKey = Object.keys(lib)[0];
    return firstKey || '';
}

/**
 * True when the card's preset library for this mode should override the
 * global active preset. Requires both (a) a `presetLibraries.<mode>`
 * entry exists, and (b) `overrideEnabled.<mode>` is true.
 *
 * Cards freshly imported under the legacy `override.<mode>` shape (no
 * preset library, no `overrideEnabled` container) are migrated in place
 * on first read so the probe and the downstream `getActivePreset` call
 * both see the new shape. Without this, the runtime gate in
 * `getEffectiveProfile` would short-circuit before the lazy migration
 * inside `getActivePreset(scope:'character')` ever runs.
 */
export function isCharacterPresetActiveOverrideEnabled(context, avatar, mode) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    if (hasLegacyOverridePayload(ext, mode)) {
        migrateAndPersistLegacyCardOverrideForMode(context, avatar, mode);
    }
    if (!readOverrideEnabledFlag(ext, mode)) return false;
    const id = getCharacterActivePresetId(context, avatar, mode);
    if (!id) return false;
    const lib = getCharacterPresetLibrary(context, avatar, mode);
    return Boolean(lib[id]);
}

function hasLegacyOverridePayload(ext, mode) {
    const override = ext?.override;
    if (!override || typeof override !== 'object') return false;
    if (mode === ORCH_EXECUTION_MODE_SPEC) {
        return Boolean(
            (override.spec && typeof override.spec === 'object')
            || (override.presets && typeof override.presets === 'object')
            || (override.presetPatch && typeof override.presetPatch === 'object')
            || typeof override.enabled === 'boolean',
        );
    }
    const sub = override[mode];
    return Boolean(sub && typeof sub === 'object');
}

/**
 * Compute the next character-extension payload after a "Clear Character
 * Override" click for the given execution mode. Strips
 * `presetLibraries.<mode>`, `activePresetIds.<mode>`, and the
 * `overrideEnabled.<mode>` flag, dropping empty containers so the
 * `hasCharacter*Override` probe reads false afterwards. Also drops the
 * `override.mode` pin when it was pointing at the cleared mode so the
 * dispatcher does not keep that mode active after the data is gone.
 * Pure (no I/O) so it can be unit-tested independent of the click
 * handler — main.js wires this into the persistence + UI reload path.
 */
export function clearCharacterExtensionForMode(previous, mode) {
    const previousExt = previous && typeof previous === 'object' ? previous : {};
    const normalizedMode = normalizeExecutionMode(mode);
    const next = { ...previousExt };
    const nextLibraries = previousExt.presetLibraries && typeof previousExt.presetLibraries === 'object'
        ? structuredClone(previousExt.presetLibraries)
        : null;
    const nextActiveIds = previousExt.activePresetIds && typeof previousExt.activePresetIds === 'object'
        ? structuredClone(previousExt.activePresetIds)
        : null;
    const nextEnabledFlags = previousExt.overrideEnabled && typeof previousExt.overrideEnabled === 'object'
        ? structuredClone(previousExt.overrideEnabled)
        : null;
    if (nextLibraries) delete nextLibraries[normalizedMode];
    if (nextActiveIds) delete nextActiveIds[normalizedMode];
    if (nextEnabledFlags) delete nextEnabledFlags[normalizedMode];

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
    const enabledFlagsStillPopulated = nextEnabledFlags && Object.keys(nextEnabledFlags).some(key => nextEnabledFlags[key]);
    if (enabledFlagsStillPopulated) {
        next.overrideEnabled = nextEnabledFlags;
    } else {
        delete next.overrideEnabled;
    }

    const previousOverride = previousExt.override && typeof previousExt.override === 'object'
        ? previousExt.override
        : null;
    if (previousOverride) {
        const previousPinnedMode = normalizeExecutionMode(previousOverride.mode);
        if (previousPinnedMode === normalizedMode) {
            // The pin pointed at the mode we just cleared. Re-anchor to
            // whichever library still has data, or drop the envelope.
            let nextPinnedMode = '';
            for (const candidate of ORCH_EXECUTION_MODES) {
                if (candidate === ORCH_EXECUTION_MODE_SINGLE) continue;
                if (next.presetLibraries?.[candidate]) {
                    nextPinnedMode = candidate;
                    break;
                }
            }
            if (nextPinnedMode) {
                next.override = { ...previousOverride, mode: nextPinnedMode };
            } else {
                delete next.override;
            }
        } else {
            next.override = previousOverride;
        }
    } else {
        delete next.override;
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
