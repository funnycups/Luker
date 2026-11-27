/**
 * Editor state holder for the orchestrator extension.
 *
 * Owns the shared `uiState` object that the editor panel, the
 * AI-iteration popup, and the runtime callbacks all read from and
 * mutate. Also owns the loaders that materialize
 * `uiState.{global,character}{,Agenda}Editor` from settings + character
 * overrides, plus the "displayed scope" preference that switches the
 * editor between global and character views.
 *
 * `uiState` intentionally bundles editor fields with non-editor
 * UI-session fields (`aiIterationSession`, `orchEditorPopupContentId`) —
 * the popups share a single state object so the orchestrator UI can be
 * rebuilt with one snapshot. Editor-only consumers read the four
 * `*Editor` fields and the two `*DisplayedScope` fields; non-editor
 * consumers manage their own slots on the same object.
 *
 * Read-only display helpers (label formatting, scope-from-element)
 * live in `editor-display.js`. Persist + portable-profile creation
 * lives in `editor-persist.js`.
 */

const extension_settings = Luker.getContext().extensionSettings;
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_NODE_TYPE_WORKER,
    createDefaultDirectorProfile,
    defaultLoopProfile,
    defaultSpec,
    sanitizeDirectorProfile,
} from './defaults.js';
import {
    applyCharacterExecutionModeForAvatar,
    getCharacterActivePresetId,
    getCharacterExtensionDataByAvatar,
    getRuntimePresetScope,
    normalizeExecutionMode,
} from './character-overrides.js';
import { makeModeMap } from './preset-modes.js';
import { canonicalStringify } from './canonical-stringify.js';
import {
    createPresetDraft,
    resolveStoredIdReference,
    toEditablePresetMap,
    toEditableSpec,
} from './editable-spec.js';
import {
    ensureAgendaEditorIntegrity,
    sanitizeAgendaWorkingProfile,
} from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { getCurrentAvatar } from './snapshot-cache.js';
import { getActivePreset, getActivePresetId } from './preset-library.js';

const MODULE_NAME = 'orchestrator';

function getSettings() {
    return extension_settings[MODULE_NAME];
}

export const uiState = {
    selectedAvatar: '',
    globalEditor: null,
    characterEditor: null,
    globalAgendaEditor: null,
    characterAgendaEditor: null,
    globalLoopEditor: null,
    characterLoopEditor: null,
    globalDirectorEditor: null,
    characterDirectorEditor: null,
    specDisplayedScope: 'global',
    agendaDisplayedScope: 'global',
    loopDisplayedScope: 'global',
    directorDisplayedScope: 'global',
    aiIterationSession: null,
    orchEditorPopupContentId: '',
    globalActivePresetIds: makeModeMap(() => ''),
    characterActivePresetIds: makeModeMap(() => ''),
};

export function ensureEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    if (!editor.presets || typeof editor.presets !== 'object' || Object.keys(editor.presets).length === 0) {
        editor.presets = {};
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
    editor.presets = toEditablePresetMap(editor.presets);
    ensureLorebookFilterOnEditor(editor.spec);
}

/**
 * Guarantee a `lorebookFilter = { bookPattern, entryPattern }` shape on
 * an editor draft. Called by the popup input handlers before they write
 * a field and by the per-mode integrity ensurers so subsequent render
 * passes can index `editor.lorebookFilter.bookPattern` without guarding.
 * Missing / non-object host slot is created; non-string patterns are
 * coerced to '' to match the sanitizer's contract (Task 1).
 */
export function ensureLorebookFilterOnEditor(editor) {
    if (!editor || typeof editor !== 'object') return;
    if (!editor.lorebookFilter || typeof editor.lorebookFilter !== 'object') {
        editor.lorebookFilter = { bookPattern: '', entryPattern: '' };
        return;
    }
    if (typeof editor.lorebookFilter.bookPattern !== 'string') {
        editor.lorebookFilter.bookPattern = '';
    }
    if (typeof editor.lorebookFilter.entryPattern !== 'string') {
        editor.lorebookFilter.entryPattern = '';
    }
}

export function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        const presetId = 'distiller';
        editor.presets = {
            [presetId]: createPresetDraft(),
        };
        return presetId;
    }
    return keys[0];
}

/**
 * Point a spec editor node at the preset `value` resolves to; an empty
 * value falls back to the default preset.
 */
export function setEditorNodePreset(editor, node, value) {
    node.preset = resolveStoredIdReference(editor?.presets, value) || pickDefaultPreset(editor);
}

export function createNewStage(editor) {
    const defaultPreset = pickDefaultPreset(editor);
    const index = (editor.spec?.stages?.length || 0) + 1;
    return {
        id: `stage_${index}`,
        mode: 'serial',
        nodes: [{
            id: defaultPreset,
            preset: defaultPreset,
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: '',
        }],
    };
}

/**
 * Canonical JSON of what a mode's character draft is loaded from, split
 * into the card data and the merged global base:
 * - card: the active avatar, the card's library and active slot for
 *   that mode, and the legacy override payload the loader migrates.
 *   Missing containers fingerprint like empty ones, because the loader
 *   seeds them in memory only.
 * - globalBase: the global active preset for that mode, which every
 *   character loader merges under the card data.
 * The card shape is settled first, as the loaders do, so a card whose
 * legacy flags settle only in memory compares equal to its settled draft.
 */
export function getCharacterDraftSourceFingerprint(context, avatar, mode, extension = null) {
    getRuntimePresetScope(context, avatar, mode);
    const ext = extension ?? (avatar ? getCharacterExtensionDataByAvatar(context, avatar) : {});
    const library = ext.presetLibraries?.[mode];
    const override = ext.override && typeof ext.override === 'object' ? ext.override : {};
    const legacy = mode === ORCH_EXECUTION_MODE_SPEC
        ? { spec: override.spec, presets: override.presets, presetPatch: override.presetPatch, enabled: override.enabled }
        : override[mode];
    const globalActive = getActivePreset(getSettings(), mode, { scope: 'global' });
    return {
        card: canonicalStringify({
            avatar: String(avatar || ''),
            library: library && typeof library === 'object' ? library : {},
            activeId: String(ext.activePresetIds?.[mode] || ''),
            legacy: legacy ?? null,
            overrideEnabled: ext.overrideEnabled?.[mode] ?? null,
        }),
        globalBase: canonicalStringify((globalActive.ok && globalActive.state) || null),
    };
}

/** Fingerprints of the sources each mode's character draft was last loaded from. */
const characterDraftSources = makeModeMap(() => null);
const characterDraftContents = makeModeMap(() => null);

/** Acknowledge an owned write without replacing unrelated unsaved fields. */
export function acknowledgeCharacterDraftSource(context, avatar, mode, expectedDraft = null, expectedSource = null) {
    if (!avatar || uiState.selectedAvatar !== avatar) return false;
    if (expectedDraft && CHARACTER_DRAFT_LOADERS[mode]?.key && uiState[CHARACTER_DRAFT_LOADERS[mode].key] !== expectedDraft) return false;
    const source = getCharacterDraftSourceFingerprint(context, avatar, mode);
    if (expectedSource && (source.card !== expectedSource.card || source.globalBase !== expectedSource.globalBase)) return false;
    characterDraftSources[mode] = source;
    return true;
}

export function getCharacterDraftForMode(mode) {
    const key = CHARACTER_DRAFT_LOADERS[mode]?.key;
    return key ? uiState[key] : null;
}

export function loadGlobalEditorState() {
    const settings = getSettings();
    // `getActivePreset` returns `{ok:true, state}` envelope after Task 4.1;
    // `state` is null when no preset is configured. Existing sanitizer
    // fallbacks already tolerate `{}`, so we unwrap to a plain object here.
    const activeResult = getActivePreset(settings, ORCH_EXECUTION_MODE_SPEC, { scope: 'global' });
    const active = (activeResult.ok && activeResult.state) ? activeResult.state : {};
    const presets = toEditablePresetMap(active.presets);
    const spec = toEditableSpec(active.spec || defaultSpec, presets);
    return { spec, presets };
}

function buildCharacterEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    // Settle legacy card shapes before reading, as the runtime does.
    getRuntimePresetScope(context, safeAvatar, ORCH_EXECUTION_MODE_SPEC);
    const globalActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_SPEC, { scope: 'global' });
    const globalActive = (globalActiveResult.ok && globalActiveResult.state) ? globalActiveResult.state : {};
    const charActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_SPEC,
        { scope: 'character', context, avatar: safeAvatar });
    const charActive = (charActiveResult.ok && charActiveResult.state) ? charActiveResult.state : null;
    // Always merge override on top of the global base so partial overrides
    // inherit missing fields instead of getting filled with empty defaults
    // by the sanitizers. We merge preset maps (override wins per-id) and
    // fall back the top-level spec object key-by-key.
    const presets = charActive
        ? toEditablePresetMap({ ...(globalActive.presets || {}), ...(charActive.presets || {}) })
        : toEditablePresetMap(globalActive.presets);
    const globalSpecSource = globalActive.spec || defaultSpec;
    const overrideSpec = charActive && charActive.spec && typeof charActive.spec === 'object'
        ? charActive.spec
        : null;
    const specSource = overrideSpec
        ? { ...globalSpecSource, ...overrideSpec }
        : globalSpecSource;
    const spec = toEditableSpec(specSource, presets);
    return {
        avatar: safeAvatar,
        enabled: Boolean(getCharacterActivePresetId(context, safeAvatar, ORCH_EXECUTION_MODE_SPEC)),
        spec,
        presets,
    };
}

export function loadGlobalAgendaEditorState() {
    const settings = getSettings();
    const activeResult = getActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA, { scope: 'global' });
    const active = (activeResult.ok && activeResult.state) ? activeResult.state : null;
    return sanitizeAgendaWorkingProfile(active || {});
}

function buildCharacterAgendaEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    // Settle legacy card shapes before reading, as the runtime does.
    getRuntimePresetScope(context, safeAvatar, ORCH_EXECUTION_MODE_AGENDA);
    // Override merged on top of global base — fields the override doesn't
    // specify inherit from the global profile. Without this, a partial
    // override (e.g. only `{ enabled: true, planner: { systemPrompt } }`)
    // would replace the global agents with the sanitizer's default
    // single-finalizer fallback instead of keeping the global agent set.
    const globalActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA, { scope: 'global' });
    const globalActive = (globalActiveResult.ok && globalActiveResult.state) ? globalActiveResult.state : {};
    const globalBase = sanitizeAgendaWorkingProfile(globalActive);
    const charActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA,
        { scope: 'character', context, avatar: safeAvatar });
    const charActive = (charActiveResult.ok && charActiveResult.state) ? charActiveResult.state : null;
    const profile = charActive
        ? sanitizeAgendaWorkingProfile({ ...globalBase, ...charActive })
        : globalBase;
    return {
        avatar: safeAvatar,
        enabled: Boolean(getCharacterActivePresetId(context, safeAvatar, ORCH_EXECUTION_MODE_AGENDA)),
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: profile.limits,
    };
}

/**
 * Ensure a loop-mode editor draft has the canonical V3 shape. Called
 * before render and after every input mutation so renderers can index
 * into `tools.note.open` etc. without optional-chain fallback noise.
 */
export function ensureLoopEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeLoopProfile(editor);
    editor.mode = normalized.mode;
    editor.apiPresetName = normalized.apiPresetName;
    editor.promptPresetName = normalized.promptPresetName;
    editor.system_prompt = normalized.system_prompt;
    editor.tools = normalized.tools;
    editor.max_rounds = normalized.max_rounds;
    editor.wall_clock_budget_ms = normalized.wall_clock_budget_ms;
    editor.capsule_inject = normalized.capsule_inject;
    editor.customTools = normalized.customTools;
    editor.lorebookFilter = normalized.lorebookFilter;
}

/**
 * Load the global loop editor draft from settings. Falls back to
 * `defaultLoopProfile` when settings has no loopProfile key (fresh
 * install) so the editor always renders with reasonable defaults.
 */
export function loadGlobalLoopEditorState() {
    const settings = getSettings();
    const activeResult = getActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, { scope: 'global' });
    const active = (activeResult.ok && activeResult.state) ? activeResult.state : null;
    return sanitizeLoopProfile(active || defaultLoopProfile);
}

/**
 * Load the per-character loop editor draft. When the character has a
 * persisted loop override, use it; otherwise seed from the global loop
 * profile so the editor has a sensible starting point. The returned
 * draft carries `enabled` like the spec/agenda character editors, so
 * save / clear flows can roundtrip that field.
 */
function buildCharacterLoopEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    // Settle legacy card shapes before reading, as the runtime does.
    getRuntimePresetScope(context, safeAvatar, ORCH_EXECUTION_MODE_LOOP);
    // Override merged on top of global base — fields the override doesn't
    // specify (system_prompt, tools, max_rounds, etc.) inherit from the
    // global loop profile instead of falling back to LOOP_PROFILE_DEFAULTS.
    const globalActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, { scope: 'global' });
    const globalActiveRaw = (globalActiveResult.ok && globalActiveResult.state) ? globalActiveResult.state : null;
    const globalActive = sanitizeLoopProfile(globalActiveRaw || defaultLoopProfile);
    const charActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_LOOP,
        { scope: 'character', context, avatar: safeAvatar });
    const charActive = (charActiveResult.ok && charActiveResult.state) ? charActiveResult.state : null;
    const baseProfile = charActive
        ? sanitizeLoopProfile({ ...globalActive, ...charActive })
        : globalActive;
    return {
        ...baseProfile,
        avatar: safeAvatar,
        enabled: Boolean(getCharacterActivePresetId(context, safeAvatar, ORCH_EXECUTION_MODE_LOOP)),
    };
}

/**
 * Ensure a director-mode editor draft has the canonical flat shape
 * (mainAgent / subAgents / limits / tools at top level). Called before
 * render and after every input mutation so renderers can index into
 * `editor.mainAgent.systemPrompt` etc. without optional-chain fallback
 * noise. The sanitizer is the single source of truth for the shape —
 * we mutate the editor object in place to match the sanitizer output,
 * preserving any non-director fields (avatar / enabled) that ride
 * along on character-scope editors.
 */
export function ensureDirectorEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeDirectorProfile(editor);
    editor.mode = normalized.mode;
    editor.mainAgent = normalized.mainAgent;
    editor.subAgents = normalized.subAgents;
    editor.maxRounds = normalized.maxRounds;
    editor.maxConcurrentSubagents = normalized.maxConcurrentSubagents;
    editor.maxTotalSubagentRuns = normalized.maxTotalSubagentRuns;
    editor.tools = normalized.tools;
    editor.discardOnAbort = normalized.discardOnAbort;
    editor.customTools = normalized.customTools;
    editor.lorebookFilter = normalized.lorebookFilter;
    // Stale wrapper from any pre-flatten editor object — strip so the
    // editor draft is exclusively the new flat shape.
    delete editor.director;
}

/**
 * Load the global director editor draft from settings. Falls back to
 * `createDefaultDirectorProfile()` when settings has no directorProfile
 * key (fresh install) so the editor always renders with the canonical
 * default sub-agents.
 */
export function loadGlobalDirectorEditorState() {
    const settings = getSettings();
    const activeResult = getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
    const active = (activeResult.ok && activeResult.state) ? activeResult.state : null;
    return sanitizeDirectorProfile(active || createDefaultDirectorProfile());
}

/**
 * Load the per-character director editor draft. When the character has
 * a persisted director override, use it; otherwise seed from the global
 * director profile so the editor has a sensible starting point. The
 * returned draft carries `enabled` like the spec/agenda/loop character
 * editors, so save / clear flows can roundtrip that field.
 */
function buildCharacterDirectorEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    // Settle legacy card shapes before reading, as the runtime does.
    getRuntimePresetScope(context, safeAvatar, ORCH_EXECUTION_MODE_DIRECTOR);
    // Override merged on top of global base. Without this, a partial
    // override (e.g. only `{ enabled: true, mainAgent: {} }`) would land
    // with an empty mainAgent.systemPrompt and zero sub-agents because
    // sanitizeDirectorProfile fills missing slots with empty defaults
    // rather than inheriting from the global director profile.
    const globalActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, { scope: 'global' });
    const globalActiveRaw = (globalActiveResult.ok && globalActiveResult.state) ? globalActiveResult.state : null;
    const globalBase = sanitizeDirectorProfile(globalActiveRaw || createDefaultDirectorProfile());
    const charActiveResult = getActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR,
        { scope: 'character', context, avatar: safeAvatar });
    const charActive = (charActiveResult.ok && charActiveResult.state) ? charActiveResult.state : null;
    // Single-scope model: "enabled" means the card's active slot holds a
    // real preset id — the card library runs for this mode.
    const overrideEnabled = Boolean(getCharacterActivePresetId(
        context, safeAvatar, ORCH_EXECUTION_MODE_DIRECTOR,
    ));
    if (!charActive) {
        return {
            ...globalBase,
            avatar: safeAvatar,
            enabled: overrideEnabled,
        };
    }
    // The character active payload is already preset-shaped — sanitize for
    // the canonical flat shape and merge over the global base. Spread
    // semantics give the override the final word for each top-level key
    // (mainAgent / subAgents / limits / tools), exactly like the
    // loop / agenda character editors. Empty subAgents `[]` and empty
    // mainAgent.systemPrompt `''` are treated as explicit user/AI intent,
    // NOT silently rehydrated from global — otherwise iter-studio's
    // "delete all sub-agents on this card" or "blank the main prompt"
    // edits would appear to persist but rematerialize the global content
    // the next time the editor reads.
    const sanitizedOverride = sanitizeDirectorProfile(charActive);
    const merged = {
        ...globalBase,
        ...sanitizedOverride,
    };
    return {
        ...merged,
        avatar: safeAvatar,
        enabled: overrideEnabled,
    };
}

/**
 * Refresh the cached `uiState.{global,character}ActivePresetIds` from
 * stored settings and the selected card. Editor drafts are left as-is,
 * so callers that re-render after an in-memory edit keep that edit.
 */
export function syncActivePresetIdsFromSettings(context) {
    const settings = getSettings();
    uiState.globalActivePresetIds = makeModeMap((mode) => getActivePresetId(settings, mode, { scope: 'global' }));
    if (uiState.selectedAvatar) {
        uiState.characterActivePresetIds = makeModeMap((mode) => getCharacterActivePresetId(context, uiState.selectedAvatar, mode));
    }
}

export function initializeUiState(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar !== uiState.selectedAvatar) {
        applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    }
    uiState.selectedAvatar = activeAvatar;
    uiState.globalEditor = loadGlobalEditorState();
    uiState.characterEditor = loadCharacterEditorState(context, uiState.selectedAvatar);
    uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, uiState.selectedAvatar);
    uiState.globalLoopEditor = loadGlobalLoopEditorState();
    uiState.characterLoopEditor = loadCharacterLoopEditorState(context, uiState.selectedAvatar);
    uiState.globalDirectorEditor = loadGlobalDirectorEditorState();
    uiState.characterDirectorEditor = loadCharacterDirectorEditorState(context, uiState.selectedAvatar);
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    ensureLoopEditorIntegrity(uiState.globalLoopEditor);
    ensureLoopEditorIntegrity(uiState.characterLoopEditor);
    ensureDirectorEditorIntegrity(uiState.globalDirectorEditor);
    ensureDirectorEditorIntegrity(uiState.characterDirectorEditor);
    syncActivePresetIdsFromSettings(context);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

const CHARACTER_DRAFT_LOADERS = {
    [ORCH_EXECUTION_MODE_SPEC]: { key: 'characterEditor', load: loadCharacterEditorState, ensure: ensureEditorIntegrity },
    [ORCH_EXECUTION_MODE_AGENDA]: { key: 'characterAgendaEditor', load: loadCharacterAgendaEditorState, ensure: ensureAgendaEditorIntegrity },
    [ORCH_EXECUTION_MODE_LOOP]: { key: 'characterLoopEditor', load: loadCharacterLoopEditorState, ensure: ensureLoopEditorIntegrity },
    [ORCH_EXECUTION_MODE_DIRECTOR]: { key: 'characterDirectorEditor', load: loadCharacterDirectorEditorState, ensure: ensureDirectorEditorIntegrity },
};

function loadCharacterDraft(context, avatar, mode, build, ensure) {
    const draft = build(context, avatar);
    ensure(draft);
    characterDraftSources[mode] = getCharacterDraftSourceFingerprint(context, avatar, mode);
    characterDraftContents[mode] = JSON.parse(JSON.stringify(draft));
    return draft;
}

export function loadCharacterEditorState(context, avatar) {
    return loadCharacterDraft(context, avatar, ORCH_EXECUTION_MODE_SPEC, buildCharacterEditorState, ensureEditorIntegrity);
}

export function loadCharacterAgendaEditorState(context, avatar) {
    return loadCharacterDraft(context, avatar, ORCH_EXECUTION_MODE_AGENDA, buildCharacterAgendaEditorState, ensureAgendaEditorIntegrity);
}

export function loadCharacterLoopEditorState(context, avatar) {
    return loadCharacterDraft(context, avatar, ORCH_EXECUTION_MODE_LOOP, buildCharacterLoopEditorState, ensureLoopEditorIntegrity);
}

export function loadCharacterDirectorEditorState(context, avatar) {
    return loadCharacterDraft(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR, buildCharacterDirectorEditorState, ensureDirectorEditorIntegrity);
}

function reloadCharacterDraft(context, mode, avatar) {
    const { key, load, ensure } = CHARACTER_DRAFT_LOADERS[mode];
    uiState[key] = load(context, avatar);
    ensure(uiState[key]);
}

export function syncCharacterEditorWithActiveAvatar(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar === uiState.selectedAvatar) {
        return;
    }
    applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    uiState.selectedAvatar = activeAvatar;
    for (const mode of Object.keys(CHARACTER_DRAFT_LOADERS)) {
        reloadCharacterDraft(context, mode, activeAvatar);
    }
    syncActivePresetIdsFromSettings(context);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

/**
 * Reload the selected avatar's character draft for `mode` when the card
 * data or the merged global base it was loaded from changed. The
 * displayed scope is re-derived only on a card change: the stored scope
 * comes from the card's active slot alone, and re-deriving it otherwise
 * would override an explicit display choice. Returns whether it reloaded.
 */
export function refreshCharacterDraftIfSourceChanged(context, mode) {
    const avatar = uiState.selectedAvatar;
    const recorded = characterDraftSources[mode];
    const current = getCharacterDraftSourceFingerprint(context, avatar, mode);
    const cardChanged = current.card !== recorded?.card;
    if (!cardChanged && current.globalBase === recorded?.globalBase) {
        return false;
    }
    const draft = getCharacterDraftForMode(mode);
    const baseline = characterDraftContents[mode];
    reloadCharacterDraft(context, mode, avatar);
    if (!cardChanged && baseline) {
        const key = CHARACTER_DRAFT_LOADERS[mode].key;
        uiState[key] = mergeDraftEdits(baseline, draft, uiState[key]);
    }
    if (cardChanged) {
        setDisplayedScopeForMode(context, getSettings(), mode);
    }
    return true;
}

// Three-way structural rebase: fields unchanged by the editor follow the
// new global base. Edited values and arrays remain the user's draft.
function mergeDraftEdits(before, draft, next) {
    if (canonicalStringify(before) === canonicalStringify(draft)) return next;
    if (!before || !draft || !next || typeof before !== 'object' || typeof draft !== 'object' || typeof next !== 'object'
        || Array.isArray(before) || Array.isArray(draft) || Array.isArray(next)) return draft;
    const merged = { ...next };
    for (const key of new Set([...Object.keys(before), ...Object.keys(draft)])) {
        if (!Object.hasOwn(draft, key)) delete merged[key];
        else merged[key] = mergeDraftEdits(before[key], draft[key], next[key]);
    }
    return merged;
}

const GLOBAL_DRAFT_LOADERS = {
    [ORCH_EXECUTION_MODE_SPEC]: { key: 'globalEditor', load: loadGlobalEditorState, ensure: ensureEditorIntegrity },
    [ORCH_EXECUTION_MODE_AGENDA]: { key: 'globalAgendaEditor', load: loadGlobalAgendaEditorState, ensure: ensureAgendaEditorIntegrity },
    [ORCH_EXECUTION_MODE_LOOP]: { key: 'globalLoopEditor', load: loadGlobalLoopEditorState, ensure: ensureLoopEditorIntegrity },
    [ORCH_EXECUTION_MODE_DIRECTOR]: { key: 'globalDirectorEditor', load: loadGlobalDirectorEditorState, ensure: ensureDirectorEditorIntegrity },
};

/** Reload an explicitly selected preset without clearing other modes' drafts. */
export function reloadPresetDraft(context, mode) {
    const { key, load, ensure } = GLOBAL_DRAFT_LOADERS[mode];
    uiState[key] = load();
    ensure(uiState[key]);
    reloadCharacterDraft(context, mode, uiState.selectedAvatar);
    syncActivePresetIdsFromSettings(context);
    setDisplayedScopeForMode(context, getSettings(), mode);
}

/** Capture draft ownership before an asynchronous global write. */
export function captureGlobalWriteDrafts(mode) {
    const key = GLOBAL_DRAFT_LOADERS[mode].key;
    return {
        key, draft: uiState[key], content: canonicalStringify(uiState[key]),
        avatar: uiState.selectedAvatar, characterDraft: getCharacterDraftForMode(mode),
        characterContent: canonicalStringify(getCharacterDraftForMode(mode)),
        characterSource: characterDraftSources[mode],
    };
}

/** Publish an acknowledged source without replacing later or unrelated draft edits. */
export function acknowledgeGlobalWriteDrafts(context, mode, captured, { replaceGlobal = false, sourceEditor = null } = {}) {
    const { key, load, ensure } = GLOBAL_DRAFT_LOADERS[mode];
    if (replaceGlobal && uiState[key] === captured.draft && canonicalStringify(uiState[key]) === captured.content) {
        uiState[key] = load();
        ensure(uiState[key]);
    }
    if (uiState.selectedAvatar !== captured.avatar || getCharacterDraftForMode(mode) !== captured.characterDraft) return;
    const currentSource = getCharacterDraftSourceFingerprint(context, captured.avatar, mode);
    if (currentSource.card !== captured.characterSource?.card) return;
    if (sourceEditor === captured.characterDraft && canonicalStringify(sourceEditor) === captured.characterContent) {
        reloadCharacterDraft(context, mode, captured.avatar);
    } else if (canonicalStringify(captured.characterDraft) !== captured.characterContent) {
        acknowledgeCharacterDraftSource(context, captured.avatar, mode, captured.characterDraft, currentSource);
    } else {
        // Narrow writes must retain the global editor's other unsaved fields
        // while allowing inherited character fields to follow acknowledged data.
        refreshCharacterDraftIfSourceChanged(context, mode);
    }
}

/**
 * Refresh editor state after a host event (connection profile, chat or
 * character change) re-renders an already mounted drawer. Global drafts
 * are kept: their source is the saved orchestrator settings, which host
 * events do not change. Character drafts are swapped on an avatar change
 * and otherwise reloaded per mode only when the card data or the global
 * base they were loaded from changed.
 */
export function refreshUiStateFromHost(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar !== uiState.selectedAvatar) {
        syncCharacterEditorWithActiveAvatar(context);
        return;
    }
    for (const mode of Object.keys(CHARACTER_DRAFT_LOADERS)) {
        refreshCharacterDraftIfSourceChanged(context, mode);
    }
    syncActivePresetIdsFromSettings(context);
}

export function getScopePreferenceStateKey(mode = ORCH_EXECUTION_MODE_SPEC) {
    const normalized = normalizeExecutionMode(mode);
    if (normalized === ORCH_EXECUTION_MODE_AGENDA) return 'agendaDisplayedScope';
    if (normalized === ORCH_EXECUTION_MODE_LOOP) return 'loopDisplayedScope';
    if (normalized === ORCH_EXECUTION_MODE_DIRECTOR) return 'directorDisplayedScope';
    return 'specDisplayedScope';
}

export function getStoredDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    // Single-scope model: the card's active slot decides which library
    // the editor displays — same derivation as the runtime.
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const normalized = normalizeExecutionMode(mode);
    return getRuntimePresetScope(context, activeAvatar, normalized) === 'character' ? 'character' : 'global';
}

export function setDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC, scope = '') {
    const key = getScopePreferenceStateKey(mode);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (scope === 'character' && activeAvatar) {
        uiState[key] = 'character';
        return uiState[key];
    }
    if (scope === 'global') {
        uiState[key] = 'global';
        return uiState[key];
    }
    uiState[key] = getStoredDisplayedScopeForMode(context, settings, mode);
    return uiState[key];
}

function syncDisplayedScopesFromStoredState(context, settings) {
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_LOOP);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_DIRECTOR);
}
