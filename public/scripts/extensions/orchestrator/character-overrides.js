/**
 * Per-character preset state accessors for the orchestrator.
 *
 * Characters override the global orchestration spec / agenda / loop / director
 * profile by storing their own per-mode preset libraries under
 * `character.data.extensions.orchestrator.presetLibraries.<mode>` (with the
 * active id in `activePresetIds.<mode>`). Under the single-scope model the
 * active slot alone decides what runs: a non-empty slot pointing at a real
 * library entry means the card library is applied; an empty slot (or a
 * missing container) means the global active preset wins. A small
 * `override` envelope persists the saved execution mode for the card
 * (`override.mode`).
 *
 * Three layers of helpers live here:
 *
 *   1. Character lookup — `getCharacterByAvatar`, `getCharacterIndexByAvatar`,
 *      `getCharacterDisplayName`, `getCharacterDisplayNameByAvatar`.
 *   2. Preset state reads — `getCharacterExtensionDataByAvatar`,
 *      `getCharacterActivePresetId`, `getRuntimePresetScope`,
 *      `hasCharacterSpecOverride`, `hasCharacterAgendaOverride`,
 *      `hasCharacterLoopOverride`, `hasCharacterDirectorOverride`,
 *      `hasCharacterOverride`, `hasCharacterSpecPresetLibrary`,
 *      `hasCharacterAgendaPresetLibrary`, `hasCharacterLoopPresetLibrary`,
 *      `hasCharacterDirectorPresetLibrary`, `getCharacterCardSnapshot`.
 *      The two predicate families are NOT interchangeable: `has*Override`
 *      means "the card library runs for this mode right now" (active slot
 *      non-empty), while `has*PresetLibrary` means "a library is saved on
 *      the card regardless of which preset is active" and is only for UI
 *      plumbing (library visibility, profile-title rendering, the saved
 *      execution-mode pin walk).
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
 * Two per-mode predicates:
 *
 *   `hasCharacter<Mode>Override`         — "the card's preset is
 *       actively taking effect right now". True iff the card's active
 *       slot is non-empty (single-scope model). This is the predicate
 *       for anything that decides which profile/scope to use (displayed
 *       scope, runtime skill filter, iter-studio's exposed reset tool,
 *       etc.).
 *
 *   `hasCharacter<Mode>PresetLibrary`    — "the card has a saved
 *       library for this mode". This is the predicate for UI plumbing
 *       that must keep working even while the runtime runs the global
 *       preset: chip labels keep showing the card's saved preset, and
 *       the profile-title renderer treats it as a persisted (not draft)
 *       card override.
 *
 * Callers must not confuse the two: mistaking library-presence for
 * "active" is exactly the bug that made toggle-off refresh only the
 * preset dropdown while the workspace, active preset, and skill scope
 * silently stayed pinned to the card.
 */
export function hasCharacterSpecOverride(context, avatar) {
    return getRuntimePresetScope(context, avatar, ORCH_EXECUTION_MODE_SPEC) === 'character';
}

export function hasCharacterAgendaOverride(context, avatar) {
    return getRuntimePresetScope(context, avatar, ORCH_EXECUTION_MODE_AGENDA) === 'character';
}

export function hasCharacterLoopOverride(context, avatar) {
    return getRuntimePresetScope(context, avatar, ORCH_EXECUTION_MODE_LOOP) === 'character';
}

export function hasCharacterDirectorOverride(context, avatar) {
    return getRuntimePresetScope(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR) === 'character';
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
    // Single-scope model: read the card's own active slot strictly. No
    // first-key fallback — an empty slot is the explicit "run the global
    // active preset" state, and resurrecting the first library entry
    // here would override that choice on every read.
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const id = ext.activePresetIds?.[mode];
    if (id && ext.presetLibraries?.[mode]?.[id]) return String(id);
    return '';
}

/**
 * One-time migration: consume the legacy `overrideEnabled.<mode>` flags
 * and settle each mode's active slot accordingly, then drop the flag
 * field entirely.
 *
 * - `true` keeps the slot (filling it with the library's first key when
 *   empty, preserving the "override was on" intent).
 * - `false` clears the slot (the card falls back to the global active).
 *
 * Returns true when the card was mutated, so callers can persist.
 */
export function migrateCardOverrideEnabledFlags(context, avatar) {
    const ext = getCharacterExtensionDataByAvatar(context, avatar) || {};
    const flags = ext?.overrideEnabled;
    if (!flags || typeof flags !== 'object') return false;
    if (!ext.activePresetIds || typeof ext.activePresetIds !== 'object') {
        ext.activePresetIds = { spec: '', agenda: '', loop: '', director: '' };
    }
    for (const mode of ['spec', 'agenda', 'loop', 'director']) {
        if (typeof flags[mode] !== 'boolean') continue;
        if (flags[mode]) {
            const lib = ext.presetLibraries?.[mode];
            if (!ext.activePresetIds[mode] && lib && Object.keys(lib).length > 0) {
                ext.activePresetIds[mode] = Object.keys(lib)[0];
            }
        } else {
            ext.activePresetIds[mode] = '';
        }
    }
    delete ext.overrideEnabled;
    return true;
}

/**
 * Which library runs for this (avatar, mode) under the single-scope
 * model: the card's active slot when it holds a real preset id, else
 * the global active. Runs both lazy migrations first so freshly
 * imported legacy cards settle before the read.
 */
export function getRuntimePresetScope(context, avatar, mode) {
    const safeAvatar = String(avatar || '').trim();
    if (!safeAvatar) return 'global';
    // Flag migration runs FIRST: an explicit new-shape `overrideEnabled`
    // flag wins over the legacy `override.<mode>` payload. Running the
    // legacy migration first would let a stale legacy `enabled:true`
    // re-seed the flag container after the user's explicit `false` was
    // consumed, resurrecting a slot the user cleared.
    migrateCardOverrideEnabledFlags(context, safeAvatar);
    const ext = getCharacterExtensionDataByAvatar(context, safeAvatar) || {};
    if (hasLegacyOverridePayload(ext, mode)) {
        migrateAndPersistLegacyCardOverrideForMode(context, safeAvatar, mode);
        // The legacy migration translates `override.<mode>.enabled` into
        // a fresh flag container — consume it in the same pass so the
        // slot settles before the read.
        migrateCardOverrideEnabledFlags(context, safeAvatar);
    }
    const id = getCharacterActivePresetId(context, safeAvatar, mode);
    return id ? 'character' : 'global';
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
 * Compute the next character-extension payload after a "Clear presets
 * from this card" click for the given execution mode. Strips
 * `presetLibraries.<mode>` and `activePresetIds.<mode>` (plus any
 * stale `overrideEnabled.<mode>` flag from pre-migration cards),
 * dropping empty containers so the `hasCharacter*Override` probe reads
 * false afterwards. Also drops the `override.mode` pin when it was
 * pointing at the cleared mode so the dispatcher does not keep that
 * mode active after the data is gone.
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
